import { describe, expect, it } from "vitest";
import { periodOf, toAnchorRow, type BalanceSheetRowForAnchor } from "./engagement.drizzle.js";

/**
 * One stored balance-sheet row as a roll-forward anchor row.
 *
 * Every rejection here keeps a figure OUT of the roll. A figure wrongly let in
 * is counted against the accounts it summarises, and the sheet still balances
 * — it is just wrong by the amount of the heading.
 */

const row = (over: Partial<BalanceSheetRowForAnchor> = {}): BalanceSheetRowForAnchor => ({
  asOfDate: "2025-12-31",
  accountName: "Operating Cash",
  section: "assets",
  subSection: "Bank Accounts",
  amount: "12500.50",
  coaId: "coa-1",
  hierarchyLevel: 1,
  isTotal: false,
  ...over,
});

describe("reading a balance-sheet row", () => {
  it("reads the account, the section, the heading and the amount", () => {
    expect(toAnchorRow(row(), true)).toEqual({
      accountId: "coa-1",
      accountName: "Operating Cash",
      section: "asset",
      group: "Bank Accounts",
      amount: 12500.5,
    });
  });

  it("falls back to the name when extraction resolved no chart account", () => {
    // An anchor row still has to be matchable against the ledger, and the name
    // is the only handle left.
    expect(toAnchorRow(row({ coaId: null }), true)?.accountId).toBe("Operating Cash");
  });

  it("takes the plural section the entry table writes", () => {
    // The table uses plurals and the engine the singular.
    expect(toAnchorRow(row({ section: "liabilities" }), true)?.section).toBe("liability");
    expect(toAnchorRow(row({ section: "Equity" }), true)?.section).toBe("equity");
  });
});

describe("rows that are not positions", () => {
  it("drops one with no date", () => {
    // A row with no `as_of_date` belongs to no statement, and putting it in the
    // earliest one would date somebody else's figures to it.
    expect(toAnchorRow(row({ asOfDate: null }), true)).toBeNull();
  });

  it("drops one with no account name", () => {
    // A blank the statement carries for layout.
    expect(toAnchorRow(row({ accountName: null }), true)).toBeNull();
  });

  it("drops one whose section is not on the balance sheet", () => {
    // Guessing a section would put a real amount on an arbitrary side, where
    // it adds up and is wrong.
    expect(toAnchorRow(row({ section: "revenue" }), true)).toBeNull();
    expect(toAnchorRow(row({ section: null }), true)).toBeNull();
  });

  it("drops a parent caption, which is structure rather than an account", () => {
    // Extraction filters subtotals but not headings, so "Bank Accounts"
    // arrives looking like a balance and would be double-counted against the
    // accounts beneath it (UAT #4).
    expect(toAnchorRow(row({ accountName: "Bank Accounts", hierarchyLevel: 0 }), true)).toBeNull();
  });

  it("drops an explicit total", () => {
    expect(toAnchorRow(row({ accountName: "Total Assets", isTotal: true }), true)).toBeNull();
  });

  it("keeps a level-0 row when the statement never set levels", () => {
    // `hierarchy_level` defaults to 0, so a statement where nothing set it
    // would otherwise look like nothing but section headers — and the roll
    // would have no accounts at all.
    expect(toAnchorRow(row({ hierarchyLevel: 0 }), false)).not.toBeNull();
  });

  it("reads an unreadable amount as nothing rather than refusing the row", () => {
    // The account is real and on the sheet; only its figure is missing.
    expect(toAnchorRow(row({ amount: null }), true)?.amount).toBe(0);
    expect(toAnchorRow(row({ amount: "n/a" }), true)?.amount).toBe(0);
  });
});

describe("which period a statement states", () => {
  it("reads the year and the month off the date", () => {
    expect(periodOf("2025-12-31")).toEqual({ fiscalYear: 2025, month: 12 });
    expect(periodOf("2024-03-31")).toEqual({ fiscalYear: 2024, month: 3 });
  });

  it("assumes December for a date that names only a year", () => {
    // A balance sheet with no month is a year-end one; assuming January would
    // put the opening position at the wrong end of the year.
    expect(periodOf("2025")).toEqual({ fiscalYear: 2025, month: 12 });
  });
});
