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
const { aiSectionToStandardLevels, labelsToLevelArray, buildLevelsFromPath, MAX_LEVELS } = require("./keyReports/coaHierarchyRules");
const { classifyAccountsWithAI } = require("./keyReports/geminiCoaClassifier");

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

// Standardized hierarchy taxonomy (formerly the coa_hierarchy_levels seed table,
// removed in migration 055). Kept in lock-step with coaHierarchyRules.STANDARD_PREFIX
// and the deeper expense groups; served to the UI level filters.
const HIERARCHY_LEVELS = Object.freeze([
  { level_number: 1, statement_type: "profit_loss",   parent_label: null,                 label: "Income Statement", sort_order: 1, is_standard: true },
  { level_number: 1, statement_type: "balance_sheet", parent_label: null,                 label: "Balance Sheet",    sort_order: 2, is_standard: true },
  { level_number: 2, statement_type: "profit_loss",   parent_label: "Income Statement",   label: "Net Income",        sort_order: 1, is_standard: true },
  { level_number: 2, statement_type: "balance_sheet", parent_label: "Balance Sheet",      label: "Total Assets",      sort_order: 2, is_standard: true },
  { level_number: 2, statement_type: "balance_sheet", parent_label: "Balance Sheet",      label: "Total Liabilities", sort_order: 3, is_standard: true },
  { level_number: 2, statement_type: "balance_sheet", parent_label: "Balance Sheet",      label: "Total Equity",      sort_order: 4, is_standard: true },
  { level_number: 3, statement_type: "profit_loss",   parent_label: "Net Income",         label: "Pretax Income",         sort_order: 1, is_standard: true },
  { level_number: 3, statement_type: "balance_sheet", parent_label: "Total Assets",       label: "Current Assets",        sort_order: 2, is_standard: true },
  { level_number: 3, statement_type: "balance_sheet", parent_label: "Total Assets",       label: "Fixed Assets",          sort_order: 3, is_standard: true },
  { level_number: 3, statement_type: "balance_sheet", parent_label: "Total Assets",       label: "Other Assets",          sort_order: 4, is_standard: true },
  { level_number: 3, statement_type: "balance_sheet", parent_label: "Total Liabilities",  label: "Current Liabilities",   sort_order: 5, is_standard: true },
  { level_number: 3, statement_type: "balance_sheet", parent_label: "Total Liabilities",  label: "Long-Term Liabilities", sort_order: 6, is_standard: true },
  { level_number: 4, statement_type: "profit_loss",   parent_label: "Pretax Income",      label: "Operating Income", sort_order: 1, is_standard: true },
  { level_number: 5, statement_type: "profit_loss",   parent_label: "Operating Income",   label: "Gross Profit",     sort_order: 1, is_standard: true },
  { level_number: 6, statement_type: "profit_loss",   parent_label: "Gross Profit",       label: "Total Revenue",    sort_order: 1, is_standard: true },
  { level_number: 6, statement_type: "profit_loss",   parent_label: "Gross Profit",       label: "Total Expenses",   sort_order: 2, is_standard: true },
  { level_number: 7, statement_type: "profit_loss",   parent_label: "Total Revenue",      label: "Income",   sort_order: 1, is_standard: true },
  { level_number: 7, statement_type: "profit_loss",   parent_label: "Total Expenses",     label: "Expenses", sort_order: 2, is_standard: true },
  { level_number: 8, statement_type: "profit_loss",   parent_label: "Expenses", label: "Payroll and Labor",          sort_order: 1, is_standard: true },
  { level_number: 8, statement_type: "profit_loss",   parent_label: "Expenses", label: "Cost of Sales",              sort_order: 2, is_standard: true },
  { level_number: 8, statement_type: "profit_loss",   parent_label: "Expenses", label: "Occupancy",                  sort_order: 3, is_standard: true },
  { level_number: 8, statement_type: "profit_loss",   parent_label: "Expenses", label: "Insurance",                  sort_order: 4, is_standard: true },
  { level_number: 8, statement_type: "profit_loss",   parent_label: "Expenses", label: "Sales and Marketing",        sort_order: 5, is_standard: true },
  { level_number: 8, statement_type: "profit_loss",   parent_label: "Expenses", label: "General and Administrative", sort_order: 6, is_standard: true },
  { level_number: 8, statement_type: "profit_loss",   parent_label: "Expenses", label: "Vehicle and Travel",         sort_order: 7, is_standard: true },
  { level_number: 8, statement_type: "profit_loss",   parent_label: "Expenses", label: "Repairs and Maintenance",    sort_order: 8, is_standard: true },
  { level_number: 8, statement_type: "profit_loss",   parent_label: "Expenses", label: "Non-Cash and Below-Line",    sort_order: 9, is_standard: true },
]);

// Group (parent) node definitions, keyed by normalized account type. Retained
// for the legacy 2-level summary + statement-type slicing.
const GROUP_DEFS = Object.freeze({
  asset: { label: "Assets", statementType: "balance_sheet", sortOrder: 1 },
  liability: { label: "Liabilities", statementType: "balance_sheet", sortOrder: 2 },
  equity: { label: "Equity", statementType: "balance_sheet", sortOrder: 3 },
  income: { label: "Revenue", statementType: "profit_loss", sortOrder: 4 },
  cogs: { label: "Cost of Goods Sold", statementType: "profit_loss", sortOrder: 5 },
  expense: { label: "Expenses", statementType: "profit_loss", sortOrder: 6 },
});

const BALANCE_SHEET_TYPES = new Set(["asset", "liability", "equity"]);

function statementTypeFor(accountType) {
  return BALANCE_SHEET_TYPES.has(accountType) ? "balance_sheet" : "profit_loss";
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
  return fetchAllRows(() =>
    supabase.from("general_ledger_entries")
      .select("account_name, split_account, account_section, fiscal_year, account_number")
      .eq("company_id", companyId).eq("version_id", versionId)
      .order("id", { ascending: true }),
  );
}

async function collectBsAccountsFromEntries(companyId, versionId) {
  return fetchAllRows(() =>
    supabase.from("balance_sheet_entries")
      .select("account_name, account_number, section, is_total, hierarchy_level, fiscal_year")
      .eq("company_id", companyId).eq("version_id", versionId)
      .or("is_total.eq.false,is_total.is.null").order("id", { ascending: true }),
  );
}

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
 * @returns {Array<{key, accountName, accountNumber, bsSection}>}
 */
function collectUniqueAccountNames(glRows, bsRows) {
  const seen = new Map(); // normKey → descriptor
  const add = (rawName, accountNumber, bsSection) => {
    const name = String(rawName || "").trim();
    if (!name || isMetadataRow(name)) return;
    const key = normName(name);
    if (seen.has(key)) return;
    seen.set(key, {
      key,
      accountName: normalizeForGemini(name),
      accountNumber: accountNumber ? String(accountNumber).trim() : null,
      bsSection: bsSection || null,
    });
  };
  for (const r of bsRows || []) {
    if (r.account_name) add(r.account_name, r.account_number, r.section);
  }
  for (const r of glRows || []) {
    if (r.account_name) add(r.account_name, r.account_number, r.account_section);
    if (r.split_account) add(r.split_account, null, null);
  }
  return Array.from(seen.values());
}

// ── COA leaf model ────────────────────────────────────────────────────────────

/**
 * Build the in-memory COA leaf model from raw account rows.
 *
 * Classification is 100% AI-driven:
 *   • isReportRow: true  → row excluded from COA entirely (report total / header)
 *   • confidence ≥ threshold → accountType / section / deeperLevels used as-is
 *   • confidence < threshold → same AI result used, but needsReview: true set
 *   • no AI result at all   → accountType defaults to "expense", needsReview: true
 *
 * No keyword rules, no fallback classification engine.
 *
 * @param {Array}  glRows    GL transaction rows
 * @param {Array}  bsRows    Balance Sheet rows
 * @param {Array}  plRows    P&L rows (always empty — no profit_loss_entries table)
 * @param {Map}    aiResults classifyAccountsWithAI result keyed by normName(accountName)
 */
function buildCoaModel(glRows, bsRows, plRows, aiResults = new Map()) {
  const leavesByName = new Map();
  const usedGroups = new Set();

  const mergeInto = (leaf, source, fiscalYear, number, bsSection) => {
    leaf.sources.add(source);
    if (fiscalYear) leaf.fiscalYears.add(Number(fiscalYear));
    if (!leaf.accountNumber && number) leaf.accountNumber = number;
    if (bsSection && !leaf.bsSection) leaf.bsSection = bsSection;
    if (bsSection) {
      const normSec = String(bsSection).toLowerCase().trim();
      if (normSec.includes("asset")) {
        leaf.accountType = "asset";
        leaf.statementType = "balance_sheet";
        if (!leaf.aiSection || !leaf.aiSection.toLowerCase().includes("asset")) leaf.aiSection = "Current Assets";
      } else if (normSec.includes("liab")) {
        leaf.accountType = "liability";
        leaf.statementType = "balance_sheet";
        if (!leaf.aiSection || !leaf.aiSection.toLowerCase().includes("liabilit")) leaf.aiSection = "Current Liabilities";
      } else if (normSec.includes("equity") || normSec.includes("capital") || normSec.includes("owner") || normSec.includes("member")) {
        leaf.accountType = "equity";
        leaf.statementType = "balance_sheet";
        leaf.aiSection = "Equity";
      }
    }
  };

  const addLeaf = (accountName, accountNumber, source, fiscalYear, bsSection) => {
    const name = String(accountName || "").trim();
    // isMetadataRow catches only ERP noise (date lines, "Accrual Basis", etc.).
    // Report totals / section headers are excluded by AI isReportRow detection below.
    if (!name || isMetadataRow(name)) return;
    const number = accountNumber ? String(accountNumber).trim() : null;
    const key = normName(name);

    const aiResult = aiResults.get(key);

    // AI identified this as a calculated/header row — exclude from COA entirely.
    if (aiResult?.isReportRow) return;

    // AI result drives the classification.  Low or absent confidence → needsReview.
    let accountType        = aiResult?.accountType || "expense";
    let aiSection          = aiResult?.section     || "";
    if (bsSection) {
      const normSec = String(bsSection).toLowerCase().trim();
      if (normSec.includes("asset")) {
        accountType = "asset";
        if (!aiSection || !aiSection.toLowerCase().includes("asset")) aiSection = "Current Assets";
      } else if (normSec.includes("liab")) {
        accountType = "liability";
        if (!aiSection || !aiSection.toLowerCase().includes("liabilit")) aiSection = "Current Liabilities";
      } else if (normSec.includes("equity") || normSec.includes("capital") || normSec.includes("owner") || normSec.includes("member")) {
        accountType = "equity";
        aiSection = "Equity";
      }
    }
    const aiDeeperLevels     = aiResult?.deeperLevels    || [];
    const aiNormalizedName   = aiResult?.normalizedName  || null;
    const aiNormalBalance    = aiResult?.normalBalance   || null;
    const confidence         = aiResult?.confidence      ?? null;
    const needsReview        = !aiResult || (confidence !== null && confidence < AI_NEEDS_REVIEW_THRESHOLD);
    const classificationMethod =
      !aiResult            ? "unclassified"         :
      needsReview          ? "ai_low_confidence"    :
                             "gemini";
    const resolvedSource     =
      !aiResult            ? "no_ai_result"         :
      confidence !== null  ? `ai_${confidence.toFixed(2)}` :
                             "gemini";

    const bucket = leavesByName.get(key) || [];
    const target = bucket.find((l) => {
      if (number && l.accountNumber) return l.accountNumber === number;
      return true;
    });
    if (target) {
      mergeInto(target, source, fiscalYear, number, bsSection);
      return;
    }

    usedGroups.add(accountType);
    const leaf = {
      accountName: name,
      accountNumber: number,
      accountType,
      statementType: statementTypeFor(accountType),
      classificationSource: resolvedSource,
      classificationMethod,
      aiSection,
      aiNormalizedName,
      aiDeeperLevels,
      aiNormalBalance,
      confidence,
      needsReview,
      sources: new Set([source]),
      fiscalYears: new Set(fiscalYear ? [Number(fiscalYear)] : []),
      bsSection: bsSection || null,
    };
    bucket.push(leaf);
    leavesByName.set(key, bucket);
  };

  for (const r of bsRows || []) {
    addLeaf(r.account_name, r.account_number || null, "balance_sheet", r.fiscal_year, r.section);
  }
  for (const r of plRows || []) {
    addLeaf(r.account_name, r.account_number || null, "profit_loss", r.fiscal_year, null);
  }
  for (const r of glRows || []) {
    const name = r.account_name || r.account_section || "";
    if (name) addLeaf(name, r.account_number || null, "general_ledger", r.fiscal_year, null);
    if (r.split_account) addLeaf(r.split_account, null, "general_ledger", r.fiscal_year, null);
  }

  // Inject synthetic equity closing lines.  "Net Income" and "Retained Earnings"
  // are computed balances, not real GL accounts.  The AI would mark any extracted
  // "Net Income" row as isReportRow: true, so they never enter via addLeaf — we
  // inject them here with a fixed equity classification so the Balance Sheet engine
  // (bsBalancesForYear / monthly snapshots) can map its closing balances onto them.
  const ensureEquityLeaf = (name) => {
    const key = normName(name);
    if (leavesByName.has(key)) return;
    usedGroups.add("equity");
    leavesByName.set(key, [{
      accountName: name,
      accountNumber: null,
      accountType: "equity",
      statementType: "balance_sheet",
      classificationSource: "synthetic_equity",
      classificationMethod: "rule",
      aiSection: "Equity",
      aiNormalizedName: name,
      aiDeeperLevels: [],
      aiNormalBalance: "credit",
      confidence: 1,
      needsReview: false,
      sources: new Set(["generated"]),
      fiscalYears: new Set(),
      bsSection: null,
    }]);
  };
  ensureEquityLeaf("Retained Earnings");
  ensureEquityLeaf("Net Income");

  const groups = Object.entries(GROUP_DEFS)
    .filter(([type]) => usedGroups.has(type))
    .map(([type, def]) => ({ type, ...def }));

  const leaves = Array.from(leavesByName.values()).flat();
  return { groups, leaves };
}

// ── Hierarchy assembly (AI-driven) ───────────────────────────────────────────

/**
 * Enrich each leaf with its full 15-level hierarchy.
 *
 * Pipeline (pure AI — no keyword matching, no second Gemini call):
 *   1. Standard structural levels:  aiSectionToStandardLevels(leaf.aiSection, leaf.accountType)
 *      maps the AI-returned section string to the fixed L1-Ln rollup labels defined
 *      in coaHierarchyRules.SECTION_STANDARD_LEVELS.  This is a pure lookup table.
 *   2. AI deeper levels:  leaf.aiDeeperLevels from the classification pre-pass are
 *      appended after the standard levels.  Duplicate labels (AI echoing a standard
 *      level) are stripped before assembly.
 *   3. Final path assembly via buildLevelsFromPath (dedup + fit within MAX_LEVELS).
 *
 * This function is synchronous — all AI work was done in the classifyAccountsWithAI
 * pre-pass.  No network calls here.
 *
 * @param {Array} leaves — output of buildCoaModel
 * @returns {Array} leaves augmented with { levels, hierarchyPath, baseAccount, displayName }
 */
function buildLeafHierarchies(leaves) {
  return leaves.map((leaf) => {
    // 1. Standard structural levels derived from AI-returned section.
    const stdLabels  = aiSectionToStandardLevels(leaf.aiSection, leaf.accountType);
    const stdArr     = labelsToLevelArray(stdLabels);
    const stdPathSet = new Set(stdLabels.map((l) => l.toLowerCase()));

    // 2. AI deeper levels, with standard-label echoes removed.
    const filteredDeeper = (leaf.aiDeeperLevels || []).filter(
      (l) => l && !stdPathSet.has(l.toLowerCase()),
    );

    // 3. Display name (AI-normalised when available).
    const displayName = leaf.aiNormalizedName || leaf.accountName;

    // 4. Assemble.
    const { levels, hierarchyPath } = buildLevelsFromPath(
      stdArr, stdLabels.length, filteredDeeper, displayName,
    );

    return {
      ...leaf,
      levels,
      hierarchyPath,
      baseAccount: leaf.accountName || displayName,
      displayName,
    };
  });
}

// ── Persistence helpers ──────────────────────────────────────────────────────

function levelsToColumns(levels) {
  const out = {};
  for (let i = 0; i < MAX_LEVELS; i += 1) out[`level_${i + 1}`] = levels[i] || null;
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
  const EXPECTED = {
    asset:     { level1: 'Balance Sheet',    level2: 'Total Assets' },
    liability: { level1: 'Balance Sheet',    level2: 'Total Liabilities' },
    equity:    { level1: 'Balance Sheet',    level2: 'Total Equity' },
    income:    { level1: 'Income Statement', level2: 'Net Income' },
    cogs:      { level1: 'Income Statement', level2: 'Net Income' },
    expense:   { level1: 'Income Statement', level2: 'Net Income' },
  };
  const issues = [];
  for (const leaf of hierarchical) {
    const exp = EXPECTED[leaf.accountType];
    if (!exp) continue;
    const l1 = leaf.levels[0] || '';
    const l2 = leaf.levels[1] || '';
    if (l1 !== exp.level1 || l2 !== exp.level2) {
      issues.push({
        accountName: leaf.accountName,
        accountType: leaf.accountType,
        level1: l1, level2: l2,
        expected1: exp.level1, expected2: exp.level2,
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
 * Regenerate and persist the Chart of Accounts for a Key Report version.
 * Preserves account ids (and their audit history) + user adjustments via an
 * upsert-by-stable-key merge.
 *
 * @param {string} companyId
 * @param {string} versionId
 * @param {string} batchId   legacy path; pass null to read entry tables
 */
async function generateChartOfAccounts(companyId, versionId, batchId) {
  if (!companyId || !versionId) {
    return { accountCount: 0, leafCount: 0, skipped: true };
  }

  // 1) Collect source accounts. The Chart of Accounts is built from the General
  //    Ledger + Balance Sheet only (there is no profit_loss_entries table — P&L
  //    accounts surface through the GL). plRows is always empty.
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

  // 1b) AI classification pre-pass — sole classification authority.
  //     Collect every unique account name (metadata rows filtered, report totals
  //     are detected by AI not by regex), then call classifyAccountsWithAI once
  //     for the entire version in batched Gemini prompts.
  const uniqueAccounts = collectUniqueAccountNames(glRows, bsRows);

  let aiResults = new Map();
  try {
    aiResults = await classifyAccountsWithAI(uniqueAccounts, { companyId });
  } catch (err) {
    console.warn(`[ChartOfAccounts] AI pre-pass failed — accounts will be flagged for review: ${err.message}`);
  }

  const { leaves } = buildCoaModel(glRows, bsRows, [], aiResults);
  if (!leaves.length) {
    // Nothing to build — clear derived rows so stale accounts don't linger.
    await supabase.from(TABLE_COA).delete().eq("version_id", versionId);
    return { accountCount: 0, leafCount: 0 };
  }

  const hierarchical = buildLeafHierarchies(leaves);
  const validationIssues = validateHierarchyConsistency(hierarchical);

  // 2) Load existing rows so we can preserve ids, originals, and adjustments.
  const { data: existingData, error: exErr } = await supabase
    .from(TABLE_COA)
    .select("id, system_id, normal_balance, account_number, account_name, parent_account_id, original_name, original_hierarchy, adjusted_name, adjusted_hierarchy, metadata, classification_method, account_type, statement_type, level_1, level_2, level_3, level_4, level_5, level_6, level_7, level_8, level_9, level_10, level_11, level_12, level_13, level_14, level_15, base_account")
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

  // 2a) Materialize the category-node tree (parent_account_id) + assign system ids.
  const desiredCats = buildDesiredCategories(hierarchical);
  const catIdByPath = await syncCategoryNodes(versionId, companyId, existingCatsData, desiredCats);
  const systemIdByKey = assignSystemIds(hierarchical, existingByKey);

  const seenKeys = new Set();
  const toInsert = [];
  const updates = []; // { id, patch }
  let sortCounter = 0;

  for (const leaf of hierarchical
    .slice()
    .sort((a, b) => a.accountName.localeCompare(b.accountName))) {
    const key = accountKey(leaf.accountNumber, leaf.accountName);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    const aiLevels   = leaf.levels;
    const aiSnapshot = hierarchySnapshot(aiLevels, leaf.accountType, leaf.statementType, leaf.baseAccount);
    const accountIdName = leaf.accountNumber ? `${leaf.accountNumber} — ${leaf.accountName}` : leaf.accountName;
    // Prefer AI-provided normal balance; fall back to the type-based default.
    const normalBal = leaf.aiNormalBalance || normalBalanceFor(leaf.accountType);
    const baseMeta  = {
      is_group: false,
      sources: Array.from(leaf.sources),
      fiscal_years: Array.from(leaf.fiscalYears).sort((a, b) => a - b),
      classification_source: leaf.classificationSource || null,
      ai_confidence: leaf.confidence ?? null,
      needs_review: leaf.needsReview || false,
    };
    sortCounter += 1;
    const existing        = existingByKey.get(key);
    const systemId        = systemIdByKey.get(key) || null;
    const parentAccountId = catIdByPath.get(leafCategoryKey(leaf.levels)) || null;

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
        sort_order: sortCounter,
        ...levelsToColumns(aiLevels),
        base_account: leaf.baseAccount || leaf.accountName,
        hierarchy_path: leaf.hierarchyPath,
        classification_method: leaf.classificationMethod,
        original_name: leaf.displayName,
        original_hierarchy: aiSnapshot,
        adjusted_name: leaf.displayName,
        adjusted_hierarchy: aiSnapshot,
        metadata: { ...baseMeta, user_modified: false },
        audit_log: [classificationAudit(leaf.classificationMethod, aiSnapshot, "generate", null)],
      });
      continue;
    }

    // Existing account. NEVER overwrite original_*. Preserve adjustments and classifications.
    const userModified = Boolean(existing.metadata?.user_modified);
    const resolvedType = existing.account_type || leaf.accountType;
    const resolvedStmt = existing.statement_type || leaf.statementType;
    const resolvedNormal = existing.normal_balance || normalBal;

    const patch = {
      account_id_name: accountIdName,
      // system_id comes from assignSystemIds: it preserves the id when the section
      // prefix is unchanged and re-issues a correct-prefix id when the account was
      // reclassified into a different section.
      system_id: systemId || existing.system_id,
      account_type: resolvedType,
      statement_type: resolvedStmt,
      normal_balance: resolvedNormal,
      sort_order: sortCounter,
      // original stays as first-seen; only backfill if it was never set.
      original_name: existing.original_name || leaf.displayName,
      original_hierarchy: existing.original_hierarchy || aiSnapshot,
      metadata: { ...(existing.metadata || {}), ...baseMeta, user_modified: userModified },
      updated_at: new Date().toISOString(),
    };
    if (userModified) {
      // Keep the user's adjusted hierarchy + display name + level columns +
      // their existing parent_account_id. (No level/adjusted changes here.)
    } else {
      // If we are preserving existing classification, we should also preserve existing levels and parent relationships.
      // Only set them if the existing account did not have them set.
      const hasExistingLevels = columnsToLevels(existing).some(Boolean);
      if (hasExistingLevels) {
        // Preserve existing levels and hierarchy
        const existingLevels = columnsToLevels(existing);
        Object.assign(patch, levelsToColumns(existingLevels), {
          parent_account_id: existing.parent_account_id,
          base_account: existing.base_account || leaf.baseAccount,
          hierarchy_path: existing.hierarchy_path || leaf.hierarchyPath,
          classification_method: existing.classification_method || leaf.classificationMethod,
          adjusted_name: existing.adjusted_name || leaf.displayName,
          adjusted_hierarchy: existing.adjusted_hierarchy || aiSnapshot,
        });
      } else {
        // Backfill with the latest AI result
        Object.assign(patch, levelsToColumns(aiLevels), {
          parent_account_id: parentAccountId,
          base_account: leaf.baseAccount,
          hierarchy_path: leaf.hierarchyPath,
          classification_method: leaf.classificationMethod,
          adjusted_name: leaf.displayName,
          adjusted_hierarchy: aiSnapshot,
        });
      }
    }
    updates.push({ id: existing.id, patch });
  }

  // 3) Apply updates.
  for (const { id, patch } of updates) {
    const { error } = await supabase.from(TABLE_COA).update(patch).eq("id", id);
    if (error) throw error;
  }

  // 4) Insert new rows (batched) and capture their ids.
  const insertedByKey = new Map();
  if (toInsert.length) {
    const ins = await supabase.from(TABLE_COA).insert(toInsert).select("id, account_number, account_name");
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
    modified: Boolean(modified),
    isGroup: Boolean(row.metadata?.is_group),
    metadata: row.metadata || {},
  };
}

// Stable ordering for the standardized top levels; everything else alpha.
const LEVEL_ORDER = new Map([
  ["Income Statement", 1], ["Balance Sheet", 2],
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
  const update = { updated_at: new Date().toISOString(), classification_method: "manual" };
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
    Object.assign(update, levelsToColumns(levels), {
      base_account: baseAccount,
      hierarchy_path: hierarchyPath,
      adjusted_hierarchy: hierarchySnapshot(levels, update.account_type || row.account_type, update.statement_type || row.statement_type, baseAccount),
    });
    changed = true;
  }

  if (patch.isActive !== undefined && patch.isActive !== row.is_active) {
    audits.push(adjustmentAudit("active", row.is_active, patch.isActive, userId));
    update.is_active = patch.isActive;
    changed = true;
  }

  if (!changed) return mapRow(row);

  const newLevels = columnsToLevels({ ...row, ...update });
  const snapshot = hierarchySnapshot(newLevels, update.account_type || row.account_type, update.statement_type || row.statement_type, update.base_account || row.base_account);
  audits.push(classificationAudit("manual", snapshot, "adjust", userId));
  update.audit_log = appendAudit(row.audit_log, ...audits);

  const { data, error } = await supabase.from(TABLE_COA).update(update).eq("id", accountId).select("*").single();
  if (error) throw error;
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
    ...levelsToColumns(levels),
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

/** The standardized taxonomy reference (for UI level filters). Static — derived
 *  from coaHierarchyRules (the generation engine's own vocabulary), replacing the
 *  removed coa_hierarchy_levels seed table. */
async function getHierarchyLevels() {
  return HIERARCHY_LEVELS;
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
  const empty = { nullType: [], invalidRows: [], needsReviewList: [], duplicates: [], unmapped: [], multiCategory: [], noLevel: [], noBase: [], noSystemId: [], noPath: [], badParent: [] };
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
  const noLevel     = leaves.filter((r) => !r.level_1).map((r) => r.account_name);
  const noBase      = leaves.filter((r) => !r.base_account).map((r) => r.account_name);
  const noSystemId  = leaves.filter((r) => !r.system_id).map((r) => r.account_name);
  const noPath      = leaves.filter((r) => !r.hierarchy_path).map((r) => r.account_name);
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

  const reports = { nullType, invalidRows, needsReviewList, duplicates, unmapped, multiCategory, noLevel, noBase, noSystemId, noPath, badParent };

  const sample = (arr, n = 8) =>
    arr.slice(0, n).join(", ") + (arr.length > n ? ` … (+${arr.length - n} more)` : "");

  const rows = [];
  let worst = "success";

  const errorChecks = [
    [nullType,      (a) => `${a.length} account(s) missing a category: ${sample(a)}`],
    [invalidRows,   (a) => `${a.length} metadata row(s) found in the Chart of Accounts (should not appear): ${sample(a)}`],
    [multiCategory, (a) => `${a.length} account(s) classified into more than one category: ${sample(a)}`],
    [noLevel,       (a) => `${a.length} account(s) missing a hierarchy (no Level 1): ${sample(a)}`],
    [badParent,     (a) => `${a.length} account(s) have a parent_account_id that does not resolve to a row in this version: ${sample(a)}`],
  ];
  for (const [arr, msg] of errorChecks) {
    if (arr.length) {
      worst = "error";
      rows.push({ dataType: "chart_of_accounts", year: null, status: "error", severity: "error", message: msg(arr), metadata: { sample: arr.slice(0, 25), count: arr.length } });
    }
  }

  const warnChecks = [
    [needsReviewList, (a) => `${a.length} account(s) flagged for manual review (low AI confidence): ${sample(a)}`],
    [duplicates,      (a) => `${a.length} duplicate account name(s): ${sample(a)}`],
    [noBase,          (a) => `${a.length} account(s) missing a base account: ${sample(a)}`],
    [noSystemId,      (a) => `${a.length} account(s) missing a System ID: ${sample(a)}`],
    [noPath,          (a) => `${a.length} account(s) missing a hierarchy path: ${sample(a)}`],
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
async function ensureCoaComplete(companyId, versionId) {
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

  console.log(`[COA][ensureComplete] ${missingRaw.length} GL accounts not in COA — classifying via AI`);

  // 3. AI classification — same pipeline as generateChartOfAccounts.
  const accountsForAI = missingRaw.map((rawName) => ({
    key: normName(rawName),
    accountName: normalizeForGemini(rawName),
    accountNumber: null,
    bsSection: null,
  }));
  let aiResults = new Map();
  try {
    aiResults = await classifyAccountsWithAI(accountsForAI, { companyId });
  } catch (err) {
    console.warn(`[COA][ensureComplete] AI classification failed — accounts flagged for review: ${err.message}`);
  }

  // 4. Build leaf descriptors (no keyword rules — pure AI output).
  const classifiedLeaves = missingRaw
    .filter((rawName) => {
      const aiResult = aiResults.get(normName(rawName));
      return !aiResult?.isReportRow; // exclude AI-detected report rows
    })
    .map((rawName) => {
      const key      = normName(rawName);
      const aiResult = aiResults.get(key);
      const type     = aiResult?.accountType || "expense";
      const section  = aiResult?.section     || "";
      const deeper   = aiResult?.deeperLevels || [];
      const confidence  = aiResult?.confidence ?? null;
      const needsReview = !aiResult || (confidence !== null && confidence < AI_NEEDS_REVIEW_THRESHOLD);
      const displayName = aiResult?.normalizedName || rawName;
      const normalBal   = aiResult?.normalBalance || normalBalanceFor(type);
      const stmtType    = statementTypeFor(type);
      const stdLabels   = aiSectionToStandardLevels(section, type);
      const stdArr      = labelsToLevelArray(stdLabels);
      const stdPathSet  = new Set(stdLabels.map((l) => l.toLowerCase()));
      const filteredDeeper = deeper.filter((l) => l && !stdPathSet.has(l.toLowerCase()));
      const { levels: finalLevels, hierarchyPath } = buildLevelsFromPath(
        stdArr, stdLabels.length, filteredDeeper, displayName,
      );
      const classificationMethod = !aiResult ? "unclassified" : needsReview ? "ai_low_confidence" : "gemini";
      return { rawName, displayName, type, stmtType, finalLevels, hierarchyPath,
               normalBal, confidence, needsReview, classificationMethod };
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
      sort_order:            sortCounter++,
      ...levelsToColumns(leaf.finalLevels),
      base_account:          leaf.rawName,
      hierarchy_path:        leaf.hierarchyPath,
      classification_method: leaf.classificationMethod,
      original_name:         leaf.displayName,
      original_hierarchy:    snapshot,
      adjusted_name:         leaf.displayName,
      adjusted_hierarchy:    snapshot,
      metadata: {
        is_group: false, sources: ["completion"], fiscal_years: [],
        user_modified: false, ai_confidence: leaf.confidence, needs_review: leaf.needsReview,
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
  getHierarchyLevels,
  validateChartOfAccounts,
  ensureCoaComplete,
  // exported for unit testing
  buildCoaModel,
  buildLeafHierarchies,
  buildTree,
  isMetadataRow,
};
