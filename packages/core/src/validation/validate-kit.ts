import { checkCoverage } from "../coverage/check-coverage.js";
import { kitSchema, type Kit } from "../schemas/kit.js";

export type KitIssue = { code: string; path: string; message: string };
export type KitValidation =
  | { success: true; data: Kit; warnings: KitIssue[] }
  | { success: false; errors: KitIssue[]; warnings: KitIssue[] };

/** Drafts may lack coverage, but still require honest coverage and valid links. */
export function validateKit(
  input: unknown,
  options: { requestedDays: number; mode?: "generated" | "draft" },
): KitValidation {
  const parsed = kitSchema.safeParse(input);
  if (!parsed.success) return {
    success: false, warnings: [], errors: parsed.error.issues.map((issue) => ({
      code: "INVALID_STRUCTURE", path: issue.path.join("."), message: issue.message,
    })),
  };
  const kit = parsed.data;
  const errors: KitIssue[] = [];
  const warnings: KitIssue[] = [];
  const issue = (code: string, path: string, message: string, incomplete = false) => {
    (incomplete && options.mode === "draft" ? warnings : errors).push({ code, path, message });
  };
  const unique = (ids: string[], path: string) => {
    if (new Set(ids).size !== ids.length) issue("DUPLICATE_ID", path, "IDs must be unique within this collection.");
  };
  unique(kit.role.requirements.map((r) => r.id), "role.requirements");
  unique(kit.questions.map((q) => q.id), "questions");
  unique(kit.flashcards.map((f) => f.id), "flashcards");
  const requirements = new Set(kit.role.requirements.map((r) => r.id));
  const questionIds = new Set(kit.questions.map((q) => q.id));
  const references = (ids: string[], known: Set<string>, path: string) => {
    unique(ids, path);
    if (ids.some((id) => !known.has(id))) issue("UNKNOWN_REFERENCE", path, "Referenced ID does not exist.");
  };
  kit.questions.forEach((q, i) => references(q.requirement_ids, requirements, `questions.${i}.requirement_ids`));
  kit.flashcards.forEach((f, i) => references(f.requirement_ids, requirements, `flashcards.${i}.requirement_ids`));
  references(kit.coverage.uncovered_requirement_ids, requirements, "coverage.uncovered_requirement_ids");
  const requested = options.requestedDays;
  if (!Number.isSafeInteger(requested) || requested < 1 ||
      kit.schedule.days_available !== requested || kit.schedule.days.length !== requested) {
    issue("DAY_COUNT_MISMATCH", "schedule", "Schedule must span exactly the requested positive integer number of days.");
  }
  kit.schedule.days.forEach((day, index) => {
    if (day.day !== index + 1) issue("INVALID_DAY_SEQUENCE", `schedule.days.${index}.day`, "Days must be consecutive starting at 1.");
    references(day.question_ids, questionIds, `schedule.days.${index}.question_ids`);
  });
  // Duplicate/unknown IDs must not be normalized into apparently valid coverage.
  if (!errors.some((entry) => ["DUPLICATE_ID", "UNKNOWN_REFERENCE"].includes(entry.code))) {
    const coverage = checkCoverage(kit.role.requirements, kit.questions);
    const actualGaps = new Set(coverage.uncovered_requirement_ids);
    if (actualGaps.size !== kit.coverage.uncovered_requirement_ids.length ||
        kit.coverage.uncovered_requirement_ids.some((id) => !actualGaps.has(id))) {
      issue("STALE_COVERAGE", "coverage.uncovered_requirement_ids", "Stored coverage does not match the questions.");
    }
    if (coverage.uncovered_must_requirement_ids.length) {
      issue("UNCOVERED_MUST", "coverage", "Must-have requirements have no questions.", true);
    }
    const scheduled = new Set(kit.schedule.days.flatMap((day) => day.question_ids));
    const scheduledQuestions = kit.questions.filter((q) => scheduled.has(q.id));
    if (checkCoverage(kit.role.requirements, scheduledQuestions).uncovered_must_requirement_ids.length) {
      issue("UNSCHEDULED_MUST", "schedule", "Must-have requirements are absent from the schedule.", true);
    }
    if (kit.questions.some((q) => !scheduled.has(q.id))) {
      issue("UNSCHEDULED_QUESTION", "schedule", "Every generated question must be scheduled at least once.", true);
    }
  }
  return errors.length ? { success: false, errors, warnings } : { success: true, data: kit, warnings };
}
