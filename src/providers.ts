import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionContentPart,
  ChatCompletionCreateParams,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";

// ===========================================================================
// Provider contract
//
// The agent speaks one dialect: OpenAI chat-completions requests and stream chunks.
// Every backend implements `ChatClient`; adapters translate where the wire format differs.
// Two extensions to that dialect:
//   - request `thinking`: "auto" | "on" | "off", mapped to each provider's own switch;
//   - assistant messages may carry `provider_state` (opaque, provider-specific data such as
//     Claude's signed thinking blocks), streamed back in a chunk's `delta.provider_state`.
//     Adapters that don't understand it must strip it before sending.
// ===========================================================================

export type ThinkingMode = "auto" | "on" | "off";

export type ChatRequest = Omit<ChatCompletionCreateParams, "stream"> & {
  stream: boolean;
  thinking?: ThinkingMode;
};

export interface ProviderState {
  /** Claude's assistant content blocks exactly as produced (thinking blocks and signatures included). */
  anthropic?: Anthropic.ContentBlockParam[];
}

export interface ModelEntry {
  id: string;
  /** Human-friendly name, when the provider has one. */
  label?: string;
  /** Context window in tokens, when the provider reports it. */
  contextTokens?: number;
}

export interface ChatClient {
  /** Provider id, e.g. "anthropic". */
  readonly provider: string;
  /** Streams chunks; with `stream: false` the whole reply arrives as one chunk. */
  streamChat(params: ChatRequest, signal: AbortSignal): Promise<AsyncIterable<ChatCompletionChunk>>;
  listModels(): Promise<ModelEntry[]>;
}

export type ProviderKind = "local" | "openai" | "anthropic" | "custom";

export interface ProviderSettings {
  kind: ProviderKind;
  baseURL?: string;
  apiKey?: string;
}

export interface ProviderPreset {
  label: string;
  description: string;
  defaultBaseURL: string;
  /** Environment variable used when no key is saved. */
  keyEnv?: string;
  needsKey: boolean;
  /** Fallback context window when the provider does not report one. */
  defaultContextTokens: number;
}

export const PROVIDERS: Record<ProviderKind, ProviderPreset> = {
  local: {
    label: "Local",
    description: "llama.cpp, Ollama, LM Studio, vLLM on this machine",
    // A getter so a .env loaded after this module still applies.
    get defaultBaseURL() {
      return process.env.LLM_BASE_URL || "http://localhost:9931/v1";
    },
    keyEnv: "LLM_API_KEY",
    needsKey: false,
    defaultContextTokens: 32_768,
  },
  openai: {
    label: "OpenAI",
    description: "GPT and o-series models",
    defaultBaseURL: "https://api.openai.com/v1",
    keyEnv: "OPENAI_API_KEY",
    needsKey: true,
    defaultContextTokens: 128_000,
  },
  anthropic: {
    label: "Anthropic",
    description: "Claude models via the native Messages API",
    defaultBaseURL: "https://api.anthropic.com",
    keyEnv: "ANTHROPIC_API_KEY",
    needsKey: true,
    defaultContextTokens: 200_000,
  },
  custom: {
    label: "Custom",
    description: "Any OpenAI-compatible endpoint (OpenRouter, Groq, Together…)",
    defaultBaseURL: "",
    keyEnv: "CUSTOM_API_KEY",
    needsKey: false,
    defaultContextTokens: 32_768,
  },
};

export class ProviderError extends Error {}

/** Builds a client for the given settings. A missing key falls back to the preset's env variable. */
export function createChatClient(settings: ProviderSettings): ChatClient {
  const preset = PROVIDERS[settings.kind];
  if (!preset) throw new ProviderError(`Unknown provider "${settings.kind}"`);
  const baseURL = (settings.baseURL || preset.defaultBaseURL).trim();
  if (!baseURL) throw new ProviderError("A base URL is required for this provider.");
  const apiKey = settings.apiKey || (preset.keyEnv ? process.env[preset.keyEnv] : undefined);
  if (preset.needsKey && !apiKey) {
    throw new ProviderError(`${preset.label} needs an API key (enter one, or set ${preset.keyEnv}).`);
  }
  if (settings.kind === "anthropic") {
    return anthropicChatClient(new Anthropic({ apiKey: apiKey!, baseURL, maxRetries: 2, timeout: 10 * 60_000 }));
  }
  const client = new OpenAI({ baseURL, apiKey: apiKey || "no-key", maxRetries: 2, timeout: 10 * 60_000 });
  return openAIChatClient(client, settings.kind);
}

/** Removes the provider-private field so strict OpenAI-compatible servers don't reject it. */
function withoutProviderState(messages: ChatCompletionMessageParam[]): ChatCompletionMessageParam[] {
  return messages.map((m) => {
    if (!("provider_state" in m)) return m;
    const { provider_state: _, ...rest } = m as ChatCompletionMessageParam & { provider_state?: unknown };
    return rest as ChatCompletionMessageParam;
  });
}

// ---------------------------------------------------------------------------
// OpenAI and OpenAI-compatible servers
// ---------------------------------------------------------------------------

// Models listed by OpenAI that cannot chat with tools.
const OPENAI_NON_CHAT =
  /(embedding|whisper|tts|dall-e|davinci|babbage|moderation|image|audio|realtime|transcribe|search|instruct|sora|computer-use)/;

/** A complete (non-streamed) reply, re-shaped as the chunks the agent consumes. */
async function* fromCompletion(c: ChatCompletion): AsyncGenerator<ChatCompletionChunk> {
  const choice = c.choices[0];
  const msg = (choice?.message ?? {}) as ChatCompletion.Choice["message"] & { reasoning_content?: string };
  const base = { id: c.id, object: "chat.completion.chunk" as const, created: c.created, model: c.model };
  yield {
    ...base,
    choices: [
      {
        index: 0,
        logprobs: null,
        finish_reason: choice?.finish_reason ?? "stop",
        delta: {
          role: "assistant",
          content: msg.content ?? "",
          ...(msg.reasoning_content ? { reasoning_content: msg.reasoning_content } : {}),
          tool_calls: (msg.tool_calls ?? [])
            .filter((tc) => tc.type === "function")
            .map((tc, index) => ({ index, id: tc.id, type: "function" as const, function: tc.function })),
        } as ChatCompletionChunk.Choice.Delta,
      },
    ],
  };
  if (c.usage) yield { ...base, choices: [], usage: c.usage };
}

export function openAIChatClient(client: OpenAI, provider = "openai-compatible"): ChatClient {
  // Servers that reject the thinking switch are remembered, so later requests skip it.
  let thinkingSupported = true;

  const buildBody = (params: ChatRequest, withThinking: boolean) => {
    const { thinking, ...rest } = params;
    const body: Record<string, any> = { ...rest, messages: withoutProviderState(rest.messages) };
    if (!body.stream) delete body.stream_options;
    if (provider === "openai" && body.max_tokens !== undefined) {
      // OpenAI's newer models only accept max_completion_tokens.
      body.max_completion_tokens = body.max_tokens;
      delete body.max_tokens;
    }
    if (withThinking && thinking && thinking !== "auto") {
      if (provider === "openai") body.reasoning_effort = thinking === "off" ? "minimal" : "high";
      // llama.cpp, vLLM and SGLang pass this to the chat template (Qwen, Gemma, GLM, …).
      else body.chat_template_kwargs = { ...body.chat_template_kwargs, enable_thinking: thinking === "on" };
    }
    return body;
  };

  return {
    provider,
    async streamChat(params, signal) {
      const send = async (withThinking: boolean) => {
        const body = buildBody(params, withThinking);
        const res = await client.chat.completions.create(body as ChatCompletionCreateParams, { signal });
        return body.stream ? (res as AsyncIterable<ChatCompletionChunk>) : fromCompletion(res as ChatCompletion);
      };
      const wantsThinking = thinkingSupported && Boolean(params.thinking && params.thinking !== "auto");
      try {
        return await send(wantsThinking);
      } catch (e: any) {
        if (
          wantsThinking &&
          e?.status === 400 &&
          /reasoning|thinking|chat_template_kwargs|unrecognized|unsupported|extra/i.test(String(e.message))
        ) {
          thinkingSupported = false;
          return send(false);
        }
        throw e;
      }
    },
    async listModels() {
      const out: ModelEntry[] = [];
      for await (const m of client.models.list()) {
        const entry = m as typeof m & { tags?: string[] };
        if (provider === "openai" && OPENAI_NON_CHAT.test(m.id)) continue;
        out.push({ id: m.id, label: entry.tags?.length ? `[${entry.tags.join(", ")}]` : undefined });
      }
      return out.sort((a, b) => a.id.localeCompare(b.id));
    },
  };
}

// ---------------------------------------------------------------------------
// Anthropic (native Messages API)
// ---------------------------------------------------------------------------

type AnthropicMessage = Anthropic.MessageParam;
type AnthropicBlock = Anthropic.ContentBlockParam;

/** Anthropic tool ids must match ^[a-zA-Z0-9_-]+$; local models invent all sorts. */
function safeToolId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_") || "call";
}

function textOf(content: ChatCompletionMessageParam["content"]): string {
  if (typeof content === "string") return content;
  if (!content) return "";
  return content.map((p: any) => (p.type === "text" ? p.text : "")).join("");
}

const IMAGE_MEDIA = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** OpenAI content parts -> Claude blocks (text and images). */
function toAnthropicParts(content: string | ChatCompletionContentPart[] | null | undefined): AnthropicBlock[] {
  if (!content) return [];
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  const out: AnthropicBlock[] = [];
  for (const part of content) {
    if (part.type === "text" && part.text) out.push({ type: "text", text: part.text });
    else if (part.type === "image_url") {
      const url = part.image_url.url;
      const m = /^data:([^;]+);base64,(.*)$/s.exec(url);
      if (m && IMAGE_MEDIA.has(m[1]!)) {
        out.push({ type: "image", source: { type: "base64", media_type: m[1] as "image/png", data: m[2]! } });
      } else if (/^https?:/i.test(url)) {
        out.push({ type: "image", source: { type: "url", url } });
      }
    }
  }
  return out;
}

const isThinkingBlock = (b: AnthropicBlock) => b.type === "thinking" || b.type === "redacted_thinking";

/** OpenAI-style transcript -> Anthropic system prompt + strictly alternating messages. */
export function toAnthropicMessages(messages: ChatCompletionMessageParam[]): { system: string; messages: AnthropicMessage[] } {
  const system: string[] = [];
  const out: AnthropicMessage[] = [];
  const push = (role: "user" | "assistant", blocks: AnthropicBlock[]) => {
    if (blocks.length === 0) return;
    const last = out.at(-1);
    // Anthropic requires alternating roles: merge consecutive same-role messages.
    if (last?.role === role) (last.content as AnthropicBlock[]).push(...blocks);
    else out.push({ role, content: blocks });
  };

  for (const m of messages) {
    switch (m.role) {
      case "system":
      case "developer":
        system.push(textOf(m.content));
        break;
      case "user": {
        const parts = toAnthropicParts(m.content as string | ChatCompletionContentPart[]);
        push("user", parts.length ? parts : [{ type: "text", text: "(empty)" }]);
        break;
      }
      case "assistant": {
        // Replay Claude's own blocks verbatim when we have them: thinking blocks must come back
        // unchanged (signature included) or later turns lose their reasoning.
        const own = (m as { provider_state?: ProviderState }).provider_state?.anthropic;
        const expectedIds = (m.tool_calls ?? []).map((tc) => safeToolId(tc.id));
        const ownIds = (own ?? []).flatMap((b) => (b.type === "tool_use" ? [b.id] : []));
        if (own?.length && own.some((b) => !isThinkingBlock(b)) && ownIds.join() === expectedIds.join()) {
          push("assistant", own);
          break;
        }
        const blocks: AnthropicBlock[] = [];
        const text = textOf(m.content ?? null).trim();
        if (text) blocks.push({ type: "text", text });
        for (const tc of m.tool_calls ?? []) {
          if (tc.type !== "function") continue;
          let input: unknown = {};
          try {
            const parsed = JSON.parse(tc.function.arguments || "{}");
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) input = parsed;
          } catch {}
          blocks.push({ type: "tool_use", id: safeToolId(tc.id), name: tc.function.name, input });
        }
        push("assistant", blocks.length ? blocks : [{ type: "text", text: "(no reply)" }]);
        break;
      }
      case "tool": {
        const content = textOf(m.content);
        push("user", [
          {
            type: "tool_result",
            tool_use_id: safeToolId(m.tool_call_id),
            content,
            is_error: content.startsWith("Error:") || content.startsWith("Denied:"),
          },
        ]);
        break;
      }
    }
  }
  return { system: system.join("\n\n"), messages: out };
}

/**
 * Maps the agent's thinking switch to a Claude request. Rules differ per model generation:
 * current models use adaptive thinking; Claude Opus 5 / 5.5 and Fable cannot (or should not) turn
 * it off, so "off" lowers effort instead; Claude Sonnet 5.5 turns it off with `between_tools`;
 * models before 4.6 use a fixed budget.
 */
export function claudeThinking(model: string, mode: ThinkingMode | undefined): Record<string, unknown> {
  if (!mode || mode === "auto") return {};
  const legacy = /claude-3|-4-[015](?!\d)|-4-\d{8}/.test(model);
  if (mode === "on") {
    return legacy ? { thinking: { type: "enabled", budget_tokens: 4096 } } : { thinking: { type: "adaptive", display: "summarized" } };
  }
  if (legacy) return {}; // off by default on these models
  if (/opus-5|fable|mythos/.test(model)) return { output_config: { effort: "low" } };
  if (/sonnet-5-5/.test(model)) return { thinking: { type: "between_tools" } };
  return { thinking: { type: "disabled" } };
}

const STOP_REASONS: Record<string, ChatCompletionChunk.Choice["finish_reason"]> = {
  end_turn: "stop",
  stop_sequence: "stop",
  tool_use: "tool_calls",
  max_tokens: "length",
  model_context_window_exceeded: "length",
  refusal: "content_filter",
};

type Delta = ChatCompletionChunk.Choice.Delta & { reasoning_content?: string; provider_state?: ProviderState };

function chunkMaker(model: string) {
  const base = { id: "", object: "chat.completion.chunk" as const, created: Math.floor(Date.now() / 1000), model };
  const chunk = (delta: Delta, finish: ChatCompletionChunk.Choice["finish_reason"] = null): ChatCompletionChunk => ({
    ...base,
    choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
  });
  const usage = (input: number, output: number): ChatCompletionChunk => ({
    ...base,
    choices: [],
    usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output },
  });
  return { base, chunk, usage };
}

const inputTokensOf = (u: Anthropic.Usage) => u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);

/** Anthropic stream events -> OpenAI chat-completion chunks (plus Claude's own blocks for replay). */
export async function* fromAnthropicStream(
  events: AsyncIterable<Anthropic.RawMessageStreamEvent>,
  model: string,
): AsyncGenerator<ChatCompletionChunk> {
  const { base, chunk, usage } = chunkMaker(model);
  const toolIndexByBlock = new Map<number, number>();
  const blocks: (AnthropicBlock & { _json?: string })[] = [];
  let nextTool = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let stop: string | null = null;

  for await (const ev of events) {
    switch (ev.type) {
      case "message_start":
        base.id = ev.message.id;
        inputTokens = inputTokensOf(ev.message.usage);
        outputTokens = ev.message.usage.output_tokens;
        break;
      case "content_block_start": {
        const b = ev.content_block;
        if (b.type === "text") blocks[ev.index] = { type: "text", text: "" };
        else if (b.type === "thinking") blocks[ev.index] = { type: "thinking", thinking: "", signature: "" };
        else if (b.type === "redacted_thinking") blocks[ev.index] = { type: "redacted_thinking", data: b.data };
        else if (b.type === "tool_use") {
          blocks[ev.index] = { type: "tool_use", id: b.id, name: b.name, input: {}, _json: "" };
          const index = nextTool++;
          toolIndexByBlock.set(ev.index, index);
          yield chunk({ tool_calls: [{ index, id: b.id, type: "function", function: { name: b.name, arguments: "" } }] });
        }
        break;
      }
      case "content_block_delta": {
        const block = blocks[ev.index];
        const d = ev.delta;
        if (d.type === "text_delta") {
          if (block?.type === "text") block.text += d.text;
          yield chunk({ content: d.text });
        } else if (d.type === "thinking_delta") {
          if (block?.type === "thinking") block.thinking += d.thinking;
          if (d.thinking) yield chunk({ reasoning_content: d.thinking });
        } else if (d.type === "signature_delta") {
          if (block?.type === "thinking") block.signature += d.signature;
        } else if (d.type === "input_json_delta") {
          if (block) block._json = (block._json ?? "") + d.partial_json;
          const index = toolIndexByBlock.get(ev.index);
          if (index !== undefined) yield chunk({ tool_calls: [{ index, function: { arguments: d.partial_json } }] });
        }
        break;
      }
      case "message_delta":
        stop = ev.delta.stop_reason;
        if (ev.usage?.output_tokens != null) outputTokens = ev.usage.output_tokens;
        break;
    }
  }

  const finalBlocks: AnthropicBlock[] = [];
  for (const b of blocks) {
    if (!b) continue;
    if (b.type === "tool_use") {
      let input: unknown = {};
      try {
        input = JSON.parse(b._json || "{}");
      } catch {}
      finalBlocks.push({ type: "tool_use", id: b.id, name: b.name, input });
    } else finalBlocks.push(b);
  }
  if (finalBlocks.length) yield chunk({ provider_state: { anthropic: finalBlocks } });
  yield chunk({}, STOP_REASONS[stop ?? "end_turn"] ?? "stop");
  yield usage(inputTokens, outputTokens);
}

/** A complete Claude message -> the same chunk shape. */
async function* fromAnthropicMessage(msg: Anthropic.Message): AsyncGenerator<ChatCompletionChunk> {
  const { base, chunk, usage } = chunkMaker(msg.model);
  base.id = msg.id;
  const replay: AnthropicBlock[] = [];
  let text = "";
  let reasoning = "";
  const toolCalls: ChatCompletionChunk.Choice.Delta.ToolCall[] = [];
  for (const b of msg.content) {
    if (b.type === "text") {
      text += b.text;
      replay.push({ type: "text", text: b.text });
    } else if (b.type === "thinking") {
      reasoning += b.thinking;
      replay.push({ type: "thinking", thinking: b.thinking, signature: b.signature });
    } else if (b.type === "redacted_thinking") {
      replay.push({ type: "redacted_thinking", data: b.data });
    } else if (b.type === "tool_use") {
      toolCalls.push({
        index: toolCalls.length,
        id: b.id,
        type: "function",
        function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
      });
      replay.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
    }
  }
  yield chunk({
    role: "assistant",
    content: text,
    ...(reasoning ? { reasoning_content: reasoning } : {}),
    tool_calls: toolCalls,
    provider_state: { anthropic: replay },
  });
  yield chunk({}, STOP_REASONS[msg.stop_reason ?? "end_turn"] ?? "stop");
  yield usage(inputTokensOf(msg.usage), msg.usage.output_tokens);
}

/** The documented 400 for thinking blocks whose conversation prefix changed (preserved thinking). */
function isThinkingBindingError(e: unknown): boolean {
  return e instanceof Anthropic.BadRequestError && /`thinking` block|Invalid `signature`/.test(e.message);
}

/** Drops stored thinking blocks from the history (in place), keeping text and tool_use blocks. */
function stripThinking(messages: ChatCompletionMessageParam[]): void {
  for (const m of messages) {
    const state = (m as { provider_state?: ProviderState }).provider_state;
    if (state?.anthropic) state.anthropic = state.anthropic.filter((b) => !isThinkingBlock(b));
  }
}

export function anthropicChatClient(client: Anthropic): ChatClient {
  return {
    provider: "anthropic",
    async streamChat(params, signal) {
      const send = async () => {
        const { system, messages } = toAnthropicMessages(params.messages);
        const tools = params.tools
          ?.filter((t) => t.type === "function")
          .map((t) => ({
            name: t.function.name,
            description: t.function.description ?? "",
            input_schema: (t.function.parameters ?? { type: "object" }) as Anthropic.Tool.InputSchema,
          }));
        const think = claudeThinking(params.model, params.thinking);
        let maxTokens = params.max_tokens ?? params.max_completion_tokens ?? 4096;
        const budget = (think.thinking as { budget_tokens?: number } | undefined)?.budget_tokens;
        if (budget) maxTokens = Math.max(maxTokens, budget + 2048);
        // No temperature/top_p/top_k: since API version 2026-10-21 any of them is a 400 on every model.
        const body = {
          model: params.model,
          max_tokens: maxTokens,
          system: system || undefined,
          messages,
          ...(tools?.length ? { tools, tool_choice: { type: "auto" as const } } : {}),
          ...think,
        } as Anthropic.MessageCreateParamsNonStreaming;
        if (params.stream) {
          return fromAnthropicStream(await client.messages.create({ ...body, stream: true }, { signal }), params.model);
        }
        return fromAnthropicMessage(await client.messages.create(body, { signal }));
      };
      try {
        return await send();
      } catch (e) {
        // Our history was edited (context compaction, a provider switch, …): strip the stale
        // thinking blocks once and retry, as the API docs recommend.
        if (!isThinkingBindingError(e)) throw e;
        stripThinking(params.messages);
        return send();
      }
    },
    async listModels() {
      const out: ModelEntry[] = [];
      for await (const m of client.models.list({ limit: 100 })) {
        if ((m as any).lifecycle === "retired") continue;
        out.push({ id: m.id, label: m.display_name, contextTokens: (m as any).max_input_tokens ?? undefined });
      }
      return out;
    },
  };
}
