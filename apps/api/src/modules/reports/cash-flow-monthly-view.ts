import {
  buildCashFlow,
  buildIncomeStatement,
  buildPeriods,
  periodKey,
  rollForwardBalanceSheet,
} from "@datahub/financial-engine";
import type { EngagementData } from "../../shared/engagement.drizzle.js";
import { NoBalanceSheetError } from "./balance-sheet-view.js";
import { MONTH_NAMES, resolveMonths } from "./monthly-detail-view.js";

/**
 * The month-by-month Cash Flow.
 *
 * Section labels here are "Operating Activities", while the yearly view says
 * "Cash Flow from Operating Activities". That is not an oversight to tidy: the
 * two views are rendered by different components which print `label` verbatim,
 * and legacy said different things in each. Making them agree would change what
 * one of the two pages reads.
 *
 * Beginning cash for a month is the PREVIOUS month's close, and for the first
 * month shown it is the opening balance — which is why the columns have to be
 * walked in order rather than each derived independently.
 */

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export interface CfMonthlyAccount {
  accountName: string;
  monthly: Record<number, number>;
  total: number;
}

export interface CfMonthlySection {
  key: string;
  label: string;
  accounts?: CfMonthlyAccount[];
  monthlyTotals: Record<number, number>;
  total: number;
  totalLabel?: string;
  isCalculated?: boolean;
}

export interface CashFlowMonthlyPayload {
  source: string;
  reportType: "cash_flow_monthly_detail";
  year: number | null;
  months: number[];
  monthNames: readonly string[];
  sections: CfMonthlySection[];
  filters: CashFlowMonthlyFilters;
}

export interface CashFlowMonthlyFilters {
  fiscalYear?: number;
  months?: number[];
}

const SECTIONS = [
  { key: "operating", label: "Operating Activities", engine: "operating" as const, name: "Operating" },
  { key: "investing", label: "Investing Activities", engine: "investing" as const, name: "Investing" },
  { key: "financing", label: "Financing Activities", engine: "financing" as const, name: "Financing" },
];

export function buildCashFlowMonthlyDetail(
  engagement: EngagementData,
  filters: CashFlowMonthlyFilters = {},
): CashFlowMonthlyPayload {
  if (engagement.anchors.length === 0) throw new NoBalanceSheetError();

  const months = resolveMonths(filters.months);
  const year =
    filters.fiscalYear && engagement.fiscalYears.includes(filters.fiscalYear)
      ? filters.fiscalYear
      : (engagement.fiscalYears[engagement.fiscalYears.length - 1] ?? null);

  const shell = (sections: CfMonthlySection[]): CashFlowMonthlyPayload => ({
    source: "general_ledger_entries",
    reportType: "cash_flow_monthly_detail",
    year,
    months,
    monthNames: MONTH_NAMES,
    sections,
    filters,
  });
  if (year === null) return shell([]);

  const balanceSheet = rollForwardBalanceSheet({
    accounts: engagement.accounts,
    entries: engagement.entries,
    anchors: engagement.anchors,
    fiscalYears: engagement.fiscalYears,
  });
  const income = buildIncomeStatement(
    engagement.accounts,
    engagement.entries,
    buildPeriods(engagement.entries, engagement.fiscalYears, "monthly"),
    "monthly",
  );
  const cashFlow = buildCashFlow({ income, balanceSheet });

  // Months the roll-forward produced. A month with no rolled period had no
  // movement, which for a FLOW statement really is zero — unlike a balance
  // sheet, where it means the position held.
  const rolled = new Set(
    balanceSheet.periods.filter((p) => p.fiscalYear === year).map((p) => p.month),
  );
  const keyOf = (month: number): string | null =>
    rolled.has(month) ? periodKey(year, month) : null;

  const at = (record: Record<string, number>, month: number): number => {
    const key = keyOf(month);
    return key === null ? 0 : round2(record[key] ?? 0);
  };
  const sumMonths = (values: Record<number, number>): number =>
    round2(months.reduce((total, m) => total + (values[m] ?? 0), 0));

  const sections: CfMonthlySection[] = [];

  for (const section of SECTIONS) {
    const accounts: CfMonthlyAccount[] = [];

    // Net income leads the operating section, as it does on the yearly view.
    if (section.key === "operating") {
      const monthly = Object.fromEntries(months.map((m) => [m, at(cashFlow.netIncome, m)]));
      accounts.push({ accountName: "Net Income", monthly, total: sumMonths(monthly) });
    }

    for (const line of cashFlow.lines) {
      if (line.section !== section.engine) continue;
      const monthly = Object.fromEntries(months.map((m) => [m, at(line.amounts, m)]));
      const total = sumMonths(monthly);
      // An account that did not move in the window is not a line.
      if (Math.abs(total) <= 0.005 && months.every((m) => Math.abs(monthly[m] ?? 0) <= 0.005)) {
        continue;
      }
      accounts.push({ accountName: line.accountName, monthly, total });
    }
    accounts.sort((a, b) => {
      // Net income stays first whatever it is called.
      if (a.accountName === "Net Income") return -1;
      if (b.accountName === "Net Income") return 1;
      return a.accountName.localeCompare(b.accountName);
    });

    const totals: Record<string, number> =
      section.engine === "operating"
        ? cashFlow.operating
        : section.engine === "investing"
          ? cashFlow.investing
          : cashFlow.financing;
    const monthlyTotals = Object.fromEntries(months.map((m) => [m, at(totals, m)]));

    sections.push({
      key: section.key,
      label: section.label,
      accounts,
      monthlyTotals,
      total: sumMonths(monthlyTotals),
      totalLabel: `Net Cash from ${section.name} Activities`,
    });
  }

  const netCashMonthly = Object.fromEntries(
    months.map((m) => [
      m,
      round2(sections.reduce((total, s) => total + (s.monthlyTotals[m] ?? 0), 0)),
    ]),
  );
  sections.push({
    key: "net_cash_change",
    label: "Net Change in Cash",
    isCalculated: true,
    monthlyTotals: netCashMonthly,
    total: sumMonths(netCashMonthly),
  });

  // Walked in order: each month opens where the previous one closed, and the
  // first opens at the balance carried into it.
  const endingCash: Record<number, number> = {};
  const beginningCash: Record<number, number> = {};
  let carried: number | null = null;
  for (const month of months) {
    const key = keyOf(month);
    const opening: number =
      carried !== null ? carried : key === null ? 0 : round2(cashFlow.openingCash[key] ?? 0);
    const closing: number = key === null ? opening : round2(cashFlow.closingCash[key] ?? 0);
    beginningCash[month] = opening;
    endingCash[month] = closing;
    carried = closing;
  }

  const firstMonth = months[0];
  const lastMonth = months[months.length - 1];
  sections.push({
    key: "beginning_cash",
    label: "Beginning Cash",
    isCalculated: true,
    monthlyTotals: beginningCash,
    // A balance, so the year's figure is the first month's opening.
    total: firstMonth === undefined ? 0 : (beginningCash[firstMonth] ?? 0),
  });
  sections.push({
    key: "ending_cash",
    label: "Ending Cash",
    isCalculated: true,
    monthlyTotals: endingCash,
    // Likewise the last month's close, never the sum.
    total: lastMonth === undefined ? 0 : (endingCash[lastMonth] ?? 0),
  });

  return shell(sections);
}
