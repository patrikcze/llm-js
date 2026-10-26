#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { styleText } from "node:util";
import { Agent, type ApprovalRequest, type PermissionMode, type RunResult, type UserInput } from "./agent.ts";
import { COMMON_HELP, COMMON_OPTIONS, ConfigError, MODES, parseArgs, resolveConfig, THINKING } from "./config.ts";
import type { ThinkingMode } from "./providers.ts";
import { fsTools, sniffImage } from "./tools/fs.ts";
import { searchProviderName, webTools } from "./tools/web.ts";

const HELP = `llm-agent: an agent with filesystem, web search and web fetch tools for any OpenAI-compatible server.

Usage:
  node src/cli.ts [options]            interactive chat
  node src/cli.ts [options] "task"     run one task and exit
  node src/server.ts [options]         browser UI (see --help there)

Options:
${COMMON_HELP}
      --show-thinking      print reasoning tokens from thinking models
      --json               one-shot mode: print the RunResult as JSON

Web search uses TAVILY_API_KEY, BRAVE_API_KEY or SEARXNG_URL when set, otherwise DuckDuckGo.
If the workspace has an AGENTS.md, it is added to the system prompt.

Chat commands:
  /think [auto|on|off]   reasoning switch          /stream [on|off]   token streaming
  /attach <image file>   send an image with your next message (/attach to list, /attach clear)
  /mode <mode>  /reset  /tokens  /help  /exit
Press Ctrl+C to interrupt the agent; press it at the prompt to quit.`;

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: { ...COMMON_OPTIONS, "show-thinking": { type: "boolean" }, json: { type: "boolean" } },
});

if (opt.help) {
  console.log(HELP);
  process.exit(0);
}

const dim = (s: string) => styleText("dim", s);
const err = (s: string) => console.error(styleText("red", s));

let cfg: Awaited<ReturnType<typeof resolveConfig>>;
try {
  cfg = await resolveConfig(opt);
} catch (e) {
  if (!(e instanceof ConfigError)) throw e;
  err(e.message);
  process.exit(2);
}
const { baseURL, chat, model, workspace, mode, instructions } = cfg;
const oneShot = positionals.join(" ").trim();
const interactive = !oneShot;

// --- terminal I/O ----------------------------------------------------------

const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
let current: AbortController | null = null;
let lastWasText = false;

rl.on("SIGINT", () => {
  if (current && !current.signal.aborted) {
    current.abort();
    process.stdout.write(styleText("yellow", "\n^C interrupting...\n"));
  } else {
    rl.close();
  }
});
process.on("SIGINT", () => current?.abort()); // non-TTY

const alwaysAllow = new Set<string>();

async function approve(req: ApprovalRequest): Promise<boolean> {
  if (alwaysAllow.has(req.tool)) return true;
  if (!process.stdin.isTTY && !interactive) {
    err(`Denied ${req.action.summary}: no terminal to ask. Use --mode auto-edit or --yes.`);
    return false;
  }
  const color = req.risk === "destructive" ? "red" : "yellow";
  process.stdout.write(`\n${styleText(["bold", color], `? ${req.action.summary}`)}\n`);
  if (req.action.preview) {
    const lines = req.action.preview.split("\n");
    const shown = lines
      .slice(0, 40)
      .map((l) => dim("  │ ") + l)
      .join("\n");
    process.stdout.write(`${shown + (lines.length > 40 ? dim(`\n  │ ... ${lines.length - 40} more lines`) : "")}\n`);
  }
  try {
    const answer = (await rl.question(styleText(color, "  Allow? [y]es / [n]o / [a]lways for this tool: "), { signal: current?.signal }))
      .trim()
      .toLowerCase();
    if (answer === "a" || answer === "always") {
      alwaysAllow.add(req.tool);
      return true;
    }
    return answer === "y" || answer === "yes";
  } catch {
    return false; // aborted
  }
}

function short(v: unknown, max = 120): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  const one = (s ?? "").replace(/\s+/g, " ");
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

let thinking = false;
const agent = new Agent({
  client: chat,
  model,
  workspace,
  tools: [...fsTools, ...webTools],
  permissions: { mode },
  approve,
  instructions,
  maxSteps: cfg.maxSteps,
  contextTokens: cfg.contextTokens,
  maxOutputTokens: cfg.maxOutputTokens,
  temperature: cfg.temperature,
  thinking: cfg.thinking,
  stream: cfg.stream,
  events: {
    onReasoning(d) {
      if (!opt["show-thinking"] || opt.json) return;
      if (!thinking) process.stdout.write(dim("\n[thinking] "));
      thinking = true;
      process.stdout.write(dim(d));
    },
    onText(d) {
      if (opt.json) return;
      if (thinking) process.stdout.write("\n\n");
      thinking = false;
      lastWasText = true;
      process.stdout.write(d);
    },
    onToolCall({ name, args }) {
      if (opt.json) return;
      if (lastWasText || thinking) process.stdout.write("\n");
      lastWasText = thinking = false;
      process.stdout.write(`${styleText("cyan", `● ${name}`) + dim(` ${short(args)}`)}\n`);
    },
    onToolResult({ name, output, status, ms, images }) {
      if (opt.json) return;
      const mark = status === "ok" ? styleText("green", "  ✓") : styleText("red", status === "denied" ? "  ⊘" : "  ✗");
      const shown = images ? ` · ${images} image(s) shown to the model` : "";
      process.stdout.write(`${mark} ${dim(`${name} ${ms}ms · ${short(output, 100)}${shown}`)}\n`);
    },
    onNotice(m) {
      if (!opt.json) process.stdout.write(styleText("yellow", `\n[agent] ${m}\n`));
    },
  },
});

// Images queued with /attach go out with the next message.
const attachments: { name: string; url: string }[] = [];

async function attach(file: string): Promise<string> {
  const abs = path.resolve(file.replace(/^~(?=\/)/, process.env.HOME ?? "~"));
  const buf = await readFile(abs).catch((e) => {
    throw new Error(`cannot read ${file}: ${e.code ?? e.message}`);
  });
  const mime = sniffImage(buf);
  if (!mime) throw new Error(`${file} is not a PNG, JPEG, GIF or WebP image`);
  if (buf.length > 5_000_000) throw new Error(`${file} is larger than 5 MB`);
  attachments.push({ name: path.basename(abs), url: `data:${mime};base64,${buf.toString("base64")}` });
  return `${path.basename(abs)} (${Math.ceil(buf.length / 1024)} KB)`;
}

async function runTask(task: string): Promise<RunResult | undefined> {
  current = new AbortController();
  lastWasText = thinking = false;
  const input: UserInput = attachments.length
    ? [{ type: "text", text: task }, ...attachments.map((a) => ({ type: "image_url" as const, image_url: { url: a.url } }))]
    : task;
  attachments.length = 0;
  try {
    const result = await agent.run(input, current.signal);
    if (!opt.json) {
      if (!lastWasText && result.text) process.stdout.write(result.text);
      const u = result.usage;
      const tag = result.stopReason === "completed" ? "" : ` · ${result.stopReason}`;
      process.stdout.write(
        "\n" +
          dim(
            `\n[${result.steps} step(s) · ${result.toolCalls.length} tool call(s) · ${u.promptTokens}+${u.completionTokens} tokens${tag}]`,
          ) +
          "\n",
      );
    }
    return result;
  } catch (e: any) {
    err(`\nModel request failed: ${e?.status ? `HTTP ${e.status} ` : ""}${e?.message ?? e}`);
    return undefined;
  } finally {
    current = null;
  }
}

// --- main ------------------------------------------------------------------

if (!interactive) {
  const result = await runTask(oneShot);
  if (opt.json && result) console.log(JSON.stringify(result, null, 2));
  rl.close();
  process.exit(result && result.stopReason !== "cancelled" ? 0 : 1);
}

console.log(styleText("bold", "llm-agent") + dim(` · ${model} @ ${baseURL}`));
console.log(dim(`workspace ${workspace} · mode ${mode} · search ${searchProviderName()}${instructions ? " · AGENTS.md loaded" : ""}`));
console.log(dim("Type /help for commands.\n"));

rl.on("close", () => {
  console.log(dim("\nbye"));
  process.exit(0);
});

while (true) {
  let line: string;
  try {
    line = (await rl.question(styleText(["bold", "green"], "› "))).trim();
  } catch {
    break;
  }
  if (!line) continue;
  if (line.startsWith("/")) {
    const cmd = line.split(/\s+/, 1)[0]!;
    const arg = line.slice(cmd.length).trim();
    if (cmd === "/exit" || cmd === "/quit") break;
    else if (cmd === "/help") console.log(HELP);
    else if (cmd === "/reset") {
      agent.reset();
      alwaysAllow.clear();
      console.log(dim("Conversation cleared."));
    } else if (cmd === "/tokens") console.log(dim(`~${agent.estimateTokens()} tokens in context, ${agent.messages.length} messages`));
    else if (cmd === "/mode") {
      if (!arg || !MODES.includes(arg as PermissionMode)) console.log(dim(`Usage: /mode ${MODES.join("|")}`));
      else {
        agent.setPermissionMode(arg as PermissionMode);
        console.log(dim(`Mode: ${arg}`));
      }
    } else if (cmd === "/think") {
      if (arg && !THINKING.includes(arg as ThinkingMode)) console.log(dim(`Usage: /think ${THINKING.join("|")}`));
      else {
        if (arg) agent.setThinking(arg as ThinkingMode);
        console.log(dim(`Thinking: ${agent.thinking}`));
      }
    } else if (cmd === "/stream") {
      if (arg && arg !== "on" && arg !== "off") console.log(dim("Usage: /stream on|off"));
      else {
        if (arg) agent.setStreaming(arg === "on");
        console.log(dim(`Streaming: ${agent.streaming ? "on" : "off"}`));
      }
    } else if (cmd === "/attach") {
      if (!arg) console.log(dim(attachments.length ? `Attached: ${attachments.map((a) => a.name).join(", ")}` : "No images attached."));
      else if (arg === "clear") {
        attachments.length = 0;
        console.log(dim("Attachments cleared."));
      } else {
        try {
          console.log(dim(`Attached ${await attach(arg)}; it goes with your next message.`));
        } catch (e: any) {
          err(e.message);
        }
      }
    } else console.log(dim("Unknown command. /help lists them."));
    continue;
  }
  await runTask(line);
  console.log();
}
rl.close();
