import { describe, expect, it } from "vitest";
import type { DomainCoverage } from "./coverage.js";
import { verdictFor } from "./verdict.js";

/**
 * The exit code is the whole contract of this harness — CI reads it to decide
 * whether a cutover may proceed. The case worth pinning hardest is a clean run
 * that compared nothing, because that is the one which looks like success.
 */

const cov = (over: Partial<DomainCoverage> = {}): DomainCoverage => ({
  domain: "companies",
  comparable: 6,
  covered: 3,
  uncovered: ["DELETE /companies/:p"],
  outsideComparable: [],
  unmatched: [],
  ...over,
});

describe("differences", () => {
  it("fails, whatever the coverage", () => {
    expect(verdictFor(false, [cov()]).code).toBe(1);
  });
});

describe("a clean run that compared nothing", () => {
  it("is refused rather than reported as agreement", () => {
    // Before coverage was wired in, this printed PARITY CLEAN and exited 0.
    const v = verdictFor(true, [cov({ covered: 0, comparable: 6 })]);
    expect(v.code).toBe(3);
    expect(v.errors.join(" ")).toMatch(/no comparable endpoint was exercised/);
  });

  it("is refused when there are no domains at all", () => {
    expect(verdictFor(true, []).code).toBe(3);
  });

  it("is refused only when EVERY domain compared nothing", () => {
    const v = verdictFor(true, [cov({ covered: 0 }), cov({ domain: "folders", covered: 2 })]);
    expect(v.code).toBe(0);
  });
});

describe("stale scenarios", () => {
  it("fail the run, because an uncompared scenario is not a passing one", () => {
    const v = verdictFor(true, [cov({ unmatched: ["folders/list → GET /folder"] })]);
    expect(v.code).toBe(1);
    expect(v.errors.join(" ")).toMatch(/stale or mistyped/);
    // Naming them is the difference between a failure and a puzzle.
    expect(v.errors.join(" ")).toMatch(/folders\/list/);
  });
});

describe("partial coverage", () => {
  it("passes, but says so — it is evidence for a flip, not for a deletion", () => {
    const v = verdictFor(true, [cov({ covered: 3, comparable: 6 })]);
    expect(v.code).toBe(0);
    expect(v.warnings.join(" ")).toMatch(/partial/);
  });

  it("passes silently when every comparable endpoint was exercised", () => {
    const v = verdictFor(true, [cov({ covered: 6, comparable: 6, uncovered: [] })]);
    expect(v.code).toBe(0);
    expect(v.warnings).toEqual([]);
  });
});
