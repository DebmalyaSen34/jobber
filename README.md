# Jobber — AI Interview Prep Kit

Implementation follows the assessment PRD in the parent workspace (`../PRD.md`). **M1 tasks 1–4** are complete: the TypeScript workspace, shared schemas, evaluation CLI contract, deterministic coverage/scheduling, relational validation, and reusable synthetic fixtures. **M2 task 1** is also complete: secure company retrieval and ranked crawling. Public-discussion search, real extraction/generation, authentication, and product UI are not implemented yet.

## Setup

Tested runtime: Node.js **22.17.0**, npm **11.15.0**. Use `nvm use` if nvm is installed. The committed lockfile fixes dependency resolutions.

```bash
npm ci
npm run dev
```

Run commands from this repository root. The frontend remains available at `http://localhost:3000`.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Build shared core and start the Next.js development server |
| `npm run build` | Build core declarations/JavaScript and the production frontend |
| `npm start` | Serve the built frontend |
| `npm run lint` | Lint workspace sources |
| `npm run typecheck` | Build core, generate Next.js route types, and check packages and CLI |
| `npm test` | Run schema and CLI/batch contract tests using Node's test runner |
| `npm run test:cli` | Compile and run CLI/batch tests only |
| `npm run build:cli` | Compile core and the TypeScript CLI |
| `npm run check` | Lint, typecheck, and all network-free tests |
| `npm run test:fixtures` | Verify synthetic JDs, provider responses, and company-site fixtures |
| `npm run fixtures:serve` | Serve synthetic company sites on loopback port 8099 |
| `npm run test:fixtures:http` | Verify the real loopback fixture server (requires local port permission) |
| `npm run test:retrieval:http` | Verify real retrieval sockets, security controls, and crawling on local fixtures |

## Evaluation CLI

```bash
npm run evaluate -- --input examples/evaluation-cases.json --output kits.json
```

`preevaluate` builds core and CLI automatically, so no manual compilation, running server, login, or database setup is required. No credentials are needed at this stage because provider integration does not exist yet. Provider environment variables and `.env.example` will be added with M2.

**Current limitation:** each valid case returns `status: "failed"` with `error.code: "PIPELINE_NOT_IMPLEMENTED"`. This is a working CLI contract, not a working research/generation pipeline. The actual command invokes the shared `generateKit` entry point; successful kits are exercised only through clearly identified test doubles. No mock-generation mode is exposed in the CLI.

Behavior:

- Requires exactly one `--input` and one `--output`; supports paths with spaces and `--input=...` syntax. Rejects unknown options and positional arguments.
- Reads a JSON array and preserves case IDs and original JD text. Cases execute sequentially.
- Missing/blank/non-string IDs and duplicate IDs are file-level errors: the runner cannot report results with unambiguous original identities. These are checked before generation.
- Other invalid case fields produce `INVALID_CASE`; subsequent cases continue. Unexpected pipeline exceptions become `GENERATION_FAILED` without exposing raw exception text.
- Returned kits pass `validateKit` in generated mode before output: structure, unique IDs, valid references, exact requested days, honest coverage, and scheduled coverage. Invalid/incomplete kits become `INVALID_KIT` without stopping subsequent cases.
- Writes the exact version `1.0` envelope with an ISO timestamp and one result per identifiable input case. An empty array produces an empty result list.
- Writes via a temporary file and atomic rename, preserving existing output on input/validation/write failure. The output parent directory must already exist. Input and output cannot refer to the same file, including symlink/hardlink aliases.
- Exit **0** means the batch completed and its output was written, even if all cases failed. Inspect each case's status. Exit **1** means invalid invocation, invalid input file/identities, or an output/file-level failure.
- CLI diagnostics go to stderr; the result file contains JSON only. npm itself may print lifecycle banners to stdout.

Example failures such as `PIPELINE_NOT_IMPLEMENTED` are not benchmark evidence. The five-case live-provider/15-minute requirement remains unverified until M2.

## Structure

```text
apps/web/          Existing Next.js + Tailwind frontend
packages/core/    Shared schemas, batch runner, and pipeline entry point
scripts/          TypeScript CLI and integration tests
examples/         Sample batch input (not a live benchmark)
```

The Express backend will be added under `apps/api` in a later milestone. Existing frontend files were moved without changing the starter UI.

Import shared contracts from `@jobber/core`. The package exports compiled ESM and TypeScript declarations; root development/build/check commands build it first. After changing core while the frontend is already running, run `npm run build --workspace=@jobber/core` to refresh its compiled output.

## Schema boundaries

`kitSchema` implements Appendix A fields and preserves extension data such as warnings and requirement evidence. `evaluationCaseSchema`, `evaluationInputSchema`, and `evaluationOutputSchema` describe Appendix B. Types are inferred from runtime schemas to avoid divergent copies.

These schemas enforce **shape**, enums, required fields, and integer constraints. Use `validateKit(input, { requestedDays, mode })` for relational validation and completeness. Passing structural validation alone does not establish that a kit is complete.

Unknown company information can remain empty. A case's company URL is retained as text so invalid/unreachable research can later become a warning instead of aborting a useful kit. Source URLs actually used must be HTTP(S). URL syntax validation is not SSRF protection; the server-only retrieval module now enforces production public-address restrictions and explicit trusted loopback-origin exceptions. The original JD is retained without whitespace normalization for evidence offsets and character accounting.

## Verification

Schema tests cover thin kits, preserved warning extensions, integer durations, missing fields, exact question categories, outline types, local input URLs, day validation, and the success/failure output union. Live-provider quality and runtime benchmarks will be added once the pipeline exists.

M1 task 2 adds nine CLI/batch tests covering mixed-case isolation, invalid generated output, safe structured errors, argument errors, malformed JSON, duplicate/missing identities, atomic replacement, file aliases, inaccessible destinations, empty batches, and executable exit codes/stderr. All 14 tests, lint, and package/CLI type checks pass.

Verified for M1 task 1: lint, both package type checks, five schema tests, package import resolution, and a production build using `npm run build --workspace=@jobber/web -- --webpack`. The default Turbopack build could not finish in the restricted agent environment because its internal worker port binding was denied. The default build configuration remains unchanged. The starter's Google fonts also require network access during a fresh build.

## Deterministic core (M1 task 3)

All functions are exported from `@jobber/core`; no model, database, network, clock, or filesystem is used for coverage/allocation decisions.

- `checkCoverage(requirements, questions)` validates input shapes and entity uniqueness, rejects unknown requirement references, and returns covered IDs, all uncovered IDs, and uncovered must-have IDs. It does not judge semantic question relevance or increment generation passes. The real targeted generation/repair loop remains M2 work.
- `allocateSchedule(requirements, questions, daysAvailable)` refuses uncovered must-haves. It estimates 10/20/30 minutes by question difficulty, sorts by number of distinct must-have requirements covered (descending), then difficulty (descending), then ID (lexical). Inputs are never mutated.
- First exposure uses `min(questionCount, ceil(daysAvailable * 0.6))` learning days. A question's day index is `floor(previouslyAllocatedMinutes * learningDays / totalMinutes)`, capped to that window. This preserves priority order and approximately balances new work; it does not impose an invented daily time limit.
- Days without new questions review one already introduced question: least recently studied first, with the same priority order as the stable tie-break. Review uses the same 10/20/30-minute estimate. One day contains all material; long schedules reuse actual question IDs. Empty material creates exactly N zero-minute clarification days. Focus text is derived from categories in code.
- `validateKit` returns either `{ success: true, data, warnings }` or `{ success: false, errors, warnings }`, with structured issue codes and paths. It validates unique entities and reference lists, existing references, consecutive day numbers, requested day count, and freshly computed coverage. Repeating a question on different days is allowed; repeating it within one day is rejected.
- Default `generated` mode rejects uncovered must-haves, unscheduled must-haves, and any unscheduled question. Honest nice-have coverage gaps can remain. `draft` mode turns incompleteness into actionable warnings, but still rejects dangling references, malformed structure, and stale coverage. Later editor work must recompute coverage and remove dangling links before saving a valid draft.

M1 task 3 verification: `npm run check` passes all **26 tests** (17 core + 9 CLI), lint, and package/CLI type checks. Tests cover explicit 1/5/60-day cases, priority and immutability, draft-versus-generated rules, malformed references/IDs/days, batch rejection of invalid kits, and an invariant sweep over 240 combinations of material count and days. No live-provider benchmark or new frontend production build was performed.

## Reusable fixtures (M1 task 4)

See [tests/fixtures/README.md](tests/fixtures/README.md) for the scenario catalog, helpers, server routes, and M2 integration instructions.

- Six synthetic JDs cover must/nice wording, experience thresholds, alternatives, mentoring, thin inputs, missing company research, and prompt injection. Expected requirements include exact evidence quotes/offsets and human-review notes.
- Provider-neutral scripts cover rate limits, malformed JSON, incomplete kits, temporary/auth failures, delayed responses, empty public discussion, and search failures. A first-pass/repair pair deliberately closes a mentoring gap.
- Company routes cover nested relative-link hiring discovery, a closed no-hiring site, robots restrictions, hostile content, 404, timeouts, redirects/loops/private destinations, unexpected content types, oversized bodies, and retry recovery.
- `loadCases(origin)` supports an ephemeral test-server origin. Provider and site helpers have isolated per-test histories. The optional HTTP server binds only to loopback and cleans up delayed responses on shutdown.

Verification: `npm run check` passes **31 tests** (17 core, 9 CLI, 5 fixture tests), lint, and TypeScript checks. The separate HTTP integration test also passed after granting local port-binding permission: **32 tests total across both commands**. These fixtures do not prove that the unimplemented extractor, crawler, provider adapter, or repair orchestrator works. Live quality and the five-case/15-minute benchmark remain M2 and release work.

## Company retrieval (M2 task 1)

See [docs/retrieval.md](docs/retrieval.md) for the API, source policies, limits, dependency choices, security model, and verified behavior.

`@jobber/core/retrieval` exports a server-only client, HTML cleaner, and bounded crawler. It validates DNS/IP destinations and redirect targets, pins socket resolution, handles robots and pacing, enforces encoded/decoded byte and time limits, ranks discovered relative/external hiring links, and records source outcomes. Missing sources yield warnings alongside any usable pages. HTML text remains explicitly untrusted.

Production defaults block private/loopback/metadata destinations. Trusted local execution can allow exact loopback origins via `localFixturePolicy`; there is no user-facing bypass. Site-term exclusions can be enforced through trusted `sourceAllowed` configuration; robots is not a substitute for reviewing source terms. No JavaScript rendering or PDF extraction is implemented.

Verification on 2026-09-24: lint/type checks and **47 standard tests**, **5 HTTP retrieval integration tests**, plus a successful public HTTPS smoke crawl of `https://example.com/`. This is not the five-case live-generation benchmark. Retrieval is ready for the shared pipeline; `generateKit` still reports `PIPELINE_NOT_IMPLEMENTED` pending the remaining M2 stages.
