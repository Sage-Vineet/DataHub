import { describe, expect, it } from "vitest";
import type { Account, BalanceSheetAnchor, GlEntry } from "@datahub/financial-engine";
import type { EngagementData } from "../../shared/engagement.drizzle.js";
import { buildBalanceSheet, NoBalanceSheetError } from "./balance-sheet-view.js";
import type { PlRow } from "./profit-loss-view.js";

/**
 * The Balance Sheet payload.
 *
 * A balance sheet is the one statement that checks itself, so the assertions
 * here lean on that: assets equal liabilities plus equity in every period, the
 * derived equity rows are present (leave them out and the sheet fails by
 * exactly their sum), and a yearly column is a POSITION at the year's close
 * rather than the year's movements added together.
 */

const accounts: Account[] = [
  { id: "cash", name: "Operating Cash", statementType: "balance_sheet", accountType: "asset", group: "Bank Accounts" },
  { id: "ar", name: "Accounts Receivable", statementType: "balance_sheet", accountType: "asset", group: "Accounts Receivable" },
  { id: "equip", name: "Equipment", statementType: "balance_sheet", accountType: "asset", group: "Fixed Assets" },
  { id: "ap", name: "Accounts Payable", statementType: "balance_sheet", accountType: "liability", group: "Other Current Liabilities" },
  { id: "loan", name: "Bank Loan", statementType: "balance_sheet", accountType: "liability", group: "Long-term Liabilities" },
  { id: "capital", name: "Owner Capital", statementType: "balance_sheet", accountType: "equity", group: "Equity" },
  { id: "sales", name: "Sales", statementType: "profit_loss", accountType: "income" },
  { id: "rent", name: "Rent", statementType: "profit_loss", accountType: "expense" },
];

// A double entry per year: revenue banked, rent paid, both through cash.
const entries: GlEntry[] = [
  { accountId: "sales", fiscalYear: 2023, month: 6, amount: 1000 },
  { accountId: "cash", fiscalYear: 2023, month: 6, amount: 1000 },
  { accountId: "rent", fiscalYear: 2023, month: 6, amount: 400 },
  { accountId: "cash", fiscalYear: 2023, month: 6, amount: -400 },

  { accountId: "sales", fiscalYear: 2024, month: 6, amount: 1500 },
  { accountId: "cash", fiscalYear: 2024, month: 6, amount: 1500 },
  { accountId: "rent", fiscalYear: 2024, month: 6, amount: 500 },
  { accountId: "cash", fiscalYear: 2024, month: 6, amount: -500 },
];

const opening: BalanceSheetAnchor = {
  kind: "starting",
  fiscalYear: 2022,
  month: 12,
  rows: [
    { accountId: "cash", accountName: "Operating Cash", section: "asset", group: "Bank Accounts", amount: 5000 },
    { accountId: "ar", accountName: "Accounts Receivable", section: "asset", group: "Accounts Receivable", amount: 2000 },
    { accountId: "equip", accountName: "Equipment", section: "asset", group: "Fixed Assets", amount: 8000 },
    { accountId: "ap", accountName: "Accounts Payable", section: "liability", group: "Other Current Liabilities", amount: 1500 },
    { accountId: "loan", accountName: "Bank Loan", section: "liability", group: "Long-term Liabilities", amount: 6000 },
    { accountId: "capital", accountName: "Owner Capital", section: "equity", group: "Equity", amount: 7500 },
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

const rowById = (rows: PlRow[], id: string): PlRow | undefined => {
  for (const row of rows) {
    if (row.id === id) return row;
    const found = row.children ? rowById(row.children, id) : undefined;
    if (found) return found;
  }
  return undefined;
};

describe("without a stated position", () => {
  it("refuses rather than rolling from zero", async () => {
    // A roll-forward with no anchor produces a sheet that balances perfectly
    // and is wrong in every figure. Saying so is the only safe answer.
    expect(() => buildBalanceSheet({ ...engagement, anchors: [] })).toThrow(NoBalanceSheetError);
  });
});

describe("the balance sheet", () => {
  const payload = buildBalanceSheet(engagement);

  it("balances in every year it reports", () => {
    expect(payload.audit).toHaveLength(2);
    for (const year of payload.audit) {
      expect(year.assets).toBeCloseTo(year.liabilities + year.equity, 2);
      expect(year.isBalanced).toBe(true);
    }
  });

  it("carries the derived equity rows, without which it would not balance", () => {
    const equity = payload.sections.Equity;
    expect(equity.categories.map((c) => c.label)).toEqual([
      "Owner Equity",
      "Retained Earnings",
      "Net Income",
    ]);
    // FY2024 income is 1500 − 500.
    const netIncome = equity.categories.find((c) => c.label === "Net Income")!;
    expect(netIncome.totalByYear[2024]).toBeCloseTo(1000, 2);
  });

  it("reports a position at the year's close, not the year's movement", () => {
    // Cash opens at 5,000, gains 600 in FY2023 and 1,000 in FY2024. FY2024
    // closes at 6,600 — not at 1,000, which is what summing the year gives.
    const bank = payload.sections.Assets.categories.find((c) => c.label === "Bank Accounts")!;
    expect(bank.totalByYear[2023]).toBeCloseTo(5600, 2);
    expect(bank.totalByYear[2024]).toBeCloseTo(6600, 2);
  });

  it("puts each account under the sub-heading its statement gave it", () => {
    expect(payload.sections.Assets.categories.map((c) => c.label)).toEqual([
      "Bank Accounts",
      "Accounts Receivable",
      "Fixed Assets",
    ]);
    expect(payload.sections.Liabilities.categories.map((c) => c.label)).toEqual([
      "Other Current Liabilities",
      "Long-term Liabilities",
    ]);
  });
});

describe("the rows the statement table walks", () => {
  const payload = buildBalanceSheet(engagement, { fiscalYears: [2023, 2024] });
  const rows = payload.hierarchicalRows;

  it("has exactly the two top-level halves", () => {
    expect(rows.map((r) => r.id)).toEqual(["assets", "liabilities-and-equity"]);
  });

  it("makes the two halves equal, which is the statement's whole claim", () => {
    for (const key of ["y2023", "y2024"]) {
      expect(rowById(rows, "assets")!.amounts[key]).toBeCloseTo(
        rowById(rows, "liabilities-and-equity")!.amounts[key]!,
        2,
      );
    }
  });

  it("rolls current assets up from its sub-headings only", () => {
    // Fixed Assets sits outside Current Assets. Including it is the classic
    // way this subtotal goes wrong.
    const current = rowById(rows, "current-assets")!;
    const bank = rowById(rows, "assets-bank-bank-accounts")!;
    const ar = rowById(rows, "assets-ar-accounts-receivable")!;
    expect(current.amounts["y2024"]).toBeCloseTo(
      bank.amounts["y2024"]! + ar.amounts["y2024"]!,
      2,
    );
    expect(rowById(rows, "assets")!.amounts["y2024"]).toBeGreaterThan(
      current.amounts["y2024"]!,
    );
  });

  it("totals each section to the accounts beneath it", () => {
    for (const id of ["assets", "liabilities", "equity"]) {
      const section = rowById(rows, id)!;
      const total = rowById(rows, `${id}-total`)!;
      expect(section.amounts["y2024"]).toBeCloseTo(total.amounts["y2024"]!, 2);
    }
  });

  it("names a comparative column per requested year", () => {
    expect(payload.yearCols).toEqual([
      { key: "y2023", label: "2023" },
      { key: "y2024", label: "2024" },
    ]);
  });

  it("omits a sub-heading with no accounts rather than printing an empty one", () => {
    // Nothing is a credit card or an other asset in this engagement.
    expect(rowById(rows, "liab-cc-credit-cards")).toBeUndefined();
    expect(rowById(rows, "assets-other-other-assets")).toBeUndefined();
  });
});

describe("choosing the years", () => {
  it("rolls from the start whatever year is asked for", () => {
    // FY2024 alone must still close at 6,600 — rolling from FY2024's own
    // entries would start from nothing, balance, and be wrong throughout.
    const only2024 = buildBalanceSheet(engagement, { fiscalYears: [2024] });
    const bank = only2024.sections.Assets.categories.find((c) => c.label === "Bank Accounts")!;
    expect(bank.totalByYear[2024]).toBeCloseTo(6600, 2);
    expect(only2024.audit.every((a) => a.isBalanced)).toBe(true);
  });

  it("reports every year by default, latest as the display year", () => {
    const payload = buildBalanceSheet(engagement);
    expect(payload.years).toEqual([2023, 2024]);
    expect(payload.displayYear).toBe(2024);
    expect(payload.yearCols).toBeUndefined();
  });

  it("drops a year the engagement has no position for", () => {
    const payload = buildBalanceSheet(engagement, { fiscalYears: [2024, 2099] });
    expect(payload.years).toEqual([2024]);
  });

  it("answers an empty statement when the filter selects nothing", () => {
    const payload = buildBalanceSheet(engagement, { fiscalYears: [2099] });
    expect(payload.years).toEqual([]);
    expect(payload.displayYear).toBeNull();
    expect(payload.audit).toEqual([]);
  });

  it("sets the scalar amount to the display year", () => {
    const payload = buildBalanceSheet(engagement);
    const assets = rowById(payload.hierarchicalRows, "assets")!;
    expect(assets.amount).toBe(assets.amounts["y2024"]);
  });
});
