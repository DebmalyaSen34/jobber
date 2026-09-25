"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  formatDate,
  readApiError,
  stageLabel,
  type OwnedKit,
  type KitDerivedState,
  type PublicRegeneration,
  type Question,
  type Requirement,
} from "@/lib/api-types";
import { useSession } from "@/lib/use-session";
import { WorkspaceHeader } from "./workspace-header";
import { InlineSpinner, LoadingState } from "./loading-state";

type KitContent = OwnedKit["content"];
type SaveState = "idle" | "saving" | "saved" | "error" | "conflict";
const categories: Question["category"][] = ["technical", "behavioural", "system-design", "company-fit"];
const requirementKinds: Requirement["kind"][] = ["technical", "behavioural", "domain"];

function copyContent(content: KitContent): KitContent {
  return structuredClone(content);
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function rebaseCollection<T extends { id: string }>(base: T[], local: T[], remote: T[]): T[] {
  if (same(base, local)) return remote;
  const baseById = new Map(base.map((item) => [item.id, item]));
  const localById = new Map(local.map((item) => [item.id, item]));
  const deleted = new Set(base.filter(({ id }) => !localById.has(id)).map(({ id }) => id));
  const result = remote.filter(({ id }) => !deleted.has(id)).map((item) => {
    const localItem = localById.get(item.id);
    const baseItem = baseById.get(item.id);
    return localItem && (!baseItem || !same(baseItem, localItem)) ? structuredClone(localItem) : item;
  });
  const resultIds = new Set(result.map(({ id }) => id));
  for (const item of local) if (!resultIds.has(item.id)) result.push(structuredClone(item));
  const baseOrder = base.map(({ id }) => id).filter((id) => localById.has(id));
  const localOrder = local.map(({ id }) => id).filter((id) => baseById.has(id));
  if (!same(baseOrder, localOrder)) {
    const rank = new Map(local.map(({ id }, index) => [id, index]));
    result.sort((left, right) => (rank.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.id) ?? Number.MAX_SAFE_INTEGER));
  }
  return result;
}

function rebaseLocalDraft(base: KitContent, local: KitContent, remote: KitContent): KitContent {
  const next = copyContent(remote);
  if (base.source.company !== local.source.company) next.source.company = local.source.company;
  if (base.source.role !== local.source.role) next.source.role = local.source.role;
  if (base.source.location !== local.source.location) next.source.location = local.source.location;
  if (base.company_brief.summary !== local.company_brief.summary) next.company_brief.summary = local.company_brief.summary;
  if (base.company_brief.what_they_do !== local.company_brief.what_they_do) next.company_brief.what_they_do = local.company_brief.what_they_do;
  if (base.role.title !== local.role.title) next.role.title = local.role.title;
  if (base.role.seniority !== local.role.seniority) next.role.seniority = local.role.seniority;
  if (!same(base.role.responsibilities, local.role.responsibilities)) next.role.responsibilities = structuredClone(local.role.responsibilities);
  next.role.requirements = rebaseCollection(base.role.requirements, local.role.requirements, remote.role.requirements);
  next.questions = rebaseCollection(base.questions, local.questions, remote.questions);
  next.flashcards = rebaseCollection(base.flashcards, local.flashcards, remote.flashcards);
  if (!same(base.schedule, local.schedule)) next.schedule = structuredClone(local.schedule);
  return next;
}

function deriveDraftState(content: KitContent): KitDerivedState {
  const requirementIds = new Set(content.role.requirements.map(({ id }) => id));
  const covered = new Set(content.questions.flatMap(({ requirement_ids }) => requirement_ids).filter((id) => requirementIds.has(id)));
  const uncovered = content.role.requirements.filter(({ id }) => !covered.has(id)).map(({ id }) => id);
  const uncoveredMust = content.role.requirements.filter(({ id, priority }) => priority === "must" && !covered.has(id)).map(({ id }) => id);
  const questionIds = new Set(content.questions.map(({ id }) => id));
  const scheduledIds = [...new Set(content.schedule.days.flatMap(({ question_ids }) => question_ids))].filter((id) => questionIds.has(id));
  const scheduled = new Set(scheduledIds);
  const scheduledRequirementIds = new Set(content.questions
    .filter(({ id }) => scheduled.has(id))
    .flatMap(({ requirement_ids }) => requirement_ids));
  const coveredButUnscheduledMust = content.role.requirements
    .filter(({ id, priority }) => priority === "must" && covered.has(id) && !scheduledRequirementIds.has(id))
    .map(({ id }) => id);
  const unscheduledQuestions = content.questions.filter(({ id }) => !scheduled.has(id)).map(({ id }) => id);
  const scheduleReasons: KitDerivedState["schedule_reasons"] = [];
  if (unscheduledQuestions.length > 0) scheduleReasons.push("UNSCHEDULED_QUESTIONS");
  if (coveredButUnscheduledMust.length > 0) scheduleReasons.push("UNSCHEDULED_MUST_REQUIREMENTS");
  return {
    covered_requirement_ids: content.role.requirements.filter(({ id }) => covered.has(id)).map(({ id }) => id),
    uncovered_requirement_ids: uncovered,
    uncovered_must_requirement_ids: uncoveredMust,
    scheduled_question_ids: scheduledIds,
    unscheduled_question_ids: unscheduledQuestions,
    covered_but_unscheduled_must_requirement_ids: coveredButUnscheduledMust,
    schedule_needs_regeneration: scheduleReasons.length > 0,
    schedule_reasons: scheduleReasons,
  };
}

function manualId(prefix: string): string {
  return `${prefix}-manual-${crypto.randomUUID()}`;
}

function confirmDelete(label: string): boolean {
  return window.confirm(`Delete ${label}? This change will not reach the server until you save.`);
}

function ReferenceChecks({
  legend,
  options,
  selected,
  onChange,
}: {
  legend: string;
  options: Array<{ id: string; label: string }>;
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  return (
    <fieldset className="reference-checks">
      <legend>{legend}</legend>
      {options.length === 0 ? <p>No items are available to link.</p> : options.map((option) => (
        <label key={option.id}>
          <input
            type="checkbox"
            checked={selected.includes(option.id)}
            onChange={(event) => onChange(event.target.checked
              ? [...selected, option.id]
              : selected.filter((id) => id !== option.id))}
          />
          <span>{option.label}</span>
        </label>
      ))}
    </fieldset>
  );
}

export function KitWorkspace({ kitId }: { kitId: string }) {
  const { session, error: sessionError, retry: retrySession } = useSession();
  const [kit, setKit] = useState<OwnedKit | null>(null);
  const [draft, setDraft] = useState<KitContent | null>(null);
  const [editing, setEditing] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveMessage, setSaveMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pinnedQuestionIds, setPinnedQuestionIds] = useState<string[]>([]);
  const [regenerating, setRegenerating] = useState<string | null>(null);
  const [regenerationMessage, setRegenerationMessage] = useState("");
  const dirtyRef = useRef(false);
  const draftRef = useRef<KitContent | null>(null);
  const pinsRef = useRef<string[]>([]);

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
      setDraft(copyContent(body.kit.content));
      setPinnedQuestionIds(Object.entries(body.kit.metadata.questions).filter(([, value]) => value.pinned).map(([id]) => id));
      setError(null);
      setSaveState("idle");
      setSaveMessage("");
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

  const pinDirty = useMemo(() => {
    if (!kit) return false;
    const saved = Object.entries(kit.metadata.questions).filter(([, value]) => value.pinned).map(([id]) => id).sort();
    return JSON.stringify(saved) !== JSON.stringify([...pinnedQuestionIds].sort());
  }, [kit, pinnedQuestionIds]);
  const dirty = useMemo(() => Boolean(kit && draft && (JSON.stringify(kit.content) !== JSON.stringify(draft) || pinDirty)), [draft, kit, pinDirty]);

  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);
  useEffect(() => { draftRef.current = draft; }, [draft]);
  useEffect(() => { pinsRef.current = pinnedQuestionIds; }, [pinnedQuestionIds]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const updateDraft = useCallback((change: (next: KitContent) => void) => {
    setDraft((current) => {
      if (!current) return current;
      const next = copyContent(current);
      change(next);
      return next;
    });
    setSaveState("idle");
    setSaveMessage("");
  }, []);

  const requirementById = useMemo(() => new Map(draft?.role.requirements.map((item) => [item.id, item]) ?? []), [draft]);
  const questionById = useMemo(() => new Map(draft?.questions.map((item) => [item.id, item]) ?? []), [draft]);
  const groupedQuestions = useMemo(() => categories.map((category) => ({
    category,
    questions: draft?.questions.filter((question) => question.category === category) ?? [],
  })).filter(({ questions }) => editing || questions.length > 0), [draft, editing]);
  const requirementOptions = useMemo(() => draft?.role.requirements.map((item) => ({ id: item.id, label: item.text })) ?? [], [draft]);
  const questionOptions = useMemo(() => draft?.questions.map((item) => ({ id: item.id, label: item.prompt })) ?? [], [draft]);
  const derivedState = useMemo(() => draft ? deriveDraftState(draft) : kit?.derivedState, [draft, kit?.derivedState]);
  const reconciliationTotal = kit ? (
    kit.reconciliation.removedQuestionRequirementLinks
      + kit.reconciliation.removedFlashcardRequirementLinks
      + kit.reconciliation.removedScheduleQuestionLinks
  ) : 0;

  function startEditing() {
    if (!kit) return;
    setDraft(copyContent(kit.content));
    setPinnedQuestionIds(Object.entries(kit.metadata.questions).filter(([, value]) => value.pinned).map(([id]) => id));
    setEditing(true);
    setSaveState("idle");
    setSaveMessage("");
  }

  function discardEdits() {
    if (!kit || (dirty && !window.confirm("Discard all unsaved edits?"))) return;
    setDraft(copyContent(kit.content));
    setPinnedQuestionIds(Object.entries(kit.metadata.questions).filter(([, value]) => value.pinned).map(([id]) => id));
    setEditing(false);
    setSaveState("idle");
    setSaveMessage("");
  }

  async function save() {
    if (!session || !kit || !draft || !dirty) return;
    setSaveState("saving");
    setSaveMessage("Saving your changes…");
    try {
      const response = await fetch(`/api/v1/kits/${encodeURIComponent(kit.id)}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken },
        body: JSON.stringify({ revision: kit.revision, content: draft, pinned_question_ids: pinnedQuestionIds }),
      });
      if (!response.ok) {
        const apiError = await readApiError(response, "Your changes could not be saved.");
        setSaveState(apiError?.code === "KIT_REVISION_CONFLICT" ? "conflict" : "error");
        throw new Error(apiError?.message);
      }
      const body = await response.json() as { kit: OwnedKit };
      setKit(body.kit);
      setDraft(copyContent(body.kit.content));
      setPinnedQuestionIds(Object.entries(body.kit.metadata.questions).filter(([, value]) => value.pinned).map(([id]) => id));
      setSaveState("saved");
      const cleaned = body.kit.reconciliation.removedQuestionRequirementLinks
        + body.kit.reconciliation.removedFlashcardRequirementLinks
        + body.kit.reconciliation.removedScheduleQuestionLinks;
      setSaveMessage(cleaned > 0
        ? `Saved revision ${body.kit.revision}. Removed ${cleaned} stale ${cleaned === 1 ? "reference" : "references"}.`
        : `Saved revision ${body.kit.revision}. Coverage and schedule checks are up to date.`);
    } catch (caught) {
      const message = caught instanceof Error && caught.message ? caught.message : "Your changes could not be saved.";
      setSaveMessage(message);
      setSaveState((current) => current === "conflict" ? current : "error");
    }
  }

  async function regenerate(target: PublicRegeneration["target"]) {
    if (!session || !kit || dirty || regenerating) return;
    const key = target.type === "question-category" ? target.category : target.type;
    const baseDraft = copyContent(draft!);
    const basePins = [...pinnedQuestionIds];
    setRegenerating(key);
    setRegenerationMessage(`Regenerating ${stageLabel(key)}… You can keep editing; save those edits while this runs so the merge can protect them.`);
    try {
      const response = await fetch(`/api/v1/kits/${encodeURIComponent(kit.id)}/regenerate`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken },
        body: JSON.stringify(target),
      });
      if (!response.ok) throw new Error((await readApiError(response, "Regeneration could not start."))?.message);
      let job = (await response.json() as { regeneration: PublicRegeneration }).regeneration;
      for (let attempt = 0; attempt < 900 && (job.status === "queued" || job.status === "running"); attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 1_000));
        const statusResponse = await fetch(`/api/v1/regenerations/${encodeURIComponent(job.id)}`, { credentials: "include" });
        if (!statusResponse.ok) throw new Error((await readApiError(statusResponse, "Regeneration status could not be loaded."))?.message);
        job = (await statusResponse.json() as { regeneration: PublicRegeneration }).regeneration;
      }
      if (job.status !== "completed") throw new Error(job.error?.message ?? "Regeneration did not finish in time.");
      const kitResponse = await fetch(`/api/v1/kits/${encodeURIComponent(kit.id)}`, { credentials: "include" });
      if (!kitResponse.ok) throw new Error((await readApiError(kitResponse, "The merged kit could not be loaded."))?.message);
      const mergedKit = (await kitResponse.json() as { kit: OwnedKit }).kit;
      const remotePins = Object.entries(mergedKit.metadata.questions).filter(([, value]) => value.pinned).map(([id]) => id);
      if (dirtyRef.current && draftRef.current) {
        const rebased = rebaseLocalDraft(baseDraft, draftRef.current, mergedKit.content);
        const localPinsChanged = !same([...basePins].sort(), [...pinsRef.current].sort());
        setKit(mergedKit);
        setDraft(rebased);
        setPinnedQuestionIds(localPinsChanged ? pinsRef.current : remotePins);
        setSaveState("idle");
        setSaveMessage("");
        setRegenerationMessage(`${stageLabel(key)} merged. Your newer local edits were preserved on top; review and save them.`);
      } else {
        setKit(mergedKit);
        setDraft(copyContent(mergedKit.content));
        setPinnedQuestionIds(remotePins);
        setRegenerationMessage(`${stageLabel(key)} regenerated and safely merged.`);
      }
    } catch (caught) {
      setRegenerationMessage(caught instanceof Error && caught.message ? caught.message : "Regeneration failed.");
    } finally {
      setRegenerating(null);
    }
  }

  function removeRequirement(id: string) {
    const requirement = requirementById.get(id);
    if (!requirement || !confirmDelete(`the requirement “${requirement.text}”`)) return;
    updateDraft((next) => {
      next.role.requirements = next.role.requirements.filter((item) => item.id !== id);
      next.questions = next.questions.map((question) => ({ ...question, requirement_ids: question.requirement_ids.filter((value) => value !== id) }));
      next.flashcards = next.flashcards.map((card) => ({ ...card, requirement_ids: card.requirement_ids.filter((value) => value !== id) }));
      next.coverage.uncovered_requirement_ids = next.coverage.uncovered_requirement_ids.filter((value) => value !== id);
    });
  }

  function removeQuestion(id: string) {
    const question = questionById.get(id);
    if (!question || !confirmDelete(`the question “${question.prompt}”`)) return;
    updateDraft((next) => {
      next.questions = next.questions.filter((item) => item.id !== id);
      next.schedule.days = next.schedule.days.map((day) => ({ ...day, question_ids: day.question_ids.filter((value) => value !== id) }));
    });
  }

  function moveQuestion(questionId: string, direction: -1 | 1) {
    updateDraft((next) => {
      const index = next.questions.findIndex((question) => question.id === questionId);
      if (index < 0) return;
      const category = next.questions[index]!.category;
      const peers = next.questions.map((question, peerIndex) => ({ question, peerIndex }))
        .filter(({ question }) => question.category === category);
      const peerPosition = peers.findIndex(({ question }) => question.id === questionId);
      const target = peers[peerPosition + direction];
      if (!target) return;
      [next.questions[index], next.questions[target.peerIndex]] = [next.questions[target.peerIndex]!, next.questions[index]!];
    });
  }

  if (!draft) {
    return (
      <div className="workspace-shell">
        <WorkspaceHeader session={session} backHref="/dashboard" />
        <main className="kit-page">
          {(sessionError || error) && <div className="dashboard-state dashboard-state--error" role="alert"><span>{sessionError ?? error}</span><button className="secondary-button" type="button" onClick={() => sessionError ? retrySession() : void load()}>Retry</button></div>}
          {!error && !sessionError && <LoadingState label="Opening your preparation kit…" detail="Loading the latest saved revision." />}
        </main>
      </div>
    );
  }

  return (
    <div className="workspace-shell">
      <WorkspaceHeader session={session} backHref="/dashboard" />
      <main className="kit-page">
        {(sessionError || error) && <div className="dashboard-state dashboard-state--error" role="alert"><span>{sessionError ?? error}</span><button className="secondary-button" type="button" onClick={() => sessionError ? retrySession() : void load()}>Retry</button></div>}

        <header className="kit-hero">
          <div>
            {editing ? <label className="editor-field editor-field--compact"><span>Company</span><input value={draft.source.company} onChange={(event) => updateDraft((next) => { next.source.company = event.target.value; })} /></label> : <p className="eyebrow">{draft.source.company || "Preparation kit"}</p>}
            {editing ? <label className="editor-field editor-field--title"><span>Role title</span><input value={draft.role.title} onChange={(event) => updateDraft((next) => { next.role.title = event.target.value; next.source.role = event.target.value; })} /></label> : <h1>{draft.role.title || draft.source.role || "Untitled role"}</h1>}
            {editing ? <div className="editor-inline-grid"><label className="editor-field"><span>Seniority</span><input value={draft.role.seniority} onChange={(event) => updateDraft((next) => { next.role.seniority = event.target.value; })} /></label><label className="editor-field"><span>Location</span><input value={draft.source.location} onChange={(event) => updateDraft((next) => { next.source.location = event.target.value; })} /></label></div> : <p>{[draft.role.seniority, draft.source.location].filter(Boolean).join(" · ") || `${kit?.days ?? draft.schedule.days_available}-day preparation plan`}</p>}
          </div>
          <dl className="kit-stats"><div><dt>Questions</dt><dd>{draft.questions.length}</dd></div><div><dt>Flashcards</dt><dd>{draft.flashcards.length}</dd></div><div><dt>Days</dt><dd>{draft.schedule.days_available}</dd></div></dl>
        </header>

        {draft.warnings && draft.warnings.length > 0 && <details className="warning-panel kit-warning"><summary>{draft.warnings.length} research {draft.warnings.length === 1 ? "note" : "notes"}</summary><ul>{draft.warnings.map((warning, index) => <li key={`${warning.code}-${index}`}><strong>{warning.code.replaceAll("_", " ")}</strong><span>{warning.message}</span></li>)}</ul></details>}
        <nav className="kit-nav" aria-label="Kit sections"><a href="#company">Company</a><a href="#role">Role</a><a href="#questions">Questions</a><a href="#flashcards">Flashcards</a><a href="#schedule">Schedule</a><a href="#evidence">Evidence</a></nav>

        <div className="editor-toolbar" aria-label="Kit editing controls">
          <div aria-live="polite"><strong>{editing ? (dirty ? "Unsaved changes" : "Editing revision is up to date") : `Revision ${kit?.revision ?? 1}`}</strong><span className={`save-message save-message--${saveState}`}>{saveMessage || (editing ? "Changes stay local until you save." : "Open edit mode to customize this kit.")}</span></div>
          <div className="editor-toolbar__actions">{editing ? <><button className="secondary-button" type="button" onClick={discardEdits} disabled={saveState === "saving"}>Done</button><button className="primary-button button-with-spinner" type="button" onClick={() => void save()} disabled={!dirty || saveState === "saving"}>{saveState === "saving" && <InlineSpinner />}{saveState === "saving" ? "Saving…" : "Save changes"}</button></> : <button className="primary-button" type="button" onClick={startEditing}>Edit kit</button>}</div>
          {saveState === "conflict" && <button className="text-link editor-reload" type="button" onClick={() => void load()}>Discard local edits and load latest revision</button>}
          {regenerationMessage && <p className="editor-note" aria-live="polite">{regenerating && <InlineSpinner />} {regenerationMessage}</p>}
        </div>

        {derivedState && <section className={`kit-health ${derivedState.uncovered_requirement_ids.length > 0 || derivedState.schedule_needs_regeneration ? "kit-health--attention" : "kit-health--ready"}`} aria-labelledby="kit-health-heading">
          <div className="kit-health__header">
            <div><p className="eyebrow">{dirty ? "Unsaved health preview" : "Saved kit health"}</p><h2 id="kit-health-heading">{derivedState.uncovered_requirement_ids.length > 0 || derivedState.schedule_needs_regeneration ? "A few areas need attention." : "Coverage and schedule are in sync."}</h2></div>
            <span className="health-status">{dirty ? "Preview" : derivedState.schedule_needs_regeneration || derivedState.uncovered_requirement_ids.length > 0 ? "Action needed" : "Up to date"}</span>
          </div>
          <div className="health-metrics">
            <div><span>Uncovered requirements</span><strong>{derivedState.uncovered_requirement_ids.length}</strong></div>
            <div><span>Uncovered must-haves</span><strong>{derivedState.uncovered_must_requirement_ids.length}</strong></div>
            <div><span>Unscheduled questions</span><strong>{derivedState.unscheduled_question_ids.length}</strong></div>
          </div>
          {derivedState.uncovered_requirement_ids.length > 0 && <div className="health-detail"><strong>Question coverage gaps</strong><p>These requirements currently have no linked interview question:</p><ul>{derivedState.uncovered_requirement_ids.map((id) => <li key={id}>{requirementById.get(id)?.text ?? id}{derivedState.uncovered_must_requirement_ids.includes(id) ? <span>Must-have</span> : null}</li>)}</ul></div>}
          {derivedState.schedule_needs_regeneration && <div className="health-detail"><strong>Schedule repair recommended</strong><p>{derivedState.unscheduled_question_ids.length > 0 ? `${derivedState.unscheduled_question_ids.length} ${derivedState.unscheduled_question_ids.length === 1 ? "question is" : "questions are"} missing from the plan. ` : ""}{derivedState.covered_but_unscheduled_must_requirement_ids.length > 0 ? `${derivedState.covered_but_unscheduled_must_requirement_ids.length} covered must-have ${derivedState.covered_but_unscheduled_must_requirement_ids.length === 1 ? "requirement is" : "requirements are"} absent from scheduled practice.` : ""}</p></div>}
          {reconciliationTotal > 0 && kit && kit.reconciliation.revision === kit.revision && <p className="health-reconciliation" role="status">The last save safely removed {reconciliationTotal} stale {reconciliationTotal === 1 ? "reference" : "references"} after content was deleted.</p>}
          {(derivedState.uncovered_requirement_ids.length > 0 || derivedState.schedule_needs_regeneration) && <div className="health-actions">
            {derivedState.uncovered_requirement_ids.length > 0 && <a className="small-button" href="#questions">Review question coverage</a>}
            {derivedState.schedule_needs_regeneration && <button className="small-button button-with-spinner" type="button" disabled={dirty || Boolean(regenerating) || derivedState.uncovered_must_requirement_ids.length > 0} aria-describedby={dirty || derivedState.uncovered_must_requirement_ids.length > 0 ? "schedule-repair-help" : undefined} onClick={() => void regenerate({ type: "schedule" })}>{regenerating === "schedule" && <InlineSpinner />}{regenerating === "schedule" ? "Repairing…" : "Repair schedule"}</button>}
            {(dirty || derivedState.uncovered_must_requirement_ids.length > 0) && derivedState.schedule_needs_regeneration && <span id="schedule-repair-help">{dirty ? "Save the preview first to enable schedule repair." : "Cover the must-have requirement gaps before repairing the schedule."}</span>}
          </div>}
        </section>}

        <section className="kit-section company-section" id="company" aria-labelledby="company-heading">
          <div className="section-number">01</div><div><p className="eyebrow">Company brief</p><div className="editor-heading"><h2 id="company-heading">Know the context.</h2><button className="small-button button-with-spinner" type="button" disabled={dirty || Boolean(regenerating)} onClick={() => void regenerate({ type: "company-brief" })}>{regenerating === "company-brief" && <InlineSpinner />}{regenerating === "company-brief" ? "Regenerating…" : "Regenerate brief"}</button></div>
            {editing ? <div className="editor-stack"><label className="editor-field"><span>Summary</span><textarea rows={4} value={draft.company_brief.summary} onChange={(event) => updateDraft((next) => { next.company_brief.summary = event.target.value; })} /></label><label className="editor-field"><span>What they do</span><textarea rows={5} value={draft.company_brief.what_they_do} onChange={(event) => updateDraft((next) => { next.company_brief.what_they_do = event.target.value; })} /></label></div> : <><p className="section-lede">{draft.company_brief.summary || "No reliable company summary was available."}</p>{draft.company_brief.what_they_do && <p>{draft.company_brief.what_they_do}</p>}</>}
          </div>
        </section>

        <section className="kit-section" id="role" aria-labelledby="role-heading">
          <div className="section-number">02</div><div><p className="eyebrow">Role map</p><h2 id="role-heading">What the role asks of you.</h2>
            {editing ? <div className="editor-collection"><div className="editor-heading"><h3>Responsibilities</h3><button className="small-button" type="button" onClick={() => updateDraft((next) => { next.role.responsibilities.push("New responsibility"); })}>Add responsibility</button></div>{draft.role.responsibilities.map((item, index) => <div className="editor-list-row" key={index}><label className="editor-field"><span className="sr-only">Responsibility {index + 1}</span><textarea rows={2} value={item} onChange={(event) => updateDraft((next) => { next.role.responsibilities[index] = event.target.value; })} /></label><button className="danger-button" type="button" onClick={() => confirmDelete(`responsibility ${index + 1}`) && updateDraft((next) => { next.role.responsibilities.splice(index, 1); })}>Delete</button></div>)}</div> : draft.role.responsibilities.length > 0 && <ul className="responsibility-list">{draft.role.responsibilities.map((item, index) => <li key={index}>{item}</li>)}</ul>}
            <div className="editor-heading"><h3 className={editing ? "" : "sr-only"}>Requirements</h3>{editing && <button className="small-button" type="button" onClick={() => updateDraft((next) => { next.role.requirements.push({ id: manualId("req"), text: "New requirement", kind: "technical", priority: "nice" }); })}>Add requirement</button>}</div>
            <div className="requirement-grid">{draft.role.requirements.map((requirement, index) => <article className={`requirement-card ${editing ? "requirement-card--editing" : ""}`} key={requirement.id}>{editing ? <><label className="editor-field"><span>Requirement</span><textarea rows={3} value={requirement.text} onChange={(event) => updateDraft((next) => { next.role.requirements[index]!.text = event.target.value; })} /></label><div className="editor-inline-grid"><label className="editor-field"><span>Priority</span><select value={requirement.priority} onChange={(event) => updateDraft((next) => { next.role.requirements[index]!.priority = event.target.value as Requirement["priority"]; })}><option value="must">Must have</option><option value="nice">Nice to have</option></select></label><label className="editor-field"><span>Kind</span><select value={requirement.kind} onChange={(event) => updateDraft((next) => { next.role.requirements[index]!.kind = event.target.value as Requirement["kind"]; })}>{requirementKinds.map((kind) => <option key={kind} value={kind}>{stageLabel(kind)}</option>)}</select></label></div><button className="danger-button" type="button" onClick={() => removeRequirement(requirement.id)}>Delete requirement</button></> : <><span className={`priority priority--${requirement.priority}`}>{requirement.priority}</span><h3>{requirement.text}</h3><p>{requirement.kind}</p></>}</article>)}</div>
            {draft.role.requirements.length === 0 && !editing && <p className="section-empty">The description did not contain reliable, extractable requirements. The rest of this kit stays intentionally light.</p>}
          </div>
        </section>

        <section className="kit-section" id="questions" aria-labelledby="questions-heading">
          <div className="section-number">03</div><div><p className="eyebrow">Interview questions</p><h2 id="questions-heading">Practise the thinking, not a script.</h2>
            {editing && <div className="editor-heading editor-heading--top"><p>Add questions to any category, then use the controls to move or reorder them.</p><button className="small-button" type="button" onClick={() => updateDraft((next) => { next.questions.push({ id: manualId("q"), requirement_ids: [], category: "technical", prompt: "New interview question", answer_outline: "", difficulty: 1 }); })}>Add question</button></div>}
            <div className="question-groups">{groupedQuestions.map(({ category, questions }) => <section key={category} className="question-group"><div className="editor-heading"><h3>{stageLabel(category)} <span>{questions.length}</span></h3><button className="small-button button-with-spinner" type="button" disabled={dirty || Boolean(regenerating)} onClick={() => void regenerate({ type: "question-category", category })}>{regenerating === category && <InlineSpinner />}{regenerating === category ? "Regenerating…" : "Regenerate category"}</button></div>{questions.length === 0 && <p className="section-empty">No questions in this category.</p>}{questions.map((question, index) => {
              const actualIndex = draft.questions.findIndex((item) => item.id === question.id);
              const pinned = pinnedQuestionIds.includes(question.id);
              return <article className={`question-card ${editing ? "question-card--editing" : ""}`} key={question.id}><div className="question-number">{String(index + 1).padStart(2, "0")}</div><div>{editing ? <div className="editor-stack"><label className="editor-field"><span>Question prompt</span><textarea rows={3} value={question.prompt} onChange={(event) => updateDraft((next) => { next.questions[actualIndex]!.prompt = event.target.value; })} /></label><label className="editor-field"><span>Answer outline</span><textarea rows={5} value={question.answer_outline} onChange={(event) => updateDraft((next) => { next.questions[actualIndex]!.answer_outline = event.target.value; })} /></label><div className="editor-inline-grid"><label className="editor-field"><span>Category</span><select value={question.category} onChange={(event) => updateDraft((next) => { next.questions[actualIndex]!.category = event.target.value as Question["category"]; })}>{categories.map((value) => <option key={value} value={value}>{stageLabel(value)}</option>)}</select></label><label className="editor-field"><span>Difficulty</span><select value={question.difficulty} onChange={(event) => updateDraft((next) => { next.questions[actualIndex]!.difficulty = Number(event.target.value) as Question["difficulty"]; })}><option value={1}>1 · Foundation</option><option value={2}>2 · Applied</option><option value={3}>3 · Deep dive</option></select></label></div><ReferenceChecks legend="Linked requirements" options={requirementOptions} selected={question.requirement_ids} onChange={(ids) => updateDraft((next) => { next.questions[actualIndex]!.requirement_ids = ids; })} /><div className="item-actions"><button className="small-button" type="button" aria-pressed={pinned} onClick={() => setPinnedQuestionIds((ids) => pinned ? ids.filter((id) => id !== question.id) : [...ids, question.id])}>{pinned ? "Pinned" : "Pin"}</button><button className="small-button" type="button" disabled={index === 0} onClick={() => moveQuestion(question.id, -1)} aria-label={`Move ${question.prompt} earlier in ${stageLabel(category)}`}>Move up</button><button className="small-button" type="button" disabled={index === questions.length - 1} onClick={() => moveQuestion(question.id, 1)} aria-label={`Move ${question.prompt} later in ${stageLabel(category)}`}>Move down</button><button className="danger-button" type="button" onClick={() => removeQuestion(question.id)}>Delete question</button></div></div> : <><div className="tag-row">{pinned && <span>Pinned</span>}</div><h4>{question.prompt}</h4><p className="answer-outline">{question.answer_outline || "Build your answer from the linked role requirements."}</p><div className="tag-row"><span>Difficulty {question.difficulty}</span>{question.requirement_ids.map((id) => <span key={id}>{requirementById.get(id)?.text ?? id}</span>)}</div></>}</div></article>;
            })}</section>)}</div>
            {draft.questions.length === 0 && !editing && <p className="section-empty">No reliable questions could be generated from this input.</p>}
          </div>
        </section>

        <section className="kit-section" id="flashcards" aria-labelledby="flashcards-heading">
          <div className="section-number">04</div><div><p className="eyebrow">Flashcards</p><h2 id="flashcards-heading">Fast recall, full context.</h2>
            {editing && <div className="editor-heading editor-heading--top"><p>Cards can link to any current requirement.</p><button className="small-button" type="button" onClick={() => updateDraft((next) => { next.flashcards.push({ id: manualId("card"), front: "New flashcard prompt", back: "", requirement_ids: [] }); })}>Add flashcard</button></div>}
            <div className="flashcard-grid">{draft.flashcards.map((card, index) => <article className={`flashcard ${editing ? "flashcard--editing" : ""}`} key={card.id}>{editing ? <div className="editor-stack"><label className="editor-field"><span>Front</span><textarea rows={3} value={card.front} onChange={(event) => updateDraft((next) => { next.flashcards[index]!.front = event.target.value; })} /></label><label className="editor-field"><span>Back</span><textarea rows={5} value={card.back} onChange={(event) => updateDraft((next) => { next.flashcards[index]!.back = event.target.value; })} /></label><ReferenceChecks legend="Linked requirements" options={requirementOptions} selected={card.requirement_ids} onChange={(ids) => updateDraft((next) => { next.flashcards[index]!.requirement_ids = ids; })} /><button className="danger-button" type="button" onClick={() => confirmDelete(`flashcard “${card.front}”`) && updateDraft((next) => { next.flashcards.splice(index, 1); })}>Delete flashcard</button></div> : <><p className="flashcard__label">Prompt</p><h3>{card.front}</h3><div className="flashcard__answer"><p className="flashcard__label">Answer</p><p>{card.back || "No answer supplied."}</p></div></>}</article>)}</div>{draft.flashcards.length === 0 && !editing && <p className="section-empty">This kit has no flashcards yet.</p>}
          </div>
        </section>

        <section className="kit-section" id="schedule" aria-labelledby="schedule-heading">
          <div className="section-number">05</div><div><p className="eyebrow">Study schedule</p><div className="editor-heading"><h2 id="schedule-heading">A plan for every available day.</h2><button className="small-button button-with-spinner" type="button" disabled={dirty || Boolean(regenerating) || Boolean(derivedState?.uncovered_must_requirement_ids.length)} onClick={() => void regenerate({ type: "schedule" })}>{regenerating === "schedule" && <InlineSpinner />}{regenerating === "schedule" ? "Regenerating…" : derivedState?.schedule_needs_regeneration ? "Repair schedule" : "Regenerate schedule"}</button></div><ol className="schedule-list">{draft.schedule.days.map((day, index) => <li className={editing ? "schedule-day--editing" : ""} key={day.day}><div className="day-marker"><span>Day</span><strong>{day.day}</strong></div><div>{editing ? <div className="editor-stack"><label className="editor-field"><span>Focus</span><input value={day.focus} onChange={(event) => updateDraft((next) => { next.schedule.days[index]!.focus = event.target.value; })} /></label><ReferenceChecks legend="Assigned questions" options={questionOptions} selected={day.question_ids} onChange={(ids) => updateDraft((next) => { next.schedule.days[index]!.question_ids = ids; })} /></div> : <><h3>{day.focus || "Review and consolidate"}</h3><p>{day.question_ids.length > 0 ? day.question_ids.map((id) => questionById.get(id)?.prompt ?? id).join(" · ") : "No new material scheduled; use this day to review."}</p></>}</div>{editing ? <label className="editor-field editor-field--minutes"><span>Minutes</span><input type="number" inputMode="numeric" min="0" step="1" value={day.minutes} onChange={(event) => updateDraft((next) => { next.schedule.days[index]!.minutes = Math.max(0, Number.parseInt(event.target.value || "0", 10)); })} /></label> : <span className="minutes">{day.minutes} min</span>}</li>)}</ol></div>
        </section>

        <section className="kit-section" id="evidence" aria-labelledby="evidence-heading">
          <div className="section-number">06</div><div><p className="eyebrow">Sources & coverage</p><h2 id="evidence-heading">What supports this kit.</h2><div className="evidence-grid"><div><span>Coverage passes</span><strong>{draft.coverage.passes}</strong></div><div><span>{dirty ? "Preview gaps" : "Saved gaps"}</span><strong>{derivedState?.uncovered_requirement_ids.length ?? 0}</strong></div><div><span>Last updated</span><strong>{kit ? formatDate(kit.updatedAt) : "—"}</strong></div></div>
            {editing && <p className="editor-note">Coverage and schedule health update locally as you edit, then the server verifies them when you save. Source URLs and generation evidence remain read-only.</p>}
            <ul className="source-list"><li><a href={draft.source.company_url} target="_blank" rel="noreferrer">Original company URL</a></li>{[...new Set([...draft.source.pages_used, ...draft.company_brief.sources])].map((source) => <li key={source}><a href={source} target="_blank" rel="noreferrer">{source}</a></li>)}</ul>
            {draft.source.pages_used.length === 0 && draft.company_brief.sources.length === 0 && <p className="section-empty">No public pages were used. This kit is based on the supplied job description.</p>}
          </div>
        </section>
      </main>
    </div>
  );
}
