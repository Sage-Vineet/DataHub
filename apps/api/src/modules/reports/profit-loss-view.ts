import {
  buildIncomeStatement,
  buildPeriods,
  type Account,
  type IncomeStatement,
} from "@datahub/financial-engine";
import type { EngagementData } from "../../shared/engagement.drizzle.js";

/**
 * The Profit & Loss payload the Reports page reads, derived from the ledger.
 *
 * WHAT THIS REPLACES
 * ------------------
 * `backend/src/services/manualGlMultiYearService.js` built the same payload
 * from `manual_gl_staged_transactions`, falling back to a `reporting_snapshots`
 * row when one existed. Neither can answer today: the snapshot table does not
 * exist in the database at all, and the staging table is empty — while
 * `general_ledger_entries` holds 3,723 rows and `chart_of_accounts` 71. So the
 * legacy handler is not a working implementation to preserve; it is a shape to
 * honour, and the numbers come from `@datahub/financial-engine` instead.
 *
 * WHERE IT DISAGREES WITH LEGACY, AND WHY
 * ---------------------------------------
 * Legacy sorted each account into Revenue / COGS / Operating Expenses / Other
 * Expenses with `normalizeProfitLossCategory(category, accountName,
 * accountType)` — a label match against the account's *name* when its type did
 * not settle it. The engine refuses to infer a classification from a label;
 * that refusal is the reason it produces a P&L anyone can tie out, and it is
 * documented at length in `income-statement.ts`. So the split here comes from
 * `Account.accountType` alone:
 *
 *   income  → Revenue          cogs → COGS          expense → Operating Expenses
 *
 * which leaves **Other Expenses empty**. That is a deliberate narrowing, not an
 * omission: legacy's "other" bucket was whatever its regexes caught, and with
 * the bucket empty `Operating Income` equals `Net Profit`, which is
 * arithmetically correct rather than merely consistent. An account that truly
 * belongs below the operating line is reclassified on the chart of accounts —
 * the one place a classification is allowed to come from.
 *
 * SIGNS
 * -----
 * Section metrics carry positive magnitudes for costs (`Gross Profit =
 * Revenue − COGS`), matching the legacy buckets. Account rows do too. Only the
 * "Other Income/Expense" header is negated for display, and it is emitted only
 * when it has children — so today it never is.
 */

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** The four buckets a P&L account can land in. */
export type PlCategory = "Revenue" | "COGS" | "Operating Expenses" | "Other Expenses";

export interface PlYearRow {
  fiscalYear: number;
  Revenue: number;
  COGS: number;
  "Operating Expenses": number;
  "Other Expenses": number;
  "Gross Profit": number;
  "Operating Income": number;
  "Net Profit": number;
}

export interface PlMonthRow extends Omit<PlYearRow, "fiscalYear"> {
  month: string;
  fiscalYear: number;
}

export interface PlSummaryLine {
  key: string;
  label: string;
  valuesByYear: Record<number, number>;
  consolidated: number;
}

export interface PlYearComparison {
  fiscalYear: number;
  revenue: number;
  cogs: number;
  grossProfit: number;
  operatingExpenses: number;
  operatingIncome: number;
  otherExpenses: number;
  netProfit: number;
  netProfitDeltaVsPreviousYear: number;
  netProfitDeltaPctVsPreviousYear: number | null;
}

export interface PlRow {
  id: string;
  name: string;
  type: "header" | "total" | "data";
  amount: number;
  amounts: Record<string, number>;
  children?: PlRow[];
}

export interface ProfitLossSummaryPayload {
  source: string;
  reportType: "profit_loss_summary";
  filters: ProfitLossFilters;
  years: number[];
  displayYear: number | null;
  lines: PlSummaryLine[];
  monthlyBreakdown: PlMonthRow[];
  yearComparison: PlYearComparison[];
  netProfitByYear: Record<number, number>;
  hierarchicalRows: PlRow[];
  yearCols?: Array<{ key: string; label: string }>;
}

export interface ProfitLossFilters {
  /** Years to show as comparative columns. Empty means the latest year alone. */
  fiscalYears?: number[];
}

/** The bucket an account's type puts it in, or null if it is not a P&L account. */
export function categoryOf(account: Pick<Account, "statementType" | "accountType">): PlCategory | null {
  if (account.statementType !== "profit_loss") return null;
  switch (account.accountType) {
    case "income":
      return "Revenue";
    case "cogs":
      return "COGS";
    case "expense":
      return "Operating Expenses";
    default:
      // An unclassified P&L account is not silently binned here; the engine
      // raises `UnclassifiedAccountError` before this presenter runs.
      return null;
  }
}

const emptyBuckets = (): Pick<PlYearRow, PlCategory> => ({
  Revenue: 0,
  COGS: 0,
  "Operating Expenses": 0,
  "Other Expenses": 0,
});

/** `Gross Profit`, `Operating Income` and `Net Profit` from the four buckets. */
export function finalizeLine<T extends Pick<PlYearRow, PlCategory>>(
  bucket: T,
): T & Pick<PlYearRow, "Gross Profit" | "Operating Income" | "Net Profit"> {
  const grossProfit = round2(bucket.Revenue - bucket.COGS);
  const operatingIncome = round2(grossProfit - bucket["Operating Expenses"]);
  return {
    ...bucket,
    "Gross Profit": grossProfit,
    "Operating Income": operatingIncome,
    "Net Profit": round2(operatingIncome - bucket["Other Expenses"]),
  };
}

interface Buckets {
  yearly: PlYearRow[];
  monthly: PlMonthRow[];
}

/** Per-year and per-month bucket totals, from the engine's signed per-account figures. */
function bucketize(engagement: EngagementData, years: number[]): Buckets {
  const byId = new Map(engagement.accounts.map((a) => [a.id, a]));
  const yearly = new Map<number, ReturnType<typeof emptyBuckets> & { fiscalYear: number }>();
  const monthly = new Map<string, ReturnType<typeof emptyBuckets> & { month: string; fiscalYear: number }>();
  const wanted = new Set(years);

  for (const entry of engagement.entries) {
    if (!wanted.has(entry.fiscalYear)) continue;
    const account = byId.get(entry.accountId);
    if (!account) continue;
    const category = categoryOf(account);
    if (!category) continue;

    // The ledger exports revenue AND cost as positive amounts, and the buckets
    // want positive magnitudes for both — so the raw amount is already right.
    const amount = round2(entry.amount);

    let yearRow = yearly.get(entry.fiscalYear);
    if (!yearRow) yearly.set(entry.fiscalYear, (yearRow = { fiscalYear: entry.fiscalYear, ...emptyBuckets() }));
    yearRow[category] = round2(yearRow[category] + amount);

    const month = entry.month;
    if (month === undefined || month === null) continue;
    const monthKey = `${entry.fiscalYear}-${String(month).padStart(2, "0")}`;
    let monthRow = monthly.get(monthKey);
    if (!monthRow) {
      monthly.set(monthKey, (monthRow = { month: monthKey, fiscalYear: entry.fiscalYear, ...emptyBuckets() }));
    }
    monthRow[category] = round2(monthRow[category] + amount);
  }

  return {
    yearly: [...yearly.values()]
      .sort((a, b) => a.fiscalYear - b.fiscalYear)
      .map((row) => finalizeLine(row)),
    monthly: [...monthly.values()]
      .sort((a, b) => a.month.localeCompare(b.month))
      .map((row) => finalizeLine(row)),
  };
}

const METRICS = [
  "Revenue",
  "COGS",
  "Gross Profit",
  "Operating Expenses",
  "Operating Income",
  "Other Expenses",
  "Net Profit",
] as const;

export function buildSummaryLines(yearlyRows: PlYearRow[]): { years: number[]; lines: PlSummaryLine[] } {
  const years = yearlyRows.map((row) => row.fiscalYear).filter(Number.isInteger);
  const lines = METRICS.map((metric) => {
    const valuesByYear: Record<number, number> = {};
    for (const year of years) {
      const row = yearlyRows.find((item) => item.fiscalYear === year);
      valuesByYear[year] = round2(Number(row?.[metric] ?? 0));
    }
    return {
      key: metric.toLowerCase().replace(/\s+/g, "_"),
      label: metric,
      valuesByYear,
      // Legacy's word for "added across every year in view". A running total of
      // gross profit is not a meaningful figure on its own, but the column
      // exists in the payload the page reads, so it is reproduced rather than
      // quietly dropped.
      consolidated: round2(Object.values(valuesByYear).reduce((sum, v) => sum + v, 0)),
    };
  });
  return { years, lines };
}

export function buildYearComparison(yearlyRows: PlYearRow[]): PlYearComparison[] {
  return yearlyRows.map((row, index) => {
    const previous = index > 0 ? yearlyRows[index - 1] : null;
    const delta = round2(row["Net Profit"] - (previous?.["Net Profit"] ?? 0));
    const previousNet = previous ? previous["Net Profit"] : 0;
    return {
      fiscalYear: row.fiscalYear,
      revenue: round2(row.Revenue),
      cogs: round2(row.COGS),
      grossProfit: round2(row["Gross Profit"]),
      operatingExpenses: round2(row["Operating Expenses"]),
      operatingIncome: round2(row["Operating Income"]),
      otherExpenses: round2(row["Other Expenses"]),
      netProfit: round2(row["Net Profit"]),
      netProfitDeltaVsPreviousYear: delta,
      // No previous year, or a previous year that broke exactly even, has no
      // percentage — null rather than zero or Infinity.
      netProfitDeltaPctVsPreviousYear:
        previous && previousNet !== 0 ? round2((delta / Math.abs(previousNet)) * 100) : null,
    };
  });
}

/** Per-account signed totals for the selected years, grouped by bucket. */
interface AccountTotals {
  accountName: string;
  accountNumber: string;
  category: PlCategory;
  totalsByYear: Record<number, number>;
}

function accountTotals(
  engagement: EngagementData,
  income: IncomeStatement,
  years: number[],
): Record<PlCategory, AccountTotals[]> {
  const byCategory: Record<PlCategory, AccountTotals[]> = {
    Revenue: [],
    COGS: [],
    "Operating Expenses": [],
    "Other Expenses": [],
  };

  for (const account of engagement.accounts) {
    const category = categoryOf(account);
    if (!category) continue;
    const signed = income.byAccount.get(account.id);
    if (!signed) continue;

    const totalsByYear: Record<number, number> = {};
    let anything = false;
    for (const year of years) {
      // `byAccount` signs costs negative; these rows want magnitudes, so a
      // cost account is flipped back and revenue is left as it is.
      const raw = signed[String(year)] ?? 0;
      const total = category === "Revenue" ? round2(raw) : round2(-raw);
      totalsByYear[year] = total;
      if (total !== 0) anything = true;
    }
    // An account with no movement in any selected year is not a row.
    if (!anything) continue;
    byCategory[category].push({
      accountName: account.name,
      accountNumber: "",
      category,
      totalsByYear,
    });
  }

  for (const rows of Object.values(byCategory)) {
    rows.sort((a, b) => a.accountName.localeCompare(b.accountName));
  }
  return byCategory;
}

const amountsFromByYear = (
  byYear: Record<number, number>,
  years: readonly number[],
): Record<string, number> =>
  Object.fromEntries(years.map((y) => [`y${y}`, round2(byYear[y] ?? 0)]));

export function buildHierarchicalRows(
  engagement: EngagementData,
  income: IncomeStatement,
  yearlyRows: PlYearRow[],
  years: number[],
): PlRow[] {
  const selected = [...new Set(years)].sort((a, b) => a - b);
  const displayYear = selected.length > 0 ? selected[selected.length - 1]! : null;
  const byCategory = accountTotals(engagement, income, selected);

  const metricByYear = (metric: (typeof METRICS)[number]): Record<number, number> =>
    Object.fromEntries(
      selected.map((y) => [y, round2(yearlyRows.find((r) => r.fiscalYear === y)?.[metric] ?? 0)]),
    );

  // The latest selected year, for the scalar `amount` the older table reads.
  const scalar = (byYear: Record<number, number>): number =>
    displayYear === null ? 0 : round2(byYear[displayYear] ?? 0);

  const sectionNode = (byYear: Record<number, number>) => ({
    amount: scalar(byYear),
    amounts: amountsFromByYear(byYear, selected),
  });

  const toAccountRows = (accounts: AccountTotals[], prefix: string): PlRow[] =>
    accounts.map((acc, i) => ({
      id: `${prefix}-${i}-${acc.accountNumber}`,
      name: acc.accountName,
      type: "data" as const,
      amount: scalar(acc.totalsByYear),
      amounts: amountsFromByYear(acc.totalsByYear, selected),
    }));

  const rows: PlRow[] = [];

  const incomeByYear = metricByYear("Revenue");
  rows.push({
    id: "income",
    name: "Income",
    type: "header",
    ...sectionNode(incomeByYear),
    children: [
      ...toAccountRows(byCategory.Revenue, "inc"),
      { id: "total-income", name: "Total Income", type: "total", ...sectionNode(incomeByYear) },
    ],
  });

  if (byCategory.COGS.length > 0) {
    const cogsByYear = metricByYear("COGS");
    rows.push({
      id: "cogs",
      name: "Cost of Goods Sold",
      type: "header",
      ...sectionNode(cogsByYear),
      children: [
        ...toAccountRows(byCategory.COGS, "cogs"),
        {
          id: "total-cogs",
          name: "Total Cost of Goods Sold",
          type: "total",
          ...sectionNode(cogsByYear),
        },
      ],
    });
  }

  rows.push({
    id: "gross-profit",
    name: "Gross Profit",
    type: "total",
    ...sectionNode(metricByYear("Gross Profit")),
  });

  const expenseByYear = metricByYear("Operating Expenses");
  rows.push({
    id: "expenses",
    name: "Expenses",
    type: "header",
    ...sectionNode(expenseByYear),
    children: [
      ...toAccountRows(byCategory["Operating Expenses"], "exp"),
      { id: "total-expenses", name: "Total Expenses", type: "total", ...sectionNode(expenseByYear) },
    ],
  });

  rows.push({
    id: "net-operating-income",
    name: "Net Operating Income",
    type: "total",
    ...sectionNode(metricByYear("Operating Income")),
  });

  // Emitted only when something sits below the operating line. Nothing does
  // while the split comes from account type alone — see the header comment.
  if (byCategory["Other Expenses"].length > 0) {
    const otherByYear = metricByYear("Other Expenses");
    const displayed = Object.fromEntries(
      selected.map((y) => [y, round2(-(otherByYear[y] ?? 0))]),
    ) as Record<number, number>;
    rows.push({
      id: "other-income-expense",
      name: "Other Income/Expense",
      type: "header",
      ...sectionNode(displayed),
      children: [
        ...toAccountRows(byCategory["Other Expenses"], "other"),
        {
          id: "total-other",
          name: "Total Other Income/Expense",
          type: "total",
          ...sectionNode(displayed),
        },
      ],
    });
  }

  rows.push({
    id: "net-income",
    name: "Net Income",
    type: "total",
    ...sectionNode(metricByYear("Net Profit")),
  });

  return rows;
}

/**
 * The whole payload.
 *
 * `fiscalYears` chooses the comparative columns. With none given the summary
 * shows the latest year alone, which is the behaviour the page has always had.
 */
export function buildProfitLossSummary(
  engagement: EngagementData,
  filters: ProfitLossFilters = {},
): ProfitLossSummaryPayload {
  const explicit = (filters.fiscalYears ?? [])
    .map(Number)
    .filter((y) => Number.isInteger(y) && y > 0)
    .sort((a, b) => a - b);
  const available = engagement.fiscalYears;
  const inScope = explicit.length > 0 ? explicit.filter((y) => available.includes(y)) : available;

  const { yearly, monthly } = bucketize(engagement, inScope);
  const summary = buildSummaryLines(yearly);

  const netProfitByYear: Record<number, number> = {};
  for (const row of yearly) netProfitByYear[row.fiscalYear] = row["Net Profit"];

  const displayYear =
    explicit.length > 0
      ? (explicit[explicit.length - 1] ?? null)
      : (summary.years[summary.years.length - 1] ?? null);
  const rowYears = explicit.length > 0 ? explicit : displayYear ? [displayYear] : [];

  const income = buildIncomeStatement(
    engagement.accounts,
    engagement.entries,
    buildPeriods(engagement.entries, inScope, "annual"),
    "annual",
  );

  return {
    source: "general_ledger_entries",
    reportType: "profit_loss_summary",
    filters,
    years: summary.years,
    displayYear,
    lines: summary.lines,
    monthlyBreakdown: monthly,
    yearComparison: buildYearComparison(yearly),
    netProfitByYear,
    hierarchicalRows: buildHierarchicalRows(engagement, income, yearly, rowYears),
    // Comparative columns appear only when years were asked for explicitly.
    ...(explicit.length > 0
      ? { yearCols: explicit.map((y) => ({ key: `y${y}`, label: String(y) })) }
      : {}),
  };
}
