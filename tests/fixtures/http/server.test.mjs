import assert from "node:assert/strict";
import test from "node:test";
import { startFixtureServer } from "../serve.mjs";

test("loopback HTTP server serves real responses, redirects, retries, and abortable delays", async (t) => {
  const server = await startFixtureServer();
  t.after(() => server.close());
  const get = (path, options) => fetch(server.origin + path, options);
  assert.match(await (await get("/acme/")).text(), /Acme Tools/);
  assert.equal((await get("/failures/missing")).status, 404);
  assert.match(await (await get("/failures/redirect")).text(), /Acme Tools/);
  const limited = await get("/failures/rate-limited");
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "1");
  assert.equal((await get("/failures/rate-limited")).status, 200);
  await assert.rejects(() => get("/failures/slow", { signal: AbortSignal.timeout(50) }), { name: "TimeoutError" });
  assert.ok(server.requests.includes("/failures/slow"));
  // Never follow the private-address redirect fixture; inspect it manually.
  const privateRedirect = await get("/failures/private-redirect", { redirect: "manual" });
  assert.equal(privateRedirect.status, 302);
  assert.equal(privateRedirect.headers.get("location"), "http://169.254.169.254/latest/meta-data/");
});
