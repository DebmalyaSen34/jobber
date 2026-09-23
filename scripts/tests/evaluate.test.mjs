import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runCli } from "../../dist/scripts/evaluate.mjs";
import { GenerationError, runBatch, evaluationOutputSchema } from "@jobber/core";

const caseInput = (id, days = 1) => ({
  id, jd: "Required: TypeScript", company_url: "http://localhost:8099/acme/", days,
});

// Contract-only test double, never wired into the real command.
function kitFor(input) {
  return {
    source: { company: "", company_url: input.company_url, role: "", location: "", jd_chars: input.jd.length, researched_at: "2026-09-23T12:00:00Z", pages_used: [] },
    company_brief: { summary: "Research unavailable in test double", what_they_do: "", sources: [] },
    role: { title: "", seniority: "", responsibilities: [], requirements: [] },
    questions: [], flashcards: [],
    schedule: { days_available: input.days, days: Array.from({ length: input.days }, (_, i) => ({ day: i + 1, focus: "Clarify", question_ids: [], minutes: 0 })) },
    coverage: { uncovered_requirement_ids: [], passes: 0 },
    warnings: [{ code: "TEST_DOUBLE" }],
  };
}

async function files(t, input) {
  const dir = await mkdtemp(join(tmpdir(), "jobber-cli-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = join(dir, "input cases.json");
  const output = join(dir, "output kits.json");
  await writeFile(source, JSON.stringify(input));
  return { dir, source, output, args: ["--input", source, "--output", output] };
}

test("five mixed cases isolate failures and preserve IDs, inputs, days, and warnings", async () => {
  const inputs = [caseInput(" good ", 60), caseInput("bad-days", 0), caseInput("throw"), caseInput("bad-kit"), caseInput("last")];
  const called = [];
  const output = await runBatch(inputs, async (input) => {
    called.push(input);
    if (input.id === "throw") throw new Error("private credential must not leak");
    if (input.id === "bad-kit") return {};
    return kitFor(input);
  });
  assert.equal(evaluationOutputSchema.safeParse(output).success, true);
  assert.deepEqual(output.kits.map((entry) => entry.id), inputs.map((entry) => entry.id));
  assert.deepEqual(output.kits.map((entry) => entry.status), ["ok", "failed", "failed", "failed", "ok"]);
  assert.equal(output.kits[1].error.code, "INVALID_CASE");
  assert.equal(output.kits[2].error.code, "GENERATION_FAILED");
  assert.equal(output.kits[3].error.code, "INVALID_KIT");
  assert.deepEqual(called[0], inputs[0]);
  assert.equal(output.kits[0].kit.schedule.days.length, 60);
  assert.deepEqual(output.kits[0].kit.warnings, [{ code: "TEST_DOUBLE" }]);
  assert.equal(JSON.stringify(output).includes("private credential"), false);
});

test("known pipeline failures retain safe structured codes", async () => {
  const output = await runBatch([caseInput("a")], async () => {
    throw new GenerationError("PROVIDER_UNAVAILABLE", "Try again later.");
  });
  assert.deepEqual(output.kits[0].error, { code: "PROVIDER_UNAVAILABLE", message: "Try again later." });
});

test("CLI writes replacement JSON atomically, accepts spaces, and cleans temporary files", async (t) => {
  const f = await files(t, [caseInput("a")]);
  await writeFile(f.output, "old output");
  const diagnostics = [];
  const code = await runCli(f.args, async (input) => kitFor(input), (message) => diagnostics.push(message));
  assert.equal(code, 0);
  const output = JSON.parse(await readFile(f.output, "utf8"));
  assert.equal(output.kits[0].status, "ok");
  assert.match(diagnostics[0], /1 ok, 0 failed/);
  assert.equal((await readdir(f.dir)).some((name) => name.startsWith(".jobber-")), false);
});

test("bad JSON, top-level shape, missing IDs, and duplicate IDs preserve existing output", async (t) => {
  const f = await files(t, []);
  for (const content of ["{", "{}", '[{"jd":"x"}]', JSON.stringify([caseInput("a"), caseInput("a")])]) {
    await writeFile(f.source, content);
    await writeFile(f.output, "do not overwrite");
    let calls = 0;
    assert.equal(await runCli(f.args, async (input) => { calls++; return kitFor(input); }, () => {}), 1);
    assert.equal(calls, 0);
    assert.equal(await readFile(f.output, "utf8"), "do not overwrite");
  }
});

test("rejects missing, duplicate, unknown, and positional arguments", async () => {
  for (const args of [[], ["--input", "a"], ["--input", "a", "--output", "b", "--input", "c"], ["--input", "a", "--output", "b", "--unknown"], ["a", "b"]]) {
    const diagnostics = [];
    assert.equal(await runCli(args, undefined, (message) => diagnostics.push(message)), 1);
    assert.match(diagnostics[0], /^INVALID_ARGUMENTS:/);
  }
});

test("same-file and hardlink output cannot overwrite input", async (t) => {
  const f = await files(t, [caseInput("a")]);
  const original = await readFile(f.source, "utf8");
  await link(f.source, f.output);
  for (const output of [f.source, f.output]) {
    assert.equal(await runCli(["--input", f.source, "--output", output], undefined, () => {}), 1);
  }
  assert.equal(await readFile(f.source, "utf8"), original);
});

test("missing input and unwritable output destination return file-level errors", async (t) => {
  const f = await files(t, []);
  for (const [source, output, expected] of [
    [join(f.dir, "missing.json"), f.output, "INPUT_READ_FAILED"],
    [f.source, join(f.dir, "missing-dir", "out.json"), "OUTPUT_WRITE_FAILED"],
    [f.source, f.dir, "OUTPUT_WRITE_FAILED"],
  ]) {
    const diagnostics = [];
    assert.equal(await runCli(["--input", source, "--output", output], undefined, (message) => diagnostics.push(message)), 1);
    assert.match(diagnostics[0], new RegExp(`^${expected}:`));
  }
  assert.equal((await readdir(f.dir)).some((name) => name.startsWith(".jobber-")), false);
});

test("empty batches are valid and do not invoke generation", async (t) => {
  const f = await files(t, []);
  assert.equal(await runCli(f.args, async () => { throw new Error("must not run"); }, () => {}), 0);
  assert.deepEqual(JSON.parse(await readFile(f.output, "utf8")).kits, []);
});

test("actual executable reports unimplemented pipeline, exits 0 for case failures, writes diagnostics to stderr", async (t) => {
  const f = await files(t, [caseInput("a"), caseInput("b")]);
  const executable = fileURLToPath(new URL("../../dist/scripts/evaluate.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [executable, ...f.args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /0 ok, 2 failed/);
  const output = JSON.parse(await readFile(f.output, "utf8"));
  assert.equal(evaluationOutputSchema.safeParse(output).success, true);
  assert.deepEqual(output.kits.map((entry) => entry.error.code), ["PIPELINE_NOT_IMPLEMENTED", "PIPELINE_NOT_IMPLEMENTED"]);
  const bad = spawnSync(process.execPath, [executable], { encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /INVALID_ARGUMENTS/);
});
