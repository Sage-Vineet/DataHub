import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAGE_SIZE,
  EXTRACTED_DATA_TYPES,
  MAX_PAGE_SIZE,
  isExtractedDataType,
  toLikePattern,
  toPage,
  toPageSize,
} from "./extracted-data.js";

/**
 * Reading back what extraction stored.
 *
 * The parts worth testing without a database are the ones that take values off
 * a query string: which table, which page, and how a search term becomes a
 * pattern. Each is a place where a caller's input reaches a query.
 */

describe("which table a request means", () => {
  it("recognises the five", () => {
    for (const type of EXTRACTED_DATA_TYPES) expect(isExtractedDataType(type)).toBe(true);
  });

  it("refuses anything else", () => {
    // `dataType` selects a TABLE. A closed set makes an unknown value a 400
    // rather than something that reaches a query builder.
    for (const type of ["", "users", "profit_loss; DROP TABLE", "PROFIT_LOSS"]) {
      expect(isExtractedDataType(type)).toBe(false);
    }
  });
});

describe("a search term as a pattern", () => {
  it("escapes the wildcards, so a search for a character finds that character", () => {
    // `%` and `_` are LIKE wildcards. Unescaped, searching for "50%" matches
    // every account starting "50", and searching for "_" matches everything —
    // a search box that silently means something else than it says.
    expect(toLikePattern("50%")).toBe("%50\\%%");
    expect(toLikePattern("_")).toBe("%\\_%");
  });

  it("escapes a backslash before the wildcards, not after", () => {
    // The other order double-escapes a backslash the user typed, so searching
    // for `a\b` looks for `a\\b` and finds nothing.
    expect(toLikePattern("a\\b")).toBe("%a\\\\b%");
  });

  it("wraps an ordinary term without touching it", () => {
    expect(toLikePattern("Rent")).toBe("%Rent%");
  });

  it("leaves a comma alone", () => {
    // Legacy built its filter as a comma-joined string, so a term containing a
    // comma changed the filter's STRUCTURE rather than what it searched for.
    // Here it is a bound parameter and a comma is just a comma.
    expect(toLikePattern("Smith, J")).toBe("%Smith, J%");
  });
});

describe("which page", () => {
  it("reads a page number", () => {
    expect(toPage("3")).toBe(3);
    expect(toPage(3)).toBe(3);
  });

  it("falls back to the first page rather than to page zero or minus one", () => {
    // A zero or negative page becomes a negative OFFSET, which the database
    // refuses — a 500 from a query string somebody mistyped.
    for (const value of ["0", "-1", "", "abc", null, undefined]) {
      expect(toPage(value)).toBe(1);
    }
  });
});

describe("how many rows", () => {
  it("takes a size the caller asks for", () => {
    expect(toPageSize("25")).toBe(25);
  });

  it("caps it, because the caller is a query string", () => {
    // Uncapped, `pageSize=100000` asks for a whole general ledger in one
    // response — tens of megabytes of JSON the page cannot render and the
    // server has to hold in memory to serialise.
    expect(toPageSize("100000")).toBe(MAX_PAGE_SIZE);
  });

  it("falls back to a default rather than to nothing", () => {
    for (const value of ["0", "-5", "", "lots", null, undefined]) {
      expect(toPageSize(value)).toBe(DEFAULT_PAGE_SIZE);
    }
  });
});
