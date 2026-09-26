import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { RetrievalClient, validateDestination, localFixturePolicy, cleanPage, crawlCompany, decodeBody, retryDelay, safeTraceUrl } from "../dist/retrieval/index.js";
import { createFixtureSite } from "../../../tests/fixtures/helpers/site.mjs";

const publicResolver = async () => [{ address: "8.8.8.8", family: 4 }];
const noWait = { minIntervalMs: 0, retries: 0 };
async function fakeSite() {
  const site = await createFixtureSite();
  return {
    site,
    dependencies: { resolver: publicResolver, transport: async (url) => {
      const response = site.respond(url.href);
      return { status: response.status, headers: response.headers, text: response.body };
    } },
  };
}

test("production rejects nonpublic IPv4, IPv6, alternate IP spellings, schemes, and credentials", async () => {
  const blocked = ["127.0.0.1", "2130706433", "0x7f000001", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "192.0.2.1", "224.0.0.1", "[::1]", "[::]", "[fc00::1]", "[fe80::1]", "[::ffff:127.0.0.1]"];
  for (const host of blocked) await assert.rejects(() => validateDestination(`http://${host}/`), { code: "BLOCKED_ADDRESS" });
  for (const url of ["file:///etc/passwd", "https://user:password@example.com/", "not a url"]) {
    await assert.rejects(() => validateDestination(url), { code: "INVALID_URL" });
  }
  await assert.rejects(() => validateDestination("https://example.com:9000/", {}, publicResolver), { code: "BLOCKED_PORT" });
});

test("DNS validation rejects mixed public/private answers and pins a validated address", async () => {
  await assert.rejects(() => validateDestination("https://example.com", {}, async () => [
    { address: "8.8.8.8", family: 4 }, { address: "::1", family: 6 },
  ]), { code: "BLOCKED_ADDRESS" });
  const result = await validateDestination("https://example.com/#section", {}, publicResolver);
  assert.equal(result.address.address, "8.8.8.8");
  assert.equal(result.url.hash, "");
  await assert.rejects(() => validateDestination("https://example.com", {}, async () => []), { code: "BLOCKED_ADDRESS" });
});

test("trusted local exception is exact-origin, loopback-only, and cannot enable metadata addresses", async () => {
  const policy = localFixturePolicy(["http://127.0.0.1:8099"]);
  assert.equal((await validateDestination("http://127.0.0.1:8099/acme/", policy)).address.address, "127.0.0.1");
  await assert.rejects(() => validateDestination("http://127.0.0.1:8100/", policy));
  await assert.rejects(() => validateDestination("http://169.254.169.254/", policy), { code: "BLOCKED_ADDRESS" });
  assert.throws(() => localFixturePolicy(["http://10.0.0.1"]), { code: "INVALID_POLICY" });
  await assert.rejects(() => validateDestination("http://localhost:8099/", localFixturePolicy(["http://localhost:8099"]), publicResolver), { code: "BLOCKED_ADDRESS" });
});

test("configured source restrictions run before DNS; trace URL redacts credentials and queries", async () => {
  await assert.rejects(() => validateDestination("https://example.com", { sourceAllowed: () => false }, () => { throw Error("must not resolve"); }), { code: "SOURCE_POLICY_BLOCKED" });
  assert.equal(safeTraceUrl("https://u:secret@example.com/path?token=secret#x"), "https://example.com/path");
  assert.equal(safeTraceUrl("invalid secret"), "[invalid URL]");
});

test("HTML cleaning removes executable/hidden/navigation content and ranks discovered links", () => {
  const page = cleanPage(`<title>Acme</title><base href="http://attacker.test/"><nav>menu</nav><script>SECRET_SCRIPT</script><style>SECRET_STYLE</style><div hidden>SECRET_HIDDEN</div><h1>About us</h1><p>We build inventory tools.</p><a href="./people/?utm_source=x#top">Our hiring team</a><a href="/privacy">Privacy</a><a href="javascript:alert(1)">bad</a><a rel="nofollow" href="/ignore">Skip</a>`, "https://acme.test/company/");
  assert.ok(!page.text.includes("SECRET"));
  assert.ok(!page.text.includes("menu"));
  assert.equal(page.links[0].url, "https://acme.test/company/people/");
  assert.ok(page.links[0].score > page.links[1].score);
  assert.equal(page.links.length, 2);
  assert.equal(page.trust, "untrusted");
  assert.equal(cleanPage('<meta name="robots" content="nofollow"><a href="/hiring">Hiring</a>', "https://acme.test").links.length, 0);
  assert.equal(cleanPage("<p>abcdefgh</p>", "https://acme.test", 4).truncated, true);
});

test("compressed bodies have decoded-size limits, including compression bombs", () => {
  assert.equal(decodeBody(gzipSync("hello"), "gzip", 100), "hello");
  assert.throws(() => decodeBody(gzipSync("x".repeat(100000)), "gzip", 100), { code: "BODY_TOO_LARGE" });
  assert.throws(() => decodeBody(Buffer.from("garbage"), "gzip", 100), { code: "INVALID_ENCODING" });
  assert.throws(() => decodeBody(Buffer.from("abc"), "weird", 100), { code: "UNSUPPORTED_ENCODING" });
});

test("crawl discovers unexpected nested hiring page through relative links", async () => {
  const { site, dependencies } = await fakeSite();
  const result = await crawlCompany("https://acme.test/acme/", noWait, dependencies);
  assert.ok(result.hiring_pages.includes("https://acme.test/handbook/working-together/selection/"));
  assert.ok(result.pages.some((page) => page.text.includes("take-home API exercise")));
  assert.equal(site.requests.filter((path) => path === "/robots.txt").length, 1);
  assert.ok(!site.requests.includes("/careers"));
  assert.ok(result.trace.every((trace) => !Number.isNaN(Date.parse(trace.at))));
});

test("no-hiring and unreachable sources are honest nonfatal results", async () => {
  const { dependencies } = await fakeSite();
  const missingHiring = await crawlCompany("https://acme.test/no-hiring/", noWait, dependencies);
  assert.equal(missingHiring.pages.length, 2);
  assert.deepEqual(missingHiring.hiring_pages, []);
  assert.ok(missingHiring.warnings.some((w) => w.code === "NO_HIRING_PAGE"));
  const missing = await crawlCompany("https://acme.test/failures/missing", noWait, dependencies);
  assert.equal(missing.pages.length, 0);
  assert.ok(missing.warnings.some((w) => w.code === "HTTP_404"));
  const invalid = await crawlCompany("invalid", noWait, dependencies);
  assert.ok(invalid.warnings.some((w) => w.code === "INVALID_URL"));
});

test("robots blocks a page before its transport request; failed robots is conservative", async () => {
  const { site, dependencies } = await fakeSite();
  const client = new RetrievalClient(noWait, dependencies);
  await assert.rejects(() => client.fetchPage("https://acme.test/blocked/secret/"), { code: "ROBOTS_BLOCKED" });
  assert.ok(!site.requests.includes("/blocked/secret/"));
  const requested = [];
  const denied = new RetrievalClient(noWait, { resolver: publicResolver, transport: async (url) => {
    requested.push(url.pathname); return { status: 503, headers: {}, text: "" };
  } });
  await assert.rejects(() => denied.fetchPage("https://acme.test/"), { code: "ROBOTS_UNAVAILABLE" });
  assert.deepEqual(requested, ["/robots.txt"]);
});

test("redirect destinations are revalidated, robots checked, and loops bounded", async () => {
  const { site, dependencies } = await fakeSite();
  const client = new RetrievalClient(noWait, dependencies);
  await assert.rejects(() => client.fetchPage("https://acme.test/failures/private-redirect"), { code: "BLOCKED_ADDRESS" });
  assert.ok(!site.requests.includes("/latest/meta-data/"));
  await assert.rejects(() => client.fetchPage("https://acme.test/failures/loop"), { code: "REDIRECT_LOOP" });
  assert.equal((await client.fetchPage("https://acme.test/failures/redirect")).url, "https://acme.test/acme/");
  const requests = [];
  const blocked = new RetrievalClient(noWait, { resolver: publicResolver, transport: async (url) => {
    requests.push(url.pathname);
    if (url.pathname === "/robots.txt") return { status: 200, headers: {}, text: "User-agent: *\nDisallow: /private" };
    return { status: 302, headers: { location: "/private" }, text: "" };
  } });
  await assert.rejects(() => blocked.fetchPage("https://acme.test/go"), { code: "ROBOTS_BLOCKED" });
  assert.deepEqual(requests, ["/robots.txt", "/go"]);
});

test("429 retries are bounded and observable; 404 does not retry", async () => {
  let calls = 0;
  const client = new RetrievalClient({ ...noWait, retries: 1 }, { resolver: publicResolver, transport: async (url) => {
    if (url.pathname === "/robots.txt") return { status: 404, headers: {}, text: "" };
    calls++;
    return { status: calls === 1 ? 429 : 200, headers: { "retry-after": "0" }, text: "ok" };
  } });
  assert.equal((await client.fetchPage("https://acme.test/")).text, "ok");
  assert.equal(calls, 2);
  assert.ok(client.trace.some((trace) => trace.outcome === "retry" && trace.status === 429));
  const { site, dependencies } = await fakeSite();
  await assert.rejects(() => new RetrievalClient({ retries: 2, minIntervalMs: 0 }, dependencies).fetchPage("https://acme.test/failures/missing"));
  assert.equal(site.requests.filter((p) => p === "/failures/missing").length, 1);
  assert.equal(retryDelay("2", 0), 2000);
  assert.equal(retryDelay("Thu, 24 Sep 2026 00:00:01 GMT", 0, Date.parse("2026-09-24T00:00:00Z")), 1000);
});

test("request and time budgets stop work, including never-resolving DNS", async () => {
  const { dependencies } = await fakeSite();
  const limited = new RetrievalClient({ ...noWait, maxRequests: 1 }, dependencies);
  await assert.rejects(() => limited.fetchPage("https://acme.test/acme/"), { code: "BUDGET_EXHAUSTED" });
  const stuck = new RetrievalClient({ ...noWait, timeoutMs: 20 }, { resolver: () => new Promise(() => {}) });
  await assert.rejects(() => stuck.fetchPage("https://acme.test/"), { code: "TIMEOUT" });
  const crawl = await crawlCompany("https://acme.test/acme/", { ...noWait, maxPages: 1 }, dependencies);
  assert.equal(crawl.pages.length, 1);
  assert.ok(crawl.warnings.some((w) => w.code === "CRAWL_LIMIT_REACHED" && w.message.includes("highest-priority pages")));
});

test("concurrent fetches on one client are paced and robots crawl-delay is respected", async () => {
  const starts = [];
  const client = new RetrievalClient({ ...noWait, minIntervalMs: 10 }, { resolver: publicResolver, transport: async (url) => {
    starts.push(Date.now());
    return { status: 200, headers: {}, text: url.pathname === "/robots.txt" ? "User-agent: *\nCrawl-delay: 0.03" : "ok" };
  } });
  await Promise.all([client.fetchPage("https://acme.test/a"), client.fetchPage("https://acme.test/b")]);
  assert.equal(starts.length, 3);
  assert.ok(starts[1] - starts[0] >= 25);
  assert.ok(starts[2] - starts[1] >= 25);
});

test("discovered external hiring links are ranked and traced; unrelated external links are not followed", async () => {
  const visited = [];
  const result = await crawlCompany("https://company.test/", noWait, { resolver: publicResolver, transport: async (url) => {
    visited.push(url.href);
    if (url.pathname === "/robots.txt") return { status: 404, headers: {}, text: "" };
    if (url.hostname === "company.test") return { status: 200, headers: { "content-type": "text/html" }, text: '<h1>Company</h1><a href="https://handbook.test/hiring">Hiring process</a><a href="https://social.test/feed">News</a>' };
    return { status: 200, headers: { "content-type": "text/plain" }, text: "Hiring process: a take-home assessment followed by an interview." };
  } });
  assert.deepEqual(result.hiring_pages, ["https://handbook.test/hiring"]);
  assert.equal(result.pages[1].discovered_from, "https://company.test/");
  assert.ok(!visited.some((url) => url.includes("social.test")));
});

test("robots failures and excessive retry-after do not consume an unbounded time budget", async () => {
  for (const status of [401, 403]) {
    const client = new RetrievalClient(noWait, { resolver: publicResolver, transport: async () => ({ status, headers: {}, text: "" }) });
    await assert.rejects(() => client.fetchPage("https://company.test/"), { code: "ROBOTS_BLOCKED" });
  }
  const client = new RetrievalClient({ ...noWait, retries: 1, budgetMs: 1000 }, { resolver: publicResolver, transport: async (url) =>
    url.pathname === "/robots.txt" ? { status: 404, headers: {}, text: "" } : { status: 429, headers: { "retry-after": "3600" }, text: "" },
  });
  await assert.rejects(() => client.fetchPage("https://company.test/"), { code: "BUDGET_EXHAUSTED" });
});

test("DNS changes between validation and request cannot bypass the address policy", async () => {
  let calls = 0;
  let transports = 0;
  const client = new RetrievalClient(noWait, {
    resolver: async () => [{ address: ++calls === 1 ? "8.8.8.8" : "127.0.0.1", family: 4 }],
    transport: async () => { transports++; return { status: 200, headers: {}, text: "" }; },
  });
  await assert.rejects(() => client.fetchPage("https://company.test/"), { code: "BLOCKED_ADDRESS" });
  assert.equal(transports, 0);
});

test("well-known NAT64 accepts public IPv4 only and retains the pinned IPv6 address", async () => {
  for (const address of ["64:ff9b::22a0:a8b5", "0064:ff9b:0000:0000:0000:0000:0808:0808", "64:ff9b::8.8.8.8"]) {
    const result = await validateDestination("https://example.com", {}, async () => [{ address, family: 6 }, { address: "8.8.8.8", family: 4 }]);
    assert.deepEqual(result.address, { address, family: 6 });
    await validateDestination(`https://[${address}]/`);
  }
});

test("NAT64 cannot hide restricted IPv4, mixed DNS answers, or bypass fixture policy", async () => {
  for (const ipv4 of ["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "192.0.2.1", "198.18.0.1", "224.0.0.1", "255.255.255.255"]) {
    const address = `64:ff9b::${ipv4}`;
    await assert.rejects(() => validateDestination(`http://[${address}]/`), { code: "BLOCKED_ADDRESS" });
    await assert.rejects(() => validateDestination("https://example.com", {}, async () => [{ address: "8.8.8.8", family: 4 }, { address, family: 6 }]), { code: "BLOCKED_ADDRESS" });
  }
  assert.throws(() => localFixturePolicy(["http://[64:ff9b::127.0.0.1]"]), { code: "INVALID_POLICY" });
  await assert.rejects(() => validateDestination("http://localhost:8099", localFixturePolicy(["http://localhost:8099"]), async () => [{ address: "64:ff9b::127.0.0.1", family: 6 }]), { code: "BLOCKED_ADDRESS" });
  for (const address of ["64:ff9b:1::808:808", "2002:0808:0808::1", "::808:808"]) {
    await assert.rejects(() => validateDestination(`https://[${address}]/`), { code: "BLOCKED_ADDRESS" });
  }
});

test("NAT64 metadata redirects are rejected before their robots or content is fetched", async () => {
  const requests = [];
  const client = new RetrievalClient(noWait, {
    resolver: publicResolver,
    transport: async (url) => {
      requests.push(url.href);
      if (url.pathname === "/robots.txt") return { status: 200, headers: {}, text: "User-agent: *\nAllow: /" };
      return { status: 302, headers: { location: "http://[64:ff9b::a9fe:a9fe]/latest/meta-data/" }, text: "" };
    },
  });
  await assert.rejects(() => client.fetchPage("https://example.com/"), { code: "BLOCKED_ADDRESS" });
  assert.ok(requests.every((url) => new URL(url).hostname === "example.com"));
});
