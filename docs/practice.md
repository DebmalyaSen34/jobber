# Flashcard practice

M4 task 4 adds durable, owner-scoped flashcard practice to completed kits. M4 task 5 verifies its keyboard, mobile, and reopen behavior.

## Session behavior

- A session snapshots its card order when the user starts it. Grading a card affects the next session rather than immediately looping the current card.
- Only revealing a card exposes its answer and confidence controls. The three levels are `Again`, `Unsure`, and `Confident`.
- `Skip for now`, pausing, closing, or reopening a session does not record an unrevealed card as reviewed.
- Every accepted confidence selection is saved before the UI advances. A failed request leaves the revealed card in place with a retryable error.
- Unseen and reviewed card counts are displayed independently from requirement coverage.

The next session order is deterministic: `Again`, unseen, `Unsure`, then `Confident`. Within a level, the oldest review comes first and stable card ID breaks ties. Never-reviewed cards are oldest within the unseen group.

## Persistence and edits

`GET /api/v1/kits/:kitId/practice` returns current progress and the next deterministic order. `POST /api/v1/kits/:kitId/practice/reviews` accepts a UUID review ID, card ID, and confidence. Both routes require the authenticated owner; the mutation also requires trusted origin and the session CSRF token.

MongoDB keeps one practice document per owner, kit, and card. It stores current confidence, total review count, last-reviewed time, and append-only review events. Review UUIDs make a retried submission idempotent.

Each review records a hash of the material card content. If the front, back, or requirement links later change, the current confidence is presented as unseen while historical review count, timestamp, and events remain intact. Reordering a card does not reset confidence. Deleted cards disappear from active practice without requiring historical review deletion.

## Verification

- The pure-core test proves the priority policy, oldest-review ordering, lexical tie-break, and input-order independence.
- The API service test records all confidence levels, reopens progress, checks next-session ordering, retries a review UUID without double-counting, and verifies content-edit reset with retained history.
- The loopback HTTP suite verifies authenticated progress reads, CSRF rejection, successful review persistence, counts, and cross-owner 404.
- Lint, all type checks, the repository test suite, and the webpack production frontend build pass.
- Keyboard browser QA skipped the first card without creating a review, revealed the second card, confirmed focus moved to `Again`, and recorded `Unsure` with Enter-key activation. Reopening retained one unseen and one reviewed card; the following session presented the unseen card first.
- The same real-Chrome 375×812 and 812×375 checks used for the editor found no page-level horizontal overflow, preserved 44px minimum main action targets, and produced no runtime console errors or framework error overlay.
