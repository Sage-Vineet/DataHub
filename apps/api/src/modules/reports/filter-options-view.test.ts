import { describe, expect, it } from "vitest";
import type { Account, GlEntry } from "@datahub/financial-engine";
import type { EngagementData } from "../../shared/engagement.drizzle.js";
import { buildFilterOptions } from "./filter-options-view.js";

/**
 * The report filter options.
 *
 * The filter panel indexes into this object by key name, so the contract is
 * that every key is present whether or not there is anything to put in it.
 */

const accounts: Account[] = [
  { id: "sales", name: "Sales", statementType: "profit_loss", accountType: "income" },
  { id: "rent", name: "Rent", statementType: "profit_loss", accountType: "expense" },
  { id: "cash", name: "Cash", statementType: "balance_sheet", accountType: "asset" },
  { id: "dormant", name: "Dormant Account", statementType: "profit_loss", accountType: "expense" },
];

const entries: GlEntry[] = [
  { accountId: "sales", fiscalYear: 2023, month: 6, amount: 100 },
  { accountId: "rent", fiscalYear: 2024, month: 2, amount: 50 },
  { accountId: "cash", fiscalYear: 2024, month: 2, amount: 50 },
  // A row whose date could not be read: `0` is not a month anyone can pick.
  { accountId: "sales", fiscalYear: 2024, month: 0, amount: 25 },
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

const KEYS = [
  "fiscalYear", "fiscalMonth", "accountName", "accountNumber", "accountType",
  "category", "subCategory", "department", "class", "location", "sourceFile",
  "transactionType", "journalType", "reportType",
];

describe("the filter options", () => {
  const { options, rowCount } = buildFilterOptions(engagement);

  it("emits every key, so the filter panel can index them all", () => {
    expect(Object.keys(options).sort()).toEqual([...KEYS].sort());
  });

  it("offers the years and months the ledger posts in", () => {
    expect(options.fiscalYear).toEqual([2023, 2024]);
    expect(options.fiscalMonth).toEqual([2, 6]);
  });

  it("leaves out a month that is not a month", () => {
    // A row with no readable date reports `0`, which is not a choice.
    expect(options.fiscalMonth).not.toContain(0);
  });

  it("offers only accounts the ledger actually posts to", () => {
    // A filter that returns nothing is worse than one that is not offered.
    expect(options.accountName).toEqual(["Cash", "Rent", "Sales"]);
    expect(options.accountName).not.toContain("Dormant Account");
  });

  it("offers the account types in play", () => {
    expect(options.accountType).toEqual(["asset", "expense", "income"]);
  });

  it("fixes the report types rather than deriving them", () => {
    expect(options.reportType).toEqual(["profit_loss", "balance_sheet"]);
  });

  it("answers an empty list for a dimension the ledger does not carry", () => {
    // Not a missing key and not an invented value — the honest answer is that
    // there is nothing to filter on there yet.
    for (const key of ["accountNumber", "category", "department", "journalType"] as const) {
      expect(options[key]).toEqual([]);
    }
  });

  it("reports how many rows the options were drawn from", () => {
    expect(rowCount).toBe(4);
  });
});

describe("an engagement with no ledger", () => {
  it("still emits every key, all empty", () => {
    const { options, rowCount } = buildFilterOptions({ ...engagement, entries: [] });
    expect(Object.keys(options).sort()).toEqual([...KEYS].sort());
    expect(options.fiscalYear).toEqual([]);
    expect(options.accountName).toEqual([]);
    expect(options.reportType).toEqual(["profit_loss", "balance_sheet"]);
    expect(rowCount).toBe(0);
  });
});
