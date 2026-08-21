import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

/**
 * A PGlite database carrying the REAL deployed schema.
 *
 * Integration tests used to hand-write their own DDL, which is how three
 * production defects passed every test on the way in: each one described a
 * column more permissively than production has it, so an insert that could never
 * succeed was green. Loading the generated snapshot removes the opportunity — a
 * test cannot disagree with a schema it did not write.
 *
 * Regenerate the snapshot with `pnpm --filter @datahub/db db:snapshot` after
 * changing any of the SQL it is built from; `schema-snapshot.test.ts` fails if
 * you forget.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
export const SNAPSHOT_PATH = join(HERE, "..", "schema-snapshot.sql");

export function readSchemaSnapshot(): string {
  return readFileSync(SNAPSHOT_PATH, "utf8");
}

/**
 * Building the schema costs ~2s; restoring a built one costs ~0.4s. Tests make a
 * fresh database per case, so the difference is the whole suite's runtime rather
 * than a rounding error — hence one build per process, reused.
 */
let snapshotBlob: Promise<Blob> | null = null;

function buildOnce(): Promise<Blob> {
  snapshotBlob ??= (async () => {
    const seed = new PGlite();
    await seed.exec(readSchemaSnapshot());
    const blob = await seed.dumpDataDir("none");
    await seed.close();
    return blob;
  })();
  return snapshotBlob;
}

/**
 * A fresh, empty database with every real table, type, constraint and default.
 *
 * Empty of rows, not of schema: seed whatever the case needs through the module
 * under test, or with SQL that has to satisfy the same constraints production
 * does — which is the point.
 */
export async function createSchemaDb(): Promise<PGlite> {
  return new PGlite({ loadDataDir: await buildOnce() });
}
