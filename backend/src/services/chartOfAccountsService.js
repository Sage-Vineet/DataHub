// ============================================================================
// Chart of Accounts engine (Key Reports redesign — COA is the source of truth)
//
// Builds a per-version Chart of Accounts (COA) from a synced Key Report
// version's extracted P&L / Balance Sheet / General Ledger accounts, classifies
// each account into a deep hierarchy (up to 15 levels), and persists it with a
// never-overwritten ORIGINAL (AI) classification beside a user-editable ADJUSTED
// one, plus mapping + audit-history tables.
//
// Classification is 100% AI-driven:
//   classifyAccountsWithAI (geminiCoaClassifier) is the sole classification
//   authority for every unique GL account.  No keyword matching, regex rules,
//   or hardcoded dictionaries remain.  Accounts below the confidence threshold
//   are flagged needsReview: true in metadata for human review; they are NOT
//   reclassified by any fallback rule engine.  If Gemini is unavailable all
//   accounts are flagged for review and no silent mis-classification occurs.
//
// Persistence uses an UPSERT-by-stable-key merge (NOT delete-then-insert) so
// that account ids — and therefore the adjustment/classification audit history
// that FKs to them — survive regeneration, and user adjustments are preserved.
// ============================================================================

const { supabase } = require("../db");
const { classifyAccountsWithAI } = require("./keyReports/geminiCoaClassifier");
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

// AI confidence below this value → account is inserted with needsReview: true
// in its metadata so a human can verify the classification.  The AI result is
// still used (never replaced by keyword rules) since any AI result is more
// informative than a blind default.
const AI_NEEDS_REVIEW_THRESHOLD = 0.70;

// Audit history (classification snapshots + per-edit adjustments) is stored
// INLINE on each chart_of_accounts row in the `audit_log` jsonb array, rather
// than in the former coa_account_mappings / coa_account_adjustments /
// coa_classification_history / coa_hierarchy_levels side tables (all removed —
// migration 055). Each entry: { kind, at, ...fields }.
//   kind = "classification" → { method, hierarchy_snapshot, source, by }
//   kind = "adjustment"     → { field_changed, old_value, new_value, by }
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
// resolved this account — coarser than metadata.match_tier (which also
// distinguishes finer tiers within a client-COA match, e.g. "exact" vs "fuzzy").
function matchSourceFromTier(matchTier) {
  if (!matchTier) return null;
  if (matchTier === "bs_section") return "balance_sheet";
  if (matchTier === "pl_section") return "profit_loss";
  if (matchTier === "ai_hierarchy") return "generated";
  if (matchTier === "existing_working_coa") return "existing_working_coa";
  if (matchTier === "rule") return "generated"; // deterministic GAAP fact (Net Income / Retained Earnings), not matched from any document
  return "client_coa"; // coaAccountMatcher tier: account_number/exact/normalized/alias/fuzzy/parent_validated
}

// Top-level audit column (migration 074): how strongly the SELECTED
// HIERARCHY is supported by document evidence — distinct from AI confidence
// (which reflects account_type/normalized_name recognition, not placement).
// `matchConfidence` is the AI's own per-account number for the "ai_hierarchy"
// tier, or coaAccountMatcher's own per-account score for a client-COA match
// (both passed through directly, not a fixed constant) — every other tier
// uses a fixed constant since it isn't a fresh per-account judgment.
function hierarchyConfidenceFromTier(matchTier, matchConfidence) {
  if (!matchTier) return 0;
  if (["ai_hierarchy", "account_number", "exact", "normalized", "alias", "fuzzy", "parent_validated"].includes(matchTier)) {
    return Math.min(1, Math.max(0, Number(matchConfidence) || 0));
  }
  if (matchTier === "bs_section" || matchTier === "pl_section") return 0.9;
  if (matchTier === "existing_working_coa") return 0.8;
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

// ── Metadata row guard ────────────────────────────────────────────────────────
//
// Catches only software-generated noise that is definitively not an accounting
// account: empty strings, date lines, and ERP header rows.  Report totals
// (Total Assets, Net Income, etc.) and section headers (Assets, Liabilities,
// etc.) are NOT filtered here — the AI classifies those as isReportRow: true
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

// ── Source collectors (unchanged) ───────────────────────────────────────────
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
  // fiscal_year no longer exists on general_ledger_entries (migration 069) —
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
  return fetchAllRows(() =>
    supabase.from("balance_sheet_entries")
      .select("account_name, account_number, section, sub_section, is_total, hierarchy_level, parent_path, fiscal_year")
      .eq("company_id", companyId).eq("version_id", versionId)
      .or("is_total.eq.false,is_total.is.null").order("id", { ascending: true }),
  );
}

// Whether a Chart of Accounts DOCUMENT is linked to THIS Key Report version —
// the ONLY correct signal for "was a COA uploaded," per key_report_file_mappings
// (version-scoped). NEVER client_chart_of_accounts.length > 0 — that table is
// company-scoped (a re-upload replaces ALL of a company's rows regardless of
// which version triggered it — see clientCoaImportService.js), so a stale
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

// A mapper that never matches anything and never queries the database — used
// whenever hasLinkedCoaDocumentForVersion is false, so client_chart_of_accounts
// (another company's data, or this same company's stale prior-version upload)
// is never even READ, let alone used as a hierarchy reference.
const NULL_COA_MAPPER = Object.freeze({
  map: () => ({ matched: false, status: "unmatched", reason: "No Chart of Accounts document is linked to this version." }),
  entryCount: 0,
});

// ── Normalization helpers ─────────────────────────────────────────────────────

// Strip a leading GL account-code prefix when one is present in the name field
// (e.g. "1000 - Cash" → "Cash", "10200 Checking" → "Checking").
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
// journal entry — QuickBooks-style exports sometimes record it as a
// colon-joined "Parent:Child" label (e.g. "80950 Operational Expense:
// Background Check") even though that same account posts directly elsewhere
// in the GL under a bare name ("80950 Background Check"). Treating the
// colon form as a brand-new account creates a DUPLICATE chart_of_accounts
// entry for what is really one account (confirmed root cause of a
// reproducible Balance Sheet imbalance — the report-generation half of this
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
 * other rows are passed to the AI — it is the AI's job (isReportRow: true) to
 * decide what is a real account vs. a calculated row.
 *
 * The `key` field matches the normName(rawName) that addLeaf uses internally.
 * The `accountName` sent to Gemini is normalizeForGemini(rawName) — the raw
 * name with leading account-code prefixes stripped.
 *
 * @param {Array} glRows - GL rows (from collectGlAccountsFromEntries)
 * @param {Array} bsRows - BS rows (from collectBsAccountsFromEntries)
 * @param {Array} [plRows] - parsed uploaded P&L rows (ephemeral, see buildCoaModel)
 * @returns {Array<{key, accountName, accountNumber, bsSection, plSection}>}
 */
function collectUniqueAccountNames(glRows, bsRows, plRows, stats = null) {
  const seen = new Map(); // normKey → descriptor
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
    // real account as the GL's own "80950 Background Check" posting row —
    // canonicalized to one COA account, never added as a second leaf.
    if (isKnownAccountReference(splitName, knownGlAccountNames)) {
      if (stats) stats.duplicateAccountsAvoided += 1;
      continue;
    }
    add(splitName, null, null);
  }
  return Array.from(seen.values());
}

// ── Document-hierarchy classification (Priority 2 — between the uploaded ────
// Chart of Accounts match and AI) ───────────────────────────────────────────
//
// The account's OWN real position in the uploaded Balance Sheet/P&L — read
// from the document's own indentation via parent_path (balanceSheetExtraction
// Service.js / profitLossExtractionService.js / geminiFinancialParser.js's
// flattenGeminiRows) — is used directly, dynamic depth, never a fixed level
// scheme. Only AI classification (Priority 3) is spent on an account neither
// the uploaded COA nor the uploaded statements can resolve.

function bsSectionToType(section) {
  const s = String(section || "").toLowerCase();
  if (s === "assets") return "asset";
  if (s === "liabilities") return "liability";
  if (s === "equity") return "equity";
  return null;
}

// Same mapping as buildCoaModel's local typeFromPlSection — kept as its own
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
// when stripping heading rows — not a company-specific mapping) tells us
// which side of the equation it belongs to, even when the account has no
// leaf-level position in any uploaded document to read a section from.
// CONFIRMED production case this fixes: a client's GL posts a real
// transaction directly to an account literally named "Fixed Assets" — a real
// leaf by GL activity (namesWithGlActivity below), but "Fixed Assets" is only
// ever a header/total row in that same client's uploaded Balance Sheet
// (filtered out before insertion, never a postable leaf there), so neither
// Priority 2 (document position) nor a bsSection/plSection value is
// available for it. Only used when every other signal (client COA match,
// document position, confident AI, bsSection/plSection) has already found
// nothing — never overrides any of those.
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
// hierarchy level — "Total for Payroll Expenses" becomes "Payroll Expenses"
// wherever it is used as an ancestor label in the GENERATED COA. Only the
// "Total for " form is stripped (never a bare "Total X", e.g. "Total
// Assets" — that is a legitimate top-level statement total, not a subtotal
// alias for a narrower group, and must stay exactly as extracted).
function normalizeHierarchyLabel(label) {
  const s = String(label || "").trim();
  const m = /^total\s+for\s+(.+)$/i.exec(s);
  return m ? m[1].trim() : s;
}

// Fixed hierarchy anchors. These EXACT literal sequences are never generated,
// inferred, or reworded — they are prepended before the account's own real,
// dynamic-depth position in the uploaded document (parent_path) is appended.
// Matches the pre-existing unified-hierarchy convention this codebase already
// expects for P&L accounts (see validateHierarchyConsistency's EXPECTED
// table), extended to a full fixed anchor per statement side.
const ASSET_FIXED_PREFIX     = Object.freeze(["Total Assets", "Total Assets"]);
const LIABILITY_FIXED_PREFIX = Object.freeze(["Total Liabilities and Equity", "Total Liabilities"]);
const EQUITY_FIXED_PREFIX    = Object.freeze(["Total Liabilities and Equity", "Total Equity", "Total Equity", "Equity"]);
const PL_REVENUE_FIXED_PREFIX = Object.freeze([
  "Total Liabilities and Equity", "Total Equity", "Total Equity", "Net Income",
  "Pretax Income", "Operating Income", "Gross Profit", "Total Revenue", "Income",
]);
const PL_EXPENSE_FIXED_PREFIX = Object.freeze([
  "Total Liabilities and Equity", "Total Equity", "Total Equity", "Net Income",
  "Pretax Income", "Operating Income", "Gross Profit", "Total Expenses", "Expenses",
]);

function fixedPrefixFor(accountType) {
  if (accountType === "asset") return ASSET_FIXED_PREFIX;
  if (accountType === "liability") return LIABILITY_FIXED_PREFIX;
  if (accountType === "equity") return EQUITY_FIXED_PREFIX;
  if (accountType === "income") return PL_REVENUE_FIXED_PREFIX;
  if (accountType === "cogs" || accountType === "expense") return PL_EXPENSE_FIXED_PREFIX;
  return [];
}

// The document's own outermost heading (parentPath[0]) is often just the
// bare statement-side label itself ("Assets", "ASSETS", "Equity", "Income",
// "Expenses") — that concept is now carried by the fixed prefix above, so
// keeping it too would duplicate it as its own extra level (the user's own
// worked examples show the uploaded "Current Assets > Bank Accounts >
// Checking" continuing directly after the fixed Level 1/2, with no
// redundant "Assets" level in between). Whole-string match only — a
// deeper, genuinely distinct category (e.g. "Fixed Assets") must never be
// dropped just for containing a similar word.
function isRedundantTopLevelHeading(label, accountType) {
  const s = String(label || "").trim().toLowerCase();
  if (!s) return false;
  if (accountType === "asset") return s === "assets" || s === "asset" || s === "total assets";
  if (accountType === "liability") return s === "liabilities" || s === "liability" || s === "total liabilities";
  if (accountType === "equity") return ["equity", "total equity", "owner's equity", "owners equity", "stockholders equity", "members equity"].includes(s);
  if (accountType === "income") return ["income", "revenue", "sales", "total income", "total revenue"].includes(s);
  if (accountType === "cogs" || accountType === "expense") return ["expenses", "expense", "total expenses", "cost of goods sold", "cost of sales"].includes(s);
  return false;
}

function trimRedundantParentPath(parentPath, accountType) {
  if (parentPath.length && isRedundantTopLevelHeading(parentPath[0], accountType)) return parentPath.slice(1);
  return parentPath;
}

/**
 * Priority-2 lookup tables: normName(accountName) -> { levels, accountType,
 * statementType }, one from this version's own uploaded Balance Sheet rows,
 * one from the ephemeral parsed Profit & Loss rows — both now carrying
 * `parent_path` (migration 077 for BS; P&L stays ephemeral, never persisted).
 * DEEPEST occurrence wins (never first) — see the DEEPEST-WINS comment below.
 * Total/header rows are excluded — they are not real postable accounts.
 */
function buildDocHierarchyLookups(bsRows, plRows) {
  const bsHierarchyByName = new Map();
  for (const r of bsRows || []) {
    // hierarchy_level 0 = a structural header/grouping row (recognized
    // section header, e.g. "ASSETS") — not a real postable account.
    if (!r.account_name || r.is_total || r.hierarchy_level === 0) continue;
    const key = normName(r.account_name);
    const accountType = bsSectionToType(r.section);
    const rawParentPath = (Array.isArray(r.parent_path) ? r.parent_path : []).filter(Boolean).map(normalizeHierarchyLabel);
    const parentPath = trimRedundantParentPath(rawParentPath, accountType);
    const levels = [...fixedPrefixFor(accountType), ...parentPath, r.account_name];
    // DEEPEST-WINS: the same account can appear at different real depths
    // across multiple uploaded Balance Sheet documents (or repeated
    // comparative columns within one) — e.g. one export nests it
    // Assets > Fixed Assets > Equipment > Computer Equipment, another
    // flattens the same account straight under Assets. A later, shallower
    // occurrence must never silently replace an earlier, deeper one that
    // already resolved this account — keep whichever has more real levels.
    const existing = bsHierarchyByName.get(key);
    if (existing && existing.levels.length >= levels.length) continue;
    bsHierarchyByName.set(key, {
      levels,
      accountType,
      statementType: accountType ? "balance_sheet" : null,
    });
  }
  const plHierarchyByName = new Map();
  for (const r of plRows || []) {
    // A subtotal (Gross Profit / Net Operating Income / Net Income, etc.) is
    // a real computed line in the statement, and legitimately appears as an
    // ANCESTOR for other accounts (see the fixed P&L prefixes above) — but
    // is never itself a postable account.
    if (!r.account_name || r.is_total || r.is_header || r.node_type === "subtotal") continue;
    const key = normName(r.account_name);
    const accountType = plSectionToType(r.section);
    const rawParentPath = (Array.isArray(r.parent_path) ? r.parent_path : []).filter(Boolean).map(normalizeHierarchyLabel);
    const parentPath = trimRedundantParentPath(rawParentPath, accountType);
    // Every P&L account anchors under its fixed 9-level prefix before its own
    // real, dynamic-depth position in the uploaded P&L (e.g. Healthcare
    // Revenue > RN Revenue > Travel Nurse Revenue) is appended.
    const levels = [...fixedPrefixFor(accountType), ...parentPath, r.account_name];
    // DEEPEST-WINS — see the identical rule in the Balance Sheet loop above
    // (e.g. one monthly P&L column nests an account under a sub-category,
    // another (or a differently-formatted comparative column) flattens it).
    const existing = plHierarchyByName.get(key);
    if (existing && existing.levels.length >= levels.length) continue;
    plHierarchyByName.set(key, {
      levels,
      accountType,
      statementType: accountType ? "profit_loss" : null,
    });
  }
  return { bsHierarchyByName, plHierarchyByName };
}

// Strict fuzzy fallback (Step 3, between the exact document lookup and AI) —
// same combined Levenshtein/Jaro-Winkler/token-overlap metric and normalized
// input coaAccountMatcher.js's client-COA matcher uses, just applied against
// THIS version's own uploaded-statement accounts instead of a client COA
// workbook. "Checking Account" / "Chase Checking" / "Cash Checking" resolve
// to the same already-known parent this way.
const DOC_FUZZY_THRESHOLD = 0.90;

function fuzzyMatchDocHierarchy(accountName, hierarchyByName) {
  const target = fuzzyNorm(accountName);
  let best = null;
  let bestScore = 0;
  for (const [key, entry] of hierarchyByName) {
    const score = strongSimilarity(target, fuzzyNorm(key));
    if (score >= DOC_FUZZY_THRESHOLD && score > bestScore) {
      bestScore = score;
      best = entry;
    }
  }
  return best;
}

function createDocHierarchyStats() {
  return { balanceSheet: 0, profitLoss: 0, fuzzy: 0 };
}

/**
 * Which parsed-document hierarchy resolves a given account — Steps 1-3 of
 * the mapping logic (exact match in the preferred statement, exact match in
 * the other, then a strict fuzzy match against either). The Retained-
 * Earnings GL bucket (splitAccountsAtRetainedEarnings) is only a preference
 * hint for which statement to try FIRST, never a hard gate.
 *
 * @param {object} [stats] - createDocHierarchyStats() accumulator, incremented
 *   in place for the "COA Hierarchy Generation" summary log — optional, has
 *   no effect on resolution itself.
 */
function pickDocHierarchy(accountName, key, glBucketByKey, bsHierarchyByName, plHierarchyByName, stats) {
  const bucket = glBucketByKey && glBucketByKey.get(key);
  const [first, second, firstLabel, secondLabel] = bucket === "profit_loss"
    ? [plHierarchyByName, bsHierarchyByName, "profitLoss", "balanceSheet"]
    : [bsHierarchyByName, plHierarchyByName, "balanceSheet", "profitLoss"];

  let entry = first.get(key);
  if (entry) { if (stats) stats[firstLabel]++; return entry; }
  entry = second.get(key);
  if (entry) { if (stats) stats[secondLabel]++; return entry; }

  // Step 3 — fuzzy match, tried against both statements' known accounts.
  entry = fuzzyMatchDocHierarchy(accountName, first) || fuzzyMatchDocHierarchy(accountName, second);
  if (entry) { if (stats) stats.fuzzy++; return entry; }
  return null;
}

/**
 * GL "Column B" unique account list, in the GL's own first-seen row order
 * (never alphabetical — Rule 4), split at "Retained Earnings" into Balance
 * Sheet vs Profit & Loss buckets: a real General Ledger conventionally lists
 * Balance Sheet accounts (Assets/Liabilities/Equity) before Profit & Loss
 * accounts (Income/Expenses), with Retained Earnings the last Balance Sheet
 * account. This is a bucketing HINT for which parsed document hierarchy to
 * try first (see pickDocHierarchy) — never a hard gate: an account outside
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
    console.warn('[ChartOfAccounts] "Retained Earnings" not found in the General Ledger\'s account list — Balance Sheet/P&L bucketing hint skipped; every account still tries both parsed hierarchies.');
    return new Map();
  }
  const bucketByKey = new Map();
  uniqueOrdered.forEach((n, i) => bucketByKey.set(normName(n), i <= reIdx ? "balance_sheet" : "profit_loss"));
  return bucketByKey;
}

// ── COA leaf model ────────────────────────────────────────────────────────────

/**
 * Build the in-memory COA leaf model from raw account rows.
 *
 * The uploaded Chart of Accounts (client_chart_of_accounts), when present, is
 * the SOURCE OF TRUTH: every unique account is matched against it (see
 * generateChartOfAccounts, which builds `matchResults` via coaMappingService
 * BEFORE any AI call) and a confident match is used directly here —
 * `needsReview: false` always, since a deterministic match is never
 * uncertain. AI (`aiResults`) is only ever consulted for accounts that
 * genuinely don't exist in the upload or matched ambiguously:
 *   • isReportRow: true  → row excluded from COA entirely (report total / header)
 *   • confidence ≥ threshold → accountType used as-is
 *   • confidence < threshold → same AI result used, but needsReview: true set
 *   • no AI result at all   → accountType stays null (never guessed), needsReview: true
 *
 * No keyword rules, no fallback classification engine.
 *
 * @param {Array}  glRows    GL transaction rows
 * @param {Array}  bsRows    Balance Sheet rows
 * @param {Array}  plRows    Parsed uploaded Profit & Loss rows (ephemeral —
 *                           never persisted, no profit_loss_entries table; see
 *                           keyReportSyncService's Step 5b). Each row's own
 *                           `section` (revenue|cost_of_sales|operating_expenses,
 *                           detected from the document's own header text) is
 *                           used only as a Priority-3 type/grouping hint below
 *                           the uploaded Balance Sheet — never invented.
 * @param {Map}    aiResults classifyAccountsWithAI result keyed by normName(accountName) —
 *                           populated ONLY for accounts matchResults left unmatched/ambiguous
 * @param {Map}    matchResults coaMappingService match result keyed by normName(accountName),
 *                           for EVERY unique account (see generateChartOfAccounts)
 * @param {Map}    [glBucketByKey] splitAccountsAtRetainedEarnings's Balance-Sheet/
 *                           Profit-and-Loss bucketing hint (Priority 2, below
 *                           matchResults, above aiResults)
 */
function buildCoaModel(glRows, bsRows, plRows, aiResults = new Map(), matchResults = new Map(), glBucketByKey = new Map()) {
  const leavesByName = new Map();
  const { bsHierarchyByName, plHierarchyByName } = buildDocHierarchyLookups(bsRows, plRows);

  // A GL posting is, by definition, a real transaction — never a calculated
  // report/header row. If Gemini says isReportRow=true for a name that ALSO
  // has real GL activity, that's a misclassification (confirmed live: "Augusta
  // Rule" — 20 real transactions, isReportRow=true at confidence 1.0). GL
  // activity must never silently disappear because of it (root-cause fix —
  // previously this returned early with no COA row and no trace at all).
  const namesWithGlActivity = new Set();
  for (const r of glRows || []) {
    const n1 = r.account_name || r.account_section || "";
    if (n1) namesWithGlActivity.add(normName(n1));
    if (r.split_account) namesWithGlActivity.add(normName(r.split_account));
  }

  // High AI confidence must not be silently overwritten by a lower-priority
  // structural inference (see below) — only a missing or low-confidence AI
  // result may be filled in by bsSection/plSection. This does NOT weaken the
  // "Capital One Credit Card → equity" fix from earlier this session: that
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
    if (aiConfident) return; // keep the confident AI classification — section evidence only fills gaps
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
      // Never applies to a leaf that already has a BS section — a Balance
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
    // even made (see generateChartOfAccounts) — the upload is the source of
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
    // Balance Sheet / Profit & Loss — read from the document's own
    // indentation (parent_path), dynamic depth, never guessed, never sent to
    // AI. Only an account neither the uploaded COA nor the uploaded
    // statements can resolve reaches AI (Priority 3, below).
    const docHierarchy = pickDocHierarchy(name, key, glBucketByKey, bsHierarchyByName, plHierarchyByName);
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
        // (matchLevels/matchHierarchyPath — same fields a client-COA match
        // uses) rather than the AI-hierarchy pass, so classificationMethod/
        // matchTier above are preserved instead of being overwritten to
        // "ai_hierarchy". Parent levels only — the leaf's own name is
        // appended by that pass, same convention as a client-COA match.
        matchLevels: docHierarchy.levels.slice(0, -1),
        matchHierarchyPath: docHierarchy.levels.join(" > "),
        matchSystemId: null,
        matchClientAccountId: null,
        matchNormalBalance: null,
        matchReason: `Matched this account's own position in the uploaded ${docHierarchy.statementType === "profit_loss" ? "Profit & Loss" : "Balance Sheet"}.`,
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

    // AI identified this as a calculated/header row — exclude from COA,
    // UNLESS real GL transactions exist under this exact name, in which case
    // money would silently vanish from Net Income/Balance Sheet. Never
    // discard real GL activity — insert it, flagged for manual review.
    const isReportRowOverride = Boolean(aiResult?.isReportRow) && namesWithGlActivity.has(key);
    if (aiResult?.isReportRow && !isReportRowOverride) return;

    // AI result drives the type classification.  Low or absent confidence → needsReview.
    // bsSection (a structural field from the extraction itself, not AI/keyword-derived
    // from the account name) can still override accountType when present — but ONLY
    // when the AI result is missing or below AI_OVERRIDE_CONFIDENCE_FLOOR; a
    // confident AI answer is never second-guessed by a lower-priority structural
    // inference. plSection is the same idea for the Income Statement side
    // (Priority 3 — below client COA and the uploaded Balance Sheet, above AI)
    // and never applies when bsSection is present.
    // No fallback default: an account with no AI result and no section override
    // has an unknown type — never guessed (was `|| "expense"`). It surfaces as
    // needsReview/needsMapping until a human classifies it.
    let accountType = isReportRowOverride ? null : (aiResult?.accountType || null);
    const aiConfident = !isReportRowOverride && aiResult && Number(aiResult.confidence) >= AI_OVERRIDE_CONFIDENCE_FLOOR && accountType;
    // Set only when sectionHeaderNameToType (below) is what resolved accountType —
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
      // bsSection/plSection) has already been tried and found nothing — last
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
      // straight from the same classifyAccountsWithAI call above — the AI's
      // CPA-style reasoning is the PRIMARY source of hierarchy placement (see
      // buildLeafHierarchies), not a fallback. Empty when isReportRowOverride
      // (this "account" is really a report row that happens to have GL
      // activity — never given an AI-reasoned hierarchy) or when the AI
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
    // become its own leaf — that creates a duplicate chart_of_accounts entry
    // for the same real-world account (confirmed root cause of a Balance
    // Sheet imbalance).
    if (splitName && !isKnownAccountReference(splitName, knownGlAccountNamesForSplit)) {
      addLeaf(splitName, null, "general_ledger", glYear, null);
    }
  }

  // Inject synthetic equity closing lines.  "Net Income" and "Retained Earnings"
  // are computed balances, not real GL accounts.  The AI would mark any extracted
  // "Net Income" row as isReportRow: true, so they never enter via addLeaf — we
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

// ── Hierarchy assembly (uploaded COA is the source of truth, AI is the fallback) ──

/**
 * Derive an account's category (everything above its own base-account name)
 * from a raw level_1..15 array. Collapses consecutive duplicate levels first
 * — both chart_of_accounts (copied from a match) and client_chart_of_accounts
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
 * Every distinct category path already established, from two sources —
 * STRICTLY scoped to this one company/version. No cross-company or
 * cross-version reuse: the client has explicitly required that Company A's
 * COA never influence Company B's.
 *   1. chart_of_accounts — this version's own already-resolved accounts.
 *   2. client_chart_of_accounts — this company's own uploaded COA reference, if any.
 * Passed as context into geminiCoaClassifier's unified hierarchy-generation
 * prompt (see generateChartOfAccounts/ensureCoaComplete) so the AI reuses an
 * already-established path verbatim for a new account that genuinely belongs
 * there (e.g. "AMEX" when "Visa Credit Card" already exists under Credit
 * Cards) instead of drifting to a slightly different phrasing — never
 * invented, and never reaching outside this one company's own data.
 *
 * @param {string} companyId
 * @param {string} versionId
 * @returns {Array<{path: string, levels: string[]}>}
 */
async function loadKnownCategoryPaths(companyId, versionId, hasLinkedCoaDocument = undefined) {
  const levelCols = Array.from({ length: MAX_LEVELS }, (_, i) => `level_${i + 1}`);
  // client_chart_of_accounts is company-scoped, not version-scoped — only
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
 * section EVIDENCE (leaf.bsSection or leaf.plSection — a real
 * balance_sheet_entries.section value or a parsed P&L section header, never
 * from GL, never invented) as `section`, not just an accountType — this
 * makes "no document evidence → no hierarchy" a structural guarantee of the
 * function signature, not just a call-site convention. accountType only
 * selects WHICH one-level label the evidence maps to (the same deterministic
 * type→label translation normalBalanceFor/statementTypeFor already use
 * elsewhere); it was itself already set FROM this same section evidence
 * earlier in buildCoaModel/addLeaf, never independently AI-guessed. Tried
 * BEFORE the AI category selector — a real, if shallow, structural fact from
 * THIS company's own document beats an AI guess, and it's free (no Gemini
 * call) for every account it resolves. The income/cogs/expense branches are
 * Priority 3 (uploaded Profit & Loss) — grouping only, never deeper than one
 * level, never applied to a Balance Sheet account.
 *
 * `subSection` (asset/liability only — from balance_sheet_entries.sub_section,
 * migration 075) adds ONE more real level when the document's own sub-header
 * distinguished it (Current vs. Fixed Assets, Current vs. Long-Term
 * Liabilities) — still evidence-gated the same way as `section`, never
 * invented when the document only shows the bare top-level header.
 */
const ASSET_SUB_LABELS = { current: "Current Assets", fixed: "Fixed Assets", other: "Other Assets" };
const LIABILITY_SUB_LABELS = { current: "Current Liabilities", long_term: "Long-Term Liabilities", other: "Other Liabilities" };

// Every anchor here is built ON TOP OF fixedPrefixFor(accountType) — the same
// fixed root every document-hierarchy match uses (buildDocHierarchyLookups)
// — so a shallow, evidence-only placement still lands under the correct
// top-level branch. Previously income/cogs/expense returned bare anchors
// ("Total Income"/"Total Cost of Goods Sold"/"Total Expenses") with no fixed
// prefix at all, landing them as siblings of "Total Assets"/"Total
// Liabilities and Equity" instead of nested under Net Income where they
// belong — confirmed live as a real wrong-section classification.
function shallowLevelsFromSectionEvidence(section, accountType, subSection) {
  if (!section) return null; // no document evidence — never guess
  const prefix = fixedPrefixFor(accountType);
  if (accountType === "asset") {
    const sub = subSection && ASSET_SUB_LABELS[subSection];
    return sub ? [...prefix, sub] : [...prefix];
  }
  if (accountType === "liability") {
    const sub = subSection && LIABILITY_SUB_LABELS[subSection];
    return sub ? [...prefix, sub] : [...prefix];
  }
  if (accountType === "equity") return [...prefix];
  if (accountType === "income" || accountType === "cogs" || accountType === "expense") return [...prefix];
  return null;
}

/**
 * Enrich each leaf with its full 15-level hierarchy.
 *
 * The uploaded Chart of Accounts is the source of truth: matching against it
 * already happened in generateChartOfAccounts (BEFORE any AI call), and its
 * result is sitting on the leaf as `matchLevels`/`matchHierarchyPath`/etc
 * (see buildCoaModel). This function's job is just to turn that — or an AI
 * result for the accounts that had no confident match at all — into the
 * final `levels`/`hierarchyPath`.
 *
 * Pass order:
 *   1. Rule — synthetic Net Income / Retained Earnings, a fixed GAAP fact,
 *      not something to reason about or match.
 *   2. Client COA match — copy `matchLevels`/`matchHierarchyPath` verbatim.
 *      `needsReview` is explicitly forced to `false` here — a confident
 *      deterministic match is never uncertain, regardless of what an
 *      (unrun, since matched accounts never reach AI) AI confidence would
 *      otherwise have set.
 *   3. Existing Working COA — reuse a leaf's own prior hierarchy from an
 *      earlier regenerate, for accounts that still have no COA match this
 *      run. Stability beats re-spending an AI call and risking a different
 *      placement than last time.
 *   4. AI hierarchy — leaf.aiLevels, exactly as returned by the model, for
 *      accounts genuinely missing from the upload or ambiguously matched
 *      (see classifyAccountsWithAI's disambiguation-candidates mode).
 *   5. AI-failure fallback — shallowLevelsFromSectionEvidence, fires only
 *      when the AI returned nothing usable for this account this run (no
 *      API key, quota, malformed batch) and real BS/PL section evidence
 *      exists. Cheap, deterministic, evidence-gated — better than nothing,
 *      always flagged needsReview since it's shallower than a full AI
 *      hierarchy.
 *   6. Anything still unresolved → needsMapping: true. Never invented.
 *
 * @param {Array} leaves — output of buildCoaModel
 * @param {Map} [existingByKey] — accountKey → existing chart_of_accounts row for
 *   this version (from a prior regenerate). Consulted in the Existing
 *   Working COA pass, before the AI hierarchy is applied.
 * @returns {Promise<Array>} leaves augmented with { levels, hierarchyPath, baseAccount, displayName, needsMapping, matchTier, sortOrder }
 */
async function buildLeafHierarchies(leaves, existingByKey = new Map()) {
  const resolved = leaves.map((leaf) => {
    const displayName = leaf.aiNormalizedName || leaf.accountName;

    // Synthetic GAAP closing lines (ensureEquityLeaf — Net Income / Retained
    // Earnings) are a fixed structural fact, not something to reason about:
    // they always sit directly under Total Equity, as siblings of each
    // other, never nested one under the other.
    if (leaf.classificationMethod === "rule" && leaf.accountType === "equity") {
      const path = ["Total Liabilities and Equity", "Total Equity", leaf.accountName];
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

    // Client COA match — resolved upstream in buildCoaModel (matchResults),
    // just needs its levels array assembled with the account's own name.
    // Also covers a Priority-2 document-hierarchy match with an EMPTY parent
    // chain (a flat document with no real indentation to read) — that's
    // still a legitimate, if shallow, resolved 1-level hierarchy ([own name]),
    // not an unresolved account; the classificationMethod check is what lets
    // it in even though matchLevels.some(Boolean) is false for an empty array.
    if (leaf.matchLevels && (leaf.matchLevels.some(Boolean) || leaf.classificationMethod === "document_hierarchy")) {
      const baseAccount = leaf.accountName || displayName;
      const path = [...leaf.matchLevels.filter(Boolean), baseAccount];
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

    return { ...leaf, displayName, __pending: true };
  });

  // Track indices into `resolved` explicitly — pending is a filtered COPY of
  // the array, so writing into pending[i] would never be seen by the final
  // resolved.map() below; every update here must go through resolved[idx].
  let pendingIndices = [];
  resolved.forEach((r, idx) => { if (r.__pending) pendingIndices.push(idx); });

  // Pass: reuse a leaf's own EXISTING hierarchy from a prior regenerate.
  // Stability across syncs beats spending a fresh AI call and risking a
  // different placement than last time. Never applies to an existing row
  // that itself has no real hierarchy (empty hierarchy_path — already
  // needs_mapping).
  for (const idx of pendingIndices) {
    const leaf = resolved[idx];
    const existing = existingByKey.get(accountKey(leaf.accountNumber, leaf.accountName));
    if (!existing || !existing.hierarchy_path) continue;
    const existingLevels = columnsToLevels(existing);
    if (!existingLevels.some(Boolean)) continue;

    resolved[idx] = {
      ...leaf,
      levels: existingLevels,
      hierarchyPath: existing.hierarchy_path,
      baseAccount: existing.base_account || leaf.accountName,
      needsMapping: false,
      needsReview: false,
      classificationMethod: "existing_working_coa",
      matchTier: "existing_working_coa",
      matchConfidence: null,
      sortOrder: existing.sort_order ?? null,
      __pending: false, // resolved — must not be reprocessed/overwritten by a later pass
    };
  }
  pendingIndices = pendingIndices.filter((idx) => resolved[idx].__pending);

  // Pass: AI-generated hierarchy — the model's own reasoned levels array,
  // for accounts genuinely missing from the uploaded COA or matched
  // ambiguously (buildCoaModel attaches leaf.aiLevels/leaf.aiReasoning ONLY
  // for these — everything else was resolved above without an AI call).
  // Empty aiLevels means the AI returned nothing usable — falls through to
  // the section-evidence fallback below, never given an invented hierarchy.
  for (const idx of pendingIndices) {
    const leaf = resolved[idx];
    if (!leaf.aiLevels || !leaf.aiLevels.length) continue;
    const baseAccount = leaf.accountName || leaf.displayName;
    // The AI reasons about the account's OWN intermediate categories only
    // (e.g. "Revenue" for a "40000 Revenue" account) — it is never asked to
    // reproduce the fixed 2-9 level root every account of this type shares
    // (Total Assets / Total Liabilities and Equity > ... > Total Revenue,
    // etc.), so that root must be prepended here exactly like every
    // document-hierarchy match already gets it (buildDocHierarchyLookups).
    // Without this, an AI-classified account was landing under its OWN
    // invented top-level anchor ("Total Revenue" as level_1) instead of
    // nested correctly under the shared fixed prefix — confirmed live as a
    // real wrong-section classification. trimRedundantParentPath strips a
    // leading AI label that just re-states the fixed prefix's own concept
    // (e.g. AI returning "Total Revenue" as its own first level) so it isn't
    // duplicated.
    const trimmedAiLevels = trimRedundantParentPath(leaf.aiLevels, leaf.accountType);
    const path = [...fixedPrefixFor(leaf.accountType), ...trimmedAiLevels, baseAccount];
    const levels = new Array(MAX_LEVELS).fill(null);
    path.forEach((label, li) => { if (li < MAX_LEVELS) levels[li] = label; });

    resolved[idx] = {
      ...leaf,
      levels,
      hierarchyPath: path.join(" > "),
      baseAccount,
      needsMapping: false,
      // Preserve whatever confidence-based review flag buildCoaModel already
      // computed from the AI's accountType confidence — a low-confidence
      // type classification should stay reviewable even if the hierarchy
      // itself looks fine.
      needsReview: leaf.needsReview,
      classificationMethod: "ai_hierarchy",
      matchTier: "ai_hierarchy",
      matchConfidence: leaf.confidence ?? null,
      __pending: false,
    };
  }
  pendingIndices = pendingIndices.filter((idx) => resolved[idx].__pending);

  // Pass: AI-failure fallback — a shallow, evidence-gated placement for an
  // account the AI could not classify at all this run (no API key, quota,
  // malformed batch response). Real document section evidence beats
  // nothing, but is still far shallower than a proper AI-reasoned hierarchy,
  // so it's always flagged needsReview.
  for (const idx of pendingIndices) {
    const leaf = resolved[idx];
    const sectionEvidence = leaf.bsSection || leaf.plSection;
    const shallowLevels = shallowLevelsFromSectionEvidence(sectionEvidence, leaf.accountType, leaf.bsSubSection);
    if (!shallowLevels) continue;
    const tier = leaf.bsSection ? "bs_section" : "pl_section";

    const baseAccount = leaf.accountName || leaf.displayName;
    const path = [...shallowLevels, baseAccount];
    const levels = new Array(MAX_LEVELS).fill(null);
    path.forEach((label, li) => { if (li < MAX_LEVELS) levels[li] = label; });

    resolved[idx] = {
      ...leaf,
      levels,
      hierarchyPath: path.join(" > "),
      baseAccount,
      needsMapping: false,
      needsReview: true,
      classificationMethod: tier,
      matchTier: tier,
      matchConfidence: null,
      __pending: false, // resolved — must not be reprocessed/overwritten by a later pass
    };
  }
  pendingIndices = pendingIndices.filter((idx) => resolved[idx].__pending);

  // Anything still pending is a genuinely new accounting concept the AI
  // could not place and no document section evidence exists for — flagged
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

// Final normalization applied at persistence time (levelsToColumns, below) —
// NOT here — so buildLeafHierarchies keeps returning the TRUE, unpadded
// document-derived levels for the pre-insert depth/quality logging
// (Maximum/Average Depth, Accounts With Internal Hierarchy Gaps) to stay
// meaningful. The uploaded documents define the hierarchy only up to the
// true leaf account; there is no real data for any level beyond it. Per an
// explicit business rule (never a guess or an invented category): every
// level past the leaf repeats the leaf's own name instead of staying NULL,
// so every persisted row has exactly 15 populated levels and the deepest
// populated level always equals the account itself. Only TRAILING empty
// levels (after the last real, document-derived value) are touched — an
// internal gap, if one ever existed, is left alone so it still surfaces in
// the pre-insert gap check rather than being silently papered over here.
function padLevelsWithLeafPropagation(levels, leafName) {
  const out = (levels || []).slice(0, MAX_LEVELS);
  while (out.length < MAX_LEVELS) out.push(null);
  let lastIdx = -1;
  for (let i = 0; i < MAX_LEVELS; i += 1) {
    if (out[i] != null && String(out[i]).trim()) lastIdx = i;
  }
  if (lastIdx < 0) {
    // A genuinely unresolved leaf (no document position, no AI, no section
    // evidence) has zero real levels — even then, every level must be
    // populated, so all 15 repeat the leaf's own name.
    const fallback = leafName || null;
    for (let i = 0; i < MAX_LEVELS; i += 1) out[i] = fallback;
    return out;
  }
  const lastValue = out[lastIdx];
  for (let i = lastIdx + 1; i < MAX_LEVELS; i += 1) out[i] = lastValue;
  return out;
}

// ── Persistence helpers ──────────────────────────────────────────────────────

// leafName: pass the account's own name for a LEAF account row — trailing
// levels past the uploaded documents' real depth are filled by repeating it
// (padLevelsWithLeafPropagation's doc comment has the full rule). Omit it
// for a pure category/group node (a grouping's own row correctly has only
// as many levels as its own real depth — it is not "an account" that needs
// to look 15 levels deep).
function levelsToColumns(levels, leafName = null) {
  const padded = leafName != null ? padLevelsWithLeafPropagation(levels, leafName) : levels;
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

// ── System ID (the client's "System ID" column: INC-001 / EXP-001 / BS-001) ───
const SYSTEM_ID_PREFIX = Object.freeze({
  income: "INC", expense: "EXP", cogs: "EXP",
  asset: "BS", liability: "BS", equity: "BS",
});
// Excel ordering: income → expense → assets → liabilities → equity.
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
  for (const row of existingByKey.values()) {
    const m = /^([A-Z]+)-(\d+)$/.exec(row.system_id || "");
    if (!m) continue;
    maxByPrefix[m[1]] = Math.max(maxByPrefix[m[1]] || 0, Number(m[2]));
  }
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
    if (existing?.system_id && existingPrefix === prefix) {
      byKey.set(key, existing.system_id);
      continue;
    }
    // New account, or reclassified into a different section → issue a correct-prefix id.
    const n = (maxByPrefix[prefix] || 0) + 1;
    maxByPrefix[prefix] = n;
    byKey.set(key, `${prefix}-${String(n).padStart(3, "0")}`);
  }
  return byKey;
}

// ── Category (parent) node materialization for parent_account_id ──────────────
// The level columns alone encode the hierarchy, but the spec also requires a
// valid parent_account_id tree. We materialize one is_group row per distinct
// path prefix (the level labels above the base account) and chain them, so a
// real expandable tree can be rebuilt from parent_account_id — not just levels.

/** The category path a leaf hangs under (its levels minus the base account). */
function leafCategoryKey(levelsArr) {
  const path = levelsArr.filter(Boolean);
  if (path.length <= 1) return null; // base account only → no parent category
  return path.slice(0, -1).join(" > ");
}

/** Distinct category prefixes across all leaves → Map<catKey, descriptor>. */
function buildDesiredCategories(leaves) {
  const cats = new Map();
  for (const leaf of leaves) {
    const path = leaf.levels.filter(Boolean);
    if (path.length <= 1) continue;
    const catLabels = path.slice(0, -1);
    for (let i = 0; i < catLabels.length; i += 1) {
      const prefixArr = catLabels.slice(0, i + 1);
      const key = prefixArr.join(" > ");
      if (cats.has(key)) continue;
      cats.set(key, {
        pathArr: prefixArr,
        label: prefixArr[prefixArr.length - 1],
        parentKey: i === 0 ? null : prefixArr.slice(0, -1).join(" > "),
        depth: prefixArr.length,
        accountType: leaf.accountType,
        statementType: leaf.statementType,
      });
    }
  }
  return cats;
}

/**
 * Reconcile the version's category nodes against the desired set: insert new,
 * update changed, delete stale, then chain parent_account_id. Returns
 * Map<catKey, accountId> for the leaf pass to point parents at.
 */
async function syncCategoryNodes(versionId, companyId, existingCatsData, desiredCats) {
  const existingByPath = new Map();
  for (const row of existingCatsData || []) {
    const p = row.metadata?.cat_path;
    if (p) existingByPath.set(p, row);
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
    const hierarchyPath = def.pathArr.join(" > ");
    const existing = existingByPath.get(key);
    const common = {
      account_type: def.accountType,
      statement_type: def.statementType,
      sort_order: sortCounter,
      ...levelsToColumns(levelsArr),
      hierarchy_path: hierarchyPath,
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

  if (toInsert.length) {
    const payload = toInsert.map(({ _cat_path, ...row }) => row);
    const ins = await supabase.from(TABLE_COA).insert(payload).select("id, metadata");
    if (ins.error) throw ins.error;
    for (const row of ins.data || []) {
      const p = row.metadata?.cat_path;
      if (p) catIdByPath.set(p, row.id);
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

  // Delete category nodes whose path is no longer used (CASCADE clears any FKs).
  const staleCatIds = (existingCatsData || [])
    .filter((row) => !desiredCats.has(row.metadata?.cat_path))
    .map((row) => row.id);
  if (staleCatIds.length) {
    const del = await supabase.from(TABLE_COA).delete().in("id", staleCatIds);
    if (del.error) throw del.error;
  }

  return catIdByPath;
}

/**
 * Post-generation sanity check: verify that every leaf's level_1/level_2
 * match the expected labels for its accountType.  Logs warnings for any
 * anomalies and returns them for the caller to include in the response.
 * Never throws — this is purely informational.
 *
 * @param {Array} hierarchical - output of buildLeafHierarchies
 * @returns {Array<{accountName, accountType, level1, level2, expected1, expected2}>}
 */
function validateHierarchyConsistency(hierarchical) {
  // Unified hierarchy (client spec): Net Income nests under Total Equity, so
  // income/cogs/expense share the same L1/L2 anchor as equity — L2 is not
  // type-discriminating anymore, this only checks each type's leaves are
  // internally consistent with the anchor they're supposed to share.
  // Assets have no stable L2 (it's the subcategory: Current/Fixed/Other
  // Assets) — level2 is intentionally omitted (undefined) for asset so that
  // check is skipped rather than false-flagging every asset leaf.
  const EXPECTED = {
    asset:     { level1: 'Total Assets' },
    liability: { level1: 'Total Liabilities and Equity', level2: 'Total Liabilities' },
    equity:    { level1: 'Total Liabilities and Equity', level2: 'Total Equity' },
    income:    { level1: 'Total Liabilities and Equity', level2: 'Total Equity' },
    cogs:      { level1: 'Total Liabilities and Equity', level2: 'Total Equity' },
    expense:   { level1: 'Total Liabilities and Equity', level2: 'Total Equity' },
  };
  const issues = [];
  for (const leaf of hierarchical) {
    if (leaf.needsMapping) continue; // unmapped, not inconsistent — tracked separately
    const exp = EXPECTED[leaf.accountType];
    if (!exp) continue;
    const l1 = leaf.levels[0] || '';
    const l2 = leaf.levels[1] || '';
    const l1Bad = l1 !== exp.level1;
    const l2Bad = exp.level2 != null && l2 !== exp.level2;
    if (l1Bad || l2Bad) {
      issues.push({
        accountName: leaf.accountName,
        accountType: leaf.accountType,
        level1: l1, level2: l2,
        expected1: exp.level1, expected2: exp.level2 ?? '(any)',
      });
    }
  }
  if (issues.length) {
    console.warn(
      `[ChartOfAccounts][validateHierarchy] ${issues.length} anomaly/anomalies:\n` +
      issues.slice(0, 10).map((i) =>
        `  "${i.accountName}" (${i.accountType}): L1="${i.level1}" L2="${i.level2}"` +
        ` (expected "${i.expected1}" / "${i.expected2}")`
      ).join('\n') +
      (issues.length > 10 ? `\n  ... and ${issues.length - 10} more` : ''),
    );
  }
  return issues;
}

/**
 * Diagnostic-only (never blocking): groups leaves that share identical real
 * document section evidence (same accountType + same bsSection/plSection)
 * and flags any group whose members ended up with different level_1/level_2
 * — a sign the AI's per-batch hierarchy reasoning drifted for what should be
 * the same reporting group, despite being given the same known category
 * paths as context. Does not fix anything automatically (that risks silently
 * overriding a placement that was actually correct) — surfaced for a human
 * to review, same as validateHierarchyConsistency's anomalies.
 *
 * @param {Array} hierarchical - output of buildLeafHierarchies
 * @returns {Array<{accountType, section, level1Values, level2Values, accountNames}>}
 */
function detectSiblingDrift(hierarchical) {
  const groups = new Map();
  for (const leaf of hierarchical) {
    if (leaf.needsMapping) continue;
    const section = leaf.bsSection || leaf.plSection;
    if (!section || !leaf.accountType) continue; // no real evidence to compare against
    const groupKey = `${leaf.accountType}::${String(section).toLowerCase().trim()}`;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(leaf);
  }

  const issues = [];
  for (const [groupKey, members] of groups) {
    if (members.length < 2) continue;
    const [accountType, section] = groupKey.split("::");
    const level1Values = new Set(members.map((m) => m.levels[0] || ""));
    const level2Values = new Set(members.map((m) => m.levels[1] || ""));
    if (level1Values.size > 1 || level2Values.size > 1) {
      issues.push({
        accountType,
        section,
        level1Values: [...level1Values],
        level2Values: [...level2Values],
        accountNames: members.map((m) => m.accountName),
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
async function generateChartOfAccounts(companyId, versionId, batchId, opts = {}) {
  if (!companyId || !versionId) {
    return { accountCount: 0, leafCount: 0, skipped: true };
  }

  // Case 1 vs Case 2 — the ONLY signal is whether a COA document is linked to
  // THIS version (see hasLinkedCoaDocumentForVersion's doc comment). The
  // caller (keyReportSyncService.js) already knows this from the version's
  // own linked-document mappings and should pass it through opts; falls back
  // to a direct, version-scoped check when not provided — never to
  // client_chart_of_accounts.length > 0.
  const hasLinkedCoaDocument = opts.hasLinkedCoaDocument !== undefined
    ? Boolean(opts.hasLinkedCoaDocument)
    : await hasLinkedCoaDocumentForVersion(versionId);

  // 1) Collect source accounts. GL + Balance Sheet come from entry tables (P&L
  //    transactions surface through the GL — there is no profit_loss_entries
  //    table). opts.plRows is an optional ephemeral parse of the linked
  //    Profit & Loss file(s), supplied by the caller (keyReportSyncService's
  //    Step 5b) — used only as a Priority-3 shallow Income-Statement grouping
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

  // 1b) Match every unique account against the uploaded Chart of Accounts
  //     FIRST — before any AI call. When a company has uploaded its own COA,
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

  // 1c) Priority 2 — this exact account's own real position in the uploaded
  //     Balance Sheet / Profit & Loss (parent_path). Only accounts NEITHER
  //     the uploaded COA (1b) NOR the uploaded statements (here) can resolve
  //     are sent to AI (Priority 3) below.
  const glBucketByKey = splitAccountsAtRetainedEarnings(glRows);
  const { bsHierarchyByName, plHierarchyByName } = buildDocHierarchyLookups(bsRows, plRows);
  const docHierarchyStats = createDocHierarchyStats();
  const needsAi = unmatchedByCoa.filter(
    (a) => !pickDocHierarchy(a.accountName, a.key, glBucketByKey, bsHierarchyByName, plHierarchyByName, docHierarchyStats),
  );
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
      console.warn(`[ChartOfAccounts] AI pre-pass failed — accounts will be flagged for review: ${err.message}`);
    }
  }

  const { leaves } = buildCoaModel(glRows, bsRows, plRows, aiResults, matchResults, glBucketByKey);
  if (!leaves.length) {
    // Nothing to build — clear derived rows so stale accounts don't linger.
    await supabase.from(TABLE_COA).delete().eq("version_id", versionId);
    return { accountCount: 0, leafCount: 0 };
  }

  // 2) Load existing rows EARLY — before hierarchy resolution — so a leaf that
  // already has good hierarchy from a prior run can be reused (Priority:
  // Existing Working COA, above AI) instead of unconditionally re-spending a
  // Gemini category-selector call on it every single regenerate.
  const { data: existingData, error: exErr } = await supabase
    .from(TABLE_COA)
    .select("id, system_id, normal_balance, account_number, account_name, parent_account_id, original_name, original_hierarchy, adjusted_name, adjusted_hierarchy, metadata, classification_method, match_source, hierarchy_confidence, account_type, statement_type, sort_order, client_account_id, level_1, level_2, level_3, level_4, level_5, level_6, level_7, level_8, level_9, level_10, level_11, level_12, level_13, level_14, level_15, base_account")
    .eq("version_id", versionId);
  if (exErr) throw exErr;
  // Category (is_group) rows form the parent_account_id tree; leaves are the real
  // accounts. Keep them separate so the leaf upsert/stale-delete never touches them.
  let existingLeavesData = (existingData || []).filter((r) => !r.metadata?.is_group);
  const existingCatsData = (existingData || []).filter((r) => r.metadata?.is_group);

  // Older schemas allowed identical leaves when account_number was NULL. Keep
  // one deterministic row, repoint GL links, and remove the redundant copies.
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

  const hierarchical = await buildLeafHierarchies(leaves, existingByKey);
  const unmappedCount = hierarchical.filter((l) => l.needsMapping).length;
  const aiHierarchyCount = hierarchical.filter((l) => l.matchTier === "ai_hierarchy").length;
  const bsSectionCount = hierarchical.filter((l) => l.matchTier === "bs_section").length;
  const plSectionCount = hierarchical.filter((l) => l.matchTier === "pl_section").length;
  const existingWorkingCoaCount = hierarchical.filter((l) => l.matchTier === "existing_working_coa").length;
  const ruleCount = hierarchical.filter((l) => l.matchTier === "rule").length;
  const clientCoaMatchedCount = hierarchical.filter((l) => l.classificationMethod === "client_workbook").length;
  const sourceCounts = {
    clientCoaMatched: clientCoaMatchedCount,
    aiHierarchy: aiHierarchyCount,
    bsSection: bsSectionCount,
    plSection: plSectionCount,
    existingWorkingCoa: existingWorkingCoaCount,
    rule: ruleCount,
    needsMapping: unmappedCount,
  };
  if (unmappedCount) {
    console.log(`[ChartOfAccounts] ${unmappedCount} account(s) did not match an existing Chart of Accounts hierarchy. Marked needs_mapping=true. Excluded from reports until manually mapped.`);
  }
  const validationIssues = validateHierarchyConsistency(hierarchical);
  const driftIssues = detectSiblingDrift(hierarchical);
  if (driftIssues.length) {
    console.warn(`[ChartOfAccounts] ${driftIssues.length} sibling-drift anomaly(ies) detected — accounts with identical section evidence resolved to different top-level hierarchy:`, driftIssues);
  }

  // ── COA Hierarchy Generation summary log ─────────────────────────────────
  {
    const bsAccountNames = new Set((bsRows || []).filter((r) => r.account_name && !r.is_total && r.hierarchy_level !== 0).map((r) => normName(r.account_name)));
    const plAccountNames = new Set((plRows || []).filter((r) => r.account_name && !r.is_total && !r.is_header && r.node_type !== "subtotal").map((r) => normName(r.account_name)));
    const glAccountNames = new Set((glRows || []).map((r) => r.account_name || r.account_section).filter(Boolean).map(normName));
    const pathCounts = new Map();
    let maxDepth = 0;
    let totalDepth = 0;
    let depthCount = 0;
    // Explicit, continuously-checked invariant (never just assumed): a
    // "gap" is a real level preceded by a NULL/empty one in the same array —
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
    const hierarchyNodeCount = buildDesiredCategories(hierarchical).size;
    const aiMappedCount = hierarchical.filter((l) => l.classificationMethod === "gemini" || l.matchTier === "ai_hierarchy").length;
    const fullyResolvedCount = hierarchical.filter((l) => !l.needsMapping && !l.needsReview).length;
    const brokenPathCount = hierarchical.filter((l) => !l.needsMapping && !(l.levels || []).some(Boolean)).length;
    // Missing-parent integrity is checked against the persisted table post-insert
    // (validateChartOfAccounts's badParent check) — nothing to report pre-insert.
    const missingParentsCount = 0;
    const hierarchyValid = duplicatePathCount === 0 && missingParentsCount === 0 && gapAccountCount === 0 && maxDepth <= MAX_LEVELS;

    // Uploaded COA: ONLY hasLinkedCoaDocument (this version's own linked
    // documents) — never mapper.entryCount / client_chart_of_accounts, which
    // would leak a stale prior-version upload or (if ever unscoped) another
    // company's data into this version's log. "Other company COA used" /
    // "Historical COA used" are unconditionally NO: the mapper is either
    // NULL_COA_MAPPER (no query issued at all) or createCoaMapper(companyId)
    // (already strictly scoped to this one company, never cross-version data
    // beyond this company's own single current upload).
    const sourcesUsed = [
      bsAccountNames.size ? "✓ Balance Sheet" : "✗ Balance Sheet (not uploaded)",
      plAccountNames.size ? "✓ Profit & Loss" : "✗ Profit & Loss (not uploaded)",
      glAccountNames.size ? "✓ General Ledger" : "✗ General Ledger (not uploaded)",
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
      // level from its real depth — there is no fixed-depth schema to shrink
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
  }

  // A prior run's client_account_id can go stale if client_chart_of_accounts was
  // ever wiped and re-imported (a fresh import assigns new row ids) — blindly
  // preserving it below would violate the FK. Load the current valid id set once
  // so a dangling reference gets dropped instead of crashing the whole regenerate.
  const { data: validClientAccountRows } = await supabase.from("client_chart_of_accounts").select("id").eq("company_id", companyId);
  const validClientAccountIds = new Set((validClientAccountRows || []).map((r) => r.id));

  // 2a) Materialize the category-node tree (parent_account_id) + assign system ids.
  const desiredCats = buildDesiredCategories(hierarchical);
  const catIdByPath = await syncCategoryNodes(versionId, companyId, existingCatsData, desiredCats);
  const systemIdByKey = assignSystemIds(hierarchical, existingByKey);

  const seenKeys = new Set();
  const toInsert = [];
  const updates = []; // { id, patch }
  let sortCounter = 0;

  // Iterate in `hierarchical`'s own natural order — NOT alphabetical.
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
    const accountIdName = leaf.accountNumber ? `${leaf.accountNumber} — ${leaf.accountName}` : leaf.accountName;
    // Prefer the matched account's normal balance; for an unmapped account with
    // a known type (e.g. bsSection-derived) fall back to the deterministic
    // type→balance fact — never guessed when the type itself is unknown.
    const normalBal = leaf.mappedNormalBalance || (leaf.accountType ? normalBalanceFor(leaf.accountType) : null);
    const baseMeta  = {
      is_group: false,
      sources: Array.from(leaf.sources),
      fiscal_years: Array.from(leaf.fiscalYears).sort((a, b) => a - b),
      classification_source: leaf.classificationSource || null,
      ai_confidence: leaf.confidence ?? null,
      needs_review: leaf.needsReview || false,
      // Did not match an existing Chart of Accounts hierarchy (not even
      // fuzzy) — excluded from report rollups until a human assigns
      // hierarchy. That save (updateAccountHierarchy) writes straight to
      // this same table, so it's immediately reusable — no separate
      // reference table to feed back into.
      needs_mapping: leaf.needsMapping || false,
      match_tier: leaf.matchTier || null,
      // Human-readable diagnostic of WHY this account resolved the way it
      // did — for a client-COA match, which of the 5 matching stages fired
      // (coaAccountMatcher.js); for an AI-classified account, its own
      // 1-2 sentence CPA-style justification. Never used programmatically.
      match_reason: leaf.matchReason || leaf.aiReasoning || null,
      hierarchy_source: leaf.classificationMethod === "client_workbook" ? "uploaded_coa" : "ai_generated",
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
    // a user-modified account, or "existing_working_coa" when no fresh match
    // exists this run and prior hierarchy is simply being preserved.
    const freshMatchSource = leaf.needsMapping ? "manual_review" : matchSourceFromTier(leaf.matchTier);
    const freshHierarchyConfidence = hierarchyConfidenceFromTier(leaf.matchTier, leaf.matchConfidence);
    // Only set parent_account_id if the parent category actually exists in catIdByPath.
    // If a parent is referenced that doesn't exist, set it to null to avoid FK violation.
    const leafCatKey = leafCategoryKey(leaf.levels);
    const parentAccountId = (leafCatKey && catIdByPath.has(leafCatKey)) ? catIdByPath.get(leafCatKey) : null;

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
        // hierarchy was copied from — null for a needs_mapping/standard-rule account.
        client_account_id: leaf.clientAccountId || null,
        cf_category: classifyCfCategory({
          accountType: leaf.accountType,
          name: leaf.baseAccount || leaf.accountName,
          level2: aiLevels[1],
          level3: aiLevels[2],
        }),
        ...levelsToColumns(aiLevels, leaf.baseAccount || leaf.accountName),
        base_account: leaf.baseAccount || leaf.accountName,
        hierarchy_path: leaf.hierarchyPath,
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
    // had — chart_of_accounts is the single source of truth, and a match now
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
        // Parent no longer exists; clear it to avoid FK violation
        patch.parent_account_id = null;
      }
      // A human already classified this account — it's never needs_mapping,
      // regardless of what this run's automated match happened to find.
      patch.metadata.needs_mapping = false;
      patch.match_source = "manual_review";
      patch.hierarchy_confidence = 1.0;
      // cf_category isn't user-editable — always (re)derive it from whatever
      // levels/type the account currently has, even when hierarchy is preserved.
      patch.cf_category = classifyCfCategory({
        accountType: resolvedType,
        name: existing.base_account || existing.account_name,
        level2: existing.level_2,
        level3: existing.level_3,
      });
    } else if (hasFreshMatch) {
      // Refresh hierarchy from this run's match — corrects stale/wrong data
      // (e.g. a previous run's bad accountType) instead of preserving it.
      Object.assign(patch, levelsToColumns(leaf.levels, leaf.baseAccount || leaf.accountName), {
        parent_account_id: parentAccountId,
        base_account: leaf.baseAccount,
        hierarchy_path: leaf.hierarchyPath,
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
      // No fresh match this run — preserve whatever existing hierarchy there
      // is rather than wiping it out (only set fields when the existing
      // account didn't already have them).
      const hasExistingLevels = columnsToLevels(existing).some(Boolean);
      if (hasExistingLevels) {
        // Preserve existing levels and hierarchy
        const existingLevels = columnsToLevels(existing);
        // Validate that the existing parent_account_id still exists
        const validParentId = (existing.parent_account_id && Array.from(catIdByPath.values()).includes(existing.parent_account_id))
          ? existing.parent_account_id
          : null;
        Object.assign(patch, levelsToColumns(existingLevels, existing.base_account || leaf.baseAccount || leaf.accountName), {
          parent_account_id: validParentId,
          base_account: existing.base_account || leaf.baseAccount,
          hierarchy_path: existing.hierarchy_path || leaf.hierarchyPath,
          classification_method: existing.classification_method || leaf.classificationMethod,
          match_source: existing.match_source || "existing_working_coa",
          hierarchy_confidence: existing.hierarchy_confidence ?? 0.8,
          client_account_id: (existing.client_account_id && validClientAccountIds.has(existing.client_account_id))
            ? existing.client_account_id
            : (leaf.clientAccountId || null),
          adjusted_name: existing.adjusted_name || leaf.displayName,
          adjusted_hierarchy: existing.adjusted_hierarchy || aiSnapshot,
          cf_category: classifyCfCategory({
            accountType: resolvedType,
            name: existing.base_account || leaf.baseAccount,
            level2: existingLevels[1],
            level3: existingLevels[2],
          }),
        });
      } else {
        // Backfill with the latest AI result
        Object.assign(patch, levelsToColumns(aiLevels, leaf.baseAccount || leaf.accountName), {
          parent_account_id: parentAccountId,
          base_account: leaf.baseAccount,
          hierarchy_path: leaf.hierarchyPath,
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
    }
    updates.push({ id: existing.id, patch });
  }

  // A client_account_id can go stale mid-run if client_chart_of_accounts is
  // replaced (delete+reinsert assigns new row ids) between when validClientAccountIds
  // was snapshotted and when these writes actually execute — a real race we hit
  // live during testing. Rather than aborting the entire regenerate over one
  // dangling traceability link, drop just that link and retry once.
  const isClientAccountFkError = (error) =>
    error?.code === "23503" && String(error.details || "").includes("client_account_id");

  // 3) Apply updates.
  for (const { id, patch } of updates) {
    let { error } = await supabase.from(TABLE_COA).update(patch).eq("id", id);
    if (error && isClientAccountFkError(error)) {
      console.warn(`[ChartOfAccounts] Stale client_account_id on update (id=${id}) — retrying without it.`);
      ({ error } = await supabase.from(TABLE_COA).update({ ...patch, client_account_id: null }).eq("id", id));
    }
    if (error) throw error;
  }

  // 4) Insert new rows (batched) and capture their ids.
  const insertedByKey = new Map();
  if (toInsert.length) {
    let ins = await supabase.from(TABLE_COA).insert(toInsert).select("id, account_number, account_name");
    if (ins.error && isClientAccountFkError(ins.error)) {
      console.warn(`[ChartOfAccounts] Stale client_account_id in insert batch — retrying without it.`);
      ins = await supabase
        .from(TABLE_COA)
        .insert(toInsert.map((row) => ({ ...row, client_account_id: null })))
        .select("id, account_number, account_name");
    }
    if (ins.error) throw ins.error;
    for (const row of ins.data || []) {
      insertedByKey.set(accountKey(row.account_number, row.account_name), row.id);
    }
  }

  // 5) Delete leaf rows whose source account disappeared (CASCADE clears their
  //    audit). Category nodes are reconciled separately in syncCategoryNodes.
  const staleIds = existingLeavesData
    .filter((row) => !seenKeys.has(accountKey(row.account_number, row.account_name)))
    .map((row) => row.id);
  if (staleIds.length) {
    const del = await supabase.from(TABLE_COA).delete().in("id", staleIds);
    if (del.error) throw del.error;
  }

  // The source→account name map and per-account classification history are no
  // longer stored in side tables. The COA leaves ARE the name map (rebuilt in
  // memory by the report layer), and the initial "generate" classification
  // snapshot is seeded into each new row's audit_log above. Account ids are
  // resolved here only for the return summary.

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
}

// ── Read model (deep tree + flat) ────────────────────────────────────────────

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

// Stable ordering for the standardized top levels; everything else alpha.
const LEVEL_ORDER = new Map([
  ["Total Liabilities and Equity", 1], ["Total Assets", 2],
  ["Assets", 1], ["Liabilities", 2], ["Equity", 3],
  ["Revenue", 4], ["Cost of Goods Sold", 5], ["Operating Expenses", 6],
]);

function buildTree(flatRows) {
  const root = { children: [], childIndex: new Map() };

  for (const acct of flatRows) {
    const path = acct.levels.filter(Boolean); // last element = base account (leaf)
    if (!path.length) {
      root.children.push({ ...leafNode(acct) });
      continue;
    }
    let node = root;
    // Walk category levels (all but the last path element).
    for (let i = 0; i < path.length - 1; i += 1) {
      const label = path[i];
      let child = node.childIndex.get(label);
      if (!child) {
        child = {
          id: `cat:${(node.id || "root")}/${label}`,
          name: label,
          isGroup: true,
          level: i + 1,
          statementType: acct.statementType,
          children: [],
          childIndex: new Map(),
        };
        node.childIndex.set(label, child);
        node.children.push(child);
      }
      node = child;
    }
    node.children.push(leafNode(acct, path.length));
  }

  // Sort recursively and strip the helper index.
  const finalize = (n) => {
    if (n.children) {
      n.children.sort((a, b) => {
        if (a.isGroup !== b.isGroup) return a.isGroup ? -1 : 1; // categories first
        const ao = LEVEL_ORDER.get(a.name) || 999;
        const bo = LEVEL_ORDER.get(b.name) || 999;
        if (ao !== bo) return ao - bo;
        return String(a.name).localeCompare(String(b.name));
      });
      n.children.forEach(finalize);
    }
    delete n.childIndex;
    return n;
  };
  root.children.forEach(finalize);
  return root.children;
}

function leafNode(acct, level) {
  return {
    id: acct.id,
    accountId: acct.id,
    name: acct.accountName,
    isGroup: false,
    level: level || (acct.levels.filter(Boolean).length || 1),
    accountNumber: acct.accountNumber,
    accountType: acct.accountType,
    statementType: acct.statementType,
    hierarchyPath: acct.hierarchyPath,
    classificationMethod: acct.classificationMethod,
    isActive: acct.isActive,
    modified: acct.modified,
    levels: acct.levels,
    originalName: acct.originalName,
    adjustedName: acct.adjustedName,
    children: [],
  };
}

async function getChartOfAccounts(versionId) {
  const { data, error } = await supabase
    .from(TABLE_COA).select("*").eq("version_id", versionId)
    .order("sort_order", { ascending: true });
  if (error) throw error;

  // Category (is_group) rows exist only to carry the parent_account_id tree;
  // the UI grid + tree are built from the real leaf accounts.
  const rows = (data || []).filter((r) => !r.metadata?.is_group).map(mapRow);
  const tree = buildTree(rows);
  return { versionId, flat: rows, tree, accountCount: rows.length };
}

// ── Editing (rename / move / reclassify / save / reset) ──────────────────────

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
async function updateAccountHierarchy(accountId, patch = {}, userId = null) {
  const row = await loadAccount(accountId);
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
    const hierarchyPath = nonNull.join(" > ");
    audits.push(adjustmentAudit(patch.movedParent ? "parent" : "level", columnsToLevels(row), levels, userId));
    Object.assign(update, levelsToColumns(levels, baseAccount || row.account_name), {
      base_account: baseAccount,
      hierarchy_path: hierarchyPath,
      adjusted_hierarchy: hierarchySnapshot(levels, update.account_type || row.account_type, update.statement_type || row.statement_type, baseAccount),
    });
    // A human just assigned real hierarchy — it's no longer unmapped, whether
    // or not it was needs_mapping before (see buildLeafHierarchies). This row
    // is chart_of_accounts itself, so it's immediately match-eligible for
    // every future import — no separate reference-table write needed.
    meta.needs_mapping = false;
    changed = true;
  }

  if (patch.isActive !== undefined && patch.isActive !== row.is_active) {
    audits.push(adjustmentAudit("active", row.is_active, patch.isActive, userId));
    update.is_active = patch.isActive;
    changed = true;
  }

  if (!changed) return mapRow(row);

  const newLevels = columnsToLevels({ ...row, ...update });
  const finalAccountType = update.account_type || row.account_type;
  const finalStatementType = update.statement_type || row.statement_type;
  const snapshot = hierarchySnapshot(newLevels, finalAccountType, finalStatementType, update.base_account || row.base_account);
  audits.push(classificationAudit("manual", snapshot, "adjust", userId));
  update.audit_log = appendAudit(row.audit_log, ...audits);

  const { data, error } = await supabase.from(TABLE_COA).update(update).eq("id", accountId).select("*").single();
  if (error) throw error;

  // No separate feedback-loop write needed: this row IS chart_of_accounts,
  // the only hierarchy table. The moment this update commits, coaMappingService
  // .createCoaMapper() will find it on the very next classification run — for
  // this company's future imports and for every other company's, since
  // matching is global (see coaMappingService.loadCandidateAccounts).
  return mapRow(data);
}

/** Bulk-persist an edited hierarchy (array of per-account patches). */
async function saveHierarchy(versionId, nodes = [], userId = null) {
  let updated = 0;
  for (const node of nodes) {
    if (!node?.accountId && !node?.id) continue;
    await updateAccountHierarchy(node.accountId || node.id, {
      adjustedName: node.adjustedName,
      levels: node.levels,
      accountType: node.accountType,
      statementType: node.statementType,
      isActive: node.isActive,
      movedParent: node.movedParent,
    }, userId);
    updated += 1;
  }
  return { updated };
}

/** Restore a single account's adjusted classification back to its original AI one. */
async function resetAccount(accountId, userId = null) {
  const row = await loadAccount(accountId);
  const original = row.original_hierarchy || hierarchySnapshot(columnsToLevels(row), row.account_type, row.statement_type, row.base_account);
  const levels = Array.isArray(original.levels) ? original.levels.slice(0, MAX_LEVELS) : columnsToLevels(row);
  while (levels.length < MAX_LEVELS) levels.push(null);
  const nonNull = levels.filter(Boolean);
  const baseAccount = original.base_account || (nonNull.length ? nonNull[nonNull.length - 1] : row.base_account);

  const update = {
    updated_at: new Date().toISOString(),
    adjusted_name: row.original_name || row.account_name,
    adjusted_hierarchy: original,
    account_type: original.account_type || row.account_type,
    statement_type: original.statement_type || row.statement_type,
    base_account: baseAccount,
    hierarchy_path: nonNull.join(" > "),
    classification_method: "rule",
    metadata: { ...(row.metadata || {}), user_modified: false },
    ...levelsToColumns(levels, baseAccount || row.account_name),
  };
  update.audit_log = appendAudit(
    row.audit_log,
    adjustmentAudit("reset", columnsToLevels(row), levels, userId),
    classificationAudit("rule", original, "reset", userId),
  );
  const { data, error } = await supabase.from(TABLE_COA).update(update).eq("id", accountId).select("*").single();
  if (error) throw error;
  return mapRow(data);
}

/** Restore every modified account in a version to its original AI classification. */
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

// Legacy single-field update — retained for backward compatibility.
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
  for (const [apiKey, column] of Object.entries(EDITABLE_FIELDS)) {
    if (patch[apiKey] !== undefined) update[column] = patch[apiKey];
  }
  const { data, error } = await supabase.from(TABLE_COA).update(update).eq("id", accountId).select("*").single();
  if (error) throw error;
  return mapRow(data);
}

// ── Validation engine (extended with level-integrity checks) ─────────────────
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
  // Accounts with no match in coa_mapping (coaMappingService) — no hierarchy was
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
    arr.slice(0, n).join(", ") + (arr.length > n ? ` … (+${arr.length - n} more)` : "");

  const rows = [];
  let worst = "success";

  const errorChecks = [
    [nullType,      (a) => `${a.length} account(s) missing a category: ${sample(a)}`],
    [invalidRows,   (a) => `${a.length} metadata row(s) found in the Chart of Accounts (should not appear): ${sample(a)}`],
    [multiCategory, (a) => `${a.length} account(s) classified into more than one category: ${sample(a)}`],
    // Genuinely anomalous only now — needs_mapping accounts (expected, no
    // hierarchy on purpose) are excluded from noLevel/noPath above. If this
    // still fires, an account has missing hierarchy WITHOUT being flagged for
    // review, meaning something bypassed coaMappingService entirely.
    [noLevel,       (a) => `${a.length} account(s) missing a hierarchy (no Level 1) despite not being flagged needs_mapping — investigate, this should not happen: ${sample(a)}`],
    [badParent,     (a) => `${a.length} account(s) have a parent_account_id that does not resolve to a row in this version: ${sample(a)}`],
  ];
  for (const [arr, msg] of errorChecks) {
    if (arr.length) {
      worst = "error";
      rows.push({ dataType: "chart_of_accounts", year: null, status: "error", severity: "error", message: msg(arr), metadata: { sample: arr.slice(0, 25), count: arr.length } });
    }
  }

  const warnChecks = [
    // Expected, actionable state — no match in the existing Chart of Accounts,
    // not a data-integrity problem. Worded to read as a review queue, not a defect.
    [needsMappingList, (a) => `${a.length} account(s) pending manual review — no match found in the existing Chart of Accounts. Map them in Review & Adjust; future imports with the same account name will reuse the mapping automatically: ${sample(a)}`],
    [needsReviewList, (a) => `${a.length} account(s) flagged for manual review (low AI confidence): ${sample(a)}`],
    [duplicates,      (a) => `${a.length} duplicate account name(s): ${sample(a)}`],
    [noBase,          (a) => `${a.length} account(s) missing a base account: ${sample(a)}`],
    [noSystemId,      (a) => `${a.length} account(s) missing a System ID: ${sample(a)}`],
    [noPath,          (a) => `${a.length} account(s) missing a hierarchy path despite not being flagged needs_mapping — investigate: ${sample(a)}`],
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
 * Prints the "COA Validation" summary block after every sync — real counts
 * from the persisted chart_of_accounts + actual GL linkage state, never
 * placeholders. Read-only, never blocks the sync.
 */
async function printCoaValidationBlock(companyId, versionId) {
  const { data: allRows } = await supabase
    .from(TABLE_COA)
    .select(["id, account_name, account_number, parent_account_id, hierarchy_path, statement_type, cf_category, metadata", ...Array.from({ length: MAX_LEVELS }, (_, i) => `level_${i + 1}`)].join(", "))
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
  // is a dead branch — created, then never actually used as a parent.
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

  // ── COA Hierarchy Validation — every LEAF row must have all 15 levels
  // populated, per padLevelsWithLeafPropagation's business rule (trailing
  // levels past the uploaded documents' real depth repeat the leaf's own
  // name rather than staying NULL). Category/group nodes are excluded —
  // they are not "an account" and correctly have only their own real depth.
  {
    const isBlank = (v) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");
    let rowsWithNullLevels = 0;
    let rowsWithEmptyLevels = 0;
    let rowsWithFewerThan15 = 0;
    let rowsNormalizedByPropagation = 0;
    let hierarchyLeafMaxDepth = 0;
    for (const r of leaves) {
      const vals = levelCols.map((c) => r[c]);
      if (vals.some((v) => v === null || v === undefined)) rowsWithNullLevels += 1;
      if (vals.some((v) => typeof v === "string" && v.trim() === "")) rowsWithEmptyLevels += 1;
      const populated = vals.filter((v) => !isBlank(v));
      if (populated.length > hierarchyLeafMaxDepth) hierarchyLeafMaxDepth = populated.length;
      if (populated.length < MAX_LEVELS) rowsWithFewerThan15 += 1;
      const leafName = r.base_account || r.account_name;
      if (leafName && vals.filter((v) => v === leafName).length > 1) rowsNormalizedByPropagation += 1;
    }
    const hierarchyGapsValid = rowsWithNullLevels === 0 && rowsWithEmptyLevels === 0 && rowsWithFewerThan15 === 0;
    console.log(
      "COA Hierarchy Validation\n\n" +
      `Total Accounts: ${leaves.length}\n\n` +
      `Rows with NULL Levels: ${rowsWithNullLevels}\n\n` +
      `Rows with Empty Levels: ${rowsWithEmptyLevels}\n\n` +
      `Rows with <15 populated levels: ${rowsWithFewerThan15}\n\n` +
      `Rows normalized by leaf propagation: ${rowsNormalizedByPropagation}\n\n` +
      `Maximum Depth: ${hierarchyLeafMaxDepth}\n\n` +
      `Hierarchy Valid: ${hierarchyGapsValid ? "YES" : "NO"}`,
    );
    if (!hierarchyGapsValid) {
      // Every insert path routes through levelsToColumns' leaf-propagation
      // padding, so this should never actually fire — surfaced loudly
      // (error, not warn) rather than silently, if it ever does. NOTE: this
      // function's own caller (keyReportSyncService) wraps it in a
      // never-fatal try/catch by design (a COA validation problem must not
      // halt Trial Balance/BS/P&L from generating), so this does not halt
      // the sync — see this function's own doc comment ("Read-only, never
      // blocks the sync"). Making a hierarchy-gap violation truly reject the
      // generation would require changing that caller's error handling,
      // which is a broader decision than this validation block.
      console.error(
        `[ChartOfAccounts] HIERARCHY INVARIANT VIOLATED: ${rowsWithNullLevels} row(s) with NULL levels, ` +
        `${rowsWithFewerThan15} row(s) with fewer than 15 populated levels. This should be impossible — ` +
        "every persistence path pads trailing levels via levelsToColumns/padLevelsWithLeafPropagation.",
      );
    }
  }

  return {
    leafAccounts: leaves.length, hierarchyNodes: groups.length, maxDepth, duplicateAccounts, duplicatePaths,
    missingParents, circularRefs, orphanNodes, unmappedGlAccounts: unmappedGl || 0, totalGlAccounts: totalGl || 0,
    accountsLinkedToGl, accountsLinkedToBs, accountsLinkedToPl, accountsLinkedToCf, hierarchyValid,
  };
}

async function ensureAccountExistsInCoa(versionId, companyId, accountName, accountNumber = null, explicitType = null) {
  throw new Error("Dynamic Chart of Accounts insertion is disabled. Run generateChartOfAccounts/ensureCoaComplete during sync before generating reports.");
}

// ─── Phase 2c: Bulk-complete COA from GL distinct accounts ───────────────────
//
// After generateChartOfAccounts + linkGlToCoa, any GL row still missing a
// coa_id means its account_name was not in the set sent to generateChartOfAccounts.
// This function finds those accounts, classifies them via the same AI pipeline
// (classifyAccountsWithAI), and bulk-inserts them before Phase 3 (Trial Balance).
// Accounts that receive no AI result or low-confidence results are flagged
// needsReview: true — no keyword-rule fallback is applied.
//
// Returns { added, skipped }.
//
// @param {string} companyId
// @param {string} versionId
// @param {Array} [plRows] - the SAME ephemeral parsed Profit & Loss rows
//   keyReportSyncService's Step 5b already passed to generateChartOfAccounts
//   (never re-parsed here, never persisted) — needed so a GL-only account
//   discovered at this later phase still gets Priority-2 document-hierarchy
//   resolution before falling back to AI.
async function ensureCoaComplete(companyId, versionId, plRows = [], hasLinkedCoaDocument = undefined) {
  if (!companyId || !versionId) return { added: 0, skipped: 0 };

  // 1. Collect distinct GL account_names that have no coa_id yet.
  const unlinkedNames = new Map(); // normKey → rawName
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

  console.log(`[COA][ensureComplete] ${missingRaw.length} GL accounts not in COA — matching against the uploaded Chart of Accounts first`);

  // 3. Match against the uploaded COA FIRST — before any AI call. Only what's
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

  // 3b. Priority 2 — this exact account's own real position in the uploaded
  //     Balance Sheet / Profit & Loss, same as generateChartOfAccounts. Only
  //     what neither the upload nor the uploaded statements resolve reaches AI.
  const [glRowsInOrder, bsRows] = await Promise.all([
    collectGlAccountsFromEntries(companyId, versionId).catch(() => []),
    collectBsAccountsFromEntries(companyId, versionId).catch(() => []),
  ]);
  const glBucketByKey = splitAccountsAtRetainedEarnings(glRowsInOrder);
  const { bsHierarchyByName, plHierarchyByName } = buildDocHierarchyLookups(bsRows, plRows);
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
      console.warn(`[COA][ensureComplete] AI classification failed — accounts flagged for review: ${err.message}`);
    }
  }

  // 4. Build leaf descriptors: a confident COA match is copied directly
  //    (needsReview:false, no AI ever consulted); everything else falls back
  //    to the AI's own accountType + full hierarchy (or needsMapping if the
  //    AI has nothing either — no document section evidence exists for a
  //    GL-only discovered account, so there is no cheaper fallback here).
  const classifiedLeaves = missingRaw
    .filter((rawName) => !aiResults.get(normName(rawName))?.isReportRow) // exclude AI-detected report rows
    .map((rawName) => {
      const key   = normName(rawName);
      const match = matchResults.get(key);

      if (match?.matched) {
        const path = [...match.levels.filter(Boolean), rawName];
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
        const path = [...docHierarchy.levels]; // already [...parentPath, ownName] — real document structure
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
        };
      }

      const aiResult = aiResults.get(key);
      // No fallback default: an account with no AI result has an unknown
      // type — never guessed. It stays needsMapping/needsReview until a
      // human classifies it (see chartOfAccountsService.updateAccountHierarchy).
      const type        = aiResult?.accountType || null;
      const confidence  = aiResult?.confidence ?? null;
      const needsReview = !aiResult || (confidence !== null && confidence < AI_NEEDS_REVIEW_THRESHOLD);
      const displayName = aiResult?.normalizedName || rawName;
      const classificationMethod = !aiResult ? "unclassified" : needsReview ? "ai_low_confidence" : "gemini";
      // statementTypeFor/normalBalanceFor are deterministic accounting facts of a
      // KNOWN type — never invoked to invent a type; null when type is null.
      const stmtType  = type ? statementTypeFor(type) : null;
      const normalBal = type ? normalBalanceFor(type) : null;
      const aiLevels  = aiResult?.levels || [];

      if (aiLevels.length) {
        const path = [...aiLevels, rawName];
        const finalLevels = new Array(MAX_LEVELS).fill(null);
        path.forEach((label, li) => { if (li < MAX_LEVELS) finalLevels[li] = label; });
        return {
          rawName, displayName, type, stmtType, sortOrder: null, clientAccountId: null, normalBal,
          confidence, needsReview, classificationMethod: "ai_hierarchy",
          hierarchyReasoning: aiResult?.reasoning || null,
          finalLevels, hierarchyPath: path.join(" > "), needsMapping: false, matchTier: "ai_hierarchy",
          matchConfidence: confidence,
        };
      }
      // No AI hierarchy — no document section evidence exists for a GL-only
      // discovered account, so there is no cheaper fallback: needs_mapping.
      return {
        rawName, displayName, type, stmtType, sortOrder: null, clientAccountId: null, normalBal,
        confidence, needsReview, classificationMethod,
        finalLevels: new Array(MAX_LEVELS).fill(null), hierarchyPath: "", needsMapping: true, matchTier: null,
      };
    });

  if (classifiedLeaves.length === 0) return { added: 0, skipped: unlinkedNames.size };

  // 5. Sync category nodes for all new leaves.
  const allCats = buildDesiredCategories(
    classifiedLeaves.map((l) => ({ levels: l.finalLevels, accountType: l.type, statementType: l.stmtType })),
  );
  let catIdByPath = new Map();
  try {
    const { data: existingCats } = await supabase
      .from(TABLE_COA).select("id, parent_account_id, metadata").eq("version_id", versionId);
    const existingCatsData = (existingCats || []).filter((r) => r.metadata?.is_group);
    catIdByPath = await syncCategoryNodes(versionId, companyId, existingCatsData, allCats);
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
      ...levelsToColumns(leaf.finalLevels, leaf.rawName),
      base_account:          leaf.rawName,
      hierarchy_path:        leaf.hierarchyPath,
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
  return { added, skipped: unlinkedNames.size - missingRaw.length };
}

module.exports = {
  generateChartOfAccounts,
  getChartOfAccounts,
  updateAccount,
  updateAccountHierarchy,
  saveHierarchy,
  resetAccount,
  resetVersion,
  getHistory,
  validateChartOfAccounts,
  ensureCoaComplete,
  printCoaValidationBlock,
  // exported for unit testing
  buildCoaModel,
  buildLeafHierarchies,
  buildTree,
  isMetadataRow,
  loadKnownCategoryPaths,
  buildDocHierarchyLookups,
  pickDocHierarchy,
  splitAccountsAtRetainedEarnings,
  normalizeHierarchyLabel,
};
