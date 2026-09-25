import assert from "node:assert/strict";
import { test } from "node:test";
import { GenerationError } from "@jobber/core";
import {
  JobError,
  JobRunner,
  JobService,
  fingerprintJobInput,
  parseJobInput,
} from "../dist/jobs.js";

class MemoryJobStore {
  jobs = new Map();
  nextId = 1;
  nextKitId = 1;

  async enqueueJob(input) {
    const active = [...this.jobs.values()].find((job) =>
      job.ownerId === input.ownerId &&
      job.fingerprint === input.fingerprint &&
      ["queued", "running", "retry_wait"].includes(job.status));
    if (active) return { job: active, deduplicated: true };
    const job = {
      id: `job-${this.nextId++}`,
      ownerId: input.ownerId,
      kitId: `kit-${this.nextKitId++}`,
      fingerprint: input.fingerprint,
      pipelineVersion: input.pipelineVersion,
      input: input.jobInput,
      status: "queued",
      stage: "queued",
      progress: [],
      warnings: [],
      attempt: 0,
      maxAttempts: input.maxAttempts,
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.jobs.set(job.id, job);
    return { job, deduplicated: false };
  }

  async findOwnedJob(ownerId, jobId) {
    const job = this.jobs.get(jobId);
    return job?.ownerId === ownerId ? job : null;
  }

  async listOwnedJobs(ownerId, limit) {
    return [...this.jobs.values()].filter((job) => job.ownerId === ownerId).slice(0, limit);
  }

  async claimNextJob(workerId, now, leaseMs) {
    for (const expired of this.jobs.values()) {
      if (expired.status === "running" && expired.leaseExpiresAt <= now && expired.attempt >= expired.maxAttempts) {
        expired.status = "failed";
        expired.error = {
          code: "JOB_RECOVERY_EXHAUSTED",
          message: "Generation stopped repeatedly and needs an explicit retry.",
          retryable: true,
        };
        delete expired.leaseToken;
        delete expired.leaseOwner;
        delete expired.leaseExpiresAt;
      }
    }
    const job = [...this.jobs.values()].find((candidate) =>
      candidate.attempt < candidate.maxAttempts && (
      candidate.status === "queued" ||
      (candidate.status === "retry_wait" && candidate.nextAttemptAt <= now) ||
      (candidate.status === "running" && candidate.leaseExpiresAt <= now)));
    if (!job) return null;
    job.status = "running";
    job.attempt += 1;
    job.leaseToken = `lease-${workerId}-${job.attempt}`;
    job.leaseOwner = workerId;
    job.leaseExpiresAt = new Date(now.getTime() + leaseMs);
    job.startedAt = now;
    job.updatedAt = now;
    delete job.nextAttemptAt;
    delete job.error;
    return { ...job };
  }

  validLease(jobId, leaseToken, now) {
    const job = this.jobs.get(jobId);
    return job && job.status === "running" && job.leaseToken === leaseToken && job.leaseExpiresAt > now ? job : null;
  }

  async renewJobLease(jobId, leaseToken, now, leaseMs) {
    const job = this.validLease(jobId, leaseToken, now);
    if (!job) return false;
    job.leaseExpiresAt = new Date(now.getTime() + leaseMs);
    job.updatedAt = now;
    return true;
  }

  async checkpointJob(jobId, leaseToken, progress, now, leaseMs) {
    const job = this.validLease(jobId, leaseToken, now);
    if (!job) return false;
    job.stage = progress.stage;
    job.progress.push(progress);
    job.leaseExpiresAt = new Date(now.getTime() + leaseMs);
    job.updatedAt = now;
    return true;
  }

  async completeJob(jobId, leaseToken, kit, now) {
    const job = this.validLease(jobId, leaseToken, now);
    if (!job) return false;
    const warnings = Array.isArray(kit.warnings) ? kit.warnings : [];
    job.status = warnings.length ? "completed_with_warnings" : "completed";
    job.warnings = warnings;
    job.result = kit;
    job.completedAt = now;
    job.updatedAt = now;
    delete job.leaseToken;
    delete job.leaseOwner;
    delete job.leaseExpiresAt;
    return true;
  }

  async recordJobFailure(input) {
    const job = this.validLease(input.jobId, input.leaseToken, input.now);
    if (!job) return false;
    job.status = input.retryAt ? "retry_wait" : "failed";
    job.error = input.failure;
    job.updatedAt = input.now;
    if (input.retryAt) job.nextAttemptAt = input.retryAt;
    delete job.leaseToken;
    delete job.leaseOwner;
    delete job.leaseExpiresAt;
    return true;
  }

  async releaseJob(jobId, leaseToken, now) {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== "running" || job.leaseToken !== leaseToken) return false;
    job.status = "queued";
    job.stage = "queued";
    job.updatedAt = now;
    job.attempt = Math.max(0, job.attempt - 1);
    delete job.leaseToken;
    delete job.leaseOwner;
    delete job.leaseExpiresAt;
    return true;
  }

  async retryOwnedJob(ownerId, jobId, now) {
    const job = await this.findOwnedJob(ownerId, jobId);
    if (!job || job.status !== "failed") return null;
    const conflict = [...this.jobs.values()].find((candidate) =>
      candidate.id !== job.id && candidate.ownerId === ownerId && candidate.fingerprint === job.fingerprint &&
      ["queued", "running", "retry_wait"].includes(candidate.status));
    if (conflict) return null;
    job.status = "queued";
    job.stage = "queued";
    job.progress = [];
    job.warnings = [];
    job.attempt = 0;
    job.updatedAt = now;
    delete job.error;
    return job;
  }

  async materializeCompletedKits() {}
}

const input = {
  jd: "Build reliable TypeScript APIs.",
  company_url: "HTTPS://Example.COM:443/careers/?b=2&a=1#role",
  days: 5,
};

function service(store) {
  return new JobService(store, { pipelineVersion: "pipeline-1", maxAttempts: 3 });
}

function kit(warnings = []) {
  return {
    source: {
      company: "Example",
      company_url: "https://example.com/careers?a=1&b=2",
      role: "Engineer",
      location: "",
      jd_chars: 31,
      researched_at: "2026-09-25T00:00:00.000Z",
      pages_used: [],
    },
    company_brief: { summary: "", what_they_do: "", sources: [] },
    role: { title: "Engineer", seniority: "", responsibilities: [], requirements: [] },
    questions: [],
    flashcards: [],
    schedule: { days_available: 5, days: [] },
    coverage: { uncovered_requirement_ids: [], passes: 0 },
    warnings,
  };
}

test("job input validation canonicalizes URLs and fingerprints normalized equivalent input", () => {
  const parsed = parseJobInput(input);
  assert.equal(parsed.companyUrl, "https://example.com/careers?a=1&b=2");
  assert.equal(
    fingerprintJobInput(parsed, "pipeline-1"),
    fingerprintJobInput({ ...parsed, jd: "Build reliable TypeScript APIs.\r\n" }, "pipeline-1"),
  );
  assert.notEqual(fingerprintJobInput(parsed, "pipeline-1"), fingerprintJobInput(parsed, "pipeline-2"));
  assert.throws(() => parseJobInput({ ...input, days: 0 }), { name: "JobError", code: "INVALID_INPUT" });
  assert.throws(() => parseJobInput({ ...input, company_url: "file:///etc/passwd" }), { name: "JobError" });
  assert.throws(() => parseJobInput({ ...input, company_url: "https://user:secret@example.com" }), { name: "JobError" });
});

test("active duplicates are reused per owner while another owner receives an independent job", async () => {
  const store = new MemoryJobStore();
  const jobs = service(store);
  const first = await jobs.enqueue("owner-a", input);
  const duplicate = await jobs.enqueue("owner-a", { ...input, company_url: "https://example.com/careers?a=1&b=2" });
  const otherOwner = await jobs.enqueue("owner-b", input);

  assert.equal(first.deduplicated, false);
  assert.equal(duplicate.deduplicated, true);
  assert.equal(duplicate.job.id, first.job.id);
  assert.notEqual(otherOwner.job.id, first.job.id);
  await assert.rejects(jobs.getOwned("owner-b", first.job.id), { name: "JobError", code: "NOT_FOUND", status: 404 });
});

test("runner persists named progress and completes a warning-bearing job", async () => {
  const store = new MemoryJobStore();
  const jobs = service(store);
  const queued = await jobs.enqueue("owner-a", input);
  const now = new Date("2026-09-25T00:00:00.000Z");
  const runner = new JobRunner(store, async (_case, onProgress) => {
    await onProgress({ stage: "researching", at: now.toISOString() });
    await onProgress({ stage: "validating", at: now.toISOString() });
    return kit([{ code: "RESEARCH_FAILED", message: "Research was unavailable." }]);
  }, { workerId: "worker-a", leaseMs: 60_000, pollMs: 1_000, retryBaseMs: 100 }, () => now);

  assert.equal(await runner.runOnce(), true);
  const completed = await jobs.getOwned("owner-a", queued.job.id);
  assert.equal(completed.status, "completed_with_warnings");
  assert.deepEqual(completed.progress.map(({ stage }) => stage), ["researching", "validating"]);
  assert.equal(completed.result.source.role, "Engineer");
});

test("expired lease is recoverable and fences a stale worker from committing", async () => {
  const store = new MemoryJobStore();
  const jobs = service(store);
  const queued = await jobs.enqueue("owner-a", input, new Date("2026-09-25T00:00:00.000Z"));
  const claimedA = await store.claimNextJob("worker-a", new Date("2026-09-25T00:00:00.000Z"), 1_000);
  const claimedB = await store.claimNextJob("worker-b", new Date("2026-09-25T00:00:01.001Z"), 1_000);

  assert.equal(claimedA.id, queued.job.id);
  assert.equal(claimedB.id, queued.job.id);
  assert.notEqual(claimedA.leaseToken, claimedB.leaseToken);
  assert.equal(await store.completeJob(claimedA.id, claimedA.leaseToken, kit(), new Date("2026-09-25T00:00:01.100Z")), false);
  assert.equal(await store.completeJob(claimedB.id, claimedB.leaseToken, kit(), new Date("2026-09-25T00:00:01.100Z")), true);
});

test("repeated expired leases stop at the attempt bound and require explicit retry", async () => {
  const store = new MemoryJobStore();
  const jobs = new JobService(store, { pipelineVersion: "pipeline-1", maxAttempts: 2 });
  const queued = await jobs.enqueue("owner-a", input, new Date("2026-09-25T00:00:00.000Z"));
  await store.claimNextJob("worker-a", new Date("2026-09-25T00:00:00.000Z"), 1_000);
  await store.claimNextJob("worker-b", new Date("2026-09-25T00:00:01.001Z"), 1_000);
  assert.equal(await store.claimNextJob("worker-c", new Date("2026-09-25T00:00:02.002Z"), 1_000), null);

  const failed = await jobs.getOwned("owner-a", queued.job.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error.code, "JOB_RECOVERY_EXHAUSTED");
  assert.equal((await jobs.retry("owner-a", failed.id)).status, "queued");
});

test("transient failures enter retry wait and are reclaimed after the durable delay", async () => {
  const store = new MemoryJobStore();
  const jobs = service(store);
  const queued = await jobs.enqueue("owner-a", input);
  let current = new Date("2026-09-25T00:00:00.000Z");
  let calls = 0;
  const runner = new JobRunner(store, async () => {
    calls += 1;
    if (calls === 1) {
      throw new GenerationError("PROVIDER_TEMPORARY", "The provider is temporarily unavailable.", {
        cause: Object.assign(new Error("temporary"), { retryable: true }),
      });
    }
    return kit();
  }, { workerId: "worker-a", leaseMs: 60_000, pollMs: 1_000, retryBaseMs: 1_000 }, () => current);

  await runner.runOnce();
  const waiting = await jobs.getOwned("owner-a", queued.job.id);
  assert.equal(waiting.status, "retry_wait");
  assert.equal(waiting.error.retryable, true);
  assert.equal(await runner.runOnce(), false);
  current = new Date("2026-09-25T00:00:01.001Z");
  assert.equal(await runner.runOnce(), true);
  assert.equal((await jobs.getOwned("owner-a", queued.job.id)).status, "completed");
});

test("permanent failure is actionable and explicit retry resets durable execution state", async () => {
  const store = new MemoryJobStore();
  const jobs = service(store);
  const queued = await jobs.enqueue("owner-a", input);
  const runner = new JobRunner(store, async () => {
    throw new GenerationError("INVALID_KIT", "The generated kit was incomplete.");
  }, { workerId: "worker-a", leaseMs: 60_000, pollMs: 1_000, retryBaseMs: 1_000 });

  await runner.runOnce();
  const failed = await jobs.getOwned("owner-a", queued.job.id);
  assert.equal(failed.status, "failed");
  assert.deepEqual(failed.error, {
    code: "INVALID_KIT",
    message: "The generated kit was incomplete.",
    retryable: false,
  });
  const retried = await jobs.retry("owner-a", failed.id);
  assert.equal(retried.status, "queued");
  assert.equal(retried.attempt, 0);
  await assert.rejects(jobs.retry("owner-b", failed.id), { name: "JobError", code: "NOT_FOUND" });
  await assert.rejects(jobs.retry("owner-a", failed.id), (error) =>
    error instanceof JobError && error.code === "JOB_NOT_RETRYABLE" && error.options.existingJobId === failed.id);
});
