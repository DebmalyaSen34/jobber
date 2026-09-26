# Dashboard, creation, and kit workspace

The authenticated web application presents durable jobs, kits, editing, regeneration, and practice through first-party browser routes. Requests to `/api/v1/*` are rewritten to the Render API. The API derives ownership from the persisted session; clients never submit an owner ID.

## User flow

1. `/dashboard` loads the signed-in user's kits and recent generation jobs in parallel. Active jobs poll every 2.5 seconds and remain reopenable after navigation or refresh.
2. `/create` accepts one job description, HTTP(S) company URL, and an integer from 1–60 days. A versioned local draft protects unsent form text from navigation; the draft is cleared after a successful submission.
3. The JSON upload mode accepts the CLI's case-array shape (`id`, `jd`, `company_url`, `days`) up to 1 MB and 50 rows. Every row receives its own queued/deduplicated/invalid result, so an invalid row cannot hide or block valid rows.
4. `/jobs/[jobId]` reloads durable named stages, retry timing, warnings, and actionable failures. Failed jobs can be explicitly retried with the session CSRF token. Completed jobs link to their stable kit ID.
5. `/kits/[kitId]` presents the company brief, role responsibilities and requirements, grouped questions, flashcards, daily schedule, coverage, warnings, and public sources. It renders text only; retrieved HTML is never inserted.

## Interaction feedback

- Authentication keeps a visible spinner for the entire request, then shows a brief confirmed “Signed in” or “Account created” state before redirecting. The confirmation replaces the form in both the visual and accessibility trees, so the outcome is unambiguous without leaving hidden controls focusable.
- Kit submission follows the same request → confirmed → redirect sequence. Buttons retain progress feedback for slower requests, and server/client field errors move focus to the first field that needs attention.
- Active generation uses motion only on live state: an activity spinner, segmented stage meter, flowing current-stage connector, and pulsing current marker. Completed stages are stable checkmarks. Visible copy explains two-second durable polling and that the user may safely leave and return.
- Route and data waits use labeled progress panels and reserved-space skeletons instead of plain text, reducing perceived stalls and layout shift. Sign-out, batch validation, retry, and password visibility also expose immediate feedback.
- Every animation uses transform/opacity and is disabled by `prefers-reduced-motion`; status meaning is also expressed in text rather than color or motion alone.

## API reads and batch enqueue

| Method/path | Response |
| --- | --- |
| `GET /api/v1/kits` | Up to 100 owner-scoped kit summaries, newest update first |
| `GET /api/v1/kits/:kitId` | Owner-scoped kit content, revision, metadata, and persisted original input |
| `GET /api/v1/jobs` | Up to 100 owner-scoped durable jobs, newest update first |
| `POST /api/v1/kits/batch` | Per-row queue or validation result for a JSON case array |

Job responses expose only the company URL, day count, and JD character count needed by the UI; they do not return the raw JD. Kit detail returns the original input because editing and regeneration use the exact source, but omits internal research/provider execution traces. Cross-owner job and kit IDs return the same 404 shape as missing IDs.

Batch mutations require an allowed exact `Origin`, an authenticated session, and the session-bound `X-CSRF-Token`. Valid rows use the same canonicalization, fingerprint, active deduplication, limits, and worker queue as one-at-a-time submissions. The worker is awakened once when a batch queues at least one valid row.

## Supported limits

- The dashboard returns the 100 most recent kits and jobs in each list.
- Progress uses process-independent polling rather than a push channel.
- Completed kits support typed editing, conflict recovery, safe section regeneration, deletion, derived health, and persistent practice as documented in [editing.md](editing.md) and [practice.md](practice.md).
