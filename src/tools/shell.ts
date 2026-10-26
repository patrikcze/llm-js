import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { resolveInWorkspace } from "./fs.ts";
import { type Tool, type ToolContext, ToolError } from "./types.ts";

// ===========================================================================
// run_command
//
// Security model (in order of strength):
//   1. Approval: risk "execute" is refused in read-only mode and asked in every other mode
//      except "auto". "Always allow" covers one exact command line (see approvalKey).
//   2. Isolation: run the agent in its container (`make agent-up`) and commands only see
//      that container and its /workspace. On the host they run as your user.
//   3. Hygiene: secrets are removed from the environment, stdin is closed, no TTY, pagers and
//      credential prompts are disabled, the whole process group is killed on timeout/abort,
//      and leftover background processes are stopped when the command ends.
//   4. A blocklist of catastrophic patterns (sudo, rm -rf /, mkfs, curl | sh, …). Defense in
//      depth only: no blocklist can catch everything a shell can express.
// ===========================================================================

const DEFAULT_TIMEOUT_S = 60;
const MAX_TIMEOUT_S = 600;
const MAX_COMMAND_CHARS = 10_000;
/** Characters returned to the model: the head plus the (usually more useful) tail. */
const MAX_RESULT_CHARS = 30_000;
/** Bytes kept in memory per stream end while the command runs. */
const CAPTURE_BYTES = 2_000_000;
/** After the shell exits, how long to wait for pipes held open by background children. */
const EXIT_GRACE_MS = 500;

// "Command position": the start of any line (a newline ends a shell command too), or right after
// ; & | ( $( ` or a keyword/wrapper such as `then`, `exec`, `env`, `xargs`, `nohup`, optionally with
// a path. So `grep -r sudo` is fine, but `echo hi\nsudo ls`, `x && /usr/bin/sudo ls` and
// `exec sudo ls` are blocked.
const POSITION = String.raw`(?:^|[;&|(\`\n\r]|\$\()\s*(?:(?:then|do|else|elif|time|exec|command|builtin|env|nohup|nice|xargs|!)\s+|[A-Za-z_]\w*=\S*\s+)*(?:\\|[\w./-]*/)?`;
const atCommand = (names: string) => new RegExp(`${POSITION}(?:${names})(?:\\s|$)`);

const BLOCKED: [RegExp, string][] = [
  [atCommand("sudo|doas|su"), "privilege escalation (sudo/su) is not available to the agent"],
  [
    /\brm\s+(-\S+\s+)*-\S*[rR]\S*\s+(-\S+\s+)*(\/|\/\*|~|~\/|~\/\*|\$HOME|\$HOME\/|\$HOME\/\*|"\$HOME"|\/(Users|home|root|etc|usr|var|System|bin|sbin|opt|Library)\/?)(\s|;|&|\||$)/,
    "recursive delete of the root, home or a system directory",
  ],
  [/\bmkfs(\.\w+)?\b|\bdiskutil\s+(erase|zero|secureErase|partition)/i, "formatting a disk"],
  [/\bdd\b[^|;&]*\bof=\/dev\/|>\s*\/dev\/(sd|disk|nvme|hd)/, "writing to a raw disk device"],
  [/:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:/, "fork bomb"],
  [atCommand("shutdown|reboot|halt|poweroff"), "shutting down or rebooting the machine"],
  [new RegExp(`${POSITION}init\\s+[06]\\b`), "shutting down or rebooting the machine"],
  [/\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b|\b(ba|z)?sh\s+-c\s+"?\$\(\s*(curl|wget)\b/, "downloading and executing a script"],
  [/\bchmod\s+(-\S+\s+)*-R\S*\s+\S*7\S*\s+\/(\s|$)/, "recursive permission change on /"],
];

/** Returns a human-readable reason when a command matches a blocked pattern. */
export function blockedReason(command: string): string | undefined {
  for (const [re, why] of BLOCKED) if (re.test(command)) return why;
  return undefined;
}

// Variables that commonly hold credentials. Commands (and anything the model asks them to
// print) must not see the agent's API keys or the user's tokens.
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|COOKIE|SESSION|PRIVATE|AUTH|SIGNATURE)/i;
const SECRET_PREFIX =
  /^(ANTHROPIC_|OPENAI_|AWS_|AZURE_|GOOGLE_|GCP_|GH_|GITHUB_|GITLAB_|NPM_|HF_|HUGGING|TAVILY_|BRAVE_|SEARXNG_SECRET|AGENT_|LLM_API_KEY|DOCKER_AUTH)/i;

// Values that look like credentials whatever the variable is called: URLs with a password
// (DATABASE_URL=postgres://user:pw@host/db), well-known token formats, JWTs, and long opaque strings.
const SECRET_VALUE = new RegExp(
  [
    String.raw`^[a-z][a-z0-9+.-]*://[^/\s:@]*:[^/\s@]+@`,
    String.raw`^(gh[pousr]_|github_pat_|glpat-|xox[abprs]-|sk-|sk_live_|rk_live_|pk_live_|AKIA|ASIA|AIza|npm_|hf_|ya29\.|eyJ[A-Za-z0-9_-]{8,}\.)`,
    String.raw`^-----BEGIN [A-Z ]*PRIVATE KEY`,
    String.raw`^[A-Za-z0-9_+=-]{40,}$`,
  ].join("|"),
);

/**
 * The environment commands see. Denylist by variable name AND by value shape, because secrets
 * have innocent-looking names too. An allowlist would be safer still, but would break the many
 * tools that read their own settings (JAVA_HOME, GOPATH, npm_config_*, ...).
 */
export function commandEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined || SECRET_NAME.test(k) || SECRET_PREFIX.test(k) || SECRET_VALUE.test(v)) continue;
    env[k] = v;
  }
  return Object.assign(env, {
    // Never block on a pager, an editor or a credential prompt.
    PAGER: "cat",
    GIT_PAGER: "cat",
    GIT_EDITOR: "true",
    EDITOR: "true",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "echo",
    SSH_ASKPASS: "echo",
    DEBIAN_FRONTEND: "noninteractive",
    TERM: "dumb",
    NO_COLOR: "1",
  });
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escape sequences is the point.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

export interface CommandResult {
  exitCode: number | null;
  signal: string | null;
  output: string;
  timedOut: boolean;
  ms: number;
  /** Bytes that did not fit in memory (dropped from the middle). */
  droppedBytes: number;
}

/**
 * Runs `command` in a fresh shell with stdout and stderr interleaved as they arrive.
 * Kills the whole process group on timeout or abort; rejects with the abort reason on abort.
 */
export function runShell(
  command: string,
  opts: { cwd: string; timeoutMs: number; signal: AbortSignal; stdin?: string; env?: Record<string, string> },
): Promise<CommandResult> {
  const isWin = process.platform === "win32";
  const started = Date.now();
  return new Promise((resolve, reject) => {
    // POSIX: one pipe for both streams (exec 2>&1), so output keeps its real order.
    const child = spawn(
      isWin ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh",
      isWin ? ["/d", "/s", "/c", command] : ["-c", `exec 2>&1\n${command}`],
      {
        cwd: opts.cwd,
        env: opts.env ?? commandEnv(),
        // Own process group, so a timeout can stop the command and everything it started.
        detached: !isWin,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );

    const head: Buffer[] = [];
    let headBytes = 0;
    let tail: Buffer[] = [];
    let tailBytes = 0;
    let droppedBytes = 0;
    const collect = (chunk: Buffer) => {
      if (headBytes < CAPTURE_BYTES) {
        head.push(chunk);
        headBytes += chunk.length;
        return;
      }
      tail.push(chunk);
      tailBytes += chunk.length;
      while (tailBytes > CAPTURE_BYTES && tail.length > 1) {
        const first = tail.shift()!;
        tailBytes -= first.length;
        droppedBytes += first.length;
      }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    let timedOut = false;
    let settled = false;
    const killTree = (sig: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        if (isWin) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
        else process.kill(-child.pid, sig);
      } catch {
        // already gone
      }
    };
    const stop = () => {
      killTree("SIGTERM");
      setTimeout(() => killTree("SIGKILL"), 2000).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, opts.timeoutMs);
    const onAbort = () => stop();
    opts.signal.addEventListener("abort", onAbort, { once: true });

    let exitCode: number | null = null;
    let exitSignal: string | null = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal.removeEventListener("abort", onAbort);
      // Nothing the command started may outlive it.
      killTree("SIGKILL");
      if (opts.signal.aborted) return reject(opts.signal.reason ?? new Error("aborted"));
      const out =
        Buffer.concat(head).toString("utf8") +
        (droppedBytes ? `\n[... ${droppedBytes} bytes omitted ...]\n` : "") +
        Buffer.concat(tail).toString("utf8");
      tail = [];
      resolve({ exitCode, signal: exitSignal, output: out.replace(ANSI, ""), timedOut, ms: Date.now() - started, droppedBytes });
    };

    child.on("error", (e: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal.removeEventListener("abort", onAbort);
      reject(new ToolError(`Could not start the shell: ${e.code ?? e.message}`));
    });
    child.on("exit", (code, sig) => {
      exitCode = code;
      exitSignal = sig;
      // Background children may keep stdout open; don't wait for them forever.
      setTimeout(finish, EXIT_GRACE_MS).unref();
    });
    child.on("close", finish);

    child.stdin.on("error", () => {}); // the command may exit without reading stdin
    if (opts.stdin) child.stdin.end(opts.stdin);
    else child.stdin.end();
  });
}

/** Keeps the start and the end of long output; errors are usually at the end. */
function clip(text: string, max = MAX_RESULT_CHARS): string {
  if (text.length <= max) return text;
  const headChars = Math.floor(max * 0.35);
  const tailChars = max - headChars;
  return `${text.slice(0, headChars)}\n\n[... ${text.length - max} characters omitted ...]\n\n${text.slice(-tailChars)}`;
}

type CommandArgs = { command: string; cwd?: string; timeout_seconds?: number; stdin?: string };

async function prepare({ command, cwd = ".", timeout_seconds = DEFAULT_TIMEOUT_S }: CommandArgs, ctx: ToolContext) {
  if (!command.trim()) throw new ToolError("command must not be empty");
  if (command.length > MAX_COMMAND_CHARS)
    throw new ToolError(`command is longer than ${MAX_COMMAND_CHARS} characters; write a script file instead`);
  const why = blockedReason(command);
  if (why) throw new ToolError(`Blocked by the command safety rules: ${why}. Do not try to work around this; tell the user.`);
  const dir = await resolveInWorkspace(ctx, cwd);
  if (!(await stat(dir).catch(() => null))?.isDirectory()) throw new ToolError(`cwd is not a directory: ${cwd}`);
  const timeout = Math.min(Math.max(timeout_seconds, 1), MAX_TIMEOUT_S);
  return { dir, timeout, relDir: path.relative(realpathSync(ctx.workspace), dir) || "." };
}

export const runCommandTool: Tool<CommandArgs, string> = {
  name: "run_command",
  risk: "execute",
  description:
    "Run a shell command (/bin/sh -c) in the workspace and get its combined stdout/stderr and exit code. Use it to build, " +
    "test, run scripts, use git, or inspect the system. Each call is a fresh, non-interactive shell: no TTY, stdin is " +
    "closed unless you pass `stdin`, `cd`/`export` do not persist (use `cwd`), sudo is unavailable, and anything still " +
    "running when the command ends (servers, `&` jobs) is stopped. Long output keeps its beginning and end. A non-zero " +
    "exit code is reported as an error together with the output.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command line, e.g. `npm test` or `git log --oneline -5`." },
      cwd: { type: "string", description: "Directory to run in, relative to the workspace. Default '.'" },
      timeout_seconds: {
        type: "integer",
        minimum: 1,
        maximum: MAX_TIMEOUT_S,
        description: `Kill the command after this many seconds. Default ${DEFAULT_TIMEOUT_S}.`,
      },
      stdin: { type: "string", description: "Text to pass on standard input." },
    },
    required: ["command"],
  },
  async describe(args, ctx) {
    const { relDir, timeout } = await prepare(args, ctx);
    return {
      summary: `Run command: ${args.command.length > 80 ? `${args.command.slice(0, 79)}…` : args.command}`,
      preview:
        `$ ${args.command}\n\ncwd: ${relDir} · timeout: ${timeout}s${args.stdin ? ` · stdin: ${args.stdin.length} chars` : ""}\n` +
        "Runs with this agent's user permissions (inside the container when the agent runs in Docker). " +
        "API keys and other secret environment variables are hidden from it.",
    };
  },
  async run(args, ctx) {
    const { dir, timeout, relDir } = await prepare(args, ctx);
    const r = await runShell(args.command, { cwd: dir, timeoutMs: timeout * 1000, signal: ctx.signal, stdin: args.stdin });
    const how = r.timedOut
      ? `timed out after ${timeout}s (process group killed)`
      : r.signal
        ? `killed by ${r.signal}`
        : `exit code ${r.exitCode}`;
    const body = r.output.trim() ? clip(r.output.trimEnd()) : "(no output)";
    const text = `$ ${args.command}\n[cwd ${relDir} · ${how} · ${(r.ms / 1000).toFixed(1)}s]\n${body}`;
    if (r.timedOut || r.signal || r.exitCode !== 0) throw new ToolError(`Command failed: ${text}`);
    return text;
  },
};
