import {
  cellOf,
  flattenReportRows,
  toAmount,
  type QuickBooksReportRow,
} from "./quickbooks-report-rows.js";

/**
 * The handful of figures a tax reconciliation compares against a return.
 *
 * A profit-and-loss carries hundreds of lines and a return carries nine. This
 * pulls out those nine, so the two can be set side by side.
 *
 * THE DOUBLE COUNT THIS EXISTS TO FIX
 * -----------------------------------
 * The version this replaces walked the tree and, for each row, BOTH recursed
 * into its children AND matched the row itself. For the figures it accumulated
 * with `+=` — officer wages, depreciation, amortization, interest — a section
 * and its own children were both counted.
 *
 * Concretely: a P&L with a "Depreciation" section containing "Depreciation —
 * Vehicles" and "Depreciation — Equipment", plus the section's own total, added
 * all three. Depreciation came out at twice its real value, every add-back
 * built on it was wrong, and the statement still balanced because nothing else
 * used the figure.
 *
 * Here, a match at the OUTERMOST level wins and nothing beneath it is added.
 * A section total is the section; its children are its detail.
 *
 * AND THE AMOUNTS WERE READ WITH `Number()`
 * -----------------------------------------
 * `Number("1,234.56") || 0` is 0. Any P&L whose figures carry thousands
 * separators read as ZERO throughout — not an error, a report of a company
 * with no revenue and no costs.
 */

/** The figures a tax reconciliation needs. */
export interface ProfitAndLossSummary {
  totalRevenue: number;
  totalCostOfGoodsSold: number;
  grossProfit: number;
  officerWages: number;
  depreciation: number;
  amortization: number;
  interestExpense: number;
  interestIncome: number;
  netIncome: number;
  /**
   * Everything not named above.
   *
   * Derived rather than matched, so the nine figures always add up to the
   * statement: gross profit less the named costs less net income is whatever
   * is left. A matched "other expenses" line would agree with that sum only by
   * luck, and disagree silently when it did not.
   */
  allOtherExpenses: number;
}

type SummaryKey = Exclude<keyof ProfitAndLossSummary, "allOtherExpenses">;

/**
 * How each figure is recognised, in priority order.
 *
 * `exact` matches the whole label; `contains` needs every term present. Exact
 * first, because "Total Income" is the revenue line and "Total Other Income"
 * is not, and a `contains` rule for "income" claims both.
 */
interface Matcher {
  key: SummaryKey;
  exact?: readonly string[];
  contains?: readonly string[];
  /** Terms that disqualify a match, however well the rest fits. */
  excludes?: readonly string[];
}

const MATCHERS: readonly Matcher[] = [
  { key: "totalRevenue", exact: ["total income", "total revenue"] },
  {
    key: "totalCostOfGoodsSold",
    exact: ["total cost of goods sold", "cost of goods sold", "total cogs"],
  },
  { key: "grossProfit", exact: ["gross profit"] },
  { key: "netIncome", exact: ["net income"] },
  {
    key: "officerWages",
    contains: ["officer"],
    // "Officer" alone catches "Officer Life Insurance", which is a benefit
    // rather than wages and belongs in other expenses.
    excludes: ["insurance"],
  },
  { key: "amortization", contains: ["amortization"] },
  {
    key: "depreciation",
    contains: ["depreciation"],
    // A combined "Depreciation and Amortization" line is claimed by the
    // amortization matcher above, which runs first. Splitting a combined line
    // between the two would be a guess at a ratio nobody stated.
    excludes: ["amortization"],
  },
  { key: "interestIncome", contains: ["interest", "income"] },
  { key: "interestExpense", contains: ["interest"], excludes: ["income"] },
];

/** The label of a row, as the matchers compare it. */
function labelOf(row: QuickBooksReportRow): string {
  // The first non-empty cell. A summary's label sits there, as does a data
  // row's account name, whatever the column set.
  return (row.cells.find((cell) => cell !== "") ?? "").toLowerCase().trim();
}

const AMOUNT_TYPES = ["subt_nat_amount", "nat_amount", "amount", "subt_nat_home_amount"] as const;
const AMOUNT_TITLES = ["total", "amount"] as const;

/**
 * The amount on a row.
 *
 * By column type where the report says one, and otherwise the LAST readable
 * cell — a summary row's figure sits at the end of its line, and a summary
 * often carries fewer cells than the column set, so a positional read finds
 * nothing.
 */
function amountOf(row: QuickBooksReportRow): number | null {
  const byColumn = toAmount(cellOf(row, AMOUNT_TYPES, AMOUNT_TITLES));
  if (byColumn !== null) return byColumn;
  for (let i = row.cells.length - 1; i >= 1; i -= 1) {
    const value = toAmount(row.cells[i]);
    if (value !== null) return value;
  }
  return null;
}

function matches(matcher: Matcher, label: string): boolean {
  if (matcher.excludes?.some((term) => label.includes(term))) return false;
  if (matcher.exact?.some((term) => label === term)) return true;
  if (matcher.contains && matcher.contains.every((term) => label.includes(term))) return true;
  return false;
}

/**
 * Read the summary figures out of a profit-and-loss report.
 *
 * Rows are visited outermost first, and once a figure has been taken from a
 * row nothing beneath that row contributes to it — which is what stops a
 * section and its children both counting.
 */
export function readProfitAndLossSummary(report: unknown): ProfitAndLossSummary {
  const found: Partial<Record<SummaryKey, number>> = {};
  /** The depth and path at which each figure was claimed. */
  const claimedAt: Partial<Record<SummaryKey, { depth: number; path: string }>> = {};

  const rows = flattenReportRows(report);
  // Shallowest first, so an outer section is considered before its contents.
  // A stable sort keeps report order within a depth, so two candidates at the
  // same level resolve the same way every time.
  const ordered = [...rows].sort((a, b) => a.depth - b.depth);

  for (const row of ordered) {
    // A header carries a label and sometimes a figure, but its figure is the
    // section's opening balance rather than its total. Only data rows and
    // summaries carry figures worth reading.
    if (row.kind === "header") continue;

    const label = labelOf(row);
    if (label === "") continue;

    for (const matcher of MATCHERS) {
      if (!matches(matcher, label)) continue;

      const amount = amountOf(row);
      if (amount === null) break;

      const claimed = claimedAt[matcher.key];
      const path = row.sectionPath.join(" > ");

      if (claimed === undefined) {
        found[matcher.key] = amount;
        claimedAt[matcher.key] = { depth: row.depth, path };
        break;
      }

      // Already claimed. A row nested INSIDE the claiming row is that row's
      // own detail and is already included in it; a row elsewhere in the
      // report is a separate occurrence and adds.
      const isBeneath = path.startsWith(claimed.path) && row.depth > claimed.depth;
      if (!isBeneath) {
        found[matcher.key] = (found[matcher.key] ?? 0) + amount;
      }
      break;
    }
  }

  const summary = {
    totalRevenue: found.totalRevenue ?? 0,
    totalCostOfGoodsSold: found.totalCostOfGoodsSold ?? 0,
    grossProfit: found.grossProfit ?? 0,
    officerWages: found.officerWages ?? 0,
    depreciation: found.depreciation ?? 0,
    amortization: found.amortization ?? 0,
    interestExpense: found.interestExpense ?? 0,
    interestIncome: found.interestIncome ?? 0,
    netIncome: found.netIncome ?? 0,
  };

  return {
    ...summary,
    // Whatever gross profit leaves once the named costs and the profit itself
    // are taken out. Derived rather than matched so the nine figures always
    // reconcile to the statement.
    allOtherExpenses: round2(
      summary.grossProfit -
        summary.officerWages -
        summary.depreciation -
        summary.amortization -
        summary.interestExpense -
        summary.netIncome,
    ),
  };
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** The labels the tax-reconciliation page puts down its left-hand column. */
export const TAX_RECONCILIATION_LABELS = [
  "Total Revenue",
  "Total Cost of Goods Sold",
  "Gross Profit",
  "Officer Wages",
  "Depreciation Expense",
  "Amortization Expense",
  "Total Interest Expense",
  "All Other Expenses",
  "Net Income",
] as const;

/** The summary as the page's rows, in the order it renders them. */
export function toTaxReconciliationRows(
  summary: ProfitAndLossSummary,
): Array<{ label: string; pl: number }> {
  const byLabel: Record<string, number> = {
    "Total Revenue": summary.totalRevenue,
    "Total Cost of Goods Sold": summary.totalCostOfGoodsSold,
    "Gross Profit": summary.grossProfit,
    "Officer Wages": summary.officerWages,
    "Depreciation Expense": summary.depreciation,
    "Amortization Expense": summary.amortization,
    "Total Interest Expense": summary.interestExpense,
    "All Other Expenses": summary.allOtherExpenses,
    "Net Income": summary.netIncome,
  };
  return TAX_RECONCILIATION_LABELS.map((label) => ({ label, pl: byLabel[label] ?? 0 }));
}
