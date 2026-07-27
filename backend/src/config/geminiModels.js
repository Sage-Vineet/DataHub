// ============================================================================
// Gemini model selection — centralized, environment-driven.
//
// Historically every Gemini caller hardcoded its own model list with
// "gemini-2.5-flash-lite" fixed as the primary. This module makes the model
// DYNAMICALLY selectable via environment variables, while preserving each
// caller's tuned fallback order when no override is set.
//
// Selection precedence (first that applies wins):
//   1. GEMINI_MODELS  — comma-separated ordered list (full override of the chain)
//        e.g.  GEMINI_MODELS="gemini-2.5-flash,gemini-2.0-flash"
//   2. GEMINI_MODEL   — a single primary model; the caller's defaults are kept
//        as fallbacks after it, so resilience is retained.
//        e.g.  GEMINI_MODEL="gemini-2.5-flash"
//   3. The caller's own default list (or DEFAULT_GEMINI_MODELS).
//
// No company/account/report hardcoding — pure configuration.
// ============================================================================

"use strict";

// The historical default fallback chain. Callers may pass their own tuned order.
// NOTE: "gemini-2.0-flash" was removed — Google decommissioned it and the API now
// returns "404 model no longer available", which as the LAST fallback turned any
// upstream failure into a hard error (and masked the real cause). Keep only
// currently-available models here.
const DEFAULT_GEMINI_MODELS = Object.freeze([
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
]);

function parseList(value) {
  return String(value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const m of list) {
    if (!seen.has(m)) {
      seen.add(m);
      out.push(m);
    }
  }
  return out;
}

/**
 * Resolve the ordered list of Gemini models to try.
 * @param {string[]} [callerDefaults] this caller's tuned default order; used when
 *   no environment override is present. Falls back to DEFAULT_GEMINI_MODELS.
 * @returns {string[]} non-empty ordered model list.
 */
function getGeminiModels(callerDefaults) {
  const base =
    Array.isArray(callerDefaults) && callerDefaults.length
      ? callerDefaults.slice()
      : DEFAULT_GEMINI_MODELS.slice();

  const envList = parseList(process.env.GEMINI_MODELS);
  if (envList.length) return dedupe(envList);

  const single = String(process.env.GEMINI_MODEL || "").trim();
  if (single) return dedupe([single, ...base]);

  return dedupe(base);
}

/**
 * Convenience: the single primary model to use for one-shot calls.
 * @param {string[]} [callerDefaults]
 * @returns {string}
 */
function getPrimaryGeminiModel(callerDefaults) {
  return getGeminiModels(callerDefaults)[0];
}

module.exports = {
  DEFAULT_GEMINI_MODELS,
  getGeminiModels,
  getPrimaryGeminiModel,
};
