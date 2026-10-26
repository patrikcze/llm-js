import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { Agent } from "../src/agent.ts";
import { anthropicChatClient, createChatClient, ProviderError, toAnthropicMessages } from "../src/providers.ts";
import { fsTools } from "../src/tools/fs.ts";
import { assertValidTranscript } from "./harness.ts";

describe("toAnthropicMessages", () => {
  it("moves system out, maps tool calls/results, sanitises ids and keeps roles alternating", () => {
    const { system, messages } = toAnthropicMessages([
      { role: "system", content: "rules" },
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "Reading.",
        tool_calls: [
          { id: "call:1", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } },
          { id: "call:2", type: "function", function: { name: "list_dir", arguments: "not json" } },
        ],
      },
      { role: "tool", tool_call_id: "call:1", content: "data" },
      { role: "tool", tool_call_id: "call:2", content: "Error: boom" },
      { role: "user", content: "next" },
    ]);
    assert.equal(system, "rules");
    assert.deepEqual(
      messages.map((m) => m.role),
      ["user", "assistant", "user"],
    );
    const [text, use1, use2] = messages[1]!.content as any[];
    assert.deepEqual(text, { type: "text", text: "Reading." });
    assert.deepEqual(use1, { type: "tool_use", id: "call_1", name: "read_file", input: { path: "a" } });
    assert.deepEqual(use2.input, {});
    const results = messages[2]!.content as any[];
    assert.deepEqual(
      results.map((b) => b.type),
      ["tool_result", "tool_result", "text"],
    );
    assert.equal(results[0].tool_use_id, "call_1");
    assert.equal(results[1].is_error, true);
  });
});

describe("createChatClient", () => {
  it("requires keys for hosted providers and a URL for custom ones", () => {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      assert.throws(() => createChatClient({ kind: "openai" }), ProviderError);
      assert.throws(() => createChatClient({ kind: "custom" }), /base URL/);
      assert.equal(createChatClient({ kind: "openai", apiKey: "sk-test" }).provider, "openai");
      assert.equal(createChatClient({ kind: "anthropic", apiKey: "sk-ant-test" }).provider, "anthropic");
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
    }
  });
});

describe("Anthropic adapter end to end", () => {
  let server: ReturnType<typeof createServer>;
  let url = "";
  const requests: any[] = [];
  const headers: Record<string, string | string[] | undefined>[] = [];

  const sse = (events: object[]) => events.map((e: any) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  const start = (id: string) => ({
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      content: [],
      model: "claude-test",
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 120, output_tokens: 1 },
    },
  });

  before(async () => {
    server = createServer(async (req, res) => {
      if (req.method === "GET" && req.url?.startsWith("/v1/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(
          JSON.stringify({
            data: [
              {
                id: "claude-test",
                display_name: "Claude Test",
                type: "model",
                created_at: "2026-01-01T00:00:00Z",
                max_input_tokens: 200000,
                lifecycle: "active",
              },
              {
                id: "claude-old",
                display_name: "Claude Old",
                type: "model",
                created_at: "2024-01-01T00:00:00Z",
                max_input_tokens: 100000,
                lifecycle: "retired",
              },
            ],
            has_more: false,
            first_id: "claude-test",
            last_id: "claude-old",
          }),
        );
      }
      let body = "";
      for await (const c of req) body += c;
      requests.push(JSON.parse(body));
      headers.push(req.headers);
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (requests.length === 1) {
        res.end(
          sse([
            start("msg_1"),
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me read it." } },
            { type: "content_block_stop", index: 0 },
            { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_01", name: "read_file", input: {} } },
            { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path": ' } },
            { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"a.txt"}' } },
            { type: "content_block_stop", index: 1 },
            { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 30 } },
            { type: "message_stop" },
          ]),
        );
      } else {
        res.end(
          sse([
            start("msg_2"),
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "It says hello." } },
            { type: "content_block_stop", index: 0 },
            { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
            { type: "message_stop" },
          ]),
        );
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  it("lists active models with context sizes", async () => {
    const client = anthropicChatClient(new Anthropic({ apiKey: "sk-ant-test", baseURL: url }));
    assert.deepEqual(await client.listModels(), [{ id: "claude-test", label: "Claude Test", contextTokens: 200000 }]);
  });

  it("runs the agent loop: native tool_use in, tool_result back, final answer out", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-anthropic-"));
    try {
      await writeFile(path.join(workspace, "a.txt"), "hello");
      const agent = new Agent({
        client: anthropicChatClient(new Anthropic({ apiKey: "sk-ant-test", baseURL: url })),
        model: "claude-test",
        workspace,
        tools: fsTools,
        permissions: { mode: "auto" },
      });
      const r = await agent.run("what is in a.txt?");
      assert.equal(r.text, "It says hello.");
      assert.equal(r.stopReason, "completed");
      assert.deepEqual(
        r.toolCalls.map((c) => [c.name, c.status]),
        [["read_file", "ok"]],
      );
      assert.deepEqual(r.usage, { promptTokens: 240, completionTokens: 35 });
      assertValidTranscript(agent.messages);

      // First request: native shape.
      const first = requests[0];
      // The SDK authenticates with x-api-key or (newer versions) a Bearer header.
      const auth = headers[0]!["x-api-key"] ?? String(headers[0]!.authorization).replace(/^Bearer /, "");
      assert.equal(auth, "sk-ant-test");
      assert.equal(first.model, "claude-test");
      assert.equal(first.stream, true);
      assert.match(first.system, /autonomous assistant/);
      assert.ok(first.tools.some((t: any) => t.name === "read_file" && t.input_schema.type === "object"));
      assert.equal(first.messages[0].role, "user");
      // Second request carries the tool_result for toolu_01.
      const second = requests[1];
      const toolResult = second.messages.at(-1).content[0];
      assert.equal(toolResult.type, "tool_result");
      assert.equal(toolResult.tool_use_id, "toolu_01");
      assert.match(toolResult.content, /hello/);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
