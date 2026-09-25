"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Session } from "@/lib/api-types";
import { Brand } from "./brand";
import { InlineSpinner } from "./loading-state";

export function WorkspaceHeader({ session, backHref }: { session?: Session | null; backHref?: string }) {
  const router = useRouter();
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState(false);

  async function logout() {
    if (!session) return;
    setLoggingOut(true);
    setLogoutError(false);
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
      setLoggingOut(false);
      setLogoutError(true);
    }
  }

  return (
    <header className="site-header workspace-header">
      <Brand />
      <nav className="header-actions" aria-label="Workspace navigation">
        {backHref && <Link className="text-link" href={backHref}>Dashboard</Link>}
        {session && <span className="account-email">{session.email}</span>}
        {session && (
          <button className="header-button button-with-spinner" type="button" onClick={() => void logout()} disabled={loggingOut}>
            {loggingOut && <InlineSpinner />}{loggingOut ? "Signing out…" : "Sign out"}
          </button>
        )}
      </nav>
      {logoutError && <div className="action-toast" role="alert">Sign out did not complete. Please try again.</div>}
    </header>
  );
}
