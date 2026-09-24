import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  generateFlashcards,
  generateQuestionsWithCoverage,
  GenerationContentError,
  routeRequirements,
} from "../dist/generation/index.js";

const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

function fakeProvider(responder) {
  const requests = [];
  return {
    requests,
    async generateJson(request) {
      const serializable = Object.fromEntries(
        Object.entries(request).filter(([key]) => key !== "validate"),
      );
      requests.push(structuredClone(serializable));
      return {
        value: structuredClone(await responder(request, requests.length - 1)),
        provider: "test-provider",
        model: "test-model",
        usage,
        requestId: `request-${requests.length}`,
      };
    },
  };
}

const requirements = [
  { id: "r-tech", text: "Design reliable TypeScript APIs", kind: "technical", priority: "must" },
  { id: "r-beh", text: "Mentor junior engineers", kind: "behavioural", priority: "must" },
  { id: "r-domain", text: "Healthcare experience", kind: "domain", priority: "nice" },
];

function question(requirementId, label) {
  return {
    requirement_ids: [requirementId],
    prompt: `${label} prompt`,
    answer_outline: `${label} outline with trade-offs and validation`,
    difficulty: 2,
  };
}

test("routes relevant requirements and makes distinct evidence-aware category calls", async () => {
  const context = {
    roleTitle: "Platform Engineer",
    companyBrief: { summary: "Acme builds inventory tools.", whatTheyDo: "Warehouse software.", sources: ["https://acme.test/about"] },
    hiringEvidence: [{ source: "official hiring page", excerpt: "Candidates complete a take-home API exercise.", url: "https://acme.test/hiring" }],
  };
  const routed = routeRequirements(requirements, context);
  assert.deepEqual(routed.technical.map(({ id }) => id), ["r-tech"]);
  assert.deepEqual(routed.behavioural.map(({ id }) => id), ["r-beh"]);
  assert.deepEqual(routed["system-design"].map(({ id }) => id), ["r-tech"]);
  assert.deepEqual(routed["company-fit"].map(({ id }) => id), requirements.map(({ id }) => id));

  const provider = fakeProvider((request) => {
    const id = request.stage === "behavioural" ? "r-beh"
      : request.stage === "company-fit" ? "r-domain" : "r-tech";
    return { questions: [question(id, request.stage)] };
  });
  const result = await generateQuestionsWithCoverage(requirements, provider, { context });

  assert.deepEqual(provider.requests.map(({ stage }) => stage), [
    "technical", "behavioural", "system-design", "company-fit",
  ]);
  assert.equal(new Set(provider.requests.map(({ system }) => system)).size, 4);
  assert.ok(provider.requests.every(({ system }) => system.includes("avoid absolute guarantees")));
  assert.ok(provider.requests.every(({ prompt }) => prompt.includes("take-home API exercise")));
  assert.deepEqual(result.coverage.uncovered_requirement_ids, []);
  assert.equal(result.passes, 1);
  assert.equal(result.questions.length, 4);
  assert.ok(result.questions.every(({ id }) => /^q-[a-f0-9]{12}$/.test(id)));
  assert.deepEqual(result.trace.at(-1).uncovered_after, []);

  const withoutContext = fakeProvider((request) => ({
    questions: [question(request.stage === "behavioural" ? "r-beh" : request.stage === "company-fit" ? "r-domain" : "r-tech", request.stage)],
  }));
  await generateQuestionsWithCoverage(requirements, withoutContext);
  assert.ok(withoutContext.requests.every(({ prompt }) => !prompt.includes("take-home API exercise")));
});

test("executes the fixture-backed repair round and records the gap closing", async () => {
  const fixture = JSON.parse(await readFile(new URL("../../../tests/fixtures/providers/coverage-repair.json", import.meta.url), "utf8"));
  const fixtureRequirements = [
    { id: "r1", text: "5+ years building APIs with TypeScript", kind: "technical", priority: "must" },
    { id: "r2", text: "Experience with Python or Java", kind: "technical", priority: "must" },
    { id: "r3", text: "Mentor junior engineers", kind: "behavioural", priority: "must" },
    { id: "r4", text: "Kubernetes experience", kind: "technical", priority: "nice" },
  ];
  const provider = fakeProvider((request) => {
    if (request.stage === "technical") {
      return { questions: fixture.first_pass.map((item) => ({
        requirement_ids: item.requirement_ids,
        prompt: item.prompt,
        answer_outline: item.answer_outline,
        difficulty: item.difficulty,
      })) };
    }
    if (request.stage === "coverage-repair") {
      return { questions: fixture.repair_pass.map((item) => ({
        requirement_ids: item.requirement_ids,
        category: item.category,
        prompt: item.prompt,
        answer_outline: item.answer_outline,
        difficulty: item.difficulty,
      })) };
    }
    return { questions: [] };
  });

  const result = await generateQuestionsWithCoverage(fixtureRequirements, provider);
  assert.equal(result.passes, 2);
  assert.deepEqual(result.coverage.uncovered_requirement_ids, []);
  assert.deepEqual(provider.requests.map(({ stage }) => stage), [
    "technical", "behavioural", "system-design", "coverage-repair",
  ]);
  const checks = result.trace.filter(({ stage }) => stage === "coverage-check");
  assert.deepEqual(checks.map(({ uncovered_after }) => uncovered_after), [["r3"], []]);
  const repairRequirements = JSON.parse(provider.requests.at(-1).prompt).uncovered_requirements;
  assert.deepEqual(repairRequirements.map(({ id }) => id), ["r3"]);
  assert.deepEqual(repairRequirements[0].allowed_categories, ["behavioural"]);
});

test("bounded repair fails recoverably for must gaps but records exhausted nice gaps", async () => {
  const empty = fakeProvider(() => ({ questions: [] }));
  await assert.rejects(
    () => generateQuestionsWithCoverage([
      { id: "must-1", text: "TypeScript", kind: "technical", priority: "must" },
    ], empty),
    (error) => error instanceof GenerationContentError
      && error.code === "MUST_HAVE_COVERAGE_FAILED"
      && error.partial.passes === 3
      && error.partial.questions.length === 0
      && error.partial.coverage.uncovered_must_requirement_ids[0] === "must-1",
  );
  assert.equal(empty.requests.filter(({ stage }) => stage === "coverage-repair").length, 2);

  const nice = await generateQuestionsWithCoverage([
    { id: "nice-1", text: "Kubernetes", kind: "technical", priority: "nice" },
  ], fakeProvider(() => ({ questions: [] })));
  assert.deepEqual(nice.coverage.uncovered_requirement_ids, ["nice-1"]);
  assert.equal(nice.passes, 3);
  assert.match(nice.warnings[0], /nice-1/);
});

test("rejects out-of-batch references and skips all calls for no requirements", async () => {
  const bad = fakeProvider(() => ({ questions: [question("invented", "bad")] }));
  await assert.rejects(
    () => generateQuestionsWithCoverage([
      { id: "r1", text: "TypeScript", kind: "technical", priority: "must" },
    ], bad),
    { code: "UNKNOWN_REQUIREMENT_REFERENCE" },
  );
  const unused = fakeProvider(() => { throw new Error("must not call"); });
  const thin = await generateQuestionsWithCoverage([], unused);
  assert.equal(thin.passes, 0);
  assert.deepEqual(thin.questions, []);
  assert.equal(unused.requests.length, 0);

  const wrongCategory = fakeProvider((request) => request.stage === "coverage-repair"
    ? { questions: [{ ...question("r1", "wrong category"), category: "company-fit" }] }
    : { questions: [] });
  await assert.rejects(
    () => generateQuestionsWithCoverage([
      { id: "r1", text: "TypeScript", kind: "technical", priority: "must" },
    ], wrongCategory),
    { code: "INVALID_GENERATED_CONTENT" },
  );
});

test("generates grounded flashcards with application IDs and rejects dangling references", async () => {
  const questions = [{
    id: "q1", requirement_ids: ["r-tech"], category: "technical",
    prompt: "How do you design a reliable API?", answer_outline: "Discuss failure modes.", difficulty: 2,
  }];
  const provider = fakeProvider(() => ({ flashcards: [
    { front: "What makes an API retry safe?", back: "Idempotency and bounded retry policy.", requirement_ids: ["r-tech"] },
    { front: "What makes an API retry safe?", back: "Idempotency and bounded retry policy.", requirement_ids: ["r-tech"] },
  ] }));
  const result = await generateFlashcards(requirements, questions, provider, { roleTitle: "Platform Engineer" });
  assert.equal(result.flashcards.length, 1);
  assert.match(result.flashcards[0].id, /^card-[a-f0-9]{12}$/);
  assert.equal(provider.requests[0].stage, "flashcards");
  assert.equal(result.trace[0].output_ids[0], result.flashcards[0].id);

  await assert.rejects(
    () => generateFlashcards(requirements, questions, fakeProvider(() => ({ flashcards: [
      { front: "Invented", back: "No", requirement_ids: ["unknown"] },
    ] }))),
    { code: "UNKNOWN_REQUIREMENT_REFERENCE" },
  );
  await assert.rejects(
    () => generateFlashcards(requirements, [{ ...questions[0], requirement_ids: ["unknown"] }], provider),
    /Unknown requirement ID/,
  );
  const unused = fakeProvider(() => { throw new Error("must not call"); });
  assert.deepEqual(await generateFlashcards([], [], unused), { flashcards: [], trace: [] });
});
