import { periodKey, rollForwardBalanceSheet } from "@datahub/financial-engine";
import type { EngagementData } from "../../shared/engagement.drizzle.js";
import { NoBalanceSheetError } from "./balance-sheet-view.js";
import { MONTH_NAMES, resolveMonths, type DetailTransaction } from "./monthly-detail-view.js";
import type { LedgerTransaction } from "./ports.js";

/**
 * The month-by-month Balance Sheet, with the transactions behind each line.
 *
 * The one thing this view must not do is treat a balance like a movement. Each
 * month's figure is the POSITION at that month's close, so a section's `total`
 * is its last shown month rather than the twelve added together — and the
 * transactions in the drill-down are the movements *within* the month, which
 * do add, but only to the difference between two positions.
 *
 * Because of that, the monthly balances come from the roll-forward and the
 * drill-down comes from the ledger; they answer different questions and are
 * read from different places on purpose.
 */

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export interface BsDetailAccount {
  name: string;
  monthly: Record<number, number>;
  total: number;
  transactions: DetailTransaction[];
}

export interface BsDetailCategory {
  label: string;
  accounts: BsDetailAccount[];
  monthlyTotals: Record<number, number>;
  total: number;
}

export interface BsDetailSection {
  label: string;
  categories: BsDetailCategory[];
  monthlyTotals: Record<number, number>;
  total: number;
}

export interface BalanceSheetMonthlyPayload {
  source: string;
  reportType: "balance_sheet_monthly_detail";
  year: number | null;
  months: number[];
  monthNames: readonly string[];
  sections: {
    Assets: BsDetailSection;
    Liabilities: BsDetailSection;
    Equity: BsDetailSection;
  };
  filters: BalanceSheetMonthlyFilters;
}

export interface BalanceSheetMonthlyFilters {
  fiscalYear?: number;
  months?: number[];
}

const CATEGORY_ORDER: Record<string, readonly string[]> = {
  Assets: ["Bank Accounts", "Accounts Receivable", "Other Current Assets", "Fixed Assets", "Other Assets"],
  Liabilities: ["Credit Cards", "Other Current Liabilities", "Long-term Liabilities"],
  Equity: ["Owner Equity", "Retained Earnings", "Net Income"],
};

type SectionKey = keyof BalanceSheetMonthlyPayload["sections"];

const emptySection = (label: string, months: readonly number[]): BsDetailSection => ({
  label,
  categories: [],
  monthlyTotals: Object.fromEntries(months.map((m) => [m, 0])),
  total: 0,
});

export function buildBalanceSheetMonthlyDetail(
  engagement: EngagementData,
  transactions: readonly LedgerTransaction[],
  filters: BalanceSheetMonthlyFilters = {},
): BalanceSheetMonthlyPayload {
  if (engagement.anchors.length === 0) throw new NoBalanceSheetError();

  const months = resolveMonths(filters.months);
  const year =
    filters.fiscalYear && engagement.fiscalYears.includes(filters.fiscalYear)
      ? filters.fiscalYear
      : (engagement.fiscalYears[engagement.fiscalYears.length - 1] ?? null);

  const sections: BalanceSheetMonthlyPayload["sections"] = {
    Assets: emptySection("Assets", months),
    Liabilities: emptySection("Liabilities", months),
    Equity: emptySection("Equity", months),
  };

  const empty = (): BalanceSheetMonthlyPayload => ({
    source: "general_ledger_entries",
    reportType: "balance_sheet_monthly_detail",
    year,
    months,
    monthNames: MONTH_NAMES,
    sections,
    filters,
  });
  if (year === null) return empty();

  // Rolled over every year the engagement has, because a position part-way
  // through cannot be derived from its own year alone.
  const balanceSheet = rollForwardBalanceSheet({
    accounts: engagement.accounts,
    entries: engagement.entries,
    anchors: engagement.anchors,
    fiscalYears: engagement.fiscalYears,
  });

  /**
   * Which rolled period each shown month reads its position from.
   *
   * The roll-forward only produces months the ledger has activity in, so a
   * quiet month has no period of its own. A balance sheet still has a position
   * in a quiet month — the one it closed the previous month with — and showing
   * zero there would claim the company's bank account emptied and refilled.
   * So each month takes the LAST rolled period at or before it, and months
   * before the engagement's first rolled period take the opening balances.
   */
  const chronological = [...balanceSheet.periods]
    .map((p) => ({ year: p.fiscalYear, month: p.month ?? 12, key: periodKey(p.fiscalYear, p.month) }))
    .sort((a, b) => a.year - b.year || a.month - b.month);

  const keyAsOf = (month: number): string | null => {
    let found: string | null = null;
    for (const period of chronological) {
      if (period.year > year || (period.year === year && period.month > month)) break;
      found = period.key;
    }
    return found;
  };

  /**
   * Current-year income resets at each fiscal year start, so it may only be
   * carried WITHIN the year — before the year's first rolled month it is zero,
   * not last year's result.
   */
  const inYearKeyAsOf = (month: number): string | null => {
    let found: string | null = null;
    for (const period of chronological) {
      if (period.year !== year) continue;
      if (period.month > month) break;
      found = period.key;
    }
    return found;
  };

  const shown = months;
  const lastMonth = shown[shown.length - 1];

  const shownSet = new Set(shown);
  const byAccount = new Map<string, DetailTransaction[]>();
  for (const tx of transactions) {
    if (tx.fiscalYear !== year) continue;
    if (!shownSet.has(tx.month)) continue;
    let list = byAccount.get(tx.accountId);
    if (!list) byAccount.set(tx.accountId, (list = []));
    list.push({
      id: tx.id,
      date: tx.date,
      vendorName: tx.vendorName,
      description: tx.description,
      reference: tx.reference,
      journalType: tx.journalType,
      amount: round2(tx.amount),
      debit: tx.debit,
      credit: tx.credit,
    });
  }

  const categoryFor = (section: BsDetailSection, label: string): BsDetailCategory => {
    let category = section.categories.find((c) => c.label === label);
    if (!category) {
      category = {
        label,
        accounts: [],
        monthlyTotals: Object.fromEntries(months.map((m) => [m, 0])),
        total: 0,
      };
      section.categories.push(category);
    }
    return category;
  };

  const addAccount = (
    sectionKey: SectionKey,
    categoryLabel: string,
    name: string,
    balances: Record<string, number>,
    accountId: string | null,
    options: { resetsEachYear?: boolean; before?: number } = {},
  ): void => {
    const section = sections[sectionKey];
    const category = categoryFor(section, categoryLabel);
    const asOf = options.resetsEachYear ? inYearKeyAsOf : keyAsOf;

    const monthly: Record<number, number> = {};
    for (const month of months) {
      const key = asOf(month);
      const balance =
        key === null ? round2(options.before ?? 0) : round2(balances[key] ?? 0);
      monthly[month] = balance;
      category.monthlyTotals[month] = round2((category.monthlyTotals[month] ?? 0) + balance);
      section.monthlyTotals[month] = round2((section.monthlyTotals[month] ?? 0) + balance);
    }

    const drill = accountId === null ? [] : (byAccount.get(accountId) ?? []);
    category.accounts.push({
      name,
      monthly,
      // A closing position, not a sum of the months.
      total: lastMonth === undefined ? 0 : round2(monthly[lastMonth] ?? 0),
      transactions: [...drill].sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "")),
    });
  };

  for (const line of balanceSheet.lines) {
    const sectionKey: SectionKey =
      line.section === "liability" ? "Liabilities" : line.section === "equity" ? "Equity" : "Assets";
    const label =
      sectionKey === "Equity" ? "Owner Equity" : (line.group ?? "Other Current Assets");
    addAccount(sectionKey, label, line.accountName, line.balances, line.accountId, {
      before: balanceSheet.openingBalances[line.accountId] ?? 0,
    });
  }

  // Derived by the roll-forward rather than rolled as lines. Without them the
  // sheet fails to balance by exactly their sum, in every month.
  addAccount("Equity", "Retained Earnings", "Retained Earnings", balanceSheet.retainedEarnings, null, {
    before: balanceSheet.openingRetainedEarnings,
  });
  addAccount("Equity", "Net Income", "Net Income", balanceSheet.netIncome, null, {
    resetsEachYear: true,
  });

  for (const [key, section] of Object.entries(sections) as Array<[SectionKey, BsDetailSection]>) {
    const order = CATEGORY_ORDER[key] ?? [];
    const rank = new Map(order.map((label, i) => [label, i]));
    section.categories.sort(
      (a, b) => (rank.get(a.label) ?? order.length) - (rank.get(b.label) ?? order.length),
    );
    for (const category of section.categories) {
      category.accounts.sort((a, b) => a.name.localeCompare(b.name));
      category.total = lastMonth === undefined ? 0 : round2(category.monthlyTotals[lastMonth] ?? 0);
    }
    section.total = lastMonth === undefined ? 0 : round2(section.monthlyTotals[lastMonth] ?? 0);
  }

  return empty();
}
