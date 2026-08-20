#!/usr/bin/env node
/**
 * The migration runner.
 *
 * Until this existed there was no way to apply a migration. `tools/demo/up.sh`
 * hand-listed five `psql < file` steps and its own header called that sequence
 * "itself the finding"; a dev checkout had no bootstrap at all
 * (`openspec/changes/devenv-schema-bootstrap`). Three new table groups could not
 * land on that.
 *
 * Deliberately small. It applies `NNNN_*.sql` in filename order, once each, in a
 * transaction, and records what it did. The one piece of real opinion is the
 * checksum: an already-applied migration whose bytes have changed is a hard
 * error, because the alternative is a database that silently disagrees with the
 * file that claims to describe it.
 *
 * Usage:
 *   node scripts/migrate.mjs                 apply everything outstanding
 *   node scripts/migrate.mjs --to 0002       apply up to and including 0002
 *   node scripts/migrate.mjs --down 0001     roll back down to (not including) 0001
 *   node scripts/migrate.mjs --status        report without changing anything
 *   node scripts/migrate.mjs --force         re-record drifted checksums, apply nothing
 *
 * DATABASE_URL is required. Exits non-zero on any failure.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/** `0001_module_schema.sql` -> `0001`. The version is the ordering key. */
const VERSION = /^(\d{4})_.+\.sql$/;

export function discover(dir = MIGRATIONS_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => !f.endsWith(".down.sql") && VERSION.test(f))
    .sort()
    .map((file) => {
      const version = VERSION.exec(file)[1];
      const sql = readFileSync(join(dir, file), "utf8");
      const down = join(dir, file.replace(/\.sql$/, ".down.sql"));
      return {
        version,
        file,
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
        downPath: existsSync(down) ? down : null,
      };
    });
}

const LEDGER = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version     text PRIMARY KEY,
    checksum    text NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now()
  )
`;

/**
 * Compare what is on disk with what the database says it has applied.
 *
 * `drifted` is the interesting one — a version recorded as applied whose file no
 * longer hashes to what was recorded. Reporting it separately from `pending` is
 * the whole point: it must never be silently skipped as "already applied".
 */
export function plan(onDisk, applied) {
  const byVersion = new Map(applied.map((r) => [r.version, r]));
  const pending = [];
  const drifted = [];
  for (const m of onDisk) {
    const record = byVersion.get(m.version);
    if (!record) pending.push(m);
    else if (record.checksum !== m.checksum) drifted.push(m);
  }
  const orphaned = applied
    .filter((r) => !onDisk.some((m) => m.version === r.version))
    .map((r) => r.version);
  return { pending, drifted, orphaned };
}

async function readApplied(client) {
  await client.query(LEDGER);
  const { rows } = await client.query(
    "SELECT version, checksum FROM schema_migrations ORDER BY version",
  );
  return rows;
}

async function applyOne(client, m) {
  // One transaction per migration, so a failure half way through leaves nothing
  // behind and records nothing — the file stays pending and can be re-run once
  // fixed. A single transaction around the whole run would be tidier but makes a
  // partially-migrated database unrecoverable without manual surgery.
  await client.query("BEGIN");
  try {
    await client.query(m.sql);
    await client.query(
      "INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)",
      [m.version, m.checksum],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw new Error(`${m.file}: ${err.message}`, { cause: err });
  }
}

async function rollbackOne(client, m) {
  if (!m.downPath) throw new Error(`${m.file}: no .down.sql — refusing to roll back blind`);
  const sql = readFileSync(m.downPath, "utf8");
  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query("DELETE FROM schema_migrations WHERE version = $1", [m.version]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw new Error(`${m.file} (down): ${err.message}`, { cause: err });
  }
}

function parseArgs(argv) {
  const out = { to: null, down: null, force: false, status: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--force") out.force = true;
    else if (a === "--status") out.status = true;
    else if (a === "--to") out.to = argv[++i];
    else if (a === "--down") out.down = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

/** Progress goes to stdout: this is a CLI, and its output is not a diagnostic. */
const stdout = (message) => process.stdout.write(`${message}\n`);

export async function run(client, argv = [], opts = {}) {
  const log = opts.log ?? stdout;
  const args = parseArgs(argv);
  const onDisk = discover(opts.dir);
  const applied = await readApplied(client);
  const { pending, drifted, orphaned } = plan(onDisk, applied);

  for (const v of orphaned) {
    log(`  warn  ${v} is recorded as applied but has no file on disk`);
  }

  if (args.status) {
    log(`applied ${applied.length}, pending ${pending.length}, drifted ${drifted.length}`);
    for (const m of pending) log(`  pending  ${m.file}`);
    for (const m of drifted) log(`  DRIFTED  ${m.file}`);
    return { applied: [], rolledBack: [], drifted };
  }

  if (args.force) {
    for (const m of drifted) {
      await client.query("UPDATE schema_migrations SET checksum = $2 WHERE version = $1", [
        m.version,
        m.checksum,
      ]);
      log(`  re-recorded  ${m.file}`);
    }
    return { applied: [], rolledBack: [], drifted: [] };
  }

  if (drifted.length) {
    const names = drifted.map((m) => m.file).join(", ");
    throw new Error(
      `already-applied migration(s) changed on disk: ${names}. ` +
        `The database no longer matches the file that describes it. Write a new ` +
        `migration, or re-record deliberately with --force.`,
    );
  }

  if (args.down !== null) {
    // Roll back everything strictly above the target, newest first.
    const target = args.down;
    const toRollBack = onDisk
      .filter((m) => m.version > target && applied.some((r) => r.version === m.version))
      .reverse();
    for (const m of toRollBack) {
      await rollbackOne(client, m);
      log(`  rolled back  ${m.file}`);
    }
    return { applied: [], rolledBack: toRollBack.map((m) => m.version), drifted: [] };
  }

  const toApply = args.to === null ? pending : pending.filter((m) => m.version <= args.to);
  for (const m of toApply) {
    await applyOne(client, m);
    log(`  applied  ${m.file}`);
  }
  if (!toApply.length) log("  nothing to apply");
  return { applied: toApply.map((m) => m.version), rolledBack: [], drifted: [] };
}

// Entry point only when executed directly, so the functions above stay testable.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("migrate: DATABASE_URL is required");
    process.exit(1);
  }
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    await run(client, process.argv.slice(2));
  } catch (err) {
    console.error(`migrate: ${err.message}`);
    process.exit(1);
  } finally {
    await client.end();
  }
}
