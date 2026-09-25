import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyReconciliation, initialKitMetadata } from "../dist/kits.js";
import { PracticeError, PracticeService } from "../dist/practice.js";

const card = (id) => ({ id, front: `Front ${id}`, back: `Back ${id}`, requirement_ids: [] });

class MemoryPracticeStore {
  constructor() {
    const content = {
      source: { company: "Acme", company_url: "https://example.com", role: "Engineer", location: "", jd_chars: 8, researched_at: "2026-09-25T00:00:00.000Z", pages_used: [] },
      company_brief: { summary: "Acme", what_they_do: "Builds software", sources: [] },
      role: { title: "Engineer", seniority: "", responsibilities: [], requirements: [] },
      questions: [],
      flashcards: [card("c-confident"), card("c-again"), card("c-unseen"), card("c-unsure")],
      schedule: { days_available: 1, days: [{ day: 1, focus: "Review", question_ids: [], minutes: 0 }] },
      coverage: { uncovered_requirement_ids: [], passes: 0 },
    };
    this.kit = {
      id: "kit-1", ownerId: "owner-1", sourceJobId: "job-1",
      originalInput: { jd: "Engineer", companyUrl: "https://example.com", days: 1 },
      content, metadata: initialKitMetadata(content, "job-1"), tombstones: [],
      lastReconciliation: emptyReconciliation(1), revision: 1,
      createdAt: new Date("2026-09-25T00:00:00.000Z"), updatedAt: new Date("2026-09-25T00:00:00.000Z"),
    };
    this.records = new Map();
  }
  async findOwnedKit(ownerId, kitId) { return ownerId === this.kit.ownerId && kitId === this.kit.id ? this.kit : null; }
  async listOwnedKits() { return [this.kit]; }
  async updateOwnedKit() { throw new Error("not used"); }
  async listPracticeRecords(ownerId, kitId) {
    return [...this.records.values()].filter((item) => item.ownerId === ownerId && item.kitId === kitId);
  }
  async recordPracticeReview(input) {
    const prior = this.records.get(input.cardId);
    if (prior?.reviews.some(({ id }) => id === input.reviewId)) return prior;
    const review = { id: input.reviewId, confidence: input.confidence, reviewedAt: input.now, cardVersion: input.cardVersion };
    const next = {
      ownerId: input.ownerId, kitId: input.kitId, cardId: input.cardId,
      cardVersion: input.cardVersion, confidence: input.confidence,
      reviewCount: (prior?.reviewCount ?? 0) + 1, lastReviewedAt: input.now,
      reviews: [...(prior?.reviews ?? []), review],
    };
    this.records.set(input.cardId, next);
    return next;
  }
}

test("practice persists reviews, orders the next session, and resets edited card confidence without deleting history", async () => {
  const store = new MemoryPracticeStore();
  const practice = new PracticeService(store);
  const initial = await practice.get("owner-1", "kit-1");
  assert.deepEqual(initial.counts, { unseen: 4, reviewed: 0, total: 4 });
  assert.deepEqual(initial.orderedCardIds, ["c-again", "c-confident", "c-unseen", "c-unsure"]);

  const reviews = [
    ["c-confident", "confident", "00000000-0000-4000-8000-000000000001", "2026-09-25T01:00:00.000Z"],
    ["c-again", "again", "00000000-0000-4000-8000-000000000002", "2026-09-25T02:00:00.000Z"],
    ["c-unsure", "unsure", "00000000-0000-4000-8000-000000000003", "2026-09-25T03:00:00.000Z"],
  ];
  for (const [cardId, confidence, reviewId, at] of reviews) {
    await practice.review("owner-1", "kit-1", { review_id: reviewId, card_id: cardId, confidence }, new Date(at));
  }
  const reopened = await practice.get("owner-1", "kit-1");
  assert.deepEqual(reopened.counts, { unseen: 1, reviewed: 3, total: 4 });
  assert.deepEqual(reopened.orderedCardIds, ["c-again", "c-unseen", "c-unsure", "c-confident"]);

  await practice.review("owner-1", "kit-1", {
    review_id: reviews[1][2], card_id: "c-again", confidence: "again",
  }, new Date("2026-09-25T04:00:00.000Z"));
  assert.equal((await practice.get("owner-1", "kit-1")).progress.find(({ cardId }) => cardId === "c-again").reviewCount, 1);

  store.kit.content.flashcards.find(({ id }) => id === "c-confident").back = "Materially edited answer";
  const afterEdit = await practice.get("owner-1", "kit-1");
  const edited = afterEdit.progress.find(({ cardId }) => cardId === "c-confident");
  assert.equal(edited.confidence, null);
  assert.equal(edited.reviewCount, 1);
  assert.equal(edited.lastReviewedAt, "2026-09-25T01:00:00.000Z");
  assert.deepEqual(afterEdit.orderedCardIds, ["c-again", "c-unseen", "c-confident", "c-unsure"]);

  await assert.rejects(() => practice.get("owner-2", "kit-1"), (error) => error instanceof PracticeError && error.status === 404);
  await assert.rejects(() => practice.review("owner-1", "kit-1", {
    review_id: "00000000-0000-4000-8000-000000000004", card_id: "missing", confidence: "again",
  }), (error) => error instanceof PracticeError && error.code === "CARD_NOT_FOUND");
});
