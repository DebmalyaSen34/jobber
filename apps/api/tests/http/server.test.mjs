import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { createApp } from "../../dist/app.js";
import { loadConfig } from "../../dist/config.js";

class MemoryPersistence {
  users = new Map();
  sessions = new Map();
  nextUserId = 1;

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
