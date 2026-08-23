import {
  buildCashFlow,
  buildIncomeStatement,
  buildPeriods,
  periodKey,
  rollForwardBalanceSheet,
  type BalanceSheetGroup,
  type BalanceSheetResult,
  type CashFlowStatement,
} from "@datahub/financial-engine";
import type { EngagementData } from "../../shared/engagement.drizzle.js";

/**
 * The financial statements, in the shape the reports view renders.
 *
 * A presenter, not a calculator: every number comes from
 * `@datahub/financial-engine`, and this file only arranges them into the nested
 * sections `FinancialStatementsView` walks (`assets.currentAssets.groups[…]`,
 * `operatingActivities.items[…]`). Keeping the arrangement separate from the
 * arithmetic is what lets the engine be tested against a workbook while this is
 * tested against a contract.
 *
 * The profit-and-loss slot is deliberately left empty — see `buildStatements`.
 */

export interface AccountAmount {
  name: string;
  amount: number;
}

export interface StatementGroup {
  total: number;
  accounts: AccountAmount[];
}

export interface StatementSection {
  total: number;
  groups: Record<string, StatementGroup>;
}

export interface BalanceSheetStatement {
  assets: {
    currentAssets: StatementSection;
    fixedAssets: StatementSection;
    otherAssets: StatementSection;
  };
  liabilities: {
    currentLiabilities: StatementSection;
    longTermLiabilities: StatementSection;
  };
  equity: { total: number; accounts: AccountAmount[] };
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
  totalLiabilitiesAndEquity: number;
}

export interface CashFlowSectionView {
  label: string;
  items: AccountAmount[];
  total: number;
}

export interface CashFlowStatementView {
  operatingActivities: CashFlowSectionView;
  investingActivities: CashFlowSectionView;
  financingActivities: CashFlowSectionView;
  netCashIncrease: number;
  openingCash: number;
  endingCash: number;
}

export interface PeriodEntry<T> {
  year: number;
  month?: string;
  monthNumber?: number;
  statement: T;
}

export interface FinancialStatements {
  companyName: string;
  currency: string;
  reports: {
    profitAndLoss: { yearly: unknown[]; monthly: unknown[] };
    balanceSheet: { yearly: PeriodEntry<BalanceSheetStatement>[]; monthly: PeriodEntry<BalanceSheetStatement>[] };
    cashFlow: { yearly: PeriodEntry<CashFlowStatementView>[]; monthly: PeriodEntry<CashFlowStatementView>[] };
  };
  validation: string[];
  unmappedAccounts: string[];
  missingData: string[];
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Where each balance-sheet group presents on the statement. */
const SECTION_OF_GROUP: Readonly<Record<BalanceSheetGroup, string>> = {
  "Bank Accounts": "assets.currentAssets",
  "Accounts Receivable": "assets.currentAssets",
  "Other Current Assets": "assets.currentAssets",
  "Fixed Assets": "assets.fixedAssets",
  "Other Assets": "assets.otherAssets",
  "Credit Cards": "liabilities.currentLiabilities",
  "Other Current Liabilities": "liabilities.currentLiabilities",
  "Long-term Liabilities": "liabilities.longTermLiabilities",
  Equity: "equity",
};

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const emptySection = (): StatementSection => ({ total: 0, groups: {} });

/** One period's balance sheet, arranged into presentation sections. */
export function toBalanceSheetStatement(
  balanceSheet: BalanceSheetResult,
  key: string,
): BalanceSheetStatement {
  const sections: Record<string, StatementSection> = {
    "assets.currentAssets": emptySection(),
    "assets.fixedAssets": emptySection(),
    "assets.otherAssets": emptySection(),
    "liabilities.currentLiabilities": emptySection(),
    "liabilities.longTermLiabilities": emptySection(),
  };
  const equityAccounts: AccountAmount[] = [];
  let totalEquity = 0;

  for (const line of balanceSheet.lines) {
    const amount = round2(line.balances[key] ?? 0);
    const group = (line.group ?? "Other Current Assets") as BalanceSheetGroup;
    const path = SECTION_OF_GROUP[group] ?? "assets.currentAssets";

    if (path === "equity") {
      equityAccounts.push({ name: line.accountName, amount });
      totalEquity += amount;
      continue;
    }

    const section = sections[path]!;
    const bucket = (section.groups[group] ??= { total: 0, accounts: [] });
    bucket.accounts.push({ name: line.accountName, amount });
    bucket.total = round2(bucket.total + amount);
    section.total = round2(section.total + amount);
  }

  // Retained earnings and current-year income are derived rather than rolled as
  // lines, so the roll-forward carries them separately — and a balance sheet
  // without them does not balance.
  const retained = round2(balanceSheet.retainedEarnings[key] ?? 0);
  const netIncome = round2(balanceSheet.netIncome[key] ?? 0);
  if (retained !== 0) equityAccounts.push({ name: "Retained Earnings", amount: retained });
  if (netIncome !== 0) equityAccounts.push({ name: "Net Income", amount: netIncome });
  totalEquity = round2(totalEquity + retained + netIncome);

  const totalAssets = round2(
    sections["assets.currentAssets"]!.total +
      sections["assets.fixedAssets"]!.total +
      sections["assets.otherAssets"]!.total,
  );
  const totalLiabilities = round2(
    sections["liabilities.currentLiabilities"]!.total +
      sections["liabilities.longTermLiabilities"]!.total,
  );

  return {
    assets: {
      currentAssets: sections["assets.currentAssets"]!,
      fixedAssets: sections["assets.fixedAssets"]!,
      otherAssets: sections["assets.otherAssets"]!,
    },
    liabilities: {
      currentLiabilities: sections["liabilities.currentLiabilities"]!,
      longTermLiabilities: sections["liabilities.longTermLiabilities"]!,
    },
    equity: { total: totalEquity, accounts: equityAccounts },
    totalAssets,
    totalLiabilities,
    totalEquity,
    totalLiabilitiesAndEquity: round2(totalLiabilities + totalEquity),
  };
}

/**
 * One period's cash flow, or a span of them.
 *
 * `keys` is a list so a yearly column can be assembled from its months: the
 * section movements add up, while opening cash comes from the first month and
 * ending cash from the last. Summing those two would be nonsense.
 */
export function toCashFlowStatement(
  cashFlow: CashFlowStatement,
  keys: readonly string[],
): CashFlowStatementView {
  const sum = (record: Record<string, number>): number =>
    round2(keys.reduce((total, key) => total + (record[key] ?? 0), 0));

  const itemsFor = (section: "operating" | "investing" | "financing"): AccountAmount[] =>
    cashFlow.lines
      .filter((line) => line.section === section)
      .map((line) => ({
        name: line.accountName,
        amount: round2(keys.reduce((total, key) => total + (line.amounts[key] ?? 0), 0)),
      }))
      .filter((item) => Math.abs(item.amount) > 0.005);

  const operatingItems = itemsFor("operating");
  // Net income leads the operating section by convention, and is the one line
  // that is not a balance movement.
  operatingItems.unshift({ name: "Net Income", amount: sum(cashFlow.netIncome) });

  const first = keys[0];
  const last = keys[keys.length - 1];

  return {
    operatingActivities: {
      label: "Operating Activities",
      items: operatingItems,
      total: sum(cashFlow.operating),
    },
    investingActivities: {
      label: "Investing Activities",
      items: itemsFor("investing"),
      total: sum(cashFlow.investing),
    },
    financingActivities: {
      label: "Financing Activities",
      items: itemsFor("financing"),
      total: sum(cashFlow.financing),
    },
    netCashIncrease: sum(cashFlow.netChange),
    openingCash: first === undefined ? 0 : round2(cashFlow.openingCash[first] ?? 0),
    endingCash: last === undefined ? 0 : round2(cashFlow.closingCash[last] ?? 0),
  };
}

export interface BuildStatementsOptions {
  /** Restrict to one fiscal year. Omitted means every year in the ledger. */
  year?: number;
  currency?: string;
  companyName?: string;
}

/**
 * Build the statements for an engagement.
 *
 * The profit-and-loss slot is returned EMPTY, and that is deliberate rather
 * than unfinished. The reports view takes its P&L from the income-statement
 * endpoint and discards whatever this returns — because the legacy handler
 * built it from `profit_loss_entries`, a table holding revenue *plus* expenses,
 * and reported $4,975,913 for a year whose net income was $47,568. Returning a
 * second, differently-derived P&L here would put two numbers on the wire and
 * invite someone to trust the wrong one.
 */
export function buildStatements(
  engagement: EngagementData,
  options: BuildStatementsOptions = {},
): FinancialStatements {
  const companyName = options.companyName || engagement.companyName;
  const currency = options.currency || "USD";
  const years = options.year
    ? engagement.fiscalYears.filter((y) => y === options.year)
    : engagement.fiscalYears;

  const missingData: string[] = [];
  if (engagement.accounts.length === 0) {
    missingData.push(
      "Chart of Accounts has no leaf accounts. Generate the COA first (Step 6 in Key Reports).",
    );
  }
  if (years.length === 0) {
    missingData.push(
      `No financial data found for ${options.year ? `FY${options.year}` : "any year"}. ` +
        "Sync your financial documents first.",
    );
  }
  if (engagement.anchors.length === 0) {
    // Without a stated balance sheet there is nothing to roll from, and a
    // roll-forward from zero would be confidently wrong.
    missingData.push(
      "No balance sheet has been ingested, so the balance sheet and cash flow cannot be derived.",
    );
  }

  const empty: FinancialStatements = {
    companyName,
    currency,
    reports: {
      profitAndLoss: { yearly: [], monthly: [] },
      balanceSheet: { yearly: [], monthly: [] },
      cashFlow: { yearly: [], monthly: [] },
    },
    validation: missingData,
    unmappedAccounts: [],
    missingData,
  };
  if (missingData.length > 0) return empty;

  const balanceSheet = rollForwardBalanceSheet({
    accounts: engagement.accounts,
    entries: engagement.entries,
    anchors: engagement.anchors,
    fiscalYears: years,
  });
  const income = buildIncomeStatement(
    engagement.accounts,
    engagement.entries,
    buildPeriods(engagement.entries, years, "monthly"),
    "monthly",
  );
  const cashFlow = buildCashFlow({ income, balanceSheet });

  const monthKeys = balanceSheet.periods.map((p) => ({
    year: p.fiscalYear,
    month: p.month,
    key: periodKey(p.fiscalYear, p.month),
  }));

  const balanceSheetMonthly = monthKeys.map((p) => ({
    year: p.year,
    month: MONTHS[(p.month ?? 1) - 1] ?? "",
    monthNumber: p.month ?? 0,
    statement: toBalanceSheetStatement(balanceSheet, p.key),
  }));
  const cashFlowMonthly = monthKeys.map((p) => ({
    year: p.year,
    month: MONTHS[(p.month ?? 1) - 1] ?? "",
    monthNumber: p.month ?? 0,
    statement: toCashFlowStatement(cashFlow, [p.key]),
  }));

  // A yearly balance sheet is the position at the year's LAST rolled month —
  // a balance sheet is a moment, not a sum. The yearly cash flow is the
  // opposite: every month of movement, added up.
  const balanceSheetYearly: PeriodEntry<BalanceSheetStatement>[] = [];
  const cashFlowYearly: PeriodEntry<CashFlowStatementView>[] = [];
  for (const year of years) {
    const inYear = monthKeys.filter((p) => p.year === year);
    if (inYear.length === 0) continue;
    balanceSheetYearly.push({
      year,
      statement: toBalanceSheetStatement(balanceSheet, inYear[inYear.length - 1]!.key),
    });
    cashFlowYearly.push({
      year,
      statement: toCashFlowStatement(cashFlow, inYear.map((p) => p.key)),
    });
  }

  return {
    companyName,
    currency,
    reports: {
      profitAndLoss: { yearly: [], monthly: [] },
      balanceSheet: { yearly: balanceSheetYearly, monthly: balanceSheetMonthly },
      cashFlow: { yearly: cashFlowYearly, monthly: cashFlowMonthly },
    },
    validation: [],
    unmappedAccounts: [],
    missingData: [],
  };
}
