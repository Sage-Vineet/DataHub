import { describe, expect, it } from "vitest";
import { inferMappingYear, normalizeYear, yearsInText } from "./mapping-year.js";

/**
 * Reading a year off a file name.
 *
 * A weak signal, so the interesting cases are the ones where it should decline
 * rather than the ones where it succeeds: a wrong default silently files a
 * document under the wrong period, and nobody re-reads a field that was
 * pre-filled.
 */

describe("normalizing a year", () => {
  it("takes a four-digit year as written", () => {
    expect(normalizeYear(2024)).toBe(2024);
    expect(normalizeYear("1998")).toBe(1998);
  });

  it("windows a two-digit year at 70", () => {
    // Legacy's cut, kept: a "70" in a file name is far likelier to be 1970
    // than 2070, and moving the boundary would reinterpret existing rows.
    expect(normalizeYear(69)).toBe(2069);
    expect(normalizeYear(70)).toBe(1970);
    expect(normalizeYear("24")).toBe(2024);
    expect(normalizeYear("99")).toBe(1999);
  });

  it("declines anything that is not a year", () => {
    for (const value of [null, undefined, "", "FY", -1, 0, 100, 999, 10000, Number.NaN]) {
      expect(normalizeYear(value)).toBeNull();
    }
  });
});

describe("years in a file name", () => {
  it("finds a four-digit year", () => {
    expect(yearsInText("Balance Sheet 2024.pdf")).toEqual([2024]);
  });

  it("finds a month-and-two-digit-year, which legacy never could", () => {
    // `new RegExp(month + '[\\s._-]*(\\d{2,4})')` — a STRING literal, so `\\s`
    // and `\\d` collapsed to `s` and `d` and the pattern compiled as
    // `[s._-]*(d{2,4})`, hunting for literal `d`s. This branch has never fired.
    expect(yearsInText("Financials Jan 24.pdf")).toEqual([2024]);
    expect(yearsInText("P&L_December_23.xlsx")).toEqual([2023]);
    expect(yearsInText("Trial Balance-Mar-22")).toEqual([2022]);
  });

  it("still finds the four-digit form when a month is present too", () => {
    expect(yearsInText("GL January 2023.csv")).toEqual([2023]);
  });

  it("returns every year mentioned, ascending and deduplicated", () => {
    expect(yearsInText("Comparison 2022 vs 2024 (2022 base).xlsx")).toEqual([2022, 2024]);
  });

  it("finds nothing in a name that says nothing", () => {
    expect(yearsInText("Balance Sheet.pdf")).toEqual([]);
    expect(yearsInText("")).toEqual([]);
    expect(yearsInText(null)).toEqual([]);
  });

  it("does not read an arbitrary number as a year", () => {
    // A four-digit run is only a year if it looks like one.
    expect(yearsInText("Invoice 4821.pdf")).toEqual([]);
    expect(yearsInText("Account 1234 statement.pdf")).toEqual([]);
  });

  it("scans each name from the start, whatever was scanned before it", () => {
    // The month-year pattern is a module-level /g regex, so `lastIndex`
    // persists between calls unless it is reset. Without the reset the second
    // call here starts part-way through and finds nothing.
    expect(yearsInText("Ledger Jan 24.pdf")).toEqual([2024]);
    expect(yearsInText("Ledger Jan 24.pdf")).toEqual([2024]);
    expect(yearsInText("Ledger Feb 23.pdf")).toEqual([2023]);
  });
});

describe("the year a mapping is filed under", () => {
  it("takes the latest year mentioned", () => {
    // A comparative document is about the later period; the earlier is context.
    expect(inferMappingYear("FY2023 vs FY2024.xlsx")).toBe(2024);
  });

  it("is null when the name says nothing", () => {
    expect(inferMappingYear("Balance Sheet.pdf")).toBeNull();
    expect(inferMappingYear(null)).toBeNull();
    expect(inferMappingYear(undefined)).toBeNull();
  });
});
