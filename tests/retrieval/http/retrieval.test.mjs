import assert from "node:assert/strict";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { startFixtureServer } from "../../fixtures/serve.mjs";
import { RetrievalClient, crawlCompany, localFixturePolicy, requestPinned } from "@jobber/core/retrieval";
import { searchPublicDiscussions } from "@jobber/core/research";

async function fixture(t) {
  const server = await startFixtureServer();
  t.after(() => server.close());
  return { server, options: { policy: localFixturePolicy([server.origin]), minIntervalMs: 0, retries: 0 } };
}

test("public search uses real JSON HTTP transport, robots, and honest partial results", async (t) => {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    if (req.url === "/robots.txt") {
      res.setHeader("content-type", "text/plain");
      res.end("User-agent: *\nAllow: /"); return;
    }
    const url = new URL(req.url, "http://localhost");
    if (url.searchParams.get("query") === "GitLab hiring process") {
      res.statusCode = 503; res.end(); return;
    }
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ hits: [{ objectID: "123", _tags: ["comment"], comment_text: "GitLab technical interview included a coding exercise." }] }));
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(async () => { await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const retrieval = { policy: localFixturePolicy([origin]), minIntervalMs: 0, retries: 0 };
  const result = await searchPublicDiscussions({ company_url: "https://gitlab.com", jd: "Company: GitLab", pages: [] }, { endpoint: origin + "/api/v1/search", retrieval });
  assert.equal(result.status, "partial");
  assert.equal(result.evidence[0].url, "https://news.ycombinator.com/item?id=123");
  assert.equal(result.attempts[1].code, "HTTP_503");
  assert.equal(requests.filter((url) => url === "/robots.txt").length, 1);
  assert.equal(requests.length, 3);
  await assert.rejects(() => new RetrievalClient(retrieval).fetchPage(origin + "/api/v1/search"), { code: "UNSUPPORTED_CONTENT_TYPE" });
});

test("real crawler discovers nested hiring and records successful source URLs", async (t) => {
  const { server, options } = await fixture(t);
  const result = await crawlCompany(server.origin + "/acme/", options);
  assert.ok(result.hiring_pages.includes(server.origin + "/handbook/working-together/selection/"));
  assert.equal(server.requests.filter((p) => p === "/robots.txt").length, 1);
  assert.ok(!server.requests.includes("/careers"));
  assert.ok(result.pages.every((p) => result.trace.some((event) => event.purpose === "page" && event.url === p.url && event.outcome === "fetched")));
  const noHiring = await crawlCompany(server.origin + "/no-hiring/", options);
  assert.deepEqual(noHiring.hiring_pages, []);
  assert.equal(noHiring.pages.length, 2);
});

test("production blocks fixture before network; trusted fixture policy still blocks private redirects", async (t) => {
  const { server, options } = await fixture(t);
  await assert.rejects(() => new RetrievalClient().fetchPage(server.origin + "/acme/"));
  assert.deepEqual(server.requests, []);
  await assert.rejects(() => new RetrievalClient(options).fetchPage(server.origin + "/failures/private-redirect"), { code: "BLOCKED_ADDRESS" });
  assert.ok(!server.requests.includes("/latest/meta-data/"));
});

test("real fetcher enforces robots, content type, byte, timeout, and redirect limits", async (t) => {
  const { server, options } = await fixture(t);
  const client = new RetrievalClient(options);
  for (const [path, code] of [
    ["/blocked/secret/", "ROBOTS_BLOCKED"],
    ["/failures/missing", "HTTP_404"],
    ["/failures/wrong-type", "UNSUPPORTED_CONTENT_TYPE"],
    ["/failures/oversized", "BODY_TOO_LARGE"],
    ["/failures/loop", "REDIRECT_LOOP"],
  ]) await assert.rejects(() => client.fetchPage(server.origin + path), { code });
  assert.ok(!server.requests.includes("/blocked/secret/"));
  assert.equal((await client.fetchPage(server.origin + "/failures/redirect")).url, server.origin + "/acme/");
  await assert.rejects(() => new RetrievalClient({ ...options, timeoutMs: 100 }).fetchPage(server.origin + "/failures/slow"), { code: "TIMEOUT" });
  await assert.rejects(() => new RetrievalClient({ ...options, maxRedirects: 0 }).fetchPage(server.origin + "/failures/redirect"), { code: "TOO_MANY_REDIRECTS" });
});

test("real 429 retry honors retry-after and keeps a trace", async (t) => {
  const { server, options } = await fixture(t);
  const client = new RetrievalClient({ ...options, retries: 1 });
  const start = Date.now();
  const response = await client.fetchPage(server.origin + "/failures/rate-limited");
  assert.equal(response.status, 200);
  assert.ok(Date.now() - start >= 990);
  assert.equal(server.requests.filter((p) => p === "/failures/rate-limited").length, 2);
  assert.ok(client.trace.some((e) => e.outcome === "retry" && e.status === 429));
});

test("socket uses pinned address and original Host; compression, partial-body timeout, and disconnects are bounded", async (t) => {
  const hosts = [];
  const server = createServer((req, res) => {
    hosts.push(req.headers.host);
    res.setHeader("content-type", "text/html");
    if (req.url === "/disconnect") { req.socket.destroy(); return; }
    if (req.url === "/partial") { res.write("<p>waiting"); return; }
    if (req.url === "/bomb") {
      res.setHeader("content-encoding", "gzip"); res.end(gzipSync("x".repeat(10000))); return;
    }
    res.setHeader("content-encoding", "gzip"); res.end(gzipSync("<p>safe text</p>"));
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(async () => {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  });
  // No DNS record exists for this hostname. Transport must connect to the supplied
  // validated address, retaining Host (and TLS server name for HTTPS).
  const origin = `http://does-not-resolve.invalid:${server.address().port}`;
  const fetch = (path, timeout = 1000) => requestPinned(new URL(origin + path), { address: "127.0.0.1", family: 4 }, {
    deadline: Date.now() + timeout, maxBytes: 1000, maxDecodedBytes: 1000, contentTypes: ["text/html"],
  });
  assert.equal((await fetch("/")).text, "<p>safe text</p>");
  assert.equal(hosts[0], new URL(origin).host);
  await assert.rejects(() => fetch("/bomb"), { code: "BODY_TOO_LARGE" });
  await assert.rejects(() => fetch("/partial", 50), { code: "TIMEOUT" });
  await assert.rejects(() => fetch("/disconnect"));
});
