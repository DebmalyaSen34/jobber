import assert from "node:assert/strict";
import test from "node:test";
import { allocateSchedule, checkCoverage, evaluationCaseSchema, kitSchema, questionSchema, requirementSchema, validateKit } from "@jobber/core";
import { loadCases, readFixtureJson } from "./helpers/load.mjs";
import { scriptedProvider } from "./helpers/provider.mjs";
import { createFixtureSite } from "./helpers/site.mjs";

test("six JD fixtures have unique identities, valid cases, exact evidence, and independent expectations", async () => {
  const cases = await loadCases();
  assert.equal(cases.length, 6);
  assert.equal(new Set(cases.map((c) => c.input.id)).size, cases.length);
  for (const { input, expected } of cases) {
    evaluationCaseSchema.parse(input);
    for (const requirement of expected.requirements) {
      requirementSchema.parse(requirement);
      const { start, end, quote } = requirement.evidence;
      assert.equal(input.jd.slice(start, end), quote);
    }
    assert.ok(expected.review_notes.length);
  }
  const backend = cases.find((c) => c.input.id === "backend");
  assert.equal(backend.expected.requirements.filter((r) => r.priority === "nice").length, 1);
  assert.ok(backend.expected.requirements.some((r) => r.text.includes("Python or Java")));
  assert.equal(cases.find((c) => c.input.id === "thin").expected.requirements.length, 0);
  assert.equal(cases.find((c) => c.input.id === "injection").expected.requirements.length, 1);
});

test("saved first-pass and repair responses close exactly the declared coverage gap", async () => {
  const fixture = await readFixtureJson("providers/coverage-repair.json");
  const { input, expected } = (await loadCases()).find((c) => c.input.id === fixture.case_id);
  fixture.first_pass.forEach((q) => questionSchema.parse(q));
  fixture.repair_pass.forEach((q) => questionSchema.parse(q));
  assert.deepEqual(checkCoverage(expected.requirements, fixture.first_pass).uncovered_requirement_ids, fixture.expected_gap_ids);
  const questions = [...fixture.first_pass, ...fixture.repair_pass];
  const coverage = checkCoverage(expected.requirements, questions);
  assert.deepEqual(coverage.uncovered_requirement_ids, fixture.expected_final_gap_ids);
  const kit = {
    source: { company: "Acme Tools", company_url: input.company_url, role: "Senior Backend Engineer", location: "Remote within India", jd_chars: input.jd.length, researched_at: "2026-09-23T12:00:00Z", pages_used: [] },
    company_brief: { summary: "Synthetic fixture", what_they_do: "Inventory APIs", sources: [] },
    role: { title: "Senior Backend Engineer", seniority: "Senior", responsibilities: [], requirements: expected.requirements },
    questions, flashcards: [], schedule: allocateSchedule(expected.requirements, questions, input.days),
    coverage: { uncovered_requirement_ids: coverage.uncovered_requirement_ids, passes: 2 },
  };
  assert.equal(validateKit(kit, { requestedDays: input.days }).success, true);
  // This only assembles canned responses. It does not claim a real model repair loop ran.
});

test("provider scripts preserve retry, malformed JSON, auth, timeout, and search distinctions", async () => {
  const provider = await scriptedProvider("rate_limit_then_success");
  const first = await provider.next({ stage: "extract" });
  assert.equal(first.status, 429);
  assert.equal(first.headers["retry-after"], "1");
  assert.equal((await provider.next({ stage: "extract" })).status, 200);
  await assert.rejects(() => provider.next({}), /exhausted/);
  assert.equal(provider.requests.length, 2);
  const fresh = await scriptedProvider("rate_limit_then_success");
  assert.equal((await fresh.next({})).status, 429);
  const malformed = await scriptedProvider("invalid_json_then_success");
  const bad = await malformed.next({});
  assert.throws(() => JSON.parse(bad.body));
  assert.ok(JSON.parse((await malformed.next({})).body).summary);
  const incomplete = await scriptedProvider("incomplete_kit");
  assert.equal(kitSchema.safeParse(JSON.parse((await incomplete.next({})).body)).success, false);
  assert.equal((await (await scriptedProvider("permanent_auth_failure")).next({})).status, 401);
  assert.equal((await (await scriptedProvider("provider_timeout")).next({})).delay_ms, 10000);
  assert.deepEqual(JSON.parse((await (await scriptedProvider("public_discussion_empty")).next({})).body).hits, []);
  assert.equal((await (await scriptedProvider("public_discussion_failure")).next({})).status, 503);
  const temporary = await scriptedProvider("temporary_failure");
  assert.equal((await temporary.next({})).status, 503);
  assert.equal((await temporary.next({})).status, 200);
});

test("nested hiring chain resolves actual relative links; no-hiring graph is closed", async () => {
  const site = await createFixtureSite();
  const expected = await readFixtureJson("sites/expected.json");
  const origin = "http://localhost:8099";
  for (let i = 0; i < expected.discovery_chain.length - 1; i++) {
    const path = expected.discovery_chain[i];
    const links = [...site.respond(path).body.matchAll(/href="([^"]+)"/g)].map((m) => new URL(m[1], origin + path).pathname);
    assert.ok(links.includes(expected.discovery_chain[i + 1]));
  }
  const hiring = site.respond(expected.hiring_path).body;
  expected.official_rounds.forEach((round) => assert.ok(hiring.includes(round)));
  for (const path of expected.no_hiring_paths) {
    const response = site.respond(path);
    assert.equal(response.status, 200);
    for (const match of response.body.matchAll(/href="([^"]+)"/g)) {
      assert.ok(expected.no_hiring_paths.includes(new URL(match[1], origin + path).pathname));
    }
  }
});

test("site fixtures expose controlled failures, robots rules, injection, and isolated request histories", async () => {
  const site = await createFixtureSite();
  assert.match(site.respond("/robots.txt").body, /Disallow: \/blocked\//);
  assert.equal(site.respond("/failures/missing").status, 404);
  assert.equal(site.respond("/unknown").status, 404);
  assert.equal(site.respond("/failures/slow").delay_ms, 10000);
  assert.equal(site.respond("/failures/redirect").headers.location, "/acme/");
  assert.equal(site.respond("/failures/loop").headers.location, "/failures/loop");
  assert.equal(site.respond("/failures/private-redirect").headers.location, "http://169.254.169.254/latest/meta-data/");
  assert.equal(site.respond("/failures/wrong-type").headers["content-type"], "application/octet-stream");
  assert.equal(site.respond("/failures/oversized").body.length, 2097152);
  assert.match(site.respond("/hostile/").body, /Ignore all previous instructions/);
  assert.equal(site.respond("/failures/rate-limited").status, 429);
  assert.equal(site.respond("/failures/rate-limited").status, 200);
  const fresh = await createFixtureSite();
  assert.deepEqual(fresh.requests, []);
  assert.equal(fresh.respond("/failures/rate-limited").status, 429);
});
