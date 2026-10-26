import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { fetchImage, guardedLookup, htmlToMarkdown, isPrivateAddress, webFetchTool } from "../src/tools/web.ts";

const ctx = { workspace: process.cwd(), signal: new AbortController().signal };

const ARTICLE = `<!doctype html><html><head><title>Test Page</title></head><body>
<nav>Home | About</nav>
<article><h1>Big News</h1>
<p>${"The quick brown fox jumps over the lazy dog. ".repeat(20)}</p>
<p>See <a href="/more">more details</a>.</p>
<script>alert("x")</script></article></body></html>`;

describe("htmlToMarkdown", () => {
  it("extracts the article as Markdown with absolute links and no scripts", () => {
    const { title, markdown } = htmlToMarkdown(ARTICLE, "https://example.com/news/1");
    assert.equal(title, "Test Page");
    assert.match(markdown, /quick brown fox/);
    assert.match(markdown, /\[more details\]\(https:\/\/example\.com\/more\)/);
    assert.doesNotMatch(markdown, /alert/);
  });
});

describe("isPrivateAddress", () => {
  it("catches every encoding of local/private addresses", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.31.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "::1",
      "::",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "0:0:0:0:0:ffff:7f00:1",
      "::127.0.0.1",
      "64:ff9b::7f00:1",
      "2002:7f00:1::",
      "fd00::1",
      "fe80::1",
      "fec0::1",
      "ff02::1",
      "not-an-ip",
    ])
      assert.equal(isPrivateAddress(ip), true, ip);
    for (const ip of ["1.1.1.1", "8.8.8.8", "93.184.216.34", "2606:4700:4700::1111", "2a00:1450:4001::200e"]) {
      assert.equal(isPrivateAddress(ip), false, ip);
    }
  });

  it("pins connections: the lookup used to connect refuses private answers", async () => {
    delete process.env.AGENT_ALLOW_PRIVATE_FETCH;
    const err = await new Promise<any>((resolve) => guardedLookup("localhost", {}, (e) => resolve(e)));
    assert.equal(err?.code, "ERR_PRIVATE_ADDRESS");
  });
});

describe("web_fetch", () => {
  let server: ReturnType<typeof createServer>;
  let base = "";
  before(async () => {
    server = createServer((req, res) => {
      if (req.url === "/page") return res.writeHead(200, { "content-type": "text/html" }).end(ARTICLE);
      if (req.url === "/json") return res.writeHead(200, { "content-type": "application/json" }).end('{"a":1}');
      if (req.url === "/redirect") return res.writeHead(302, { location: "/page" }).end();
      if (req.url === "/bin") return res.writeHead(200, { "content-type": "image/png" }).end("PNG");
      if (req.url === "/img.png") return res.writeHead(200, { "content-type": "image/png" }).end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      if (req.url === "/img.svg") return res.writeHead(200, { "content-type": "image/svg+xml" }).end("<svg onload=alert(1)/>");
      if (req.url === "/huge.png") return res.writeHead(200, { "content-type": "image/png", "content-length": String(50_000_000) }).end();
      res.writeHead(404).end("nope");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  it("refuses localhost and private addresses by default", async () => {
    delete process.env.AGENT_ALLOW_PRIVATE_FETCH;
    await assert.rejects(webFetchTool.run({ url: `${base}/page` }, ctx), /private\/local address/);
    await assert.rejects(webFetchTool.run({ url: "http://169.254.169.254/latest/meta-data" }, ctx), /private/);
    await assert.rejects(webFetchTool.run({ url: "file:///etc/passwd" }, ctx), /Only http/);
    const port = new URL(base).port;
    for (const u of [
      `http://[::ffff:127.0.0.1]:${port}/page`, // URL normalises this to [::ffff:7f00:1]
      `http://[0:0:0:0:0:ffff:7f00:1]:${port}/page`,
      `http://[::1]:${port}/page`,
      `http://[64:ff9b::7f00:1]:${port}/page`,
      `http://2130706433:${port}/page`, // decimal 127.0.0.1
      `http://0x7f.1:${port}/page`,
      `http://0.0.0.0:${port}/page`,
      `http://localhost:${port}/page`,
    ])
      await assert.rejects(webFetchTool.run({ url: u }, ctx), /private\/local address/, u);
  });

  it("fetchImage (UI image proxy): raster only, size-capped, same address guard", async () => {
    const signal = new AbortController().signal;
    delete process.env.AGENT_ALLOW_PRIVATE_FETCH;
    await assert.rejects(fetchImage(`${base}/img.png`, signal), /private\/local address/);
    process.env.AGENT_ALLOW_PRIVATE_FETCH = "1";
    try {
      const img = await fetchImage(`${base}/img.png`, signal);
      assert.equal(img.type, "image/png");
      assert.equal(img.body.length, 4);
      await assert.rejects(fetchImage(`${base}/img.svg`, signal), /Not a supported image type: "image\/svg\+xml"/);
      await assert.rejects(fetchImage(`${base}/page`, signal), /Not a supported image type/);
      await assert.rejects(fetchImage(`${base}/huge.png`, signal), /too large/);
      await assert.rejects(fetchImage("javascript:alert(1)", signal), /Only http/);
    } finally {
      delete process.env.AGENT_ALLOW_PRIVATE_FETCH;
    }
  });

  it("fetches, follows redirects, converts, paginates and reports errors", async () => {
    process.env.AGENT_ALLOW_PRIVATE_FETCH = "1";
    try {
      const page = await webFetchTool.run({ url: `${base}/redirect` }, ctx);
      assert.match(page, /Title: Test Page/);
      assert.match(page, /quick brown fox/);

      const first = await webFetchTool.run({ url: `${base}/page`, max_length: 500 }, ctx);
      const next = Number(first.match(/start_index=(\d+)/)![1]);
      assert.equal(next, 500);
      const second = await webFetchTool.run({ url: `${base}/page`, start_index: next, max_length: 500 }, ctx);
      assert.match(second, /Showing characters 500-/);

      assert.match(await webFetchTool.run({ url: `${base}/json` }, ctx), /"a": 1/);
      await assert.rejects(webFetchTool.run({ url: `${base}/missing` }, ctx), /HTTP 404/);
      await assert.rejects(webFetchTool.run({ url: `${base}/bin` }, ctx), /Unsupported content type/);
    } finally {
      delete process.env.AGENT_ALLOW_PRIVATE_FETCH;
    }
  });
});
