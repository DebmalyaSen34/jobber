import { readFixtureJson } from "./load.mjs";

/** Transport-level test double. No credentials, SDK, retries, or fake production mode. */
export async function scriptedProvider(name) {
  const scenarios = await readFixtureJson("providers/scenarios.json");
  const script = scenarios[name];
  if (!script) throw new Error(`Unknown provider fixture: ${name}`);
  const requests = [];
  return {
    requests,
    async next(request) {
      if (requests.length >= script.length) throw new Error(`Provider fixture exhausted: ${name}`);
      const response = structuredClone(script[requests.length]);
      requests.push(structuredClone(request));
      return response;
    },
  };
}
