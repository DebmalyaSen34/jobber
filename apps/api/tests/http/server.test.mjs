import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { createApp } from "../../dist/app.js";
import { loadConfig } from "../../dist/config.js";

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
  });
  const server = createServer(createApp(config, persistence));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address();
    assert(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;

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
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
