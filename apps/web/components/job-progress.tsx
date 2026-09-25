"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { formatDate, isActiveJob, jobStatusLabel, readApiError, stageLabel, type PublicJob } from "@/lib/api-types";
import { useSession } from "@/lib/use-session";
import { InlineSpinner, LoadingState } from "./loading-state";
import { WorkspaceHeader } from "./workspace-header";

const stages = [
  ["researching", "Research company"],
  ["extracting", "Read the role"],
  ["synthesizing", "Synthesize evidence"],
  ["generating", "Generate questions"],
  ["checking_coverage", "Check coverage"],
  ["repairing", "Repair gaps"],
  ["flashcards", "Build flashcards"],
  ["scheduling", "Plan the schedule"],
  ["validating", "Validate the kit"],
] as const;

export function JobProgress({ jobId }: { jobId: string }) {
  const searchParams = useSearchParams();
  const { session, error: sessionError, retry: retrySession } = useSession();
  const [job, setJob] = useState<PublicJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!session) return;
    try {
      const response = await fetch(`/api/v1/jobs/${encodeURIComponent(jobId)}`, { credentials: "include", signal });
      if (!response.ok) {
        const apiError = await readApiError(response, "Generation could not be loaded.");
        throw new Error(apiError?.message);
      }
      const body = await response.json() as { job: PublicJob };
      setJob(body.job);
      setError(null);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setError(caught instanceof Error && caught.message ? caught.message : "Generation could not be loaded.");
    }
  }, [jobId, session]);

  useEffect(() => {
    if (!session) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(controller.signal), 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [load, session]);

  useEffect(() => {
    if (!job || !isActiveJob(job)) return;
    const timer = window.setInterval(() => void load(), 2000);
    return () => window.clearInterval(timer);
  }, [job, load]);

  async function retryJob() {
    if (!session) return;
    setRetrying(true);
    try {
      const response = await fetch(`/api/v1/jobs/${encodeURIComponent(jobId)}/retry`, {
        method: "POST",
        credentials: "include",
        headers: { "X-CSRF-Token": session.csrfToken },
      });
      if (!response.ok) {
        const apiError = await readApiError(response, "This job could not be retried.");
        throw new Error(apiError?.message);
      }
      const body = await response.json() as { job: PublicJob };
      setJob(body.job);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error && caught.message ? caught.message : "This job could not be retried.");
    } finally {
      setRetrying(false);
    }
  }

  const reached = new Set(job?.progress.map((entry) => entry.stage) ?? []);
  const currentIndex = stages.findIndex(([id]) => id === job?.stage);
  const complete = job?.status === "completed" || job?.status === "completed_with_warnings";

  return (
    <div className="workspace-shell">
      <WorkspaceHeader session={session} backHref="/dashboard" />
      <main id="main" className="progress-page">
        <section className="progress-intro">
          <p className="eyebrow">Preparation progress</p>
          <h1>{complete ? "Your kit is ready." : job?.status === "failed" ? "Generation needs attention." : "Building your preparation kit."}</h1>
          <p>{job ? `${new URL(job.source.companyUrl).hostname} · ${job.source.days} day plan` : "Loading your saved progress…"}</p>
          {searchParams.get("duplicate") === "1" && <div className="notice">This role is already being prepared, so we reopened its existing progress.</div>}
        </section>

        {(sessionError || error) && <div className="dashboard-state dashboard-state--error" role="alert"><span>{sessionError ?? error}</span><button className="secondary-button" type="button" onClick={() => sessionError ? retrySession() : void load()}>Retry</button></div>}
        {!job && !error && !sessionError && <LoadingState label="Loading generation progress…" detail="Reconnecting to your saved progress." />}

        {job && (
          <div className="progress-layout">
            <section className="timeline-card" aria-labelledby="timeline-heading">
              <div className="section-heading"><div><p className="eyebrow">Progress</p><h2 id="timeline-heading">{stageLabel(job.stage)}</h2></div><span className={`status-chip status-chip--${job.status}`}>{jobStatusLabel(job.status)}</span></div>
              {isActiveJob(job) && (
                <div className="generation-live" role="status" aria-live="polite">
                  <InlineSpinner />
                  <div>
                    <strong>{job.status === "retry_wait" ? "Waiting for the next safe retry." : job.status === "queued" ? "Your job is securely queued." : `${stageLabel(job.stage)} is in progress.`}</strong>
                    <span>This page refreshes automatically. You can leave and return safely.</span>
                  </div>
                </div>
              )}
              <div className="stage-progress" aria-hidden="true">
                {stages.map(([id], index) => {
                  const done = reached.has(id) || complete || (currentIndex > index && currentIndex !== -1);
                  const current = job.stage === id && isActiveJob(job);
                  return <span className={current ? "stage-progress__step stage-progress__step--current" : done ? "stage-progress__step stage-progress__step--done" : "stage-progress__step"} key={id} />;
                })}
              </div>
              <ol className="stage-list">
                {stages.map(([id, label], index) => {
                  const done = reached.has(id) || complete || (currentIndex > index && currentIndex !== -1);
                  const current = job.stage === id && isActiveJob(job);
                  const detail = [...job.progress].reverse().find((entry) => entry.stage === id)?.detail;
                  return <li className={current ? "stage stage--current" : done ? "stage stage--done" : "stage"} key={id}><span className="stage__marker">{done && !current ? "✓" : index + 1}</span><div><strong>{label}{current && <span className="sr-only"> — in progress</span>}</strong>{detail && <p>{detail}</p>}</div></li>;
                })}
              </ol>
            </section>

            <aside className="progress-aside">
              <div className="fact-card"><span>Attempt</span><strong>{job.retry.attempt} / {job.retry.maxAttempts}</strong></div>
              <div className="fact-card"><span>Last update</span><strong>{formatDate(job.updatedAt)}</strong></div>
              {job.status === "retry_wait" && <div className="notice"><strong>Automatic retry scheduled.</strong><br />{job.retry.nextAttemptAt ? `Next attempt ${formatDate(job.retry.nextAttemptAt)}.` : "Jobber will try again shortly."}</div>}
              {job.error && <div className="failure-panel" role="alert"><p className="eyebrow">Needs attention</p><h2>Generation stopped</h2><p>{job.error.message}</p><button className="primary-button button-with-spinner" type="button" onClick={() => void retryJob()} disabled={retrying}>{retrying && <InlineSpinner />}{retrying ? "Restarting…" : "Retry generation"}</button></div>}
              {complete && <div className="completion-panel"><p className="eyebrow">Complete</p><h2>Ready to study</h2><p>Your questions, flashcards, evidence, and daily plan are saved.</p><Link className="primary-link" href={`/kits/${job.kitId}`}>Open preparation kit</Link></div>}
            </aside>
          </div>
        )}

        {job && job.warnings.length > 0 && <section className="warning-panel" aria-labelledby="warning-heading"><p className="eyebrow">Research notes</p><h2 id="warning-heading">Usable kit, with honest limits</h2><ul>{job.warnings.map((warning, index) => <li key={`${warning.code}-${index}`}><span>{warning.message}</span></li>)}</ul></section>}
      </main>
    </div>
  );
}
