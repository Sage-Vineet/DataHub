import { describe, expect, it } from "vitest";
import { HttpError } from "../../shared/errors.js";
import {
  UnavailableReportSyncPort,
  splitOf,
  toLedgerTransaction,
  toNumber,
  type LedgerRow,
} from "./adapters.js";

/**
 * Turning a stored ledger row into a transaction the reports can add up.
 *
 * Every branch here decides where a real amount lands. A row filed under the
 * wrong year sits on the wrong statement, and the statement still foots.
 */

const ROW: LedgerRow = {
  id: 42,
  coaId: "coa-1",
  fiscalYear: 2025,
  transactionDate: "2025-03-04",
  amount: "1250.50",
  vendor: "Acme Supplies",
  description: "Stationery",
  reference: "INV-9",
  journalType: "AP",
  debit: "1250.50",
  credit: "0",
};

describe("reading a ledger row", () => {
  it("reads every field", () => {
    expect(toLedgerTransaction(ROW)).toEqual({
      id: "42",
      accountId: "coa-1",
      fiscalYear: 2025,
      month: 3,
      date: "2025-03-04",
      vendorName: "Acme Supplies",
      description: "Stationery",
      reference: "INV-9",
      journalType: "AP",
      amount: 1250.5,
      debit: 1250.5,
      credit: 0,
    });
  });

  it("drops a row that names no account", () => {
    // It cannot be reported against anything, and there is no sensible default.
    expect(toLedgerTransaction({ ...ROW, coaId: null })).toBeNull();
  });

  it("takes the year off the date when the row does not state one", () => {
    expect(toLedgerTransaction({ ...ROW, fiscalYear: null })?.fiscalYear).toBe(2025);
  });

  it("drops a row that lands in no year at all", () => {
    // Defaulting would put a real amount on an arbitrary statement, where it
    // adds up and is wrong.
    expect(toLedgerTransaction({ ...ROW, fiscalYear: null, transactionDate: null })).toBeNull();
    expect(
      toLedgerTransaction({ ...ROW, fiscalYear: null, transactionDate: "not a date" }),
    ).toBeNull();
  });

  it("reports a year without a month as month zero", () => {
    // Which the monthly views drop, rather than showing it under January.
    expect(toLedgerTransaction({ ...ROW, transactionDate: null })?.month).toBe(0);
  });

  it("reads the month in UTC, not the server's zone", () => {
    // The first of a month is the previous month west of Greenwich if the date
    // goes through a local-time parse.
    expect(toLedgerTransaction({ ...ROW, transactionDate: "2025-01-01" })?.month).toBe(1);
    expect(toLedgerTransaction({ ...ROW, transactionDate: "2025-12-31" })?.month).toBe(12);
  });

  it("treats an unpopulated text column as absent whichever way it is empty", () => {
    // `emptyToNull` is exercised through the mapper rather than directly: the
    // four columns it guards are the point, not the helper.
    const sparse = toLedgerTransaction({
      ...ROW,
      vendor: "",
      description: "   ",
      reference: null,
      journalType: "",
    });
    expect(sparse).toMatchObject({
      vendorName: null,
      description: null,
      reference: null,
      journalType: null,
    });
  });
});

describe("the debit and credit split", () => {
  it("keeps a real split", () => {
    expect(splitOf("100", "0", 100)).toEqual({ debit: 100, credit: 0 });
    expect(splitOf("0", "100", -100)).toEqual({ debit: 0, credit: 100 });
  });

  it("reports both-zero against a real amount as nobody having recorded it", () => {
    // The columns are DEFAULT 0, so an extractor that never wrote them leaves
    // zeroes — which read as "this was zero either way" rather than as "nobody
    // said which side it fell on".
    expect(splitOf("0", "0", 1000)).toEqual({ debit: null, credit: null });
  });

  it("keeps the zeroes on a genuinely zero row", () => {
    // There the split really is nothing on both sides, which is a fact rather
    // than a gap.
    expect(splitOf("0", "0", 0)).toEqual({ debit: 0, credit: 0 });
  });

  it("passes a null column through as null", () => {
    expect(splitOf(null, null, 0)).toEqual({ debit: null, credit: null });
    expect(splitOf(null, "50", 50)).toEqual({ debit: null, credit: 50 });
  });
});

describe("reading a number out of a column", () => {
  it("takes a number as it stands", () => {
    expect(toNumber(12.5)).toBe(12.5);
  });

  it("reads the string a numeric column arrives as", () => {
    expect(toNumber("1250.50")).toBe(1250.5);
    expect(toNumber("-40")).toBe(-40);
  });

  it("treats what it cannot read as zero", () => {
    expect(toNumber(null)).toBe(0);
    expect(toNumber(undefined)).toBe(0);
    expect(toNumber("n/a")).toBe(0);
  });
});

describe("a deployment that cannot read a statement", () => {
  it("says which of the two it is, with a 503", async () => {
    // A 503 naming the configuration rather than a 501 saying "not migrated":
    // it IS migrated, but reading a statement needs a model, and a server
    // without one should say so.
    await expect(new UnavailableReportSyncPort().sync()).rejects.toMatchObject({ status: 503 });
  });

  it("throws an HttpError, so the router maps it rather than 500ing", async () => {
    await expect(new UnavailableReportSyncPort().sync()).rejects.toBeInstanceOf(HttpError);
  });
});
