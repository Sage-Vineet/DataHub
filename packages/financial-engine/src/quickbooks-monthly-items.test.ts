import { describe, expect, it } from "vitest";
import {
  monthKeyOf,
  monthsBetween,
  readMonthlyLineItems,
  sectionKindOf,
} from "./quickbooks-monthly-items.js";

/**
 * A month-by-month P&L as pickable line items.
 *
 * The two defects that drive this both produce a page that looks fine: an
 * accounting negative read as positive, and an empty picker for any company
 * whose P&L labels its sections anything but "Income" and "Expenses".
 */

const report = (rows: unknown, titles = ["", "Jan 2024", "Feb 2024", "TOTAL"]) => ({
  Columns: { Column: titles.map((ColTitle) => ({ ColTitle, ColType: "" })) },
  Rows: { Row: rows },
});

const line = (label: string, values: string[]) => ({
  type: "Data",
  ColData: [{ value: label }, ...values.map((value) => ({ value }))],
});

const group = (label: string, children: unknown[]) => ({
  type: "Section",
  Header: { ColData: [{ value: label }] },
  Rows: { Row: children },
  Summary: { ColData: [{ value: `Total ${label}` }, { value: "999" }, { value: "999" }] },
});

describe("reading a column title as a month", () => {
  it("reads the format QuickBooks writes", () => {
    expect(monthKeyOf("Jan 2024")).toBe("2024-01");
    expect(monthKeyOf("Dec 2026")).toBe("2026-12");
  });

  it("tolerates a longer month name or a full stop", () => {
    expect(monthKeyOf("January 2024")).toBe("2024-01");
    expect(monthKeyOf("Jan. 2024")).toBe("2024-01");
  });

  it("refuses anything that is not a month rather than guessing", () => {
    // A mis-parsed column puts a whole month's figures under the wrong key,
    // and the total still adds up.
    for (const title of ["TOTAL", "Total", "", "2024", "Q1 2024", null, undefined]) {
      expect(monthKeyOf(title)).toBeNull();
    }
  });
});

describe("which section a heading is", () => {
  it("recognises the labels a chart actually uses", () => {
    // Exact matching on "income" and "expenses" produced an EMPTY picker for
    // any company labelling them otherwise, with nothing to say why.
    for (const label of ["Income", "Revenue", "Sales", "Total Turnover"]) {
      expect(sectionKindOf(label)).toBe("pl_income");
    }
    for (const label of ["Expenses", "Operating Expenses", "Overheads", "COGS"]) {
      expect(sectionKindOf(label)).toBe("pl_expense");
    }
  });

  it("reads cost of sales as an expense, not as income", () => {
    // It contains "sales". Read as income, every cost lands on the revenue
    // side and the picker offers them as things to add BACK to profit.
    expect(sectionKindOf("Cost of Sales")).toBe("pl_expense");
    expect(sectionKindOf("Cost of Goods Sold")).toBe("pl_expense");
  });

  it("says nothing for a heading that is neither", () => {
    for (const label of ["Other", "", "   ", null]) expect(sectionKindOf(label)).toBeNull();
  });
});

describe("the months in a range", () => {
  it("lists them inclusively, across a year boundary", () => {
    expect(monthsBetween("2023-11", "2024-02")).toEqual([
      "2023-11",
      "2023-12",
      "2024-01",
      "2024-02",
    ]);
  });

  it("handles a single month", () => {
    expect(monthsBetween("2024-06", "2024-06")).toEqual(["2024-06"]);
  });

  it("makes nothing of a range it cannot read", () => {
    expect(monthsBetween("soon", "2024-02")).toEqual([]);
    expect(monthsBetween("", "")).toEqual([]);
  });
});

describe("reading the line items", () => {
  const monthly = readMonthlyLineItems(
    report([
      group("Income", [
        line("Product Sales", ["10000.00", "12000.00", "22000.00"]),
        line("Service Revenue", ["5000.00", "0.00", "5000.00"]),
      ]),
      group("Expenses", [
        group("Motor", [line("Fuel", ["800.00", "900.00", "1700.00"])]),
        line("Rent", ["2000.00", "2000.00", "4000.00"]),
      ]),
    ]),
  );

  it("puts each account on the right side", () => {
    expect(monthly.plIncomeItems.map((i) => i.name)).toEqual([
      "Product Sales",
      "Service Revenue",
    ]);
    expect(monthly.plExpenseItems.map((i) => i.name)).toEqual(["Fuel", "Rent"]);
  });

  it("reaches an account nested inside a sub-section", () => {
    expect(monthly.plExpenseItems.find((i) => i.name === "Fuel")).toBeDefined();
  });

  it("keeps the outer section's side for a nested one", () => {
    // "Motor" is neither income nor expense on its own; the section above it
    // decides.
    expect(monthly.plExpenseItems.find((i) => i.name === "Fuel")!.source).toBe("pl_expense");
  });

  it("reads each month from its own column", () => {
    const sales = monthly.plIncomeItems.find((i) => i.name === "Product Sales")!;
    expect(sales.monthAmounts).toEqual({ "2024-01": 10000, "2024-02": 12000 });
  });

  it("leaves the TOTAL column out of the months", () => {
    // Adding it would double every figure in the row's own sum.
    const sales = monthly.plIncomeItems.find((i) => i.name === "Product Sales")!;
    expect(Object.keys(sales.monthAmounts)).toEqual(["2024-01", "2024-02"]);
  });

  it("omits a month with nothing in it rather than storing a zero", () => {
    // The picker renders a blank cell; a stored zero renders as "0.00", which
    // reads as a figure somebody checked.
    const service = monthly.plIncomeItems.find((i) => i.name === "Service Revenue")!;
    expect(service.monthAmounts).toEqual({ "2024-01": 5000 });
  });

  it("adds each side up per month", () => {
    expect(monthly.plTotalIncome).toEqual({ "2024-01": 15000, "2024-02": 12000 });
    expect(monthly.plTotalExpenses).toEqual({ "2024-01": 2800, "2024-02": 2900 });
  });

  it("offers only the accounts, not the section totals", () => {
    // A summary is its children added up. Offering both lets somebody add a
    // total and one of its parts as two separate add-backs.
    const names = [...monthly.plIncomeItems, ...monthly.plExpenseItems].map((i) => i.name);
    expect(names.some((n) => n.startsWith("Total"))).toBe(false);
  });
});

describe("the amounts", () => {
  it("reads an accounting negative as negative", () => {
    // `parseFloat("(1,200.00)".replace(/,/g, ""))` is 1200 — POSITIVE. A
    // credit note read as a cost of the same size moves the month's total by
    // twice the figure, in the wrong direction.
    const monthly = readMonthlyLineItems(
      report([group("Income", [line("Refunds", ["(1,200.00)", "0", "(1,200.00)"])])]),
    );
    expect(monthly.plIncomeItems[0]!.monthAmounts["2024-01"]).toBe(-1200);
  });

  it("reads thousands separators", () => {
    const monthly = readMonthlyLineItems(
      report([group("Income", [line("Sales", ["1,234,567.89", "0", "1,234,567.89"])])]),
    );
    expect(monthly.plIncomeItems[0]!.monthAmounts["2024-01"]).toBe(1234567.89);
  });

  it("skips a cell it cannot read rather than counting it as zero", () => {
    const monthly = readMonthlyLineItems(
      report([group("Income", [line("Sales", ["n/a", "500.00", "500.00"])])]),
    );
    expect(monthly.plIncomeItems[0]!.monthAmounts).toEqual({ "2024-02": 500 });
  });

  it("rounds a month's total to the cent", () => {
    const monthly = readMonthlyLineItems(
      report([
        group("Income", [line("A", ["0.10", "0", "0.10"]), line("B", ["0.20", "0", "0.20"])]),
      ]),
    );
    expect(monthly.plTotalIncome["2024-01"]).toBe(0.3);
  });
});

describe("a report with nothing usable", () => {
  it("answers empty lists rather than failing", () => {
    const monthly = readMonthlyLineItems(report([]));
    expect(monthly).toEqual({
      plIncomeItems: [],
      plExpenseItems: [],
      plTotalIncome: {},
      plTotalExpenses: {},
    });
  });

  it("ignores an account outside any recognised section", () => {
    const monthly = readMonthlyLineItems(
      report([group("Something Else", [line("Mystery", ["100", "100", "200"])])]),
    );
    expect(monthly.plIncomeItems).toEqual([]);
    expect(monthly.plExpenseItems).toEqual([]);
  });

  it("copes with no report at all", () => {
    expect(readMonthlyLineItems(null).plIncomeItems).toEqual([]);
  });
});
