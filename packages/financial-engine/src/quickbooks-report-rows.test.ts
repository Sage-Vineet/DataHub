import { describe, expect, it } from "vitest";
import {
  cellOf,
  columnsOf,
  dataRowsOf,
  flattenReportRows,
  toAmount,
  toLedgerTransactions,
} from "./quickbooks-report-rows.js";

/**
 * Reading the rows out of a QuickBooks report.
 *
 * Two defects drive most of this. Cells were read at FIXED POSITIONS, so a
 * report with a different column set silently shifted every field by one — the
 * running balance read as the amount, and nothing errored. And the tree was
 * walked one level, so a report nesting accounts under sub-accounts lost every
 * transaction below the second.
 */

/** A report with the column set a general ledger usually has. */
const report = (rows: unknown) => ({
  Header: { ReportName: "GeneralLedger" },
  Columns: {
    Column: [
      { ColTitle: "Date", ColType: "tx_date" },
      { ColTitle: "Transaction Type", ColType: "txn_type" },
      { ColTitle: "Num", ColType: "doc_num" },
      { ColTitle: "Name", ColType: "name" },
      { ColTitle: "Memo/Description", ColType: "memo" },
      { ColTitle: "Split", ColType: "split_acc" },
      { ColTitle: "Amount", ColType: "subt_nat_amount" },
      { ColTitle: "Balance", ColType: "rbal_nat_amount" },
    ],
  },
  Rows: { Row: rows },
});

const dataRow = (values: string[]) => ({
  type: "Data",
  ColData: values.map((value) => ({ value })),
});

const section = (label: string, children: unknown[]) => ({
  type: "Section",
  Header: { ColData: [{ value: label }] },
  Rows: { Row: children },
  Summary: { ColData: [{ value: "Total " + label }, { value: "999.00" }] },
});

describe("finding the columns", () => {
  it("reads the types and the titles", () => {
    const columns = columnsOf(report([]));
    expect(columns[0]).toEqual({ type: "tx_date", title: "date" });
    expect(columns[6]).toEqual({ type: "subt_nat_amount", title: "amount" });
  });

  it("copes with a report that has none", () => {
    expect(columnsOf({})).toEqual([]);
    expect(columnsOf(null)).toEqual([]);
  });

  it("reads a column QuickBooks did not send as a list", () => {
    // QuickBooks collapses a single-element list to the element itself in some
    // responses. Treating that as "no columns" loses a report that has exactly
    // one, which is what a single-account general ledger looks like.
    const columns = columnsOf({
      Columns: { Column: { ColType: "tx_date", ColTitle: "Date" } },
    });
    expect(columns).toEqual([{ type: "tx_date", title: "date" }]);
  });

  it("reads a cell value whatever type it arrives as", () => {
    /**
     * QuickBooks types these loosely: a column title can come back as a
     * number, a flag as a boolean, and an absent one as null. Every one has to
     * become a string, because the column titles are matched by name and a
     * non-string reaches `.toLowerCase()` and throws — taking the whole report
     * down over a title.
     */
    const columns = columnsOf({
      Columns: {
        Column: [
          { ColType: 7, ColTitle: 2024 },
          { ColType: true, ColTitle: false },
          { ColType: null, ColTitle: undefined },
          { ColType: { nested: "object" }, ColTitle: ["a", "list"] },
          { ColType: "  spaced  ", ColTitle: "  Amount  " },
        ],
      },
    });

    expect(columns).toEqual([
      { type: "7", title: "2024" },
      { type: "true", title: "false" },
      { type: "", title: "" },
      { type: "", title: "" },
      { type: "spaced", title: "amount" },
    ]);
  });
});

describe("walking the tree", () => {
  it("reaches a transaction nested two sections deep", () => {
    // The old code walked `section.Rows.Row` once, so everything below the
    // second level was simply absent — a ledger with sub-accounts lost most of
    // itself and reported a total that looked plausible.
    const parsed = dataRowsOf(
      report([
        section("Expenses", [
          section("Motor Expenses", [
            dataRow(["2024-01-15", "Expense", "1", "Shell", "Fuel", "Bank", "50.00", "50.00"]),
          ]),
        ]),
      ]),
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.sectionPath).toEqual(["Expenses", "Motor Expenses"]);
  });

  it("labels each row by kind rather than dropping any", () => {
    // Different readers want different rows: a ledger wants transactions, a
    // profit-and-loss wants the section TOTALS. Dropping either here would
    // make one of the two impossible.
    const parsed = flattenReportRows(
      report([
        section("Expenses", [
          dataRow(["2024-01-15", "Expense", "1", "Shell", "Fuel", "Bank", "50.00", "50.00"]),
        ]),
      ]),
    );
    expect(parsed.map((r) => r.kind)).toEqual(["header", "data", "summary"]);
  });

  it("offers the data rows on their own, because that is the common case", () => {
    const parsed = dataRowsOf(
      report([
        section("Expenses", [
          dataRow(["2024-01-15", "Expense", "1", "Shell", "Fuel", "Bank", "50.00", "50.00"]),
        ]),
      ]),
    );
    expect(parsed).toHaveLength(1);
  });

  it("files a summary beside what it totals, not inside it", () => {
    // A total emitted at its children's depth looks like one more of its own
    // children, and anything summing by depth counts the section twice.
    const parsed = flattenReportRows(
      report([
        section("Expenses", [
          dataRow(["2024-01-15", "Expense", "1", "Shell", "Fuel", "Bank", "50.00", "50.00"]),
        ]),
      ]),
    );
    const summary = parsed.find((r) => r.kind === "summary")!;
    const data = parsed.find((r) => r.kind === "data")!;
    expect(summary.depth).toBeLessThan(data.depth);
  });

  it("reads a report with no sections at all", () => {
    const parsed = dataRowsOf(
      report([dataRow(["2024-01-15", "Expense", "1", "Shell", "", "", "50.00", "50.00"])]),
    );
    expect(parsed[0]!.sectionPath).toEqual([]);
  });

  it("treats a single row that is not in an array as one row", () => {
    // QuickBooks collapses a one-element list to the element in some
    // responses; reading that as "no rows" loses a report that has exactly one.
    const parsed = dataRowsOf(
      report(dataRow(["2024-01-15", "Expense", "1", "Shell", "", "", "50.00", "50.00"])),
    );
    expect(parsed).toHaveLength(1);
  });

  it("makes nothing of a report with nothing in it", () => {
    expect(flattenReportRows(report([]))).toEqual([]);
    expect(flattenReportRows({})).toEqual([]);
    expect(flattenReportRows(null)).toEqual([]);
  });
});

describe("addressing a cell by what it holds", () => {
  const [row] = dataRowsOf(
    report([dataRow(["2024-01-15", "Expense", "1", "Shell", "Fuel", "Bank", "50.00", "50.00"])]),
  );

  it("finds it by column type", () => {
    expect(cellOf(row!, ["tx_date"])).toBe("2024-01-15");
    expect(cellOf(row!, ["subt_nat_amount"])).toBe("50.00");
  });

  it("falls back to the visible title", () => {
    expect(cellOf(row!, ["no_such_type"], ["Amount"])).toBe("50.00");
  });

  it("answers empty rather than undefined for a column that is not there", () => {
    expect(cellOf(row!, ["no_such_type"], ["no such title"])).toBe("");
  });

  it("does not shift when the column set differs", () => {
    // The whole point. A report with an extra column read positionally puts
    // the date in the type field and the running balance in the amount.
    const different = {
      Columns: {
        Column: [
          { ColTitle: "Account", ColType: "account_name" },
          { ColTitle: "Date", ColType: "tx_date" },
          { ColTitle: "Amount", ColType: "subt_nat_amount" },
        ],
      },
      Rows: { Row: [dataRow(["Motor Expenses", "2024-01-15", "50.00"])] },
    };
    const [shifted] = dataRowsOf(different);
    expect(cellOf(shifted!, ["tx_date"])).toBe("2024-01-15");
    expect(cellOf(shifted!, ["subt_nat_amount"])).toBe("50.00");
  });
});

describe("reading a money value", () => {
  it("reads the formats QuickBooks writes", () => {
    expect(toAmount("50.00")).toBe(50);
    expect(toAmount("1,234.56")).toBe(1234.56);
    expect(toAmount("-99.00")).toBe(-99);
  });

  it("reads accounting parentheses as negative", () => {
    expect(toAmount("(1,234.56)")).toBe(-1234.56);
  });

  it("strips a currency symbol", () => {
    expect(toAmount("$1,000.00")).toBe(1000);
    expect(toAmount("£250")).toBe(250);
  });

  it("keeps a genuine zero", () => {
    // Distinct from unreadable: a zero-value transaction is a real thing.
    expect(toAmount("0.00")).toBe(0);
  });

  it("returns null rather than NaN for anything unreadable", () => {
    // NaN propagates into every total and turns a report into "NaN", which
    // says nothing about anything.
    for (const value of ["", "   ", "n/a", "-", ".", null, undefined]) {
      expect(toAmount(value)).toBeNull();
    }
  });
});

describe("a general ledger as transactions", () => {
  const ledger = report([
    section("Motor Expenses", [
      dataRow(["2024-01-15", "Expense", "1", "Shell", "Fuel", "Bank", "-50.00", "-50.00"]),
      dataRow(["2024-01-20", "Bill", "2", "BP", "Diesel", "A/P", "-75.50", "-125.50"]),
    ]),
    section("Sales", [
      dataRow(["2024-01-31", "Invoice", "3", "Acme Ltd", "", "A/R", "1,200.00", "1,200.00"]),
    ]),
  ]);

  it("reads every transaction, with the account it sits under", () => {
    const transactions = toLedgerTransactions(ledger);
    expect(transactions).toHaveLength(3);
    expect(transactions[0]).toEqual({
      date: "2024-01-15",
      transactionType: "Expense",
      name: "Shell",
      amount: -50,
      accountName: "Motor Expenses",
    });
    expect(transactions[2]!.accountName).toBe("Sales");
  });

  it("reads the AMOUNT, not the running balance", () => {
    // Positional reading took `ColData[6]` as the amount for one column set
    // and the balance for another. A running balance stored as an amount makes
    // every transaction the cumulative total to that point.
    expect(toLedgerTransactions(ledger)[1]!.amount).toBe(-75.5);
  });

  it("drops a row with no date", () => {
    // A heading or a blank the report carries for layout. Stored as a
    // transaction it puts a phantom line in every reconciliation.
    const withBlank = report([
      section("Expenses", [
        dataRow(["", "", "", "", "", "", "", ""]),
        dataRow(["2024-01-15", "Expense", "1", "Shell", "", "", "-50.00", "-50.00"]),
      ]),
    ]);
    expect(toLedgerTransactions(withBlank)).toHaveLength(1);
  });

  it("drops a row whose amount cannot be read", () => {
    const withBad = report([
      section("Expenses", [
        dataRow(["2024-01-15", "Expense", "1", "Shell", "", "", "n/a", ""]),
      ]),
    ]);
    expect(toLedgerTransactions(withBad)).toEqual([]);
  });

  it("keeps a transaction of exactly zero", () => {
    const withZero = report([
      section("Expenses", [
        dataRow(["2024-01-15", "Journal", "1", "Adjustment", "", "", "0.00", "0.00"]),
      ]),
    ]);
    expect(toLedgerTransactions(withZero)).toHaveLength(1);
    expect(toLedgerTransactions(withZero)[0]!.amount).toBe(0);
  });

  it("nulls a name or type the report did not carry", () => {
    const sparse = report([
      section("Expenses", [dataRow(["2024-01-15", "", "", "", "", "", "-50.00", ""])]),
    ]);
    const [transaction] = toLedgerTransactions(sparse);
    expect(transaction!.name).toBeNull();
    expect(transaction!.transactionType).toBeNull();
  });

  it("makes nothing of an empty report", () => {
    expect(toLedgerTransactions(report([]))).toEqual([]);
    expect(toLedgerTransactions(null)).toEqual([]);
  });
});
