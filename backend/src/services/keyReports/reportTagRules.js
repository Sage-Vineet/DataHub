// ============================================================================
// Chart of Accounts — report-line tagging (Key Reports redesign)
//
// classifyReportTag(account) identifies accounts that specific reports need to
// find as distinct line items — cash, receivables, inventory, payables,
// long-term debt, depreciation/amortization, interest expense, income tax —
// ONCE, at Chart of Accounts classification time. The tag is written to
// chart_of_accounts.metadata.report_tag (no new column — metadata is already
// the catch-all classification-metadata field). QoE and KPI then read the
// stored tag instead of scanning account/group names by keyword at report
// render time.
//
// Returns null when an account doesn't correspond to any of these specific
// report lines — most accounts have no tag, and that's expected.
// ============================================================================

const CASH_RE        = /cash|checking|savings|petty|money market/i;
const RECEIVABLE_RE  = /receivable/i;
const INVENTORY_RE   = /inventory/i;
const PAYABLE_RE     = /payable/i;
const DEBT_RE        = /loan|note payable|mortgage|bond|line of credit/i;
const DEPR_AMORT_RE  = /depreciation|amortization|\bdepr\b|\bamort\b/i;
const INTEREST_RE    = /interest/i;
const INCOME_TAX_RE  = /income tax|tax expense|provision for tax/i;

/**
 * @param {{accountType: string, name: string, level3: string|null}} account
 * @returns {"cash"|"accounts_receivable"|"inventory"|"accounts_payable"|
 *   "long_term_debt"|"depreciation_amortization"|"interest_expense"|
 *   "income_tax"|null}
 */
function classifyReportTag({ accountType, name, level3 } = {}) {
  const n = String(name || "");

  if (accountType === "asset") {
    if (CASH_RE.test(n)) return "cash";
    if (RECEIVABLE_RE.test(n)) return "accounts_receivable";
    if (INVENTORY_RE.test(n)) return "inventory";
    return null;
  }

  if (accountType === "liability") {
    if (level3 === "Long-Term Liabilities" || DEBT_RE.test(n)) return "long_term_debt";
    if (PAYABLE_RE.test(n)) return "accounts_payable";
    return null;
  }

  if (accountType === "expense") {
    if (DEPR_AMORT_RE.test(n)) return "depreciation_amortization";
    if (INTEREST_RE.test(n)) return "interest_expense";
    if (INCOME_TAX_RE.test(n)) return "income_tax";
    return null;
  }

  return null;
}

module.exports = { classifyReportTag };
