/**
 * Test harness: a scripted, OpenAI-compatible chat server plus helpers to build an Agent
 * against it in a temporary workspace. Responses stream as SSE exactly like llama.cpp / OpenAI,
 * including tool-call arguments split across chunks, so the real streaming code path is tested.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { Agent, type AgentOptions } from "../src/agent.ts";
import { fsTools } from "../src/tools/fs.ts";

export interface ScriptedToolCall {
  name: string;
  /** Object (serialised for you) or a raw string, to test malformed JSON. */
  args: unknown;
  id?: string;
}

export type ScriptedReply =
  | { content?: string; reasoning?: string; tool_calls?: ScriptedToolCall[]; finish_reason?: string; delayMs?: number }
  | { status: number; error: string };

export type ScriptStep = ScriptedReply | ((req: ChatRequest) => ScriptedReply);

export interface ChatRequest {
  model: string;
  messages: ChatCompletionMessageParam[];
  tools?: { function: { name: string } }[];
  [k: string]: unknown;
}

export class MockLLM {
  readonly requests: ChatRequest[] = [];
  private server!: Server;
  private script: ScriptStep[] = [];
  url = "";

  /** Queue the replies for the next requests, in order. */
  enqueue(...steps: ScriptStep[]): this {
    this.script.push(...steps);
    return this;
  }

  get remaining(): number {
    return this.script.length;
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) =>
      this.handle(req, res).catch((e) => {
        res.statusCode = 500;
        res.end(String(e?.stack ?? e));
      }),
    );
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((r) => this.server.close(r));
  }

  private async handle(req: IncomingMessage, res: import("node:http").ServerResponse) {
    if (req.url === "/v1/models") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ object: "list", data: [{ id: "mock-model", object: "model" }] }));
      return;
    }
    if (req.url !== "/v1/chat/completions") {
      res.statusCode = 404;
      res.end();
      return;
    }
    let body = "";
    for await (const c of req) body += c;
    const request = JSON.parse(body) as ChatRequest;
    // Deep copy: the agent mutates its transcript later (compaction).
    this.requests.push(structuredClone(request));

    const step = this.script.shift();
    if (!step) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: { message: "MockLLM script exhausted" } }));
      return;
    }
    const reply = typeof step === "function" ? step(request) : step;
    if ("status" in reply) {
      res.statusCode = reply.status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: { message: reply.error, code: reply.status } }));
      return;
    }

    // Non-streaming request: one JSON chat completion.
    if (request.stream === false) {
      const toolCalls = (reply.tool_calls ?? []).map((tc, i) => ({
        id: tc.id ?? `call_${this.requests.length}_${i}`,
        type: "function",
        function: { name: tc.name, arguments: typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args) },
      }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-mock",
          object: "chat.completion",
          created: 0,
          model: request.model,
          choices: [
            {
              index: 0,
              finish_reason: reply.finish_reason ?? (toolCalls.length ? "tool_calls" : "stop"),
              message: {
                role: "assistant",
                content: reply.content ?? null,
                reasoning_content: reply.reasoning,
                ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
              },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
        }),
      );
      return;
    }

    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const base = { id: "chatcmpl-mock", object: "chat.completion.chunk", created: 0, model: request.model };
    const send = (delta: object, finish: string | null = null) =>
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);

    send({ role: "assistant" });
    if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
    if (reply.reasoning) send({ reasoning_content: reply.reasoning });
    // Split text into small chunks like a real stream.
    for (const piece of (reply.content ?? "").match(/.{1,7}/gs) ?? []) send({ content: piece });
    (reply.tool_calls ?? []).forEach((tc, index) => {
      const args = typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args);
      const mid = Math.floor(args.length / 2);
      send({
        tool_calls: [
          {
            index,
            id: tc.id ?? `call_${this.requests.length}_${index}`,
            type: "function",
            function: { name: tc.name, arguments: args.slice(0, mid) },
          },
        ],
      });
      send({ tool_calls: [{ index, function: { arguments: args.slice(mid) } }] });
    });
    const finish = reply.finish_reason ?? (reply.tool_calls?.length ? "tool_calls" : "stop");
    send({}, finish);
    // Like a real server, count the tool schemas as part of the prompt.
    const promptChars = JSON.stringify(request.messages).length + JSON.stringify(request.tools ?? []).length;
    res.write(
      `data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: Math.ceil(promptChars / 3.5), completion_tokens: 10, total_tokens: 0 } })}\n\n`,
    );
    res.end("data: [DONE]\n\n");
  }
}

/** A temp workspace plus a mock server and an Agent wired to both. */
export async function setup(overrides: Partial<AgentOptions> = {}) {
  const llm = await new MockLLM().start();
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-test-"));
  const client = new OpenAI({ baseURL: `${llm.url}/v1`, apiKey: "test", maxRetries: 0 });
  const notices: string[] = [];
  const agent = new Agent({
    client,
    model: "mock-model",
    workspace,
    tools: fsTools,
    permissions: { mode: "auto" },
    events: { onNotice: (m) => notices.push(m) },
    ...overrides,
  });
  return {
    llm,
    agent,
    workspace,
    client,
    notices,
    async cleanup() {
      await llm.stop();
      await rm(workspace, { recursive: true, force: true });
    },
  };
}

/**
 * Invariants every transcript must satisfy before it is sent to a model.
 * Chat templates (Gemma, Llama, Qwen...) reject transcripts that break these.
 */
export function assertValidTranscript(messages: ChatCompletionMessageParam[]): void {
  assert.equal(messages[0]?.role, "system", "first message must be the system prompt");
  assert.equal(messages.filter((m) => m.role === "system").length, 1, "exactly one system message");
  for (let i = 1; i < messages.length; i++) {
    const m = messages[i]!;
    const prev = messages[i - 1]!;
    if (m.role === "tool") {
      // Must answer a tool call of the nearest preceding assistant message.
      let j = i - 1;
      while (messages[j]?.role === "tool") j--;
      const owner = messages[j];
      assert.equal(owner?.role, "assistant", `tool message at ${i} has no assistant before it`);
      const ids = ((owner as any).tool_calls ?? []).map((c: any) => c.id);
      assert.ok(ids.includes(m.tool_call_id), `tool message at ${i} answers unknown call ${m.tool_call_id}`);
    }
    if (m.role === "assistant" && (m as any).tool_calls?.length) {
      const ids: string[] = (m as any).tool_calls.map((c: any) => c.id);
      const answered = [];
      for (let k = i + 1; messages[k]?.role === "tool"; k++) answered.push((messages[k] as any).tool_call_id);
      assert.deepEqual([...answered].sort(), [...ids].sort(), `assistant tool calls at ${i} are not all answered exactly once`);
    }
    if (m.role === "user") assert.notEqual(prev.role, "user", `two user messages in a row at ${i}`);
    if (m.role === "assistant" && !(m as any).tool_calls?.length) {
      assert.notEqual(prev.role, "assistant", `two assistant messages in a row at ${i}`);
    }
  }
}

/** Last tool result content the model was sent. */
export function toolResults(req: ChatRequest): string[] {
  const out: string[] = [];
  for (let i = req.messages.length - 1; i >= 0 && req.messages[i]!.role === "tool"; i--) {
    out.unshift(String(req.messages[i]!.content));
  }
  return out;
}
