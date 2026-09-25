"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  readApiError,
  type Flashcard,
  type PracticeConfidence,
  type PracticeSnapshot,
} from "@/lib/api-types";
import { InlineSpinner } from "./loading-state";

type Props = {
  kitId: string;
  kitRevision: number;
  csrfToken: string;
  flashcards: Flashcard[];
  disabled: boolean;
};

const confidenceOptions: Array<{ value: PracticeConfidence; label: string; detail: string }> = [
  { value: "again", label: "Again", detail: "I need to relearn this" },
  { value: "unsure", label: "Unsure", detail: "I partly remembered it" },
  { value: "confident", label: "Confident", detail: "I recalled it clearly" },
];

export function PracticeSession({ kitId, kitRevision, csrfToken, flashcards, disabled }: Props) {
  const [snapshot, setSnapshot] = useState<PracticeSnapshot | null>(null);
  const [queue, setQueue] = useState<string[]>([]);
  const [position, setPosition] = useState(0);
  const [active, setActive] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [saving, setSaving] = useState<PracticeConfidence | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const revealButton = useRef<HTMLButtonElement>(null);
  const firstConfidenceButton = useRef<HTMLButtonElement>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch(`/api/v1/kits/${encodeURIComponent(kitId)}/practice`, {
        credentials: "include",
        signal,
      });
      if (!response.ok) throw new Error((await readApiError(response, "Practice progress could not be loaded."))?.message);
      const body = await response.json() as { practice: PracticeSnapshot };
      setSnapshot(body.practice);
      setError(null);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setError(caught instanceof Error && caught.message ? caught.message : "Practice progress could not be loaded.");
    }
  }, [kitId]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(controller.signal), 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [kitRevision, load]);

  useEffect(() => {
    if (!active || disabled) return;
    const timer = window.setTimeout(() => {
      (revealed ? firstConfidenceButton : revealButton).current?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [active, disabled, position, revealed]);

  const cardsById = useMemo(() => new Map(flashcards.map((card) => [card.id, card])), [flashcards]);
  const progressById = useMemo(() => new Map(snapshot?.progress.map((item) => [item.cardId, item]) ?? []), [snapshot]);
  const currentId = queue[position];
  const current = currentId ? cardsById.get(currentId) : undefined;
  const currentProgress = currentId ? progressById.get(currentId) : undefined;

  function startSession() {
    if (!snapshot || disabled || snapshot.orderedCardIds.length === 0) return;
    setQueue(snapshot.orderedCardIds.filter((id) => cardsById.has(id)));
    setPosition(0);
    setRevealed(false);
    setCompleted(false);
    setMessage("Session started. Reveal the answer before recording confidence.");
    setError(null);
    setActive(true);
  }

  function advance(detail: string) {
    if (position + 1 >= queue.length) {
      setActive(false);
      setCompleted(true);
      setRevealed(false);
      setMessage(`${detail} Session complete.`);
      return;
    }
    setPosition((value) => value + 1);
    setRevealed(false);
    setMessage(detail);
  }

  async function record(confidence: PracticeConfidence) {
    if (!current || !revealed || saving) return;
    setSaving(confidence);
    setError(null);
    try {
      const response = await fetch(`/api/v1/kits/${encodeURIComponent(kitId)}/practice/reviews`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ review_id: crypto.randomUUID(), card_id: current.id, confidence }),
      });
      if (!response.ok) throw new Error((await readApiError(response, "Your confidence could not be saved."))?.message);
      const body = await response.json() as { practice: PracticeSnapshot };
      setSnapshot(body.practice);
      advance(`${confidenceOptions.find(({ value }) => value === confidence)!.label} saved.`);
    } catch (caught) {
      setError(caught instanceof Error && caught.message ? caught.message : "Your confidence could not be saved. Try again.");
    } finally {
      setSaving(null);
    }
  }

  return (
    <section className="kit-section practice-section" id="practice" aria-labelledby="practice-heading">
      <div className="section-number">05</div>
      <div>
        <p className="eyebrow">Active recall</p>
        <div className="editor-heading">
          <h2 id="practice-heading">Practice one card at a time.</h2>
          {!active && snapshot && snapshot.counts.total > 0 && (
            <button className="primary-button" type="button" onClick={startSession} disabled={disabled}>
              {completed ? "Start next session" : snapshot.counts.reviewed > 0 ? "Continue practice" : "Start practice"}
            </button>
          )}
        </div>
        <p className="practice-intro">Reveal the answer, then record how well you recalled it. Confidence is saved immediately and kept separate from requirement coverage.</p>

        {error && <div className="dashboard-state dashboard-state--error" role="alert"><span>{error}</span>{!active && <button className="secondary-button" type="button" onClick={() => void load()}>Retry</button>}</div>}
        {!snapshot && !error && <div className="practice-loading" role="status"><InlineSpinner /> Loading practice progress…</div>}
        {snapshot && <div className="practice-counts" aria-label="Practice progress">
          <div><span>Unseen</span><strong>{snapshot.counts.unseen}</strong></div>
          <div><span>Reviewed</span><strong>{snapshot.counts.reviewed}</strong></div>
          <div><span>Total cards</span><strong>{snapshot.counts.total}</strong></div>
        </div>}

        {disabled && <p className="editor-note" role="status">Finish editing this kit before starting practice so every answer matches the saved card.</p>}
        {snapshot?.counts.total === 0 && <p className="section-empty">Add and save at least one flashcard to begin a practice session.</p>}
        {completed && !active && <div className="practice-complete" role="status"><strong>Session complete.</strong><span>Your saved confidence will shape the next session: Again, unseen, Unsure, then Confident.</span></div>}

        {active && !disabled && current && <div className="practice-player" aria-live="polite">
          <div className="practice-progress">
            <span>Card {position + 1} of {queue.length}</span>
            <progress value={position + 1} max={queue.length}>{position + 1} of {queue.length}</progress>
            <span>{currentProgress?.reviewCount ?? 0} previous {(currentProgress?.reviewCount ?? 0) === 1 ? "review" : "reviews"}</span>
          </div>
          <article className="practice-card">
            <p className="flashcard__label">Prompt</p>
            <h3>{current.front}</h3>
            {!revealed ? (
              <div className="practice-reveal-actions">
                <button ref={revealButton} className="primary-button" type="button" onClick={() => { setRevealed(true); setMessage("Answer revealed. Choose your confidence."); }}>Reveal answer</button>
                <button className="text-link" type="button" onClick={() => advance("Card skipped without recording a review.")}>Skip for now</button>
              </div>
            ) : (
              <div className="practice-answer">
                <p className="flashcard__label">Answer</p>
                <p>{current.back || "No answer supplied."}</p>
                <fieldset className="confidence-controls" disabled={Boolean(saving)}>
                  <legend>How well did you recall it?</legend>
                  {confidenceOptions.map((option, index) => <button
                    key={option.value}
                    ref={index === 0 ? firstConfidenceButton : undefined}
                    className={`confidence-button confidence-button--${option.value}`}
                    type="button"
                    onClick={() => void record(option.value)}
                  >
                    {saving === option.value && <InlineSpinner />}
                    <strong>{saving === option.value ? "Saving…" : option.label}</strong>
                    <span>{option.detail}</span>
                  </button>)}
                </fieldset>
              </div>
            )}
          </article>
          <div className="practice-session-footer">
            <span role="status">{message}</span>
            <button className="text-link" type="button" disabled={Boolean(saving)} onClick={() => { setActive(false); setRevealed(false); setMessage("Session paused. Unrated cards were not marked reviewed."); }}>Pause session</button>
          </div>
        </div>}
        {!active && !completed && message && <p className="practice-message" role="status">{message}</p>}
      </div>
    </section>
  );
}
