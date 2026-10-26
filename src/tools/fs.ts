import { constants, type Dirent } from "node:fs";
import { type FileHandle, mkdir, open, readdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { isBinary, realInside, rel, resolveInWorkspace, SKIP_DIRS } from "./paths.ts";
import { globTool, grepTool } from "./search.ts";
import { type ImageData, type Tool, type ToolContext, ToolError, type ToolOutput, truncate } from "./types.ts";

export { isBinary, realInside, rel, resolveInWorkspace, SKIP_DIRS };

const MAX_READ_CHARS = 60_000;
const MAX_LIST_ENTRIES = 500;
/**
 * Writes `data` to an already-validated path without following a symlink at the last component,
 * after re-checking that the parent directory still resolves to the same place. This closes the
 * window in which a link could be swapped in between validation and the write.
 */
async function writeInWorkspace(ctx: ToolContext, p: string, file: string, data: string): Promise<void> {
  if ((await resolveInWorkspace(ctx, p)) !== file) throw new ToolError(`Path "${p}" changed while writing; aborted.`);
  let fh: FileHandle;
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
      let entries: Dirent[];
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
  return stat(p).then(
    () => true,
    () => false,
  );
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

const MAX_IMAGE_BYTES = 5_000_000; // the common provider limit per image

/** Identifies an image by its first bytes rather than its file name. */
export function sniffImage(buf: Buffer): ImageData["mime"] | undefined {
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return undefined;
}

export const viewImageTool: Tool<{ path: string }, ToolOutput> = {
  name: "view_image",
  risk: "read",
  description:
    "Look at an image file in the workspace (PNG, JPEG, GIF or WebP, up to 5 MB). The image is shown to you right " +
    "after this call. Use it for screenshots, diagrams, photos or charts. Needs a vision-capable model.",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "Image path relative to the workspace." } },
    required: ["path"],
  },
  async run({ path: p }, ctx) {
    const file = await resolveInWorkspace(ctx, p);
    const st = await stat(file).catch(() => null);
    if (!st?.isFile()) throw new ToolError(`File not found: ${p}`);
    if (st.size > MAX_IMAGE_BYTES) throw new ToolError(`${p} is ${(st.size / 1e6).toFixed(1)} MB; the limit is 5 MB.`);
    const buf = await readFile(file);
    const mime = sniffImage(buf);
    if (!mime) throw new ToolError(`${p} is not a PNG, JPEG, GIF or WebP image.`);
    return {
      text: `Showing ${rel(ctx, file)} (${mime}, ${Math.ceil(buf.length / 1024)} KB).`,
      images: [{ mime, data: buf.toString("base64") }],
    };
  },
};

export const fsTools: Tool[] = [
  listDir,
  readFileTool,
  viewImageTool,
  globTool,
  grepTool,
  writeFileTool,
  editFileTool,
  makeDirTool,
  movePathTool,
  deletePathTool,
];
