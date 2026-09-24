# End-to-end generation pipeline

M2 task 5 connects the independently tested research, extraction, generation, coverage, flashcard, scheduling, and validation stages behind one shared implementation.

## Entry points

- `generateKit(input)` is the production entry point. Company retrieval uses the public-address-only SSRF policy.
- `generateEvaluationKit(input)` is used by `scripts/evaluate.mts`. It has the same pipeline, plus an exact-origin loopback exception when the case itself names `localhost`, `127.0.0.1`, or `[::1]`. This is for trusted local fixtures and does not permit arbitrary private or metadata addresses.
- `generateKitWithDependencies(input, dependencies, options, onProgress)` is the deterministic test/application integration seam. It does not enable fixture behavior by itself.

The CLI loads `.env` when present, executes cases sequentially, isolates per-case failures, and validates every successful kit again in the batch runner before writing the atomic output envelope.

## Sequence

1. Validate the evaluation case.
2. Start bounded company crawling and evidence-based JD extraction concurrently.
3. Resolve company identity from evidence and perform bounded Hacker News/Algolia discussion search when identity is unambiguous.
4. Synthesize a company brief. Official facts may cite only supplied official pages; public discussion must remain labelled anecdotal.
5. Route requirements deterministically into technical, behavioural, system-design, and company-fit generation calls.
6. Compute coverage in application code and perform at most two targeted repair rounds.
7. Generate and validate flashcards separately.
8. Allocate the deterministic schedule for the exact requested day count.
9. Assemble the Appendix A kit and run `validateKit` in generated mode.

Research failure is nonfatal. The result retains warnings and continues from the JD and any evidence that was available. Missing evidence produces an explicit limited company brief instead of invented facts. Provider, content-validation, must-have coverage, budget, or final-kit failures remain case failures.

## Provider reliability

`ReliableJsonProvider` wraps the provider-neutral `JsonProvider` boundary:

- one shared `ProviderGate` bounds concurrency and spaces request starts across active cases;
- every case has a hard provider deadline plus request and observed-token budgets;
- only errors classified as retryable by the adapter are retried;
- exponential backoff has bounded jitter and honors a bounded `Retry-After` value;
- structured responses are checked by stage-specific application validators, and invalid content receives bounded corrective feedback before failing;
- permanent authentication, configuration, blocked-content, and invalid-request outcomes are not retried.

Usage is based on provider-reported totals, with a conservative prompt estimate used before each call. A request is rejected before dispatch when the remaining budget cannot accommodate the prompt and a small output reserve. The wrapper cannot cancel an arbitrary dependency implementation after its promise starts; the Gemini adapter separately aborts each HTTP attempt at `GEMINI_TIMEOUT_MS`.

## Configuration

| Variable | Default | Meaning |
| --- | ---: | --- |
| `GEMINI_API_KEY` | required | Server-side Gemini Developer API key |
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` | Structured-output model |
| `GEMINI_TIMEOUT_MS` | `30000` | Timeout for one HTTP attempt |
| `GEMINI_MIN_INTERVAL_MS` | `4200` | Minimum interval between shared provider request starts; conservative for a 15-RPM tier |
| `GEMINI_MAX_CONCURRENCY` | `1` | Shared in-process provider concurrency |
| `GEMINI_MAX_REQUESTS_PER_CASE` | `20` | Attempt budget, including retries |
| `GEMINI_MAX_TOKENS_PER_CASE` | `30000` | Observed token budget per case |
| `GEMINI_RETRIES` | `3` | Retries after the initial attempt |
| `GEMINI_RETRY_BASE_MS` | `1000` | Exponential backoff base |
| `GEMINI_MAX_RETRY_DELAY_MS` | `60000` | Backoff/`Retry-After` cap |
| `PIPELINE_DEADLINE_MS` | `720000` | Provider deadline for one case |

`GEMINI_API_BASE_URL` is a trusted test/proxy override and must not be derived from user input.

## Trace and verification

Successful kits include concise generation traces and provider-call accounting: stage, attempt count, retry codes, model/provider identity, and token counts. Prompts, JD/source text, credentials, provider response bodies, and hidden reasoning are not retained.

Network-free verification on 2026-09-24 covered transient and permanent failures, `Retry-After`, schema-feedback repair, request/token/deadline exhaustion, a fully researched five-day kit, a 60-day thin kit with failed research, schedule construction, source accounting, progress events, and final validation. `npm run check` passed 75 tests with clean lint and type checks. The final real CLI benchmark produced five valid kits in 122.22 seconds using 26 requests and 17,477 tokens with no retries; see `docs/live-benchmark.md` for findings and limitations.
