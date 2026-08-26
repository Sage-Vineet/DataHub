import { describe, expect, it } from "vitest";
import { BadRequestError } from "../../shared/errors.js";
import { toAmount, toOverrideMap, toOverrides } from "./wire.js";

/**
 * Translating between the page's nested map and rows.
 *
 * The distinction that matters throughout: a CLEARED field and a ZERO are
 * different assertions. Cleared means "no correction here, use what was
 * extracted"; zero means "this line really is nil". Collapsing them turns
 * every cleared cell into a claim that the figure is nothing.
 */

describe("reading a figure the page sent", () => {
  it("keeps a cleared field apart from a zero", () => {
    expect(toAmount("")).toBeNull();
    expect(toAmount(null)).toBeNull();
    expect(toAmount(undefined)).toBeNull();
    expect(toAmount(0)).toBe(0);
    expect(toAmount("0")).toBe(0);
  });

  it("reads what a person actually types into a money field", () => {
    expect(toAmount("1,200.50")).toBe(1200.5);
    expect(toAmount(" 900 ")).toBe(900);
    expect(toAmount(-450)).toBe(-450);
  });

  it("returns null rather than NaN for something unreadable", () => {
    // NaN would reach `toFixed` and store the string "NaN" in a numeric
    // column, which fails at the driver with a message about nothing.
    expect(toAmount("about nine hundred")).toBeNull();
    expect(toAmount(Number.NaN)).toBeNull();
    expect(toAmount(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("parsing the page's map", () => {
  it("flattens year and line into one row per cell", () => {
    expect(
      toOverrides({
        "2024": { "Meals & Entertainment": { taxReturn: 1200, pl: 900 } },
        "2023": { Depreciation: { taxReturn: "", pl: 5000, userAdded: true } },
      }),
      // 2023 first, whatever order the page sent: JavaScript enumerates
      // integer-like object keys in ascending numeric order, not insertion
      // order. Worth pinning — a caller who assumed insertion order would be
      // right about every other key and wrong about years.
    ).toEqual([
      {
        fiscalYear: 2023,
        lineLabel: "Depreciation",
        taxReturnAmount: null,
        bookAmount: 5000,
        userAdded: true,
      },
      {
        fiscalYear: 2024,
        lineLabel: "Meals & Entertainment",
        taxReturnAmount: 1200,
        bookAmount: 900,
        userAdded: false,
      },
    ]);
  });

  it("refuses a key that is not a fiscal year", () => {
    // Storing it would leave a correction nothing ever reads: the
    // reconciliation looks up by year, so a row filed under "recent" is
    // invisible and silently absent from the figures.
    expect(() => toOverrides({ recent: { Meals: {} } })).toThrow(BadRequestError);
    expect(() => toOverrides({ "1800": { Meals: {} } })).toThrow(BadRequestError);
  });

  it("refuses something that is not a map at all", () => {
    for (const value of [null, "overrides", 42, [{ year: 2024 }]]) {
      expect(() => toOverrides(value)).toThrow(BadRequestError);
    }
    expect(() => toOverrides({ "2024": "Meals" })).toThrow(BadRequestError);
    expect(() => toOverrides({ "2024": [] })).toThrow(BadRequestError);
  });

  it("drops a line with no label rather than storing an unmatched row", () => {
    // An empty label cannot be matched against anything on the return.
    expect(toOverrides({ "2024": { "  ": { taxReturn: 100 } } })).toEqual([]);
  });

  it("trims a label, so two spellings of one line are one line", () => {
    expect(toOverrides({ "2024": { " Meals ": {} } })[0]!.lineLabel).toBe("Meals");
  });

  it("treats a missing cell as a cleared one", () => {
    expect(toOverrides({ "2024": { Meals: null } })).toEqual([
      {
        fiscalYear: 2024,
        lineLabel: "Meals",
        taxReturnAmount: null,
        bookAmount: null,
        userAdded: false,
      },
    ]);
  });

  it("takes only an explicit true as user-added", () => {
    // The flag says a line has no extracted counterpart, so nothing downstream
    // should treat its absence from the return as a discrepancy. A truthy
    // string arriving from a form must not turn that on by accident.
    expect(toOverrides({ "2024": { Meals: { userAdded: "yes" } } })[0]!.userAdded).toBe(false);
    expect(toOverrides({ "2024": { Meals: { userAdded: 1 } } })[0]!.userAdded).toBe(false);
    expect(toOverrides({ "2024": { Meals: { userAdded: true } } })[0]!.userAdded).toBe(true);
  });

  it("accepts an empty map", () => {
    expect(toOverrides({})).toEqual([]);
    expect(toOverrides({ "2024": {} })).toEqual([]);
  });
});

describe("rebuilding the map", () => {
  it("nests rows back under year and line", () => {
    expect(
      toOverrideMap([
        {
          fiscalYear: 2024,
          lineLabel: "Meals",
          taxReturnAmount: 1200,
          bookAmount: 900,
          userAdded: false,
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
        {
          fiscalYear: 2024,
          lineLabel: "Depreciation",
          taxReturnAmount: null,
          bookAmount: 5000,
          userAdded: true,
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
      ]),
    ).toEqual({
      "2024": {
        Meals: { taxReturn: 1200, pl: 900 },
        Depreciation: { taxReturn: null, pl: 5000, userAdded: true },
      },
    });
  });

  it("leaves the flag off a line nobody added", () => {
    // The page treats the flag's presence as meaningful, so a `false` on every
    // cell is noise it has to filter.
    const map = toOverrideMap([
      {
        fiscalYear: 2024,
        lineLabel: "Meals",
        taxReturnAmount: 0,
        bookAmount: null,
        userAdded: false,
        updatedAt: null,
      },
    ]);
    expect("userAdded" in map["2024"]!.Meals!).toBe(false);
  });

  it("survives a round trip without changing anything", () => {
    const original = {
      "2024": { Meals: { taxReturn: 1200, pl: 900 } },
      "2023": { Depreciation: { taxReturn: null, pl: 5000, userAdded: true } },
    };
    const roundTripped = toOverrideMap(
      toOverrides(original).map((o) => ({ ...o, updatedAt: null })),
    );
    expect(roundTripped).toEqual(original);
  });

  it("makes nothing out of nothing", () => {
    expect(toOverrideMap([])).toEqual({});
  });
});
