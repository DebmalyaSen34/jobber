import { createHash, randomUUID } from "node:crypto";
import {
  GenerationError,
  type EvaluationCase,
  type Kit,
  type KitGenerator,
  type PipelineProgress,
  type PipelineStage,
} from "@jobber/core";
import { z } from "zod";

export const jobStatuses = ["queued", "running", "retry_wait", "completed", "completed_with_warnings", "failed"] as const;
export type JobStatus = (typeof jobStatuses)[number];
export type JobStage = "queued" | PipelineStage;

export type JobInput = {
  jd: string;
  companyUrl: string;
  days: number;
};

export type JobProgress = PipelineProgress;

export type JobFailure = {
  code: string;
  message: string;
  retryable: boolean;
};

export type GenerationJob = {
  id: string;
  ownerId: string;
  kitId: string;
  fingerprint: string;
  pipelineVersion: string;
  input: JobInput;
  status: JobStatus;
  stage: JobStage;
  progress: JobProgress[];
  warnings: Array<{ code: string; message: string; url?: string }>;
  attempt: number;
  maxAttempts: number;
  nextAttemptAt?: Date;
  leaseToken?: string;
  leaseOwner?: string;
  leaseExpiresAt?: Date;
  error?: JobFailure;
  result?: Kit;
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  completedAt?: Date;
};

export type ClaimedJob = GenerationJob & {
  status: "running";
  leaseToken: string;
  leaseOwner: string;
  leaseExpiresAt: Date;
};

export interface JobStore {
  enqueueJob(input: {
    ownerId: string;
    fingerprint: string;
    pipelineVersion: string;
    jobInput: JobInput;
    maxAttempts: number;
    now: Date;
  }): Promise<{ job: GenerationJob; deduplicated: boolean }>;
  findOwnedJob(ownerId: string, jobId: string): Promise<GenerationJob | null>;
  listOwnedJobs(ownerId: string, limit: number): Promise<GenerationJob[]>;
  claimNextJob(workerId: string, now: Date, leaseMs: number): Promise<ClaimedJob | null>;
  renewJobLease(jobId: string, leaseToken: string, now: Date, leaseMs: number): Promise<boolean>;
  checkpointJob(jobId: string, leaseToken: string, progress: JobProgress, now: Date, leaseMs: number): Promise<boolean>;
  completeJob(jobId: string, leaseToken: string, kit: Kit, now: Date): Promise<boolean>;
  recordJobFailure(input: {
    jobId: string;
    leaseToken: string;
    failure: JobFailure;
    retryAt?: Date;
    now: Date;
  }): Promise<boolean>;
  releaseJob(jobId: string, leaseToken: string, now: Date): Promise<boolean>;
  retryOwnedJob(ownerId: string, jobId: string, now: Date): Promise<GenerationJob | null>;
  materializeCompletedKits(): Promise<void>;
}

const createJobSchema = z.object({
  jd: z.string().max(100_000).refine((value) => value.trim().length > 0, "Job description is required."),
  company_url: z.string().trim().max(2_048).url("Enter a valid company URL.").refine((value) => {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
  }, "Company URL must use HTTP or HTTPS and cannot contain credentials."),
  days: z.number().int("Days must be a whole number.").min(1, "Days must be at least 1.").max(60, "Days must be at most 60."),
}).strict();

function canonicalUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) {
    url.port = "";
  }
  url.pathname = url.pathname.replace(/\/{2,}/g, "/");
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/$/, "");
  url.searchParams.sort();
  return url.toString();
}

function normalizedJd(value: string): string {
  return value.normalize("NFKC").replace(/\r\n?/g, "\n").split("\n").map((line) => line.trimEnd()).join("\n").trim();
}

export function parseJobInput(input: unknown): JobInput {
  const parsed = createJobSchema.safeParse(input);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const field = String(issue.path[0] ?? "form");
      if (!(field in fields)) fields[field] = issue.message;
    }
    throw new JobError("INVALID_INPUT", 400, "Please correct the highlighted fields.", { fields });
  }
  return { jd: parsed.data.jd, companyUrl: canonicalUrl(parsed.data.company_url), days: parsed.data.days };
}

export function fingerprintJobInput(input: JobInput, pipelineVersion: string): string {
  return createHash("sha256").update(JSON.stringify({
    jd: normalizedJd(input.jd),
    company_url: canonicalUrl(input.companyUrl),
    days: input.days,
    pipeline_version: pipelineVersion,
  })).digest("base64url");
}

export class JobError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly options: { fields?: Record<string, string>; retryable?: boolean; existingJobId?: string } = {},
  ) {
    super(message);
    this.name = "JobError";
  }
}

export type JobServiceConfig = { pipelineVersion: string; maxAttempts: number };

export class JobService {
  constructor(private readonly store: JobStore, private readonly config: JobServiceConfig) {}

  async enqueue(ownerId: string, body: unknown, now = new Date()) {
    const input = parseJobInput(body);
    return this.store.enqueueJob({
      ownerId,
      fingerprint: fingerprintJobInput(input, this.config.pipelineVersion),
      pipelineVersion: this.config.pipelineVersion,
      jobInput: input,
      maxAttempts: this.config.maxAttempts,
      now,
    });
  }

  async getOwned(ownerId: string, jobId: string): Promise<GenerationJob> {
    const job = await this.store.findOwnedJob(ownerId, jobId);
    if (!job) throw new JobError("NOT_FOUND", 404, "Job not found.");
    return job;
  }

  async listOwned(ownerId: string): Promise<GenerationJob[]> {
    return this.store.listOwnedJobs(ownerId, 100);
  }

  async enqueueBatch(ownerId: string, body: unknown, now = new Date()) {
    if (!Array.isArray(body)) {
      throw new JobError("INVALID_BATCH", 400, "Upload a JSON array of preparation cases.");
    }
    if (body.length > 50) {
      throw new JobError("BATCH_TOO_LARGE", 400, "A batch can contain at most 50 cases.");
    }

    const seenIds = new Set<string>();
    const results = [];
    let queuedCount = 0;
    for (const [index, value] of body.entries()) {
      const record = value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
      const id = typeof record.id === "string" ? record.id.trim() : "";
      if (!id || seenIds.has(id)) {
        results.push({
          row: index + 1,
          ...(id ? { id } : {}),
          status: "invalid" as const,
          error: {
            code: !id ? "MISSING_ID" : "DUPLICATE_ID",
            message: !id ? "Each case needs a non-empty id." : `Case id ${id} is duplicated.`,
            fields: { id: !id ? "Case ID is required." : "Case ID must be unique in this upload." },
          },
        });
        continue;
      }
      seenIds.add(id);
      try {
        const queued = await this.enqueue(ownerId, {
          jd: record.jd,
          company_url: record.company_url,
          days: record.days,
        }, now);
        queuedCount += 1;
        results.push({
          row: index + 1,
          id,
          status: "queued" as const,
          deduplicated: queued.deduplicated,
          job: publicJob(queued.job),
        });
      } catch (error) {
        if (!(error instanceof JobError)) throw error;
        results.push({
          row: index + 1,
          id,
          status: "invalid" as const,
          error: {
            code: error.code,
            message: error.message,
            ...(error.options.fields ? { fields: error.options.fields } : {}),
          },
        });
      }
    }
    return { results, queuedCount };
  }

  async retry(ownerId: string, jobId: string, now = new Date()): Promise<GenerationJob> {
    const existing = await this.getOwned(ownerId, jobId);
    if (existing.status !== "failed") {
      throw new JobError("JOB_NOT_RETRYABLE", 409, "Only failed jobs can be retried.", {
        retryable: false,
        ...(existing.status === "queued" || existing.status === "running" || existing.status === "retry_wait"
          ? { existingJobId: existing.id }
          : {}),
      });
    }
    const job = await this.store.retryOwnedJob(ownerId, jobId, now);
    if (!job) throw new JobError("JOB_RETRY_CONFLICT", 409, "An equivalent generation job is already active.");
    return job;
  }
}

export function publicJob(job: GenerationJob) {
  return {
    id: job.id,
    kitId: job.kitId,
    status: job.status,
    stage: job.stage,
    progress: job.progress.map((progress) => ({ ...progress })),
    warnings: job.warnings.map((warning) => ({ ...warning })),
    source: {
      companyUrl: job.input.companyUrl,
      days: job.input.days,
      jdChars: job.input.jd.length,
    },
    retry: {
      attempt: job.attempt,
      maxAttempts: job.maxAttempts,
      ...(job.nextAttemptAt ? { nextAttemptAt: job.nextAttemptAt.toISOString() } : {}),
    },
    ...(job.error ? { error: { ...job.error } } : {}),
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    ...(job.startedAt ? { startedAt: job.startedAt.toISOString() } : {}),
    ...(job.completedAt ? { completedAt: job.completedAt.toISOString() } : {}),
  };
}

type JobRunnerConfig = {
  workerId: string;
  leaseMs: number;
  pollMs: number;
  retryBaseMs: number;
};

function hasRetryableCause(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if ("retryable" in current && current.retryable === true) return true;
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

function failureFor(error: unknown): JobFailure {
  if (error instanceof GenerationError) {
    return { code: error.code, message: error.message, retryable: hasRetryableCause(error) };
  }
  return { code: "GENERATION_FAILED", message: "The generation job failed unexpectedly.", retryable: false };
}

function evaluationInput(job: ClaimedJob): EvaluationCase {
  return { id: job.id, jd: job.input.jd, company_url: job.input.companyUrl, days: job.input.days };
}

export class JobRunner {
  private stopped = false;
  private started = false;
  private timer: NodeJS.Timeout | undefined;
  private tickRunning = false;
  private active: { jobId: string; leaseToken: string; leaseLost: boolean } | undefined;

  constructor(
    private readonly store: JobStore,
    private readonly generator: KitGenerator,
    private readonly config: JobRunnerConfig,
    private readonly now: () => Date = () => new Date(),
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.schedule(0);
  }

  wake(): void {
    if (!this.started || this.stopped || this.tickRunning) return;
    if (this.timer) clearTimeout(this.timer);
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.active) {
      this.active.leaseLost = true;
      await this.store.releaseJob(this.active.jobId, this.active.leaseToken, this.now());
    }
  }

  async runOnce(): Promise<boolean> {
    if (this.tickRunning) return false;
    this.tickRunning = true;
    try {
      const job = await this.store.claimNextJob(this.config.workerId, this.now(), this.config.leaseMs);
      if (!job) return false;
      await this.execute(job);
      return true;
    } finally {
      this.tickRunning = false;
    }
  }

  private schedule(delay: number): void {
    this.timer = setTimeout(() => {
      void this.tick();
    }, delay);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.tickRunning) return;
    try {
      const worked = await this.runOnce();
      if (!this.stopped) this.schedule(worked ? 0 : this.config.pollMs);
    } catch {
      if (!this.stopped) this.schedule(this.config.pollMs);
    }
  }

  private async execute(job: ClaimedJob): Promise<void> {
    const active = { jobId: job.id, leaseToken: job.leaseToken, leaseLost: false };
    this.active = active;
    const heartbeatMs = Math.max(100, Math.floor(this.config.leaseMs / 3));
    const heartbeat = setInterval(() => {
      void this.store.renewJobLease(job.id, job.leaseToken, this.now(), this.config.leaseMs).then((renewed) => {
        if (!renewed) active.leaseLost = true;
      }).catch(() => {
        active.leaseLost = true;
      });
    }, heartbeatMs);
    heartbeat.unref();

    try {
      const kit = await this.generator(evaluationInput(job), async (progress) => {
        if (active.leaseLost || this.stopped) throw new JobError("LEASE_LOST", 409, "The worker lease was lost.");
        const written = await this.store.checkpointJob(
          job.id,
          job.leaseToken,
          progress,
          this.now(),
          this.config.leaseMs,
        );
        if (!written) {
          active.leaseLost = true;
          throw new JobError("LEASE_LOST", 409, "The worker lease was lost.");
        }
      });
      if (!active.leaseLost && !this.stopped) {
        await this.store.completeJob(job.id, job.leaseToken, kit, this.now());
      }
    } catch (error) {
      if (active.leaseLost || this.stopped || (error instanceof JobError && error.code === "LEASE_LOST")) return;
      const failure = failureFor(error);
      const canRetry = failure.retryable && job.attempt < job.maxAttempts;
      const retryAt = canRetry
        ? new Date(this.now().getTime() + this.config.retryBaseMs * 2 ** Math.max(0, job.attempt - 1))
        : undefined;
      await this.store.recordJobFailure({
        jobId: job.id,
        leaseToken: job.leaseToken,
        failure,
        ...(retryAt ? { retryAt } : {}),
        now: this.now(),
      });
    } finally {
      clearInterval(heartbeat);
      if (this.active === active) this.active = undefined;
    }
  }
}

export function createWorkerId(release: string): string {
  return `${release}:${process.pid}:${randomUUID()}`;
}
