import assert from "node:assert/strict";
import { test } from "node:test";
import bcrypt from "bcryptjs";
import { AuthError, AuthService, assertOwner } from "../dist/auth.js";

class MemoryAuthStore {
  users = new Map();
  sessions = new Map();
  limits = new Map();
  nextUserId = 1;

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
    if (!session) return null;
    const user = [...this.users.values()].find((candidate) => candidate.id === session.userId);
    if (!user) return null;
    return { id, user, csrfToken: session.csrfToken, expiresAt: session.expiresAt };
  }

  async deleteSession(id) {
    this.sessions.delete(id);
  }

  consume(key, limit, now, windowMs) {
    const cutoff = now.getTime() - windowMs;
    const attempts = (this.limits.get(key) ?? []).filter((attempt) => attempt.getTime() >= cutoff);
    attempts.push(now);
    this.limits.set(key, attempts);
    return {
      allowed: attempts.length <= limit,
      retryAfterSeconds: attempts.length > limit
        ? Math.max(1, Math.ceil((attempts[0].getTime() + windowMs - now.getTime()) / 1_000))
        : 0,
    };
  }

  async consumeLoginLimit(input) {
    const email = this.consume(input.emailKey, input.emailLimit, input.now, input.windowMs);
    const ip = this.consume(input.ipKey, input.ipLimit, input.now, input.windowMs);
    return {
      allowed: email.allowed && ip.allowed,
      retryAfterSeconds: Math.max(email.retryAfterSeconds, ip.retryAfterSeconds),
    };
  }

  async clearLoginLimits(emailKey, ipKey) {
    this.limits.delete(emailKey);
    this.limits.delete(ipKey);
  }
}

function createHarness(overrides = {}) {
  const store = new MemoryAuthStore();
  const auth = new AuthService(store, {
    secret: "test-session-secret-with-at-least-32-characters",
    sessionTtlMs: 60_000,
    bcryptRounds: 4,
    loginWindowMs: 60_000,
    loginEmailLimit: 2,
    loginIpLimit: 20,
    ...overrides,
  });
  return { auth, store };
}

async function expectAuthError(promise, code, status) {
  await assert.rejects(promise, (error) => {
    assert(error instanceof AuthError);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    return true;
  });
}

test("registration normalizes email, hashes the password, and issues an opaque session", async () => {
  const { auth, store } = createHarness();
  const now = new Date("2026-09-24T10:00:00.000Z");
  const issued = await auth.register({ email: "  Person@Example.COM ", password: "correct horse battery staple" }, now);
  const user = store.users.get("person@example.com");

  assert(user);
  assert.notEqual(user.passwordHash, "correct horse battery staple");
  assert.equal(await bcrypt.compare("correct horse battery staple", user.passwordHash), true);
  assert.notEqual(issued.token, issued.session.id);
  assert.equal(issued.session.user.email, "person@example.com");
  assert.equal(issued.session.expiresAt.toISOString(), "2026-09-24T10:01:00.000Z");
});

test("registration rejects duplicates and invalid password input", async () => {
  const { auth } = createHarness();
  const credentials = { email: "person@example.com", password: "correct horse battery staple" };
  await auth.register(credentials);
  await expectAuthError(auth.register(credentials), "EMAIL_IN_USE", 409);
  await expectAuthError(auth.register({ email: "person@example.com", password: "too-short" }), "INVALID_INPUT", 400);
});

test("login uses a generic credential error and throttles repeated attempts", async () => {
  const { auth } = createHarness();
  const now = new Date("2026-09-24T10:00:00.000Z");
  await auth.register({ email: "person@example.com", password: "correct horse battery staple" }, now);

  await expectAuthError(
    auth.login({ email: "person@example.com", password: "wrong password but long enough" }, "192.0.2.10", now),
    "INVALID_CREDENTIALS",
    401,
  );
  await expectAuthError(
    auth.login({ email: "missing@example.com", password: "wrong password but long enough" }, "192.0.2.11", now),
    "INVALID_CREDENTIALS",
    401,
  );
  await expectAuthError(
    auth.login({ email: "person@example.com", password: "wrong password but long enough" }, "192.0.2.10", now),
    "INVALID_CREDENTIALS",
    401,
  );
  await expectAuthError(
    auth.login({ email: "person@example.com", password: "wrong password but long enough" }, "192.0.2.10", now),
    "LOGIN_THROTTLED",
    429,
  );
});

test("successful login clears counters and session logout is immediately authoritative", async () => {
  const { auth, store } = createHarness();
  const credentials = { email: "person@example.com", password: "correct horse battery staple" };
  await auth.register(credentials);
  const issued = await auth.login(credentials, "192.0.2.10");

  assert.equal(store.limits.size, 0);
  assert.equal((await auth.resolveSession(issued.token)).kind, "authenticated");
  assert.doesNotThrow(() => auth.verifyCsrf(issued.session, issued.session.csrfToken));
  assert.throws(() => auth.verifyCsrf(issued.session, "incorrect-token"), { name: "AuthError", code: "INVALID_CSRF" });

  await auth.logout(issued.token);
  assert.equal((await auth.resolveSession(issued.token)).kind, "missing");
});

test("expired sessions are deleted and ownership failures do not reveal resource existence", async () => {
  const { auth, store } = createHarness({ sessionTtlMs: 1_000 });
  const issuedAt = new Date("2026-09-24T10:00:00.000Z");
  const issued = await auth.register(
    { email: "person@example.com", password: "correct horse battery staple" },
    issuedAt,
  );

  assert.equal((await auth.resolveSession(issued.token, new Date(issuedAt.getTime() + 1_001))).kind, "expired");
  assert.equal(store.sessions.size, 0);
  assert.doesNotThrow(() => assertOwner("user-a", "user-a"));
  assert.throws(() => assertOwner("user-a", "user-b"), { name: "AuthError", code: "NOT_FOUND", status: 404 });
});
