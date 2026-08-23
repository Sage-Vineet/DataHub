import { describe, expect, it } from "vitest";
import {
  CONFIDENCE_THRESHOLD,
  detectMapping,
  emptyMapping,
  headerScore,
  looksLikeDate,
  parseAmount,
  profileColumn,
  validateMapping,
} from "./column-mapping.js";

/**
 * Matching spreadsheet columns to ledger fields.
 *
 * The cost of a wrong guess is a mis-imported ledger nobody notices until the
 * balance sheet stops balancing, so the tests care about two things: that a
 * real export maps correctly, and that an ambiguous one is REPORTED as
 * ambiguous instead of guessed at.
 */

/** A QuickBooks general ledger export, near enough. */
const QUICKBOOKS = {
  columns: ["Date", "Transaction Type", "Num", "Name", "Memo/Description", "Distribution Account", "Debit", "Credit", "Balance"],
  rows: [
    { Date: "01/15/2024", "Transaction Type": "Invoice", Num: "1001", Name: "Northwind", "Memo/Description": "Consulting work for Q1", "Distribution Account": "Sales", Debit: "", Credit: "1,200.00", Balance: "1,200.00" },
    { Date: "02/03/2024", "Transaction Type": "Bill", Num: "1002", Name: "Acme Supply", "Memo/Description": "Materials for the workshop", "Distribution Account": "Cost of Goods Sold", Debit: "450.00", Credit: "", Balance: "750.00" },
    { Date: "03/21/2024", "Transaction Type": "Check", Num: "1003", Name: "Landlord Ltd", "Memo/Description": "Rent for the March quarter", "Distribution Account": "Rent Expense", Debit: "900.00", Credit: "", Balance: "-150.00" },
  ],
};

describe("reading a cell", () => {
  it("recognises the date formats an export actually uses", () => {
    for (const value of ["01/15/2024", "2024-01-15", "15 Jan 2024", "Jan 15, 2024"]) {
      expect(looksLikeDate(value)).toBe(true);
    }
  });

  it("does not mistake a bare number for a date", () => {
    // Otherwise every amount column scores as a date column, and `date` gets
    // assigned to Debit on a file whose date header is unusual.
    for (const value of ["1200", "1200.50", "-450", 1200]) {
      expect(looksLikeDate(value)).toBe(false);
    }
  });

  it("declines an empty or nonsense cell", () => {
    for (const value of ["", "   ", null, undefined, "n/a"]) {
      expect(looksLikeDate(value)).toBe(false);
    }
  });

  it("reads an amount however it is decorated", () => {
    expect(parseAmount("1,200.00")).toBe(1200);
    expect(parseAmount("$1,200.00")).toBe(1200);
    expect(parseAmount("£450")).toBe(450);
    expect(parseAmount(-99.5)).toBe(-99.5);
  });

  it("reads accounting parentheses as negative", () => {
    // The single most common way a spreadsheet writes a credit, and reading it
    // as positive would invert half the ledger.
    expect(parseAmount("(1,234.56)")).toBeCloseTo(-1234.56, 2);
    expect(parseAmount("($99)")).toBe(-99);
  });

  it("declines anything that is not a number", () => {
    for (const value of ["", "Invoice", "N/A", "-", null, undefined]) {
      expect(parseAmount(value)).toBeNull();
    }
  });
});

describe("profiling a column", () => {
  it("measures over non-empty cells, not over every row", () => {
    // A column half full of dates is a date column with gaps, not a
    // half-hearted one — and a debit column is mostly blank by nature.
    const profile = profileColumn(QUICKBOOKS.rows, "Debit");
    expect(profile.nonEmpty).toBe(2);
    expect(profile.numericRatio).toBe(1);
  });

  it("sees a date column as dates and an account column as text", () => {
    expect(profileColumn(QUICKBOOKS.rows, "Date").dateRatio).toBe(1);
    expect(profileColumn(QUICKBOOKS.rows, "Distribution Account").textRatio).toBe(1);
  });

  it("notices both signs in a running balance", () => {
    const profile = profileColumn(QUICKBOOKS.rows, "Balance");
    expect(profile.positiveRatio).toBeGreaterThan(0);
    expect(profile.negativeRatio).toBeGreaterThan(0);
  });

  it("survives a column that is not there at all", () => {
    const profile = profileColumn(QUICKBOOKS.rows, "Nonexistent");
    expect(profile.nonEmpty).toBe(0);
    expect(profile.numericRatio).toBe(0);
  });
});

describe("scoring a header", () => {
  it("prefers an exact header over one that merely contains the word", () => {
    expect(headerScore("Date", "date")).toBeGreaterThan(headerScore("Posting Date Modified", "date"));
  });

  it("recognises the wording other systems use", () => {
    expect(headerScore("Distribution Account", "account_name")).toBeGreaterThan(0.9);
    expect(headerScore("Money Out", "debit")).toBeGreaterThan(0.9);
    expect(headerScore("Txn Date", "date")).toBeGreaterThan(0.5);
  });

  it("scores an unrelated header at nothing", () => {
    expect(headerScore("Widget Colour", "date")).toBe(0);
  });
});

describe("a real export", () => {
  const result = detectMapping(QUICKBOOKS);

  it("maps every required field", () => {
    expect(result.mapping.date).toBe("Date");
    expect(result.mapping.account_name).toBe("Distribution Account");
    expect(result.mapping.debit).toBe("Debit");
    expect(result.mapping.credit).toBe("Credit");
  });

  it("maps the optional ones it can", () => {
    expect(result.mapping.transaction_type).toBe("Transaction Type");
    expect(result.mapping.description).toBe("Memo/Description");
    expect(result.mapping.balance).toBe("Balance");
  });

  it("does not give one column to two fields", () => {
    // "Transaction Type" and "Account Type" share a keyword; assigning both to
    // the same column would silently read the type as the account.
    const assigned = Object.values(result.mapping).filter(Boolean);
    expect(new Set(assigned).size).toBe(assigned.length);
  });

  it("leaves the split amount alone when debit and credit are both there", () => {
    // The split is an ALTERNATIVE to the pair. Legacy assigned it anyway, and
    // let it reuse a claimed column, so a proper export came back with
    // `split_amount` pointing at Debit or Balance — an importer reading both
    // would count those rows twice.
    expect(result.mapping.split_amount).toBe("");
  });

  it("is confident enough to import without asking", () => {
    expect(result.missingRequired).toEqual([]);
    expect(result.canAutoProcess).toBe(true);
  });
});

describe("a file with one signed amount instead of debit and credit", () => {
  const result = detectMapping({
    columns: ["Posting Date", "GL Account", "Net Amount", "Narration"],
    rows: [
      { "Posting Date": "2024-01-15", "GL Account": "Sales", "Net Amount": "1200.00", Narration: "Consulting work for Q1" },
      { "Posting Date": "2024-02-03", "GL Account": "Materials", "Net Amount": "-450.00", Narration: "Materials for the workshop" },
      { "Posting Date": "2024-03-21", "GL Account": "Rent", "Net Amount": "-900.00", Narration: "Rent for the March quarter" },
    ],
  });

  it("finds the amount column and treats it as the split", () => {
    // Both shapes are common and neither is more correct.
    expect(result.mapping.split_amount).toBe("Net Amount");
    expect(result.mapping.date).toBe("Posting Date");
    expect(result.mapping.account_name).toBe("GL Account");
  });

  it("accepts it as importable without debit and credit", () => {
    expect(result.missingRequired).toEqual([]);
  });
});

describe("what the user said wins", () => {
  it("takes their choice over anything detected", () => {
    // They are looking at the file; this is not.
    const result = detectMapping({
      ...QUICKBOOKS,
      mapping: { account_name: "Name" },
    });
    expect(result.mapping.account_name).toBe("Name");
    expect(result.sources.account_name).toBe("manual");
    expect(result.confidence.account_name).toBe(1);
  });

  it("keeps detection off a column they already claimed", () => {
    // Otherwise their choice and an auto-assignment point at one column and
    // the same values are read as two different things.
    const result = detectMapping({ ...QUICKBOOKS, mapping: { description: "Distribution Account" } });
    expect(result.mapping.description).toBe("Distribution Account");
    expect(result.mapping.account_name).not.toBe("Distribution Account");
  });

  it("ignores a choice naming a column that is not in the file", () => {
    const result = detectMapping({ ...QUICKBOOKS, mapping: { date: "Settlement Date" } });
    expect(result.mapping.date).toBe("Date");
  });
});

describe("a file it cannot read confidently", () => {
  it("refuses to proceed on nameless columns of prose", () => {
    // A column of words does look like an account name BY VALUE, so it is
    // assigned — but with nothing in the header to support it, the confidence
    // is below the bar and the file is not importable unattended. That is the
    // right outcome: a guess offered for review, not a guess acted on.
    const result = detectMapping({
      columns: ["Col1", "Col2", "Col3"],
      rows: [
        { Col1: "alpha", Col2: "beta", Col3: "gamma" },
        { Col1: "delta", Col2: "epsilon", Col3: "zeta" },
      ],
    });
    expect(result.missingRequired).toContain("date");
    expect(result.canAutoProcess).toBe(false);
    expect(result.lowConfidenceFields).toContain("account_name");
    expect(result.confidence.account_name ?? 0).toBeLessThan(CONFIDENCE_THRESHOLD);
  });

  it("names the amount requirement as one thing, not two", () => {
    // Debit-and-credit OR a split. Reporting "debit missing, credit missing"
    // would send somebody looking for two columns that need not exist.
    const result = detectMapping({
      columns: ["Date", "Account"],
      rows: [{ Date: "2024-01-15", Account: "Sales" }],
    });
    expect(result.missingRequired).toContain("debit_credit_or_split_amount");
    expect(result.missingRequired).not.toContain("debit");
  });

  it("survives a file with no rows at all", () => {
    // Headers and nothing under them: mappable by name, not by value.
    const result = detectMapping({ columns: ["Date", "Account Name", "Debit", "Credit"], rows: [] });
    expect(result.mapping.date).toBe("Date");
    expect(result.missingRequired).toEqual([]);
  });

  it("survives a file with no columns at all", () => {
    const result = detectMapping({ columns: [], rows: [] });
    expect(result.canAutoProcess).toBe(false);
    expect(result.missingRequired.length).toBeGreaterThan(0);
  });
});

describe("the shape of a mapping", () => {
  it("always carries every field, unmapped ones empty", () => {
    // The upload screen renders a row per field and reads them by name.
    const mapping = emptyMapping({ date: "Date" });
    expect(mapping.date).toBe("Date");
    expect(mapping.account_name).toBe("");
    expect(Object.keys(mapping)).toHaveLength(11);
  });

  it("flags a required field mapped with low confidence", () => {
    const result = validateMapping(emptyMapping({
      date: "Col1",
      account_name: "Col2",
      split_amount: "Col3",
    }), { date: 0.2, account_name: 0.9, split_amount: 0.9 });

    expect(result.lowConfidenceFields).toContain("date");
    expect(result.canAutoProcess).toBe(false);
  });

  it("passes one mapped confidently", () => {
    const high = CONFIDENCE_THRESHOLD + 0.1;
    const result = validateMapping(emptyMapping({
      date: "Col1",
      account_name: "Col2",
      split_amount: "Col3",
    }), { date: high, account_name: high, split_amount: high });

    expect(result.lowConfidenceFields).toEqual([]);
    expect(result.canAutoProcess).toBe(true);
  });

  it("does not report the same field as low-confidence twice", () => {
    const result = validateMapping(emptyMapping({
      date: "Col1",
      account_name: "Col2",
      debit: "Col3",
      credit: "Col4",
    }), {});
    expect(new Set(result.lowConfidenceFields).size).toBe(result.lowConfidenceFields.length);
  });
});
