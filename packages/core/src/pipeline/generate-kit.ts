import type { EvaluationCase } from "../schemas/evaluation.js";
import type { Kit } from "../schemas/kit.js";

/** Safe, user-facing failures; never wrap raw provider errors with credentials. */
export class GenerationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "GenerationError";
  }
}

export type KitGenerator = (input: EvaluationCase) => Promise<Kit>;

/** Shared entry point for the CLI and future app worker. Implemented in M2. */
export const generateKit: KitGenerator = async () => {
  throw new GenerationError(
    "PIPELINE_NOT_IMPLEMENTED",
    "Research and generation are not implemented yet. This command currently validates the batch contract only.",
  );
};
