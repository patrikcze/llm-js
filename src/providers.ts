import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type {
  ChatCompletionChunk,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";

// ===========================================================================
// Provider contract
//
// The agent speaks one dialect: OpenAI chat-completions requests and stream chunks.
// Every backend implements `ChatClient`; adapters translate where the wire format differs.
// ===========================================================================

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
  streamChat(params: ChatCompletionCreateParamsStreaming, signal: AbortSignal): Promise<AsyncIterable<ChatCompletionChunk>>;
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

// ---------------------------------------------------------------------------
// OpenAI and OpenAI-compatible servers
// ---------------------------------------------------------------------------

// Models listed by OpenAI that cannot chat with tools.
const OPENAI_NON_CHAT = /(embedding|whisper|tts|dall-e|davinci|babbage|moderation|image|audio|realtime|transcribe|search|instruct|sora|computer-use)/;

export function openAIChatClient(client: OpenAI, provider = "openai-compatible"): ChatClient {
  return {
    provider,
    async streamChat(params, signal) {
      let body: ChatCompletionCreateParamsStreaming = params;
      if (provider === "openai" && params.max_tokens !== undefined) {
        // OpenAI's newer models only accept max_completion_tokens.
        const { max_tokens, ...rest } = params;
        body = { ...rest, max_completion_tokens: max_tokens };
      }
      return client.chat.completions.create(body, { signal });
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
        const text = textOf(m.content);
        push("user", [{ type: "text", text: text || "(empty)" }]);
        break;
      }
      case "assistant": {
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

const STOP_REASONS: Record<string, ChatCompletionChunk.Choice["finish_reason"]> = {
  end_turn: "stop",
  stop_sequence: "stop",
  tool_use: "tool_calls",
  max_tokens: "length",
  model_context_window_exceeded: "length",
  refusal: "content_filter",
};

/** Anthropic stream events -> OpenAI chat-completion chunks. */
export async function* fromAnthropicStream(
  events: AsyncIterable<Anthropic.RawMessageStreamEvent>,
  model: string,
): AsyncGenerator<ChatCompletionChunk> {
  const base = { id: "", object: "chat.completion.chunk" as const, created: Math.floor(Date.now() / 1000), model };
  const chunk = (delta: ChatCompletionChunk.Choice.Delta & { reasoning_content?: string }, finish: ChatCompletionChunk.Choice["finish_reason"] = null): ChatCompletionChunk => ({
    ...base,
    choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
  });

  const toolIndexByBlock = new Map<number, number>();
  let nextTool = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let stop: string | null = null;

  for await (const ev of events) {
    switch (ev.type) {
      case "message_start": {
        const u = ev.message.usage;
        base.id = ev.message.id;
        inputTokens = u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        outputTokens = u.output_tokens;
        break;
      }
      case "content_block_start":
        if (ev.content_block.type === "tool_use") {
          const index = nextTool++;
          toolIndexByBlock.set(ev.index, index);
          yield chunk({ tool_calls: [{ index, id: ev.content_block.id, type: "function", function: { name: ev.content_block.name, arguments: "" } }] });
        }
        break;
      case "content_block_delta":
        if (ev.delta.type === "text_delta") yield chunk({ content: ev.delta.text });
        else if (ev.delta.type === "thinking_delta") yield chunk({ reasoning_content: ev.delta.thinking });
        else if (ev.delta.type === "input_json_delta") {
          const index = toolIndexByBlock.get(ev.index);
          if (index !== undefined) yield chunk({ tool_calls: [{ index, function: { arguments: ev.delta.partial_json } }] });
        }
        break;
      case "message_delta":
        stop = ev.delta.stop_reason;
        if (ev.usage?.output_tokens != null) outputTokens = ev.usage.output_tokens;
        break;
    }
  }
  yield chunk({}, STOP_REASONS[stop ?? "end_turn"] ?? "stop");
  yield { ...base, choices: [], usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens } };
}

export function anthropicChatClient(client: Anthropic): ChatClient {
  return {
    provider: "anthropic",
    async streamChat(params, signal) {
      const { system, messages } = toAnthropicMessages(params.messages);
      const tools = params.tools
        ?.filter((t) => t.type === "function")
        .map((t) => ({
          name: t.function.name,
          description: t.function.description ?? "",
          input_schema: (t.function.parameters ?? { type: "object" }) as Anthropic.Tool.InputSchema,
        }));
      const events = await client.messages.create(
        {
          model: params.model,
          max_tokens: params.max_tokens ?? params.max_completion_tokens ?? 4096,
          system: system || undefined,
          messages,
          ...(tools?.length ? { tools, tool_choice: { type: "auto" as const } } : {}),
          ...(params.temperature != null ? { temperature: params.temperature } : {}),
          stream: true,
        },
        { signal },
      );
      return fromAnthropicStream(events, params.model);
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
