export class RetrievalError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "RetrievalError";
  }
}

export type SourceTrace = {
  url: string;
  purpose: "page" | "robots";
  outcome: "fetched" | "redirect" | "retry" | "skipped" | "failed";
  code?: string;
  status?: number;
  attempt?: number;
  at: string;
};

export type DiscoveredLink = { url: string; text: string; score: number };
export type ResearchPage = {
  url: string;
  title: string;
  text: string;
  kind: "hiring" | "company" | "other";
  links: DiscoveredLink[];
  truncated: boolean;
  trust: "untrusted";
  discovered_from?: string | null;
  depth?: number;
};

export const USER_AGENT = "JobberResearchBot/1.0";

export function safeTraceUrl(input: string): string {
  try {
    const url = new URL(input);
    url.username = "";
    url.password = "";
    // Traces need not retain potentially sensitive query parameters.
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return "[invalid URL]";
  }
}
