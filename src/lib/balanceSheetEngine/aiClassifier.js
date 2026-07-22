// Layer 12 — AI classification. The absolute last resort: invoked ONLY for
// accounts that every deterministic layer (1–11) failed to place, and only
// from the async engine entry point (`restructureBalanceSheetTreeAsync`) —
// a synchronous React render can never call out to a model.
//
// This module defines the contract and ships a safe no-op default. Wiring a
// real model call (e.g. reusing the backend's Gemini-based COA classifier —
// see backend/src/services/keyReports/geminiCoaClassifier.js — behind a new
// endpoint) is a deliberate integration decision left to the caller: pass
// `classifyWithAI` to `restructureBalanceSheetTreeAsync`. Without it, AI is
// disabled and unresolved accounts fall through to the engine's
// "Other <Section>" catch-all instead of hanging on an unconfigured call.

/** Default AI classifier: disabled. */
export async function noopAIClassifier() {
  return new Map();
}

/**
 * Runs the AI layer for a batch of still-unresolved items and writes every
 * confident result into the history cache (Layer 10) so it is never sent to
 * AI again for this account.
 *
 * @param {Array} items             unresolved item contexts ({ node, section, subsectionHint, meta })
 * @param {Function} classifyWithAI async (requests) => Map<key, { label, subsection, confidence }>
 *   requests: [{ key, name, section, subsectionHint }] — `key` is the historyCacheKey for that item.
 * @param {object} historyCache     from createHistoryCache()
 * @param {Function} keyFor         (name, meta) => cache key (pass historyCacheKey)
 * @param {number} minConfidence    results below this are not cached, so they stay eligible for retry
 * @returns {Promise<Map<string, { label: string, subsection: string|null }>>}
 */
export async function runAIClassificationLayer(items, classifyWithAI, historyCache, keyFor, minConfidence = 0.75) {
  if (!items.length || typeof classifyWithAI !== "function") return new Map();

  const requests = items.map((item) => ({
    key: keyFor(item.node?.name, item.meta),
    name: item.node?.name || "",
    section: item.section,
    subsectionHint: item.subsectionHint || null,
  }));

  let results;
  try {
    results = await classifyWithAI(requests);
  } catch (err) {
    console.warn("[BalanceSheetEngine] AI classification layer failed:", err);
    return new Map();
  }
  if (!(results instanceof Map)) return new Map();

  for (const [key, value] of results.entries()) {
    if (value?.label && Number(value.confidence ?? 1) >= minConfidence) {
      historyCache.set(key, { label: value.label, subsection: value.subsection || null });
    }
  }
  return results;
}
