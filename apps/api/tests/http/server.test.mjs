import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { createApp } from "../../dist/app.js";
import { loadConfig } from "../../dist/config.js";

class MemoryPersistence {
  users = new Map();
  sessions = new Map();
  jobs = new Map();
  kits = new Map();
  practiceRecords = new Map();
  nextUserId = 1;
  nextJobId = 1;

  async connect() {}
  async ping() {}
  async close() {}

  async createUser(email, passwordHash, now) {
    if (this.users.has(email)) return null;
    const user = { id: String(this.nextUserId++), email, passwordHash, createdAt: now };
    this.users.set(email, user);
    return user;
  }

  async findUserByEmail(email) {
    return this.users.get(email) ?? null;
  }

  async createSession(input) {
    this.sessions.set(input.id, input);
  }

  async findSessionWithUser(id) {
    const session = this.sessions.get(id);
    const user = session && [...this.users.values()].find((candidate) => candidate.id === session.userId);
    return session && user
      ? { id, user, csrfToken: session.csrfToken, expiresAt: session.expiresAt }
      : null;
  }

  async deleteSession(id) {
    this.sessions.delete(id);
  }

  async consumeLoginLimit() {
    return { allowed: true, retryAfterSeconds: 0 };
  }

  async clearLoginLimits() {}

  async enqueueJob(input) {
    const active = [...this.jobs.values()].find((job) =>
      job.ownerId === input.ownerId && job.fingerprint === input.fingerprint &&
      ["queued", "running", "retry_wait"].includes(job.status));
    if (active) return { job: active, deduplicated: true };
    const job = {
      id: `job-${this.nextJobId++}`,
      ownerId: input.ownerId,
      kitId: `kit-${this.nextJobId}`,
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

  async listOwnedKits(ownerId) {
    return [...this.kits.values()].filter((kit) => kit.ownerId === ownerId);
  }

  async findOwnedKit(ownerId, kitId) {
    const kit = this.kits.get(kitId);
    return kit?.ownerId === ownerId ? kit : null;
  }

  async updateOwnedKit(input) {
    const kit = await this.findOwnedKit(input.ownerId, input.kitId);
    if (!kit) return { kind: "not_found" };
    if (kit.revision !== input.expectedRevision) return { kind: "conflict", revision: kit.revision };
    kit.content = input.content;
    kit.metadata = input.metadata;
    kit.tombstones = input.tombstones;
    kit.lastReconciliation = input.reconciliation;
    kit.revision += 1;
    kit.updatedAt = input.now;
    return { kind: "updated", kit };
  }

  async listPracticeRecords(ownerId, kitId) {
    return [...this.practiceRecords.values()].filter((record) => record.ownerId === ownerId && record.kitId === kitId);
  }

  async recordPracticeReview(input) {
    const key = `${input.ownerId}:${input.kitId}:${input.cardId}`;
    const prior = this.practiceRecords.get(key);
    if (prior?.reviews.some(({ id }) => id === input.reviewId)) return prior;
    const next = {
      ownerId: input.ownerId, kitId: input.kitId, cardId: input.cardId,
      cardVersion: input.cardVersion, confidence: input.confidence,
      reviewCount: (prior?.reviewCount ?? 0) + 1, lastReviewedAt: input.now,
      reviews: [...(prior?.reviews ?? []), {
        id: input.reviewId, confidence: input.confidence, reviewedAt: input.now, cardVersion: input.cardVersion,
      }],
    };
    this.practiceRecords.set(key, next);
    return next;
  }

  async retryOwnedJob(ownerId, jobId, now) {
    const job = await this.findOwnedJob(ownerId, jobId);
    if (!job || job.status !== "failed") return null;
    job.status = "queued";
    job.stage = "queued";
    job.attempt = 0;
    job.updatedAt = now;
    delete job.error;
    return job;
  }

  async claimNextJob() { return null; }
  async renewJobLease() { return false; }
  async checkpointJob() { return false; }
  async completeJob() { return false; }
  async recordJobFailure() { return false; }
  async releaseJob() { return false; }
  async materializeCompletedKits() {}
}

async function listen(app) {
  const server = createServer(app);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

test("HTTP health/status flow handles readiness and blocked origins", async () => {
  let persistenceAvailable = true;
  const persistence = {
    connect: async () => {},
    ping: async () => {
      if (!persistenceAvailable) throw new Error("test outage");
    },
    close: async () => {},
  };
  const config = loadConfig({
    NODE_ENV: "test",
    MONGODB_URI: "mongodb://127.0.0.1:27017",
    WEB_ORIGINS: "http://localhost:3000",
    SESSION_SECRET: "test-session-secret-with-at-least-32-characters",
    BCRYPT_ROUNDS: "4",
  });
  const { server, origin } = await listen(createApp(config, persistence));

  try {
    const live = await fetch(`${origin}/health/live`);
    assert.equal(live.status, 200);
    assert.equal((await live.json()).status, "ok");

    const ready = await fetch(`${origin}/api/v1/status`, { headers: { Origin: "http://localhost:3000" } });
    assert.equal(ready.status, 200);
    assert.equal(ready.headers.get("access-control-allow-origin"), "http://localhost:3000");
    assert.equal((await ready.json()).persistence.status, "connected");

    const blocked = await fetch(`${origin}/api/v1/status`, { headers: { Origin: "https://evil.example" } });
    assert.equal(blocked.status, 403);

    persistenceAvailable = false;
    const unavailable = await fetch(`${origin}/health/ready`);
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), {
      status: "unavailable",
      error: { code: "PERSISTENCE_UNAVAILABLE" },
    });
  } finally {
    await close(server);
  }
});

test("HTTP auth flow enforces origin, session, CSRF, and logout invalidation", async () => {
  const config = loadConfig({
    NODE_ENV: "test",
    MONGODB_URI: "mongodb://127.0.0.1:27017",
    WEB_ORIGINS: "http://localhost:3000",
    SESSION_SECRET: "test-session-secret-with-at-least-32-characters",
    SESSION_TTL_HOURS: "1",
    BCRYPT_ROUNDS: "4",
  });
  const persistence = new MemoryPersistence();
  const { server, origin } = await listen(createApp(config, persistence));
  const browserOrigin = "http://localhost:3000";

  try {
    const rejected = await fetch(`${origin}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "person@example.com", password: "correct horse battery staple" }),
    });
    assert.equal(rejected.status, 403);
    assert.equal((await rejected.json()).error.code, "ORIGIN_REQUIRED");

    const registered = await fetch(`${origin}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: browserOrigin },
      body: JSON.stringify({ email: "Person@Example.COM", password: "correct horse battery staple" }),
    });
    assert.equal(registered.status, 201);
    const registrationBody = await registered.json();
    assert.equal(registrationBody.user.email, "person@example.com");
    assert.equal("passwordHash" in registrationBody.user, false);

    const setCookie = registered.headers.get("set-cookie");
    assert(setCookie);
    assert.match(setCookie, /^jobber_session=/);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Lax/i);
    const cookie = setCookie.split(";", 1)[0];

    const session = await fetch(`${origin}/api/v1/auth/session`, { headers: { Cookie: cookie } });
    assert.equal(session.status, 200);
    assert.equal(session.headers.get("cache-control"), "no-store");
    const sessionBody = await session.json();
    assert.equal(sessionBody.authenticated, true);
    assert.equal(sessionBody.user.email, "person@example.com");
    assert.equal(typeof sessionBody.csrfToken, "string");

    const account = await fetch(`${origin}/api/v1/account`, { headers: { Cookie: cookie } });
    assert.equal(account.status, 200);
    assert.equal((await account.json()).user.email, "person@example.com");

    const rejectedLogout = await fetch(`${origin}/api/v1/auth/logout`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: browserOrigin },
    });
    assert.equal(rejectedLogout.status, 403);
    assert.equal((await rejectedLogout.json()).error.code, "INVALID_CSRF");

    const loggedOut = await fetch(`${origin}/api/v1/auth/logout`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: browserOrigin, "X-CSRF-Token": sessionBody.csrfToken },
    });
    assert.equal(loggedOut.status, 204);

    const invalidated = await fetch(`${origin}/api/v1/account`, { headers: { Cookie: cookie } });
    assert.equal(invalidated.status, 401);
    assert.equal((await invalidated.json()).error.code, "UNAUTHENTICATED");
  } finally {
    await close(server);
  }
});

test("HTTP job flow enforces CSRF, active deduplication, validation, and ownership", async () => {
  const config = loadConfig({
    NODE_ENV: "test",
    MONGODB_URI: "mongodb://127.0.0.1:27017",
    WEB_ORIGINS: "http://localhost:3000",
    SESSION_SECRET: "test-session-secret-with-at-least-32-characters",
    BCRYPT_ROUNDS: "4",
  });
  const persistence = new MemoryPersistence();
  let wakeCount = 0;
  const { server, origin } = await listen(createApp(config, persistence, { notifyJobAvailable: () => wakeCount++ }));
  const browserOrigin = "http://localhost:3000";

  async function register(email) {
    const response = await fetch(`${origin}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: browserOrigin },
      body: JSON.stringify({ email, password: "correct horse battery staple" }),
    });
    assert.equal(response.status, 201);
    return {
      cookie: response.headers.get("set-cookie").split(";", 1)[0],
      body: await response.json(),
    };
  }

  try {
    const ownerA = await register("owner-a@example.com");
    const ownerB = await register("owner-b@example.com");
    const body = {
      jd: "Build reliable TypeScript APIs.",
      company_url: "https://example.com/careers",
      days: 5,
    };

    const noCsrf = await fetch(`${origin}/api/v1/kits`, {
      method: "POST",
      headers: { Cookie: ownerA.cookie, Origin: browserOrigin, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(noCsrf.status, 403);
    assert.equal((await noCsrf.json()).error.code, "INVALID_CSRF");

    const queued = await fetch(`${origin}/api/v1/kits`, {
      method: "POST",
      headers: {
        Cookie: ownerA.cookie,
        Origin: browserOrigin,
        "Content-Type": "application/json",
        "X-CSRF-Token": ownerA.body.csrfToken,
      },
      body: JSON.stringify(body),
    });
    assert.equal(queued.status, 202);
    assert.match(queued.headers.get("location"), /^\/api\/v1\/jobs\/job-/);
    const queuedBody = await queued.json();
    assert.equal(queuedBody.deduplicated, false);
    assert.equal(queuedBody.job.status, "queued");
    assert.equal("input" in queuedBody.job, false);
    assert.deepEqual(queuedBody.job.source, {
      companyUrl: "https://example.com/careers",
      days: 5,
      jdChars: 31,
    });

    const duplicate = await fetch(`${origin}/api/v1/kits`, {
      method: "POST",
      headers: {
        Cookie: ownerA.cookie,
        Origin: browserOrigin,
        "Content-Type": "application/json",
        "X-CSRF-Token": ownerA.body.csrfToken,
      },
      body: JSON.stringify(body),
    });
    const duplicateBody = await duplicate.json();
    assert.equal(duplicate.status, 202);
    assert.equal(duplicateBody.deduplicated, true);
    assert.equal(duplicateBody.job.id, queuedBody.job.id);
    assert.equal(wakeCount, 2);

    const listed = await fetch(`${origin}/api/v1/jobs`, { headers: { Cookie: ownerA.cookie } });
    assert.equal(listed.status, 200);
    assert.deepEqual((await listed.json()).jobs.map((job) => job.id), [queuedBody.job.id]);

    const batch = await fetch(`${origin}/api/v1/kits/batch`, {
      method: "POST",
      headers: {
        Cookie: ownerA.cookie,
        Origin: browserOrigin,
        "Content-Type": "application/json",
        "X-CSRF-Token": ownerA.body.csrfToken,
      },
      body: JSON.stringify([
        { id: "valid", ...body },
        { id: "bad-days", ...body, days: 0 },
        { id: "valid", ...body },
      ]),
    });
    assert.equal(batch.status, 202);
    const batchBody = await batch.json();
    assert.equal(batchBody.queuedCount, 1);
    assert.equal(batchBody.results[0].status, "queued");
    assert.equal(batchBody.results[0].deduplicated, true);
    assert.equal(batchBody.results[1].status, "invalid");
    assert.equal(batchBody.results[1].error.fields.days, "Days must be at least 1.");
    assert.equal(batchBody.results[2].error.code, "DUPLICATE_ID");
    assert.equal(wakeCount, 3);

    const owned = await fetch(`${origin}/api/v1/jobs/${queuedBody.job.id}`, { headers: { Cookie: ownerA.cookie } });
    assert.equal(owned.status, 200);
    assert.equal((await owned.json()).job.id, queuedBody.job.id);

    const hidden = await fetch(`${origin}/api/v1/jobs/${queuedBody.job.id}`, { headers: { Cookie: ownerB.cookie } });
    assert.equal(hidden.status, 404);
    assert.equal((await hidden.json()).error.code, "NOT_FOUND");

    persistence.kits.set(queuedBody.job.kitId, {
      id: queuedBody.job.kitId,
      ownerId: "1",
      sourceJobId: queuedBody.job.id,
      originalInput: { jd: body.jd, companyUrl: body.company_url, days: body.days },
      content: {
        source: { company: "Example", company_url: body.company_url, role: "Engineer", location: "", jd_chars: body.jd.length, researched_at: new Date().toISOString(), pages_used: [] },
        company_brief: { summary: "Example summary", what_they_do: "Builds examples.", sources: [] },
        role: { title: "Engineer", seniority: "", responsibilities: [], requirements: [] },
        questions: [], flashcards: [], schedule: { days_available: 5, days: [] },
        coverage: { uncovered_requirement_ids: [], passes: 0 },
      },
      revision: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const kitList = await fetch(`${origin}/api/v1/kits`, { headers: { Cookie: ownerA.cookie } });
    assert.equal(kitList.status, 200);
    assert.equal((await kitList.json()).kits[0].role, "Engineer");
    const ownedKit = await fetch(`${origin}/api/v1/kits/${queuedBody.job.kitId}`, { headers: { Cookie: ownerA.cookie } });
    assert.equal(ownedKit.status, 200);
    const ownedKitBody = await ownedKit.json();
    assert.equal(ownedKitBody.kit.originalInput.jd, body.jd);
    const hiddenKit = await fetch(`${origin}/api/v1/kits/${queuedBody.job.kitId}`, { headers: { Cookie: ownerB.cookie } });
    assert.equal(hiddenKit.status, 404);

    const editedContent = structuredClone(ownedKitBody.kit.content);
    editedContent.company_brief.summary = "A user-edited summary.";
    editedContent.role.requirements = [{ id: "manual-r1", text: "Explain TypeScript trade-offs", kind: "technical", priority: "must" }];
    editedContent.questions = [{
      id: "manual-q1",
      requirement_ids: ["manual-r1"],
      category: "technical",
      prompt: "How would you design the type boundary?",
      answer_outline: "Explain validation and inference.",
      difficulty: 2,
    }];
    editedContent.flashcards = [{
      id: "manual-card-1", front: "What is a type boundary?", back: "A validation boundary between typed and untyped data.", requirement_ids: ["manual-r1"],
    }];
    editedContent.schedule.days = Array.from({ length: 5 }, (_, index) => ({
      day: index + 1,
      focus: index === 0 ? "Type boundaries" : "Review",
      question_ids: ["manual-q1"],
      minutes: 20,
    }));
    const saved = await fetch(`${origin}/api/v1/kits/${queuedBody.job.kitId}`, {
      method: "PATCH",
      headers: {
        Cookie: ownerA.cookie,
        Origin: browserOrigin,
        "Content-Type": "application/json",
        "X-CSRF-Token": ownerA.body.csrfToken,
      },
      body: JSON.stringify({ revision: 1, content: editedContent }),
    });
    assert.equal(saved.status, 200);
    const savedBody = await saved.json();
    assert.equal(savedBody.kit.revision, 2);
    assert.equal(savedBody.kit.content.company_brief.summary, "A user-edited summary.");
    assert.deepEqual(savedBody.kit.content.coverage.uncovered_requirement_ids, []);

    const initialPractice = await fetch(`${origin}/api/v1/kits/${queuedBody.job.kitId}/practice`, {
      headers: { Cookie: ownerA.cookie },
    });
    assert.equal(initialPractice.status, 200);
    assert.deepEqual((await initialPractice.json()).practice.counts, { unseen: 1, reviewed: 0, total: 1 });

    const rejectedReview = await fetch(`${origin}/api/v1/kits/${queuedBody.job.kitId}/practice/reviews`, {
      method: "POST",
      headers: { Cookie: ownerA.cookie, Origin: browserOrigin, "Content-Type": "application/json" },
      body: JSON.stringify({ review_id: "00000000-0000-4000-8000-000000000001", card_id: "manual-card-1", confidence: "unsure" }),
    });
    assert.equal(rejectedReview.status, 403);

    const recordedReview = await fetch(`${origin}/api/v1/kits/${queuedBody.job.kitId}/practice/reviews`, {
      method: "POST",
      headers: { Cookie: ownerA.cookie, Origin: browserOrigin, "Content-Type": "application/json", "X-CSRF-Token": ownerA.body.csrfToken },
      body: JSON.stringify({ review_id: "00000000-0000-4000-8000-000000000001", card_id: "manual-card-1", confidence: "unsure" }),
    });
    assert.equal(recordedReview.status, 201);
    assert.deepEqual((await recordedReview.json()).practice.counts, { unseen: 0, reviewed: 1, total: 1 });

    const hiddenPractice = await fetch(`${origin}/api/v1/kits/${queuedBody.job.kitId}/practice`, {
      headers: { Cookie: ownerB.cookie },
    });
    assert.equal(hiddenPractice.status, 404);

    const staleSave = await fetch(`${origin}/api/v1/kits/${queuedBody.job.kitId}`, {
      method: "PATCH",
      headers: {
        Cookie: ownerA.cookie,
        Origin: browserOrigin,
        "Content-Type": "application/json",
        "X-CSRF-Token": ownerA.body.csrfToken,
      },
      body: JSON.stringify({ revision: 1, content: editedContent }),
    });
    assert.equal(staleSave.status, 409);
    assert.equal((await staleSave.json()).error.code, "KIT_REVISION_CONFLICT");

    const danglingContent = structuredClone(savedBody.kit.content);
    danglingContent.questions[0].requirement_ids = ["missing-requirement"];
    const reconciledSave = await fetch(`${origin}/api/v1/kits/${queuedBody.job.kitId}`, {
      method: "PATCH",
      headers: {
        Cookie: ownerA.cookie,
        Origin: browserOrigin,
        "Content-Type": "application/json",
        "X-CSRF-Token": ownerA.body.csrfToken,
      },
      body: JSON.stringify({ revision: 2, content: danglingContent }),
    });
    assert.equal(reconciledSave.status, 200);
    const reconciledBody = await reconciledSave.json();
    assert.deepEqual(reconciledBody.kit.content.questions[0].requirement_ids, []);
    assert.equal(reconciledBody.kit.reconciliation.removedQuestionRequirementLinks, 1);
    assert.deepEqual(reconciledBody.kit.derivedState.uncovered_must_requirement_ids, ["manual-r1"]);

    const crossOwnerSave = await fetch(`${origin}/api/v1/kits/${queuedBody.job.kitId}`, {
      method: "PATCH",
      headers: {
        Cookie: ownerB.cookie,
        Origin: browserOrigin,
        "Content-Type": "application/json",
        "X-CSRF-Token": ownerB.body.csrfToken,
      },
      body: JSON.stringify({ revision: 2, content: editedContent }),
    });
    assert.equal(crossOwnerSave.status, 404);

    const activeRetry = await fetch(`${origin}/api/v1/jobs/${queuedBody.job.id}/retry`, {
      method: "POST",
      headers: { Cookie: ownerA.cookie, Origin: browserOrigin, "X-CSRF-Token": ownerA.body.csrfToken },
    });
    assert.equal(activeRetry.status, 409);
    const activeRetryBody = await activeRetry.json();
    assert.equal(activeRetryBody.error.code, "JOB_NOT_RETRYABLE");
    assert.equal(activeRetryBody.error.details.existingJobId, queuedBody.job.id);

    const invalid = await fetch(`${origin}/api/v1/kits`, {
      method: "POST",
      headers: {
        Cookie: ownerA.cookie,
        Origin: browserOrigin,
        "Content-Type": "application/json",
        "X-CSRF-Token": ownerA.body.csrfToken,
      },
      body: JSON.stringify({ ...body, days: 61 }),
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.fields.days, "Days must be at most 60.");
  } finally {
    await close(server);
  }
});
