/**
 * Input and output records for the financial engine.
 *
 * Everything here is plain data. The engine performs no I/O: callers load rows
 * from wherever they live (Drizzle, a fixture, a CSV) and hand them in.
 */

export type StatementType = "profit_loss" | "balance_sheet";

/** Income-statement side of a P&L account. Null for balance-sheet accounts. */
export type AccountType = "income" | "expense" | null;

/**
 * The centralized account-level classification `QE - 0004` requires in place of
 * label matching. An account with no role contributes nothing to Reported
 * EBITDA — the safe direction, and the one the legacy regex path got wrong.
 */
export type EbitdaRole =
  | "interest_income"
  | "interest_expense"
  | "income_tax"
  | "depreciation"
  | "amortization"
  | "owner_compensation";

export interface Account {
  id: string;
  name: string;
  statementType: StatementType;
  accountType: AccountType;
  ebitdaRole?: EbitdaRole | null;
}

/**
 * A general-ledger amount for one account, period and (optionally) vendor.
 *
 * `amount` is the raw ledger figure as exported by QuickBooks, where BOTH
 * revenue and expenses arrive positive. The sign convention is applied exactly
 * once, in `income-statement.ts`, using `Account.accountType` — it cannot be
 * inferred from the amount.
 */
export interface GlEntry {
  accountId: string;
  fiscalYear: number;
  /** 1–12. `0` means the row carries no month. */
  month: number;
  amount: number;
  vendor?: string | null;
}

export type DataSource = "company_financials" | "tax_return";
export type EarningsMetric = "adjusted_ebitda" | "sde";
export type Aggregation = "annual" | "monthly";

export interface Period {
  fiscalYear: number;
  /** `null` for an annual column. */
  month: number | null;
  label: string;
}

/** The four sourcing mechanisms `QE - 0004` requires the wizard to gate on. */
export type AddbackKind =
  | "pnl_account_vendor"
  | "balance_sheet_change"
  | "manual_adjustment"
  | "recast";

export type EntryGranularity = "detail" | "smoothed";

export interface Addback {
  id: string;
  kind: AddbackKind;
  dataSource: DataSource;
  /** Category (`personal_expense`, `officer_compensation`, …) — orthogonal to `kind`. */
  typeKey: string;
  name: string;
  linkedAccountId?: string | null;
  /** Empty means the entire account is in scope. */
  vendorScope?: string[];
  granularity: EntryGranularity;
  /** Manual/recast amounts by period key (`"2024"` or `"2024-07"`). */
  values?: Record<string, number>;
  /** Recast only: the normalized post-close value the add-back is measured against. */
  recastNormalizedValue?: number | null;
  groupId?: string | null;
  groupLabel?: string | null;
  explanation?: string | null;
  commentary?: string | null;
}

export interface BridgeLineItem {
  key: string;
  label: string;
  /** Amount per period key. */
  amounts: Record<string, number>;
  commentary?: string | null;
}

export interface BridgeGroup {
  id: string | null;
  label: string | null;
  items: BridgeLineItem[];
  subtotals: Record<string, number>;
}

export interface BridgeResult {
  periods: Period[];
  netIncome: BridgeLineItem;
  /** Interest, D&A and tax lines — always itemized, never pre-aggregated. */
  ebitLines: BridgeLineItem[];
  reportedEbitda: Record<string, number>;
  addbackGroups: BridgeGroup[];
  ownerCompensation: BridgeLineItem | null;
  adjusted: Record<string, number>;
  metric: EarningsMetric;
  metricLabel: string;
  revenue: Record<string, number>;
  margin: Record<string, number>;
  /** Accounts carrying no `ebitdaRole` that a reviewer may want to classify. */
  unflaggedAccounts: string[];
  /** Selectable accounts for the add-back wizard's GL picker. */
  accounts: Array<Pick<Account, "id" | "name" | "statementType" | "ebitdaRole">>;
}
