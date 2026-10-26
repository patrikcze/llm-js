import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type ParseArgsConfig, parseArgs } from "node:util";
import OpenAI from "openai";
import type { PermissionMode } from "./agent.ts";
import { type ChatClient, createChatClient, PROVIDERS, ProviderError, type ProviderKind, type ThinkingMode } from "./providers.ts";
import { loadSettings } from "./settings.ts";

// Load the project's .env (SEARXNG_URL, API keys, ...). Variables already set in the shell win.
try {
  process.loadEnvFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env"));
} catch {}

export const MODES: PermissionMode[] = ["read-only", "ask", "auto-edit", "auto"];
export const THINKING: ThinkingMode[] = ["auto", "on", "off"];

/** Options shared by the CLI and the web UI. */
export const COMMON_OPTIONS = {
  model: { type: "string", short: "m" },
  "base-url": { type: "string", short: "u" },
  "api-key": { type: "string", short: "k" },
  workspace: { type: "string", short: "w" },
  mode: { type: "string" },
  yes: { type: "boolean", short: "y" },
  "max-steps": { type: "string" },
  ctx: { type: "string" },
  "max-tokens": { type: "string" },
  temperature: { type: "string", short: "t" },
  think: { type: "string" },
  "no-stream": { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const satisfies ParseArgsConfig["options"];

export const COMMON_HELP = `  -m, --model <id>         model id (default: saved in the UI, else LLM_MODEL, else auto-detected)
  -u, --base-url <url>     OpenAI-compatible server URL (env LLM_BASE_URL; default http://localhost:9931/v1)
  -k, --api-key <key>      API key for --base-url (env LLM_API_KEY)
  -w, --workspace <dir>    directory the agent may read/write (default: current directory)
      --mode <mode>        read-only | ask | auto-edit | auto   (default: ask)
  -y, --yes                same as --mode auto
      --max-steps <n>      model rounds per task (default 50)
      --ctx <tokens>       context window (default: from the provider, 32768 for local)
      --max-tokens <n>     max output tokens per round (default 4096)
  -t, --temperature <x>    sampling temperature (ignored by Anthropic, which no longer accepts it)
      --think <mode>       auto | on | off   reasoning switch (default: auto = the model decides)
      --no-stream          wait for whole replies instead of streaming tokens
  -h, --help

Provider and model chosen in the browser UI are saved to ~/.llm-agent/settings.json
(AGENT_CONFIG_DIR) and reused here unless -m/-u/-k are given.`;

/** `usage` is true for invalid flags (fatal), false for provider problems (the UI can recover). */
export class ConfigError extends Error {
  readonly usage: boolean;
  constructor(message: string, usage = false) {
    super(message);
    this.usage = usage;
  }
}

function intOpt(name: string, v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new ConfigError(`--${name} must be a positive integer`, true);
  return n;
}

export type CommonValues = { [K in keyof typeof COMMON_OPTIONS]?: (typeof COMMON_OPTIONS)[K]["type"] extends "boolean" ? boolean : string };

/** Picks a chat model from an OpenAI-compatible server: llama.cpp "chat" tag, then a loaded model, then the first. */
async function autoPickModel(baseURL: string, apiKey: string | undefined): Promise<string | undefined> {
  const client = new OpenAI({ baseURL, apiKey: apiKey || "no-key", maxRetries: 0, timeout: 10_000 });
  const models = (await client.models.list()).data as Array<{ id: string; tags?: string[]; status?: { value?: string } }>;
  return (models.find((m) => m.tags?.includes("chat")) ?? models.find((m) => m.status?.value === "loaded") ?? models[0])?.id;
}

/**
 * Turns flags, saved UI settings and env into everything needed to build an Agent.
 * Precedence: CLI flags > settings saved from the UI > .env / defaults.
 * With `requireModel: false` an unreachable server yields `model: ""` instead of an error,
 * so the UI can start and let the user pick a provider.
 */
export async function resolveConfig(opt: CommonValues, { requireModel = true } = {}) {
  const workspace = path.resolve(opt.workspace ?? process.cwd());
  const mode = (opt.yes ? "auto" : (opt.mode ?? "ask")) as PermissionMode;
  if (!MODES.includes(mode)) throw new ConfigError(`--mode must be one of ${MODES.join(", ")}`, true);
  const temperature = opt.temperature !== undefined ? Number(opt.temperature) : undefined;
  if (temperature !== undefined && !Number.isFinite(temperature)) throw new ConfigError("--temperature must be a number", true);
  const thinking = (opt.think ?? "auto") as ThinkingMode;
  if (!THINKING.includes(thinking)) throw new ConfigError(`--think must be one of ${THINKING.join(", ")}`, true);

  const flagsGiven = Boolean(opt.model || opt["base-url"] || opt["api-key"]);
  const saved = flagsGiven ? null : loadSettings();

  let provider: ProviderKind;
  let baseURL: string;
  let apiKey: string | undefined;
  let model: string | undefined;
  let contextTokens = intOpt("ctx", opt.ctx);

  if (saved) {
    provider = saved.provider;
    baseURL = saved.providers[provider]?.baseURL || PROVIDERS[provider].defaultBaseURL;
    apiKey = saved.providers[provider]?.apiKey;
    model = saved.model;
    contextTokens ??= saved.contextTokens;
  } else {
    provider = "local";
    baseURL = opt["base-url"] ?? PROVIDERS.local.defaultBaseURL;
    apiKey = opt["api-key"] ?? process.env.LLM_API_KEY;
    model = opt.model ?? process.env.LLM_MODEL;
  }
  contextTokens ??= PROVIDERS[provider].defaultContextTokens;

  let chat: ChatClient;
  try {
    chat = createChatClient({ kind: provider, baseURL, apiKey });
  } catch (e) {
    if (e instanceof ProviderError) throw new ConfigError(e.message);
    throw e;
  }

  if (!model && provider === "local") {
    try {
      model = await autoPickModel(baseURL, apiKey);
    } catch (e: any) {
      if (requireModel) throw new ConfigError(`Cannot reach ${baseURL}: ${e.message}`);
    }
    if (!model && requireModel) throw new ConfigError("The server lists no models; pass --model.");
  }

  // AGENTS.md is the common convention for per-project agent instructions.
  const instructions = await readFile(path.join(workspace, "AGENTS.md"), "utf8").catch(() => undefined);

  return {
    provider,
    baseURL,
    chat,
    model: model ?? "",
    workspace,
    mode,
    instructions,
    maxSteps: intOpt("max-steps", opt["max-steps"]),
    contextTokens,
    maxOutputTokens: intOpt("max-tokens", opt["max-tokens"]),
    temperature,
    thinking,
    stream: !opt["no-stream"],
  };
}

export { parseArgs };
