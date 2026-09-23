import { z } from "zod";
import {
  evaluationCaseSchema,
  evaluationOutputSchema,
  type EvaluationOutput,
  type EvaluationResult,
} from "../schemas/evaluation.js";
import { kitSchema } from "../schemas/kit.js";
import { GenerationError, type KitGenerator } from "../pipeline/generate-kit.js";

export class BatchInputError extends Error {
  readonly code = "INVALID_INPUT";
}

const identitySchema = z.object({
  id: z.string().refine((value) => value.trim().length > 0),
});

/** Reject identities we cannot report faithfully; validate other fields per case. */
export function validateBatchIdentities(input: unknown): Array<{ id: string }> {
  if (!Array.isArray(input)) {
    throw new BatchInputError("Input must be a JSON array of cases.");
  }
  const seen = new Set<string>();
  return input.map((entry: unknown, index) => {
    const identity = identitySchema.safeParse(entry);
    if (!identity.success) {
      throw new BatchInputError(`Case at index ${index} requires a nonblank string id.`);
    }
    if (seen.has(identity.data.id)) {
      throw new BatchInputError(`Case at index ${index} has a duplicate id.`);
    }
    seen.add(identity.data.id);
    return identity.data;
  });
}

/** No filesystem, server, database, or provider initialization in the runner. */
export async function runBatch(
  input: unknown,
  generator: KitGenerator,
): Promise<EvaluationOutput> {
  const identities = validateBatchIdentities(input);
  const entries = input as unknown[];
  const kits: EvaluationResult[] = [];

  // Sequential by default to avoid overwhelming future free-tier providers.
  for (const [index, identity] of identities.entries()) {
    const parsed = evaluationCaseSchema.safeParse(entries[index]);
    if (!parsed.success) {
      kits.push({
        id: identity.id, status: "failed", kit: null,
        error: {
          code: "INVALID_CASE",
          message: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
        },
      });
      continue;
    }
    try {
      const result = kitSchema.safeParse(await generator(parsed.data));
      if (!result.success) {
        throw new GenerationError("INVALID_KIT", "The pipeline returned a structurally invalid kit.");
      }
      kits.push({ id: identity.id, status: "ok", kit: result.data, error: null });
    } catch (error) {
      kits.push({
        id: identity.id, status: "failed", kit: null,
        error: error instanceof GenerationError
          ? { code: error.code, message: error.message }
          : { code: "GENERATION_FAILED", message: "The generation pipeline failed unexpectedly." },
      });
    }
  }
  return evaluationOutputSchema.parse({
    version: "1.0", generated_at: new Date().toISOString(), kits,
  });
}
