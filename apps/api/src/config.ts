import { z } from "zod";

const positiveInteger = z.coerce.number().int().positive();

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: positiveInteger.max(65_535).default(4_000),
    MONGODB_URI: z.string().trim().optional(),
    MONGODB_DB: z.string().trim().min(1).default("jobber"),
    WEB_ORIGINS: z.string().trim().default("http://localhost:3000"),
    SESSION_SECRET: z.string().min(32).optional(),
    GEMINI_API_KEY: z.string().trim().min(1).optional(),
    APP_RELEASE: z.string().trim().min(1).optional(),
    RENDER_GIT_COMMIT: z.string().trim().min(1).optional(),
    MONGODB_CONNECT_TIMEOUT_MS: positiveInteger.max(60_000).default(5_000),
    SHUTDOWN_GRACE_MS: positiveInteger.max(60_000).default(10_000),
    SESSION_TTL_HOURS: positiveInteger.max(24 * 30).default(24 * 7),
    BCRYPT_ROUNDS: positiveInteger.min(4).max(14).default(12),
    LOGIN_WINDOW_MINUTES: positiveInteger.max(60).default(15),
    LOGIN_EMAIL_LIMIT: positiveInteger.max(100).default(5),
    LOGIN_IP_LIMIT: positiveInteger.max(500).default(20),
    JOB_LEASE_SECONDS: positiveInteger.max(600).default(60),
    JOB_POLL_MS: positiveInteger.max(60_000).default(1_000),
    JOB_MAX_ATTEMPTS: positiveInteger.max(10).default(3),
    JOB_RETRY_BASE_MS: positiveInteger.max(300_000).default(5_000),
    PIPELINE_VERSION: z.string().trim().min(1).max(64).default("1"),
  })
  .superRefine((value, context) => {
    if (!value.SESSION_SECRET) {
      context.addIssue({ code: "custom", path: ["SESSION_SECRET"], message: "is required" });
    }

    if (
      value.MONGODB_URI &&
      !value.MONGODB_URI.startsWith("mongodb://") &&
      !value.MONGODB_URI.startsWith("mongodb+srv://")
    ) {
      context.addIssue({
        code: "custom",
        path: ["MONGODB_URI"],
        message: "must use the mongodb:// or mongodb+srv:// scheme",
      });
    }

    if (value.NODE_ENV !== "production") return;

    for (const key of ["MONGODB_URI", "GEMINI_API_KEY"] as const) {
      if (!value[key]) {
        context.addIssue({ code: "custom", path: [key], message: "is required in production" });
      }
    }
  });

export type AppConfig = {
  nodeEnv: "development" | "test" | "production";
  port: number;
  mongoUri: string;
  mongoDatabase: string;
  webOrigins: readonly string[];
  sessionSecret: string;
  geminiApiKey?: string;
  release: string;
  mongoConnectTimeoutMs: number;
  shutdownGraceMs: number;
  sessionTtlMs: number;
  bcryptRounds: number;
  loginWindowMs: number;
  loginEmailLimit: number;
  loginIpLimit: number;
  jobLeaseMs: number;
  jobPollMs: number;
  jobMaxAttempts: number;
  jobRetryBaseMs: number;
  pipelineVersion: string;
};

function parseOrigins(raw: string): string[] {
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (values.length === 0) throw new Error("Invalid environment configuration: WEB_ORIGINS is required");

  return [...new Set(values.map((value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error("Invalid environment configuration: WEB_ORIGINS must contain HTTP(S) origins");
    }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== value) {
      throw new Error("Invalid environment configuration: WEB_ORIGINS must contain exact HTTP(S) origins");
    }
    return url.origin;
  }))];
}

export function loadConfig(input: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = environmentSchema.safeParse(input);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path[0]).filter(Boolean))];
    throw new Error(`Invalid environment configuration: ${fields.join(", ")}`);
  }

  if (!parsed.data.MONGODB_URI) {
    throw new Error("Invalid environment configuration: MONGODB_URI");
  }

  return {
    nodeEnv: parsed.data.NODE_ENV,
    port: parsed.data.PORT,
    mongoUri: parsed.data.MONGODB_URI,
    mongoDatabase: parsed.data.MONGODB_DB,
    webOrigins: parseOrigins(parsed.data.WEB_ORIGINS),
    sessionSecret: parsed.data.SESSION_SECRET!,
    ...(parsed.data.GEMINI_API_KEY ? { geminiApiKey: parsed.data.GEMINI_API_KEY } : {}),
    release: parsed.data.APP_RELEASE ?? parsed.data.RENDER_GIT_COMMIT ?? "development",
    mongoConnectTimeoutMs: parsed.data.MONGODB_CONNECT_TIMEOUT_MS,
    shutdownGraceMs: parsed.data.SHUTDOWN_GRACE_MS,
    sessionTtlMs: parsed.data.SESSION_TTL_HOURS * 60 * 60 * 1_000,
    bcryptRounds: parsed.data.BCRYPT_ROUNDS,
    loginWindowMs: parsed.data.LOGIN_WINDOW_MINUTES * 60 * 1_000,
    loginEmailLimit: parsed.data.LOGIN_EMAIL_LIMIT,
    loginIpLimit: parsed.data.LOGIN_IP_LIMIT,
    jobLeaseMs: parsed.data.JOB_LEASE_SECONDS * 1_000,
    jobPollMs: parsed.data.JOB_POLL_MS,
    jobMaxAttempts: parsed.data.JOB_MAX_ATTEMPTS,
    jobRetryBaseMs: parsed.data.JOB_RETRY_BASE_MS,
    pipelineVersion: parsed.data.PIPELINE_VERSION,
  };
}
