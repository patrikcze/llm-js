/** grep and glob: the same expectations for the ripgrep and the built-in backend. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { globTool, grepTool, hasRipgrep } from "../src/tools/search.ts";

const rgAvailable = await hasRipgrep();
let workspace = "";
let outside = "";
const ctx = () => ({ workspace, signal: new AbortController().signal });

before(async () => {
  workspace = await mkdtemp(path.join(os.tmpdir(), "agent-search-"));
  outside = await mkdtemp(path.join(os.tmpdir(), "agent-search-out-"));
  const w = (rel: string, text: string) =>
    mkdir(path.dirname(path.join(workspace, rel)), { recursive: true }).then(() => writeFile(path.join(workspace, rel), text));
  await w("src/app.ts", "import x from 'y';\n\nexport function alpha() {\n  return 1;\n}\n\nexport function beta() {\n  return 2;\n}\n");
  await w("src/util/helpers.ts", "export const ALPHA_FLAG = true;\n// a.b(c) literal\n");
  await w("src/view.tsx", "export const Alpha = () => null;\n");
  await w("config.json", '{ "alpha": 1 }\n');
  await w("deploy.yml", "alpha: yes\n");
  await w("notes.md", "nothing here\n");
  await w("node_modules/pkg/index.ts", "export function alpha() {}\n");
  await w("secret.log", "alpha in an ignored file\n");
  await w(".gitignore", "*.log\n");
  await writeFile(path.join(outside, "leak.ts"), "export function alpha() { /* outside */ }\n");
  await symlink(path.join(outside, "leak.ts"), path.join(workspace, "src/leak.ts"));
  execFileSync("git", ["init", "-q"], { cwd: workspace });
  // Deterministic modification times for glob's newest-first order.
  const base = Date.now() / 1000 - 1000;
  for (const [i, f] of ["notes.md", "src/app.ts", "src/util/helpers.ts", "src/view.tsx"].entries()) {
    await utimes(path.join(workspace, f), base + i * 10, base + i * 10);
  }
});
after(async () => {
  await rm(workspace, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

for (const backend of ["ripgrep", "builtin"] as const) {
  describe(`grep (${backend})`, { skip: backend === "ripgrep" && !rgAvailable && "ripgrep not installed" }, () => {
    before(() => {
      if (backend === "builtin") process.env.AGENT_NO_RIPGREP = "1";
    });
    after(() => {
      delete process.env.AGENT_NO_RIPGREP;
    });
    const grep = (args: Parameters<typeof grepTool.run>[0]) => grepTool.run(args, ctx());

    it("prints path:line:text, skipping node_modules, .gitignored files and outside symlinks", async () => {
      assert.equal(await grep({ pattern: "function alpha" }), "src/app.ts:3:export function alpha() {");
    });

    it("adds context lines and separates groups with --", async () => {
      assert.equal(
        await grep({ pattern: "^export function", context: 1 }),
        [
          "src/app.ts-2-",
          "src/app.ts:3:export function alpha() {",
          "src/app.ts-4-  return 1;",
          "--",
          "src/app.ts-6-",
          "src/app.ts:7:export function beta() {",
          "src/app.ts-8-  return 2;",
        ].join("\n"),
      );
    });

    it("filters by glob at any depth, case-insensitively", async () => {
      const out = await grep({ pattern: "alpha", glob: "*.ts", case_insensitive: true, output_mode: "files" });
      assert.deepEqual(out.split("\n").sort(), ["src/app.ts", "src/util/helpers.ts"]);
      const braces = await grep({ pattern: "alpha", glob: "*.{json,yml}", output_mode: "files" });
      assert.deepEqual(braces.split("\n").sort(), ["config.json", "deploy.yml"]);
    });

    it("counts matches per file and searches a single file", async () => {
      assert.equal(await grep({ pattern: "return", output_mode: "count" }), "src/app.ts:2");
      assert.equal(await grep({ pattern: "ALPHA", path: "src/util/helpers.ts" }), "src/util/helpers.ts:1:export const ALPHA_FLAG = true;");
    });

    it("supports literal search and reports invalid patterns", async () => {
      assert.match(await grep({ pattern: "a.b(c)", fixed_strings: true }), /helpers\.ts:2:\/\/ a\.b\(c\) literal/);
      await assert.rejects(grep({ pattern: "(unclosed" }), /grep failed|Invalid regular expression/);
    });

    it("stops at the limit and says so", async () => {
      const out = await grep({ pattern: ".", limit: 3 });
      assert.equal(out.split("\n").length, 4);
      assert.match(out, /stopped at 3 lines/);
    });

    it("says when nothing matches, and refuses paths outside the workspace", async () => {
      assert.match(await grep({ pattern: "zzz_not_there" }), /^No matches/);
      await assert.rejects(grep({ pattern: "x", path: "../" }), /outside the workspace/);
    });
  });
}

describe("glob", () => {
  const glob = (args: Parameters<typeof globTool.run>[0]) => globTool.run(args, ctx());

  it("matches at any depth, newest first, without ignored, vendored or escaping files", async () => {
    assert.equal(await glob({ pattern: "*.ts" }), "src/util/helpers.ts\nsrc/app.ts");
    assert.equal(await glob({ pattern: "src/*.ts*" }), "src/view.tsx\nsrc/app.ts");
    assert.match(await glob({ pattern: "*.log" }), /^No files match/);
  });

  it("supports braces, a base path and a limit", async () => {
    assert.deepEqual((await glob({ pattern: "*.{json,yml}" })).split("\n").sort(), ["config.json", "deploy.yml"]);
    assert.equal(await glob({ pattern: "*.ts", path: "src/util" }), "src/util/helpers.ts");
    assert.match(await glob({ pattern: "*", limit: 2 }), /\[\d+ more; narrow the pattern or raise limit\]$/);
  });
});
