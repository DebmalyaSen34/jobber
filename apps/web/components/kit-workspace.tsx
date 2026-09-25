"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatDate, readApiError, stageLabel, type OwnedKit } from "@/lib/api-types";
import { useSession } from "@/lib/use-session";
import { WorkspaceHeader } from "./workspace-header";

export function KitWorkspace({ kitId }: { kitId: string }) {
  const { session, error: sessionError, retry: retrySession } = useSession();
  const [kit, setKit] = useState<OwnedKit | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!session) return;
    try {
      const response = await fetch(`/api/v1/kits/${encodeURIComponent(kitId)}`, { credentials: "include", signal });
      if (!response.ok) {
        const apiError = await readApiError(response, "This kit could not be loaded.");
        throw new Error(apiError?.message);
      }
      const body = await response.json() as { kit: OwnedKit };
      setKit(body.kit);
      setError(null);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setError(caught instanceof Error && caught.message ? caught.message : "This kit could not be loaded.");
    }
  }, [kitId, session]);

  useEffect(() => {
    if (!session) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(controller.signal), 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [load, session]);

  const requirementById = useMemo(() => new Map(kit?.content.role.requirements.map((item) => [item.id, item]) ?? []), [kit]);
  const questionById = useMemo(() => new Map(kit?.content.questions.map((item) => [item.id, item]) ?? []), [kit]);
  const groupedQuestions = useMemo(() => {
    const groups = new Map<string, OwnedKit["content"]["questions"]>();
    for (const question of kit?.content.questions ?? []) {
      const group = groups.get(question.category) ?? [];
      group.push(question);
      groups.set(question.category, group);
    }
    return [...groups.entries()];
  }, [kit]);

  return (
    <div className="workspace-shell">
      <WorkspaceHeader session={session} backHref="/dashboard" />
      <main className="kit-page">
        {(sessionError || error) && <div className="dashboard-state dashboard-state--error" role="alert"><span>{sessionError ?? error}</span><button className="secondary-button" type="button" onClick={() => sessionError ? retrySession() : void load()}>Retry</button></div>}
        {!kit && !error && !sessionError && <div className="dashboard-state" aria-live="polite">Opening your preparation kit…</div>}

        {kit && (
          <>
            <header className="kit-hero">
              <div><p className="eyebrow">{kit.content.source.company || "Preparation kit"}</p><h1>{kit.content.role.title || kit.content.source.role || "Untitled role"}</h1><p>{[kit.content.role.seniority, kit.content.source.location].filter(Boolean).join(" · ") || `${kit.days}-day preparation plan`}</p></div>
              <dl className="kit-stats"><div><dt>Questions</dt><dd>{kit.content.questions.length}</dd></div><div><dt>Flashcards</dt><dd>{kit.content.flashcards.length}</dd></div><div><dt>Days</dt><dd>{kit.days}</dd></div></dl>
            </header>

            {kit.content.warnings && kit.content.warnings.length > 0 && (
              <details className="warning-panel kit-warning"><summary>{kit.content.warnings.length} research {kit.content.warnings.length === 1 ? "note" : "notes"}</summary><ul>{kit.content.warnings.map((warning, index) => <li key={`${warning.code}-${index}`}><strong>{warning.code.replaceAll("_", " ")}</strong><span>{warning.message}</span></li>)}</ul></details>
            )}

            <nav className="kit-nav" aria-label="Kit sections"><a href="#company">Company</a><a href="#role">Role</a><a href="#questions">Questions</a><a href="#flashcards">Flashcards</a><a href="#schedule">Schedule</a><a href="#evidence">Evidence</a></nav>

            <section className="kit-section company-section" id="company" aria-labelledby="company-heading">
              <div className="section-number">01</div><div><p className="eyebrow">Company brief</p><h2 id="company-heading">Know the context.</h2><p className="section-lede">{kit.content.company_brief.summary || "No reliable company summary was available."}</p>{kit.content.company_brief.what_they_do && <p>{kit.content.company_brief.what_they_do}</p>}</div>
            </section>

            <section className="kit-section" id="role" aria-labelledby="role-heading">
              <div className="section-number">02</div><div><p className="eyebrow">Role map</p><h2 id="role-heading">What the role asks of you.</h2>
                {kit.content.role.responsibilities.length > 0 && <ul className="responsibility-list">{kit.content.role.responsibilities.map((item, index) => <li key={index}>{item}</li>)}</ul>}
                <div className="requirement-grid">{kit.content.role.requirements.map((requirement) => <article className="requirement-card" key={requirement.id}><span className={`priority priority--${requirement.priority}`}>{requirement.priority}</span><h3>{requirement.text}</h3><p>{requirement.kind}</p></article>)}</div>
                {kit.content.role.requirements.length === 0 && <p className="section-empty">The description did not contain reliable, extractable requirements. The rest of this kit stays intentionally light.</p>}
              </div>
            </section>

            <section className="kit-section" id="questions" aria-labelledby="questions-heading">
              <div className="section-number">03</div><div><p className="eyebrow">Interview questions</p><h2 id="questions-heading">Practise the thinking, not a script.</h2>
                <div className="question-groups">{groupedQuestions.map(([category, questions]) => <section key={category} className="question-group"><h3>{stageLabel(category)} <span>{questions.length}</span></h3>{questions.map((question, index) => <article className="question-card" key={question.id}><div className="question-number">{String(index + 1).padStart(2, "0")}</div><div><h4>{question.prompt}</h4><p className="answer-outline">{question.answer_outline || "Build your answer from the linked role requirements."}</p><div className="tag-row"><span>Difficulty {question.difficulty}</span>{question.requirement_ids.map((id) => <span key={id}>{requirementById.get(id)?.text ?? id}</span>)}</div></div></article>)}</section>)}</div>
                {kit.content.questions.length === 0 && <p className="section-empty">No reliable questions could be generated from this input.</p>}
              </div>
            </section>

            <section className="kit-section" id="flashcards" aria-labelledby="flashcards-heading">
              <div className="section-number">04</div><div><p className="eyebrow">Flashcards</p><h2 id="flashcards-heading">Fast recall, full context.</h2><div className="flashcard-grid">{kit.content.flashcards.map((card) => <article className="flashcard" key={card.id}><p className="flashcard__label">Prompt</p><h3>{card.front}</h3><div className="flashcard__answer"><p className="flashcard__label">Answer</p><p>{card.back || "No answer supplied."}</p></div></article>)}</div>{kit.content.flashcards.length === 0 && <p className="section-empty">This kit has no flashcards yet.</p>}</div>
            </section>

            <section className="kit-section" id="schedule" aria-labelledby="schedule-heading">
              <div className="section-number">05</div><div><p className="eyebrow">Study schedule</p><h2 id="schedule-heading">A plan for every available day.</h2><ol className="schedule-list">{kit.content.schedule.days.map((day) => <li key={day.day}><div className="day-marker"><span>Day</span><strong>{day.day}</strong></div><div><h3>{day.focus || "Review and consolidate"}</h3><p>{day.question_ids.length > 0 ? day.question_ids.map((id) => questionById.get(id)?.prompt ?? id).join(" · ") : "No new material scheduled; use this day to review."}</p></div><span className="minutes">{day.minutes} min</span></li>)}</ol></div>
            </section>

            <section className="kit-section" id="evidence" aria-labelledby="evidence-heading">
              <div className="section-number">06</div><div><p className="eyebrow">Sources & coverage</p><h2 id="evidence-heading">What supports this kit.</h2><div className="evidence-grid"><div><span>Coverage passes</span><strong>{kit.content.coverage.passes}</strong></div><div><span>Uncovered requirements</span><strong>{kit.content.coverage.uncovered_requirement_ids.length}</strong></div><div><span>Last updated</span><strong>{formatDate(kit.updatedAt)}</strong></div></div>
                <ul className="source-list"><li><a href={kit.content.source.company_url} target="_blank" rel="noreferrer">Original company URL</a></li>{[...new Set([...kit.content.source.pages_used, ...kit.content.company_brief.sources])].map((source) => <li key={source}><a href={source} target="_blank" rel="noreferrer">{source}</a></li>)}</ul>
                {kit.content.source.pages_used.length === 0 && kit.content.company_brief.sources.length === 0 && <p className="section-empty">No public pages were used. This kit is based on the supplied job description.</p>}
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
