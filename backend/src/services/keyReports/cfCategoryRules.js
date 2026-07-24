// ============================================================================
// Chart of Accounts — Cash Flow bucket assignment (Key Reports redesign)
//
// classifyCfCategory(account) decides which Cash Flow section an account's
// balance-sheet-delta belongs to — Operating / Investing / Financing — ONCE,
// at Chart of Accounts classification time (chartOfAccountsService writes the
// result to chart_of_accounts.cf_category, migration 070). Cash Flow report
// builders (financialStatementService) then read the stored value instead of
// matching account names against regex keyword lists at render time.
//
// The account's own BS section (level_2 for assets, level_3 for
// liabilities/equity — copied from the matched chart_of_accounts row) drives
// the decision first, since it is unambiguous for Fixed/Other Assets and
// Long-Term Liabilities. Current Assets and Current Liabilities legitimately
// mix operating and non-operating items (e.g. Accounts Payable vs. Current
// Portion of Long-Term Debt both sit in "Current Liabilities"), so name
// patterns disambiguate only within those two buckets — this is the same
// domain knowledge the report layer used to apply per-render, just run once
// and stored instead of repeated in every Cash Flow builder.
// ============================================================================

const CASH_RE     = /cash|checking|savings|petty/i;
const INVEST_RE   = /equipment|property|building|land|vehicle|furniture|ppe|intangible|invest/i;
const FINANCE_RE  = /loan|mortgage|bond|note payable|line of credit|long.term/i;

/**
 * @param {{accountType: string, name: string, level2: string|null, level3: string|null}} account
 * @returns {"operating"|"investing"|"financing"|null}
 *   null = cash/bank account (excluded — Cash Flow solves for the cash balance
 *   itself, it isn't a delta input) or an income/cogs/expense account (these
 *   don't participate in the balance-sheet-delta Cash Flow build).
 */
function classifyCfCategory({ accountType, name, level2, level3 } = {}) {
  const n = String(name || "");

  if (accountType === "asset") {
    if (CASH_RE.test(n)) return null;
    if (level2 === "Fixed Assets" || level2 === "Other Assets") return "investing";
    if (INVEST_RE.test(n)) return "investing";
    return "operating"; // Current Assets default: receivables, inventory, prepaid, deposits
  }

  if (accountType === "liability") {
    if (level3 === "Long-Term Liabilities") return "financing";
    if (FINANCE_RE.test(n)) return "financing";
    return "operating"; // Current Liabilities default: payables, accruals, unearned revenue
  }

  if (accountType === "equity") return "financing";

  return null; // income / cogs / expense
}

module.exports = { classifyCfCategory };
