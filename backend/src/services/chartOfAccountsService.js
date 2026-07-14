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
const { createCoaMapper } = require("./keyReports/coaMappingService");
const { selectCategoryForAccounts } = require("./keyReports/coaCategorySelector");

const MAX_LEVELS = 15;

// A match whose classificationMethod is one of these is trusted
// unconditionally, even when its accountType conflicts with a fresh AI
// classification: "manual" is a human-reviewed chart_of_accounts row (legacy
// cross-company matching); "client_workbook" is any row copied from
// client_chart_of_accounts, the imported master reference — every row there
// is equally authoritative, not an accumulated, possibly-wrong AI guess.
// Anything else (e.g. a stale "gemini"-sourced match from the old
// cross-company search) is rejected wholesale on conflict — see
// buildLeafHierarchies and ensureCoaComplete.
const TRUSTED_MATCH_METHODS = new Set(["manual", "client_workbook"]);
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
// distinguishes finer tiers within client_coa, e.g. "exact_name" vs "fuzzy").
function matchSourceFromTier(matchTier) {
  if (!matchTier) return null;
  if (matchTier === "bs_section") return "balance_sheet";
  if (matchTier === "pl_section") return "profit_loss";
  if (matchTier === "gemini_category") return "generated";
  if (matchTier === "existing_working_coa") return "existing_working_coa";
  if (matchTier === "rule") return "generated"; // deterministic GAAP fact (Net Income / Retained Earnings), not matched from any document
  return "client_coa"; // any coaMappingService tier: account_number/exact_name/normalized_name/adjusted_alias/fuzzy
}

// Top-level audit column (migration 074): how strongly the SELECTED
// HIERARCHY is supported by document evidence — distinct from AI confidence
// (which reflects account_type/normalized_name recognition, not placement).
function hierarchyConfidenceFromTier(matchTier) {
  if (!matchTier) return 0;
  if (matchTier === "account_number" || matchTier === "exact_name") return 1.0;
  if (matchTier === "normalized_name") return 0.95;
  if (matchTier === "fuzzy") return 0.85;
  if (matchTier === "bs_section" || matchTier === "pl_section") return 0.9;
  if (matchTier === "existing_working_coa") return 0.8;
  if (matchTier === "gemini_category") return 0.6;
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
 *   • confidence ≥ threshold → accountType used as-is (hierarchy comes later, from coaMappingService)
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
 *                           client_chart_of_accounts and the uploaded Balance
 *                           Sheet — never invented, never overriding a BS-side
 *                           account.
 * @param {Map}    aiResults classifyAccountsWithAI result keyed by normName(accountName)
 */
function buildCoaModel(glRows, bsRows, plRows, aiResults = new Map()) {
  const leavesByName = new Map();

  // plSection values are the 3 canonical labels profitLossExtractionService's
  // header detection recognizes: revenue | cost_of_sales | operating_expenses.
  const typeFromPlSection = (plSection) => {
    if (plSection === "revenue") return "income";
    if (plSection === "cost_of_sales") return "cogs";
    if (plSection === "operating_expenses") return "expense";
    return null;
  };

  const mergeInto = (leaf, source, fiscalYear, number, bsSection, plSection) => {
    leaf.sources.add(source);
    if (fiscalYear) leaf.fiscalYears.add(Number(fiscalYear));
    if (!leaf.accountNumber && number) leaf.accountNumber = number;
    if (bsSection && !leaf.bsSection) leaf.bsSection = bsSection;
    if (plSection && !leaf.plSection) leaf.plSection = plSection;
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

  const addLeaf = (accountName, accountNumber, source, fiscalYear, bsSection, plSection) => {
    const name = String(accountName || "").trim();
    // isMetadataRow catches only ERP noise (date lines, "Accrual Basis", etc.).
    // Report totals / section headers are excluded by AI isReportRow detection below.
    if (!name || isMetadataRow(name)) return;
    const number = accountNumber ? String(accountNumber).trim() : null;
    const key = normName(name);

    const aiResult = aiResults.get(key);

    // AI identified this as a calculated/header row — exclude from COA entirely.
    if (aiResult?.isReportRow) return;

    // AI result drives the type classification.  Low or absent confidence → needsReview.
    // bsSection (a structural field from the extraction itself, not AI/keyword-derived
    // from the account name) can still override accountType when present. plSection is
    // the same idea for the Income Statement side (Priority 3 — below client COA and
    // the uploaded Balance Sheet, above AI) and never applies when bsSection is present.
    // No fallback default: an account with no AI result and no section override
    // has an unknown type — never guessed (was `|| "expense"`). It surfaces as
    // needsReview/needsMapping until a human classifies it.
    let accountType = aiResult?.accountType || null;
    if (bsSection) {
      const normSec = String(bsSection).toLowerCase().trim();
      if (normSec.includes("asset")) accountType = "asset";
      else if (normSec.includes("liab")) accountType = "liability";
      else if (normSec.includes("equity") || normSec.includes("capital") || normSec.includes("owner") || normSec.includes("member")) accountType = "equity";
    } else if (plSection) {
      const plType = typeFromPlSection(plSection);
      if (plType) accountType = plType;
    }
    const aiNormalizedName   = aiResult?.normalizedName  || null;
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
      mergeInto(target, source, fiscalYear, number, bsSection, plSection);
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
      sources: new Set([source]),
      fiscalYears: new Set(fiscalYear ? [Number(fiscalYear)] : []),
      bsSection: bsSection || null,
      plSection: bsSection ? null : (plSection || null),
    };
    bucket.push(leaf);
    leavesByName.set(key, bucket);
  };

  for (const r of bsRows || []) {
    addLeaf(r.account_name, r.account_number || null, "balance_sheet", r.fiscal_year, r.section, null);
  }
  for (const r of plRows || []) {
    addLeaf(r.account_name, r.account_number || null, "profit_loss", r.fiscal_year, null, r.section);
  }
  for (const r of glRows || []) {
    const glYear = glRowYear(r);
    const name = r.account_name || r.account_section || "";
    if (name) addLeaf(name, r.account_number || null, "general_ledger", glYear, null);
    if (r.split_account) addLeaf(r.split_account, null, "general_ledger", glYear, null);
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

// ── Hierarchy assembly (AI-driven) ───────────────────────────────────────────

/**
 * Try each candidate name against client_chart_of_accounts in order, keeping
 * the first match. Not a fallback guess — both names are already-known,
 * verbatim data about this exact account (Gemini's AI-normalized name, which
 * expands abbreviations like "F&F" -> "Furniture & Fixtures" for display
 * quality, and the raw original GL account name, which is often what the
 * client's own reference workbook literally uses instead of the expanded
 * form). Trying both only widens which already-existing string gets matched;
 * it never invents a new one. Duplicate names are only tried once.
 *
 * @param {{map: Function}} mapper
 * @param {string[]} names
 * @param {string|null} accountNumber
 */
function matchAnyName(mapper, names, accountNumber) {
  const tried = new Set();
  for (const name of names) {
    if (!name || tried.has(name)) continue;
    tried.add(name);
    const result = mapper.map({ normalizedName: name, accountNumber });
    if (result.matched) return result;
  }
  return { matched: false };
}

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
 * Every distinct category path already established, from two sources:
 *   1. chart_of_accounts — real, previously-matched/approved accounts across
 *      every company/version.
 *   2. client_chart_of_accounts — the imported master reference, which is
 *      stable and complete regardless of how much any one company's own data
 *      has been processed yet (source #1 alone bootstraps thin: a category
 *      like "Bank Accounts" only appears there once SOME company's bank
 *      account has actually been matched and persisted).
 * Never invented — this is the CLOSED list coaCategorySelector
 * .selectCategoryForAccounts is allowed to choose from for an account that
 * failed name/number matching (e.g. "AMEX" when "Visa Credit Card" already
 * exists under Credit Cards) — the mechanism that lets the system scale
 * across companies without a keyword/regex rule for every vendor or brand name.
 *
 * @returns {Array<{path: string, levels: string[]}>}
 */
async function loadKnownCategoryPaths() {
  const levelCols = Array.from({ length: MAX_LEVELS }, (_, i) => `level_${i + 1}`);
  const [coaRows, clientRows] = await Promise.all([
    fetchAllRows(() => supabase.from(TABLE_COA).select(["metadata", ...levelCols].join(", ")).eq("is_active", true)),
    fetchAllRows(() => supabase.from("client_chart_of_accounts").select(levelCols.join(", "))),
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
 */
function shallowLevelsFromSectionEvidence(section, accountType) {
  if (!section) return null; // no document evidence — never guess
  if (accountType === "asset") return ["Total Assets"];
  if (accountType === "liability") return ["Total Liabilities and Equity", "Total Liabilities"];
  if (accountType === "equity") return ["Total Liabilities and Equity", "Total Equity"];
  if (accountType === "income") return ["Total Income"];
  if (accountType === "cogs") return ["Total Cost of Goods Sold"];
  if (accountType === "expense") return ["Total Expenses"];
  return null;
}

/**
 * Enrich each leaf with its full 15-level hierarchy.
 *
 * Hierarchy is no longer computed — it's looked up directly against
 * chart_of_accounts itself via coaMappingService (Account Number > Exact Name >
 * Normalized Name > Fuzzy Match > Manual Review), searching every other
 * already-classified account across every company/version.
 *
 * A match's accountType/statementType/hierarchy are trusted over a fresh
 * Gemini call ONLY when the match itself is human-reviewed (classification_
 * method "manual") — that really is client-approved and should win on
 * conflict. A match whose classification_method is "gemini"/"ai_low_
 * confidence" is just a PRIOR, unverified AI guess sitting in chart_of_accounts;
 * if it conflicts with a confident fresh classification this run, it is
 * rejected wholesale (treated as no match at all) rather than partially
 * applied. This is the fix for credit-card-as-equity accounts persisting
 * across regenerates: the previous version trusted ANY match's accountType
 * unconditionally, so a single early, wrong "equity" guess for e.g. "Capital
 * One - Credit Card" would keep outranking every later, correct "liability"
 * classification of the same account name, forever. See coaMappingService
 * .resultFromEntry for where classificationMethod is exposed.
 *
 * A true miss (nothing matches, not even fuzzy — including a rejected
 * conflicting match) gets no hierarchy: level_1-15 and hierarchy_path stay
 * null/empty and needsMapping is set — the account is excluded from report
 * rollups until a human resolves it (see chartOfAccountsService
 * .updateAccountHierarchy). The moment a human saves that account's
 * hierarchy, classification_method becomes "manual" and this same row is
 * trusted unconditionally as a match candidate for every future import.
 *
 * A true miss from BOTH the name/number match above AND the category
 * selector below gets no hierarchy: level_1-15 and hierarchy_path stay
 * null/empty and needsMapping is set.
 *
 * @param {Array} leaves — output of buildCoaModel
 * @param {{map: Function}} mapper — coaMappingService.createCoaMapper() result
 * @param {Array<{path: string, levels: string[]}>} categoryPaths — loadKnownCategoryPaths() result
 * @param {Map} [existingByKey] — accountKey → existing chart_of_accounts row for
 *   this version (from a prior regenerate). Consulted in Pass 1.75, AFTER
 *   client_chart_of_accounts/BS/PL section matching and BEFORE the AI category
 *   selector — an account's own prior hierarchy outranks a fresh Gemini call.
 * @returns {Promise<Array>} leaves augmented with { levels, hierarchyPath, baseAccount, displayName, needsMapping, matchTier, sortOrder }
 */
async function buildLeafHierarchies(leaves, mapper, categoryPaths = [], existingByKey = new Map()) {
  // Pass 1: copy-only matching against client_chart_of_accounts.
  const resolved = leaves.map((leaf) => {
    const displayName = leaf.aiNormalizedName || leaf.accountName;

    // Synthetic GAAP closing lines (ensureEquityLeaf — Net Income / Retained
    // Earnings) are a fixed structural fact, not something to match or
    // AI-categorize: they always sit directly under Total Equity, as
    // siblings of each other, never nested one under the other. Without
    // this, both have no bsSection (they're computed, not extracted) and
    // fall through to the AI category selector, which previously nested
    // "Net Income" a level too deep under an existing "Retained Earnings"
    // category instead of placing it as its own sibling line.
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

    const rawMatch = matchAnyName(mapper, [displayName, leaf.accountName], leaf.accountNumber);

    const matchConflicts = rawMatch.matched
      && !TRUSTED_MATCH_METHODS.has(rawMatch.classificationMethod)
      && leaf.accountType
      && leaf.accountType !== rawMatch.accountType;
    const match = matchConflicts ? { matched: false } : rawMatch;

    if (match.matched) {
      // account_type isn't in client_chart_of_accounts, so a Balance Sheet
      // match's accountType (asset/liability/equity) is DERIVED from that
      // same matched hierarchy (accountTypeFromHierarchy) and wins over
      // Gemini/cache on conflict — confirmed fix for "Capital One - Credit
      // Card" resolving to equity despite a Balance Sheet > Liabilities match.
      // A P&L match can never legitimately be asset/liability/equity — if
      // Gemini/a stale cache entry said otherwise (the "Job Supplies" bug:
      // cached as "asset" for an account matched under Total Expenses), that
      // contradicts the workbook's own placement and is corrected to
      // "expense" (COGS vs. Expense can't be told apart from structure alone
      // in this workbook — both fold into the same Total Expenses branch —
      // so Gemini's call is kept whenever it's already in the right category).
      let resolvedAccountType = match.accountType || leaf.accountType;
      if (match.statementType === "profit_loss" && BALANCE_SHEET_TYPES.has(resolvedAccountType)) {
        resolvedAccountType = "expense";
      }
      return {
        ...leaf,
        accountType: resolvedAccountType,
        statementType: match.statementType || leaf.statementType,
        mappedNormalBalance: match.normalBalance,
        levels: match.levels,
        hierarchyPath: match.hierarchyPath,
        // Copied straight from the matched row — never rebuilt. Only a
        // genuinely new (needsMapping) account falls back to a sequential
        // counter in generateChartOfAccounts/ensureCoaComplete.
        sortOrder: match.sortOrder ?? null,
        clientAccountId: match.clientAccountId ?? null,
        baseAccount: leaf.accountName || displayName,
        displayName,
        needsMapping: false,
        matchTier: match.matchTier,
        matchConfidence: match.confidence,
      };
    }

    // No copy-only match — provisional; pass 2 may still resolve it via the
    // category selector before this becomes needs_mapping.
    return { ...leaf, displayName, __pending: true };
  });

  // Track indices into `resolved` explicitly — pending is a filtered COPY of
  // the array, so writing into pending[i] would never be seen by the final
  // resolved.map() below; every update here must go through resolved[idx].
  let pendingIndices = [];
  resolved.forEach((r, idx) => { if (r.__pending) pendingIndices.push(idx); });

  // Pass 1.5: a shallow (top-level only) placement for an account this
  // version's OWN uploaded document actually shows a section for — a Balance
  // Sheet section (Priority 2) or, failing that, a Profit & Loss section
  // (Priority 3, income-statement grouping only) — real, if shallow,
  // structural data beats an AI guess, and it's free. Resolved here, it's
  // removed from what pass 2 sends to Gemini. bsSection always wins when both
  // are somehow present (see mergeInto/addLeaf — plSection never applies to a
  // leaf that already has bsSection).
  for (const idx of pendingIndices) {
    const leaf = resolved[idx];
    const sectionEvidence = leaf.bsSection || leaf.plSection;
    const shallowLevels = shallowLevelsFromSectionEvidence(sectionEvidence, leaf.accountType);
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

  // Pass 1.75: reuse a leaf's own EXISTING hierarchy from a prior regenerate
  // (Priority: Existing Working COA — outranks AI). Client COA / BS section /
  // PL section all failed to resolve this leaf THIS run, but if it already
  // has a real, previously-resolved hierarchy sitting in chart_of_accounts,
  // that beats spending a fresh Gemini category-selector call and risking a
  // different placement than last time. Never applies to an existing row that
  // itself has no real hierarchy (empty hierarchy_path — already needs_mapping).
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

  // Pass 2: for accounts still unresolved, ask Gemini to pick the best-fit
  // EXISTING category (never invent one) — this is what lets "AMEX" land
  // under the same "Credit Cards" category "Visa Credit Card" already
  // established, without any keyword/regex rule for card issuers.
  if (pendingIndices.length && categoryPaths.length) {
    const categoryLevelsByPath = new Map(categoryPaths.map((c) => [c.path, c.levels]));
    const batchInput = pendingIndices.map((idx, i) => {
      const r = resolved[idx];
      return { key: String(i), accountName: r.displayName, accountType: r.accountType || undefined };
    });
    const placements = await selectCategoryForAccounts(batchInput, categoryPaths.map((c) => c.path));

    for (let i = 0; i < pendingIndices.length; i++) {
      const placement = placements.get(String(i));
      if (!placement) continue;
      const categoryLevels = categoryLevelsByPath.get(placement.category);
      if (!categoryLevels) continue; // defensive — selectCategoryForAccounts already validates this

      const idx = pendingIndices[i];
      const leaf = resolved[idx];
      const baseAccount = leaf.accountName || leaf.displayName;
      const path = [...categoryLevels, baseAccount];
      const levels = new Array(MAX_LEVELS).fill(null);
      path.forEach((label, li) => { if (li < MAX_LEVELS) levels[li] = label; });

      resolved[idx] = {
        ...leaf,
        levels,
        hierarchyPath: path.join(" > "),
        baseAccount,
        needsMapping: false,
        // Visible for optional human confirmation but not blocking — this is
        // an AI category pick, not a copy from an authoritative source or a
        // human decision, so it stays reviewable without excluding the
        // account from reports (see chartOfAccountsService's report-consuming
        // callers, which only ever gate on needsMapping, not needsReview).
        needsReview: true,
        classificationMethod: "gemini_category",
        matchTier: "gemini_category",
        matchConfidence: placement.confidence,
      };
    }
  }

  // Anything still pending after both passes is a genuinely new accounting
  // concept (or the category selector was unavailable/found no fit) —
  // flagged for manual mapping, never given an invented hierarchy.
  return resolved.map((r) => {
    if (!r.__pending) return r;
    const { __pending, ...leaf } = r;
    if (leaf.levels) return leaf; // resolved by pass 2 above
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

  const { leaves } = buildCoaModel(glRows, bsRows, plRows, aiResults);
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

  const mapper = await createCoaMapper(companyId);
  const categoryPaths = await loadKnownCategoryPaths();
  const hierarchical = await buildLeafHierarchies(leaves, mapper, categoryPaths, existingByKey);
  const unmappedCount = hierarchical.filter((l) => l.needsMapping).length;
  const aiCategorizedCount = hierarchical.filter((l) => l.matchTier === "gemini_category").length;
  const bsSectionCount = hierarchical.filter((l) => l.matchTier === "bs_section").length;
  const plSectionCount = hierarchical.filter((l) => l.matchTier === "pl_section").length;
  const existingWorkingCoaCount = hierarchical.filter((l) => l.matchTier === "existing_working_coa").length;
  const ruleCount = hierarchical.filter((l) => l.matchTier === "rule").length;
  // Any other truthy matchTier came from coaMappingService — i.e. matched
  // against client_chart_of_accounts (company-scoped upload or the global
  // reference), the highest-priority hierarchy source.
  const coaMatchedCount = hierarchical.filter(
    (l) => l.matchTier && !["gemini_category", "bs_section", "pl_section", "existing_working_coa", "rule"].includes(l.matchTier),
  ).length;
  const sourceCounts = {
    coaReference: coaMatchedCount,
    bsSection: bsSectionCount,
    plSection: plSectionCount,
    existingWorkingCoa: existingWorkingCoaCount,
    rule: ruleCount,
    aiCategory: aiCategorizedCount,
    needsMapping: unmappedCount,
  };
  if (aiCategorizedCount) {
    console.log(`[ChartOfAccounts] ${aiCategorizedCount} account(s) auto-placed into an existing category by AI selection (no name/number match, no new category invented) — flagged needs_review for optional confirmation.`);
  }
  if (unmappedCount) {
    console.log(`[ChartOfAccounts] ${unmappedCount} account(s) did not match an existing Chart of Accounts hierarchy. Marked needs_mapping=true. Excluded from reports until manually mapped.`);
  }
  const validationIssues = validateHierarchyConsistency(hierarchical);

  // A prior run's client_account_id can go stale if client_chart_of_accounts was
  // ever wiped and re-imported (a fresh import assigns new row ids) — blindly
  // preserving it below would violate the FK. Load the current valid id set once
  // so a dangling reference gets dropped instead of crashing the whole regenerate.
  const { data: validClientAccountRows } = await supabase.from("client_chart_of_accounts").select("id");
  const validClientAccountIds = new Set((validClientAccountRows || []).map((r) => r.id));

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
    const freshHierarchyConfidence = hierarchyConfidenceFromTier(leaf.matchTier);
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
        ...levelsToColumns(aiLevels),
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
      Object.assign(patch, levelsToColumns(leaf.levels), {
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
        Object.assign(patch, levelsToColumns(existingLevels), {
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
        Object.assign(patch, levelsToColumns(aiLevels), {
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
    Object.assign(update, levelsToColumns(levels), {
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

  // 4. Build leaf descriptors. Gemini supplies accountType/normalizedName/confidence
  //    only; hierarchy is looked up against other chart_of_accounts rows (same
  //    as generateChartOfAccounts — see buildLeafHierarchies).
  const coaMapper = await createCoaMapper(companyId);
  const categoryPaths = await loadKnownCategoryPaths();
  const categoryLevelsByPath = new Map(categoryPaths.map((c) => [c.path, c.levels]));

  const preliminary = missingRaw
    .filter((rawName) => {
      const aiResult = aiResults.get(normName(rawName));
      return !aiResult?.isReportRow; // exclude AI-detected report rows
    })
    .map((rawName) => {
      const key      = normName(rawName);
      const aiResult = aiResults.get(key);
      // No fallback default: an account with no AI result and no COA match has an
      // unknown type — never guessed. It stays needsMapping/needsReview until a
      // human classifies it (see chartOfAccountsService.updateAccountHierarchy).
      const aiType   = aiResult?.accountType || null;
      const confidence  = aiResult?.confidence ?? null;
      const needsReview = !aiResult || (confidence !== null && confidence < AI_NEEDS_REVIEW_THRESHOLD);
      const displayName = aiResult?.normalizedName || rawName;
      const classificationMethod = !aiResult ? "unclassified" : needsReview ? "ai_low_confidence" : "gemini";

      // Try the AI-normalized name first, then the raw original GL name —
      // same fallback as buildLeafHierarchies (see matchAnyName's docblock).
      const rawMatch = matchAnyName(coaMapper, [displayName, rawName], null);
      // Reject a non-manual match that conflicts with this run's own AI
      // classification — same rule as buildLeafHierarchies, and for the same
      // reason: an unverified prior "gemini"-sourced classification must not
      // outrank a fresh one just because it happened to exist first.
      const matchConflicts = rawMatch.matched
        && !TRUSTED_MATCH_METHODS.has(rawMatch.classificationMethod)
        && aiType && aiType !== rawMatch.accountType;
      const match = matchConflicts ? { matched: false } : rawMatch;
      // Same guard as buildLeafHierarchies: a P&L match can never legitimately
      // be asset/liability/equity (the "Job Supplies" bug — cached as "asset"
      // for an account matched under Total Expenses).
      let type = match.matched ? (match.accountType || aiType) : aiType;
      if (match.matched && match.statementType === "profit_loss" && BALANCE_SHEET_TYPES.has(type)) {
        type = "expense";
      }
      // statementTypeFor/normalBalanceFor are deterministic accounting facts of a
      // KNOWN type (asset is always debit/balance_sheet) — never invoked to invent
      // a type; when `type` itself is null/unknown these stay null too.
      const stmtType  = match.matched ? (match.statementType || (type ? statementTypeFor(type) : null)) : (type ? statementTypeFor(type) : null);
      const normalBal = match.matched ? match.normalBalance : (type ? normalBalanceFor(type) : null);
      // Copied from the matched row, never rebuilt — same rule as generateChartOfAccounts.
      const sortOrder = match.matched ? (match.sortOrder ?? null) : null;
      const clientAccountId = match.matched ? (match.clientAccountId ?? null) : null;

      if (match.matched) {
        return { rawName, displayName, type, stmtType, sortOrder, clientAccountId, normalBal,
                 confidence, needsReview, classificationMethod, finalLevels: match.levels,
                 hierarchyPath: match.hierarchyPath, needsMapping: false, matchTier: match.matchTier || null };
      }
      // No copy-only match — provisional; the category selector below may
      // still resolve it before this becomes needs_mapping.
      return { rawName, displayName, type, stmtType, sortOrder, clientAccountId, normalBal,
               confidence, needsReview, classificationMethod, __pending: true };
    });

  // Second pass: same scalable category-reuse fallback as buildLeafHierarchies
  // — ask Gemini to pick the best-fit EXISTING category for accounts with no
  // direct name/number match, never inventing a new one.
  const pendingIndices = [];
  preliminary.forEach((r, idx) => { if (r.__pending) pendingIndices.push(idx); });
  if (pendingIndices.length && categoryPaths.length) {
    const batchInput = pendingIndices.map((idx, i) => {
      const r = preliminary[idx];
      return { key: String(i), accountName: r.displayName, accountType: r.type || undefined };
    });
    const placements = await selectCategoryForAccounts(batchInput, categoryPaths.map((c) => c.path));
    for (let i = 0; i < pendingIndices.length; i++) {
      const placement = placements.get(String(i));
      if (!placement) continue;
      const categoryLevels = categoryLevelsByPath.get(placement.category);
      if (!categoryLevels) continue;

      const idx = pendingIndices[i];
      const leaf = preliminary[idx];
      const path = [...categoryLevels, leaf.rawName];
      const finalLevels = new Array(MAX_LEVELS).fill(null);
      path.forEach((label, li) => { if (li < MAX_LEVELS) finalLevels[li] = label; });

      preliminary[idx] = {
        ...leaf, finalLevels, hierarchyPath: path.join(" > "), needsMapping: false,
        needsReview: true, classificationMethod: "gemini_category", matchTier: "gemini_category",
      };
    }
  }

  const classifiedLeaves = preliminary.map((r) => {
    if (!r.__pending) return r;
    const { __pending, ...leaf } = r;
    if (leaf.finalLevels) return leaf; // resolved by the category selector above
    return { ...leaf, finalLevels: new Array(MAX_LEVELS).fill(null), hierarchyPath: "", needsMapping: true, matchTier: null };
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
      ...levelsToColumns(leaf.finalLevels),
      base_account:          leaf.rawName,
      hierarchy_path:        leaf.hierarchyPath,
      classification_method: leaf.classificationMethod,
      match_source:          leaf.needsMapping ? "manual_review" : matchSourceFromTier(leaf.matchTier),
      hierarchy_confidence:  hierarchyConfidenceFromTier(leaf.matchTier),
      original_name:         leaf.displayName,
      original_hierarchy:    snapshot,
      adjusted_name:         leaf.displayName,
      adjusted_hierarchy:    snapshot,
      metadata: {
        is_group: false, sources: ["completion"], fiscal_years: [],
        user_modified: false, ai_confidence: leaf.confidence, needs_review: leaf.needsReview,
        needs_mapping: leaf.needsMapping || false,
        match_tier: leaf.matchTier || null,
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
  // exported for unit testing
  buildCoaModel,
  buildLeafHierarchies,
  buildTree,
  isMetadataRow,
};
