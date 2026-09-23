# Jobber — AI Interview Prep Kit

Implementation follows the assessment PRD in the parent workspace (`../PRD.md`). **M1 tasks 1–2** are complete: the TypeScript workspace, shared structural schemas, and evaluation CLI contract. Real generation, reference/coverage validation, scheduling, authentication, and product UI are not implemented yet.

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
| `npm run check` | Lint, typecheck, and test |

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
- Successful provider results will be checked against the kit schema before output. Relational validation will be connected in the next M1 task.
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

These schemas enforce **shape**, enums, required fields, and integer constraints. They do not yet check unique IDs, reference integrity, coverage, or exact requested schedule length; those deterministic validators belong to the remaining M1 work. Passing structural validation alone does not establish that a kit is complete.

Unknown company information can remain empty. A case's company URL is retained as text so invalid/unreachable research can later become a warning instead of aborting a useful kit. Source URLs actually used must be HTTP(S). URL syntax validation is not SSRF protection; production/local evaluation fetch policies will be implemented in retrieval. The original JD is retained without whitespace normalization for evidence offsets and character accounting.

## Verification

Schema tests cover thin kits, preserved warning extensions, integer durations, missing fields, exact question categories, outline types, local input URLs, day validation, and the success/failure output union. Live-provider quality and runtime benchmarks will be added once the pipeline exists.

M1 task 2 adds nine CLI/batch tests covering mixed-case isolation, invalid generated output, safe structured errors, argument errors, malformed JSON, duplicate/missing identities, atomic replacement, file aliases, inaccessible destinations, empty batches, and executable exit codes/stderr. All 14 tests, lint, and package/CLI type checks pass.

Verified for M1 task 1: lint, both package type checks, five schema tests, package import resolution, and a production build using `npm run build --workspace=@jobber/web -- --webpack`. The default Turbopack build could not finish in the restricted agent environment because its internal worker port binding was denied. The default build configuration remains unchanged. The starter's Google fonts also require network access during a fresh build.
