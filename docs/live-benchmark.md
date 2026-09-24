# Live Gemini benchmark — 2026-09-24

M2's five-case live-provider benchmark used the real evaluation CLI, `gemini-3.5-flash-lite`, and the synthetic inputs in `examples/live-benchmark-cases.json`. The company URLs used the repository's loopback-only fixture server so the research graph and failure cases were deterministic; Gemini calls were real.

Final command:

```bash
/usr/bin/time -p npm run evaluate -- \
  --input examples/live-benchmark-cases.json \
  --output /tmp/jobber-m2-task5-live-benchmark.json
```

Result: **5 successful, 0 failed in 122.22 seconds**. The output envelope passed `evaluationOutputSchema`, and every kit independently passed `validateKit` in generated mode with its requested day count.

| Case | Scenario | Days | Requirements | Questions | Cards | Coverage passes | Requests | Tokens | Retries |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `benchmark-detailed-hiring` | Detailed technical JD and nested hiring evidence | 5 | 4 | 9 | 4 | 1 | 7 | 5,567 | 0 |
| `benchmark-behavioural` | Mentoring, conflict resolution, systems, must/nice distinctions | 5 | 5 | 9 | 4 | 2 | 8 | 6,449 | 0 |
| `benchmark-thin-60-days` | Two-line JD and long edge schedule | 60 | 0 | 0 | 0 | 0 | 2 | 578 | 0 |
| `benchmark-no-hiring-page` | Useful company page but no hiring page | 1 | 2 | 4 | 4 | 1 | 5 | 3,078 | 0 |
| `benchmark-unreachable-edge` | HTTP 404 research and one-day edge schedule | 1 | 1 | 2 | 3 | 1 | 4 | 1,805 | 0 |
| **Total** |  |  | **12** | **24** | **15** |  | **26** | **17,477** | **0** |

All final cases had empty uncovered-requirement lists. The thin case generated no requirements, questions, or cards and retained its 60 honest zero-minute schedule days. The unreachable case completed from the JD with `HTTP_404`, `NO_HIRING_PAGE`, `NO_COMPANY_BRIEF_PAGE`, `COMPANY_IDENTITY_UNRESOLVED`, and `COMPANY_BRIEF_LIMITATION` warnings.

## Findings and corrections

The first run completed in 58.94 seconds but stopped at 3/5 because the original one-second gate reached the account's apparent 15-request/minute limit. Defaults were changed to a conservative 4.2-second shared interval, three retries, a one-second exponential base, and a 60-second retry/`Retry-After` cap.

The next run reached 4/5 in 140.80 seconds and exposed a deterministic coverage-repair validation loop. Repair prompts now supply the application-controlled allowed categories for every uncovered requirement. A focused live rerun then closed the behavioural gap in two coverage passes.

Live semantic inspection also found that the extractor merged two independently testable duties joined by “and.” Extraction guidance now explicitly splits those duties and consistently treats educational and industry qualifications as domain requirements. A focused live extraction returned all five reviewed behavioural requirements with exact evidence and correct kinds/priorities before the final batch.

Question inspection found specific technical, behavioural, system-design, and evidence-aware company-fit prompts with valid references. This was a manual spot-check, not a formal human relevance score. The fixture company names were not present in the JDs and loopback hostnames cannot corroborate identity, so public-discussion searches correctly reported `COMPANY_IDENTITY_UNRESOLVED`; the independently recorded M2 task 2 live search remains the public-discussion evidence. The final run was a fresh CLI process but followed earlier calls in the same provider quota window, so it should not be described as a cold-account benchmark.

