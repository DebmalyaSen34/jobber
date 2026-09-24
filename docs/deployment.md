# Deployment foundation

M3 task 1 uses a split deployment: the Next.js web app on Vercel, the long-running Express API on Render, and durable state in MongoDB Atlas. The application does not write durable state to either host's filesystem.

This repository is deployment-ready, but a deployment is not considered verified until the URLs and lifecycle checks at the end of this document have been completed.

## Why this topology

- Vercel's Hobby plan is suitable for the public Next.js frontend. Browser calls use same-origin `/api/*` URLs, which Next.js rewrites to Render using server-side `API_PROXY_TARGET` (with `NEXT_PUBLIC_API_BASE_URL` retained as a compatible fallback).
- Render provides a conventional Node process for the API and eventual background-job coordination. A free web service can spin down after 15 idle minutes, has an ephemeral filesystem, and can restart; future jobs must therefore use MongoDB leases/checkpoints rather than process memory.
- MongoDB Atlas is the system of record. The API performs a database ping and durable `service_runtime` upsert before accepting traffic. `/health/live` proves the process is alive; `/health/ready` proves persistence is reachable.

Current platform references: [Render free services](https://render.com/docs/free), [Render Blueprint specification](https://render.com/docs/blueprint-spec), [Render health checks](https://render.com/docs/health-checks), [Vercel Hobby](https://vercel.com/docs/plans/hobby), [Vercel function limits](https://vercel.com/docs/functions/limitations), and [Atlas limits](https://www.mongodb.com/docs/atlas/reference/limitations/).

## Environment contract

| Variable | Surface | Purpose |
| --- | --- | --- |
| `MONGODB_URI` | Render secret | Atlas connection string; must start with `mongodb://` or `mongodb+srv://` |
| `MONGODB_DB` | Render | Database name, default `jobber` |
| `GEMINI_API_KEY` | Render secret | Server-side generation provider credential |
| `SESSION_SECRET` | Render secret | At least 32 characters; HMAC key for privacy-preserving login-limit identifiers |
| `SESSION_TTL_HOURS`, `BCRYPT_ROUNDS` | Render | Session lifetime and password hashing work factor |
| `LOGIN_WINDOW_MINUTES`, `LOGIN_EMAIL_LIMIT`, `LOGIN_IP_LIMIT` | Render | Persisted login throttling policy |
| `WEB_ORIGINS` | Render | Comma-separated exact Vercel/local web origins; no wildcard |
| `API_PROXY_TARGET` | Vercel server env | Preferred Render API origin used by the same-origin rewrite |
| `NEXT_PUBLIC_API_BASE_URL` | Vercel public env | Render API origin, without a trailing slash |
| `APP_RELEASE` | Render, optional | Safe release label returned by status endpoints; otherwise Render's commit identifier is used |
| `PORT` | Render-provided | API listen port; local default is 4000 |
| `GEMINI_MODEL` and budget variables | Render | Model, pacing, retries, requests, tokens, and deadline; see `.env.example` |

Never place the MongoDB URI, Gemini key, or session secret in `NEXT_PUBLIC_*`, source control, logs, or status responses. Configure production values in provider dashboards. `render.yaml` deliberately uses `sync: false` for user-supplied secrets and generates the session secret.

## Local foundation check

1. Copy the documented values from `.env.example` into `.env`; use an Atlas development database or another disposable MongoDB deployment.
2. Copy `apps/web/.env.example` to `apps/web/.env.local`.
3. In one terminal run `npm run dev:api`; in another run `npm run dev`.
4. Open `http://localhost:3000`. The deployment card should say **Ready** only after the API has reached MongoDB.

The API intentionally fails closed if `MONGODB_URI` is absent or unreachable. Configuration errors identify variable names but never include values.

### Local live evidence

On 2026-09-24, the configured Atlas credentials passed the complete local boundary smoke: the API connected and returned 200 from liveness, readiness, and status; `http://localhost:3000` received its exact credentialed CORS response; an unlisted origin received 403; and the browser displayed **Ready** only after reaching the API and database. Restarting the API increased the durable `service_runtime` document's `boot_count` from 1 to 2, and SIGINT exercised the graceful shutdown handler. No credentials or connection details appeared in responses or logs.

This proves the credentials and persistence implementation locally. It is not evidence of Render/Vercel deployment, provider cold-start behavior, or a private production-browser flow.

### Production evidence

Verified on 2026-09-24:

- Web: `https://jobber-web-lemon.vercel.app`
- API: `https://jobber-api-bllr.onrender.com`
- `/health/live`, `/health/ready`, and `/api/v1/status` returned HTTP 200 from release `2132090ac7d8c2e8efb3f976fe5f0b9df55d8062`; status reported MongoDB connected.
- The exact Vercel origin received credentialed CORS headers and a 204 preflight; an unlisted origin received 403.
- A fresh browser page load progressed from **Checking** to **Ready**, rendered the same release, had no framework overlay, console warning/error, or horizontal overflow, and therefore verified browser → API → Atlas → response rendering.

This completes the M3 task 1 early deployed slice and production secret/persistence boundary. A forced hosted restart, an idle-period cold start, production authentication/cookies/CSRF, and restart-during-job recovery remain operational gates for the later M3 auth/job implementation.

## Production setup

1. Create an Atlas free cluster and least-privilege database user. Allow network access from the API host according to the current Atlas/Render guidance; rotate the credential if it is ever exposed.
2. Connect the Git repository to Render and create the Blueprint from the repository-root `render.yaml`. Supply `MONGODB_URI`, `GEMINI_API_KEY`, and the eventual Vercel production origin in `WEB_ORIGINS`.
3. Confirm `GET /health/live` returns HTTP 200 and `GET /health/ready` returns HTTP 200. A failed database check must return 503.
4. Create a Vercel project with root directory `apps/web`. Set `API_PROXY_TARGET` to the Render service origin. The existing `NEXT_PUBLIC_API_BASE_URL` value also works as a fallback; redeploy after changing either value.
5. Add the exact deployed Vercel origin to Render's `WEB_ORIGINS`, then redeploy the API. Preview origins must be explicitly listed or routed through a controlled production origin; do not use `*`.

## Required verification before checking off M3 task 1

- Record the deployed web and API URLs and release identifiers.
- Open the web URL in a private browser and observe a ready API and MongoDB status.
- Let the Render service idle, then verify the web UI shows a recoverable state during cold start and reaches ready afterward.
- Restart the API and confirm the service returns to ready and the MongoDB `service_runtime` document's `boot_count` increases.
- Temporarily use an invalid database credential in a nonproduction check and confirm readiness returns 503 without leaking connection details; restore the credential immediately.
- Confirm an unlisted `Origin` receives 403 and the configured Vercel origin receives its exact `Access-Control-Allow-Origin` value.
- Run `npm ci`, `npm run check`, and the evaluation CLI from a clean clone with only documented credentials.

M3 task 2 now implements cookies, CSRF, persisted sessions, login throttling, and an authenticated workspace. See [authentication.md](authentication.md). Production auth verification and job continuation/recovery remain outstanding until the updated services and persisted-job task are deployed.
