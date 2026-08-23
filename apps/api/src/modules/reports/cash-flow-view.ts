import {
  buildCashFlow,
  buildIncomeStatement,
  buildPeriods,
  periodKey,
  rollForwardBalanceSheet,
  type CashFlowStatement,
} from "@datahub/financial-engine";
import type { EngagementData } from "../../shared/engagement.drizzle.js";
import type { PlRow } from "./profit-loss-view.js";
import { NoBalanceSheetError } from "./balance-sheet-view.js";

/**
 * The Cash Flow payload the Reports page reads.
 *
 * Legacy had three separate cash-flow builders over the staging tables. This
 * has one source: `buildCashFlow`, which is a pure function of the income
 * statement and the balance-sheet roll-forward. That is the point — a cash
 * flow derived from the other two statements cannot disagree with them, where
 * a third independent pass over the ledger can and did.
 *
 * ANNUAL COLUMNS
 * --------------
 * Movements add up across a year's months; cash balances do not. Opening cash
 * for a year is the opening of its FIRST month and ending cash the close of
 * its LAST — summing either would produce a number with no meaning that still
 * looks plausible on the page.
 */

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export interface CfItem {
  label: string;
  yearMovements: Record<number, number>;
}

export interface CfSection {
  label: string;
  items: CfItem[];
  totalByYear: Record<number, number>;
}

export interface CashFlowPayload {
  source: string;
  reportType: "cash_flow";
  filters: CashFlowFilters;
  years: number[];
  sections: { Operating: CfSection; Investing: CfSection; Financing: CfSection };
  netCashChange: Record<number, number>;
  hierarchicalRows: PlRow[];
  yearCols: Array<{ key: string; label: string }>;
  beginningCash: Record<string, number>;
  endingCash: Record<string, number>;
}

export interface CashFlowFilters {
  fiscalYears?: number[];
}

const SECTION_LABELS = {
  Operating: "Operating Activities",
  Investing: "Investing Activities",
  Financing: "Financing Activities",
} as const;

const SECTION_TOTAL_LABELS = {
  Operating: "Net Cash from Operating Activities",
  Investing: "Net Cash from Investing Activities",
  Financing: "Net Cash from Financing Activities",
} as const;

type SectionKey = keyof typeof SECTION_LABELS;
const SECTION_KEYS: SectionKey[] = ["Operating", "Investing", "Financing"];

const amountsFromByYear = (
  byYear: Record<number, number>,
  years: readonly number[],
): Record<string, number> =>
  Object.fromEntries(years.map((y) => [`y${y}`, round2(byYear[y] ?? 0)]));

/** The period keys belonging to each year, in order. */
function keysByYear(
  periods: ReadonlyArray<{ fiscalYear: number; month: number | null }>,
  years: number[],
): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const year of years) {
    const keys = periods
      .filter((p) => p.fiscalYear === year)
      .map((p) => periodKey(p.fiscalYear, p.month));
    if (keys.length > 0) out.set(year, keys);
  }
  return out;
}

export function buildSections(
  cashFlow: CashFlowStatement,
  years: number[],
  keys: Map<number, string[]>,
): CashFlowPayload["sections"] {
  const sumOver = (record: Record<string, number>, year: number): number =>
    round2((keys.get(year) ?? []).reduce((total, key) => total + (record[key] ?? 0), 0));

  const make = (key: SectionKey): CfSection => {
    const totals: Record<string, number> =
      key === "Operating"
        ? cashFlow.operating
        : key === "Investing"
          ? cashFlow.investing
          : cashFlow.financing;

    const items: CfItem[] = [];
    for (const line of cashFlow.lines) {
      if (line.section !== key.toLowerCase()) continue;
      const yearMovements: Record<number, number> = {};
      let moved = false;
      for (const year of years) {
        const value = sumOver(line.amounts, year);
        yearMovements[year] = value;
        // Half a cent is rounding, not a movement.
        if (Math.abs(value) > 0.005) moved = true;
      }
      // An account that did not move in any year on show is not a line.
      if (!moved) continue;
      items.push({ label: line.accountName, yearMovements });
    }
    items.sort((a, b) => a.label.localeCompare(b.label));

    return {
      label: SECTION_LABELS[key],
      items,
      totalByYear: Object.fromEntries(years.map((y) => [y, sumOver(totals, y)])),
    };
  };

  return { Operating: make("Operating"), Investing: make("Investing"), Financing: make("Financing") };
}

export function buildCashFlowRows(
  sections: CashFlowPayload["sections"],
  netIncomeByYear: Record<number, number>,
  netCashChange: Record<number, number>,
  beginningCash: Record<string, number>,
  endingCash: Record<string, number>,
  years: number[],
): PlRow[] {
  const amounts = (byYear: Record<number, number>) => amountsFromByYear(byYear, years);
  const scalar = (byYear: Record<string, number>): number => {
    const last = years[years.length - 1];
    return last === undefined ? 0 : round2(byYear[`y${last}`] ?? 0);
  };

  const rows: PlRow[] = [];

  for (const key of SECTION_KEYS) {
    const section = sections[key];
    const children: PlRow[] = [];

    // Net income leads the operating section by convention, and is the one
    // line that is not a balance movement.
    if (key === "Operating") {
      children.push({
        id: "net-income",
        name: "Net Income",
        type: "data",
        amount: scalar(amounts(netIncomeByYear)),
        amounts: amounts(netIncomeByYear),
      });
    }

    section.items.forEach((item, index) => {
      children.push({
        id: `${key.toLowerCase()}-item-${index}`,
        name: item.label,
        type: "data",
        amount: scalar(amounts(item.yearMovements)),
        amounts: amounts(item.yearMovements),
      });
    });

    const headerAmounts = amounts(section.totalByYear);
    rows.push({
      id: `${key.toLowerCase()}-header`,
      name: section.label,
      type: "header",
      amount: scalar(headerAmounts),
      amounts: headerAmounts,
      children,
    });
    rows.push({
      id: `${key.toLowerCase()}-total`,
      name: SECTION_TOTAL_LABELS[key],
      type: "total",
      amount: scalar(headerAmounts),
      amounts: headerAmounts,
    });
  }

  const changeAmounts = amounts(netCashChange);
  rows.push({
    id: "net-cash-change",
    name: "Net Change in Cash",
    type: "total",
    amount: scalar(changeAmounts),
    amounts: changeAmounts,
  });
  rows.push({
    id: "beginning-cash",
    name: "Beginning Cash",
    type: "data",
    amount: scalar(beginningCash),
    amounts: beginningCash,
  });
  rows.push({
    id: "ending-cash",
    name: "Ending Cash",
    type: "total",
    amount: scalar(endingCash),
    amounts: endingCash,
  });

  return rows;
}

export function buildCashFlowReport(
  engagement: EngagementData,
  filters: CashFlowFilters = {},
): CashFlowPayload {
  // The cash flow is a function of the balance sheet, so it inherits the
  // balance sheet's precondition exactly.
  if (engagement.anchors.length === 0) throw new NoBalanceSheetError();

  const explicit = (filters.fiscalYears ?? [])
    .map(Number)
    .filter((y) => Number.isInteger(y) && y > 0)
    .sort((a, b) => a - b);
  const available = engagement.fiscalYears;
  const inScope = explicit.length > 0 ? explicit.filter((y) => available.includes(y)) : available;

  // Rolled over every year the engagement has, for the reason the balance
  // sheet is: a position part-way through cannot be derived from its own year.
  const balanceSheet = rollForwardBalanceSheet({
    accounts: engagement.accounts,
    entries: engagement.entries,
    anchors: engagement.anchors,
    fiscalYears: available,
  });
  const income = buildIncomeStatement(
    engagement.accounts,
    engagement.entries,
    buildPeriods(engagement.entries, available, "monthly"),
    "monthly",
  );
  const cashFlow = buildCashFlow({ income, balanceSheet });

  const keys = keysByYear(balanceSheet.periods, inScope);
  const years = inScope.filter((y) => keys.has(y));
  const sections = buildSections(cashFlow, years, keys);

  const sumOver = (record: Record<string, number>, year: number): number =>
    round2((keys.get(year) ?? []).reduce((total, key) => total + (record[key] ?? 0), 0));

  const netCashChange: Record<number, number> = {};
  const netIncomeByYear: Record<number, number> = {};
  const beginningCash: Record<string, number> = {};
  const endingCash: Record<string, number> = {};

  for (const year of years) {
    netCashChange[year] = sumOver(cashFlow.netChange, year);
    netIncomeByYear[year] = sumOver(cashFlow.netIncome, year);

    // Balances, not movements: the first month's opening and the last month's
    // close. Adding them across the year would be meaningless.
    const yearKeys = keys.get(year) ?? [];
    const first = yearKeys[0];
    const last = yearKeys[yearKeys.length - 1];
    beginningCash[`y${year}`] = first === undefined ? 0 : round2(cashFlow.openingCash[first] ?? 0);
    endingCash[`y${year}`] = last === undefined ? 0 : round2(cashFlow.closingCash[last] ?? 0);
  }

  return {
    source: "general_ledger_entries",
    reportType: "cash_flow",
    filters,
    years,
    sections,
    netCashChange,
    hierarchicalRows: buildCashFlowRows(
      sections,
      netIncomeByYear,
      netCashChange,
      beginningCash,
      endingCash,
      years,
    ),
    yearCols: years.map((y) => ({ key: `y${y}`, label: String(y) })),
    beginningCash,
    endingCash,
  };
}
