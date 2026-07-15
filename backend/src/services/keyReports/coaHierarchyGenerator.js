// ============================================================================
// COA Hierarchy Generator — AI-BUILT multi-level hierarchy (client request
// 2026-07-14: "if no COA file is uploaded, AI creates the COA and fills all
// levels").
//
// This is the second-line hierarchy source. The order of precedence for a
// generated account's hierarchy is:
//   1. An uploaded / reference COA workbook match (coaMappingService) — copied
//      verbatim. Highest priority; an uploaded COA is always authoritative.
//   2. THIS generator — when there is no workbook match, Gemini generates a full
//      reporting category PATH (statement-section root → sub-categories) for the
//      account, so the Chart of Accounts is a real multi-level tree even when no
//      COA workbook was provided.
//   3. needs_mapping — only when the AI is unavailable/uncertain.
//
// The generator returns the PARENT path only (never the account's own name); the
// caller appends the real account name as the leaf, so the leaf label is always
// the genuine account, never a paraphrase. The Level-1 section root is enforced
// in code by accountType so every branch is anchored consistently.
//
// Non-fatal: any failure (no API key, quota, malformed JSON) leaves the account
// unresolved so the caller marks it needs_mapping — exactly as before this
// generator existed.
// ============================================================================

"use strict";

const { callGeminiText, parseJsonFromText } = require("./geminiCoaClassifier");
const { supabase } = require("../../db");

const GEN_BATCH_SIZE = 40;
const MAX_LEVELS = 15;
// Reuses the classifier cache table with a distinct classifier_version, so no
// new migration is required. Stabilises hierarchies across re-generates and
// avoids re-calling Gemini for accounts already placed. Bump to invalidate.
const HIER_CACHE_VERSION = "coa-hierarchy-v1";
const MIN_CONFIDENCE = 0.5;

// Canonical Level-1 section root per accountType — enforced in code so the top
// of every branch is consistent regardless of Gemini's wording. These labels
// also carry the section keywords financialStatementService relies on.
const SECTION_ROOT = {
  income: "Total Revenue",
  cogs: "Total Cost of Goods Sold",
  expense: "Total Expenses",
  asset: "Total Assets",
  liability: "Total Liabilities",
  equity: "Total Equity",
};

function cacheEnabled() {
  return String(process.env.KEY_REPORT_COA_CACHE || "on").toLowerCase() !== "off";
}

// Fill `out` with any cached hierarchies for the given accounts; return the
// subset still needing AI. Company-scoped; degrades to "generate everything" if
// disabled, no companyId, or the cache table is absent.
async function primeFromCache(companyId, list, out) {
  if (!cacheEnabled() || !companyId) return list;
  try {
    const keys = [...new Set(list.map((a) => a.key).filter(Boolean))];
    if (!keys.length) return list;
    const cached = new Map();
    const CHUNK = 200;
    for (let i = 0; i < keys.length; i += CHUNK) {
      const { data, error } = await supabase
        .from("key_report_coa_classification_cache")
        .select("normalized_name, classification")
        .eq("company_id", companyId)
        .eq("classifier_version", HIER_CACHE_VERSION)
        .in("normalized_name", keys.slice(i, i + CHUNK));
      if (error) return list; // table missing / error → no cache
      for (const row of data || []) {
        if (row?.normalized_name && Array.isArray(row.classification?.path)) {
          cached.set(row.normalized_name, row.classification);
        }
      }
    }
    if (!cached.size) return list;
    const misses = [];
    for (const a of list) {
      const hit = cached.get(a.key);
      if (hit) out.set(a.key, hit);
      else misses.push(a);
    }
    return misses;
  } catch {
    return list; // never block generation on a cache error
  }
}

async function writeCache(companyId, entries) {
  if (!cacheEnabled() || !companyId || !entries.length) return;
  try {
    const now = new Date().toISOString();
    const rows = entries.map((e) => ({
      company_id: companyId,
      normalized_name: e.key,
      classifier_version: HIER_CACHE_VERSION,
      classification: e.value,
      updated_at: now,
    }));
    const CHUNK = 200;
    for (let i = 0; i < rows.length; i += CHUNK) {
      await supabase
        .from("key_report_coa_classification_cache")
        .upsert(rows.slice(i, i + CHUNK), { onConflict: "company_id,normalized_name,classifier_version" });
    }
  } catch {
    // Non-fatal — caching is an optimization, never a correctness dependency.
  }
}

function buildPrompt(batch) {
  const lines = batch
    .map((a) => `- key="${a.key}" name="${a.accountName}" type="${a.accountType || "unknown"}"`)
    .join("\n");

  return `You are a Certified Public Accountant building a company's Chart of Accounts
hierarchy from its General Ledger, Profit & Loss and Balance Sheet accounts.

For EACH account below, return the REPORTING CATEGORY PATH it belongs under: an
ordered list of parent category labels from the top statement section down to the
account's IMMEDIATE parent. Do NOT include the account's own name in the path —
it is appended automatically as the leaf.

Rules for the path:
  • The FIRST element MUST be exactly one of these section roots, by type:
      income     -> "Total Revenue"
      cogs       -> "Total Cost of Goods Sold"
      expense    -> "Total Expenses"
      asset      -> "Total Assets"
      liability  -> "Total Liabilities"
      equity     -> "Total Equity"
  • For ASSET accounts the SECOND element MUST be one of:
      "Current Assets", "Fixed Assets", or "Other Assets".
    (Cash/bank/AR/inventory/prepaid -> Current Assets; property/equipment/
     vehicles -> Fixed Assets; goodwill/intangibles/long-term deposits -> Other Assets.)
  • For LIABILITY accounts the SECOND element MUST be one of:
      "Current Liabilities" or "Long-Term Liabilities".
    (AP/credit cards/accrued/short-term -> Current; loans/notes payable >1yr -> Long-Term.)
  • Then add 1-2 further standard, human-readable sub-category levels that GROUP
    similar accounts, e.g. "Bank Accounts", "Vehicles", "Operating Expenses",
    "Vehicle & Travel", "Payroll & Benefits", "Credit Cards", "Loans Payable",
    "Professional Services", "Rent & Utilities".
  • Use CONSISTENT category names so similar accounts share the SAME path (every
    bank account under one "Bank Accounts", every vehicle fuel/repair under one
    "Vehicle & Travel", etc.).
  • 2 to 4 levels per path. Never fewer than 2. NEVER include the account name.

Return STRICT JSON only — no markdown, no prose:
{
  "hierarchies": [
    { "key": "<echo exactly>", "path": ["Total Expenses", "Operating Expenses", "Vehicle & Travel"], "confidence": 0.9 }
  ]
}

Accounts:
${lines}`;
}

// Enforce the canonical section root by type and cap depth. Gemini may vary the
// root wording or omit it — we normalise here so every branch is anchored.
function sanitizePath(rawPath, accountType) {
  if (!Array.isArray(rawPath)) return null;
  let path = rawPath.map((s) => String(s || "").trim()).filter(Boolean);
  if (!path.length) return null;
  const root = SECTION_ROOT[accountType];
  if (root) {
    if (path[0] !== root) path = [root, ...path.filter((l) => l !== root)];
    // collapse any accidental repeat of the root deeper in the path
    path = path.filter((lvl, i) => !(i > 0 && lvl === root));
  }
  // Leave room for the leaf the caller appends.
  if (path.length > MAX_LEVELS - 1) path = path.slice(0, MAX_LEVELS - 1);
  return path.length ? path : null;
}

/**
 * Generate a parent category path for each unmatched account.
 *
 * @param {Array<{key: string, accountName: string, accountType?: string}>} accounts
 *   key         — stable per-account key (normName(accountName)); used for cache + echo
 *   accountName — display name (AI-normalized preferred)
 *   accountType — one of the 6 types (drives the enforced section root)
 * @param {{companyId?: string|null}} [opts]
 * @returns {Promise<Map<string, {path: string[], confidence: number}>>}
 */
async function generateHierarchiesForAccounts(accounts, opts = {}) {
  const out = new Map();
  const companyId = opts.companyId || null;
  const list = (accounts || []).filter((a) => a && a.key);
  if (!list.length) return out;

  const remaining = await primeFromCache(companyId, list, out);
  const reused = out.size;
  if (!remaining.length) {
    console.log(`[CoaHierarchyGen] ${list.length} account(s) → all ${reused} served from cache (0 AI calls).`);
    return out;
  }
  if (!process.env.GEMINI_API_KEY) {
    console.log(`[CoaHierarchyGen] GEMINI_API_KEY not set — ${remaining.length} account(s) left for manual mapping (${reused} reused).`);
    return out;
  }

  const toStore = [];
  let failedBatches = 0;
  for (let i = 0; i < remaining.length; i += GEN_BATCH_SIZE) {
    const batch = remaining.slice(i, i + GEN_BATCH_SIZE);
    const typeByKey = new Map(batch.map((a) => [a.key, a.accountType || null]));
    try {
      const text = await callGeminiText(buildPrompt(batch));
      const parsed = parseJsonFromText(text);
      const rows = Array.isArray(parsed?.hierarchies) ? parsed.hierarchies : [];
      for (const r of rows) {
        const key = String(r?.key || "").trim();
        if (!key || !typeByKey.has(key)) continue;
        const confidence = Math.min(1, Math.max(0, Number(r.confidence) || 0));
        if (confidence < MIN_CONFIDENCE) continue;
        const path = sanitizePath(r.path, typeByKey.get(key));
        if (!path) continue;
        const value = { path, confidence };
        out.set(key, value);
        if (companyId) toStore.push({ key, value });
      }
    } catch (err) {
      failedBatches += 1;
      console.warn(`[CoaHierarchyGen] batch ${Math.floor(i / GEN_BATCH_SIZE) + 1} failed: ${err.message}`);
    }
  }

  await writeCache(companyId, toStore);
  console.log(
    `[CoaHierarchyGen] ${list.length} account(s) → ${out.size} hierarchies generated ` +
    `(${reused} reused, ${remaining.length} sent to AI)` +
    (failedBatches ? `, ${failedBatches} batch(es) failed` : ""),
  );
  return out;
}

module.exports = { generateHierarchiesForAccounts, SECTION_ROOT };
