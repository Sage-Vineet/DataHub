import { describe, expect, it } from "vitest";
import type { ImportedRow } from "./sheet.js";
import { fiscalYearOf, hashRow, toLedgerEntries } from "./staging.js";

/**
 * Turning parsed rows into ledger entries.
 *
 * Every figure any user ever sees is derived from what lands in
 * `general_ledger_entries`. A mistake here is invisible: the statements still
 * balance, they are just about a different company's worth of money. So the
 * tests are about the two things that go wrong silently — which year a
 * transaction lands in, and whether importing a file twice doubles it.
 */

const row = (over: Partial<ImportedRow> = {}): ImportedRow => ({
  rowNumber: 2,
  date: "2024-01-15",
  accountName: "Sales",
  accountNumber: null,
  accountType: null,
  description: "Consulting",
  transactionType: null,
  reference: null,
  amount: -1200,
  debit: null,
  credit: 1200,
  ...over,
});

describe("which fiscal year a transaction lands in", () => {
  it("is the calendar year when the year starts in January", () => {
    expect(fiscalYearOf("2024-01-15")).toBe(2024);
    expect(fiscalYearOf("2024-12-31")).toBe(2024);
  });

  it("is named for the year it ENDS in", () => {
    // April 2023 to March 2024 is FY2024. A calendar reading puts May 2023 in
    // 2023 and eight months of trading in the wrong year.
    expect(fiscalYearOf("2023-05-01", 4)).toBe(2024);
    expect(fiscalYearOf("2024-03-31", 4)).toBe(2024);
  });

  it("rolls over on the first day of the new year, not the last of the old", () => {
    expect(fiscalYearOf("2024-03-31", 4)).toBe(2024);
    expect(fiscalYearOf("2024-04-01", 4)).toBe(2025);
  });

  it("handles a year starting in December, the awkward one", () => {
    expect(fiscalYearOf("2023-12-01", 12)).toBe(2024);
    expect(fiscalYearOf("2023-11-30", 12)).toBe(2023);
  });

  it("treats a nonsense start month as a calendar year", () => {
    for (const start of [0, 13, -1, Number.NaN]) {
      expect(fiscalYearOf("2024-05-01", start)).toBe(2024);
    }
  });

  it("refuses a date it cannot read rather than guessing a year", () => {
    expect(() => fiscalYearOf("not-a-date")).toThrow();
  });
});

describe("what makes a re-import a no-op", () => {
  it("gives the same row the same hash every time", () => {
    expect(hashRow(row(), "file-a")).toBe(hashRow(row(), "file-a"));
  });

  it("changes when any figure on the row changes", () => {
    const base = hashRow(row(), "file-a");
    expect(hashRow(row({ amount: -1200.01 }), "file-a")).not.toBe(base);
    expect(hashRow(row({ accountName: "Services" }), "file-a")).not.toBe(base);
    expect(hashRow(row({ date: "2024-01-16" }), "file-a")).not.toBe(base);
    expect(hashRow(row({ description: "Something else" }), "file-a")).not.toBe(base);
  });

  it("keeps two identical lines apart", () => {
    // A ledger legitimately contains them: two £20 taxi fares on the same day
    // to the same account are two transactions, and a content-only hash would
    // silently keep one.
    expect(hashRow(row({ rowNumber: 2 }), "file-a")).not.toBe(
      hashRow(row({ rowNumber: 3 }), "file-a"),
    );
  });

  it("keeps the same line in two different files apart", () => {
    // Two genuinely different exports with a coincidentally identical line are
    // two transactions.
    expect(hashRow(row(), "file-a")).not.toBe(hashRow(row(), "file-b"));
  });
});

describe("preparing entries", () => {
  it("carries the figures across without rounding them", () => {
    const { entries } = toLedgerEntries([row({ amount: -1234.56 })], { sourceKey: "f" });
    expect(entries[0]!.amount).toBe("-1234.56");
    expect(entries[0]!.credit).toBe("1200.00");
    expect(entries[0]!.debit).toBeNull();
  });

  it("writes an amount as a fixed string, not a float", () => {
    // The column is numeric(18,2); handing it a float invites a rounding
    // nobody chose.
    const { entries } = toLedgerEntries([row({ amount: 0.1 + 0.2 })], { sourceKey: "f" });
    expect(entries[0]!.amount).toBe("0.30");
  });

  it("uses an empty account number rather than null", () => {
    // The column is NOT NULL, and "" is the honest value for a file that does
    // not carry them.
    const { entries } = toLedgerEntries([row()], { sourceKey: "f" });
    expect(entries[0]!.accountNumber).toBe("");
  });

  it("reports every fiscal year it saw, in order", () => {
    const { fiscalYears } = toLedgerEntries(
      [
        row({ date: "2024-01-15" }),
        row({ date: "2022-06-01", rowNumber: 3 }),
        row({ date: "2023-03-10", rowNumber: 4 }),
        row({ date: "2024-11-30", rowNumber: 5 }),
      ],
      { sourceKey: "f" },
    );
    expect(fiscalYears).toEqual([2022, 2023, 2024]);
  });

  it("shifts every year when the fiscal year does not start in January", () => {
    const { fiscalYears } = toLedgerEntries(
      [row({ date: "2023-05-01" }), row({ date: "2023-03-01", rowNumber: 3 })],
      { sourceKey: "f", fiscalYearStartMonth: 4 },
    );
    expect(fiscalYears).toEqual([2023, 2024]);
  });

  it("drops and counts a row it cannot place in a year", () => {
    const { entries, undated } = toLedgerEntries(
      [row(), row({ date: null, rowNumber: 3 })],
      { sourceKey: "f" },
    );
    expect(entries).toHaveLength(1);
    expect(undated).toBe(1);
  });

  it("gives every entry a hash, so every one is deduplicable", () => {
    // A row without one falls outside the partial unique index, and importing
    // the file again would duplicate exactly those rows.
    const { entries } = toLedgerEntries(
      [row(), row({ rowNumber: 3, accountName: "Rent", amount: 450 })],
      { sourceKey: "f" },
    );
    for (const entry of entries) expect(entry.transactionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(entries.map((e) => e.transactionHash)).size).toBe(2);
  });

  it("handles an empty file without inventing anything", () => {
    const summary = toLedgerEntries([], { sourceKey: "f" });
    expect(summary.entries).toEqual([]);
    expect(summary.fiscalYears).toEqual([]);
    expect(summary.undated).toBe(0);
  });
});
