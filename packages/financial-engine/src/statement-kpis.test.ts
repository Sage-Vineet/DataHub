import { describe, expect, it } from "vitest";
import type { StatementNode } from "./statement-cash-flow.js";
import { allNodes, findAmount, readStatementKpis, toKpiTrend } from "./statement-kpis.js";

/**
 * The headline figures a dashboard shows for a year.
 *
 * The two defects here are the same shape twice: treating a genuine ZERO as an
 * absence. A company that broke even exactly, and a company with no current
 * liabilities, both got a fabricated figure in place of a real one.
 */

const node = (name: string, amount: number, children?: StatementNode[]): StatementNode => ({
  name,
  amount,
  ...(children ? { children } : {}),
});

describe("reading every line, not just the leaves", () => {
  it("includes the parents, because a total IS a parent", () => {
    const tree = [node("Assets", 500, [node("Cash", 300), node("Stock", 200)])];
    expect(allNodes(tree).map((n) => n.name)).toEqual(["Assets", "Cash", "Stock"]);
  });

  it("copes with nothing", () => {
    expect(allNodes(null)).toEqual([]);
    expect(allNodes(undefined)).toEqual([]);
    expect(allNodes([])).toEqual([]);
  });
});

describe("finding a named figure", () => {
  const nodes = allNodes([
    node("Assets", 0, [node("Total Current Assets", 1000), node("Total Assets", 5000)]),
  ]);

  it("prefers the specific name to the general one", () => {
    // The list runs specific to general. Reversed, a section header's own
    // figure — often zero — is read as the total for the section.
    expect(findAmount(nodes, ["total assets", "assets"])).toEqual({ amount: 5000, found: true });
  });

  it("says when it found nothing, rather than only answering zero", () => {
    // A card cannot render an absence differently from a zero, so the caller
    // needs to be told which it got.
    expect(findAmount(nodes, ["total goodwill"])).toEqual({ amount: 0, found: false });
  });

  it("matches regardless of punctuation and case", () => {
    const punctuated = allNodes([node("Accounts Receivable (A/R)", 250)]);
    expect(findAmount(punctuated, ["accounts receivable a r"]).amount).toBe(250);
  });

  it("takes the first occurrence, so an outer total beats a repeat below", () => {
    const repeated = allNodes([
      node("Total Assets", 5000, [node("Total Assets", 99)]),
    ]);
    expect(findAmount(repeated, ["total assets"]).amount).toBe(5000);
  });

  it("reads a missing or unreadable figure as zero", () => {
    const odd = allNodes([{ name: "Total Assets", amount: null }]);
    expect(findAmount(odd, ["total assets"])).toEqual({ amount: 0, found: true });
  });
});

const BALANCE_SHEET = [
  node("Assets", 0, [
    node("Total Current Assets", 150000),
    node("Total Bank Accounts", 50000),
    node("Total Accounts Receivable", 60000),
    node("Total Inventory", 40000),
    node("Total Assets", 300000),
  ]),
  node("Liabilities", 0, [
    node("Total Current Liabilities", 80000),
    node("Total Accounts Payable", 30000),
    node("Total Long Term Liabilities", 100000),
    node("Total Liabilities", 180000),
  ]),
  node("Total Equity", 120000),
];

const PROFIT_LOSS = [
  node("Total Income", 500000),
  node("Total Expenses", 380000),
  node("Net Income", 120000),
];

describe("the figures it reads", () => {
  const kpis = readStatementKpis(BALANCE_SHEET, PROFIT_LOSS);

  it("finds each one", () => {
    expect(kpis).toMatchObject({
      totalRevenue: 500000,
      totalExpenses: 380000,
      netProfit: 120000,
      totalAssets: 300000,
      totalLiabilities: 180000,
      totalEquity: 120000,
      cashAndBankBalance: 50000,
      accountsReceivable: 60000,
      inventoryValue: 40000,
      accountsPayable: 30000,
      longTermDebt: 100000,
    });
  });

  it("takes working capital from the statement's own subtotals", () => {
    expect(kpis.workingCapital).toBe(70000);
  });

  it("forces the expense total positive", () => {
    // Statements disagree about the sign of a cost total, and a card reading
    // "-450,000 expenses" is read as a credit.
    const negated = readStatementKpis(BALANCE_SHEET, [
      node("Total Income", 500000),
      node("Total Expenses", -380000),
    ]);
    expect(negated.totalExpenses).toBe(380000);
  });
});

describe("a zero that is a real figure", () => {
  it("believes a net profit of exactly zero", () => {
    // The defect: `netProfitRaw !== 0 ? netProfitRaw : revenue - expenses`
    // replaced a real break-even with a computed number. A company that broke
    // even exactly showed a fabricated figure.
    const kpis = readStatementKpis(BALANCE_SHEET, [
      node("Total Income", 500000),
      node("Total Expenses", 480000),
      node("Net Income", 0),
    ]);
    expect(kpis.netProfit).toBe(0);
  });

  it("still computes a net profit the statement does not state", () => {
    // The fallback is for an ABSENT line, which is what it was for.
    const kpis = readStatementKpis(BALANCE_SHEET, [
      node("Total Income", 500000),
      node("Total Expenses", 380000),
    ]);
    expect(kpis.netProfit).toBe(120000);
  });

  it("believes current liabilities of exactly zero", () => {
    // `currentAssets && currentLiabilities` treats 0 as absent, so a company
    // with NO current liabilities — a real and good position — took the
    // fallback and had its working capital computed from a different set of
    // accounts entirely.
    const kpis = readStatementKpis(
      [
        node("Total Current Assets", 150000),
        node("Total Current Liabilities", 0),
        node("Total Bank Accounts", 1),
        node("Total Accounts Receivable", 1),
      ],
      PROFIT_LOSS,
    );
    expect(kpis.workingCapital).toBe(150000);
  });

  it("falls back to the components when a subtotal is genuinely absent", () => {
    const kpis = readStatementKpis(
      [
        node("Total Bank Accounts", 50000),
        node("Total Accounts Receivable", 60000),
        node("Total Inventory", 40000),
        node("Total Accounts Payable", 30000),
      ],
      PROFIT_LOSS,
    );
    expect(kpis.workingCapital).toBe(120000);
  });
});

describe("statements it cannot read", () => {
  it("answers zeroes rather than failing", () => {
    const kpis = readStatementKpis([], []);
    expect(kpis.totalRevenue).toBe(0);
    expect(kpis.netProfit).toBe(0);
    expect(kpis.workingCapital).toBe(0);
  });

  it("copes with nothing at all", () => {
    expect(readStatementKpis(null, undefined).totalAssets).toBe(0);
  });

  it("reads a P&L with no balance sheet beside it", () => {
    const kpis = readStatementKpis(null, PROFIT_LOSS);
    expect(kpis.totalRevenue).toBe(500000);
    expect(kpis.totalAssets).toBe(0);
  });
});

describe("the trend line", () => {
  it("runs oldest first, which is the order a chart draws it", () => {
    const trend = toKpiTrend([
      { year: 2024, kpis: readStatementKpis(BALANCE_SHEET, PROFIT_LOSS) },
      { year: 2022, kpis: readStatementKpis(BALANCE_SHEET, PROFIT_LOSS) },
      { year: 2023, kpis: readStatementKpis(BALANCE_SHEET, PROFIT_LOSS) },
    ]);
    expect(trend.map((p) => p.year)).toEqual(["2022", "2023", "2024"]);
  });

  it("carries the three figures a chart plots", () => {
    const [point] = toKpiTrend([
      { year: 2024, kpis: readStatementKpis(BALANCE_SHEET, PROFIT_LOSS) },
    ]);
    expect(point).toEqual({
      year: "2024",
      revenue: 500000,
      expenses: 380000,
      netProfit: 120000,
    });
  });

  it("makes nothing of nothing", () => {
    expect(toKpiTrend([])).toEqual([]);
  });
});
