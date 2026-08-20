import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

/**
 * 0004 in isolation, against real Postgres.
 *
 * The interesting half is the blob import. `WorkspaceCimPrep.jsx` persists one
 * flat `fieldValues[fieldId] = string` map into a single `workspace_page_state`
 * row, and the whole reason this migration is affordable is that the field id is
 * stable — so `block_key` carries it verbatim and the SPA sees the same shape
 * afterwards.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(join(HERE, "0004_cim.sql"), "utf8");
const DOWN = readFileSync(join(HERE, "0004_cim.down.sql"), "utf8");

const CREATED = [
  "cim_block_provenance",
  "cim_blocks",
  "cim_decks",
  "cim_publications",
  "cim_question_library",
  "cim_sections",
  "cim_slides",
  "cim_versions",
] as const;
const CREATED_SQL = CREATED.map((t) => `'${t}'`).join(", ");

/** The subset of the surrounding schema 0004 references. */
const BASE = `
  CREATE TABLE companies (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL);
  CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL);
  CREATE TABLE uploads (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), file_name text NOT NULL);
  CREATE TABLE folders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE, name text NOT NULL);
  CREATE TABLE documents (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    folder_id uuid NOT NULL REFERENCES folders(id) ON DELETE CASCADE, name text NOT NULL);
`;

/** The legacy blob table, present only where the legacy schema was loaded. */
const BLOB_TABLE = `
  CREATE TABLE workspace_page_state (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL,
    page_key text NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE (company_id, page_key)
  );
`;

const CO = "11111111-0000-4000-8000-000000000001";

let db: PGlite;

beforeEach(async () => {
  db = new PGlite();
  await db.waitReady;
  await db.exec(BASE);
  await db.exec(`INSERT INTO companies (id, name) VALUES ('${CO}', 'Acme');`);
});

afterEach(async () => {
  await db.close();
});

describe("0004 applies", () => {
  it("creates the CIM tables", async () => {
    await db.exec(MIGRATION);

    const { rows } = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name IN (${CREATED_SQL}) ORDER BY table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([...CREATED]);
  });

  it("applies to a database that has never had the legacy blob table", async () => {
    // The guard matters more than it looks: an unguarded INSERT..SELECT against a
    // missing table fails to PARSE, aborting the whole migration rather than
    // skipping one statement.
    await expect(db.exec(MIGRATION)).resolves.toBeDefined();
  });

  it("is idempotent", async () => {
    await db.exec(MIGRATION);
    await expect(db.exec(MIGRATION)).resolves.toBeDefined();
  });

  it("down removes what it added and leaves the rest", async () => {
    await db.exec(MIGRATION);
    await db.exec(DOWN);

    const gone = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name IN (${CREATED_SQL})`,
    );
    const kept = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name IN ('companies','users','documents')`,
    );
    expect(gone.rows[0].n).toBe(0);
    expect(kept.rows[0].n).toBe(3);
  });
});

describe("importing the JSON blob", () => {
  beforeEach(async () => {
    await db.exec(BLOB_TABLE);
  });

  async function seedBlob(payload: unknown) {
    await db.query(
      `INSERT INTO workspace_page_state (company_id, page_key, payload) VALUES ($1, 'cim-prep', $2)`,
      [CO, JSON.stringify(payload)],
    );
  }

  it("carries each field across under its existing key", async () => {
    // The key is the whole reason this is a re-point rather than a rewrite: the
    // SPA's in-memory shape after migration is identical to before.
    await seedBlob({
      globalDetails: { company_name: "Acme" },
      fieldValues: {
        "5:abc:token:0:company_name": "Acme Manufacturing",
        "7:def": "A leading maker of things",
      },
    });

    await db.exec(MIGRATION);

    const { rows } = await db.query<{ block_key: string; value: string }>(
      `SELECT block_key, content #>> '{}' AS value FROM cim_blocks ORDER BY block_key`,
    );
    expect(rows).toEqual([
      { block_key: "5:abc:token:0:company_name", value: "Acme Manufacturing" },
      { block_key: "7:def", value: "A leading maker of things" },
    ]);
  });

  it("puts the cover fields on the version", async () => {
    await seedBlob({ globalDetails: { company_name: "Acme", sector: "Manufacturing" } });

    await db.exec(MIGRATION);

    const { rows } = await db.query<{ name: string; sector: string }>(
      `SELECT cover ->> 'company_name' AS name, cover ->> 'sector' AS sector FROM cim_versions`,
    );
    expect(rows[0]).toEqual({ name: "Acme", sector: "Manufacturing" });
  });

  it("skips empty values rather than importing blank blocks", async () => {
    // An empty string is an unanswered field, and importing it as content would
    // make CM-0004's gap analysis report the deck as complete.
    await seedBlob({ fieldValues: { "1:a": "real", "2:b": "" } });

    await db.exec(MIGRATION);

    const { rows } = await db.query<{ block_key: string }>(`SELECT block_key FROM cim_blocks`);
    expect(rows.map((r) => r.block_key)).toEqual(["1:a"]);
  });

  it("marks imported content as authored, so gap analysis skips it", async () => {
    await seedBlob({ fieldValues: { "1:a": "written by the broker" } });

    await db.exec(MIGRATION);

    const { rows } = await db.query<{ populated_by: string }>(
      `SELECT populated_by FROM cim_blocks`,
    );
    expect(rows[0].populated_by).toBe("author");
  });

  it("creates one draft deck per company that had a blob", async () => {
    await seedBlob({ fieldValues: { "1:a": "x" } });

    await db.exec(MIGRATION);

    const { rows } = await db.query<{ n: number; status: string }>(
      `SELECT count(*)::int AS n, min(v.status) AS status
       FROM cim_decks d JOIN cim_versions v ON v.deck_id = d.id`,
    );
    expect(rows[0]).toEqual({ n: 1, status: "draft" });
  });

  it("leaves the blob in place, so the legacy path stays a rollback target", async () => {
    await seedBlob({ fieldValues: { "1:a": "x" } });

    await db.exec(MIGRATION);

    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM workspace_page_state`,
    );
    expect(rows[0].n).toBe(1);
  });

  it("does not import twice if the migration is re-applied", async () => {
    await seedBlob({ fieldValues: { "1:a": "x" } });
    await db.exec(MIGRATION);

    await db.exec(MIGRATION);

    const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM cim_decks`);
    expect(rows[0].n).toBe(1);
  });

  it("ignores rows for other pages", async () => {
    await db.query(
      `INSERT INTO workspace_page_state (company_id, page_key, payload) VALUES ($1, 'something-else', $2)`,
      [CO, JSON.stringify({ fieldValues: { "1:a": "not a CIM" } })],
    );

    await db.exec(MIGRATION);

    const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM cim_decks`);
    expect(rows[0].n).toBe(0);
  });
});

describe("version invariants", () => {
  beforeEach(async () => {
    await db.exec(MIGRATION);
    await db.query(
      `INSERT INTO cim_decks (id, company_id, name) VALUES ('22222222-0000-4000-8000-000000000001', $1, 'CIM')`,
      [CO],
    );
  });

  const deck = "22222222-0000-4000-8000-000000000001";

  it("allows only one unpublished version per deck", async () => {
    // Two drafts leaves "what am I editing" with no answer.
    await db.query(`INSERT INTO cim_versions (deck_id, version_no) VALUES ($1, 1)`, [deck]);

    await expect(
      db.query(`INSERT INTO cim_versions (deck_id, version_no) VALUES ($1, 2)`, [deck]),
    ).rejects.toThrow(/cim_versions_one_open/);
  });

  it("allows a new draft once the previous version is published", async () => {
    await db.query(
      `INSERT INTO cim_versions (deck_id, version_no, status) VALUES ($1, 1, 'published')`,
      [deck],
    );

    await expect(
      db.query(`INSERT INTO cim_versions (deck_id, version_no) VALUES ($1, 2)`, [deck]),
    ).resolves.toBeDefined();
  });

  it("rejects a status the service does not know", async () => {
    await expect(
      db.query(`INSERT INTO cim_versions (deck_id, version_no, status) VALUES ($1, 1, 'whenever')`, [
        deck,
      ]),
    ).rejects.toThrow(/status/);
  });

  it("defaults a block to deal content, unlocked", async () => {
    const ver = await db.query<{ id: string }>(
      `INSERT INTO cim_versions (deck_id, version_no) VALUES ($1, 1) RETURNING id`,
      [deck],
    );
    const sect = await db.query<{ id: string }>(
      `INSERT INTO cim_sections (version_id, section_key, title, sort_order)
       VALUES ($1, 'overview', 'Overview', 1) RETURNING id`,
      [ver.rows[0].id],
    );
    const slide = await db.query<{ id: string }>(
      `INSERT INTO cim_slides (version_id, section_id, layout_key, slide_no, sort_order)
       VALUES ($1, $2, 'source-slide-01', 1, 1) RETURNING id`,
      [ver.rows[0].id, sect.rows[0].id],
    );

    const block = await db.query<{ content_class: string; content_class_locked: boolean }>(
      `INSERT INTO cim_blocks (version_id, slide_id, block_key)
       VALUES ($1, $2, '1:a') RETURNING content_class, content_class_locked`,
      [ver.rows[0].id, slide.rows[0].id],
    );

    // Deal content by default: CM-0002 requires boilerplate to be opted into, so
    // nothing travels into a firm template by accident.
    expect(block.rows[0]).toEqual({ content_class: "deal", content_class_locked: false });
  });
});
