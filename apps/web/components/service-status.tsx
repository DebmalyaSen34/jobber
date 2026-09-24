"use client";

import { useCallback, useEffect, useState } from "react";

type ViewState =
  | { kind: "loading" }
  | { kind: "ready"; release: string }
  | { kind: "unconfigured" }
  | { kind: "error"; message: string };

const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, "");

export function ServiceStatus() {
  const [state, setState] = useState<ViewState>({ kind: "loading" });

  const checkService = useCallback(async () => {
    if (!apiBaseUrl) {
      setState({ kind: "unconfigured" });
      return;
    }

    setState({ kind: "loading" });
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10_000);

    try {
      const response = await fetch(`${apiBaseUrl}/api/v1/status`, {
        credentials: "include",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      const body = (await response.json()) as { status?: string; release?: string };
      if (!response.ok || body.status !== "ready") throw new Error("Service unavailable");
      setState({ kind: "ready", release: body.release ?? "unknown" });
    } catch (error) {
      setState({
        kind: "error",
        message: error instanceof DOMException && error.name === "AbortError"
          ? "The service took too long to respond. It may be waking from an idle period."
          : "The API or database is unavailable. You can retry without losing anything.",
      });
    } finally {
      window.clearTimeout(timeout);
    }
  }, []);

  useEffect(() => {
    const start = window.setTimeout(() => void checkService(), 0);
    return () => window.clearTimeout(start);
  }, [checkService]);

  const ready = state.kind === "ready";

  return (
    <section className="status-card" aria-labelledby="service-heading">
      <div className="status-card__topline">
        <p className="eyebrow">Deployment signal</p>
        <span className={`status-pill status-pill--${state.kind}`}>
          <span className="status-pill__dot" aria-hidden="true" />
          {state.kind === "ready" ? "Ready" : state.kind === "loading" ? "Checking" : "Needs attention"}
        </span>
      </div>

      <div className="status-card__body" aria-live="polite" aria-busy={state.kind === "loading"}>
        <h2 id="service-heading">
          {ready ? "The foundation is connected." : state.kind === "loading" ? "Checking the foundation…" : "Connection check incomplete."}
        </h2>
        {state.kind === "ready" && (
          <p>API release <code>{state.release}</code> reached durable MongoDB storage.</p>
        )}
        {state.kind === "unconfigured" && (
          <p>Set <code>NEXT_PUBLIC_API_BASE_URL</code> for this deployment, then rebuild the web app.</p>
        )}
        {state.kind === "error" && <p>{state.message}</p>}
      </div>

      <div className="status-card__footer">
        <div className="status-list" aria-label="Foundation capabilities">
          <span><i className={ready ? "signal signal--good" : "signal"} />API</span>
          <span><i className={ready ? "signal signal--good" : "signal"} />MongoDB</span>
          <span><i className={apiBaseUrl ? "signal signal--good" : "signal"} />Exact-origin CORS</span>
        </div>
        {state.kind !== "ready" && state.kind !== "unconfigured" && (
          <button className="retry-button" type="button" onClick={() => void checkService()} disabled={state.kind === "loading"}>
            {state.kind === "loading" ? "Checking…" : "Retry check"}
          </button>
        )}
      </div>
    </section>
  );
}
