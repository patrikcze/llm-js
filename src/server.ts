#!/usr/bin/env node
/**
 * Browser UI for the agent. Serves a single page and streams agent events over SSE.
 *
 *   node src/server.ts [options] [--port 8787]
 *
 * Security: binds to 127.0.0.1 by default (HOST overrides it, e.g. 0.0.0.0 inside a container
 * whose port is published on the host's loopback only). Every API call must come from the page
 * itself: Host must be localhost/127.0.0.1 (or listed in AGENT_ALLOWED_HOSTS), Origin must match,
 * and bodies must be JSON. So other websites in your browser cannot drive the agent.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, type ApprovalRequest, type PermissionMode } from "./agent.ts";
import { COMMON_HELP, COMMON_OPTIONS, ConfigError, MODES, parseArgs, resolveConfig } from "./config.ts";
import { createChatClient, PROVIDERS, ProviderError, type ProviderKind } from "./providers.ts";
import { loadSettings, publicProviders, saveSettings, settingsPath, type SavedSettings } from "./settings.ts";
import { fsTools } from "./tools/fs.ts";
import { ToolError } from "./tools/types.ts";
import { fetchImage, searchProviderName, webTools } from "./tools/web.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const { values: opt } = parseArgs({ options: { ...COMMON_OPTIONS, port: { type: "string", short: "p" } } });
if (opt.help) {
  console.log(`llm-agent web UI\n\nUsage: node src/server.ts [options]\n\nOptions:\n${COMMON_HELP}\n  -p, --port <n>           port to listen on (env PORT, default 8787)\n\nEnv HOST sets the bind address (default 127.0.0.1).`);
  process.exit(0);
}

let cfg: Awaited<ReturnType<typeof resolveConfig>>;
try {
  cfg = await resolveConfig(opt, { requireModel: false });
} catch (e) {
  if (!(e instanceof ConfigError)) throw e;
  // A broken saved provider (e.g. key removed) must not keep the UI from starting.
  console.error(`${e.message}\nStarting with the local provider; pick one in the UI.`);
  cfg = await resolveConfig({ ...opt, "base-url": opt["base-url"] ?? PROVIDERS.local.defaultBaseURL }, { requireModel: false });
}
const port = Number(opt.port ?? process.env.PORT ?? 8787);
const host = process.env.HOST || "127.0.0.1";
const allowedHosts = new Set(["127.0.0.1", "localhost", ...(process.env.AGENT_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean)]);

// --- state (one local user, one conversation) -------------------------------

let active = { provider: cfg.provider, baseURL: cfg.baseURL };
// Capability for /api/image. The page reads it from /api/info (JSON other sites cannot read), so
// model output cannot build working proxy URLs (e.g. CSS url(/api/image?...)) on its own.
const imageToken = randomUUID();
type Send = (event: string, data: unknown) => void;
let send: Send | null = null;
let running: AbortController | null = null;
const pendingApprovals = new Map<string, { tool: string; resolve: (ok: boolean) => void }>();
const alwaysAllow = new Set<string>();

async function approve(req: ApprovalRequest): Promise<boolean> {
  if (alwaysAllow.has(req.tool)) return true;
  if (!send) return false;
  const id = randomUUID();
  send("approval", { id, tool: req.tool, risk: req.risk, summary: req.action.summary, preview: req.action.preview ?? "" });
  return new Promise<boolean>((resolve) => {
    pendingApprovals.set(id, { tool: req.tool, resolve });
    running?.signal.addEventListener("abort", () => resolve(false), { once: true });
  });
}

const agent = new Agent({
  client: cfg.chat,
  model: cfg.model,
  workspace: cfg.workspace,
  tools: [...fsTools, ...webTools],
  permissions: { mode: cfg.mode },
  approve,
  instructions: cfg.instructions,
  maxSteps: cfg.maxSteps,
  contextTokens: cfg.contextTokens,
  maxOutputTokens: cfg.maxOutputTokens,
  temperature: cfg.temperature,
  events: {
    onText: (d) => send?.("text", d),
    onReasoning: (d) => send?.("reasoning", d),
    onToolCall: (c) => send?.("tool_call", c),
    onToolResult: (r) => send?.("tool_result", r),
    onStep: (s) => send?.("step", s),
    onNotice: (m) => send?.("notice", m),
  },
});

function info() {
  return {
    provider: active.provider,
    providerLabel: PROVIDERS[active.provider].label,
    model: agent.model,
    baseURL: active.baseURL,
    workspace: cfg.workspace,
    mode: agent.permissions.mode,
    modes: MODES,
    search: searchProviderName(),
    agentsMd: Boolean(cfg.instructions),
    tools: agent.tools.map((t) => ({ name: t.name, risk: t.risk })),
    busy: Boolean(running),
    tokens: agent.estimateTokens(),
    contextTokens: agent.contextTokens,
    imageToken,
  };
}

function settingsView() {
  return {
    active: { provider: active.provider, model: agent.model, contextTokens: agent.contextTokens },
    providers: publicProviders(loadSettings()),
    file: settingsPath(),
  };
}

/** Client for a provider from the form, falling back to the saved key (or env) when none is typed. */
function clientFromForm(form: { provider: ProviderKind; baseURL?: string; apiKey?: string; clearKey?: boolean }) {
  if (!PROVIDERS[form.provider]) throw new ProviderError(`Unknown provider "${form.provider}"`);
  const saved = loadSettings()?.providers[form.provider];
  const apiKey = form.apiKey?.trim() || (form.clearKey ? undefined : saved?.apiKey);
  const baseURL = form.baseURL?.trim() || PROVIDERS[form.provider].defaultBaseURL;
  return { client: createChatClient({ kind: form.provider, baseURL, apiKey }), apiKey, baseURL };
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new ProviderError(`${what} timed out after ${ms / 1000}s`)), ms))]);
}

// --- HTTP ---------------------------------------------------------------------

const STATIC: Record<string, [string, string]> = {
  "/": ["web/index.html", "text/html; charset=utf-8"],
  "/vendor/marked.js": ["node_modules/marked/lib/marked.umd.js", "text/javascript"],
  "/vendor/purify.js": ["node_modules/dompurify/dist/purify.min.js", "text/javascript"],
  "/vendor/katex.js": ["node_modules/katex/dist/katex.min.js", "text/javascript"],
  "/vendor/katex.css": ["node_modules/katex/dist/katex.min.css", "text/css"],
  "/vendor/mermaid.js": ["node_modules/mermaid/dist/mermaid.min.js", "text/javascript"],
};
// KaTeX's stylesheet loads its fonts from fonts/ next to it.
const FONT_TYPES: Record<string, string> = { woff2: "font/woff2", woff: "font/woff", ttf: "font/ttf" };

function staticFile(url: URL): [string, string] | undefined {
  if (STATIC[url.pathname]) return STATIC[url.pathname];
  const font = /^\/vendor\/fonts\/(KaTeX_[A-Za-z0-9_-]+\.(woff2|woff|ttf))$/.exec(url.pathname);
  if (font) return [`node_modules/katex/dist/fonts/${font[1]}`, FONT_TYPES[font[2]!]!];
  return undefined;
}

// No remote images at the CSP level: the browser blocks every way model output could load one
// (img srcset, CSS url(), SVG <image>, video poster…). Images the user's policy allows are loaded
// through /api/image instead, so that policy is the only path.
const CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; media-src 'none'; connect-src 'self'; " +
  "object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
}

/** Rejects cross-site requests and DNS rebinding: Host must be ours, Origin must match, bodies must be JSON. */
function sameOrigin(req: IncomingMessage): boolean {
  const hostHeader = req.headers.host ?? "";
  const hostname = hostHeader.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  if (!allowedHosts.has(hostname)) return false;
  const origin = req.headers.origin;
  if (req.method === "GET") return !origin || origin === `http://${hostHeader}`;
  return origin === `http://${hostHeader}` && (req.headers["content-type"] ?? "").startsWith("application/json");
}

async function body(req: IncomingMessage): Promise<any> {
  let raw = "";
  for await (const c of req) {
    raw += c;
    if (raw.length > 1_000_000) throw new Error("body too large");
  }
  return raw ? JSON.parse(raw) : {};
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/healthz") return json(res, 200, { ok: true });

    const asset = req.method === "GET" ? staticFile(url) : undefined;
    if (asset) {
      if (!sameOrigin(req)) return json(res, 403, { error: "forbidden" });
      const [file, type] = asset;
      return res
        .writeHead(200, {
          "content-type": type,
          // Vendor files are immutable per install; the page itself must always be fresh.
          "cache-control": file.startsWith("node_modules/") ? "public, max-age=86400" : "no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "content-security-policy": CSP,
        })
        .end(await readFile(path.join(ROOT, file)));
    }
    if (!url.pathname.startsWith("/api/")) return json(res, 404, { error: "not found" });
    if (!sameOrigin(req)) return json(res, 403, { error: "cross-origin request refused" });

    if (req.method === "GET" && url.pathname === "/api/info") return json(res, 200, info());

    // Same-origin image proxy for Markdown images the page decided to load.
    if (req.method === "GET" && url.pathname === "/api/image") {
      // Only this page may use it (browsers send Sec-Fetch-Site on every request).
      const site = req.headers["sec-fetch-site"];
      if (site && site !== "same-origin") return json(res, 403, { error: "forbidden" });
      if (url.searchParams.get("t") !== imageToken) return json(res, 403, { error: "forbidden" });
      const target = url.searchParams.get("url") ?? "";
      const ac = new AbortController();
      res.on("close", () => ac.abort());
      try {
        const img = await fetchImage(target, AbortSignal.any([ac.signal, AbortSignal.timeout(20_000)]));
        res.writeHead(200, {
          "content-type": img.type,
          "content-length": img.body.length,
          "cache-control": "private, max-age=600",
          "x-content-type-options": "nosniff",
          "content-security-policy": "default-src 'none'; sandbox",
        });
        return res.end(img.body);
      } catch (e: any) {
        if (ac.signal.aborted) return;
        return json(res, 502, { error: e instanceof ToolError ? e.message : "image fetch failed" });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/run") {
      const { message } = await body(req);
      if (typeof message !== "string" || !message.trim()) return json(res, 400, { error: "message required" });
      if (running) return json(res, 409, { error: "the agent is already working" });
      if (!agent.model) return json(res, 400, { error: "No model selected. Open CONFIG and pick a provider and model." });

      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      const ac = (running = new AbortController());
      send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      // Closing the tab or reloading cancels the run.
      res.on("close", () => ac.abort());
      try {
        const result = await agent.run(message, ac.signal);
        send("done", result);
      } catch (e: any) {
        send("error", { message: `${e?.status ? `HTTP ${e.status}: ` : ""}${e?.message ?? e}` });
      } finally {
        running = null;
        send = null;
        pendingApprovals.clear();
        res.end();
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/approve") {
      const { id, allow, always } = await body(req);
      const pending = pendingApprovals.get(id);
      if (!pending) return json(res, 404, { error: "no such approval" });
      pendingApprovals.delete(id);
      if (allow && always) alwaysAllow.add(pending.tool);
      pending.resolve(Boolean(allow));
      return json(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/cancel") {
      running?.abort();
      return json(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/reset") {
      if (running) return json(res, 409, { error: "stop the agent first" });
      agent.reset();
      alwaysAllow.clear();
      return json(res, 200, info());
    }

    if (req.method === "POST" && url.pathname === "/api/mode") {
      const { mode } = await body(req);
      if (!MODES.includes(mode)) return json(res, 400, { error: `mode must be one of ${MODES.join(", ")}` });
      agent.setPermissionMode(mode as PermissionMode);
      return json(res, 200, info());
    }

    if (req.method === "GET" && url.pathname === "/api/settings") return json(res, 200, settingsView());

    // Lists the models a provider offers, using the typed key or the saved/env one.
    if (req.method === "POST" && url.pathname === "/api/settings/models") {
      const form = await body(req);
      let target = "";
      try {
        const { client, baseURL } = clientFromForm(form);
        target = baseURL;
        const models = await withTimeout(client.listModels(), 20_000, "Listing models");
        return json(res, 200, { models });
      } catch (e: any) {
        let msg: string;
        if (e instanceof ProviderError) msg = e.message;
        else if (e?.status === 401 || e?.status === 403) msg = `The API key was rejected (HTTP ${e.status}).`;
        else if (e?.status) msg = `HTTP ${e.status}: ${e.message}`;
        else msg = `Cannot reach ${target || "the endpoint"} (${e?.cause?.code ?? e?.message ?? e}).`;
        return json(res, 400, { error: msg });
      }
    }

    // Saves provider + model and switches the running agent to them. The conversation is kept.
    if (req.method === "POST" && url.pathname === "/api/settings") {
      if (running) return json(res, 409, { error: "Stop the agent before changing the model." });
      const form = await body(req);
      if (typeof form.model !== "string" || !form.model.trim()) return json(res, 400, { error: "Pick a model." });
      const contextTokens = Number(form.contextTokens) || PROVIDERS[form.provider as ProviderKind]?.defaultContextTokens;
      if (!Number.isInteger(contextTokens) || contextTokens < 2048) return json(res, 400, { error: "Context window must be at least 2048 tokens." });
      let built;
      try {
        built = clientFromForm(form);
      } catch (e: any) {
        return json(res, 400, { error: e.message });
      }
      const saved: SavedSettings = loadSettings() ?? { provider: form.provider, model: form.model, providers: {} };
      const kind = form.provider as ProviderKind;
      saved.provider = kind;
      saved.model = form.model.trim();
      saved.contextTokens = contextTokens;
      saved.providers[kind] = {
        baseURL: built.baseURL !== PROVIDERS[kind].defaultBaseURL ? built.baseURL : undefined,
        // Keys from env are not copied into the file.
        apiKey: form.apiKey?.trim() || (form.clearKey ? undefined : saved.providers[kind]?.apiKey),
      };
      saveSettings(saved);
      agent.setModel({ client: built.client, model: saved.model, contextTokens });
      active = { provider: kind, baseURL: built.baseURL };
      return json(res, 200, { info: info(), settings: settingsView() });
    }

    json(res, 404, { error: "not found" });
  } catch (e: any) {
    if (!res.headersSent) json(res, 500, { error: e?.message ?? String(e) });
  }
});

server.listen(port, host, () => {
  console.log(host === "0.0.0.0" ? `llm-agent UI listening on 0.0.0.0:${port} (container)` : `llm-agent UI: http://${host}:${port}`);
  console.log(`${PROVIDERS[active.provider].label} · ${agent.model || "(no model selected)"} @ ${active.baseURL} · workspace ${cfg.workspace} · mode ${cfg.mode}`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    running?.abort();
    server.close();
    server.closeAllConnections();
    process.exit(0);
  });
}
