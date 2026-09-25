"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ChangeEvent, type FormEvent, useEffect, useState } from "react";
import { readApiError, type PublicJob } from "@/lib/api-types";
import { useSession } from "@/lib/use-session";
import { WorkspaceHeader } from "./workspace-header";

const DRAFT_KEY = "jobber:create-draft:v1";
type Mode = "manual" | "upload";
type Fields = { jd: string; company_url: string; days: string };
type BatchResult = {
  row: number;
  id?: string;
  status: "queued" | "invalid";
  deduplicated?: boolean;
  job?: PublicJob;
  error?: { code: string; message: string; fields?: Record<string, string> };
};

function validate(fields: Fields): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!fields.jd.trim()) errors.jd = "Paste a job description to continue.";
  try {
    const url = new URL(fields.company_url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
  } catch {
    errors.company_url = "Enter a complete HTTP or HTTPS company URL.";
  }
  const days = Number(fields.days);
  if (!Number.isInteger(days) || days < 1 || days > 60) errors.days = "Choose a whole number from 1 to 60.";
  return errors;
}

export function CreateKit() {
  const router = useRouter();
  const { session, error: sessionError, retry } = useSession();
  const [mode, setMode] = useState<Mode>("manual");
  const [fields, setFields] = useState<Fields>({ jd: "", company_url: "", days: "7" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [uploadName, setUploadName] = useState("");
  const [uploadRows, setUploadRows] = useState<unknown[] | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [batchResults, setBatchResults] = useState<BatchResult[] | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const raw = window.localStorage.getItem(DRAFT_KEY);
        if (raw) {
          const draft = JSON.parse(raw) as { version?: number; fields?: Fields };
          if (draft.version === 1 && draft.fields) setFields(draft.fields);
        }
      } catch {
        window.localStorage.removeItem(DRAFT_KEY);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      window.localStorage.setItem(DRAFT_KEY, JSON.stringify({ version: 1, fields }));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [fields]);

  function update(field: keyof Fields, value: string) {
    setFields((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: "" }));
  }

  async function submitManual(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session) return;
    const nextErrors = validate(fields);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    setSubmitting(true);
    setFormError(null);
    try {
      const response = await fetch("/api/v1/kits", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken },
        body: JSON.stringify({ ...fields, days: Number(fields.days) }),
      });
      if (!response.ok) {
        const error = await readApiError(response, "The kit could not be queued.");
        setErrors(error?.fields ?? {});
        throw new Error(error?.message);
      }
      const body = await response.json() as { job: PublicJob; deduplicated: boolean };
      window.localStorage.removeItem(DRAFT_KEY);
      router.push(`/jobs/${body.job.id}${body.deduplicated ? "?duplicate=1" : ""}`);
    } catch (caught) {
      setFormError(caught instanceof Error && caught.message ? caught.message : "The kit could not be queued. Please try again.");
      setSubmitting(false);
    }
  }

  async function readUpload(event: ChangeEvent<HTMLInputElement>) {
    setBatchResults(null);
    setUploadError(null);
    const file = event.target.files?.[0];
    if (!file) return;
    setUploadName(file.name);
    if (file.size > 1_000_000) {
      setUploadRows(null);
      setUploadError("Choose a JSON file smaller than 1 MB.");
      return;
    }
    try {
      const parsed: unknown = JSON.parse(await file.text());
      if (!Array.isArray(parsed)) throw new Error();
      setUploadRows(parsed);
    } catch {
      setUploadRows(null);
      setUploadError("The file must contain one JSON array of evaluation cases.");
    }
  }

  async function submitBatch() {
    if (!session || !uploadRows) return;
    setSubmitting(true);
    setUploadError(null);
    try {
      const response = await fetch("/api/v1/kits/batch", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken },
        body: JSON.stringify(uploadRows),
      });
      if (!response.ok) {
        const error = await readApiError(response, "The upload could not be processed.");
        throw new Error(error?.message);
      }
      const body = await response.json() as { results: BatchResult[] };
      setBatchResults(body.results);
    } catch (caught) {
      setUploadError(caught instanceof Error && caught.message ? caught.message : "The upload could not be processed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="workspace-shell">
      <WorkspaceHeader session={session} backHref="/dashboard" />
      <main className="form-page">
        <header className="form-intro">
          <p className="eyebrow">New preparation kit</p>
          <h1>Bring the role.<br />We’ll build the plan.</h1>
          <p>Your job description drives every question. Company research adds context when public evidence is available.</p>
        </header>

        {sessionError && <div className="dashboard-state dashboard-state--error" role="alert"><span>{sessionError}</span><button className="secondary-button" onClick={retry} type="button">Retry</button></div>}
        {!session && !sessionError && <div className="dashboard-state" aria-live="polite">Preparing the form…</div>}

        {session && (
          <section className="create-card" aria-labelledby="create-mode-heading">
            <h2 className="sr-only" id="create-mode-heading">Choose how to create kits</h2>
            <div className="mode-switch" role="group" aria-label="Creation method">
              <button type="button" aria-pressed={mode === "manual"} onClick={() => setMode("manual")}>One role</button>
              <button type="button" aria-pressed={mode === "upload"} onClick={() => setMode("upload")}>JSON upload</button>
            </div>

            {mode === "manual" ? (
              <form className="create-form" onSubmit={submitManual} noValidate>
                <div className="field">
                  <label htmlFor="jd">Job description</label>
                  <textarea id="jd" value={fields.jd} onChange={(event) => update("jd", event.target.value)} aria-invalid={Boolean(errors.jd)} aria-describedby={errors.jd ? "jd-error" : "jd-hint"} rows={13} />
                  {errors.jd ? <p className="field-error" id="jd-error">{errors.jd}</p> : <p className="field-hint" id="jd-hint">Paste the full listing when possible. Short descriptions are accepted.</p>}
                </div>
                <div className="form-row">
                  <div className="field">
                    <label htmlFor="company-url">Company URL</label>
                    <input id="company-url" type="url" placeholder="https://company.com" value={fields.company_url} onChange={(event) => update("company_url", event.target.value)} aria-invalid={Boolean(errors.company_url)} aria-describedby={errors.company_url ? "url-error" : undefined} />
                    {errors.company_url && <p className="field-error" id="url-error">{errors.company_url}</p>}
                  </div>
                  <div className="field field--days">
                    <label htmlFor="days">Days available</label>
                    <input id="days" type="number" inputMode="numeric" min="1" max="60" step="1" value={fields.days} onChange={(event) => update("days", event.target.value)} aria-invalid={Boolean(errors.days)} aria-describedby={errors.days ? "days-error" : undefined} />
                    {errors.days && <p className="field-error" id="days-error">{errors.days}</p>}
                  </div>
                </div>
                {formError && <p className="form-error" role="alert">{formError}</p>}
                <div className="form-actions"><button className="primary-button" type="submit" disabled={submitting}>{submitting ? "Queuing…" : "Generate my kit"}</button><span>Generation continues if you leave this page.</span></div>
              </form>
            ) : (
              <div className="upload-form">
                <div className="upload-drop">
                  <label htmlFor="batch-file">Choose a JSON case file</label>
                  <p>Use the same array format as the evaluation CLI: <code>id</code>, <code>jd</code>, <code>company_url</code>, and <code>days</code>.</p>
                  <input id="batch-file" type="file" accept="application/json,.json" onChange={(event) => void readUpload(event)} />
                  {uploadName && <span>{uploadName}{uploadRows ? ` · ${uploadRows.length} rows` : ""}</span>}
                </div>
                {uploadError && <p className="form-error" role="alert">{uploadError}</p>}
                {uploadRows && <button className="primary-button" type="button" onClick={() => void submitBatch()} disabled={submitting || uploadRows.length === 0}>{submitting ? "Validating rows…" : `Queue ${uploadRows.length} ${uploadRows.length === 1 ? "case" : "cases"}`}</button>}
                {batchResults && (
                  <div className="batch-results" aria-live="polite">
                    <div className="section-heading"><div><p className="eyebrow">Upload results</p><h3>Each row was checked independently.</h3></div><Link className="text-link" href="/dashboard">View dashboard</Link></div>
                    <ol>
                      {batchResults.map((result) => (
                        <li key={`${result.row}-${result.id ?? "missing"}`} className={result.status === "queued" ? "batch-row batch-row--good" : "batch-row batch-row--bad"}>
                          <span>Row {result.row}</span><strong>{result.id || "Missing ID"}</strong>
                          {result.job ? <Link href={`/jobs/${result.job.id}`}>{result.deduplicated ? "Already running" : "View generation"}</Link> : <p>{result.error?.message}</p>}
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
