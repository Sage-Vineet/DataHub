import { describe, expect, it } from "vitest";
import { VOLATILE, matchesPath, normalize, type Json } from "./normalize.js";

describe("path matching", () => {
  it.each([
    ["id", ["id"], true],
    ["id", ["other"], false],
    ["[].id", ["[]", "id"], true],
    ["data[].created_at", ["data", "[]", "created_at"], true],
    ["data[].created_at", ["data", "created_at"], false],
    ["*.token", ["session", "token"], true],
    ["*.token", ["a", "b", "token"], false],
    ["**.id", ["id"], true],
    ["**.id", ["a", "b", "c", "id"], true],
    ["**.id", ["a", "b", "name"], false],
  ] as const)("matches %o against %o → %s", (pattern, path, expected) => {
    expect(matchesPath(pattern, path)).toBe(expected);
  });

  it("does not let * cross an array boundary", () => {
    // `*` means "one object key"; an array step must be written explicitly, so a
    // rule meant for a field cannot silently mask a whole collection.
    expect(matchesPath("*.id", ["[]", "id"])).toBe(false);
  });
});

describe("normalize", () => {
  it("masks volatile values but keeps the key", () => {
    const out = normalize({ id: "abc", name: "Acme" }, { volatile: ["id"] });
    expect(out).toEqual({ id: VOLATILE, name: "Acme" });
  });

  it("still reports a volatile field that disappears entirely", () => {
    // Masking the value must not mask its absence — that is a contract change.
    const control = normalize({ id: "abc", name: "Acme" }, { volatile: ["**.id"] });
    const candidate = normalize({ name: "Acme" }, { volatile: ["**.id"] });
    expect(control).not.toEqual(candidate);
  });

  it("masks volatile values at any depth with **", () => {
    const value: Json = { data: [{ id: 1, nested: { id: 2, keep: "x" } }] };
    expect(normalize(value, { volatile: ["**.id"] })).toEqual({
      data: [{ id: VOLATILE, nested: { id: VOLATILE, keep: "x" } }],
    });
  });

  it("orders object keys so key order is never a difference", () => {
    const a = normalize({ b: 1, a: 2 });
    const b = normalize({ a: 2, b: 1 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("sorts arrays only where declared", () => {
    const value: Json = [{ name: "b" }, { name: "a" }];
    expect(normalize(value, { sortArraysBy: { "": "name" } })).toEqual([
      { name: "a" },
      { name: "b" },
    ]);
    // Undeclared → order preserved, so a genuine ordering change is reported.
    expect(normalize(value)).toEqual([{ name: "b" }, { name: "a" }]);
  });

  it("sorts by the normalised element, so masked ids cannot affect order", () => {
    const spec = { volatile: ["**.id"], sortArraysBy: { "": "name" } };
    const left = normalize([{ id: "z", name: "a" }, { id: "a", name: "b" }], spec);
    const right = normalize([{ id: "q", name: "b" }, { id: "r", name: "a" }], spec);
    expect(left).toEqual(right);
  });

  it("drops ignored paths entirely", () => {
    expect(normalize({ keep: 1, drop: 2 }, { ignore: ["drop"] })).toEqual({ keep: 1 });
  });

  it("is deterministic", () => {
    const value: Json = { z: [3, 1, 2], a: { id: "x" } };
    const spec = { volatile: ["**.id"] };
    expect(JSON.stringify(normalize(value, spec))).toBe(JSON.stringify(normalize(value, spec)));
  });

  it("leaves primitives and nulls alone", () => {
    expect(normalize(null)).toBeNull();
    expect(normalize(42)).toBe(42);
    expect(normalize("text")).toBe("text");
  });
});
