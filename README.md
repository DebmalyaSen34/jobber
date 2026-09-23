# Jobber — AI Interview Prep Kit

Implementation follows the assessment PRD in the parent workspace (`../PRD.md`). This repository currently completes **M1, task 1**: the TypeScript workspace, runtime/scripts, and shared structural schemas. Generation, evaluation CLI execution, reference/coverage validation, scheduling, authentication, and product UI are not implemented yet.

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
| `npm run typecheck` | Build core, generate Next.js route types, and check both packages |
| `npm test` | Compile core and run schema contract tests using Node's test runner |
| `npm run check` | Lint, typecheck, and test |

The assessment command `npm run evaluate -- --input cases.json --output kits.json` is the **next M1 task**; no placeholder command reports fabricated success.

## Structure

```text
apps/web/          Existing Next.js + Tailwind frontend
packages/core/    Framework-independent TypeScript schemas and inferred types
```

The Express backend will be added under `apps/api` in a later milestone. Existing frontend files were moved without changing the starter UI.

Import shared contracts from `@jobber/core`. The package exports compiled ESM and TypeScript declarations; root development/build/check commands build it first. After changing core while the frontend is already running, run `npm run build --workspace=@jobber/core` to refresh its compiled output.

## Schema boundaries

`kitSchema` implements Appendix A fields and preserves extension data such as warnings and requirement evidence. `evaluationCaseSchema`, `evaluationInputSchema`, and `evaluationOutputSchema` describe Appendix B. Types are inferred from runtime schemas to avoid divergent copies.

These schemas enforce **shape**, enums, required fields, and integer constraints. They do not yet check unique IDs, reference integrity, coverage, or exact requested schedule length; those deterministic validators belong to the remaining M1 work. Passing structural validation alone does not establish that a kit is complete.

Unknown company information can remain empty. A case's company URL is retained as text so invalid/unreachable research can later become a warning instead of aborting a useful kit. Source URLs actually used must be HTTP(S). URL syntax validation is not SSRF protection; production/local evaluation fetch policies will be implemented in retrieval. The original JD is retained without whitespace normalization for evidence offsets and character accounting.

## Verification

Schema tests cover thin kits, preserved warning extensions, integer durations, missing fields, exact question categories, outline types, local input URLs, day validation, and the success/failure output union. Live-provider quality and runtime benchmarks will be added once the pipeline exists.

Verified for M1 task 1: lint, both package type checks, five schema tests, package import resolution, and a production build using `npm run build --workspace=@jobber/web -- --webpack`. The default Turbopack build could not finish in the restricted agent environment because its internal worker port binding was denied. The default build configuration remains unchanged. The starter's Google fonts also require network access during a fresh build.
