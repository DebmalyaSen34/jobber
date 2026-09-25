"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { InlineSpinner, TransitionOverlay } from "./loading-state";

type AuthMode = "login" | "register";
type ErrorBody = { error?: { message?: string; fields?: Record<string, string> } };

export function AuthForm({ mode, notice }: { mode: AuthMode; notice?: string }) {
  const router = useRouter();
  const [status, setStatus] = useState<"idle" | "authenticating" | "redirecting">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [showPassword, setShowPassword] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    setFieldErrors({});
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "");
    const password = String(form.get("password") ?? "");

    if (mode === "register" && password !== String(form.get("confirmPassword") ?? "")) {
      setFieldErrors({ confirmPassword: "Passwords do not match." });
      window.requestAnimationFrame(() => document.getElementById("confirmPassword")?.focus());
      return;
    }

    setStatus("authenticating");
    try {
      const response = await fetch(`/api/v1/auth/${mode}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const body = (await response.json().catch(() => ({}))) as ErrorBody;
      if (!response.ok) {
        setMessage(body.error?.message ?? "Authentication could not be completed. Please try again.");
        setFieldErrors(body.error?.fields ?? {});
        setStatus("idle");
        const firstField = Object.keys(body.error?.fields ?? {})[0];
        if (firstField) window.requestAnimationFrame(() => document.getElementById(firstField)?.focus());
        return;
      }
      setStatus("redirecting");
      await new Promise((resolve) => window.setTimeout(resolve, 350));
      router.replace("/dashboard");
      router.refresh();
    } catch {
      setMessage("The service is unavailable. Please try again shortly.");
      setStatus("idle");
    }
  }

  const registering = mode === "register";

  if (status === "redirecting") {
    return (
      <div className="auth-transition-panel" aria-busy="true">
        <TransitionOverlay
          confirmed
          title={registering ? "Account created." : "Signed in."}
          detail="Opening your private workspace now…"
        />
      </div>
    );
  }

  return (
    <form className="auth-form" onSubmit={submit} noValidate aria-busy={status !== "idle"}>
      {notice && <div className="notice" role="status">{notice}</div>}
      {message && <div className="form-error" role="alert">{message}</div>}

      <div className="field">
        <label htmlFor="email">Email address</label>
        <input
          id="email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          required
          maxLength={254}
          aria-invalid={Boolean(fieldErrors.email)}
          aria-describedby={fieldErrors.email ? "email-error" : undefined}
        />
        {fieldErrors.email && <p className="field-error" id="email-error">{fieldErrors.email}</p>}
      </div>

      <div className="field">
        <label htmlFor="password">Password</label>
        <div className="password-control">
          <input
            id="password"
            name="password"
            type={showPassword ? "text" : "password"}
            autoComplete={registering ? "new-password" : "current-password"}
            required
            minLength={12}
            maxLength={128}
            aria-invalid={Boolean(fieldErrors.password)}
            aria-describedby={[
              registering ? "password-hint" : null,
              fieldErrors.password ? "password-error" : null,
            ].filter(Boolean).join(" ") || undefined}
          />
          <button type="button" onClick={() => setShowPassword((visible) => !visible)} aria-label={showPassword ? "Hide password" : "Show password"}>{showPassword ? "Hide" : "Show"}</button>
        </div>
        {registering && <p className="field-hint" id="password-hint">Use at least 12 characters.</p>}
        {fieldErrors.password && <p className="field-error" id="password-error">{fieldErrors.password}</p>}
      </div>

      {registering && (
        <div className="field">
          <label htmlFor="confirmPassword">Confirm password</label>
          <div className="password-control">
            <input
              id="confirmPassword"
              name="confirmPassword"
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
              required
              minLength={12}
              maxLength={128}
              aria-invalid={Boolean(fieldErrors.confirmPassword)}
              aria-describedby={fieldErrors.confirmPassword ? "confirm-password-error" : undefined}
            />
            <button type="button" onClick={() => setShowPassword((visible) => !visible)} aria-label={showPassword ? "Hide passwords" : "Show passwords"}>{showPassword ? "Hide" : "Show"}</button>
          </div>
          {fieldErrors.confirmPassword && <p className="field-error" id="confirm-password-error">{fieldErrors.confirmPassword}</p>}
        </div>
      )}

      <button className="primary-button button-with-spinner" type="submit" disabled={status !== "idle"}>
        {status === "authenticating" && <InlineSpinner />}
        {status === "authenticating" ? (registering ? "Creating account…" : "Signing you in…") : registering ? "Create account" : "Sign in"}
      </button>

      <p className="auth-switch">
        {registering ? "Already have an account?" : "New to Jobber?"}{" "}
        <Link href={registering ? "/login" : "/register"}>
          {registering ? "Sign in" : "Create an account"}
        </Link>
      </p>
    </form>
  );
}
