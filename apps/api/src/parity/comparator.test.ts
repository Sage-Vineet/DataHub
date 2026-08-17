import { describe, expect, it } from "vitest";
import { compareResponses, invariants, shapeOf, type ResponseSnapshot } from "./comparator.js";

const snap = (status: number, body: unknown, durationMs = 5): ResponseSnapshot => ({
  status,
  body,
  durationMs,
});

describe("shape derivation", () => {
  it("collapses volatile scalars to type placeholders", () => {
    expect(shapeOf("8f1e2d3c-4b5a-4968-8776-655443332211")).toBe("<uuid>");
    expect(shapeOf("2026-08-17T12:00:00.000Z")).toBe("<timestamp>");
    expect(shapeOf("2026-08-17")).toBe("<timestamp>");
    expect(shapeOf("Acme")).toBe("<string>");
    expect(shapeOf(42)).toBe("<number>");
    expect(shapeOf(null)).toBe("<null>");
  });

  it("collapses an array to a representative element shape", () => {
    expect(shapeOf([{ a: 1 }, { a: 2 }, { a: 3 }])).toEqual([{ a: "<number>" }]);
  });

  it("flags a heterogeneous array rather than picking the first element", () => {
    expect(shapeOf([{ a: 1 }, { b: "x" }])).toEqual(["<mixed:2>"]);
  });
});

describe("response comparison", () => {
  it("passes when only ids and timestamps differ", () => {
    const legacy = snap(200, {
      id: "8f1e2d3c-4b5a-4968-8776-655443332211",
      name: "Acme",
      created_at: "2026-08-17T12:00:00.000Z",
    });
    const module = snap(200, {
      id: "11111111-2222-4333-8444-555566667777",
      name: "Acme",
      created_at: "2026-08-18T09:30:00.000Z",
    });

    expect(compareResponses(legacy, module).verdict).toBe("pass");
  });

  it("fails and names the field when the module drops a key", () => {
    const legacy = snap(200, { id: "x", name: "Acme", industry: "SaaS" });
    const module = snap(200, { id: "y", name: "Acme" });

    const result = compareResponses(legacy, module);
    expect(result.verdict).toBe("fail");
    expect(result.differences).toHaveLength(1);
    expect(result.differences[0]?.field).toBe("body.industry");
    expect(result.differences[0]?.reason).toMatch(/missing from the module/);
  });

  it("fails when the module adds a key legacy never returned", () => {
    const result = compareResponses(snap(200, { name: "Acme" }), snap(200, { name: "Acme", extra: 1 }));
    expect(result.verdict).toBe("fail");
    expect(result.differences[0]?.field).toBe("body.extra");
    expect(result.differences[0]?.reason).toMatch(/not in legacy/);
  });

  it("fails on a type change with both sides reported", () => {
    const result = compareResponses(snap(200, { count: 3 }), snap(200, { count: "3" }));
    expect(result.verdict).toBe("fail");
    expect(result.differences[0]).toMatchObject({
      field: "body.count",
      legacy: '"<number>"',
      module: '"<string>"',
    });
  });

  it("fails on a status divergence and reports both codes", () => {
    const result = compareResponses(snap(200, {}), snap(401, {}));
    expect(result.verdict).toBe("fail");
    expect(result.differences[0]).toMatchObject({ field: "status", legacy: "200", module: "401" });
  });

  it("descends into nested fields", () => {
    const legacy = snap(200, { company: { name: "Acme", since: "2020-01-01" } });
    const module = snap(200, { company: { name: "Acme" } });

    const result = compareResponses(legacy, module);
    expect(result.differences[0]?.field).toBe("body.company.since");
  });

  it("descends into array elements", () => {
    const legacy = snap(200, [{ name: "a", status: "active" }]);
    const module = snap(200, [{ name: "a" }]);

    const result = compareResponses(legacy, module);
    expect(result.differences[0]?.field).toBe("body[].status");
  });

  it("treats an empty list as compatible with any element shape", () => {
    expect(compareResponses(snap(200, []), snap(200, [{ a: 1 }])).verdict).toBe("pass");
  });

  it("records latency without gating on it", () => {
    const result = compareResponses(snap(200, { a: 1 }, 5), snap(200, { a: 2 }, 500));
    expect(result.verdict).toBe("pass");
    expect(result.latency).toEqual({ legacyMs: 5, moduleMs: 500, deltaMs: 495 });
  });
});

describe("declared invariants", () => {
  // Shape equality proves the response looks right, not that it says the same
  // thing — two lists of different lengths have identical shapes.
  it("catches a count difference that shape comparison cannot see", () => {
    const legacy = snap(200, [{ name: "a" }, { name: "b" }, { name: "c" }]);
    const module = snap(200, [{ name: "a" }]);

    expect(compareResponses(legacy, module).verdict).toBe("pass");

    const withInvariant = compareResponses(legacy, module, [invariants.sameLength()]);
    expect(withInvariant.verdict).toBe("fail");
    expect(withInvariant.differences[0]?.reason).toMatch(/same number of items/);
  });

  it("catches differing values at the same shape", () => {
    const legacy = snap(200, [{ name: "Acme" }, { name: "Globex" }]);
    const module = snap(200, [{ name: "Acme" }, { name: "Initech" }]);

    const result = compareResponses(legacy, module, [invariants.sameValues("name")]);
    expect(result.verdict).toBe("fail");
    expect(result.differences[0]?.reason).toMatch(/same set of `name` values/);
  });

  it("passes when the invariant holds", () => {
    const rows = [{ name: "Acme" }, { name: "Globex" }];
    const result = compareResponses(snap(200, rows), snap(200, [...rows].reverse()), [
      invariants.sameValues("name"),
      invariants.sameLength(),
    ]);
    expect(result.verdict).toBe("pass");
  });
});
