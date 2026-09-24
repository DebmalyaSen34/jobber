import {
  ProviderError,
  type GenerateJsonRequest,
  type GenerateJsonResult,
  type JsonProvider,
  type ProviderUsage,
} from "./provider.js";

const DEFAULT_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const DEFAULT_TIMEOUT_MS = 30_000;

type Fetch = typeof globalThis.fetch;

export type GeminiProviderOptions = {
  apiKey: string;
  model?: string;
  endpoint?: string;
  timeoutMs?: number;
  fetch?: Fetch;
};

type GeminiResponse = {
  candidates?: Array<{
    finishReason?: string;
    content?: { parts?: Array<{ text?: string }> };
  }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
};

function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ProviderError("PROVIDER_CONFIGURATION", `${label} must be a positive integer.`, false);
  }
  return value;
}

function normalizedEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProviderError("PROVIDER_CONFIGURATION", "GEMINI_API_BASE_URL must be a valid URL.", false);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ProviderError(
      "PROVIDER_CONFIGURATION",
      "Gemini API endpoint cannot contain credentials, a query, or a fragment.",
      false,
    );
  }
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new ProviderError("PROVIDER_CONFIGURATION", "Gemini API endpoint must use HTTPS.", false);
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function retryAfterMs(headers: Headers): number | null {
  const raw = headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const date = Date.parse(raw);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

function httpError(status: number, headers: Headers): ProviderError {
  if (status === 401 || status === 403) {
    return new ProviderError("PROVIDER_AUTH", "Gemini rejected the configured API credentials.", false);
  }
  if (status === 429) {
    return new ProviderError(
      "PROVIDER_RATE_LIMIT",
      "Gemini rate limit exceeded.",
      true,
      retryAfterMs(headers),
    );
  }
  if (status === 408 || status === 409 || status === 425 || status >= 500) {
    return new ProviderError("PROVIDER_TEMPORARY", `Gemini temporarily failed with HTTP ${status}.`, true);
  }
  return new ProviderError("PROVIDER_REQUEST_FAILED", `Gemini request failed with HTTP ${status}.`, false);
}

function finiteInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function usageOf(body: GeminiResponse): ProviderUsage {
  return {
    inputTokens: finiteInteger(body.usageMetadata?.promptTokenCount),
    outputTokens: finiteInteger(body.usageMetadata?.candidatesTokenCount),
    totalTokens: finiteInteger(body.usageMetadata?.totalTokenCount),
  };
}

export class GeminiProvider implements JsonProvider {
  readonly model: string;
  readonly endpoint: string;
  readonly timeoutMs: number;
  readonly #apiKey: string;
  readonly #fetch: Fetch;

  constructor(options: GeminiProviderOptions) {
    if (!options.apiKey.trim()) {
      throw new ProviderError("PROVIDER_CONFIGURATION", "GEMINI_API_KEY is required.", false);
    }
    this.#apiKey = options.apiKey;
    this.model = options.model?.trim() || DEFAULT_MODEL;
    this.endpoint = normalizedEndpoint(options.endpoint ?? DEFAULT_ENDPOINT);
    this.timeoutMs = requirePositiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "Gemini timeout");
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async generateJson(request: GenerateJsonRequest): Promise<GenerateJsonResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    let rawBody: string;
    try {
      response = await this.#fetch(
        `${this.endpoint}/models/${encodeURIComponent(this.model)}:generateContent`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": this.#apiKey,
          },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: request.system }] },
            contents: [{ role: "user", parts: [{ text: request.prompt }] }],
            generationConfig: {
              responseMimeType: "application/json",
              responseJsonSchema: request.schema,
              temperature: request.temperature ?? 0,
              maxOutputTokens: request.maxOutputTokens ?? 4_096,
            },
          }),
          signal: controller.signal,
          redirect: "error",
        },
      );
      if (!response.ok) throw httpError(response.status, response.headers);
      rawBody = await response.text();
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (controller.signal.aborted) {
        throw new ProviderError("PROVIDER_TIMEOUT", "Gemini request timed out.", true, null, { cause: error });
      }
      throw new ProviderError("PROVIDER_TEMPORARY", "Gemini could not be reached.", true, null, { cause: error });
    } finally {
      clearTimeout(timeout);
    }

    let body: GeminiResponse;
    try {
      body = JSON.parse(rawBody) as GeminiResponse;
    } catch (error) {
      throw new ProviderError(
        "PROVIDER_INVALID_RESPONSE",
        "Gemini returned a non-JSON response.",
        true,
        null,
        { cause: error },
      );
    }

    if (body.promptFeedback?.blockReason) {
      throw new ProviderError("PROVIDER_BLOCKED", "Gemini blocked the extraction request.", false);
    }
    const candidate = body.candidates?.[0];
    const text = candidate?.content?.parts?.map((part) => part.text ?? "").join("").trim();
    if (!text) {
      const blocked = ["SAFETY", "PROHIBITED_CONTENT", "RECITATION", "BLOCKLIST"]
        .includes(candidate?.finishReason ?? "");
      throw new ProviderError(
        blocked ? "PROVIDER_BLOCKED" : "PROVIDER_INVALID_RESPONSE",
        blocked ? "Gemini blocked the extraction response." : "Gemini returned no structured output.",
        false,
      );
    }

    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      throw new ProviderError(
        "PROVIDER_INVALID_RESPONSE",
        "Gemini returned invalid structured JSON.",
        true,
        null,
        { cause: error },
      );
    }

    return {
      value,
      provider: "google-gemini",
      model: this.model,
      usage: usageOf(body),
      requestId: response.headers.get("x-request-id"),
    };
  }
}

export function createGeminiProviderFromEnv(env: NodeJS.ProcessEnv = process.env): GeminiProvider {
  const apiKey = env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new ProviderError(
      "PROVIDER_CONFIGURATION",
      "Set GEMINI_API_KEY before running generation.",
      false,
    );
  }
  const timeout = env.GEMINI_TIMEOUT_MS ? Number(env.GEMINI_TIMEOUT_MS) : undefined;
  return new GeminiProvider({
    apiKey,
    model: env.GEMINI_MODEL,
    endpoint: env.GEMINI_API_BASE_URL,
    timeoutMs: timeout,
  });
}
