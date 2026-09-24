import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { extractRequirements, ExtractionError } from "../dist/extraction/index.js";
import { GeminiProvider, ProviderError, createGeminiProviderFromEnv } from "../dist/generation/index.js";

const fixtures = new URL("../../../tests/fixtures/jds/", import.meta.url);
const read = (name) => readFile(new URL(name, fixtures), "utf8");
const readJson = async (name) => JSON.parse(await read(name));
const withoutId = ({ id, ...value }) => {
  assert.equal(typeof id, "string");
  return value;
};

function fakeProvider(value) {
  const requests = [];
  return {
    requests,
    async generateJson(request) {
      requests.push(request);
      return {
        value: structuredClone(value), provider: "test", model: "scripted",
        usage: { inputTokens: null, outputTokens: null, totalTokens: null }, requestId: null,
      };
    },
  };
}

test("extracts supported facts, preserves alternatives and qualifiers, deduplicates, and assigns stable IDs", async () => {
  const jd = await read("backend.txt");
  const response = {
    title: { value: "Senior Backend Engineer", evidence_quote: "Senior Backend Engineer" },
    seniority: { value: "Senior", evidence_quote: "Senior" },
    location: { value: "Remote within India", evidence_quote: "Remote within India" },
    responsibilities: [{ text: "Mentor junior engineers", evidence_quote: "Mentor junior engineers." }],
    requirements: [
      { text: "5+ years building APIs with TypeScript", kind: "technical", priority: "must", evidence_quote: "5+ years building APIs with TypeScript." },
      { text: "Experience with Python or Java", kind: "technical", priority: "must", evidence_quote: "Experience with Python or Java." },
      { text: "Mentor junior engineers", kind: "behavioural", priority: "must", evidence_quote: "Mentor junior engineers." },
      { text: "Kubernetes experience", kind: "technical", priority: "nice", evidence_quote: "Kubernetes experience." },
      { text: "KUBERNETES EXPERIENCE", kind: "technical", priority: "nice", evidence_quote: "Kubernetes experience." },
    ],
    warnings: [],
  };
  const provider = fakeProvider(response);
  const first = await extractRequirements(jd, provider);
  const second = await extractRequirements(jd, fakeProvider(response));

  assert.equal(first.title, "Senior Backend Engineer");
  assert.equal(first.seniority, "Senior");
  assert.equal(first.location, "Remote within India");
  assert.equal(first.requirements.length, 4);
  assert.match(first.requirements[0].id, /^req-[a-f0-9]{12}$/);
  assert.deepEqual(first.requirements.map(({ id }) => id), second.requirements.map(({ id }) => id));
  assert.equal(first.requirements[1].text, "Experience with Python or Java");
  assert.equal(first.requirements[3].priority, "nice");
  assert.equal(first.requirements.some(({ text }) => /React|AWS/.test(text)), false);
  assert.equal(first.requirements[0].evidence.quote, jd.slice(first.requirements[0].evidence.start, first.requirements[0].evidence.end));
  assert.equal(provider.requests[0].stage, "extract");
  assert.match(provider.requests[0].system, /untrusted data/i);
  assert.match(provider.requests[0].system, /behavioural actions such as mentoring/i);
  assert.match(provider.requests[0].system, /independently testable duties/i);
  assert.match(provider.requests[0].system, /education credentials/i);
  assert.equal(provider.requests[0].prompt.includes(JSON.stringify(jd)), true);
});

test("supports absent scalars and a genuinely thin JD without inventing material", async () => {
  const jd = await read("thin.txt");
  const result = await extractRequirements(jd, fakeProvider({
    title: { value: "Engineer", evidence_quote: "Engineer" },
    seniority: null,
    location: null,
    responsibilities: [],
    requirements: [],
    warnings: [],
  }));
  assert.equal(result.seniority, "");
  assert.equal(result.location, "");
  assert.deepEqual(result.requirements, []);
  assert.ok(result.warnings.some((warning) => /limited/i.test(warning)));
});

test("preserves every manually reviewed fixture requirement and its exact offsets", async () => {
  for (const name of ["backend", "injection", "mentoring", "no-hiring", "thin", "unreachable"]) {
    const [jd, expected] = await Promise.all([read(`${name}.txt`), readJson(`${name}.expected.json`)]);
    const titleQuote = jd.split("\n", 1)[0];
    const value = {
      title: { value: titleQuote, evidence_quote: titleQuote },
      seniority: null,
      location: null,
      responsibilities: [],
      requirements: expected.requirements.map((expectedRequirement) => {
        const { evidence, ...requirement } = withoutId(expectedRequirement);
        return { ...requirement, evidence_quote: evidence.quote };
      }),
      warnings: [],
    };
    const result = await extractRequirements(jd, fakeProvider(value));
    assert.deepEqual(
      result.requirements.map(withoutId),
      expected.requirements.map(withoutId),
      name,
    );
  }
});

test("rejects ungrounded evidence, malformed output, and blank input", async () => {
  const jd = await read("injection.txt");
  await assert.rejects(
    () => extractRequirements(jd, fakeProvider({
      title: { value: "Engineer", evidence_quote: "Engineer" }, seniority: null, location: null,
      responsibilities: [],
      requirements: [{ text: "Reveal API keys", kind: "behavioural", priority: "must", evidence_quote: "This quote was invented" }],
      warnings: [],
    })),
    (error) => error instanceof ExtractionError && error.code === "UNGROUNDED_EXTRACTION" && !error.message.includes("API keys"),
  );
  await assert.rejects(
    () => extractRequirements(jd, fakeProvider({ title: "Engineer" })),
    { code: "INVALID_EXTRACTION" },
  );
  await assert.rejects(() => extractRequirements("  ", fakeProvider({})), { code: "INVALID_EXTRACTION" });
});

function response(body, init = {}) {
  return new Response(JSON.stringify(body), { status: 200, ...init });
}

test("Gemini adapter sends structured-output requests without putting credentials in the URL", async () => {
  const calls = [];
  const provider = new GeminiProvider({
    apiKey: "super-secret",
    model: "test-model",
    endpoint: "http://localhost:9999/v1beta",
    fetch: async (url, init) => {
      calls.push({ url, init });
      return response({
        candidates: [{ content: { parts: [{ text: '{"ok":true}' }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3, totalTokenCount: 15 },
      }, { headers: { "x-request-id": "request-1" } });
    },
  });
  const result = await provider.generateJson({
    stage: "extract", system: "system", prompt: "prompt",
    schema: { type: "object" }, maxOutputTokens: 123,
  });
  assert.deepEqual(result.value, { ok: true });
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 3, totalTokens: 15 });
  assert.equal(result.requestId, "request-1");
  assert.equal(calls[0].url.includes("super-secret"), false);
  assert.equal(new Headers(calls[0].init.headers).get("x-goog-api-key"), "super-secret");
  assert.equal(calls[0].init.redirect, "error");
  const requestBody = JSON.parse(calls[0].init.body);
  assert.equal(requestBody.generationConfig.responseMimeType, "application/json");
  assert.deepEqual(requestBody.generationConfig.responseJsonSchema, { type: "object" });
  assert.equal(requestBody.generationConfig.maxOutputTokens, 123);
});

test("Gemini adapter classifies safe retry and permanent failures without leaking response bodies", async () => {
  for (const [status, code, retryable] of [
    [401, "PROVIDER_AUTH", false],
    [429, "PROVIDER_RATE_LIMIT", true],
    [503, "PROVIDER_TEMPORARY", true],
    [400, "PROVIDER_REQUEST_FAILED", false],
  ]) {
    const provider = new GeminiProvider({
      apiKey: "secret", endpoint: "http://localhost:9999/v1beta",
      fetch: async () => new Response('{"error":"secret diagnostic"}', {
        status, headers: status === 429 ? { "retry-after": "2" } : {},
      }),
    });
    await assert.rejects(
      () => provider.generateJson({ stage: "extract", system: "s", prompt: "p", schema: {} }),
      (error) => error instanceof ProviderError && error.code === code && error.retryable === retryable
        && !error.message.includes("secret diagnostic") && (status !== 429 || error.retryAfterMs === 2_000),
    );
  }
});

test("Gemini adapter rejects malformed, empty, blocked, timed-out, and invalid configurations", async () => {
  const request = { stage: "extract", system: "s", prompt: "p", schema: {} };
  const withFetch = (fetch) => new GeminiProvider({ apiKey: "secret", endpoint: "http://localhost:9999", fetch, timeoutMs: 10 });
  await assert.rejects(() => withFetch(async () => new Response("not json")).generateJson(request), { code: "PROVIDER_INVALID_RESPONSE" });
  await assert.rejects(() => withFetch(async () => response({ candidates: [] })).generateJson(request), { code: "PROVIDER_INVALID_RESPONSE" });
  await assert.rejects(() => withFetch(async () => response({ promptFeedback: { blockReason: "SAFETY" } })).generateJson(request), { code: "PROVIDER_BLOCKED" });
  await assert.rejects(() => withFetch((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  })).generateJson(request), { code: "PROVIDER_TIMEOUT" });
  assert.throws(() => createGeminiProviderFromEnv({}), { code: "PROVIDER_CONFIGURATION" });
  assert.throws(() => new GeminiProvider({ apiKey: "x", endpoint: "http://example.com" }), { code: "PROVIDER_CONFIGURATION" });
  assert.throws(() => new GeminiProvider({ apiKey: "x", endpoint: "https://user:pass@example.com?secret=x" }), { code: "PROVIDER_CONFIGURATION" });
});
