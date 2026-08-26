import type { ReasonablenessClassifier } from "./ports.js";

/**
 * Gemini adapter for the reasonableness review.
 *
 * Ported from the model plumbing inside `aiHierarchyRecommendationService.js` on
 * `data_room`, which is also why it is Gemini rather than anything else: the
 * prompt, the confidence bands it self-reports, and the restraint instructions
 * were all tuned against these models. Swapping providers is a behaviour change
 * to be measured, not a detail of the port — and the port exists precisely so
 * that can be done later without touching the engine.
 *
 * ## What this adapter deliberately does not do
 *
 * It returns raw text. Parsing, validation and materiality are the engine's job,
 * every one of them, and an adapter that "helpfully" parsed would become a
 * second place where a malformed answer could be repaired into a plausible one.
 * The whole design rests on nothing free-form being persisted.
 */

/** The default fallback chain, cheapest and fastest first. */
export const DEFAULT_MODELS = [
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
  "gemini-2.0-flash",
] as const;

const QUOTA_BACKOFF_MS = 3000;
/** One retry after a quota refusal; a second is just a slower failure. */
const ATTEMPTS_PER_MODEL = 2;

/** The shape of `@google/generative-ai` this adapter uses, and nothing more. */
export interface GenerativeClient {
  getGenerativeModel(opts: { model: string }): {
    generateContent(input: [{ text: string }]): Promise<{ response: { text(): string } }>;
  };
}

export interface GeminiClassifierOptions {
  apiKey: string;
  /** Injected in tests; defaults to the real SDK, loaded lazily. */
  createClient?: (apiKey: string) => GenerativeClient;
  models?: readonly string[];
  sleep?: (ms: number) => Promise<void>;
  logger?: { warn: (msg: string) => void };
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Try each model in turn, retrying once on a quota refusal.
 *
 * The two error classes are handled differently on purpose. A 404 means this
 * model does not exist for this key, so retrying it is pure latency — move to
 * the next one immediately. A 429 means the model exists and is rate-limited,
 * which one short backoff often clears.
 *
 * Throws when every model has been exhausted. That is not a failure mode to
 * hide: the service is fail-soft around it and reports the check unavailable,
 * leaving the chart of accounts and every downstream report untouched.
 */
export function createGeminiClassifier(opts: GeminiClassifierOptions): ReasonablenessClassifier {
  const {
    apiKey,
    models = DEFAULT_MODELS,
    sleep = defaultSleep,
    logger = { warn: (msg: string) => console.warn(msg) },
  } = opts;

  const createClient =
    opts.createClient ??
    ((key: string): GenerativeClient => {
      // Required lazily so the SDK is not loaded — or needed — by a deployment
      // that never enables this module.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { GoogleGenerativeAI } = require("@google/generative-ai") as {
        new (k: string): GenerativeClient;
        prototype: unknown;
      } & { GoogleGenerativeAI: new (k: string) => GenerativeClient };
      return new GoogleGenerativeAI(key);
    });

  return {
    async review(prompt: string): Promise<{ text: string; model: string }> {
      if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
      let lastError: unknown = null;

      for (const model of models) {
        for (let attempt = ATTEMPTS_PER_MODEL; attempt > 0; attempt -= 1) {
          try {
            const client = createClient(apiKey);
            const result = await client
              .getGenerativeModel({ model })
              .generateContent([{ text: prompt }]);
            return { text: result.response.text(), model };
          } catch (err) {
            lastError = err;
            const message = String((err as Error)?.message ?? err);
            const isQuota = message.includes("429") || message.toLowerCase().includes("quota");
            const isNotFound =
              message.includes("404") || message.toLowerCase().includes("not found");
            logger.warn(`[CoaReview] model ${model} failed: ${message}`);

            if (isNotFound) break; // this key cannot use it at all
            if (isQuota && attempt > 1) {
              await sleep(QUOTA_BACKOFF_MS);
              continue;
            }
            break;
          }
        }
      }

      throw new Error(
        `reasonableness review call failed: ${String((lastError as Error)?.message ?? "unknown")}`,
      );
    },
  };
}
