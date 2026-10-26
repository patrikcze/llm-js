import { localContextTool } from "./context.ts";
import { fsTools } from "./fs.ts";
import { runCommandTool } from "./shell.ts";
import type { Tool } from "./types.ts";
import { webTools } from "./web.ts";

/** The standard tool set. `exec: false` leaves out run_command (the `--no-exec` flag). */
export function defaultTools({ exec = true } = {}): Tool[] {
  return [...fsTools, localContextTool, ...webTools, ...(exec ? [runCommandTool] : [])];
}
