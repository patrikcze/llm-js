import { execFile, spawn } from "node:child_process";
import { glob, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { SAFE_GIT_ARGS, safeGitEnv } from "./git.ts";
import { isBinary, realInside, rel, resolveInWorkspace, SKIP_DIRS } from "./paths.ts";
import { type Tool, type ToolContext, ToolError } from "./types.ts";

// ===========================================================================
// glob and grep
//
// grep uses ripgrep when it is installed (fast, honours .gitignore) and an equivalent built-in
// search otherwise; both produce the same output format and stay inside the workspace (ripgrep
// does not follow symlinks; the built-in path checks every file's real path).
// ===========================================================================

const SCAN_LIMIT = 20_000; // files examined per call
const MAX_FILE_BYTES = 2_000_000;
const MAX_LINE_CHARS = 300;

let ripgrep: Promise<boolean> | undefined;
/** Whether `rg` is on PATH (checked once). AGENT_NO_RIPGREP=1 forces the built-in search. */
export function hasRipgrep(): Promise<boolean> {
  if (process.env.AGENT_NO_RIPGREP === "1") return Promise.resolve(false);
  ripgrep ??= new Promise((resolve) => execFile("rg", ["--version"], { timeout: 3000 }, (err) => resolve(!err)));
  return ripgrep;
}

/** Runs a program (no shell) with optional stdin; resolves with its exit code and output. */
function runProgram(
  file: string,
  args: string[],
  opts: { cwd: string; input?: string; signal: AbortSignal; maxLines?: number; env?: NodeJS.ProcessEnv },
) {
  return new Promise<{ code: number | null; stdout: string; stderr: string; cut: boolean }>((resolve, reject) => {
    const child = spawn(file, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let lines = 0;
    let cut = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    const onAbort = () => child.kill("SIGKILL");
    opts.signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      if (cut) return;
      stdout += chunk;
      if (opts.maxLines) {
        lines += chunk.split("\n").length - 1;
        // Enough output: stop the search instead of reading everything.
        if (lines > opts.maxLines) {
          cut = true;
          child.kill("SIGTERM");
        }
      }
    });
    child.stderr.setEncoding("utf8").on("data", (c: string) => {
      if (stderr.length < 4000) stderr += c;
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      opts.signal.removeEventListener("abort", onAbort);
      if (opts.signal.aborted) return reject(opts.signal.reason ?? new Error("aborted"));
      resolve({ code, stdout, stderr, cut });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(opts.input ?? "");
  });
}

/** Paths (relative to `root`) that .gitignore excludes; empty when `root` is not in a git repository. */
async function gitIgnored(root: string, paths: string[], signal: AbortSignal): Promise<Set<string>> {
  if (!paths.length) return new Set();
  try {
    const r = await runProgram("git", [...SAFE_GIT_ARGS, "-C", root, "check-ignore", "--stdin"], {
      cwd: root,
      input: paths.join("\n"),
      signal,
      env: safeGitEnv(),
    });
    return new Set(r.code === 0 ? r.stdout.split("\n").filter(Boolean) : []);
  } catch {
    return new Set();
  }
}

/** A glob without a slash matches at any depth, like ripgrep's --glob and .gitignore. */
const anyDepth = (pattern: string) => (pattern.includes("/") ? pattern : `**/${pattern}`);

/** Workspace files under `base` matching `pattern`, skipping vendored, ignored and escaping paths. */
async function listFiles(ctx: ToolContext, base: string, pattern: string) {
  const root = await realpath(ctx.workspace);
  const files: { full: string; rel: string; mtime: number; size: number }[] = [];
  for await (const m of glob(pattern, { cwd: base, exclude: (f: string) => SKIP_DIRS.has(path.basename(f)) })) {
    if (ctx.signal.aborted || files.length >= SCAN_LIMIT) break;
    const full = await realInside(root, path.join(base, m));
    if (!full) continue;
    const st = await stat(full).catch(() => null);
    if (!st?.isFile()) continue;
    files.push({ full, rel: rel(ctx, path.join(base, m)), mtime: st.mtimeMs, size: st.size });
  }
  const ignored = await gitIgnored(
    root,
    files.map((f) => f.rel),
    ctx.signal,
  );
  return files.filter((f) => !ignored.has(f.rel));
}

// ---------------------------------------------------------------------------
// glob
// ---------------------------------------------------------------------------

export const globTool: Tool<{ pattern: string; path?: string; limit?: number }, string> = {
  name: "glob",
  risk: "read",
  description:
    "Find files by name pattern, e.g. `**/*.ts`, `src/**/test_*.py`, `*.{json,yml}`. A pattern without `/` matches at " +
    "any depth. Returns paths relative to the workspace, most recently modified first. Skips .git, node_modules, build " +
    "output and anything in .gitignore.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern." },
      path: { type: "string", description: "Directory to search from. Default '.'" },
      limit: { type: "integer", minimum: 1, maximum: 1000, description: "Maximum paths to return. Default 200." },
    },
    required: ["pattern"],
  },
  async run({ pattern, path: p = ".", limit = 200 }, ctx) {
    const base = await resolveInWorkspace(ctx, p);
    if (!(await stat(base).catch(() => null))?.isDirectory()) throw new ToolError(`Not a directory: ${p}`);
    const files = await listFiles(ctx, base, anyDepth(pattern));
    if (!files.length) return `No files match ${pattern}${p !== "." ? ` under ${p}` : ""}.`;
    files.sort((a, b) => b.mtime - a.mtime);
    const shown = files.slice(0, limit).map((f) => f.rel);
    const more = files.length > limit ? `\n[${files.length - limit} more; narrow the pattern or raise limit]` : "";
    return `${shown.join("\n")}${more}`;
  },
};

// ---------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------

type GrepArgs = {
  pattern: string;
  path?: string;
  glob?: string;
  case_insensitive?: boolean;
  fixed_strings?: boolean;
  context?: number;
  output_mode?: "content" | "files" | "count";
  limit?: number;
};

const clipLine = (line: string) => (line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)} […]` : line);

async function grepRipgrep(a: Required<Omit<GrepArgs, "glob">> & { glob?: string }, target: string, root: string, signal: AbortSignal) {
  const args = [
    "--color=never",
    "--no-config",
    "--hidden",
    "--max-filesize",
    "2M",
    "--max-columns",
    String(MAX_LINE_CHARS),
    "--max-columns-preview",
  ];
  // Same skip list as the built-in search, with or without a .gitignore.
  for (const dir of SKIP_DIRS) args.push("--glob", `!${dir}`);
  if (a.output_mode === "files") args.push("--files-with-matches");
  else if (a.output_mode === "count") args.push("--count", "--with-filename");
  else {
    args.push("--line-number", "--with-filename", "--no-heading");
    if (a.context) args.push("--context", String(a.context));
  }
  if (a.case_insensitive) args.push("--ignore-case");
  if (a.fixed_strings) args.push("--fixed-strings");
  if (a.glob) args.push("--glob", a.glob);
  // Always pass a path: without one, ripgrep reads stdin when it is a pipe (as it is here).
  args.push("--regexp", a.pattern, "--", path.relative(root, target) || ".");
  const r = await runProgram("rg", args, { cwd: root, signal, maxLines: a.limit });
  if (r.code === 2 && !r.stdout) throw new ToolError(`grep failed: ${r.stderr.trim() || "invalid pattern"}`);
  // Searching "." prints `./src/x.ts`; report workspace-relative paths like the built-in search.
  return {
    lines: r.stdout
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => l.replace(/^\.\//, "")),
    cut: r.cut,
  };
}

async function grepBuiltin(a: Required<Omit<GrepArgs, "glob">> & { glob?: string }, target: string, ctx: ToolContext) {
  let re: RegExp;
  try {
    re = new RegExp(a.fixed_strings ? a.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : a.pattern, a.case_insensitive ? "i" : "");
  } catch (e: any) {
    throw new ToolError(`Invalid regular expression: ${e.message}`);
  }
  const st = await stat(target);
  const files = st.isFile() ? [{ full: target, rel: rel(ctx, target) }] : await listFiles(ctx, target, a.glob ? anyDepth(a.glob) : "**/*");
  files.sort((x, y) => x.rel.localeCompare(y.rel));

  const out: string[] = [];
  let cut = false;
  for (const f of files) {
    if (ctx.signal.aborted) break;
    if (out.length > a.limit) {
      cut = true;
      break;
    }
    if ((await stat(f.full)).size > MAX_FILE_BYTES) continue;
    const buf = await readFile(f.full).catch(() => null);
    if (!buf || (await isBinary(buf))) continue;
    const lines = buf.toString("utf8").split("\n");
    const hits: number[] = [];
    for (let i = 0; i < lines.length; i++) if (re.test(lines[i]!)) hits.push(i);
    if (!hits.length) continue;
    if (a.output_mode === "files") out.push(f.rel);
    else if (a.output_mode === "count") out.push(`${f.rel}:${hits.length}`);
    else {
      // Merge each hit's context window into blocks, like ripgrep's -C.
      const hitSet = new Set(hits);
      let lastPrinted = -2;
      for (const h of hits) {
        const from = Math.max(0, h - a.context);
        const to = Math.min(lines.length - 1, h + a.context);
        if (a.context && lastPrinted >= 0 && from > lastPrinted + 1) out.push("--");
        for (let i = Math.max(from, lastPrinted + 1); i <= to; i++) {
          out.push(`${f.rel}${hitSet.has(i) ? ":" : "-"}${i + 1}${hitSet.has(i) ? ":" : "-"}${clipLine(lines[i]!)}`);
        }
        lastPrinted = Math.max(lastPrinted, to);
      }
      if (a.context) out.push("--");
    }
  }
  if (out.at(-1) === "--") out.pop();
  return { lines: out, cut };
}

export const grepTool: Tool<GrepArgs, string> = {
  name: "grep",
  risk: "read",
  description:
    "Search file contents with a regular expression (ripgrep syntax; use fixed_strings for literal text). " +
    "output_mode: 'content' (default) prints `path:line:text` with optional context lines (`path-line-text`, groups " +
    "separated by --); 'files' lists matching files; 'count' prints matches per file. Filter files with `glob` " +
    "(e.g. `*.ts` or `src/**/*.{js,jsx}`). Skips .git, node_modules, binary files and anything in .gitignore.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression (or literal text with fixed_strings)." },
      path: { type: "string", description: "File or directory to search. Default '.'" },
      glob: { type: "string", description: "Only search files matching this glob." },
      case_insensitive: { type: "boolean", description: "Default false." },
      fixed_strings: { type: "boolean", description: "Treat pattern as literal text. Default false." },
      context: { type: "integer", minimum: 0, maximum: 20, description: "Lines of context around each match (content mode). Default 0." },
      output_mode: { type: "string", enum: ["content", "files", "count"], description: "Default 'content'." },
      limit: { type: "integer", minimum: 1, maximum: 2000, description: "Maximum output lines. Default 250." },
    },
    required: ["pattern"],
  },
  async run(args, ctx) {
    if (!args.pattern) throw new ToolError("pattern must not be empty");
    const a = {
      path: ".",
      case_insensitive: false,
      fixed_strings: false,
      context: 0,
      output_mode: "content" as const,
      limit: 250,
      ...args,
    };
    const target = await resolveInWorkspace(ctx, a.path);
    if (!(await stat(target).catch(() => null))) throw new ToolError(`Not found: ${a.path}`);
    const root = await realpath(ctx.workspace);
    const useRg = await hasRipgrep();
    const { lines, cut } = useRg ? await grepRipgrep(a, target, root, ctx.signal) : await grepBuiltin(a, target, ctx);
    if (!lines.length) return `No matches for ${JSON.stringify(a.pattern)}${a.path !== "." ? ` in ${a.path}` : ""}.`;
    const shown = lines.slice(0, a.limit);
    const more = cut || lines.length > a.limit ? `\n[stopped at ${a.limit} lines; narrow the pattern, path or glob, or raise limit]` : "";
    return `${shown.join("\n")}${more}`;
  },
};
