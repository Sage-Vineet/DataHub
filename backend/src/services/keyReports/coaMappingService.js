// ============================================================================
// COA Mapping Service (uploaded Chart of Accounts is the single source of
// truth when present)
//
// Hierarchy (level_1..level_15, hierarchy_path, sort_order, statement_type)
// is never computed for a matched account — it's looked up directly against
// client_chart_of_accounts, the table imported once from the client's own
// COA workbook (clientCoaImportService.js / migration 071). That import is
// the only way hierarchy enters the system for a matched account; this
// service only ever COPIES it.
//
// Matching itself is delegated to coaAccountMatcher.js's 5-stage deterministic
// engine (Account Number > Exact > Normalized > Alias > strict Fuzzy >= 95% >
// Parent Validation for ties). account_type is NOT in the source workbook and
// is not looked up here — for a Balance Sheet row it's derived unambiguously
// from the matched row's OWN hierarchy position (accountTypeFromHierarchy);
// normal_balance is derived from whichever type wins, deterministically, by
// chartOfAccountsService.normalBalanceFor.
//
// A true miss (status 'unmatched') or a genuine tie neither exact/alias/fuzzy
// NOR parent-validation can resolve (status 'ambiguous') is the ONLY case
// that should ever reach AI classification — see chartOfAccountsService
// .buildLeafHierarchies, which now matches against this service FIRST and
// only spends an AI call on what's left.
// ============================================================================

"use strict";

const { fetchAllRows } = require("./pagedFetch");
const { matchAccountToCoa } = require("./coaAccountMatcher");
const { supabase } = require("../../db");

const LEVEL_KEYS = Array.from({ length: 15 }, (_, i) => `level_${i + 1}`);
const TABLE = "client_chart_of_accounts";

/**
 * Rows imported from a COA workbook for THIS company only (migration 072).
 * No global/shared reference — the client has explicitly required that no
 * company's COA generation ever reads another company's (or a company-
 * independent) reference data. Every query against client_chart_of_accounts
 * must be scoped by company_id; there is no unscoped fallback.
 */
async function loadCandidateAccounts(companyId) {
  const cols = [
    "id", "system_id", "account_name", "adjusted_name", "account_number",
    "account_id_name", "statement_type", "normal_balance", "hierarchy_path", ...LEVEL_KEYS,
  ].join(", ");
  return fetchAllRows(() => supabase.from(TABLE).select(cols).eq("company_id", companyId));
}

/**
 * account_type isn't a column in the source workbook, but for a Balance
 * Sheet row its position in the copied hierarchy already determines it
 * unambiguously — asset accounts sit directly under "Total Assets", liability
 * under "Total Liabilities", equity under "Total Equity". Reading that back
 * off the SAME authoritative structure being copied is not a guess — it's
 * different in kind from inventing a NEW hierarchy position, which this never
 * does. P&L accounts are left null: this workbook folds COGS and Expense into
 * the same "Total Expenses > Expenses" branch, so the two can't be told apart
 * from structure alone; only "income" (under "Total Revenue") is unambiguous.
 */
function accountTypeFromHierarchy(statementType, level1, level2, hierarchyPath) {
  if (statementType === "Balance Sheet") {
    if (level1 === "Total Assets") return "asset";
    if (level2 === "Total Liabilities") return "liability";
    if (level2 === "Total Equity") return "equity";
    return null;
  }
  if (statementType === "P&L" && /total revenue/i.test(String(hierarchyPath || ""))) {
    return "income";
  }
  return null;
}

// The workbook's own literal labels ("P&L", "Balance Sheet") are stored
// verbatim in client_chart_of_accounts, but every other consumer in the
// system (financialStatementService.isPlAccount/isBsAccount, the
// idx_chart_of_accounts_statement index, Trial Balance) expects the
// long-standing "profit_loss"/"balance_sheet" values — normalizing here,
// once, at the only place the workbook's raw text enters chart_of_accounts,
// is translation between two vocabularies for the same known fact, not
// hierarchy generation.
function normalizeStatementType(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (s === "p&l" || s === "profit_loss" || s === "profit & loss") return "profit_loss";
  if (s === "balance sheet" || s === "balance_sheet") return "balance_sheet";
  return null;
}

function resultFromEntry(entry, matchTier, confidence, reason) {
  return {
    matched: true,
    status: "matched",
    matchTier,
    confidence,
    reason,
    accountType: accountTypeFromHierarchy(entry.statement_type, entry.level_1, entry.level_2, entry.hierarchy_path),
    normalBalance: entry.normal_balance || null,
    statementType: normalizeStatementType(entry.statement_type),
    systemId: entry.system_id,
    hierarchyPath: entry.hierarchy_path,
    levels: LEVEL_KEYS.map((k) => entry[k] || null),
    // Traceability back to the master row this hierarchy was copied from
    // (chart_of_accounts.client_account_id — migration 071).
    clientAccountId: entry.id,
    classificationMethod: "client_workbook",
  };
}

function ambiguousResult(candidateRows, reason) {
  return {
    matched: false,
    status: "ambiguous",
    matchTier: null,
    confidence: 0,
    reason,
    candidates: candidateRows.map((c) => ({
      clientAccountId: c.id,
      accountName: c.account_name,
      hierarchyPath: c.hierarchy_path,
    })),
  };
}

/** One name/number lookup over a fixed set of candidate rows for one company. */
function buildSingleMapper(entries) {
  return {
    /**
     * @param {{normalizedName: string, accountNumber?: string|null, bsSection?: string|null, plSection?: string|null}} account
     */
    map({ normalizedName, accountNumber, bsSection, plSection }) {
      const result = matchAccountToCoa({ accountName: normalizedName, accountNumber, bsSection, plSection }, entries);
      if (result.status === "matched") return resultFromEntry(result.entry, result.matchTier, result.confidence, result.reason);
      if (result.status === "ambiguous") return ambiguousResult(result.candidates, result.reason);
      return { matched: false, status: "unmatched", reason: result.reason };
    },
    entryCount: entries.length,
  };
}

/**
 * Try each candidate name against client_chart_of_accounts in order, keeping
 * the first confident match. Not a fallback guess — both names are already-
 * known, verbatim data about this exact account (an AI-normalized display
 * name, which expands abbreviations for display quality, and the raw
 * original GL account name, which is often what the client's own reference
 * workbook literally uses). Trying both only widens which already-existing
 * string gets matched; it never invents a new one. An 'ambiguous' result
 * from an earlier name is kept as a fallback if no later name matches
 * cleanly — still far more informative than treating it as a flat miss.
 *
 * @param {{map: Function}} mapper
 * @param {string[]} names
 * @param {string|null} accountNumber
 * @param {{bsSection?: string|null, plSection?: string|null}} [evidence]
 */
function matchAnyName(mapper, names, accountNumber, evidence = {}) {
  const tried = new Set();
  let bestAmbiguous = null;
  for (const name of names) {
    if (!name || tried.has(name)) continue;
    tried.add(name);
    const result = mapper.map({ normalizedName: name, accountNumber, bsSection: evidence.bsSection, plSection: evidence.plSection });
    if (result.matched) return result;
    if (result.status === "ambiguous" && !bestAmbiguous) bestAmbiguous = result;
  }
  return bestAmbiguous || { matched: false, status: "unmatched" };
}

/**
 * Build a reusable mapper for one classification run — strictly this
 * company's own uploaded COA (migration 072), if any. No cross-company or
 * global fallback: a company with no uploaded COA of its own simply gets no
 * match here, and every account falls through to AI classification (Balance
 * Sheet/P&L section evidence still informs the AI's own reasoning, but never
 * another company's data, per the client's explicit multi-tenant isolation
 * requirement).
 *
 * @param {string} companyId
 */
async function createCoaMapper(companyId) {
  const companyEntries = companyId ? await loadCandidateAccounts(companyId) : [];
  const companyMapper = companyEntries.length ? buildSingleMapper(companyEntries) : null;
  // Visibility for a recurring issue this session: client_chart_of_accounts has
  // unexpectedly gone empty more than once, with the cause still unconfirmed.
  // Logging the count on every mapper build means the next occurrence shows up
  // directly in sync logs instead of requiring an ad hoc DB query to notice.
  console.log(
    `[CoaMapping] client_chart_of_accounts: ${companyEntries.length} row(s) for company=${companyId}.` +
    (companyEntries.length === 0 ? ' No uploaded Chart of Accounts for this company — every account will be classified by AI.' : ''),
  );

  return {
    /**
     * @param {{normalizedName: string, accountNumber?: string|null, bsSection?: string|null, plSection?: string|null}} account
     * @returns {{matched: false, status: 'unmatched'|'ambiguous', candidates?: Array} |
     *   {matched: true, status: 'matched', matchTier: string, confidence: number, reason: string,
     *    accountType: string|null, statementType: string|null, normalBalance: string|null, systemId: string,
     *    hierarchyPath: string, levels: (string|null)[], clientAccountId: string, classificationMethod: string}}
     */
    map(account) {
      if (!companyMapper) return { matched: false, status: "unmatched", reason: "No uploaded Chart of Accounts for this company." };
      return companyMapper.map(account);
    },
    entryCount: companyEntries.length,
  };
}

module.exports = { createCoaMapper, matchAnyName, loadCandidateAccounts };
