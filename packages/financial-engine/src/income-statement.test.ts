import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/engagement.json" with { type: "json" };
import { buildIncomeStatement, UnclassifiedAccountError } from "./income-statement.js";
import { buildPeriods } from "./periods.js";
import type { Account, GlEntry } from "./types.js";

const accounts = fixture.accounts as Account[];
const entries = fixture.glEntries as GlEntry[];
const years = fixture.fiscalYears;

const annual = () => {
  const periods = buildPeriods(entries, years, "annual");
  return buildIncomeStatement(accounts, entries, periods, "annual");
};

/**
 * Ground truth transcribed from "Data walkthrough 05.05.2026.xlsx".
 * These are the figures the whole engagement is measured against.
 */
const WORKBOOK = {
  2022: { revenue: 2609930.6, expenses: 2494034.22, netIncome: 115896.38 },
  2023: { revenue: 2927853.69, expenses: 2823774.57, netIncome: 104079.12 },
  2024: { revenue: 2511740.83, expenses: 2464172.6, netIncome: 47568.23 },
  2025: { revenue: 2333398.51, expenses: 2163902.61, netIncome: 169495.9 },
} as const;

describe("income statement", () => {
  const statement = annual();

  for (const [year, want] of Object.entries(WORKBOOK)) {
    it(`FY${year} ties to the workbook`, () => {
      expect(statement.revenue[year]).toBeCloseTo(want.revenue, 2);
      expect(statement.expenses[year]).toBeCloseTo(want.expenses, 2);
      expect(statement.netIncome[year]).toBeCloseTo(want.netIncome, 2);
    });
  }

  it("does not reproduce the revenue-plus-expenses inversion", () => {
    // The extracted profit_loss_entries table reports 4,975,913.43 for FY2024,
    // which is revenue + expenses. Guard the regression explicitly.
    const inverted = WORKBOOK[2024].revenue + WORKBOOK[2024].expenses;
    expect(inverted).toBeCloseTo(4975913.43, 2);
    expect(statement.netIncome["2024"]).not.toBeCloseTo(inverted, 2);
    expect(statement.netIncome["2024"]).toBeCloseTo(47568.23, 2);
  });

  it("signs expense accounts negative and income accounts positive", () => {
    expect(statement.byAccount.get("sales")!["2024"]).toBeGreaterThan(0);
    expect(statement.byAccount.get("depreciation")!["2024"]).toBeLessThan(0);
    // The raw ledger amount stays unsigned — both arrive positive from QuickBooks.
    expect(statement.ledgerByAccount.get("depreciation")!["2024"]).toBeCloseTo(217775, 2);
  });

  it("monthly columns sum back to the annual figure", () => {
    const periods = buildPeriods(entries, [2024], "monthly");
    const monthly = buildIncomeStatement(accounts, entries, periods, "monthly");
    const total = Object.values(monthly.netIncome).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(WORKBOOK[2024].netIncome, 1);
  });

  it("refuses to guess at an unclassified P&L account", () => {
    const broken = accounts.map((a) =>
      a.id === "sales" ? { ...a, accountType: null } : a,
    ) as Account[];
    const periods = buildPeriods(entries, [2024], "annual");
    expect(() => buildIncomeStatement(broken, entries, periods, "annual")).toThrow(
      UnclassifiedAccountError,
    );
  });
});
