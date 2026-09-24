import assert from "node:assert/strict";
import test from "node:test";
import { searchPublicDiscussions, resolveCompanyIdentity } from "../dist/research/index.js";
import { RetrievalClient } from "../dist/retrieval/index.js";

const input = { company_url: "https://gitlab.com", jd: "Company: GitLab\nPRIVATE_JD_SENTINEL", pages: [] };
const hit = (id, text, extra = {}) => ({ objectID: id, comment_text: text, _tags: ["comment"], author: "candidate", created_at: "2025-01-01T00:00:00Z", ...extra });
const options = { retrieval: { retries: 0, minIntervalMs: 0 } };
function fake(responses) {
  const requests = [];
  let i = 0;
  return { requests, dependencies: {
    resolver: async () => [{ address: "8.8.8.8", family: 4 }],
    transport: async (url, address, config) => {
      requests.push({ url: url.href, config });
      if (url.pathname === "/robots.txt") return { status: 200, headers: {}, text: "User-agent: *\nAllow: /" };
      const response = responses[i++];
      if (!response) throw new Error("script exhausted");
      return { status: 200, headers: { "content-type": "application/json" }, ...response };
    },
  } };
}
const json = (hits) => ({ text: JSON.stringify({ hits }) });

test("identity requires textual evidence, rejects conflicting or fabricated candidates, and never infers from URL alone", () => {
  assert.equal(resolveCompanyIdentity(input).name, "GitLab");
  assert.equal(resolveCompanyIdentity({ ...input, jd: "Engineer wanted" }), null);
  assert.equal(resolveCompanyIdentity({ ...input, candidate: { name: "Made Up", evidence: { source: "jd", quote: "Made Up" } } }), null);
  const page = { url: "https://gitlab.com/about", title: "About GitLab", text: "GitLab builds developer tools" };
  assert.equal(resolveCompanyIdentity({ ...input, jd: "Engineer", pages: [page] }).name, "GitLab");
  assert.equal(resolveCompanyIdentity({ ...input, jd: "Company: Different", pages: [page] }), null);
  assert.equal(resolveCompanyIdentity({ ...input, jd: "Engineer", pages: [{ ...page, url: "https://unrelated.test" }] }), null);
  assert.equal(resolveCompanyIdentity({ ...input, jd: "Company: Apple", company_url: "https://apple.com" }).ambiguous, true);
});

test("unresolved identity skips without network activity", async () => {
  const { requests, dependencies } = fake([]);
  const result = await searchPublicDiscussions({ ...input, jd: "Engineer wanted" }, options, dependencies);
  assert.equal(result.status, "skipped");
  assert.equal(requests.length, 0);
  assert.deepEqual(result.attempts, []);
});

test("outbound search contains only company name and fixed terms, never JD or page text", async () => {
  const { requests, dependencies } = fake([json([]), json([])]);
  const result = await searchPublicDiscussions({ ...input, pages: [{ url: "https://gitlab.com", title: "GitLab", text: "PRIVATE_PAGE_SENTINEL" }] }, options, dependencies);
  assert.equal(result.status, "no_results");
  const apiRequests = requests.filter((r) => new URL(r.url).pathname !== "/robots.txt");
  assert.deepEqual(apiRequests.map((r) => new URL(r.url).searchParams.get("query")), ["GitLab interview", "GitLab hiring process"]);
  for (const r of apiRequests) {
    assert.deepEqual([...new URL(r.url).searchParams.keys()], ["query", "tags", "hitsPerPage"]);
    assert.deepEqual(r.config.contentTypes, ["application/json"]);
  }
  assert.equal(JSON.stringify(requests).includes("PRIVATE_"), false);
});

test("keeps relevant anecdotes with provenance, strips HTML, filters unrelated hits and deduplicates", async () => {
  const good = hit("123", "<p>I interviewed at GitLab and completed a coding exercise.</p><script>malicious()</script>");
  const { dependencies } = fake([json([
    good, hit("124", "OtherCo hiring process included a technical interview."),
    hit("125", "Great discussion!", { story_title: "GitLab interview process" }),
    hit("126", "A journalist interview with GitLab's CEO about quarterly revenue."),
    hit("127", "NotGitLab hiring process interview."),
    hit("invalid-id", "GitLab technical interview."),
  ]), json([good])]);
  const result = await searchPublicDiscussions(input, options, dependencies);
  assert.equal(result.status, "found");
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0].url, "https://news.ycombinator.com/item?id=123");
  assert.equal(result.evidence[0].source_type, "anecdotal");
  assert.equal(result.evidence[0].trust, "untrusted");
  assert.equal(result.evidence[0].excerpt.includes("malicious"), false);
  assert.equal(result.evidence[0].published_at, "2025-01-01T00:00:00.000Z");
  assert.ok(result.trace.some((t) => t.purpose === "api"));
});

test("common names require an exact matching domain, not a lookalike suffix", async () => {
  const { dependencies } = fake([json([
    hit("1", "Apple hiring process technical interview."),
    hit("2", "Apple at apple.com hiring process technical interview."),
    hit("3", "Apple at apple.com.evil.test hiring process technical interview."),
  ]), json([])]);
  const result = await searchPublicDiscussions({ ...input, company_url: "https://apple.com", jd: "Company: Apple" }, options, dependencies);
  assert.deepEqual(result.evidence.map((e) => e.id), ["2"]);
});

test("empty, failed, partial, malformed, and blocked searches remain distinct", async () => {
  for (const [responses, expected] of [
    [[json([]), json([])], "no_results"],
    [[{ status: 503, text: "" }, { status: 503, text: "" }], "failed"],
    [[json([]), { status: 503, text: "" }], "partial"],
    [[{ text: "not JSON" }, { text: '{}' }], "failed"],
    [[json([{ nonsense: true }]), json([{ nonsense: true }])], "failed"],
  ]) {
    const { dependencies } = fake(responses);
    assert.equal((await searchPublicDiscussions(input, options, dependencies)).status, expected);
  }
  const { dependencies } = fake([]);
  const result = await searchPublicDiscussions(input, { retrieval: { policy: { sourceAllowed: () => false }, retries: 0 } }, dependencies);
  assert.equal(result.status, "blocked");
});

test("partial search retains usable evidence and never hides the failed query", async () => {
  const { dependencies } = fake([json([hit("1", "GitLab technical interview questions were practical.")]), { status: 503, text: "" }]);
  const result = await searchPublicDiscussions(input, options, dependencies);
  assert.equal(result.status, "partial");
  assert.equal(result.evidence.length, 1);
  assert.equal(result.attempts[1].outcome, "failed");
});

test("JSON parsing failures are structured and page methods retain their original content types", async () => {
  const { dependencies, requests } = fake([{ text: "broken" }, { text: "<p>page</p>" }]);
  const client = new RetrievalClient(options.retrieval, dependencies);
  await assert.rejects(() => client.fetchJson("https://example.com/api"), { code: "INVALID_JSON" });
  await client.fetchPage("https://example.com/page");
  assert.deepEqual(requests.at(-1).config.contentTypes, ["text/html", "application/xhtml+xml", "text/plain"]);
});

test("search endpoint redirects cannot escape provider origin", async () => {
  const { dependencies, requests } = fake([{ status: 302, headers: { location: "http://169.254.169.254/" }, text: "" }, { status: 302, headers: { location: "https://other.test/" }, text: "" }]);
  const result = await searchPublicDiscussions(input, options, dependencies);
  assert.equal(result.status, "blocked");
  assert.ok(requests.every((r) => new URL(r.url).hostname === "hn.algolia.com"));
});
