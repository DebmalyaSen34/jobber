import { load } from "cheerio";
import { parseHttpUrl } from "./policy.js";
import type { DiscoveredLink, ResearchPage } from "./types.js";

const whitespace = (value: string) => value.replace(/\s+/g, " ").trim();

export function classifyPage(title: string, text: string): ResearchPage["kind"] {
  const hiring = /hiring|interview|selection|recruit/i.test(`${title} ${text}`) && /take.home|interview|round|assessment|process/i.test(text);
  return hiring ? "hiring" : /about|company|we (build|make|provide)/i.test(`${title} ${text}`) ? "company" : "other";
}

export function rankLink(url: string, text: string, context = ""): number {
  const content = `${new URL(url).pathname} ${text} ${context}`.toLowerCase();
  let score = 0;
  if (/interview|hiring|recruit|selection/.test(content)) score += 8;
  if (/career|\bjobs?\b|join/.test(content)) score += 6;
  if (/handbook|team|people|working/.test(content)) score += 4;
  if (/about|company|product|engineering/.test(content)) score += 2;
  if (/login|sign.?in|privacy|legal|terms|cookie|unsubscribe/.test(`${new URL(url).pathname} ${text}`.toLowerCase())) score -= 20;
  return score;
}

export function cleanPage(html: string, url: string, maxTextChars = 16000, maxLinks = 200): ResearchPage {
  const $ = load(html);
  const title = whitespace($("title").first().text() || $("h1").first().text()).slice(0, 300);
  const nofollow = /\b(nofollow|none)\b/i.test($("meta[name='robots']").attr("content") ?? "");
  $("script,style,noscript,template,iframe,svg,form,[hidden],[aria-hidden='true']").remove();
  const links = new Map<string, DiscoveredLink>();
  if (!nofollow) $("a[href]").each((_, element) => {
    if (links.size >= maxLinks) return false;
    const anchor = $(element);
    if (/\bnofollow\b/i.test(anchor.attr("rel") ?? "")) return;
    try {
      // Ignore hostile <base> tags: actual response URL is the link base.
      const target = parseHttpUrl(new URL(anchor.attr("href")!, url).href);
      for (const key of [...target.searchParams.keys()]) {
        if (/^utm_|^(fbclid|gclid)$/i.test(key)) target.searchParams.delete(key);
      }
      if (/\.(pdf|zip|png|jpe?g|gif|mp4|svg|css|js)$/i.test(target.pathname)) return;
      const text = whitespace(anchor.text()).slice(0, 200);
      const context = whitespace(anchor.parent().clone().children("a").remove().end().text()).slice(0, 200);
      const link = { url: target.href, text, score: rankLink(target.href, text, context) };
      if (!links.has(link.url) || links.get(link.url)!.score < link.score) links.set(link.url, link);
    } catch { /* Invalid/non-HTTP links are not fetch candidates. */ }
  });
  $("nav,footer,header").remove();
  $("p,div,section,article,li,h1,h2,h3,h4,br,tr").append(" ");
  const text = whitespace($("body").text());
  // A navigation link labelled "hiring process" is not hiring-process evidence.
  const evidenceText = whitespace($("body").clone().find("a").remove().end().text());
  return {
    url, title, text: text.slice(0, maxTextChars),
    kind: classifyPage(title, evidenceText),
    links: [...links.values()].sort((a, b) => b.score - a.score || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0)),
    truncated: text.length > maxTextChars, trust: "untrusted",
  };
}
