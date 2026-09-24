import { randomUUID } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import type { AppConfig } from "./config.js";
import type { Persistence } from "./database.js";

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

export function createApp(config: AppConfig, persistence: Persistence) {
  const app = express();
  app.disable("x-powered-by");
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

  app.use((_request, response) => {
    response.status(404).json({ error: { code: "NOT_FOUND", message: "Route not found." } });
  });

  app.use((_error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    void _next;
    if (response.headersSent) return;
    response.status(500).json({ error: { code: "INTERNAL_ERROR", message: "The request could not be completed." } });
  });

  return app;
}
