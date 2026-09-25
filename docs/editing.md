# Kit editing

M4 task 1 adds durable, owner-scoped editing to completed kits.

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
4. Recomputes requirement coverage from the edited requirements and questions.
5. Runs relational validation in draft mode. Intentional coverage or scheduling gaps are warnings; malformed structure and dangling references are rejected.
6. Atomically updates only when the stored revision equals the submitted revision, then increments it.

A stale revision returns `409 KIT_REVISION_CONFLICT`. The browser keeps its local draft and offers an explicit action to discard it and load the latest server revision. Full entity metadata, deletion tombstones, and regeneration-safe merging are M4 task 2.

Deleting a requirement removes its links from questions and flashcards. Deleting a question removes its schedule assignments. These immediate reconciliations keep user-driven mutations structurally valid; broader derived-state repair remains M4 task 3.

## Verification

- The network-free repository check covers lint, TypeScript, 61 core tests, 16 API tests, nine CLI tests, and five fixture tests.
- The loopback API suite verifies an authenticated successful edit, coverage recomputation, revision increment, stale-save conflict, and cross-owner 404.
- The webpack production frontend build passes.
- A local browser smoke with a temporary mock session verified view/edit states, accessible labels and controls, local dirty state, successful save feedback/revision increment, and question addition without a framework error overlay.
