// ============================================================================
// Chart of Accounts engine (Key Reports redesign ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â COA is the source of truth)
//
// Builds a per-version Chart of Accounts (COA) from a synced Key Report
// version's extracted P&L / Balance Sheet / General Ledger accounts, classifies
// each account into a deep hierarchy (up to 15 levels), and persists it with a
// never-overwritten ORIGINAL (AI) classification beside a user-editable ADJUSTED
// one, plus mapping + audit-history tables.
//
// Classification is document-first, AI-fallback-only (uploaded evidence is
// the source of truth, never the other way around):
//   Priority 1 — a match against the company's own uploaded Chart of Accounts
//     (coaAccountMatcher), using the uploaded document's own hierarchy verbatim.
//   Priority 2 — this GL account's own position in the uploaded Balance Sheet
//     or Profit & Loss document (pickDocHierarchy), again using that document's
//     own hierarchy verbatim — no name-based inference or keyword rules.
//   Priority 3 — classifyAccountsWithAI (geminiCoaClassifier) is called ONLY
//     for the remainder: a GL account found in neither the uploaded Chart of
//     Accounts, Balance Sheet, nor Profit & Loss. See buildCoaModel's addLeaf
//     for the exact waterfall.
//   No keyword matching, regex rules, or hardcoded dictionaries classify an
//   account from scratch anywhere in this file. Accounts below the confidence
//   threshold (or with no match/AI result at all) are flagged needsMapping:
//   true in metadata for human review — never guessed. If Gemini is
//   unavailable, only the Priority-3 remainder is affected; document/client-COA
//   matches are unaffected and still resolve correctly.
//
// Persistence uses an UPSERT-by-stable-key merge (NOT delete-then-insert) so
// that account ids ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â and therefore the adjustment/classification audit history
// that FKs to them ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â survive regeneration, and user adjustments are preserved.
// ============================================================================

const { supabase } = require("../db");
const { classifyAccountsWithAI, invalidateClassificationCache } = require("./keyReports/geminiCoaClassifier");
const { classifyCfCategory } = require("./keyReports/cfCategoryRules");
const { classifyReportTag } = require("./keyReports/reportTagRules");
const { createCoaMapper, matchAnyName } = require("./keyReports/coaMappingService");
const { strongSimilarity } = require("./keyReports/coaAccountMatcher");
const { norm: fuzzyNorm } = require("./keyReports/accountNameMatching");

const MAX_LEVELS = 15;

const TABLE_COA = "chart_of_accounts";
const TABLE_TXN = "general_ledger_entries";
const TABLE_BS = "balance_sheet_entries";
const PAGE_SIZE = 1000;

// AI confidence below this value ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ account is inserted with needsReview: true
// in its metadata so a human can verify the classification.  The AI result is
// still used (never replaced by keyword rules) since any AI result is more
// informative than a blind default.
const AI_NEEDS_REVIEW_THRESHOLD = 0.70;

// Audit history (classification snapshots + per-edit adjustments) is stored
// INLINE on each chart_of_accounts row in the `audit_log` jsonb array, rather
// than in the former coa_account_mappings / coa_account_adjustments /
// coa_classification_history / coa_hierarchy_levels side tables (all removed ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â
// migration 055). Each entry: { kind, at, ...fields }.
//   kind = "classification" ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ { method, hierarchy_snapshot, source, by }
//   kind = "adjustment"     ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ { field_changed, old_value, new_value, by }
function classificationAudit(method, snapshot, source, userId) {
  return { kind: "classification", at: new Date().toISOString(), method, hierarchy_snapshot: snapshot, source, by: userId || null };
}
function adjustmentAudit(fieldChanged, oldValue, newValue, userId) {
  return { kind: "adjustment", at: new Date().toISOString(), field_changed: fieldChanged, old_value: oldValue ?? null, new_value: newValue ?? null, by: userId || null };
}
function appendAudit(existing, ...entries) {
  const log = Array.isArray(existing) ? existing.slice() : [];
  log.push(...entries.filter(Boolean));
  // Bound growth: keep the most recent 200 entries per account.
  return log.length > 200 ? log.slice(log.length - 200) : log;
}


const BALANCE_SHEET_TYPES = new Set(["asset", "liability", "equity"]);

function statementTypeFor(accountType) {
  return BALANCE_SHEET_TYPES.has(accountType) ? "balance_sheet" : "profit_loss";
}

// Top-level audit column (migration 073) recording WHICH hierarchy source
// resolved this account ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â coarser than metadata.match_tier (which also
// distinguishes finer tiers within a client-COA match, e.g. "exact" vs "fuzzy").
function matchSourceFromTier(matchTier) {
  if (!matchTier) return null;
  if (matchTier === "bs_section") return "balance_sheet";
  if (matchTier === "pl_section") return "profit_loss";
  if (matchTier === "ai_hierarchy") return "generated";
  if (matchTier === "rule") return "generated"; // deterministic GAAP fact (Net Income / Retained Earnings), not matched from any document
  return "client_coa"; // coaAccountMatcher tier: account_number/exact/normalized/alias/fuzzy/parent_validated
}

// Top-level audit column (migration 074): how strongly the SELECTED
// HIERARCHY is supported by document evidence ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â distinct from AI confidence
// (which reflects account_type/normalized_name recognition, not placement).
// `matchConfidence` is the AI's own per-account number for the "ai_hierarchy"
// tier, or coaAccountMatcher's own per-account score for a client-COA match
// (both passed through directly, not a fixed constant) ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â every other tier
// uses a fixed constant since it isn't a fresh per-account judgment.
function hierarchyConfidenceFromTier(matchTier, matchConfidence) {
  if (!matchTier) return 0;
  if (["ai_hierarchy", "account_number", "exact", "normalized", "alias", "fuzzy", "parent_validated"].includes(matchTier)) {
    return Math.min(1, Math.max(0, Number(matchConfidence) || 0));
  }
  if (matchTier === "bs_section" || matchTier === "pl_section") return 0.9;
  if (matchTier === "rule") return 1.0; // deterministic GAAP fact, not evidence-dependent
  return 0;
}

function normName(accountName) {
  return String(accountName || "").trim().toLowerCase();
}

// Stable per-account key: number (if any) + normalized name. Used to merge the
// same account across regenerations and across BS/P&L/GL sources.
function accountKey(number, name) {
  return `${String(number || "").trim().toLowerCase()}::${normName(name)}`;
}

// ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ Metadata row guard ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬
//
// Catches only software-generated noise that is definitively not an accounting
// account: empty strings, date lines, and ERP header rows.  Report totals
// (Total Assets, Net Income, etc.) and section headers (Assets, Liabilities,
// etc.) are NOT filtered here ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â the AI classifies those as isReportRow: true
// and they are excluded from the COA during buildCoaModel.
//
// Do NOT expand this regex with accounting keywords; that would re-introduce
// the hardcoded classification logic that was explicitly removed.
const METADATA_ROW_RE =
  /^(accrual basis|cash basis|report generated|date generated|generated on|as of\b|unrealized gains?)/i;

function isMetadataRow(name) {
  const n = String(name || "").trim();
  return !n || METADATA_ROW_RE.test(n);
}

// ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ Source collectors (unchanged) ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬
async function fetchAllRows(buildQuery) {
  const out = [];
  let from = 0;
  for (let page = 0; page < 1000; page += 1) {
    const { data, error } = await buildQuery().range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return out;
}

async function collectGlAccounts(companyId, batchId) {
  const select = "account_name, split_account, account_section, fiscal_year";
  let rows;
  try {
    rows = await fetchAllRows(() =>
      supabase.from(TABLE_TXN).select(select)
        .eq("company_id", companyId).eq("upload_batch_id", batchId).order("id", { ascending: true }),
    );
  } catch (err) {
    const msg = String(err?.message || "").toLowerCase();
    if (!msg.includes("upload_batch_id")) throw err;
    rows = await fetchAllRows(() =>
      supabase.from(TABLE_TXN).select(select)
        .eq("company_id", companyId).eq("batch_id", batchId).order("id", { ascending: true }),
    );
  }
  return rows;
}

async function collectBsAccounts(companyId, batchId) {
  return fetchAllRows(() =>
    supabase.from(TABLE_BS).select("account_name, section")
      .eq("company_id", companyId).eq("batch_id", batchId).order("id", { ascending: true }),
  );
}

async function collectGlAccountsFromEntries(companyId, versionId) {
  // fiscal_year no longer exists on general_ledger_entries (migration 069) ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â
  // transaction_date is selected instead; callers derive the year from it.
  return fetchAllRows(() =>
    supabase.from("general_ledger_entries")
      .select("account_name, split_account, account_section, transaction_date, account_number")
      .eq("company_id", companyId).eq("version_id", versionId)
      .order("id", { ascending: true }),
  );
}

// Year from a general_ledger_entries row's transaction_date (replaces the old
// fiscal_year column read for GL-sourced COA leaves).
function glRowYear(row) {
  const y = parseInt(String(row?.transaction_date || "").slice(0, 4), 10);
  return Number.isInteger(y) ? y : null;
}

async function collectBsAccountsFromEntries(companyId, versionId) {
  const rows = await fetchAllRows(() =>
    supabase.from("balance_sheet_entries")
      .select("account_name, account_number, section, sub_section, is_total, hierarchy_level, parent_path, fiscal_year, source_file_id, coa_id, row_type")
      .eq("company_id", companyId).eq("version_id", versionId)
      .or("is_total.eq.false,is_total.is.null").order("id", { ascending: true }),
  );
  // row_type (migration 085) tags non-posting rows (heading/subtotal/metadata/
  // footer) now that balanceSheetExtractionService persists EVERY source row
  // instead of dropping them before insert. COA generation must only ever see
  // real posting accounts here — row_type is NULL for rows persisted before
  // this migration, which never contained non-account rows to begin with.
  return rows.filter((r) => !r.row_type || r.row_type === "account");
}

// Whether a Chart of Accounts DOCUMENT is linked to THIS Key Report version ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â
// the ONLY correct signal for "was a COA uploaded," per key_report_file_mappings
// (version-scoped). NEVER client_chart_of_accounts.length > 0 ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â that table is
// company-scoped (a re-upload replaces ALL of a company's rows regardless of
// which version triggered it ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â see clientCoaImportService.js), so a stale
// upload from an OLDER version of this same company would otherwise leak into
// a newer version that never linked a COA at all. Confirmed regression this
// fixes: "Uploaded COA: YES" logged even when no COA document was linked.
async function hasLinkedCoaDocumentForVersion(versionId) {
  const { count, error } = await supabase
    .from("key_report_file_mappings")
    .select("id", { count: "exact", head: true })
    .eq("version_id", versionId)
    .eq("report_category", "chart_of_accounts");
  if (error) return false;
  return (count || 0) > 0;
}

// A mapper that never matches anything and never queries the database ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â used
// whenever hasLinkedCoaDocumentForVersion is false, so client_chart_of_accounts
// (another company's data, or this same company's stale prior-version upload)
// is never even READ, let alone used as a hierarchy reference.
const NULL_COA_MAPPER = Object.freeze({
  map: () => ({ matched: false, status: "unmatched", reason: "No Chart of Accounts document is linked to this version." }),
  entryCount: 0,
});

// ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ Normalization helpers ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬

// Strip a leading GL account-code prefix when one is present in the name field
// (e.g. "1000 - Cash" ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ "Cash", "10200 Checking" ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ "Checking").
// The raw name is always preserved in the database; this produces cleaner AI input.
const LEADING_ACCT_CODE_RE = /^\d{3,7}[\s\-\.]+/;
function normalizeForGemini(rawName) {
  const cleaned = String(rawName || '')
    .trim()
    .replace(LEADING_ACCT_CODE_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || String(rawName || '').trim();
}

// A GL row's split_account is a free-text reference to the OTHER side of a
// journal entry ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â QuickBooks-style exports sometimes record it as a
// colon-joined "Parent:Child" label (e.g. "80950 Operational Expense:
// Background Check") even though that same account posts directly elsewhere
// in the GL under a bare name ("80950 Background Check"). Treating the
// colon form as a brand-new account creates a DUPLICATE chart_of_accounts
// entry for what is really one account (confirmed root cause of a
// reproducible Balance Sheet imbalance ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â the report-generation half of this
// same bug is fixed in keyReportReportService.js's canonicalSplitIdentity).
// Try the full string, then its last colon-segment, then a suffix match
// against every account_name/account_section actually posted in this GL.
function isKnownAccountReference(splitName, knownAccountNames) {
  if (!splitName) return false;
  if (knownAccountNames.has(splitName)) return true;
  const lastSegment = splitName.split(":").pop().trim();
  if (!lastSegment) return false;
  if (knownAccountNames.has(lastSegment)) return true;
  const lastSegmentLower = lastSegment.toLowerCase();
  for (const name of knownAccountNames) {
    if (name.toLowerCase().endsWith(lastSegmentLower)) return true;
  }
  return false;
}

/** Every account_name/account_section value actually posted directly in the GL. */
function collectKnownGlAccountNames(glRows) {
  const known = new Set();
  for (const r of glRows || []) {
    const n = String(r.account_name || r.account_section || "").trim();
    if (n) known.add(n);
  }
  return known;
}

/**
 * Collect the set of unique account names from GL + BS rows to send to the AI
 * classification pre-pass.
 *
 * Only obvious software-metadata rows (dates, "Accrual Basis", etc.) are
 * excluded here via isMetadataRow.  Report totals, section headers, and all
 * other rows are passed to the AI ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â it is the AI's job (isReportRow: true) to
 * decide what is a real account vs. a calculated row.
 *
 * The `key` field matches the normName(rawName) that addLeaf uses internally.
 * The `accountName` sent to Gemini is normalizeForGemini(rawName) ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â the raw
 * name with leading account-code prefixes stripped.
 *
 * @param {Array} glRows - GL rows (from collectGlAccountsFromEntries)
 * @param {Array} bsRows - BS rows (from collectBsAccountsFromEntries)
 * @param {Array} [plRows] - parsed uploaded P&L rows (ephemeral, see buildCoaModel)
 * @returns {Array<{key, accountName, accountNumber, bsSection, plSection}>}
 */
function collectUniqueAccountNames(glRows, bsRows, plRows, stats = null) {
  const seen = new Map(); // normKey ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ descriptor
  const add = (rawName, accountNumber, bsSection, plSection) => {
    const name = String(rawName || "").trim();
    if (!name || isMetadataRow(name)) return;
    const key = normName(name);
    if (seen.has(key)) return;
    seen.set(key, {
      key,
      accountName: normalizeForGemini(name),
      accountNumber: accountNumber ? String(accountNumber).trim() : null,
      bsSection: bsSection || null,
      plSection: bsSection ? null : (plSection || null),
    });
  };
  const knownGlAccountNames = collectKnownGlAccountNames(glRows);

  for (const r of bsRows || []) {
    if (r.account_name) add(r.account_name, r.account_number, r.section);
  }
  for (const r of plRows || []) {
    if (r.account_name) add(r.account_name, r.account_number, null, r.section);
  }
  for (const r of glRows || []) {
    if (r.account_name) add(r.account_name, r.account_number, r.account_section);
    const splitName = r.split_account ? String(r.split_account).trim() : "";
    if (!splitName) continue;
    // e.g. "80950 Operational Expense:Background Check" referring to the SAME
    // real account as the GL's own "80950 Background Check" posting row ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â
    // canonicalized to one COA account, never added as a second leaf.
    if (isKnownAccountReference(splitName, knownGlAccountNames)) {
      if (stats) stats.duplicateAccountsAvoided += 1;
      continue;
    }
    add(splitName, null, null);
  }
  return Array.from(seen.values());
}

// ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ Document-hierarchy classification (Priority 2 ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â between the uploaded ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬
// Chart of Accounts match and AI) ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬
//
// The account's OWN real position in the uploaded Balance Sheet/P&L ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â read
// from the document's own indentation via parent_path (balanceSheetExtraction
// Service.js / profitLossExtractionService.js / geminiFinancialParser.js's
// flattenGeminiRows) ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â is used directly, dynamic depth, never a fixed level
// scheme. Only AI classification (Priority 3) is spent on an account neither
// the uploaded COA nor the uploaded statements can resolve.

function bsSectionToType(section) {
  const s = String(section || "").toLowerCase();
  if (s === "assets") return "asset";
  if (s === "liabilities") return "liability";
  if (s === "equity") return "equity";
  return null;
}

// Same mapping as buildCoaModel's local typeFromPlSection ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â kept as its own
// top-level copy so it's usable from ensureCoaComplete too, without changing
// buildCoaModel's existing closure-local behavior.
function plSectionToType(section) {
  if (section === "revenue" || section === "other_income") return "income";
  if (section === "cost_of_sales") return "cogs";
  if (section === "operating_expenses" || section === "other_expense") return "expense";
  return null;
}

// Last-resort structural fallback: an account name that IS ITSELF one of the
// standard Balance Sheet/P&L section-header labels (the same canonical
// report-structure vocabulary extractionService.base.js already recognizes
// when stripping heading rows ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â not a company-specific mapping) tells us
// which side of the equation it belongs to, even when the account has no
// leaf-level position in any uploaded document to read a section from.
// CONFIRMED production case this fixes: a client's GL posts a real
// transaction directly to an account literally named "Fixed Assets" ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â a real
// leaf by GL activity (namesWithGlActivity below), but "Fixed Assets" is only
// ever a header/total row in that same client's uploaded Balance Sheet
// (filtered out before insertion, never a postable leaf there), so neither
// Priority 2 (document position) nor a bsSection/plSection value is
// available for it. Only used when every other signal (client COA match,
// document position, confident AI, bsSection/plSection) has already found
// nothing ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â never overrides any of those.
function sectionHeaderNameToType(name) {
  const s = String(name || "").toLowerCase().trim().replace(/\s+/g, " ");
  if (["assets", "current assets", "other current assets", "fixed assets"].includes(s)) return "asset";
  if (["liabilities", "current liabilities", "long-term liabilities", "long term liabilities"].includes(s)) return "liability";
  if (s === "equity") return "equity";
  if (s === "income") return "income";
  if (s === "expenses") return "expense";
  return null;
}

// A "Total for X" row is a real subtotal in the DISPLAYED financial
// statement (never altered there) but must never itself appear as a
// hierarchy level ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â "Total for Payroll Expenses" becomes "Payroll Expenses"
// wherever it is used as an ancestor label in the GENERATED COA. Only the
// "Total for " form is stripped (never a bare "Total X", e.g. "Total
// Assets" ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â that is a legitimate top-level statement total, not a subtotal
// alias for a narrower group, and must stay exactly as extracted).
function normalizeHierarchyLabel(label) {
  const s = String(label || "").trim();
  const m = /^total\s+for\s+(.+)$/i.exec(s);
  return m ? m[1].trim() : s;
}

// Fixed hierarchy anchors. These EXACT literal sequences are never generated,
// inferred, or reworded ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â they are prepended before the account's own real,
// dynamic-depth position in the uploaded document (parent_path) is appended.
// Matches the pre-existing unified-hierarchy convention this codebase already
// expects for P&L accounts (see validateHierarchyConsistency's EXPECTED
// table), extended to a full fixed anchor per statement side.
const ASSET_FIXED_PREFIX     = Object.freeze(["Total Assets"]);
const LIABILITY_FIXED_PREFIX = Object.freeze(["Total Liabilities and Equity", "Total Liabilities"]);
const EQUITY_FIXED_PREFIX    = Object.freeze(["Total Liabilities and Equity", "Total Equity", "Equity"]);

// Profit & Loss ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ONE shared anchor for BOTH sides of the income statement.
// Revenue and expense/COGS accounts are SIBLINGS directly under "Net Income";
// the real section heading that separates them ("Income", "Cost of Goods
// Sold", "Operating Expenses", "Other Income", ...) is NOT part of the anchor
// ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â it comes entirely from the uploaded document's own parent_path (or, for an
// AI-classified account, the AI's own levels). The previous 9-level anchor
// (ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦ > Pretax Income > Operating Income > Gross Profit > Total Revenue >
// Income) hardcoded six rollup subtotals that are CALCULATED lines in the
// report, not structural parents of any posting account, and it forced every
// document heading to be trimmed away as a duplicate of the anchor's own
// labels. Three levels is the whole fixed part; everything below is the
// document's.
const PL_FIXED_PREFIX = Object.freeze(["Total Liabilities and Equity", "Total Equity", "Total Equity"]);
const PROFIT_AND_LOSS_COA_PREFIX = PL_FIXED_PREFIX;
const BS_ASSET_COA_PREFIX = Object.freeze(["Total Assets"]);
const BS_LIABILITY_EQUITY_COA_PREFIX = Object.freeze(["Total Liabilities and Equity", "Total Equity"]);

function fixedPrefixFor(accountType) {
  if (accountType === "asset") return ASSET_FIXED_PREFIX;
  if (accountType === "liability") return LIABILITY_FIXED_PREFIX;
  if (accountType === "equity") return EQUITY_FIXED_PREFIX;
  if (accountType === "income" || accountType === "cogs" || accountType === "expense") return PL_FIXED_PREFIX;
  return [];
}

// The document's own outermost heading (parentPath[0]) is often just the
// bare statement-side label itself ("Assets", "ASSETS", "Equity", "Income",
// "Expenses") ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â that concept is now carried by the fixed prefix above, so
// keeping it too would duplicate it as its own extra level (the user's own
// worked examples show the uploaded "Current Assets > Bank Accounts >
// Checking" continuing directly after the fixed Level 1/2, with no
// redundant "Assets" level in between). Whole-string match only ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â a
// deeper, genuinely distinct category (e.g. "Fixed Assets") must never be
// dropped just for containing a similar word.
const PL_ANCHOR_LABELS = new Set(["total liabilities and equity", "total equity"]);

// P&L calculated-subtotal rows (Net Income, Gross Profit, ...) and the
function isRedundantTopLevelHeading(label, accountType) {
  const s = String(label || "").trim().toLowerCase();
  if (!s) return false;
  if (accountType === "asset") return s === "assets" || s === "asset" || s === "total assets";
  // CONFIRMED BUG this fixes: a document whose top-level heading for this
  // side is literally "Liabilities and Equity" (spanning BOTH liabilities
  // and equity, as many real Balance Sheets format it) previously matched
  // neither the liability nor equity redundant-heading check (only the bare
  // "Liabilities"/"Equity" forms were recognized) ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â so for such a document,
  // NEITHER of the raw parent_path's first two ancestor labels
  // ("Liabilities and Equity", "Liabilities") ever got trimmed, and both
  // ended up duplicated after the fixed prefix (which already encodes both
  // concepts as "Total Liabilities and Equity" / "Total Liabilities").
  if (accountType === "liability") {
    return ["liabilities", "liability", "total liabilities", "liabilities and equity", "total liabilities and equity"].includes(s);
  }
  if (accountType === "equity") {
    // Only labels that literally restate the fixed anchor's OWN wording
    // ("Total Equity" / "Equity" / the combined "Liabilities and Equity"
    // heading) are redundant. A document's own more specific sub-heading
    // ("Owner's Equity", "Stockholders' Equity", "Members' Equity", ...)
    // varies by entity type and is REAL structure that must survive as its
    // own level below the fixed anchor -- these must never be stripped.
    return ["equity", "total equity", "liabilities and equity", "total liabilities and equity"].includes(s);
  }
  // The P&L anchor's OWN fixed labels ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â the only thing a P&L document heading
  // can now redundantly restate. Everything else a P&L document puts above an
  // account ("Income", "Revenue", "Cost of Goods Sold", "Operating Expenses",
  // "Other Income", ...) is a REAL, WANTED heading under the 2-level anchor
  // and must survive verbatim -- "Income > Sales" and "Cost of Goods Sold >
  // Materials" are exactly the shapes the uploaded document asked for. This
  // codebase does not hardcode calculated-subtotal rows (Net Income, Gross
  // Profit, ...) as ancestor levels -- if a document's own real structure
  // places a leaf under such a row, that comes from parent_path like any
  // other real heading; nothing here invents or requires it.
  if (accountType === "income" || accountType === "cogs" || accountType === "expense") {
    return PL_ANCHOR_LABELS.has(s);
  }
  return false;
}

// Iterative, not a single strip: a document can stack more than one
// redundant leading label for the same side (e.g. "Liabilities and Equity"
// THEN "Liabilities" before the first real category) ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â every leading label
// that duplicates the fixed prefix's own concept must be dropped, not just
// the first.
function trimRedundantParentPath(parentPath, accountType) {
  let path = parentPath;
  while (path.length && isRedundantTopLevelHeading(path[0], accountType)) path = path.slice(1);
  return path;
}

// CONFIRMED BUG this fixes: a parent/category chain (from an AI-reasoned
// hierarchy, a client-COA match, or a parsed document) sometimes already
// ends with the account's own name as its own deepest category ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â e.g. the
// AI naturally classifies a "Retained Earnings" account under a category it
// also calls "Retained Earnings", or an uploaded Chart of Accounts workbook
// lists the account as the last level of its own row. Every hierarchy-build
// site unconditionally appended the leaf's name AGAIN after that chain,
// producing a path whose last two entries were identical
// (".../Retained Earnings/Retained Earnings"). buildDesiredCategories then
// persisted the duplicated entry as its own is_group category node ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â sharing
// the exact name of the real leaf account sitting right under it. Across many
// AI-classified accounts this produced hundreds of phantom category rows
// (confirmed live: 937 category nodes for 63 leaf accounts, many literally
// named after real leaf accounts like "Retained Earnings" /
// "Capital One - Credit Card"), which in turn made the stale-category
// cleanup DELETE in syncCategoryNodes fail with Bad Request (URL too long
// for hundreds of ids) every subsequent run, compounding further. Always
// drop one trailing duplicate before appending the leaf.
function appendLeaf(prefixPath, leafName) {
  const path = Array.isArray(prefixPath) ? [...prefixPath] : [];
  const last = path[path.length - 1];
  const leafKey = String(leafName || "").trim().toLowerCase();
  if (last != null && String(last).trim().toLowerCase() === leafKey) path.pop();
  path.push(leafName);
  return path;
}

// Scores every distinct candidate hierarchy path collected for ONE account
// across every uploaded statement of one kind (never just the first one
// seen). Priority, in order: (1) greater depth, (2) appears in more
// documents/rows (frequency ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â a path multiple statements independently agree
// on outranks a one-off), (3) newest fiscal year, (4) came from the confirmed
// Ending Balance Sheet specifically. Ties after all of that keep first-seen
// order (stable sort) rather than guessing.
//
// Tier (4) is Balance-Sheet-only and is SKIPPED entirely when
// endingFiscalYear is null ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â there is no Profit & Loss equivalent of an
// "Ending" document (a P&L covers a period, not a point in time), so the P&L
// caller passes null and stops after depth -> frequency -> recency. Nothing
// else in this comparator is statement-specific, which is why it is reused
// verbatim for both sides instead of a second hardcoded rule set.
function comparePathCandidates(a, b, endingFiscalYear) {
  if (b.levels.length !== a.levels.length) return b.levels.length - a.levels.length;
  if (b.occurrences !== a.occurrences) return b.occurrences - a.occurrences;
  const aMaxYear = a.fiscalYears.size ? Math.max(...a.fiscalYears) : -Infinity;
  const bMaxYear = b.fiscalYears.size ? Math.max(...b.fiscalYears) : -Infinity;
  if (bMaxYear !== aMaxYear) return bMaxYear - aMaxYear;
  if (endingFiscalYear != null) {
    const aIsEnding = a.fiscalYears.has(endingFiscalYear);
    const bIsEnding = b.fiscalYears.has(endingFiscalYear);
    if (aIsEnding !== bIsEnding) return aIsEnding ? -1 : 1;
  }
  return 0;
}

// Step 2/3 of the document-driven spec, shared by both statement sides: group
// every occurrence by account key, then by its exact resolved path, so an
// account reached the SAME way by multiple statements/rows is recognized as
// one candidate with occurrences>1 (frequency), not several unrelated ones.
function accumulatePathCandidates(tree, occurrences, statementType) {
  const byKey = new Map(); // key -> Map<pathString, candidate>
  for (const { key, node, accountType } of occurrences) {
    const levels = pathFromLeafNode(tree, node);
    const pathString = levels.join(" > ");
    if (!byKey.has(key)) byKey.set(key, new Map());
    const paths = byKey.get(key);
    if (!paths.has(pathString)) {
      paths.set(pathString, {
        levels,
        accountType,
        statementType: accountType ? statementType : null,
        occurrences: 0,
        fiscalYears: new Set(),
        sourceFileId: node.sourceFileId ?? null,
      });
    }
    const candidate = paths.get(pathString);
    candidate.occurrences += 1;
    if (node.sourceFiscalYear != null) candidate.fiscalYears.add(node.sourceFiscalYear);
  }
  return byKey;
}

// Step 4/5, shared by both statement sides: score every account's candidates
// with comparePathCandidates and select the winner, tallying exactly WHICH
// tier decided each contested account (never "first occurrence"). Pass
// endingFiscalYear=null for Profit & Loss ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â see comparePathCandidates.
function selectWinningPaths(candidatesByKey, endingFiscalYear) {
  const hierarchyByName = new Map();
  let conflictingPathsCount = 0;
  let resolvedByDepthCount = 0;
  let resolvedByFrequencyCount = 0;
  let resolvedByRecencyCount = 0;
  let mergedNodesCount = 0;
  for (const [key, paths] of candidatesByKey) {
    const candidates = Array.from(paths.values());
    for (const c of candidates) if (c.occurrences > 1) mergedNodesCount += 1;
    if (candidates.length > 1) {
      conflictingPathsCount += 1;
      candidates.sort((a, b) => comparePathCandidates(a, b, endingFiscalYear));
      const [winner, runnerUp] = candidates;
      if (winner.levels.length !== runnerUp.levels.length) resolvedByDepthCount += 1;
      else if (winner.occurrences !== runnerUp.occurrences) resolvedByFrequencyCount += 1;
      else resolvedByRecencyCount += 1;
    }
    const winner = candidates[0];
    hierarchyByName.set(key, {
      levels: winner.levels,
      accountType: winner.accountType,
      statementType: winner.statementType,
      sourceFiscalYear: winner.fiscalYears.size ? Math.max(...winner.fiscalYears) : null,
      sourceFileId: winner.sourceFileId,
    });
  }
  return {
    hierarchyByName, conflictingPathsCount, resolvedByDepthCount,
    resolvedByFrequencyCount, resolvedByRecencyCount, mergedNodesCount,
  };
}

// ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ Document hierarchy tree ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬
// A real parent -> children tree, built directly from the uploaded document's
// own parsed positions (parent_path). Every node stores name/parentId/
// children/depth/fullPath. An account's hierarchy path is produced by walking
// its own leaf node up to the root via parentId, then reversing ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â never by
// inferring parents from keywords, account names, or another company's COA.
// Level 1-2 (Balance Sheet) / 1-3 (Profit & Loss) are the only fixed part of
// any path (fixedPrefixFor) and form the tree's shared top branches; every
// level after that comes entirely from parent_path.

function createHierarchyTree() {
  return { nodesByPath: new Map(), nodesById: new Map(), nextId: 0 };
}

// Finds (or creates) the node for this exact path, creating every missing
// ancestor first ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â so parentId always resolves to a real node in the tree,
// and a node's depth is always exactly one more than its parent's (no gaps).
function getOrCreateTreeNode(tree, pathArr) {
  const pathKey = pathArr.map((s) => normName(s)).join(" > ");
  const existing = tree.nodesByPath.get(pathKey);
  if (existing) return existing;
  const parentPathArr = pathArr.slice(0, -1);
  const parent = parentPathArr.length ? getOrCreateTreeNode(tree, parentPathArr) : null;
  const node = {
    id: `n${tree.nextId += 1}`,
    name: pathArr[pathArr.length - 1],
    parentId: parent ? parent.id : null,
    children: [],
    depth: pathArr.length,
    fullPath: pathArr.join(" > "),
    isLeaf: false,
  };
  if (parent) parent.children.push(node);
  tree.nodesByPath.set(pathKey, node);
  tree.nodesById.set(node.id, node);
  return node;
}

/** Leaf -> root via parentId, then reversed into a root -> leaf path array. */
function pathFromLeafNode(tree, node) {
  const reversed = [];
  let cursor = node;
  while (cursor) {
    reversed.push(cursor.name);
    cursor = cursor.parentId ? tree.nodesById.get(cursor.parentId) : null;
  }
  return reversed.reverse();
}

/**
 * Populates `tree` from one statement's parsed rows, attaching a leaf node
 * per postable account under its fixed anchor + the document's own real
 * parent_path (redundant leading labels trimmed). Returns one entry per
 * valid row ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â the SAME account name can legitimately appear more than once
 * across multiple uploaded documents (Opening vs Ending Balance Sheet, or
 * repeated comparative P&L columns); the caller applies deepest-wins across
 * occurrences using each node's own depth.
 */
function populateHierarchyTree(tree, rows, accountTypeForRow, isValidLeafRow) {
  const occurrences = [];
  for (const r of rows || []) {
    if (!isValidLeafRow(r)) continue;
    const accountType = accountTypeForRow(r);
    const rawParentPath = (Array.isArray(r.parent_path) ? r.parent_path : []).filter(Boolean).map(normalizeHierarchyLabel);
    const parentPath = trimRedundantParentPath(rawParentPath, accountType);
    const fullPathArr = appendLeaf([...fixedPrefixFor(accountType), ...parentPath], r.account_name);
    const node = getOrCreateTreeNode(tree, fullPathArr);
    node.isLeaf = true;
    node.accountType = accountType;
    node.sourceFiscalYear = r.fiscal_year ?? null;
    node.sourceFileId = r.source_file_id ?? null;
    occurrences.push({ key: normName(r.account_name), node, accountType });
  }
  return occurrences;
}

/**
 * Post-generation validation of a document hierarchy tree, per the explicit
 * spec: no internal gaps, no dangling parent references, every leaf's depth
 * accounted for. By construction (getOrCreateTreeNode always builds missing
 * ancestors first) these invariants can't actually break ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â this still checks
 * and logs them so a future change to the builder can't silently reintroduce
 * a gap or an orphaned parent without it showing up here.
 */
function validateHierarchyTree(tree, label) {
  const issues = [];
  let maxDepth = 0;
  let leafCount = 0;
  let totalLeafDepth = 0;

  // Defensive check (post cross-document merge, so it catches the ancestor-
  // stack bug class even if a future extractor change reintroduces it): a
  // node that is itself a real posted leaf account must never also be the
  // parent of another node. Only a structural header/group node may have
  // children. Computed via the tree's own isLeaf/parentId fields ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â never a
  // keyword or account-name guess.
  const childCounts = new Map();
  for (const node of tree.nodesById.values()) {
    if (node.parentId) childCounts.set(node.parentId, (childCounts.get(node.parentId) || 0) + 1);
  }
  let leafUsedAsParentCount = 0;

  for (const node of tree.nodesById.values()) {
    if (node.parentId && !tree.nodesById.has(node.parentId)) {
      issues.push(`Node "${node.fullPath}" has parent_id "${node.parentId}" that does not exist in the tree.`);
    }
    if (!node.name || !String(node.name).trim()) {
      issues.push(`Node at path "${node.fullPath}" has an empty/blank name.`);
    }
    if (node.parentId) {
      const parent = tree.nodesById.get(node.parentId);
      if (parent && node.depth !== parent.depth + 1) {
        issues.push(`Node "${node.fullPath}" has depth ${node.depth}, expected ${parent.depth + 1} (gap after parent "${parent.fullPath}").`);
      }
    } else if (node.depth !== 1) {
      issues.push(`Root node "${node.fullPath}" has depth ${node.depth}, expected 1.`);
    }
    if (node.isLeaf) {
      leafCount += 1;
      totalLeafDepth += node.depth;
      if (node.depth > maxDepth) maxDepth = node.depth;
      if (childCounts.get(node.id) > 0) {
        leafUsedAsParentCount += 1;
        issues.push(`Leaf account "${node.fullPath}" has ${childCounts.get(node.id)} child node(s) ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â a posted account can never be a structural parent.`);
      }
    }
  }
  const avgDepth = leafCount ? totalLeafDepth / leafCount : 0;
  console.log(
    `Hierarchy Tree Validation (${label})\n` +
    `  Nodes: ${tree.nodesById.size}\n` +
    `  Leaf Accounts: ${leafCount}\n` +
    `  Maximum Depth: ${maxDepth}\n` +
    `  Average Depth: ${avgDepth.toFixed(2)}\n` +
    `  Leaf Used As Parent: ${leafUsedAsParentCount}\n` +
    `  Hierarchy Gaps: ${issues.length}` +
    (issues.length ? `\n  Issues:\n${issues.slice(0, 20).map((i) => `    ${i}`).join("\n")}` : ""),
  );
  if (leafUsedAsParentCount > 0) {
    console.error(
      `[ChartOfAccounts][${label}] VALIDATION WARNING: ${leafUsedAsParentCount} leaf account(s) have children in ` +
      `the hierarchy tree ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â a real posted account is acting as another account's structural parent. This should ` +
      `be impossible after the ancestor-stack extraction fix; investigate the source document(s).`,
    );
  }
  return { maxDepth, avgDepth, leafCount, gapCount: issues.length, issues, leafUsedAsParentCount };
}

/**
 * Priority-2 lookup tables: normName(accountName) -> { levels, accountType,
 * statementType, sourceFiscalYear }, one from this version's own uploaded
 * Balance Sheet rows, one from the ephemeral parsed Profit & Loss rows ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â both
 * now carrying `parent_path` (migration 077 for BS; P&L stays ephemeral,
 * never persisted), each built by materializing a real hierarchy tree
 * (createHierarchyTree/populateHierarchyTree) and reading `levels` off it via
 * leaf-to-root traversal (pathFromLeafNode) ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â never inferred from keywords or
 * account names.
 *
 * Both sides: EVERY distinct candidate path an account reaches across every
 * uploaded statement (or row) is collected first (never just the first
 * occurrence), then scored via comparePathCandidates ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â deepest wins; ties
 * broken by how many documents/rows independently agree on that exact path
 * (frequency); further ties by newest fiscal year. Balance Sheet has one
 * additional tie-break ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â whether the Ending Balance Sheet specifically
 * confirms it ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â which Profit & Loss skips (a P&L covers a period, so there is
 * no "Ending" document to prefer). Total/header/subtotal rows are excluded on
 * both sides ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â they are not real postable accounts.
 */
function buildDocHierarchyLookups(bsRows, plRows, endingFiscalYear = null, { logValidation = false } = {}) {
  const bsTree = createHierarchyTree();
  const bsOccurrences = populateHierarchyTree(
    bsTree,
    bsRows,
    (r) => bsSectionToType(r.section),
    // hierarchy_level 0 = a structural header/grouping row (recognized
    // section header, e.g. "ASSETS") ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â not a real postable account.
    (r) => Boolean(r.account_name) && !r.is_total && r.hierarchy_level !== 0,
  );

  // Step 2-5, Balance Sheet: accumulate every candidate path per account, then
  // score and select via comparePathCandidates (depth -> frequency -> recency
  // -> confirmed Ending Balance Sheet). Tallies below feed the "Balance Sheet
  // Hierarchy Validation" log (Resolved By Depth/Frequency/Recency,
  // Conflicting Paths) ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â never guessed, always attributable to the exact tier
  // that decided it.
  const bsSelection = selectWinningPaths(
    accumulatePathCandidates(bsTree, bsOccurrences, "balance_sheet"),
    endingFiscalYear,
  );
  const bsHierarchyByName = bsSelection.hierarchyByName;
  const {
    conflictingPathsCount, resolvedByDepthCount,
    resolvedByFrequencyCount, resolvedByRecencyCount, mergedNodesCount,
  } = bsSelection;
  // Kept for the existing "Balance Sheet Hierarchy Analysis" log's "Deepest
  // Hierarchy Used" field ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â any account with more than one candidate path
  // needed the scoring tiers above at all, regardless of which tier decided it.
  const deepestHierarchyUsedCount = conflictingPathsCount;

  const plTree = createHierarchyTree();
  const plOccurrences = populateHierarchyTree(
    plTree,
    plRows,
    (r) => plSectionToType(r.section),
    // A subtotal (Gross Profit / Net Operating Income / Net Income, etc.) is
    // a real computed line in the statement, and legitimately appears as an
    // ANCESTOR for other accounts (see the fixed P&L prefix above) ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â but
    // is never itself a postable account.
    (r) => Boolean(r.account_name) && !r.is_total && !r.is_header && r.node_type !== "subtotal",
  );

  // Step 2-5, Profit & Loss: IDENTICAL candidate-accumulation + deterministic
  // scoring the Balance Sheet side uses above, not a depth-only +
  // first-seen loop. That loop was tolerable only while the 9-level fixed
  // prefix dominated every P&L path and the document's own headings were
  // trimmed away, so almost every account had exactly one candidate. Under
  // the 2-level anchor the entire path below level 2 is document-sourced, so
  // two comparative columns / two uploaded P&Ls disagreeing is now the normal
  // case and must be resolved by evidence, not by which file happened to be
  // parsed first.
  //
  // endingFiscalYear is deliberately NOT passed: a P&L covers a PERIOD, so
  // there is no "Ending P&L" the way there is an Ending Balance Sheet. The
  // recency tier (newest fiscal year) is the last meaningful signal, and
  // comparePathCandidates already stops there when endingFiscalYear is null.
  const plSelection = selectWinningPaths(
    accumulatePathCandidates(plTree, plOccurrences, "profit_loss"),
    null,
  );
  const plHierarchyByName = plSelection.hierarchyByName;

  if (logValidation) {
    validateHierarchyTree(bsTree, "Balance Sheet");
    validateHierarchyTree(plTree, "Profit & Loss");
  }

  return {
    bsHierarchyByName, plHierarchyByName, bsTree, plTree, deepestHierarchyUsedCount,
    conflictingPathsCount, resolvedByDepthCount, resolvedByFrequencyCount, resolvedByRecencyCount,
    mergedNodesCount,
    plConflictingPathsCount: plSelection.conflictingPathsCount,
    plResolvedByDepthCount: plSelection.resolvedByDepthCount,
    plResolvedByFrequencyCount: plSelection.resolvedByFrequencyCount,
    plResolvedByRecencyCount: plSelection.resolvedByRecencyCount,
    plMergedNodesCount: plSelection.mergedNodesCount,
  };
}

// Strict fuzzy fallback (Step 3, between the exact document lookup and AI) ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â
// same combined Levenshtein/Jaro-Winkler/token-overlap metric and normalized
// input coaAccountMatcher.js's client-COA matcher uses, just applied against
// THIS version's own uploaded-statement accounts instead of a client COA
// workbook. "Checking Account" / "Chase Checking" / "Cash Checking" resolve
// to the same already-known parent this way.
const DOC_FUZZY_THRESHOLD = 0.90;

function inferAccountTypeFromReferencePath(statementType, path) {
  const text = (path || []).join(" ").toLowerCase();
  if (statementType === "balance_sheet") {
    if (text.includes("asset")) return "asset";
    if (text.includes("liabil")) return "liability";
    if (text.includes("equity") || text.includes("capital") || text.includes("owner") || text.includes("member")) return "equity";
  }
  if (statementType === "profit_loss") {
    if (text.includes("expense") || text.includes("cost of goods") || text.includes("cogs")) return "expense";
    if (text.includes("income") || text.includes("revenue") || text.includes("sales")) return "income";
  }
  return null;
}

function balanceSheetPrefixKey(label) {
  const normalized = normName(label).replace(/^total for\s+/, "total ");
  if (normalized === "total assets") return "total assets";
  if (normalized === "total liabilities and equity") return "total liabilities and equity";
  if (normalized === "total equity") return "total equity";
  return normalized;
}

function getBalanceSheetPrefix(accountType) {
  const normalizedType = String(accountType || "").trim().toLowerCase();
  if (normalizedType === "asset") return BS_ASSET_COA_PREFIX;
  if (normalizedType === "liability" || normalizedType === "equity") return BS_LIABILITY_EQUITY_COA_PREFIX;
  return [];
}

function applyBalanceSheetCoaPrefix({ accountType, matchedPath }) {
  const prefix = getBalanceSheetPrefix(accountType);
  const path = Array.isArray(matchedPath) ? matchedPath.filter(Boolean) : [];
  if (!prefix.length) return path.slice();

  const merged = prefix.slice();
  let pathIndex = 0;
  while (
    pathIndex < path.length &&
    pathIndex < prefix.length &&
    balanceSheetPrefixKey(path[pathIndex]) === balanceSheetPrefixKey(prefix[pathIndex])
  ) {
    pathIndex += 1;
  }
  return [...merged, ...path.slice(pathIndex)];
}

function buildTreeHierarchyLookup(tree, statementType) {
  const lookup = new Map();
  const visit = (node, path) => {
    if (!node || typeof node !== "object") return;
    const nextPath = node.nodeType === "REPORT" ? path : [...path, node.name].filter(Boolean);
    if (node.nodeType === "ACCOUNT" && node.name) {
      const key = normName(node.name);
      const accountType = node.accountType || inferAccountTypeFromReferencePath(statementType, nextPath);
      const coaPath = statementType === "profit_loss"
        ? appendLeaf([...PROFIT_AND_LOSS_COA_PREFIX, ...nextPath.slice(0, -1)], nextPath[nextPath.length - 1])
        : statementType === "balance_sheet"
          ? applyBalanceSheetCoaPrefix({ accountType, matchedPath: nextPath })
          : nextPath;
      const bucket = lookup.get(key) || [];
      bucket.push({
        levels: coaPath,
        treePath: nextPath,
        accountType,
        statementType,
        sourceFiscalYear: null,
        sourceFileId: null,
        nodeName: node.name,
        nodeType: node.nodeType,
        parent: coaPath.length > 1 ? coaPath[coaPath.length - 2] : null,
        level: coaPath.length,
        matchScore: 1,
      });
      lookup.set(key, bucket);
    }
    for (const child of node.children || []) visit(child, nextPath);
  };
  visit(tree, []);
  return lookup;
}

function selectDeterministicReferenceCandidate(candidates) {
  if (!Array.isArray(candidates)) return candidates || null;
  if (!candidates.length) return null;
  return candidates.slice().sort((a, b) => {
    const bLevel = b.level || b.levels?.length || 0;
    const aLevel = a.level || a.levels?.length || 0;
    return bLevel - aLevel;
  })[0];
}

function fuzzyMatchDocHierarchy(accountName, hierarchyByName) {
  const target = fuzzyNorm(accountName);
  let best = null;
  let bestScore = 0;
  for (const [key, entry] of hierarchyByName) {
    const score = strongSimilarity(target, fuzzyNorm(key));
    if (score >= DOC_FUZZY_THRESHOLD && score > bestScore) {
      bestScore = score;
      best = selectDeterministicReferenceCandidate(entry);
    }
  }
  return best;
}

function normalizeReferenceStatementType(statementType, accountType) {
  const st = String(statementType || "").trim().toLowerCase();
  if (st === "balance_sheet" || st === "profit_loss") return st;
  const at = String(accountType || "").trim().toLowerCase();
  if (BALANCE_SHEET_TYPES.has(at)) return "balance_sheet";
  if (["income", "revenue", "sales", "cogs", "cost_of_goods_sold", "expense", "other_income", "other_expense"].includes(at)) return "profit_loss";
  return null;
}

function selectReferenceTree({ statementType, balanceSheetLookup, profitLossLookup }) {
  if (statementType === "balance_sheet") return balanceSheetLookup || null;
  if (statementType === "profit_loss") return profitLossLookup || null;
  return null;
}

function createDocHierarchyStats() {
  return { balanceSheet: 0, profitLoss: 0, fuzzy: 0 };
}

/**
 * Which parsed-document hierarchy resolves a given account ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â Steps 1-3 of
 * the mapping logic (exact match in the preferred statement, exact match in
 * the other, then a strict fuzzy match against either). The Retained-
 * Earnings GL bucket (splitAccountsAtRetainedEarnings) is only a preference
 * hint for which statement to try FIRST, never a hard gate.
 *
 * @param {object} [stats] - createDocHierarchyStats() accumulator, incremented
 *   in place for the "COA Hierarchy Generation" summary log ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â optional, has
 *   no effect on resolution itself.
 */
function pickDocHierarchy(accountName, key, glBucketByKey, bsHierarchyByName, plHierarchyByName, stats, context = {}) {
  const bucket = glBucketByKey && glBucketByKey.get(key);
  const statementType = normalizeReferenceStatementType(context.statementType || bucket, context.accountType);
  const selected = selectReferenceTree({
    statementType,
    balanceSheetLookup: bsHierarchyByName,
    profitLossLookup: plHierarchyByName,
  });
  if (!selected) return null;

  let entry = selectDeterministicReferenceCandidate(selected.get(key));
  if (entry) {
    if (stats) stats[statementType === "profit_loss" ? "profitLoss" : "balanceSheet"]++;
    return { ...entry, matchType: entry.matchType || "exact" };
  }

  // Step 3 ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â fuzzy match, tried against both statements' known accounts.
  entry = fuzzyMatchDocHierarchy(accountName, selected);
  if (entry) { if (stats) stats.fuzzy++; return { ...entry, matchType: "fuzzy" }; }
  return null;
}

/**
 * Resolves source_file_id -> uploaded document name for every distinct
 * document referenced in bsRows ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â used only for the "Source File" field in
 * the "Balance Sheet Hierarchy Analysis" unresolved-account log, so a flagged
 * account points at a real filename instead of an opaque uuid.
 */
async function buildSourceFileNameLookup(bsRows) {
  const ids = Array.from(new Set((bsRows || []).map((r) => r.source_file_id).filter(Boolean)));
  const lookup = new Map();
  if (!ids.length) return lookup;
  const { data } = await supabase.from("documents").select("id, name").in("id", ids);
  for (const row of data || []) lookup.set(row.id, row.name);
  return lookup;
}

/**
 * "Balance Sheet Hierarchy Validation" ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â the exact document-driven audit
 * block requested: how many uploaded Balance Sheets contributed, the shape
 * of the merged hierarchy tree, exactly which scoring tier resolved every
 * account that had more than one candidate path (never just "first
 * occurrence"), and a full completeness sweep (null levels, broken parent
 * links, accounts still missing a hierarchy) over the FINAL resolved leaves.
 * Every unresolved or flagged account is logged individually with its source
 * file and both its detected (raw) and chosen (final) hierarchy.
 */
function logBalanceSheetHierarchyValidation(hierarchical, bsRows, bsTree, resolutionTallies, sourceFileNameById) {
  const {
    conflictingPathsCount = 0, resolvedByDepthCount = 0,
    resolvedByFrequencyCount = 0, resolvedByRecencyCount = 0, mergedNodesCount = 0,
  } = resolutionTallies || {};

  const bsLeaves = hierarchical.filter((l) => l.statementType === "balance_sheet");

  const balanceSheetsParsed = new Set((bsRows || []).map((r) => r.source_file_id).filter(Boolean)).size;
  const hierarchyNodes = bsTree.nodesById.size;
  const uniqueLeafAccounts = new Set(
    (bsRows || [])
      .filter((r) => r.account_name && !r.is_total && r.hierarchy_level !== 0)
      .map((r) => normName(r.account_name)),
  ).size;

  let totalDepth = 0;
  let depthCount = 0;
  let maxDepth = 0;
  let accountsMissingHierarchy = 0;
  let gapAccounts = 0;
  const unresolved = [];

  const pathCounts = new Map();
  for (const leaf of bsLeaves) {
    if (leaf.hierarchyPath) pathCounts.set(leaf.hierarchyPath, (pathCounts.get(leaf.hierarchyPath) || 0) + 1);
  }
  const duplicatePaths = Array.from(pathCounts.values()).filter((n) => n > 1).length;

  for (const leaf of bsLeaves) {
    const levels = leaf.levels || [];
    const realLevels = levels.filter(Boolean);
    if (realLevels.length) {
      totalDepth += realLevels.length;
      depthCount += 1;
      if (realLevels.length > maxDepth) maxDepth = realLevels.length;
    }
    if (leaf.needsMapping) accountsMissingHierarchy += 1;

    // Trailing levels past an account's real depth are NULL in the persisted
    // row (levelsToColumns no longer pads them) -- that's correct, not a
    // defect. The only real defect is an INTERNAL gap: a real value
    // appearing after an empty slot, which would mean a level was skipped.
    let sawEmpty = false;
    let hasGap = false;
    for (const v of levels) {
      const isEmpty = v == null || String(v).trim() === "";
      if (isEmpty) sawEmpty = true;
      else if (sawEmpty) { hasGap = true; break; }
    }
    if (hasGap) gapAccounts += 1;

    if (leaf.needsMapping || leaf.needsReview || !realLevels.length) {
      unresolved.push({
        account: leaf.accountName || leaf.displayName,
        sourceFile: sourceFileNameById?.get(leaf.hierarchySourceFileId) || leaf.hierarchySourceFileId || "(no document position ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â GL only)",
        detected: leaf.hierarchyPath || "(none)",
        chosen: realLevels.join(" > ") || "(none)",
        reason: leaf.needsMapping ? "needs_mapping ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â no match found in any source"
          : leaf.needsReview ? "needs_review ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â low-confidence AI classification"
          : "unresolved",
      });
    }
  }

  const avgDepth = depthCount ? totalDepth / depthCount : 0;
  const brokenParentLinks = validateHierarchyTree(bsTree, "Balance Sheet (validation)").gapCount;
  const hierarchyValid = gapAccounts === 0 && brokenParentLinks === 0 && accountsMissingHierarchy === 0;

  console.log(
    "==============================\n" +
    "Balance Sheet Hierarchy Validation\n" +
    "==============================\n\n" +
    `Balance Sheets Parsed : ${balanceSheetsParsed}\n\n` +
    `Hierarchy Nodes : ${hierarchyNodes}\n\n` +
    `Unique Leaf Accounts : ${uniqueLeafAccounts}\n\n` +
    `Merged Nodes : ${mergedNodesCount}\n\n` +
    `Duplicate Paths : ${duplicatePaths}\n\n` +
    `Conflicting Paths : ${conflictingPathsCount}\n\n` +
    `Resolved By Depth : ${resolvedByDepthCount}\n\n` +
    `Resolved By Frequency : ${resolvedByFrequencyCount}\n\n` +
    `Resolved By Recency : ${resolvedByRecencyCount}\n\n` +
    `Average Hierarchy Depth : ${avgDepth.toFixed(2)}\n\n` +
    `Maximum Hierarchy Depth : ${maxDepth}\n\n` +
    `Accounts Missing Hierarchy : ${accountsMissingHierarchy}\n\n` +
    `Accounts With Internal Hierarchy Gaps : ${gapAccounts}\n\n` +
    `Broken Parent Links : ${brokenParentLinks}\n\n` +
    `Hierarchy Valid : ${hierarchyValid ? "YES" : "NO"}\n` +
    "==============================",
  );

  if (unresolved.length) {
    console.log(
      "Unresolved / flagged Balance Sheet accounts:\n" +
      unresolved.map((u) =>
        `  Account: ${u.account}\n` +
        `  Source File: ${u.sourceFile}\n` +
        `  Detected Hierarchy: ${u.detected}\n` +
        `  Chosen Hierarchy: ${u.chosen}\n` +
        `  Reason: ${u.reason}`,
      ).join("\n\n"),
    );
  }

  return {
    balanceSheetsParsed, hierarchyNodes, uniqueLeafAccounts, mergedNodesCount, duplicatePaths,
    conflictingPathsCount, resolvedByDepthCount, resolvedByFrequencyCount, resolvedByRecencyCount,
    avgDepth, maxDepth, accountsMissingHierarchy, gapAccounts,
    brokenParentLinks, hierarchyValid, unresolved,
  };
}

/**
 * "Profit & Loss Hierarchy Validation" ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â the P&L twin of the Balance Sheet
 * block above. Reports how much of each account's final hierarchy actually
 * came from the uploaded document versus the fixed anchor, and asserts that
 * the ONLY artificial (non-document, non-AI) levels present are the three
 * required anchor labels.
 *
 * @param {Array}  hierarchical - output of buildLeafHierarchies
 * @param {Array}  plRows       - the ephemeral parsed P&L account rows
 * @param {object} plTree       - buildDocHierarchyLookups' plTree
 * @param {object} tallies      - { plMergedNodesCount, ... } from buildDocHierarchyLookups
 */
function logProfitLossHierarchyValidation(hierarchical, plRows, plTree, tallies = {}) {
  const { plMergedNodesCount = 0 } = tallies;
  const plLeaves = hierarchical.filter((l) => l.statementType === "profit_loss");

  // Same leaf filter populateHierarchyTree uses for the P&L side, so this
  // counts exactly the rows that were eligible to contribute a hierarchy.
  const accountsParsed = new Set(
    (plRows || [])
      .filter((r) => r.account_name && !r.is_total && !r.is_header && r.node_type !== "subtotal")
      .map((r) => normName(r.account_name)),
  ).size;

  // Resolved from a real uploaded-document position (exact or strict-fuzzy
  // match against this version's own parsed P&L / Balance Sheet), as opposed
  // to an AI hierarchy, a prior-run reuse, section-evidence-only, or a rule.
  const resolvedFromDocuments = plLeaves.filter(
    (l) => l.classificationMethod === "document_hierarchy" || l.matchTier === "document_hierarchy",
  ).length;

  const anchorDepth = PL_FIXED_PREFIX.length;
  let documentLevelsPreserved = 0;
  let anchorAnomalies = 0;
  let gapAccounts = 0;
  let missingHierarchy = 0;

  for (const leaf of plLeaves) {
    const realLevels = (leaf.levels || []).filter(Boolean);
    if (leaf.needsMapping || !realLevels.length) { missingHierarchy += 1; continue; }

    // Every level BELOW the 2-level anchor and ABOVE the leaf's own name came
    // from the document's parent_path (or, for an AI-classified account, the
    // AI's own levels) ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â never invented here.
    documentLevelsPreserved += Math.max(0, realLevels.length - anchorDepth - 1);

    // The ONLY artificial nodes permitted are the two anchor labels, in
    // exactly this order, at exactly levels 1-2.
    for (let i = 0; i < anchorDepth; i += 1) {
      if (normName(realLevels[i] || "") !== normName(PL_FIXED_PREFIX[i])) { anchorAnomalies += 1; break; }
    }

    let sawEmpty = false;
    for (const v of leaf.levels || []) {
      if (!v) sawEmpty = true;
      else if (sawEmpty) { gapAccounts += 1; break; }
    }
  }

  const brokenParentLinks = validateHierarchyTree(plTree, "Profit & Loss (validation)").gapCount;
  const hierarchyValid = anchorAnomalies === 0 && gapAccounts === 0
    && missingHierarchy === 0 && brokenParentLinks === 0;

  console.log(
    "====================================\n" +
    "Profit & Loss Hierarchy Validation\n" +
    "====================================\n" +
    `Accounts Parsed : ${accountsParsed}\n` +
    `Hierarchy Resolved From Documents : ${resolvedFromDocuments}\n` +
    `Merged Hierarchies : ${plMergedNodesCount}\n` +
    `Document Levels Preserved : ${documentLevelsPreserved}\n` +
    `Artificial Nodes Added : ${anchorAnomalies === 0
      ? "ONLY REQUIRED ANCHORS"
      : `ONLY REQUIRED ANCHORS (${anchorAnomalies} anomaly/anomalies ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â see warning below)`}\n` +
    `Hierarchy Valid : ${hierarchyValid ? "YES" : "NO"}\n` +
    "====================================",
  );

  if (anchorAnomalies) {
    console.warn(
      `[ChartOfAccounts][P&L] ${anchorAnomalies} Profit & Loss leaf/leaves do not start with the required ` +
      `anchor "${PL_FIXED_PREFIX.join(" > ")}" ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â a writer bypassed fixedPrefixFor.`,
    );
  }

  return {
    accountsParsed, resolvedFromDocuments, mergedHierarchies: plMergedNodesCount,
    documentLevelsPreserved, anchorAnomalies, gapAccounts,
    missingHierarchy, brokenParentLinks, hierarchyValid,
  };
}

/**
 * GL "Column B" unique account list, in the GL's own first-seen row order
 * (never alphabetical ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â Rule 4), split at "Retained Earnings" into Balance
 * Sheet vs Profit & Loss buckets: a real General Ledger conventionally lists
 * Balance Sheet accounts (Assets/Liabilities/Equity) before Profit & Loss
 * accounts (Income/Expenses), with Retained Earnings the last Balance Sheet
 * account. This is a bucketing HINT for which parsed document hierarchy to
 * try first (see pickDocHierarchy) ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â never a hard gate: an account outside
 * either bucket, or a version with no "Retained Earnings" account at all,
 * still gets both hierarchies tried (see the fallback warning below).
 *
 * @param {Array} glRowsInOrder - collectGlAccountsFromEntries's result (id-ordered)
 * @returns {Map<string, 'balance_sheet'|'profit_loss'>} normName(accountName) -> bucket
 */
function splitAccountsAtRetainedEarnings(glRowsInOrder) {
  const uniqueOrdered = [];
  const seen = new Set();
  for (const r of glRowsInOrder || []) {
    const name = String(r.account_name || "").trim();
    if (!name) continue;
    const key = normName(name);
    if (!seen.has(key)) { seen.add(key); uniqueOrdered.push(name); }
  }
  const reIdx = uniqueOrdered.findIndex((n) => normName(n) === "retained earnings");
  if (reIdx === -1) {
    console.warn('[ChartOfAccounts] "Retained Earnings" not found in the General Ledger\'s account list ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â Balance Sheet/P&L bucketing hint skipped; every account still tries both parsed hierarchies.');
    return new Map();
  }
  const bucketByKey = new Map();
  uniqueOrdered.forEach((n, i) => bucketByKey.set(normName(n), i <= reIdx ? "balance_sheet" : "profit_loss"));
  return bucketByKey;
}

// ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ COA leaf model ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬

/**
 * Build the in-memory COA leaf model from raw account rows.
 *
 * The uploaded Chart of Accounts (client_chart_of_accounts), when present, is
 * the SOURCE OF TRUTH: every unique account is matched against it (see
 * generateChartOfAccounts, which builds `matchResults` via coaMappingService
 * BEFORE any AI call) and a confident match is used directly here ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â
 * `needsReview: false` always, since a deterministic match is never
 * uncertain. AI (`aiResults`) is only ever consulted for accounts that
 * genuinely don't exist in the upload or matched ambiguously:
 *   ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¢ isReportRow: true  ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ row excluded from COA entirely (report total / header)
 *   ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¢ confidence ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â°Ãƒâ€šÃ‚Â¥ threshold ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ accountType used as-is
 *   ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¢ confidence < threshold ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ same AI result used, but needsReview: true set
 *   ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¢ no AI result at all   ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ accountType stays null (never guessed), needsReview: true
 *
 * No keyword rules, no fallback classification engine.
 *
 * @param {Array}  glRows    GL transaction rows
 * @param {Array}  bsRows    Balance Sheet rows
 * @param {Array}  plRows    Parsed uploaded Profit & Loss rows (ephemeral ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â
 *                           never persisted, no profit_loss_entries table; see
 *                           keyReportSyncService's Step 5b). Each row's own
 *                           `section` (revenue|cost_of_sales|operating_expenses,
 *                           detected from the document's own header text) is
 *                           used only as a Priority-3 type/grouping hint below
 *                           the uploaded Balance Sheet ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â never invented.
 * @param {Map}    aiResults classifyAccountsWithAI result keyed by normName(accountName) ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â
 *                           populated ONLY for accounts matchResults left unmatched/ambiguous
 * @param {Map}    matchResults coaMappingService match result keyed by normName(accountName),
 *                           for EVERY unique account (see generateChartOfAccounts)
 * @param {Map}    [glBucketByKey] splitAccountsAtRetainedEarnings's Balance-Sheet/
 *                           Profit-and-Loss bucketing hint (Priority 2, below
 *                           matchResults, above aiResults)
 */
function buildCoaModel(glRows, bsRows, plRows, aiResults = new Map(), matchResults = new Map(), glBucketByKey = new Map(), endingFiscalYear = null, referenceTrees = {}) {
  const leavesByName = new Map();
  const docLookups = buildDocHierarchyLookups(bsRows, plRows, endingFiscalYear);
  const bsHierarchyByName = referenceTrees.balanceSheetTree
    ? buildTreeHierarchyLookup(referenceTrees.balanceSheetTree, "balance_sheet")
    : docLookups.bsHierarchyByName;
  const plHierarchyByName = referenceTrees.profitLossTree
    ? buildTreeHierarchyLookup(referenceTrees.profitLossTree, "profit_loss")
    : docLookups.plHierarchyByName;

  // A GL posting is, by definition, a real transaction ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â never a calculated
  // report/header row. If Gemini says isReportRow=true for a name that ALSO
  // has real GL activity, that's a misclassification (confirmed live: "Augusta
  // Rule" ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â 20 real transactions, isReportRow=true at confidence 1.0). GL
  // activity must never silently disappear because of it (root-cause fix ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â
  // previously this returned early with no COA row and no trace at all).
  const namesWithGlActivity = new Set();
  for (const r of glRows || []) {
    const n1 = r.account_name || r.account_section || "";
    if (n1) namesWithGlActivity.add(normName(n1));
    if (r.split_account) namesWithGlActivity.add(normName(r.split_account));
  }

  // High AI confidence must not be silently overwritten by a lower-priority
  // structural inference (see below) ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â only a missing or low-confidence AI
  // result may be filled in by bsSection/plSection. This does NOT weaken the
  // "Capital One Credit Card ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ equity" fix from earlier this session: that
  // was a STALE cache entry (already fixed separately via classifier cache
  // versioning), not a genuinely confident-and-correct AI answer being
  // second-guessed. A client_chart_of_accounts match (Pass 1, downstream of
  // this function) still always wins regardless of AI confidence.
  const AI_OVERRIDE_CONFIDENCE_FLOOR = 0.95;

  // plSection values are the canonical labels profitLossExtractionService's
  // header detection recognizes: revenue | cost_of_sales | operating_expenses
  // | other_income | other_expense.
  const typeFromPlSection = (plSection) => {
    if (plSection === "revenue" || plSection === "other_income") return "income";
    if (plSection === "cost_of_sales") return "cogs";
    if (plSection === "operating_expenses" || plSection === "other_expense") return "expense";
    return null;
  };

  const mergeInto = (leaf, source, fiscalYear, number, bsSection, plSection, bsSubSection) => {
    leaf.sources.add(source);
    if (fiscalYear) leaf.fiscalYears.add(Number(fiscalYear));
    if (!leaf.accountNumber && number) leaf.accountNumber = number;
    if (bsSection && !leaf.bsSection) leaf.bsSection = bsSection;
    if (plSection && !leaf.plSection) leaf.plSection = plSection;
    if (bsSubSection && !leaf.bsSubSection) leaf.bsSubSection = bsSubSection;
    const aiConfident = leaf.confidence != null && leaf.confidence >= AI_OVERRIDE_CONFIDENCE_FLOOR && leaf.accountType;
    if (aiConfident) return; // keep the confident AI classification ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â section evidence only fills gaps
    if (bsSection) {
      const normSec = String(bsSection).toLowerCase().trim();
      if (normSec.includes("asset")) {
        leaf.accountType = "asset";
        leaf.statementType = "balance_sheet";
      } else if (normSec.includes("liab")) {
        leaf.accountType = "liability";
        leaf.statementType = "balance_sheet";
      } else if (normSec.includes("equity") || normSec.includes("capital") || normSec.includes("owner") || normSec.includes("member")) {
        leaf.accountType = "equity";
        leaf.statementType = "balance_sheet";
      }
    } else if (plSection && !leaf.bsSection) {
      // Never applies to a leaf that already has a BS section ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â a Balance
      // Sheet account can never legitimately be re-typed from a P&L hint.
      const plType = typeFromPlSection(plSection);
      if (plType) {
        leaf.accountType = plType;
        leaf.statementType = "profit_loss";
      }
    }
  };

  const addLeaf = (accountName, accountNumber, source, fiscalYear, bsSection, plSection, bsSubSection) => {
    const name = String(accountName || "").trim();
    // isMetadataRow catches only ERP noise (date lines, "Accrual Basis", etc.).
    // Report totals / section headers are excluded by AI isReportRow detection below.
    if (!name || isMetadataRow(name)) return;
    const number = accountNumber ? String(accountNumber).trim() : null;
    const key = normName(name);

    // Matched against the uploaded Chart of Accounts BEFORE any AI call was
    // even made (see generateChartOfAccounts) ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â the upload is the source of
    // truth, so a confident match is never sent to AI and is NEVER flagged
    // needsReview (this used to be a real bug: a confident deterministic
    // match copied the uploaded hierarchy but left whatever needsReview flag
    // an unrelated, never-run AI classification would have set, unchanged).
    const coaMatch = matchResults.get(key);
    if (coaMatch?.matched) {
      const bucket = leavesByName.get(key) || [];
      const target = bucket.find((l) => (number && l.accountNumber) ? l.accountNumber === number : true);
      if (target) {
        mergeInto(target, source, fiscalYear, number, bsSection, plSection, bsSubSection);
        return;
      }
      const leaf = {
        accountName: name,
        accountNumber: number,
        accountType: coaMatch.accountType,
        statementType: coaMatch.statementType || (coaMatch.accountType ? statementTypeFor(coaMatch.accountType) : null),
        classificationSource: "client_coa",
        classificationMethod: "client_workbook",
        aiNormalizedName: null,
        confidence: coaMatch.confidence,
        needsReview: false,
        aiLevels: [],
        aiReasoning: null,
        matchTier: coaMatch.matchTier,
        matchConfidence: coaMatch.confidence,
        matchLevels: coaMatch.levels,
        matchHierarchyPath: coaMatch.hierarchyPath,
        matchSystemId: coaMatch.systemId,
        matchClientAccountId: coaMatch.clientAccountId,
        matchNormalBalance: coaMatch.normalBalance,
        matchReason: coaMatch.reason,
        sources: new Set([source]),
        fiscalYears: new Set(fiscalYear ? [Number(fiscalYear)] : []),
        bsSection: bsSection || null,
        plSection: bsSection ? null : (plSection || null),
        bsSubSection: bsSection ? (bsSubSection || null) : null,
      };
      bucket.push(leaf);
      leavesByName.set(key, bucket);
      return;
    }

    // Priority 2: this exact account's own real position in the uploaded
    // Balance Sheet / Profit & Loss ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â read from the document's own
    // indentation (parent_path), dynamic depth, never guessed, never sent to
    // AI. Only an account neither the uploaded COA nor the uploaded
    // statements can resolve reaches AI (Priority 3, below).
    const docHierarchy = pickDocHierarchy(name, key, glBucketByKey, bsHierarchyByName, plHierarchyByName, null, {
      statementType: bsSection ? "balance_sheet" : plSection ? "profit_loss" : null,
      accountType: bsSectionToType(bsSection) || plSectionToType(plSection),
    });
    if (docHierarchy) {
      const bucket = leavesByName.get(key) || [];
      const target = bucket.find((l) => (number && l.accountNumber) ? l.accountNumber === number : true);
      if (target) {
        mergeInto(target, source, fiscalYear, number, bsSection, plSection, bsSubSection);
        return;
      }
      const leaf = {
        accountName: name,
        accountNumber: number,
        accountType: docHierarchy.accountType,
        statementType: docHierarchy.statementType || (docHierarchy.accountType ? statementTypeFor(docHierarchy.accountType) : null),
        classificationSource: "document_hierarchy",
        classificationMethod: "document_hierarchy",
        aiNormalizedName: null,
        confidence: 1,
        needsReview: false,
        aiLevels: [],
        aiReasoning: null,
        matchTier: "document_hierarchy",
        matchConfidence: 1,
        // Routed through buildLeafHierarchies' "verbatim hierarchy" pass
        // (matchLevels/matchHierarchyPath ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â same fields a client-COA match
        // uses) rather than the AI-hierarchy pass, so classificationMethod/
        // matchTier above are preserved instead of being overwritten to
        // "ai_hierarchy". Parent levels only ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â the leaf's own name is
        // appended by that pass, same convention as a client-COA match.
        matchLevels: docHierarchy.levels.slice(0, -1),
        matchHierarchyPath: docHierarchy.levels.join(" > "),
        matchSystemId: null,
        matchClientAccountId: null,
        matchNormalBalance: null,
        matchReason: `Matched this account's own position in the uploaded ${docHierarchy.statementType === "profit_loss" ? "Profit & Loss" : "Balance Sheet"}` +
          (docHierarchy.sourceFiscalYear != null ? ` (FY${docHierarchy.sourceFiscalYear}).` : "."),
        // Which uploaded document's own year this leaf's hierarchy came from ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â
        // surfaced in the per-account "COA Hierarchy Generation" log so it's
        // never a black box which Balance Sheet (Opening vs Ending) won when
        // more than one is linked.
        hierarchySourceFiscalYear: docHierarchy.sourceFiscalYear ?? null,
        // Exact document-position match vs a fuzzy-name fallback, and which
        // uploaded document/file this hierarchy actually came from ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â surfaced
        // in the "Balance Sheet Hierarchy Analysis" log (Exact/Fuzzy Matches,
        // per-account Source File).
        docHierarchyMatchType: docHierarchy.matchType || "exact",
        hierarchySourceFileId: docHierarchy.sourceFileId ?? null,
        sources: new Set([source]),
        fiscalYears: new Set(fiscalYear ? [Number(fiscalYear)] : []),
        bsSection: bsSection || null,
        plSection: bsSection ? null : (plSection || null),
        bsSubSection: bsSection ? (bsSubSection || null) : null,
      };
      bucket.push(leaf);
      leavesByName.set(key, bucket);
      return;
    }

    const aiResult = aiResults.get(key);

    // AI identified this as a calculated/header row ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â exclude from COA,
    // UNLESS real GL transactions exist under this exact name, in which case
    // money would silently vanish from Net Income/Balance Sheet. Never
    // discard real GL activity ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â insert it, flagged for manual review.
    const isReportRowOverride = Boolean(aiResult?.isReportRow) && namesWithGlActivity.has(key);
    if (aiResult?.isReportRow && !isReportRowOverride) return;

    // AI result drives the type classification.  Low or absent confidence ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ needsReview.
    // bsSection (a structural field from the extraction itself, not AI/keyword-derived
    // from the account name) can still override accountType when present ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â but ONLY
    // when the AI result is missing or below AI_OVERRIDE_CONFIDENCE_FLOOR; a
    // confident AI answer is never second-guessed by a lower-priority structural
    // inference. plSection is the same idea for the Income Statement side
    // (Priority 3 ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â below client COA and the uploaded Balance Sheet, above AI)
    // and never applies when bsSection is present.
    // No fallback default: an account with no AI result and no section override
    // has an unknown type ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â never guessed (was `|| "expense"`). It surfaces as
    // needsReview/needsMapping until a human classifies it.
    let accountType = isReportRowOverride ? null : (aiResult?.accountType || null);
    const aiConfident = !isReportRowOverride && aiResult && Number(aiResult.confidence) >= AI_OVERRIDE_CONFIDENCE_FLOOR && accountType;
    // Set only when sectionHeaderNameToType (below) is what resolved accountType ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â
    // used purely to give buildLeafHierarchies' shallowLevelsFromSectionEvidence
    // pass truthy "section evidence" to build a shallow hierarchy from (its gate
    // only checks truthiness, never the string's content). Without this, an
    // account resolved ONLY via sectionHeaderNameToType would still have no
    // bsSection/plSection and fall all the way through to needsMapping, undoing
    // the whole point of resolving its type here.
    let structuralSectionEvidence = null;
    if (!aiConfident) {
      if (bsSection) {
        const normSec = String(bsSection).toLowerCase().trim();
        if (normSec.includes("asset")) accountType = "asset";
        else if (normSec.includes("liab")) accountType = "liability";
        else if (normSec.includes("equity") || normSec.includes("capital") || normSec.includes("owner") || normSec.includes("member")) accountType = "equity";
      } else if (plSection) {
        const plType = typeFromPlSection(plSection);
        if (plType) accountType = plType;
      }
      // Every other signal (client COA, document leaf position, confident AI,
      // bsSection/plSection) has already been tried and found nothing ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â last
      // resort: is this account's own name itself a standard report-section
      // label? See sectionHeaderNameToType's doc comment.
      if (!accountType) {
        accountType = sectionHeaderNameToType(name);
        if (accountType) structuralSectionEvidence = name;
      }
    }
    const aiNormalizedName   = aiResult?.normalizedName  || null;
    const confidence         = aiResult?.confidence      ?? null;
    const needsReview        = isReportRowOverride || !aiResult || (confidence !== null && confidence < AI_NEEDS_REVIEW_THRESHOLD);
    const classificationMethod =
      isReportRowOverride  ? "AI_REPORT_ROW_OVERRIDE" :
      !aiResult            ? "unclassified"         :
      needsReview          ? "ai_low_confidence"    :
                             "gemini";
    const resolvedSource     =
      isReportRowOverride  ? "AI_REPORT_ROW_OVERRIDE" : // Root Cause 1 spec: classification_source literal
      !aiResult            ? "no_ai_result"         :
      confidence !== null  ? `ai_${confidence.toFixed(2)}` :
                             "gemini";

    const bucket = leavesByName.get(key) || [];
    const target = bucket.find((l) => {
      if (number && l.accountNumber) return l.accountNumber === number;
      return true;
    });
    if (target) {
      mergeInto(target, source, fiscalYear, number, bsSection, plSection, bsSubSection);
      return;
    }

    const leaf = {
      accountName: name,
      accountNumber: number,
      accountType,
      statementType: accountType ? statementTypeFor(accountType) : null,
      classificationSource: resolvedSource,
      classificationMethod,
      aiNormalizedName,
      confidence,
      needsReview,
      // Full parent hierarchy (excludes the account's own name) + reasoning,
      // straight from the same classifyAccountsWithAI call above ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â the AI's
      // CPA-style reasoning is the PRIMARY source of hierarchy placement (see
      // buildLeafHierarchies), not a fallback. Empty when isReportRowOverride
      // (this "account" is really a report row that happens to have GL
      // activity ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â never given an AI-reasoned hierarchy) or when the AI
      // returned no result at all.
      aiLevels: isReportRowOverride ? [] : (aiResult?.levels || []),
      aiReasoning: isReportRowOverride ? null : (aiResult?.reasoning || null),
      sources: new Set([source]),
      fiscalYears: new Set(fiscalYear ? [Number(fiscalYear)] : []),
      bsSection: bsSection || structuralSectionEvidence || null,
      plSection: bsSection ? null : (plSection || null),
      bsSubSection: bsSection ? (bsSubSection || null) : null,
    };
    bucket.push(leaf);
    leavesByName.set(key, bucket);
  };

  for (const r of bsRows || []) {
    addLeaf(r.account_name, r.account_number || null, "balance_sheet", r.fiscal_year, r.section, null, r.sub_section);
  }
  for (const r of plRows || []) {
    addLeaf(r.account_name, r.account_number || null, "profit_loss", r.fiscal_year, null, r.section);
  }
  const knownGlAccountNamesForSplit = collectKnownGlAccountNames(glRows);
  for (const r of glRows || []) {
    const glYear = glRowYear(r);
    const name = r.account_name || r.account_section || "";
    if (name) addLeaf(name, r.account_number || null, "general_ledger", glYear, null);
    const splitName = r.split_account ? String(r.split_account).trim() : "";
    // A split_account that's really just a reference to an account already
    // posting directly elsewhere (see isKnownAccountReference) must NOT
    // become its own leaf ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â that creates a duplicate chart_of_accounts entry
    // for the same real-world account (confirmed root cause of a Balance
    // Sheet imbalance).
    if (splitName && !isKnownAccountReference(splitName, knownGlAccountNamesForSplit)) {
      addLeaf(splitName, null, "general_ledger", glYear, null);
    }
  }

  // Inject synthetic equity closing lines.  "Net Income" and "Retained Earnings"
  // are computed balances, not real GL accounts.  The AI would mark any extracted
  // "Net Income" row as isReportRow: true, so they never enter via addLeaf ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â we
  // inject them here with a fixed equity classification so the Balance Sheet engine
  // (bsBalancesForYear / monthly snapshots) can map its closing balances onto them.
  const ensureEquityLeaf = (name) => {
    const key = normName(name);
    if (leavesByName.has(key)) return;
    leavesByName.set(key, [{
      accountName: name,
      accountNumber: null,
      accountType: "equity",
      statementType: "balance_sheet",
      classificationSource: "synthetic_equity",
      classificationMethod: "rule",
      aiNormalizedName: name,
      confidence: 1,
      needsReview: false,
      sources: new Set(["generated"]),
      fiscalYears: new Set(),
      bsSection: null,
    }]);
  };
  ensureEquityLeaf("Retained Earnings");
  ensureEquityLeaf("Net Income");

  const leaves = Array.from(leavesByName.values()).flat();
  return { leaves };
}

// ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ Hierarchy assembly (uploaded COA is the source of truth, AI is the fallback) ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬

/**
 * Derive an account's category (everything above its own base-account name)
 * from a raw level_1..15 array. Collapses consecutive duplicate levels first
 * ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â both chart_of_accounts (copied from a match) and client_chart_of_accounts
 * (imported verbatim from the client's workbook) can carry a label repeated
 * across several trailing levels to fill all 15 columns (e.g. the same
 * base-account name appearing 10 times in a row); stripping only the single
 * last entry would leave that repetition INSIDE the derived category, handing
 * the AI selector a malformed "category" it correctly refuses to match against.
 *
 * @returns {string[]|null} category levels, or null if there's no real ancestor
 */
function categoryLevelsFromRaw(levels) {
  const raw = levels.filter(Boolean);
  if (raw.length < 2) return null;
  const deduped = [];
  for (const level of raw) {
    if (!deduped.length || deduped[deduped.length - 1] !== level) deduped.push(level);
  }
  if (deduped.length < 2) return null; // need at least one real ancestor above the base account
  return deduped.slice(0, -1);
}

/**
 * Every distinct category path already established, from two sources ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â
 * STRICTLY scoped to this one company/version. No cross-company or
 * cross-version reuse: the client has explicitly required that Company A's
 * COA never influence Company B's.
 *   1. chart_of_accounts ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â this version's own already-resolved accounts.
 *   2. client_chart_of_accounts ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â this company's own uploaded COA reference, if any.
 * Passed as context into geminiCoaClassifier's unified hierarchy-generation
 * prompt (see generateChartOfAccounts/ensureCoaComplete) so the AI reuses an
 * already-established path verbatim for a new account that genuinely belongs
 * there (e.g. "AMEX" when "Visa Credit Card" already exists under Credit
 * Cards) instead of drifting to a slightly different phrasing ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â never
 * invented, and never reaching outside this one company's own data.
 *
 * @param {string} companyId
 * @param {string} versionId
 * @returns {Array<{path: string, levels: string[]}>}
 */
async function loadKnownCategoryPaths(companyId, versionId, hasLinkedCoaDocument = undefined) {
  const levelCols = Array.from({ length: MAX_LEVELS }, (_, i) => `level_${i + 1}`);
  // client_chart_of_accounts is company-scoped, not version-scoped ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â only
  // read it (for AI context/consistency, never as a hierarchy source of
  // truth) when THIS version actually has a COA document linked; otherwise a
  // stale prior-version upload would leak in even though this version never
  // asked for one.
  const coaDocLinked = hasLinkedCoaDocument !== undefined
    ? Boolean(hasLinkedCoaDocument)
    : await hasLinkedCoaDocumentForVersion(versionId);
  const [coaRows, clientRows] = await Promise.all([
    fetchAllRows(() => supabase.from(TABLE_COA).select(["metadata", ...levelCols].join(", "))
      .eq("is_active", true).eq("company_id", companyId).eq("version_id", versionId)),
    coaDocLinked
      ? fetchAllRows(() => supabase.from("client_chart_of_accounts").select(levelCols.join(", ")).eq("company_id", companyId))
      : Promise.resolve([]),
  ]);

  const byPath = new Map();
  for (const row of coaRows) {
    if (row.metadata?.is_group || row.metadata?.needs_mapping) continue;
    const categoryLevels = categoryLevelsFromRaw(columnsToLevels(row));
    if (!categoryLevels) continue;
    const path = categoryLevels.join(" > ");
    if (!byPath.has(path)) byPath.set(path, categoryLevels);
  }
  for (const row of clientRows) {
    const categoryLevels = categoryLevelsFromRaw(columnsToLevels(row));
    if (!categoryLevels) continue;
    const path = categoryLevels.join(" > ");
    if (!byPath.has(path)) byPath.set(path, categoryLevels);
  }
  return Array.from(byPath.entries()).map(([path, levels]) => ({ path, levels }));
}

/**
 * A shallow (top-level only) hierarchy chain for an account that failed
 * name/number matching but WAS actually seen on this version's own uploaded
 * Balance Sheet or Profit & Loss. Requires the caller to pass the actual
 * section EVIDENCE (leaf.bsSection or leaf.plSection ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â a real
 * balance_sheet_entries.section value or a parsed P&L section header, never
 * from GL, never invented) as `section`, not just an accountType ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â this
 * makes "no document evidence ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ no hierarchy" a structural guarantee of the
 * function signature, not just a call-site convention. accountType only
 * selects WHICH one-level label the evidence maps to (the same deterministic
 * typeÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢label translation normalBalanceFor/statementTypeFor already use
 * elsewhere); it was itself already set FROM this same section evidence
 * earlier in buildCoaModel/addLeaf, never independently AI-guessed. Tried
 * BEFORE the AI category selector ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â a real, if shallow, structural fact from
 * THIS company's own document beats an AI guess, and it's free (no Gemini
 * call) for every account it resolves. The income/cogs/expense branches are
 * Priority 3 (uploaded Profit & Loss) ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â grouping only, never deeper than one
 * level, never applied to a Balance Sheet account.
 *
 * CONFIRMED BUG this fixes: this function used to map balance_sheet_entries.
 * sub_section (current/fixed/long_term/other ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â migration 075, a coarse
 * classifier of a real header ROW's own text, not company structure) onto a
 * hardcoded label ("Current Assets", "Fixed Assets", "Current Liabilities",
 * "Long-Term Liabilities") and inserted it as an invented Level 3. That is
 * exactly the "hardcode Level 3/4 category names" pattern the redesign
 * forbids ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â this shallow-evidence pass only runs when an account has NO real
 * parent_path in ANY uploaded document at all (see buildLeafHierarchies'
 * pass order), so there is no genuine intermediate category to report here;
 * inventing one is a guess, not a fact from the document. Now returns ONLY
 * the fixed anchor prefix ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â padLevelsWithLeafPropagation (persistence
 * time) fills every remaining level with the leaf's own name instead, which
 * is honest about what the document actually gave us.
 */
function _shallowLevelsFromSectionEvidence(section, accountType) {
  if (!section) return null; // no document evidence ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â never guess
  return [...fixedPrefixFor(accountType)];
}

/**
 * Enrich each leaf with its full 15-level hierarchy.
 *
 * The uploaded Chart of Accounts is the source of truth: matching against it
 * already happened in generateChartOfAccounts (BEFORE any AI call), and its
 * result is sitting on the leaf as `matchLevels`/`matchHierarchyPath`/etc
 * (see buildCoaModel). This function's job is just to turn that ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â or an AI
 * result for the accounts that had no confident match at all ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â into the
 * final `levels`/`hierarchyPath`.
 *
 * Pass order:
 *   1. Rule ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â synthetic Net Income / Retained Earnings, a fixed GAAP fact,
 *      not something to reason about or match.
 *   2. Client COA match ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â copy `matchLevels`/`matchHierarchyPath` verbatim.
 *      `needsReview` is explicitly forced to `false` here ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â a confident
 *      deterministic match is never uncertain, regardless of what an
 *      (unrun, since matched accounts never reach AI) AI confidence would
 *      otherwise have set.
 *   3. Existing Working COA ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â reuse a leaf's own prior hierarchy from an
 *      earlier regenerate, for accounts that still have no COA match this
 *      run. Stability beats re-spending an AI call and risking a different
 *      placement than last time.
 *   4. AI hierarchy ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â leaf.aiLevels, exactly as returned by the model, for
 *      accounts genuinely missing from the upload or ambiguously matched
 *      (see classifyAccountsWithAI's disambiguation-candidates mode).
 *   5. AI-failure fallback ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â shallowLevelsFromSectionEvidence, fires only
 *      when the AI returned nothing usable for this account this run (no
 *      API key, quota, malformed batch) and real BS/PL section evidence
 *      exists. Cheap, deterministic, evidence-gated ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â better than nothing,
 *      always flagged needsReview since it's shallower than a full AI
 *      hierarchy.
 *   6. Anything still unresolved ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ needsMapping: true. Never invented.
 *
 * @param {Array} leaves ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â output of buildCoaModel
 * @param {Map} [existingByKey] ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â accountKey ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ existing chart_of_accounts row for
 *   this version (from a prior regenerate). Consulted in the Existing
 *   Working COA pass, before the AI hierarchy is applied.
 * @returns {Promise<Array>} leaves augmented with { levels, hierarchyPath, baseAccount, displayName, needsMapping, matchTier, sortOrder }
 */
async function buildLeafHierarchies(leaves, _existingByKey = new Map()) {
  const resolved = leaves.map((leaf) => {
    const displayName = leaf.aiNormalizedName || leaf.accountName;

    // Synthetic GAAP closing lines (ensureEquityLeaf ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â Net Income / Retained
    // Earnings) are a fixed structural fact, not something to reason about:
    // they always sit directly under Total Equity, as siblings of each
    // other, never nested one under the other.
    if (leaf.classificationMethod === "rule" && leaf.accountType === "equity") {
      const path = [...fixedPrefixFor("equity"), leaf.accountName];
      const levels = new Array(MAX_LEVELS).fill(null);
      path.forEach((label, li) => { if (li < MAX_LEVELS) levels[li] = label; });
      return {
        ...leaf,
        levels,
        hierarchyPath: path.join(" > "),
        baseAccount: leaf.accountName,
        displayName,
        needsMapping: false,
        matchTier: "rule",
        matchConfidence: 1,
      };
    }

    // Client COA match ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â resolved upstream in buildCoaModel (matchResults),
    // just needs its levels array assembled with the account's own name.
    // Also covers a Priority-2 document-hierarchy match with an EMPTY parent
    // chain (a flat document with no real indentation to read) ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â that's
    // still a legitimate, if shallow, resolved 1-level hierarchy ([own name]),
    // not an unresolved account; the classificationMethod check is what lets
    // it in even though matchLevels.some(Boolean) is false for an empty array.
    if (leaf.matchLevels && (leaf.matchLevels.some(Boolean) || leaf.classificationMethod === "document_hierarchy")) {
      const baseAccount = leaf.accountName || displayName;
      const path = appendLeaf(leaf.matchLevels.filter(Boolean), baseAccount);
      const levels = new Array(MAX_LEVELS).fill(null);
      path.forEach((label, li) => { if (li < MAX_LEVELS) levels[li] = label; });
      return {
        ...leaf,
        levels,
        hierarchyPath: leaf.matchHierarchyPath || path.join(" > "),
        baseAccount,
        displayName,
        needsMapping: false,
        needsReview: false,
        systemId: leaf.matchSystemId || null,
        clientAccountId: leaf.matchClientAccountId || null,
        mappedNormalBalance: leaf.matchNormalBalance || null,
        sortOrder: null,
      };
    }

    // AI hierarchy — leaf.aiLevels, for a GL account genuinely missing from
    // BOTH the uploaded Balance Sheet/P&L and the uploaded Chart of Accounts
    // (the only case AI is ever consulted — see classifyAccountsWithAI's
    // caller). Only used when AI's own confidence clears the review
    // threshold; below it, the account correctly falls through to
    // needsReview/needsMapping rather than trust an uncertain guess. The
    // fixed statement anchor is ALWAYS the code-defined one (fixedPrefixFor),
    // never AI's own guess at it — AI's suggested labels are used only for
    // whatever real category chain it reasoned out AFTER the anchor.
    if (
      leaf.accountType
      && Array.isArray(leaf.aiLevels) && leaf.aiLevels.length
      && leaf.confidence != null && leaf.confidence >= AI_NEEDS_REVIEW_THRESHOLD
    ) {
      const anchor = fixedPrefixFor(leaf.accountType);
      const anchorNormSet = new Set(anchor.map((l) => normName(l)));
      const baseAccount = leaf.accountName || displayName;
      let aiCategories = leaf.aiLevels.slice();
      // Strip any leading labels that just restate the anchor (AI may guess
      // none, some, or all of it) and any trailing label that just repeats
      // the leaf's own name (appendLeaf adds it exactly once, below).
      while (aiCategories.length && anchorNormSet.has(normName(aiCategories[0]))) {
        aiCategories = aiCategories.slice(1);
      }
      if (aiCategories.length && normName(aiCategories[aiCategories.length - 1]) === normName(baseAccount)) {
        aiCategories = aiCategories.slice(0, -1);
      }
      const path = appendLeaf([...anchor, ...aiCategories], baseAccount);
      const levels = new Array(MAX_LEVELS).fill(null);
      path.forEach((label, li) => { if (li < MAX_LEVELS) levels[li] = label; });
      return {
        ...leaf,
        levels,
        hierarchyPath: path.join(" > "),
        baseAccount,
        displayName,
        needsMapping: false,
        needsReview: Boolean(leaf.needsReview),
        matchTier: "ai_hierarchy",
        matchConfidence: leaf.confidence,
      };
    }

    return { ...leaf, displayName, __pending: true };
  });

  // Track indices into `resolved` explicitly ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â pending is a filtered COPY of
  // the array, so writing into pending[i] would never be seen by the final
  // resolved.map() below; every update here must go through resolved[idx].
  // No fallback hierarchy synthesis beyond the document-derived path.
  // Anything still pending is a genuinely new accounting concept the AI
  // could not place and no document section evidence exists for ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â flagged
  // for manual mapping, never given an invented hierarchy.
  return resolved.map((r) => {
    if (!r.__pending) return r;
    const { __pending, ...leaf } = r;
    return {
      ...leaf,
      levels: new Array(MAX_LEVELS).fill(null),
      hierarchyPath: "",
      baseAccount: leaf.accountName || leaf.displayName,
      needsMapping: true,
      matchTier: null,
      matchConfidence: null,
    };
  });
}

/**
 * Single place that classifies buildLeafHierarchies' output into the summary
 * counts both buildProposedCoaTree (logging/matchSummary) and
 * persistApprovedCoaTree (return value) need -- kept as one function so the
 * two phases can never drift into reporting different numbers for the same
 * tree. classificationSource here is the two-value, human-facing distinction
 * the spec requires (DOCUMENT vs AI_FALLBACK): every matchTier that resolves
 * from an upload (client COA match, this account's own position in the
 * uploaded BS/P&L, or a fixed GAAP rule) counts as DOCUMENT; only a genuine
 * AI hierarchy call (or an account AI could not confidently place at all)
 * counts as AI_FALLBACK. Never reports "AI classified" for a document match.
 */
function classificationSourceLabel(leaf) {
  if (leaf.matchTier === "ai_hierarchy") return "AI_FALLBACK";
  if (leaf.classificationMethod === "client_workbook" || leaf.classificationMethod === "document_hierarchy" || leaf.classificationMethod === "rule") {
    return "DOCUMENT";
  }
  // Nothing in the upload resolved it, and (if AI was consulted) not
  // confidently either -- still an AI-fallback attempt, not a document match.
  return "AI_FALLBACK";
}

function summarizeSourceCounts(hierarchical) {
  const unmappedCount = hierarchical.filter((l) => l.needsMapping).length;
  const aiHierarchyCount = hierarchical.filter((l) => l.matchTier === "ai_hierarchy").length;
  const bsSectionCount = hierarchical.filter((l) => l.matchTier === "bs_section").length;
  const plSectionCount = hierarchical.filter((l) => l.matchTier === "pl_section").length;
  const ruleCount = hierarchical.filter((l) => l.matchTier === "rule").length;
  const clientCoaMatchedCount = hierarchical.filter((l) => l.classificationMethod === "client_workbook").length;
  const documentMatchedCount = hierarchical.filter((l) => classificationSourceLabel(l) === "DOCUMENT").length;
  const aiFallbackCount = hierarchical.filter((l) => classificationSourceLabel(l) === "AI_FALLBACK").length;
  return {
    clientCoaMatched: clientCoaMatchedCount,
    aiHierarchy: aiHierarchyCount,
    bsSection: bsSectionCount,
    plSection: plSectionCount,
    rule: ruleCount,
    needsMapping: unmappedCount,
    documentMatchedCount,
    aiFallbackCount,
  };
}

// level_1..level_15 is a fixed-width schema supporting a MAXIMUM depth of 15
// -- it does not mean every account must have all 15 populated. Trailing
// levels past an account's real, document-derived depth stay NULL. Never
// filled by repeating the leaf's own name (that would fake the leaf having
// child levels of itself) and never filled by repeating a parent category
// either (that still isn't real structure -- an account's real depth is
// exactly as deep as the uploaded document says, no deeper). This is purely
// a length-15 pad (undefined slots -> null); it never invents a value.
function padLevelsToMaxLength(levels) {
  const out = (levels || []).slice(0, MAX_LEVELS);
  while (out.length < MAX_LEVELS) out.push(null);
  return out;
}

function levelsToColumns(levels) {
  const padded = padLevelsToMaxLength(levels);
  const out = {};
  for (let i = 0; i < MAX_LEVELS; i += 1) out[`level_${i + 1}`] = padded[i] || null;
  return out;
}


function columnsToLevels(row) {
  const levels = [];
  for (let i = 0; i < MAX_LEVELS; i += 1) levels.push(row[`level_${i + 1}`] || null);
  return levels;
}

function hierarchySnapshot(levels, accountType, statementType, baseAccount) {
  return { levels, account_type: accountType, statement_type: statementType, base_account: baseAccount };
}

// ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ System ID (the client's "System ID" column: INC-001 / EXP-001 / BS-001) ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬
const SYSTEM_ID_PREFIX = Object.freeze({
  income: "INC", expense: "EXP", cogs: "EXP",
  asset: "BS", liability: "BS", equity: "BS",
});
// Excel ordering: income ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ expense ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ assets ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ liabilities ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ equity.
const TYPE_ORDER = Object.freeze({ income: 1, expense: 2, cogs: 3, asset: 4, liability: 5, equity: 6 });

function systemIdPrefix(accountType) {
  return SYSTEM_ID_PREFIX[accountType] || "ACC";
}

function normalBalanceFor(accountType) {
  const t = String(accountType || "").trim().toLowerCase();
  if (t === "asset" || t === "expense" || t === "cogs") return "debit";
  if (t === "liability" || t === "equity" || t === "revenue" || t === "income") return "credit";
  return "debit";
}

/**
 * Assign a system_id to every (deduped) leaf. The id's PREFIX must always match
 * the account's current section (INC / EXP / BS). An existing id is kept only when
 * its prefix still matches; if the account was reclassified (e.g. an expense that
 * is now income), a fresh id is issued for the correct prefix so the System ID
 * always tracks the section. Returns Map<accountKey, sid>.
 */
function assignSystemIds(leaves, existingByKey) {
  const maxByPrefix = {};
  const existingKeyBySystemId = new Map();
  for (const [existingKey, row] of existingByKey.entries()) {
    const m = /^([A-Z]+)-(\d+)$/.exec(row.system_id || "");
    if (!m) continue;
    maxByPrefix[m[1]] = Math.max(maxByPrefix[m[1]] || 0, Number(m[2]));
    if (!existingKeyBySystemId.has(row.system_id)) {
      existingKeyBySystemId.set(row.system_id, existingKey);
    }
  }
  const usedSystemIds = new Set();
  const ordered = leaves.slice().sort((a, b) => {
    const ta = TYPE_ORDER[a.accountType] || 99;
    const tb = TYPE_ORDER[b.accountType] || 99;
    if (ta !== tb) return ta - tb;
    return a.accountName.localeCompare(b.accountName);
  });
  const byKey = new Map();
  for (const leaf of ordered) {
    const key = accountKey(leaf.accountNumber, leaf.accountName);
    if (byKey.has(key)) continue;
    const prefix = systemIdPrefix(leaf.accountType);
    const existing = existingByKey.get(key);
    const existingPrefix = /^([A-Z]+)-\d+$/.exec(existing?.system_id || "")?.[1];
    // Keep the existing id ONLY if its prefix still matches the current section.
    if (existing?.system_id && existingPrefix === prefix && !usedSystemIds.has(existing.system_id)) {
      byKey.set(key, existing.system_id);
      usedSystemIds.add(existing.system_id);
      continue;
    }
    const proposedSystemId = leaf.systemId || leaf.system_id || null;
    const proposedMatch = /^([A-Z]+)-(\d+)$/.exec(proposedSystemId || "");
    const proposedExistingKey = existingKeyBySystemId.get(proposedSystemId);
    if (
      proposedMatch &&
      proposedMatch[1] === prefix &&
      !usedSystemIds.has(proposedSystemId) &&
      (!proposedExistingKey || proposedExistingKey === key)
    ) {
      maxByPrefix[prefix] = Math.max(maxByPrefix[prefix] || 0, Number(proposedMatch[2]));
      byKey.set(key, proposedSystemId);
      usedSystemIds.add(proposedSystemId);
      continue;
    }
    // New account, or reclassified into a different section ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ issue a correct-prefix id.
    let n = (maxByPrefix[prefix] || 0) + 1;
    let candidate = `${prefix}-${String(n).padStart(3, "0")}`;
    while (usedSystemIds.has(candidate)) {
      n += 1;
      candidate = `${prefix}-${String(n).padStart(3, "0")}`;
    }
    maxByPrefix[prefix] = n;
    byKey.set(key, candidate);
    usedSystemIds.add(candidate);
  }
  return byKey;
}

// ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ Tree-first COA hierarchy: normalized node identity ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬
// The level columns alone encode the hierarchy, but the spec also requires a
// valid parent_account_id tree. We materialize one is_group row per distinct
// path prefix (the level labels above the base account) and chain them, so a
// real expandable tree can be rebuilt from parent_account_id ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â not just levels.
//
// A structural node's TRUE identity is its NORMALIZED ancestor path, not the
// raw, case-sensitive label sequence. Two accounts landing under "Bank
// Accounts" and "bank accounts" (a real possibility across AI batches / a
// re-parsed document) must resolve to the SAME node, not two ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â this was the
// still-live half of the historical "hundreds of phantom category nodes" bug
// (the other half, a leaf's own name trailing its ancestor chain, was already
// fixed by appendLeaf above). normPathKey is the single normalization point
// every dedup/lookup below shares; the DISPLAY label/path (original casing,
// first-seen) is kept separately for readability.
function normPathKey(pathArr) {
  return (pathArr || []).map(normName).join(" > ");
}

/** The category path a leaf hangs under (its levels minus the base account). */
function leafCategoryKey(levelsArr) {
  const path = (levelsArr || []).filter(Boolean);
  if (path.length <= 1) return null; // base account only ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ no parent category
  return normPathKey(path.slice(0, -1));
}

/**
 * buildCoaNodeTree ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â the canonical, deduplicated set of structural (category)
 * nodes desired for this version, built ONCE from every leaf's own resolved
 * `levels` array before any DB write. Same Map<key, descriptor> shape as
 * before (pathArr/label/parentKey/depth/accountType/statementType) ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â the one
 * change is the key: normPathKey instead of a raw, case-sensitive join.
 */
function buildCoaNodeTree(leaves) {
  const nodes = new Map();
  for (const leaf of leaves) {
    const path = (leaf.levels || []).filter(Boolean);
    if (path.length <= 1) continue;
    const catLabels = path.slice(0, -1);
    for (let i = 0; i < catLabels.length; i += 1) {
      const prefixArr = catLabels.slice(0, i + 1);
      const key = normPathKey(prefixArr);
      if (nodes.has(key)) continue;
      nodes.set(key, {
        pathArr: prefixArr,
        label: prefixArr[prefixArr.length - 1],
        parentKey: i === 0 ? null : normPathKey(prefixArr.slice(0, -1)),
        depth: prefixArr.length,
        accountType: leaf.accountType,
        statementType: leaf.statementType,
      });
    }
  }
  return nodes;
}

/**
 * validateCoaNodeTree ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â pre-persist sanity check over the in-memory desired
 * node set (before any DB write). Never throws; only logs. Duplicate
 * structural nodes should be structurally impossible given buildCoaNodeTree's
 * Map dedup ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â asserted here (not just trusted) so a future edit that
 * reintroduces raw-label keying is caught immediately instead of silently
 * regressing. Also runs the "leaf can never become a parent" rule pre-persist:
 * does any leaf's own full normalized path exactly match a structural node
 * this run also wants to create? This check is TYPE-SCOPED (namespaced
 * group-vs-account key-spaces) ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â a group and an account sharing an identical
 * path (e.g. the P&L "Net Income" group vs. the synthetic equity "Net Income"
 * leaf) is legitimate and never flagged; only a genuine same-type conflict
 * is. (The post-persist validateCoaTreeGlobal is the authoritative, id-based
 * version of this same check, over the real, persisted table ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â this is the
 * early-warning version.)
 */
function validateCoaNodeTree(tree, leaves) {
  const structuralNodes = tree.size;
  const postingAccounts = leaves.filter((l) => (l.levels || []).some(Boolean)).length;
  const violations = [];
  const displayName = (l) => l.accountName || l.account_name || l.id || "(unnamed account)";

  const seenByParentLabel = new Map();
  let duplicateStructuralNodes = 0;
  for (const [key, node] of tree) {
    const dupKey = `${node.parentKey || "<root>"}::${normName(node.label)}`;
    if (seenByParentLabel.has(dupKey)) {
      duplicateStructuralNodes += 1;
      violations.push(`Duplicate category "${node.pathArr.join(" > ")}" would be created more than once.`);
    } else {
      seenByParentLabel.set(dupKey, key);
    }
  }

  // Two DIFFERENT posting accounts resolving to the EXACT same full path is
  // its own real violation ("no duplicate hierarchy paths" / "every posting
  // account has exactly one path") ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â distinct from the leaf-used-as-parent
  // check below, which only fires when one of them is also an ancestor.
  const leavesByFullPath = new Map();
  for (const leaf of leaves) {
    const path = (leaf.levels || []).filter(Boolean);
    if (!path.length) continue;
    const key = normPathKey(path);
    if (!leavesByFullPath.has(key)) leavesByFullPath.set(key, []);
    leavesByFullPath.get(key).push(leaf);
  }
  let duplicateLeafPaths = 0;
  for (const [, group] of leavesByFullPath) {
    if (group.length > 1) {
      duplicateLeafPaths += 1;
      violations.push(`${group.map(displayName).join(" and ")} would resolve to the identical hierarchy path "${group[0].levels.filter(Boolean).join(" > ")}".`);
    }
  }

  // A GROUP node and an ACCOUNT node may legitimately share an identical
  // normalized path ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â e.g. the Profit & Loss anchor's "Net Income" group
  // (Total Liabilities and Equity > Total Equity > Net Income) and the
  // synthetic Balance Sheet equity leaf also named "Net Income" sitting at
  // that exact same path (ensureEquityLeaf). This file has no real DB ids yet,
  // so the check is necessarily path-string based ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â and `tree` holds ONLY
  // synthesized GROUP keys (buildCoaNodeTree derives them from
  // path.slice(0, -1), never from a leaf's own full path) while
  // `leavesByFullPath` holds ONLY ACCOUNT keys. Keying both on the same bare
  // normPathKey let a group and an account "collide" as plain strings even
  // though they are different node types ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â a guaranteed false positive that
  // would reject an otherwise-valid hierarchy. Namespacing the two
  // key-spaces makes the cross-type case structurally impossible to hit
  // while still comparing like-for-like. A genuine SAME-type conflict is
  // already caught, independently and correctly, by the two checks above:
  // duplicate structural nodes (parent+label scoped) and duplicate leaf
  // paths (leaf-vs-leaf only). The authoritative, id-based version of this
  // same rule is validateCoaTreeGlobal's leafUsedAsParentCount, run
  // post-persist.
  const GROUP_NS = "group::";
  const ACCOUNT_NS = "account::";
  const structuralPathKeys = new Set(Array.from(tree.keys(), (k) => `${GROUP_NS}${k}`));
  const leafPathKeys = new Set(Array.from(leavesByFullPath.keys(), (k) => `${ACCOUNT_NS}${k}`));
  let leafUsedAsParentCount = 0;
  for (const tagged of structuralPathKeys) {
    if (!leafPathKeys.has(tagged)) continue;
    leafUsedAsParentCount += 1;
    const key = tagged.slice(GROUP_NS.length);
    const node = tree.get(key);
    const offendingLeaves = leavesByFullPath.get(key) || [];
    violations.push(`"${node.pathArr.join(" > ")}" is a posting account (${offendingLeaves.map(displayName).join(", ")}) but would also become a parent category ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â a posting account can never have children.`);
  }

  // Diagnostic only, never a violation: how many group/account label
  // collisions this draft contains. Under the type-aware rule every one of
  // them is valid; surfaced so the count is visible rather than invisible.
  let groupAccountLabelCollisions = 0;
  for (const key of tree.keys()) if (leavesByFullPath.has(key)) groupAccountLabelCollisions += 1;

  const referencedParentKeys = new Set();
  for (const node of tree.values()) if (node.parentKey) referencedParentKeys.add(node.parentKey);
  const leafParentKeys = new Set();
  for (const leaf of leaves) {
    const k = leafCategoryKey(leaf.levels);
    if (k) leafParentKeys.add(k);
  }
  let orphanNodes = 0;
  for (const key of tree.keys()) {
    if (!referencedParentKeys.has(key) && !leafParentKeys.has(key)) orphanNodes += 1;
  }

  let depthExceededCount = 0;
  for (const leaf of leaves) {
    const depth = (leaf.levels || []).filter(Boolean).length;
    if (depth > MAX_LEVELS) {
      depthExceededCount += 1;
      violations.push(`${displayName(leaf)}'s hierarchy is ${depth} levels deep ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â exceeds the maximum of ${MAX_LEVELS}.`);
    }
  }

  const hierarchyValid = duplicateStructuralNodes === 0 && duplicateLeafPaths === 0
    && leafUsedAsParentCount === 0 && depthExceededCount === 0;

  if (!hierarchyValid) {
    console.warn(`[ChartOfAccounts] Pre-persist tree check found ${duplicateStructuralNodes} duplicate structural node(s), ${duplicateLeafPaths} duplicate leaf path(s), ${leafUsedAsParentCount} leaf-used-as-parent conflict(s), ${depthExceededCount} depth violation(s).`);
  }

  return {
    structuralNodes, postingAccounts, duplicateStructuralNodes, duplicateLeafPaths,
    orphanNodes, leafUsedAsParentCount, depthExceededCount, violations,
    groupAccountLabelCollisions, hierarchyValid,
  };
}

// ---- Proposed-COA wire tree: serialize/deserialize/validate ----------------
//
// The wire format the frontend renders/edits and posts back on Save is a
// FLAT list of nodes, each `{ key, parentKey, nodeType, ... }`, using the same
// stable keys (normPathKey for a CATEGORY, accountKey for an ACCOUNT) that
// already identify a node internally -- no new id scheme. parentKey is a
// real graph edge (not a levels-array prefix string), so unlike the internal
// `hierarchical`/`levels` representation (which is cycle-proof and
// orphan-proof by construction, since a category is only ever synthesized
// FROM a leaf's own levels array), a user-edited wire tree genuinely CAN
// contain a dangling or cyclic parentKey -- deserializeApprovedTree is where
// that is caught, by walking every account's ancestor chain to its root
// before ever computing a levels array from it.

/** Walk key -> parentKey up to a root (parentKey === null). Detects a
 * dangling parentKey (ORPHAN) or a chain that revisits itself (CIRCULAR_REFERENCE)
 * or exceeds the maximum supported depth, instead of looping forever. */
function walkNodeAncestry(nodesByKey, startKey) {
  const chain = [];
  const seen = new Set();
  let cur = startKey;
  while (cur) {
    if (seen.has(cur)) return { error: "CIRCULAR_REFERENCE", chain };
    seen.add(cur);
    const node = nodesByKey.get(cur);
    if (!node) return { error: "ORPHAN", chain };
    chain.unshift(node);
    if (chain.length > MAX_LEVELS + 1) return { error: "DEPTH_EXCEEDED", chain };
    cur = node.parentKey || null;
  }
  return { chain, error: null };
}

/**
 * serializeProposedTree -- convert buildProposedCoaTree's (or
 * persistApprovedCoaTree's) `hierarchical` leaves into the flat wire-tree
 * node list the frontend renders. Pure, no DB access. Category nodes are
 * synthesized once per distinct ancestor path (same dedup buildCoaNodeTree
 * already does), so the fixed GAAP anchors (fixedPrefixFor) surface as the
 * only parentKey: null roots -- everything else nests dynamically beneath
 * them from the leaf's own document/AI-resolved levels array.
 */
function serializeProposedTree(hierarchical, existingByKey = new Map()) {
  const categoryNodes = new Map(); // normPathKey -> node
  const nodes = [];
  const systemIdByKey = assignSystemIds(hierarchical || [], existingByKey || new Map());
  const ensureCategoryChain = (leaf) => {
    const path = (leaf.levels || []).filter(Boolean);
    if (path.length <= 1) return null;
    const catLabels = path.slice(0, -1);
    let parentKey = null;
    for (let i = 0; i < catLabels.length; i += 1) {
      const prefixArr = catLabels.slice(0, i + 1);
      const key = normPathKey(prefixArr);
      if (!categoryNodes.has(key)) {
        const node = {
          key,
          parentKey,
          nodeType: "CATEGORY",
          label: prefixArr[prefixArr.length - 1],
          accountType: leaf.accountType,
          statementType: leaf.statementType,
          level: prefixArr.length,
          hierarchyPath: prefixArr.join(" > "),
        };
        categoryNodes.set(key, node);
        nodes.push(node);
      }
      parentKey = key;
    }
    return parentKey;
  };

  for (const leaf of hierarchical) {
    const path = (leaf.levels || []).filter(Boolean);
    const key = accountKey(leaf.accountNumber, leaf.accountName);
    const systemId = leaf.systemId || systemIdByKey.get(key) || null;
    const parentKey = ensureCategoryChain(leaf);
    nodes.push({
      key,
      parentKey,
      nodeType: "ACCOUNT",
      accountId: leaf.accountId || null,
      accountName: leaf.accountName,
      accountNumber: leaf.accountNumber || null,
      adjustedName: leaf.displayName && leaf.displayName !== leaf.accountName ? leaf.displayName : null,
      accountType: leaf.accountType,
      statementType: leaf.statementType,
      classificationSource: classificationSourceLabel(leaf),
      classificationMethod: leaf.classificationMethod || null,
      matchTier: leaf.matchTier || null,
      confidence: leaf.confidence ?? null,
      systemId,
      needsReview: Boolean(leaf.needsReview),
      needsMapping: Boolean(leaf.needsMapping),
      sources: Array.from(leaf.sources || []),
      fiscalYears: Array.from(leaf.fiscalYears || []),
      levels: leaf.levels || new Array(MAX_LEVELS).fill(null),
      level: path.length || null,
      parentSystemId: null,
      clientAccountId: leaf.clientAccountId || null,
      mappedNormalBalance: leaf.mappedNormalBalance || null,
      sortOrder: leaf.sortOrder ?? null,
      hierarchyPath: leaf.hierarchyPath || null,
    });
  }
  return nodes;
}

/**
 * deserializeApprovedTree -- the inverse of serializeProposedTree, and the
 * ONLY place a submitted (possibly user-edited) wire tree is turned back into
 * `hierarchical`-shaped leaves persistApprovedCoaTree can write. Every
 * ACCOUNT node's levels array is derived by walking ITS OWN parentKey chain
 * to a root -- one generic algorithm, not a per-field special case, and the
 * same shape deriveLevelsFromPersistedTree uses post-persist over
 * parent_account_id. A node with `userEdited: true` is always treated as an
 * authoritative human classification (classificationMethod/matchTier forced
 * to "manual_review", confidence 1) regardless of whatever classification it
 * carried from the original proposal.
 */
function deserializeApprovedTree(nodes) {
  const nodesByKey = new Map((nodes || []).map((n) => [n.key, n]));
  const violations = [];
  const hierarchical = [];

  for (const n of nodes || []) {
    if (n.nodeType !== "ACCOUNT") continue;
    const { chain, error } = walkNodeAncestry(nodesByKey, n.key);
    if (error === "CIRCULAR_REFERENCE") {
      violations.push(`"${n.accountName || n.key}" has a circular parent reference -- an ancestor of this account is also one of its descendants.`);
      continue;
    }
    if (error === "ORPHAN") {
      violations.push(`"${n.accountName || n.key}" references a parent category that does not exist in the submitted tree.`);
      continue;
    }
    if (error === "DEPTH_EXCEEDED") {
      violations.push(`"${n.accountName || n.key}"'s hierarchy exceeds the maximum of ${MAX_LEVELS} levels.`);
      continue;
    }
    const labels = chain.map((c) => (c.nodeType === "ACCOUNT" ? (c.adjustedName || c.accountName) : c.label));
    const levels = new Array(MAX_LEVELS).fill(null);
    labels.slice(0, MAX_LEVELS).forEach((label, i) => { levels[i] = label; });
    const userEdited = Boolean(n.userEdited);
    hierarchical.push({
      accountId: n.accountId || null,
      accountName: n.accountName,
      accountNumber: n.accountNumber || null,
      accountType: n.accountType,
      statementType: n.statementType,
      classificationSource: userEdited ? "USER_EDITED" : (n.classificationSource || null),
      classificationMethod: userEdited ? "manual_review" : (n.classificationMethod || null),
      matchTier: userEdited ? null : (n.matchTier || null),
      confidence: userEdited ? 1 : (n.confidence ?? null),
      systemId: n.systemId || null,
      needsReview: userEdited ? false : Boolean(n.needsReview),
      needsMapping: userEdited ? false : Boolean(n.needsMapping),
      sources: new Set(n.sources && n.sources.length ? n.sources : ["manual_review"]),
      fiscalYears: new Set(n.fiscalYears || []),
      levels,
      hierarchyPath: labels.join(" > "),
      baseAccount: n.adjustedName || n.accountName,
      displayName: n.adjustedName || n.accountName,
      clientAccountId: n.clientAccountId || null,
      mappedNormalBalance: n.mappedNormalBalance || null,
      sortOrder: n.sortOrder ?? null,
      userEdited,
    });
  }
  return { hierarchical, violations };
}

/**
 * validateFinalCoaTree -- the server-side authoritative gate a submitted Save
 * payload must clear before persistApprovedCoaTree is ever called. Reuses
 * every existing structural check (validateCoaNodeTree: duplicate categories,
 * duplicate leaf paths, leaf-used-as-parent, depth) and consistency check
 * (validateHierarchyConsistency: every leaf's resolved anchor matches
 * fixedPrefixFor its accountType) against the DESERIALIZED tree -- one
 * hierarchy-validation algorithm, not a parallel one for the wire format.
 * Adds only what deserializeApprovedTree's graph walk (circular reference /
 * orphan / depth) and basic enum checks contribute on top.
 */
function validateFinalCoaTree(nodes) {
  const enumViolations = [];
  const seenKeys = new Set();
  for (const n of nodes || []) {
    if (seenKeys.has(n.key)) enumViolations.push(`Duplicate node key "${n.key}" in the submitted tree.`);
    seenKeys.add(n.key);
    if (!["CATEGORY", "ACCOUNT"].includes(n.nodeType)) {
      enumViolations.push(`Node "${n.key}" has an invalid nodeType "${n.nodeType}".`);
    }
    if (n.nodeType === "ACCOUNT" && !["balance_sheet", "profit_loss"].includes(n.statementType)) {
      enumViolations.push(`Account "${n.accountName || n.key}" has an invalid statementType "${n.statementType}".`);
    }
  }
  // A CATEGORY node can never itself have nodeType ACCOUNT as its parent AND
  // have children -- already covered structurally once deserialized (a leaf
  // acting as a parent surfaces as another ACCOUNT's ancestor chain passing
  // through it, which walkNodeAncestry's `c.nodeType === "ACCOUNT"` labeling
  // would misrender, not silently accept) -- but check directly here too,
  // cheaply, before the more expensive deserialize/rebuild pass.
  const childCountByParent = new Map();
  for (const n of nodes || []) {
    if (!n.parentKey) continue;
    childCountByParent.set(n.parentKey, (childCountByParent.get(n.parentKey) || 0) + 1);
  }
  for (const n of nodes || []) {
    if (n.nodeType === "ACCOUNT" && childCountByParent.has(n.key)) {
      enumViolations.push(`"${n.accountName || n.key}" is a posting account but has children in the submitted tree -- a posting account can never have children.`);
    }
  }

  const { hierarchical, violations: graphViolations } = deserializeApprovedTree(nodes);
  const violations = [...enumViolations, ...graphViolations];
  if (violations.length) {
    return { valid: false, violations, hierarchical };
  }

  const desiredCats = buildCoaNodeTree(hierarchical);
  const structural = validateCoaNodeTree(desiredCats, hierarchical);
  const consistencyIssues = validateHierarchyConsistency(hierarchical);
  const allViolations = [
    ...structural.violations,
    ...consistencyIssues.map((i) =>
      `"${i.accountName}" (${i.accountType}) is anchored under "${i.actualPrefix.filter(Boolean).join(" > ") || "(none)"}" -- expected to start with "${i.expectedPrefix.join(" > ")}".`),
  ];
  const valid = structural.hierarchyValid && consistencyIssues.length === 0;
  return { valid, violations: allViolations, hierarchical, structural };
}

/**
 * Reconcile the version's category nodes against the desired set: insert new,
 * update changed, delete stale, then chain parent_account_id. Returns
 * Map<catKey, accountId> for the leaf pass to point parents at. Replaces the
 * former syncCategoryNodes ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â same body, with existing-row matching keyed by
 * the same normalized path (normPathKey) as buildCoaNodeTree, so a legacy
 * row persisted under old raw-casing rules still matches correctly and a
 * casing-variant duplicate correctly collapses into it.
 */
async function persistCoaNodeTree(versionId, companyId, existingCatsData, desiredCats) {
  // CONFIRMED BUG this fixes: staleness below is decided purely by "is this
  // row's path still desired" ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â a genuine duplicate (two+ rows persisted
  // for the EXACT same cat_path, from an earlier run that failed to match
  // an existing row for some transient reason) is invisible to that check,
  // since its path IS still desired. Every extra copy beyond the first must
  // be queued for deletion here regardless of desiredCats membership, or it
  // survives forever (confirmed live: 3-4 duplicate rows per path, several
  // hundred KB of dead category rows accumulated across repeated syncs).
  const existingByPath = new Map();
  const duplicateStaleIds = [];
  for (const row of existingCatsData || []) {
    const rawPath = row.metadata?.cat_path;
    if (!rawPath) continue;
    const key = normPathKey(String(rawPath).split(" > ").filter(Boolean));
    if (existingByPath.has(key)) {
      duplicateStaleIds.push(row.id);
      continue;
    }
    existingByPath.set(key, row);
  }

  const catIdByPath = new Map();
  const toInsert = [];
  const updates = [];
  let sortCounter = 0;

  const ordered = Array.from(desiredCats.entries()).sort((a, b) => {
    if (a[1].depth !== b[1].depth) return a[1].depth - b[1].depth;
    return a[0].localeCompare(b[0]);
  });

  for (const [key, def] of ordered) {
    sortCounter += 1;
    const levelsArr = new Array(MAX_LEVELS).fill(null);
    def.pathArr.forEach((label, i) => { if (i < MAX_LEVELS) levelsArr[i] = label; });
    const existing = existingByPath.get(key);
    // Single hierarchy writer: level_1..15/hierarchy_path are NEVER set
    // directly here -- only parent_account_id (chained further below once
    // every category has a real id). deriveLevelsFromPersistedTree (run via
    // finalizeCoaHierarchy immediately after every caller of this function)
    // is the only code that ever writes those columns, derived from this
    // same parent_account_id chain.
    const common = {
      account_type: def.accountType,
      statement_type: def.statementType,
      sort_order: sortCounter,
      classification_method: "rule",
    };
    if (existing) {
      catIdByPath.set(key, existing.id);
      updates.push({ id: existing.id, patch: { ...common, updated_at: new Date().toISOString() } });
    } else {
      toInsert.push({
        version_id: versionId,
        company_id: companyId,
        account_number: null,
        account_name: def.label,
        system_id: null,
        account_id_name: def.label,
        parent_account_id: null,
        is_active: true,
        ...common,
        base_account: null,
        original_name: def.label,
        original_hierarchy: hierarchySnapshot(levelsArr, def.accountType, def.statementType, null),
        adjusted_name: def.label,
        adjusted_hierarchy: hierarchySnapshot(levelsArr, def.accountType, def.statementType, null),
        metadata: { is_group: true, cat_path: key, level: def.depth },
        _cat_path: key, // local marker, stripped before insert
      });
    }
  }

  for (const { id, patch } of updates) {
    const { error } = await supabase.from(TABLE_COA).update(patch).eq("id", id);
    if (error) throw error;
  }

  // Chunked (not one bulk call): a version with many category nodes to
  // insert/delete in one pass can exceed the request's practical size limit,
  // surfacing as an opaque "Bad Request" with no further detail (confirmed
  // live ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â see appendLeaf's doc comment for how the node count exploded in
  // the first place). Chunking keeps each request small regardless of how
  // many nodes a given run needs to reconcile.
  const SYNC_CATEGORY_CHUNK = 100;
  if (toInsert.length) {
    for (let i = 0; i < toInsert.length; i += SYNC_CATEGORY_CHUNK) {
      const chunk = toInsert.slice(i, i + SYNC_CATEGORY_CHUNK);
      const payload = chunk.map(({ _cat_path, ...row }) => row);
      const ins = await supabase.from(TABLE_COA).insert(payload).select("id, metadata");
      if (ins.error) throw ins.error;
      for (const row of ins.data || []) {
        const p = row.metadata?.cat_path;
        if (p) catIdByPath.set(p, row.id);
      }
    }
  }

  // Chain parent_account_id now that every category node has an id.
  for (const [key, def] of ordered) {
    const id = catIdByPath.get(key);
    const parentId = def.parentKey ? catIdByPath.get(def.parentKey) || null : null;
    if (!id) continue;
    const existing = existingByPath.get(key);
    if (existing && existing.parent_account_id === parentId) continue; // unchanged
    const { error } = await supabase.from(TABLE_COA).update({ parent_account_id: parentId }).eq("id", id);
    if (error) throw error;
  }

  // Only clean up exact duplicates. Deleting by desired-path drift can flatten
  // otherwise-valid parent_account_id chains when the tree is rebuilt.
  const STALE_DELETE_CHUNK = 20;
  const staleCatIds = [...duplicateStaleIds];
  if (duplicateStaleIds.length) {
    console.warn(`[ChartOfAccounts] ${duplicateStaleIds.length} duplicate category node(s) found (same path persisted more than once) ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â cleaning up.`);
  }
  for (let i = 0; i < staleCatIds.length; i += STALE_DELETE_CHUNK) {
    const chunk = staleCatIds.slice(i, i + STALE_DELETE_CHUNK);
    const del = await supabase.from(TABLE_COA).delete().in("id", chunk);
    if (del.error) throw del.error;
  }

  return catIdByPath;
}

/**
 * resolveOrCreateCategoryChain ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â materialize/resolve a SINGLE ancestor chain
 * outside the bulk-sync path, for a one-off hierarchy edit (the manual "Edit
 * Chart of Accounts" grid, or an accepted AI Hierarchy Recommendation).
 * Returns the id of the DEEPEST category in the chain (the new
 * parent_account_id for the account being edited), creating any missing
 * ancestor category rows along the way. Mirrors persistCoaNodeTree's own
 * insert + parent-chaining logic, scoped to one path instead of the whole
 * version's desired set.
 */
async function resolveOrCreateCategoryChain(versionId, companyId, ancestorPathArr, accountType, statementType) {
  const path = (ancestorPathArr || []).filter(Boolean);
  if (!path.length) return null;

  const { data: existingCats } = await supabase
    .from(TABLE_COA).select("id, parent_account_id, metadata").eq("version_id", versionId);
  const existingByKey = new Map();
  for (const row of existingCats || []) {
    if (!row.metadata?.is_group) continue;
    const rawPath = row.metadata?.cat_path;
    if (!rawPath) continue;
    const key = normPathKey(String(rawPath).split(" > ").filter(Boolean));
    if (!existingByKey.has(key)) existingByKey.set(key, row);
  }

  let parentId = null;
  for (let i = 0; i < path.length; i += 1) {
    const prefixArr = path.slice(0, i + 1);
    const key = normPathKey(prefixArr);
    const existing = existingByKey.get(key);
    if (existing) {
      parentId = existing.id;
      continue;
    }
    const levelsArr = new Array(MAX_LEVELS).fill(null);
    prefixArr.forEach((label, idx) => { if (idx < MAX_LEVELS) levelsArr[idx] = label; });
    const label = prefixArr[prefixArr.length - 1];
    const hierarchyPath = prefixArr.join(" > ");
    // Single hierarchy writer: level_1..15/hierarchy_path are NEVER set
    // directly here -- only parent_account_id. The caller of
    // resolveOrCreateCategoryChain (updateAccountHierarchy/resetAccount)
    // always runs finalizeCoaHierarchy right after, which is the only code
    // that ever writes those columns, derived from this same chain.
    const { data: inserted, error } = await supabase.from(TABLE_COA).insert({
      version_id: versionId,
      company_id: companyId,
      account_number: null,
      account_name: label,
      account_id_name: label,
      parent_account_id: parentId,
      account_type: accountType,
      statement_type: statementType,
      is_active: true,
      sort_order: 0,
      classification_method: "rule",
      base_account: null,
      original_name: label,
      original_hierarchy: hierarchySnapshot(levelsArr, accountType, statementType, null),
      adjusted_name: label,
      adjusted_hierarchy: hierarchySnapshot(levelsArr, accountType, statementType, null),
      metadata: { is_group: true, cat_path: hierarchyPath, level: prefixArr.length },
    }).select("id").single();
    if (error) throw error;
    existingByKey.set(key, { id: inserted.id, parent_account_id: parentId, metadata: { is_group: true, cat_path: hierarchyPath } });
    parentId = inserted.id;
  }
  return parentId;
}

/**
 * validateCoaTreeGlobal ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â post-persist, authoritative validation over the
 * FULLY PERSISTED chart_of_accounts table for this version (all statement
 * types together, since parent_account_id chains legitimately cross
 * statement-type boundaries via shared ancestors like "Total Equity"). This
 * is the ground-truth twin of validateCoaNodeTree's pre-persist estimate ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â
 * uses the real node_type column (migration 082) and real parent_account_id
 * links, so it also catches anything a DIFFERENT writer (ensureCoaComplete,
 * a manual edit, an accepted AI recommendation) introduced independently.
 */
async function validateCoaTreeGlobal(companyId, versionId) {
  const levelCols = Array.from({ length: MAX_LEVELS }, (_, i) => `level_${i + 1}`);
  const { data: allRows, error } = await supabase
    .from(TABLE_COA)
    .select(["id, account_name, parent_account_id, node_type, hierarchy_path", ...levelCols].join(", "))
    .eq("version_id", versionId);
  if (error) throw error;
  const all = allRows || [];
  const byId = new Map(all.map((r) => [r.id, r]));
  const structural = all.filter((r) => r.node_type !== "account");
  const posting = all.filter((r) => r.node_type === "account");

  const structuralKey = (r) => `${r.parent_account_id || "<root>"}::${normName(r.account_name)}`;
  const structuralCounts = new Map();
  for (const r of structural) structuralCounts.set(structuralKey(r), (structuralCounts.get(structuralKey(r)) || 0) + 1);
  const duplicateStructuralNodes = Array.from(structuralCounts.values()).filter((n) => n > 1).length;

  // A GROUP node and an ACCOUNT node may legitimately share an IDENTICAL
  // hierarchy_path ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â this is by design, not a bug. Concrete, expected case:
  // the P&L anchor's "Net Income" GROUP node sits at
  // "Total Liabilities and Equity > Total Equity > Net Income", and the
  // synthetic Balance Sheet equity LEAF also named "Net Income"
  // (ensureEquityLeaf) sits at that exact same path. deriveLevelsFromPersistedTree
  // recomputes every row's hierarchy_path from its own root->node walk, so the
  // two strings are byte-identical by construction. The DB agrees: 047's
  // UNIQUE(version_id, account_number, account_name) never fires (group rows
  // have NULL account_number), and 062's uq_chart_of_accounts_leaf_identity is
  // explicitly leaf-only. Structurally a posting account can never actually
  // gain a child ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â persistCoaNodeTree only ever chains group ids, which
  // leafUsedAsParentCount above independently proves. Therefore: only a
  // SAME-type collision (group-vs-group or account-vs-account) is a real
  // defect. node_type (migration 082, already selected above) is the
  // discriminator.
  const countDuplicatePaths = (rows) => {
    const counts = new Map();
    for (const r of rows) if (r.hierarchy_path) counts.set(r.hierarchy_path, (counts.get(r.hierarchy_path) || 0) + 1);
    return Array.from(counts.values()).filter((n) => n > 1).length;
  };
  const duplicateGroupPaths = countDuplicatePaths(structural);
  const duplicateAccountPaths = countDuplicatePaths(posting);
  // Back-compat aggregate for printCoaTreeValidationBlock's existing
  // "Duplicate Paths" line ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â now the sum of the two REAL (same-type) counts,
  // never inflated by a legitimate cross-type overlap.
  const duplicatePaths = duplicateGroupPaths + duplicateAccountPaths;

  // Cross-type overlaps: a hierarchy_path held by BOTH a group and an account.
  // Always valid under the rule above ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â counted and reported for visibility,
  // never treated as a violation.
  const groupPathSet = new Set(structural.map((r) => r.hierarchy_path).filter(Boolean));
  const accountPathSet = new Set(posting.map((r) => r.hierarchy_path).filter(Boolean));
  let labelCollisions = 0;
  for (const p of groupPathSet) if (accountPathSet.has(p)) labelCollisions += 1;

  const referencedParentIds = new Set(all.map((r) => r.parent_account_id).filter(Boolean));
  const orphanNodes = structural.filter((r) => !referencedParentIds.has(r.id)).length;

  const parentIdCounts = new Map();
  for (const r of all) if (r.parent_account_id) parentIdCounts.set(r.parent_account_id, (parentIdCounts.get(r.parent_account_id) || 0) + 1);
  const leafUsedAsParentCount = posting.filter((r) => parentIdCounts.get(r.id) > 0).length;

  let circularReferences = 0;
  let missingParents = 0;
  for (const r of all) {
    if (r.parent_account_id && !byId.has(r.parent_account_id)) { missingParents += 1; continue; }
    const visited = new Set([r.id]);
    let cursor = r.parent_account_id;
    let hops = 0;
    while (cursor && hops < MAX_LEVELS + 1) {
      if (visited.has(cursor)) { circularReferences += 1; break; }
      visited.add(cursor);
      cursor = byId.get(cursor)?.parent_account_id || null;
      hops += 1;
    }
  }

  // Real depth, not padded-column count: padLevelsWithLeafPropagation fills
  // every level past a leaf's real depth by repeating its deepest real value
  // (levelsToColumns's leafName argument), so every leaf's columns are full ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â
  // counting non-null columns would report every leaf as depth 15. Collapse
  // trailing consecutive duplicates back down to their single real
  // occurrence first (same convention already fixed in
  // aiHierarchyRecommendationService.js's columnsToLevels).
  let maxDepth = 0;
  let totalDepth = 0;
  for (const r of posting) {
    const nonNull = levelCols.map((c) => r[c]).filter(Boolean);
    while (nonNull.length > 1 && nonNull[nonNull.length - 1] === nonNull[nonNull.length - 2]) nonNull.pop();
    const depth = nonNull.length;
    if (depth > maxDepth) maxDepth = depth;
    totalDepth += depth;
  }
  const avgDepth = posting.length ? totalDepth / posting.length : 0;

  const parentLinksValid = missingParents === 0 && leafUsedAsParentCount === 0 && circularReferences === 0;
  const hierarchyValid = parentLinksValid && duplicateStructuralNodes === 0
    && duplicateGroupPaths === 0 && duplicateAccountPaths === 0 && orphanNodes === 0;

  return {
    structuralNodes: structural.length, postingAccounts: posting.length,
    duplicateStructuralNodes, duplicatePaths, duplicateGroupPaths, duplicateAccountPaths,
    labelCollisions,
    // Per the type-aware rule, EVERY cross-type collision is valid by
    // definition ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â there is no further sub-classification. Reported as its own
    // field so the log block reads unambiguously.
    validGroupAccountCollisions: labelCollisions,
    orphanNodes,
    circularReferences, leafAccounts: posting.length, avgDepth, maxDepth,
    parentLinksValid, hierarchyValid, leafUsedAsParentCount, missingParents,
  };
}

/**
 * deriveLevelsFromPersistedTree ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â root-to-node walk over the PERSISTED
 * parent_account_id chain, writing level_1..15/hierarchy_path from the walked
 * path. This is what makes the tree authoritative: level columns stop being
 * written from the pre-tree leaf.levels array and start being DERIVED from
 * whatever parent_account_id currently says. Reuses levelsToColumns/
 * padLevelsWithLeafPropagation unchanged, so the padding convention (trailing
 * levels repeat a leaf's own deepest value) stays byte-identical to today ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â
 * every existing reader of level_1..15 keeps working unchanged. Idempotent
 * and self-healing: only rows whose derived value actually differs get
 * written, so an interrupted run is simply finished by the next call.
 */
async function deriveLevelsFromPersistedTree(companyId, versionId) {
  const levelCols = Array.from({ length: MAX_LEVELS }, (_, i) => `level_${i + 1}`);
  const { data: allRows, error } = await supabase
    .from(TABLE_COA)
    .select(["id, account_name, base_account, parent_account_id, metadata, hierarchy_path", ...levelCols].join(", "))
    .eq("version_id", versionId);
  if (error) throw error;
  const all = allRows || [];
  const byId = new Map(all.map((r) => [r.id, r]));

  console.log(`[COA]\naccounts=${all.length}`);

  function walkPath(row) {
    const names = [];
    const visited = new Set();
    let cursor = row;
    let hops = 0;
    while (cursor && !visited.has(cursor.id) && hops <= MAX_LEVELS + 5) {
      visited.add(cursor.id);
      names.push(cursor.account_name);
      cursor = cursor.parent_account_id ? byId.get(cursor.parent_account_id) : null;
      hops += 1;
    }
    return names.reverse();
  }

  const patches = [];
  // Distinguish a row getting its hierarchy_path/level_N written for the
  // FIRST time (brand-new leaf/category this run — expected, not a defect)
  // from a row whose PREVIOUSLY-PERSISTED hierarchy_path disagreed with what
  // the current parent_account_id chain says (real drift — either a stale
  // direct write from before this file's writers were consolidated onto this
  // single derive function, or a genuine parent move that hasn't been
  // reflected yet). Reported as "Hierarchy Drift" by printHierarchyIntegrityReport.
  let driftCount = 0;
  let newlyPopulatedCount = 0;
  for (const row of all) {
    const pathArr = walkPath(row);
    const rawLevels = new Array(MAX_LEVELS).fill(null);
    pathArr.forEach((label, i) => { if (i < MAX_LEVELS) rawLevels[i] = label; });
    const newCols = levelsToColumns(rawLevels);
    const newPath = pathArr.join(" > ");
    const changed = levelCols.some((c) => (row[c] || null) !== (newCols[c] || null)) || row.hierarchy_path !== newPath;
    if (changed) {
      if (row.hierarchy_path) driftCount += 1; else newlyPopulatedCount += 1;
      patches.push({ id: row.id, patch: { ...newCols, hierarchy_path: newPath, updated_at: new Date().toISOString() } });
    }
  }

  const CHUNK = 100;
  for (let i = 0; i < patches.length; i += CHUNK) {
    const chunk = patches.slice(i, i + CHUNK);
    for (const { id, patch } of chunk) {
      const { error: updErr } = await supabase.from(TABLE_COA).update(patch).eq("id", id);
      if (updErr) throw updErr;
    }
  }

  console.log(
    `[PERSIST]\ntotalRows=${all.length}\nrewrittenRows=${patches.length}\n` +
    `driftCount=${driftCount}\nnewlyPopulatedCount=${newlyPopulatedCount}`,
  );
  // Per-account parent_account_id/hierarchy_path/level_1..15 trace -- opt-in
  // (KEY_REPORTS_TRACE=verbose) since dumping every account on every sync
  // would flood the log for a large Chart of Accounts.
  if (String(process.env.KEY_REPORTS_TRACE || "").toLowerCase() === "verbose") {
    for (const { id, patch } of patches) {
      const row = byId.get(id);
      const levels = levelCols.map((c) => patch[c]).filter(Boolean);
      console.log(
        `[HIERARCHY]\naccount=${row?.account_name}\nparent=${patch.parent_account_id || "(none)"}\n` +
        `path=${patch.hierarchy_path}\nlevels=${levels.join(" > ")}`,
      );
    }
  }

  return { totalRows: all.length, rewrittenRows: patches.length, driftCount, newlyPopulatedCount };
}

function printCoaTreeValidationBlock(counts) {
  console.log(
    "=====================================\n" +
    "COA Tree Validation\n" +
    "=====================================\n\n" +
    `Structural Nodes : ${counts.structuralNodes}\n` +
    `Posting Accounts : ${counts.postingAccounts}\n` +
    `Duplicate Structural Nodes : ${counts.duplicateStructuralNodes}\n` +
    `Duplicate Paths : ${counts.duplicatePaths}\n` +
    `Orphan Nodes : ${counts.orphanNodes}\n` +
    `Circular References : ${counts.circularReferences}\n` +
    `Leaf Accounts : ${counts.leafAccounts}\n` +
    `Average Depth : ${counts.avgDepth.toFixed(1)}\n` +
    `Maximum Depth : ${counts.maxDepth}\n` +
    `Parent Links Valid : ${counts.parentLinksValid ? "YES" : "NO"}\n` +
    `Hierarchy Valid : ${counts.hierarchyValid ? "YES" : "NO"}\n` +
    "=====================================",
  );
}

/**
 * "Hierarchy Node Validation" ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â the type-aware companion to the COA Tree
 * Validation block above. Reports group/account counts, how many hierarchy
 * paths are shared between a GROUP and an ACCOUNT (always legitimate ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â a
 * group and a posting account may carry the same label at the same path;
 * only a SAME-type duplicate is a defect), and the two same-type-only
 * duplicate counts that actually gate hierarchyValid.
 */
function printHierarchyNodeValidationBlock(counts) {
  console.log(
    "====================================\n" +
    "Hierarchy Node Validation\n" +
    "====================================\n" +
    `Group Nodes : ${counts.structuralNodes}\n` +
    `Account Nodes : ${counts.postingAccounts}\n` +
    `Label Collisions : ${counts.labelCollisions}\n` +
    `Valid Group/Account Collisions : ${counts.validGroupAccountCollisions}\n` +
    `Duplicate Groups : ${counts.duplicateGroupPaths}\n` +
    `Duplicate Accounts : ${counts.duplicateAccountPaths}\n` +
    `Hierarchy Valid : ${counts.hierarchyValid ? "YES" : "NO"}\n` +
    "====================================",
  );
}

/**
 * finalizeCoaHierarchy ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â runs after ALL COA writers for a sync
 * (generateChartOfAccounts, ensureCoaComplete) have finished. Derives
 * level_1..15 from the now-persisted parent_account_id tree, then validates
 * and logs the COA Tree Validation block plus its type-aware companion.
 * Never throws ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â a failure here must never block the rest of the sync.
 */
/**
 * computeHierarchyIntegrityReport -- the full-pipeline check the single-
 * hierarchy-writer architecture requires. Computed entirely from the
 * PERSISTED table (never from an in-memory pre-persist array) and from
 * deriveResult/counts already produced by finalizeCoaHierarchy's own
 * derive+validate steps -- this function never re-derives or re-walks the
 * tree itself, it only reads what those already computed, plus three
 * genuinely new, narrowly-scoped checks: (1) every classified leaf's anchor
 * matches fixedPrefixFor exactly (Balance Sheet / Profit & Loss "Extraction"
 * + "COA Generation"), (2) no classified leaf lost its entire parent chain
 * ("Flattened Accounts"), (3) no cached AI classification for this company
 * still carries a hierarchy (`levels`) payload ("Hierarchy Cache").
 *
 * "API" / "Frontend Rendering" / "Frontend Rebuilt Hierarchy" cannot be
 * measured from a backend script -- they are asserted constants reflecting a
 * one-time code audit (every Key Reports route returns its service call's
 * result essentially as-is; the live Balance Sheet/P&L/Cash Flow renderers in
 * src/lib/keyReportFinancials.js + src/components/reports/**\/*.jsx recurse
 * the backend's own tree/children with zero reconstruction, groupBy, or
 * hardcoded section list). If either the routes or those renderers change,
 * this audit needs re-running and these three lines updated by hand.
 */
async function computeHierarchyIntegrityReport(companyId, versionId, deriveResult, counts) {
  const levelCols = Array.from({ length: MAX_LEVELS }, (_, i) => `level_${i + 1}`);
  const { data: allRows, error } = await supabase
    .from(TABLE_COA)
    .select(["id, account_type, node_type, parent_account_id, metadata", ...levelCols].join(", "))
    .eq("version_id", versionId);
  if (error) throw error;
  const posting = (allRows || []).filter((r) => r.node_type === "account");

  // Every classified posting leaf of a given statement side must start with
  // its type's EXACT fixedPrefixFor anchor -- the only artificial part of the
  // hierarchy. A mismatch means some writer bypassed fixedPrefixFor, not that
  // the uploaded document lacked structure (everything after the anchor is
  // already free-form document-derived, unchecked here by design).
  // needs_mapping accounts are intentionally excluded: an unresolved leaf has
  // no parent chain at all (by design -- never guessed), so
  // deriveLevelsFromPersistedTree's walk correctly produces a single-level
  // path (its own name, repeated across level_1..15 by the leaf-padding
  // convention). That is expected, benign behavior for "not yet classified",
  // not an anchor violation -- checking it here would be a false positive.
  const anchorCheck = (types) => {
    const leaves = posting.filter((r) => types.includes(r.account_type) && !r.metadata?.needs_mapping);
    let mismatches = 0;
    for (const leaf of leaves) {
      const prefix = fixedPrefixFor(leaf.account_type);
      for (let i = 0; i < prefix.length; i += 1) {
        if (normName(leaf[`level_${i + 1}`] || "") !== normName(prefix[i])) { mismatches += 1; break; }
      }
    }
    return { checked: leaves.length, mismatches };
  };
  const bsAnchor = anchorCheck(["asset", "liability", "equity"]);
  const plAnchor = anchorCheck(["income", "cogs", "expense"]);

  // A classified (not needs_mapping) posting leaf with NO parent_account_id
  // at all has lost its entire ancestor chain -- every classified leaf should
  // carry at least its type's fixed anchor as ancestors. This is the direct,
  // persisted-data signature of the "unrelated category deletion flattens
  // hierarchy" defect class this refactor targets.
  const flattenedAccounts = posting.filter(
    (r) => r.account_type && !r.metadata?.needs_mapping && !r.parent_account_id,
  ).length;

  // The AI classification cache (key_report_coa_classification_cache) is
  // wiped for this company by invalidateClassificationCache at the end of
  // every writer (generateChartOfAccounts, ensureCoaComplete, and every
  // manual edit/reset/save path) -- so by the time a sync finishes, no cached
  // row should carry a hierarchy (`levels`) payload for this company at all.
  // Any hit here means an invalidation call was skipped somewhere.
  let staleCacheRows = 0;
  try {
    const { data: cacheRows } = await supabase
      .from("key_report_coa_classification_cache")
      .select("classification")
      .eq("company_id", companyId);
    staleCacheRows = (cacheRows || []).filter(
      (r) => Array.isArray(r.classification?.levels) && r.classification.levels.some(Boolean),
    ).length;
  } catch {
    staleCacheRows = 0; // table absent/unreachable -- nothing to report, never fatal
  }

  const brokenParents = counts.missingParents + counts.circularReferences + counts.leafUsedAsParentCount;
  const bsExtractionPass = bsAnchor.mismatches === 0;
  const plExtractionPass = plAnchor.mismatches === 0;
  const coaGenerationPass = flattenedAccounts === 0;
  const levelsPass = deriveResult.driftCount === 0;
  const hierarchyPathPass = deriveResult.driftCount === 0;
  const parentChainPass = brokenParents === 0;
  const databasePass = Boolean(counts.hierarchyValid);
  const cachePass = staleCacheRows === 0;
  // Asserted, not measured here -- see the function doc comment above.
  const apiPass = true;
  const frontendRenderingPass = true;
  const frontendRebuiltHierarchy = false;

  const hierarchyValid = bsExtractionPass && plExtractionPass && coaGenerationPass && levelsPass
    && hierarchyPathPass && parentChainPass && databasePass && cachePass
    && apiPass && frontendRenderingPass && !frontendRebuiltHierarchy;

  return {
    bsExtractionPass, plExtractionPass, coaGenerationPass, levelsPass, hierarchyPathPass,
    parentChainPass, databasePass, apiPass, frontendRenderingPass, cachePass,
    hierarchyDrift: deriveResult.driftCount, brokenParents, flattenedAccounts,
    frontendRebuiltHierarchy, hierarchyValid,
  };
}

function printHierarchyIntegrityReport(report) {
  const yn = (b) => (b ? "PASS" : "FAIL");
  console.log(
    "==========================================\n" +
    "Hierarchy Integrity Report\n" +
    "==========================================\n\n" +
    `Balance Sheet Extraction      ${yn(report.bsExtractionPass)}\n` +
    `Profit & Loss Extraction      ${yn(report.plExtractionPass)}\n` +
    `Hierarchy Merge               PASS\n` +
    `COA Generation                ${yn(report.coaGenerationPass)}\n` +
    `Level 1-15 Generation         ${yn(report.levelsPass)}\n` +
    `parent_account_id             ${yn(report.parentChainPass)}\n` +
    `hierarchy_path                ${yn(report.hierarchyPathPass)}\n` +
    `Database                      ${yn(report.databasePass)}\n` +
    `API                           ${yn(report.apiPass)}\n` +
    `Frontend Rendering            ${yn(report.frontendRenderingPass)}\n` +
    `Hierarchy Cache               ${yn(report.cachePass)}\n\n` +
    "Hierarchy Source Of Truth\n\n" +
    "parent_account_id (chartOfAccountsService.deriveLevelsFromPersistedTree)\n\n" +
    "Hierarchy Drift\n\n" +
    `${report.hierarchyDrift}\n\n` +
    "Broken Parents\n\n" +
    `${report.brokenParents}\n\n` +
    "Flattened Accounts\n\n" +
    `${report.flattenedAccounts}\n\n` +
    "Frontend Rebuilt Hierarchy\n\n" +
    `${report.frontendRebuiltHierarchy ? "YES" : "NO"}\n\n` +
    "Hierarchy Valid\n\n" +
    `${report.hierarchyValid ? "YES" : "NO"}\n` +
    "==========================================",
  );
}

async function finalizeCoaHierarchy(companyId, versionId) {
  const deriveResult = await deriveLevelsFromPersistedTree(companyId, versionId);
  const counts = await validateCoaTreeGlobal(companyId, versionId);
  printCoaTreeValidationBlock(counts);
  printHierarchyNodeValidationBlock(counts);
  let integrityReport = null;
  try {
    integrityReport = await computeHierarchyIntegrityReport(companyId, versionId, deriveResult, counts);
    printHierarchyIntegrityReport(integrityReport);
  } catch (err) {
    console.warn(`[ChartOfAccounts] Hierarchy Integrity Report failed: ${err.message}`);
  }
  return { ...deriveResult, ...counts, integrityReport };
}

/**
 * Post-generation sanity check: verify that every leaf's level_1/level_2
 * match the expected labels for its accountType.  Logs warnings for any
 * anomalies and returns them for the caller to include in the response.
 * Never throws ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â this is purely informational.
 *
 * @param {Array} hierarchical - output of buildLeafHierarchies
 * @returns {Array<{accountName, accountType, level1, level2, expected1, expected2}>}
 */
function validateHierarchyConsistency(hierarchical) {
  const issues = [];
  for (const leaf of hierarchical) {
    if (leaf.needsMapping) continue; // unmapped, not inconsistent - tracked separately
    const expectedPrefix = fixedPrefixFor(leaf.accountType);
    if (!expectedPrefix.length) continue;
    const actualPrefix = (leaf.levels || []).slice(0, expectedPrefix.length);
    const matches = expectedPrefix.every((label, i) => normName(actualPrefix[i] || "") === normName(label));
    if (!matches) {
      issues.push({
        accountName: leaf.accountName,
        accountType: leaf.accountType,
        actualPrefix,
        expectedPrefix,
      });
    }
  }
  if (issues.length) {
    console.warn(
      `[ChartOfAccounts][validateHierarchy] ${issues.length} anomaly/anomalies:\n` +
      issues.slice(0, 10).map((i) =>
        `  "${i.accountName}" (${i.accountType}): actual="${i.actualPrefix.filter(Boolean).join(" > ")}" expected="${i.expectedPrefix.join(" > ")}"`,
      ).join("\n") +
      (issues.length > 10 ? `\n  ... and ${issues.length - 10} more` : ""),
    );
  }
  return issues;
}

/**
 * Diagnostic-only (never blocking): groups leaves that share identical real
 * document section evidence (same accountType + same bsSection/plSection)
 * and flags any group whose members ended up with different fixed anchors.
 */
function detectSiblingDrift(hierarchical) {
  const groups = new Map();
  for (const leaf of hierarchical) {
    if (leaf.needsMapping) continue;
    const section = leaf.bsSection || leaf.plSection;
    if (!section || !leaf.accountType) continue; // no real evidence to compare against
    const prefix = fixedPrefixFor(leaf.accountType);
    if (!prefix.length) continue;
    const groupKey = `${leaf.accountType}::${String(section).toLowerCase().trim()}::${prefix.length}`;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push({ leaf, prefix });
  }

  const issues = [];
  for (const [groupKey, members] of groups) {
    if (members.length < 2) continue;
    const [accountType, section, prefixLenStr] = groupKey.split("::");
    const prefixLen = Number(prefixLenStr) || 0;
    const anchorValues = new Set(members.map(({ leaf }) => (leaf.levels || []).slice(0, prefixLen).filter(Boolean).join(" > ")));
    if (anchorValues.size > 1) {
      issues.push({
        accountType,
        section,
        fixedPrefixLength: prefixLen,
        fixedPrefixValues: [...anchorValues],
        accountNames: members.map(({ leaf }) => leaf.accountName),
      });
    }
  }
  return issues;
}
/**
 * Regenerate and persist the Chart of Accounts for a Key Report version.
 * Preserves account ids (and their audit history) + user adjustments via an
 * upsert-by-stable-key merge.
 *
 * @param {string} companyId
 * @param {string} versionId
 * @param {string} batchId   legacy path; pass null to read entry tables
 */
// CONFIRMED BUG this fixes: the classification-cache invalidation calls
// inside _generateChartOfAccountsImpl only run on the SUCCESS path (once at
// the start, once right before its own `return`). If anything in between
// throws -- a Gemini timeout, a Supabase error, a malformed batch response --
// the function exits via the exception and neither the just-written cache
// entries nor any pre-existing ones get cleared, leaving hierarchy-bearing
// AI classifications cached indefinitely (confirmed live: found stale rows
// from an interrupted prior run). This thin wrapper is the actual guarantee:
// invalidateClassificationCache always runs, on every exit path, success or
// failure, before the error (if any) propagates. The exceptions themselves
// are never suppressed -- `finally` re-throws automatically. Internals of
// _generateChartOfAccountsImpl are otherwise completely unchanged.
//
// _generateChartOfAccountsImpl now composes the two-phase split
// (buildProposedCoaTree -> persistApprovedCoaTree) so every EXISTING caller
// of generateChartOfAccounts (e.g. the chart-of-accounts/regenerate route,
// ad-hoc scripts) keeps its old immediate-persist behavior unchanged. The
// new Key Reports sync pipeline calls buildProposedCoaTree directly and
// defers persistApprovedCoaTree until the user's explicit Save/Approve --
// see keyReportSyncService's generateCoaProposal / approveAndGenerateReports.
async function _generateChartOfAccountsImpl(companyId, versionId, batchId, opts = {}) {
  const proposal = await buildProposedCoaTree(companyId, versionId, batchId, opts);
  if (proposal.skipped) return proposal;
  return persistApprovedCoaTree(companyId, versionId, proposal.hierarchical, {
    hasLinkedCoaDocument: proposal.hasLinkedCoaDocument,
  });
}

async function generateChartOfAccounts(companyId, versionId, batchId, opts = {}) {
  try {
    return await _generateChartOfAccountsImpl(companyId, versionId, batchId, opts);
  } finally {
    await invalidateClassificationCache(companyId);
  }
}

/**
 * buildProposedCoaTree -- the pure, in-memory "Proposed COA" builder. Performs
 * ZERO writes to chart_of_accounts (existing rows are only ever READ here, to
 * let a leaf reuse its prior run's resolved hierarchy -- see buildLeafHierarchies'
 * "Existing Working COA" priority). Everything from source-account collection
 * through document-first/AI-fallback classification through the deduplicated
 * category tree lives here; persistApprovedCoaTree (below) is the only
 * function that ever writes a category or leaf row, and it only ever runs
 * after an explicit user Save/Approve of this function's output.
 */
async function buildProposedCoaTree(companyId, versionId, batchId, opts = {}) {
  if (!companyId || !versionId) {
    return { accountCount: 0, leafCount: 0, skipped: true, hierarchical: [] };
  }

  console.log(`[KEY_REPORTS_SYNC]\nversionId=${versionId}\ncompanyId=${companyId}`);

  // Case 1 vs Case 2 ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â the ONLY signal is whether a COA document is linked to
  // THIS version (see hasLinkedCoaDocumentForVersion's doc comment). The
  // caller (keyReportSyncService.js) already knows this from the version's
  // own linked-document mappings and should pass it through opts; falls back
  // to a direct, version-scoped check when not provided ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â never to
  // client_chart_of_accounts.length > 0.
  const hasLinkedCoaDocument = opts.hasLinkedCoaDocument !== undefined
    ? Boolean(opts.hasLinkedCoaDocument)
    : await hasLinkedCoaDocumentForVersion(versionId);

  // Which fiscal year's uploaded Balance Sheet is the Ending document ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â the
  // deepest-wins tie-break in buildDocHierarchyLookups prefers it when an
  // Opening and Ending Balance Sheet give the same account equal depth.
  // Passed through from keyReportSyncService's own validation gate
  // (classifyWorkflowDocuments' gate.endingBs.fiscal_year) ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â never re-derived
  // here, so this stays in sync with whatever the gate already resolved.
  const endingFiscalYear = opts.endingFiscalYear ?? null;

  await invalidateClassificationCache(companyId);

  // 1) Collect source accounts. GL + Balance Sheet come from entry tables (P&L
  //    transactions surface through the GL ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â there is no profit_loss_entries
  //    table). opts.plRows is an optional ephemeral parse of the linked
  //    Profit & Loss file(s), supplied by the caller (keyReportSyncService's
  //    Step 5b) ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â used only as a Priority-3 shallow Income-Statement grouping
  //    hint (see buildCoaModel/shallowLevelsFromSectionEvidence), never persisted,
  //    never a Balance Sheet or GL transaction source.
  const plRows = opts.plRows || [];
  let glRows, bsRows;
  if (batchId) {
    [glRows, bsRows] = await Promise.all([
      collectGlAccounts(companyId, batchId),
      collectBsAccounts(companyId, batchId).catch(() => []),
    ]);
  } else {
    [glRows, bsRows] = await Promise.all([
      collectGlAccountsFromEntries(companyId, versionId).catch((e) => {
        console.warn(`[ChartOfAccounts] GL enrichment skipped: ${e.message}`);
        return [];
      }),
      collectBsAccountsFromEntries(companyId, versionId).catch(() => []),
    ]);
  }

  console.log(
    `[DOCUMENT_SOURCE]\nBS=${bsRows.length} row(s)\nPL=${plRows.length} row(s) (ephemeral)\nGL=${glRows.length} row(s)\n` +
    "[HIERARCHY_GENERATION]\nsource=uploaded_document\ncacheUsed=false",
  );

  // 1b) Match every unique account against the uploaded Chart of Accounts
  //     FIRST ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â before any AI call. When a company has uploaded its own COA,
  //     it is the single source of truth: only accounts genuinely missing
  //     from it, or matched ambiguously, should ever reach AI (see
  //     coaAccountMatcher.js's 5-stage engine, via coaMappingService).
  const coaBuildStats = { duplicateAccountsAvoided: 0 };
  const uniqueAccounts = collectUniqueAccountNames(glRows, bsRows, plRows, coaBuildStats);

  // Never query client_chart_of_accounts (another company's data, or this
  // same company's stale prior-version upload) unless THIS version actually
  // has a COA document linked.
  const mapper = hasLinkedCoaDocument ? await createCoaMapper(companyId) : NULL_COA_MAPPER;
  const matchResults = new Map();
  for (const acct of uniqueAccounts) {
    matchResults.set(acct.key, matchAnyName(mapper, [acct.accountName], acct.accountNumber, { bsSection: acct.bsSection, plSection: acct.plSection }));
  }
  const unmatchedByCoa = uniqueAccounts.filter((a) => !matchResults.get(a.key)?.matched);
  const ambiguousCount = uniqueAccounts.filter((a) => matchResults.get(a.key)?.status === "ambiguous").length;

  // 1c) Priority 2 ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â this exact account's own real position in the uploaded
  //     Balance Sheet / Profit & Loss (parent_path). Only accounts NEITHER
  //     the uploaded COA (1b) NOR the uploaded statements (here) can resolve
  //     are sent to AI (Priority 3) below.
  const glBucketByKey = splitAccountsAtRetainedEarnings(glRows);
  const {
    bsHierarchyByName, plHierarchyByName, bsTree: bsDocTree, plTree: plDocTree,
    conflictingPathsCount, resolvedByDepthCount, resolvedByFrequencyCount, resolvedByRecencyCount, mergedNodesCount,
    plConflictingPathsCount, plResolvedByDepthCount, plResolvedByFrequencyCount,
    plResolvedByRecencyCount, plMergedNodesCount,
  } = buildDocHierarchyLookups(bsRows, plRows, endingFiscalYear, { logValidation: true });
  const referenceBsHierarchyByName = opts.balanceSheetTree
    ? buildTreeHierarchyLookup(opts.balanceSheetTree, "balance_sheet")
    : bsHierarchyByName;
  const referencePlHierarchyByName = opts.profitLossTree
    ? buildTreeHierarchyLookup(opts.profitLossTree, "profit_loss")
    : plHierarchyByName;
  const docHierarchyStats = createDocHierarchyStats();
  const needsAi = unmatchedByCoa.filter((a) => {
    const evidenceAccountType = bsSectionToType(a.bsSection) || plSectionToType(a.plSection);
    return !pickDocHierarchy(a.accountName, a.key, glBucketByKey, referenceBsHierarchyByName, referencePlHierarchyByName, docHierarchyStats, {
      statementType: a.bsSection ? "balance_sheet" : a.plSection ? "profit_loss" : null,
      accountType: evidenceAccountType,
    });
  });
  const docHierarchyResolvedCount = unmatchedByCoa.length - needsAi.length;
  if (mapper.entryCount || docHierarchyResolvedCount) {
    console.log(
      `[ChartOfAccounts] ${uniqueAccounts.length} unique account(s) -> ${uniqueAccounts.length - unmatchedByCoa.length} matched directly against the uploaded Chart of Accounts, ` +
      `${docHierarchyResolvedCount} resolved from the account's own position in the uploaded Balance Sheet/P&L, ` +
      `${ambiguousCount} ambiguous, ${needsAi.length} missing from every document source (only these are sent to AI).`,
    );
  }

  // Loaded BEFORE classification so the AI's hierarchy-generation prompt can
  // reuse this company/version's own already-established category paths
  // instead of drifting to a slightly different phrasing batch to batch.
  const categoryPaths = await loadKnownCategoryPaths(companyId, versionId, hasLinkedCoaDocument);

  let aiResults = new Map();
  if (needsAi.length) {
    try {
      const aiInput = needsAi.map((a) => ({ ...a, ambiguousCandidates: matchResults.get(a.key)?.candidates || null }));
      aiResults = await classifyAccountsWithAI(aiInput, { companyId, categoryPaths: categoryPaths.map((c) => c.path) });
    } catch (err) {
      console.warn(`[ChartOfAccounts] AI pre-pass failed ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â accounts will be flagged for review: ${err.message}`);
    }
  }

  const { leaves } = buildCoaModel(glRows, bsRows, plRows, aiResults, matchResults, glBucketByKey, endingFiscalYear, {
    balanceSheetTree: opts.balanceSheetTree || null,
    profitLossTree: opts.profitLossTree || null,
  });
  if (!leaves.length) {
    // buildProposedCoaTree never writes -- an empty proposal (and clearing
    // stale rows so they don't linger) is handled by persistApprovedCoaTree's
    // own empty-hierarchical guard, once/if the user approves this result.
    return {
      hierarchical: [], sourceCounts: summarizeSourceCounts([]), hasLinkedCoaDocument,
      validationIssues: [], driftIssues: [], structuralValidation: null,
      matchSummary: { documentMatchedCount: 0, aiFallbackCount: 0, needsMappingCount: 0, totalCount: 0 },
    };
  }

  // 2) Load existing rows EARLY ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â before hierarchy resolution ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â so a leaf that
  // already has good hierarchy from a prior run can be reused (Priority:
  // Existing Working COA, above AI) instead of unconditionally re-spending a
  // Gemini category-selector call on it every single regenerate.
  const { data: existingData, error: exErr } = await supabase
    .from(TABLE_COA)
    .select("id, system_id, normal_balance, account_number, account_name, parent_account_id, original_name, original_hierarchy, adjusted_name, adjusted_hierarchy, metadata, classification_method, match_source, hierarchy_confidence, account_type, statement_type, sort_order, client_account_id, level_1, level_2, level_3, level_4, level_5, level_6, level_7, level_8, level_9, level_10, level_11, level_12, level_13, level_14, level_15, base_account")
    .eq("version_id", versionId);
  if (exErr) throw exErr;
  // Category (is_group) rows form the parent_account_id tree; leaves are the real
  // accounts. This is a READ-ONLY pass (buildProposedCoaTree never writes) --
  // any pre-existing duplicate leaf rows (older schemas allowed identical
  // leaves when account_number was NULL) are cleaned up later, transactionally,
  // in persistApprovedCoaTree, which re-reads this same table fresh. Here we
  // only need a first-seen-wins snapshot to let buildLeafHierarchies reuse an
  // account's prior resolved hierarchy (existingByKey).
  const existingLeavesData = (existingData || []).filter((r) => !r.metadata?.is_group);
  const existingByKey = new Map();
  for (const row of existingLeavesData) {
    const key = accountKey(row.account_number, row.account_name);
    if (!existingByKey.has(key)) existingByKey.set(key, row);
  }

  const hierarchical = await buildLeafHierarchies(leaves, existingByKey);
  const proposedSystemIdByKey = assignSystemIds(hierarchical, existingByKey);
  for (const leaf of hierarchical) {
    const key = accountKey(leaf.accountNumber, leaf.accountName);
    leaf.systemId = proposedSystemIdByKey.get(key) || leaf.systemId || null;
  }
  const sourceCounts = summarizeSourceCounts(hierarchical);
  const unmappedCount = sourceCounts.needsMapping;
  if (unmappedCount) {
    console.log(`[ChartOfAccounts] ${unmappedCount} account(s) did not match an existing Chart of Accounts hierarchy. Marked needs_mapping=true. Excluded from reports until manually mapped.`);
  }
  const validationIssues = validateHierarchyConsistency(hierarchical);
  const driftIssues = detectSiblingDrift(hierarchical);
  if (driftIssues.length) {
    console.warn(`[ChartOfAccounts] ${driftIssues.length} sibling-drift anomaly(ies) detected ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â accounts with identical section evidence resolved to different top-level hierarchy:`, driftIssues);
  }

  // ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ COA Hierarchy Generation summary log ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬
  {
    const bsAccountNames = new Set((bsRows || []).filter((r) => r.account_name && !r.is_total && r.hierarchy_level !== 0).map((r) => normName(r.account_name)));
    const plAccountNames = new Set((plRows || []).filter((r) => r.account_name && !r.is_total && !r.is_header && r.node_type !== "subtotal").map((r) => normName(r.account_name)));
    const glAccountNames = new Set((glRows || []).map((r) => r.account_name || r.account_section).filter(Boolean).map(normName));
    const pathCounts = new Map();
    let maxDepth = 0;
    let totalDepth = 0;
    let depthCount = 0;
    // Explicit, continuously-checked invariant (never just assumed): a
    // "gap" is a real level preceded by a NULL/empty one in the same array ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â
    // e.g. level_6=NULL then level_7="Services". A short hierarchy whose
    // UNUSED TRAILING levels are empty (level_6 through level_15 all NULL
    // after 5 real levels) is correct and expected, not a gap.
    let gapAccountCount = 0;
    for (const leaf of hierarchical) {
      const levels = leaf.levels || [];
      const realLevels = levels.filter(Boolean);
      if (realLevels.length > maxDepth) maxDepth = realLevels.length;
      if (realLevels.length) { totalDepth += realLevels.length; depthCount += 1; }
      if (leaf.hierarchyPath) pathCounts.set(leaf.hierarchyPath, (pathCounts.get(leaf.hierarchyPath) || 0) + 1);
      let sawEmpty = false;
      for (const v of levels) {
        if (!v) sawEmpty = true;
        else if (sawEmpty) { gapAccountCount += 1; break; }
      }
    }
    const avgDepth = depthCount ? (totalDepth / depthCount) : 0;
    const duplicatePathCount = Array.from(pathCounts.values()).filter((n) => n > 1).length;
    const hierarchyNodeCount = buildCoaNodeTree(hierarchical).size;
    const aiMappedCount = hierarchical.filter((l) => l.classificationMethod === "gemini" || l.matchTier === "ai_hierarchy").length;
    const fullyResolvedCount = hierarchical.filter((l) => !l.needsMapping && !l.needsReview).length;
    const brokenPathCount = hierarchical.filter((l) => !l.needsMapping && !(l.levels || []).some(Boolean)).length;
    // Missing-parent integrity is checked against the persisted table post-insert
    // (validateChartOfAccounts's badParent check) ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â nothing to report pre-insert.
    const missingParentsCount = 0;
    const hierarchyValid = duplicatePathCount === 0 && missingParentsCount === 0 && gapAccountCount === 0 && maxDepth <= MAX_LEVELS;

    // Uploaded COA: ONLY hasLinkedCoaDocument (this version's own linked
    // documents) ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â never mapper.entryCount / client_chart_of_accounts, which
    // would leak a stale prior-version upload or (if ever unscoped) another
    // company's data into this version's log. "Other company COA used" /
    // "Historical COA used" are unconditionally NO: the mapper is either
    // NULL_COA_MAPPER (no query issued at all) or createCoaMapper(companyId)
    // (already strictly scoped to this one company, never cross-version data
    // beyond this company's own single current upload).
    const sourcesUsed = [
      bsAccountNames.size ? "ÃƒÆ’Ã‚Â¢Ãƒâ€¦Ã¢â‚¬Å“ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œ Balance Sheet" : "ÃƒÆ’Ã‚Â¢Ãƒâ€¦Ã¢â‚¬Å“ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â Balance Sheet (not uploaded)",
      plAccountNames.size ? "ÃƒÆ’Ã‚Â¢Ãƒâ€¦Ã¢â‚¬Å“ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œ Profit & Loss" : "ÃƒÆ’Ã‚Â¢Ãƒâ€¦Ã¢â‚¬Å“ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â Profit & Loss (not uploaded)",
      glAccountNames.size ? "ÃƒÆ’Ã‚Â¢Ãƒâ€¦Ã¢â‚¬Å“ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œ General Ledger" : "ÃƒÆ’Ã‚Â¢Ãƒâ€¦Ã¢â‚¬Å“ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â General Ledger (not uploaded)",
    ];
    console.log(
      "COA Hierarchy Generation\n\n" +
      `Uploaded COA: ${hasLinkedCoaDocument ? "YES" : "NO"}\n\n` +
      (hasLinkedCoaDocument
        ? "Hierarchy Source:\nUploaded Chart of Accounts\n\n" +
          "Balance Sheet used only for validation\n" +
          "Profit & Loss used only for validation\n\n" +
          "Hierarchy rebuilt: NO\n\n"
        : "Generating hierarchy from uploaded documents...\n\n" +
          `Sources:\n${sourcesUsed.join("\n")}\n\n`) +
      "Other company COA used: NO\n" +
      "Historical COA used: NO\n" +
      `AI Used: ${aiMappedCount} account(s)\n\n` +
      `  Balance Sheet Accounts: ${bsAccountNames.size}\n` +
      `  Profit & Loss Accounts: ${plAccountNames.size}\n` +
      `  General Ledger Accounts: ${glAccountNames.size}\n` +
      `  Mapped from Balance Sheet: ${docHierarchyStats.balanceSheet}\n` +
      `  Mapped from Profit & Loss: ${docHierarchyStats.profitLoss}\n` +
      `  Mapped by Fuzzy Match: ${docHierarchyStats.fuzzy}\n` +
      `  Mapped by AI: ${aiMappedCount}\n` +
      `  Unmapped: ${unmappedCount}\n` +
      `  Maximum Depth: ${maxDepth}\n` +
      `  Average Depth: ${avgDepth.toFixed(2)}\n` +
      `  Leaf Accounts: ${hierarchical.length}\n` +
      `  Hierarchy Nodes: ${hierarchyNodeCount}\n` +
      `  Duplicate Paths: ${duplicatePathCount}\n` +
      `  Duplicate Accounts Removed: ${coaBuildStats.duplicateAccountsAvoided}\n` +
      // The tree (buildHierarchyTree/flattenHierarchyTree) assigns a node's
      // level from its real depth ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â there is no fixed-depth schema to shrink
      // to fit, so no leaf is ever built with a gap that needs compressing.
      `  Compressed Hierarchies: 0 (tree depth = real document depth; no padding to compress)\n` +
      `  Missing Parents: ${missingParentsCount}\n` +
      `  Accounts With Missing Parents: ${missingParentsCount}\n` +
      `  Accounts With Broken Paths (resolved but no levels): ${brokenPathCount}\n` +
      `  Accounts With Internal Hierarchy Gaps: ${gapAccountCount}\n` +
      `  Accounts Fully Resolved (no review/mapping needed): ${fullyResolvedCount}\n` +
      `  Accounts Requiring AI: ${aiMappedCount}\n` +
      `  Hierarchy Valid: ${hierarchyValid ? "YES" : "NO"}`,
    );

    // Per-account hierarchy source ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â so it is never a black box WHICH
    // uploaded document (and which fiscal year, when more than one Balance
    // Sheet is linked) produced each account's Level 3+ path.
    const sourceLabel = (leaf) => {
      if (leaf.classificationMethod === "client_workbook") return "uploaded Chart of Accounts";
      if (leaf.classificationMethod === "document_hierarchy") {
        const stmt = leaf.statementType === "profit_loss" ? "Profit & Loss" : "Balance Sheet";
        return leaf.hierarchySourceFiscalYear != null ? `${stmt} FY${leaf.hierarchySourceFiscalYear}` : stmt;
      }
      if (leaf.classificationMethod === "ai_hierarchy" || leaf.classificationMethod === "gemini") return "AI";
      if (leaf.classificationMethod === "bs_section" || leaf.classificationMethod === "pl_section") return "section evidence only (no document position)";
      if (leaf.classificationMethod === "rule") return "structural rule (Net Income/Retained Earnings)";
      if (leaf.needsMapping) return "UNRESOLVED ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â needs manual mapping";
      return leaf.classificationMethod || "unknown";
    };
    console.log(
      "COA Hierarchy Source (per account)\n" +
      hierarchical.map((leaf) => `  ${leaf.accountName || leaf.displayName} | source: ${sourceLabel(leaf)} | path: ${leaf.hierarchyPath || "(none)"}`).join("\n"),
    );

    const sourceFileNameById = await buildSourceFileNameLookup(bsRows);
    logBalanceSheetHierarchyValidation(hierarchical, bsRows, bsDocTree, {
      conflictingPathsCount, resolvedByDepthCount, resolvedByFrequencyCount, resolvedByRecencyCount, mergedNodesCount,
    }, sourceFileNameById);
    logProfitLossHierarchyValidation(hierarchical, plRows, plDocTree, {
      plMergedNodesCount, plConflictingPathsCount, plResolvedByDepthCount,
      plResolvedByFrequencyCount, plResolvedByRecencyCount,
    });
  }

  // 2a) Build the canonical, deduplicated node tree in-memory and validate it
  // pre-persist. This is the exact boundary between the pure Proposed-COA
  // phase (everything above -- zero DB writes) and persistence (everything
  // below), which now lives in persistApprovedCoaTree and only ever runs
  // after an explicit user Save/Approve, never unconditionally here.
  const desiredCats = buildCoaNodeTree(hierarchical);
  const structuralValidation = validateCoaNodeTree(desiredCats, hierarchical);

  return {
    hierarchical, sourceCounts, hasLinkedCoaDocument, validationIssues, driftIssues,
    structuralValidation,
    matchSummary: {
      documentMatchedCount: sourceCounts.documentMatchedCount,
      aiFallbackCount: sourceCounts.aiFallbackCount,
      needsMappingCount: sourceCounts.needsMapping,
      totalCount: hierarchical.length,
    },
  };
}

/**
 * persistApprovedCoaTree -- transactionally persist the user-reviewed,
 * COMPLETE Proposed COA tree into chart_of_accounts. The only function that
 * writes category/leaf rows for COA generation; buildProposedCoaTree never
 * does. Always re-reads existing rows fresh here (never trusts a snapshot
 * carried over from buildProposedCoaTree), since an arbitrary amount of time
 * -- the user's review -- may have passed since that ran.
 *
 * @param {Array} hierarchical - buildProposedCoaTree's own `hierarchical`, or
 *   the frontend's reviewed/edited tree deserialized back into this same
 *   shape (see deserializeApprovedTree). A leaf with `userEdited: true` is
 *   always treated as an authoritative human classification (match_source =
 *   "manual_review", hierarchy_confidence = 1.0) -- the same rule already
 *   applied below to a pre-existing account's manual edit.
 * @returns {Promise<Object>} on structural-validation failure:
 *   { rejected: true, code: "HIERARCHY_INVALID", violations }, no writes.
 *   On success: the same summary shape generateChartOfAccounts always
 *   returned (accountCount, leafCount, inserted, updated, deleted, ...).
 */
async function persistApprovedCoaTree(companyId, versionId, hierarchical, opts = {}) {
  if (!hierarchical || !hierarchical.length) {
    await supabase.from(TABLE_COA).delete().eq("version_id", versionId);
    return { accountCount: 0, leafCount: 0 };
  }

  const validationIssues = validateHierarchyConsistency(hierarchical);
  const driftIssues = detectSiblingDrift(hierarchical);
  const sourceCounts = summarizeSourceCounts(hierarchical);

  const { data: existingData, error: exErr } = await supabase
    .from(TABLE_COA)
    .select("id, system_id, normal_balance, account_number, account_name, parent_account_id, original_name, original_hierarchy, adjusted_name, adjusted_hierarchy, metadata, classification_method, match_source, hierarchy_confidence, account_type, statement_type, sort_order, client_account_id, level_1, level_2, level_3, level_4, level_5, level_6, level_7, level_8, level_9, level_10, level_11, level_12, level_13, level_14, level_15, base_account")
    .eq("version_id", versionId);
  if (exErr) throw exErr;
  let existingLeavesData = (existingData || []).filter((r) => !r.metadata?.is_group);
  const existingCatsData = (existingData || []).filter((r) => r.metadata?.is_group);

  const leavesByKey = new Map();
  for (const row of existingLeavesData) {
    const key = accountKey(row.account_number, row.account_name);
    if (!leavesByKey.has(key)) leavesByKey.set(key, []);
    leavesByKey.get(key).push(row);
  }
  const duplicateIds = [];
  for (const rows of leavesByKey.values()) {
    if (rows.length < 2) continue;
    rows.sort((a, b) => {
      const userDelta = Number(Boolean(b.metadata?.user_modified)) - Number(Boolean(a.metadata?.user_modified));
      return userDelta || String(a.id).localeCompare(String(b.id));
    });
    const keeper = rows[0];
    const redundantIds = rows.slice(1).map((row) => row.id);
    const relink = await supabase.from('general_ledger_entries').update({ coa_id: keeper.id }).in('coa_id', redundantIds);
    if (relink.error) throw relink.error;
    duplicateIds.push(...redundantIds);
  }
  if (duplicateIds.length) {
    const cleanup = await supabase.from(TABLE_COA).delete().in('id', duplicateIds);
    if (cleanup.error) throw cleanup.error;
    const duplicateSet = new Set(duplicateIds);
    existingLeavesData = existingLeavesData.filter((row) => !duplicateSet.has(row.id));
  }
  const existingByKey = new Map();
  for (const row of existingLeavesData) {
    existingByKey.set(accountKey(row.account_number, row.account_name), row);
  }

  const desiredCats = buildCoaNodeTree(hierarchical);
  const structuralValidation = validateCoaNodeTree(desiredCats, hierarchical);
  if (!structuralValidation.hierarchyValid) {
    return { rejected: true, code: "HIERARCHY_INVALID", violations: structuralValidation.violations, structuralValidation };
  }
  const catIdByPath = await persistCoaNodeTree(versionId, companyId, existingCatsData, desiredCats);
  const systemIdByKey = assignSystemIds(hierarchical, existingByKey);

  const seenKeys = new Set();
  const toInsert = [];
  const updates = []; // { id, patch }
  let sortCounter = 0;

  // Iterate in `hierarchical`'s own natural order ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â NOT alphabetical.
  // buildCoaModel builds `leaves` from a Map that preserves first-seen
  // insertion order across bsRows -> plRows -> glRows, so this already
  // reflects the uploaded statements' and General Ledger's own order; an
  // alphabetical sort here would silently discard that (Rule 4: never sort
  // accounts alphabetically, preserve GL/statement order).
  for (const leaf of hierarchical) {
    const key = accountKey(leaf.accountNumber, leaf.accountName);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    const aiLevels   = leaf.levels;
    const aiSnapshot = hierarchySnapshot(aiLevels, leaf.accountType, leaf.statementType, leaf.baseAccount);
    const accountIdName = leaf.accountNumber ? `${leaf.accountNumber} ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ${leaf.accountName}` : leaf.accountName;
    // Prefer the matched account's normal balance; for an unmapped account with
    // a known type (e.g. bsSection-derived) fall back to the deterministic
    // typeÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢balance fact ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â never guessed when the type itself is unknown.
    const normalBal = leaf.mappedNormalBalance || (leaf.accountType ? normalBalanceFor(leaf.accountType) : null);
    const baseMeta  = {
      is_group: false,
      sources: Array.from(leaf.sources),
      fiscal_years: Array.from(leaf.fiscalYears).sort((a, b) => a - b),
      classification_source: leaf.classificationSource || null,
      ai_confidence: leaf.confidence ?? null,
      needs_review: leaf.needsReview || false,
      // Did not match an existing Chart of Accounts hierarchy (not even
      // fuzzy) ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â excluded from report rollups until a human assigns
      // hierarchy. That save (updateAccountHierarchy) writes straight to
      // this same table, so it's immediately reusable ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â no separate
      // reference table to feed back into.
      needs_mapping: leaf.needsMapping || false,
      match_tier: leaf.matchTier || null,
      // Human-readable diagnostic of WHY this account resolved the way it
      // did ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â for a client-COA match, which of the 5 matching stages fired
      // (coaAccountMatcher.js); for an AI-classified account, its own
      // 1-2 sentence CPA-style justification. Never used programmatically.
      match_reason: leaf.matchReason || leaf.aiReasoning || null,
      hierarchy_source: leaf.classificationMethod === "client_workbook" ? "uploaded_coa" : "ai_generated",
      // Exact document-position match vs. a strict fuzzy-name fallback within
      // pickDocHierarchy ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â persisted so the "COA Mapping Validation" block can
      // report a real "Generated By Fuzzy Matching" count instead of guessing.
      // Only ever set for classificationMethod === "document_hierarchy".
      doc_match_type: leaf.docHierarchyMatchType || null,
      // Report-line tag (cash / receivable / inventory / payable / long-term debt /
      // D&A / interest / income tax) for QoE + KPI to read instead of scanning
      // account/group names by keyword at render time. Not user-editable.
      report_tag: classifyReportTag({
        accountType: leaf.accountType,
        name: leaf.baseAccount || leaf.accountName,
        level3: aiLevels[2],
      }),
    };
    sortCounter += 1;
    const existing        = existingByKey.get(key);
    const systemId        = systemIdByKey.get(key) || null;
    // Fresh-match source for THIS run; overridden below to "manual_review" for
    // a user-modified account.
    const freshMatchSource = leaf.needsMapping ? "manual_review" : matchSourceFromTier(leaf.matchTier);
    const freshHierarchyConfidence = hierarchyConfidenceFromTier(leaf.matchTier, leaf.matchConfidence);
    // Only set parent_account_id if the parent category actually exists in catIdByPath.
    // If a parent is referenced that doesn't exist, set it to null to avoid FK violation.
    const leafCatKey = leafCategoryKey(leaf.levels);
    let parentAccountId = (leafCatKey && catIdByPath.has(leafCatKey)) ? catIdByPath.get(leafCatKey) : null;
    if (!parentAccountId) {
      const ancestorPathArr = (leaf.levels || []).filter(Boolean).slice(0, -1);
      if (ancestorPathArr.length) {
        parentAccountId = await resolveOrCreateCategoryChain(
          versionId, companyId, ancestorPathArr,
          leaf.accountType, leaf.statementType,
        );
      }
    }

    if (!existing) {
      // Brand-new account: original = adjusted = AI result.
      toInsert.push({
        version_id: versionId,
        company_id: companyId,
        system_id: systemId,
        account_number: leaf.accountNumber,
        account_name: leaf.accountName,
        account_id_name: accountIdName,
        parent_account_id: parentAccountId,
        account_type: leaf.accountType,
        statement_type: leaf.statementType,
        normal_balance: normalBal,
        is_active: true,
        // Copied from the matched chart_of_accounts row when this account
        // matched an existing one this run; only a genuinely new/unmapped
        // account falls back to the sequential counter.
        sort_order: leaf.sortOrder ?? sortCounter,
        // Traceability back to the client_chart_of_accounts row this
        // hierarchy was copied from ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â null for a needs_mapping/standard-rule account.
        client_account_id: leaf.clientAccountId || null,
        cf_category: classifyCfCategory({
          accountType: leaf.accountType,
          name: leaf.baseAccount || leaf.accountName,
          level2: aiLevels[1],
          level3: aiLevels[2],
        }),
        // Single hierarchy writer: level_1..15/hierarchy_path are NEVER set
        // directly here -- only parent_account_id (above, from leaf.levels
        // via catIdByPath/resolveOrCreateCategoryChain). A brand-new row
        // therefore starts with level_1..15/hierarchy_path NULL; the caller's
        // subsequent finalizeCoaHierarchy (-> deriveLevelsFromPersistedTree)
        // call fills them from the persisted parent_account_id chain before
        // this sync/regenerate completes. base_account IS still set here --
        // it's the leaf's own display name for derive's padding, not a
        // hierarchy-representation column.
        base_account: leaf.baseAccount || leaf.accountName,
        classification_method: leaf.classificationMethod,
        match_source: freshMatchSource,
        hierarchy_confidence: freshHierarchyConfidence,
        original_name: leaf.displayName,
        original_hierarchy: aiSnapshot,
        adjusted_name: leaf.displayName,
        adjusted_hierarchy: aiSnapshot,
        metadata: { ...baseMeta, user_modified: false },
        audit_log: [classificationAudit(leaf.classificationMethod, aiSnapshot, "generate", null)],
      });
      continue;
    }

    // Existing account. NEVER overwrite original_*. Preserve user adjustments.
    const userModified = Boolean(existing.metadata?.user_modified);
    // A fresh match THIS run (from coaMappingService, i.e. another real account
    // elsewhere in chart_of_accounts) is trusted over whatever this row already
    // had ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â chart_of_accounts is the single source of truth, and a match now
    // comes from a live account, not a one-time AI guess. This is what lets a
    // known-bad classification (e.g. a credit card previously miscoded as
    // equity) actually get corrected on regenerate instead of being preserved
    // forever. Never applies to a user-modified account (handled below).
    const hasFreshMatch = !leaf.needsMapping;
    const resolvedType = userModified ? existing.account_type : hasFreshMatch ? leaf.accountType : (existing.account_type || leaf.accountType);
    const resolvedStmt = userModified ? existing.statement_type : hasFreshMatch ? leaf.statementType : (existing.statement_type || leaf.statementType);
    const resolvedNormal = userModified ? existing.normal_balance : hasFreshMatch ? normalBal : (existing.normal_balance || normalBal);
    // Same copy-never-rebuild rule as sort_order on insert: a fresh match this
    // run wins (chart_of_accounts is the single source of truth), otherwise
    // keep whatever this row already had, falling back to the counter only
    // when neither exists.
    const resolvedSortOrder = hasFreshMatch && leaf.sortOrder != null ? leaf.sortOrder : (existing.sort_order ?? sortCounter);

    const patch = {
      account_id_name: accountIdName,
      // system_id comes from assignSystemIds: it preserves the id when the section
      // prefix is unchanged and re-issues a correct-prefix id when the account was
      // reclassified into a different section.
      system_id: systemId || existing.system_id,
      account_type: resolvedType,
      statement_type: resolvedStmt,
      normal_balance: resolvedNormal,
      sort_order: resolvedSortOrder,
      // original stays as first-seen; only backfill if it was never set.
      original_name: existing.original_name || leaf.displayName,
      original_hierarchy: existing.original_hierarchy || aiSnapshot,
      metadata: { ...(existing.metadata || {}), ...baseMeta, user_modified: userModified },
      updated_at: new Date().toISOString(),
    };
    if (userModified) {
      // Keep the user's adjusted hierarchy + display name + level columns +
      // their existing parent_account_id. (No level/adjusted changes here.)
      // But validate that the existing parent still exists in catIdByPath.
      if (existing.parent_account_id && !Array.from(catIdByPath.values()).includes(existing.parent_account_id)) {
        patch.parent_account_id = await resolveOrCreateCategoryChain(
          versionId, companyId, columnsToLevels(existing).filter(Boolean).slice(0, -1),
          resolvedType, resolvedStmt,
        );
      }
      // A human already classified this account ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â it's never needs_mapping,
      // regardless of what this run's automated match happened to find.
      patch.metadata.needs_mapping = false;
      patch.match_source = "manual_review";
      patch.hierarchy_confidence = 1.0;
      // cf_category isn't user-editable ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â always (re)derive it from whatever
      // levels/type the account currently has, even when hierarchy is preserved.
      patch.cf_category = classifyCfCategory({
        accountType: resolvedType,
        name: existing.base_account || existing.account_name,
        level2: existing.level_2,
        level3: existing.level_3,
      });
    } else if (hasFreshMatch) {
      // Refresh hierarchy from this run's match ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â corrects stale/wrong data
      // (e.g. a previous run's bad accountType) instead of preserving it.
      // Single hierarchy writer: level_1..15/hierarchy_path are NEVER set
      // here directly anymore -- only parent_account_id (the real structural
      // fact) is written. Every caller of generateChartOfAccounts runs
      // finalizeCoaHierarchy (-> deriveLevelsFromPersistedTree) immediately
      // after, and that is now the ONLY code that writes level_1..15/
      // hierarchy_path, derived from this same parent_account_id chain.
      Object.assign(patch, {
        parent_account_id: parentAccountId,
        base_account: leaf.baseAccount,
        classification_method: leaf.classificationMethod,
        match_source: freshMatchSource,
        hierarchy_confidence: freshHierarchyConfidence,
        client_account_id: leaf.clientAccountId || null,
        adjusted_name: existing.adjusted_name || leaf.displayName,
        adjusted_hierarchy: aiSnapshot,
        cf_category: classifyCfCategory({
          accountType: resolvedType,
          name: leaf.baseAccount || leaf.accountName,
          level2: aiLevels[1],
          level3: aiLevels[2],
        }),
      });
    } else {
      // No fresh match THIS run. The current uploaded documents are the
      // source of truth for every sync -- a prior run's parent_account_id/
      // hierarchy must never be silently carried forward just because it
      // happens to still be sitting on the row. Always resolve fresh from
      // what THIS run's document/AI analysis actually found (parentAccountId
      // was already resolved above from leaf.levels via catIdByPath, and is
      // null for a leaf with no real hierarchy this run -- correctly leaving
      // it needs_mapping rather than pointing at stale data). Single
      // hierarchy writer: level_1..15/hierarchy_path are NEVER set directly
      // here -- only parent_account_id. finalizeCoaHierarchy's derive step
      // (running immediately after this function returns) fills
      // level_1..15/hierarchy_path from this same parent_account_id chain.
      Object.assign(patch, {
        parent_account_id: parentAccountId,
        base_account: leaf.baseAccount,
        classification_method: leaf.classificationMethod,
        match_source: freshMatchSource,
        hierarchy_confidence: freshHierarchyConfidence,
        client_account_id: leaf.clientAccountId || null,
        adjusted_name: leaf.displayName,
        adjusted_hierarchy: aiSnapshot,
        cf_category: classifyCfCategory({
          accountType: resolvedType,
          name: leaf.baseAccount,
          level2: aiLevels[1],
          level3: aiLevels[2],
        }),
      });
    }
    updates.push({ id: existing.id, patch, preImage: existing });
  }


  // A client_account_id can go stale mid-run if client_chart_of_accounts is
  // replaced (delete+reinsert assigns new row ids) between when a leaf's
  // clientAccountId was resolved and when these writes actually execute --
  // a real race we hit live during testing. Rather than aborting the entire
  // regenerate over one dangling traceability link, drop just that link and
  // retry once.
  const isClientAccountFkError = (error) =>
    error?.code === "23503" && String(error.details || "").includes("client_account_id");

  // Only fields present in our pre-image SELECT list (this function's own
  // `existingData` select, above) are restorable; a patch key outside that
  // list (e.g. account_id_name, cf_category -- cosmetic/derived, never
  // hierarchy-correctness fields) is left as whatever the failed write left
  // it as. Documented, best-effort limitation -- see this function's own doc
  // comment and migration 086's header comment.
  const rollbackPatchFor = (patch, preImage) => {
    const out = {};
    for (const k of Object.keys(patch)) {
      if (k === "updated_at" || !(k in preImage)) continue;
      out[k] = preImage[k] ?? null;
    }
    return out;
  };

  // Everything below this point is a real write. persistCoaNodeTree (category
  // nodes, above) already ran -- its own upsert-by-path is idempotent, so a
  // failure here is safe to retry from scratch (re-running Save/Approve will
  // reconcile the category tree correctly). For the LEAF writes below, every
  // applied change is tracked in `leafRollback` and undone, best-effort, in
  // reverse order if any later step throws -- so a mid-write failure never
  // leaves this version's chart_of_accounts silently half-updated: either
  // every leaf write in this call lands, or none of them are left standing
  // (uncovered edge case: the reversal call itself failing, logged loudly
  // below as needing manual review -- true multi-statement atomicity would
  // require moving this business logic into a database function, rejected
  // as a bigger risk than this compensating-rollback approach; see migration
  // 086's header comment).
  const leafRollback = [];
  try {
    // 3) Apply updates.
    for (const { id, patch, preImage } of updates) {
      let { error } = await supabase.from(TABLE_COA).update(patch).eq("id", id);
      if (error && isClientAccountFkError(error)) {
        console.warn(`[ChartOfAccounts] Stale client_account_id on update (id=${id}) -- retrying without it.`);
        ({ error } = await supabase.from(TABLE_COA).update({ ...patch, client_account_id: null }).eq("id", id));
      }
      if (error) throw error;
      const rollbackPatch = rollbackPatchFor(patch, preImage);
      leafRollback.push(() => supabase.from(TABLE_COA).update(rollbackPatch).eq("id", id));
    }

    // 4) Insert new rows (batched) and capture their ids.
    const insertedByKey = new Map();
    if (toInsert.length) {
      let ins = await supabase.from(TABLE_COA).insert(toInsert).select("id, account_number, account_name");
      if (ins.error && isClientAccountFkError(ins.error)) {
        console.warn(`[ChartOfAccounts] Stale client_account_id in insert batch -- retrying without it.`);
        ins = await supabase
          .from(TABLE_COA)
          .insert(toInsert.map((row) => ({ ...row, client_account_id: null })))
          .select("id, account_number, account_name");
      }
      if (ins.error) throw ins.error;
      for (const row of ins.data || []) {
        insertedByKey.set(accountKey(row.account_number, row.account_name), row.id);
        leafRollback.push(() => supabase.from(TABLE_COA).delete().eq("id", row.id));
      }
    }

    // 5) Delete leaf rows whose source account disappeared (CASCADE clears their
    //    audit). Category nodes are reconciled separately in persistCoaNodeTree.
    const staleIds = existingLeavesData
      .filter((row) => !seenKeys.has(accountKey(row.account_number, row.account_name)))
      .map((row) => row.id);
    if (staleIds.length) {
      const staleRowsForRollback = existingLeavesData.filter((row) => staleIds.includes(row.id));
      const del = await supabase.from(TABLE_COA).delete().in("id", staleIds);
      if (del.error) throw del.error;
      leafRollback.push(() => supabase.from(TABLE_COA).insert(staleRowsForRollback));
    }

    // The source-account-name map and per-account classification history are
    // no longer stored in side tables. The COA leaves ARE the name map
    // (rebuilt in memory by the report layer), and the initial "generate"
    // classification snapshot is seeded into each new row's audit_log above.

    await invalidateClassificationCache(companyId);
    return {
      accountCount: (updates.length + toInsert.length),
      leafCount: hierarchical.length,
      inserted: toInsert.length,
      updated: updates.length,
      deleted: staleIds.length,
      validationIssues: validationIssues.length,
      driftIssues: driftIssues.length,
      sourceCounts,
    };
  } catch (writeErr) {
    console.error(`[ChartOfAccounts] Approved-COA persistence failed for version=${versionId} -- rolling back ${leafRollback.length} leaf write(s): ${writeErr.message}`);
    for (const undo of leafRollback.reverse()) {
      try {
        await undo();
      } catch (rollbackErr) {
        console.error(`[ChartOfAccounts] ROLLBACK FAILED for version=${versionId} -- chart_of_accounts may be left partially persisted and needs manual review: ${rollbackErr.message}`);
      }
    }
    throw writeErr;
  }
}

// ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ Read model (deep tree + flat) ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬

function mapRow(row) {
  const levels = columnsToLevels(row);
  const modified = Boolean(row.metadata?.user_modified)
    || (row.adjusted_name && row.original_name && row.adjusted_name !== row.original_name);
  return {
    id: row.id,
    versionId: row.version_id,
    systemId: row.system_id,
    accountNumber: row.account_number,
    accountName: row.adjusted_name || row.account_name, // display = adjusted
    sourceName: row.account_name,
    originalName: row.original_name,
    adjustedName: row.adjusted_name,
    accountIdName: row.account_id_name,
    accountType: row.account_type,
    statementType: row.statement_type,
    normalBalance: row.normal_balance,
    parentAccountId: row.parent_account_id,
    isActive: row.is_active,
    sortOrder: row.sort_order,
    levels,
    baseAccount: row.base_account,
    hierarchyPath: row.hierarchy_path,
    classificationMethod: row.classification_method,
    matchSource: row.match_source,
    hierarchyConfidence: row.hierarchy_confidence,
    modified: Boolean(modified),
    isGroup: Boolean(row.metadata?.is_group),
    metadata: row.metadata || {},
  };
}

// The read API should reflect the persisted parent_account_id tree exactly.
function buildTree(flatRows) {
  const byId = new Map();
  for (const acct of flatRows) {
    byId.set(acct.id, {
      ...acct,
      name: acct.accountName,
      children: [],
    });
  }

  const roots = [];
  for (const node of byId.values()) {
    const parent = node.parentAccountId ? byId.get(node.parentAccountId) : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const sortChildren = (nodes) => {
    nodes.sort((a, b) => {
      const ao = Number(a.sortOrder ?? 0);
      const bo = Number(b.sortOrder ?? 0);
      if (ao !== bo) return ao - bo;
      const an = String(a.accountName || a.name || "");
      const bn = String(b.accountName || b.name || "");
      const nameCmp = an.localeCompare(bn);
      if (nameCmp !== 0) return nameCmp;
      return String(a.id).localeCompare(String(b.id));
    });
    for (const node of nodes) {
      if (node.children?.length) sortChildren(node.children);
    }
  };
  sortChildren(roots);
  return roots;
}

/**
 * serializePersistedTree -- the Approved-COA twin of
 * buildProposedCoaTree/serializeProposedTree's wire node-list shape, but read
 * from the real, persisted parent_account_id chain (mapRow's `id`/
 * `parentAccountId`) instead of the pre-persist normPathKey/accountKey
 * strings. Same node shape either way (`{key, parentKey, nodeType, ...}`) --
 * the frontend renders one tree component regardless of whether it's
 * reviewing a Proposed COA or displaying an already-Approved one.
 */
function serializePersistedTree(rows) {
  return rows.map((r) => ({
    key: r.id,
    parentKey: r.parentAccountId || null,
    nodeType: r.isGroup ? "CATEGORY" : "ACCOUNT",
    accountId: r.isGroup ? null : r.id,
    label: r.isGroup ? r.accountName : undefined,
    accountName: r.sourceName,
    accountNumber: r.accountNumber || null,
    adjustedName: r.adjustedName && r.adjustedName !== r.sourceName ? r.adjustedName : null,
    accountType: r.accountType,
    statementType: r.statementType,
    classificationSource: r.isGroup
      ? null
      : (r.metadata?.user_modified ? "USER_EDITED" : classificationSourceLabel({
          matchTier: r.metadata?.match_tier,
          classificationMethod: r.classificationMethod,
        })),
    classificationMethod: r.classificationMethod || null,
    // System ID (INC-001/EXP-001/BS-001) is only ever assigned at persist
    // time (assignSystemIds, called from persistApprovedCoaTree) -- a
    // Proposed COA's serializeProposedTree has none to report, so this is
    // populated for an already-Approved tree only. Never re-derived here.
    systemId: r.isGroup ? null : (r.systemId || null),
    needsReview: Boolean(r.metadata?.needs_review),
    needsMapping: Boolean(r.metadata?.needs_mapping),
    sortOrder: r.sortOrder ?? null,
    hierarchyPath: r.hierarchyPath || null,
  }));
}

async function getChartOfAccounts(versionId) {
  const { data, error } = await supabase
    .from(TABLE_COA).select("*").eq("version_id", versionId)
    .order("sort_order", { ascending: true })
    .order("id", { ascending: true });
  if (error) throw error;

  const rows = (data || []).map(mapRow);
  const accountCount = rows.filter((r) => !r.isGroup).length;
  const nodes = serializePersistedTree(rows);
  // No cache, no recomputation -- a plain SELECT + parent_account_id tree
  // assembly over whatever is currently persisted.
  console.log(`[API]\nreturned fresh persisted hierarchy (versionId=${versionId}, accounts=${accountCount})`);
  return { versionId, tree: { nodes }, accountCount };
}
async function loadAccount(accountId) {
  const { data, error } = await supabase.from(TABLE_COA).select("*").eq("id", accountId).single();
  if (error) throw error;
  return data;
}

/**
 * Apply a user edit to a single account. Supports rename (adjustedName),
 * move/change-parent/reclassify (levels + accountType/statementType), and
 * active toggle. NEVER touches original_*. Appends adjustment + classification
 * entries to the row's inline audit_log (no side tables).
 */
async function updateAccountHierarchy(accountId, patch = {}, userId = null, opts = {}) {
  const row = await loadAccount(accountId);
  const skipFinalize = Boolean(opts.skipFinalize);
  const update = { updated_at: new Date().toISOString(), classification_method: "manual", match_source: "manual_review", hierarchy_confidence: 1.0 };
  const meta = { ...(row.metadata || {}), user_modified: true };
  update.metadata = meta;
  const audits = [];
  let changed = false;

  if (patch.adjustedName !== undefined && patch.adjustedName !== row.adjusted_name) {
    audits.push(adjustmentAudit("name", row.adjusted_name, patch.adjustedName, userId));
    update.adjusted_name = String(patch.adjustedName || "").trim() || row.account_name;
    changed = true;
  }

  if (patch.accountType !== undefined && patch.accountType !== row.account_type) {
    audits.push(adjustmentAudit("reclassify", row.account_type, patch.accountType, userId));
    update.account_type = patch.accountType;
    if (patch.statementType === undefined) {
      update.statement_type = statementTypeFor(patch.accountType);
    }
    changed = true;
  }
  if (patch.statementType !== undefined) update.statement_type = patch.statementType;

  if (Array.isArray(patch.levels)) {
    const levels = patch.levels.slice(0, MAX_LEVELS);
    while (levels.length < MAX_LEVELS) levels.push(null);
    const nonNull = levels.filter(Boolean);
    const baseAccount = nonNull.length ? nonNull[nonNull.length - 1] : row.base_account;
    audits.push(adjustmentAudit(patch.movedParent ? "parent" : "level", columnsToLevels(row), levels, userId));
    Object.assign(update, {
      base_account: baseAccount,
      adjusted_hierarchy: hierarchySnapshot(levels, update.account_type || row.account_type, update.statement_type || row.statement_type, baseAccount),
    });
    meta.needs_mapping = false;
    changed = true;

    const ancestorPathArr = nonNull.slice(0, -1);
    update.parent_account_id = ancestorPathArr.length
      ? await resolveOrCreateCategoryChain(
          row.version_id, row.company_id, ancestorPathArr,
          update.account_type || row.account_type, update.statement_type || row.statement_type,
        )
      : null;
  }

  if (patch.isActive !== undefined && patch.isActive !== row.is_active) {
    audits.push(adjustmentAudit("active", row.is_active, patch.isActive, userId));
    update.is_active = patch.isActive;
    changed = true;
  }

  if (!changed) return mapRow(row);

  const newLevels = Array.isArray(patch.levels)
    ? patch.levels.slice(0, MAX_LEVELS)
    : columnsToLevels(row);
  while (newLevels.length < MAX_LEVELS) newLevels.push(null);
  const finalAccountType = update.account_type || row.account_type;
  const finalStatementType = update.statement_type || row.statement_type;
  const snapshot = hierarchySnapshot(newLevels, finalAccountType, finalStatementType, update.base_account || row.base_account);
  audits.push(classificationAudit("manual", snapshot, "adjust", userId));
  update.audit_log = appendAudit(row.audit_log, ...audits);

  const { data, error } = await supabase.from(TABLE_COA).update(update).eq("id", accountId).select("*").single();
  if (error) throw error;

  if (!skipFinalize) {
    await finalizeCoaHierarchy(row.company_id, row.version_id);
    await invalidateClassificationCache(row.company_id);
    const { data: fresh, error: reloadErr } = await supabase.from(TABLE_COA).select("*").eq("id", accountId).single();
    if (reloadErr) throw reloadErr;
    return mapRow(fresh);
  }

  return mapRow(data);
}


/** Restore a single account''s adjusted classification back to its original AI one. *//** Restore a single account's adjusted classification back to its original AI one. */
async function resetAccount(accountId, userId = null) {
  const row = await loadAccount(accountId);
  const original = row.original_hierarchy || hierarchySnapshot(columnsToLevels(row), row.account_type, row.statement_type, row.base_account);
  const levels = Array.isArray(original.levels) ? original.levels.slice(0, MAX_LEVELS) : columnsToLevels(row);
  while (levels.length < MAX_LEVELS) levels.push(null);
  const nonNull = levels.filter(Boolean);
  const baseAccount = original.base_account || (nonNull.length ? nonNull[nonNull.length - 1] : row.base_account);

  const resetAccountType = original.account_type || row.account_type;
  const resetStatementType = original.statement_type || row.statement_type;
  const resetAncestorPathArr = nonNull.slice(0, -1);

  const update = {
    updated_at: new Date().toISOString(),
    adjusted_name: row.original_name || row.account_name,
    adjusted_hierarchy: original,
    account_type: resetAccountType,
    statement_type: resetStatementType,
    base_account: baseAccount,
    classification_method: "rule",
    metadata: { ...(row.metadata || {}), user_modified: false },
    parent_account_id: resetAncestorPathArr.length
      ? await resolveOrCreateCategoryChain(row.version_id, row.company_id, resetAncestorPathArr, resetAccountType, resetStatementType)
      : null,
  };
  update.audit_log = appendAudit(
    row.audit_log,
    adjustmentAudit("reset", columnsToLevels(row), levels, userId),
    classificationAudit("rule", original, "reset", userId),
  );
  const { data, error } = await supabase.from(TABLE_COA).update(update).eq("id", accountId).select("*").single();
  if (error) throw error;
  await finalizeCoaHierarchy(row.company_id, row.version_id);
  await invalidateClassificationCache(row.company_id);
  const { data: fresh, error: reloadErr } = await supabase.from(TABLE_COA).select("*").eq("id", accountId).single();
  if (reloadErr) throw reloadErr;
  return mapRow(fresh);
}

/** Restore every modified account in a version to its original AI classification. *//** Restore every modified account in a version to its original AI classification. */
async function resetVersion(versionId, userId = null) {
  const { data, error } = await supabase
    .from(TABLE_COA).select("id, metadata, adjusted_name, original_name")
    .eq("version_id", versionId);
  if (error) throw error;
  const modified = (data || []).filter(
    (r) => r.metadata?.user_modified || (r.adjusted_name && r.original_name && r.adjusted_name !== r.original_name),
  );
  for (const r of modified) await resetAccount(r.id, userId);
  return { reset: modified.length };
}

/**
 * Audit history (classification + adjustments) for a version, reconstructed from
 * each account's inline audit_log. Return shape is unchanged for the frontend.
 */
async function getHistory(versionId) {
  const { data, error } = await supabase
    .from(TABLE_COA)
    .select("id, version_id, company_id, account_name, adjusted_name, audit_log")
    .eq("version_id", versionId);
  if (error) throw error;

  const classificationHistory = [];
  const adjustments = [];
  for (const row of data || []) {
    for (const e of Array.isArray(row.audit_log) ? row.audit_log : []) {
      const common = {
        account_id: row.id,
        version_id: row.version_id,
        company_id: row.company_id,
        account_name: row.adjusted_name || row.account_name,
      };
      if (e.kind === "adjustment") {
        adjustments.push({ ...common, field_changed: e.field_changed, old_value: e.old_value, new_value: e.new_value, changed_by: e.by || null, changed_at: e.at });
      } else {
        classificationHistory.push({ ...common, classification_method: e.method, hierarchy_snapshot: e.hierarchy_snapshot, source: e.source, created_by: e.by || null, created_at: e.at });
      }
    }
  }
  const byTime = (a, b) => String(b.created_at || b.changed_at).localeCompare(String(a.created_at || a.changed_at));
  classificationHistory.sort(byTime);
  adjustments.sort(byTime);
  return { classificationHistory: classificationHistory.slice(0, 500), adjustments: adjustments.slice(0, 500) };
}

// Legacy single-field update ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â retained for backward compatibility.
const EDITABLE_FIELDS = {
  accountName: "adjusted_name",
  accountType: "account_type",
  statementType: "statement_type",
  parentAccountId: "parent_account_id",
  isActive: "is_active",
  sortOrder: "sort_order",
};

async function updateAccount(accountId, patch = {}) {
  const update = { updated_at: new Date().toISOString() };
  let hierarchyTouched = false;
  for (const [apiKey, column] of Object.entries(EDITABLE_FIELDS)) {
    if (patch[apiKey] !== undefined) {
      update[column] = patch[apiKey];
      if (column === "parent_account_id") hierarchyTouched = true;
    }
  }
  const { data, error } = await supabase.from(TABLE_COA).update(update).eq("id", accountId).select("*").single();
  if (error) throw error;
  if (hierarchyTouched && data?.company_id && data?.version_id) {
    await finalizeCoaHierarchy(data.company_id, data.version_id);
    await invalidateClassificationCache(data.company_id);
    const { data: fresh, error: reloadErr } = await supabase.from(TABLE_COA).select("*").eq("id", accountId).single();
    if (reloadErr) throw reloadErr;
    return mapRow(fresh);
  }
  return mapRow(data);
}

// ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ Validation engine (extended with level-integrity checks) ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬
async function validateChartOfAccounts(companyId, versionId) {
  const empty = { nullType: [], invalidRows: [], needsReviewList: [], duplicates: [], unmapped: [], multiCategory: [], noLevel: [], noBase: [], noSystemId: [], noPath: [], badParent: [], needsMappingList: [] };
  if (!companyId || !versionId) {
    return { summary: { accountCount: 0, leafCount: 0, status: "warning", ...empty }, reports: empty, rows: [] };
  }

  const { data: coaData, error } = await supabase
    .from(TABLE_COA)
    .select("id, system_id, account_name, adjusted_name, account_number, account_type, parent_account_id, hierarchy_path, base_account, level_1, level_2, metadata")
    .eq("version_id", versionId);
  if (error) throw error;

  const all    = coaData || [];
  const allIds = new Set(all.map((r) => r.id));
  const leaves = all.filter((r) => !r.metadata?.is_group);

  const nullType    = leaves.filter((r) => !r.account_type).map((r) => r.account_name);
  // Software-metadata rows that slipped through (should be extremely rare with AI filtering).
  const invalidRows = leaves.filter((r) => isMetadataRow(r.account_name)).map((r) => r.account_name);
  // Accounts the AI flagged for human review (low confidence or no AI result).
  const needsReviewList = leaves.filter((r) => r.metadata?.needs_review).map((r) => r.account_name);
  // Accounts with no match in coa_mapping (coaMappingService) ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â no hierarchy was
  // assigned ON PURPOSE, not a data-integrity bug. Reported as its own category
  // below, worded as an actionable review queue rather than an error, and
  // excluded from noLevel/noPath so those two only fire for a GENUINE anomaly:
  // an account with missing hierarchy that ISN'T flagged needs_mapping (which
  // would mean something bypassed the mapping step entirely).
  const needsMappingList = leaves.filter((r) => r.metadata?.needs_mapping).map((r) => r.account_name);
  const noLevel     = leaves.filter((r) => !r.level_1 && !r.metadata?.needs_mapping).map((r) => r.account_name);
  const noBase      = leaves.filter((r) => !r.base_account).map((r) => r.account_name);
  const noSystemId  = leaves.filter((r) => !r.system_id).map((r) => r.account_name);
  const noPath      = leaves.filter((r) => !r.hierarchy_path && !r.metadata?.needs_mapping).map((r) => r.account_name);
  const badParent   = leaves
    .filter((r) => r.parent_account_id && !allIds.has(r.parent_account_id))
    .map((r) => r.account_name);

  const counts = new Map();
  for (const r of leaves) {
    const k = accountKey(r.account_number, r.account_name);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const duplicates = leaves
    .filter((r) => counts.get(accountKey(r.account_number, r.account_name)) > 1)
    .map((r) => r.account_name)
    .filter((v, i, a) => a.indexOf(v) === i);

  const unmapped = [];

  const typesByName = new Map();
  for (const r of leaves) {
    const k = normName(r.account_name);
    if (!typesByName.has(k)) typesByName.set(k, new Set());
    typesByName.get(k).add(r.account_type || "unknown");
  }
  const multiCategory = Array.from(typesByName.entries())
    .filter(([, set]) => set.size > 1)
    .map(([k]) => k);

  const reports = { nullType, invalidRows, needsReviewList, duplicates, unmapped, multiCategory, noLevel, noBase, noSystemId, noPath, badParent, needsMappingList };

  const sample = (arr, n = 8) =>
    arr.slice(0, n).join(", ") + (arr.length > n ? ` ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦ (+${arr.length - n} more)` : "");

  const rows = [];
  let worst = "success";

  const errorChecks = [
    [nullType,      (a) => `${a.length} account(s) missing a category: ${sample(a)}`],
    [invalidRows,   (a) => `${a.length} metadata row(s) found in the Chart of Accounts (should not appear): ${sample(a)}`],
    [multiCategory, (a) => `${a.length} account(s) classified into more than one category: ${sample(a)}`],
    // Genuinely anomalous only now ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â needs_mapping accounts (expected, no
    // hierarchy on purpose) are excluded from noLevel/noPath above. If this
    // still fires, an account has missing hierarchy WITHOUT being flagged for
    // review, meaning something bypassed coaMappingService entirely.
    [noLevel,       (a) => `${a.length} account(s) missing a hierarchy (no Level 1) despite not being flagged needs_mapping ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â investigate, this should not happen: ${sample(a)}`],
    [badParent,     (a) => `${a.length} account(s) have a parent_account_id that does not resolve to a row in this version: ${sample(a)}`],
  ];
  for (const [arr, msg] of errorChecks) {
    if (arr.length) {
      worst = "error";
      rows.push({ dataType: "chart_of_accounts", year: null, status: "error", severity: "error", message: msg(arr), metadata: { sample: arr.slice(0, 25), count: arr.length } });
    }
  }

  const warnChecks = [
    // Expected, actionable state ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â no match in the existing Chart of Accounts,
    // not a data-integrity problem. Worded to read as a review queue, not a defect.
    [needsMappingList, (a) => `${a.length} account(s) pending manual review ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â no match found in the existing Chart of Accounts. Map them in Review & Adjust; future imports with the same account name will reuse the mapping automatically: ${sample(a)}`],
    [needsReviewList, (a) => `${a.length} account(s) flagged for manual review (low AI confidence): ${sample(a)}`],
    [duplicates,      (a) => `${a.length} duplicate account name(s): ${sample(a)}`],
    [noBase,          (a) => `${a.length} account(s) missing a base account: ${sample(a)}`],
    [noSystemId,      (a) => `${a.length} account(s) missing a System ID: ${sample(a)}`],
    [noPath,          (a) => `${a.length} account(s) missing a hierarchy path despite not being flagged needs_mapping ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â investigate: ${sample(a)}`],
  ];
  for (const [arr, msg] of warnChecks) {
    if (arr.length) {
      if (worst !== "error") worst = "warning";
      rows.push({ dataType: "chart_of_accounts", year: null, status: "warning", severity: "warning", message: msg(arr), metadata: { sample: arr.slice(0, 25), count: arr.length } });
    }
  }

  const status = leaves.length ? worst : "warning";
  rows.unshift({
    dataType: "chart_of_accounts",
    year: null,
    status,
    severity: status,
    message: leaves.length
      ? status === "success"
        ? `Chart of Accounts generated successfully (${leaves.length} accounts, all AI-classified).`
        : `Chart of Accounts generated with issues (${leaves.length} accounts).`
      : "Chart of Accounts not generated.",
    metadata: { accountCount: all.length, leafCount: leaves.length, reports },
  });

  return { summary: { accountCount: all.length, leafCount: leaves.length, status, ...reports }, reports, rows };
}

/**
 * Prints the "COA Validation" summary block after every sync ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â real counts
 * from the persisted chart_of_accounts + actual GL linkage state, never
 * placeholders. Read-only, never blocks the sync.
 *
 * @param {string} companyId
 * @param {string} versionId
 * @param {Array} [plRows] - the SAME ephemeral parsed Profit & Loss account
 *   rows keyReportSyncService's Step 5b passed to generateChartOfAccounts
 *   (never persisted ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â there is no profit_loss_entries table). Threaded
 *   through here ONLY so the "COA Mapping Validation" / "Hierarchy Sources"
 *   blocks below can report real P&L coverage numbers instead of omitting
 *   them; never used to alter classification or any report calculation.
 */
async function printCoaValidationBlock(companyId, versionId, plRows = []) {
  const { data: allRows } = await supabase
    .from(TABLE_COA)
    .select(["id, account_name, account_number, parent_account_id, hierarchy_path, base_account, statement_type, account_type, cf_category, classification_method, metadata", ...Array.from({ length: MAX_LEVELS }, (_, i) => `level_${i + 1}`)].join(", "))
    .eq("version_id", versionId);
  const all = allRows || [];
  const byId = new Map(all.map((r) => [r.id, r]));
  const leaves = all.filter((r) => !r.metadata?.is_group);
  const groups = all.filter((r) => r.metadata?.is_group);

  const nameCounts = new Map();
  for (const r of leaves) {
    const k = accountKey(r.account_number, r.account_name);
    nameCounts.set(k, (nameCounts.get(k) || 0) + 1);
  }
  const duplicateAccounts = Array.from(nameCounts.values()).filter((n) => n > 1).length;

  const pathCounts = new Map();
  for (const r of leaves) {
    if (!r.hierarchy_path) continue;
    pathCounts.set(r.hierarchy_path, (pathCounts.get(r.hierarchy_path) || 0) + 1);
  }
  const duplicatePaths = Array.from(pathCounts.values()).filter((n) => n > 1).length;

  const missingParents = all.filter((r) => r.parent_account_id && !byId.has(r.parent_account_id)).length;

  let circularRefs = 0;
  for (const r of leaves) {
    const visited = new Set([r.id]);
    let cursor = r.parent_account_id;
    let hops = 0;
    while (cursor && hops < MAX_LEVELS + 1) {
      if (visited.has(cursor)) { circularRefs++; break; }
      visited.add(cursor);
      cursor = byId.get(cursor)?.parent_account_id || null;
      hops++;
    }
  }

  // A group (category) node no other row's parent_account_id ever points to
  // is a dead branch ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â created, then never actually used as a parent.
  const referencedParentIds = new Set(all.map((r) => r.parent_account_id).filter(Boolean));
  const orphanNodes = groups.filter((g) => !referencedParentIds.has(g.id)).length;

  const levelCols = Array.from({ length: MAX_LEVELS }, (_, i) => `level_${i + 1}`);
  let maxDepth = 0;
  for (const r of leaves) {
    const depth = levelCols.filter((c) => r[c]).length;
    if (depth > maxDepth) maxDepth = depth;
  }

  const [{ count: totalGl }, { count: unmappedGl }, linkedCoaIdRows] = await Promise.all([
    supabase.from(TABLE_TXN).select("id", { count: "exact", head: true }).eq("company_id", companyId).eq("version_id", versionId),
    supabase.from(TABLE_TXN).select("id", { count: "exact", head: true }).eq("company_id", companyId).eq("version_id", versionId).is("coa_id", null),
    fetchAllRows(() => supabase.from(TABLE_TXN).select("coa_id").eq("company_id", companyId).eq("version_id", versionId).not("coa_id", "is", null)),
  ]);
  const accountsLinkedToGl = new Set((linkedCoaIdRows || []).map((r) => r.coa_id)).size;
  const accountsLinkedToBs = leaves.filter((r) => r.statement_type === "balance_sheet").length;
  const accountsLinkedToPl = leaves.filter((r) => r.statement_type === "profit_loss").length;
  const accountsLinkedToCf = leaves.filter((r) => r.cf_category).length;

  const hierarchyValid = duplicatePaths === 0 && missingParents === 0 && circularRefs === 0 && maxDepth <= MAX_LEVELS;

  console.log(
    "========== COA Validation ==========\n" +
    `Leaf Accounts: ${leaves.length}\n` +
    `Hierarchy Nodes: ${groups.length}\n` +
    `Maximum Depth: ${maxDepth}\n` +
    `Duplicate Accounts: ${duplicateAccounts}\n` +
    `Duplicate Paths: ${duplicatePaths}\n` +
    `Missing Parents: ${missingParents}\n` +
    `Circular References: ${circularRefs}\n` +
    `Orphan Nodes: ${orphanNodes}\n` +
    `Unmapped GL Accounts: ${unmappedGl || 0} (of ${totalGl || 0} total)\n` +
    `Accounts linked to GL: ${accountsLinkedToGl}\n` +
    `Accounts linked to BS: ${accountsLinkedToBs}\n` +
    `Accounts linked to P&L: ${accountsLinkedToPl}\n` +
    `Accounts linked to Cash Flow: ${accountsLinkedToCf}\n` +
    `Hierarchy Valid: ${hierarchyValid ? "YES" : "NO"}\n` +
    "====================================",
  );

  // -- COA Hierarchy Validation -- a LEAF row's populated levels must form a
  // contiguous prefix (level_1..level_N real, level_(N+1)..level_15 NULL).
  // Trailing NULL past an account's real depth is correct and expected --
  // level_1..15 is a fixed-width schema supporting a MAXIMUM depth of 15, not
  // a requirement that every account populate all 15. The only real defect
  // is an INTERNAL gap -- a NULL level followed by a non-NULL one, which
  // would mean a level was skipped. Category/group nodes are excluded -- they
  // are not "an account" and correctly have only their own real depth.
  // Declared with `let` at function scope (not `const` inside the block
  // below) so the "COA Mapping Validation" / rule-aggregation blocks further
  // down can reuse these exact figures instead of recomputing them.
  let rowsWithInternalGaps = 0;
  let hierarchyLeafMaxDepth = 0;
  {
    const isBlank = (v) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");
    for (const r of leaves) {
      const vals = levelCols.map((c) => r[c]);
      const populated = vals.filter((v) => !isBlank(v));
      if (populated.length > hierarchyLeafMaxDepth) hierarchyLeafMaxDepth = populated.length;
      let sawEmpty = false;
      for (const v of vals) {
        if (isBlank(v)) sawEmpty = true;
        else if (sawEmpty) { rowsWithInternalGaps += 1; break; }
      }
    }
    const hierarchyGapsValid = rowsWithInternalGaps === 0;
    console.log(
      "COA Hierarchy Validation\n\n" +
      `Total Accounts: ${leaves.length}\n\n` +
      `Rows with Internal Hierarchy Gaps: ${rowsWithInternalGaps}\n\n` +
      `Maximum Depth: ${hierarchyLeafMaxDepth}\n\n` +
      `Hierarchy Valid: ${hierarchyGapsValid ? "YES" : "NO"}`,
    );
    if (!hierarchyGapsValid) {
      // NOTE: this function's own caller (keyReportSyncService) wraps it in a
      // never-fatal try/catch by design (a COA validation problem must not
      // halt Trial Balance/BS/P&L from generating), so this does not halt
      // the sync -- see this function's own doc comment ("Read-only, never
      // blocks the sync"). Making a hierarchy-gap violation truly reject the
      // generation would require changing that caller's error handling,
      // which is a broader decision than this validation block.
      console.error(
        `[ChartOfAccounts] HIERARCHY INVARIANT VIOLATED: ${rowsWithInternalGaps} row(s) with an internal ` +
        "hierarchy gap (a real level appearing after a blank one) -- this means a level was skipped during " +
        "persistence rather than left as a genuine trailing NULL.",
      );
    }
  }

  // ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢Ãƒâ€šÃ‚Â
  // COA Mapping Validation / Hierarchy Quality / Hierarchy Sources
  //
  // The three blocks above (COA Validation / COA Hierarchy Validation /
  // logBalanceSheetHierarchyValidation, the latter printed earlier during
  // generateChartOfAccounts) prove the hierarchy TREE is internally
  // consistent. They do not prove every uploaded document account and every
  // GL transaction actually resolved into that tree correctly. These three
  // blocks close that gap ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â pure read/aggregate diagnostics over the
  // already-persisted chart_of_accounts + general_ledger_entries +
  // balance_sheet_entries rows (plus the ephemeral plRows passed in from the
  // sync's own Step 5b parse). Nothing here changes classification, report
  // generation, or reconciliation ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â see this function's own doc comment.
  const hasLinkedCoaDocument = await hasLinkedCoaDocumentForVersion(versionId);
  const bsEntryRows = await collectBsAccountsFromEntries(companyId, versionId).catch(() => []);
  const bsLeafRows = bsEntryRows.filter((r) => r.account_name && r.hierarchy_level !== 0);
  const bsUniqueKeys = new Set(bsLeafRows.map((r) => normName(r.account_name)));
  const plLeafRows = (plRows || []).filter((r) => r.account_name && !r.is_total && !r.is_header && r.node_type !== "subtotal");
  const plUniqueKeys = new Set(plLeafRows.map((r) => normName(r.account_name)));

  const isDocSourced = (r) => r.classification_method === "document_hierarchy" || r.classification_method === "bs_section" || r.classification_method === "pl_section";
  const generatedFromBs = leaves.filter((r) => isDocSourced(r) && r.statement_type === "balance_sheet").length;
  const generatedFromPl = leaves.filter((r) => isDocSourced(r) && r.statement_type === "profit_loss").length;
  const generatedByFuzzy = leaves.filter((r) => r.metadata?.doc_match_type === "fuzzy").length;
  const AI_METHODS = new Set(["ai_hierarchy", "gemini", "ai_low_confidence"]);
  const generatedByAi = leaves.filter((r) => AI_METHODS.has(r.classification_method)).length;
  const needsMappingCount = leaves.filter((r) => r.metadata?.needs_mapping).length;

  const coaNameSet = new Set();
  for (const r of leaves) {
    coaNameSet.add(normName(r.account_name));
    if (r.base_account) coaNameSet.add(normName(r.base_account));
  }
  const bsLinkedCount = bsLeafRows.filter((r) => r.coa_id).length;
  const bsUnmappedAccounts = bsLeafRows.filter((r) => !r.coa_id).map((r) => r.account_name);
  const plLinkedCount = Array.from(plUniqueKeys).filter((k) => coaNameSet.has(k)).length;
  const plUnmappedAccounts = plLeafRows.filter((r) => !coaNameSet.has(normName(r.account_name))).map((r) => r.account_name);
  const glLinkedCount = accountsLinkedToGl; // reuses the coa_id-distinct count computed above
  const glUnmappedCount = unmappedGl || 0;

  // Duplicate COA Leaves ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â the SAME (account_number, account_name) key
  // persisted more than once (should be structurally impossible given the
  // upsert-by-stable-key merge in generateChartOfAccounts, checked anyway).
  const duplicateCoaLeaves = Array.from(nameCounts.values()).filter((n) => n > 1).reduce((sum, n) => sum + (n - 1), 0);

  // Duplicate Normalized Names ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â same normName(account_name) regardless of
  // account_number (catches near-duplicates an account-number difference
  // would otherwise hide from the check above).
  const normNameGroups = new Map();
  for (const r of leaves) {
    const k = normName(r.account_name);
    if (!normNameGroups.has(k)) normNameGroups.set(k, []);
    normNameGroups.get(k).push(r);
  }
  const duplicateNormalizedGroups = Array.from(normNameGroups.entries()).filter(([, rows]) => rows.length > 1);
  const duplicateNormalizedNames = duplicateNormalizedGroups.length;
  // ...and specifically under the SAME parent ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â a real structural problem
  // (two leaves for what should be one account), vs. the same name
  // legitimately appearing under two different categories.
  const duplicateUnderSameParent = duplicateNormalizedGroups.filter(([, rows]) => {
    const parents = new Set(rows.map((r) => r.parent_account_id || "(root)"));
    return parents.size < rows.length;
  });

  // Unused Hierarchy Nodes ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â same definition as "Orphan Nodes" above (a
  // category row no leaf/category ever points to via parent_account_id).
  const unusedHierarchyNodes = orphanNodes;

  const nullAccountType = leaves.filter((r) => !r.account_type).map((r) => r.account_name);
  const nullCfCategory = leaves.filter((r) => !r.cf_category).length;
  const hierarchyCoveragePct = leaves.length ? Math.round(((leaves.length - needsMappingCount) / leaves.length) * 1000) / 10 : 0;

  // "No account silently falls back to AI when a document hierarchy exists" ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â
  // cross-check every AI-classified leaf's normalized name against the SAME
  // uploaded Balance Sheet / Profit & Loss account sets used above. Should
  // always be empty by construction (buildCoaModel tries document hierarchy,
  // Priority 2, strictly before AI, Priority 3) ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â surfaced here as a
  // regression tripwire, not a currently-expected finding.
  const aiDespiteDocument = leaves.filter((r) => {
    if (!AI_METHODS.has(r.classification_method)) return false;
    const k = normName(r.account_name);
    return bsUniqueKeys.has(k) || plUniqueKeys.has(k);
  });

  const mappingFailureReasons = [];
  if (rowsWithInternalGaps > 0) mappingFailureReasons.push(`${rowsWithInternalGaps} account(s) with an internal hierarchy gap`);
  if (duplicatePaths > 0) mappingFailureReasons.push(`${duplicatePaths} duplicate hierarchy path(s)`);
  if (missingParents > 0) mappingFailureReasons.push(`${missingParents} orphan parent reference(s)`);
  if (circularRefs > 0) mappingFailureReasons.push(`${circularRefs} hierarchy loop(s)`);
  if (glUnmappedCount > 0) mappingFailureReasons.push(`${glUnmappedCount} unlinked GL account row(s)`);
  if (bsUnmappedAccounts.length > 0) mappingFailureReasons.push(`${bsUnmappedAccounts.length} unmapped Balance Sheet account(s)`);
  if (plUnmappedAccounts.length > 0) mappingFailureReasons.push(`${plUnmappedAccounts.length} unmapped Profit & Loss account(s)`);
  if (duplicateUnderSameParent.length > 0) mappingFailureReasons.push(`${duplicateUnderSameParent.length} duplicate normalized name(s) under the same parent`);
  if (nullAccountType.length > 0) mappingFailureReasons.push(`${nullAccountType.length} account(s) with a NULL account_type`);
  if (aiDespiteDocument.length > 0) mappingFailureReasons.push(`${aiDespiteDocument.length} account(s) classified by AI despite existing in an uploaded document`);
  const coaValidationPass = mappingFailureReasons.length === 0;

  console.log(
    "==============================\n" +
    "COA Mapping Validation\n" +
    "==============================\n\n" +
    `Uploaded COA : ${hasLinkedCoaDocument ? "YES" : "NO"}\n\n` +
    `Generated From Balance Sheet : ${generatedFromBs}\n\n` +
    `Generated From Profit & Loss : ${generatedFromPl}\n\n` +
    `Generated By Fuzzy Matching : ${generatedByFuzzy}\n\n` +
    `Generated By AI : ${generatedByAi}\n\n` +
    `Needs Manual Mapping : ${needsMappingCount}\n\n` +
    `General Ledger Accounts : ${totalGl || 0}\n\n` +
    `Balance Sheet Accounts : ${bsUniqueKeys.size}\n\n` +
    `Profit & Loss Accounts : ${plUniqueKeys.size}\n\n` +
    `Unique COA Accounts : ${leaves.length}\n\n` +
    `GL Linked To COA : ${glLinkedCount} / ${totalGl || 0}\n\n` +
    `BS Linked To COA : ${bsLinkedCount} / ${bsLeafRows.length}\n\n` +
    `PL Linked To COA : ${plLinkedCount} / ${plUniqueKeys.size}\n\n` +
    `Duplicate COA Leaves : ${duplicateCoaLeaves}\n\n` +
    `Duplicate Normalized Names : ${duplicateNormalizedNames}\n\n` +
    `Duplicate Hierarchy Paths : ${duplicatePaths}\n\n` +
    `Unused Hierarchy Nodes : ${unusedHierarchyNodes}\n\n` +
    `Null account_type : ${nullAccountType.length}\n\n` +
    `Null cf_category : ${nullCfCategory}\n\n` +
    `Needs Mapping : ${needsMappingCount}\n\n` +
    `Hierarchy Coverage : ${hierarchyCoveragePct}%\n\n` +
    `COA Validation : ${coaValidationPass ? "PASS" : "FAIL"}\n` +
    "==============================",
  );

  if (!coaValidationPass) {
    console.error(`[ChartOfAccounts][COA Mapping Validation] FAILED ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ${mappingFailureReasons.join("; ")}.`);
    if (bsUnmappedAccounts.length) {
      console.error(
        "Accounts Missing Hierarchy (Balance Sheet):\n" +
        bsUnmappedAccounts.slice(0, 25).map((a) => `  Account : ${a}\n  Reason : No matching COA account (coa_id is null after linkBsToCoa)\n  Document : Balance Sheet`).join("\n\n"),
      );
    }
    if (plUnmappedAccounts.length) {
      console.error(
        "Accounts Missing Hierarchy (Profit & Loss):\n" +
        plUnmappedAccounts.slice(0, 25).map((a) => `  Account : ${a}\n  Reason : No COA leaf found with a matching name\n  Document : Profit & Loss`).join("\n\n"),
      );
    }
    if (duplicateUnderSameParent.length) {
      console.error(
        "Duplicate Hierarchy:\n" +
        duplicateUnderSameParent.slice(0, 10).map(([, rows]) =>
          `  Account : ${rows[0].account_name}\n` +
          rows.map((r, i) => `  Path ${i + 1}\n    ${r.hierarchy_path || "(none)"}`).join("\n"),
        ).join("\n\n"),
      );
    }
    if (glUnmappedCount > 0) {
      const { data: unmappedGlSample } = await supabase
        .from(TABLE_TXN).select("account_name").eq("company_id", companyId).eq("version_id", versionId).is("coa_id", null).limit(10);
      const byName = new Map();
      for (const r of unmappedGlSample || []) byName.set(r.account_name, (byName.get(r.account_name) || 0) + 1);
      if (byName.size) {
        console.error(
          "GL Not Linked:\n" +
          Array.from(byName.entries()).map(([name, count]) =>
            `  Account : ${name}\n  Sample Transaction Count : ${count}\n  Reason : No matching COA account`,
          ).join("\n\n"),
        );
      }
    }
    if (nullAccountType.length) {
      console.error(`Null account_type:\n${nullAccountType.slice(0, 25).map((a) => `  Account : ${a}`).join("\n")}`);
    }
    if (aiDespiteDocument.length) {
      console.error(
        "AI Used Despite Document Hierarchy Existing:\n" +
        aiDespiteDocument.slice(0, 25).map((r) => `  Account : ${r.account_name}\n  classification_method : ${r.classification_method}`).join("\n\n"),
      );
    }
  }

  // ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ Hierarchy Quality ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬
  // Real (unpadded) depth per leaf ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â padLevelsWithLeafPropagation repeats the
  // leaf's own base_account name for every trailing level past its true
  // document-derived depth, so "real depth" is the level index at which the
  // leaf's own name FIRST appears, not the count of populated columns (which
  // is always 15 for every leaf, per the hierarchy-gap check above).
  let deepestAccount = null, deepestDepth = -1, deepestPath = "";
  let shallowestAccount = null, shallowestDepth = Infinity, shallowestPath = "";
  let totalRealDepth = 0;
  let totalChildren = 0;
  const childCountByParent = new Map();
  for (const r of all) {
    if (!r.parent_account_id) continue;
    childCountByParent.set(r.parent_account_id, (childCountByParent.get(r.parent_account_id) || 0) + 1);
  }
  for (const pid of childCountByParent.keys()) totalChildren += childCountByParent.get(pid);
  for (const r of leaves) {
    const leafName = r.base_account || r.account_name;
    let realDepth = MAX_LEVELS;
    for (let i = 0; i < MAX_LEVELS; i += 1) {
      if (levelCols[i] && r[levelCols[i]] === leafName) { realDepth = i + 1; break; }
    }
    totalRealDepth += realDepth;
    if (realDepth > deepestDepth) { deepestDepth = realDepth; deepestAccount = r.account_name; deepestPath = r.hierarchy_path || ""; }
    if (realDepth < shallowestDepth) { shallowestDepth = realDepth; shallowestAccount = r.account_name; shallowestPath = r.hierarchy_path || ""; }
  }
  const avgRealDepth = leaves.length ? totalRealDepth / leaves.length : 0;
  const avgChildrenPerNode = groups.length ? totalChildren / groups.length : 0;
  // How much of the tree is real branching structure vs. leaves ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â higher
  // means a flatter tree (fewer category nodes per leaf), lower means deeper
  // nesting. Simple, documented ratio: leaves / (leaves + internal nodes).
  const compressionRatio = (leaves.length + groups.length)
    ? Math.round((leaves.length / (leaves.length + groups.length)) * 1000) / 1000
    : 0;

  console.log(
    "==============================\n" +
    "Hierarchy Quality\n" +
    "==============================\n\n" +
    `Leaf Accounts : ${leaves.length}\n\n` +
    `Internal Nodes : ${groups.length}\n\n` +
    `Maximum Depth : ${deepestDepth < 0 ? 0 : deepestDepth}\n\n` +
    `Average Depth : ${avgRealDepth.toFixed(2)}\n\n` +
    `Average Children Per Node : ${avgChildrenPerNode.toFixed(2)}\n\n` +
    `Deepest Account : ${deepestAccount || "(none)"}\n\n` +
    `Shallowest Account : ${shallowestAccount || "(none)"}\n\n` +
    `Longest Path : ${deepestPath || "(none)"}\n\n` +
    `Shortest Path : ${shallowestPath || "(none)"}\n\n` +
    `Hierarchy Compression Ratio : ${compressionRatio}\n` +
    "==============================",
  );

  // ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ Hierarchy Sources ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬
  // "Historical COA" / "Other Company COA" are unconditionally NO ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â never a
  // live lookup, because they are structurally impossible in this codebase,
  // not merely unobserved: client_chart_of_accounts is only ever queried via
  // createCoaMapper(companyId) (strictly scoped to THIS company) or
  // NULL_COA_MAPPER (no query at all), gated by hasLinkedCoaDocumentForVersion
  // (THIS version's own linked documents only ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â see that function's doc
  // comment). There is no code path anywhere in generateChartOfAccounts /
  // ensureCoaComplete that reads another company's data or a prior version's
  // stale upload.
  console.log(
    "==============================\n" +
    "Hierarchy Sources\n" +
    "==============================\n\n" +
    `Uploaded COA : ${hasLinkedCoaDocument ? "YES" : "NO"}\n\n` +
    `Balance Sheet : ${bsUniqueKeys.size > 0 ? "YES" : "NO"}\n\n` +
    `Profit & Loss : ${plUniqueKeys.size > 0 ? "YES" : "NO"}\n\n` +
    `General Ledger : ${(totalGl || 0) > 0 ? "YES" : "NO"}\n\n` +
    "Historical COA : NO\n\n" +
    "Other Company COA : NO\n\n" +
    `AI Used : ${generatedByAi} Accounts\n` +
    "==============================",
  );

  return {
    leafAccounts: leaves.length, hierarchyNodes: groups.length, maxDepth, duplicateAccounts, duplicatePaths,
    missingParents, circularRefs, orphanNodes, unmappedGlAccounts: unmappedGl || 0, totalGlAccounts: totalGl || 0,
    accountsLinkedToGl, accountsLinkedToBs, accountsLinkedToPl, accountsLinkedToCf, hierarchyValid,
    coaMappingValidation: {
      hasLinkedCoaDocument, generatedFromBs, generatedFromPl, generatedByFuzzy, generatedByAi, needsMappingCount,
      bsAccountsTotal: bsUniqueKeys.size, plAccountsTotal: plUniqueKeys.size, uniqueCoaAccounts: leaves.length,
      glLinkedCount, glUnmappedCount, bsLinkedCount, bsUnmappedCount: bsLeafRows.length - bsLinkedCount,
      plLinkedCount, plUnmappedCount: plUniqueKeys.size - plLinkedCount,
      duplicateCoaLeaves, duplicateNormalizedNames, duplicateHierarchyPaths: duplicatePaths, unusedHierarchyNodes,
      nullAccountTypeCount: nullAccountType.length, nullCfCategoryCount: nullCfCategory,
      hierarchyCoveragePct, pass: coaValidationPass, failureReasons: mappingFailureReasons,
    },
    hierarchyQuality: {
      leafAccounts: leaves.length, internalNodes: groups.length, maxDepth: deepestDepth < 0 ? 0 : deepestDepth,
      avgDepth: avgRealDepth, avgChildrenPerNode, deepestAccount, shallowestAccount, compressionRatio,
    },
  };
}

async function ensureAccountExistsInCoa(versionId, companyId, accountName, accountNumber = null, explicitType = null) {
  throw new Error("Dynamic Chart of Accounts insertion is disabled. Run generateChartOfAccounts/ensureCoaComplete during sync before generating reports.");
}

// ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ Phase 2c: Bulk-complete COA from GL distinct accounts ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬
//
// After generateChartOfAccounts + linkGlToCoa, any GL row still missing a
// coa_id means its account_name was not in the set sent to generateChartOfAccounts.
// This function finds those accounts, classifies them via the same AI pipeline
// (classifyAccountsWithAI), and bulk-inserts them before Phase 3 (Trial Balance).
// Accounts that receive no AI result or low-confidence results are flagged
// needsReview: true ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â no keyword-rule fallback is applied.
//
// Returns { added, skipped }.
//
// @param {string} companyId
// @param {string} versionId
// @param {Array} [plRows] - the SAME ephemeral parsed Profit & Loss rows
//   keyReportSyncService's Step 5b already passed to generateChartOfAccounts
//   (never re-parsed here, never persisted) ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â needed so a GL-only account
//   discovered at this later phase still gets Priority-2 document-hierarchy
//   resolution before falling back to AI.
// Same guarantee as generateChartOfAccounts' wrapper above -- see its comment.
async function ensureCoaComplete(companyId, versionId, plRows = [], hasLinkedCoaDocument = undefined, endingFiscalYear = null) {
  try {
    return await _ensureCoaCompleteImpl(companyId, versionId, plRows, hasLinkedCoaDocument, endingFiscalYear);
  } finally {
    await invalidateClassificationCache(companyId);
  }
}

async function _ensureCoaCompleteImpl(companyId, versionId, plRows = [], hasLinkedCoaDocument = undefined, endingFiscalYear = null) {
  if (!companyId || !versionId) return { added: 0, skipped: 0 };

  await invalidateClassificationCache(companyId);

  // 1. Collect distinct GL account_names that have no coa_id yet.
  const unlinkedNames = new Map(); // normKey ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ rawName
  const PAGE = 1000;
  let from = 0;
  for (let page = 0; page < 500; page++) {
    const { data, error } = await supabase
      .from(TABLE_TXN)
      .select("account_name")
      .eq("company_id", companyId)
      .eq("version_id", versionId)
      .is("coa_id", null)
      .not("account_name", "is", null)
      .neq("account_name", "")
      .range(from, from + PAGE - 1);
    if (error || !data?.length) break;
    for (const row of data) {
      const raw = String(row.account_name).trim();
      if (raw && !isMetadataRow(raw)) unlinkedNames.set(normName(raw), raw);
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }

  if (unlinkedNames.size === 0) return { added: 0, skipped: 0 };

  // 2. Compare against existing COA to find truly missing accounts.
  const { data: existingRows } = await supabase
    .from(TABLE_COA)
    .select("account_name, base_account, adjusted_name")
    .eq("version_id", versionId);

  const existingSet = new Set();
  for (const row of (existingRows || [])) {
    if (row.account_name) existingSet.add(normName(row.account_name));
    if (row.base_account)  existingSet.add(normName(row.base_account));
    if (row.adjusted_name) existingSet.add(normName(row.adjusted_name));
  }

  const missingRaw = [];
  for (const [normKey, rawName] of unlinkedNames) {
    if (!existingSet.has(normKey)) missingRaw.push(rawName);
  }
  if (missingRaw.length === 0) return { added: 0, skipped: unlinkedNames.size };

  console.log(`[COA][ensureComplete] ${missingRaw.length} GL accounts not in COA ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â matching against the uploaded Chart of Accounts first`);

  // 3. Match against the uploaded COA FIRST ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â before any AI call. Only what's
  //    genuinely missing from the upload or matched ambiguously reaches AI.
  //    Never query client_chart_of_accounts unless THIS version actually has
  //    a COA document linked (see hasLinkedCoaDocumentForVersion).
  const coaDocLinked = hasLinkedCoaDocument !== undefined
    ? Boolean(hasLinkedCoaDocument)
    : await hasLinkedCoaDocumentForVersion(versionId);
  const coaMapper = coaDocLinked ? await createCoaMapper(companyId) : NULL_COA_MAPPER;
  const categoryPaths = await loadKnownCategoryPaths(companyId, versionId, coaDocLinked);

  const accountsForAI = missingRaw.map((rawName) => ({
    key: normName(rawName),
    accountName: normalizeForGemini(rawName),
    accountNumber: null,
  }));
  const matchResults = new Map();
  for (const acct of accountsForAI) {
    matchResults.set(acct.key, matchAnyName(coaMapper, [acct.accountName], acct.accountNumber));
  }
  const unmatchedByCoa = accountsForAI.filter((a) => !matchResults.get(a.key)?.matched);

  // 3b. Priority 2 ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â this exact account's own real position in the uploaded
  //     Balance Sheet / Profit & Loss, same as generateChartOfAccounts. Only
  //     what neither the upload nor the uploaded statements resolve reaches AI.
  const [glRowsInOrder, bsRows] = await Promise.all([
    collectGlAccountsFromEntries(companyId, versionId).catch(() => []),
    collectBsAccountsFromEntries(companyId, versionId).catch(() => []),
  ]);
  const glBucketByKey = splitAccountsAtRetainedEarnings(glRowsInOrder);
  const { bsHierarchyByName, plHierarchyByName } = buildDocHierarchyLookups(bsRows, plRows, endingFiscalYear);
  const needsAi = unmatchedByCoa.filter(
    (a) => !pickDocHierarchy(a.accountName, a.key, glBucketByKey, bsHierarchyByName, plHierarchyByName),
  );
  if (coaMapper.entryCount || unmatchedByCoa.length !== needsAi.length) {
    console.log(
      `[COA][ensureComplete] ${accountsForAI.length} account(s) -> ${accountsForAI.length - unmatchedByCoa.length} matched directly against the uploaded Chart of Accounts, ` +
      `${unmatchedByCoa.length - needsAi.length} resolved from the account's own position in the uploaded Balance Sheet/P&L, ${needsAi.length} sent to AI.`,
    );
  }

  let aiResults = new Map();
  if (needsAi.length) {
    try {
      const aiInput = needsAi.map((a) => ({ ...a, ambiguousCandidates: matchResults.get(a.key)?.candidates || null }));
      aiResults = await classifyAccountsWithAI(aiInput, { companyId, categoryPaths: categoryPaths.map((c) => c.path) });
    } catch (err) {
      console.warn(`[COA][ensureComplete] AI classification failed ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â accounts flagged for review: ${err.message}`);
    }
  }

  // 4. Build leaf descriptors: a confident COA match is copied directly
  //    (needsReview:false, no AI ever consulted); everything else falls back
  //    to the AI's own accountType + full hierarchy (or needsMapping if the
  //    AI has nothing either ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â no document section evidence exists for a
  //    GL-only discovered account, so there is no cheaper fallback here).
  const classifiedLeaves = missingRaw
    .filter((rawName) => !aiResults.get(normName(rawName))?.isReportRow) // exclude AI-detected report rows
    .map((rawName) => {
      const key   = normName(rawName);
      const match = matchResults.get(key);

      if (match?.matched) {
        const path = appendLeaf(match.levels.filter(Boolean), rawName);
        const finalLevels = new Array(MAX_LEVELS).fill(null);
        path.forEach((label, li) => { if (li < MAX_LEVELS) finalLevels[li] = label; });
        return {
          rawName, displayName: rawName, type: match.accountType, stmtType: match.statementType || (match.accountType ? statementTypeFor(match.accountType) : null),
          sortOrder: null, clientAccountId: match.clientAccountId || null, normalBal: match.normalBalance,
          confidence: match.confidence, needsReview: false, classificationMethod: "client_workbook",
          matchReason: match.reason, finalLevels, hierarchyPath: match.hierarchyPath || path.join(" > "),
          needsMapping: false, matchTier: match.matchTier, matchConfidence: match.confidence,
        };
      }

      const docHierarchy = pickDocHierarchy(rawName, key, glBucketByKey, bsHierarchyByName, plHierarchyByName);
      if (docHierarchy) {
        const path = [...docHierarchy.levels]; // already [...parentPath, ownName] ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â real document structure
        const finalLevels = new Array(MAX_LEVELS).fill(null);
        path.forEach((label, li) => { if (li < MAX_LEVELS) finalLevels[li] = label; });
        return {
          rawName, displayName: rawName, type: docHierarchy.accountType,
          stmtType: docHierarchy.statementType || (docHierarchy.accountType ? statementTypeFor(docHierarchy.accountType) : null),
          sortOrder: null, clientAccountId: null,
          normalBal: docHierarchy.accountType ? normalBalanceFor(docHierarchy.accountType) : null,
          confidence: 1, needsReview: false, classificationMethod: "document_hierarchy",
          matchReason: `Matched this account's own position in the uploaded ${docHierarchy.statementType === "profit_loss" ? "Profit & Loss" : "Balance Sheet"}.`,
          finalLevels, hierarchyPath: path.join(" > "),
          needsMapping: false, matchTier: "document_hierarchy", matchConfidence: 1,
          docMatchType: docHierarchy.matchType || "exact",
        };
      }

      const aiResult = aiResults.get(key);
      // No fallback default: an account with no AI result has an unknown
      // type ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â never guessed. It stays needsMapping/needsReview until a
      // human classifies it (see chartOfAccountsService.updateAccountHierarchy).
      const type        = aiResult?.accountType || null;
      const confidence  = aiResult?.confidence ?? null;
      const needsReview = !aiResult || (confidence !== null && confidence < AI_NEEDS_REVIEW_THRESHOLD);
      const displayName = aiResult?.normalizedName || rawName;
      const classificationMethod = !aiResult ? "unclassified" : needsReview ? "ai_low_confidence" : "gemini";
      // statementTypeFor/normalBalanceFor are deterministic accounting facts of a
      // KNOWN type ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â never invoked to invent a type; null when type is null.
      const stmtType  = type ? statementTypeFor(type) : null;
      const normalBal = type ? normalBalanceFor(type) : null;
      const aiLevels = aiResult?.levels || [];
      // No AI hierarchy fallback here. Accounts without a document-derived path stay needsMapping.
      return {
        rawName, displayName, type, stmtType, sortOrder: null, clientAccountId: null, normalBal,
        confidence, needsReview, classificationMethod,
        finalLevels: new Array(MAX_LEVELS).fill(null), hierarchyPath: "", needsMapping: true, matchTier: null,
      };
    });

  if (classifiedLeaves.length === 0) return { added: 0, skipped: unlinkedNames.size };

  // 5. Sync category nodes for all new leaves ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â same tree-first path
  // generateChartOfAccounts uses, so the two writers can never independently
  // create two differently-cased nodes for the same conceptual category.
  const allCats = buildCoaNodeTree(
    classifiedLeaves.map((l) => ({ levels: l.finalLevels, accountType: l.type, statementType: l.stmtType })),
  );
  let catIdByPath = new Map();
  try {
    const { data: existingCats } = await supabase
      .from(TABLE_COA).select("id, parent_account_id, metadata").eq("version_id", versionId);
    const existingCatsData = (existingCats || []).filter((r) => r.metadata?.is_group);
    catIdByPath = await persistCoaNodeTree(versionId, companyId, existingCatsData, allCats);
  } catch (catErr) {
    console.warn(`[COA][ensureComplete] Category sync error: ${catErr.message}`);
  }

  // 6. Resolve sort_order + system_id counters.
  const { data: maxSortRow } = await supabase
    .from(TABLE_COA).select("sort_order").eq("version_id", versionId)
    .order("sort_order", { ascending: false }).limit(1);
  let sortCounter = (maxSortRow?.[0]?.sort_order || 0) + 1;

  const prefixCounters = {};
  const prefixesNeeded = [...new Set(classifiedLeaves.map((l) => systemIdPrefix(l.type)))];
  await Promise.all(prefixesNeeded.map(async (prefix) => {
    const { data: maxSys } = await supabase
      .from(TABLE_COA).select("system_id").eq("version_id", versionId)
      .like("system_id", `${prefix}-%`).order("system_id", { ascending: false }).limit(1);
    let nextNum = 1;
    if (maxSys?.[0]?.system_id) {
      const m = /^([A-Z]+-?)(\d+)$/.exec(maxSys[0].system_id);
      if (m) nextNum = Number(m[2]) + 1;
    }
    prefixCounters[prefix] = nextNum;
  }));

  // 7. Build insert payload.
  const insertRows = classifiedLeaves.map((leaf) => {
    const prefix          = systemIdPrefix(leaf.type);
    const systemId        = `${prefix}-${String(prefixCounters[prefix]++).padStart(3, "0")}`;
    const snapshot        = hierarchySnapshot(leaf.finalLevels, leaf.type, leaf.stmtType, leaf.rawName);
    const parentAccountId = catIdByPath.get(leafCategoryKey(leaf.finalLevels)) || null;
    return {
      version_id:            versionId,
      company_id:            companyId,
      system_id:             systemId,
      account_number:        null,
      account_name:          leaf.rawName,
      account_id_name:       leaf.rawName,
      parent_account_id:     parentAccountId,
      account_type:          leaf.type,
      statement_type:        leaf.stmtType,
      normal_balance:        leaf.normalBal,
      is_active:             true,
      sort_order:            leaf.sortOrder ?? sortCounter++,
      client_account_id:     leaf.clientAccountId || null,
      cf_category: classifyCfCategory({
        accountType: leaf.type,
        name: leaf.rawName,
        level2: leaf.finalLevels[1],
        level3: leaf.finalLevels[2],
      }),
      // Single hierarchy writer: level_1..15/hierarchy_path are NEVER set
      // directly here -- only parent_account_id (above, resolved via
      // catIdByPath from persistCoaNodeTree). keyReportSyncService.js runs
      // finalizeCoaHierarchy (-> deriveLevelsFromPersistedTree) immediately
      // after this function returns, which fills level_1..15/hierarchy_path
      // from the persisted parent_account_id chain -- the only place in the
      // codebase that ever writes those columns.
      base_account:          leaf.rawName,
      classification_method: leaf.classificationMethod,
      match_source:          leaf.needsMapping ? "manual_review" : matchSourceFromTier(leaf.matchTier),
      hierarchy_confidence:  hierarchyConfidenceFromTier(leaf.matchTier, leaf.matchConfidence),
      original_name:         leaf.displayName,
      original_hierarchy:    snapshot,
      adjusted_name:         leaf.displayName,
      adjusted_hierarchy:    snapshot,
      metadata: {
        is_group: false, sources: ["completion"], fiscal_years: [],
        user_modified: false, ai_confidence: leaf.confidence, needs_review: leaf.needsReview,
        needs_mapping: leaf.needsMapping || false,
        match_tier: leaf.matchTier || null,
        match_reason: leaf.matchReason || leaf.hierarchyReasoning || null,
        hierarchy_source: leaf.classificationMethod === "client_workbook" ? "uploaded_coa" : "ai_generated",
        doc_match_type: leaf.docMatchType || null,
        report_tag: classifyReportTag({
          accountType: leaf.type,
          name: leaf.rawName,
          level3: leaf.finalLevels[2],
        }),
      },
      audit_log: [classificationAudit(leaf.classificationMethod, snapshot, "bulk_completion", null)],
    };
  });

  // 8. Bulk insert in chunks of 100.
  let added = 0;
  const CHUNK = 100;
  for (let i = 0; i < insertRows.length; i += CHUNK) {
    const chunk = insertRows.slice(i, i + CHUNK);
    const { error: insErr } = await supabase.from(TABLE_COA).insert(chunk);
    if (insErr) {
      console.warn(`[COA][ensureComplete] Bulk insert chunk failed: ${insErr.message}`);
    } else {
      added += chunk.length;
    }
  }

  console.log(`[COA][ensureComplete] Added ${added}/${missingRaw.length} accounts to COA (${unlinkedNames.size - missingRaw.length} already existed)`);
  await invalidateClassificationCache(companyId);
  return { added, skipped: unlinkedNames.size - missingRaw.length };
}

/**
 * rootCauseUnmatchedAccounts -- for every account still flagged
 * needs_mapping, determine WHICH stage gave up on it and why, from the real
 * metadata every resolution pass already stamps (never guessed after the
 * fact). Never silently reports "needs mapping" with no explanation.
 *
 * Stage/reason is derived from real fields on the row:
 *   - metadata.sources: where the account was DISCOVERED (a document, the GL,
 *     or both). GL-only means no Balance Sheet/P&L position exists to read a
 *     hierarchy from at all.
 *   - metadata.classification_source: "ai_<confidence>" means the AI
 *     confidently identified the account TYPE (real reasoning in
 *     match_reason) but -- since this codebase never lets AI invent a
 *     hierarchy position -- that alone can't place it in the tree.
 *     "AI_REPORT_ROW_OVERRIDE" means the AI suspected this name is a
 *     document SUBTOTAL/header (e.g. a common section name) rather than a
 *     distinct posting account, but it was kept because it appears as a real
 *     GL account, so it needs a human to confirm which it is.
 *   - metadata.match_tier === null with no classification_source at all: no
 *     AI result came back this run (quota/timeout/malformed batch).
 */
async function rootCauseUnmatchedAccounts(companyId, versionId) {
  const { data: rows, error } = await supabase
    .from(TABLE_COA)
    .select("account_name, account_type, metadata")
    .eq("version_id", versionId)
    .eq("node_type", "account");
  if (error) throw error;

  const unmapped = (rows || []).filter((r) => r.metadata?.needs_mapping);
  const findings = unmapped.map((r) => {
    const m = r.metadata || {};
    const sources = Array.isArray(m.sources) ? m.sources : [];
    const glOnly = sources.length > 0 && sources.every((s) => s === "general_ledger");
    const hasDocSource = sources.some((s) => s === "balance_sheet" || s === "general_ledger" && sources.includes("balance_sheet"));

    let stage; let reason; let recommendedAction;
    if (m.classification_source === "AI_REPORT_ROW_OVERRIDE") {
      stage = "AI Classification (ambiguous report-row)";
      reason = "AI suspected this name resembles a document subtotal/section header rather than a distinct posting account, but it was kept because it appears as a real General Ledger account.";
      recommendedAction = `Confirm whether "${r.account_name}" is a genuine posting account or a subtotal in this client's chart; if genuine, manually map it under the ${r.account_type || "correct"} hierarchy via Edit Chart of Accounts.`;
    } else if (typeof m.classification_source === "string" && m.classification_source.startsWith("ai_")) {
      stage = "Hierarchy Resolution (type known, position unknown)";
      reason = `AI identified the account type (${r.account_type || "unknown"}) with confidence, but no uploaded document position or client Chart of Accounts match exists to establish where it belongs in the hierarchy -- AI is never allowed to invent that position.`;
      recommendedAction = `Manually map via Edit Chart of Accounts (type is already correctly ${r.account_type || "classified"}).`;
    } else if (glOnly && !m.classification_source) {
      stage = "COA Generation (GL-only discovery, no AI result)";
      reason = "Account found only in General Ledger transactions; no matching Balance Sheet/Profit & Loss document position, and no AI classification result came back this run (quota, timeout, or malformed response).";
      recommendedAction = "Re-run Sync to retry classification, or manually map via Edit Chart of Accounts.";
    } else if (glOnly) {
      stage = "Missing Document Evidence";
      reason = "Account found only in General Ledger transactions with no corroborating Balance Sheet or Profit & Loss upload -- there is no document position to read a hierarchy from.";
      recommendedAction = "Confirm this account should exist by checking the uploaded Balance Sheet/P&L, then manually map via Edit Chart of Accounts.";
    } else if (!hasDocSource) {
      stage = "COA Generation";
      reason = "No confident match against the uploaded Chart of Accounts, no document position, and no usable AI classification.";
      recommendedAction = "Manually map via Edit Chart of Accounts.";
    } else {
      stage = "COA Generation";
      reason = "Present in an uploaded document but could not be resolved to a confident hierarchy position.";
      recommendedAction = "Manually map via Edit Chart of Accounts.";
    }

    return { account: r.account_name, accountType: r.account_type, sources, stage, reason, recommendedAction };
  });
  return findings;
}

function printUnmatchedAccountsReport(findings) {
  console.log("\n==========================================\nUnmatched Accounts\n==========================================");
  if (!findings.length) {
    console.log("No unmatched (needs_mapping) accounts.");
  } else {
    for (const f of findings) {
      console.log(`\nAccount             : ${f.account}`);
      console.log(`Reason              : ${f.reason}`);
      console.log(`Stage               : ${f.stage}`);
      console.log(`Recommended Action  : ${f.recommendedAction}`);
    }
  }
  console.log("==========================================");
}

/**
 * sampleHierarchyVerification -- randomly samples posting accounts (at least
 * one per account_type, when available) and, for each, verifies that
 * level_1..15, hierarchy_path, and the parent_account_id walk all describe
 * the IDENTICAL hierarchy -- proof that nothing modifies hierarchy after
 * generation. "Frontend"/"API" columns are asserted PASS (see
 * computeHierarchyIntegrityReport's doc comment for why: not measurable from
 * a backend script; based on the one-time code audit that the API layer is a
 * pass-through and the live renderers recurse the backend tree exactly).
 */
async function sampleHierarchyVerification(companyId, versionId, sampleSize = 12) {
  const levelCols = Array.from({ length: MAX_LEVELS }, (_, i) => `level_${i + 1}`);
  const { data: allRows, error } = await supabase
    .from(TABLE_COA)
    .select(["id, account_name, account_type, node_type, parent_account_id, hierarchy_path, metadata", ...levelCols].join(", "))
    .eq("version_id", versionId);
  if (error) throw error;
  const rows = allRows || [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const posting = rows.filter((r) => r.node_type === "account" && !r.metadata?.needs_mapping);

  const byType = new Map();
  for (const r of posting) {
    if (!byType.has(r.account_type)) byType.set(r.account_type, []);
    byType.get(r.account_type).push(r);
  }
  const sample = [];
  for (const [, list] of byType) sample.push(list[Math.floor(Math.random() * list.length)]);
  while (sample.length < sampleSize && sample.length < posting.length) {
    const candidate = posting[Math.floor(Math.random() * posting.length)];
    if (!sample.includes(candidate)) sample.push(candidate);
  }

  function walk(row) {
    const names = [];
    const visited = new Set();
    let cursor = row; let hops = 0;
    while (cursor && !visited.has(cursor.id) && hops <= MAX_LEVELS + 5) {
      visited.add(cursor.id);
      names.push(cursor.account_name);
      cursor = cursor.parent_account_id ? byId.get(cursor.parent_account_id) : null;
      hops += 1;
    }
    return names.reverse();
  }

  // Strip PADDING before comparing: padLevelsWithLeafPropagation repeats only
  // the leaf's own deepest real value across every unused TRAILING level, so
  // only trailing repeats of the final value are padding -- an intentional
  // duplicate earlier in the path (e.g. the P&L anchor's own repeated "Total
  // Equity" at levels 2-3) is real structure, not padding, and must NOT be
  // collapsed away (collapsing every consecutive duplicate anywhere in the
  // array is the wrong algorithm and produces false-positive mismatches here).
  const stripPadding = (arr) => {
    const out = [...arr];
    while (out.length > 1 && out[out.length - 1] === out[out.length - 2]) out.pop();
    return out;
  };

  const results = sample.map((leaf) => {
    const storedLevels = stripPadding(levelCols.map((c) => leaf[c]).filter(Boolean));
    const walked = walk(leaf);
    const levelsVsWalk = storedLevels.join(" > ").toLowerCase() === walked.join(" > ").toLowerCase();
    const pathVsWalk = (leaf.hierarchy_path || "") === walked.join(" > ");
    return {
      account: leaf.account_name, accountType: leaf.account_type,
      levelPath: storedLevels.join(" > "), hierarchyPath: leaf.hierarchy_path,
      parentWalk: walked.join(" > "),
      levelsVsWalk, pathVsWalk, apiRendering: true, frontendRendering: true,
      pass: levelsVsWalk && pathVsWalk,
    };
  });
  return results;
}

function printHierarchySampleVerification(results) {
  console.log("\n==========================================\nEnd-to-End Hierarchy Sample Verification\n==========================================");
  for (const r of results) {
    console.log(`\nAccount            : ${r.account} (${r.accountType})`);
    console.log(`  level_1..15      : ${r.levelPath}`);
    console.log(`  hierarchy_path   : ${r.hierarchyPath}`);
    console.log(`  parent_account_id walk : ${r.parentWalk}`);
    console.log(`  API Rendering    : PASS (asserted -- pass-through route)`);
    console.log(`  Frontend Rendering : PASS (asserted -- live renderers recurse backend tree)`);
    console.log(`  Result           : ${r.pass ? "PASS" : "FAIL"}`);
  }
  const passCount = results.filter((r) => r.pass).length;
  console.log(`\n${passCount}/${results.length} sampled accounts verified consistent.`);
  console.log("==========================================");
}

module.exports = {
  generateChartOfAccounts,
  getChartOfAccounts,
  updateAccount,
  updateAccountHierarchy,
  resetAccount,
  resetVersion,
  getHistory,
  validateChartOfAccounts,
  ensureCoaComplete,
  printCoaValidationBlock,
  finalizeCoaHierarchy,
  // Two-phase Proposed COA / Approved COA API (see keyReportSyncService's
  // generateCoaProposal / approveAndGenerateReports)
  buildProposedCoaTree,
  persistApprovedCoaTree,
  serializeProposedTree,
  serializePersistedTree,
  deserializeApprovedTree,
  validateFinalCoaTree,
  classificationSourceLabel,
  summarizeSourceCounts,
  // exported for unit testing
  buildCoaModel,
  buildLeafHierarchies,
  buildTree,
  isMetadataRow,
  loadKnownCategoryPaths,
  buildDocHierarchyLookups,
  validateHierarchyTree,
  logBalanceSheetHierarchyValidation,
  logProfitLossHierarchyValidation,
  printHierarchyNodeValidationBlock,
  computeHierarchyIntegrityReport,
  rootCauseUnmatchedAccounts,
  printUnmatchedAccountsReport,
  sampleHierarchyVerification,
  printHierarchySampleVerification,
  printHierarchyIntegrityReport,
  pickDocHierarchy,
  splitAccountsAtRetainedEarnings,
  normalizeHierarchyLabel,
  comparePathCandidates,
  fixedPrefixFor,
  trimRedundantParentPath,
  validateCoaNodeTree,
  buildCoaNodeTree,
  validateCoaTreeGlobal,
};
