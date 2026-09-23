import { z } from "zod";
import { questionSchema, requirementSchema, type Question, type Requirement } from "../schemas/kit.js";

export function assertUniqueIds(items: ReadonlyArray<{ id: string }>, label: string): void {
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) throw new Error(`Duplicate ${label} ID: ${item.id}`);
    ids.add(item.id);
  }
}

/** Checks declared ID coverage, not the semantic relevance of model-written text. */
export function checkCoverage(requirements: readonly Requirement[], questions: readonly Question[]) {
  z.array(requirementSchema).parse(requirements);
  z.array(questionSchema).parse(questions);
  assertUniqueIds(requirements, "requirement");
  assertUniqueIds(questions, "question");
  const known = new Set(requirements.map((requirement) => requirement.id));
  const covered = new Set<string>();
  for (const question of questions) {
    for (const id of question.requirement_ids) {
      if (!known.has(id)) throw new Error(`Unknown requirement ID: ${id}`);
      covered.add(id);
    }
  }
  return {
    covered_requirement_ids: requirements.filter((r) => covered.has(r.id)).map((r) => r.id),
    uncovered_requirement_ids: requirements.filter((r) => !covered.has(r.id)).map((r) => r.id),
    uncovered_must_requirement_ids: requirements.filter((r) => r.priority === "must" && !covered.has(r.id)).map((r) => r.id),
  };
}
