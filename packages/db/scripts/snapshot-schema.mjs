/**
 * Capture the deployed schema as a single loadable file.
 *
 * Integration tests used to declare their own DDL by hand, table by table. That
 * is how three production defects reached `ba/rearch` and passed every test:
 * `documents.status` against an enum with no value in common with the model's,
 * `documents.file_url` and `companies.industry` NOT NULL where the test said
 * nullable, and `document_activity` missing legacy's two NOT NULL columns
 * entirely. In each case the hand-written DDL described the schema we are
 * migrating *toward*, so an insert that could never succeed in production was
 * green on the way in.
 *
 * The fix is to stop writing that DDL. This dumps the real thing — the database
 * `tools/demo/up.sh` builds from legacy `schema.sql`, legacy migrations 049/050
 * and the Drizzle migrations, in that order — and tests load the result.
 *
 * Run it against a database built by that sequence:
 *
 *   DATABASE_URL=postgres://datahub:datahub@127.0.0.1:5435/datahub \
 *     pnpm --filter @datahub/db db:snapshot
 *
 * The header records a hash of every source file the schema is built from, and
 * `schema-snapshot.test.ts` fails when the sources move without the snapshot
 * being regenerated — the same guarantee, and the same shape, as the route
 * surface that `route-contract.test.ts` pins.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DB_PKG = join(HERE, "..");
const ROOT = join(DB_PKG, "..", "..");
export const SNAPSHOT_PATH = join(DB_PKG, "schema-snapshot.sql");

/** Every file the deployed schema is built from, in the order up.sh applies them. */
export function sourceFiles() {
  const drizzle = readdirSync(join(DB_PKG, "migrations"))
    .filter((f) => f.endsWith(".sql") && !f.includes(".down."))
    .sort()
    .map((f) => join("packages", "db", "migrations", f));
  return [
    join("backend", "sql", "schema.sql"),
    join("backend", "sql", "migrations", "049_key_reports_entry_tables.sql"),
    join("backend", "sql", "migrations", "050_general_ledger_entries_new_columns.sql"),
    ...drizzle,
  ];
}

/** A hash over the source SQL, so a snapshot cannot silently go stale. */
export function sourceHash() {
  const hash = createHash("sha256");
  for (const rel of sourceFiles()) {
    hash.update(rel);
    hash.update(readFileSync(join(ROOT, rel)));
  }
  return hash.digest("hex");
}

/**
 * Make a pg_dump loadable by PGlite.
 *
 * Two edits, both mechanical and both explained where they happen, so a reader
 * of the snapshot is never left wondering what was done to it.
 */
export function normalize(dump) {
  const lines = dump.split("\n").filter((line) => !line.startsWith("\\"));
  return lines
    .join("\n")
    .replace(
      /^CREATE EXTENSION IF NOT EXISTS pgcrypto.*$/m,
      "-- pgcrypto omitted: gen_random_uuid() is core from PG13 and PGlite has no extension.",
    )
    .replace(/\n{3,}/g, "\n\n");
}

function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(
      "DATABASE_URL is required. Point it at a database built by tools/demo/up.sh —\n" +
        "the snapshot is only meaningful if it captures that exact sequence.",
    );
    process.exit(1);
  }
  const dump = execFileSync(
    "pg_dump",
    ["--schema-only", "--no-owner", "--no-privileges", "--no-comments", "--dbname", url],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );

  const body = normalize(dump);
  const header = [
    "-- GENERATED FILE — do not edit by hand.",
    "--",
    "-- The deployed schema, captured with packages/db/scripts/snapshot-schema.mjs.",
    "-- Integration tests load this instead of declaring DDL themselves, so a test",
    "-- can no longer describe a table more permissively than production has it.",
    "--",
    "-- Regenerate after changing any file below:",
    "--   DATABASE_URL=... pnpm --filter @datahub/db db:snapshot",
    "--",
    ...sourceFiles().map((f) => `--   ${f}`),
    "--",
    `-- source-sha256: ${sourceHash()}`,
    "",
  ].join("\n");

  writeFileSync(SNAPSHOT_PATH, header + body);
  const tables = (body.match(/^CREATE TABLE /gm) ?? []).length;
  const types = (body.match(/^CREATE TYPE /gm) ?? []).length;
  console.log(`schema snapshot: ${tables} tables, ${types} types -> ${SNAPSHOT_PATH}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
