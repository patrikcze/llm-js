import { constants, realpathSync } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { glob } from "node:fs/promises";
import path from "node:path";
import { ToolError, truncate, type Tool, type ToolContext } from "./types.ts";

const MAX_READ_CHARS = 60_000;
const MAX_LIST_ENTRIES = 500;
const MAX_GREP_MATCHES = 200;
const SKIP_DIRS = new Set([".git", "node_modules", ".next", "dist", "build", ".venv", "__pycache__"]);

/**
 * Resolves a user/model supplied path inside the workspace and refuses anything that
 * escapes it, including escapes through symlinks.
 */
export async function resolveInWorkspace(ctx: ToolContext, p: string): Promise<string> {
  if (typeof p !== "string" || p.trim() === "") throw new ToolError("path must be a non-empty string");
  const abs = path.resolve(ctx.workspace, p);
  const root = await realpath(ctx.workspace);
  // Resolve symlinks on the deepest part of the path that already exists.
  let existing = abs;
  const tail: string[] = [];
  while (true) {
    try {
      existing = await realpath(existing);
      break;
    } catch {
      // realpath fails on a missing path, but also on a symlink whose target is missing.
      // Following such a link on write would create a file wherever it points: refuse it.
      if ((await lstat(existing).catch(() => null))?.isSymbolicLink()) {
        throw new ToolError(`Path "${p}" goes through a broken symlink (${existing}); refusing to follow it.`);
      }
      const parent = path.dirname(existing);
      if (parent === existing) break;
      tail.unshift(path.basename(existing));
      existing = parent;
    }
  }
  const real = path.join(existing, ...tail);
  if (real !== root && !real.startsWith(root + path.sep)) {
    throw new ToolError(`Path "${p}" is outside the workspace (${ctx.workspace}). Use paths relative to the workspace.`);
  }
  return real;
}

/** Real path of `full` if it stays inside `root` (a realpath'd workspace), else null. */
async function realInside(root: string, full: string): Promise<string | null> {
  const real = await realpath(full).catch(() => null);
  return real && (real === root || real.startsWith(root + path.sep)) ? real : null;
}

/**
 * Writes `data` to an already-validated path without following a symlink at the last component,
 * after re-checking that the parent directory still resolves to the same place. This closes the
 * window in which a link could be swapped in between validation and the write.
 */
async function writeInWorkspace(ctx: ToolContext, p: string, file: string, data: string): Promise<void> {
  if ((await resolveInWorkspace(ctx, p)) !== file) throw new ToolError(`Path "${p}" changed while writing; aborted.`);
  let fh;
  try {
    fh = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0), 0o644);
  } catch (e: any) {
    if (e.code === "ELOOP") throw new ToolError(`Refusing to write through a symlink: ${p}`);
    throw e;
  }
  try {
    await fh.writeFile(data, "utf8");
  } finally {
    await fh.close();
  }
}

function rel(ctx: ToolContext, abs: string): string {
  return path.relative(realpathSync(ctx.workspace), abs) || ".";
}

async function isBinary(buf: Buffer): Promise<boolean> {
  const sample = buf.subarray(0, 8000);
  return sample.includes(0);
}

function numberLines(text: string, startLine: number): string {
  const lines = text.split("\n");
  const width = String(startLine + lines.length - 1).length;
  return lines.map((l, i) => `${String(startLine + i).padStart(width)}\t${l}`).join("\n");
}

export const listDir: Tool<{ path?: string; recursive?: boolean }> = {
  name: "list_dir",
  risk: "read",
  description:
    "List files and directories. Directories end with '/'. Set recursive=true to walk subdirectories " +
    "(skips .git, node_modules and similar).",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory relative to the workspace. Default '.'" },
      recursive: { type: "boolean", description: "Walk subdirectories. Default false." },
    },
  },
  async run({ path: p = ".", recursive = false }, ctx) {
    const dir = await resolveInWorkspace(ctx, p);
    const out: string[] = [];
    const walk = async (d: string, depth: number) => {
      let entries;
      try {
        entries = await readdir(d, { withFileTypes: true });
      } catch (e: any) {
        throw new ToolError(`Cannot list ${rel(ctx, d)}: ${e.code ?? e.message}`);
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        if (out.length >= MAX_LIST_ENTRIES) return;
        const full = path.join(d, e.name);
        const isDir = e.isDirectory();
        out.push("  ".repeat(depth) + e.name + (isDir ? "/" : ""));
        if (recursive && isDir && !SKIP_DIRS.has(e.name)) await walk(full, depth + 1);
      }
    };
    await walk(dir, 0);
    if (out.length === 0) return `${rel(ctx, dir)} is empty.`;
    const more = out.length >= MAX_LIST_ENTRIES ? `\n[stopped at ${MAX_LIST_ENTRIES} entries]` : "";
    return out.join("\n") + more;
  },
};

export const readFileTool: Tool<{ path: string; start_line?: number; end_line?: number }> = {
  name: "read_file",
  risk: "read",
  description:
    "Read a text file. Output lines are prefixed with line numbers (for reference only, they are not part of the file). " +
    "For large files pass start_line/end_line (1-based, inclusive) to read a range.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the workspace." },
      start_line: { type: "integer", minimum: 1 },
      end_line: { type: "integer", minimum: 1 },
    },
    required: ["path"],
  },
  async run({ path: p, start_line, end_line }, ctx) {
    const file = await resolveInWorkspace(ctx, p);
    let buf: Buffer;
    try {
      buf = await readFile(file);
    } catch (e: any) {
      if (e.code === "ENOENT") throw new ToolError(`File not found: ${p}`);
      if (e.code === "EISDIR") throw new ToolError(`${p} is a directory; use list_dir.`);
      throw new ToolError(`Cannot read ${p}: ${e.code ?? e.message}`);
    }
    if (await isBinary(buf)) return `${p} looks like a binary file (${buf.length} bytes); not shown.`;
    const lines = buf.toString("utf8").split("\n");
    const start = Math.max(1, start_line ?? 1);
    const end = Math.min(lines.length, end_line ?? lines.length);
    if (start > lines.length) throw new ToolError(`start_line ${start} is past the end of the file (${lines.length} lines).`);
    const body = numberLines(lines.slice(start - 1, end).join("\n"), start);
    const header = `${p} (lines ${start}-${end} of ${lines.length})\n`;
    return header + truncate(body, MAX_READ_CHARS, "Use start_line/end_line to read the rest.");
  },
};

async function exists(p: string): Promise<boolean> {
  return stat(p).then(() => true, () => false);
}

export const writeFileTool: Tool<{ path: string; content: string }> = {
  name: "write_file",
  description:
    "Create a file or completely overwrite an existing one. Parent directories are created automatically. " +
    "To change part of an existing file prefer edit_file.",
  risk: "write",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the workspace." },
      content: { type: "string", description: "Full new contents of the file." },
    },
    required: ["path", "content"],
  },
  async describe({ path: p, content }, ctx) {
    const file = await resolveInWorkspace(ctx, p);
    const st = await stat(file).catch(() => null);
    if (st?.isDirectory()) throw new ToolError(`${p} is a directory.`);
    return {
      summary: `${st ? "Overwrite" : "Create"} ${rel(ctx, file)} (${content.split("\n").length} lines)`,
      preview: truncate(content, 2000),
    };
  },
  async run({ path: p, content }, ctx) {
    const file = await resolveInWorkspace(ctx, p);
    const existed = await exists(file);
    await mkdir(path.dirname(file), { recursive: true });
    await writeInWorkspace(ctx, p, file, content);
    return `${existed ? "Overwrote" : "Created"} ${rel(ctx, file)} (${content.split("\n").length} lines).`;
  },
};

type EditArgs = { path: string; old_text: string; new_text: string; replace_all?: boolean };

/** Shared by describe and run, so a file that changed in between is re-checked. */
async function planEdit({ path: p, old_text, new_text, replace_all = false }: EditArgs, ctx: ToolContext) {
  if (!old_text) throw new ToolError("old_text must not be empty. To create a file use write_file.");
  if (old_text === new_text) throw new ToolError("old_text and new_text are identical; nothing to change.");
  const file = await resolveInWorkspace(ctx, p);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e: any) {
    throw new ToolError(e.code === "ENOENT" ? `File not found: ${p}` : `Cannot read ${p}: ${e.code ?? e.message}`);
  }
  const count = text.split(old_text).length - 1;
  if (count === 0) throw new ToolError(`old_text was not found in ${p}. Re-read the file and copy the text exactly.`);
  if (count > 1 && !replace_all) {
    throw new ToolError(`old_text occurs ${count} times in ${p}. Add surrounding context to make it unique, or set replace_all=true.`);
  }
  const updated = replace_all ? text.split(old_text).join(new_text) : text.replace(old_text, () => new_text);
  return { file, updated, replacements: replace_all ? count : 1 };
}

export const editFileTool: Tool<EditArgs> = {
  name: "edit_file",
  description:
    "Replace an exact snippet in a file. old_text must match the file exactly (whitespace included, " +
    "without the line-number prefixes from read_file) and must be unique unless replace_all=true. " +
    "Include a few surrounding lines to make it unique.",
  risk: "write",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      old_text: { type: "string", description: "Exact text to find." },
      new_text: { type: "string", description: "Replacement text." },
      replace_all: { type: "boolean", description: "Replace every occurrence. Default false." },
    },
    required: ["path", "old_text", "new_text"],
  },
  async describe(args, ctx) {
    const { file, replacements } = await planEdit(args, ctx);
    return {
      summary: `Edit ${rel(ctx, file)} (${replacements} replacement${replacements > 1 ? "s" : ""})`,
      preview: `--- old\n${truncate(args.old_text, 1500)}\n+++ new\n${truncate(args.new_text, 1500)}`,
    };
  },
  async run(args, ctx) {
    const { file, updated, replacements } = await planEdit(args, ctx);
    await writeInWorkspace(ctx, args.path, file, updated);
    return `Edited ${rel(ctx, file)}: ${replacements} replacement(s).`;
  },
};

export const makeDirTool: Tool<{ path: string }> = {
  name: "make_dir",
  description: "Create a directory (and any missing parents).",
  risk: "write",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  async describe({ path: p }, ctx) {
    return { summary: `Create directory ${rel(ctx, await resolveInWorkspace(ctx, p))}` };
  },
  async run({ path: p }, ctx) {
    const dir = await resolveInWorkspace(ctx, p);
    await mkdir(dir, { recursive: true });
    return `Directory ready: ${rel(ctx, dir)}`;
  },
};

export const movePathTool: Tool<{ from: string; to: string }> = {
  name: "move_path",
  description: "Move or rename a file or directory. Fails if the destination exists.",
  risk: "write",
  parameters: {
    type: "object",
    properties: { from: { type: "string" }, to: { type: "string" } },
    required: ["from", "to"],
  },
  async describe({ from, to }, ctx) {
    const src = await resolveInWorkspace(ctx, from);
    const dst = await resolveInWorkspace(ctx, to);
    if (!(await exists(src))) throw new ToolError(`Not found: ${from}`);
    if (await exists(dst)) throw new ToolError(`Destination already exists: ${to}`);
    return { summary: `Move ${rel(ctx, src)} -> ${rel(ctx, dst)}` };
  },
  async run({ from, to }, ctx) {
    const src = await resolveInWorkspace(ctx, from);
    const dst = await resolveInWorkspace(ctx, to);
    if (await exists(dst)) throw new ToolError(`Destination already exists: ${to}`);
    await mkdir(path.dirname(dst), { recursive: true });
    await rename(src, dst);
    return `Moved ${rel(ctx, src)} -> ${rel(ctx, dst)}`;
  },
};

export const deletePathTool: Tool<{ path: string }> = {
  name: "delete_path",
  description: "Delete a file or directory (recursively).",
  risk: "destructive",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  async describe({ path: p }, ctx) {
    const target = await resolveInWorkspace(ctx, p);
    if (target === (await realpath(ctx.workspace))) throw new ToolError("Refusing to delete the workspace root.");
    const st = await stat(target).catch(() => null);
    if (!st) throw new ToolError(`Not found: ${p}`);
    return { summary: `Delete ${st.isDirectory() ? "directory (recursively)" : "file"} ${rel(ctx, target)}` };
  },
  async run({ path: p }, ctx) {
    const target = await resolveInWorkspace(ctx, p);
    if (target === (await realpath(ctx.workspace))) throw new ToolError("Refusing to delete the workspace root.");
    await rm(target, { recursive: true });
    return `Deleted ${rel(ctx, target)}`;
  },
};

export const findFilesTool: Tool<{ pattern: string; path?: string }> = {
  name: "find_files",
  risk: "read",
  description: "Find files by glob pattern, e.g. '**/*.ts' or 'src/**/test_*.py'. Returns matching paths.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern." },
      path: { type: "string", description: "Directory to search from. Default '.'" },
    },
    required: ["pattern"],
  },
  async run({ pattern, path: p = "." }, ctx) {
    const base = await resolveInWorkspace(ctx, p);
    const root = await realpath(ctx.workspace);
    const out: string[] = [];
    for await (const m of glob(pattern, {
      cwd: base,
      exclude: (f: string) => SKIP_DIRS.has(path.basename(f)),
    })) {
      // Skip matches that only exist through a symlink pointing outside the workspace.
      if (!(await realInside(root, path.join(base, m)))) continue;
      out.push(rel(ctx, path.join(base, m)));
      if (out.length >= MAX_LIST_ENTRIES) break;
    }
    if (out.length === 0) return `No files match ${pattern}`;
    return out.sort().join("\n") + (out.length >= MAX_LIST_ENTRIES ? `\n[stopped at ${MAX_LIST_ENTRIES}]` : "");
  },
};

export const searchFilesTool: Tool<{ query: string; path?: string; regex?: boolean; case_sensitive?: boolean; include?: string }> = {
  name: "search_files",
  risk: "read",
  description:
    "Search file contents (like grep). Returns 'path:line: text' for each match. " +
    "Use include to limit to a glob such as '**/*.ts'.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Text or regular expression to search for." },
      path: { type: "string", description: "Directory to search. Default '.'" },
      regex: { type: "boolean", description: "Treat query as a JavaScript regular expression. Default false." },
      case_sensitive: { type: "boolean", description: "Default false." },
      include: { type: "string", description: "Glob of files to search. Default '**/*'." },
    },
    required: ["query"],
  },
  async run({ query, path: p = ".", regex = false, case_sensitive = false, include = "**/*" }, ctx) {
    const base = await resolveInWorkspace(ctx, p);
    let re: RegExp;
    try {
      const src = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      re = new RegExp(src, case_sensitive ? "" : "i");
    } catch (e: any) {
      throw new ToolError(`Invalid regex: ${e.message}`);
    }
    const root = await realpath(ctx.workspace);
    const out: string[] = [];
    for await (const m of glob(include, { cwd: base, exclude: (f: string) => SKIP_DIRS.has(path.basename(f)) })) {
      if (ctx.signal.aborted || out.length >= MAX_GREP_MATCHES) break;
      // Read through the real path, and never outside the workspace (symlinked files or dirs).
      const shown = path.join(base, m);
      const full = await realInside(root, shown);
      if (!full) continue;
      const st = await stat(full).catch(() => null);
      if (!st?.isFile() || st.size > 2_000_000) continue;
      const buf = await readFile(full).catch(() => null);
      if (!buf || (await isBinary(buf))) continue;
      const lines = buf.toString("utf8").split("\n");
      for (let i = 0; i < lines.length && out.length < MAX_GREP_MATCHES; i++) {
        if (re.test(lines[i]!)) out.push(`${rel(ctx, shown)}:${i + 1}: ${lines[i]!.trim().slice(0, 300)}`);
      }
    }
    if (out.length === 0) return `No matches for ${JSON.stringify(query)}.`;
    return out.join("\n") + (out.length >= MAX_GREP_MATCHES ? `\n[stopped at ${MAX_GREP_MATCHES} matches; narrow the search]` : "");
  },
};

export const fsTools: Tool[] = [
  listDir,
  readFileTool,
  findFilesTool,
  searchFilesTool,
  writeFileTool,
  editFileTool,
  makeDirTool,
  movePathTool,
  deletePathTool,
];
