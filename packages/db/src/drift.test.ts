import { describe, expect, it } from "vitest";
import {
  baselineFrom,
  diffSchemas,
  driftKey,
  isBreaking,
  normalizeType,
  reconcile,
  renderDrift,
  type SchemaShape,
} from "./drift.js";

const database: SchemaShape = {
  companies: { id: "uuid", name: "text", legacy_flag: "boolean" },
  users: { id: "uuid", email: "text" },
  legacy_only_table: { id: "bigint" },
};

const declared: SchemaShape = {
  companies: { id: "uuid", name: "text" },
  users: { id: "uuid", email: "text" },
};

describe("type normalization", () => {
  it("treats Postgres spellings of the same type as equal", () => {
    expect(normalizeType("timestamp with time zone")).toBe(normalizeType("timestamptz"));
    expect(normalizeType("character varying")).toBe(normalizeType("varchar"));
    expect(normalizeType("int4")).toBe(normalizeType("integer"));
    expect(normalizeType("  BOOLEAN ")).toBe("boolean");
  });

  it("still distinguishes genuinely different types", () => {
    expect(normalizeType("text")).not.toBe(normalizeType("uuid"));
  });
});

describe("schema diff", () => {
  it("reports an unmodelled table as backlog, not as breakage", () => {
    const items = diffSchemas(database, declared);
    const table = items.find((i) => i.table === "legacy_only_table")!;
    expect(table.kind).toBe("table-missing-from-declaration");
    expect(isBreaking(table)).toBe(false);
  });

  it("reports a declared table the database lacks as breaking", () => {
    const items = diffSchemas({}, { ghost: { id: "uuid" } });
    expect(items[0]!.kind).toBe("table-missing-from-database");
    expect(isBreaking(items[0]!)).toBe(true);
  });

  // The direction matters: a column we declared that is absent from the database
  // breaks a module at runtime, while a column we have not modelled is backlog.
  it("reports a declared column the database lacks as breaking", () => {
    const items = diffSchemas(
      { companies: { id: "uuid" } },
      { companies: { id: "uuid", missing_col: "text" } },
    );
    const item = items.find((i) => i.column === "missing_col")!;
    expect(item.kind).toBe("column-missing-from-database");
    expect(isBreaking(item)).toBe(true);
  });

  it("reports an unmodelled column as backlog", () => {
    const item = diffSchemas(database, declared).find((i) => i.column === "legacy_flag")!;
    expect(item.kind).toBe("column-missing-from-declaration");
    expect(isBreaking(item)).toBe(false);
  });

  it("reports a type mismatch with both sides", () => {
    const item = diffSchemas(
      { companies: { id: "text" } },
      { companies: { id: "uuid" } },
    ).find((i) => i.kind === "type-differs")!;
    expect(item).toMatchObject({ table: "companies", column: "id", database: "text", declared: "uuid" });
    expect(isBreaking(item)).toBe(true);
  });

  it("finds nothing when the schemas agree", () => {
    expect(diffSchemas(declared, declared)).toEqual([]);
  });
});

describe("baseline reconciliation", () => {
  it("reports everything as new when no baseline exists", () => {
    const report = reconcile(database, declared, null);
    expect(report.known).toHaveLength(0);
    expect(report.fresh.length).toBeGreaterThan(0);
  });

  // Without this, every reconciliation re-derives the same known legacy drift and
  // a genuinely new difference is lost in the noise.
  it("separates drift already accepted in the baseline from new drift", () => {
    const baseline = baselineFrom(database, declared, "prod-snapshot", "2026-08-17T10:00:00.000Z");
    const report = reconcile(database, declared, baseline);

    expect(report.fresh).toHaveLength(0);
    expect(report.known.length).toBeGreaterThan(0);
  });

  it("surfaces drift that appeared after the baseline was taken", () => {
    const baseline = baselineFrom(database, declared, "prod-snapshot", "2026-08-17T10:00:00.000Z");
    const changed: SchemaShape = {
      ...database,
      companies: { ...database.companies!, brand_new_column: "text" },
    };

    const report = reconcile(changed, declared, baseline);
    expect(report.fresh).toHaveLength(1);
    expect(report.fresh[0]).toMatchObject({ table: "companies", column: "brand_new_column" });
  });

  it("keys baseline entries stably enough to match on a later run", () => {
    const item = diffSchemas(database, declared)[0]!;
    expect(driftKey(item)).toBe(driftKey({ ...item }));
  });
});

describe("drift rendering", () => {
  it("counts breaking drift separately and says when no baseline exists", () => {
    const report = reconcile({}, { ghost: { id: "uuid" } }, null);
    const text = renderDrift(report);
    expect(text).toMatch(/NO baseline recorded/);
    expect(text).toMatch(/1 breaking/);
    expect(text).toMatch(/ABSENT FROM THE DATABASE/);
  });

  it("hides known drift behind a count rather than reprinting it", () => {
    const baseline = baselineFrom(database, declared, "prod-snapshot", "2026-08-17T10:00:00.000Z");
    const text = renderDrift(reconcile(database, declared, baseline));
    expect(text).toMatch(/New drift: 0/);
    expect(text).toMatch(/Known drift carried by the baseline: \d+/);
    expect(text).not.toContain("legacy_only_table");
  });
});
