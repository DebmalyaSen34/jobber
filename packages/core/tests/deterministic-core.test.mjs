import assert from "node:assert/strict";
import test from "node:test";
import { allocateSchedule, checkCoverage, deriveKitState, validateKit, runBatch } from "../dist/index.js";

const requirement = (id, priority = "must") => ({ id, text: `Requirement ${id}`, kind: "technical", priority });
const question = (id, requirement_ids, difficulty = 2) => ({ id, requirement_ids, difficulty, category: "technical", prompt: `Explain ${id}`, answer_outline: "Discuss trade-offs." });
const requirements = [requirement("r1"), requirement("r2"), requirement("r3", "nice")];
const questions = [question("hard", ["r1", "r2"], 3), question("medium", ["r1"], 2), question("easy", ["r3"], 1)];

function makeKit(days = 5, rs = requirements, qs = questions) {
  return {
    source: { company: "", company_url: "http://localhost:8099/acme/", role: "", location: "", jd_chars: 0, researched_at: "2026-09-23T12:00:00Z", pages_used: [] },
    company_brief: { summary: "Unknown", what_they_do: "", sources: [] },
    role: { title: "", seniority: "", responsibilities: [], requirements: structuredClone(rs) },
    questions: structuredClone(qs), flashcards: [],
    schedule: allocateSchedule(rs, qs, days),
    coverage: { uncovered_requirement_ids: checkCoverage(rs, qs).uncovered_requirement_ids, passes: 1 },
  };
}

test("coverage includes nice gaps, separates must gaps, and responds to added questions", () => {
  const first = checkCoverage(requirements, [question("q", ["r1"])]);
  assert.deepEqual(first.uncovered_requirement_ids, ["r2", "r3"]);
  assert.deepEqual(first.uncovered_must_requirement_ids, ["r2"]);
  const second = checkCoverage(requirements, [question("q", ["r1"]), question("repair", ["r2", "r3"])]);
  assert.deepEqual(second.uncovered_requirement_ids, []);
  assert.deepEqual(checkCoverage([], []).covered_requirement_ids, []);
});

test("coverage rejects unknown references, duplicate entities, and invalid shapes", () => {
  assert.throws(() => checkCoverage(requirements, [question("q", ["missing"])]), /Unknown/);
  assert.throws(() => checkCoverage([...requirements, requirements[0]], questions), /Duplicate requirement/);
  assert.throws(() => checkCoverage(requirements, [...questions, questions[0]]), /Duplicate question/);
  assert.throws(() => checkCoverage(requirements, [question("q", ["r1"], 4)]));
});

test("derived state distinguishes content gaps from schedule repair needs", () => {
  const kit = makeKit();
  kit.questions = kit.questions.filter(({ id }) => id !== "easy");
  kit.schedule.days.forEach((day) => { day.question_ids = day.question_ids.filter((id) => id !== "easy" && id !== "medium"); });
  const state = deriveKitState(kit);
  assert.deepEqual(state.uncovered_requirement_ids, ["r3"]);
  assert.deepEqual(state.uncovered_must_requirement_ids, []);
  assert.deepEqual(state.unscheduled_question_ids, ["medium"]);
  assert.deepEqual(state.covered_but_unscheduled_must_requirement_ids, []);
  assert.equal(state.schedule_needs_regeneration, true);
  assert.deepEqual(state.schedule_reasons, ["UNSCHEDULED_QUESTIONS"]);

  kit.schedule.days.forEach((day) => { day.question_ids = []; });
  const missingMust = deriveKitState(kit);
  assert.deepEqual(missingMust.covered_but_unscheduled_must_requirement_ids, ["r1", "r2"]);
  assert.deepEqual(missingMust.schedule_reasons, ["UNSCHEDULED_QUESTIONS", "UNSCHEDULED_MUST_REQUIREMENTS"]);
});

test("one-day schedule includes all questions and their full estimated workload", () => {
  const schedule = allocateSchedule(requirements, questions, 1);
  assert.deepEqual(schedule.days[0].question_ids, ["hard", "medium", "easy"]);
  assert.equal(schedule.days[0].minutes, 60);
  assert.equal(validateKit(makeKit(1), { requestedDays: 1 }).success, true);
});

test("five-day allocation has priority-ordered first exposure and oldest-first review", () => {
  const schedule = allocateSchedule(requirements, questions, 5);
  assert.deepEqual(schedule.days.map((day) => day.question_ids), [["hard"], ["medium"], ["easy"], ["hard"], ["medium"]]);
  assert.deepEqual(schedule.days.map((day) => day.minutes), [30, 20, 10, 30, 20]);
  assert.match(schedule.days[3].focus, /^Review:/);
});

test("must priority precedes difficulty; lexical IDs break ties independent of input order", () => {
  const rs = [requirement("must"), requirement("nice", "nice")];
  const qs = [question("z", ["must"], 1), question("nice-hard", ["nice"], 3), question("a", ["must"], 1)];
  const before = structuredClone({ rs, qs });
  const schedule = allocateSchedule(rs, qs, 5);
  const firstSeen = [...new Set(schedule.days.flatMap((d) => d.question_ids))];
  assert.deepEqual(firstSeen, ["a", "z", "nice-hard"]);
  assert.deepEqual(schedule, allocateSchedule([...rs].reverse(), [...qs].reverse(), 5));
  assert.deepEqual({ rs, qs }, before);
});

test("sixty days reuse material without fabricated IDs or premature reviews", () => {
  const schedule = allocateSchedule(requirements, questions, 60);
  assert.equal(schedule.days.length, 60);
  const seen = new Set();
  for (const day of schedule.days) {
    assert.ok(day.question_ids.length > 0);
    assert.ok(Number.isInteger(day.minutes));
    for (const id of day.question_ids) {
      assert.ok(questions.some((q) => q.id === id));
      if (day.focus.startsWith("Review:")) assert.ok(seen.has(id));
      seen.add(id);
    }
  }
  assert.equal(validateKit(makeKit(60), { requestedDays: 60 }).success, true);
});

test("thin schedules remain honest for 1 and 60 days; uncovered musts cannot be scheduled", () => {
  for (const days of [1, 60]) {
    const kit = makeKit(days, [], []);
    assert.equal(kit.schedule.days.length, days);
    assert.ok(kit.schedule.days.every((d) => d.minutes === 0 && d.question_ids.length === 0));
    assert.equal(validateKit(kit, { requestedDays: days }).success, true);
  }
  assert.throws(() => allocateSchedule(requirements, [], 5), /uncovered must-have/);
  for (const days of [0, -1, 1.2, Infinity]) assert.throws(() => allocateSchedule([], [], days));
});

test("allocation invariants hold across varying material counts and all supported edge days", () => {
  for (const count of [1, 2, 7, 25]) {
    const rs = Array.from({ length: count }, (_, i) => requirement(`r${i}`, i % 3 ? "must" : "nice"));
    const qs = rs.map((r, i) => question(`q${i}`, [r.id], i % 3 + 1));
    for (let days = 1; days <= 60; days++) {
      const kit = makeKit(days, rs, qs);
      assert.equal(validateKit(kit, { requestedDays: days }).success, true, `${count} questions/${days} days`);
      assert.equal(new Set(kit.schedule.days.flatMap((d) => d.question_ids)).size, count);
      assert.deepEqual(kit.schedule, allocateSchedule(rs, qs, days));
    }
  }
});

test("relational validation rejects duplicate IDs, dangling references, and malformed days", () => {
  const mutations = [
    ["DUPLICATE_ID", (k) => k.role.requirements.push(k.role.requirements[0])],
    ["DUPLICATE_ID", (k) => k.questions.push(k.questions[0])],
    ["DUPLICATE_ID", (k) => { const f = { id: "f", front: "?", back: "!", requirement_ids: [] }; k.flashcards = [f, f]; }],
    ["UNKNOWN_REFERENCE", (k) => k.questions[0].requirement_ids.push("ghost")],
    ["UNKNOWN_REFERENCE", (k) => k.flashcards.push({ id: "f", front: "?", back: "!", requirement_ids: ["ghost"] })],
    ["UNKNOWN_REFERENCE", (k) => k.schedule.days[0].question_ids.push("ghost")],
    ["DUPLICATE_ID", (k) => k.schedule.days[0].question_ids.push(k.schedule.days[0].question_ids[0])],
    ["DAY_COUNT_MISMATCH", (k) => k.schedule.days.pop()],
    ["DAY_COUNT_MISMATCH", (k) => { k.schedule.days_available = 60; }],
    ["INVALID_DAY_SEQUENCE", (k) => { k.schedule.days[1].day = 1; }],
    ["STALE_COVERAGE", (k) => k.coverage.uncovered_requirement_ids.push("r1")],
    ["INVALID_STRUCTURE", (k) => { k.schedule.days[0].minutes = 1.5; }],
  ];
  for (const [code, mutate] of mutations) {
    const kit = makeKit(); mutate(kit);
    const result = validateKit(kit, { requestedDays: 5 });
    assert.equal(result.success, false, code);
    assert.ok(result.errors.some((issue) => issue.code === code), code);
  }
  assert.equal(validateKit(makeKit(), { requestedDays: 1 }).success, false);
});

test("generated kits reject coverage gaps; honest edited drafts receive actionable warnings", () => {
  const kit = makeKit();
  kit.questions = kit.questions.filter((q) => q.id !== "hard");
  kit.schedule.days.forEach((d) => { d.question_ids = d.question_ids.filter((id) => id !== "hard"); });
  kit.coverage.uncovered_requirement_ids = ["r2"];
  const generated = validateKit(kit, { requestedDays: 5 });
  assert.equal(generated.success, false);
  assert.ok(generated.errors.some((e) => e.code === "UNCOVERED_MUST"));
  const draft = validateKit(kit, { requestedDays: 5, mode: "draft" });
  assert.equal(draft.success, true);
  assert.ok(draft.warnings.some((e) => e.code === "UNSCHEDULED_MUST"));
  kit.coverage.uncovered_requirement_ids = [];
  assert.equal(validateKit(kit, { requestedDays: 5, mode: "draft" }).success, false);
});

test("unscheduled musts and nice questions are detected; honest nice gaps are permitted", () => {
  const kit = makeKit();
  kit.schedule.days.forEach((d) => { d.question_ids = []; });
  const invalid = validateKit(kit, { requestedDays: 5 });
  assert.ok(invalid.errors.some((e) => e.code === "UNSCHEDULED_MUST"));
  assert.ok(invalid.errors.some((e) => e.code === "UNSCHEDULED_QUESTION"));
  const niceGap = makeKit(5, requirements, [questions[0]]);
  assert.deepEqual(niceGap.coverage.uncovered_requirement_ids, ["r3"]);
  assert.equal(validateKit(niceGap, { requestedDays: 5 }).success, true);
});

test("batch rejects relationally invalid kits and continues to the next case", async () => {
  const cases = ["bad", "good"].map((id) => ({ id, jd: "Engineer", company_url: "invalid", days: 5 }));
  const result = await runBatch(cases, async ({ id }) => {
    const kit = makeKit();
    if (id === "bad") kit.schedule.days[0].question_ids.push("unknown");
    return kit;
  });
  assert.equal(result.kits[0].error.code, "INVALID_KIT");
  assert.equal(result.kits[1].status, "ok");
});
