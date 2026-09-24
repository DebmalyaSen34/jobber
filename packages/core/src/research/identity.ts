import { parseHttpUrl, type ResearchPage } from "../retrieval/index.js";

export type IdentityEvidence = { source: "jd" | "company_page"; quote: string; url?: string };
export type CompanyIdentity = { name: string; domain: string | null; evidence: IdentityEvidence; ambiguous: boolean };
export type IdentityInput = {
  company_url: string;
  jd: string;
  pages: readonly ResearchPage[];
  candidate?: { name: string; evidence: IdentityEvidence };
};

export const normalize = (text: string) => text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
export function containsName(text: string, name: string): boolean {
  return ` ${normalize(text)} `.includes(` ${normalize(name)} `);
}

const commonNames = new Set(["apple", "amazon", "linear", "square", "block", "bolt", "buffer", "notion", "shell", "meta", "stripe", "remote"]);
const genericNames = new Set(["home", "about", "careers", "jobs", "company", "welcome", "engineering", "example domain"]);
const validName = (name: string) => name.length >= 2 && name.length <= 80 &&
  /^[\p{L}\p{N}][\p{L}\p{N} .&'’+-]*$/u.test(name) && !genericNames.has(normalize(name));

/** Conservative evidence matching, not an LLM/entity resolver. Never invent from a domain alone. */
export function resolveCompanyIdentity(input: IdentityInput): CompanyIdentity | null {
  let origin: string | null = null;
  let domain: string | null = null;
  try {
    const url = parseHttpUrl(input.company_url);
    origin = url.origin;
    const host = url.hostname.replace(/^www\./, "");
    if (host.includes(".") && !/^[\d.]+$/.test(host) && !host.includes(":")) domain = host;
  } catch { /* A valid explicit JD company name can still support search. */ }
  const companyPages = input.pages.filter((page) => {
    try { return new URL(page.url).origin === origin; } catch { return false; }
  });
  const candidates: Array<{ name: string; evidence: IdentityEvidence }> = [];
  const explicit = input.jd.match(/^\s*Company\s*:\s*([^\r\n]+)$/im);
  if (explicit?.[1]) candidates.push({ name: explicit[1].trim(), evidence: { source: "jd", quote: explicit[0].trim() } });
  // Only a short title segment corroborated by a hostname label is auto-selected.
  const labels = domain?.split(".").filter((label) => !["com", "org", "net", "co", "uk", "io", "test", "www"].includes(label)) ?? [];
  for (const page of companyPages) {
    for (const segment of page.title.split(/\s+[|–—-]\s+/)) {
      const name = segment.replace(/^(about|careers at|welcome to)\s+/i, "").trim();
      if (labels.some((label) => normalize(name).replaceAll(" ", "") === normalize(label))) {
        candidates.push({ name, evidence: { source: "company_page", quote: page.title, url: page.url } });
      }
    }
  }
  if (input.candidate) {
    const { name, evidence } = input.candidate;
    const source = evidence.source === "jd" ? input.jd : companyPages.find((p) => p.url === evidence.url);
    const supported = typeof source === "string" ? source.includes(evidence.quote) : source && (source.title.includes(evidence.quote) || source.text.includes(evidence.quote));
    if (!supported || !evidence.quote.trim() || !containsName(evidence.quote, name) || !validName(name)) return null;
    candidates.push(input.candidate);
  }
  const usable = candidates.filter((candidate) => validName(candidate.name));
  const names = new Set(usable.map((candidate) => normalize(candidate.name)));
  if (names.size !== 1) return null;
  const selected = usable[0]!;
  return {
    ...selected, domain,
    ambiguous: selected.name.length <= 3 || commonNames.has(normalize(selected.name)),
  };
}
