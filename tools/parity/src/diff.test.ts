import { describe, expect, it } from "vitest";
import { diffBodies, diffResponses, worstSeverity } from "./diff.js";

describe("diffBodies", () => {
  it("finds nothing when the bodies match", () => {
    expect(diffBodies({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] })).toEqual([]);
  });

  it("reports a field legacy returns but the module does not", () => {
    const [diff] = diffBodies({ a: 1, b: 2 }, { a: 1 });
    expect(diff).toMatchObject({ kind: "missing-field", path: "$.b", severity: "major" });
  });

  it("reports an extra field as minor, not a failure of the same weight", () => {
    const [diff] = diffBodies({ a: 1 }, { a: 1, b: 2 });
    expect(diff).toMatchObject({ kind: "extra-field", path: "$.b", severity: "minor" });
  });

  it("treats a changed JSON type as critical", () => {
    // "3" vs 3 survives a loose eyeball but breaks arithmetic downstream.
    const [diff] = diffBodies({ total: 3 }, { total: "3" });
    expect(diff).toMatchObject({ kind: "type", severity: "critical" });
  });

  it("distinguishes null from absent", () => {
    const [diff] = diffBodies({ a: null }, {});
    expect(diff?.kind).toBe("missing-field");
  });

  it("reports array length once instead of a diff per element", () => {
    const diffs = diffBodies([1, 2, 3], [1]);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ path: "$.length", control: 3, candidate: 1 });
  });

  it("descends into equal-length arrays", () => {
    const [diff] = diffBodies([{ n: 1 }, { n: 2 }], [{ n: 1 }, { n: 99 }]);
    expect(diff).toMatchObject({ kind: "value", path: "$[].n", control: 2, candidate: 99 });
  });

  it("reports nested paths readably", () => {
    const [diff] = diffBodies({ a: { b: { c: 1 } } }, { a: { b: { c: 2 } } });
    expect(diff?.path).toBe("$.a.b.c");
  });
});

describe("diffResponses", () => {
  it("puts a status mismatch first and marks it critical", () => {
    const diffs = diffResponses({ status: 200, body: {} }, { status: 403, body: {} });
    expect(diffs[0]).toMatchObject({ kind: "status", severity: "critical", path: "$status" });
  });

  it("catches the 403-vs-404 substitution a rewrite tends to introduce", () => {
    const diffs = diffResponses(
      { status: 403, body: { error: "Forbidden" } },
      { status: 404, body: { error: "Not found" } },
    );
    expect(diffs.some((d) => d.kind === "status")).toBe(true);
  });
});

describe("worstSeverity", () => {
  it("returns undefined when there are no differences", () => {
    expect(worstSeverity([])).toBeUndefined();
  });

  it("ranks critical above major above minor", () => {
    const diffs = diffResponses(
      { status: 200, body: { a: 1, keep: 1 } },
      { status: 500, body: { a: 2, extra: 3 } },
    );
    expect(worstSeverity(diffs)).toBe("critical");
  });
});
