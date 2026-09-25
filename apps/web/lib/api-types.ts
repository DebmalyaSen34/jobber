export type Session = {
  email: string;
  csrfToken: string;
  expiresAt: string;
};

export type ApiError = {
  error?: {
    code?: string;
    message?: string;
    fields?: Record<string, string>;
    details?: { existingJobId?: string; revision?: number };
  };
};

export type PublicJob = {
  id: string;
  kitId: string;
  status: "queued" | "running" | "retry_wait" | "completed" | "completed_with_warnings" | "failed";
  stage: string;
  progress: Array<{ stage: string; at: string; detail?: string }>;
  warnings: Array<{ code: string; message: string; url?: string }>;
  source: { companyUrl: string; days: number; jdChars: number };
  retry: { attempt: number; maxAttempts: number; nextAttemptAt?: string };
  error?: { code: string; message: string; retryable: boolean };
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
};

export type KitSummary = {
  id: string;
  sourceJobId: string;
  role: string;
  company: string;
  days: number;
  warningCount: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type Requirement = { id: string; text: string; kind: "technical" | "behavioural" | "domain"; priority: "must" | "nice" };
export type Question = {
  id: string;
  requirement_ids: string[];
  category: "technical" | "behavioural" | "system-design" | "company-fit";
  prompt: string;
  answer_outline: string;
  difficulty: 1 | 2 | 3;
};

export type Flashcard = { id: string; front: string; back: string; requirement_ids: string[] };
export type PracticeConfidence = "again" | "unsure" | "confident";
export type PracticeSnapshot = {
  kitId: string;
  progress: Array<{
    cardId: string;
    confidence: PracticeConfidence | null;
    reviewCount: number;
    lastReviewedAt: string | null;
  }>;
  orderedCardIds: string[];
  counts: { unseen: number; reviewed: number; total: number };
};
export type ScheduleDay = { day: number; focus: string; question_ids: string[]; minutes: number };
export type ContentMetadata = {
  origin: "generated" | "manual";
  userEdited: boolean;
  pinned: boolean;
  revision: number;
  generationRunId: string | null;
};

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

export type OwnedKit = KitSummary & {
  originalInput: { jd: string; companyUrl: string; days: number };
  content: {
    source: {
      company: string;
      company_url: string;
      role: string;
      location: string;
      jd_chars: number;
      researched_at: string;
      pages_used: string[];
    };
    company_brief: { summary: string; what_they_do: string; sources: string[] };
    role: {
      title: string;
      seniority: string;
      responsibilities: string[];
      requirements: Requirement[];
    };
    questions: Question[];
    flashcards: Flashcard[];
    schedule: {
      days_available: number;
      days: ScheduleDay[];
    };
    coverage: { uncovered_requirement_ids: string[]; passes: number };
    warnings?: Array<{ code: string; message: string; url?: string }>;
  };
  metadata: {
    companyBrief: ContentMetadata;
    schedule: ContentMetadata;
    requirements: Record<string, ContentMetadata>;
    questions: Record<string, ContentMetadata>;
    flashcards: Record<string, ContentMetadata>;
  };
  derivedState: KitDerivedState;
  reconciliation: {
    revision: number;
    removedQuestionRequirementLinks: number;
    removedFlashcardRequirementLinks: number;
    removedScheduleQuestionLinks: number;
  };
};

export type PublicRegeneration = {
  id: string;
  kitId: string;
  target:
    | { type: "company-brief" }
    | { type: "question-category"; category: Question["category"] }
    | { type: "schedule" };
  baseRevision: number;
  status: "queued" | "running" | "completed" | "failed";
  error?: { code: string; message: string };
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};

export async function readApiError(response: Response, fallback: string): Promise<ApiError["error"]> {
  try {
    const body = await response.json() as ApiError;
    return { ...body.error, message: body.error?.message ?? fallback };
  } catch {
    return { message: fallback };
  }
}

export function isActiveJob(job: PublicJob): boolean {
  return job.status === "queued" || job.status === "running" || job.status === "retry_wait";
}

export function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function stageLabel(stage: string): string {
  return stage.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
