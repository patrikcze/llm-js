import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { Agent, fetch as undiciFetch } from "undici";
import { type Tool, type ToolContext, ToolError, truncate } from "./types.ts";

const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const FETCH_TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 5_000_000;
const DEFAULT_FETCH_CHARS = 20_000;

// ---------------------------------------------------------------------------
// Safe HTTP
// ---------------------------------------------------------------------------

// Everything that is not the public internet. BlockList matches any textual form of an address,
// so "::ffff:7f00:1", "::ffff:127.0.0.1" and "0:0:0:0:0:ffff:7f00:1" are all caught.
// Two lists: BlockList also matches IPv4 addresses against IPv6 rules (as ::a.b.c.d), so a single
// list containing ::/96 would flag every IPv4 address.
const BLOCKED_V4 = new BlockList();
const BLOCKED_V6 = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  BLOCKED_V4.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::", 96], // unspecified, loopback and IPv4-compatible (::a.b.c.d)
  ["::ffff:0:0", 96], // IPv4-mapped
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48], // NAT64: embeds an IPv4 address
  ["100::", 64], // discard
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4: embeds an IPv4 address
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
] as const)
  BLOCKED_V6.addSubnet(net, bits, "ipv6");

export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 0) return true; // not an address: refuse rather than guess
  return family === 6 ? BLOCKED_V6.check(ip, "ipv6") : BLOCKED_V4.check(ip, "ipv4");
}

const privateFetchAllowed = () => process.env.AGENT_ALLOW_PRIVATE_FETCH === "1";

/**
 * DNS lookup used for the actual connection. Rejects private answers, so the socket can only
 * reach an address that passed the check (no DNS-rebinding window between check and connect).
 */
export const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "", 0);
    const list = addresses as LookupAddress[];
    if (!privateFetchAllowed()) {
      const bad = list.find((a) => isPrivateAddress(a.address));
      if (bad) {
        const e = Object.assign(new Error(`${hostname} resolves to a private/local address (${bad.address})`), {
          code: "ERR_PRIVATE_ADDRESS",
        });
        return callback(e, "", 0);
      }
    }
    if (options.all) return (callback as any)(null, list);
    callback(null, list[0]!.address, list[0]!.family);
  });
};

const dispatcher = new Agent({ connect: { lookup: guardedLookup } });

/**
 * Pages the model reads can tell it to fetch anything, so by default we refuse to reach
 * localhost and private networks. Set AGENT_ALLOW_PRIVATE_FETCH=1 to lift that.
 * This check gives a clear early error; `guardedLookup` enforces it at connect time.
 */
async function assertPublicUrl(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ToolError(`Only http(s) URLs are supported, got ${url.protocol}`);
  }
  if (privateFetchAllowed()) return;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (addrs.length === 0) throw new ToolError(`Could not resolve host ${url.hostname}`);
  if (addrs.some((a) => isPrivateAddress(a.address))) {
    throw new ToolError(`Refusing to fetch ${url.hostname}: it resolves to a private/local address.`);
  }
}

type FetchResponse = Awaited<ReturnType<typeof undiciFetch>>;

async function safeFetch(
  rawUrl: string,
  ctx: ToolContext,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<FetchResponse> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ToolError(`Invalid URL: ${rawUrl}`);
  }
  const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]);
  // Follow redirects by hand so every hop goes through the address check.
  for (let hop = 0; hop < 6; hop++) {
    await assertPublicUrl(url);
    let res: FetchResponse;
    try {
      res = await undiciFetch(url, {
        ...init,
        redirect: "manual",
        signal,
        dispatcher,
        // No Brotli from arbitrary servers: defense in depth for decoder bugs like CVE-2026-111497.
        headers: { "User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.9", "Accept-Encoding": "gzip, deflate", ...init.headers },
      });
    } catch (e: any) {
      if (e.name === "TimeoutError") throw new ToolError(`Timed out fetching ${url}`);
      if (e.name === "AbortError") throw e;
      if (e.cause?.code === "ERR_PRIVATE_ADDRESS") throw new ToolError(`Refusing to fetch ${url.hostname}: ${e.cause.message}.`);
      throw new ToolError(`Network error fetching ${url}: ${e.cause?.code ?? e.message}`);
    }
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel();
      url = new URL(location, url);
      init = { ...init, method: "GET", body: undefined };
      continue;
    }
    return res;
  }
  throw new ToolError(`Too many redirects for ${rawUrl}`);
}

async function readBody(res: FetchResponse): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

// ---------------------------------------------------------------------------
// Image proxy (used by the browser UI)
// ---------------------------------------------------------------------------

const MAX_IMAGE_BYTES = 15_000_000;
// Raster formats only: SVG can carry script and would run in the UI's origin if opened directly.
const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/x-icon",
  "image/vnd.microsoft.icon",
]);

/**
 * Fetches a remote image for the UI with the same guards as web_fetch (public addresses only,
 * pinned DNS, checked redirects). Returns the bytes and content type, or throws ToolError.
 */
export async function fetchImage(rawUrl: string, signal: AbortSignal): Promise<{ type: string; body: Buffer }> {
  const res = await safeFetch(
    rawUrl,
    { workspace: "", signal },
    { headers: { Accept: "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8" } },
  );
  if (!res.ok) {
    await res.body?.cancel();
    throw new ToolError(`HTTP ${res.status} for image ${rawUrl}`);
  }
  const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!IMAGE_TYPES.has(type)) {
    await res.body?.cancel();
    throw new ToolError(`Not a supported image type: "${type || "unknown"}"`);
  }
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_IMAGE_BYTES) {
    await res.body?.cancel();
    throw new ToolError("Image too large");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body ?? []) {
    size += chunk.byteLength;
    if (size > MAX_IMAGE_BYTES) throw new ToolError("Image too large");
    chunks.push(chunk);
  }
  return { type, body: Buffer.concat(chunks) };
}

// ---------------------------------------------------------------------------
// HTML -> Markdown
// ---------------------------------------------------------------------------

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
turndown.remove(["script", "style", "noscript", "iframe", "svg", "form", "button"] as any);

export function htmlToMarkdown(html: string, url: string): { title: string; markdown: string } {
  const { document } = parseHTML(html);
  // Make relative links absolute so the model can follow them.
  for (const a of document.querySelectorAll("a[href]")) {
    try {
      a.setAttribute("href", new URL(a.getAttribute("href")!, url).href);
    } catch {}
  }
  let title = document.title?.trim() ?? "";
  let contentHtml: string;
  const article = new Readability(document as any, { charThreshold: 200 }).parse();
  if (article?.content && (article.textContent?.trim().length ?? 0) > 200) {
    title = article.title?.trim() || title;
    contentHtml = article.content;
  } else {
    // Readability gave up (search pages, app shells...). Fall back to the whole body.
    const { document: fresh } = parseHTML(html);
    for (const el of fresh.querySelectorAll("script,style,noscript,nav,header,footer,svg")) el.remove();
    contentHtml = fresh.body?.innerHTML ?? html;
  }
  const markdown = turndown
    .turndown(contentHtml)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, markdown };
}

// ---------------------------------------------------------------------------
// web_fetch
// ---------------------------------------------------------------------------

export const webFetchTool: Tool<{ url: string; start_index?: number; max_length?: number }, string> = {
  name: "web_fetch",
  risk: "read",
  description:
    "Fetch a web page and return its main content as Markdown (HTML) or raw text (JSON, plain text). " +
    "Long pages are paginated: call again with start_index to continue reading.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "Absolute http(s) URL." },
      start_index: { type: "integer", minimum: 0, description: "Character offset to start from. Default 0." },
      max_length: {
        type: "integer",
        minimum: 500,
        maximum: 100000,
        description: `Max characters to return. Default ${DEFAULT_FETCH_CHARS}.`,
      },
    },
    required: ["url"],
  },
  async run({ url, start_index = 0, max_length = DEFAULT_FETCH_CHARS }, ctx) {
    const res = await safeFetch(url, ctx, {
      headers: { Accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5" },
    });
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    if (!res.ok) {
      const body = await readBody(res).catch(() => "");
      throw new ToolError(`HTTP ${res.status} ${res.statusText} for ${url}${body ? `\n${body.slice(0, 500)}` : ""}`);
    }
    const isText = /text\/|json|xml|javascript|yaml|markdown/.test(type) || type === "";
    if (!isText) {
      await res.body?.cancel();
      throw new ToolError(`Unsupported content type "${type}" at ${url}. Only text, HTML and JSON can be read.`);
    }
    const raw = await readBody(res);
    let title = "";
    let content: string;
    if (type.includes("html") || (type === "" && /<html|<!doctype html/i.test(raw.slice(0, 1000)))) {
      ({ title, markdown: content } = htmlToMarkdown(raw, res.url || url));
    } else if (type.includes("json")) {
      try {
        content = JSON.stringify(JSON.parse(raw), null, 2);
      } catch {
        content = raw;
      }
    } else {
      content = raw;
    }
    const total = content.length;
    if (start_index >= total && total > 0) throw new ToolError(`start_index ${start_index} is past the end (${total} chars).`);
    const slice = content.slice(start_index, start_index + max_length);
    const end = start_index + slice.length;
    const header = [`URL: ${res.url || url}`, title && `Title: ${title}`, `Showing characters ${start_index}-${end} of ${total}`]
      .filter(Boolean)
      .join("\n");
    const more = end < total ? `\n\n[More content available: call web_fetch with start_index=${end}]` : "";
    return `${header}\n\n${slice}${more}`;
  },
};

// ---------------------------------------------------------------------------
// web_search
// ---------------------------------------------------------------------------

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

type SearchProvider = (query: string, count: number, ctx: ToolContext) => Promise<SearchResult[]>;

const tavily: SearchProvider = async (query, count, ctx) => {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.TAVILY_API_KEY}` },
    body: JSON.stringify({ query, max_results: count }),
  });
  if (!res.ok) throw new ToolError(`Tavily search failed: HTTP ${res.status} ${await res.text()}`);
  const data: any = await res.json();
  return (data.results ?? []).map((r: any) => ({ title: r.title, url: r.url, snippet: r.content ?? "" }));
};

const brave: SearchProvider = async (query, count, ctx) => {
  const u = new URL("https://api.search.brave.com/res/v1/web/search");
  u.searchParams.set("q", query);
  u.searchParams.set("count", String(count));
  const res = await fetch(u, {
    signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
    headers: { Accept: "application/json", "X-Subscription-Token": process.env.BRAVE_API_KEY! },
  });
  if (!res.ok) throw new ToolError(`Brave search failed: HTTP ${res.status} ${await res.text()}`);
  const data: any = await res.json();
  return (data.web?.results ?? []).map((r: any) => ({
    title: r.title,
    url: r.url,
    snippet: (r.description ?? "").replace(/<[^>]+>/g, ""),
  }));
};

const searxng: SearchProvider = async (query, count, ctx) => {
  const u = new URL("/search", process.env.SEARXNG_URL);
  u.searchParams.set("q", query);
  u.searchParams.set("format", "json");
  // SearXNG is usually self-hosted on localhost, so it bypasses the private-address guard on purpose.
  let res: Response;
  try {
    res = await fetch(u, { signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]) });
  } catch (e: any) {
    if (e.name === "AbortError") throw e;
    throw new ToolError(
      `SearXNG at ${process.env.SEARXNG_URL} is not reachable (${e.cause?.code ?? e.message}). ` +
        "Web search is unavailable: tell the user to run `npm run search:up`, and use web_fetch on known URLs meanwhile.",
    );
  }
  if (res.status === 403)
    throw new ToolError("SearXNG refused the JSON API (HTTP 403). Add `json` to search.formats in searxng/settings.yml.");
  if (!res.ok) throw new ToolError(`SearXNG search failed: HTTP ${res.status}.`);
  const data: any = await res.json();
  return (data.results ?? []).slice(0, count).map((r: any) => ({ title: r.title, url: r.url, snippet: r.content ?? "" }));
};

/** Keyless fallback: scrapes DuckDuckGo's HTML endpoint. */
const duckduckgo: SearchProvider = async (query, count, ctx) => {
  const res = await safeFetch("https://html.duckduckgo.com/html/", ctx, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ q: query, kl: "wt-wt" }).toString(),
  });
  const html = await readBody(res);
  if (res.status === 202 || /anomaly-modal|challenge-form/.test(html)) {
    throw new ToolError(
      "Web search is unavailable: DuckDuckGo is blocking automated requests from this machine. " +
        "Do not retry web_search during this task. Use web_fetch on official URLs you know instead " +
        "(e.g. the project's website or docs), and tell the user that search needs TAVILY_API_KEY, BRAVE_API_KEY or SEARXNG_URL.",
    );
  }
  const { document } = parseHTML(html);
  const results: SearchResult[] = [];
  for (const el of document.querySelectorAll(".result")) {
    if (el.classList.contains("result--ad")) continue;
    const a = el.querySelector("a.result__a");
    if (!a) continue;
    let href = a.getAttribute("href") ?? "";
    // Links are wrapped as //duckduckgo.com/l/?uddg=<encoded target>
    try {
      const u = new URL(href, "https://duckduckgo.com");
      href = u.searchParams.get("uddg") ?? u.href;
    } catch {}
    if (!href.startsWith("http")) continue;
    results.push({
      title: a.textContent?.trim() ?? "",
      url: href,
      snippet: el.querySelector(".result__snippet")?.textContent?.trim() ?? "",
    });
    if (results.length >= count) break;
  }
  return results;
};

export function searchProviderName(): string {
  if (process.env.TAVILY_API_KEY) return "tavily";
  if (process.env.BRAVE_API_KEY) return "brave";
  if (process.env.SEARXNG_URL) return "searxng";
  return "duckduckgo";
}

const providers: Record<string, SearchProvider> = { tavily, brave, searxng, duckduckgo };

export const webSearchTool: Tool<{ query: string; count?: number }, string> = {
  name: "web_search",
  risk: "read",
  description:
    "Search the web. Returns titles, URLs and snippets. Snippets are short; use web_fetch on the most relevant URLs to read them.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query." },
      count: { type: "integer", minimum: 1, maximum: 20, description: "Number of results. Default 8." },
    },
    required: ["query"],
  },
  async run({ query, count = 8 }, ctx) {
    if (!query?.trim()) throw new ToolError("query must not be empty");
    const name = searchProviderName();
    const results = await providers[name]!(query, Math.min(Math.max(count, 1), 20), ctx);
    if (results.length === 0) return `No results for ${JSON.stringify(query)} (provider: ${name}). Try different keywords.`;
    const body = results
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet.replace(/\s+/g, " ").slice(0, 400)}`)
      .join("\n\n");
    return truncate(`Results for ${JSON.stringify(query)} (provider: ${name}):\n\n${body}`, 12_000);
  },
};

export const webTools: Tool[] = [webSearchTool, webFetchTool];
