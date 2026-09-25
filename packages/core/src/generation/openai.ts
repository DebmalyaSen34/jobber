import OpenAI from "openai";

import {
  ProviderError,
  type GenerateJsonRequest,
  type GenerateJsonResult,
  type JsonProvider,
  type ProviderUsage,
} from "./provider.js";

const DEFAULT_ENDPOINT = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-flash";
const DEFAULT_TIMEOUT_MS = 30_000;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: DEFAULT_ENDPOINT,
  timeout: DEFAULT_TIMEOUT_MS,
});

//todo: OpenAI response type
// type openaiResponse = {

// }

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
    throw new ProviderError("PROVIDER_CONFIGURATION", "OPENAI_API_BASE_URL must be a valid URL.", false);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ProviderError(
      "PROVIDER_CONFIGURATION",
      "OPENAI API endpoint cannot contain credentials, a query, or a fragment.",
      false,
    );
  }
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new ProviderError("PROVIDER_CONFIGURATION", "OPENAI API endpoint must use HTTPS.", false);
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
    return new ProviderError("PROVIDER_AUTH", "OPENAI rejected the configured API credentials.", false);
  }
  if (status === 429) {
    return new ProviderError(
      "PROVIDER_RATE_LIMIT",
      "OPENAI rate limit exceeded.",
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
