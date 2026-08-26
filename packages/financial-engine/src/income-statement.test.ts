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

/**
 * Cost of sales.
 *
 * `cogs` was absent from `AccountType` while the database, the QoE contracts
 * and `coa-constraints.ts` all accepted it, so a cost-of-sales account reached
 * the engine as a value its own union forbade. What follows pins the two
 * things that could then not be got right: gross profit, and the guarantee
 * that separating cost of sales out never moves the bottom line.
 */
describe("cost of sales", () => {
  const accountsWithCogs: Account[] = [
    { id: "sales", name: "Sales", statementType: "profit_loss", accountType: "income" },
    { id: "materials", name: "Materials", statementType: "profit_loss", accountType: "cogs" },
    { id: "rent", name: "Rent", statementType: "profit_loss", accountType: "expense" },
  ];
  const rows: GlEntry[] = [
    { accountId: "sales", fiscalYear: 2024, month: 1, amount: 1000 },
    { accountId: "materials", fiscalYear: 2024, month: 1, amount: 400 },
    { accountId: "rent", fiscalYear: 2024, month: 1, amount: 250 },
  ];
  const build = (a: Account[], e: GlEntry[]) =>
    buildIncomeStatement(a, e, buildPeriods(e, [2024], "annual"), "annual");

  it("reports gross profit as revenue less cost of sales", () => {
    const statement = build(accountsWithCogs, rows);
    expect(statement.costOfSales["2024"]).toBeCloseTo(400, 2);
    expect(statement.grossProfit["2024"]).toBeCloseTo(600, 2);
  });

  it("keeps cost of sales inside expenses, so net income is unchanged", () => {
    // The bottom line must not depend on how finely the accounts are split.
    // Reclassifying Materials from expense to cogs moves gross profit and
    // nothing else.
    const asExpense = accountsWithCogs.map((a) =>
      a.id === "materials" ? { ...a, accountType: "expense" as const } : a,
    );
    const split = build(accountsWithCogs, rows);
    const merged = build(asExpense, rows);

    expect(split.netIncome["2024"]).toBeCloseTo(merged.netIncome["2024"]!, 2);
    expect(split.expenses["2024"]).toBeCloseTo(merged.expenses["2024"]!, 2);
    expect(merged.grossProfit["2024"]).toBeCloseTo(1000, 2);
    expect(split.grossProfit["2024"]).toBeCloseTo(600, 2);
  });

  it("signs a cost-of-sales account negative, like any other cost", () => {
    const statement = build(accountsWithCogs, rows);
    expect(statement.byAccount.get("materials")!["2024"]).toBeCloseTo(-400, 2);
    expect(statement.ledgerByAccount.get("materials")!["2024"]).toBeCloseTo(400, 2);
  });

  it("reports gross profit equal to revenue when nothing is classified cogs", () => {
    // Undefined, not zero — and saying so beats inferring a cost of sales from
    // account names, which is the inference this engine exists to remove.
    const statement = annual();
    for (const year of Object.keys(WORKBOOK)) {
      expect(statement.costOfSales[year]).toBeCloseTo(0, 2);
      expect(statement.grossProfit[year]).toBeCloseTo(statement.revenue[year]!, 2);
    }
  });
});
