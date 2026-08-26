import { amountAt, round2 } from "./amounts.js";
import type { Account } from "@datahub/financial-engine";
import type { EngagementData } from "../../shared/engagement.drizzle.js";
import type { LedgerTransaction } from "./ports.js";
import { categoryOf, type PlCategory } from "./profit-loss-view.js";

/**
 * The month-by-month Profit & Loss, with the transactions behind each line.
 *
 * The columns are the twelve months of one fiscal year, and every account row
 * carries the posted rows that made it — which is the point of the view: a
 * reader who does not believe a figure opens it and sees what it is made of.
 *
 * The drill-down's `debit`, `credit`, `description`, `reference` and
 * `journalType` come through as null where the ledger does not carry them.
 * That is the honest rendering of the current extractor: of 3,723 posted rows
 * in the demo ledger every one has a date, 2,295 have a vendor, and not one has
 * a description, reference, journal type or debit/credit split. Legacy read
 * these from a different table and emitted `0` for the missing splits, which
 * reads on the page as "this transaction was zero on both sides" rather than
 * as "nobody recorded it".
 *
 * Signs follow the summary: revenue positive, costs positive as costs.
 */


export const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

export interface DetailTransaction {
  id: string;
  date: string | null;
  vendorName: string | null;
  description: string | null;
  reference: string | null;
  journalType: string | null;
  amount: number;
  debit: number | null;
  credit: number | null;
}

export interface DetailAccount {
  accountName: string;
  accountNumber: string;
  category: PlCategory;
  monthly: Record<number, number>;
  total: number;
  transactions: DetailTransaction[];
}

export interface DetailSection {
  key: string;
  label: string;
  accounts?: DetailAccount[];
  monthlyTotals: Record<number, number>;
  total: number;
  totalLabel?: string;
  isCalculated?: boolean;
}

export interface MonthlyDetailPayload {
  source: string;
  reportType: "profit_loss_monthly_detail";
  year: number | null;
  months: number[];
  monthNames: readonly string[];
  sections: DetailSection[];
  filters: MonthlyDetailFilters;
}

export interface MonthlyDetailFilters {
  fiscalYear?: number;
  /** 1–12. Empty means every month. */
  months?: number[];
}

const ALL_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

/** The months to show: those asked for, or all twelve. */
export function resolveMonths(requested: readonly number[] | undefined): number[] {
  const valid = (requested ?? [])
    .map(Number)
    .filter((m) => Number.isInteger(m) && m >= 1 && m <= 12);
  return valid.length > 0 ? [...new Set(valid)].sort((a, b) => a - b) : ALL_MONTHS;
}

interface Totals {
  monthly: Record<number, number>;
  total: number;
}

const emptyTotals = (months: readonly number[]): Totals => ({
  monthly: Object.fromEntries(months.map((m) => [m, 0])),
  total: 0,
});

const addTo = (totals: Totals, month: number, amount: number): void => {
  totals.monthly[month] = round2((amountAt(totals.monthly, month)) + amount);
  totals.total = round2(totals.total + amount);
};

const combine = (
  months: readonly number[],
  ...parts: Array<{ totals: Totals; sign: 1 | -1 }>
): Totals => ({
  monthly: Object.fromEntries(
    months.map((m) => [
      m,
      round2(parts.reduce((sum, p) => sum + p.sign * (amountAt(p.totals.monthly, m)), 0)),
    ]),
  ),
  total: round2(parts.reduce((sum, p) => sum + p.sign * p.totals.total, 0)),
});

export function buildMonthlyDetail(
  engagement: EngagementData,
  transactions: readonly LedgerTransaction[],
  filters: MonthlyDetailFilters = {},
): MonthlyDetailPayload {
  const months = resolveMonths(filters.months);
  const monthSet = new Set(months);
  const year =
    filters.fiscalYear && engagement.fiscalYears.includes(filters.fiscalYear)
      ? filters.fiscalYear
      : (engagement.fiscalYears[engagement.fiscalYears.length - 1] ?? null);

  const byId = new Map<string, Account>(engagement.accounts.map((a) => [a.id, a]));
  const accounts = new Map<string, DetailAccount>();
  const totals: Record<PlCategory, Totals> = {
    Revenue: emptyTotals(months),
    COGS: emptyTotals(months),
    "Operating Expenses": emptyTotals(months),
    "Other Expenses": emptyTotals(months),
  };

  for (const tx of transactions) {
    if (year === null || tx.fiscalYear !== year) continue;
    if (!monthSet.has(tx.month)) continue;

    const account = byId.get(tx.accountId);
    if (!account) continue;
    const category = categoryOf(account);
    if (!category) continue;

    // The ledger exports revenue and cost both positive, and this view shows a
    // cost as a positive cost — so the raw amount is already what it prints.
    const amount = round2(tx.amount);

    let row = accounts.get(tx.accountId);
    if (!row) {
      accounts.set(
        tx.accountId,
        (row = {
          accountName: account.name,
          accountNumber: "",
          category,
          monthly: Object.fromEntries(months.map((m) => [m, 0])),
          total: 0,
          transactions: [],
        }),
      );
    }
    row.monthly[tx.month] = round2((amountAt(row.monthly, tx.month)) + amount);
    row.total = round2(row.total + amount);
    row.transactions.push({
      id: tx.id,
      date: tx.date,
      vendorName: tx.vendorName,
      description: tx.description,
      reference: tx.reference,
      journalType: tx.journalType,
      amount,
      debit: tx.debit,
      credit: tx.credit,
    });

    addTo(totals[category], tx.month, amount);
  }

  const byCategory = (category: PlCategory): DetailAccount[] =>
    [...accounts.values()]
      .filter((a) => a.category === category)
      .sort((a, b) => a.accountName.localeCompare(b.accountName))
      .map((a) => ({
        ...a,
        // Oldest first, so the drill-down reads as a statement of account.
        transactions: [...a.transactions].sort((x, y) => (x.date ?? "").localeCompare(y.date ?? "")),
      }));

  const grossProfit = combine(
    months,
    { totals: totals.Revenue, sign: 1 },
    { totals: totals.COGS, sign: -1 },
  );
  const netOperating = combine(
    months,
    { totals: grossProfit, sign: 1 },
    { totals: totals["Operating Expenses"], sign: -1 },
  );
  const netIncome = combine(
    months,
    { totals: netOperating, sign: 1 },
    { totals: totals["Other Expenses"], sign: -1 },
  );

  const sections: DetailSection[] = [
    {
      key: "income",
      label: "Income",
      accounts: byCategory("Revenue"),
      monthlyTotals: totals.Revenue.monthly,
      total: totals.Revenue.total,
      totalLabel: "Total For Income",
    },
  ];

  const cogs = byCategory("COGS");
  if (cogs.length > 0) {
    sections.push({
      key: "cogs",
      label: "Cost of Goods Sold",
      accounts: cogs,
      monthlyTotals: totals.COGS.monthly,
      total: totals.COGS.total,
      totalLabel: "Total For Cost of Goods Sold",
    });
  }

  sections.push({
    key: "gross_profit",
    label: "Gross Profit",
    isCalculated: true,
    monthlyTotals: grossProfit.monthly,
    total: grossProfit.total,
  });
  sections.push({
    key: "expenses",
    label: "Expenses",
    accounts: byCategory("Operating Expenses"),
    monthlyTotals: totals["Operating Expenses"].monthly,
    total: totals["Operating Expenses"].total,
    totalLabel: "Total For Expenses",
  });
  sections.push({
    key: "net_operating_income",
    label: "Net Operating Income",
    isCalculated: true,
    monthlyTotals: netOperating.monthly,
    total: netOperating.total,
  });

  // Below the operating line, on the same terms as the summary: emitted only
  // when an account is classified there, which nothing is while the split
  // comes from account type alone.
  const other = byCategory("Other Expenses");
  if (other.length > 0) {
    sections.push({
      key: "other_income_expense",
      label: "Other Income/Expense",
      accounts: other,
      monthlyTotals: totals["Other Expenses"].monthly,
      total: totals["Other Expenses"].total,
      totalLabel: "Total For Other Income/Expense",
    });
  }

  sections.push({
    key: "net_income",
    label: "Net Income",
    isCalculated: true,
    monthlyTotals: netIncome.monthly,
    total: netIncome.total,
  });

  return {
    source: "general_ledger_entries",
    reportType: "profit_loss_monthly_detail",
    year,
    months,
    monthNames: MONTH_NAMES,
    sections,
    filters,
  };
}
