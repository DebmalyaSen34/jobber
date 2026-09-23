import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createFixtureSite } from "./helpers/site.mjs";

/** Loopback-only test server. Port 0 selects an available port for integration tests. */
export async function startFixtureServer(port = 0) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid fixture port");
  const site = await createFixtureSite();
  const timers = new Set();
  const server = createServer((req, res) => {
    const response = site.respond(req.url);
    const send = () => { res.writeHead(response.status, response.headers); res.end(response.body); };
    if (!response.delay_ms) return send();
    const timer = setTimeout(() => { timers.delete(timer); send(); }, response.delay_ms);
    timers.add(timer);
    res.on("close", () => { clearTimeout(timer); timers.delete(timer); });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    requests: site.requests,
    async close() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const fixture = await startFixtureServer(Number(process.argv[2] ?? 8099));
  console.log(`Synthetic company fixtures: ${fixture.origin}`);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => { void fixture.close(); });
  }
}
