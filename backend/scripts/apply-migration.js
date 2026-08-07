#!/usr/bin/env node
"use strict";

/**
 * Applies a SQL migration file over the verified TLS connection.
 *
 *   node scripts/apply-migration.js 089_security_sessions_and_audit.sql
 *   node scripts/apply-migration.js 089_...sql --dry-run
 *
 * Why a script rather than psql: `psql` is often not installed on developer
 * machines or on Render, and it would need the Supabase CA wired up separately.
 * This reuses the application's own pool, so the migration runs over exactly the
 * same verified TLS path as the app itself.
 *
 * The file is executed as a single statement batch. Migrations in this repo
 * wrap themselves in BEGIN/COMMIT; those that do not are run inside an implicit
 * transaction by the driver, so a failure rolls back rather than leaving the
 * schema half-applied.
 */

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { getSharedPool, closeSharedPool, describeSslPosture } = require("../src/db/pgPool");

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

const MIGRATIONS_DIR = path.join(__dirname, "..", "sql", "migrations");

(async () => {
  const arg = process.argv[2];
  const dryRun = process.argv.includes("--dry-run");

  if (!arg) {
    console.log("\nUsage: node scripts/apply-migration.js <file.sql> [--dry-run]\n");
    console.log("Available migrations:");
    for (const file of fs.readdirSync(MIGRATIONS_DIR).sort().slice(-12)) {
      console.log(`  ${file}`);
    }
    process.exit(1);
  }

  const file = path.isAbsolute(arg) ? arg : path.join(MIGRATIONS_DIR, arg);
  if (!fs.existsSync(file)) {
    console.log(`${RED}✗${RESET} Not found: ${file}`);
    process.exit(1);
  }

  const sql = fs.readFileSync(file, "utf8");
  console.log(`\nMigration : ${path.basename(file)}`);
  console.log(`Statements: ~${sql.split(";").filter((s) => s.trim()).length}`);
  console.log(`Connection: ${describeSslPosture()}\n`);

  if (dryRun) {
    console.log(`${YELLOW}!${RESET} Dry run — nothing was executed.`);
    await closeSharedPool();
    process.exit(0);
  }

  const pool = getSharedPool();
  const client = await pool.connect();
  const startedAt = Date.now();

  try {
    await client.query(sql);
    console.log(`${GREEN}✓${RESET} Applied in ${Date.now() - startedAt}ms`);
  } catch (error) {
    console.log(`${RED}✗${RESET} FAILED: ${error.message}`);
    if (error.position) console.log(`    at character ${error.position}`);
    if (error.code) console.log(`    SQLSTATE ${error.code}`);
    if (error.hint) console.log(`    hint: ${error.hint}`);
    client.release();
    await closeSharedPool();
    process.exit(1);
  }

  client.release();
  await closeSharedPool();
  process.exit(0);
})().catch((error) => {
  console.error(`${RED}✗${RESET} ${error.message}`);
  process.exit(1);
});
