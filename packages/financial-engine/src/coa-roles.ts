import type { Account, EbitdaRole } from "./types.js";

/**
 * Resolve the EBIT add-back lines from the chart of accounts.
 *
 * `QE - 0004` requires Interest Income, Interest Expense and Income Tax Expense
 * to come from predefined mapped GL account groupings, and Depreciation and
 * Amortization from a centralized account-level flag — NOT from matching
 * account labels.
 *
 * The label-matching approach it replaces is not merely inelegant, it is wrong
 * on real data. The legacy browser implementation matched any account whose
 * name contained the whole word "tax", which on this engagement swept up
 * Meals Tax ($37,820.18), Real estate taxes ($39,428.38) and Taxes & Licenses
 * ($6,733.00) as income tax expense — $83,981.56 of fabricated add-back against
 * a true FY2024 net income of $47,568.23.
 *
 * An account with no role contributes nothing. That is the safe direction: a
 * missing add-back is visible on review, an invented one is not.
 */

/** Sign applied when a role's ledger amount enters the Reported EBITDA build. */
const ROLE_SIGN: Record<EbitdaRole, 1 | -1> = {
  interest_expense: 1,
  interest_income: -1,
  income_tax: 1,
  depreciation: 1,
  amortization: 1,
  owner_compensation: 1,
};

/** Display order and labels for the itemized EBIT lines. */
export const EBIT_ROLE_ORDER: EbitdaRole[] = [
  "interest_expense",
  "interest_income",
  "depreciation",
  "amortization",
  "income_tax",
];

export const ROLE_LABELS: Record<EbitdaRole, string> = {
  interest_expense: "Interest Expense",
  interest_income: "Interest Income",
  income_tax: "Income Tax Expense",
  depreciation: "Depreciation",
  amortization: "Amortization",
  owner_compensation: "Owner Compensation",
};

/**
 * Default commentary `QE - 0004` requires to be pre-populated on every EBIT
 * line — general accounting rationale, not deal-specific, editable per deal.
 */
export const ROLE_DEFAULT_COMMENTARY: Record<EbitdaRole, string> = {
  interest_expense:
    "Interest expense is added back as it reflects the seller's capital structure rather than operating performance.",
  interest_income:
    "Interest income is deducted as it is non-operating and does not recur with the business.",
  income_tax:
    "Income tax expense is added back as tax position is specific to the current ownership structure.",
  depreciation:
    "Depreciation is added back as a non-cash charge reflecting historical capital expenditure.",
  amortization:
    "Amortization is added back as a non-cash charge reflecting historical intangible acquisition.",
  owner_compensation:
    "Owner compensation is normalized to reflect the cost of operating the business post-close.",
};

export function roleSign(role: EbitdaRole): 1 | -1 {
  return ROLE_SIGN[role];
}

/** Accounts carrying each role, in chart order. */
export function accountsByRole(accounts: Account[]): Map<EbitdaRole, Account[]> {
  const byRole = new Map<EbitdaRole, Account[]>();
  for (const account of accounts) {
    if (!account.ebitdaRole) continue;
    const bucket = byRole.get(account.ebitdaRole);
    if (bucket) bucket.push(account);
    else byRole.set(account.ebitdaRole, [account]);
  }
  return byRole;
}

/**
 * P&L accounts with no role assigned. Surfaced on the bridge so a reviewer can
 * see what was skipped rather than discovering it in a workpaper review.
 */
export function unflaggedProfitLossAccounts(accounts: Account[]): string[] {
  return accounts
    .filter((a) => a.statementType === "profit_loss" && !a.ebitdaRole)
    .map((a) => a.name)
    .sort();
}
