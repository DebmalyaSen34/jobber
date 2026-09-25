# Dashboard, creation, and kit workspace

M3 task 4 connects the authenticated web application to the durable jobs and kits created in task 3. All routes remain first-party in the browser (`/api/v1/*`) and are rewritten to the Render API. The API derives ownership from the persisted session; clients never submit an owner ID.

## User flow

1. `/dashboard` loads the signed-in user's kits and recent generation jobs in parallel. Active jobs poll every 2.5 seconds and remain reopenable after navigation or refresh.
2. `/create` accepts one job description, HTTP(S) company URL, and an integer from 1–60 days. A versioned local draft protects unsent form text from navigation; the draft is cleared after a successful submission.
3. The JSON upload mode accepts the CLI's case-array shape (`id`, `jd`, `company_url`, `days`) up to 1 MB and 50 rows. Every row receives its own queued/deduplicated/invalid result, so an invalid row cannot hide or block valid rows.
4. `/jobs/[jobId]` reloads durable named stages, retry timing, warnings, and actionable failures. Failed jobs can be explicitly retried with the session CSRF token. Completed jobs link to their stable kit ID.
5. `/kits/[kitId]` presents the company brief, role responsibilities and requirements, grouped questions, flashcards, daily schedule, coverage, warnings, and public sources. It renders text only; retrieved HTML is never inserted.

## API reads and batch enqueue

| Method/path | Response |
| --- | --- |
| `GET /api/v1/kits` | Up to 100 owner-scoped kit summaries, newest update first |
| `GET /api/v1/kits/:kitId` | Owner-scoped kit content, revision, metadata, and persisted original input |
| `GET /api/v1/jobs` | Up to 100 owner-scoped durable jobs, newest update first |
| `POST /api/v1/kits/batch` | Per-row queue or validation result for a JSON case array |

Job responses expose only the company URL, day count, and JD character count needed by the UI; they do not return the raw JD. Kit detail returns the original input because future editing and regeneration need the exact source, but omits internal research/provider execution traces. Cross-owner job and kit IDs return the same 404 shape as missing IDs.

Batch mutations require an allowed exact `Origin`, an authenticated session, and the session-bound `X-CSRF-Token`. Valid rows use the same canonicalization, fingerprint, active deduplication, limits, and worker queue as one-at-a-time submissions. The worker is awakened once when a batch queues at least one valid row.

## Current limits

- The dashboard caps each list at 100 records; pagination is future work.
- Task 4 is read-only after generation. Typed editing, revision conflicts, regeneration merge, deletion, and practice are M4 work.
- Polling is intentionally simple and process-independent. Push updates are not required for the current scale.
- The local browser verification used a mock API/session and did not call Gemini, Atlas, Render, or Vercel. Production submit/refresh/restart recovery and the full deployed-user exit test remain deployment checks.
