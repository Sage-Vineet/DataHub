import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/engagement.json" with { type: "json" };
import { buildIncomeStatement, UnclassifiedAccountError } from "./income-statement.js";
import { buildPeriods } from "./periods.js";
import { buildVendorBreakdown } from "./vendor-breakdown.js";
import type { Account, GlEntry } from "./types.js";

/**
 * The vendor breakdown.
 *
 * It is a second cut of the ledger the income statement already reads, so the
 * assertion that matters most is that the two agree: a breakdown that applies
 * the sign convention differently still produces totals that look like money,
 * and nothing catches it except tying out against the P&L.
 */

const accounts: Account[] = [
  { id: "sales", name: "Sales", statementType: "profit_loss", accountType: "income" },
  { id: "materials", name: "Materials", statementType: "profit_loss", accountType: "cogs" },
  { id: "rent", name: "Rent", statementType: "profit_loss", accountType: "expense" },
  { id: "cash", name: "Cash", statementType: "balance_sheet", accountType: "asset" },
];

const entries: GlEntry[] = [
  { accountId: "sales", fiscalYear: 2024, month: 1, amount: 1000, vendor: "Northwind" },
  { accountId: "materials", fiscalYear: 2024, month: 1, amount: 400, vendor: "Acme Supply" },
  { accountId: "materials", fiscalYear: 2024, month: 2, amount: 100, vendor: "Acme Supply" },
  { accountId: "rent", fiscalYear: 2024, month: 3, amount: 250, vendor: "Landlord Ltd" },
  { accountId: "rent", fiscalYear: 2024, month: 4, amount: 50, vendor: null },
  { accountId: "rent", fiscalYear: 2024, month: 5, amount: 25, vendor: "   " },
  // A balance-sheet account, which is not spend on anything.
  { accountId: "cash", fiscalYear: 2024, month: 1, amount: 600, vendor: "Northwind" },
];

const annual = (rows: GlEntry[] = entries, list: Account[] = accounts) =>
  buildVendorBreakdown(list, rows, buildPeriods(rows, [2024], "annual"), "annual");

const find = (name: string | null) =>
  annual().find((v) => v.vendorName === name)!;

describe("the vendor breakdown", () => {
  it("signs revenue positive and cost negative, as the income statement does", () => {
    expect(find("Northwind").total).toBeCloseTo(1000, 2);
    expect(find("Acme Supply").total).toBeCloseTo(-500, 2);
    expect(find("Landlord Ltd").total).toBeCloseTo(-250, 2);
  });

  it("ties out: every vendor added together equals net income", () => {
    // The check that catches a sign applied differently here than there.
    const total = annual().reduce((sum, v) => sum + v.total, 0);
    const income = buildIncomeStatement(
      accounts,
      entries,
      buildPeriods(entries, [2024], "annual"),
      "annual",
    );
    expect(total).toBeCloseTo(income.netIncome["2024"]!, 2);
  });

  it("leaves balance-sheet movement out, even under a vendor that also traded", () => {
    // Northwind has a 600 cash row too. Counting it would report 1,600.
    expect(find("Northwind").accounts.map((a) => a.accountName)).toEqual(["Sales"]);
    expect(find("Northwind").total).toBeCloseTo(1000, 2);
  });

  it("treats an absent vendor and a blank one as the same absence", () => {
    // One bucket of 75, not a null bucket of 50 and a "   " bucket of 25.
    const unnamed = annual().filter((v) => v.vendorName === null);
    expect(unnamed).toHaveLength(1);
    expect(unnamed[0]!.total).toBeCloseTo(-75, 2);
  });

  it("adds each vendor's accounts to that vendor's total", () => {
    for (const vendor of annual()) {
      const summed = vendor.accounts.reduce((total, a) => total + a.total, 0);
      expect(vendor.total).toBeCloseTo(summed, 2);
    }
  });

  it("orders by size, so a large refund ranks with a large spend", () => {
    const totals = annual().map((v) => Math.abs(v.total));
    expect(totals).toEqual([...totals].sort((a, b) => b - a));
  });

  it("splits by period when asked monthly, and the months sum to the year", () => {
    const monthly = buildVendorBreakdown(
      accounts,
      entries,
      buildPeriods(entries, [2024], "monthly"),
      "monthly",
    );
    const acme = monthly.find((v) => v.vendorName === "Acme Supply")!;
    expect(acme.amounts["2024-01"]).toBeCloseTo(-400, 2);
    expect(acme.amounts["2024-02"]).toBeCloseTo(-100, 2);
    expect(Object.values(acme.amounts).reduce((a, b) => a + b, 0)).toBeCloseTo(acme.total, 2);
  });

  it("refuses an unclassified P&L account rather than dropping its spend", () => {
    // A silent omission here would under-report a vendor with no sign of it.
    const unclassified: Account[] = [
      ...accounts,
      { id: "mystery", name: "Mystery", statementType: "profit_loss", accountType: null },
    ];
    const rows: GlEntry[] = [
      ...entries,
      { accountId: "mystery", fiscalYear: 2024, month: 1, amount: 900, vendor: "Acme Supply" },
    ];
    expect(() => annual(rows, unclassified)).toThrow(UnclassifiedAccountError);
  });

  it("ties out against the workbook engagement too", () => {
    const workbookAccounts = fixture.accounts as Account[];
    const workbookEntries = fixture.glEntries as GlEntry[];
    const years = fixture.fiscalYears;
    const periods = buildPeriods(workbookEntries, years, "annual");

    const vendors = buildVendorBreakdown(workbookAccounts, workbookEntries, periods, "annual");
    const income = buildIncomeStatement(workbookAccounts, workbookEntries, periods, "annual");

    for (const year of years) {
      const fromVendors = vendors.reduce((sum, v) => sum + (v.amounts[String(year)] ?? 0), 0);
      expect(fromVendors).toBeCloseTo(income.netIncome[String(year)]!, 1);
    }
  });
});
