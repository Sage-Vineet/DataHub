import { describe, expect, it } from "vitest";
import { emptyToNull, postedAt, toLedgerNumber } from "./ledger-row.js";

/**
 * Where a ledger row posts.
 *
 * The engagement loader and the monthly drill-down both read the same table
 * and both used to decide this for themselves. A disagreement between them
 * would show as two reports differing about a company's own ledger, with
 * nothing on either page to say which was right.
 */

const ROW = { coaId: "coa-1", fiscalYear: 2025, transactionDate: "2025-03-04" };

describe("where a row posts", () => {
  it("reads the account, the year and the month", () => {
    expect(postedAt(ROW)).toEqual({ accountId: "coa-1", fiscalYear: 2025, month: 3 });
  });

  it("posts nowhere without an account", () => {
    expect(postedAt({ ...ROW, coaId: null })).toBeNull();
    expect(postedAt({ ...ROW, coaId: "" })).toBeNull();
  });

  it("takes the year off the date when the row states none", () => {
    expect(postedAt({ ...ROW, fiscalYear: null })?.fiscalYear).toBe(2025);
  });

  it("prefers the year the row states over the year its date falls in", () => {
    // A fiscal year need not start in January. A March date inside FY2024 is
    // FY2024, and reading 2025 off the date would move it a year.
    expect(postedAt({ coaId: "a", fiscalYear: 2024, transactionDate: "2025-03-04" })?.fiscalYear)
      .toBe(2024);
  });

  it("posts nowhere when it lands in no year at all", () => {
    expect(postedAt({ coaId: "a", fiscalYear: null, transactionDate: null })).toBeNull();
    expect(postedAt({ coaId: "a", fiscalYear: null, transactionDate: "sometime" })).toBeNull();
  });

  it("reports a year without a month as month zero", () => {
    expect(postedAt({ ...ROW, transactionDate: null })?.month).toBe(0);
  });

  it("reads the month in UTC, not the server's zone", () => {
    // Parsed as local time, the first of a month is the previous month west of
    // Greenwich — and a year's worth of transactions shifts by one.
    expect(postedAt({ ...ROW, transactionDate: "2025-01-01" })?.month).toBe(1);
    expect(postedAt({ ...ROW, transactionDate: "2025-12-31" })?.month).toBe(12);
  });
});

describe("reading a numeric column", () => {
  it("takes a number", () => {
    expect(toLedgerNumber(12.5)).toBe(12.5);
  });

  it("reads the string a numeric column arrives as", () => {
    expect(toLedgerNumber("1250.50")).toBe(1250.5);
    expect(toLedgerNumber("-40")).toBe(-40);
  });

  it("treats what it cannot read as zero", () => {
    expect(toLedgerNumber(null)).toBe(0);
    expect(toLedgerNumber(undefined)).toBe(0);
    expect(toLedgerNumber("n/a")).toBe(0);
  });
});

describe("reading a text column", () => {
  it("keeps what is there", () => {
    expect(emptyToNull("  Acme  ")).toBe("Acme");
  });

  it("treats an unpopulated column as absent whichever way it is empty", () => {
    expect(emptyToNull("")).toBeNull();
    expect(emptyToNull("   ")).toBeNull();
    expect(emptyToNull(null)).toBeNull();
    expect(emptyToNull(undefined)).toBeNull();
  });
});
