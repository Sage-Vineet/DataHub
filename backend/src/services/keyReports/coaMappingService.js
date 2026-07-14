// ============================================================================
// COA Mapping Service (Key Reports redesign — client_chart_of_accounts is the
// master hierarchy reference)
//
// Hierarchy (level_1..level_15, hierarchy_path, sort_order, statement_type)
// is never computed — it's looked up directly against client_chart_of_accounts,
// the table imported once from the client's own COA workbook
// (clientCoaImportService.js / migration 071). That import is the only way
// hierarchy enters the system; this service only ever COPIES it.
//
// Matching priority: Account Number > Exact Name > Normalized Name >
// (Adjusted Name alias) > Fuzzy Match > Manual Review (needs_mapping).
// account_type and normal_balance are NOT in the source workbook and are not
// looked up here — account_type always comes from Gemini, and normal_balance
// is derived from it deterministically by chartOfAccountsService.normalBalanceFor.
//
// A true miss (nothing matches, not even fuzzy) means no hierarchy is
// assigned — the account is flagged needs_mapping and excluded from report
// rollups until a human resolves it directly on its own chart_of_accounts row
// (chartOfAccountsService.updateAccountHierarchy). That per-account fix does
// NOT feed back into client_chart_of_accounts — the master only changes by
// re-running the importer against a newer version of the source workbook.
// ============================================================================

"use strict";

const { fetchAllRows } = require("./pagedFetch");
const { buildFuzzyLookup, fuzzyMatch } = require("./accountNameMatching");
const { supabase } = require("../../db");

const LEVEL_KEYS = Array.from({ length: 15 }, (_, i) => `level_${i + 1}`);
const TABLE = "client_chart_of_accounts";

// Every row in client_chart_of_accounts is equally authoritative — it's a
// curated import, not accumulated AI history — so every match from this
// service is unconditionally trusted (see chartOfAccountsService
// .buildLeafHierarchies' TRUSTED_MATCH_METHODS check).
const CLIENT_WORKBOOK_METHOD = "client_workbook";

/**
 * Rows imported from a COA workbook — either one company's own upload
 * (migration 072) or the shared global reference (companyId null).
 */
async function loadCandidateAccounts(companyId) {
  const cols = [
    "id", "system_id", "account_name", "adjusted_name", "account_number",
    "account_id_name", "statement_type", "hierarchy_path", ...LEVEL_KEYS,
  ].join(", ");
  return fetchAllRows(() => {
    const q = supabase.from(TABLE).select(cols);
    return companyId ? q.eq("company_id", companyId) : q.is("company_id", null);
  });
}

/**
 * account_type isn't a column in the source workbook, but for a Balance
 * Sheet row its position in the copied hierarchy already determines it
 * unambiguously — asset accounts sit directly under "Total Assets", liability
 * under "Total Liabilities", equity under "Total Equity". Reading that back
 * off the SAME authoritative structure being copied is not a guess (it's
 * exactly how "Capital One - Credit Card" is confirmed a liability even when
 * Gemini, fresh or from a stale cache entry, classifies it as equity) — it's
 * different in kind from inventing a NEW hierarchy position, which this never
 * does. P&L accounts are left null: this workbook folds COGS and Expense into
 * the same "Total Expenses > Expenses" branch, so the two can't be told apart
 * from structure alone; only "income" (under "Total Revenue") is unambiguous,
 * and Gemini already gets that case right without contradiction from the workbook.
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

function resultFromEntry(entry, matchTier, confidence) {
  return {
    matched: true,
    matchTier,
    confidence,
    // Derived from the matched row's OWN hierarchy when unambiguous (see
    // accountTypeFromHierarchy) — otherwise null, and the caller keeps
    // Gemini's classification. normal_balance is derived from whichever
    // wins by chartOfAccountsService.normalBalanceFor.
    accountType: accountTypeFromHierarchy(entry.statement_type, entry.level_1, entry.level_2, entry.hierarchy_path),
    normalBalance: null,
    statementType: normalizeStatementType(entry.statement_type),
    systemId: entry.system_id,
    hierarchyPath: entry.hierarchy_path,
    levels: LEVEL_KEYS.map((k) => entry[k] || null),
    // Traceability back to the master row this hierarchy was copied from
    // (chart_of_accounts.client_account_id — migration 071).
    clientAccountId: entry.id,
    // Always "client_workbook" — every row here is equally authoritative, so
    // this always wins over a fresh AI classification on conflict (unlike a
    // "gemini"-sourced candidate from the old cross-company chart_of_accounts
    // search, which was just a prior, possibly-wrong, never-verified guess).
    classificationMethod: CLIENT_WORKBOOK_METHOD,
  };
}

/** One name/number lookup over a fixed set of candidate rows. */
function buildSingleMapper(entries) {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const fuzzyLookup = buildFuzzyLookup(entries);

  return {
    map({ normalizedName, accountNumber }) {
      // 1. Exact account number.
      if (accountNumber) {
        const nk = String(accountNumber).trim();
        if (fuzzyLookup.byNum.has(nk)) {
          const entry = byId.get(fuzzyLookup.byNum.get(nk));
          if (entry) return resultFromEntry(entry, "account_number", 1.0);
        }
      }
      // 2-5. Exact normalized name / exact original name / adjusted-name alias /
      // fuzzy similarity — accountNameMatching.fuzzyMatch already tries these
      // tiers in order (normalized-exact, strict-alnum-exact — which indexes
      // account_name AND adjusted_name as aliases of the same account — then
      // Jaccard word-similarity with the accounting-modifier hard gate).
      // accountNumber already checked above — pass null so it isn't re-checked.
      const match = fuzzyMatch(fuzzyLookup, normalizedName, null);
      if (!match) return { matched: false };
      const entry = byId.get(match.id);
      if (!entry) return { matched: false };
      const matchTier = match.confidence >= 1.0 ? "exact_name" : match.confidence >= 0.95 ? "normalized_name" : "fuzzy";
      return resultFromEntry(entry, matchTier, match.confidence);
    },
    entryCount: entries.length,
  };
}

/**
 * Build a reusable mapper for one classification run.
 *
 * When companyId is given and that company has its own uploaded COA
 * (migration 072), it is searched FIRST and wins on any match, full stop —
 * a company's own uploaded workbook is the highest-priority hierarchy source
 * by definition. The shared global reference is always the fallback, so
 * companies without their own upload keep working exactly as before.
 *
 * @param {string|null} [companyId]
 */
async function createCoaMapper(companyId = null) {
  const [companyEntries, globalEntries] = await Promise.all([
    companyId ? loadCandidateAccounts(companyId) : Promise.resolve([]),
    loadCandidateAccounts(null),
  ]);

  const companyMapper = companyEntries.length ? buildSingleMapper(companyEntries) : null;
  const globalMapper = buildSingleMapper(globalEntries);
  // Visibility for a recurring issue this session: client_chart_of_accounts has
  // unexpectedly gone empty (both company-scoped and global rows) more than
  // once, with the cause still unconfirmed. Logging counts on every mapper
  // build means the next occurrence shows up directly in sync logs instead of
  // requiring an ad hoc DB query to notice.
  console.log(
    `[CoaMapping] client_chart_of_accounts: ${companyEntries.length} company-scoped row(s)` +
    (companyId ? ` (company=${companyId})` : '') +
    `, ${globalEntries.length} global row(s).` +
    (companyEntries.length === 0 && globalEntries.length === 0 ? ' WARNING: table is empty — no COA-reference hierarchy source available for this run.' : ''),
  );

  return {
    /**
     * @param {{normalizedName: string, accountNumber?: string|null}} account
     * @returns {{matched: false} | {matched: true, matchTier: string, confidence: number,
     *   accountType: null, statementType: string, normalBalance: null, systemId: string,
     *   hierarchyPath: string, levels: (string|null)[], clientAccountId: string,
     *   classificationMethod: string}}
     */
    map(account) {
      if (companyMapper) {
        const result = companyMapper.map(account);
        if (result.matched) return result;
      }
      return globalMapper.map(account);
    },
    entryCount: companyEntries.length + globalEntries.length,
  };
}

module.exports = { createCoaMapper };
