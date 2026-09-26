# Evidence-based extraction and provider adapter

The server-side generation package provides a provider-neutral structured JSON boundary and a JD-only extractor. Import APIs from `@jobber/core/generation` and `@jobber/core/extraction`.

## Provider configuration

The adapter uses the [Gemini Developer API](https://ai.google.dev/api/generate-content) directly over `fetch`, so there is no provider SDK dependency. The default model is `gemini-3.5-flash-lite` with structured output enabled. Model availability and quotas are external; `GEMINI_MODEL` provides a server-side override.

Copy `.env.example` and set:

- `GEMINI_API_KEY` (required): server-only API key.
- `GEMINI_MODEL` (optional): defaults to `gemini-3.5-flash-lite`.
- `GEMINI_TIMEOUT_MS` (optional): defaults to 30000.
- `GEMINI_API_BASE_URL` (optional): trusted testing/proxy override; production should retain Google's HTTPS endpoint.

`GeminiProvider.generateJson` sends a system instruction, user prompt, JSON schema, zero temperature by default, and an output-token cap. The API key is sent in a header, never placed in the URL. Results retain model/provider identifiers, token counts when returned, and a request ID. Safe errors distinguish configuration, authentication, rate limiting, temporary failures, timeout, blocked content, malformed provider output, and permanent request failures. They do not include response bodies or credentials.

The adapter makes one bounded HTTP attempt. The pipeline's `ReliableJsonProvider` adds shared throttling, request/token budgets, retry/backoff orchestration, total-case deadlines, and invalid-schema feedback repair using the adapter's structured `retryable` and `retryAfterMs` metadata.

## Extraction contract

`extractRequirements(jd, provider)` makes one `extract` stage call and validates the returned object before accepting it. The prompt treats the complete JD as untrusted JSON data and instructs the model to:

- extract only JD-supported facts;
- preserve numbers, alternatives, and qualifiers;
- use headings and wording for must/nice classification;
- avoid turning company stack/context into candidate requirements;
- use unknown scalars and empty arrays instead of inventing content.

Every role scalar, responsibility, and requirement must include an exact contiguous quote from the original JD. Application code locates that quote, computes offsets, and rejects the entire extraction with `UNGROUNDED_EXTRACTION` if any quote is absent. Evidence existence proves provenance, not semantic interpretation; fixture review and live quality evaluation remain necessary.

Requirement IDs are assigned by application code from the quote and offset, making them deterministic for the same JD evidence and independent of model wording. Repeated requirements that cite the same normalized evidence quote are collapsed in first-seen order. Empty-requirement extraction is valid and receives a limitation warning.

## Verification

Network-free tests cover all six reviewed JD fixtures, stable IDs, exact offsets, alternatives, qualifiers, nice/must distinctions, thin inputs, prompt-injection handling, malformed/ungrounded output, structured Gemini request shape, usage metadata, safe error mapping, `Retry-After`, blocked output, timeout, and invalid configuration.

Live extraction verification ran on 2026-09-24 with `gemini-3.5-flash-lite` and the synthetic backend/thin fixtures. The backend fixture returned all four reviewed requirements with correct kinds, priorities, and exact source evidence; wording differed only by terminal punctuation. It did not promote React/AWS company context into requirements. The thin fixture returned zero requirements, unknown seniority and location, and the expected limitation warning. Calls took about 1.75 seconds and 1.24 seconds. Full-pipeline throughput and coverage results are recorded in [live-benchmark.md](live-benchmark.md).
