import {
  checkCoverage,
  validateKit,
  type RegeneratedSection,
  type RegenerationTarget,
} from "@jobber/core";
import { z } from "zod";
import {
  normalizeKitMetadata,
  type ContentMetadata,
  type KitStore,
  type OwnedKit,
} from "./kits.js";

export type RegenerationStatus = "queued" | "running" | "completed" | "failed";

export type RegenerationJob = {
  id: string;
  ownerId: string;
  kitId: string;
  target: RegenerationTarget;
  baseRevision: number;
  status: RegenerationStatus;
  leaseToken?: string;
  leaseExpiresAt?: Date;
  error?: { code: string; message: string };
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
};

export type ClaimedRegeneration = RegenerationJob & {
  status: "running";
  leaseToken: string;
  leaseExpiresAt: Date;
};

export interface RegenerationStore extends KitStore {
  enqueueRegeneration(input: {
    ownerId: string;
    kitId: string;
    target: RegenerationTarget;
    baseRevision: number;
    now: Date;
  }): Promise<RegenerationJob>;
  findOwnedRegeneration(ownerId: string, jobId: string): Promise<RegenerationJob | null>;
  claimNextRegeneration(workerId: string, now: Date, leaseMs: number): Promise<ClaimedRegeneration | null>;
  renewRegenerationLease(jobId: string, leaseToken: string, now: Date, leaseMs: number): Promise<boolean>;
  completeRegeneration(jobId: string, leaseToken: string, now: Date): Promise<boolean>;
  failRegeneration(jobId: string, leaseToken: string, error: { code: string; message: string }, now: Date): Promise<boolean>;
  releaseRegeneration(jobId: string, leaseToken: string, now: Date): Promise<boolean>;
}

const targetSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("company-brief") }),
  z.strictObject({ type: z.literal("question-category"), category: z.enum(["technical", "behavioural", "system-design", "company-fit"]) }),
  z.strictObject({ type: z.literal("schedule") }),
]);

export class RegenerationError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message);
    this.name = "RegenerationError";
  }
}

export class RegenerationService {
  constructor(private readonly store: RegenerationStore) {}

  async enqueue(ownerId: string, kitId: string, body: unknown, now = new Date()): Promise<RegenerationJob> {
    const target = targetSchema.safeParse(body);
    if (!target.success) throw new RegenerationError("INVALID_REGENERATION_TARGET", 400, "Choose a valid section to regenerate.");
    const kit = await this.store.findOwnedKit(ownerId, kitId);
    if (!kit) throw new RegenerationError("NOT_FOUND", 404, "Kit not found.");
    return this.store.enqueueRegeneration({ ownerId, kitId, target: target.data, baseRevision: kit.revision, now });
  }

  async getOwned(ownerId: string, jobId: string): Promise<RegenerationJob> {
    const job = await this.store.findOwnedRegeneration(ownerId, jobId);
    if (!job) throw new RegenerationError("NOT_FOUND", 404, "Regeneration job not found.");
    return job;
  }
}

function replaceCategory(
  latest: OwnedKit,
  job: RegenerationJob,
  result: Extract<RegeneratedSection, { type: "question-category" }>,
): { content: OwnedKit["content"]; metadata: OwnedKit["metadata"] } {
  const content = structuredClone(latest.content);
  const metadata = structuredClone(normalizeKitMetadata(latest.content, latest.metadata, latest.sourceJobId, latest.revision));
  const protectedQuestions = content.questions.filter((question) => {
    if (question.category !== result.category) return false;
    const meta = metadata.questions[question.id];
    return !meta || meta.origin === "manual" || meta.userEdited || meta.pinned || meta.revision > job.baseRevision;
  });
  const deletedIds = new Set(latest.tombstones.filter(({ kind }) => kind === "question").map(({ id }) => id));
  const requirementIds = new Set(content.role.requirements.map(({ id }) => id));
  const protectedIds = new Set(protectedQuestions.map(({ id }) => id));
  const reservedIds = new Set(content.questions.filter(({ category }) => category !== result.category).map(({ id }) => id));
  const generated = result.questions.filter((question) => (
    !deletedIds.has(question.id)
    && !protectedIds.has(question.id)
    && !reservedIds.has(question.id)
    && question.requirement_ids.every((id) => requirementIds.has(id))
  ));
  const replacement = [...protectedQuestions, ...generated];
  const firstTarget = content.questions.findIndex(({ category }) => category === result.category);
  const withoutTarget = content.questions.filter(({ category }) => category !== result.category);
  const insertion = firstTarget < 0 ? withoutTarget.length : content.questions.slice(0, firstTarget).filter(({ category }) => category !== result.category).length;
  withoutTarget.splice(insertion, 0, ...replacement);
  content.questions = withoutTarget;
  const liveIds = new Set(content.questions.map(({ id }) => id));
  content.schedule.days = content.schedule.days.map((day) => ({ ...day, question_ids: day.question_ids.filter((id) => liveIds.has(id)) }));
  content.coverage.uncovered_requirement_ids = checkCoverage(content.role.requirements, content.questions).uncovered_requirement_ids;
  metadata.questions = Object.fromEntries(content.questions.map((question) => {
    const existing = metadata.questions[question.id];
    if (existing) return [question.id, existing];
    const value: ContentMetadata = {
      origin: "generated", userEdited: false, pinned: false,
      revision: latest.revision + 1, generationRunId: job.id,
    };
    return [question.id, value];
  }));
  return { content, metadata };
}

export function mergeRegeneratedSection(
  latest: OwnedKit,
  job: RegenerationJob,
  result: RegeneratedSection,
): { content: OwnedKit["content"]; metadata: OwnedKit["metadata"] } {
  if (result.type === "question-category") return replaceCategory(latest, job, result);
  const content = structuredClone(latest.content);
  const metadata = structuredClone(normalizeKitMetadata(latest.content, latest.metadata, latest.sourceJobId, latest.revision));
  const key = result.type === "company-brief" ? "companyBrief" : "schedule";
  const current = metadata[key];
  if (current.origin === "manual" || current.userEdited || current.pinned || current.revision > job.baseRevision) {
    return { content, metadata };
  }
  if (result.type === "company-brief") content.company_brief = { ...content.company_brief, ...result.companyBrief };
  else content.schedule = result.schedule;
  metadata[key] = {
    origin: "generated", userEdited: false, pinned: false,
    revision: latest.revision + 1, generationRunId: job.id,
  };
  return { content, metadata };
}

export type SectionRegenerator = (input: {
  kit: OwnedKit["content"];
  jd: string;
  target: RegenerationTarget;
}) => Promise<RegeneratedSection>;

export class RegenerationRunner {
  private stopped = false;
  private started = false;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private active: { jobId: string; leaseToken: string; leaseLost: boolean } | undefined;

  constructor(
    private readonly store: RegenerationStore,
    private readonly regenerate: SectionRegenerator,
    private readonly config: { workerId: string; leaseMs: number; pollMs: number },
    private readonly now: () => Date = () => new Date(),
  ) {}

  start(): void { if (this.started) return; this.started = true; this.stopped = false; this.schedule(0); }
  wake(): void { if (this.started && !this.stopped && !this.running) { if (this.timer) clearTimeout(this.timer); this.schedule(0); } }
  async stop(): Promise<void> {
    this.stopped = true;
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.active) {
      this.active.leaseLost = true;
      await this.store.releaseRegeneration(this.active.jobId, this.active.leaseToken, this.now());
    }
  }

  async runOnce(): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    try {
      const job = await this.store.claimNextRegeneration(this.config.workerId, this.now(), this.config.leaseMs);
      if (!job) return false;
      await this.execute(job);
      return true;
    } finally { this.running = false; }
  }

  private schedule(delay: number): void {
    this.timer = setTimeout(() => void this.tick(), delay);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.running) return;
    try {
      const worked = await this.runOnce();
      if (!this.stopped) this.schedule(worked ? 0 : this.config.pollMs);
    } catch {
      if (!this.stopped) this.schedule(this.config.pollMs);
    }
  }

  private async execute(job: ClaimedRegeneration): Promise<void> {
    const active = { jobId: job.id, leaseToken: job.leaseToken, leaseLost: false };
    this.active = active;
    const heartbeat = setInterval(() => {
      void this.store.renewRegenerationLease(job.id, job.leaseToken, this.now(), this.config.leaseMs)
        .then((renewed) => { if (!renewed) active.leaseLost = true; })
        .catch(() => { active.leaseLost = true; });
    }, Math.max(100, Math.floor(this.config.leaseMs / 3)));
    heartbeat.unref();
    try {
      const startingKit = await this.store.findOwnedKit(job.ownerId, job.kitId);
      if (!startingKit) throw new RegenerationError("NOT_FOUND", 404, "Kit not found.");
      const generated = await this.regenerate({ kit: startingKit.content, jd: startingKit.originalInput.jd, target: job.target });
      let merged = false;
      for (let attempt = 0; attempt < 3 && !merged; attempt += 1) {
        if (active.leaseLost || this.stopped || !(await this.store.renewRegenerationLease(job.id, job.leaseToken, this.now(), this.config.leaseMs))) {
          throw new RegenerationError("LEASE_LOST", 409, "The regeneration worker lease was lost.");
        }
        const latest = await this.store.findOwnedKit(job.ownerId, job.kitId);
        if (!latest) throw new RegenerationError("NOT_FOUND", 404, "Kit not found.");
        const candidate = mergeRegeneratedSection(latest, job, generated);
        const validation = validateKit(candidate.content, { requestedDays: latest.originalInput.days, mode: "draft" });
        if (!validation.success) throw new RegenerationError("INVALID_REGENERATION", 500, "Regeneration produced invalid references.");
        const updated = await this.store.updateOwnedKit({
          ownerId: job.ownerId,
          kitId: job.kitId,
          expectedRevision: latest.revision,
          content: validation.data,
          metadata: candidate.metadata,
          tombstones: latest.tombstones,
          now: this.now(),
        });
        merged = updated.kind === "updated";
        if (updated.kind === "not_found") throw new RegenerationError("NOT_FOUND", 404, "Kit not found.");
      }
      if (!merged) throw new RegenerationError("REGENERATION_CONFLICT", 409, "The kit kept changing while regeneration was merging. Try again.");
      await this.store.completeRegeneration(job.id, job.leaseToken, this.now());
    } catch (error) {
      if (active.leaseLost || this.stopped || (error instanceof RegenerationError && error.code === "LEASE_LOST")) return;
      const failure = error instanceof RegenerationError
        ? { code: error.code, message: error.message }
        : { code: "REGENERATION_FAILED", message: "The section could not be regenerated." };
      await this.store.failRegeneration(job.id, job.leaseToken, failure, this.now());
    } finally {
      clearInterval(heartbeat);
      if (this.active === active) this.active = undefined;
    }
  }
}

export function publicRegeneration(job: RegenerationJob) {
  return {
    id: job.id,
    kitId: job.kitId,
    target: job.target,
    baseRevision: job.baseRevision,
    status: job.status,
    ...(job.error ? { error: job.error } : {}),
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    ...(job.completedAt ? { completedAt: job.completedAt.toISOString() } : {}),
  };
}
