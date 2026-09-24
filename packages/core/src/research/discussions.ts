import { load } from "cheerio";
import { z } from "zod";
import { RetrievalClient, RetrievalError, type RetrievalOptions, type RetrievalDependencies, type SourceTrace } from "../retrieval/index.js";
import { containsName, resolveCompanyIdentity, type IdentityInput } from "./identity.js";

const ENDPOINT = "https://hn.algolia.com/api/v1/search";
const hitSchema = z.object({
  objectID: z.string().regex(/^\d+$/),
  title: z.string().nullable().optional(), story_title: z.string().nullable().optional(),
  story_text: z.string().nullable().optional(), comment_text: z.string().nullable().optional(),
  author: z.string().nullable().optional(), created_at: z.string().nullable().optional(),
  _tags: z.array(z.string()),
});
const responseSchema = z.object({ hits: z.array(z.unknown()).max(1000), nbHits: z.number().int().nonnegative().optional() });
const plain = (html: string) => {
  const $ = load(html);
  $("script,style,iframe,template,[hidden]").remove();
  $("p,br,div,li").append(" ");
  return $("body").text().replace(/\s+/g, " ").trim();
};
const interviewTerms = /\b(interview(?:s|ed|ing)?|take[- ]home|coding (?:test|challenge|exercise)|hiring process|recruit(?:ment|ing) process)\b/i;
const hiringContext = /\b(candidate|job|take[- ]home|coding|hiring|recruit\w*|on.?site|system design|technical|round|interviewed (?:at|with)|interview (?:process|experience|question))\b/i;

export type DiscussionEvidence = {
  id: string; url: string; title: string; excerpt: string; author: string | null;
  published_at: string | null; retrieved_at: string; query: string;
  source_type: "anecdotal"; trust: "untrusted"; provider: "hacker-news-algolia";
};
export type SearchAttempt = {
  query: string; url: string; outcome: "ok" | "failed" | "blocked";
  received?: number; accepted?: number; rejected?: number; code?: string;
};
export type DiscussionOptions = {
  retrieval?: RetrievalOptions;
  /** Trusted test endpoint only; production callers should leave this unset. */
  endpoint?: string;
};

export async function searchPublicDiscussions(
  input: IdentityInput, options: DiscussionOptions = {}, dependencies: RetrievalDependencies = {},
) {
  const identity = resolveCompanyIdentity(input);
  const attempts: SearchAttempt[] = [];
  const evidence: DiscussionEvidence[] = [];
  const warnings: Array<{ code: string; message: string }> = [];
  const trace: SourceTrace[] = [];
  const base = { provider: "hacker-news-algolia" as const, scope: "Hacker News only; up to two queries and 20 hits per query", identity, attempts, evidence, warnings, trace, searched_at: new Date().toISOString() };
  if (!identity) {
    warnings.push({ code: "COMPANY_IDENTITY_UNRESOLVED", message: "No unambiguous evidence-backed company name was established; no search was performed." });
    return { ...base, status: "skipped" as const };
  }
  const endpoint = new URL(options.endpoint ?? ENDPOINT);
  // Limit JSON API redirects to the configured provider origin/path and robots.
  const originalPolicy = options.retrieval?.policy;
  const client = new RetrievalClient({
    budgetMs: 20000, timeoutMs: 8000, maxRequests: 10, retries: 1,
    ...options.retrieval,
    policy: { ...originalPolicy, sourceAllowed: (url) =>
      url.origin === endpoint.origin && [endpoint.pathname, "/robots.txt"].includes(url.pathname) &&
      (!originalPolicy?.sourceAllowed || originalPolicy.sourceAllowed(url)),
    },
  }, dependencies);
  const seen = new Set<string>();
  const queries = [`${identity.name} interview`, `${identity.name} hiring process`];
  for (const query of queries) {
    const url = new URL(endpoint);
    url.searchParams.set("query", query);
    url.searchParams.set("tags", "(story,comment)");
    url.searchParams.set("hitsPerPage", "20");
    const attempt: SearchAttempt = { query, url: url.href, outcome: "ok" };
    attempts.push(attempt);
    try {
      const response = await client.fetchJson(url.href);
      const parsed = responseSchema.safeParse(response.data);
      if (!parsed.success) throw new RetrievalError("INVALID_SEARCH_RESPONSE", "Search response has an unexpected structure.");
      attempt.received = parsed.data.hits.length;
      let invalid = 0;
      let accepted = 0;
      for (const raw of parsed.data.hits.slice(0, 20)) {
        const result = hitSchema.safeParse(raw);
        if (!result.success) { invalid++; continue; }
        const hit = result.data;
        if (!hit._tags.some((tag) => ["story", "comment"].includes(tag))) continue;
        const title = plain(hit.title ?? hit.story_title ?? "").slice(0, 250);
        const body = plain(hit.comment_text ?? hit.story_text ?? "").slice(0, 2000);
        // Parent-thread titles cannot make an otherwise generic comment relevant.
        const relevantText = hit._tags.includes("comment") ? body : `${title} ${body}`;
        const hasDomain = identity.domain !== null && new RegExp(`(^|[^a-z0-9.-])${identity.domain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^a-z0-9.-])`, "i").test(relevantText);
        if (!containsName(relevantText, identity.name) || !interviewTerms.test(relevantText) || !hiringContext.test(relevantText) ||
            (identity.ambiguous && !hasDomain) || seen.has(hit.objectID)) continue;
        const excerpt = (body || title).slice(0, 2000);
        if (!excerpt) continue;
        seen.add(hit.objectID); accepted++;
        evidence.push({
          id: hit.objectID, url: `https://news.ycombinator.com/item?id=${hit.objectID}`,
          title: title.slice(0, 250), excerpt, author: hit.author ?? null,
          published_at: hit.created_at && Number.isFinite(Date.parse(hit.created_at)) ? new Date(hit.created_at).toISOString() : null,
          retrieved_at: new Date().toISOString(), query,
          source_type: "anecdotal", trust: "untrusted", provider: "hacker-news-algolia",
        });
      }
      attempt.accepted = accepted;
      attempt.rejected = parsed.data.hits.length - accepted;
      if (invalid) warnings.push({ code: "MALFORMED_SEARCH_HITS", message: `${invalid} malformed search hits were discarded.` });
      if (parsed.data.hits.length && invalid === Math.min(20, parsed.data.hits.length)) {
        throw new RetrievalError("INVALID_SEARCH_RESPONSE", "No search hits could be decoded.");
      }
    } catch (error) {
      const code = error instanceof RetrievalError ? error.code : "SEARCH_FAILED";
      attempt.outcome = /BLOCKED|ROBOTS/.test(code) ? "blocked" : "failed";
      attempt.code = code;
      warnings.push({ code, message: "A public-discussion query could not be completed." });
    }
  }
  trace.push(...client.trace);
  const failures = attempts.filter((attempt) => attempt.outcome !== "ok");
  const status = failures.length === attempts.length
    ? failures.every((attempt) => attempt.outcome === "blocked") ? "blocked" : "failed"
    : failures.length ? "partial" : evidence.length ? "found" : "no_results";
  if (!evidence.length) warnings.push({ code: "NO_DISCUSSION_EVIDENCE", message: "No usable interview discussion was found in the queried Hacker News results; this does not establish absence elsewhere." });
  if (identity.ambiguous) warnings.push({ code: "AMBIGUOUS_NAME_FILTER", message: "A common or short company name required a matching domain in each retained item; relevant results may have been omitted." });
  return { ...base, status };
}
