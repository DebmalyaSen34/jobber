import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";
import { z } from "zod";

const emailSchema = z.string().trim().toLowerCase().email().max(254);
const passwordSchema = z.string().min(12).max(128).superRefine((password, context) => {
  if (Buffer.byteLength(password, "utf8") > 72) {
    context.addIssue({ code: "custom", message: "Password must be at most 72 UTF-8 bytes." });
  }
});

const credentialsSchema = z.object({ email: emailSchema, password: passwordSchema }).strict();

export type AuthUser = {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: Date;
};

export type SessionWithUser = {
  id: string;
  user: AuthUser;
  csrfToken: string;
  expiresAt: Date;
};

export type LoginLimitDecision = {
  allowed: boolean;
  retryAfterSeconds: number;
};

export interface AuthStore {
  createUser(email: string, passwordHash: string, now: Date): Promise<AuthUser | null>;
  findUserByEmail(email: string): Promise<AuthUser | null>;
  createSession(input: {
    id: string;
    userId: string;
    csrfToken: string;
    createdAt: Date;
    expiresAt: Date;
  }): Promise<void>;
  findSessionWithUser(id: string, now: Date): Promise<SessionWithUser | null>;
  deleteSession(id: string): Promise<void>;
  consumeLoginLimit(input: {
    emailKey: string;
    ipKey: string;
    now: Date;
    windowMs: number;
    emailLimit: number;
    ipLimit: number;
  }): Promise<LoginLimitDecision>;
  clearLoginLimits(emailKey: string, ipKey: string): Promise<void>;
}

export class AuthError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly options: { fieldErrors?: Record<string, string>; retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export type AuthServiceConfig = {
  secret: string;
  sessionTtlMs: number;
  bcryptRounds: number;
  loginWindowMs: number;
  loginEmailLimit: number;
  loginIpLimit: number;
};

export type IssuedSession = {
  token: string;
  session: SessionWithUser;
};

export type SessionResolution =
  | { kind: "authenticated"; session: SessionWithUser }
  | { kind: "missing" }
  | { kind: "expired" };

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function validationError(error: z.ZodError): AuthError {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const field = String(issue.path[0] ?? "form");
    if (!(field in fieldErrors)) fieldErrors[field] = issue.message;
  }
  return new AuthError("INVALID_INPUT", 400, "Please correct the highlighted fields.", { fieldErrors });
}

export function assertOwner(ownerId: string, authenticatedUserId: string): void {
  if (!safeEqual(ownerId, authenticatedUserId)) {
    throw new AuthError("NOT_FOUND", 404, "Resource not found.");
  }
}

export class AuthService {
  private readonly dummyPasswordHash: string;

  constructor(private readonly store: AuthStore, private readonly config: AuthServiceConfig) {
    this.dummyPasswordHash = bcrypt.hashSync("jobber-dummy-password", config.bcryptRounds);
  }

  private keyedHash(scope: string, value: string): string {
    return createHmac("sha256", this.config.secret).update(`${scope}:${value}`).digest("base64url");
  }

  private async issueSession(user: AuthUser, now: Date): Promise<IssuedSession> {
    const token = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(32).toString("base64url");
    const expiresAt = new Date(now.getTime() + this.config.sessionTtlMs);
    const session: SessionWithUser = {
      id: sha256(token),
      user,
      csrfToken,
      expiresAt,
    };
    await this.store.createSession({
      id: session.id,
      userId: user.id,
      csrfToken,
      createdAt: now,
      expiresAt,
    });
    return { token, session };
  }

  async register(input: unknown, now = new Date()): Promise<IssuedSession> {
    const parsed = credentialsSchema.safeParse(input);
    if (!parsed.success) throw validationError(parsed.error);

    const passwordHash = await bcrypt.hash(parsed.data.password, this.config.bcryptRounds);
    const user = await this.store.createUser(parsed.data.email, passwordHash, now);
    if (!user) {
      throw new AuthError("EMAIL_IN_USE", 409, "An account with that email already exists.", {
        fieldErrors: { email: "An account with that email already exists." },
      });
    }
    return this.issueSession(user, now);
  }

  async login(input: unknown, clientIp: string, now = new Date()): Promise<IssuedSession> {
    const parsed = credentialsSchema.safeParse(input);
    if (!parsed.success) throw validationError(parsed.error);

    const emailKey = this.keyedHash("email", parsed.data.email);
    const ipKey = this.keyedHash("ip", clientIp);
    const decision = await this.store.consumeLoginLimit({
      emailKey,
      ipKey,
      now,
      windowMs: this.config.loginWindowMs,
      emailLimit: this.config.loginEmailLimit,
      ipLimit: this.config.loginIpLimit,
    });
    if (!decision.allowed) {
      throw new AuthError("LOGIN_THROTTLED", 429, "Too many login attempts. Try again later.", {
        retryAfterSeconds: decision.retryAfterSeconds,
      });
    }

    const user = await this.store.findUserByEmail(parsed.data.email);
    const valid = await bcrypt.compare(parsed.data.password, user?.passwordHash ?? this.dummyPasswordHash);
    if (!user || !valid) {
      throw new AuthError("INVALID_CREDENTIALS", 401, "Email or password is incorrect.");
    }

    await this.store.clearLoginLimits(emailKey, ipKey);
    return this.issueSession(user, now);
  }

  async resolveSession(token: string | undefined, now = new Date()): Promise<SessionResolution> {
    if (!token) return { kind: "missing" };
    const id = sha256(token);
    const session = await this.store.findSessionWithUser(id, now);
    if (!session) return { kind: "missing" };
    if (session.expiresAt.getTime() <= now.getTime()) {
      await this.store.deleteSession(id);
      return { kind: "expired" };
    }
    return { kind: "authenticated", session };
  }

  verifyCsrf(session: SessionWithUser, providedToken: string | undefined): void {
    if (!providedToken || !safeEqual(session.csrfToken, providedToken)) {
      throw new AuthError("INVALID_CSRF", 403, "The security token is missing or invalid.");
    }
  }

  async logout(token: string): Promise<void> {
    await this.store.deleteSession(sha256(token));
  }
}

export function publicUser(user: AuthUser): { id: string; email: string } {
  return { id: user.id, email: user.email };
}
