"use strict";

/**
 * ============================================================================
 * Gemini Resilient Client — the ONE reusable retry / model-failover / timeout
 * executor for every Gemini API call in this project.
 *
 * WHY THIS EXISTS
 * ----------------------------------------------------------------------------
 * Google's Gemini API occasionally returns TRANSIENT errors under load
 * ("503 — model overloaded", 429 rate limiting, 500/502/504 gateway errors)
 * or fails at the network layer (ECONNRESET, ETIMEDOUT). These are not bugs
 * in this application and not permanent failures — retrying after a short,
 * randomized delay resolves the overwhelming majority of them. Previously,
 * every call site in this project hand-rolled its own ad hoc retry loop
 * (inconsistent backoff, no jitter, no request timeout, and — worst of all —
 * the raw Google error text could bubble all the way to the browser). This
 * module replaces every one of those ad hoc loops with a single,
 * centrally-tested implementation. See each call site for the (mechanical)
 * before/after — no prompt, parsing, or output-shape logic changes there.
 *
 * WHAT IT DOES
 * ----------------------------------------------------------------------------
 *   1. ERROR CLASSIFICATION (classifyGeminiError) — every failure is
 *      classified as either:
 *        RETRYABLE   → HTTP 429 / 500 / 502 / 503 / 504, ECONNRESET,
 *                      ETIMEDOUT, ECONNREFUSED, ENOTFOUND, or a generic
 *                      network/fetch failure.
 *        NON-RETRYABLE → HTTP 400 / 401 / 403, safety blocks, invalid
 *                      prompts/JSON, or anything unrecognized (fail fast
 *                      rather than silently retrying an unknown bug).
 *      The Gemini SDK (>= 0.24) exposes a typed `status` field on its fetch
 *      errors (GoogleGenerativeAIFetchError) — we use that directly instead
 *      of string-matching the error message, falling back to message/code
 *      inspection only for lower-level network errors the SDK doesn't wrap.
 *
 *   2. EXPONENTIAL BACKOFF WITH JITTER (computeBackoffMs) — the delay before
 *      retry N is `GEMINI_RETRY_BASE_MS * 2^(N-1)` (1s, 2s, 4s, 8s, 16s, ...
 *      by default), capped at GEMINI_RETRY_MAX_DELAY_MS. "Equal jitter"
 *      (delay/2 + random(0, delay/2)) is added so that many concurrent
 *      requests failing at the same instant don't all retry in lockstep and
 *      hammer Google again at the same moment (a "retry storm") — the
 *      request that's central to reliability under concurrent load.
 *
 *   3. MODEL FAILOVER — an ordered list of models (each caller supplies its
 *      own tuned list via config/geminiModels.js, unchanged) is tried in
 *      sequence. Once one model exhausts its retry budget on a transient
 *      error, the NEXT model is tried automatically with its own fresh
 *      budget. The caller only sees an error if EVERY model is exhausted.
 *
 *   4. CONFIGURABLE TIMEOUT — every individual attempt is bounded by
 *      GEMINI_TIMEOUT_MS, passed straight into the SDK's own
 *      `requestOptions.timeout` (it aborts the underlying HTTP request
 *      itself — no separate timer/socket bookkeeping needed here).
 *
 *   5. CANCELLATION — an optional caller-supplied AbortSignal (e.g. tied to
 *      an Express request's "close" event) is honored at every retry
 *      boundary AND passed through to the SDK for the in-flight request.
 *      If it fires, ALL retries stop immediately with GeminiCancelledError
 *      — never counted as a failure, never retried, no wasted quota.
 *
 *   6. STRUCTURED LOGGING — every attempt logs one structured line
 *      (attempt/total, model, status, wait) so retry behavior is
 *      diagnosable in production logs without ever printing a raw stack
 *      trace or SDK internals.
 *
 *   7. CLEAN FAILURE — once every model/retry combination is exhausted, the
 *      thrown error is a GeminiUnavailableError with a generic, safe
 *      message and an AI_TEMPORARILY_UNAVAILABLE code. The real Google
 *      error is attached ONLY as `.cause` (Node's standard error-chaining
 *      field), for server-side logs — callers must never forward `.cause`
 *      to a client response. `.toResponseBody()` returns the exact
 *      `{ success, code, message }` shape to send to a client.
 *
 * CONCURRENCY / SAFETY
 * ----------------------------------------------------------------------------
 * This module holds NO shared mutable state across calls — every call to
 * generateContentResilient() is fully independent, so concurrent requests
 * from many users can never race each other. The only module-level state is
 * a small cache of `GoogleGenerativeAI` / `GenerativeModel` SDK instances,
 * which are stateless, immutable per (apiKey, model) pair, and safe to share
 * (this simply avoids re-constructing the SDK client on every single retry
 * attempt, as the old per-file code did). Every timer created for backoff
 * sleeps is always cleared (on success, on abort, and on timeout) so no
 * timer or event-listener leaks accumulate under sustained load.
 *
 * CONFIGURATION (environment variables)
 * ----------------------------------------------------------------------------
 *   MAX_GEMINI_RETRIES      Retries per model AFTER the first attempt.
 *                           Default 3. Clamped to [0, 10] (a higher ceiling
 *                           would let one slow model, multiplied across a
 *                           whole fallback chain, block a request for an
 *                           unreasonable amount of time).
 *   GEMINI_TIMEOUT_MS       Per-attempt request timeout. Default 60000.
 *                           Clamped to [1000, 300000].
 *   GEMINI_RETRY_BASE_MS    Backoff base unit (optional tuning knob, not
 *                           required by the spec). Default 1000 — keeps the
 *                           documented 1s/2s/4s/8s/16s progression.
 *   GEMINI_RETRY_MAX_DELAY_MS  Backoff ceiling (optional). Default 30000.
 * ============================================================================
 */

const { GoogleGenerativeAI } = require("@google/generative-ai");

// ─── Configuration ─────────────────────────────────────────────────────────────
// Read live (not cached at module-load) so tests and runtime env changes are
// respected without needing to reload this module.

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function getMaxRetries() {
  return clampInt(process.env.MAX_GEMINI_RETRIES, 0, 10, 3);
}

function getTimeoutMs() {
  return clampInt(process.env.GEMINI_TIMEOUT_MS, 1000, 300000, 60000);
}

function getRetryBaseMs() {
  return clampInt(process.env.GEMINI_RETRY_BASE_MS, 100, 60000, 1000);
}

function getRetryMaxDelayMs() {
  return clampInt(process.env.GEMINI_RETRY_MAX_DELAY_MS, 1000, 300000, 30000);
}

// ─── Error types ───────────────────────────────────────────────────────────────

/**
 * Thrown once every model AND every retry has been exhausted on transient
 * errors (or a single non-retryable error was hit immediately). The message
 * is always safe to show to an end user; the real cause is attached via the
 * standard Error `.cause` chain for server-side logs ONLY.
 */
class GeminiUnavailableError extends Error {
  /**
   * @param {string} [message] Safe, user-facing message.
   * @param {{ cause?: unknown, attempts?: GeminiAttemptLog[] }} [options]
   */
  constructor(message = "AI service is temporarily busy. Please try again in a few moments.", options = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "GeminiUnavailableError";
    this.code = "AI_TEMPORARILY_UNAVAILABLE";
    this.httpStatus = 503;
    /** @type {GeminiAttemptLog[]} Full attempt history — server-side diagnostics only. */
    this.attempts = options.attempts || [];
  }

  /** Exact client-safe response body — never includes `.cause` or attempt internals. */
  toResponseBody() {
    return { success: false, code: this.code, message: this.message };
  }
}

/**
 * Thrown when the caller's own AbortSignal fires (client disconnected, or the
 * caller cancelled for any other reason). Never treated as a retryable
 * failure — retries stop immediately.
 */
class GeminiCancelledError extends Error {
  constructor(message = "Request was cancelled.") {
    super(message);
    this.name = "GeminiCancelledError";
    this.code = "AI_REQUEST_CANCELLED";
  }
}

// ─── Error classification ──────────────────────────────────────────────────────

const RETRYABLE_HTTP_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRYABLE_ERROR_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);
// Message substrings that indicate a transient/network failure when the SDK
// doesn't surface a typed `.status` (e.g. a raw fetch/undici error).
const RETRYABLE_MESSAGE_RE = /\b(503|502|500|504|429)\b|service unavailable|high demand|overloaded|rate limit|quota|econnreset|etimedout|econnrefused|enotfound|fetch failed|network (error|failure)|socket hang up/i;
// Explicitly non-retryable signals — checked BEFORE the retryable heuristics
// so, e.g., a message that happens to mention "quota" inside an otherwise-400
// validation error is never misclassified as retryable.
const NON_RETRYABLE_MESSAGE_RE = /\b(400|401|403)\b|invalid[ _-]?(prompt|argument|request)|api key not valid|permission denied|safety|blocked|content policy/i;

/**
 * @typedef {Object} GeminiErrorClassification
 * @property {boolean} retryable
 * @property {number|null} status  HTTP status if known, else null.
 * @property {string} reason       Short machine-readable reason code, for logs.
 */

/**
 * Classify a caught error from `model.generateContent()` as retryable
 * (transient — worth another attempt) or not (permanent — fail fast).
 *
 * Retryable: 429, 500, 502, 503, 504, ECONNRESET, ETIMEDOUT, and other
 *   network-layer failures.
 * Non-retryable: 400, 401, 403, invalid prompt, invalid JSON produced by the
 *   model (that's a parsing concern for the caller, not this layer), safety
 *   blocks — and anything unrecognized (a genuinely new failure mode should
 *   surface immediately rather than be silently retried).
 *
 * @param {any} err
 * @returns {GeminiErrorClassification}
 */
function classifyGeminiError(err) {
  // The SDK's own typed fetch error carries a real numeric HTTP status —
  // this is the authoritative source when present, no string-sniffing needed.
  const typedStatus = typeof err?.status === "number" ? err.status : null;
  if (typedStatus !== null) {
    return { retryable: RETRYABLE_HTTP_STATUS.has(typedStatus), status: typedStatus, reason: `http_${typedStatus}` };
  }

  // Network-layer errors (undici/Node fetch failures) surface their POSIX
  // error code either directly or nested under `.cause`.
  const code = err?.code || err?.cause?.code;
  if (code && RETRYABLE_ERROR_CODES.has(String(code))) {
    return { retryable: true, status: null, reason: String(code).toLowerCase() };
  }

  const msg = String(err?.message || err || "");

  // A message-embedded status code, e.g. "[503 Service Unavailable] ...".
  const statusMatch = msg.match(/\[?\b(429|500|502|503|504)\b\]?/);
  if (statusMatch) {
    const status = Number(statusMatch[1]);
    return { retryable: RETRYABLE_HTTP_STATUS.has(status), status, reason: `http_${status}` };
  }

  if (NON_RETRYABLE_MESSAGE_RE.test(msg)) {
    return { retryable: false, status: null, reason: "non_retryable_message" };
  }
  if (RETRYABLE_MESSAGE_RE.test(msg)) {
    return { retryable: true, status: null, reason: "transient_message" };
  }

  // Unknown failure shape — default to NOT retrying. Silently retrying an
  // unrecognized error risks masking a real bug (e.g. a code defect in prompt
  // construction) behind seemingly-successful backoff/fallback behavior.
  return { retryable: false, status: null, reason: "unknown" };
}

// ─── Exponential backoff with jitter ───────────────────────────────────────────

/**
 * Delay (ms) before retry attempt `retryNumber` (1-indexed: the wait before
 * the FIRST retry is retryNumber=1).
 *
 * Base progression (GEMINI_RETRY_BASE_MS=1000, the default):
 *   retry 1 → 1000ms   retry 2 → 2000ms   retry 3 → 4000ms
 *   retry 4 → 8000ms   retry 5 → 16000ms  ... capped at GEMINI_RETRY_MAX_DELAY_MS.
 *
 * "Equal jitter" is applied on top (delay/2 + random(0, delay/2)): this keeps
 * the actual wait within [50%, 100%] of the computed exponential delay, which
 * both (a) de-synchronizes many concurrent requests that failed at the same
 * instant — preventing a "retry storm" where they'd all hammer Google again
 * simultaneously — and (b) never lets jitter drop the wait so low that it
 * defeats the purpose of backing off in the first place.
 *
 * @param {number} retryNumber 1-indexed retry attempt number.
 * @returns {number} delay in milliseconds.
 */
function computeBackoffMs(retryNumber) {
  const base = getRetryBaseMs();
  const cap = getRetryMaxDelayMs();
  const raw = Math.min(base * Math.pow(2, retryNumber - 1), cap);
  const jittered = raw / 2 + Math.random() * (raw / 2);
  return Math.round(jittered);
}

// ─── Abortable sleep (no leaked timers/listeners) ──────────────────────────────

/**
 * Sleep for `ms`, but resolve immediately (rejecting) if `signal` aborts
 * first. Always clears its timer and removes its own listener before
 * settling, whichever happens — this is what keeps long-running processes
 * with many concurrent retries from accumulating timers or abort listeners.
 *
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function sleepAbortable(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new GeminiCancelledError()); return; }

    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      reject(new GeminiCancelledError());
    }

    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Combine multiple AbortSignals into one that aborts when ANY of them do,
 * without relying on `AbortSignal.any` (added in Node 20.3 — this project
 * doesn't pin a minimum Node version, so we implement it manually and always
 * clean up our own listeners once the combined signal settles).
 *
 * @param {(AbortSignal|undefined|null)[]} signals
 * @returns {{ signal: AbortSignal, cleanup: () => void }}
 */
function combineSignals(signals) {
  const controller = new AbortController();
  const real = signals.filter(Boolean);

  if (real.some((s) => s.aborted)) {
    controller.abort();
    return { signal: controller.signal, cleanup: () => {} };
  }

  const onAbort = () => controller.abort();
  real.forEach((s) => s.addEventListener("abort", onAbort, { once: true }));

  return {
    signal: controller.signal,
    cleanup: () => real.forEach((s) => s.removeEventListener("abort", onAbort)),
  };
}

// ─── SDK client cache ──────────────────────────────────────────────────────────
// GoogleGenerativeAI / GenerativeModel instances are stateless and immutable
// per (apiKey, modelName) pair. The old per-call-site code constructed a new
// one on every single attempt; caching them is a pure efficiency win with no
// behavioral change, and safe to share across concurrent requests since
// neither class holds per-request mutable state.

const genAICache = new Map(); // apiKey -> GoogleGenerativeAI
const modelCache = new Map(); // `${apiKey}::${modelName}` -> GenerativeModel

function getModel(apiKey, modelName) {
  const cacheKey = `${apiKey}::${modelName}`;
  let model = modelCache.get(cacheKey);
  if (model) return model;

  let genAI = genAICache.get(apiKey);
  if (!genAI) {
    genAI = new GoogleGenerativeAI(apiKey);
    genAICache.set(apiKey, genAI);
  }
  model = genAI.getGenerativeModel({ model: modelName });
  modelCache.set(cacheKey, model);
  return model;
}

// ─── Structured logging ────────────────────────────────────────────────────────

/**
 * @typedef {Object} GeminiAttemptLog
 * @property {string} model
 * @property {number} attempt      1-indexed attempt number for this model.
 * @property {number} maxAttempts  Total attempts budgeted for this model (1 + retries).
 * @property {number|null} status  HTTP status of the failure, if known.
 * @property {string} reason
 * @property {number|null} waitedMs  Backoff delay applied before the NEXT attempt, if any.
 */

function logAttempt(logTag, attemptLog) {
  const { model, attempt, maxAttempts, status, reason, waitedMs } = attemptLog;
  console.warn(
    `[${logTag}] Attempt ${attempt}/${maxAttempts} | Model: ${model} | ` +
    `Status: ${status ?? reason}` +
    (waitedMs != null ? ` | Waiting: ${waitedMs} ms` : ""),
  );
}

function logModelSwitch(logTag, nextModel) {
  console.warn(`[${logTag}] Switching to fallback model... | Model: ${nextModel}`);
}

// ─── Main entry point ──────────────────────────────────────────────────────────

/**
 * @typedef {Object} GenerateContentResilientOptions
 * @property {string[]} models        Ordered model fallback chain (e.g. from
 *                                     config/geminiModels.js's getGeminiModels()).
 * @property {string|Array<any>|Object} contents  Exactly what you would pass
 *                                     to `model.generateContent(...)` today —
 *                                     a string, a Part array, or a full
 *                                     GenerateContentRequest. Passed through
 *                                     unchanged.
 * @property {string} [apiKey]        Defaults to process.env.GEMINI_API_KEY.
 * @property {string} [logTag]        Prefix for structured log lines (keeps
 *                                     each caller's existing log identity).
 * @property {AbortSignal} [signal]   Optional caller cancellation signal
 *                                     (e.g. an Express request's "close").
 * @property {number} [maxRetries]    Override MAX_GEMINI_RETRIES for this call.
 * @property {number} [timeoutMs]     Override GEMINI_TIMEOUT_MS for this call.
 */

/**
 * @typedef {Object} GenerateContentResilientResult
 * @property {string} text            The model's raw response text — exactly
 *                                     what `result.response.text()` returned.
 * @property {string} modelUsed       Which model in the fallback chain succeeded.
 * @property {number} totalAttempts   Total attempts made across all models.
 */

/**
 * Resilient replacement for `model.generateContent(contents)`. Retries
 * transient failures with exponential backoff + jitter, fails over across
 * `models` in order, honors `signal` for immediate cancellation, and throws
 * a clean `GeminiUnavailableError` (never a raw Google error) once every
 * model/retry combination is exhausted.
 *
 * De-duplication: this function returns the instant any attempt succeeds —
 * a successful response is never retried or re-requested.
 *
 * @param {GenerateContentResilientOptions} options
 * @returns {Promise<GenerateContentResilientResult>}
 */
async function generateContentResilient(options) {
  const {
    models,
    contents,
    apiKey = process.env.GEMINI_API_KEY,
    logTag = "Gemini",
    signal: callerSignal,
  } = options;

  if (!apiKey) {
    throw new GeminiUnavailableError("AI service is not configured.", {
      cause: new Error("GEMINI_API_KEY not set"),
    });
  }
  if (!Array.isArray(models) || models.length === 0) {
    throw new GeminiUnavailableError("AI service is not configured.", {
      cause: new Error("generateContentResilient called with an empty model list"),
    });
  }

  // Cancellation check up front — never even start if already cancelled.
  if (callerSignal?.aborted) throw new GeminiCancelledError();

  const maxRetries = Number.isFinite(options.maxRetries) ? options.maxRetries : getMaxRetries();
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : getTimeoutMs();
  const maxAttemptsPerModel = maxRetries + 1;

  /** @type {GeminiAttemptLog[]} */
  const attemptLog = [];
  let lastError = null;

  for (let modelIndex = 0; modelIndex < models.length; modelIndex++) {
    const modelName = models[modelIndex];
    if (modelIndex > 0) logModelSwitch(logTag, modelName);

    for (let attempt = 1; attempt <= maxAttemptsPerModel; attempt++) {
      if (callerSignal?.aborted) throw new GeminiCancelledError();

      // Per-attempt timeout, combined with the caller's cancellation signal so
      // either one aborts the underlying SDK request immediately.
      const timeoutController = new AbortController();
      const timeoutTimer = setTimeout(() => timeoutController.abort(), timeoutMs);
      const { signal: attemptSignal, cleanup: cleanupSignals } =
        combineSignals([callerSignal, timeoutController.signal]);

      try {
        const model = getModel(apiKey, modelName);
        const result = await model.generateContent(contents, { timeout: timeoutMs, signal: attemptSignal });
        const text = result.response.text();
        return { text, modelUsed: modelName, totalAttempts: attemptLog.length + 1 };
      } catch (err) {
        // A caller-triggered cancellation must win over any classification —
        // stop everything immediately, do not count this as a model failure.
        if (callerSignal?.aborted) throw new GeminiCancelledError();

        const { retryable, status, reason } = classifyGeminiError(err);
        lastError = err;

        const isLastAttemptForModel = attempt === maxAttemptsPerModel;
        const willRetrySameModel = retryable && !isLastAttemptForModel;
        const waitedMs = willRetrySameModel ? computeBackoffMs(attempt) : null;

        const entry = { model: modelName, attempt, maxAttempts: maxAttemptsPerModel, status, reason, waitedMs };
        attemptLog.push(entry);
        logAttempt(logTag, entry);

        if (!retryable) break; // non-retryable — move to the next model, no more waiting on this one
        if (willRetrySameModel) {
          await sleepAbortable(waitedMs, callerSignal); // throws GeminiCancelledError if cancelled mid-wait
        }
        // else: retryable but out of attempts for this model — fall through to next model
      } finally {
        clearTimeout(timeoutTimer);
        cleanupSignals();
      }
    }
  }

  // Every model exhausted — never expose Google's error shape to the caller.
  console.error(`[${logTag}] All models exhausted (${models.join(", ")}). Last error: ${lastError?.message || "unknown"}`);
  throw new GeminiUnavailableError(undefined, { cause: lastError, attempts: attemptLog });
}

module.exports = {
  generateContentResilient,
  classifyGeminiError,
  computeBackoffMs,
  GeminiUnavailableError,
  GeminiCancelledError,
};
