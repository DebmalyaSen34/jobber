"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { formatDate, isActiveJob, stageLabel, type KitSummary, type PublicJob } from "@/lib/api-types";
import { useSession } from "@/lib/use-session";
import { WorkspaceHeader } from "./workspace-header";

export function DashboardWorkspace() {
  const { session, error: sessionError, retry: retrySession } = useSession();
  const [kits, setKits] = useState<KitSummary[]>([]);
  const [jobs, setJobs] = useState<PublicJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!session) return;
    try {
      const [kitsResponse, jobsResponse] = await Promise.all([
        fetch("/api/v1/kits", { credentials: "include", signal }),
        fetch("/api/v1/jobs", { credentials: "include", signal }),
      ]);
      if (!kitsResponse.ok || !jobsResponse.ok) throw new Error("Workspace request failed");
      const kitsBody = await kitsResponse.json() as { kits: KitSummary[] };
      const jobsBody = await jobsResponse.json() as { jobs: PublicJob[] };
      setKits(kitsBody.kits);
      setJobs(jobsBody.jobs);
      setLoadError(null);
      setLoading(false);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setLoadError("Your kits could not be loaded. Your saved work is safe.");
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    if (!session) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(controller.signal), 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [attempt, load, session]);

  const hasActiveJobs = jobs.some(isActiveJob);
  useEffect(() => {
    if (!session || !hasActiveJobs) return;
    const timer = window.setInterval(() => void load(), 2500);
    return () => window.clearInterval(timer);
  }, [hasActiveJobs, load, session]);

  const visibleJobs = useMemo(() => jobs.filter((job) => {
    const completedKitExists = kits.some((kit) => kit.id === job.kitId);
    return isActiveJob(job) || job.status === "failed" || !completedKitExists;
  }), [jobs, kits]);

  return (
    <div className="workspace-shell">
      <WorkspaceHeader session={session} />
      <main className="workspace-main">
        <section className="workspace-hero" aria-labelledby="dashboard-title">
          <div>
            <p className="eyebrow">Private workspace</p>
            <h1 id="dashboard-title">Prepare with a plan.</h1>
            <p>Turn a role into an evidence-backed interview kit, then return here whenever you are ready to practise.</p>
          </div>
          <Link className="primary-link" href="/create">Create a kit</Link>
        </section>

        {(sessionError || loadError) && (
          <div className="dashboard-state dashboard-state--error" role="alert">
            <span>{sessionError ?? loadError}</span>
            <button className="secondary-button" type="button" onClick={() => sessionError ? retrySession() : setAttempt((value) => value + 1)}>Retry</button>
          </div>
        )}
        {!session && !sessionError && <div className="dashboard-state" aria-live="polite">Opening your workspace…</div>}
        {session && loading && <div className="dashboard-state" aria-live="polite">Loading your preparation kits…</div>}

        {session && !loading && !loadError && (
          <>
            {visibleJobs.length > 0 && (
              <section className="workspace-section" aria-labelledby="generation-heading">
                <div className="section-heading">
                  <div><p className="eyebrow">In progress</p><h2 id="generation-heading">Generation activity</h2></div>
                  {hasActiveJobs && <span className="live-label"><span />Updating live</span>}
                </div>
                <div className="card-grid">
                  {visibleJobs.map((job) => (
                    <Link className="kit-card job-card" href={`/jobs/${job.id}`} key={job.id}>
                      <div className="card-topline">
                        <span className={`status-chip status-chip--${job.status}`}>{job.status.replaceAll("_", " ")}</span>
                        <span>{job.source.days} days</span>
                      </div>
                      <h3>{stageLabel(job.stage)}</h3>
                      <p>{new URL(job.source.companyUrl).hostname}</p>
                      <div className="card-meta"><span>{job.progress.length} stages recorded</span><span>{formatDate(job.updatedAt)}</span></div>
                    </Link>
                  ))}
                </div>
              </section>
            )}

            <section className="workspace-section" aria-labelledby="kits-heading">
              <div className="section-heading">
                <div><p className="eyebrow">Your library</p><h2 id="kits-heading">Preparation kits</h2></div>
                {kits.length > 0 && <span className="section-count">{kits.length} {kits.length === 1 ? "kit" : "kits"}</span>}
              </div>
              {kits.length === 0 && visibleJobs.length === 0 ? (
                <div className="empty-panel">
                  <span className="empty-panel__number">01</span>
                  <div><h3>Start with the role you want.</h3><p>Paste a job description or upload a JSON batch. A short, non-empty description is enough.</p></div>
                  <Link className="primary-link" href="/create">Create your first kit</Link>
                </div>
              ) : kits.length === 0 ? (
                <p className="section-empty">Completed kits will appear here while generation continues above.</p>
              ) : (
                <div className="card-grid">
                  {kits.map((kit) => (
                    <Link className="kit-card" href={`/kits/${kit.id}`} key={kit.id}>
                      <div className="card-topline"><span className="status-chip status-chip--completed">Ready</span><span>{kit.days} days</span></div>
                      <h3>{kit.role || "Untitled role"}</h3>
                      <p>{kit.company || "Company not identified"}</p>
                      <div className="card-meta"><span>Revision {kit.revision}</span><span>{formatDate(kit.updatedAt)}</span></div>
                      {kit.warningCount > 0 && <span className="warning-note">{kit.warningCount} research {kit.warningCount === 1 ? "note" : "notes"}</span>}
                    </Link>
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}
