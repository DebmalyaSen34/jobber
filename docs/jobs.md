# Persisted generation jobs

M3 task 3 runs generation asynchronously from the HTTP request while keeping MongoDB as the durable queue and source of truth. This follows the PRD decision to begin with an execution loop inside the Render API process instead of adding a separate broker or paid worker service.

## Request flow

1. An authenticated browser submits `POST /api/v1/kits` with its session CSRF token and `{ jd, company_url, days }`.
2. The API validates the input, canonicalizes the company URL, computes an owner-scoped fingerprint, and atomically inserts or reuses the active job.
3. The response is HTTP 202 with a job ID and `Location: /api/v1/jobs/:id`; it does not wait for generation.
4. The process-local execution loop atomically claims one MongoDB job. Named pipeline progress is checkpointed as it runs.
5. The browser can poll `GET /api/v1/jobs/:id` after navigation or refresh. The query includes the authenticated owner, so another user receives the same 404 as a missing job.
6. Completion is fenced by the current lease token. The validated kit is first committed to the job, then idempotently materialized in `kits`. Startup repairs any completed job whose kit materialization was interrupted.

`POST /api/v1/jobs/:id/retry` resets a failed owned job to queued state. It requires the trusted origin, current session, and session-bound CSRF token.

## States and progress

Statuses are `queued`, `running`, `retry_wait`, `completed`, `completed_with_warnings`, and `failed`. Status is separate from named pipeline stages such as `researching`, `extracting`, `synthesizing`, `generating`, `checking_coverage`, `repairing`, `flashcards`, `scheduling`, and `validating`. No fabricated percentage is returned.

The public job response contains IDs, status/stage, the bounded progress history, warnings, attempt limits, safe error details, and timestamps. It never returns the original JD, internal fingerprint, owner ID, lease token, raw provider errors, or credentials.

## Duplicate policy

The fingerprint covers normalized JD text, canonical company URL, requested days, and `PIPELINE_VERSION`. MongoDB's sparse unique `active_key` index includes the owner, so equivalent active submissions for one owner reuse the same job while different users remain independent. Terminal jobs release the active key; completed-copy UX belongs to the dashboard task.

## Leases and recovery

- A claim writes a random lease token, worker identity, and expiry in one atomic operation.
- Heartbeats and progress checkpoints extend only the matching unexpired lease.
- An expired `running` job is claimable by another worker after a process crash or hard restart.
- Completion/failure updates require the current token and an unexpired lease. A stale worker cannot commit after reclamation.
- Graceful SIGTERM/SIGINT stops polling and atomically returns the current job to `queued` without charging an execution attempt. Any late work from the old process is fenced out.
- Validated final output is committed inside the job before the separate idempotent kit upsert. Startup materialization closes the narrow crash window between those writes.
- Stage history, retry state, original validated input, and final validated output are durable. A crash before final validation replays generation from the original input rather than persisting or trusting partial provider/source bodies; this trades some repeated work for a smaller, safer checkpoint surface.

Transient provider failures discovered through the core error cause enter `retry_wait` with bounded exponential delays until `JOB_MAX_ATTEMPTS`. Permanent or exhausted failures retain a safe actionable error and wait for explicit user retry.

## MongoDB indexes

- `generation_jobs.active_key`: sparse unique active-job deduplication.
- `generation_jobs.status/next_attempt_at/lease_expires_at/created_at`: ordered atomic claims.
- `generation_jobs.owner_id/created_at`: owner progress history.
- `kits.owner_id/updated_at`: future dashboard/workspace listing.

## Configuration

| Variable | Default | Purpose |
| --- | ---: | --- |
| `JOB_LEASE_SECONDS` | `60` | Claim duration, renewed while work is active |
| `JOB_POLL_MS` | `1000` | Idle MongoDB polling interval |
| `JOB_MAX_ATTEMPTS` | `3` | Maximum automatic executions before failure |
| `JOB_RETRY_BASE_MS` | `5000` | Exponential automatic retry base delay |
| `PIPELINE_VERSION` | `1` | Deduplication boundary for generation semantics |

The current Render free-service topology executes jobs in the web process. A future dedicated worker can use the same MongoDB claim protocol without changing the API or adding Redis. Because the free web service can idle when there is no inbound traffic, production verification must include submitting a job, refreshing during execution, and forcing a restart while it is leased.

## Verification

Deterministic tests cover URL/input fingerprints, owner-scoped duplicate reuse, named progress, warning completion, transient retry timing, explicit retry, cross-owner denial, expired-lease reclamation, and stale-worker commit rejection. Loopback HTTP tests cover CSRF, field errors, 202/Location responses, duplicate feedback, protected polling, cross-user 404, and retry conflicts.
