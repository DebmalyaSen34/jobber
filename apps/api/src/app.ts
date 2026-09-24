import { randomUUID } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { AuthError, AuthService, assertOwner, publicUser, type SessionWithUser } from "./auth.js";
import type { AppConfig } from "./config.js";
import type { Persistence } from "./database.js";

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

export function createApp(config: AppConfig, persistence: Persistence) {
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
  app.use(["/api/v1/auth", "/api/v1/account"], (_request, response, next) => {
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
    if (error instanceof SyntaxError && "status" in error && error.status === 400) {
      response.status(400).json({ error: { code: "INVALID_JSON", message: "Request body must be valid JSON." } });
      return;
    }
    response.status(500).json({ error: { code: "INTERNAL_ERROR", message: "The request could not be completed." } });
  });

  return app;
}
