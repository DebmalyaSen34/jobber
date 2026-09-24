import robotsParser from "robots-parser";
import { parseHttpUrl, validateDestination, type FetchPolicy, type Resolver } from "./policy.js";
import { requestPinned, type HttpResponse, type Transport } from "./transport.js";
import { RetrievalError, safeTraceUrl, USER_AGENT, type SourceTrace } from "./types.js";

export type RetrievalOptions = {
  policy?: FetchPolicy;
  timeoutMs?: number;
  budgetMs?: number;
  minIntervalMs?: number;
  maxRequests?: number;
  maxRedirects?: number;
  retries?: number;
  maxBytes?: number;
  maxDecodedBytes?: number;
};
/** Dependencies are trusted test seams, never populated from untrusted input. */
export type RetrievalDependencies = { resolver?: Resolver; transport?: Transport };
const redirectStatuses = new Set([301, 302, 303, 307, 308]);
// robots-parser ships CJS with an ESM-shaped declaration; normalize that boundary.
type RobotsRules = {
  isAllowed(url: string, userAgent: string): boolean | undefined;
  getCrawlDelay(userAgent: string): number | undefined;
};
const parseRobots = robotsParser as unknown as (url: string, text: string) => RobotsRules;

async function withinDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new RetrievalError("TIMEOUT", "Fetch deadline exceeded.")), Math.max(0, deadline - Date.now()));
    })]);
  } finally { clearTimeout(timer); }
}

export function retryDelay(header: string | undefined, attempt: number, now = Date.now()): number {
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }
  return 500 * 2 ** attempt + Math.floor(Math.random() * 100);
}

export class RetrievalClient {
  readonly trace: SourceTrace[] = [];
  private readonly options: Required<Omit<RetrievalOptions, "policy">>;
  private readonly deadline: number;
  private requests = 0;
  private readonly lastStart = new Map<string, number>();
  private readonly crawlDelays = new Map<string, number>();
  private readonly robots = new Map<string, Promise<RobotsRules>>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly config: RetrievalOptions = {}, private readonly dependencies: RetrievalDependencies = {}) {
    this.options = {
      timeoutMs: 10000, budgetMs: 45000, minIntervalMs: 250, maxRequests: 40,
      maxRedirects: 5, retries: 2, maxBytes: 1024 * 1024, maxDecodedBytes: 1024 * 1024,
      ...Object.fromEntries(Object.entries(config).filter(([key]) => key !== "policy")),
    };
    for (const [name, value] of Object.entries(this.options)) {
      if (!Number.isSafeInteger(value) || value < (["minIntervalMs", "maxRedirects", "retries"].includes(name) ? 0 : 1)) {
        throw new Error(`Invalid retrieval option: ${name}`);
      }
    }
    this.deadline = Date.now() + this.options.budgetMs;
  }

  private record(url: string, purpose: SourceTrace["purpose"], outcome: SourceTrace["outcome"], extras: Partial<SourceTrace> = {}) {
    this.trace.push({ url: safeTraceUrl(url), purpose, outcome, at: new Date().toISOString(), ...extras });
  }

  private async wait(ms: number, deadline: number) {
    if (Date.now() + ms >= deadline) throw new RetrievalError("BUDGET_EXHAUSTED", "Not enough time remains for a paced request or retry.");
    if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async request(url: URL, purpose: SourceTrace["purpose"], deadline: number): Promise<HttpResponse> {
    for (let attempt = 0; ; attempt++) {
      if (Date.now() >= deadline || this.requests >= this.options.maxRequests) {
        throw new RetrievalError("BUDGET_EXHAUSTED", "Retrieval time or request budget exhausted.");
      }
      try {
        const destination = await withinDeadline(validateDestination(url.href, this.config.policy, this.dependencies.resolver), deadline);
        const interval = Math.max(this.options.minIntervalMs, this.crawlDelays.get(url.hostname) ?? 0);
        await this.wait(Math.max(0, (this.lastStart.get(url.hostname) ?? 0) + interval - Date.now()), deadline);
        this.lastStart.set(url.hostname, Date.now());
        this.requests++;
        const response = await (this.dependencies.transport ?? requestPinned)(destination.url, destination.address, {
          deadline, maxBytes: purpose === "robots" ? Math.min(this.options.maxBytes, 512000) : this.options.maxBytes,
          maxDecodedBytes: purpose === "robots" ? Math.min(this.options.maxDecodedBytes, 512000) : this.options.maxDecodedBytes,
          contentTypes: purpose === "robots" ? ["text/plain"] : ["text/html", "application/xhtml+xml", "text/plain"],
        });
        if ((response.status === 429 || [500, 502, 503, 504].includes(response.status)) && attempt < this.options.retries) {
          this.record(url.href, purpose, "retry", { status: response.status, attempt: attempt + 1 });
          await this.wait(retryDelay(response.headers["retry-after"], attempt), deadline);
          continue;
        }
        this.record(url.href, purpose, redirectStatuses.has(response.status) ? "redirect" : response.status >= 200 && response.status < 300 ? "fetched" : "failed", {
          status: response.status, attempt: attempt + 1,
        });
        return response;
      } catch (error) {
        const safe = error instanceof RetrievalError ? error : new RetrievalError("NETWORK_ERROR", "Source could not be retrieved.");
        if (["NETWORK_ERROR", "DNS_FAILED"].includes(safe.code) && attempt < this.options.retries) {
          this.record(url.href, purpose, "retry", { code: safe.code, attempt: attempt + 1 });
          await this.wait(retryDelay(undefined, attempt), deadline);
          continue;
        }
        this.record(url.href, purpose, "failed", { code: safe.code, attempt: attempt + 1 });
        throw safe;
      }
    }
  }

  private async rules(url: URL, deadline: number) {
    let rules = this.robots.get(url.origin);
    if (!rules) {
      rules = (async () => {
        const robotsUrl = new URL("/robots.txt", url);
        const result = await this.follow(robotsUrl, "robots", deadline);
        if ([404, 410].includes(result.status)) return parseRobots(robotsUrl.href, "");
        if ([401, 403].includes(result.status)) return parseRobots(robotsUrl.href, "User-agent: *\nDisallow: /");
        if (result.status < 200 || result.status >= 300) throw new RetrievalError("ROBOTS_UNAVAILABLE", "Cannot determine robots permissions; source skipped.");
        // Associate redirected rules with the original origin.
        return parseRobots(robotsUrl.href, result.text);
      })();
      this.robots.set(url.origin, rules);
    }
    const parsed = await rules;
    const delay = parsed.getCrawlDelay(USER_AGENT);
    if (delay !== undefined && Number.isFinite(delay) && delay >= 0) this.crawlDelays.set(url.hostname, delay * 1000);
    return parsed;
  }

  private async follow(initial: URL, purpose: SourceTrace["purpose"], deadline: number): Promise<HttpResponse & { url: string }> {
    let url = initial;
    const seen = new Set<string>();
    for (let redirects = 0; ; redirects++) {
      if (seen.has(url.href)) throw new RetrievalError("REDIRECT_LOOP", "Redirect loop detected.");
      seen.add(url.href);
      if (purpose === "page") {
        // Check destination even before attempting its robots endpoint.
        await withinDeadline(validateDestination(url.href, this.config.policy, this.dependencies.resolver), deadline);
        const rules = await this.rules(url, deadline);
        if (rules.isAllowed(url.href, USER_AGENT) !== true) throw new RetrievalError("ROBOTS_BLOCKED", "robots.txt disallows this source.");
      }
      const response = await this.request(url, purpose, deadline);
      if (!redirectStatuses.has(response.status)) return { ...response, url: url.href };
      if (redirects >= this.options.maxRedirects) throw new RetrievalError("TOO_MANY_REDIRECTS", "Redirect limit exceeded.");
      if (!response.headers.location) throw new RetrievalError("INVALID_REDIRECT", "Redirect has no destination.");
      try { url = parseHttpUrl(new URL(response.headers.location, url).href); }
      catch { throw new RetrievalError("INVALID_REDIRECT", "Redirect destination is invalid."); }
    }
  }

  /** Serializes calls on this client, including robots requests and retries. */
  fetchPage(input: string): Promise<HttpResponse & { url: string }> {
    const task = this.queue.then(async () => {
      try {
        const url = parseHttpUrl(input);
        const deadline = Math.min(this.deadline, Date.now() + this.options.timeoutMs);
        const result = await this.follow(url, "page", deadline);
        if (result.status < 200 || result.status >= 300) throw new RetrievalError(`HTTP_${result.status}`, "Source returned an unsuccessful HTTP status.");
        return result;
      } catch (error) {
        const safe = error instanceof RetrievalError ? error : new RetrievalError("NETWORK_ERROR", "Source could not be retrieved.");
        this.record(input, "page", "skipped", { code: safe.code });
        throw safe;
      }
    });
    this.queue = task.catch(() => undefined);
    return task;
  }
}
