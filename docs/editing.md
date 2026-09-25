# Kit editing

M4 tasks 1–3 add durable, owner-scoped editing, safe section regeneration, and explicit derived-state repair to completed kits. M4 task 5 verifies the complete editor interaction and recovery path.

## Interaction model

- `Edit kit` creates a local working copy. Keystrokes, selection changes, additions, deletions, category moves, and question reorder operations do not make network requests.
- `Save changes` sends the complete edited draft with its last-seen kit revision to `PATCH /api/v1/kits/:kitId`.
- `Done` leaves edit mode. If the draft is dirty, the user must confirm before discarding it. Browser navigation or refresh also receives the native unsaved-change warning.
- Destructive controls confirm before changing local state. Question reorder uses visible Move up/Move down buttons so it remains keyboard and touch accessible.

Editable fields include company/role display details, company brief text, responsibilities, requirements, question prompts/outlines/category/difficulty/requirement links, flashcards, and schedule focus/question assignments/minutes. Provenance URLs, original input, research timestamps, generation traces, and source counts remain read-only.

## Persistence and validation

The mutation requires the authenticated owner, trusted origin, and session CSRF token. The API:

1. Parses the complete kit shape and positive base revision.
2. Reloads the owner-scoped current kit.
3. Preserves server-owned provenance and extension data.
4. Removes requirement links whose requirements were deleted and schedule links whose questions were deleted.
5. Recomputes requirement coverage and schedule health from the reconciled draft.
6. Runs relational validation in draft mode. Intentional coverage or scheduling gaps are warnings; malformed structure is rejected.
7. Atomically updates only when the stored revision equals the submitted revision, then increments it.

A stale revision returns `409 KIT_REVISION_CONFLICT`. The browser keeps its local draft and offers an explicit action to discard it and load the latest server revision.

The server is authoritative for reconciliation even though the browser also cleans up references immediately. A successful response reports how many question-to-requirement, flashcard-to-requirement, and schedule-to-question links were removed. It never recreates deleted requirements, questions, or flashcards.

## Derived health and schedule repair

The workspace recomputes a local health preview after every edit. It separately displays uncovered requirements, uncovered must-haves, unscheduled questions, and must-have requirements that have questions but no scheduled question. Text labels and counts carry the state; color is supplementary.

After save, the API returns the same derived state calculated from persisted content. A schedule is marked for repair only when existing questions are unscheduled or a covered must-have lacks a scheduled question. A genuinely uncovered must-have is a content gap, so schedule repair remains disabled until the user adds coverage. Repair is an explicit action that reuses persisted schedule regeneration and is available only after local changes are saved; the system does not silently undo intentional deletions.

## Metadata and safe regeneration

Kit documents keep metadata outside the public `Kit` contract for the company brief, schedule, requirements, questions, and flashcards. Every entry records generated/manual origin, whether a user changed it, pin state, its last changed kit revision, and the generation run that created it. Saves derive this state server-side; clients may only submit the set of pinned question IDs. Deletions append durable requirement/question/flashcard tombstones.

Older kits without metadata remain readable. Revision-one kits receive generated defaults. For an older kit already saved at a later revision, existing content is conservatively treated as user-edited so a later regeneration cannot overwrite work created before metadata existed.

`POST /api/v1/kits/:kitId/regenerate` accepts one target: `company-brief`, `question-category` plus its category, or `schedule`. It records a Mongo-backed regeneration job and the kit's base revision, then returns `202`. `GET /api/v1/regenerations/:jobId` is owner-scoped progress polling.

The worker uses an expiring fenced lease. After generation it reloads the latest kit, merges only the requested target, protects manual/edited/pinned content and entities changed after the recorded base revision, excludes every tombstoned ID, removes stale schedule question references, recomputes coverage, validates the draft, and commits with an atomic kit-revision predicate. A racing save causes up to three latest-state merge retries; it never overwrites the stale snapshot. Preserved entities keep their IDs and explicit order; newly generated entities receive application-generated IDs.

Regeneration controls require the initial local draft to be saved, but editing remains available while the background job runs. An edit saved during generation becomes part of the server's latest-state merge. If edits are still local when the job completes, the browser rebases those entity-level changes onto the merged server revision and leaves them unsaved for review instead of replacing them.

## Verification

- The network-free acceptance test starts a category regeneration, applies an edit while generation is blocked, and verifies edited Q1, pinned Q2, manual Q3, and concurrent Q5 survive; deleted Q4 remains absent; unrelated content and all references remain valid.
- The API suites verify authoritative stale-reference removal, coverage and schedule-health recomputation, reconciliation counts, an authenticated successful edit, revision increment, stale-save conflict, and cross-owner 404.
- The webpack production frontend build passes.
- A local browser smoke with a temporary mock session verified view/edit states, accessible labels and controls, local dirty state, successful save feedback/revision increment, and question addition without a framework error overlay.
- The M4 task 5 keyboard acceptance run opened editing and saved through Enter-key activation. A forced 503 kept the local draft and exposed retry feedback; a forced stale-revision response kept the draft, offered an explicit discard/load-latest action, loaded the remote revision, and then saved revision 3 successfully.
- Real Chrome device emulation at 375×812 and 812×375 found no page-level horizontal overflow, kept visible main buttons at least 44px high, and rendered the authenticated workspace without a framework error overlay.
