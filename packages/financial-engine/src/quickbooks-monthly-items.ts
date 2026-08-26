import {
  flattenReportRows,
  toAmount,
  type QuickBooksReportRow,
} from "./quickbooks-report-rows.js";

/**
 * A month-by-month profit-and-loss, as pickable line items.
 *
 * The bank reconciliation's add-back picker offers every income and expense
 * account with its monthly figures, so somebody can pull one into the
 * reconciliation. This turns a `summarize_column_by=Month` report into that
 * list.
 *
 * TWO THINGS THE VERSION THIS REPLACES GOT WRONG
 * ----------------------------------------------
 * Amounts went through `parseFloat(str.replace(/,/g, ""))`, which handles
 * thousands separators and NOT accounting parentheses. `(1,200.00)` parsed as
 * `1200` — POSITIVE. A credit note or a refund read as a cost of the same
 * size, and the month's total moved by twice the figure in the wrong
 * direction.
 *
 * And the income and expense sections were matched by exact label — `"income"`
 * and `"expenses"`. A company whose P&L labels them "Revenue" or "Operating
 * Expenses" produced an EMPTY picker, with nothing to say why.
 */

/** One account, with what it did each month. */
export interface MonthlyLineItem {
  name: string;
  /** `pl_income` or `pl_expense`, so the picker can group them. */
  source: "pl_income" | "pl_expense";
  /** Month key (`YYYY-MM`) to amount. Months with nothing are absent. */
  monthAmounts: Record<string, number>;
}

export interface MonthlyLineItems {
  plIncomeItems: MonthlyLineItem[];
  plExpenseItems: MonthlyLineItem[];
  /** Every income item's months, added up. */
  plTotalIncome: Record<string, number>;
  plTotalExpenses: Record<string, number>;
}

const MONTHS: Readonly<Record<string, string>> = {
  jan: "01",
  feb: "02",
  mar: "03",
  apr: "04",
  may: "05",
  jun: "06",
  jul: "07",
  aug: "08",
  sep: "09",
  oct: "10",
  nov: "11",
  dec: "12",
};

/**
 * A column title as a month key.
 *
 * QuickBooks writes `"Jan 2026"`. Anything else — `"Total"`, a blank, a date
 * range — is not a month and returns null rather than a guess, because a
 * mis-parsed column puts a whole month's figures under the wrong key and the
 * total still adds up.
 */
export function monthKeyOf(title: string | null | undefined): string | null {
  const match = String(title ?? "")
    .trim()
    .match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{4})$/);
  if (!match) return null;
  const month = MONTHS[match[1]!.toLowerCase()];
  return month ? `${match[2]}-${month}` : null;
}

/** Every month between two, inclusive. */
export function monthsBetween(start: string, end: string): string[] {
  const [startYear, startMonth] = start.split("-").map(Number);
  const [endYear, endMonth] = end.split("-").map(Number);
  if (
    !Number.isInteger(startYear) ||
    !Number.isInteger(startMonth) ||
    !Number.isInteger(endYear) ||
    !Number.isInteger(endMonth)
  ) {
    return [];
  }

  const out: string[] = [];
  for (let year = startYear!; year <= endYear!; year += 1) {
    const from = year === startYear ? startMonth! : 1;
    const to = year === endYear ? endMonth! : 12;
    for (let month = from; month <= to; month += 1) {
      out.push(`${year}-${String(month).padStart(2, "0")}`);
    }
  }
  return out;
}

/**
 * Which section a top-level heading is.
 *
 * Matched loosely rather than exactly. A P&L labels its sections "Income",
 * "Revenue", "Sales", "Expenses", "Operating Expenses" or "Cost of Sales"
 * depending on the company's chart, and an exact match on two of those
 * produced an empty picker with nothing to say why.
 *
 * Cost of sales counts as an expense: it is a cost, and a picker that omits it
 * cannot offer the add-backs most often taken against it.
 */
export function sectionKindOf(label: string | null | undefined): MonthlyLineItem["source"] | null {
  const text = String(label ?? "")
    .trim()
    .toLowerCase();
  if (text === "") return null;
  // Expense first: "cost of sales" contains "sales", and reading it as income
  // would put every cost on the revenue side.
  if (/expense|cost of (goods|sales)|\bcogs\b|overhead/.test(text)) return "pl_expense";
  if (/income|revenue|\bsales\b|turnover/.test(text)) return "pl_income";
  return null;
}

/** The column index for each month, from the report's own column list. */
function monthColumns(report: unknown): Map<number, string> {
  const columns = (report as { Columns?: { Column?: unknown } })?.Columns?.Column;
  const list = Array.isArray(columns) ? columns : columns ? [columns] : [];
  const out = new Map<number, string>();
  list.forEach((column, index) => {
    const title = (column as { ColTitle?: unknown })?.ColTitle;
    const key = monthKeyOf(typeof title === "string" ? title : "");
    // The TOTAL column is deliberately not a month: adding it to the months
    // would double every figure in the row's own sum.
    if (key) out.set(index, key);
  });
  return out;
}

const labelOf = (row: QuickBooksReportRow): string => row.cells[0] ?? "";

/**
 * Read a monthly P&L into pickable line items.
 *
 * Only DATA rows become items: a section's summary is its children added up,
 * and offering both in a picker lets somebody add a total and one of its parts
 * as two separate add-backs.
 */
export function readMonthlyLineItems(report: unknown): MonthlyLineItems {
  const columns = monthColumns(report);
  const plIncomeItems: MonthlyLineItem[] = [];
  const plExpenseItems: MonthlyLineItem[] = [];

  for (const row of flattenReportRows(report)) {
    if (row.kind !== "data") continue;

    // The outermost section decides which side this is. A nested "Cost of
    // Sales" under "Expenses" is still an expense.
    const kind = row.sectionPath.map(sectionKindOf).find((k) => k !== null) ?? null;
    if (!kind) continue;

    const name = labelOf(row).trim();
    if (name === "") continue;

    const monthAmounts: Record<string, number> = {};
    for (const [index, monthKey] of columns) {
      const amount = toAmount(row.cells[index]);
      // A month with nothing in it is left out rather than stored as zero:
      // the picker renders a blank cell, and a stored zero renders as "0.00",
      // which reads as a figure somebody checked.
      if (amount !== null && amount !== 0) monthAmounts[monthKey] = amount;
    }

    const item: MonthlyLineItem = { name, source: kind, monthAmounts };
    if (kind === "pl_income") plIncomeItems.push(item);
    else plExpenseItems.push(item);
  }

  return {
    plIncomeItems,
    plExpenseItems,
    plTotalIncome: totalsOf(plIncomeItems),
    plTotalExpenses: totalsOf(plExpenseItems),
  };
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

function totalsOf(items: readonly MonthlyLineItem[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const item of items) {
    for (const [month, amount] of Object.entries(item.monthAmounts)) {
      totals[month] = round2((totals[month] ?? 0) + amount);
    }
  }
  return totals;
}
