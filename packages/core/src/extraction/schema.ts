import { z } from "zod";
import { requirementSchema } from "../schemas/kit.js";

export const evidenceSchema = z.strictObject({
  quote: z.string().min(1),
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
});

export const extractedRequirementSchema = requirementSchema.extend({
  evidence: evidenceSchema,
});

export const extractionSchema = z.strictObject({
  title: z.string(),
  seniority: z.string(),
  location: z.string(),
  responsibilities: z.array(z.string()),
  requirements: z.array(extractedRequirementSchema),
  evidence: z.strictObject({
    title: evidenceSchema.nullable(),
    seniority: evidenceSchema.nullable(),
    location: evidenceSchema.nullable(),
    responsibilities: z.array(evidenceSchema),
  }),
  warnings: z.array(z.string()),
});

export type Evidence = z.infer<typeof evidenceSchema>;
export type ExtractedRequirement = z.infer<typeof extractedRequirementSchema>;
export type Extraction = z.infer<typeof extractionSchema>;
