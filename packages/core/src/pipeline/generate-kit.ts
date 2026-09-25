import { evaluationCaseSchema, type EvaluationCase } from "../schemas/evaluation.js";
import { type Kit } from "../schemas/kit.js";
import { validateKit } from "../validation/validate-kit.js";
import { allocateSchedule } from "../scheduling/allocate-schedule.js";
import { crawlCompany, localFixturePolicy, type CrawlOptions, type RetrievalDependencies } from "../retrieval/index.js";
import {
  resolveCompanyIdentity,
  searchPublicDiscussions,
  type DiscussionOptions,
  type DiscussionEvidence,
} from "../research/index.js";
import { extractRequirements, ExtractionError } from "../extraction/index.js";
import {
  createGeminiProviderFromEnv,
  generateCompanyBrief,
  generateFlashcards,
  generateQuestionsWithCoverage,
  GenerationContentError,
  ProviderError,
  ProviderGate,
  ReliableJsonProvider,
  type GenerationTraceEntry,
  type JsonProvider,
  type ProviderBudgetSnapshot,
} from "../generation/index.js";

/** Safe, user-facing failures; never wrap raw provider errors with credentials. */
export class GenerationError extends Error {
  constructor(public readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GenerationError";
  }
}

export type KitGenerator = (
  input: EvaluationCase,
  onProgress?: (progress: PipelineProgress) => void | Promise<void>,
) => Promise<Kit>;

export type PipelineStage =
  | "researching"
  | "extracting"
  | "synthesizing"
  | "generating"
  | "checking_coverage"
  | "repairing"
  | "flashcards"
  | "scheduling"
  | "validating";

export type PipelineProgress = {
  stage: PipelineStage;
  at: string;
  detail?: string;
};

export type PipelineOptions = {
  deadlineMs?: number;
  providerMaxRequests?: number;
  providerMaxTokens?: number;
  providerRetries?: number;
  providerBaseDelayMs?: number;
  providerMaxRetryDelayMs?: number;
  crawl?: CrawlOptions;
  discussions?: DiscussionOptions;
};

type CrawlResult = Awaited<ReturnType<typeof crawlCompany>>;
type DiscussionResult = Awaited<ReturnType<typeof searchPublicDiscussions>>;

export type PipelineDependencies = {
  provider: JsonProvider;
  providerGate?: ProviderGate;
  crawl?: typeof crawlCompany;
  searchDiscussions?: typeof searchPublicDiscussions;
  crawlDependencies?: RetrievalDependencies;
  discussionDependencies?: RetrievalDependencies;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

const defaultDeadlineMs = 12 * 60 * 1_000;
let configuredProvider: JsonProvider | undefined;
let configuredGate: ProviderGate | undefined;

function envInteger(env: NodeJS.ProcessEnv, name: string, fallback: number, allowZero = false): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new GenerationError("PROVIDER_CONFIGURATION", `${name} must be ${allowZero ? "a nonnegative" : "a positive"} integer.`);
  }
  return value;
}

function optionsFromEnv(env: NodeJS.ProcessEnv): PipelineOptions {
  return {
    deadlineMs: envInteger(env, "PIPELINE_DEADLINE_MS", defaultDeadlineMs),
    providerMaxRequests: envInteger(env, "GEMINI_MAX_REQUESTS_PER_CASE", 20),
    providerMaxTokens: envInteger(env, "GEMINI_MAX_TOKENS_PER_CASE", 30_000),
    providerRetries: envInteger(env, "GEMINI_RETRIES", 3, true),
    providerBaseDelayMs: envInteger(env, "GEMINI_RETRY_BASE_MS", 1_000, true),
    providerMaxRetryDelayMs: envInteger(env, "GEMINI_MAX_RETRY_DELAY_MS", 60_000, true),
  };
}

function configuredDependencies(env: NodeJS.ProcessEnv): PipelineDependencies {
  configuredProvider ??= createGeminiProviderFromEnv(env);
  configuredGate ??= new ProviderGate({
    minIntervalMs: envInteger(env, "GEMINI_MIN_INTERVAL_MS", 4_200, true),
    maxConcurrent: envInteger(env, "GEMINI_MAX_CONCURRENCY", 1),
  });
  return { provider: configuredProvider, providerGate: configuredGate };
}

function evaluationCrawlOptions(input: EvaluationCase): CrawlOptions {
  try {
    const url = new URL(input.company_url);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return loopback ? { policy: localFixturePolicy([url.origin]) } : {};
  } catch {
    return {};
  }
}

function safeGenerationError(error: unknown): GenerationError {
  if (error instanceof GenerationError) return error;
  if (error instanceof ProviderError) return new GenerationError(error.code, error.message, { cause: error });
  if (error instanceof GenerationContentError || error instanceof ExtractionError) {
    return new GenerationError(error.code, error.message, { cause: error });
  }
  return new GenerationError("GENERATION_FAILED", "The generation pipeline failed unexpectedly.", { cause: error });
}

function fallbackCrawl(message: string): CrawlResult {
  return {
    pages: [], hiring_pages: [], trace: [], researched_at: new Date().toISOString(),
    warnings: [{ code: "RESEARCH_FAILED", message }],
  };
}

function fallbackDiscussions(message: string): DiscussionResult {
  return {
    provider: "hacker-news-algolia",
    scope: "Hacker News only; up to two queries and 20 hits per query",
    identity: null,
    attempts: [], evidence: [], trace: [], searched_at: new Date().toISOString(),
    warnings: [{ code: "SEARCH_FAILED", message }],
    status: "failed",
  };
}

function warningsFor(
  extractionWarnings: readonly string[],
  crawl: CrawlResult,
  discussions: DiscussionResult,
  briefWarnings: readonly string[],
  generationWarnings: readonly string[],
): Array<{ code: string; message: string; url?: string }> {
  return [
    ...extractionWarnings.map((message) => ({ code: "EXTRACTION_LIMITATION", message })),
    ...crawl.warnings.map(({ code, message, url }) => ({ code, message, ...(url ? { url } : {}) })),
    ...discussions.warnings.map(({ code, message }) => ({ code, message })),
    ...briefWarnings.map((message) => ({ code: "COMPANY_BRIEF_LIMITATION", message })),
    ...generationWarnings.map((message) => ({ code: "COVERAGE_LIMITATION", message })),
  ];
}

function generationContext(
  title: string,
  brief: Awaited<ReturnType<typeof generateCompanyBrief>>["brief"],
  pages: CrawlResult["pages"],
  discussions: readonly DiscussionEvidence[],
) {
  const hiringPages = pages.filter(({ kind }) => kind === "hiring").map((page) => ({
    source: "official hiring page",
    excerpt: page.text.slice(0, 2_000),
    url: page.url,
  }));
  return {
    roleTitle: title,
    companyBrief: {
      summary: brief.summary,
      whatTheyDo: brief.what_they_do,
      sources: brief.sources,
    },
    hiringEvidence: [
      ...hiringPages,
      ...discussions.slice(0, 10).map((item) => ({
        source: "anecdotal public discussion",
        excerpt: item.excerpt.slice(0, 1_500),
        url: item.url,
      })),
    ],
  };
}

async function emit(
  callback: ((progress: PipelineProgress) => void | Promise<void>) | undefined,
  stage: PipelineStage,
  detail?: string,
): Promise<void> {
  if (callback) await callback({ stage, at: new Date().toISOString(), ...(detail ? { detail } : {}) });
}

async function runPipeline(
  input: EvaluationCase,
  dependencies: PipelineDependencies,
  options: PipelineOptions,
  onProgress?: (progress: PipelineProgress) => void | Promise<void>,
): Promise<Kit> {
  const now = dependencies.now ?? Date.now;
  const deadlineMs = options.deadlineMs ?? defaultDeadlineMs;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1) {
    throw new GenerationError("PROVIDER_CONFIGURATION", "Pipeline deadline must be a positive integer.");
  }
  const deadline = now() + deadlineMs;
  const provider = new ReliableJsonProvider(dependencies.provider, {
    deadline,
    maxRequests: options.providerMaxRequests,
    maxTokens: options.providerMaxTokens,
    retries: options.providerRetries,
    baseDelayMs: options.providerBaseDelayMs,
    maxRetryDelayMs: options.providerMaxRetryDelayMs,
    gate: dependencies.providerGate,
    now,
    sleep: dependencies.sleep,
    random: dependencies.random,
  });

  await emit(onProgress, "researching");
  const crawlPromise = (dependencies.crawl ?? crawlCompany)(
    input.company_url,
    { ...options.crawl, budgetMs: Math.min(options.crawl?.budgetMs ?? 45_000, Math.max(1, deadline - now())) },
    dependencies.crawlDependencies,
  ).catch(() => fallbackCrawl("Company research could not be completed; generation continued from the job description."));
  await emit(onProgress, "extracting");
  const extractionPromise = extractRequirements(input.jd, provider);
  const [crawl, extraction] = await Promise.all([crawlPromise, extractionPromise]);

  const identity = resolveCompanyIdentity({ company_url: input.company_url, jd: input.jd, pages: crawl.pages });
  const discussions = await (dependencies.searchDiscussions ?? searchPublicDiscussions)(
    { company_url: input.company_url, jd: input.jd, pages: crawl.pages },
    {
      ...options.discussions,
      retrieval: {
        ...options.discussions?.retrieval,
        budgetMs: Math.min(options.discussions?.retrieval?.budgetMs ?? 20_000, Math.max(1, deadline - now())),
      },
    },
    dependencies.discussionDependencies,
  ).catch(() => fallbackDiscussions("Public-discussion search could not be completed."));

  await emit(onProgress, "synthesizing");
  const company = await generateCompanyBrief({ identity, pages: crawl.pages, discussions: discussions.evidence }, provider);
  const context = generationContext(extraction.title, company.brief, crawl.pages, discussions.evidence);

  await emit(onProgress, "generating");
  const generated = await generateQuestionsWithCoverage(extraction.requirements, provider, { context });
  await emit(onProgress, "checking_coverage", `Completed ${generated.passes} computed coverage pass(es).`);
  if (generated.passes > 1) await emit(onProgress, "repairing", `Completed ${generated.passes - 1} repair round(s).`);

  await emit(onProgress, "flashcards");
  const cards = await generateFlashcards(extraction.requirements, generated.questions, provider, context);
  await emit(onProgress, "scheduling");
  const schedule = allocateSchedule(extraction.requirements, generated.questions, input.days);
  const trace: GenerationTraceEntry[] = [...company.trace, ...generated.trace, ...cards.trace];
  const providerBudget: ProviderBudgetSnapshot = provider.snapshot;
  const warnings = warningsFor(extraction.warnings, crawl, discussions, company.warnings, generated.warnings);

  const kit: Kit = {
    source: {
      company: identity?.name ?? "",
      company_url: input.company_url,
      role: extraction.title,
      location: extraction.location,
      jd_chars: input.jd.length,
      researched_at: crawl.researched_at,
      pages_used: company.pagesUsed,
    },
    company_brief: company.brief,
    role: {
      title: extraction.title,
      seniority: extraction.seniority,
      responsibilities: extraction.responsibilities,
      requirements: extraction.requirements,
    },
    questions: generated.questions,
    flashcards: cards.flashcards,
    schedule,
    coverage: {
      uncovered_requirement_ids: generated.coverage.uncovered_requirement_ids,
      passes: generated.passes,
    },
    warnings,
    research: {
      crawl: { hiring_pages: crawl.hiring_pages, trace: crawl.trace },
      discussions,
    },
    generation: { trace, provider_calls: provider.trace, provider_budget: providerBudget },
  };

  await emit(onProgress, "validating");
  const validated = validateKit(kit, { requestedDays: input.days, mode: "generated" });
  if (!validated.success) {
    throw new GenerationError("INVALID_KIT", "The pipeline produced an invalid or incomplete kit.");
  }
  return validated.data;
}

export async function generateKitWithDependencies(
  input: EvaluationCase,
  dependencies: PipelineDependencies,
  options: PipelineOptions = {},
  onProgress?: (progress: PipelineProgress) => void | Promise<void>,
): Promise<Kit> {
  const parsed = evaluationCaseSchema.safeParse(input);
  if (!parsed.success) throw new GenerationError("INVALID_CASE", "Generation input is invalid.");
  try {
    return await runPipeline(parsed.data, dependencies, options, onProgress);
  } catch (error) {
    throw safeGenerationError(error);
  }
}

/** Production entry point: public-only retrieval and environment-configured provider. */
export const generateKit: KitGenerator = async (input, onProgress) => {
  try {
    const env = process.env;
    return await generateKitWithDependencies(input, configuredDependencies(env), optionsFromEnv(env), onProgress);
  } catch (error) {
    throw safeGenerationError(error);
  }
};

/** Trusted CLI entry point: permits only the exact loopback origin supplied by a local fixture case. */
export const generateEvaluationKit: KitGenerator = async (input) => {
  try {
    const env = process.env;
    const options = optionsFromEnv(env);
    options.crawl = { ...options.crawl, ...evaluationCrawlOptions(input) };
    return await generateKitWithDependencies(input, configuredDependencies(env), options);
  } catch (error) {
    throw safeGenerationError(error);
  }
};
