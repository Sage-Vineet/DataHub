import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * 0005 in isolation, against real Postgres.
 *
 * The interesting half is the constraints. This table is advisory — nothing
 * downstream reads it — so the risk is not a wrong number but a wrong row
 * surviving long enough for somebody to accept it. The checks below are the
 * same rules the service applies, placed where a future writer cannot bypass
 * them, and each one is asserted by trying to violate it.
 *
 * Hand-written base DDL is the exception this file is allowed to make: a
 * migration test has to run against the schema as it was BEFORE the migration,
 * which is by definition not what `createSchemaDb()` provides once the snapshot
 * includes it. Only the referenced key columns matter for foreign-key validity,
 * so the base is deliberately minimal.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(join(HERE, "0005_coa_recommendations.sql"), "utf8");
const DOWN = readFileSync(join(HERE, "0005_coa_recommendations.down.sql"), "utf8");
const TABLE = "key_report_coa_hierarchy_recommendations";

const BASE = `
  CREATE TABLE companies (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL);
  CREATE TABLE key_report_versions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE);
  CREATE TABLE chart_of_accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_name text NOT NULL);
`;

let db: PGlite;

/** Insert one row, overriding whichever columns a case is about. */
async function insert(over: Record<string, string> = {}) {
  const cols: Record<string, string> = {
    version_id: "(SELECT id FROM key_report_versions LIMIT 1)",
    company_id: "(SELECT id FROM companies LIMIT 1)",
    account_id: "(SELECT id FROM chart_of_accounts LIMIT 1)",
    current_hierarchy: `'["Net Income","Income","Interest Income"]'::jsonb`,
    recommended_rollup: `'Other Income'`,
    ...over,
  };
  const names = Object.keys(cols).join(", ");
  const values = Object.values(cols).join(", ");
  await db.exec(`INSERT INTO ${TABLE} (${names}) VALUES (${values});`);
}

beforeEach(async () => {
  db = new PGlite();
  await db.exec(BASE);
  await db.exec("INSERT INTO companies (name) VALUES ('Acme');");
  await db.exec("INSERT INTO key_report_versions (company_id) SELECT id FROM companies;");
  await db.exec("INSERT INTO chart_of_accounts (account_name) VALUES ('Interest Income');");
  await db.exec(MIGRATION);
});

afterEach(async () => {
  await db.close();
});

describe("0005 creates the recommendations table", () => {
  it("creates it, and is idempotent", async () => {
    const exists = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = $1`,
      [TABLE],
    );
    expect(exists.rows[0]!.n).toBe(1);

    // `CREATE TABLE IF NOT EXISTS` plus DROP/ADD constraint pairs — re-running
    // must not error, because the migration runner records a checksum and a
    // half-applied migration is worse than a repeated one.
    await expect(db.exec(MIGRATION)).resolves.toBeDefined();
  });

  it("accepts a well-formed recommendation", async () => {
    await insert();
    const rows = await db.query<{ status: string; kind: string }>(`SELECT status, kind FROM ${TABLE}`);
    expect(rows.rows[0]).toMatchObject({ status: "pending", kind: "ROLLUP_INSERT" });
  });
});

describe("the uniqueness key the upsert depends on", () => {
  it("refuses a duplicate (version, account, rollup)", async () => {
    await insert();
    // Without this the second pass would duplicate every recommendation rather
    // than refreshing it.
    await expect(insert()).rejects.toThrow(/unique|duplicate/i);
  });

  it("allows the same account with a different proposed rollup", async () => {
    await insert();
    await expect(insert({ recommended_rollup: `'Other Expenses'` })).resolves.toBeUndefined();
  });
});

describe("the constraints", () => {
  it("rejects a status outside the vocabulary", async () => {
    await expect(insert({ status: `'maybe'` })).rejects.toThrow(/coa_reco_status_check/);
  });

  it("still accepts the original engine's statuses", async () => {
    // Retained so decided rows imported from the legacy deployment stay valid.
    // Dropping them would turn somebody's recorded decision into a violation.
    await insert({ status: `'accepted'`, recommended_rollup: `'A'` });
    await insert({ status: `'ignored'`, recommended_rollup: `'B'` });
    const rows = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${TABLE}`);
    expect(rows.rows[0]!.n).toBe(2);
  });

  it("rejects an unknown kind", async () => {
    await expect(insert({ kind: `'RENAME'` })).rejects.toThrow(/coa_reco_kind_check/);
  });

  it("rejects an unknown confidence band but allows none at all", async () => {
    await expect(insert({ confidence_band: `'VERY HIGH'` })).rejects.toThrow(
      /coa_reco_confidence_band_check/,
    );
    await expect(insert({ confidence_band: "NULL" })).resolves.toBeUndefined();
  });

  it("rejects an unknown source and an unknown impact", async () => {
    await expect(insert({ source: `'VIBES'` })).rejects.toThrow(/coa_reco_source_check/);
    await expect(insert({ impact: `'SOMETHING'`, recommended_rollup: `'B'` })).rejects.toThrow(
      /coa_reco_impact_check/,
    );
  });

  describe("a RECLASSIFY must carry a valid target type, and only a RECLASSIFY may", () => {
    it("accepts one that does", async () => {
      await expect(
        insert({ kind: `'RECLASSIFY'`, recommended_account_type: `'equity'` }),
      ).resolves.toBeUndefined();
    });

    it("refuses one with no target type", async () => {
      // The service already refuses to store this, never downgrading it to a
      // hierarchy move — which would apply a P&L path to a balance-sheet
      // account. This is the same rule at the boundary.
      await expect(insert({ kind: `'RECLASSIFY'` })).rejects.toThrow(
        /coa_reco_reclassify_type_check/,
      );
    });

    it("refuses one with a target type outside the six", async () => {
      await expect(
        insert({ kind: `'RECLASSIFY'`, recommended_account_type: `'revenue'` }),
      ).rejects.toThrow(/coa_reco_reclassify_type_check/);
    });

    it("refuses a non-RECLASSIFY that carries a target type", async () => {
      await expect(
        insert({ kind: `'HIERARCHY_MOVE'`, recommended_account_type: `'equity'` }),
      ).rejects.toThrow(/coa_reco_reclassify_type_check/);
    });
  });
});

describe("the foreign keys", () => {
  it("removes recommendations with their version", async () => {
    await insert();
    await db.exec("DELETE FROM key_report_versions;");
    const rows = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${TABLE}`);
    expect(rows.rows[0]!.n).toBe(0);
  });

  it("removes recommendations with their account", async () => {
    await insert();
    await db.exec("DELETE FROM chart_of_accounts;");
    const rows = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${TABLE}`);
    expect(rows.rows[0]!.n).toBe(0);
  });

  it("constrains company_id, which the legacy table left loose", async () => {
    await expect(
      insert({ company_id: `'00000000-0000-4000-8000-000000000000'` }),
    ).rejects.toThrow(/foreign key/i);
  });
});

describe("the down migration", () => {
  it("removes the table", async () => {
    await insert();
    await db.exec(DOWN);
    const exists = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = $1`,
      [TABLE],
    );
    expect(exists.rows[0]!.n).toBe(0);
  });

  it("is idempotent, so a partial rollback can be retried", async () => {
    await db.exec(DOWN);
    await expect(db.exec(DOWN)).resolves.toBeDefined();
  });
});
