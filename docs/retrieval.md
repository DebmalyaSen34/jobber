# Company retrieval (M2 task 1)

Server-side retrieval is exported from `@jobber/core/retrieval`, separately from the browser-compatible core schemas. The module provides `RetrievalClient.fetchPage`, `cleanPage`, and `crawlCompany`. It does not call an LLM, search public discussion, or generate a kit.

```ts
import { crawlCompany, localFixturePolicy } from '@jobber/core/retrieval';

// Production: public HTTP(S) sources only.
const research = await crawlCompany('https://example.com/');

// Trusted CLI/test setup only. Never copy this policy from HTTP request input.
const local = await crawlCompany('http://127.0.0.1:8099/acme/', {
  policy: localFixturePolicy(['http://127.0.0.1:8099']),
});
```

Build core before standalone Node imports: `npm run build --workspace=@jobber/core`.

## Output and evidence

`crawlCompany` returns cleaned `pages`, candidate `hiring_pages`, `trace`, `warnings`, and `researched_at`. Each page includes its final URL, title, capped plain text, discovered/ranked links, coarse kind, truncation flag, discovery parent/depth, and `trust: 'untrusted'`.

Traces include page/robots/API purpose, timestamp, HTTP status or safe error code, attempt number, and fetched/redirect/retry/failed/skipped outcome. Credentials, query strings, and fragments are stripped from trace URLs. Raw exception messages are not exposed. Successful robots retrieval is not company evidence. The later pipeline must set `pages_used` from pages it actually uses, not from every attempted URL.

Hiring classification is a deterministic heuristic, not a factual guarantee about the current interview process. Link labels alone do not establish hiring evidence. Retain source text and provenance for later grounded synthesis. Cleaned HTML is still untrusted text; later model prompts must not follow instructions embedded in it.

## Fetch policy and transport

- Only HTTP(S), no embedded URL credentials, and production web ports 80/443.
- All DNS answers are checked with `ipaddr.js`; non-unicast IPv4/IPv6 ranges are rejected, including loopback, private, link-local/metadata, carrier-grade NAT, multicast, and reserved ranges. IPv4-mapped addresses are checked as IPv4. The well-known NAT64 `64:ff9b::/96` prefix is permitted only when its embedded IPv4 is public unicast; restricted translations never qualify for local fixture exceptions. All answers remain validated and the original IPv6 address stays pinned. This narrow mapping follows [RFC 6052](https://www.rfc-editor.org/rfc/rfc6052.html#section-2.2). Other classified transition ranges stay blocked; deprecated IPv4-compatible `::/96` addresses are explicitly rejected.
- The selected validated address is supplied to Node's socket lookup. There is no second DNS lookup at connection time. Original Host and normal HTTPS certificate verification remain intact.
- Every redirect is processed manually and revalidated; loops and excessive hops are rejected. Each redirected page is checked against its own origin's robots rules before retrieval.
- No forwarded credentials, cookie jar, arbitrary request headers, proxy environment, or pooled socket is used.
- `localFixturePolicy` permits only explicitly named loopback origins, including the port. It never permits a metadata/private redirect or blanket private network access. Hostname resolution for an allowed local origin must remain loopback.
- `sourceAllowed(url)` is a trusted callback for known source restrictions, including site-term restrictions. It runs before DNS/fetches and on redirects. Robots compliance does not automatically establish permission under all site terms; deployments must maintain appropriate source restrictions. The crawler does not interpret arbitrary legal text or bypass access restrictions.

This follows the address-validation and redirect concerns described in [OWASP's SSRF guidance](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html). Low-level transport/test seams are internal trusted capabilities; do not expose dependency injection or policy configuration to end users.

## Robots, pacing, and retries

- Fetch `/robots.txt` per origin and cache rules for this client/research run using `robots-parser`.
- Robots 404/410 means no published rules; 401/403 blocks the origin. Other robots errors, unsupported content, or timeouts fail conservatively rather than assuming permission.
- Recognize user-agent allow/disallow rules and crawl-delay. Identify requests as `JobberResearchBot/1.0`.
- Serialize fetches on each client, including robots and retries. Pace each hostname by the larger of minimum interval and robots crawl-delay. If a required wait does not fit the remaining deadline, stop instead of ignoring it.
- Retry 429 and 500/502/503/504, plus DNS/network errors, within configured limits. Respect Retry-After seconds or dates; otherwise use exponential backoff with small jitter. Do not retry ordinary 404s, blocked addresses, body/type violations, or exhausted deadlines.
- A backend running multiple independent clients concurrently will need to share/schedule them to enforce aggregate host limits across jobs. This module enforces limits per client; cross-process coordination is not implemented.

## Default bounds

| Bound | Default |
| --- | ---: |
| Crawl page attempts | 15 |
| Discovered-link depth | 3 |
| Candidate origins | 4 |
| Pending candidate links | 100 |
| Discovered links per page | 200 |
| Total HTTP attempts, including robots/retries/redirects | 60 |
| Entire client/research time budget | 60 seconds |
| Each page operation, including robots/redirects/retries | 10 seconds |
| Minimum hostname request interval | 250 ms |
| Retries after initial attempt | 2 |
| Redirects per chain | 5 |
| Encoded response bytes | 1 MiB |
| Decoded response bytes | 1 MiB |
| Robots encoded/decoded bytes | 512,000 bytes (or configured lower limit) |
| Cleaned text per page | 16,000 characters |

Timeouts cover DNS waiting, connection, and body delivery; retry waits are bounded by the same deadline. Encoded bytes are checked while receiving, and gzip/deflate/Brotli decoding has a separate output limit. Error/redirect bodies are discarded. Accepted page types are HTML, XHTML, and plain text; robots must be plain text. Unsupported encodings/types are skipped.

Options are trusted process configuration. Defaults fit the assessment timebox but must still be tuned with the later five-case live benchmark.

## Discovery and cleaning

Cheerio parses HTML without executing scripts. Remove scripts/styles, templates, frames, forms, hidden elements, and navigation/footer/header text. Extract links before removing navigation because useful hiring links often live there. Respect page/link `nofollow`, resolve against the final response URL, discard fragments/tracking parameters and obvious binary assets, and ignore hostile HTML base tags.

Rank discovered links using path, anchor text, and bounded surrounding text: interview/hiring/recruitment/selection; careers/jobs/join; handbook/team/people; company/about/product/engineering. Penalize legal/login/privacy links. Same-origin candidates require relevance; external candidates require stronger hiring relevance. No guessed `/careers` list, company-specific path mapping, or hardcoded hostname is used.

The crawler records absence of discovered hiring/company evidence, fetch failures, truncation, and crawl limits without throwing away successful pages. A missing page is not a reason to fabricate a company summary. Discovery is bounded: absence within the crawl is not proof that a page does not exist anywhere.

## Verification and current limits

Run:

```bash
npm run check
npm run test:retrieval:http
```

The standard suite uses injected resolver/transport fixtures without networking. The HTTP suite binds temporary loopback servers and exercises real transport, DNS pinning, retained Host, robots, relative-link crawling, private redirects, byte/content-type limits, compression bombs, partial-body timeouts, disconnects, and Retry-After.

Verified on 2026-09-24: 47 standard tests (33 core, 9 CLI, 5 fixtures), five real HTTP retrieval tests, and a public HTTPS smoke fetch of `https://example.com/`. The public smoke produced one page and honest no-hiring/no-company warnings. No API credentials or paid service were needed. The earlier standalone fixture-server test was not part of this task's count.

Limitations: no JavaScript rendering, PDF extraction, charset detection beyond UTF-8, sitemap expansion, or guarantee of finding every hiring page. HTML visibility based solely on external CSS is not evaluated. Heading/text classification and keyword ranking are heuristics. The shared pipeline now consumes retrieval, public discussion, extraction, and generation; this does not by itself constitute the live five-case benchmark.

M2 task 2 adds `fetchJson`, accepting `application/json` under the same destination/robots/redirect/transport protections. JSON parsing failures report `INVALID_JSON`; page content types are unchanged. The HTTP suite now includes six tests, with a real JSON search and partial-failure scenario.

NAT64 follow-up verification: 59 standard tests, lint/type checks, six HTTP tests, and two successful live Algolia queries on 2026-09-24. No DNS/TLS/robots bypass or resolver override was used.
