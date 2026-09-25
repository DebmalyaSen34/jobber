"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import type { Session } from "./api-types";

export function useSession() {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setError(null);
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
        setSession({ email: body.user.email, csrfToken: body.csrfToken, expiresAt: body.expiresAt });
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setError("Your private workspace could not be loaded. Please retry.");
      }
    }
    void load();
    return () => controller.abort();
  }, [attempt, router]);

  const retry = useCallback(() => {
    setSession(null);
    setAttempt((value) => value + 1);
  }, []);

  return { session, error, retry };
}
