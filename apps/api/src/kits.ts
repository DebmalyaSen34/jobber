import { checkCoverage, kitSchema, validateKit, type Kit } from "@jobber/core";
import { z } from "zod";
import type { JobInput } from "./jobs.js";

export type OwnedKit = {
  id: string;
  ownerId: string;
  sourceJobId: string;
  originalInput: JobInput;
  content: Kit;
  metadata: KitContentMetadata;
  tombstones: ContentTombstone[];
  revision: number;
  createdAt: Date;
  updatedAt: Date;
};

export type ContentMetadata = {
  origin: "generated" | "manual";
  userEdited: boolean;
  pinned: boolean;
  revision: number;
  generationRunId: string | null;
};

export type KitContentMetadata = {
  companyBrief: ContentMetadata;
  schedule: ContentMetadata;
  requirements: Record<string, ContentMetadata>;
  questions: Record<string, ContentMetadata>;
  flashcards: Record<string, ContentMetadata>;
};

export type ContentTombstone = {
  kind: "requirement" | "question" | "flashcard";
  id: string;
  revision: number;
  deletedAt: Date;
};

function generatedMetadata(revision: number, generationRunId: string | null): ContentMetadata {
  return { origin: "generated", userEdited: false, pinned: false, revision, generationRunId };
}

export function initialKitMetadata(content: Kit, generationRunId: string | null, revision = 1): KitContentMetadata {
  const entries = <T extends { id: string }>(items: readonly T[]) => Object.fromEntries(
    items.map(({ id }) => [id, generatedMetadata(revision, generationRunId)]),
  );
  return {
    companyBrief: generatedMetadata(revision, generationRunId),
    schedule: generatedMetadata(revision, generationRunId),
    requirements: entries(content.role.requirements),
    questions: entries(content.questions),
    flashcards: entries(content.flashcards),
  };
}

export function normalizeKitMetadata(
  content: Kit,
  metadata: KitContentMetadata | undefined,
  generationRunId: string | null,
  revision: number,
): KitContentMetadata {
  const initial = initialKitMetadata(content, generationRunId, revision);
  const legacyEdited = !metadata && revision > 1;
  const legacy = (value: ContentMetadata, id?: string): ContentMetadata => legacyEdited ? {
    ...value,
    origin: id?.includes("-manual-") ? "manual" : value.origin,
    userEdited: true,
  } : value;
  return {
    companyBrief: metadata?.companyBrief ?? legacy(initial.companyBrief),
    schedule: metadata?.schedule ?? legacy(initial.schedule),
    requirements: Object.fromEntries(content.role.requirements.map(({ id }) => [id, metadata?.requirements[id] ?? legacy(initial.requirements[id]!, id)])),
    questions: Object.fromEntries(content.questions.map(({ id }) => [id, metadata?.questions[id] ?? legacy(initial.questions[id]!, id)])),
    flashcards: Object.fromEntries(content.flashcards.map(({ id }) => [id, metadata?.flashcards[id] ?? legacy(initial.flashcards[id]!, id)])),
  };
}

export interface KitStore {
  listOwnedKits(ownerId: string): Promise<OwnedKit[]>;
  findOwnedKit(ownerId: string, kitId: string): Promise<OwnedKit | null>;
  updateOwnedKit(input: {
    ownerId: string;
    kitId: string;
    expectedRevision: number;
    content: Kit;
    metadata: KitContentMetadata;
    tombstones: ContentTombstone[];
    now: Date;
  }): Promise<{ kind: "updated"; kit: OwnedKit } | { kind: "not_found" } | { kind: "conflict"; revision: number }>;
}

const updateKitSchema = z.strictObject({
  revision: z.number().int().positive(),
  content: kitSchema,
  pinned_question_ids: z.array(z.string().min(1)).optional(),
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

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function editedMetadata(
  previous: ContentMetadata | undefined,
  changed: boolean,
  revision: number,
  pinned = previous?.pinned ?? false,
): ContentMetadata {
  if (!previous) return { origin: "manual", userEdited: true, pinned, revision, generationRunId: null };
  if (!changed && pinned === previous.pinned) return previous;
  return { ...previous, userEdited: previous.userEdited || changed, pinned, revision };
}

function deriveEditEnvelope(
  current: OwnedKit,
  content: Kit,
  pinnedQuestionIds: readonly string[] | undefined,
  now: Date,
): { metadata: KitContentMetadata; tombstones: ContentTombstone[] } {
  const nextRevision = current.revision + 1;
  const previous = normalizeKitMetadata(current.content, current.metadata, current.sourceJobId, current.revision);
  const currentRequirements = new Map(current.content.role.requirements.map((item) => [item.id, item]));
  const currentQuestions = new Map(current.content.questions.map((item) => [item.id, item]));
  const currentCards = new Map(current.content.flashcards.map((item) => [item.id, item]));
  const reordered = <T extends { id: string }>(before: readonly T[], after: readonly T[]) => new Set(
    after.filter((item, index) => before[index]?.id !== item.id).map(({ id }) => id),
  );
  const pinned = new Set(pinnedQuestionIds ?? current.content.questions.filter(({ id }) => previous.questions[id]?.pinned).map(({ id }) => id));
  const mapItems = <T extends { id: string }>(
    items: readonly T[],
    before: ReadonlyMap<string, T>,
    metadata: Record<string, ContentMetadata>,
    reorderedIds: ReadonlySet<string>,
    pinIds?: ReadonlySet<string>,
  ) => Object.fromEntries(items.map((item) => [item.id, editedMetadata(
    metadata[item.id],
    !before.has(item.id) || !same(before.get(item.id), item) || reorderedIds.has(item.id),
    nextRevision,
    pinIds ? pinIds.has(item.id) : undefined,
  )]));
  const deleted = <T extends { id: string }>(kind: ContentTombstone["kind"], before: readonly T[], after: readonly T[]) => {
    const ids = new Set(after.map(({ id }) => id));
    return before.filter(({ id }) => !ids.has(id)).map(({ id }) => ({ kind, id, revision: nextRevision, deletedAt: now }));
  };
  const newTombstones = [
    ...deleted("requirement", current.content.role.requirements, content.role.requirements),
    ...deleted("question", current.content.questions, content.questions),
    ...deleted("flashcard", current.content.flashcards, content.flashcards),
  ];
  const tombstoneKey = ({ kind, id }: ContentTombstone) => `${kind}:${id}`;
  const tombstones = new Map((current.tombstones ?? []).map((item) => [tombstoneKey(item), item]));
  for (const item of newTombstones) tombstones.set(tombstoneKey(item), item);
  return {
    metadata: {
      companyBrief: editedMetadata(previous.companyBrief, !same(current.content.company_brief, content.company_brief), nextRevision),
      schedule: editedMetadata(previous.schedule, !same(current.content.schedule, content.schedule), nextRevision),
      requirements: mapItems(content.role.requirements, currentRequirements, previous.requirements, reordered(current.content.role.requirements, content.role.requirements)),
      questions: mapItems(content.questions, currentQuestions, previous.questions, reordered(current.content.questions, content.questions), pinned),
      flashcards: mapItems(content.flashcards, currentCards, previous.flashcards, reordered(current.content.flashcards, content.flashcards)),
    },
    tombstones: [...tombstones.values()],
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

    const envelope = deriveEditEnvelope(current, validation.data, parsed.data.pinned_question_ids, now);

    const result = await this.store.updateOwnedKit({
      ownerId,
      kitId,
      expectedRevision: parsed.data.revision,
      content: validation.data,
      metadata: envelope.metadata,
      tombstones: envelope.tombstones,
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
    metadata: normalizeKitMetadata(content, kit.metadata, kit.sourceJobId, kit.revision),
  };
}
