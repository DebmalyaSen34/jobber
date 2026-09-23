import { z } from "zod";
import { checkCoverage } from "../coverage/check-coverage.js";
import type { Kit, Question, Requirement, ScheduleDay } from "../schemas/kit.js";

export function allocateSchedule(
  requirements: readonly Requirement[],
  questions: readonly Question[],
  daysAvailable: number,
): Kit["schedule"] {
  z.number().int().positive().parse(daysAvailable);
  const coverage = checkCoverage(requirements, questions);
  if (coverage.uncovered_must_requirement_ids.length) {
    throw new Error("Cannot allocate a complete schedule with uncovered must-have requirements.");
  }
  const must = new Set(requirements.filter((r) => r.priority === "must").map((r) => r.id));
  const contribution = (q: Question) => new Set(q.requirement_ids.filter((id) => must.has(id))).size;
  const ordered = [...questions].sort((a, b) =>
    contribution(b) - contribution(a) || b.difficulty - a.difficulty ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const days: ScheduleDay[] = Array.from({ length: daysAvailable }, (_, index) => ({
    day: index + 1, focus: "Clarify role expectations; no question material available",
    question_ids: [], minutes: 0,
  }));
  if (!ordered.length) return { days_available: daysAvailable, days };

  // First exposure occupies at most the first 60% of days (and at most Q days).
  // Cumulative minutes keep the priority order while roughly balancing new work.
  const learningDays = Math.min(ordered.length, Math.ceil(daysAvailable * 0.6));
  const totalMinutes = ordered.reduce((sum, q) => sum + q.difficulty * 10, 0);
  let elapsed = 0;
  for (const question of ordered) {
    const index = Math.min(learningDays - 1, Math.floor(elapsed * learningDays / totalMinutes));
    days[index]!.question_ids.push(question.id);
    elapsed += question.difficulty * 10;
  }

  const byId = new Map(ordered.map((q) => [q.id, q]));
  const lastStudied = new Map<string, number>();
  for (const day of days) {
    const review = day.question_ids.length === 0;
    if (review) {
      // Review only previously introduced questions. Oldest review wins;
      // priority order above provides stable tie-breaking.
      const candidates = ordered.filter((q) => lastStudied.has(q.id));
      candidates.sort((a, b) => lastStudied.get(a.id)! - lastStudied.get(b.id)!);
      if (candidates[0]) day.question_ids.push(candidates[0].id);
    }
    const assigned = day.question_ids.map((id) => byId.get(id)!);
    day.minutes = assigned.reduce((sum, q) => sum + q.difficulty * 10, 0);
    day.focus = `${review ? "Review" : "Study"}: ${[...new Set(assigned.map((q) => q.category))].join(", ")}`;
    for (const id of day.question_ids) lastStudied.set(id, day.day);
  }
  return { days_available: daysAvailable, days };
}
