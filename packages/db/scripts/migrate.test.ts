import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
// @ts-expect-error — the runner is plain JS on purpose; it must run under bare
// `node` with no build step, because `tools/demo/up.sh` calls it before anything
// in this repo has been compiled.
import { discover, plan, run } from "./migrate.mjs";

/**
 * A `pg.Client`-shaped shim over PGlite.
 *
 * PGlite's `query()` handles one statement; migration files hold many, and
 * `pg.Client.query()` accepts multi-statement SQL as long as no parameters are
 * bound. Routing on that distinction is exactly the contract the runner relies
 * on, so the shim is faithful rather than convenient.
 */
function client(db: PGlite) {
  return {
    query: async (sql: string, params?: unknown[]) =>
      params === undefined ? { rows: (await db.exec(sql)).at(-1)?.rows ?? [] } : db.query(sql, params),
  };
}

let dir: string;
let db: PGlite;
const silent = () => {};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "migrate-"));
  db = new PGlite();
  await db.waitReady;
});

afterEach(async () => {
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Point the runner at a scratch directory by monkey-patching discover's default. */
function write(name: string, sql: string) {
  writeFileSync(join(dir, name), sql);
}

async function appliedVersions(d: PGlite): Promise<string[]> {
  const res = await d.query<{ version: string }>(
    "SELECT version FROM schema_migrations ORDER BY version",
  );
  return res.rows.map((r) => r.version);
}

describe("discover", () => {
  it("orders by version and ignores down files and non-migrations", () => {
    write("0002_second.sql", "SELECT 2;");
    write("0001_first.sql", "SELECT 1;");
    write("0001_first.down.sql", "SELECT 0;");
    write("README.md", "not a migration");
    write("notes.sql", "SELECT 3;"); // no NNNN_ prefix

    const found = discover(dir);

    expect(found.map((m: { file: string }) => m.file)).toEqual(["0001_first.sql", "0002_second.sql"]);
    expect(found[0].version).toBe("0001");
    expect(found[0].downPath).toContain("0001_first.down.sql");
    expect(found[1].downPath).toBeNull();
  });

  it("hashes content, so two files with the same name but different bytes differ", () => {
    write("0001_a.sql", "SELECT 1;");
    const first = discover(dir)[0].checksum;
    write("0001_a.sql", "SELECT 2;");
    expect(discover(dir)[0].checksum).not.toBe(first);
  });
});

describe("plan", () => {
  const onDisk = [
    { version: "0001", checksum: "aaa" },
    { version: "0002", checksum: "bbb" },
  ];

  it("treats an unrecorded migration as pending", () => {
    const { pending, drifted } = plan(onDisk, [{ version: "0001", checksum: "aaa" }]);
    expect(pending.map((m: { version: string }) => m.version)).toEqual(["0002"]);
    expect(drifted).toEqual([]);
  });

  it("separates a changed file from a pending one — it must never look applied", () => {
    const { pending, drifted } = plan(onDisk, [
      { version: "0001", checksum: "CHANGED" },
      { version: "0002", checksum: "bbb" },
    ]);
    expect(pending).toEqual([]);
    expect(drifted.map((m: { version: string }) => m.version)).toEqual(["0001"]);
  });

  it("reports a recorded version whose file has vanished", () => {
    const { orphaned } = plan(onDisk, [
      { version: "0001", checksum: "aaa" },
      { version: "0009", checksum: "zzz" },
    ]);
    expect(orphaned).toEqual(["0009"]);
  });
});

describe("run — against real Postgres", () => {
  const opts = () => ({ dir, log: silent });

  it("applies pending migrations in order and records each one", async () => {
    write("0001_first.sql", "CREATE TABLE first (id int);");
    write("0002_second.sql", "CREATE TABLE second (id int); ALTER TABLE first ADD COLUMN note text;");

    const result = await run(client(db), [], opts());

    expect(result.applied).toEqual(["0001", "0002"]);
    expect(await appliedVersions(db)).toEqual(["0001", "0002"]);
    // Multi-statement migration bodies must both take effect.
    const cols = await db.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'first'",
    );
    expect(cols.rows.map((r) => r.column_name).sort()).toEqual(["id", "note"]);
  });

  it("is idempotent — a second run applies nothing", async () => {
    write("0001_first.sql", "CREATE TABLE first (id int);");
    await run(client(db), [], opts());

    const second = await run(client(db), [], opts());

    expect(second.applied).toEqual([]);
    expect(await appliedVersions(db)).toEqual(["0001"]);
  });

  it("rolls a failing migration back whole, and leaves it pending", async () => {
    write("0001_ok.sql", "CREATE TABLE kept (id int);");
    // The first statement would succeed on its own; the second cannot. Neither
    // may survive, or a re-run would fail on the half already applied.
    write("0002_bad.sql", "CREATE TABLE doomed (id int); SELECT * FROM nope;");

    await expect(run(client(db), [], opts())).rejects.toThrow(/0002_bad\.sql/);

    expect(await appliedVersions(db)).toEqual(["0001"]);
    const t = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'doomed'",
    );
    expect(t.rows[0].n).toBe(0);
  });

  it("refuses to run when an applied migration has changed on disk", async () => {
    write("0001_first.sql", "CREATE TABLE first (id int);");
    await run(client(db), [], opts());

    write("0001_first.sql", "CREATE TABLE first (id int); -- edited after the fact");

    await expect(run(client(db), [], opts())).rejects.toThrow(/changed on disk/);
  });

  it("does not silently treat a drifted migration as pending", async () => {
    write("0001_first.sql", "CREATE TABLE first (id int);");
    await run(client(db), [], opts());
    write("0001_first.sql", "CREATE TABLE first (id int); -- edited");
    write("0002_second.sql", "CREATE TABLE second (id int);");

    // The drift must block the whole run, not be skipped while 0002 proceeds.
    await expect(run(client(db), [], opts())).rejects.toThrow(/changed on disk/);
    expect(await appliedVersions(db)).toEqual(["0001"]);
  });

  it("--force re-records a drifted checksum without re-applying it", async () => {
    write("0001_first.sql", "CREATE TABLE first (id int);");
    await run(client(db), [], opts());
    write("0001_first.sql", "CREATE TABLE first (id int); -- edited");

    await run(client(db), ["--force"], opts());

    // Re-running the body would have failed on the already-existing table.
    const after = await run(client(db), [], opts());
    expect(after.applied).toEqual([]);
  });

  it("--to stops at the named version", async () => {
    write("0001_first.sql", "CREATE TABLE first (id int);");
    write("0002_second.sql", "CREATE TABLE second (id int);");
    write("0003_third.sql", "CREATE TABLE third (id int);");

    const result = await run(client(db), ["--to", "0002"], opts());

    expect(result.applied).toEqual(["0001", "0002"]);
    expect(await appliedVersions(db)).toEqual(["0001", "0002"]);
  });

  it("--down rolls back above the target, newest first, and forgets it", async () => {
    write("0001_first.sql", "CREATE TABLE first (id int);");
    write("0002_second.sql", "CREATE TABLE second (id int);");
    write("0002_second.down.sql", "DROP TABLE second;");
    await run(client(db), [], opts());

    const result = await run(client(db), ["--down", "0001"], opts());

    expect(result.rolledBack).toEqual(["0002"]);
    expect(await appliedVersions(db)).toEqual(["0001"]);
    const t = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'second'",
    );
    expect(t.rows[0].n).toBe(0);
  });

  it("refuses to roll back a migration that has no down script", async () => {
    write("0001_first.sql", "CREATE TABLE first (id int);");
    write("0002_second.sql", "CREATE TABLE second (id int);");
    await run(client(db), [], opts());

    await expect(run(client(db), ["--down", "0001"], opts())).rejects.toThrow(
      /no \.down\.sql/,
    );
    expect(await appliedVersions(db)).toEqual(["0001", "0002"]);
  });

  it("--status reports without changing anything", async () => {
    write("0001_first.sql", "CREATE TABLE first (id int);");
    const lines: string[] = [];

    const result = await run(client(db), ["--status"], { dir, log: (m: string) => lines.push(m) });

    expect(result.applied).toEqual([]);
    expect(await appliedVersions(db)).toEqual([]);
    expect(lines.join("\n")).toMatch(/pending 1/);
  });

  it("rejects an unknown argument rather than ignoring it", async () => {
    await expect(run(client(db), ["--wat"], opts())).rejects.toThrow(/unknown argument/);
  });
});

describe("the committed migration set", () => {
  it("is discoverable, ordered, and every migration has a down script", () => {
    const found = discover();

    expect(found.length).toBeGreaterThan(0);
    expect(found.map((m: { version: string }) => m.version)).toEqual(
      [...found.map((m: { version: string }) => m.version)].sort(),
    );
    for (const m of found) {
      expect(m.downPath, `${m.file} has no .down.sql`).not.toBeNull();
    }
  });
});
