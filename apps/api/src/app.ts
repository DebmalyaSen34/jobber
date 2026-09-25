import { randomUUID } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { AuthError, AuthService, assertOwner, publicUser, type SessionWithUser } from "./auth.js";
import type { AppConfig } from "./config.js";
import type { Persistence } from "./database.js";
import { JobError, JobService, publicJob } from "./jobs.js";
import { KitEditError, KitService, publicKit, publicKitSummary } from "./kits.js";
import { RegenerationError, RegenerationService, publicRegeneration } from "./regenerations.js";
import { PracticeError, PracticeService } from "./practice.js";

const DEVELOPMENT_SESSION_COOKIE = "jobber_session";
const PRODUCTION_SESSION_COOKIE = "__Host-jobber_session";

export function isOriginAllowed(origin: string | undefined, allowedOrigins: readonly string[]): boolean {
  return origin === undefined || allowedOrigins.includes(origin);
}

export function createStatusPayload(release: string) {
  return {
    status: "ready" as const,
    service: "jobber-api",
    release,
    persistence: { provider: "mongodb" as const, status: "connected" as const },
  };
}

function securityHeaders(_request: Request, response: Response, next: NextFunction): void {
  response.set({
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "Cross-Origin-Resource-Policy": "same-site",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
  next();
}

function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function authPayload(session: SessionWithUser) {
  return {
    authenticated: true as const,
    user: publicUser(session.user),
    csrfToken: session.csrfToken,
    expiresAt: session.expiresAt.toISOString(),
  };
}

export function createApp(
  config: AppConfig,
  persistence: Persistence,
  dependencies: { notifyJobAvailable?: () => void; notifyRegenerationAvailable?: () => void } = {},
) {
  const app = express();
  const auth = new AuthService(persistence, {
    secret: config.sessionSecret,
    sessionTtlMs: config.sessionTtlMs,
    bcryptRounds: config.bcryptRounds,
    loginWindowMs: config.loginWindowMs,
    loginEmailLimit: config.loginEmailLimit,
    loginIpLimit: config.loginIpLimit,
  });
  const sessionCookie = config.nodeEnv === "production" ? PRODUCTION_SESSION_COOKIE : DEVELOPMENT_SESSION_COOKIE;
  const cookieOptions = {
    httpOnly: true,
    secure: config.nodeEnv === "production",
    sameSite: "lax" as const,
    path: "/",
  };
  const issuedCookieOptions = { ...cookieOptions, maxAge: config.sessionTtlMs };
  const jobs = new JobService(persistence, {
    pipelineVersion: config.pipelineVersion,
    maxAttempts: config.jobMaxAttempts,
  });
  const kits = new KitService(persistence);
  const regenerations = new RegenerationService(persistence);
  const practice = new PracticeService(persistence);

  const requireMutationOrigin = (request: Request): void => {
    const origin = request.header("origin");
    if (!origin || !isOriginAllowed(origin, config.webOrigins)) {
      throw new AuthError("ORIGIN_REQUIRED", 403, "A trusted browser origin is required.");
    }
  };

  const resolveAuthenticatedSession = async (request: Request, response: Response): Promise<SessionWithUser> => {
    const token = parseCookie(request.header("cookie"), sessionCookie);
    const resolution = await auth.resolveSession(token);
    if (resolution.kind === "authenticated") return resolution.session;
    if (resolution.kind === "expired") {
      response.clearCookie(sessionCookie, cookieOptions);
      throw new AuthError("SESSION_EXPIRED", 401, "Your session expired. Please sign in again.");
    }
    throw new AuthError("UNAUTHENTICATED", 401, "Please sign in to continue.");
  };

  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(securityHeaders);
  app.use((request, response, next) => {
    const requestId = request.header("x-request-id")?.slice(0, 128) || randomUUID();
    response.setHeader("x-request-id", requestId);
    next();
  });
  app.use((request, response, next) => {
    const origin = request.header("origin");
    if (!isOriginAllowed(origin, config.webOrigins)) {
      response.status(403).json({ error: { code: "ORIGIN_NOT_ALLOWED", message: "Origin is not allowed." } });
      return;
    }
    if (origin) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Access-Control-Allow-Credentials", "true");
      response.setHeader("Vary", "Origin");
    }
    if (request.method === "OPTIONS") {
      response.setHeader("Access-Control-Allow-Headers", "Content-Type, X-CSRF-Token, X-Request-ID");
      response.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
      response.status(204).end();
      return;
    }
    next();
  });
  app.use(express.json({ limit: "1mb" }));
  app.use(["/api/v1/auth", "/api/v1/account", "/api/v1/jobs", "/api/v1/kits", "/api/v1/regenerations"], (_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    next();
  });

  app.get("/health/live", (_request, response) => {
    response.json({ status: "ok", service: "jobber-api", release: config.release });
  });

  app.get("/health/ready", async (_request, response) => {
    try {
      await persistence.ping();
      response.json({ status: "ready" });
    } catch {
      response.status(503).json({ status: "unavailable", error: { code: "PERSISTENCE_UNAVAILABLE" } });
    }
  });

  app.get("/api/v1/status", async (_request, response) => {
    try {
      await persistence.ping();
      response.json(createStatusPayload(config.release));
    } catch {
      response.status(503).json({
        status: "unavailable",
        service: "jobber-api",
        release: config.release,
        persistence: { provider: "mongodb", status: "unavailable" },
      });
    }
  });

  app.post("/api/v1/auth/register", async (request, response) => {
    requireMutationOrigin(request);
    const issued = await auth.register(request.body);
    response.cookie(sessionCookie, issued.token, issuedCookieOptions);
    response.status(201).json(authPayload(issued.session));
  });

  app.post("/api/v1/auth/login", async (request, response) => {
    requireMutationOrigin(request);
    const issued = await auth.login(request.body, request.ip ?? request.socket.remoteAddress ?? "unknown");
    response.cookie(sessionCookie, issued.token, issuedCookieOptions);
    response.json(authPayload(issued.session));
  });

  app.get("/api/v1/auth/session", async (request, response) => {
    const token = parseCookie(request.header("cookie"), sessionCookie);
    const resolution = await auth.resolveSession(token);
    if (resolution.kind === "authenticated") {
      response.json(authPayload(resolution.session));
      return;
    }
    if (resolution.kind === "expired") {
      response.clearCookie(sessionCookie, cookieOptions);
      response.status(401).json({
        authenticated: false,
        error: { code: "SESSION_EXPIRED", message: "Your session expired. Please sign in again." },
      });
      return;
    }
    response.json({ authenticated: false });
  });

  app.post("/api/v1/auth/logout", async (request, response) => {
    requireMutationOrigin(request);
    const token = parseCookie(request.header("cookie"), sessionCookie);
    const session = await resolveAuthenticatedSession(request, response);
    auth.verifyCsrf(session, request.header("x-csrf-token"));
    await auth.logout(token!);
    response.clearCookie(sessionCookie, cookieOptions);
    response.status(204).end();
  });

  app.get("/api/v1/account", async (request, response) => {
    const session = await resolveAuthenticatedSession(request, response);
    assertOwner(session.user.id, session.user.id);
    response.json({ user: publicUser(session.user) });
  });

  app.post("/api/v1/kits", async (request, response) => {
    requireMutationOrigin(request);
    const session = await resolveAuthenticatedSession(request, response);
    auth.verifyCsrf(session, request.header("x-csrf-token"));
    const queued = await jobs.enqueue(session.user.id, request.body);
    dependencies.notifyJobAvailable?.();
    response.setHeader("Location", `/api/v1/jobs/${queued.job.id}`);
    response.status(202).json({ job: publicJob(queued.job), deduplicated: queued.deduplicated });
  });

  app.post("/api/v1/kits/batch", async (request, response) => {
    requireMutationOrigin(request);
    const session = await resolveAuthenticatedSession(request, response);
    auth.verifyCsrf(session, request.header("x-csrf-token"));
    const batch = await jobs.enqueueBatch(session.user.id, request.body);
    if (batch.queuedCount > 0) dependencies.notifyJobAvailable?.();
    response.status(202).json(batch);
  });

  app.get("/api/v1/kits", async (request, response) => {
    const session = await resolveAuthenticatedSession(request, response);
    const kits = await persistence.listOwnedKits(session.user.id);
    response.json({ kits: kits.map(publicKitSummary) });
  });

  app.get("/api/v1/kits/:kitId", async (request, response) => {
    const session = await resolveAuthenticatedSession(request, response);
    const kit = await persistence.findOwnedKit(session.user.id, request.params.kitId);
    if (!kit) throw new JobError("NOT_FOUND", 404, "Kit not found.");
    response.json({ kit: publicKit(kit) });
  });

  app.patch("/api/v1/kits/:kitId", async (request, response) => {
    requireMutationOrigin(request);
    const session = await resolveAuthenticatedSession(request, response);
    auth.verifyCsrf(session, request.header("x-csrf-token"));
    const kit = await kits.update(session.user.id, request.params.kitId, request.body);
    response.json({ kit: publicKit(kit) });
  });

  app.post("/api/v1/kits/:kitId/regenerate", async (request, response) => {
    requireMutationOrigin(request);
    const session = await resolveAuthenticatedSession(request, response);
    auth.verifyCsrf(session, request.header("x-csrf-token"));
    const job = await regenerations.enqueue(session.user.id, request.params.kitId, request.body);
    dependencies.notifyRegenerationAvailable?.();
    response.setHeader("Location", `/api/v1/regenerations/${job.id}`);
    response.status(202).json({ regeneration: publicRegeneration(job) });
  });

  app.get("/api/v1/kits/:kitId/practice", async (request, response) => {
    const session = await resolveAuthenticatedSession(request, response);
    response.json({ practice: await practice.get(session.user.id, request.params.kitId) });
  });

  app.post("/api/v1/kits/:kitId/practice/reviews", async (request, response) => {
    requireMutationOrigin(request);
    const session = await resolveAuthenticatedSession(request, response);
    auth.verifyCsrf(session, request.header("x-csrf-token"));
    const result = await practice.review(session.user.id, request.params.kitId, request.body);
    response.status(201).json({ practice: result });
  });

  app.get("/api/v1/regenerations/:jobId", async (request, response) => {
    const session = await resolveAuthenticatedSession(request, response);
    const job = await regenerations.getOwned(session.user.id, request.params.jobId);
    response.json({ regeneration: publicRegeneration(job) });
  });

  app.get("/api/v1/jobs", async (request, response) => {
    const session = await resolveAuthenticatedSession(request, response);
    const ownedJobs = await jobs.listOwned(session.user.id);
    response.json({ jobs: ownedJobs.map(publicJob) });
  });

  app.get("/api/v1/jobs/:jobId", async (request, response) => {
    const session = await resolveAuthenticatedSession(request, response);
    const job = await jobs.getOwned(session.user.id, request.params.jobId);
    response.json({ job: publicJob(job) });
  });

  app.post("/api/v1/jobs/:jobId/retry", async (request, response) => {
    requireMutationOrigin(request);
    const session = await resolveAuthenticatedSession(request, response);
    auth.verifyCsrf(session, request.header("x-csrf-token"));
    const job = await jobs.retry(session.user.id, request.params.jobId);
    dependencies.notifyJobAvailable?.();
    response.status(202).json({ job: publicJob(job) });
  });

  app.use((_request, response) => {
    response.status(404).json({ error: { code: "NOT_FOUND", message: "Route not found." } });
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    void _next;
    if (response.headersSent) return;
    if (error instanceof AuthError) {
      if (error.options.retryAfterSeconds) {
        response.setHeader("Retry-After", String(error.options.retryAfterSeconds));
      }
      response.status(error.status).json({
        error: {
          code: error.code,
          message: error.message,
          ...(error.options.fieldErrors ? { fields: error.options.fieldErrors } : {}),
        },
      });
      return;
    }
    if (error instanceof JobError) {
      response.status(error.status).json({
        error: {
          code: error.code,
          message: error.message,
          ...(error.options.retryable !== undefined ? { retryable: error.options.retryable } : {}),
          ...(error.options.fields ? { fields: error.options.fields } : {}),
          ...(error.options.existingJobId ? { details: { existingJobId: error.options.existingJobId } } : {}),
        },
      });
      return;
    }
    if (error instanceof KitEditError) {
      response.status(error.status).json({
        error: {
          code: error.code,
          message: error.message,
          ...(error.options.fields ? { fields: error.options.fields } : {}),
          ...(error.options.revision !== undefined ? { details: { revision: error.options.revision } } : {}),
        },
      });
      return;
    }
    if (error instanceof RegenerationError) {
      response.status(error.status).json({ error: { code: error.code, message: error.message } });
      return;
    }
    if (error instanceof PracticeError) {
      response.status(error.status).json({ error: { code: error.code, message: error.message } });
      return;
    }
    if (error instanceof SyntaxError && "status" in error && error.status === 400) {
      response.status(400).json({ error: { code: "INVALID_JSON", message: "Request body must be valid JSON." } });
      return;
    }
    response.status(500).json({ error: { code: "INTERNAL_ERROR", message: "The request could not be completed." } });
  });

  return app;
}
