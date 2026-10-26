import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { parseArgs } from "../src/agent.ts";
import { fsTools } from "../src/tools/fs.ts";
import { assertValidTool, type Tool } from "../src/tools/types.ts";
import { webTools } from "../src/tools/web.ts";
import { assertValidTranscript, setup, toolResults } from "./harness.ts";

describe("contract", () => {
  it("every built-in tool satisfies the tool contract", () => {
    for (const t of [...fsTools, ...webTools]) assertValidTool(t);
  });

  it("rejects tools that break the contract", async () => {
    const bad: Tool = { name: "Bad Name", description: "x", parameters: { type: "object" }, risk: "read", run: async () => "" };
    assert.throws(() => assertValidTool(bad), /snake_case/);
    const noDescribe: Tool = { ...bad, name: "writer", risk: "write" };
    assert.throws(() => assertValidTool(noDescribe), /requires describe/);
    const t = await setup();
    try {
      assert.throws(() => new (t.agent.constructor as any)({ ...t, tools: [fsTools[0], fsTools[0]] }), /Duplicate tool/);
    } finally {
      await t.cleanup();
    }
  });

  it("parseArgs tolerates code fences and trailing commas", () => {
    assert.deepEqual(parseArgs('```json\n{"a": 1,}\n```'), { a: 1 });
    assert.deepEqual(parseArgs(""), {});
    assert.throws(() => parseArgs("{nope"));
  });
});

describe("agent loop", () => {
  it("answers directly when no tools are needed", async () => {
    const t = await setup();
    try {
      t.llm.enqueue({ content: "Hello there!", reasoning: "greet" });
      const r = await t.agent.run("hi");
      assert.equal(r.text, "Hello there!");
      assert.equal(r.stopReason, "completed");
      assert.equal(r.steps, 1);
      assert.ok(r.usage.promptTokens > 0);
      // Tools and the system prompt were sent.
      const req = t.llm.requests[0]!;
      assert.equal(req.messages[0]!.role, "system");
      assert.ok(req.tools!.some((x) => x.function.name === "read_file"));
      assertValidTranscript(t.agent.messages);
    } finally {
      await t.cleanup();
    }
  });

  it("runs a tool, feeds back the result, and finishes", async () => {
    const t = await setup();
    try {
      await writeFile(path.join(t.workspace, "notes.txt"), "alpha\nbeta\n");
      t.llm.enqueue({ content: "Let me read it.", tool_calls: [{ name: "read_file", args: { path: "notes.txt" } }] }, (req) => {
        const [res] = toolResults(req);
        assert.match(res!, /1\talpha/);
        return { content: "The file has alpha and beta." };
      });
      const r = await t.agent.run("what's in notes.txt?");
      assert.equal(r.text, "The file has alpha and beta.");
      assert.equal(r.toolCalls.length, 1);
      assert.equal(r.toolCalls[0]!.status, "ok");
      assert.equal(t.llm.remaining, 0);
      assertValidTranscript(t.agent.messages);
    } finally {
      await t.cleanup();
    }
  });

  it("executes parallel tool calls and returns results in call order", async () => {
    const t = await setup();
    try {
      await writeFile(path.join(t.workspace, "a.txt"), "AAA");
      await writeFile(path.join(t.workspace, "b.txt"), "BBB");
      t.llm.enqueue(
        {
          tool_calls: [
            { name: "read_file", args: { path: "a.txt" } },
            { name: "read_file", args: { path: "b.txt" } },
          ],
        },
        (req) => {
          const res = toolResults(req);
          assert.equal(res.length, 2);
          assert.match(res[0]!, /AAA/);
          assert.match(res[1]!, /BBB/);
          return { content: "done" };
        },
      );
      await t.agent.run("read both");
      assertValidTranscript(t.agent.messages);
    } finally {
      await t.cleanup();
    }
  });

  it("turns malformed JSON, schema violations and unknown tools into errors the model can fix", async () => {
    const t = await setup();
    try {
      t.llm.enqueue(
        {
          tool_calls: [
            { name: "read_file", args: '{"path": ' },
            { name: "read_file", args: { start_line: 2 } },
            { name: "read_file", args: { path: 42 } },
            { name: "launch_rockets", args: {} },
          ],
        },
        (req) => {
          const [bad, missing, wrongType, unknown] = toolResults(req);
          assert.match(bad!, /^Error: Arguments are not valid JSON/);
          assert.match(missing!, /arguments\.path is required/);
          assert.match(wrongType!, /arguments\.path must be a string/);
          assert.match(unknown!, /Unknown tool "launch_rockets"/);
          return { content: "recovered" };
        },
      );
      const r = await t.agent.run("go");
      assert.equal(r.text, "recovered");
      assert.deepEqual(
        r.toolCalls.map((c) => c.status),
        ["error", "error", "error", "error"],
      );
      assertValidTranscript(t.agent.messages);
    } finally {
      await t.cleanup();
    }
  });

  it("coerces stringly-typed numbers and booleans from small models", async () => {
    const t = await setup();
    try {
      await writeFile(path.join(t.workspace, "f.txt"), "1\n2\n3\n4\n");
      t.llm.enqueue({ tool_calls: [{ name: "read_file", args: { path: "f.txt", start_line: "2", end_line: "3" } }] }, (req) => {
        assert.match(toolResults(req)[0]!, /lines 2-3/);
        return { content: "ok" };
      });
      await t.agent.run("go");
    } finally {
      await t.cleanup();
    }
  });

  it("blocks the same call repeated more than 3 times", async () => {
    const t = await setup();
    try {
      await writeFile(path.join(t.workspace, "x.txt"), "x");
      const call = { tool_calls: [{ name: "read_file", args: { path: "x.txt" } }] };
      t.llm.enqueue(call, call, call, call, (req) => {
        assert.match(toolResults(req)[0]!, /already made this exact call 3 times/);
        return { content: "ok, stopping" };
      });
      const r = await t.agent.run("loop");
      assert.equal(r.toolCalls.at(-1)!.status, "error");
      assert.ok(t.notices.some((n) => /repeated/.test(n)));
    } finally {
      await t.cleanup();
    }
  });

  it("stops at maxSteps and asks for a summary without tools", async () => {
    const t = await setup({ maxSteps: 2 });
    try {
      t.llm.enqueue(
        { tool_calls: [{ name: "list_dir", args: {} }] },
        { tool_calls: [{ name: "list_dir", args: { path: ".", recursive: true } }] },
        (req) => {
          assert.equal(req.tools, undefined, "summary request must not offer tools");
          assert.match(String(req.messages.at(-1)!.content), /step limit/);
          return { content: "Summary: listed the dir twice." };
        },
      );
      const r = await t.agent.run("explore forever");
      assert.equal(r.stopReason, "max_steps");
      assert.equal(r.text, "Summary: listed the dir twice.");
      assertValidTranscript(t.agent.messages);
    } finally {
      await t.cleanup();
    }
  });

  it("keeps defaults when options are passed as undefined", async () => {
    const t = await setup({ maxSteps: undefined, contextTokens: undefined, permissions: undefined });
    try {
      t.llm.enqueue({ tool_calls: [{ name: "list_dir", args: {} }] }, { content: "done" });
      const r = await t.agent.run("go");
      assert.equal(r.stopReason, "completed");
      assert.equal(t.agent.permissions.mode, "ask");
    } finally {
      await t.cleanup();
    }
  });

  it("reports a truncated final answer as stopReason=length", async () => {
    const t = await setup();
    try {
      t.llm.enqueue({ content: "This is cut", finish_reason: "length" });
      assert.equal((await t.agent.run("long")).stopReason, "length");
    } finally {
      await t.cleanup();
    }
  });

  it("throws on unrecoverable server errors", async () => {
    const t = await setup();
    try {
      t.llm.enqueue({ status: 404, error: "model not found" });
      await assert.rejects(t.agent.run("hi"), /model not found/);
    } finally {
      await t.cleanup();
    }
  });
});

describe("cancellation", () => {
  it("returns stopReason=cancelled mid-stream and keeps the transcript valid", async () => {
    const t = await setup();
    try {
      t.llm.enqueue({ content: "slow", delayMs: 2000 });
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 100);
      const r = await t.agent.run("hi", ac.signal);
      assert.equal(r.stopReason, "cancelled");
      assertValidTranscript(t.agent.messages);
      // The conversation can continue afterwards.
      t.llm.enqueue({ content: "back" });
      assert.equal((await t.agent.run("again")).text, "back");
      assertValidTranscript(t.agent.messages);
    } finally {
      await t.cleanup();
    }
  });

  it("answers pending tool calls when cancelled during approval", async () => {
    const ac = new AbortController();
    const t = await setup({
      permissions: { mode: "ask" },
      approve: async () => {
        ac.abort();
        return true;
      },
    });
    try {
      t.llm.enqueue({ tool_calls: [{ name: "write_file", args: { path: "a.txt", content: "a" } }] });
      const r = await t.agent.run("write", ac.signal);
      assert.equal(r.stopReason, "cancelled");
      await assert.rejects(readFile(path.join(t.workspace, "a.txt")));
      assertValidTranscript(t.agent.messages);
    } finally {
      await t.cleanup();
    }
  });
});

describe("permission policy", () => {
  const writeCall = { tool_calls: [{ name: "write_file", args: { path: "out.txt", content: "hi" } }] };

  it("ask: a declined write does not happen and the model is told", async () => {
    const asked: string[] = [];
    const t = await setup({
      permissions: { mode: "ask" },
      approve: async (req) => {
        asked.push(req.action.summary);
        assert.equal(req.action.preview, "hi");
        return false;
      },
    });
    try {
      t.llm.enqueue(writeCall, (req) => {
        assert.match(toolResults(req)[0]!, /^Denied: The user declined: Create out\.txt/);
        return { content: "ok, not writing" };
      });
      const r = await t.agent.run("write");
      assert.deepEqual(asked, ["Create out.txt (1 lines)"]);
      assert.equal(r.toolCalls[0]!.status, "denied");
      await assert.rejects(readFile(path.join(t.workspace, "out.txt")));
    } finally {
      await t.cleanup();
    }
  });

  it("ask: an approved write happens", async () => {
    const t = await setup({ permissions: { mode: "ask" }, approve: async () => true });
    try {
      t.llm.enqueue(writeCall, { content: "written" });
      await t.agent.run("write");
      assert.equal(await readFile(path.join(t.workspace, "out.txt"), "utf8"), "hi");
    } finally {
      await t.cleanup();
    }
  });

  it("ask: invalid actions fail before the human is asked", async () => {
    let asked = false;
    const t = await setup({ permissions: { mode: "ask" }, approve: async () => (asked = true) });
    try {
      t.llm.enqueue({ tool_calls: [{ name: "delete_path", args: { path: "missing.txt" } }] }, { content: "ok" });
      const r = await t.agent.run("delete");
      assert.equal(asked, false);
      assert.match(r.toolCalls[0]!.output, /Not found/);
    } finally {
      await t.cleanup();
    }
  });

  it("read-only: write tools are refused without asking", async () => {
    const t = await setup({ permissions: { mode: "read-only" }, approve: async () => assert.fail("must not ask") });
    try {
      t.llm.enqueue(writeCall, { content: "ok" });
      const r = await t.agent.run("write");
      assert.equal(r.toolCalls[0]!.status, "denied");
      assert.match(String(t.agent.messages[0]!.content), /You may only read/);
    } finally {
      await t.cleanup();
    }
  });

  it("auto-edit: writes run, destructive actions still ask", async () => {
    const asked: string[] = [];
    const t = await setup({
      permissions: { mode: "auto-edit" },
      approve: async (r) => {
        asked.push(r.tool);
        return false;
      },
    });
    try {
      t.llm.enqueue(writeCall, { tool_calls: [{ name: "delete_path", args: { path: "out.txt" } }] }, { content: "ok" });
      await t.agent.run("write then delete");
      assert.equal(await readFile(path.join(t.workspace, "out.txt"), "utf8"), "hi");
      assert.deepEqual(asked, ["delete_path"]);
    } finally {
      await t.cleanup();
    }
  });

  it("deny list wins over auto mode", async () => {
    const t = await setup({ permissions: { mode: "auto", deny: ["write_file"] } });
    try {
      t.llm.enqueue(writeCall, { content: "ok" });
      const r = await t.agent.run("write");
      assert.equal(r.toolCalls[0]!.status, "denied");
    } finally {
      await t.cleanup();
    }
  });

  it("setPermissionMode: rebuilds the prompt before the first message, appends a note afterwards", async () => {
    const t = await setup({ permissions: { mode: "auto" } });
    try {
      t.agent.setPermissionMode("read-only");
      assert.match(String(t.agent.messages[0]!.content), /You may only read/);
      t.llm.enqueue({ content: "hi" }, { content: "noted" });
      await t.agent.run("hello");
      const systemBefore = t.agent.messages[0]!.content;
      t.agent.setPermissionMode("auto-edit");
      await t.agent.run("go on");
      // Append-only history: the system prompt is untouched (prompt caching, Claude's signed
      // thinking), and the change reaches the model with the next user message.
      assert.equal(t.agent.messages[0]!.content, systemBefore);
      assert.match(
        String(t.llm.requests[1]!.messages.at(-1)!.content),
        /^\[Permission mode changed to "auto-edit": Writes run immediately/,
      );
      assertValidTranscript(t.agent.messages);
    } finally {
      await t.cleanup();
    }
  });
});

describe("workspace sandbox", () => {
  it("refuses paths outside the workspace, including through symlinks", async () => {
    const t = await setup();
    try {
      await symlink(path.dirname(t.workspace), path.join(t.workspace, "escape"));
      t.llm.enqueue(
        {
          tool_calls: [
            { name: "read_file", args: { path: "../etc/passwd" } },
            { name: "read_file", args: { path: "/etc/passwd" } },
            { name: "list_dir", args: { path: "escape" } },
            { name: "write_file", args: { path: "escape/pwned.txt", content: "x" } },
          ],
        },
        (req) => {
          for (const r of toolResults(req)) assert.match(r, /outside the workspace/);
          return { content: "refused" };
        },
      );
      await t.agent.run("escape");
    } finally {
      await t.cleanup();
    }
  });
});

describe("symlink escapes", () => {
  const ctxFor = (workspace: string) => ({ workspace, signal: new AbortController().signal });

  it("search_files and find_files never read or list through links that leave the workspace", async () => {
    const t = await setup();
    const outside = await mkdtemp(path.join(os.tmpdir(), "agent-outside-"));
    try {
      await writeFile(path.join(outside, "secret.txt"), "TOP_SECRET_TOKEN\n");
      await mkdir(path.join(outside, "dir"));
      await writeFile(path.join(outside, "dir", "inner.txt"), "TOP_SECRET_TOKEN\n");
      await symlink(path.join(outside, "secret.txt"), path.join(t.workspace, "link.txt"));
      await symlink(path.join(outside, "dir"), path.join(t.workspace, "linkdir"));
      await writeFile(path.join(t.workspace, "ok.txt"), "TOP_SECRET_TOKEN is mentioned here\n");
      const search = fsTools.find((x) => x.name === "search_files")!;
      const find = fsTools.find((x) => x.name === "find_files")!;
      const hits = await search.run({ query: "TOP_SECRET_TOKEN" }, ctxFor(t.workspace));
      assert.equal(hits, "ok.txt:1: TOP_SECRET_TOKEN is mentioned here");
      const files = await find.run({ pattern: "**/*.txt" }, ctxFor(t.workspace));
      assert.equal(files, "ok.txt");
    } finally {
      await rm(outside, { recursive: true, force: true });
      await t.cleanup();
    }
  });

  it("refuses to write through dangling symlinks (file or directory)", async () => {
    const t = await setup();
    const outside = await mkdtemp(path.join(os.tmpdir(), "agent-outside-"));
    try {
      await symlink(path.join(outside, "planted.txt"), path.join(t.workspace, "evil.txt"));
      await symlink(path.join(outside, "missing-dir"), path.join(t.workspace, "evildir"));
      const write = fsTools.find((x) => x.name === "write_file")!;
      const mkdirTool = fsTools.find((x) => x.name === "make_dir")!;
      for (const p of ["evil.txt", "evildir/x.txt"]) {
        await assert.rejects(write.describe!({ path: p, content: "x" }, ctxFor(t.workspace)), /broken symlink/, p);
        await assert.rejects(write.run({ path: p, content: "x" }, ctxFor(t.workspace)), /broken symlink/, p);
      }
      await assert.rejects(mkdirTool.run({ path: "evildir/sub" }, ctxFor(t.workspace)), /broken symlink/);
      await assert.rejects(readFile(path.join(outside, "planted.txt")));
      await assert.rejects(readFile(path.join(outside, "missing-dir", "x.txt")));
    } finally {
      await rm(outside, { recursive: true, force: true });
      await t.cleanup();
    }
  });

  it("still writes through symlinks that stay inside the workspace", async () => {
    const t = await setup();
    try {
      await mkdir(path.join(t.workspace, "real"));
      await symlink(path.join(t.workspace, "real"), path.join(t.workspace, "alias"));
      const write = fsTools.find((x) => x.name === "write_file")!;
      await write.run({ path: "alias/a.txt", content: "hi" }, ctxFor(t.workspace));
      assert.equal(await readFile(path.join(t.workspace, "real", "a.txt"), "utf8"), "hi");
    } finally {
      await t.cleanup();
    }
  });
});

describe("filesystem tools", () => {
  it("edit_file requires a unique match and applies it", async () => {
    const t = await setup();
    try {
      const f = path.join(t.workspace, "src", "app.ts");
      await mkdir(path.dirname(f), { recursive: true });
      await writeFile(f, "const a = 1;\nconst b = 1;\n");
      t.llm.enqueue(
        { tool_calls: [{ name: "edit_file", args: { path: "src/app.ts", old_text: "= 1;", new_text: "= 2;" } }] },
        (req) => {
          assert.match(toolResults(req)[0]!, /occurs 2 times/);
          return { tool_calls: [{ name: "edit_file", args: { path: "src/app.ts", old_text: "const b = 1;", new_text: "const b = 2;" } }] };
        },
        { content: "edited" },
      );
      await t.agent.run("edit");
      assert.equal(await readFile(f, "utf8"), "const a = 1;\nconst b = 2;\n");
    } finally {
      await t.cleanup();
    }
  });

  it("find_files and search_files locate files and lines", async () => {
    const t = await setup();
    try {
      await mkdir(path.join(t.workspace, "src/deep"), { recursive: true });
      await mkdir(path.join(t.workspace, "node_modules/pkg"), { recursive: true });
      await writeFile(path.join(t.workspace, "src/deep/x.ts"), "export const TODO_ME = 1;\n");
      await writeFile(path.join(t.workspace, "node_modules/pkg/y.ts"), "TODO_ME\n");
      t.llm.enqueue(
        {
          tool_calls: [
            { name: "find_files", args: { pattern: "**/*.ts" } },
            { name: "search_files", args: { query: "todo_me" } },
          ],
        },
        (req) => {
          const [found, grep] = toolResults(req);
          assert.equal(found, "src/deep/x.ts");
          assert.equal(grep, "src/deep/x.ts:1: export const TODO_ME = 1;");
          return { content: "ok" };
        },
      );
      await t.agent.run("find");
    } finally {
      await t.cleanup();
    }
  });
});

describe("context management", () => {
  it("compacts old tool output and drops old turns but keeps the transcript valid", async () => {
    const t = await setup({ contextTokens: 6000, maxOutputTokens: 500 });
    try {
      await writeFile(path.join(t.workspace, "big.txt"), "lorem ipsum dolor sit amet\n".repeat(600));
      for (let i = 0; i < 4; i++) {
        t.llm.enqueue({ tool_calls: [{ name: "read_file", args: { path: "big.txt", start_line: i + 1 } }] }, { content: `turn ${i}` });
        await t.agent.run(`read big.txt, pass ${i}`);
        assertValidTranscript(t.agent.messages);
      }
      assert.ok(t.notices.some((n) => n.startsWith("Compacted context")));
      // Every request that was sent fit the budget and was valid.
      for (const req of t.llm.requests) {
        assertValidTranscript(req.messages);
        // The mock counts tokens as chars/3.5; the prompt must leave room for the 500 output tokens.
        assert.ok(JSON.stringify(req.messages).length / 3.5 + JSON.stringify(req.tools).length / 3.5 <= 6000 - 500);
      }
    } finally {
      await t.cleanup();
    }
  });

  it("retries with a smaller context after a context-overflow error", async () => {
    const t = await setup();
    try {
      t.llm.enqueue({ status: 400, error: "the request exceeds the available context size" }, { content: "fine now" });
      const r = await t.agent.run("hi");
      assert.equal(r.text, "fine now");
      assert.ok(t.notices.some((n) => /Context window exceeded/.test(n)));
    } finally {
      await t.cleanup();
    }
  });
});
