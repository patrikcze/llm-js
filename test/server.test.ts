/** The web server's access control, against the real server process. */
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const TOKEN = "t".repeat(8) + "secret-token-for-tests";
// The session cookie is named after the token (hashed), never the port: every Docker agent listens on
// 8787 inside its container, and a port-based name made two agents in one browser overwrite each other.
const COOKIE = `agent_session_${createHash("sha256").update(TOKEN).digest("hex").slice(0, 16)}`;
let child: ChildProcess;
let base = "";
let port = 0;
let tmp = "";
let log = "";

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });

// What a malicious peer can do: send any headers it likes (here: the same-origin ones the page sends).
const spoof = { host: "127.0.0.1", origin: "", "content-type": "application/json" };
const call = (p: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
  fetch(`${base}${p}`, { redirect: "manual", ...init, headers: { origin: base, ...init.headers } });

before(async () => {
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  tmp = await mkdtemp(path.join(os.tmpdir(), "agent-server-"));
  child = spawn(process.execPath, ["src/server.ts", "--port", String(port), "-w", tmp], {
    env: {
      ...process.env,
      AGENT_TOKEN: TOKEN,
      AGENT_CONFIG_DIR: tmp,
      LLM_BASE_URL: "http://127.0.0.1:1/v1",
      HOST: "127.0.0.1",
      AGENT_OPEN_HINT: 'make agent-open NAME=t1<script>"',
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d) => {
    log += d;
  });
  child.stderr?.on("data", (d) => {
    log += d;
  });
  for (let i = 0; i < 100; i++) {
    if (
      await fetch(`${base}/healthz`).then(
        (r) => r.ok,
        () => false,
      )
    )
      return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start:\n${log}`);
});
after(async () => {
  child.kill();
  await rm(tmp, { recursive: true, force: true });
});

describe("access token", () => {
  it("prints the sign-in URL once and leaves /healthz open", async () => {
    assert.match(log, new RegExp(`Open: http://127\\.0\\.0\\.1:${port}/\\?token=${TOKEN}`));
    assert.equal((await call("/healthz")).status, 200);
  });

  it("refuses the page and every API call without the token, even with spoofed same-origin headers", async () => {
    for (const [method, p] of [
      ["GET", "/"],
      ["GET", "/api/info"],
      ["GET", "/api/settings"],
      ["GET", "/vendor/marked.js"],
    ] as const) {
      const r = await call(p, { method, headers: { ...spoof, origin: base } });
      assert.equal(r.status, 401, `${method} ${p}`);
    }
    for (const p of ["/api/run", "/api/mode", "/api/approve", "/api/cancel", "/api/reset", "/api/options", "/api/settings"]) {
      const r = await call(p, {
        method: "POST",
        headers: { ...spoof, origin: base },
        body: JSON.stringify({ mode: "auto", message: "hi" }),
      });
      assert.equal(r.status, 401, `POST ${p}`);
    }
    // And nothing changed.
    const info = await (await call("/api/info", { headers: { "x-agent-token": TOKEN } })).json();
    assert.equal(info.mode, "ask");
  });

  it("the access page says how to open this agent and accepts a pasted token (hint sanitized)", async () => {
    const page = await (await call("/")).text();
    assert.match(page, /<code>make agent-open NAME=t1script<\/code>/);
    assert.doesNotMatch(page, /<script>/);
    assert.match(page, /<form method="get" action="\/"><input name="token" type="password"/);
  });

  it("401s carry the open hint, so the UI can say how to get back in", async () => {
    const body = await (await call("/api/info")).json();
    assert.equal(body.error, "access token required");
    assert.equal(body.hint, "make agent-open NAME=t1script");
  });

  it("rejects wrong, empty and near-miss tokens", async () => {
    for (const bad of ["", "wrong", TOKEN.slice(0, -1), `${TOKEN}x`, TOKEN.toUpperCase()]) {
      assert.equal((await call("/api/info", { headers: { "x-agent-token": bad } })).status, 401, JSON.stringify(bad));
      assert.equal((await call(`/?token=${encodeURIComponent(bad)}`)).status, 401, `?token=${bad}`);
    }
    assert.equal((await call("/api/info", { headers: { cookie: `${COOKIE}=nope` } })).status, 401);
  });

  it("signs in with ?token=, sets an HttpOnly SameSite=Strict cookie named per agent, and redirects clean", async () => {
    const r = await call(`/?token=${TOKEN}`);
    assert.equal(r.status, 302);
    assert.equal(r.headers.get("location"), "/");
    const cookie = r.headers.get("set-cookie") ?? "";
    assert.match(cookie, new RegExp(`^${COOKIE}=${TOKEN}; HttpOnly; SameSite=Strict; Path=/`));
    assert.doesNotMatch(cookie.split("=")[0]!, new RegExp(String(port)), "the cookie name must not depend on the port");
    const session = cookie.split(";")[0]!;
    const page = await call("/", { headers: { cookie: session } });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /LLM\/\/AGENT/);
    const info = await call("/api/info", { headers: { cookie: session } });
    assert.equal(info.status, 200);
    // Another agent's session cookie, sent alongside (same host), neither breaks nor replaces this one.
    const other = `agent_session_${"0".repeat(16)}=another-agents-token`;
    assert.equal((await call("/api/info", { headers: { cookie: `${other}; ${session}` } })).status, 200);
    assert.equal((await call("/api/info", { headers: { cookie: other } })).status, 401);
  });

  it("keeps the same-origin protections on top of the token", async () => {
    const h = { "x-agent-token": TOKEN };
    assert.equal(
      (
        await call("/api/mode", {
          method: "POST",
          headers: { ...h, origin: "https://evil.example", "content-type": "application/json" },
          body: '{"mode":"auto"}',
        })
      ).status,
      403,
    );
    // fetch() cannot set Host, so use a raw request to prove a rebinding-style Host is refused.
    const rebinding = await new Promise<number>((resolve, reject) => {
      const r = request({ host: "127.0.0.1", port, path: "/api/info", headers: { ...h, host: "evil.example" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      r.on("error", reject).end();
    });
    assert.equal(rebinding, 403);
    assert.equal(
      (await call("/api/mode", { method: "POST", headers: { ...h, "content-type": "application/json" }, body: '{"mode":"auto"}' })).status,
      200,
    );
  });
});
