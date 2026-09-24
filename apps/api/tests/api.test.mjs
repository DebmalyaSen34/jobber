import assert from "node:assert/strict";
import { test } from "node:test";
import { createStatusPayload, isOriginAllowed } from "../dist/app.js";
import { loadConfig } from "../dist/config.js";

const baseEnvironment = {
  NODE_ENV: "test",
  MONGODB_URI: "mongodb://127.0.0.1:27017",
  WEB_ORIGINS: "http://localhost:3000,https://jobber.example",
  SESSION_SECRET: "test-session-secret-with-at-least-32-characters",
  BCRYPT_ROUNDS: "4",
};

test("configuration parses exact origins and never echoes secret values", () => {
  const config = loadConfig(baseEnvironment);
  assert.deepEqual(config.webOrigins, ["http://localhost:3000", "https://jobber.example"]);

  const secret = "mongodb://user:do-not-leak@example.invalid/jobber";
  assert.throws(
    () => loadConfig({ ...baseEnvironment, MONGODB_URI: secret, WEB_ORIGINS: "not-an-origin" }),
    (error) => error instanceof Error && error.message.includes("WEB_ORIGINS") && !error.message.includes(secret),
  );
});

test("production requires server-side persistence, provider, and session settings", () => {
  assert.throws(() => loadConfig({ NODE_ENV: "production", WEB_ORIGINS: "https://jobber.example" }), (error) => {
    assert(error instanceof Error);
    assert.match(error.message, /SESSION_SECRET/);
    assert.match(error.message, /MONGODB_URI/);
    assert.match(error.message, /GEMINI_API_KEY/);
    return true;
  });
});

test("origin policy is exact and server-to-server requests remain available", () => {
  assert.equal(isOriginAllowed(undefined, ["https://jobber.example"]), true);
  assert.equal(isOriginAllowed("https://jobber.example", ["https://jobber.example"]), true);
  assert.equal(isOriginAllowed("https://evil.example", ["https://jobber.example"]), false);
});

test("status payload exposes capability, not connection details", () => {
  assert.deepEqual(createStatusPayload("release-1"), {
    status: "ready",
    service: "jobber-api",
    release: "release-1",
    persistence: { provider: "mongodb", status: "connected" },
  });
});
