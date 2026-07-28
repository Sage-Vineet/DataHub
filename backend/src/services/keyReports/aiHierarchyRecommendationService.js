// ============================================================================
// AI Hierarchy Recommendation Engine
//
// Runs strictly AFTER the deterministic Chart of Accounts has been fully
// generated and validated. This layer is advisory-only:
//
//   - It NEVER classifies Balance Sheet vs P&L.
//   - It NEVER decides/changes an account's type or statement type.
//   - It NEVER moves an account, overwrites hierarchy, or writes to
//     chart_of_accounts directly.
//   - It NEVER touches balances or GL mappings.
//
// Its only job is to read the already-generated, already-authoritative
// hierarchy and propose OPTIONAL roll-up improvements (e.g. "Interest
// Income" sitting bare under the generic "Income" anchor with no
// distinguishing category — conventionally reported separately from
// operating revenue). Every proposal is stored as its own row in
// key_report_coa_hierarchy_recommendations with status "pending"; nothing
// is applied until a user explicitly accepts it (see acceptRecommendation
// below), and even then only through the SAME updateAccountHierarchy path
// the manual "Edit Chart of Accounts" grid already uses.
// ============================================================================

const { GoogleGenerativeAI } = require("@google/generative-ai");
const { getGeminiModels } = require("../../config/geminiModels");
const { supabase } = require("../../db");

const GEMINI_MODELS = getGeminiModels(["gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-2.0-flash"]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MAX_LEVELS = 15;
const BATCH_SIZE = 40;
const TABLE = "key_report_coa_hierarchy_recommendations";

// In-scope account types for this MVP pass — the concrete, motivating cases
// (Interest Income sitting bare under "Income", Interest Paid sitting bare
// under "Expenses") are P&L presentation conventions (operating vs
// non-operating). Never touches asset/liability/equity accounts, and never
// reclassifies an account's own type — this list only selects WHICH already-
// classified accounts get reviewed for a hierarchy suggestion.
const REVIEWABLE_TYPES = new Set(["income", "cogs", "expense"]);

async function callGeminiText(prompt) {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not set");
  let lastError = null;
  for (const modelName of GEMINI_MODELS) {
    let retries = 2;
    while (retries > 0) {
      try {
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ model: modelName });
        const result = await model.generateContent([{ text: prompt }]);
        return result.response.text();
      } catch (err) {
        lastError = err;
        const msg = String(err?.message || err);
        const isQuota = msg.includes("429") || msg.toLowerCase().includes("quota");
        const isNotFound = msg.includes("404") || msg.toLowerCase().includes("not found");
        console.warn(`[AiHierarchyReco] Model ${modelName} failed: ${msg}`);
        if (isNotFound) break;
        if (isQuota && retries > 1) { await sleep(3000); retries -= 1; } else break;
      }
    }
  }
  throw new Error(`AI hierarchy recommendation call failed: ${String(lastError?.message || "unknown")}`);
}

function parseJsonFromText(text = "") {
  const cleaned = String(text)
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  return JSON.parse(cleaned);
}

// chartOfAccountsService.js's padLevelsWithLeafPropagation fills every level
// past a leaf's real depth by repeating its deepest real value (so every row
// has a full 15-column shape) — collapse those trailing repeats back down to
// their single real occurrence, or every leaf would look like it has 5+
// meaningless extra "levels" of its own name, corrupting both what the AI
// sees and how acceptRecommendation() inserts the new roll-up.
function columnsToLevels(row) {
  const levels = [];
  for (let i = 0; i < MAX_LEVELS; i += 1) levels.push(row[`level_${i + 1}`] || null);
  const nonNull = levels.filter(Boolean);
  while (nonNull.length > 1 && nonNull[nonNull.length - 1] === nonNull[nonNull.length - 2]) {
    nonNull.pop();
  }
  return nonNull;
}

function displayName(row) {
  return row.adjusted_name || row.base_account || row.account_name;
}

/** Every non-group, non-user-modified P&L leaf for this version. A leaf the
 * user (or a previously accepted recommendation) already customized is
 * skipped — its hierarchy is intentionally sticky, same rule the COA
 * generator itself already applies on regenerate. */
async function loadReviewableLeaves(versionId) {
  const cols = ["id", "account_name", "adjusted_name", "base_account", "account_type", "statement_type", "hierarchy_path", "metadata",
    ...Array.from({ length: MAX_LEVELS }, (_, i) => `level_${i + 1}`)].join(", ");
  const { data, error } = await supabase
    .from("chart_of_accounts")
    .select(cols)
    .eq("version_id", versionId)
    .eq("is_active", true);
  if (error) throw error;
  return (data || []).filter((r) =>
    !r.metadata?.is_group &&
    !r.metadata?.user_modified &&
    REVIEWABLE_TYPES.has(r.account_type),
  );
}

function buildPrompt(batch) {
  const lines = batch.map((a) => `- id="${a.id}" name="${a.name}" type="${a.accountType}" hierarchy="${a.hierarchy.join(" > ")}"`);
  return `You are a CPA reviewing an ALREADY-GENERATED, ALREADY-CORRECT Chart of Accounts hierarchy for a single company's Profit & Loss accounts. The hierarchy shown for each account is real and authoritative — you are NEVER being asked to classify, reclassify, or verify account type. Your ONLY job is to spot accounts that would read better on a financial statement with one additional, more specific roll-up category inserted directly above them, and propose it.

The classic case: an account that is conventionally presented SEPARATELY from core operating activity (e.g. Interest Income, Interest Expense, Gain/Loss on Sale of Assets, Foreign Exchange Gain/Loss, Other Income, Other Expense) currently sits with NO distinguishing category of its own — its hierarchy shows it landing directly under a broad, generic anchor like "Income" or "Expenses" with nothing more specific in between. For these, recommend inserting ONE new roll-up label directly above the account (its own name, or a short conventional label like "Interest Income"/"Interest Expense"/"Other Income"/"Other Expense") between it and its current immediate parent.

Do NOT recommend anything for an account that already has a real, specific category above it (e.g. an expense already grouped under "Operating Expense", "Utilities", "Payroll", "Cost of Goods Sold", or any other already-meaningful label a document or prior classification gave it) — only flag accounts that are bare/ungrouped under a generic top-level anchor.

Never recommend more than one new level per account. Never suggest merging, deleting, renaming an existing category, or changing anything about a Balance Sheet account (none are shown to you at all). If you find nothing worth recommending, return an empty "recommendations" array — do not force a suggestion.

Accounts to review:
${lines.join("\n")}

Return STRICT JSON only — no markdown, no prose:
{
  "recommendations": [
    {
      "id": "<echo the account id exactly>",
      "recommendedRollup": "Interest Income",
      "recommendedParent": "<the exact label from that account's own hierarchy this rollup should sit directly under>",
      "confidence": 0.94,
      "reason": "<one sentence — why this improves financial statement presentation>"
    }
  ]
}`;
}

/**
 * Analyze the fully-generated COA for one version and store hierarchy
 * improvement suggestions. Never writes to chart_of_accounts. Idempotent:
 * re-running upserts onto the same (version_id, account_id,
 * recommended_rollup) row rather than duplicating, and never touches a row
 * a user already accepted or ignored for a DIFFERENT rollup suggestion on
 * the same account (each distinct suggestion is its own row).
 *
 * @returns {Promise<{accountsReviewed:number, recommendations:number, highConfidence:number, mediumConfidence:number, applied:number, ignored:number}>}
 */
async function generateRecommendations(companyId, versionId) {
  const leaves = await loadReviewableLeaves(versionId);
  const reviewInput = leaves
    .map((r) => ({ id: r.id, name: displayName(r), accountType: r.account_type, hierarchy: columnsToLevels(r) }))
    .filter((r) => r.hierarchy.length >= 2); // need at least [parent, ownName] to evaluate

  const summary = { accountsReviewed: reviewInput.length, recommendations: 0, highConfidence: 0, mediumConfidence: 0, applied: 0, ignored: 0 };

  if (!reviewInput.length) {
    logSummary(summary);
    return summary;
  }

  if (!process.env.GEMINI_API_KEY) {
    console.warn("[AiHierarchyReco] GEMINI_API_KEY not set — skipping recommendation generation.");
    logSummary(summary);
    return summary;
  }

  const byId = new Map(reviewInput.map((r) => [r.id, r]));
  const proposals = [];
  for (let i = 0; i < reviewInput.length; i += BATCH_SIZE) {
    const batch = reviewInput.slice(i, i + BATCH_SIZE);
    try {
      const text = await callGeminiText(buildPrompt(batch));
      const parsed = parseJsonFromText(text);
      const rows = Array.isArray(parsed?.recommendations) ? parsed.recommendations : [];
      for (const r of rows) {
        const accountId = String(r?.id || "").trim();
        const rollup = String(r?.recommendedRollup || "").trim();
        if (!accountId || !rollup || !byId.has(accountId)) continue;
        proposals.push({
          accountId,
          recommendedRollup: rollup,
          recommendedParent: String(r?.recommendedParent || "").trim() || null,
          confidence: Math.min(1, Math.max(0, Number(r?.confidence) || 0)),
          reason: String(r?.reason || "").trim() || null,
        });
      }
    } catch (err) {
      console.warn(`[AiHierarchyReco] batch ${i / BATCH_SIZE + 1} failed: ${err.message}`);
    }
  }

  for (const p of proposals) {
    const leaf = byId.get(p.accountId);
    // `status` is deliberately omitted from this payload: on a conflict,
    // Supabase/Postgres' ON CONFLICT DO UPDATE only touches the columns
    // actually present here, so a row a user already accepted/ignored keeps
    // its status untouched — a fresh AI pass can never silently reopen a
    // decision already made. Only a genuinely NEW (account, rollup) pair
    // gets INSERTed with the table's default status='pending'.
    const { error } = await supabase
      .from(TABLE)
      .upsert(
        {
          version_id: versionId,
          company_id: companyId,
          account_id: p.accountId,
          current_hierarchy: leaf.hierarchy,
          recommended_rollup: p.recommendedRollup,
          recommended_parent: p.recommendedParent,
          confidence: p.confidence,
          reason: p.reason,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "version_id,account_id,recommended_rollup", ignoreDuplicates: false },
      );
    if (error) {
      console.warn(`[AiHierarchyReco] Failed to store recommendation for account ${p.accountId}: ${error.message}`);
      continue;
    }
    summary.recommendations += 1;
    if (p.confidence >= 0.85) summary.highConfidence += 1;
    else if (p.confidence >= 0.7) summary.mediumConfidence += 1;
  }

  const { count: applied } = await supabase.from(TABLE).select("id", { count: "exact", head: true }).eq("version_id", versionId).eq("status", "accepted");
  const { count: ignored } = await supabase.from(TABLE).select("id", { count: "exact", head: true }).eq("version_id", versionId).eq("status", "ignored");
  summary.applied = applied || 0;
  summary.ignored = ignored || 0;

  logSummary(summary);
  return summary;
}

function logSummary(s) {
  console.log(
    "==================================\n" +
    "AI Hierarchy Recommendation Summary\n" +
    "==================================\n\n" +
    `Accounts Reviewed : ${s.accountsReviewed}\n\n` +
    `Recommendations : ${s.recommendations}\n\n` +
    `High Confidence : ${s.highConfidence}\n\n` +
    `Medium Confidence : ${s.mediumConfidence}\n\n` +
    `Applied : ${s.applied}\n\n` +
    `Ignored : ${s.ignored}\n\n` +
    "==================================",
  );
}

async function listRecommendations(versionId) {
  const { data, error } = await supabase
    .from(TABLE)
    .select("*, chart_of_accounts!inner(account_name, adjusted_name, base_account, hierarchy_path)")
    .eq("version_id", versionId)
    .order("confidence", { ascending: false });
  if (error) throw error;
  return (data || []).map((r) => ({
    id: r.id,
    accountId: r.account_id,
    accountName: r.chart_of_accounts?.adjusted_name || r.chart_of_accounts?.base_account || r.chart_of_accounts?.account_name,
    currentHierarchy: r.current_hierarchy,
    recommendedRollup: r.recommended_rollup,
    recommendedParent: r.recommended_parent,
    confidence: r.confidence,
    reason: r.reason,
    status: r.status,
    decidedAt: r.decided_at,
  }));
}

/**
 * Apply ONE recommendation — the ONLY place this whole feature is allowed to
 * touch chart_of_accounts, and it does so exclusively through
 * chartOfAccountsService.updateAccountHierarchy (the same function the
 * manual "Edit Chart of Accounts" grid uses), which only ever writes
 * level_1..level_15/hierarchy_path/base_account and marks the row
 * user_modified — never account_type, statement_type, balances, or GL
 * mappings. Inserts recommendedRollup directly above the account's own
 * name in its CURRENT (re-fetched, not the stale stored snapshot) levels.
 */
async function acceptRecommendation(recommendationId, userId = null) {
  const { data: reco, error: recoErr } = await supabase.from(TABLE).select("*").eq("id", recommendationId).single();
  if (recoErr) throw recoErr;
  if (reco.status === "accepted") return { alreadyAccepted: true };

  const { data: account, error: acctErr } = await supabase
    .from("chart_of_accounts")
    .select(["id", "account_name", "adjusted_name", "base_account", ...Array.from({ length: MAX_LEVELS }, (_, i) => `level_${i + 1}`)].join(", "))
    .eq("id", reco.account_id)
    .single();
  if (acctErr) throw acctErr;

  const currentLevels = columnsToLevels(account);
  if (!currentLevels.length) throw new Error("Account has no current hierarchy to modify.");

  const ownName = displayName(account);
  const alreadyInserted = currentLevels.length >= 2 && currentLevels[currentLevels.length - 2] === reco.recommended_rollup;
  const newLevels = alreadyInserted
    ? currentLevels
    : [...currentLevels.slice(0, -1), reco.recommended_rollup, currentLevels[currentLevels.length - 1]].slice(0, MAX_LEVELS);

  const { updateAccountHierarchy } = require("../../services/chartOfAccountsService");
  await updateAccountHierarchy(reco.account_id, { levels: newLevels, movedParent: true }, userId);

  const { error: updErr } = await supabase
    .from(TABLE)
    .update({ status: "accepted", decided_at: new Date().toISOString(), decided_by: userId, updated_at: new Date().toISOString() })
    .eq("id", recommendationId);
  if (updErr) throw updErr;

  return { alreadyAccepted: false, accountId: reco.account_id, newLevels };
}

async function ignoreRecommendation(recommendationId, userId = null) {
  const { error } = await supabase
    .from(TABLE)
    .update({ status: "ignored", decided_at: new Date().toISOString(), decided_by: userId, updated_at: new Date().toISOString() })
    .eq("id", recommendationId)
    .eq("status", "pending");
  if (error) throw error;
  return { ok: true };
}

module.exports = {
  generateRecommendations,
  listRecommendations,
  acceptRecommendation,
  ignoreRecommendation,
};
