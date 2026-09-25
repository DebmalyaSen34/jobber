import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyReconciliation, initialKitMetadata, KitService, publicKit } from "../dist/kits.js";

const requirement = (id, priority = "must") => ({ id, text: `Requirement ${id}`, kind: "technical", priority });
const question = (id, requirementIds) => ({
  id, requirement_ids: requirementIds, category: "technical", prompt: `Question ${id}`,
  answer_outline: "Answer", difficulty: 2,
});

function content() {
  return {
    source: { company: "Acme", company_url: "https://example.com", role: "Engineer", location: "", jd_chars: 20, researched_at: "2026-09-25T00:00:00.000Z", pages_used: [] },
    company_brief: { summary: "Acme", what_they_do: "Builds software", sources: [] },
    role: { title: "Engineer", seniority: "", responsibilities: [], requirements: [requirement("r1"), requirement("r2", "nice")] },
    questions: [question("q1", ["r1"]), question("q2", ["r2"])],
    flashcards: [{ id: "f1", front: "Front", back: "Back", requirement_ids: ["r2"] }],
    schedule: { days_available: 1, days: [{ day: 1, focus: "Practice", question_ids: ["q1", "q2"], minutes: 40 }] },
    coverage: { uncovered_requirement_ids: [], passes: 1 },
    warnings: [],
  };
}

class MemoryKitStore {
  constructor() {
    const kitContent = content();
    this.kit = {
      id: "kit-1", ownerId: "owner-1", sourceJobId: "job-1",
      originalInput: { jd: "Engineer", companyUrl: "https://example.com", days: 1 },
      content: kitContent, metadata: initialKitMetadata(kitContent, "job-1"), tombstones: [],
      lastReconciliation: emptyReconciliation(1), revision: 1,
      createdAt: new Date("2026-09-25T00:00:00.000Z"), updatedAt: new Date("2026-09-25T00:00:00.000Z"),
    };
  }
  async listOwnedKits() { return [this.kit]; }
  async findOwnedKit(ownerId, kitId) { return ownerId === this.kit.ownerId && kitId === this.kit.id ? this.kit : null; }
  async updateOwnedKit(input) {
    if (input.expectedRevision !== this.kit.revision) return { kind: "conflict", revision: this.kit.revision };
    this.kit = {
      ...this.kit, content: input.content, metadata: input.metadata, tombstones: input.tombstones,
      lastReconciliation: input.reconciliation, revision: this.kit.revision + 1, updatedAt: input.now,
    };
    return { kind: "updated", kit: this.kit };
  }
}

test("save removes dangling links, recomputes coverage, and exposes schedule health", async () => {
  const store = new MemoryKitStore();
  const edited = structuredClone(store.kit.content);
  edited.role.requirements = edited.role.requirements.filter(({ id }) => id !== "r2");
  edited.questions = edited.questions.filter(({ id }) => id !== "q2");
  edited.questions[0].requirement_ids.push("r2");
  // Deliberately leave stale card and schedule links to verify server-side reconciliation.
  const saved = await new KitService(store).update("owner-1", "kit-1", { revision: 1, content: edited });
  const response = publicKit(saved);

  assert.deepEqual(response.content.questions[0].requirement_ids, ["r1"]);
  assert.deepEqual(response.content.flashcards[0].requirement_ids, []);
  assert.deepEqual(response.content.schedule.days[0].question_ids, ["q1"]);
  assert.deepEqual(response.content.coverage.uncovered_requirement_ids, []);
  assert.deepEqual(response.reconciliation, {
    revision: 2,
    removedQuestionRequirementLinks: 1,
    removedFlashcardRequirementLinks: 1,
    removedScheduleQuestionLinks: 1,
  });
  assert.equal(response.derivedState.schedule_needs_regeneration, false);

  const next = structuredClone(response.content);
  next.role.requirements.push(requirement("r3"));
  next.questions.push(question("q3", ["r3"]));
  const unscheduled = await new KitService(store).update("owner-1", "kit-1", { revision: 2, content: next });
  const health = publicKit(unscheduled).derivedState;
  assert.deepEqual(health.unscheduled_question_ids, ["q3"]);
  assert.deepEqual(health.covered_but_unscheduled_must_requirement_ids, ["r3"]);
  assert.equal(health.schedule_needs_regeneration, true);
});
