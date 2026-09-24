import { randomUUID } from "node:crypto";
import { MongoClient, MongoServerError, ObjectId, type Collection, type Db } from "mongodb";
import type { AuthStore, AuthUser, LoginLimitDecision, SessionWithUser } from "./auth.js";

export interface Persistence extends AuthStore {
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

function toAuthUser(record: UserRecord): AuthUser {
  return {
    id: record._id.toHexString(),
    email: record.email,
    passwordHash: record.password_hash,
    createdAt: record.created_at,
  };
}

export class MongoPersistence implements Persistence {
  private readonly client: MongoClient;
  private readonly database: Db;
  private readonly collection: Collection<RuntimeRecord>;
  private readonly users: Collection<UserRecord>;
  private readonly sessions: Collection<SessionRecord>;
  private readonly rateLimits: Collection<RateLimitRecord>;
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
}
