import { describe, expect, it } from "vitest";
import { addAt, amountAt, lastOf, round2, roundedAt, sumAt } from "./amounts.js";

/**
 * The one place the views decide what an absent period means.
 *
 * It used to be decided about sixty times, inline, in `?? 0` fallbacks that no
 * test could reach — the keys are built from the same list the reads iterate,
 * so the absent case never arose. Stated once it can be tested once, which is
 * the point.
 */

describe("reading one period", () => {
  it("reads a figure that is there", () => {
    expect(amountAt({ "2024-01": 125.5 }, "2024-01")).toBe(125.5);
  });

  it("takes a number key as well as a string one", () => {
    // Months are numbers and periods are strings, and both index the same maps.
    expect(amountAt({ "3": 40 }, 3)).toBe(40);
  });

  it("reads a period nothing was written for as nothing happening", () => {
    expect(amountAt({ "2024-01": 1 }, "2024-02")).toBe(0);
  });

  it("reads an absent record or key as nothing too", () => {
    expect(amountAt(undefined, "2024-01")).toBe(0);
    expect(amountAt({ a: 1 }, null)).toBe(0);
    expect(amountAt({ a: 1 }, undefined)).toBe(0);
  });

  it("keeps a real zero apart from nothing, because both read as zero", () => {
    // They are the same number by design: a period recorded as zero and a
    // period with nothing in it are both "no movement".
    expect(amountAt({ a: 0 }, "a")).toBe(0);
  });

  it("rounds where a view reports it", () => {
    expect(roundedAt({ a: 1.005 }, "a")).toBe(1.01);
    expect(roundedAt({ a: 1.0049 }, "a")).toBe(1);
    expect(roundedAt(undefined, "a")).toBe(0);
  });
});

describe("adding periods up", () => {
  it("adds the ones it is given", () => {
    expect(sumAt({ a: 1.5, b: 2.25, c: 99 }, ["a", "b"])).toBe(3.75);
  });

  it("counts a period with nothing in it as nothing", () => {
    expect(sumAt({ a: 10 }, ["a", "b", "c"])).toBe(10);
  });

  it("adds nothing to nothing", () => {
    expect(sumAt({}, [])).toBe(0);
    expect(sumAt(undefined, ["a"])).toBe(0);
  });

  it("rounds the total rather than each term", () => {
    // Rounding each term first drifts: three thirds of a cent are a cent, not
    // nothing.
    expect(sumAt({ a: 0.004, b: 0.004, c: 0.004 }, ["a", "b", "c"])).toBe(0.01);
  });
});

describe("accumulating in place", () => {
  it("starts a period that was not there", () => {
    const running: Record<string, number> = {};
    addAt(running, "2024-01", 10);
    expect(running).toEqual({ "2024-01": 10 });
  });

  it("adds to one that was", () => {
    const running: Record<string, number> = { "2024-01": 10 };
    addAt(running, "2024-01", 5.005);
    expect(running["2024-01"]).toBe(15.01);
  });

  it("does not leave minus zero behind", () => {
    // `-0` serialises as `-0` and renders as "-0.00", which reads as a figure
    // somebody got wrong.
    const running: Record<string, number> = { a: 5 };
    addAt(running, "a", -5);
    expect(Object.is(running.a, -0)).toBe(false);
    expect(running.a).toBe(0);
  });
});

describe("rounding", () => {
  it("goes to the cent", () => {
    expect(round2(1.005)).toBe(1.01);
    expect(round2(-1.005)).toBe(-1);
    expect(round2(1234.5678)).toBe(1234.57);
  });

  it("never answers minus zero", () => {
    expect(Object.is(round2(-0.001), -0)).toBe(false);
    expect(round2(-0.001)).toBe(0);
  });
});

describe("the last of a list", () => {
  it("is the last one", () => {
    expect(lastOf([1, 2, 3])).toBe(3);
  });

  it("is null where there is none", () => {
    // Null rather than undefined: the views put it on the wire, and `undefined`
    // disappears from JSON while `null` says "there wasn't one".
    expect(lastOf([])).toBeNull();
  });
});
