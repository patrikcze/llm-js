import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { htmlToMarkdown, webFetchTool } from "../src/tools/web.ts";

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

describe("web_fetch", () => {
  let server: ReturnType<typeof createServer>;
  let base = "";
  before(async () => {
    server = createServer((req, res) => {
      if (req.url === "/page") return res.writeHead(200, { "content-type": "text/html" }).end(ARTICLE);
      if (req.url === "/json") return res.writeHead(200, { "content-type": "application/json" }).end('{"a":1}');
      if (req.url === "/redirect") return res.writeHead(302, { location: "/page" }).end();
      if (req.url === "/bin") return res.writeHead(200, { "content-type": "image/png" }).end("PNG");
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
