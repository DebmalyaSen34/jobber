# Category generation, coverage repair, and flashcards

Provider-backed preparation content is generated without giving the model control over routing, IDs, coverage decisions, or scheduling. Import these server-side APIs from `@jobber/core/generation`:

- `routeRequirements(requirements, context)`
- `generateQuestionsWithCoverage(requirements, provider, options)`
- `generateFlashcards(requirements, questions, provider, context)`

## Category routing and calls

Routing is deterministic:

- technical requirements go to `technical`;
- behavioural requirements go to `behavioural`;
- architecture, reliability, scaling, distributed-system, API, database, infrastructure, and related technical requirements also go to `system-design`;
- domain requirements go to `company-fit`;
- when a company brief or hiring evidence is supplied, all role requirements are available to `company-fit` so questions can connect role evidence to company evidence.

Only non-empty categories are called. Each relevant category gets its own provider call, stage, system instruction, requirement batch, and structured-output validation. Company and hiring context is included as untrusted data and changes the request context; it cannot create new requirement IDs. The four instructions emphasize different evidence: implementation/debugging, concrete behavioural examples, architecture/failure modes, and evidence-backed company fit.

Provider question IDs are never accepted. Code validates non-empty prompts/outlines, difficulty 1–3, unique in-batch requirement references, and category routing, then assigns deterministic IDs from the category, sorted requirement references, and normalized prompt. Exact duplicate outputs collapse without changing order.

## Coverage and repair

After all initial category calls, `checkCoverage` computes gaps in code. The category calls together count as one completed generation round followed by one coverage pass. If any requirement remains uncovered, one targeted `coverage-repair` call receives only the uncovered requirement records plus compact existing-question context. Coverage is recomputed after the response. At most two repair rounds run, and execution stops early when no gaps remain.

`passes` therefore records actual completed generation/check rounds; it is zero only for a kit with no requirements. Unknown, duplicate, out-of-batch, or wrongly routed references are rejected rather than counted as coverage.

If must-have gaps remain after the repair budget, `GenerationContentError` uses `MUST_HAVE_COVERAGE_FAILED` and retains recoverable partial questions, computed coverage, pass count, warnings, and trace. Exhausted nice-have gaps may return successfully only with an explicit warning. The trace records stage/category, round, input requirement IDs, application output IDs, before/after gap sets, provider/model, and token usage—never credentials or hidden reasoning.

## Flashcards

Flashcards are a separate structured provider call after question coverage. The input contains compact requirements and validated questions. Code rejects dangling or duplicate references, assigns deterministic `card-...` IDs, and removes exact duplicates. No-requirement inputs return no questions or cards without calling the provider.

## Verification

Network-free tests demonstrate:

- distinct category instructions and calls;
- hiring evidence changing request context;
- deterministic routing and IDs;
- the saved coverage fixture executing a real production repair call and closing the mentoring gap on pass two;
- two-round exhaustion, recoverable must failure, and explicit nice-gap warnings;
- rejection of unknown/out-of-batch/wrong-category references;
- thin-input call avoidance;
- flashcard validation, deduplication, IDs, and traces.

Live `gemini-3.5-flash-lite` verification on 2026-09-24 used the approved synthetic backend requirements. Technical, behavioural, and system-design calls generated five questions and covered all four requirements on the first computed pass; a separate flashcard call produced four grounded cards. The full questions-and-cards run took 7.66 seconds and reported 2,065 total tokens. The shared prompt distinguishes compile-time and runtime behavior and rejects absolute guarantees; a focused question verification took 6.17 seconds, retained complete coverage, and produced technically accurate outlines. The five-case benchmark also exercised company-fit, assembled orchestration, shared pacing, and a live repair pass; see [live-benchmark.md](live-benchmark.md).
