import { describe, expect, it } from "vitest";
import type { Account, GlEntry } from "@datahub/financial-engine";
import type { EngagementData } from "../../shared/engagement.drizzle.js";
import {
  buildProfitLossSummary,
  buildSummaryLines,
  buildYearComparison,
  categoryOf,
  finalizeLine,
  type PlRow,
  type PlYearRow,
} from "./profit-loss-view.js";

/**
 * The Profit & Loss payload.
 *
 * The legacy handler this replaces cannot run — it reads a staging table that
 * is empty and a snapshot table that does not exist — so there is no working
 * behaviour to diff against. What can be checked is stronger anyway: a P&L
 * either foots or it does not, and the totals the page renders must equal the
 * accounts underneath them.
 */

const accounts: Account[] = [
  { id: "sales", name: "Sales", statementType: "profit_loss", accountType: "income" },
  { id: "fees", name: "Consulting Fees", statementType: "profit_loss", accountType: "income" },
  { id: "materials", name: "Materials", statementType: "profit_loss", accountType: "cogs" },
  { id: "rent", name: "Rent", statementType: "profit_loss", accountType: "expense" },
  { id: "wages", name: "Wages", statementType: "profit_loss", accountType: "expense" },
  { id: "cash", name: "Cash", statementType: "balance_sheet", accountType: "asset" },
];

const entries: GlEntry[] = [
  { accountId: "sales", fiscalYear: 2023, month: 3, amount: 800 },
  { accountId: "fees", fiscalYear: 2023, month: 4, amount: 200 },
  { accountId: "materials", fiscalYear: 2023, month: 3, amount: 300 },
  { accountId: "rent", fiscalYear: 2023, month: 5, amount: 120 },
  { accountId: "wages", fiscalYear: 2023, month: 5, amount: 180 },
  // A balance-sheet account in the same ledger, which must not reach the P&L.
  { accountId: "cash", fiscalYear: 2023, month: 5, amount: 400 },

  { accountId: "sales", fiscalYear: 2024, month: 1, amount: 1200 },
  { accountId: "materials", fiscalYear: 2024, month: 1, amount: 500 },
  { accountId: "rent", fiscalYear: 2024, month: 2, amount: 130 },
  { accountId: "wages", fiscalYear: 2024, month: 2, amount: 170 },
];

const engagement: EngagementData = {
  companyId: "co-1",
  companyName: "Acme Manufacturing",
  profitMetric: "adjusted_ebitda",
  marketRateReplacementSalary: null,
  fiscalYears: [2023, 2024],
  accounts,
  entries,
  anchors: [],
};

const rowById = (rows: PlRow[], id: string): PlRow | undefined => {
  for (const row of rows) {
    if (row.id === id) return row;
    const found = row.children ? rowById(row.children, id) : undefined;
    if (found) return found;
  }
  return undefined;
};

describe("which bucket an account lands in", () => {
  it("takes the bucket from the account's type, never its name", () => {
    // "Cost of Goods Sold Reserve" is an expense here. Legacy's regex would
    // have made it COGS on the strength of the words alone.
    expect(
      categoryOf({ statementType: "profit_loss", accountType: "expense" }),
    ).toBe("Operating Expenses");
    expect(categoryOf({ statementType: "profit_loss", accountType: "cogs" })).toBe("COGS");
    expect(categoryOf({ statementType: "profit_loss", accountType: "income" })).toBe("Revenue");
  });

  it("keeps balance-sheet accounts off the statement entirely", () => {
    expect(categoryOf({ statementType: "balance_sheet", accountType: "asset" })).toBeNull();
    expect(categoryOf({ statementType: "balance_sheet", accountType: "equity" })).toBeNull();
  });

  it("returns nothing for a P&L account with no classification", () => {
    expect(categoryOf({ statementType: "profit_loss", accountType: null })).toBeNull();
  });
});

describe("the metric arithmetic", () => {
  it("derives gross profit, operating income and net profit from the buckets", () => {
    const line = finalizeLine({
      Revenue: 1000,
      COGS: 300,
      "Operating Expenses": 200,
      "Other Expenses": 50,
    });
    expect(line["Gross Profit"]).toBe(700);
    expect(line["Operating Income"]).toBe(500);
    expect(line["Net Profit"]).toBe(450);
  });

  it("makes operating income and net profit equal when nothing sits below the line", () => {
    const line = finalizeLine({
      Revenue: 1000,
      COGS: 0,
      "Operating Expenses": 400,
      "Other Expenses": 0,
    });
    expect(line["Operating Income"]).toBe(line["Net Profit"]);
  });
});

describe("the summary payload", () => {
  const payload = buildProfitLossSummary(engagement);

  it("covers every year in the engagement when none is asked for", () => {
    expect(payload.years).toEqual([2023, 2024]);
    expect(payload.displayYear).toBe(2024);
  });

  it("foots: revenue less every cost equals net profit, each year", () => {
    for (const row of payload.yearComparison) {
      expect(row.netProfit).toBeCloseTo(
        row.revenue - row.cogs - row.operatingExpenses - row.otherExpenses,
        2,
      );
      expect(row.grossProfit).toBeCloseTo(row.revenue - row.cogs, 2);
    }
  });

  it("reports the figures the ledger actually contains", () => {
    const fy2024 = payload.yearComparison.find((r) => r.fiscalYear === 2024)!;
    expect(fy2024.revenue).toBe(1200);
    expect(fy2024.cogs).toBe(500);
    expect(fy2024.grossProfit).toBe(700);
    expect(fy2024.operatingExpenses).toBe(300);
    expect(fy2024.netProfit).toBe(400);
  });

  it("leaves the balance-sheet account out of every bucket", () => {
    // Cash moved 400 in FY2023. If it leaked into the P&L, revenue or expenses
    // would be out by exactly that.
    const fy2023 = payload.yearComparison.find((r) => r.fiscalYear === 2023)!;
    expect(fy2023.revenue).toBe(1000);
    expect(fy2023.operatingExpenses).toBe(300);
    expect(fy2023.netProfit).toBe(400);
  });

  it("does not report revenue plus expenses", () => {
    // The inversion that makes `profit_loss_entries` unusable: FY2024 would
    // read 2,000 rather than 400.
    const fy2024 = payload.netProfitByYear[2024];
    expect(fy2024).toBe(400);
    expect(fy2024).not.toBe(1200 + 500 + 300);
  });

  it("breaks the year down by month, and the months sum back to the year", () => {
    const fy2024Months = payload.monthlyBreakdown.filter((m) => m.fiscalYear === 2024);
    expect(fy2024Months.map((m) => m.month)).toEqual(["2024-01", "2024-02"]);
    const summed = fy2024Months.reduce((total, m) => total + m["Net Profit"], 0);
    expect(summed).toBeCloseTo(payload.netProfitByYear[2024]!, 2);
  });
});

describe("the rows the page renders", () => {
  const payload = buildProfitLossSummary(engagement, { fiscalYears: [2023, 2024] });
  const rows = payload.hierarchicalRows;

  it("names a comparative column per requested year", () => {
    expect(payload.yearCols).toEqual([
      { key: "y2023", label: "2023" },
      { key: "y2024", label: "2024" },
    ]);
  });

  it("totals each section to the accounts inside it", () => {
    // The one thing a reader checks by eye, and the one thing a presenter can
    // get wrong without any arithmetic being wrong.
    for (const id of ["income", "cogs", "expenses"]) {
      const section = rowById(rows, id)!;
      const accountRows = section.children!.filter((c) => c.type === "data");
      for (const key of ["y2023", "y2024"]) {
        const summed = accountRows.reduce((total, r) => total + (r.amounts[key] ?? 0), 0);
        expect(section.amounts[key]).toBeCloseTo(summed, 2);
      }
    }
  });

  it("puts the accounts under the section their type chose", () => {
    expect(rowById(rows, "income")!.children!.map((c) => c.name)).toEqual([
      "Consulting Fees",
      "Sales",
      "Total Income",
    ]);
    expect(rowById(rows, "cogs")!.children!.map((c) => c.name)).toEqual([
      "Materials",
      "Total Cost of Goods Sold",
    ]);
    expect(rowById(rows, "expenses")!.children!.map((c) => c.name)).toEqual([
      "Rent",
      "Wages",
      "Total Expenses",
    ]);
  });

  it("carries positive magnitudes for costs, so the subtraction reads plainly", () => {
    expect(rowById(rows, "cogs")!.amounts["y2024"]).toBe(500);
    expect(rowById(rows, "expenses")!.amounts["y2024"]).toBe(300);
  });

  it("ties the net income row to the year comparison", () => {
    const netIncome = rowById(rows, "net-income")!;
    expect(netIncome.amounts["y2024"]).toBeCloseTo(
      payload.yearComparison.find((r) => r.fiscalYear === 2024)!.netProfit,
      2,
    );
    expect(netIncome.amounts["y2023"]).toBeCloseTo(
      payload.yearComparison.find((r) => r.fiscalYear === 2023)!.netProfit,
      2,
    );
  });

  it("makes gross profit the difference between the two sections above it", () => {
    const gross = rowById(rows, "gross-profit")!;
    const income = rowById(rows, "income")!;
    const cogs = rowById(rows, "cogs")!;
    expect(gross.amounts["y2024"]).toBeCloseTo(
      income.amounts["y2024"]! - cogs.amounts["y2024"]!,
      2,
    );
  });

  it("omits the below-the-line section rather than showing an empty one", () => {
    // Nothing is classified there while the split comes from account type
    // alone, so net operating income and net income agree — as they should.
    expect(rowById(rows, "other-income-expense")).toBeUndefined();
    expect(rowById(rows, "net-operating-income")!.amounts).toEqual(
      rowById(rows, "net-income")!.amounts,
    );
  });

  it("sets the scalar amount to the latest requested year", () => {
    const netIncome = rowById(rows, "net-income")!;
    expect(netIncome.amount).toBe(netIncome.amounts["y2024"]);
  });

  it("omits an account that never moved in the years on show", () => {
    // Consulting Fees has FY2023 activity only. Asking for FY2024 alone must
    // not print a row of zeroes.
    const only2024 = buildProfitLossSummary(engagement, { fiscalYears: [2024] });
    const names = rowById(only2024.hierarchicalRows, "income")!.children!.map((c) => c.name);
    expect(names).toEqual(["Sales", "Total Income"]);
  });
});

describe("a ledger with entries the chart does not explain", () => {
  it("leaves out an entry whose account is not on the chart", () => {
    // An amount attributed to an account nobody can name is an amount on the
    // statement that cannot be drilled into, and it still moves net profit.
    const orphaned: EngagementData = {
      ...engagement,
      entries: [...entries, { accountId: "ghost", fiscalYear: 2024, month: 1, amount: 9_999 }],
    };
    const withGhost = buildProfitLossSummary(orphaned, {});
    const without = buildProfitLossSummary(engagement, {});
    expect(withGhost.lines).toEqual(without.lines);
  });

  it("counts an entry with no month in the year, but not in any month", () => {
    // A year-dated entry belongs to the year. Filed under a month it did not
    // state, it would appear in a monthly column somebody could not reconcile.
    const undated: EngagementData = {
      ...engagement,
      entries: [{ accountId: "sales", fiscalYear: 2024, month: null as never, amount: 500 }],
      fiscalYears: [2024],
    };
    const result = buildProfitLossSummary(undated, {});
    expect(result.lines.find((l) => l.key === "revenue")!.valuesByYear[2024]).toBe(500);
    expect(result.monthlyBreakdown).toEqual([]);
  });
});

describe("choosing the years", () => {
  it("shows the latest year alone, with no comparative columns, by default", () => {
    const payload = buildProfitLossSummary(engagement);
    expect(payload.yearCols).toBeUndefined();
    expect(Object.keys(rowById(payload.hierarchicalRows, "net-income")!.amounts)).toEqual([
      "y2024",
    ]);
  });

  it("ignores a year the engagement has no data for", () => {
    const payload = buildProfitLossSummary(engagement, { fiscalYears: [2024, 2099] });
    expect(payload.years).toEqual([2024]);
  });

  it("survives a filter that selects nothing at all", () => {
    // An empty statement, not a crash and not last year's numbers.
    const payload = buildProfitLossSummary(engagement, { fiscalYears: [2099] });
    expect(payload.years).toEqual([]);
    expect(payload.yearComparison).toEqual([]);
    expect(payload.monthlyBreakdown).toEqual([]);
  });

  it("discards a nonsense year rather than treating it as a column", () => {
    const payload = buildProfitLossSummary(engagement, { fiscalYears: [0, -1, 2024] });
    expect(payload.yearCols).toEqual([{ key: "y2024", label: "2024" }]);
  });
});

describe("the summary lines", () => {
  const rows: PlYearRow[] = [
    finalizeLine({ Revenue: 100, COGS: 40, "Operating Expenses": 30, "Other Expenses": 0 }),
    finalizeLine({ Revenue: 200, COGS: 80, "Operating Expenses": 60, "Other Expenses": 0 }),
  ].map((row, i) => ({ ...row, fiscalYear: 2023 + i }));

  it("carries one line per metric, keyed for the page", () => {
    const { lines } = buildSummaryLines(rows);
    expect(lines.map((l) => l.key)).toEqual([
      "revenue",
      "cogs",
      "gross_profit",
      "operating_expenses",
      "operating_income",
      "other_expenses",
      "net_profit",
    ]);
  });

  it("consolidates by adding the years in view", () => {
    const { lines } = buildSummaryLines(rows);
    expect(lines.find((l) => l.key === "revenue")!.consolidated).toBe(300);
    expect(lines.find((l) => l.key === "net_profit")!.consolidated).toBe(90);
  });

  it("reads a year with no row as zero rather than leaving a hole", () => {
    // A missing year renders as a blank cell in a column of numbers, which is
    // read as "not loaded" rather than as "nothing happened".
    const sparse: PlYearRow[] = [{ ...rows[0]!, fiscalYear: 2023 }];
    const { lines } = buildSummaryLines([...sparse, { ...rows[1]!, fiscalYear: Number.NaN }]);
    expect(lines[0]!.valuesByYear[2023]).toBe(100);
  });

  it("leaves out a year that is not one", () => {
    // A row whose fiscal year never parsed cannot head a column.
    const { years } = buildSummaryLines([
      { ...rows[0]!, fiscalYear: Number.NaN },
      { ...rows[1]!, fiscalYear: 2024 },
    ]);
    expect(years).toEqual([2024]);
  });
});

describe("year-on-year movement", () => {
  const rows: PlYearRow[] = [
    { fiscalYear: 2023, Revenue: 0, COGS: 0, "Operating Expenses": 0, "Other Expenses": 0, "Gross Profit": 0, "Operating Income": 0, "Net Profit": 100 },
    { fiscalYear: 2024, Revenue: 0, COGS: 0, "Operating Expenses": 0, "Other Expenses": 0, "Gross Profit": 0, "Operating Income": 0, "Net Profit": 150 },
  ];

  it("reports the change and its percentage", () => {
    const [, second] = buildYearComparison(rows);
    expect(second!.netProfitDeltaVsPreviousYear).toBe(50);
    expect(second!.netProfitDeltaPctVsPreviousYear).toBe(50);
  });

  it("gives the first year no percentage, rather than zero", () => {
    const [first] = buildYearComparison(rows);
    expect(first!.netProfitDeltaPctVsPreviousYear).toBeNull();
  });

  it("gives no percentage against a break-even year, rather than infinity", () => {
    const flat: PlYearRow[] = [
      { ...rows[0]!, "Net Profit": 0 },
      { ...rows[1]!, "Net Profit": 150 },
    ];
    const [, second] = buildYearComparison(flat);
    expect(second!.netProfitDeltaPctVsPreviousYear).toBeNull();
    expect(second!.netProfitDeltaVsPreviousYear).toBe(150);
  });

  it("measures a recovery from a loss against the size of that loss", () => {
    // -100 → +50 is a 150 improvement on a base of 100, so +150%. Dividing by
    // the signed figure would report it as a 150% decline.
    const recovering: PlYearRow[] = [
      { ...rows[0]!, "Net Profit": -100 },
      { ...rows[1]!, "Net Profit": 50 },
    ];
    const [, second] = buildYearComparison(recovering);
    expect(second!.netProfitDeltaPctVsPreviousYear).toBe(150);
  });
});
