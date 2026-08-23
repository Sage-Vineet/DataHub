import { describe, expect, it } from "vitest";
import type { Account, GlEntry } from "@datahub/financial-engine";
import type { EngagementData } from "../../shared/engagement.drizzle.js";
import { buildProfitLossSummary } from "./profit-loss-view.js";
import { buildVendorDetail, NO_VENDOR_LABEL } from "./vendor-detail-view.js";

/**
 * Spend by vendor.
 *
 * The engine's own suite proves the breakdown ties to net income. What is left
 * for the presenter is the arrangement — and the one judgement call in it,
 * which is that a row naming nobody is labelled rather than dropped.
 */

const accounts: Account[] = [
  { id: "sales", name: "Sales", statementType: "profit_loss", accountType: "income" },
  { id: "materials", name: "Materials", statementType: "profit_loss", accountType: "cogs" },
  { id: "rent", name: "Rent", statementType: "profit_loss", accountType: "expense" },
];

const entries: GlEntry[] = [
  { accountId: "sales", fiscalYear: 2023, month: 1, amount: 500, vendor: "Northwind" },
  { accountId: "sales", fiscalYear: 2024, month: 1, amount: 1000, vendor: "Northwind" },
  { accountId: "materials", fiscalYear: 2024, month: 1, amount: 400, vendor: "Acme Supply" },
  { accountId: "rent", fiscalYear: 2024, month: 2, amount: 250, vendor: "Acme Supply" },
  { accountId: "rent", fiscalYear: 2024, month: 3, amount: 60, vendor: null },
];

const engagement: EngagementData = {
  companyId: "co-1",
  companyName: "Acme",
  profitMetric: "adjusted_ebitda",
  marketRateReplacementSalary: null,
  fiscalYears: [2023, 2024],
  accounts,
  entries,
  anchors: [],
};

const vendor = (payload: ReturnType<typeof buildVendorDetail>, name: string) =>
  payload.vendors.find((v) => v.vendorName === name)!;

describe("the vendor payload", () => {
  const payload = buildVendorDetail(engagement);

  it("names the vendor-less bucket rather than dropping the spend", () => {
    // 60 of rent named nobody. Dropping it would make the vendor view
    // disagree with the P&L by exactly that.
    const unnamed = vendor(payload, NO_VENDOR_LABEL);
    expect(unnamed.totalAmount).toBeCloseTo(-60, 2);
  });

  it("adds every vendor to the same net profit the P&L reports", () => {
    const summed = payload.vendors.reduce((total, v) => total + v.totalAmount, 0);
    const pl = buildProfitLossSummary(engagement);
    const plTotal = Object.values(pl.netProfitByYear).reduce((a, b) => a + b, 0);
    expect(summed).toBeCloseTo(plTotal, 2);
  });

  it("groups a vendor's spend by account", () => {
    const acme = vendor(payload, "Acme Supply");
    expect(acme.accounts.map((a) => a.accountName)).toEqual(["Materials", "Rent"]);
    expect(acme.totalAmount).toBeCloseTo(-650, 2);
  });

  it("takes each account's bucket from its type, as the statement does", () => {
    // The two views must not disagree about what an account is.
    const acme = vendor(payload, "Acme Supply");
    expect(acme.accounts.find((a) => a.accountName === "Materials")!.category).toBe("COGS");
    expect(acme.accounts.find((a) => a.accountName === "Rent")!.category).toBe(
      "Operating Expenses",
    );
  });

  it("splits a vendor across the years it traded in", () => {
    const northwind = vendor(payload, "Northwind");
    expect(northwind.yearlyTotals[2023]).toBeCloseTo(500, 2);
    expect(northwind.yearlyTotals[2024]).toBeCloseTo(1000, 2);
    expect(northwind.totalAmount).toBeCloseTo(1500, 2);
  });

  it("gives every vendor a column per year, so a quiet year reads as zero", () => {
    const acme = vendor(payload, "Acme Supply");
    expect(Object.keys(acme.yearlyTotals).map(Number)).toEqual([2023, 2024]);
    expect(acme.yearlyTotals[2023]).toBe(0);
  });

  it("orders by size", () => {
    const totals = payload.vendors.map((v) => Math.abs(v.totalAmount));
    expect(totals).toEqual([...totals].sort((a, b) => b - a));
  });
});

describe("choosing the years", () => {
  it("narrows to the year asked for", () => {
    const payload = buildVendorDetail(engagement, { fiscalYears: [2024] });
    expect(payload.years).toEqual([2024]);
    expect(vendor(payload, "Northwind").totalAmount).toBeCloseTo(1000, 2);
  });

  it("drops a year the engagement has nothing for", () => {
    expect(buildVendorDetail(engagement, { fiscalYears: [2024, 2099] }).years).toEqual([2024]);
  });

  it("answers no vendors when the filter selects nothing", () => {
    const payload = buildVendorDetail(engagement, { fiscalYears: [2099] });
    expect(payload.years).toEqual([]);
    expect(payload.vendors).toEqual([]);
  });
});
