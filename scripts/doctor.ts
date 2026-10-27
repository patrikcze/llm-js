#!/usr/bin/env node
/**
 * Environment check for llm-agent: `make doctor` / `node scripts/doctor.ts`.
 * Required checks fail the run (exit 1); optional ones only warn.
 */
import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  process.loadEnvFile(path.join(ROOT, ".env"));
} catch {}

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
let failed = 0;

function report(level: "ok" | "warn" | "fail", label: string, detail: string) {
  const mark = { ok: paint(32, "✓"), warn: paint(33, "!"), fail: paint(31, "✗") }[level];
  if (level === "fail") failed++;
  console.log(`  ${mark} ${label.padEnd(16)} ${detail}`);
}

async function probe(url: string, init: RequestInit = {}): Promise<Response | Error> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(4000) });
  } catch (e: any) {
    return new Error(e.cause?.code ?? e.message);
  }
}

function portFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer()
      .once("error", () => resolve(false))
      .once("listening", () => srv.close(() => resolve(true)))
      .listen(port, host);
  });
}

console.log(paint(1, "llm-agent doctor"));

// --- runtime -------------------------------------------------------------------
const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
const nodeOk = major > 22 || (major === 22 && minor >= 18);
report(nodeOk ? "ok" : "fail", "Node.js", `${process.version}${nodeOk ? "" : " (need >= 22.18 for TypeScript type stripping)"}`);

const deps = ["openai", "@anthropic-ai/sdk", "undici", "katex", "mermaid"].filter(
  (d) => !existsSync(path.join(ROOT, "node_modules", d, "package.json")),
);
// Docker or Podman (the Makefile passes DOCKER); a `docker` CLI may also be talking to Podman.
async function detectEngine(): Promise<{ ok: boolean; detail: string }> {
  let note = "not installed (optional)";
  for (const cli of process.env.DOCKER ? [process.env.DOCKER] : ["docker", "podman"]) {
    try {
      await promisify(execFile)(cli, ["info"], { timeout: 5000 });
      const { stdout } = await promisify(execFile)(cli, ["version"], { timeout: 5000 });
      const name = /podman/i.test(stdout) ? "Podman" : "Docker";
      const version = (await promisify(execFile)(cli, ["version", "--format", "{{.Server.Version}}"], { timeout: 5000 })).stdout.trim();
      return { ok: true, detail: `${name} ${version} via \`${cli}\`` };
    } catch (e: any) {
      if (e.code !== "ENOENT") note = `\`${cli}\` installed, engine not running (optional)`;
    }
  }
  return { ok: false, detail: note };
}
const engine = await detectEngine();

// Node dependencies are only needed to run the agent on this machine; the container image has its own.
if (!deps.length) report("ok", "Dependencies", "installed");
else
  report(
    engine.ok ? "warn" : "fail",
    "Dependencies",
    `missing ${deps.join(", ")} (run: make install${engine.ok ? "; not needed for make docker-up" : ""})`,
  );

report(
  existsSync(path.join(ROOT, ".env")) ? "ok" : "warn",
  ".env",
  existsSync(path.join(ROOT, ".env")) ? "present" : "missing (optional; run: make setup)",
);

// --- model provider and web search (need the dependencies) -------------------------
if (deps.length) report("warn", "LLM / Search", "skipped until dependencies are installed");
else {
  // --- model provider ----------------------------------------------------------------
  const { loadSettings, settingsPath } = await import("../src/settings.ts");
  const { PROVIDERS } = await import("../src/providers.ts");
  const saved = loadSettings();
  const provider = saved?.provider ?? "local";
  const preset = PROVIDERS[provider];
  const baseURL = saved?.providers[provider]?.baseURL || preset.defaultBaseURL;
  const savedFile = settingsPath();
  if (existsSync(savedFile)) {
    const mode = statSync(savedFile).mode & 0o777;
    report(mode & 0o077 ? "warn" : "ok", "Settings", `${savedFile} (${mode.toString(8)})${mode & 0o077 ? " should be 600" : ""}`);
  } else {
    report("ok", "Settings", "none saved yet (pick a model in the UI)");
  }

  if (provider === "local" || provider === "custom") {
    const res = await probe(`${baseURL.replace(/\/$/, "")}/models`);
    if (res instanceof Error) report("warn", `LLM (${provider})`, `${baseURL} unreachable: ${res.message}`);
    else if (!res.ok) report("warn", `LLM (${provider})`, `${baseURL} answered HTTP ${res.status}`);
    else {
      const body: any = await res.json().catch(() => ({}));
      const n = Array.isArray(body.data) ? body.data.length : 0;
      report("ok", `LLM (${provider})`, `${baseURL} · ${n} model(s)${saved?.model ? ` · selected ${saved.model}` : ""}`);
    }
  } else {
    const key = saved?.providers[provider]?.apiKey ? "saved key" : preset.keyEnv && process.env[preset.keyEnv] ? `${preset.keyEnv}` : "";
    report(
      key ? "ok" : "fail",
      `LLM (${provider})`,
      key ? `${saved?.model ?? "?"} · key from ${key}` : `no API key (save one in the UI or set ${preset.keyEnv})`,
    );
  }

  // --- web search ------------------------------------------------------------------
  const { searchProviderName } = await import("../src/tools/web.ts");
  const search = searchProviderName();
  if (search === "searxng") {
    const res = await probe(`${process.env.SEARXNG_URL!.replace(/\/$/, "")}/search?q=test&format=json`);
    if (res instanceof Error)
      report("warn", "Search", `SearXNG at ${process.env.SEARXNG_URL} unreachable: ${res.message} (run: make search-up)`);
    else if (!res.ok) report("warn", "Search", `SearXNG answered HTTP ${res.status} (json format enabled?)`);
    else report("ok", "Search", `SearXNG · ${((await res.json()) as any).results?.length ?? 0} results for a test query`);
  } else if (search === "duckduckgo") {
    report("warn", "Search", "DuckDuckGo (no key) often blocks scripts; set SEARXNG_URL, BRAVE_API_KEY or TAVILY_API_KEY");
  } else {
    report("ok", "Search", search);
  }
}

// --- server port and containers ------------------------------------------------------
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";
const health = await probe(`http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}/healthz`);
if (!(health instanceof Error) && health.ok) report("ok", "UI server", `running on ${host}:${port}`);
else {
  const free = await portFree(port, host);
  report(free ? "ok" : "warn", "UI server", free ? `port ${port} free` : `port ${port} is used by another program`);
}

if (engine.ok) report("ok", "Containers", engine.detail);
else report("warn", "Containers", engine.detail);

console.log(failed ? paint(31, `\n${failed} required check(s) failed.`) : paint(32, "\nAll required checks passed."));
process.exit(failed ? 1 : 0);
