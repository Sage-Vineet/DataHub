import { describe, expect, it } from "vitest";
import type { Account, BalanceSheetAnchor, GlEntry } from "@datahub/financial-engine";
import type { EngagementData } from "../../shared/engagement.drizzle.js";
import { totalsOf, validateBalanceSheet } from "./balance-sheet-validation.js";

/**
 * The roll-forward validation.
 *
 * This is the check a reader runs before trusting anything else: does the
 * ledger actually carry the opening balance sheet to the closing one? So the
 * tests are mostly about it FAILING correctly — a validator that cannot report
 * a break is worse than no validator, because it certifies whatever it is
 * given.
 */

const accounts: Account[] = [
  { id: "cash", name: "Operating Cash", statementType: "balance_sheet", accountType: "asset", group: "Bank Accounts" },
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
];

const row = (id: string, name: string, section: string, amount: number) => ({
  accountId: id,
  accountName: name,
  section,
  group: null,
  amount,
});

const starting: BalanceSheetAnchor = {
  kind: "starting",
  fiscalYear: 2023,
  month: 12,
  rows: [
    row("cash", "Operating Cash", "asset", 2000),
    row("loan", "Bank Loan", "liability", 1500),
    row("capital", "Owner Capital", "equity", 500),
  ],
};

/**
 * Cash rolls 2,000 → 2,600 and the 600 of profit shows as its own equity row.
 *
 * A stated sheet that folded the profit into Owner Capital would disagree with
 * the roll-forward on both rows and agree on the total, which is exactly the
 * kind of break this validator exists to surface.
 */
const ending: BalanceSheetAnchor = {
  kind: "ending",
  fiscalYear: 2024,
  month: 12,
  rows: [
    row("cash", "Operating Cash", "asset", 2600),
    row("loan", "Bank Loan", "liability", 1500),
    row("capital", "Owner Capital", "equity", 500),
    row("Net Income", "Net Income", "equity", 600),
  ],
};

const engagement = (anchors: BalanceSheetAnchor[]): EngagementData => ({
  companyId: "co-1",
  companyName: "Acme",
  profitMetric: "adjusted_ebitda",
  marketRateReplacementSalary: null,
  fiscalYears: [2024],
  accounts,
  entries,
  anchors,
});

describe("totals of a stated sheet", () => {
  it("adds each section and says whether the sheet balances", () => {
    const totals = totalsOf(starting);
    expect(totals.totalAssets).toBe(2000);
    expect(totals.totalLiabilities).toBe(1500);
    expect(totals.totalEquity).toBe(500);
    expect(totals.isBalanced).toBe(true);
  });

  it("reports a stated sheet that does not balance", () => {
    // An uploaded sheet can simply be wrong, and saying so is the point.
    const broken = { ...starting, rows: [...starting.rows, row("cash", "Petty Cash", "asset", 50)] };
    expect(totalsOf(broken).isBalanced).toBe(false);
  });

  it("answers zeroes, unbalanced, for a sheet that is not there", () => {
    expect(totalsOf(undefined)).toEqual({
      totalAssets: 0,
      totalLiabilities: 0,
      totalEquity: 0,
      isBalanced: false,
    });
  });
});

describe("a ledger that ties out", () => {
  const { validation } = validateBalanceSheet(engagement([starting, ending]));

  it("passes, with no mismatches", () => {
    expect(validation.isValid).toBe(true);
    expect(validation.mismatches).toEqual([]);
    expect(validation.isComplete).toBe(true);
    expect(validation.missingSheets).toEqual([]);
  });

  it("reports the year's profit and no unexplained movement", () => {
    expect(validation.netIncome).toBeCloseTo(600, 2);
    expect(validation.openingBalance).toBeCloseTo(500, 2);
    expect(validation.closingBalance).toBeCloseTo(1100, 2);
    // Opening + profit = closing, so nothing was posted straight to equity.
    expect(validation.adjustments).toBeCloseTo(0, 2);
    expect(validation.equationVariance).toBeCloseTo(0, 2);
    expect(validation.isEquationValid).toBe(true);
  });
});

describe("a ledger that does not tie out", () => {
  it("names the account, and by how much", () => {
    // The closing sheet says cash ended at 3,000; the ledger gets it to 2,600.
    const wrong: BalanceSheetAnchor = {
      ...ending,
      rows: [
        row("cash", "Operating Cash", "asset", 3000),
        row("loan", "Bank Loan", "liability", 1500),
        row("capital", "Owner Capital", "equity", 900),
        row("Net Income", "Net Income", "equity", 600),
      ],
    };
    const { validation } = validateBalanceSheet(engagement([starting, wrong]));

    expect(validation.isValid).toBe(false);
    const cash = validation.mismatches.find((m) => m.account === "Operating Cash")!;
    expect(cash.opening).toBeCloseTo(2000, 2);
    expect(cash.expectedClosing).toBeCloseTo(2600, 2);
    expect(cash.actualClosing).toBeCloseTo(3000, 2);
    expect(cash.variance).toBeCloseTo(400, 2);
  });

  it("orders the mismatches by size, so the worst is first", () => {
    const wrong: BalanceSheetAnchor = {
      ...ending,
      rows: [
        row("cash", "Operating Cash", "asset", 2650),
        row("loan", "Bank Loan", "liability", 3000),
        row("capital", "Owner Capital", "equity", 500),
        row("Net Income", "Net Income", "equity", 600),
      ],
    };
    const { validation } = validateBalanceSheet(engagement([starting, wrong]));
    const sizes = validation.mismatches.map((m) => Math.abs(m.variance));
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
    expect(validation.mismatches[0]!.account).toBe("Bank Loan");
  });

  it("does not report a cent of rounding as a break", () => {
    const rounded: BalanceSheetAnchor = {
      ...ending,
      rows: [
        row("cash", "Operating Cash", "asset", 2600.004),
        row("loan", "Bank Loan", "liability", 1500),
        row("capital", "Owner Capital", "equity", 500),
        row("Net Income", "Net Income", "equity", 600),
      ],
    };
    const { validation } = validateBalanceSheet(engagement([starting, rounded]));
    expect(validation.mismatches).toEqual([]);
  });

  it("reports money that appeared in equity without passing through the P&L", () => {
    // Owner puts 900 in. Profit is 600, so 900 of the 1,500 movement is an
    // adjustment — the figure a reader is meant to go and explain.
    const injected: BalanceSheetAnchor = {
      ...ending,
      rows: [
        row("cash", "Operating Cash", "asset", 3500),
        row("loan", "Bank Loan", "liability", 1500),
        row("capital", "Owner Capital", "equity", 1400),
        row("Net Income", "Net Income", "equity", 600),
      ],
    };
    const { validation } = validateBalanceSheet(engagement([starting, injected]));
    expect(validation.adjustments).toBeCloseTo(900, 2);
    // The equation still closes — that is what `adjustments` is for.
    expect(validation.equationVariance).toBeCloseTo(0, 2);
    expect(validation.isEquationValid).toBe(true);
    // But the account itself is out, and that is what makes it invalid.
    expect(validation.isValid).toBe(false);
  });
});

describe("accounts that appear on only one sheet", () => {
  it("reports one that opens and never closes", () => {
    const withExtra: BalanceSheetAnchor = {
      ...starting,
      rows: [...starting.rows, row("prepaid", "Prepaid Rent", "asset", 300)],
    };
    const { validation } = validateBalanceSheet(engagement([withExtra, ending]));
    expect(validation.missingInEnding.map((m) => m.account)).toContain("Prepaid Rent");
  });

  it("reports one that closes having never opened", () => {
    const withExtra: BalanceSheetAnchor = {
      ...ending,
      rows: [...ending.rows, row("deposit", "Customer Deposits", "liability", 250)],
    };
    const { validation } = validateBalanceSheet(engagement([starting, withExtra]));
    expect(validation.missingInStarting.map((m) => m.account)).toContain("Customer Deposits");
  });
});

describe("a sheet that was never uploaded", () => {
  it("says which one is missing rather than reporting a pass", () => {
    const { validation } = validateBalanceSheet(engagement([starting]));
    expect(validation.hasStartingSheet).toBe(true);
    expect(validation.hasEndingSheet).toBe(false);
    expect(validation.missingSheets).toEqual(["ending"]);
    expect(validation.isComplete).toBe(false);
    expect(validation.isValid).toBe(false);
  });

  it("lists no mismatches, rather than every account", () => {
    // With nothing to roll to, every account would "disagree" with an absent
    // sheet — a list that says nothing and buries the one fact that matters.
    const { validation } = validateBalanceSheet(engagement([starting]));
    expect(validation.mismatches).toEqual([]);
  });

  it("fails outright when neither sheet is there", () => {
    const { validation } = validateBalanceSheet(engagement([]));
    expect(validation.missingSheets).toEqual(["starting", "ending"]);
    expect(validation.isBalanced).toBe(false);
    expect(validation.isValid).toBe(false);
  });
});
