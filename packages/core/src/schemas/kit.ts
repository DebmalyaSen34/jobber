import { z } from "zod";

const id = z.string().refine((value) => value.trim().length > 0, "ID is required");
const nonnegativeInteger = z.number().int().nonnegative();
const positiveInteger = z.number().int().positive();
const timestamp = z.iso.datetime({ offset: true });

// Shape validation only. Use validateKit for reference integrity, computed
// coverage, requested-day matching, and generated-versus-draft completeness.
// Loose objects preserve permitted extensions such as evidence and warnings.
export const requirementSchema = z.looseObject({
  id,
  text: z.string().min(1),
  kind: z.enum(["technical", "behavioural", "domain"]),
  priority: z.enum(["must", "nice"]),
});

export const questionSchema = z.looseObject({
  id,
  requirement_ids: z.array(id),
  category: z.enum([
    "technical", "behavioural", "system-design", "company-fit",
  ]),
  prompt: z.string().min(1),
  answer_outline: z.string(),
  difficulty: z.union([z.literal(1), z.literal(2), z.literal(3)]),
});

export const flashcardSchema = z.looseObject({
  id,
  front: z.string().min(1),
  back: z.string(),
  requirement_ids: z.array(id),
});

export const scheduleDaySchema = z.looseObject({
  day: positiveInteger,
  focus: z.string(),
  question_ids: z.array(id),
  minutes: nonnegativeInteger,
});

export const kitSchema = z.looseObject({
  source: z.looseObject({
    company: z.string(),
    // Retain original input even when retrieval rejects an invalid URL.
    company_url: z.string(),
    role: z.string(),
    location: z.string(),
    jd_chars: nonnegativeInteger,
    researched_at: timestamp,
    pages_used: z.array(z.url({ protocol: /^https?$/ })),
  }),
  company_brief: z.looseObject({
    summary: z.string(),
    what_they_do: z.string(),
    sources: z.array(z.url({ protocol: /^https?$/ })),
  }),
  role: z.looseObject({
    title: z.string(),
    seniority: z.string(),
    responsibilities: z.array(z.string()),
    requirements: z.array(requirementSchema),
  }),
  questions: z.array(questionSchema),
  flashcards: z.array(flashcardSchema),
  schedule: z.looseObject({
    days_available: positiveInteger,
    days: z.array(scheduleDaySchema),
  }),
  coverage: z.looseObject({
    uncovered_requirement_ids: z.array(id),
    passes: nonnegativeInteger,
  }),
});

export type Requirement = z.infer<typeof requirementSchema>;
export type Question = z.infer<typeof questionSchema>;
export type Flashcard = z.infer<typeof flashcardSchema>;
export type ScheduleDay = z.infer<typeof scheduleDaySchema>;
export type Kit = z.infer<typeof kitSchema>;
