import { randomUUID } from "node:crypto";
import type { Kit } from "@jobber/core";
import { MongoClient, MongoServerError, ObjectId, type Collection, type Db } from "mongodb";
import type { AuthStore, AuthUser, LoginLimitDecision, SessionWithUser } from "./auth.js";
import type {
  ClaimedJob,
  GenerationJob,
  JobFailure,
  JobInput,
  JobProgress,
  JobStatus,
  JobStore,
} from "./jobs.js";
import type { KitStore, OwnedKit } from "./kits.js";

export interface Persistence extends AuthStore, JobStore, KitStore {
  connect(): Promise<void>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

type RuntimeRecord = {
  _id: "api";
  boot_count: number;
  instance_id: string;
  release: string;
  started_at: Date;
  last_ready_at: Date;
};

type UserRecord = {
  _id: ObjectId;
  email: string;
  password_hash: string;
  created_at: Date;
  updated_at: Date;
};

type SessionRecord = {
  _id: string;
  user_id: ObjectId;
  csrf_token: string;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
};

type RateLimitRecord = {
  _id: string;
  attempts: Date[];
  expires_at: Date;
};

type JobRecord = {
  _id: ObjectId;
  owner_id: ObjectId;
  kit_id: ObjectId;
  fingerprint: string;
  active_key?: string;
  pipeline_version: string;
  input: JobInput;
  status: JobStatus;
  stage: GenerationJob["stage"];
  progress: JobProgress[];
  warnings: GenerationJob["warnings"];
  attempt: number;
  max_attempts: number;
  next_attempt_at?: Date;
  lease_token?: string;
  lease_owner?: string;
  lease_expires_at?: Date;
  error?: JobFailure;
  result?: Kit;
  created_at: Date;
  updated_at: Date;
  started_at?: Date;
  completed_at?: Date;
};

type KitRecord = {
  _id: ObjectId;
  owner_id: ObjectId;
  source_job_id: ObjectId;
  original_input: JobInput;
  content: Kit;
  revision: number;
  created_at: Date;
  updated_at: Date;
};

function toAuthUser(record: UserRecord): AuthUser {
  return {
    id: record._id.toHexString(),
    email: record.email,
    passwordHash: record.password_hash,
    createdAt: record.created_at,
  };
}

function toGenerationJob(record: JobRecord): GenerationJob {
  return {
    id: record._id.toHexString(),
    ownerId: record.owner_id.toHexString(),
    kitId: record.kit_id.toHexString(),
    fingerprint: record.fingerprint,
    pipelineVersion: record.pipeline_version,
    input: record.input,
    status: record.status,
    stage: record.stage,
    progress: record.progress,
    warnings: record.warnings,
    attempt: record.attempt,
    maxAttempts: record.max_attempts,
    ...(record.next_attempt_at ? { nextAttemptAt: record.next_attempt_at } : {}),
    ...(record.lease_token ? { leaseToken: record.lease_token } : {}),
    ...(record.lease_owner ? { leaseOwner: record.lease_owner } : {}),
    ...(record.lease_expires_at ? { leaseExpiresAt: record.lease_expires_at } : {}),
    ...(record.error ? { error: record.error } : {}),
    ...(record.result ? { result: record.result } : {}),
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    ...(record.started_at ? { startedAt: record.started_at } : {}),
    ...(record.completed_at ? { completedAt: record.completed_at } : {}),
  };
}

function toOwnedKit(record: KitRecord): OwnedKit {
  return {
    id: record._id.toHexString(),
    ownerId: record.owner_id.toHexString(),
    sourceJobId: record.source_job_id.toHexString(),
    originalInput: record.original_input,
    content: record.content,
    revision: record.revision,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

function warningsFromKit(kit: Kit): GenerationJob["warnings"] {
  if (!Array.isArray(kit.warnings)) return [];
  const warnings: GenerationJob["warnings"] = [];
  for (const value of kit.warnings) {
    if (!value || typeof value !== "object") continue;
    const code = "code" in value ? value.code : undefined;
    const message = "message" in value ? value.message : undefined;
    const url = "url" in value ? value.url : undefined;
    if (typeof code !== "string" || typeof message !== "string") continue;
    warnings.push({ code, message, ...(typeof url === "string" ? { url } : {}) });
  }
  return warnings;
}

export class MongoPersistence implements Persistence {
  private readonly client: MongoClient;
  private readonly database: Db;
  private readonly collection: Collection<RuntimeRecord>;
  private readonly users: Collection<UserRecord>;
  private readonly sessions: Collection<SessionRecord>;
  private readonly rateLimits: Collection<RateLimitRecord>;
  private readonly jobs: Collection<JobRecord>;
  private readonly kits: Collection<KitRecord>;
  private readonly instanceId = randomUUID();

  constructor(uri: string, databaseName: string, connectTimeoutMs: number, private readonly release: string) {
    this.client = new MongoClient(uri, {
      appName: "jobber-api",
      maxPoolSize: 10,
      serverSelectionTimeoutMS: connectTimeoutMs,
    });
    this.database = this.client.db(databaseName);
    this.collection = this.database.collection<RuntimeRecord>("service_runtime");
    this.users = this.database.collection<UserRecord>("users");
    this.sessions = this.database.collection<SessionRecord>("sessions");
    this.rateLimits = this.database.collection<RateLimitRecord>("auth_rate_limits");
    this.jobs = this.database.collection<JobRecord>("generation_jobs");
    this.kits = this.database.collection<KitRecord>("kits");
  }

  async connect(): Promise<void> {
    await this.client.connect();
    await this.database.command({ ping: 1 });
    const now = new Date();
    await this.collection.updateOne(
      { _id: "api" },
      {
        $inc: { boot_count: 1 },
        $set: {
          instance_id: this.instanceId,
          release: this.release,
          started_at: now,
          last_ready_at: now,
        },
        $setOnInsert: { _id: "api" },
      },
      { upsert: true },
    );
    await Promise.all([
      this.users.createIndex({ email: 1 }, { unique: true, name: "unique_email" }),
      this.sessions.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0, name: "expired_sessions" }),
      this.sessions.createIndex({ user_id: 1 }, { name: "sessions_by_user" }),
      this.rateLimits.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0, name: "expired_auth_limits" }),
      this.jobs.createIndex({ active_key: 1 }, { unique: true, sparse: true, name: "unique_active_job" }),
      this.jobs.createIndex(
        { status: 1, next_attempt_at: 1, lease_expires_at: 1, created_at: 1 },
        { name: "claimable_jobs" },
      ),
      this.jobs.createIndex({ owner_id: 1, created_at: -1 }, { name: "jobs_by_owner" }),
      this.kits.createIndex({ owner_id: 1, updated_at: -1 }, { name: "kits_by_owner" }),
    ]);
  }

  async ping(): Promise<void> {
    await this.database.command({ ping: 1 });
    await this.collection.updateOne({ _id: "api" }, { $set: { last_ready_at: new Date() } });
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  async createUser(email: string, passwordHash: string, now: Date): Promise<AuthUser | null> {
    const record: UserRecord = {
      _id: new ObjectId(),
      email,
      password_hash: passwordHash,
      created_at: now,
      updated_at: now,
    };
    try {
      await this.users.insertOne(record);
      return toAuthUser(record);
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11_000) return null;
      throw error;
    }
  }

  async findUserByEmail(email: string): Promise<AuthUser | null> {
    const record = await this.users.findOne({ email });
    return record ? toAuthUser(record) : null;
  }

  async createSession(input: {
    id: string;
    userId: string;
    csrfToken: string;
    createdAt: Date;
    expiresAt: Date;
  }): Promise<void> {
    await this.sessions.insertOne({
      _id: input.id,
      user_id: new ObjectId(input.userId),
      csrf_token: input.csrfToken,
      created_at: input.createdAt,
      last_seen_at: input.createdAt,
      expires_at: input.expiresAt,
    });
  }

  async findSessionWithUser(id: string, now: Date): Promise<SessionWithUser | null> {
    const session = await this.sessions.findOne({ _id: id });
    if (!session) return null;
    const user = await this.users.findOne({ _id: session.user_id });
    if (!user) {
      await this.sessions.deleteOne({ _id: id });
      return null;
    }
    await this.sessions.updateOne({ _id: id }, { $set: { last_seen_at: now } });
    return {
      id: session._id,
      user: toAuthUser(user),
      csrfToken: session.csrf_token,
      expiresAt: session.expires_at,
    };
  }

  async deleteSession(id: string): Promise<void> {
    await this.sessions.deleteOne({ _id: id });
  }

  private async consumeLimit(key: string, limit: number, now: Date, windowMs: number): Promise<LoginLimitDecision> {
    const cutoff = new Date(now.getTime() - windowMs);
    const expiresAt = new Date(now.getTime() + windowMs * 2);
    const record = await this.rateLimits.findOneAndUpdate(
      { _id: key },
      [
        {
          $set: {
            attempts: {
              $concatArrays: [
                {
                  $filter: {
                    input: { $ifNull: ["$attempts", []] },
                    as: "attempt",
                    cond: { $gte: ["$$attempt", cutoff] },
                  },
                },
                [now],
              ],
            },
            expires_at: expiresAt,
          },
        },
      ],
      { upsert: true, returnDocument: "after" },
    );
    const attempts = record?.attempts ?? [now];
    const retryAfterSeconds = attempts.length > limit
      ? Math.max(1, Math.ceil((attempts[0]!.getTime() + windowMs - now.getTime()) / 1_000))
      : 0;
    return { allowed: attempts.length <= limit, retryAfterSeconds };
  }

  async consumeLoginLimit(input: {
    emailKey: string;
    ipKey: string;
    now: Date;
    windowMs: number;
    emailLimit: number;
    ipLimit: number;
  }): Promise<LoginLimitDecision> {
    const [email, ip] = await Promise.all([
      this.consumeLimit(input.emailKey, input.emailLimit, input.now, input.windowMs),
      this.consumeLimit(input.ipKey, input.ipLimit, input.now, input.windowMs),
    ]);
    return {
      allowed: email.allowed && ip.allowed,
      retryAfterSeconds: Math.max(email.retryAfterSeconds, ip.retryAfterSeconds),
    };
  }

  async clearLoginLimits(emailKey: string, ipKey: string): Promise<void> {
    await this.rateLimits.deleteMany({ _id: { $in: [emailKey, ipKey] } });
  }

  async enqueueJob(input: {
    ownerId: string;
    fingerprint: string;
    pipelineVersion: string;
    jobInput: JobInput;
    maxAttempts: number;
    now: Date;
  }): Promise<{ job: GenerationJob; deduplicated: boolean }> {
    const ownerId = new ObjectId(input.ownerId);
    const activeKey = `${input.ownerId}:${input.fingerprint}`;
    const record: JobRecord = {
      _id: new ObjectId(),
      owner_id: ownerId,
      kit_id: new ObjectId(),
      fingerprint: input.fingerprint,
      active_key: activeKey,
      pipeline_version: input.pipelineVersion,
      input: input.jobInput,
      status: "queued",
      stage: "queued",
      progress: [],
      warnings: [],
      attempt: 0,
      max_attempts: input.maxAttempts,
      created_at: input.now,
      updated_at: input.now,
    };
    try {
      await this.jobs.insertOne(record);
      return { job: toGenerationJob(record), deduplicated: false };
    } catch (error) {
      if (!(error instanceof MongoServerError) || error.code !== 11_000) throw error;
      const existing = await this.jobs.findOne({ active_key: activeKey });
      if (!existing) throw error;
      return { job: toGenerationJob(existing), deduplicated: true };
    }
  }

  async findOwnedJob(ownerId: string, jobId: string): Promise<GenerationJob | null> {
    if (!ObjectId.isValid(ownerId) || !ObjectId.isValid(jobId)) return null;
    const record = await this.jobs.findOne({ _id: new ObjectId(jobId), owner_id: new ObjectId(ownerId) });
    return record ? toGenerationJob(record) : null;
  }

  async listOwnedJobs(ownerId: string, limit: number): Promise<GenerationJob[]> {
    if (!ObjectId.isValid(ownerId)) return [];
    const records = await this.jobs.find({ owner_id: new ObjectId(ownerId) })
      .sort({ updated_at: -1 })
      .limit(limit)
      .toArray();
    return records.map(toGenerationJob);
  }

  async listOwnedKits(ownerId: string): Promise<OwnedKit[]> {
    if (!ObjectId.isValid(ownerId)) return [];
    const records = await this.kits.find({ owner_id: new ObjectId(ownerId) })
      .sort({ updated_at: -1 })
      .limit(100)
      .toArray();
    return records.map(toOwnedKit);
  }

  async findOwnedKit(ownerId: string, kitId: string): Promise<OwnedKit | null> {
    if (!ObjectId.isValid(ownerId) || !ObjectId.isValid(kitId)) return null;
    const record = await this.kits.findOne({ _id: new ObjectId(kitId), owner_id: new ObjectId(ownerId) });
    return record ? toOwnedKit(record) : null;
  }

  async updateOwnedKit(input: {
    ownerId: string;
    kitId: string;
    expectedRevision: number;
    content: Kit;
    now: Date;
  }): Promise<{ kind: "updated"; kit: OwnedKit } | { kind: "not_found" } | { kind: "conflict"; revision: number }> {
    if (!ObjectId.isValid(input.ownerId) || !ObjectId.isValid(input.kitId)) return { kind: "not_found" };
    const id = new ObjectId(input.kitId);
    const ownerId = new ObjectId(input.ownerId);
    const record = await this.kits.findOneAndUpdate(
      { _id: id, owner_id: ownerId, revision: input.expectedRevision },
      { $set: { content: input.content, updated_at: input.now }, $inc: { revision: 1 } },
      { returnDocument: "after" },
    );
    if (record) return { kind: "updated", kit: toOwnedKit(record) };
    const current = await this.kits.findOne({ _id: id, owner_id: ownerId }, { projection: { revision: 1 } });
    return current ? { kind: "conflict", revision: current.revision } : { kind: "not_found" };
  }

  async claimNextJob(workerId: string, now: Date, leaseMs: number): Promise<ClaimedJob | null> {
    await this.jobs.updateMany(
      {
        status: "running",
        lease_expires_at: { $lte: now },
        $expr: { $gte: ["$attempt", "$max_attempts"] },
      },
      {
        $set: {
          status: "failed",
          error: {
            code: "JOB_RECOVERY_EXHAUSTED",
            message: "Generation stopped repeatedly and needs an explicit retry.",
            retryable: true,
          },
          updated_at: now,
        },
        $unset: {
          active_key: "",
          lease_token: "",
          lease_owner: "",
          lease_expires_at: "",
          next_attempt_at: "",
        },
      },
    );
    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);
    const record = await this.jobs.findOneAndUpdate(
      {
        $expr: { $lt: ["$attempt", "$max_attempts"] },
        $or: [
          { status: "queued" },
          { status: "retry_wait", next_attempt_at: { $lte: now } },
          { status: "running", lease_expires_at: { $lte: now } },
        ],
      },
      {
        $set: {
          status: "running",
          lease_token: leaseToken,
          lease_owner: workerId,
          lease_expires_at: leaseExpiresAt,
          started_at: now,
          updated_at: now,
        },
        $unset: { next_attempt_at: "", error: "" },
        $inc: { attempt: 1 },
      },
      { sort: { created_at: 1 }, returnDocument: "after" },
    );
    if (!record) return null;
    const job = toGenerationJob(record);
    return { ...job, status: "running", leaseToken, leaseOwner: workerId, leaseExpiresAt };
  }

  async renewJobLease(jobId: string, leaseToken: string, now: Date, leaseMs: number): Promise<boolean> {
    if (!ObjectId.isValid(jobId)) return false;
    const result = await this.jobs.updateOne(
      {
        _id: new ObjectId(jobId),
        status: "running",
        lease_token: leaseToken,
        lease_expires_at: { $gt: now },
      },
      { $set: { lease_expires_at: new Date(now.getTime() + leaseMs), updated_at: now } },
    );
    return result.modifiedCount === 1;
  }

  async checkpointJob(
    jobId: string,
    leaseToken: string,
    progress: JobProgress,
    now: Date,
    leaseMs: number,
  ): Promise<boolean> {
    if (!ObjectId.isValid(jobId)) return false;
    const result = await this.jobs.updateOne(
      {
        _id: new ObjectId(jobId),
        status: "running",
        lease_token: leaseToken,
        lease_expires_at: { $gt: now },
      },
      {
        $set: {
          stage: progress.stage,
          lease_expires_at: new Date(now.getTime() + leaseMs),
          updated_at: now,
        },
        $push: { progress: { $each: [progress], $slice: -100 } },
      },
    );
    return result.modifiedCount === 1;
  }

  async completeJob(jobId: string, leaseToken: string, kit: Kit, now: Date): Promise<boolean> {
    if (!ObjectId.isValid(jobId)) return false;
    const jobObjectId = new ObjectId(jobId);
    const warnings = warningsFromKit(kit);
    const record = await this.jobs.findOneAndUpdate(
      {
        _id: jobObjectId,
        status: "running",
        lease_token: leaseToken,
        lease_expires_at: { $gt: now },
      },
      {
        $set: {
          status: warnings.length > 0 ? "completed_with_warnings" : "completed",
          warnings,
          result: kit,
          completed_at: now,
          updated_at: now,
        },
        $unset: {
          active_key: "",
          lease_token: "",
          lease_owner: "",
          lease_expires_at: "",
          next_attempt_at: "",
          error: "",
        },
      },
      { returnDocument: "after" },
    );
    if (!record) return false;
    await this.materializeKit(record);
    return true;
  }

  async recordJobFailure(input: {
    jobId: string;
    leaseToken: string;
    failure: JobFailure;
    retryAt?: Date;
    now: Date;
  }): Promise<boolean> {
    if (!ObjectId.isValid(input.jobId)) return false;
    const retrying = Boolean(input.retryAt);
    const result = await this.jobs.updateOne(
      {
        _id: new ObjectId(input.jobId),
        status: "running",
        lease_token: input.leaseToken,
        lease_expires_at: { $gt: input.now },
      },
      {
        $set: {
          status: retrying ? "retry_wait" : "failed",
          error: input.failure,
          updated_at: input.now,
          ...(input.retryAt ? { next_attempt_at: input.retryAt } : {}),
        },
        $unset: {
          lease_token: "",
          lease_owner: "",
          lease_expires_at: "",
          ...(!retrying ? { active_key: "", next_attempt_at: "" } : {}),
        },
      },
    );
    return result.modifiedCount === 1;
  }

  async releaseJob(jobId: string, leaseToken: string, now: Date): Promise<boolean> {
    if (!ObjectId.isValid(jobId)) return false;
    const result = await this.jobs.updateOne(
      { _id: new ObjectId(jobId), status: "running", lease_token: leaseToken },
      {
        $set: { status: "queued", stage: "queued", updated_at: now },
        $unset: { lease_token: "", lease_owner: "", lease_expires_at: "", next_attempt_at: "" },
        $inc: { attempt: -1 },
      },
    );
    return result.modifiedCount === 1;
  }

  async retryOwnedJob(ownerId: string, jobId: string, now: Date): Promise<GenerationJob | null> {
    if (!ObjectId.isValid(ownerId) || !ObjectId.isValid(jobId)) return null;
    const record = await this.jobs.findOne({ _id: new ObjectId(jobId), owner_id: new ObjectId(ownerId), status: "failed" });
    if (!record) return null;
    try {
      const updated = await this.jobs.findOneAndUpdate(
        { _id: record._id, owner_id: record.owner_id, status: "failed" },
        {
          $set: {
            status: "queued",
            stage: "queued",
            active_key: `${ownerId}:${record.fingerprint}`,
            attempt: 0,
            progress: [],
            warnings: [],
            updated_at: now,
          },
          $unset: { error: "", next_attempt_at: "", completed_at: "", result: "" },
        },
        { returnDocument: "after" },
      );
      return updated ? toGenerationJob(updated) : null;
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11_000) return null;
      throw error;
    }
  }

  async materializeCompletedKits(): Promise<void> {
    const cursor = this.jobs.find({
      status: { $in: ["completed", "completed_with_warnings"] },
      result: { $exists: true },
    });
    for await (const record of cursor) await this.materializeKit(record);
  }

  private async materializeKit(record: JobRecord): Promise<void> {
    if (!record.result) return;
    await this.kits.updateOne(
      { _id: record.kit_id },
      {
        $setOnInsert: {
          _id: record.kit_id,
          owner_id: record.owner_id,
          source_job_id: record._id,
          original_input: record.input,
          content: record.result,
          revision: 1,
          created_at: record.completed_at ?? record.updated_at,
          updated_at: record.completed_at ?? record.updated_at,
        },
      },
      { upsert: true },
    );
  }
}
