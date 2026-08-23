import { describe, expect, it } from "vitest";
import type { Account, BalanceSheetAnchor, GlEntry } from "@datahub/financial-engine";
import type { EngagementData } from "../../shared/engagement.drizzle.js";
import { NoBalanceSheetError } from "./balance-sheet-view.js";
import { buildCashFlowMonthlyDetail } from "./cash-flow-monthly-view.js";

/**
 * The month-by-month Cash Flow.
 *
 * A flow statement chains: each month opens where the last one closed. That
 * makes the columns dependent on each other in a way the balance sheet's are
 * not, and it is what the assertions here are mostly about.
 */

const accounts: Account[] = [
  { id: "cash", name: "Operating Cash", statementType: "balance_sheet", accountType: "asset", group: "Bank Accounts" },
  { id: "equip", name: "Equipment", statementType: "balance_sheet", accountType: "asset", group: "Fixed Assets" },
  { id: "loan", name: "Bank Loan", statementType: "balance_sheet", accountType: "liability", group: "Long-term Liabilities" },
  { id: "capital", name: "Owner Capital", statementType: "balance_sheet", accountType: "equity", group: "Equity" },
  { id: "sales", name: "Sales", statementType: "profit_loss", accountType: "income" },
  { id: "rent", name: "Rent", statementType: "profit_loss", accountType: "expense" },
];

const entries: GlEntry[] = [
  { accountId: "sales", fiscalYear: 2024, month: 1, amount: 1000 },
  { accountId: "cash", fiscalYear: 2024, month: 1, amount: 1000 },
  { accountId: "rent", fiscalYear: 2024, month: 2, amount: 400 },
  { accountId: "cash", fiscalYear: 2024, month: 2, amount: -400 },
  { accountId: "equip", fiscalYear: 2024, month: 3, amount: 500 },
  { accountId: "cash", fiscalYear: 2024, month: 3, amount: -500 },
  { accountId: "loan", fiscalYear: 2024, month: 4, amount: -200 },
  { accountId: "cash", fiscalYear: 2024, month: 4, amount: -200 },
];

const opening: BalanceSheetAnchor = {
  kind: "starting",
  fiscalYear: 2023,
  month: 12,
  rows: [
    { accountId: "cash", accountName: "Operating Cash", section: "asset", group: "Bank Accounts", amount: 2000 },
    { accountId: "equip", accountName: "Equipment", section: "asset", group: "Fixed Assets", amount: 3000 },
    { accountId: "loan", accountName: "Bank Loan", section: "liability", group: "Long-term Liabilities", amount: 1500 },
    { accountId: "capital", accountName: "Owner Capital", section: "equity", group: "Equity", amount: 3500 },
  ],
};

const engagement: EngagementData = {
  companyId: "co-1",
  companyName: "Acme",
  profitMetric: "adjusted_ebitda",
  marketRateReplacementSalary: null,
  fiscalYears: [2024],
  accounts,
  entries,
  anchors: [opening],
};

const sectionOf = (payload: ReturnType<typeof buildCashFlowMonthlyDetail>, key: string) =>
  payload.sections.find((s) => s.key === key)!;

describe("without a stated position", () => {
  it("refuses, as its yearly counterpart does", () => {
    expect(() => buildCashFlowMonthlyDetail({ ...engagement, anchors: [] })).toThrow(
      NoBalanceSheetError,
    );
  });
});

describe("the monthly cash flow", () => {
  const payload = buildCashFlowMonthlyDetail(engagement, { fiscalYear: 2024 });

  it("chains: each month opens where the previous one closed", () => {
    // The identity that makes the statement readable down the page rather than
    // only across it.
    const beginning = sectionOf(payload, "beginning_cash").monthlyTotals;
    const ending = sectionOf(payload, "ending_cash").monthlyTotals;
    for (let i = 1; i < payload.months.length; i++) {
      const month = payload.months[i]!;
      const previous = payload.months[i - 1]!;
      expect(beginning[month]).toBeCloseTo(ending[previous]!, 2);
    }
  });

  it("reconciles each month: opening plus the change equals closing", () => {
    const beginning = sectionOf(payload, "beginning_cash").monthlyTotals;
    const ending = sectionOf(payload, "ending_cash").monthlyTotals;
    const change = sectionOf(payload, "net_cash_change").monthlyTotals;
    for (const month of payload.months) {
      expect(beginning[month]! + change[month]!).toBeCloseTo(ending[month]!, 2);
    }
  });

  it("adds the three sections to the net change, month by month", () => {
    const change = sectionOf(payload, "net_cash_change").monthlyTotals;
    for (const month of payload.months) {
      const summed = ["operating", "investing", "financing"].reduce(
        (total, key) => total + (sectionOf(payload, key).monthlyTotals[month] ?? 0),
        0,
      );
      expect(change[month]).toBeCloseTo(summed, 2);
    }
  });

  it("tracks the cash the ledger moved, month by month", () => {
    const ending = sectionOf(payload, "ending_cash").monthlyTotals;
    expect(sectionOf(payload, "beginning_cash").monthlyTotals[1]).toBeCloseTo(2000, 2);
    expect(ending[1]).toBeCloseTo(3000, 2);
    expect(ending[2]).toBeCloseTo(2600, 2);
    expect(ending[3]).toBeCloseTo(2100, 2);
    expect(ending[4]).toBeCloseTo(1900, 2);
  });

  it("holds the balance through a month with no movement", () => {
    // A flow of zero, but a balance that persists — May onward is quiet.
    const ending = sectionOf(payload, "ending_cash").monthlyTotals;
    const change = sectionOf(payload, "net_cash_change").monthlyTotals;
    expect(change[7]).toBeCloseTo(0, 2);
    expect(ending[7]).toBeCloseTo(1900, 2);
    expect(ending[12]).toBeCloseTo(1900, 2);
  });

  it("totals balances to their endpoints and flows to their sum", () => {
    // Beginning cash is the first month's opening, ending cash the last
    // month's close, and the net change the twelve added up. Treating all
    // three the same way is the mistake this pins.
    expect(sectionOf(payload, "beginning_cash").total).toBeCloseTo(2000, 2);
    expect(sectionOf(payload, "ending_cash").total).toBeCloseTo(1900, 2);
    expect(sectionOf(payload, "net_cash_change").total).toBeCloseTo(-100, 2);
    expect(sectionOf(payload, "ending_cash").total).toBeCloseTo(
      sectionOf(payload, "beginning_cash").total + sectionOf(payload, "net_cash_change").total,
      2,
    );
  });

  it("classifies the machine as investing and the repayment as financing", () => {
    expect(sectionOf(payload, "investing").monthlyTotals[3]).toBeCloseTo(-500, 2);
    expect(sectionOf(payload, "financing").monthlyTotals[4]).toBeCloseTo(-200, 2);
  });

  it("leads the operating section with net income", () => {
    expect(sectionOf(payload, "operating").accounts![0]!.accountName).toBe("Net Income");
  });

  it("names each section as this page renders it, not as the yearly page does", () => {
    // The two views have different components and legacy labelled them
    // differently; making them agree would change what one page reads.
    expect(sectionOf(payload, "operating").label).toBe("Operating Activities");
    expect(sectionOf(payload, "operating").totalLabel).toBe(
      "Net Cash from Operating Activities",
    );
  });

  it("adds each section to the accounts inside it", () => {
    for (const key of ["operating", "investing", "financing"]) {
      const section = sectionOf(payload, key);
      for (const month of payload.months) {
        const summed = section.accounts!.reduce((t, a) => t + (a.monthly[month] ?? 0), 0);
        expect(section.monthlyTotals[month]).toBeCloseTo(summed, 2);
      }
    }
  });
});

describe("narrowing to some months", () => {
  const payload = buildCashFlowMonthlyDetail(engagement, { fiscalYear: 2024, months: [2, 3] });

  it("opens the window where the month before it closed", () => {
    // February must open at 3,000 — January's close, from a month not shown.
    expect(sectionOf(payload, "beginning_cash").monthlyTotals[2]).toBeCloseTo(3000, 2);
    expect(sectionOf(payload, "ending_cash").monthlyTotals[3]).toBeCloseTo(2100, 2);
  });

  it("still reconciles across the window", () => {
    expect(sectionOf(payload, "ending_cash").total).toBeCloseTo(
      sectionOf(payload, "beginning_cash").total + sectionOf(payload, "net_cash_change").total,
      2,
    );
  });
});

describe("choosing the year", () => {
  it("defaults to the latest the engagement has", () => {
    expect(buildCashFlowMonthlyDetail(engagement).year).toBe(2024);
  });

  it("answers an empty statement for an engagement with no years", () => {
    const payload = buildCashFlowMonthlyDetail({ ...engagement, fiscalYears: [] });
    expect(payload.year).toBeNull();
    expect(payload.sections).toEqual([]);
  });
});
