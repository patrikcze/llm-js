import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { Agent, getSetCookies, fetch as undiciFetch } from "undici";
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

// Inside an OpenShell sandbox, DNS answers every name with an address from 198.18.0.0/15 that the
// sandbox's proxy maps back to the real destination; the proxy resolves the name itself and only
// connects where the sandbox policy allows. Those answers are fine for public names. Internal names
// (host.openshell.internal reaches the host machine) are refused by name, so this never opens them.
const inOpenShell = () => process.env.OPENSHELL_SANDBOX === "1";
const PROXY_MAPPED = new BlockList();
PROXY_MAPPED.addSubnet("198.18.0.0", 15, "ipv4");

/** Names that point at the local machine or network, whatever they resolve to. */
export function isInternalHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (isIP(h.replace(/^\[|\]$/g, ""))) return false;
  return !h.includes(".") || /(^|\.)(localhost|local|internal|home\.arpa|lan)$/.test(h);
}

/** True when connecting `hostname` at `address` must be refused. */
export function isRefusedAddress(hostname: string, address: string): boolean {
  if (!isPrivateAddress(address)) return false;
  const literal = isIP(hostname.replace(/^\[|\]$/g, "")) !== 0;
  return !(inOpenShell() && !literal && isIP(address) === 4 && PROXY_MAPPED.check(address, "ipv4"));
}

/**
 * DNS lookup used for the actual connection. Rejects private answers, so the socket can only
 * reach an address that passed the check (no DNS-rebinding window between check and connect).
 */
export const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "", 0);
    const list = addresses as LookupAddress[];
    if (!privateFetchAllowed()) {
      if (isInternalHostname(hostname)) {
        const e = Object.assign(new Error(`${hostname} is a private/local address`), { code: "ERR_PRIVATE_ADDRESS" });
        return callback(e, "", 0);
      }
      const bad = list.find((a) => isRefusedAddress(hostname, a.address));
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
  if (isInternalHostname(host)) throw new ToolError(`Refusing to fetch ${url.hostname}: it is a private/local address.`);
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (addrs.length === 0) throw new ToolError(`Could not resolve host ${url.hostname}`);
  if (addrs.some((a) => isRefusedAddress(host, a.address))) {
    throw new ToolError(`Refusing to fetch ${url.hostname}: it resolves to a private/local address.`);
  }
}

type FetchResponse = Awaited<ReturnType<typeof undiciFetch>>;

/** What the model should tell the user when the OpenShell policy blocks a site. */
function sandboxBlocked(url: URL, requested: URL): string {
  const name = process.env.AGENT_SANDBOX_NAME || "<name>";
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  // A redirect (e.g. to a consent or login page) is easy to mistake for the allowed site failing.
  const blocked = `the sandbox's network policy does not allow ${url.hostname}:${port}`;
  const what =
    url.hostname === requested.hostname
      ? `The ${blocked}.`
      : `${requested.hostname} redirected to ${url.hostname} (often a consent or login page), and ${blocked}.`;
  return (
    `${what} Do not retry. ` +
    `Tell the user they can allow it with: make openshell-allow NAME=${name} HOST=${url.hostname}${port === "443" ? "" : ` PORT=${port}`}`
  );
}

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
  const requested = url;
  const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]);
  // Cookies set during this one fetch, sent back on its later redirect hops: consent and cookie-check
  // redirects (set a cookie, then send you back) need that. Nothing is kept between fetches.
  const jar = new Map<string, { domain: string; value: string }>();
  // Follow redirects by hand so every hop goes through the address check.
  for (let hop = 0; hop < 8; hop++) {
    await assertPublicUrl(url);
    const host = url.hostname.toLowerCase();
    const cookie = [...jar.entries()]
      .filter(([, c]) => host === c.domain || host.endsWith(`.${c.domain}`))
      .map(([key, c]) => `${key.slice(key.indexOf(" ") + 1)}=${c.value}`)
      .join("; ");
    let res: FetchResponse;
    try {
      res = await undiciFetch(url, {
        ...init,
        redirect: "manual",
        signal,
        dispatcher,
        // No Brotli from arbitrary servers: defense in depth for decoder bugs like CVE-2026-111497.
        headers: {
          "User-Agent": USER_AGENT,
          "Accept-Language": "en-US,en;q=0.9",
          "Accept-Encoding": "gzip, deflate",
          ...(cookie ? { Cookie: cookie } : {}),
          ...init.headers,
        },
      });
    } catch (e: any) {
      if (e.name === "TimeoutError") throw new ToolError(`Timed out fetching ${url}`);
      if (e.name === "AbortError") throw e;
      if (e.cause?.code === "ERR_PRIVATE_ADDRESS") throw new ToolError(`Refusing to fetch ${url.hostname}: ${e.cause.message}.`);
      if (inOpenShell() && ["EACCES", "ECONNRESET", "ECONNREFUSED"].includes(e.cause?.code))
        throw new ToolError(sandboxBlocked(url, requested));
      throw new ToolError(`Network error fetching ${url}: ${e.cause?.code ?? e.message}`);
    }
    for (const c of getSetCookies(res.headers as any)) {
      const domain = (c.domain ?? host).replace(/^\./, "").toLowerCase();
      if (host !== domain && !host.endsWith(`.${domain}`)) continue; // a cookie for another site: ignore
      const key = `${domain} ${c.name}`;
      if (c.value === "" || (c.maxAge !== undefined && c.maxAge <= 0)) jar.delete(key);
      else jar.set(key, { domain, value: c.value });
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
  return decodeBody(Buffer.concat(chunks), res.headers.get("content-type") ?? "");
}

/**
 * Decodes a page in its declared encoding: the Content-Type charset, else a BOM, else <meta charset>
 * in the first bytes, else UTF-8. Many sites (Czech, Polish, Japanese ...) still serve windows-1250,
 * iso-8859-2, shift_jis and the like, which come out garbled when read as UTF-8.
 */
export function decodeBody(bytes: Uint8Array, contentType: string): string {
  const declared =
    contentType.match(/charset=["']?([\w.:-]+)/i)?.[1] ??
    (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? "utf-8" : undefined) ??
    new TextDecoder("latin1").decode(bytes.subarray(0, 4096)).match(/<meta[^>]+charset=["']?([\w.:-]+)/i)?.[1];
  try {
    return new TextDecoder(declared ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes); // unknown label: fall back to UTF-8
  }
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
  // The page without chrome: its <main> when that holds real content, else the body.
  const { document: page } = parseHTML(html);
  // Not <form>: some sites (ASP.NET) wrap the whole page in one.
  for (const el of page.querySelectorAll("script,style,noscript,template,svg,nav,aside,dialog")) el.remove();
  // Page-level header and footer only: inside an article they often hold its headline or byline.
  for (const el of page.querySelectorAll("header,footer")) if (!el.parentElement?.closest("article,main,[role=main]")) el.remove();
  for (const a of page.querySelectorAll("a[href]")) {
    try {
      a.setAttribute("href", new URL(a.getAttribute("href")!, url).href);
    } catch {}
  }
  const main = page.querySelector("main,[role=main]");
  const textOf = (n: { textContent: string | null } | null | undefined) => (n?.textContent ?? "").replace(/\s+/g, " ").trim().length;
  // A page without <head> can leave the parser with an empty <body> and the content after it.
  const body = textOf(page.body) > 0 ? page.body : page.documentElement;
  const whole = textOf(main) >= 500 ? main! : body;
  const wholeLength = textOf(whole);
  // Reader mode (Readability) is right for articles, but on homepages, listings and app-style pages it
  // keeps one teaser and drops the rest. Use it only when it captures a fair share of the page's text.
  let contentHtml: string;
  const article = new Readability(document as any, { charThreshold: 200 }).parse();
  const articleLength = (article?.textContent ?? "").replace(/\s+/g, " ").trim().length;
  if (article?.content && articleLength > 200 && articleLength >= 0.4 * wholeLength) {
    title = article.title?.trim() || title;
    contentHtml = article.content;
  } else {
    contentHtml = whole?.innerHTML ?? html;
  }
  const markdown = turndown
    .turndown(contentHtml)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, markdown };
}

/** True when a fetch of `requested` ended on what looks like a cookie-consent page instead. */
export function consentRedirect(requested: string, final: string): boolean {
  try {
    const r = new URL(requested);
    const f = new URL(final);
    if (f.hostname === r.hostname && f.pathname === r.pathname) return false;
    return /(^|\.)(consent|cmp)\.|consent|souhlas|zgoda|einwilligung|cookie-?(wall|settings|consent)|privacy-gateway|gdpr/i.test(
      f.hostname + f.pathname,
    );
  } catch {
    return false;
  }
}

/**
 * Recognizes the challenge pages of common bot-protection services. Normal pages often embed these
 * services' scripts or a login CAPTCHA, so a successful (2xx) page only counts when it is the challenge
 * itself; an error response may match more loosely.
 */
export function botWall(html: string, status: number): string | undefined {
  const head = html.slice(0, 20_000);
  const failed = status >= 400;
  if (/<title>\s*Just a moment\.\.\.\s*<\/title>|cf-chl-|Attention Required! \| Cloudflare/i.test(head)) return "Cloudflare";
  if (/geo\.captcha-delivery\.com|ct\.captcha-delivery\.com/i.test(head) || (failed && html.length < 5000 && /#cmsg\b/.test(head)))
    return "DataDome";
  if (/id="px-captcha"/i.test(head)) return "PerimeterX";
  if (failed && /<title>\s*Access Denied\s*<\/title>[\s\S]*Reference #/i.test(head)) return "Akamai";
  if (failed && /g-recaptcha|hcaptcha\.com|verify you are (a )?human/i.test(head)) return "CAPTCHA";
  return undefined;
}

/**
 * What the model should do when a site refuses automated readers: stop, say so, use other sources.
 * web_fetch does not try to get around these checks.
 */
function blockedByBotCheck(url: string, wall: string, status: number): string {
  const host = new URL(url).hostname;
  return (
    `${host} blocks automated readers (${wall} bot check, HTTP ${status}). Do not retry and do not try to work around it. ` +
    "Tell the user this page could not be read, and use other sources (web_search for other coverage, or the site's RSS feed) instead. " +
    "Do not present search snippets as if you had read the page."
  );
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
      const wall = botWall(body, res.status);
      if (wall) throw new ToolError(blockedByBotCheck(res.url || url, wall, res.status));
      throw new ToolError(`HTTP ${res.status} ${res.statusText} for ${url}${body ? `\n${body.slice(0, 500)}` : ""}`);
    }
    const isText = /text\/|json|xml|javascript|yaml|markdown/.test(type) || type === "";
    if (!isText) {
      await res.body?.cancel();
      throw new ToolError(`Unsupported content type "${type}" at ${url}. Only text, HTML and JSON can be read.`);
    }
    const raw = await readBody(res);
    // Some bot checks answer 200 with a challenge page instead of the content.
    const wall = botWall(raw, res.status);
    if (wall) throw new ToolError(blockedByBotCheck(res.url || url, wall, res.status));
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
    const finalUrl = res.url || url;
    const header = [
      `URL: ${finalUrl}`,
      consentRedirect(url, finalUrl) &&
        `Note: the site redirected this request to a cookie-consent page (${new URL(finalUrl).hostname}), so this is not the requested page. ` +
          "web_fetch does not give consent on the user's behalf: tell the user, and use other sources for the content.",
      title && `Title: ${title}`,
      `Showing characters ${start_index}-${end} of ${total}`,
    ]
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
