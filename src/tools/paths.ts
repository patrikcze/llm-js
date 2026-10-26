import { realpathSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { type ToolContext, ToolError } from "./types.ts";

// Workspace path helpers shared by the file and search tools.

export const SKIP_DIRS = new Set([".git", "node_modules", ".next", "dist", "build", ".venv", "__pycache__"]);

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
export async function realInside(root: string, full: string): Promise<string | null> {
  const real = await realpath(full).catch(() => null);
  return real && (real === root || real.startsWith(root + path.sep)) ? real : null;
}

export function rel(ctx: ToolContext, abs: string): string {
  return path.relative(realpathSync(ctx.workspace), abs) || ".";
}

export async function isBinary(buf: Buffer): Promise<boolean> {
  const sample = buf.subarray(0, 8000);
  return sample.includes(0);
}
