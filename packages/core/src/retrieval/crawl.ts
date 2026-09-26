import { RetrievalClient, type RetrievalDependencies, type RetrievalOptions } from "./client.js";
import { cleanPage, classifyPage } from "./clean.js";
import { parseHttpUrl } from "./policy.js";
import { RetrievalError, safeTraceUrl, type ResearchPage } from "./types.js";

export type CrawlOptions = RetrievalOptions & { maxPages?: number; maxDepth?: number; maxOrigins?: number };

export async function crawlCompany(input: string, options: CrawlOptions = {}, dependencies: RetrievalDependencies = {}) {
  const { maxPages = 10, maxDepth = 3, maxOrigins = 4, ...retrievalOptions } = options;
  if (![maxPages, maxDepth, maxOrigins].every(Number.isSafeInteger) || maxPages < 1 || maxDepth < 0 || maxOrigins < 1) throw new Error("Invalid crawl limits");
  const client = new RetrievalClient(retrievalOptions, dependencies);
  const pages: ResearchPage[] = [];
  const warnings: Array<{ code: string; url?: string; message: string }> = [];
  const queue: Array<{ url: string; depth: number; score: number; from: string | null }> = [{ url: input, depth: 0, score: Infinity, from: null }];
  const seen = new Set<string>();
  const queued = new Set([input]);
  const origins = new Set<string>();
  let attempted = 0;
  while (queue.length && attempted < maxPages) {
    queue.sort((a, b) => b.score - a.score || a.depth - b.depth || (a.url < b.url ? -1 : 1));
    const next = queue.shift()!;
    if (seen.has(next.url)) continue;
    seen.add(next.url);
    attempted++;
    try {
      const response = await client.fetchPage(next.url);
      const finalUrl = new URL(response.url);
      origins.add(finalUrl.origin);
      if (pages.some((page) => page.url === response.url)) continue;
      const type = response.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
      const page = type === "text/plain"
        ? { url: response.url, title: "", text: response.text.slice(0, 16000), kind: classifyPage("", response.text), links: [], truncated: response.text.length > 16000, trust: "untrusted" as const }
        : cleanPage(response.text, response.url);
      pages.push({ ...page, discovered_from: next.from, depth: next.depth });
      seen.add(response.url);
      if (page.truncated) warnings.push({ code: "TEXT_TRUNCATED", url: page.url, message: "Cleaned source text was capped." });
      if (next.depth >= maxDepth) continue;
      for (const link of page.links) {
        if (queue.length >= 100 || queued.has(link.url) || seen.has(link.url) || link.score < 2) continue;
        const target = parseHttpUrl(link.url);
        // Related external hiring sites must be discovered and strongly relevant.
        if (target.origin !== finalUrl.origin && link.score < 6) continue;
        if (!origins.has(target.origin) && origins.size >= maxOrigins) continue;
        origins.add(target.origin);
        queued.add(link.url);
        queue.push({ url: link.url, depth: next.depth + 1, score: link.score, from: page.url });
      }
    } catch (error) {
      const safe = error instanceof RetrievalError ? error : new RetrievalError("RETRIEVAL_FAILED", "Source could not be processed.");
      warnings.push({ code: safe.code, url: safeTraceUrl(next.url), message: safe.message });
      if (safe.code === "BUDGET_EXHAUSTED") break;
    }
  }
  if (queue.length) warnings.push({ code: "CRAWL_LIMIT_REACHED", message: "Research focused on the highest-priority pages; some lower-ranked links were not checked." });
  const hiringPages = pages.filter((page) => page.kind === "hiring").map((page) => page.url);
  if (!hiringPages.length) warnings.push({ code: "NO_HIRING_PAGE", message: "No dedicated hiring-process page was found. The kit uses the job description and other available evidence." });
  if (!pages.some((page) => page.kind === "company")) warnings.push({ code: "NO_COMPANY_BRIEF_PAGE", message: "No clear company/about page was identified; use only available evidence." });
  return { pages, hiring_pages: hiringPages, trace: client.trace, warnings, researched_at: new Date().toISOString() };
}
