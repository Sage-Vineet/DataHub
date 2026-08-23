import { ModelReplyError, parseModelJson } from "./model-json.js";

/**
 * Asking Gemini to read a document.
 *
 * Every extraction in the product that is not the Python OCR path goes through
 * here: a tax return, a balance sheet's bank balances, a statement PDF. The
 * shape is always the same — send a file and a prompt, get JSON back.
 *
 * WHY THE REST ENDPOINT RATHER THAN THE SDK
 * -----------------------------------------
 * `@google/generative-ai` wraps one HTTPS POST. Wrapping it again here would
 * mean every test either hits the network or mocks a module, and mocking a
 * module tests the mock. `fetch` is injectable, so the tests run against a
 * local fake and prove the request is built correctly and the failures are
 * classified correctly.
 *
 * They do NOT prove Google accepts it — nothing short of a real key does — and
 * that is stated here rather than implied by a green suite. The exposure is
 * small: the response is a string that goes straight into `parseModelJson`,
 * which is tested exhaustively against the shapes a model actually returns.
 */

export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com";

/**
 * The model to ask.
 *
 * Pinned rather than left to an alias. An alias that advances means an
 * extraction's answers can change without anything here changing — which is a
 * figure moving on a page with no commit to blame it on.
 */
export const DEFAULT_GEMINI_MODEL = "gemini-2.0-flash";

/** The key is missing or wrong. */
export class GeminiAuthError extends Error {
  constructor(message = "Gemini rejected the API key.") {
    super(message);
    this.name = "GeminiAuthError";
  }
}

/** Gemini answered, and not with a document. */
export class GeminiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GeminiRequestError";
  }
}

/** Nothing came back to read. */
export class GeminiEmptyReplyError extends Error {
  constructor(message = "Gemini returned no text.") {
    super(message);
    this.name = "GeminiEmptyReplyError";
  }
}

export interface GeminiDocument {
  /** `application/pdf`, `text/csv`, and so on. */
  mimeType: string;
  /** The file, base64-encoded. */
  data: string;
}

export interface AskInput {
  prompt: string;
  /** A file to read, when there is one. A text-only prompt omits it. */
  document?: GeminiDocument;
  model?: string;
}

export interface GeminiClientOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  /**
   * How long one attempt may take.
   *
   * A long PDF genuinely takes tens of seconds. Without any timeout a hung
   * connection holds the request open until the caller gives up, and the user
   * watches a spinner rather than seeing an error they can act on.
   */
  timeoutMs?: number;
  /**
   * How many times to try.
   *
   * Gemini rate-limits with 429 and sheds load with 503, and both are worth
   * retrying. A 400 is not — the prompt or the document is wrong, and trying
   * again produces the same 400 more slowly.
   */
  maxAttempts?: number;
  /** Injected in tests, so nothing here waits in real time. */
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: unknown }> };
    finishReason?: unknown;
  }>;
  promptFeedback?: { blockReason?: unknown };
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export class GeminiClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GeminiClientOptions) {
    if (!options.apiKey) {
      // Thrown at construction, not at the first call. A missing key is a
      // configuration mistake, and finding it when somebody uploads a document
      // means finding it in front of a client.
      throw new Error("GEMINI_API_KEY is required to build a Gemini client.");
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? GEMINI_BASE_URL).replace(/\/+$/, "");
    this.model = options.model ?? DEFAULT_GEMINI_MODEL;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Ask, and return the reply as text. */
  async ask(input: AskInput): Promise<string> {
    const model = input.model ?? this.model;
    const url = new URL(
      `/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      this.baseUrl,
    );
    // The key goes in a header rather than the query string: a URL reaches
    // access logs, error reports and proxy caches, and a key in one of those
    // is a key that has to be rotated.
    const body = JSON.stringify({
      contents: [
        {
          parts: [
            ...(input.document
              ? [{ inline_data: { mime_type: input.document.mimeType, data: input.document.data } }]
              : []),
            { text: input.prompt },
          ],
        },
      ],
    });

    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        return await this.attempt(url.toString(), body);
      } catch (error) {
        lastError = error;
        const retryable =
          error instanceof GeminiRequestError && RETRYABLE.has(error.status);
        if (!retryable || attempt === this.maxAttempts) throw error;
        // Exponential, starting at a second. Retrying a rate limit immediately
        // is how a client earns a longer one.
        await this.sleep(1000 * 2 ** (attempt - 1));
      }
    }
    throw lastError;
  }

  /** Ask, and parse the reply as JSON. */
  async askForJson<T = unknown>(input: AskInput): Promise<T> {
    return parseModelJson<T>(await this.ask(input));
  }

  private async attempt(url: string, body: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": this.apiKey,
        },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 401 || response.status === 403) {
      throw new GeminiAuthError(`Gemini rejected the API key (${response.status}).`);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new GeminiRequestError(
        response.status,
        `Gemini answered ${response.status}: ${text.slice(0, 500) || "(no body)"}`,
      );
    }

    const payload = (await response.json()) as GeminiResponse;

    // A blocked prompt comes back 200 with no candidates and a reason. Reading
    // it as "no text" would hide why, and the reason is the only thing that
    // tells somebody the document tripped a safety filter rather than failing
    // to parse.
    const blocked = payload.promptFeedback?.blockReason;
    if (blocked) {
      throw new GeminiEmptyReplyError(`Gemini refused the request: ${String(blocked)}.`);
    }

    const text = payload.candidates
      ?.flatMap((candidate) => candidate.content?.parts ?? [])
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .join("")
      .trim();

    if (!text) {
      const reason = payload.candidates?.[0]?.finishReason;
      throw new GeminiEmptyReplyError(
        reason
          ? `Gemini returned no text (${String(reason)}).`
          : "Gemini returned no text.",
      );
    }
    return text;
  }
}

/**
 * What a caller needs from a model.
 *
 * A port rather than the class, so a service can be tested without a network
 * and so a different model — or a queued worker — drops in without touching
 * anything above it.
 */
export interface DocumentReader {
  ask(input: AskInput): Promise<string>;
  askForJson<T = unknown>(input: AskInput): Promise<T>;
}

export { ModelReplyError };
