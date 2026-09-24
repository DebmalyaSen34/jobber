import assert from "node:assert/strict";
import test from "node:test";
import {
  ProviderError,
  ProviderGate,
  ReliableJsonProvider,
} from "../dist/generation/index.js";
import { generateKitWithDependencies } from "../dist/index.js";
import { validateKit } from "../dist/index.js";

const usage = { inputTokens: 4, outputTokens: 6, totalTokens: 10 };
const success = (value) => ({ value, provider: "fake", model: "fake-model", usage, requestId: null });

test("reliable provider retries transient and schema-invalid responses with bounded accounting", async () => {
  let calls = 0;
  let now = 1_000;
  const base = { async generateJson() {
    calls += 1;
    if (calls === 1) throw new ProviderError("PROVIDER_RATE_LIMIT", "limited", true, 20);
    if (calls === 2) return success({ wrong: true });
    return success({ ok: true });
  } };
  const provider = new ReliableJsonProvider(base, {
    deadline: 10_000,
    retries: 2,
    baseDelayMs: 10,
    maxRetryDelayMs: 100,
    gate: new ProviderGate({ minIntervalMs: 0, now: () => now, sleep: async (ms) => { now += ms; } }),
    now: () => now,
    sleep: async (ms) => { now += ms; },
    random: () => 0,
  });
  const result = await provider.generateJson({
    stage: "extract", system: "s", prompt: "p", schema: {},
    validate: (value) => value?.ok === true ? { success: true } : { success: false, feedback: "ok must be true" },
  });
  assert.deepEqual(result.value, { ok: true });
  assert.equal(result.attempts, 3);
  assert.deepEqual(result.retryCodes, ["PROVIDER_RATE_LIMIT", "PROVIDER_SCHEMA_INVALID"]);
  assert.deepEqual(provider.snapshot, {
    requests: 3, tokens: 20, retries: 2, deadline: "1970-01-01T00:00:10.000Z",
  });
  assert.equal(now, 1_040);
});

test("reliable provider does not retry permanent failures and enforces request, token, and deadline budgets", async () => {
  let calls = 0;
  const auth = new ReliableJsonProvider({ async generateJson() {
    calls += 1;
    throw new ProviderError("PROVIDER_AUTH", "bad credentials", false);
  } }, { deadline: Date.now() + 1_000, retries: 2, gate: new ProviderGate({ minIntervalMs: 0 }) });
  await assert.rejects(() => auth.generateJson({ stage: "extract", system: "s", prompt: "p", schema: {} }), { code: "PROVIDER_AUTH" });
  assert.equal(calls, 1);

  const one = new ReliableJsonProvider({ async generateJson() { return success({ ok: true }); } }, {
    deadline: Date.now() + 1_000, maxRequests: 1, maxTokens: 1_000, gate: new ProviderGate({ minIntervalMs: 0 }),
  });
  const callerRequest = { stage: "extract", system: "s", prompt: "p", schema: {}, maxOutputTokens: 5_000 };
  await one.generateJson(callerRequest);
  assert.equal(callerRequest.maxOutputTokens, 5_000);
  await assert.rejects(() => one.generateJson({ stage: "extract", system: "s", prompt: "p", schema: {} }), /request budget/i);

  const tokens = new ReliableJsonProvider({ async generateJson() { return success({ ok: true }); } }, {
    deadline: Date.now() + 1_000, maxTokens: 65, gate: new ProviderGate({ minIntervalMs: 0 }),
  });
  await assert.rejects(() => tokens.generateJson({ stage: "extract", system: "long system", prompt: "long prompt", schema: {} }), /token budget/i);

  const deadline = new ReliableJsonProvider({ async generateJson() { return new Promise(() => {}); } }, {
    deadline: Date.now() + 10, gate: new ProviderGate({ minIntervalMs: 0 }),
  });
  await assert.rejects(() => deadline.generateJson({ stage: "extract", system: "s", prompt: "p", schema: {} }), { code: "PROVIDER_TIMEOUT" });
});

function fullProvider() {
  const requests = [];
  return {
    requests,
    async generateJson(request) {
      requests.push(structuredClone({ stage: request.stage, prompt: request.prompt }));
      if (request.stage === "extract") return success({
        title: { value: "Senior Backend Engineer", evidence_quote: "Senior Backend Engineer" },
        seniority: { value: "Senior", evidence_quote: "Senior" },
        location: null,
        responsibilities: [],
        requirements: [
          { text: "TypeScript APIs", kind: "technical", priority: "must", evidence_quote: "TypeScript APIs" },
          { text: "Kubernetes", kind: "technical", priority: "nice", evidence_quote: "Kubernetes" },
        ],
        warnings: [],
      });
      if (request.stage === "company-brief") return success({
        summary: "Acme builds inventory software.",
        what_they_do: "Inventory APIs.",
        sources: ["https://acme.test/about"],
        hiring_context: "Officially uses a take-home exercise; one anecdotal discussion mentions an interview.",
        hiring_sources: ["https://acme.test/hiring", "https://news.ycombinator.com/item?id=1"],
      });
      if (["technical", "system-design", "company-fit"].includes(request.stage)) {
        const body = JSON.parse(request.prompt);
        if (request.stage !== "technical") return success({ questions: [] });
        return success({ questions: body.requirements.map((requirement) => ({
          requirement_ids: [requirement.id],
          prompt: `Explain ${requirement.text}`,
          answer_outline: "Use a concrete example, trade-offs, and validation.",
          difficulty: requirement.priority === "must" ? 3 : 2,
        })) });
      }
      if (request.stage === "flashcards") {
        const body = JSON.parse(request.prompt);
        return success({ flashcards: body.requirements.map((requirement) => ({
          front: `Recall ${requirement.text}`,
          back: `Key points for ${requirement.text}`,
          requirement_ids: [requirement.id],
        })) });
      }
      throw new Error(`Unexpected stage ${request.stage}`);
    },
  };
}

const crawlResult = {
  pages: [
    { url: "https://acme.test/about", title: "Acme | About", text: "Acme builds inventory APIs.", kind: "company", links: [], truncated: false, trust: "untrusted" },
    { url: "https://acme.test/hiring", title: "Hiring at Acme", text: "Candidates complete a take-home exercise.", kind: "hiring", links: [], truncated: false, trust: "untrusted" },
  ],
  hiring_pages: ["https://acme.test/hiring"],
  trace: [], warnings: [], researched_at: "2026-09-24T12:00:00.000Z",
};

const discussionResult = {
  provider: "hacker-news-algolia",
  scope: "test",
  identity: { name: "Acme", domain: "acme.test", evidence: { source: "jd", quote: "Company: Acme" }, ambiguous: false },
  attempts: [],
  evidence: [{
    id: "1", url: "https://news.ycombinator.com/item?id=1", title: "Acme interview",
    excerpt: "I interviewed at Acme.", author: "candidate", published_at: null,
    retrieved_at: "2026-09-24T12:00:00.000Z", query: "Acme interview",
    source_type: "anecdotal", trust: "untrusted", provider: "hacker-news-algolia",
  }],
  warnings: [], trace: [], searched_at: "2026-09-24T12:00:00.000Z", status: "found",
};

test("full injected pipeline assembles, schedules, traces, and validates a researched kit", async () => {
  const provider = fullProvider();
  const progress = [];
  const input = {
    id: "case-1",
    jd: "Company: Acme\nSenior Backend Engineer\nRequired: TypeScript APIs.\nPreferred: Kubernetes.",
    company_url: "https://acme.test",
    days: 5,
  };
  const kit = await generateKitWithDependencies(input, {
    provider,
    providerGate: new ProviderGate({ minIntervalMs: 0 }),
    crawl: async () => structuredClone(crawlResult),
    searchDiscussions: async () => structuredClone(discussionResult),
  }, { providerBaseDelayMs: 0 }, (event) => progress.push(event));

  assert.equal(validateKit(kit, { requestedDays: 5 }).success, true);
  assert.equal(kit.source.company, "Acme");
  assert.deepEqual(kit.source.pages_used, ["https://acme.test/about", "https://acme.test/hiring"]);
  assert.equal(kit.role.requirements.length, 2);
  assert.equal(kit.coverage.passes, 1);
  assert.deepEqual(kit.coverage.uncovered_requirement_ids, []);
  assert.equal(kit.schedule.days.length, 5);
  assert.equal(kit.flashcards.length, 2);
  assert.deepEqual(provider.requests.map(({ stage }) => stage), [
    "extract", "company-brief", "technical", "system-design", "company-fit", "flashcards",
  ]);
  assert.deepEqual(progress.map(({ stage }) => stage), [
    "researching", "extracting", "synthesizing", "generating", "checking_coverage", "flashcards", "scheduling", "validating",
  ]);
  assert.equal(kit.generation.provider_budget.requests, 6);
  assert.equal(kit.generation.provider_budget.tokens, 60);
  assert.deepEqual(kit.generation.provider_calls.map(({ stage }) => stage), provider.requests.map(({ stage }) => stage));
  assert.ok(kit.company_brief.hiring_context.includes("anecdotal"));
});

test("thin input and failed research produce an honest valid kit without unnecessary generation calls", async () => {
  const provider = { requests: [], async generateJson(request) {
    this.requests.push(request.stage);
    return success({
      title: { value: "Engineer", evidence_quote: "Engineer" }, seniority: null, location: null,
      responsibilities: [], requirements: [], warnings: [],
    });
  } };
  const kit = await generateKitWithDependencies({
    id: "thin", jd: "Engineer wanted.\nContact us for details.", company_url: "not a URL", days: 60,
  }, {
    provider,
    providerGate: new ProviderGate({ minIntervalMs: 0 }),
    crawl: async () => { throw new Error("offline"); },
    searchDiscussions: async () => { throw new Error("offline"); },
  });
  assert.deepEqual(provider.requests, ["extract"]);
  assert.equal(kit.role.requirements.length, 0);
  assert.equal(kit.questions.length, 0);
  assert.equal(kit.flashcards.length, 0);
  assert.equal(kit.coverage.passes, 0);
  assert.equal(kit.schedule.days.length, 60);
  assert.ok(kit.warnings.some(({ code }) => code === "RESEARCH_FAILED"));
  assert.equal(validateKit(kit, { requestedDays: 60 }).success, true);
});
