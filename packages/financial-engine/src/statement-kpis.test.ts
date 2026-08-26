import { describe, expect, it } from "vitest";
import type { StatementNode } from "./statement-cash-flow.js";
import {
  allNodes,
  findAmount,
  readStatementKpis,
  readTaxComparisonFigures,
  statementYear,
  toKpiTrend,
} from "./statement-kpis.js";

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

describe("the tax-comparison figures from an uploaded statement", () => {
  const PL = [
    node("Total Income", 1000000),
    node("Total Cost of Goods Sold", 400000),
    node("Gross Profit", 600000),
    node("Expenses", 0, [
      node("Officer Compensation", 150000),
      node("Depreciation Expense", 50000),
      node("Amortization Expense", 10000),
      node("Interest Expense", 20000),
      node("Rent", 70000),
    ]),
    node("Total Expenses", 300000),
    node("Net Income", 300000),
  ];

  it("reads each named figure", () => {
    const figures = readTaxComparisonFigures(PL, 2024);
    expect(figures).toMatchObject({
      year: 2024,
      totalRevenue: 1000000,
      totalCostOfGoodsSold: 400000,
      grossProfit: 600000,
      officerWages: 150000,
      depreciation: 50000,
      amortization: 10000,
      interestExpense: 20000,
      netIncome: 300000,
    });
  });

  it("derives what is left after the named costs", () => {
    // 300000 − (150000 + 50000 + 10000 + 20000)
    expect(readTaxComparisonFigures(PL, 2024).allOtherExpenses).toBe(70000);
  });

  it("does NOT clamp a negative remainder to zero", () => {
    // `Math.max(0, total - named)` hid the inconsistency. A negative here means
    // the named costs exceed the total — usually because one was matched twice
    // — and that belongs on screen rather than rounded away.
    const inconsistent = [
      node("Total Expenses", 100000),
      node("Officer Compensation", 150000),
    ];
    expect(readTaxComparisonFigures(inconsistent, 2024).allOtherExpenses).toBe(-50000);
  });

  it("does not let a short label match a long pattern", () => {
    // The matcher this replaces tested `pattern.includes(label)` as well, so a
    // row called "Interest" was read as "total interest expense" and a row
    // called "Income" as "total income".
    const loose = [node("Interest", 999), node("Total Interest Expense", 20000)];
    expect(readTaxComparisonFigures(loose, 2024).interestExpense).toBe(20000);
  });

  it("prefers a total to a section header of the same idea", () => {
    const both = [node("Expenses", 1), node("Total Expenses", 300000)];
    expect(readTaxComparisonFigures(both, 2024).allOtherExpenses).toBe(300000);
  });

  it("computes net income when the statement does not state it", () => {
    const noNet = [node("Total Income", 500000), node("Total Expenses", 200000)];
    expect(readTaxComparisonFigures(noNet, 2024).netIncome).toBe(300000);
  });

  it("answers zeroes for a statement it cannot read", () => {
    expect(readTaxComparisonFigures([], 2024).totalRevenue).toBe(0);
    expect(readTaxComparisonFigures(null, 2024).year).toBe(2024);
  });
});

describe("which year a statement covers", () => {
  it("believes the statement's own dates", () => {
    expect(statementYear({ asOfDate: "2023-12-31" }, "Accounts 2024.pdf", 2026)).toBe(2023);
    expect(statementYear({ periodEnd: "2022-12-31" }, null, 2026)).toBe(2022);
    expect(statementYear({ periodStart: "2021-01-01" }, null, 2026)).toBe(2021);
  });

  it("falls back to the filename only when the statement says nothing", () => {
    // A filename year is a guess about how somebody named a file. Preferring
    // it is how "2023 Accounts.pdf" holding 2024 figures ends up filed under
    // 2023.
    expect(statementYear({}, "Accounts 2024.pdf", 2026)).toBe(2024);
  });

  it("refuses a year that could not be a statement's", () => {
    expect(statementYear({ asOfDate: "1899-12-31" }, null, 2026)).toBe(2026);
    expect(statementYear({}, "Invoice 1999.pdf", 2026)).toBe(2026);
    // Next year is allowed: a statement can be filed early.
    expect(statementYear({ asOfDate: "2027-12-31" }, null, 2026)).toBe(2027);
    expect(statementYear({ asOfDate: "2028-12-31" }, null, 2026)).toBe(2026);
  });

  it("falls back to the year it was given when nothing else says", () => {
    expect(statementYear({}, null, 2026)).toBe(2026);
  });
});
