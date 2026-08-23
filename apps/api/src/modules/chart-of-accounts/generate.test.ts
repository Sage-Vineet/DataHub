import { describe, expect, it } from "vitest";
import {
  accountKeyOf,
  buildChartOfAccounts,
  isNonAccountRow,
  nameKeyOf,
  type SourceAccountRow,
} from "./generate.js";

/**
 * Building a chart of accounts out of stored entry rows.
 *
 * A fold over rows, and pure. The two things that go wrong quietly are letting
 * a total in as an account — which then rolls up under itself and double
 * counts — and treating two spellings of one account as two accounts, which
 * splits its figures across two lines that each look plausible.
 */

const row = (over: Partial<SourceAccountRow> = {}): SourceAccountRow => ({
  accountName: "Office Rent",
  source: "general_ledger",
  ...over,
});

describe("rows that are not accounts", () => {
  it("keeps totals and headings out", () => {
    // Extraction stores them because they carry figures. As an account,
    // "Total Expenses" rolls up under Total Expenses and double counts every
    // expense beneath it.
    for (const name of [
      "Total Expenses",
      "Total",
      "Subtotal",
      "Net Income",
      "Gross Profit",
      "Grand Total",
    ]) {
      expect(isNonAccountRow(name)).toBe(true);
    }
  });

  it("does NOT try to exclude a ledger's running-balance rows by name", () => {
    // "Beginning Balance" and "Ending Balance" appear in a general-ledger
    // export and are not accounts — but they are excluded by the entry's
    // `row_type`, which says what kind of row it is, rather than by guessing
    // from the text. A name-based rule here would also catch an account
    // genuinely called "Ending Balance Adjustment".
    expect(isNonAccountRow("Ending Balance")).toBe(false);
  });

  it("keeps report furniture and section headings out too", () => {
    for (const name of [
      "Accrual Basis",
      "Report Generated 01/02/2024",
      "Current Assets",
      "Liabilities & Equity",
      "Cost of Goods Sold",
    ]) {
      expect(isNonAccountRow(name)).toBe(true);
    }
  });

  it("matches a section heading exactly, not by prefix", () => {
    // "Current Assets" is a heading; "Current Assets Clearing" is an account,
    // and a prefix match would swallow it.
    expect(isNonAccountRow("Current Assets Clearing")).toBe(false);
  });

  it("keeps a real account in", () => {
    for (const name of ["Office Rent", "Netting Supplies", "Interest Received"]) {
      expect(isNonAccountRow(name)).toBe(false);
    }
  });

  it("excludes an account that merely begins with 'Total', knowingly", () => {
    // The cost of a broad `^total\b`. The two errors are not symmetric: a
    // total admitted as an account double counts every figure beneath it,
    // silently; a dropped account is one line missing from one chart.
    expect(isNonAccountRow("Total Quality Services Ltd")).toBe(true);
  });

  it("treats a nameless row as not an account", () => {
    for (const name of ["", "   ", null, undefined]) expect(isNonAccountRow(name)).toBe(true);
  });

  it("drops them from the chart entirely", () => {
    const accounts = buildChartOfAccounts([
      row({ accountName: "Office Rent" }),
      row({ accountName: "Total Expenses" }),
    ]);
    expect(accounts.map((a) => a.accountName)).toEqual(["Office Rent"]);
  });
});

describe("what counts as the same account", () => {
  it("matches a name whatever its case and spacing", () => {
    // Two ledgers spelling "Rent" and "rent " are one line on one statement.
    // Splitting them puts its figures across two lines that each look
    // plausible.
    expect(nameKeyOf("Rent")).toBe(nameKeyOf("  rent "));
    expect(nameKeyOf("Office   Rent")).toBe(nameKeyOf("Office Rent"));
  });

  it("keys on the name AND the number, matching the table's own indexes", () => {
    // Numbered accounts are unique on (version, number, name) and unnumbered
    // ones on (version, name). Anything else here produces two rows the
    // database then refuses.
    expect(accountKeyOf("Rent", "6000")).not.toBe(accountKeyOf("Rent", "6001"));
    expect(accountKeyOf("Rent", "6000")).not.toBe(accountKeyOf("Office Rent", "6000"));
    expect(accountKeyOf("Rent", null)).toBe(accountKeyOf("  rent ", ""));
  });

  it("keeps two accounts that share a name but differ in number apart", () => {
    const accounts = buildChartOfAccounts([
      row({ accountName: "Rent", accountNumber: "6000" }),
      row({ accountName: "Rent", accountNumber: "6001" }),
    ]);
    expect(accounts).toHaveLength(2);
  });

  it("merges the sightings rather than duplicating the account", () => {
    const accounts = buildChartOfAccounts([
      row({ accountName: "Rent", source: "general_ledger", fiscalYear: 2023 }),
      row({ accountName: "rent ", source: "profit_loss", fiscalYear: 2024 }),
    ]);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.sources).toEqual(["general_ledger", "profit_loss"]);
    expect(accounts[0]!.fiscalYears).toEqual([2023, 2024]);
  });

  it("fills in a number learned from a later sighting", () => {
    // The same account can appear numbered on a balance sheet and bare in a
    // ledger; the number is worth keeping wherever it turned up.
    const accounts = buildChartOfAccounts([
      row({ accountName: "Rent" }),
      row({ accountName: "Rent", accountNumber: "6000" }),
    ]);
    // One account: the name is the identity, so the numbered sighting joins
    // the bare one rather than becoming a second line.
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.accountNumber).toBe("6000");
  });
});

describe("how each account is classified", () => {
  it("believes a stated type over anything else", () => {
    const [account] = buildChartOfAccounts([
      row({ accountName: "Bank Charges", accountType: "expense" }),
    ]);
    expect(account!.accountType).toBe("expense");
    expect(account!.classificationMethod).toBe("stated");
  });

  it("takes a stated type from whichever sighting carried it", () => {
    // A balance sheet says what its accounts are; a ledger usually does not.
    const [account] = buildChartOfAccounts([
      row({ accountName: "Rent", source: "general_ledger" }),
      row({ accountName: "Rent", source: "profit_loss", accountType: "expense" }),
    ]);
    expect(account!.classificationMethod).toBe("stated");
  });

  it("uses the account number before the name", () => {
    const [account] = buildChartOfAccounts([
      row({ accountName: "Bank Charges & Fees", accountNumber: "6100" }),
    ]);
    expect(account!.accountType).toBe("expense");
    expect(account!.classificationMethod).toBe("account_number");
  });

  it("does not read a P&L row's weak keyword as a balance-sheet type", () => {
    const [account] = buildChartOfAccounts([
      row({ accountName: "Bank Charges", source: "profit_loss" }),
    ]);
    expect(account!.accountType).toBe("expense");
  });

  it("lets a balance-sheet sighting settle the guard", () => {
    // The account IS on the balance sheet, so a keyword pointing there is not
    // a P&L misreading.
    const [account] = buildChartOfAccounts([
      row({ accountName: "Bank Charges", source: "profit_loss" }),
      row({ accountName: "Bank Charges", source: "balance_sheet" }),
    ]);
    expect(account!.accountType).toBe("asset");
  });

  it("uses the balance sheet's own section to place a liability", () => {
    const [account] = buildChartOfAccounts([
      row({
        accountName: "Bank Loan",
        accountType: "liability",
        source: "balance_sheet",
        bsSection: "Long-Term Liabilities",
      }),
    ]);
    expect(account!.levels[2]).toBe("Long-Term Liabilities");
  });
});

describe("where each account sits", () => {
  it("gives it the standardised path with itself at the end", () => {
    const [account] = buildChartOfAccounts([
      row({ accountName: "Office Rent", accountType: "expense" }),
    ]);
    expect(account!.hierarchyPath).toBe(
      "Income Statement > Net Income > Pretax Income > Operating Income > Gross Profit > " +
        "Total Expenses > Expenses > Occupancy > Office Rent",
    );
    expect(account!.baseAccount).toBe("Office Rent");
  });

  it("names the statement it belongs to", () => {
    const accounts = buildChartOfAccounts([
      row({ accountName: "Business Checking", accountType: "asset" }),
      row({ accountName: "Office Rent", accountType: "expense" }),
    ]);
    const byName = new Map(accounts.map((a) => [a.accountName, a.statementType]));
    expect(byName.get("Business Checking")).toBe("balance_sheet");
    expect(byName.get("Office Rent")).toBe("profit_loss");
  });

  it("adds no company-specific levels of its own", () => {
    // Those come from the review step, which asks a model and records what a
    // person accepted. This is the deterministic part — the part that has to
    // be right without anybody looking at it.
    const [account] = buildChartOfAccounts([
      row({ accountName: "Office Rent", accountType: "expense" }),
    ]);
    expect(account!.levels[9]).toBeNull();
  });
});

describe("the order accounts come back in", () => {
  it("puts the balance sheet before the profit and loss", () => {
    const accounts = buildChartOfAccounts([
      row({ accountName: "Office Rent", accountType: "expense" }),
      row({ accountName: "Business Checking", accountType: "asset" }),
    ]);
    expect(accounts.map((a) => a.accountName)).toEqual(["Business Checking", "Office Rent"]);
  });

  it("numbers them from zero, in that order", () => {
    const accounts = buildChartOfAccounts([
      row({ accountName: "Office Rent", accountType: "expense" }),
      row({ accountName: "Business Checking", accountType: "asset" }),
      row({ accountName: "Wages", accountType: "expense" }),
    ]);
    expect(accounts.map((a) => a.sortOrder)).toEqual([0, 1, 2]);
  });

  it("is stable, so a rebuild that changes nothing writes nothing", () => {
    // An unstable order means every rebuild rewrites every `sort_order`, which
    // fills the audit trail with changes nobody made.
    const rows = [
      row({ accountName: "Wages", accountType: "expense" }),
      row({ accountName: "Office Rent", accountType: "expense" }),
      row({ accountName: "Business Checking", accountType: "asset" }),
    ];
    const first = buildChartOfAccounts(rows);
    const second = buildChartOfAccounts([...rows].reverse());
    expect(first.map((a) => a.accountName)).toEqual(second.map((a) => a.accountName));
  });
});

describe("nothing to build from", () => {
  it("produces an empty chart rather than failing", () => {
    expect(buildChartOfAccounts([])).toEqual([]);
  });

  it("produces an empty chart when every row is a total", () => {
    expect(
      buildChartOfAccounts([row({ accountName: "Total Income" }), row({ accountName: "Total" })]),
    ).toEqual([]);
  });
});
