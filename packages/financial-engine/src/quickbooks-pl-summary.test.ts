import { describe, expect, it } from "vitest";
import {
  readProfitAndLossSummary,
  toTaxReconciliationRows,
} from "./quickbooks-pl-summary.js";

/**
 * The nine figures a tax reconciliation compares against a return.
 *
 * The defect that drives most of this: the old reader recursed into a row's
 * children AND matched the row itself, so a section and its own detail both
 * counted. Depreciation came out at twice its real value, every add-back built
 * on it was wrong, and nothing else used the figure so nothing disagreed.
 */

const report = (rows: unknown) => ({
  Columns: {
    Column: [
      { ColTitle: "", ColType: "account_name" },
      { ColTitle: "Total", ColType: "subt_nat_amount" },
    ],
  },
  Rows: { Row: rows },
});

const line = (label: string, amount: string) => ({
  type: "Data",
  ColData: [{ value: label }, { value: amount }],
});

const group = (label: string, children: unknown[], total: string) => ({
  type: "Section",
  Header: { ColData: [{ value: label }, { value: "" }] },
  Rows: { Row: children },
  Summary: { ColData: [{ value: `Total ${label}` }, { value: total }] },
});

describe("the figures it reads", () => {
  const summary = readProfitAndLossSummary(
    report([
      line("Total Income", "500000.00"),
      line("Total Cost of Goods Sold", "200000.00"),
      line("Gross Profit", "300000.00"),
      line("Officer Wages", "80000.00"),
      line("Depreciation", "25000.00"),
      line("Amortization", "5000.00"),
      line("Interest Expense", "10000.00"),
      line("Net Income", "150000.00"),
    ]),
  );

  it("finds each named figure", () => {
    expect(summary.totalRevenue).toBe(500000);
    expect(summary.totalCostOfGoodsSold).toBe(200000);
    expect(summary.grossProfit).toBe(300000);
    expect(summary.officerWages).toBe(80000);
    expect(summary.depreciation).toBe(25000);
    expect(summary.amortization).toBe(5000);
    expect(summary.interestExpense).toBe(10000);
    expect(summary.netIncome).toBe(150000);
  });

  it("derives everything else so the nine reconcile", () => {
    // 300000 − 80000 − 25000 − 5000 − 10000 − 150000
    expect(summary.allOtherExpenses).toBe(30000);
  });
});

describe("a section and its own detail", () => {
  it("counts the section once, not once per child", () => {
    // The defect. A "Depreciation" section with two children plus its own
    // total added all three, and depreciation came out at twice its value.
    const summary = readProfitAndLossSummary(
      report([
        group(
          "Depreciation",
          [line("Depreciation — Vehicles", "15000.00"), line("Depreciation — Equipment", "10000.00")],
          "25000.00",
        ),
      ]),
    );
    expect(summary.depreciation).toBe(25000);
  });

  it("still adds two separate occurrences in different places", () => {
    // Two unrelated depreciation lines in different sections are two costs,
    // not one counted twice. The rule is about a row being INSIDE another, not
    // about the label appearing more than once.
    const summary = readProfitAndLossSummary(
      report([
        group("Cost of Sales", [line("Depreciation — Plant", "10000.00")], "10000.00"),
        group("Overheads", [line("Depreciation — Office", "4000.00")], "4000.00"),
      ]),
    );
    expect(summary.depreciation).toBe(14000);
  });

  it("takes the outermost total when sections nest", () => {
    const summary = readProfitAndLossSummary(
      report([
        group(
          "Expenses",
          [group("Depreciation", [line("Depreciation — Vehicles", "15000.00")], "15000.00")],
          "15000.00",
        ),
      ]),
    );
    expect(summary.depreciation).toBe(15000);
  });
});

describe("labels that look alike", () => {
  it("does not read 'Total Other Income' as revenue", () => {
    // Exact match before contains: "Total Income" is the revenue line and
    // "Total Other Income" is not, and a contains rule claims both.
    const summary = readProfitAndLossSummary(
      report([line("Total Income", "500000.00"), line("Total Other Income", "12000.00")]),
    );
    expect(summary.totalRevenue).toBe(500000);
  });

  it("separates interest income from interest expense", () => {
    const summary = readProfitAndLossSummary(
      report([line("Interest Expense", "10000.00"), line("Interest Income", "500.00")]),
    );
    expect(summary.interestExpense).toBe(10000);
    expect(summary.interestIncome).toBe(500);
  });

  it("does not read an officer's insurance as wages", () => {
    // A benefit rather than pay; it belongs in other expenses.
    const summary = readProfitAndLossSummary(
      report([line("Officer Wages", "80000.00"), line("Officer Life Insurance", "4000.00")]),
    );
    expect(summary.officerWages).toBe(80000);
  });

  it("puts a combined D&A line in amortization, once", () => {
    // Splitting a combined line between the two would be a guess at a ratio
    // nobody stated. Counting it in both would double it.
    const summary = readProfitAndLossSummary(
      report([line("Depreciation and Amortization", "30000.00")]),
    );
    expect(summary.amortization).toBe(30000);
    expect(summary.depreciation).toBe(0);
  });
});

describe("the amounts", () => {
  it("reads a figure with thousands separators", () => {
    // `Number("1,234.56") || 0` is 0. Any P&L whose figures carry separators
    // read as ZERO throughout — not an error, a report of a company with no
    // revenue and no costs.
    const summary = readProfitAndLossSummary(report([line("Total Income", "1,234,567.89")]));
    expect(summary.totalRevenue).toBe(1234567.89);
  });

  it("reads accounting parentheses as negative", () => {
    const summary = readProfitAndLossSummary(report([line("Net Income", "(50,000.00)")]));
    expect(summary.netIncome).toBe(-50000);
  });

  it("takes the figure from a summary row with fewer cells than columns", () => {
    // A summary often carries only a label and a total, so a positional read
    // against the full column set finds nothing.
    const summary = readProfitAndLossSummary({
      Columns: {
        Column: [
          { ColTitle: "", ColType: "account_name" },
          { ColTitle: "Jan", ColType: "subt_nat_amount" },
          { ColTitle: "Feb", ColType: "subt_nat_amount" },
          { ColTitle: "Total", ColType: "subt_nat_amount" },
        ],
      },
      Rows: {
        Row: [
          {
            type: "Section",
            Header: { ColData: [{ value: "Depreciation" }] },
            Rows: { Row: [] },
            Summary: { ColData: [{ value: "Total Depreciation" }, { value: "25000.00" }] },
          },
        ],
      },
    });
    expect(summary.depreciation).toBe(25000);
  });

  it("skips a row whose figure cannot be read rather than counting it as zero", () => {
    const summary = readProfitAndLossSummary(
      report([line("Depreciation", "n/a"), line("Depreciation — Real", "1000.00")]),
    );
    expect(summary.depreciation).toBe(1000);
  });
});

describe("a report with nothing in it", () => {
  it("answers zeroes rather than failing", () => {
    const summary = readProfitAndLossSummary(report([]));
    expect(summary.totalRevenue).toBe(0);
    expect(summary.allOtherExpenses).toBe(0);
  });

  it("copes with no report at all", () => {
    expect(readProfitAndLossSummary(null).netIncome).toBe(0);
    expect(readProfitAndLossSummary(undefined).netIncome).toBe(0);
  });
});

describe("the page's rows", () => {
  it("renders the nine labels in order", () => {
    const rows = toTaxReconciliationRows(readProfitAndLossSummary(report([])));
    expect(rows.map((r) => r.label)).toEqual([
      "Total Revenue",
      "Total Cost of Goods Sold",
      "Gross Profit",
      "Officer Wages",
      "Depreciation Expense",
      "Amortization Expense",
      "Total Interest Expense",
      "All Other Expenses",
      "Net Income",
    ]);
  });

  it("carries the figures across", () => {
    const rows = toTaxReconciliationRows(
      readProfitAndLossSummary(report([line("Total Income", "500000.00")])),
    );
    expect(rows.find((r) => r.label === "Total Revenue")!.pl).toBe(500000);
  });
});
