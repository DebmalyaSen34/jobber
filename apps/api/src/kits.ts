import type { Kit } from "@jobber/core";
import type { JobInput } from "./jobs.js";

export type OwnedKit = {
  id: string;
  ownerId: string;
  sourceJobId: string;
  originalInput: JobInput;
  content: Kit;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
};

export interface KitStore {
  listOwnedKits(ownerId: string): Promise<OwnedKit[]>;
  findOwnedKit(ownerId: string, kitId: string): Promise<OwnedKit | null>;
}

function kitSummary(kit: OwnedKit) {
  return {
    id: kit.id,
    sourceJobId: kit.sourceJobId,
    role: kit.content.role.title,
    company: kit.content.source.company,
    days: kit.content.schedule.days_available,
    warningCount: Array.isArray(kit.content.warnings) ? kit.content.warnings.length : 0,
    revision: kit.revision,
    createdAt: kit.createdAt.toISOString(),
    updatedAt: kit.updatedAt.toISOString(),
  };
}

export function publicKitSummary(kit: OwnedKit) {
  return kitSummary(kit);
}

export function publicKit(kit: OwnedKit) {
  const content = kit.content;
  return {
    ...kitSummary(kit),
    originalInput: {
      jd: kit.originalInput.jd,
      companyUrl: kit.originalInput.companyUrl,
      days: kit.originalInput.days,
    },
    content: {
      source: content.source,
      company_brief: content.company_brief,
      role: content.role,
      questions: content.questions,
      flashcards: content.flashcards,
      schedule: content.schedule,
      coverage: content.coverage,
      warnings: Array.isArray(content.warnings) ? content.warnings : [],
    },
  };
}
