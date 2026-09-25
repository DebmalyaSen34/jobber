import assert from "node:assert/strict";
import { test } from "node:test";
import { initialKitMetadata } from "../dist/kits.js";
import { RegenerationRunner, RegenerationService } from "../dist/regenerations.js";

const question = (id, prompt, category = "technical") => ({
  id, requirement_ids: ["req-1"], category, prompt, answer_outline: `${prompt} outline`, difficulty: 2,
});

function content() {
  const questions = [
    question("q1", "Edited Q1"), question("q2", "Pinned Q2"), question("q3", "Manual Q3"),
    question("q5", "Original Q5"), question("qu", "Unrelated", "behavioural"),
  ];
  return {
    source: { company: "Acme", company_url: "https://example.com", role: "Engineer", location: "", jd_chars: 20, researched_at: "2026-09-25T00:00:00.000Z", pages_used: [] },
    company_brief: { summary: "Keep", what_they_do: "Keep this too", sources: [] },
    role: { title: "Engineer", seniority: "", responsibilities: [], requirements: [{ id: "req-1", text: "Build systems", kind: "technical", priority: "must" }] },
    questions,
    flashcards: [],
    schedule: { days_available: 1, days: [{ day: 1, focus: "Practice", question_ids: ["q1", "qu"], minutes: 30 }] },
    coverage: { uncovered_requirement_ids: [], passes: 1 },
    warnings: [],
  };
}

class MemoryRegenerationStore {
  constructor() {
    const kitContent = content();
    const metadata = initialKitMetadata(kitContent, "generation-1", 1);
    metadata.questions.q1 = { ...metadata.questions.q1, userEdited: true, revision: 2 };
    metadata.questions.q2 = { ...metadata.questions.q2, pinned: true, revision: 2 };
    metadata.questions.q3 = { origin: "manual", userEdited: true, pinned: false, revision: 2, generationRunId: null };
    this.kit = {
      id: "kit-1", ownerId: "owner-1", sourceJobId: "generation-1",
      originalInput: { jd: "Build systems", companyUrl: "https://example.com", days: 1 },
      content: kitContent, metadata,
      tombstones: [{ kind: "question", id: "q4", revision: 2, deletedAt: new Date("2026-09-25T00:00:00.000Z") }],
      revision: 2, createdAt: new Date("2026-09-25T00:00:00.000Z"), updatedAt: new Date("2026-09-25T00:00:00.000Z"),
    };
    this.jobs = new Map();
  }

  async findOwnedKit(ownerId, kitId) { return this.kit.ownerId === ownerId && this.kit.id === kitId ? structuredClone(this.kit) : null; }
  async listOwnedKits() { return [structuredClone(this.kit)]; }
  async updateOwnedKit(input) {
    if (input.ownerId !== this.kit.ownerId || input.kitId !== this.kit.id) return { kind: "not_found" };
    if (input.expectedRevision !== this.kit.revision) return { kind: "conflict", revision: this.kit.revision };
    this.kit = { ...this.kit, content: input.content, metadata: input.metadata, tombstones: input.tombstones, revision: this.kit.revision + 1, updatedAt: input.now };
    return { kind: "updated", kit: structuredClone(this.kit) };
  }
  async enqueueRegeneration(input) {
    const job = { id: "regen-1", ...input, status: "queued", createdAt: input.now, updatedAt: input.now };
    this.jobs.set(job.id, job);
    return structuredClone(job);
  }
  async findOwnedRegeneration(ownerId, jobId) { const job = this.jobs.get(jobId); return job?.ownerId === ownerId ? structuredClone(job) : null; }
  async claimNextRegeneration(workerId, now, leaseMs) {
    const job = [...this.jobs.values()].find(({ status }) => status === "queued");
    if (!job) return null;
    Object.assign(job, { status: "running", leaseToken: `lease-${workerId}`, leaseExpiresAt: new Date(now.getTime() + leaseMs), updatedAt: now });
    return structuredClone(job);
  }
  async renewRegenerationLease(jobId, leaseToken, now, leaseMs) {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== "running" || job.leaseToken !== leaseToken || job.leaseExpiresAt <= now) return false;
    job.leaseExpiresAt = new Date(now.getTime() + leaseMs);
    return true;
  }
  async completeRegeneration(jobId, leaseToken, now) { const job = this.jobs.get(jobId); if (!job || job.leaseToken !== leaseToken) return false; Object.assign(job, { status: "completed", completedAt: now }); return true; }
  async failRegeneration(jobId, leaseToken, error) { const job = this.jobs.get(jobId); if (!job || job.leaseToken !== leaseToken) return false; Object.assign(job, { status: "failed", error }); return true; }
  async releaseRegeneration() { return true; }
}

test("category regeneration preserves edits, pins, manual items, tombstones, concurrent edits, and unrelated sections", async () => {
  const store = new MemoryRegenerationStore();
  const service = new RegenerationService(store);
  await service.enqueue("owner-1", "kit-1", { type: "question-category", category: "technical" }, new Date("2026-09-25T00:00:00.000Z"));
  let release;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const generatedPromise = new Promise((resolve) => { release = resolve; });
  const beforeBrief = structuredClone(store.kit.content.company_brief);
  const beforeUnrelated = structuredClone(store.kit.content.questions.find(({ id }) => id === "qu"));
  const now = new Date("2026-09-25T00:00:01.000Z");
  const runner = new RegenerationRunner(store, async () => {
    started();
    return generatedPromise;
  }, { workerId: "worker-1", leaseMs: 60_000, pollMs: 1_000 }, () => now);

  const running = runner.runOnce();
  await startedPromise;
  store.kit.content.questions.find(({ id }) => id === "q5").prompt = "Edited Q5 while running";
  store.kit.metadata.questions.q5 = { ...store.kit.metadata.questions.q5, userEdited: true, revision: 3 };
  store.kit.revision = 3;
  release({
    type: "question-category", category: "technical",
    questions: [question("q1", "Replacement Q1"), question("q2", "Replacement Q2"), question("q4", "Restored Q4"), question("q6", "New Q6")],
  });
  await running;

  const prompts = new Map(store.kit.content.questions.map(({ id, prompt }) => [id, prompt]));
  assert.equal(prompts.get("q1"), "Edited Q1");
  assert.equal(prompts.get("q2"), "Pinned Q2");
  assert.equal(prompts.get("q3"), "Manual Q3");
  assert.equal(prompts.get("q5"), "Edited Q5 while running");
  assert.equal(prompts.has("q4"), false);
  assert.equal(prompts.get("q6"), "New Q6");
  assert.deepEqual(store.kit.content.company_brief, beforeBrief);
  assert.deepEqual(store.kit.content.questions.find(({ id }) => id === "qu"), beforeUnrelated);
  assert.equal(store.kit.content.schedule.days.flatMap(({ question_ids }) => question_ids).every((id) => prompts.has(id)), true);
  assert.equal((await service.getOwned("owner-1", "regen-1")).status, "completed");
});
