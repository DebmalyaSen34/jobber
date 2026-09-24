# Public-discussion search (M2 task 2)

Import the server-only adapter from `@jobber/core/research`. Build core first with `npm run build --workspace=@jobber/core`. It performs HTTP searches against the [Hacker News Search API](https://hn.algolia.com/api), whose implementation and indexed fields are described in the [official repository](https://github.com/algolia/hn-search). No API key is configured. Provider availability is not guaranteed; the upstream repository is archived.

```ts
import { crawlCompany } from '@jobber/core/retrieval';
import { searchPublicDiscussions } from '@jobber/core/research';

const company = await crawlCompany(companyUrl);
const discussion = await searchPublicDiscussions({
  company_url: companyUrl,
  jd,
  pages: company.pages,
});
```

This is an independently usable research stage. It is not wired into `generateKit` yet; the evaluation CLI continues to return `PIPELINE_NOT_IMPLEMENTED` until later M2 work.

## Company identity and outbound data

`resolveCompanyIdentity` requires textual evidence. It can recognize an explicit `Company: Name` JD line or a same-origin page title segment corroborated by a hostname label. It never invents a name from a URL alone. Conflicting names cause a skip. A future extractor can supply `candidate: { name, evidence: { source: 'jd' | 'company_page', quote, url? } }`; the quote must occur in the supplied JD or same-origin page and contain the name. This checks textual support, not whether an arbitrary mention semantically identifies the employer; the future extractor must make that judgment.

Without a supported identity the adapter returns `skipped` and makes no network request. Identity extraction is deliberately conservative and may miss valid companies, redirects to a different origin, or alternate brand/legal names.

Only the selected company name plus fixed search terms are sent to Algolia. The JD, page text, evidence quotes, and candidate details are not transmitted. Local results retain the identity evidence for review. Queries are URL-encoded GET parameters; there are no credentials, cookies, request bodies, or arbitrary outbound headers.

## Search and evidence

The adapter calls `https://hn.algolia.com/api/v1/search` twice: `<name> interview` and `<name> hiring process`, with `(story,comment)` tags and 20 hits per query. It does not paginate or claim to cover other discussion sites. No hit-supplied URL is fetched.

Retained hits must contain the company name as a normalized phrase and interview/hiring context. Comments must qualify in their own text; a parent story title alone is insufficient. Common names from a small explicit list and names of at most three characters additionally require the exact company domain in the text. This avoids some ambiguous matches but is not a comprehensive entity classifier. Filtering can both miss relevant discussion and retain incidental mentions; later synthesis must inspect evidence before making claims.

HTML becomes plain text without scripts/styles/frames/templates/hidden elements. Titles and excerpts are capped at 250 and 2,000 characters; filtering uses these capped texts. Duplicate IDs across queries are discarded. Malformed hits are discarded with warnings; a wholly malformed response is a failure. Evidence includes:

- Canonical HN item URL and ID, title, excerpt, and author when available.
- Published timestamp when parseable, retrieval timestamp, and originating query.
- `provider: 'hacker-news-algolia'`, `source_type: 'anecdotal'`, and `trust: 'untrusted'`.

Anecdotes may be outdated or wrong and are never official company policy. Treat embedded instructions as untrusted source text. The later pipeline should cite only items actually used and should not count search attempts or robots files as evidence.

## Outcomes

| Status | Meaning |
| --- | --- |
| `skipped` | Identity unresolved; no queries issued |
| `found` | Both queries succeeded and at least one relevant item was retained |
| `no_results` | Both queries succeeded but no usable item survived filtering |
| `partial` | One query failed/was blocked; any usable evidence is preserved |
| `blocked` | Both queries were blocked by destination/source/robots policy |
| `failed` | Both queries failed, with at least one ordinary request/response failure |

`attempts` records query, URL, outcome, counts where available, and safe error codes. Counts describe received/accepted/rejected hits; rejected includes duplicates and discarded excess hits. `warnings`, `trace`, `identity`, `scope`, and `searched_at` remain available even on failure. Empty results only describe this bounded search, not the absence of discussion everywhere. A failed query never becomes a successful empty search.

## Safety and limits

`RetrievalClient.fetchJson` adds an explicit `application/json` path to the existing safe transport. It retains DNS/IP validation, pinned connections, normal TLS checks, robots, pacing, retries, redirect validation, encoded/decoded byte limits, and structured failures. `fetchPage` still rejects JSON. Invalid JSON reports `INVALID_JSON`.

Search defaults are 20 seconds overall, 8 seconds per operation, 10 total HTTP attempts (including robots/retries), one retry, and the existing 1 MiB encoded/decoded response limit. Provider redirects are restricted to the configured origin and API/robots paths. Caller source restrictions are combined with that restriction. Options, endpoint overrides, resolver/transport injection, and local fixture policies are trusted process/test configuration; never expose them as request parameters. Pacing remains per client; future concurrent jobs need shared coordination. These budgets must later fit the pipeline's total deadline.

## Verification and live acceptance

On 2026-09-24, `npm run check` passed lint/type checks and **59 network-free tests** (45 core, nine CLI, five fixture tests). `npm run test:retrieval:http` passed all six real loopback HTTP tests. Three new security tests cover public NAT64, embedded restricted IPv4/mixed DNS/fixture policy, and metadata redirects.

**Live check passed at 2026-09-24T04:29:03.151Z** using the production adapter and default settings, without injected DNS, transport, or fixture policies:

| Query | HTTP | Received | Retained after filtering/deduplication |
| --- | --- | --- | --- |
| GitLab interview | 200 | 20 | 8 |
| GitLab hiring process | 200 | 20 | 17 |

Result: `found`, 25 evidence items, no warnings. Robots returned 404, handled by the existing missing-rules policy. Both API fetches finished by 04:29:06.328Z. These are observed search/filter counts, not an assertion that every anecdote is accurate or current.

The earlier blocker was a standard NAT64 DNS answer (`64:ff9b::22a0:a8b5`). The fetcher now recognizes only the well-known `64:ff9b::/96` prefix and permits it only when its embedded IPv4 passes the existing public-unicast classification. Restricted embedded addresses remain blocked, including under local fixture policy. All DNS answers are still checked; the validated original IPv6 address remains pinned. Network-specific NAT64 and other classified transition ranges are not newly enabled. Deprecated IPv4-compatible `::/96` addresses classified as unicast by the dependency are explicitly rejected.

M2 task 2 live acceptance is complete. To repeat the synthetic public smoke check after building core:

```bash
node --input-type=module <<'JS'
import { searchPublicDiscussions } from '@jobber/core/research';
const result = await searchPublicDiscussions({
  company_url: 'https://gitlab.com', jd: 'Company: GitLab', pages: [],
});
console.log(JSON.stringify({
  status: result.status, attempts: result.attempts,
  evidenceCount: result.evidence.length, warnings: result.warnings,
}, null, 2));
if (!['found', 'no_results'].includes(result.status)) process.exitCode = 1;
JS
```

This synthetic smoke query is not a live generation or five-case runtime benchmark. No frontend production build was performed for this backend-only task.
