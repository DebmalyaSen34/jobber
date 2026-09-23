# Synthetic assessment fixtures

These files contain invented companies and job descriptions. They are reusable test inputs, not real research, provider responses, extraction results, or benchmark evidence. Production code must never import this directory to fabricate successful generation.

## Commands

```bash
npm run test:fixtures
npm run fixtures:serve
# Optional alternate port (0 selects an available port):
npm run fixtures:serve -- 8098
npm run test:fixtures:http
```

`test:fixtures` is included in `npm test` and `npm run check`; it verifies data and deterministic behavior without network access. The separate HTTP suite exercises the real loopback server and requires permission to bind a local port. It does not use external sites or providers.

## Job descriptions and expectations

`cases.json` maps six scenario IDs to raw JDs, expected requirement annotations, site paths, and requested days. `helpers/load.mjs` exports `loadCases(origin)` to produce case inputs and expectations using any local server origin.

| ID | Purpose |
| --- | --- |
| backend | Must/nice headings, five-year threshold, Python-or-Java alternative, mentoring, company stack that must not become requirements |
| mentoring | Behavioural responsibilities, systems design, preferred domain experience, degree-or-equivalent alternative |
| thin | Two-line JD with no stated candidate requirements; 60 days |
| no-hiring | Required React versus preferred accessibility; 1 day; no discoverable hiring page |
| unreachable | Stated SQL requirement preserved despite company 404 |
| injection | Embedded instruction treated as untrusted data; only TypeScript extracted |

Expected requirements contain stable fixture IDs and exact quote/offset evidence. They are review baselines; future extractor tests should compare meaning, priorities, and qualifiers, not demand identical generated IDs or wording. The degree/equivalent requirement uses `domain` as the closest of the allowed kinds; reassess this choice with the extraction policy. These ASCII fixtures do not establish a Unicode offset policy.

## Provider responses

`coverage-repair.json` intentionally omits the backend JD's mentoring requirement in its first response; the repair response covers it. Fixture tests combine those canned responses and verify coverage plus a valid allocated kit. They do **not** execute a real generation/repair loop. M2 must inject the responses into its actual orchestration and assert targeted calls and pass counts.

`scenarios.json` contains provider-neutral transport response descriptors: status, raw body, optional headers, and optional delay. Scenarios cover 429 then success, malformed JSON then success, incomplete kit, temporary failure, permanent auth error, timeout, empty public discussion, and failed public discussion.

`scriptedProvider(name)` returns an isolated, ordered `next(request)` test double with request history. Exhaustion throws instead of silently repeating a success. It returns delay metadata immediately; the future adapter test harness is responsible for advancing a fake clock or simulating the timeout. No retries or parsing are implemented by the double.

## Company sites

`sites/routes.json` is the single source for the in-memory responder and real HTTP server. Each new responder has fresh request counts. Unknown paths return 404.

- `/acme/` links to `/acme/people/`, which links relatively to `/handbook/working-together/selection/`. This page describes a take-home API exercise, system-design interview, and mentoring discussion. A list of guessed careers paths will not find it.
- `/no-hiring/` and its product page form a closed link graph with no hiring page.
- `/robots.txt` disallows `/blocked/`; the blocked endpoint is available so future tests can assert that the crawler did not request it. The server does not enforce robots for the crawler.
- `/hostile/` includes malicious instructions and script content to exercise cleaning and prompt trust boundaries.
- `/failures/` provides missing, slow, redirect, redirect-loop, private-redirect, wrong-content-type, oversized (2 MiB), and rate-limited-then-recovered responses.

`createFixtureSite().respond(url)` returns status, headers, body, and delay metadata without opening sockets. The HTTP server applies the delay and binds only `127.0.0.1`. Tests can call `startFixtureServer(0)` and must close the returned server. Closing cancels timers and connections.

The private redirect is deliberately a dangerous destination string. Neither helper follows it. Only test it through a secure fetcher or with `redirect: 'manual'`; never fetch the metadata address. Local fixtures do not authorize weakening production SSRF protection.

## Remaining M2 integration

- Feed raw JDs through the real extractor and compare with reviewed annotations.
- Crawl these sites through the production retrieval code using its trusted local-test policy; verify discovery, robots, cleaning, size/type/time limits, and request history.
- Feed scripted provider responses through the actual adapter/orchestrator; verify retries, bounded repair, category-specific calls, and gap closure.
- Test actual connection failures with an injected transport rather than relying on an arbitrary unused port.
- Run separate live-provider quality and timing benchmarks; fixture speed proves neither.
