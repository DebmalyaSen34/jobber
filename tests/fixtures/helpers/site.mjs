import { readFixtureJson } from "./load.mjs";

/** Fresh state for each test/server. No external URL is ever fetched. */
export async function createFixtureSite() {
  const routes = await readFixtureJson("sites/routes.json");
  const requests = [];
  const counts = new Map();
  return {
    requests,
    respond(url) {
      const path = new URL(url, "http://fixture.invalid").pathname;
      requests.push(path);
      const route = routes[path] ?? { status: 404, body: "Not found" };
      const count = counts.get(path) ?? 0;
      counts.set(path, count + 1);
      const response = route.responses
        ? route.responses[Math.min(count, route.responses.length - 1)]
        : route;
      return {
        status: response.status ?? 200,
        headers: { "content-type": response.content_type ?? "text/html; charset=utf-8", ...response.headers },
        body: (response.body ?? "").repeat(response.body_repeat ?? 1),
        delay_ms: response.delay_ms ?? 0,
      };
    },
  };
}
