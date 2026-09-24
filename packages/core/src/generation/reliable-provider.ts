import {
  ProviderError,
  type GenerateJsonRequest,
  type GenerateJsonResult,
  type JsonProvider,
} from "./provider.js";

export type ProviderGateOptions = {
  minIntervalMs?: number;
  maxConcurrent?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Shared across jobs to serialize or bound provider traffic. */
export class ProviderGate {
  readonly #minIntervalMs: number;
  readonly #maxConcurrent: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  #active = 0;
  #lastStart = 0;
  #queue: Array<() => void> = [];

  constructor(options: ProviderGateOptions = {}) {
    this.#minIntervalMs = options.minIntervalMs ?? 1_000;
    this.#maxConcurrent = options.maxConcurrent ?? 1;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? defaultSleep;
    if (!Number.isSafeInteger(this.#minIntervalMs) || this.#minIntervalMs < 0
      || !Number.isSafeInteger(this.#maxConcurrent) || this.#maxConcurrent < 1) {
      throw new ProviderError("PROVIDER_CONFIGURATION", "Invalid provider gate settings.", false);
    }
  }

  async run<T>(operation: () => Promise<T>, deadline: number): Promise<T> {
    await this.#acquire(deadline);
    try {
      const wait = Math.max(0, this.#lastStart + this.#minIntervalMs - this.#now());
      if (this.#now() + wait >= deadline) {
        throw new ProviderError("PROVIDER_TIMEOUT", "Provider deadline expired while waiting for capacity.", false);
      }
      if (wait) await this.#sleep(wait);
      this.#lastStart = this.#now();
      return await operation();
    } finally {
      this.#active -= 1;
      this.#queue.shift()?.();
    }
  }

  async #acquire(deadline: number): Promise<void> {
    while (this.#active >= this.#maxConcurrent) {
      await new Promise<void>((resolve, reject) => {
        const remaining = deadline - this.#now();
        if (remaining <= 0) {
          reject(new ProviderError("PROVIDER_TIMEOUT", "Provider deadline expired while queued.", false));
          return;
        }
        const timer = setTimeout(() => {
          const index = this.#queue.indexOf(release);
          if (index >= 0) this.#queue.splice(index, 1);
          reject(new ProviderError("PROVIDER_TIMEOUT", "Provider deadline expired while queued.", false));
        }, remaining);
        const release = () => {
          clearTimeout(timer);
          resolve();
        };
        this.#queue.push(release);
      });
    }
    this.#active += 1;
  }
}

export type ReliableProviderOptions = {
  deadline: number;
  maxRequests?: number;
  maxTokens?: number;
  retries?: number;
  baseDelayMs?: number;
  maxRetryDelayMs?: number;
  gate?: ProviderGate;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

export type ProviderBudgetSnapshot = {
  requests: number;
  tokens: number;
  retries: number;
  deadline: string;
};

export type ProviderCallTrace = {
  stage: GenerateJsonRequest["stage"];
  attempts: number;
  retry_codes: string[];
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
};

function positive(value: number, label: string, allowZero = false): number {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new ProviderError("PROVIDER_CONFIGURATION", `${label} is invalid.`, false);
  }
  return value;
}

function estimateTokens(request: GenerateJsonRequest): number {
  return Math.ceil((request.system.length + request.prompt.length + JSON.stringify(request.schema).length) / 4);
}

export class ReliableJsonProvider implements JsonProvider {
  readonly #maxRequests: number;
  readonly #maxTokens: number;
  readonly #retries: number;
  readonly #baseDelayMs: number;
  readonly #maxRetryDelayMs: number;
  readonly #gate: ProviderGate;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #random: () => number;
  #requests = 0;
  #tokens = 0;
  #retryCount = 0;
  readonly #calls: ProviderCallTrace[] = [];

  constructor(private readonly provider: JsonProvider, private readonly options: ReliableProviderOptions) {
    this.#maxRequests = positive(options.maxRequests ?? 20, "Provider request budget");
    this.#maxTokens = positive(options.maxTokens ?? 30_000, "Provider token budget");
    this.#retries = positive(options.retries ?? 2, "Provider retry count", true);
    this.#baseDelayMs = positive(options.baseDelayMs ?? 500, "Provider retry delay", true);
    this.#maxRetryDelayMs = positive(options.maxRetryDelayMs ?? 10_000, "Provider maximum retry delay", true);
    this.#gate = options.gate ?? new ProviderGate();
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#random = options.random ?? Math.random;
    if (!Number.isFinite(options.deadline)) {
      throw new ProviderError("PROVIDER_CONFIGURATION", "Provider deadline is invalid.", false);
    }
  }

  get snapshot(): ProviderBudgetSnapshot {
    return {
      requests: this.#requests,
      tokens: this.#tokens,
      retries: this.#retryCount,
      deadline: new Date(this.options.deadline).toISOString(),
    };
  }

  get trace(): readonly ProviderCallTrace[] {
    return this.#calls;
  }

  async generateJson(request: GenerateJsonRequest): Promise<GenerateJsonResult> {
    let currentRequest = { ...request };
    const retryCodes: string[] = [];
    for (let attempt = 0; ; attempt += 1) {
      this.#assertBudget(currentRequest);
      this.#requests += 1;
      try {
        const result = await this.#gate.run(
          () => this.#withinDeadline(this.provider.generateJson(currentRequest)),
          this.options.deadline,
        );
        const used = result.usage.totalTokens
          ?? ((result.usage.inputTokens ?? estimateTokens(currentRequest)) + (result.usage.outputTokens ?? 0));
        this.#tokens += used;
        if (this.#tokens > this.#maxTokens) {
          throw new ProviderError("PROVIDER_REQUEST_FAILED", "Provider token budget exhausted.", false);
        }
        const validation = currentRequest.validate?.(result.value);
        if (validation && !validation.success) {
          if (attempt >= this.#retries) {
            throw new ProviderError("PROVIDER_INVALID_RESPONSE", "Provider output remained invalid after bounded repair.", false);
          }
          retryCodes.push("PROVIDER_SCHEMA_INVALID");
          this.#retryCount += 1;
          await this.#backoff(null, attempt);
          currentRequest = {
            ...currentRequest,
            prompt: `${currentRequest.prompt}\n\nThe previous response was invalid: ${validation.feedback.slice(0, 500)} Return a corrected object only.`,
          };
          continue;
        }
        const completed = { ...result, attempts: attempt + 1, retryCodes };
        this.#calls.push({
          stage: currentRequest.stage,
          attempts: completed.attempts,
          retry_codes: [...retryCodes],
          input_tokens: result.usage.inputTokens,
          output_tokens: result.usage.outputTokens,
          total_tokens: result.usage.totalTokens,
        });
        return completed;
      } catch (error) {
        if (!(error instanceof ProviderError) || !error.retryable || attempt >= this.#retries) throw error;
        retryCodes.push(error.code);
        this.#retryCount += 1;
        await this.#backoff(error.retryAfterMs, attempt);
      }
    }
  }

  #assertBudget(request: GenerateJsonRequest): void {
    if (this.#now() >= this.options.deadline) {
      throw new ProviderError("PROVIDER_TIMEOUT", "Provider case deadline expired.", false);
    }
    if (this.#requests >= this.#maxRequests) {
      throw new ProviderError("PROVIDER_REQUEST_FAILED", "Provider request budget exhausted.", false);
    }
    const estimate = estimateTokens(request);
    const remaining = this.#maxTokens - this.#tokens;
    if (remaining <= estimate + 64) {
      throw new ProviderError("PROVIDER_REQUEST_FAILED", "Provider token budget exhausted.", false);
    }
    request.maxOutputTokens = Math.min(request.maxOutputTokens ?? 4_096, remaining - estimate);
  }

  async #backoff(retryAfterMs: number | null, attempt: number): Promise<void> {
    const exponential = this.#baseDelayMs * 2 ** attempt;
    const jitter = Math.floor(this.#random() * Math.max(1, Math.floor(this.#baseDelayMs / 2)));
    const delay = Math.min(this.#maxRetryDelayMs, retryAfterMs ?? exponential + jitter);
    if (this.#now() + delay >= this.options.deadline) {
      throw new ProviderError("PROVIDER_TIMEOUT", "Provider deadline expired before retry.", false);
    }
    if (delay) await this.#sleep(delay);
  }

  async #withinDeadline<T>(promise: Promise<T>): Promise<T> {
    const remaining = this.options.deadline - this.#now();
    if (remaining <= 0) throw new ProviderError("PROVIDER_TIMEOUT", "Provider case deadline expired.", false);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new ProviderError("PROVIDER_TIMEOUT", "Provider case deadline expired.", false)), remaining);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
