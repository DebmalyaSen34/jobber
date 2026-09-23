import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);

export async function readFixture(path) {
  return readFile(new URL(path, root), "utf8");
}

export async function readFixtureJson(path) {
  return JSON.parse(await readFixture(path));
}

export async function loadCases(origin = "http://localhost:8099") {
  const manifest = await readFixtureJson("cases.json");
  return Promise.all(manifest.map(async (entry) => ({
    input: {
      id: entry.id, jd: await readFixture(entry.jd_file),
      company_url: new URL(entry.company_path, origin).href, days: entry.days,
    },
    expected: await readFixtureJson(entry.expected_file),
  })));
}
