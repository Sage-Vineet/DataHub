import { describe, expect, it } from "vitest";
import { sourceHash } from "../scripts/snapshot-schema.mjs";
import { createSchemaDb, readSchemaSnapshot } from "./testing.js";
import * as schema from "./schema.all.js";

/**
 * The guard that keeps the snapshot honest.
 *
 * Same shape as `route-contract.test.ts` pinning `tools/parity/route-surface.json`:
 * a generated artifact is only trustworthy if something fails when the thing it
 * was generated from moves underneath it.
 */
describe("schema snapshot", () => {
  it("was generated from the SQL currently on disk", () => {
    const header = readSchemaSnapshot().slice(0, 4000);
    const recorded = /-- source-sha256: ([0-9a-f]{64})/.exec(header)?.[1];

    expect(
      recorded,
      "schema-snapshot.sql has no source-sha256 header — regenerate it.",
    ).toBeDefined();
    expect(
      recorded,
      "The schema SQL has changed since schema-snapshot.sql was generated. Rebuild a\n" +
        "database with tools/demo/up.sh, then:\n" +
        "  DATABASE_URL=... pnpm --filter @datahub/db db:snapshot",
    ).toBe(sourceHash());
  });

  // Building the whole schema in WASM is the slowest thing in this package, and
  // it gets slower every time a migration lands — 0005 took it from ~4s to
  // within a few hundred ms of the 5s default, which is a flake waiting for a
  // loaded CI box. The budget is generous on purpose: this assertion is about
  // the snapshot being loadable at all, never about how fast Postgres starts.
  it("loads into PGlite without an error, so tests can use it as-is", { timeout: 30_000 }, async () => {
    const db = await createSchemaDb();
    const tables = await db.query<{ n: number }>(
      `select count(*)::int n from information_schema.tables where table_schema='public'`,
    );

    expect(tables.rows[0]!.n).toBeGreaterThan(50);
    await db.close();
  });

  it("carries every table the Drizzle model declares", async () => {
    // A model table absent from the deployed schema is a migration nobody ran.
    // Names read directly rather than through a type predicate: narrowing to
    // `{ _: { name: string } }` is not assignable to the schema union, so the
    // predicate was a type error hiding behind an untypechecked test file.
    const declared = new Set(
      Object.values(schema as Record<string, unknown>).flatMap((v) => {
        if (typeof v !== "object" || v === null || !("_" in v)) return [];
        const meta = (v as { _: { name?: unknown } })._;
        return typeof meta?.name === "string" ? [meta.name] : [];
      }),
    );
    const db = await createSchemaDb();
    const rows = await db.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema='public'`,
    );
    const deployed = new Set(rows.rows.map((r) => r.table_name));

    const missing = [...declared].filter((t) => !deployed.has(t));
    expect(missing, `declared in packages/db but absent from the deployed schema`).toEqual([]);
    await db.close();
  });

  it("keeps the drift that made this necessary visible", async () => {
    // Not a curiosity — these exact columns are why three inserts shipped broken.
    // If the snapshot ever stops reporting them, it stopped being the real schema.
    const db = await createSchemaDb();
    const cols = await db.query<{ column_name: string; is_nullable: string; udt_name: string }>(
      `select column_name, is_nullable, udt_name from information_schema.columns
       where table_name='documents' and column_name in ('file_url','status')`,
    );
    const byName = Object.fromEntries(cols.rows.map((r) => [r.column_name, r]));

    expect(byName.file_url?.is_nullable).toBe("NO");
    expect(byName.status?.is_nullable).toBe("NO");

    const labels = await db.query<{ enumlabel: string }>(
      `select enumlabel from pg_enum e join pg_type t on t.oid=e.enumtypid
       where t.typname='document_status' order by enumsortorder`,
    );
    // The deployed vocabulary, which shares no value with the model's.
    expect(labels.rows.map((r) => r.enumlabel)).toEqual(["verified", "under-review", "rejected"]);
    await db.close();
  });
});
