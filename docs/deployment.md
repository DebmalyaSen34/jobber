# Deployment

Jobber uses a split deployment:

- Vercel serves the Next.js web application.
- Render runs the long-lived Express API and MongoDB-backed generation loop.
- MongoDB Atlas stores users, sessions, rate limits, jobs, kits, regeneration state, and practice history.

Neither Vercel nor Render's filesystem is used for durable application state.

Production URLs:

- Web: [https://jobber-web-lemon.vercel.app](https://jobber-web-lemon.vercel.app)
- API: [https://jobber-api-bllr.onrender.com](https://jobber-api-bllr.onrender.com)

## Request flow

Browser requests use same-origin `/api/*` paths. Next.js rewrites them server-side to Render using `API_PROXY_TARGET`; `NEXT_PUBLIC_API_BASE_URL` remains a compatible fallback. This design keeps the host-only session cookie first-party while the API and database remain outside the Vercel runtime.

Render executes durable jobs inside the web process. MongoDB leases, heartbeats, checkpoints, stale-worker fencing, and startup materialization repair preserve correctness through idle shutdowns and process restarts.

## Environment contract

| Variable | Surface | Purpose |
| --- | --- | --- |
| `MONGODB_URI` | Render secret | Atlas connection string using `mongodb://` or `mongodb+srv://` |
| `MONGODB_DB` | Render | Database name |
| `GEMINI_API_KEY` | Render secret | Server-side generation credential |
| `GEMINI_MODEL` | Render | Structured-output model override |
| `SESSION_SECRET` | Render secret | At least 32 characters; HMAC key for privacy-preserving rate-limit identifiers |
| `SESSION_TTL_HOURS`, `BCRYPT_ROUNDS` | Render | Session lifetime and password hashing cost |
| `LOGIN_WINDOW_MINUTES`, `LOGIN_EMAIL_LIMIT`, `LOGIN_IP_LIMIT` | Render | Persisted login throttling |
| `JOB_LEASE_SECONDS`, `JOB_POLL_MS` | Render | Job lease and polling intervals |
| `JOB_MAX_ATTEMPTS`, `JOB_RETRY_BASE_MS` | Render | Automatic job retry policy |
| `PIPELINE_VERSION` | Render | Active-input deduplication boundary |
| `WEB_ORIGINS` | Render | Comma-separated exact frontend origins; never `*` |
| `API_PROXY_TARGET` | Vercel server env | Render API origin without a trailing slash |
| `NEXT_PUBLIC_API_BASE_URL` | Vercel public env, optional | Backward-compatible API-origin fallback |
| `APP_RELEASE` | Render, optional | Safe release label for status responses |
| `PORT` | Render-provided | API listen port; local default is 4000 |

Provider pacing, retry, deadline, model-token, and research limits are documented in [.env.example](../.env.example) and [pipeline.md](pipeline.md).

Never place the MongoDB URI, Gemini key, or session secret in `NEXT_PUBLIC_*`, source control, browser code, logs, or status responses. `render.yaml` uses `sync: false` for supplied secrets and generates the session secret.

## Local deployment-equivalent setup

1. Copy `.env.example` to `.env` and provide a disposable or development MongoDB database plus Gemini key.
2. Copy `apps/web/.env.example` to `apps/web/.env.local`.
3. Run `npm run dev:api` and `npm run dev` in separate terminals.
4. Open `http://localhost:3000`.
5. Confirm `http://localhost:4000/health/live` and `/health/ready` return HTTP 200.

The API fails closed when required configuration is absent or MongoDB is unavailable. Configuration failures identify variable names without including their values.

## Render deployment

1. Create an Atlas database and least-privilege user. Configure network access according to Atlas and Render guidance.
2. Create a Render Blueprint from the repository-root `render.yaml`.
3. Supply `MONGODB_URI`, `GEMINI_API_KEY`, and the exact Vercel origin in `WEB_ORIGINS`.
4. Apply any nonsecret generation overrides from `.env.example`.
5. Deploy and confirm:
   - `GET /health/live` returns 200;
   - `GET /health/ready` returns 200 when MongoDB is reachable and 503 otherwise;
   - `GET /api/v1/status` exposes capability and release state without credentials or connection details.

## Vercel deployment

1. Create a Vercel project from the same repository.
2. Set the project root directory to `apps/web`.
3. Set `API_PROXY_TARGET` to the Render API origin.
4. Deploy the frontend.
5. Add the exact deployed Vercel origin to Render's `WEB_ORIGINS`, then redeploy the API.

Preview origins must be explicitly allowed or routed through a controlled production origin. Credentialed CORS must never use a wildcard.

## Verification

The deployed browser → Vercel rewrite → Render API → Atlas path was verified on 2026-09-24. Liveness, readiness, status, configured-origin CORS, credentialed preflight, unlisted-origin rejection, and durable boot-state persistence passed without exposing credentials.

For every release:

```bash
npm ci
npm run check
npm run build --workspace=@jobber/api
npm run build --workspace=@jobber/web -- --webpack
```

Then verify registration, login, kit submission, refresh/reopen, duplicate submission, editing, regeneration, practice persistence, logout, and API recovery after a restart. Render free services may cold-start after an idle period, so the UI treats temporary unavailability as retryable while MongoDB retains durable state.

Platform references: [Render free services](https://render.com/docs/free), [Render Blueprint specification](https://render.com/docs/blueprint-spec), [Render health checks](https://render.com/docs/health-checks), [Vercel plans](https://vercel.com/docs/plans), and [MongoDB Atlas limits](https://www.mongodb.com/docs/atlas/reference/limitations/).
