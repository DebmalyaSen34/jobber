export type JsonSchema = Record<string, unknown>;

export type ProviderStage =
  | "extract"
  | "company-brief"
  | "technical"
  | "behavioural"
  | "system-design"
  | "company-fit"
  | "coverage-repair"
  | "flashcards";

export type GenerateJsonRequest = {
  stage: ProviderStage;
  system: string;
  prompt: string;
  schema: JsonSchema;
  temperature?: number;
  maxOutputTokens?: number;
  /** Internal validation hook used by the reliability wrapper; never sent to a provider. */
  validate?: (value: unknown) => { success: true } | { success: false; feedback: string };
};

export type ProviderUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
};

export type GenerateJsonResult = {
  value: unknown;
  provider: string;
  model: string;
  usage: ProviderUsage;
  requestId: string | null;
  attempts?: number;
  retryCodes?: string[];
};

export interface JsonProvider {
  generateJson(request: GenerateJsonRequest): Promise<GenerateJsonResult>;
}

export type ProviderErrorCode =
  | "PROVIDER_CONFIGURATION"
  | "PROVIDER_AUTH"
  | "PROVIDER_RATE_LIMIT"
  | "PROVIDER_TEMPORARY"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_BLOCKED"
  | "PROVIDER_INVALID_RESPONSE"
  | "PROVIDER_REQUEST_FAILED";

export class ProviderError extends Error {
  constructor(
    public readonly code: ProviderErrorCode,
    message: string,
    public readonly retryable: boolean,
    public readonly retryAfterMs: number | null = null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProviderError";
  }
}
