import type { Kit } from "../schemas/kit.js";
import { checkCoverage } from "./check-coverage.js";

export type KitDerivedState = {
  covered_requirement_ids: string[];
  uncovered_requirement_ids: string[];
  uncovered_must_requirement_ids: string[];
  scheduled_question_ids: string[];
  unscheduled_question_ids: string[];
  covered_but_unscheduled_must_requirement_ids: string[];
  schedule_needs_regeneration: boolean;
  schedule_reasons: Array<"UNSCHEDULED_QUESTIONS" | "UNSCHEDULED_MUST_REQUIREMENTS">;
};

/** Deterministic, display-ready coverage and schedule health from current saved content. */
export function deriveKitState(
  kit: Pick<Kit, "role" | "questions" | "schedule">,
): KitDerivedState {
  const coverage = checkCoverage(kit.role.requirements, kit.questions);
  const knownQuestionIds = new Set(kit.questions.map(({ id }) => id));
  const scheduledQuestionIds = [...new Set(kit.schedule.days.flatMap(({ question_ids }) => question_ids))]
    .filter((id) => knownQuestionIds.has(id));
  const scheduled = new Set(scheduledQuestionIds);
  const scheduledQuestions = kit.questions.filter(({ id }) => scheduled.has(id));
  const scheduledCoverage = checkCoverage(kit.role.requirements, scheduledQuestions);
  const globallyUncoveredMust = new Set(coverage.uncovered_must_requirement_ids);
  const coveredButUnscheduledMust = scheduledCoverage.uncovered_must_requirement_ids
    .filter((id) => !globallyUncoveredMust.has(id));
  const unscheduledQuestionIds = kit.questions.filter(({ id }) => !scheduled.has(id)).map(({ id }) => id);
  const scheduleReasons: KitDerivedState["schedule_reasons"] = [];
  if (unscheduledQuestionIds.length > 0) scheduleReasons.push("UNSCHEDULED_QUESTIONS");
  if (coveredButUnscheduledMust.length > 0) scheduleReasons.push("UNSCHEDULED_MUST_REQUIREMENTS");
  return {
    covered_requirement_ids: coverage.covered_requirement_ids,
    uncovered_requirement_ids: coverage.uncovered_requirement_ids,
    uncovered_must_requirement_ids: coverage.uncovered_must_requirement_ids,
    scheduled_question_ids: scheduledQuestionIds,
    unscheduled_question_ids: unscheduledQuestionIds,
    covered_but_unscheduled_must_requirement_ids: coveredButUnscheduledMust,
    schedule_needs_regeneration: scheduleReasons.length > 0,
    schedule_reasons: scheduleReasons,
  };
}
