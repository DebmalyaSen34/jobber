import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluationCaseSchema, evaluationOutputSchema, kitSchema,
} from "../dist/index.js";

function thinKit() {
  return {
    source: {
      company: "", company_url: "invalid-url", role: "", location: "",
      jd_chars: 12, researched_at: "2026-09-23T12:00:00Z", pages_used: [],
    },
    company_brief: { summary: "Research unavailable", what_they_do: "", sources: [] },
    role: { title: "", seniority: "", responsibilities: [], requirements: [] },
    questions: [], flashcards: [],
    schedule: {
      days_available: 1,
      days: [{ day: 1, focus: "Clarify role expectations", question_ids: [], minutes: 0 }],
    },
    coverage: { uncovered_requirement_ids: [], passes: 0 },
    warnings: [{ code: "RESEARCH_UNAVAILABLE" }],
  };
}

test("thin kits preserve warnings without inventing material", () => {
  assert.deepEqual(kitSchema.parse(thinKit()), thinKit());
});

test("integer durations and required contract fields are enforced", () => {
  const kit = thinKit();
  kit.schedule.days[0].minutes = 1.5;
  assert.equal(kitSchema.safeParse(kit).success, false);
  kit.schedule.days[0].minutes = 0;
  delete kit.coverage;
  assert.equal(kitSchema.safeParse(kit).success, false);
});

test("question outlines must be strings and enums must match Appendix A", () => {
  const kit = thinKit();
  kit.questions = [{
    id: "q1", requirement_ids: [], category: "behavioural",
    prompt: "Describe mentoring a colleague", answer_outline: "Use a concrete example",
    difficulty: 2,
  }];
  assert.equal(kitSchema.safeParse(kit).success, true);
  kit.questions[0].answer_outline = ["Wrong representation"];
  assert.equal(kitSchema.safeParse(kit).success, false);
  kit.questions[0].answer_outline = "";
  kit.questions[0].category = "behavioral";
  assert.equal(kitSchema.safeParse(kit).success, false);
});

test("batch cases preserve JD text and permit local research fixtures", () => {
  const input = { id: "case-01", jd: "  Engineer\n", company_url: "http://localhost:8099/acme/", days: 60 };
  assert.deepEqual(evaluationCaseSchema.parse(input), input);
  for (const days of [0, -1, 1.5]) {
    assert.equal(evaluationCaseSchema.safeParse({ ...input, days }).success, false);
  }
  assert.equal(evaluationCaseSchema.safeParse({ ...input, jd: " \n" }).success, false);
});

test("batch status requires the matching kit/error shape", () => {
  const output = {
    version: "1.0", generated_at: "2026-09-23T12:00:00Z",
    kits: [
      { id: "a", status: "ok", kit: thinKit(), error: null },
      { id: "b", status: "failed", kit: null, error: { code: "GENERATION_FAILED", message: "Provider unavailable" } },
    ],
  };
  assert.equal(evaluationOutputSchema.safeParse(output).success, true);
  output.kits[0].kit = null;
  assert.equal(evaluationOutputSchema.safeParse(output).success, false);
});
