/** Thinking and streaming switches, image input, view_image, and the Claude-specific rules. */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { Agent } from "../src/agent.ts";
import { anthropicChatClient, claudeThinking } from "../src/providers.ts";
import { fsTools, sniffImage } from "../src/tools/fs.ts";
import { assertValidTranscript, setup, toolResults } from "./harness.ts";

// 1×1 transparent PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const PNG_URL = `data:image/png;base64,${PNG.toString("base64")}`;

describe("thinking switch (OpenAI-compatible servers)", () => {
  it("auto sends nothing; on/off set chat_template_kwargs.enable_thinking", async () => {
    const t = await setup();
    try {
      t.llm.enqueue({ content: "a" }, { content: "b" }, { content: "c" });
      await t.agent.run("one");
      t.agent.setThinking("off");
      await t.agent.run("two");
      t.agent.setThinking("on");
      await t.agent.run("three");
      const kw = t.llm.requests.map((r) => (r as any).chat_template_kwargs);
      assert.deepEqual(kw, [undefined, { enable_thinking: false }, { enable_thinking: true }]);
      assert.ok(
        t.llm.requests.every((r) => !("thinking" in r)),
        "the internal thinking field must not leak",
      );
    } finally {
      await t.cleanup();
    }
  });

  it("a server that rejects the switch is retried without it, then never sent it again", async () => {
    const t = await setup({ thinking: "off" });
    try {
      t.llm.enqueue(
        { status: 400, error: "Unrecognized request argument: chat_template_kwargs" },
        { content: "fine" },
        { content: "again" },
      );
      assert.equal((await t.agent.run("hi")).text, "fine");
      await t.agent.run("more");
      assert.deepEqual(
        t.llm.requests.map((r) => Boolean((r as any).chat_template_kwargs)),
        [true, false, false],
      );
    } finally {
      await t.cleanup();
    }
  });
});

describe("streaming switch", () => {
  it("non-streaming requests run the full tool loop", async () => {
    const t = await setup({ stream: false });
    try {
      await writeFile(path.join(t.workspace, "a.txt"), "hello");
      t.llm.enqueue({ reasoning: "look", tool_calls: [{ name: "read_file", args: { path: "a.txt" } }] }, { content: "It says hello." });
      const r = await t.agent.run("read a.txt");
      assert.equal(r.text, "It says hello.");
      assert.equal(r.usage.promptTokens, 200);
      for (const req of t.llm.requests) {
        assert.equal(req.stream, false);
        assert.equal(req.stream_options, undefined);
      }
      assertValidTranscript(t.agent.messages);
      t.agent.setStreaming(true);
      t.llm.enqueue({ content: "streamed" });
      assert.equal((await t.agent.run("again")).text, "streamed");
      assert.equal(t.llm.requests.at(-1)!.stream, true);
    } finally {
      await t.cleanup();
    }
  });
});

describe("image input", () => {
  it("sends user images as content parts and budgets them per image, not by base64 size", async () => {
    const t = await setup({ contextTokens: 8000, maxOutputTokens: 500 });
    try {
      const big = `data:image/png;base64,${"A".repeat(400_000)}`; // ~300 KB image
      t.llm.enqueue({ content: "a cat" });
      await t.agent.run([
        { type: "text", text: "what is this?" },
        { type: "image_url", image_url: { url: big } },
      ]);
      const sent = t.llm.requests[0]!.messages.at(-1)!.content as any[];
      assert.equal(sent[1].image_url.url, big, "the image must reach the model untouched");
      assert.ok(t.agent.estimateTokens() < 5000, `estimate ${t.agent.estimateTokens()} counts base64 as text`);
      assert.ok(!t.notices.some((n) => n.startsWith("Compacted")), "one small image must not trigger compaction");
    } finally {
      await t.cleanup();
    }
  });

  it("drops images and retries once when the model rejects image input", async () => {
    const t = await setup();
    try {
      t.llm.enqueue(
        { status: 400, error: "image input is not supported - hint: you may need to provide the mmproj" },
        { content: "text only" },
      );
      const r = await t.agent.run([
        { type: "text", text: "describe" },
        { type: "image_url", image_url: { url: PNG_URL } },
      ]);
      assert.equal(r.text, "text only");
      const retried = JSON.stringify(t.llm.requests[1]!.messages);
      assert.ok(!retried.includes("image_url") && retried.includes("image omitted"));
      assert.ok(t.notices.some((n) => /rejected image input/.test(n)));
    } finally {
      await t.cleanup();
    }
  });
});

describe("view_image tool", () => {
  it("shows a workspace image to the model right after the tool results", async () => {
    const t = await setup();
    try {
      await writeFile(path.join(t.workspace, "shot.png"), PNG);
      await writeFile(path.join(t.workspace, "fake.png"), "not an image");
      t.llm.enqueue(
        {
          tool_calls: [
            { name: "view_image", args: { path: "shot.png" } },
            { name: "view_image", args: { path: "fake.png" } },
          ],
        },
        (req) => {
          const [ok, bad] = toolResults(req.messages.at(-1)!.role === "user" ? { ...req, messages: req.messages.slice(0, -1) } : req);
          assert.match(ok!, /Showing shot\.png \(image\/png/);
          assert.match(bad!, /not a PNG, JPEG, GIF or WebP/);
          const shown = req.messages.at(-1)!;
          assert.equal(shown.role, "user");
          const parts = shown.content as any[];
          assert.equal(parts.filter((p) => p.type === "image_url").length, 1, "only the valid image is shown");
          assert.equal(parts[1].image_url.url, PNG_URL);
          return { content: "A tiny transparent pixel." };
        },
      );
      const r = await t.agent.run("what does shot.png show?");
      assert.equal(r.toolCalls[0]!.images, 1);
      assert.equal(r.toolCalls[1]!.status, "error");
      assertValidTranscript(t.agent.messages);
    } finally {
      await t.cleanup();
    }
  });

  it("sniffs formats by content", () => {
    assert.equal(sniffImage(PNG), "image/png");
    assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
    assert.equal(sniffImage(Buffer.from("GIF89a")), "image/gif");
    assert.equal(sniffImage(Buffer.from("RIFF0000WEBPVP8 ")), "image/webp");
    assert.equal(sniffImage(Buffer.from("<svg/>")), undefined);
  });
});

describe("Claude specifics", () => {
  it("maps /think per model generation", () => {
    assert.deepEqual(claudeThinking("claude-opus-5-5", "auto"), {});
    assert.deepEqual(claudeThinking("claude-opus-5-5", "on"), { thinking: { type: "adaptive", display: "summarized" } });
    assert.deepEqual(claudeThinking("claude-opus-5-5", "off"), { output_config: { effort: "low" } });
    assert.deepEqual(claudeThinking("claude-fable-5-1", "off"), { output_config: { effort: "low" } });
    assert.deepEqual(claudeThinking("claude-sonnet-5-5", "off"), { thinking: { type: "between_tools" } });
    assert.deepEqual(claudeThinking("claude-opus-4-8", "off"), { thinking: { type: "disabled" } });
    assert.deepEqual(claudeThinking("claude-haiku-5-5", "off"), { thinking: { type: "disabled" } });
    assert.deepEqual(claudeThinking("claude-haiku-4-5", "on"), { thinking: { type: "enabled", budget_tokens: 4096 } });
    assert.deepEqual(claudeThinking("claude-haiku-4-5", "off"), {});
  });

  describe("against a mock Messages API", () => {
    let server: ReturnType<typeof createServer>;
    let url = "";
    let workspace = "";
    const requests: any[] = [];
    let script: Array<(req: any) => { status?: number; body: string; sse?: boolean }> = [];

    const sse = (events: object[]) => events.map((e: any) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
    const start = (id: string) => ({
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-opus-5-5",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 50, output_tokens: 1 },
      },
    });
    const finish = (reason: string) => [
      { type: "message_delta", delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 9 } },
      { type: "message_stop" },
    ];
    const thinkingThenTool = () => ({
      sse: true,
      body: sse([
        start("msg_1"),
        { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "I should read it." } },
        { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "SIG-abc" } },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "redacted_thinking", data: "REDACTED-xyz" } },
        { type: "content_block_stop", index: 1 },
        { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_1", name: "read_file", input: {} } },
        { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"path":"a.txt"}' } },
        { type: "content_block_stop", index: 2 },
        ...finish("tool_use"),
      ]),
    });
    const text = (t: string) => ({
      sse: true,
      body: sse([
        start("msg_2"),
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } },
        { type: "content_block_stop", index: 0 },
        ...finish("end_turn"),
      ]),
    });

    before(async () => {
      workspace = await mkdtemp(path.join(os.tmpdir(), "agent-claude-"));
      await writeFile(path.join(workspace, "a.txt"), "hello");
      server = createServer(async (req, res) => {
        let body = "";
        for await (const c of req) body += c;
        const parsed = JSON.parse(body);
        requests.push(parsed);
        const step = script.shift();
        if (!step) return res.writeHead(500).end("script exhausted");
        const out = step(parsed);
        res.writeHead(out.status ?? 200, { "content-type": out.sse ? "text/event-stream" : "application/json" });
        res.end(out.body);
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    after(async () => {
      server.close();
      await rm(workspace, { recursive: true, force: true });
    });

    const agent = (opts: Record<string, unknown> = {}) =>
      new Agent({
        client: anthropicChatClient(new Anthropic({ apiKey: "sk-ant-test", baseURL: url, maxRetries: 0 })),
        model: "claude-opus-5-5",
        workspace,
        tools: fsTools,
        permissions: { mode: "auto" },
        temperature: 0.2,
        ...opts,
      });

    it("replays thinking blocks verbatim, sends images natively, never sends temperature", async () => {
      requests.length = 0;
      script = [thinkingThenTool, () => text("It says hello.")];
      const a = agent({ thinking: "on" });
      const r = await a.run([
        { type: "text", text: "read a.txt; also, this image:" },
        { type: "image_url", image_url: { url: PNG_URL } },
      ]);
      assert.equal(r.text, "It says hello.");
      const [first, second] = requests;
      assert.equal(first.temperature, undefined, "temperature is a 400 since API version 2026-10-21");
      assert.deepEqual(first.thinking, { type: "adaptive", display: "summarized" });
      assert.deepEqual(first.messages[0].content[1], {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: PNG.toString("base64") },
      });
      // The assistant turn comes back exactly as produced: signed thinking, redacted thinking, tool_use.
      assert.deepEqual(second.messages[1].content, [
        { type: "thinking", thinking: "I should read it.", signature: "SIG-abc" },
        { type: "redacted_thinking", data: "REDACTED-xyz" },
        { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "a.txt" } },
      ]);
      assert.equal(second.messages[2].content[0].type, "tool_result");
    });

    it("strips stale thinking blocks and retries once on the preserved-thinking 400", async () => {
      requests.length = 0;
      const bindingError = {
        status: 400,
        body: JSON.stringify({
          type: "error",
          error: {
            type: "invalid_request_error",
            message: "messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.",
          },
        }),
      };
      script = [thinkingThenTool, () => bindingError, () => text("Recovered.")];
      const r = await agent().run("read a.txt");
      assert.equal(r.text, "Recovered.");
      assert.equal(requests.length, 3);
      const retried = requests[2].messages[1].content;
      assert.deepEqual(
        retried.map((b: any) => b.type),
        ["tool_use"],
        "thinking blocks are gone, tool_use stays",
      );
    });

    it("works without streaming and maps /think off to low effort on Opus 5.5", async () => {
      requests.length = 0;
      script = [
        () => ({
          body: JSON.stringify({
            id: "msg_ns",
            type: "message",
            role: "assistant",
            model: "claude-opus-5-5",
            content: [{ type: "text", text: "Non-streamed." }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 3 },
          }),
        }),
      ];
      const r = await agent({ stream: false, thinking: "off" }).run("hi");
      assert.equal(r.text, "Non-streamed.");
      assert.equal(requests[0].stream, undefined);
      assert.deepEqual(requests[0].output_config, { effort: "low" });
      assert.equal(requests[0].thinking, undefined);
    });
  });
});
