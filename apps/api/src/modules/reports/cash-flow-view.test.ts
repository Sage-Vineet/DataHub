import { describe, expect, it } from "vitest";
import type { Account, BalanceSheetAnchor, GlEntry } from "@datahub/financial-engine";
import type { EngagementData } from "../../shared/engagement.drizzle.js";
import { NoBalanceSheetError } from "./balance-sheet-view.js";
import { buildCashFlowReport } from "./cash-flow-view.js";
import type { PlRow } from "./profit-loss-view.js";

/**
 * The Cash Flow payload.
 *
 * The statement is a derived one, so the assertions are the identities it must
 * satisfy: opening plus net change equals closing, the three sections add to
 * the net change, and one year's close is the next year's open. Legacy had
 * three independent cash-flow builders and no way to check any of them against
 * the other statements; this one is a function of them, and that is testable.
 */

const accounts: Account[] = [
  { id: "cash", name: "Operating Cash", statementType: "balance_sheet", accountType: "asset", group: "Bank Accounts" },
  { id: "ar", name: "Accounts Receivable", statementType: "balance_sheet", accountType: "asset", group: "Accounts Receivable" },
  { id: "equip", name: "Equipment", statementType: "balance_sheet", accountType: "asset", group: "Fixed Assets" },
  { id: "loan", name: "Bank Loan", statementType: "balance_sheet", accountType: "liability", group: "Long-term Liabilities" },
  { id: "capital", name: "Owner Capital", statementType: "balance_sheet", accountType: "equity", group: "Equity" },
  { id: "sales", name: "Sales", statementType: "profit_loss", accountType: "income" },
  { id: "rent", name: "Rent", statementType: "profit_loss", accountType: "expense" },
];

const entries: GlEntry[] = [
  // FY2023: sales banked, rent paid, and a receivable that has not been.
  { accountId: "sales", fiscalYear: 2023, month: 6, amount: 1000 },
  { accountId: "cash", fiscalYear: 2023, month: 6, amount: 700 },
  { accountId: "ar", fiscalYear: 2023, month: 6, amount: 300 },
  { accountId: "rent", fiscalYear: 2023, month: 7, amount: 400 },
  { accountId: "cash", fiscalYear: 2023, month: 7, amount: -400 },

  // FY2024: more trading, a machine bought, and a slice of the loan repaid.
  { accountId: "sales", fiscalYear: 2024, month: 3, amount: 1500 },
  { accountId: "cash", fiscalYear: 2024, month: 3, amount: 1500 },
  { accountId: "rent", fiscalYear: 2024, month: 4, amount: 500 },
  { accountId: "cash", fiscalYear: 2024, month: 4, amount: -500 },
  { accountId: "equip", fiscalYear: 2024, month: 5, amount: 600 },
  { accountId: "cash", fiscalYear: 2024, month: 5, amount: -600 },
  { accountId: "loan", fiscalYear: 2024, month: 6, amount: -200 },
  { accountId: "cash", fiscalYear: 2024, month: 6, amount: -200 },
];

const opening: BalanceSheetAnchor = {
  kind: "starting",
  fiscalYear: 2022,
  month: 12,
  rows: [
    { accountId: "cash", accountName: "Operating Cash", section: "asset", group: "Bank Accounts", amount: 5000 },
    { accountId: "ar", accountName: "Accounts Receivable", section: "asset", group: "Accounts Receivable", amount: 0 },
    { accountId: "equip", accountName: "Equipment", section: "asset", group: "Fixed Assets", amount: 8000 },
    { accountId: "loan", accountName: "Bank Loan", section: "liability", group: "Long-term Liabilities", amount: 6000 },
    { accountId: "capital", accountName: "Owner Capital", section: "equity", group: "Equity", amount: 7000 },
  ],
};

const engagement: EngagementData = {
  companyId: "co-1",
  companyName: "Acme",
  profitMetric: "adjusted_ebitda",
  marketRateReplacementSalary: null,
  fiscalYears: [2023, 2024],
  accounts,
  entries,
  anchors: [opening],
};

const rowById = (rows: PlRow[], id: string): PlRow | undefined =>
  rows.find((r) => r.id === id) ??
  rows.flatMap((r) => r.children ?? []).find((r) => r.id === id);

describe("without a stated position", () => {
  it("refuses, because a cash flow is a function of the balance sheet", () => {
    expect(() => buildCashFlowReport({ ...engagement, anchors: [] })).toThrow(NoBalanceSheetError);
  });
});

describe("the cash flow", () => {
  const payload = buildCashFlowReport(engagement);

  it("reconciles: opening plus the net change equals closing, every year", () => {
    // The one identity a cash flow statement exists to demonstrate.
    for (const year of payload.years) {
      expect(payload.beginningCash[`y${year}`]! + payload.netCashChange[year]!).toBeCloseTo(
        payload.endingCash[`y${year}`]!,
        2,
      );
    }
  });

  it("adds its three sections to the net change", () => {
    for (const year of payload.years) {
      const summed =
        payload.sections.Operating.totalByYear[year]! +
        payload.sections.Investing.totalByYear[year]! +
        payload.sections.Financing.totalByYear[year]!;
      expect(summed).toBeCloseTo(payload.netCashChange[year]!, 2);
    }
  });

  it("carries one year's close into the next year's open", () => {
    expect(payload.beginningCash["y2024"]).toBeCloseTo(payload.endingCash["y2023"]!, 2);
  });

  it("tracks the cash the ledger actually moved", () => {
    // FY2023: +700 −400 = +300 on an opening 5,000.
    expect(payload.beginningCash["y2023"]).toBeCloseTo(5000, 2);
    expect(payload.netCashChange[2023]).toBeCloseTo(300, 2);
    expect(payload.endingCash["y2023"]).toBeCloseTo(5300, 2);
    // FY2024: +1500 −500 −600 −200 = +200.
    expect(payload.netCashChange[2024]).toBeCloseTo(200, 2);
    expect(payload.endingCash["y2024"]).toBeCloseTo(5500, 2);
  });

  it("puts the machine in investing and the loan repayment in financing", () => {
    // The classification the whole statement turns on: buying equipment is not
    // an operating cost, and repaying debt is not one either.
    expect(payload.sections.Investing.totalByYear[2024]).toBeCloseTo(-600, 2);
    expect(payload.sections.Financing.totalByYear[2024]).toBeCloseTo(-200, 2);
  });

  it("shows the unpaid receivable as cash the profit did not bring in", () => {
    // FY2023 profit is 600 but only 300 of cash came in; the 300 receivable is
    // the difference, and it belongs in operating.
    expect(payload.sections.Operating.totalByYear[2023]).toBeCloseTo(300, 2);
  });
});

describe("the rows the summary renders", () => {
  const payload = buildCashFlowReport(engagement, { fiscalYears: [2023, 2024] });
  const rows = payload.hierarchicalRows;

  it("leads the operating section with net income", () => {
    const operating = rows.find((r) => r.id === "operating-header")!;
    expect(operating.children![0]!.name).toBe("Net Income");
  });

  it("totals each section header to its own total row", () => {
    for (const key of ["operating", "investing", "financing"]) {
      const header = rowById(rows, `${key}-header`)!;
      const total = rowById(rows, `${key}-total`)!;
      expect(header.amounts).toEqual(total.amounts);
    }
  });

  it("closes with beginning cash, the change, and ending cash", () => {
    const ids = rows.map((r) => r.id);
    expect(ids.slice(-3)).toEqual(["net-cash-change", "beginning-cash", "ending-cash"]);
  });

  it("keys every column the same way `yearCols` names them", () => {
    // Legacy's three statements each invented their own column keys once; the
    // page reads `yearCols` and indexes `amounts` by it, so a mismatch renders
    // a table of blanks rather than an error.
    const keys = payload.yearCols.map((c) => c.key);
    expect(keys).toEqual(["y2023", "y2024"]);
    for (const row of rows) {
      expect(Object.keys(row.amounts)).toEqual(keys);
    }
  });

  it("omits an account that never moved rather than printing a row of zeroes", () => {
    const operating = rows.find((r) => r.id === "operating-header")!;
    const names = operating.children!.map((c) => c.name);
    expect(names).not.toContain("Equipment");
    expect(names).not.toContain("Bank Loan");
  });
});

describe("choosing the years", () => {
  it("rolls from the start whatever year is asked for", () => {
    // FY2024 alone must still open at 5,300 — the close of a year not on show.
    const only2024 = buildCashFlowReport(engagement, { fiscalYears: [2024] });
    expect(only2024.beginningCash["y2024"]).toBeCloseTo(5300, 2);
    expect(only2024.endingCash["y2024"]).toBeCloseTo(5500, 2);
  });

  it("reports every year by default", () => {
    expect(buildCashFlowReport(engagement).years).toEqual([2023, 2024]);
  });

  it("drops a year the engagement has nothing for", () => {
    expect(buildCashFlowReport(engagement, { fiscalYears: [2024, 2099] }).years).toEqual([2024]);
  });

  it("answers an empty statement when the filter selects nothing", () => {
    const payload = buildCashFlowReport(engagement, { fiscalYears: [2099] });
    expect(payload.years).toEqual([]);
    expect(payload.yearCols).toEqual([]);
    expect(payload.sections.Operating.items).toEqual([]);
  });
});
