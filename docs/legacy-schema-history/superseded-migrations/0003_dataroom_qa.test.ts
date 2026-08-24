import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

/**
 * 0003 in isolation, against real Postgres.
 *
 * The migration depends on legacy tables (companies, users, folders, uploads,
 * documents) that `backend/sql/schema.sql` creates and PGlite has no way to load
 * — that file does not apply cleanly even to real Postgres. So the dependencies
 * are declared here in the shape the migration actually needs, following the
 * hand-written-DDL convention the API integration tests already use
 * (apps/api/src/modules/uploads/uploads.integration.test.ts).
 *
 * What this buys is the part worth having: the invariants are enforced by the
 * DATABASE, not by a service remembering to. A service can forget; a partial
 * unique index cannot.
 */

/** Exactly the tables 0003 owns. Named rather than pattern-matched, so the legacy
 *  `documents` and `uploads` tables cannot drift into the assertion. */
const CREATED = [
  "document_comments",
  "document_versions",
  "qa_assignees",
  "qa_assignment_events",
  "qa_attachments",
  "qa_categories",
  "qa_item_visibility",
  "qa_items",
  "qa_nominations",
  "qa_presentations",
  "qa_responses",
  "upload_chunks",
  "upload_sessions",
] as const;

const CREATED_SQL = CREATED.map((t) => `'${t}'`).join(", ");

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(join(HERE, "0003_dataroom_qa.sql"), "utf8");
const DOWN = readFileSync(join(HERE, "0003_dataroom_qa.down.sql"), "utf8");

/**
 * The subset of the legacy schema 0003 references, in the shape it references it.
 * No pgcrypto: `gen_random_uuid()` is core from Postgres 13, and PGlite ships no
 * extensions — the migration relies only on the core function.
 */
const LEGACY = `
  CREATE TABLE companies (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL
  );
  CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    company_id uuid REFERENCES companies(id) ON DELETE CASCADE
  );
  CREATE TABLE folders (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name text NOT NULL
  );
  CREATE TABLE uploads (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    file_name text NOT NULL,
    data bytea
  );
  CREATE TABLE documents (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    folder_id uuid NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    name text NOT NULL,
    upload_id uuid REFERENCES uploads(id) ON DELETE SET NULL,
    uploaded_by uuid REFERENCES users(id),
    uploaded_at timestamptz NOT NULL DEFAULT now()
  );
`;

const CO = "11111111-0000-4000-8000-000000000001";
const USER = "22222222-0000-4000-8000-000000000001";
const FOLDER = "33333333-0000-4000-8000-000000000001";
const UPLOAD = "44444444-0000-4000-8000-000000000001";
const DOC = "55555555-0000-4000-8000-000000000001";

let db: PGlite;

async function seedLegacy() {
  await db.exec(`
    INSERT INTO companies (id, name) VALUES ('${CO}', 'Probe Co');
    INSERT INTO users (id, name, company_id) VALUES ('${USER}', 'Probe User', '${CO}');
    INSERT INTO folders (id, company_id, name) VALUES ('${FOLDER}', '${CO}', 'Finance');
    INSERT INTO uploads (id, file_name, data) VALUES ('${UPLOAD}', 'a.pdf', '\\x00'::bytea);
    INSERT INTO documents (id, company_id, folder_id, name, upload_id, uploaded_by)
      VALUES ('${DOC}', '${CO}', '${FOLDER}', 'a.pdf', '${UPLOAD}', '${USER}');
  `);
}

async function newItem(id: string) {
  await db.exec(`
    INSERT INTO qa_items (id, company_id, title, body, requestor_id, created_by)
    VALUES ('${id}', '${CO}', 't', 'b', '${USER}', '${USER}');
  `);
}

beforeEach(async () => {
  db = new PGlite();
  await db.waitReady;
  await db.exec(LEGACY);
});

afterEach(async () => {
  await db.close();
});

describe("0003 applies", () => {
  it("creates every table the two capabilities need", async () => {
    await db.exec(MIGRATION);

    const { rows } = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name IN (${CREATED_SQL})
       ORDER BY table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([...CREATED]);
  });

  it("is idempotent — applying twice is not an error", async () => {
    await db.exec(MIGRATION);
    await expect(db.exec(MIGRATION)).resolves.toBeDefined();
  });

  it("down removes everything it added, pointer column first", async () => {
    await db.exec(MIGRATION);
    await db.exec(DOWN);

    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name IN (${CREATED_SQL})`,
    );
    expect(rows[0].n).toBe(0);

    // The legacy tables it built on must survive — down reverses this migration,
    // not the schema underneath it.
    const legacy = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name IN ('documents','uploads','folders','companies','users')`,
    );
    expect(legacy.rows[0].n).toBe(5);
    const cols = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.columns
       WHERE table_name = 'documents' AND column_name IN ('current_version_id','version_count')`,
    );
    expect(cols.rows[0].n).toBe(0);
  });
});

describe("backfill", () => {
  it("gives every existing document a v1, so no version list is ever empty", async () => {
    await seedLegacy();

    await db.exec(MIGRATION);

    const { rows } = await db.query<{ version_no: number; upload_id: string }>(
      `SELECT version_no, upload_id FROM document_versions WHERE document_id = '${DOC}'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].version_no).toBe(1);
    expect(rows[0].upload_id).toBe(UPLOAD);
  });

  it("points the document at its backfilled version", async () => {
    await seedLegacy();

    await db.exec(MIGRATION);

    const { rows } = await db.query<{ pointed: boolean; version_count: number }>(
      `SELECT current_version_id IS NOT NULL AS pointed, version_count
       FROM documents WHERE id = '${DOC}'`,
    );
    expect(rows[0]).toEqual({ pointed: true, version_count: 1 });
  });

  it("skips a document with no stored content rather than inventing a version", async () => {
    await db.exec(`
      INSERT INTO companies (id, name) VALUES ('${CO}', 'Probe Co');
      INSERT INTO folders (id, company_id, name) VALUES ('${FOLDER}', '${CO}', 'Finance');
      INSERT INTO documents (id, company_id, folder_id, name) VALUES ('${DOC}', '${CO}', '${FOLDER}', 'placeholder');
    `);

    await db.exec(MIGRATION);

    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM document_versions WHERE document_id = '${DOC}'`,
    );
    expect(rows[0].n).toBe(0);
  });

  it("does not double-backfill when the migration is re-applied", async () => {
    await seedLegacy();
    await db.exec(MIGRATION);

    await db.exec(MIGRATION);

    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM document_versions WHERE document_id = '${DOC}'`,
    );
    expect(rows[0].n).toBe(1);
  });

  it("seeds each company's Q&A categories from the requests vocabulary", async () => {
    await seedLegacy();

    await db.exec(MIGRATION);

    const { rows } = await db.query<{ key: string }>(
      `SELECT key FROM qa_categories WHERE company_id = '${CO}' ORDER BY sort_order`,
    );
    expect(rows.map((r) => r.key)).toEqual([
      "finance",
      "legal",
      "compliance",
      "hr",
      "tax",
      "ma",
      "other",
    ]);
  });
});

describe("answer versioning is enforced by the database, not by the service", () => {
  const ITEM = "66666666-0000-4000-8000-000000000001";
  const R1 = "77777777-0000-4000-8000-000000000001";
  const R2 = "77777777-0000-4000-8000-000000000002";

  beforeEach(async () => {
    await seedLegacy();
    await db.exec(MIGRATION);
    await newItem(ITEM);
    await db.exec(`
      INSERT INTO qa_responses (id, item_id, citation_ref, body, author_id, answer_root_id)
      VALUES ('${R1}', '${ITEM}', 'QA-1.R1', 'v1', '${USER}', '${R1}');
    `);
  });

  it("refuses a second current version of the same answer", async () => {
    await expect(
      db.exec(`
        INSERT INTO qa_responses (id, item_id, citation_ref, body, author_id, answer_root_id, answer_version)
        VALUES ('${R2}', '${ITEM}', 'QA-1.R2', 'v2', '${USER}', '${R1}', 2);
      `),
    ).rejects.toThrow(/qa_responses_current_root_uq/);
  });

  it("allows a supersede — flip the prior, insert the new — and keeps both readable", async () => {
    await db.exec(`
      UPDATE qa_responses SET is_current = false WHERE id = '${R1}';
      INSERT INTO qa_responses (id, item_id, citation_ref, body, author_id, supersedes_id, answer_root_id, answer_version)
      VALUES ('${R2}', '${ITEM}', 'QA-1.R2', 'v2', '${USER}', '${R1}', '${R1}', 2);
    `);

    const { rows } = await db.query<{ answer_version: number; is_current: boolean; body: string }>(
      `SELECT answer_version, is_current, body FROM qa_responses
       WHERE answer_root_id = '${R1}' ORDER BY answer_version`,
    );
    expect(rows).toEqual([
      { answer_version: 1, is_current: false, body: "v1" },
      { answer_version: 2, is_current: true, body: "v2" },
    ]);
  });

  it("keeps every citation reference unique, so an old citation still resolves", async () => {
    await expect(
      db.exec(`
        INSERT INTO qa_responses (id, item_id, citation_ref, body, author_id)
        VALUES ('${R2}', '${ITEM}', 'QA-1.R1', 'collides', '${USER}');
      `),
    ).rejects.toThrow(/qa_responses_citation_uq/);
  });

  it("lets unrelated answers each hold a current version", async () => {
    const other = "77777777-0000-4000-8000-000000000009";
    await expect(
      db.exec(`
        INSERT INTO qa_responses (id, item_id, citation_ref, body, author_id, answer_root_id)
        VALUES ('${other}', '${ITEM}', 'QA-1.R9', 'other answer', '${USER}', '${other}');
      `),
    ).resolves.toBeDefined();
  });
});

describe("Q&A constraints", () => {
  const ITEM = "66666666-0000-4000-8000-000000000002";

  beforeEach(async () => {
    await seedLegacy();
    await db.exec(MIGRATION);
    await newItem(ITEM);
  });

  it("requires a visibility rule to name a user or a role, never both", async () => {
    await expect(
      db.exec(
        `INSERT INTO qa_item_visibility (item_id, user_id, role_key) VALUES ('${ITEM}', '${USER}', 'buyer');`,
      ),
    ).rejects.toThrow(/qa_item_visibility_subject/);
  });

  it("requires a visibility rule to name at least one subject", async () => {
    await expect(
      db.exec(`INSERT INTO qa_item_visibility (item_id) VALUES ('${ITEM}');`),
    ).rejects.toThrow(/qa_item_visibility_subject/);
  });

  it("rejects an unknown item status rather than storing it", async () => {
    await expect(
      db.exec(`UPDATE qa_items SET status = 'nonsense' WHERE id = '${ITEM}';`),
    ).rejects.toThrow(/status/);
  });

  it("rejects an unknown source of origin", async () => {
    await expect(
      db.exec(`UPDATE qa_items SET origin = 'somewhere_else' WHERE id = '${ITEM}';`),
    ).rejects.toThrow(/origin/);
  });

  it("defaults an untagged item to Unclassified rather than null", async () => {
    const { rows } = await db.query<{ module_tag: string }>(
      `SELECT module_tag FROM qa_items WHERE id = '${ITEM}'`,
    );
    expect(rows[0].module_tag).toBe("Unclassified");
  });

  it("nominates a user for a category at most once", async () => {
    const cat = await db.query<{ id: string }>(
      `SELECT id FROM qa_categories WHERE company_id = '${CO}' AND key = 'finance'`,
    );
    const catId = cat.rows[0].id;
    await db.exec(
      `INSERT INTO qa_nominations (company_id, category_id, user_id) VALUES ('${CO}', '${catId}', '${USER}');`,
    );

    await expect(
      db.exec(
        `INSERT INTO qa_nominations (company_id, category_id, user_id) VALUES ('${CO}', '${catId}', '${USER}');`,
      ),
    ).rejects.toThrow();
  });
});

describe("data room constraints", () => {
  beforeEach(async () => {
    await seedLegacy();
    await db.exec(MIGRATION);
  });

  it("refuses two versions with the same number on one document", async () => {
    await expect(
      db.exec(`
        INSERT INTO document_versions (document_id, version_no, file_name)
        VALUES ('${DOC}', 1, 'collides.pdf');
      `),
    ).rejects.toThrow();
  });

  it("rejects a comment visibility outside internal and shared", async () => {
    await expect(
      db.exec(`
        INSERT INTO document_comments (document_id, company_id, body, visibility, author_id)
        VALUES ('${DOC}', '${CO}', 'hi', 'public', '${USER}');
      `),
    ).rejects.toThrow(/visibility/);
  });

  it("defaults a comment to internal — the safer of the two", async () => {
    await db.exec(`
      INSERT INTO document_comments (document_id, company_id, body, author_id)
      VALUES ('${DOC}', '${CO}', 'hi', '${USER}');
    `);

    const { rows } = await db.query<{ visibility: string }>(
      `SELECT visibility FROM document_comments WHERE document_id = '${DOC}'`,
    );
    expect(rows[0].visibility).toBe("internal");
  });

  it("keeps one chunk per index per session, so a re-send upserts", async () => {
    const session = await db.query<{ id: string }>(`
      INSERT INTO upload_sessions (company_id, folder_id, file_name, content_type, total_bytes, chunk_size, total_chunks)
      VALUES ('${CO}', '${FOLDER}', 'big.bin', 'application/octet-stream', 10, 5, 2)
      RETURNING id;
    `);
    const sid = session.rows[0].id;
    await db.exec(
      `INSERT INTO upload_chunks (session_id, chunk_index, size_bytes, data) VALUES ('${sid}', 0, 5, '\\x0102030405'::bytea);`,
    );

    await db.exec(`
      INSERT INTO upload_chunks (session_id, chunk_index, size_bytes, data)
      VALUES ('${sid}', 0, 5, '\\x0605040302'::bytea)
      ON CONFLICT (session_id, chunk_index) DO UPDATE SET data = EXCLUDED.data;
    `);

    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM upload_chunks WHERE session_id = '${sid}'`,
    );
    expect(rows[0].n).toBe(1);
  });

  it("assembles chunks in index order, which is how a session completes", async () => {
    const session = await db.query<{ id: string }>(`
      INSERT INTO upload_sessions (company_id, folder_id, file_name, content_type, total_bytes, chunk_size, total_chunks)
      VALUES ('${CO}', '${FOLDER}', 'big.bin', 'application/octet-stream', 6, 3, 2)
      RETURNING id;
    `);
    const sid = session.rows[0].id;
    // Deliberately inserted out of order: assembly must order by index, not arrival.
    await db.exec(`
      INSERT INTO upload_chunks (session_id, chunk_index, size_bytes, data) VALUES ('${sid}', 1, 3, '\\x040506'::bytea);
      INSERT INTO upload_chunks (session_id, chunk_index, size_bytes, data) VALUES ('${sid}', 0, 3, '\\x010203'::bytea);
    `);

    const { rows } = await db.query<{ assembled: string }>(
      `SELECT encode(string_agg(data, ''::bytea ORDER BY chunk_index), 'hex') AS assembled
       FROM upload_chunks WHERE session_id = '${sid}'`,
    );
    expect(rows[0].assembled).toBe("010203040506");
  });

  it("discards chunks when its session goes", async () => {
    const session = await db.query<{ id: string }>(`
      INSERT INTO upload_sessions (company_id, folder_id, file_name, content_type, total_bytes, chunk_size, total_chunks)
      VALUES ('${CO}', '${FOLDER}', 'big.bin', 'application/octet-stream', 3, 3, 1)
      RETURNING id;
    `);
    const sid = session.rows[0].id;
    await db.exec(
      `INSERT INTO upload_chunks (session_id, chunk_index, size_bytes, data) VALUES ('${sid}', 0, 3, '\\x010203'::bytea);`,
    );

    await db.exec(`DELETE FROM upload_sessions WHERE id = '${sid}';`);

    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM upload_chunks WHERE session_id = '${sid}'`,
    );
    expect(rows[0].n).toBe(0);
  });
});
