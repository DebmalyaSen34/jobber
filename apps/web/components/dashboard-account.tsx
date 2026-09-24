"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

type SessionState =
  | { kind: "loading" }
  | { kind: "ready"; email: string; csrfToken: string; expiresAt: string }
  | { kind: "error"; message: string };

export function DashboardAccount() {
  const router = useRouter();
  const [session, setSession] = useState<SessionState>({ kind: "loading" });
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    async function loadSession() {
      try {
        const response = await fetch("/api/v1/auth/session", {
          credentials: "include",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        const body = await response.json() as {
          authenticated?: boolean;
          user?: { email?: string };
          csrfToken?: string;
          expiresAt?: string;
        };
        if (!response.ok || !body.authenticated || !body.user?.email || !body.csrfToken || !body.expiresAt) {
          router.replace("/login?reason=session-expired");
          return;
        }
        setSession({ kind: "ready", email: body.user.email, csrfToken: body.csrfToken, expiresAt: body.expiresAt });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setSession({ kind: "error", message: "Your account could not be loaded. Please retry." });
      }
    }
    void loadSession();
    return () => controller.abort();
  }, [loadAttempt, router]);

  async function logout() {
    if (session.kind !== "ready") return;
    setLoggingOut(true);
    setLogoutError(null);
    try {
      const response = await fetch("/api/v1/auth/logout", {
        method: "POST",
        credentials: "include",
        headers: { "X-CSRF-Token": session.csrfToken },
      });
      if (!response.ok) throw new Error("Logout failed");
      router.replace("/login?reason=logged-out");
      router.refresh();
    } catch {
      setLogoutError("Sign out failed. Your work is safe; please try again.");
      setLoggingOut(false);
    }
  }

  if (session.kind === "loading") {
    return <div className="dashboard-state" aria-live="polite">Loading your account…</div>;
  }
  if (session.kind === "error") {
    return (
      <div className="dashboard-state dashboard-state--error" role="alert">
        <span>{session.message}</span>
        <button className="secondary-button" type="button" onClick={() => {
          setSession({ kind: "loading" });
          setLoadAttempt((attempt) => attempt + 1);
        }}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <section className="account-card" aria-labelledby="account-heading">
      <div>
        <p className="eyebrow">Signed in</p>
        <h2 id="account-heading">Welcome to your workspace.</h2>
        <p>{session.email}</p>
        {logoutError && <p className="account-error" role="alert">{logoutError}</p>}
      </div>
      <button className="secondary-button" type="button" onClick={() => void logout()} disabled={loggingOut}>
        {loggingOut ? "Signing out…" : "Sign out"}
      </button>
    </section>
  );
}
