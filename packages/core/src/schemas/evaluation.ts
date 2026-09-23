import { z } from "zod";
import { kitSchema } from "./kit.js";

export const evaluationCaseSchema = z.object({
  id: z.string().refine((value) => value.trim().length > 0, "Case ID is required"),
  // Validate without normalizing the original JD used for evidence offsets.
  jd: z.string().refine((value) => value.trim().length > 0, "JD is required"),
  company_url: z.string(),
  days: z.number().int().positive(),
});

export const evaluationInputSchema = z.array(evaluationCaseSchema);

export const evaluationResultSchema = z.discriminatedUnion("status", [
  z.object({
    id: z.string().min(1),
    status: z.literal("ok"),
    kit: kitSchema,
    error: z.null(),
  }),
  z.object({
    id: z.string().min(1),
    status: z.literal("failed"),
    kit: z.null(),
    error: z.object({
      code: z.string().min(1),
      message: z.string().min(1),
    }),
  }),
]);

export const evaluationOutputSchema = z.object({
  version: z.literal("1.0"),
  generated_at: z.iso.datetime({ offset: true }),
  kits: z.array(evaluationResultSchema),
});

export type EvaluationCase = z.infer<typeof evaluationCaseSchema>;
export type EvaluationResult = z.infer<typeof evaluationResultSchema>;
export type EvaluationOutput = z.infer<typeof evaluationOutputSchema>;
