import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * `backend/sql/schema.sql` — the audit's "no authoritative schema" finding, pinned.
 *
 * Nothing in the repo ever applied this file to an empty database, so nothing
 * caught that it cannot build the schema it appears to define. Applying it here
 * found two independent defects:
 *
 *   - `bank_transactions` omitted `client_id` while an index referenced it. The
 *     running code settles which side was stale (`bankVsBooks.js:483` filters on
 *     `client_id`), so the declaration was fixed.
 *   - The file references `dataset_versions(id)` but never creates it — that table
 *     lives only in the migration set, where it is created TWICE with conflicting
 *     definitions (migrations 001 and 019). Which one production has depends on the
 *     order they ran in, so the answer is not recoverable from this repository.
 *
 * The second one is not fixable here without guessing at production's shape, and a
 * guess written into a file called `schema.sql` is worse than the current state.
 * So the file carries a NOT AUTHORITATIVE banner, and these tests hold the line:
 * the banner must stay until a snapshot reconciliation replaces the file, and the
 * rest of the file must keep applying cleanly given its one known missing
 * prerequisite — so a *new* defect of this class fails the build.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = resolve(HERE, "../../../../backend/sql/schema.sql");
const MIGRATION_019 = resolve(
  HERE,
  "../../../../backend/sql/migrations/019_snapshot_reporting_architecture.sql",
);

/**
 * PGlite ships without loadable extensions, so `CREATE EXTENSION pgcrypto` cannot
 * run here — a limitation of the test environment, not a defect in the file. Strip
 * exactly those statements and assert that is all we stripped, so the
 * accommodation can never quietly grow to hide a real error. `gen_random_uuid()`
 * is native from Postgres 13, so everything else applies unchanged.
 */
function withoutExtensions(raw: string): { sql: string; stripped: string[] } {
  const stripped: string[] = [];
  const sql = raw.replace(/^\s*CREATE\s+EXTENSION[^;]*;/gim, (match) => {
    stripped.push(match.trim());
    return "";
  });
  return { sql, stripped };
}

/**
 * The one prerequisite `schema.sql` needs and does not declare, taken verbatim
 * from migration 019 rather than invented. Isolating it here is the point: it
 * names the exact dependency, so if the file grows another undeclared one, the
 * apply test fails instead of this preamble silently absorbing it.
 */
function missingPrerequisiteSql(): string {
  const migration = readFileSync(MIGRATION_019, "utf8");
  const match = migration.match(/CREATE TABLE IF NOT EXISTS dataset_versions \([\s\S]*?\n\);/);
  if (!match) throw new Error("migration 019 no longer declares dataset_versions");
  return withoutExtensions(match[0]).sql;
}

let client: PGlite;

beforeAll(async () => {
  client = new PGlite();
});

afterAll(async () => {
  await client.close();
});

describe("backend/sql/schema.sql", () => {
  it("declares itself non-authoritative, so nobody treats it as the source of truth", () => {
    const raw = readFileSync(SCHEMA, "utf8");
    expect(raw).toMatch(/NOT AUTHORITATIVE/);
    expect(raw).toMatch(/dataset_versions/);
  });

  it("cannot apply to an empty database on its own — the defect this pins", async () => {
    const isolated = new PGlite();
    try {
      const { sql } = withoutExtensions(readFileSync(SCHEMA, "utf8"));
      await expect(isolated.exec(sql)).rejects.toThrow(/dataset_versions/);
    } finally {
      await isolated.close();
    }
  });

  it("applies cleanly once its one known missing prerequisite is supplied", async () => {
    const { sql, stripped } = withoutExtensions(readFileSync(SCHEMA, "utf8"));
    expect(stripped.every((s) => /^CREATE\s+EXTENSION/i.test(s))).toBe(true);

    // companies/users must exist before dataset_versions' foreign keys.
    await client.exec(`
      CREATE TABLE IF NOT EXISTS companies (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
      CREATE TABLE IF NOT EXISTS users (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
    `);
    await client.exec(missingPrerequisiteSql());
    await client.exec("DROP TABLE companies, users CASCADE;");

    await expect(client.exec(sql)).resolves.toBeDefined();
  });

  it("declares every column its own indexes reference", async () => {
    // The general form of the `bank_transactions(client_id)` defect: an index over
    // a column the table does not declare. Ask the catalog rather than re-parsing.
    const orphans = await client.query<{ index_name: string }>(`
      SELECT i.indexrelid::regclass::text AS index_name
      FROM pg_index i
      WHERE i.indrelid IN (SELECT oid FROM pg_class WHERE relkind = 'r')
        AND EXISTS (
          SELECT 1 FROM unnest(i.indkey) AS k(attnum)
          WHERE k.attnum > 0 AND NOT EXISTS (
            SELECT 1 FROM pg_attribute a
            WHERE a.attrelid = i.indrelid AND a.attnum = k.attnum AND NOT a.attisdropped
          )
        )
    `);
    expect(orphans.rows).toEqual([]);
  });

  it("declares bank_transactions.client_id, which the running code filters on", async () => {
    const columns = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'bank_transactions'`,
    );
    expect(columns.rows.map((r) => r.column_name)).toContain("client_id");
  });
});

describe("dataset_versions is defined twice, incompatibly", () => {
  // This is what makes the schema unrecoverable from the repository alone, and
  // therefore why reconciliation must introspect a production snapshot. If someone
  // reconciles the two definitions later, this test fails and should be deleted —
  // that is the intended outcome, not a regression.
  it("migrations 001 and 019 disagree on its columns", () => {
    const read = (file: string): string =>
      readFileSync(resolve(HERE, `../../../../backend/sql/migrations/${file}`), "utf8");
    const declaration = (sql: string): string => {
      const match = sql.match(/CREATE TABLE IF NOT EXISTS dataset_versions \(([\s\S]*?)\n\);/i);
      return match?.[1] ?? "";
    };

    const first = declaration(read("001_snapshot_dataset_versions.sql")).toLowerCase();
    const second = declaration(read("019_snapshot_reporting_architecture.sql")).toLowerCase();

    expect(first).not.toBe("");
    expect(second).not.toBe("");
    expect(first).toContain("version_number");
    expect(second).not.toContain("version_number");
    expect(second).toContain("sync_source");
    expect(first).not.toContain("sync_source");
  });
});
