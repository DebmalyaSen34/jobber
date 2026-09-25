import { checkCoverage, kitSchema, validateKit, type Kit } from "@jobber/core";
import { z } from "zod";
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
  updateOwnedKit(input: {
    ownerId: string;
    kitId: string;
    expectedRevision: number;
    content: Kit;
    now: Date;
  }): Promise<{ kind: "updated"; kit: OwnedKit } | { kind: "not_found" } | { kind: "conflict"; revision: number }>;
}

const updateKitSchema = z.strictObject({
  revision: z.number().int().positive(),
  content: kitSchema,
});

export class KitEditError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly options: { fields?: Record<string, string>; revision?: number } = {},
  ) {
    super(message);
    this.name = "KitEditError";
  }
}

function fieldsFromIssues(issues: Array<{ path: PropertyKey[]; message: string }>): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of issues) {
    const path = issue.path.map(String).join(".") || "content";
    if (!(path in fields)) fields[path] = issue.message;
  }
  return fields;
}

/** Preserve provenance/extensions while accepting only the public editable kit shape. */
function mergeEditableContent(current: Kit, edited: Kit): Kit {
  const coverage = checkCoverage(edited.role.requirements, edited.questions);
  return {
    ...current,
    source: {
      ...current.source,
      company: edited.source.company,
      role: edited.source.role,
      location: edited.source.location,
    },
    company_brief: {
      ...current.company_brief,
      summary: edited.company_brief.summary,
      what_they_do: edited.company_brief.what_they_do,
    },
    role: edited.role,
    questions: edited.questions,
    flashcards: edited.flashcards,
    schedule: edited.schedule,
    coverage: {
      ...current.coverage,
      uncovered_requirement_ids: coverage.uncovered_requirement_ids,
    },
  };
}

export class KitService {
  constructor(private readonly store: KitStore) {}

  async update(ownerId: string, kitId: string, body: unknown, now = new Date()): Promise<OwnedKit> {
    const parsed = updateKitSchema.safeParse(body);
    if (!parsed.success) {
      throw new KitEditError("INVALID_KIT_EDIT", 400, "Please correct the invalid kit fields.", {
        fields: fieldsFromIssues(parsed.error.issues),
      });
    }

    const current = await this.store.findOwnedKit(ownerId, kitId);
    if (!current) throw new KitEditError("NOT_FOUND", 404, "Kit not found.");
    let content: Kit;
    try {
      content = mergeEditableContent(current.content, parsed.data.content);
    } catch {
      throw new KitEditError("INVALID_KIT_EDIT", 400, "Questions must reference unique, existing requirements.", {
        fields: { "content.questions": "Remove duplicate or unknown requirement links." },
      });
    }
    const validation = validateKit(content, { requestedDays: current.originalInput.days, mode: "draft" });
    if (!validation.success) {
      throw new KitEditError("INVALID_KIT_EDIT", 400, "Some edits would leave invalid references or structure.", {
        fields: Object.fromEntries(validation.errors.map((issue) => [issue.path, issue.message])),
      });
    }

    const result = await this.store.updateOwnedKit({
      ownerId,
      kitId,
      expectedRevision: parsed.data.revision,
      content: validation.data,
      now,
    });
    if (result.kind === "not_found") throw new KitEditError("NOT_FOUND", 404, "Kit not found.");
    if (result.kind === "conflict") {
      throw new KitEditError(
        "KIT_REVISION_CONFLICT",
        409,
        "This kit changed in another session. Your local edits were kept; reload the latest revision before saving again.",
        { revision: result.revision },
      );
    }
    return result.kit;
  }
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
