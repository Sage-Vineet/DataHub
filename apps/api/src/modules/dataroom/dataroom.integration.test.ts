import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { schema, type Db } from "@datahub/db";
import type { SessionUser } from "@datahub/contracts";
import { MIN_CHUNK_BYTES } from "@datahub/contracts";
import { createDataRoomModule } from "./index.js";

/**
 * The data room capabilities against real Postgres.
 *
 * The point of running these on PGlite rather than in-memory is the SQL that
 * cannot be modelled by a fake: `string_agg(data, '' ORDER BY chunk_index)`
 * assembling a file in the database, the upsert that makes a re-sent chunk
 * idempotent, and the unique index that stops two versions claiming one number.
 *
 * DDL is hand-written per file, following the convention the other integration
 * tests use — `packages/db/migrations/0001` presupposes the legacy schema and
 * cannot be fed to PGlite.
 */
const DDL = `
CREATE TYPE company_status AS ENUM ('active','inactive');
-- The enum the deployed database actually has. packages/db declares
-- ('active','processing','error') instead, which shares no value with it — a
-- drift that is real and is why document inserts here use explicit SQL.
CREATE TYPE document_status AS ENUM ('verified','under-review','rejected');
CREATE TYPE user_role AS ENUM ('admin','broker','buyer');
CREATE TYPE user_status AS ENUM ('active','inactive');
CREATE TABLE companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, project_name text, industry text,
  status company_status NOT NULL DEFAULT 'active', since date, logo text,
  contact_name text, contact_email text, contact_phone text,
  profit_metric text NOT NULL DEFAULT 'adjusted_ebitda', data_source_type text,
  quickbooks_connected boolean NOT NULL DEFAULT false, manual_upload_active boolean NOT NULL DEFAULT false,
  last_source_switch_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, email text NOT NULL UNIQUE,
  phone text, password_hash text NOT NULL, role user_role NOT NULL, company_id uuid,
  status user_status NOT NULL DEFAULT 'active',
  sub_role text, designation text, buyer_company_name text, parent_user_id uuid,
  date_of_birth date, occupation text, address text, broker_company text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE folders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE, parent_id uuid,
  name text NOT NULL, color text, created_by uuid NOT NULL, archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), file_name text NOT NULL, content_type text NOT NULL,
  size_bytes integer NOT NULL, data bytea NOT NULL, prefix text, uploaded_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  folder_id uuid NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  name text NOT NULL, file_url text, upload_id uuid REFERENCES uploads(id) ON DELETE SET NULL,
  size text NOT NULL, ext text NOT NULL, status document_status NOT NULL DEFAULT 'under-review',
  uploaded_by uuid NOT NULL, uploaded_at timestamptz NOT NULL DEFAULT now(), archived_at timestamptz,
  current_version_id uuid, version_count integer NOT NULL DEFAULT 1
);
CREATE TABLE document_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version_no integer NOT NULL,
  upload_id uuid REFERENCES uploads(id) ON DELETE SET NULL,
  file_name text NOT NULL, size_bytes bigint NOT NULL DEFAULT 0, content_type text, note text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, version_no)
);
CREATE TABLE document_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  version_id uuid REFERENCES document_versions(id) ON DELETE SET NULL,
  parent_id uuid REFERENCES document_comments(id) ON DELETE CASCADE,
  body text NOT NULL,
  visibility text NOT NULL DEFAULT 'internal' CHECK (visibility IN ('internal','shared')),
  page_number integer,
  author_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
);
CREATE TABLE upload_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES companies(id) ON DELETE CASCADE,
  folder_id uuid REFERENCES folders(id) ON DELETE CASCADE,
  document_id uuid REFERENCES documents(id) ON DELETE CASCADE,
  file_name text NOT NULL, content_type text NOT NULL, total_bytes bigint NOT NULL,
  chunk_size integer NOT NULL, total_chunks integer NOT NULL, received_count integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed','aborted')),
  upload_id uuid REFERENCES uploads(id) ON DELETE SET NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '6 hours'
);
CREATE TABLE buyer_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE, name text NOT NULL
);
CREATE TABLE buyer_group_members (
  group_id uuid NOT NULL REFERENCES buyer_groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, user_id)
);
CREATE TABLE folder_access (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  folder_id uuid NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  group_id uuid REFERENCES buyer_groups(id) ON DELETE CASCADE,
  can_read boolean NOT NULL DEFAULT true,
  can_write boolean NOT NULL DEFAULT false,
  can_download boolean NOT NULL DEFAULT false,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE upload_chunks (
  session_id uuid NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL, size_bytes integer NOT NULL, data bytea NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, chunk_index)
);
`;

const BROKER_ID = "11111111-1111-4111-8111-111111111111";
const SELLER_ID = "22222222-2222-4222-8222-222222222222";

function binaryParser(res: Request, cb: (err: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  (res as unknown as NodeJS.EventEmitter).on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
  (res as unknown as NodeJS.EventEmitter).on("end", () => cb(null, Buffer.concat(chunks)));
}

let client: PGlite;
let db: Db;
let app: express.Express;
let current: SessionUser;
let companyId: string;
let folderId: string;
let broker: SessionUser;
let seller: SessionUser;

/**
 * Chunk size the contract allows.
 *
 * `MIN_CHUNK_BYTES` is 1 MB, so a file smaller than that is always exactly one
 * chunk. Multi-chunk tests therefore work in real megabytes rather than three
 * letters — which is the honest thing to exercise anyway, since the whole point
 * of the SQL assembly is that it holds at sizes Node should never buffer.
 */
const CHUNK = MIN_CHUNK_BYTES;

/** A megabyte of one byte value, so a boundary mix-up is visible at a glance. */
const megabyteOf = (char: string, size = CHUNK) => Buffer.alloc(size, char.charCodeAt(0));

/** Drive a full chunked upload the way a client would. */
async function upload(fileName: string, parts: Buffer[], documentId?: string) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const open = await request(app)
    .post("/dataroom/uploads/sessions")
    .send({
      folder_id: folderId,
      file_name: fileName,
      content_type: "text/plain",
      total_bytes: total,
      chunk_size: CHUNK,
      ...(documentId ? { document_id: documentId } : {}),
    });
  expect(open.status).toBe(201);
  for (const [i, part] of parts.entries()) {
    const put = await request(app)
      .put(`/dataroom/uploads/sessions/${open.body.id}/chunks/${i}`)
      .set("Content-Type", "application/octet-stream")
      .send(part);
    expect(put.status).toBe(200);
  }
  const done = await request(app).post(`/dataroom/uploads/sessions/${open.body.id}/complete`);
  expect(done.status).toBe(201);
  return { session: open.body, result: done.body };
}

beforeEach(async () => {
  client = new PGlite();
  await client.exec(DDL);
  db = drizzle(client, { schema }) as unknown as Db;

  companyId = randomUUID();
  await db.insert(schema.companies).values({ id: companyId, name: "Acme" });
  await db.insert(schema.users).values([
    { id: BROKER_ID, name: "Blake Broker", email: "broker@x.test", passwordHash: "x", role: "broker", companyId },
    { id: SELLER_ID, name: "Dana Seller", email: "seller@x.test", passwordHash: "x", role: "buyer", companyId },
  ]);
  folderId = randomUUID();
  await db
    .insert(schema.folders)
    .values({ id: folderId, companyId, name: "Finance", createdBy: BROKER_ID });

  broker = {
    id: BROKER_ID,
    name: "Blake Broker",
    email: "broker@x.test",
    role: "broker",
    company_id: companyId,
    status: "active",
    company_ids: [companyId],
  };
  seller = { ...broker, id: SELLER_ID, name: "Dana Seller", role: "buyer" };
  current = broker;

  const requireAuth = (req: Request, _res: Response, next: NextFunction) => {
    req.user = current;
    next();
  };
  app = express();
  app.use("/", createDataRoomModule({ db, requireAuth }).router);
});

afterEach(async () => {
  await client.close();
});

describe("chunked upload assembles in the database (real Postgres)", () => {
  it("reassembles a multi-megabyte file byte-for-byte", async () => {
    const parts = [megabyteOf("A"), megabyteOf("B"), megabyteOf("C", 512)];

    const { result } = await upload("notes.bin", parts);

    const rows = await db
      .select({ data: schema.uploads.data, sizeBytes: schema.uploads.sizeBytes })
      .from(schema.uploads)
      .where(eq(schema.uploads.id, result.upload_id));
    const stored = Buffer.from(rows[0]!.data);
    expect(rows[0]!.sizeBytes).toBe(CHUNK * 2 + 512);
    expect(Buffer.compare(stored, Buffer.concat(parts))).toBe(0);
  });

  it("orders by chunk index, not by the order chunks arrived", async () => {
    const open = await request(app).post("/dataroom/uploads/sessions").send({
      folder_id: folderId,
      file_name: "ordered.bin",
      content_type: "application/octet-stream",
      total_bytes: CHUNK * 3,
      chunk_size: CHUNK,
    });
    // Sent last-first — a client with several chunks in flight does exactly this.
    for (const [index, char] of [
      [2, "C"],
      [0, "A"],
      [1, "B"],
    ] as const) {
      await request(app)
        .put(`/dataroom/uploads/sessions/${open.body.id}/chunks/${index}`)
        .set("Content-Type", "application/octet-stream")
        .send(megabyteOf(char));
    }

    const done = await request(app).post(`/dataroom/uploads/sessions/${open.body.id}/complete`);

    const content = await request(app)
      .get(`/dataroom/versions/${done.body.version_id}/content`)
      .buffer(true)
      .parse(binaryParser);
    // Sampling each chunk's first byte pins the order precisely.
    expect(content.body.length).toBe(CHUNK * 3);
    expect(String.fromCharCode(content.body[0]!)).toBe("A");
    expect(String.fromCharCode(content.body[CHUNK]!)).toBe("B");
    expect(String.fromCharCode(content.body[CHUNK * 2]!)).toBe("C");
  });

  it("treats a re-sent chunk as a replacement in the database", async () => {
    const open = await request(app).post("/dataroom/uploads/sessions").send({
      folder_id: folderId,
      file_name: "retry.txt",
      content_type: "text/plain",
      total_bytes: 3,
      chunk_size: CHUNK,
    });
    await request(app)
      .put(`/dataroom/uploads/sessions/${open.body.id}/chunks/0`)
      .set("Content-Type", "application/octet-stream")
      .send(Buffer.from("BAD"));

    const retry = await request(app)
      .put(`/dataroom/uploads/sessions/${open.body.id}/chunks/0`)
      .set("Content-Type", "application/octet-stream")
      .send(Buffer.from("OK!"));

    expect(retry.body.received).toEqual([0]);
    const done = await request(app).post(`/dataroom/uploads/sessions/${open.body.id}/complete`);
    const content = await request(app)
      .get(`/dataroom/versions/${done.body.version_id}/content`)
      .buffer(true)
      .parse(binaryParser);
    expect(content.body.toString()).toBe("OK!");
  });

  it("discards chunk rows once the session completes", async () => {
    const { session } = await upload("clean.txt", [Buffer.from("abc")]);

    const rows = await db
      .select()
      .from(schema.uploadChunks)
      .where(eq(schema.uploadChunks.sessionId, session.id));
    expect(rows).toHaveLength(0);
  });

  it("refuses to complete a session with a missing chunk", async () => {
    const open = await request(app).post("/dataroom/uploads/sessions").send({
      folder_id: folderId,
      file_name: "partial.bin",
      content_type: "application/octet-stream",
      total_bytes: CHUNK * 3,
      chunk_size: CHUNK,
    });
    await request(app)
      .put(`/dataroom/uploads/sessions/${open.body.id}/chunks/0`)
      .set("Content-Type", "application/octet-stream")
      .send(megabyteOf("A"));

    const done = await request(app).post(`/dataroom/uploads/sessions/${open.body.id}/complete`);

    expect(done.status).toBe(400);
    expect(done.body.error).toMatch(/incomplete/i);
  });
});

describe("versioning through the database (real Postgres)", () => {
  it("makes a same-name re-upload version 2 of the same document", async () => {
    const first = await upload("model.xlsx", [Buffer.from("v1")]);

    const second = await upload("model.xlsx", [Buffer.from("v2")]);

    expect(second.result.document_id).toBe(first.result.document_id);
    expect(second.result.version_no).toBe(2);
  });

  it("serves each version's own bytes", async () => {
    const first = await upload("model.xlsx", [Buffer.from("ORIGINAL")]);
    await upload("model.xlsx", [Buffer.from("REPLACEMENT")]);

    const list = await request(app).get(
      `/dataroom/documents/${first.result.document_id}/versions`,
    );

    const v1 = list.body.versions.find((v: { version_no: number }) => v.version_no === 1);
    const v2 = list.body.versions.find((v: { version_no: number }) => v.version_no === 2);
    const got1 = await request(app)
      .get(`/dataroom/versions/${v1.id}/content`)
      .buffer(true)
      .parse(binaryParser);
    const got2 = await request(app)
      .get(`/dataroom/versions/${v2.id}/content`)
      .buffer(true)
      .parse(binaryParser);
    expect(got1.body.toString()).toBe("ORIGINAL");
    expect(got2.body.toString()).toBe("REPLACEMENT");
  });

  it("keeps the document pointing at the newest version", async () => {
    const first = await upload("model.xlsx", [Buffer.from("v1")]);
    const second = await upload("model.xlsx", [Buffer.from("v2")]);

    const rows = await db
      .select({
        currentVersionId: schema.documents.currentVersionId,
        versionCount: schema.documents.versionCount,
      })
      .from(schema.documents)
      .where(eq(schema.documents.id, first.result.document_id));

    expect(rows[0]).toEqual({
      currentVersionId: second.result.version_id,
      versionCount: 2,
    });
  });

  it("restores by appending a version that reuses the old blob", async () => {
    const first = await upload("model.xlsx", [Buffer.from("ORIGINAL")]);
    const list = await request(app).get(
      `/dataroom/documents/${first.result.document_id}/versions`,
    );
    const v1 = list.body.versions[0];
    await upload("model.xlsx", [Buffer.from("REPLACEMENT")]);

    const restored = await request(app)
      .post(`/dataroom/documents/${first.result.document_id}/versions/${v1.id}/restore`)
      .send({});

    expect(restored.status).toBe(201);
    expect(restored.body.version_no).toBe(3);
    expect(restored.body.upload_id).toBe(v1.upload_id);
    const content = await request(app)
      .get(`/dataroom/versions/${restored.body.id}/content`)
      .buffer(true)
      .parse(binaryParser);
    expect(content.body.toString()).toBe("ORIGINAL");
  });

  it("refuses two versions claiming the same number", async () => {
    const first = await upload("model.xlsx", [Buffer.from("v1")]);

    // The unique index is the backstop behind the transactional allocation.
    await expect(
      db.insert(schema.documentVersions).values({
        documentId: first.result.document_id,
        versionNo: 1,
        fileName: "collides.xlsx",
      }),
    ).rejects.toThrow();
  });
});

describe("comment visibility through the database (real Postgres)", () => {
  let documentId: string;

  beforeEach(async () => {
    documentId = (await upload("evidence.pdf", [Buffer.from("contents")])).result.document_id;
  });

  it("never returns an internal comment to a counterparty", async () => {
    await request(app)
      .post(`/dataroom/documents/${documentId}/comments`)
      .send({ body: "our side only", visibility: "internal" });
    await request(app)
      .post(`/dataroom/documents/${documentId}/comments`)
      .send({ body: "for both sides", visibility: "shared" });

    current = seller;
    const asSeller = await request(app).get(`/dataroom/documents/${documentId}/comments`);

    // Absent from the response, not hidden by the client.
    expect(asSeller.body.map((c: { body: string }) => c.body)).toEqual(["for both sides"]);
  });

  it("returns both to the deal side, attributed", async () => {
    await request(app)
      .post(`/dataroom/documents/${documentId}/comments`)
      .send({ body: "internal", visibility: "internal" });

    const asBroker = await request(app).get(`/dataroom/documents/${documentId}/comments`);

    expect(asBroker.body).toHaveLength(1);
    expect(asBroker.body[0].author_name).toBe("Blake Broker");
  });

  it("stops a counterparty posting an internal comment", async () => {
    current = seller;

    const res = await request(app)
      .post(`/dataroom/documents/${documentId}/comments`)
      .send({ body: "sneaky", visibility: "internal" });

    expect(res.status).toBe(403);
  });

  it("soft-deletes, so the row survives for the audit trail", async () => {
    const created = await request(app)
      .post(`/dataroom/documents/${documentId}/comments`)
      .send({ body: "temporary", visibility: "shared" });

    await request(app).delete(`/dataroom/comments/${created.body.id}`).expect(204);

    const listed = await request(app).get(`/dataroom/documents/${documentId}/comments`);
    expect(listed.body).toHaveLength(0);
    const rows = await db.select().from(schema.documentComments);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deletedAt).not.toBeNull();
  });
});

describe("tenant isolation (real Postgres)", () => {
  it("refuses a document belonging to another company", async () => {
    const { result } = await upload("private.txt", [Buffer.from("secret")]);
    current = { ...broker, company_id: randomUUID(), company_ids: [] };

    const res = await request(app).get(`/dataroom/documents/${result.document_id}/versions`);

    expect(res.status).toBe(403);
  });

  it("refuses to open a session against another company's folder", async () => {
    current = { ...broker, company_id: randomUUID(), company_ids: [] };

    const res = await request(app).post("/dataroom/uploads/sessions").send({
      folder_id: folderId,
      file_name: "x.txt",
      content_type: "text/plain",
      total_bytes: 3,
      chunk_size: 1024 * 1024,
    });

    expect(res.status).toBe(403);
  });
});

describe("folder grants, enforced on the server (real Postgres)", () => {
  it("refuses a counterparty a document in a folder they were not granted", async () => {
    // The grant table has always existed; only the browser honoured it. On the
    // endpoints this module adds, the server does too.
    const { result } = await upload("restricted.txt", [Buffer.from("private")]);
    await db.insert(schema.folderAccess).values({
      folderId,
      userId: BROKER_ID,
      canRead: true,
      canWrite: true,
      canDownload: true,
      createdBy: BROKER_ID,
    });

    current = seller;
    const res = await request(app).get(`/dataroom/documents/${result.document_id}/versions`);

    expect(res.status).toBe(403);
  });

  it("allows a counterparty who was granted read", async () => {
    const { result } = await upload("shared.txt", [Buffer.from("shared")]);
    await db.insert(schema.folderAccess).values({
      folderId,
      userId: SELLER_ID,
      canRead: true,
      canWrite: false,
      canDownload: true,
      createdBy: BROKER_ID,
    });

    current = seller;
    const res = await request(app).get(`/dataroom/documents/${result.document_id}/versions`);

    expect(res.status).toBe(200);
  });

  it("keeps the deal team unscoped inside a company they can already reach", async () => {
    // Tightening this would make the broker's own view go dark, which reads as
    // broken rather than as secure — and does not match what legacy does.
    const { result } = await upload("brokers.txt", [Buffer.from("x")]);
    await db.insert(schema.folderAccess).values({
      folderId,
      userId: SELLER_ID,
      canRead: true,
      createdBy: BROKER_ID,
    });

    const res = await request(app).get(`/dataroom/documents/${result.document_id}/versions`);

    expect(res.status).toBe(200);
  });

  it("inherits a parent folder's grant where the child has none", async () => {
    const child = randomUUID();
    await db.insert(schema.folders).values({
      id: child,
      companyId,
      parentId: folderId,
      name: "Tax Returns",
      createdBy: BROKER_ID,
    });
    await db.insert(schema.folderAccess).values({
      folderId,
      userId: SELLER_ID,
      canRead: true,
      createdBy: BROKER_ID,
    });
    const open = await request(app).post("/dataroom/uploads/sessions").send({
      folder_id: child,
      file_name: "nested.txt",
      content_type: "text/plain",
      total_bytes: 3,
      chunk_size: CHUNK,
    });
    await request(app)
      .put(`/dataroom/uploads/sessions/${open.body.id}/chunks/0`)
      .set("Content-Type", "application/octet-stream")
      .send(Buffer.from("abc"));
    const done = await request(app).post(`/dataroom/uploads/sessions/${open.body.id}/complete`);

    current = seller;
    const res = await request(app).get(`/dataroom/documents/${done.body.document_id}/versions`);

    // Without inheritance, granting the parent would grant nothing usable.
    expect(res.status).toBe(200);
  });

  it("leaves everything readable where no grant exists anywhere", async () => {
    // Grants narrow; they do not open. Defaulting to denial would lock people out
    // of folders they have used since before grants were enforced.
    const { result } = await upload("ungranted.txt", [Buffer.from("x")]);

    current = seller;
    const res = await request(app).get(`/dataroom/documents/${result.document_id}/versions`);

    expect(res.status).toBe(200);
  });
});

describe("disabled sub-features", () => {
  it("answers 404 rather than letting the request fall through to legacy", async () => {
    const disabled = express();
    disabled.use(
      "/",
      createDataRoomModule({
        db,
        requireAuth: (req: Request, _res: Response, next: NextFunction) => {
          req.user = broker;
          next();
        },
        features: { versions: false, comments: true, chunkedUpload: true },
      }).router,
    );

    const res = await request(disabled).get(`/dataroom/documents/${randomUUID()}/versions`);

    // Falling through would reach the catch-all proxy and hit legacy, which
    // serves nothing here — an explicit 404 is honest and terminal.
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not enabled/i);
  });
});
