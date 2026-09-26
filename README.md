# Jobber — AI Interview Prep Kit

Jobber turns a job description, company website, and interview date into an evidence-backed preparation kit. It researches public company information, extracts requirements grounded in the supplied description, generates role-specific questions and flashcards, and creates an exact day-by-day study schedule.

Production deployments:

- Web: [jobber-web-lemon.vercel.app](https://jobber-web-lemon.vercel.app)
- API: [jobber-api-bllr.onrender.com](https://jobber-api-bllr.onrender.com)

## Features

- Account registration, login, logout, persisted sessions, CSRF protection, and owner-scoped data.
- Single-role creation and JSON batch upload with row-level validation.
- Durable background generation with named progress, retries, duplicate protection, and restart-safe MongoDB leases.
- Public company-page crawling with robots handling, SSRF protection, source traces, and bounded Hacker News discussion search.
- Evidence-grounded requirement extraction and separate technical, behavioural, system-design, and company-fit generation calls.
- Deterministic coverage repair, schedule allocation, and complete-kit validation.
- Editable company, role, requirement, question, flashcard, and schedule content.
- Conflict-safe saves and independent company-brief, category, and schedule regeneration.
- Persistent flashcard practice ordered by `Again`, unseen, `Unsure`, and `Confident`.
- Responsive, keyboard-accessible UI with explicit loading, success, warning, retry, and conflict states.

## Architecture

```text
Browser
  │ same-origin /api/*
  ▼
Next.js web app on Vercel
  │ server-side rewrite
  ▼
Express API and generation loop on Render
  ├── MongoDB Atlas: users, sessions, jobs, kits, edits, practice
  ├── Gemini Developer API: structured generation
  └── Public web research: company pages and Hacker News search
```

Repository layout:

```text
apps/web/          Next.js frontend
apps/api/          Express API and MongoDB-backed job execution
packages/core/     Shared schemas, retrieval, generation, validation, and scheduling
scripts/           Evaluation CLI
tests/fixtures/    Synthetic JDs, provider responses, and company sites
examples/          Evaluation input examples
docs/              Architecture, security, operation, and verification details
```

## Local setup

Requirements:

- Node.js 22.17.x
- npm 11.15.x
- MongoDB database
- Gemini Developer API key

Install dependencies:

```bash
nvm use
npm ci
```

Copy the root environment template and add server-side credentials:

```bash
cp .env.example .env
```

Copy the frontend rewrite configuration:

```bash
cp apps/web/.env.example apps/web/.env.local
```

Start the API and frontend in separate terminals:

```bash
npm run dev:api
```

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The local API defaults to `http://localhost:4000`.

Never expose `MONGODB_URI`, `GEMINI_API_KEY`, or `SESSION_SECRET` through a `NEXT_PUBLIC_*` variable. The browser should call relative `/api/*` routes; `API_PROXY_TARGET` points the Next.js server to the API origin.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Build shared core and start the Next.js development server |
| `npm run dev:api` | Start the Express API with `.env` |
| `npm run build` | Build core, API, and frontend |
| `npm start` | Serve the built frontend |
| `npm run start:api` | Serve the built API |
| `npm run lint` | Lint the workspace |
| `npm run typecheck` | Type-check workspaces, routes, and CLI |
| `npm test` | Run all network-free tests |
| `npm run check` | Run lint, type checks, and all network-free tests |
| `npm run test:cli` | Run evaluation CLI tests |
| `npm run test:fixtures` | Validate synthetic fixtures |
| `npm run fixtures:serve` | Serve synthetic company sites on loopback port 8099 |
| `npm run test:fixtures:http` | Exercise the fixture HTTP server |
| `npm run test:retrieval:http` | Exercise retrieval sockets and security controls |
| `npm run test:api:http` | Exercise API, authentication, ownership, and mutation routes |

## Evaluation CLI

The evaluator runs the same research and generation pipeline as the web application without requiring a browser, login, or database:

```bash
npm run evaluate -- --input examples/evaluation-cases.json --output kits.json
```

Input is a JSON array:

```json
[
  {
    "id": "backend-role",
    "jd": "Company: Example\nSenior Backend Engineer...",
    "company_url": "https://example.com",
    "days": 5
  }
]
```

The command writes a version `1.0` result envelope with one success or failure result per identifiable case. Invalid rows are isolated; file-level identity, invocation, or output failures return exit code 1 and preserve an existing output file. A completed batch returns exit code 0 even when individual cases failed, so callers must inspect each result status.

Research failures are retained as warnings and generation continues from the job description when possible. Every successful kit passes structural and relational validation, including valid references, exact requested days, must-have coverage, and scheduled questions.

The recorded five-case live Gemini benchmark produced five valid kits in 122.22 seconds with 26 requests, 17,477 tokens, and no retries. See [docs/live-benchmark.md](docs/live-benchmark.md).

## Reliability and safety

- Company URLs and redirects are validated against private, loopback, metadata, reserved, and disallowed destinations. Network requests use validated pinned addresses.
- Robots rules, source restrictions, response types, decompressed size, redirects, pacing, retries, page count, request count, and time are bounded.
- Retrieved pages and public discussions remain untrusted data. Model output is schema-checked and evidence references are validated in application code.
- Requirement IDs, coverage decisions, schedule allocation, ownership, revisions, and regeneration merges are application-controlled.
- Provider requests use bounded concurrency, pacing, retries, deadlines, and per-kit request/token limits. Secrets, prompts, source bodies, and hidden reasoning are excluded from persisted traces.
- Session cookies are opaque, `HttpOnly`, `SameSite=Lax`, host-only in production, and backed by server-side session records.
- Generation and regeneration use expiring fenced leases so restarted or stale workers cannot overwrite newer work.

## Deployment

The repository uses a split deployment:

- Vercel project root: `apps/web`
- Render Blueprint: `render.yaml`
- MongoDB Atlas: durable application state

Set `API_PROXY_TARGET` on Vercel to the Render API origin. Set the exact Vercel origin in Render's `WEB_ORIGINS`; do not use `*` with credentialed requests. Configure Render secrets and generation settings from [.env.example](.env.example), then verify `/health/live` and `/health/ready` before using the application.

See [docs/deployment.md](docs/deployment.md) for the complete environment contract and deployment checks.

## Validation model

Runtime Zod schemas enforce the Appendix A kit and Appendix B evaluation shapes. `validateKit(input, { requestedDays, mode })` additionally checks:

- unique entity IDs and reference lists;
- existing requirement, question, flashcard, and schedule references;
- freshly computed coverage;
- exact consecutive schedule days;
- scheduled must-have coverage;
- all generated questions scheduled at least once.

Generated kits reject incomplete must-have coverage or scheduling. Editable drafts may intentionally contain coverage or schedule gaps; those gaps are returned as warnings while malformed or dangling data remains invalid.

## Documentation

- [Deployment](docs/deployment.md)
- [Authentication and ownership](docs/authentication.md)
- [Persisted jobs](docs/jobs.md)
- [Dashboard and kit workspace](docs/workspace.md)
- [Kit editing and regeneration](docs/editing.md)
- [Flashcard practice](docs/practice.md)
- [Company retrieval](docs/retrieval.md)
- [Public-discussion search](docs/public-discussions.md)
- [Extraction and provider adapter](docs/extraction-provider.md)
- [Question generation and coverage repair](docs/question-generation.md)
- [End-to-end pipeline](docs/pipeline.md)
- [Live benchmark](docs/live-benchmark.md)

## Supported limitations

- Company research processes HTML, XHTML, plain text, and JSON APIs used by the discussion adapter; it does not render JavaScript or extract PDFs.
- Public-discussion evidence is limited to bounded Hacker News/Algolia search and is always labelled anecdotal.
- Company and hiring-page discovery is heuristic and bounded; a missing source is not proof that no source exists.
- Dashboard kit and job lists are capped at the 100 most recent records.
- The Render free service may cold-start after an idle period. Durable jobs and MongoDB leases protect persisted state across process restarts.
