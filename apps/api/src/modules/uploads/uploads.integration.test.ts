import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { schema, type Db } from "@datahub/db";
import type { SessionUser } from "@datahub/contracts";
import { createUploadsModule } from "./index.js";

const DDL = `
CREATE TYPE company_status AS ENUM ('active','inactive');
-- The DEPLOYED vocabulary. packages/db declares active|processing|error
-- instead, which shares no value with it (design D4a).
CREATE TYPE document_status AS ENUM ('verified','under-review','rejected');
CREATE TABLE companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, project_name text, industry text,
  status company_status NOT NULL DEFAULT 'active', since date, logo text,
  contact_name text, contact_email text, contact_phone text,
  profit_metric text NOT NULL DEFAULT 'adjusted_ebitda', data_source_type text,
  quickbooks_connected boolean NOT NULL DEFAULT false, manual_upload_active boolean NOT NULL DEFAULT false,
  last_source_switch_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE folders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, parent_id uuid,
  name text NOT NULL, color text, created_by uuid NOT NULL, archived_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE buyer_groups (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL);
CREATE TABLE buyer_group_members (
  group_id uuid NOT NULL, user_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE folder_access (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  folder_id uuid NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  user_id uuid, group_id uuid,
  can_read boolean NOT NULL DEFAULT true,
  can_write boolean NOT NULL DEFAULT false,
  can_download boolean NOT NULL DEFAULT false,
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT folder_access_subject CHECK (
    (user_id IS NOT NULL AND group_id IS NULL) OR (user_id IS NULL AND group_id IS NOT NULL))
);
CREATE TABLE uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), file_name text NOT NULL, content_type text NOT NULL,
  size_bytes integer NOT NULL, data bytea NOT NULL, prefix text, uploaded_by uuid, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  folder_id uuid NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  -- file_url and status are both NOT NULL with NO default in the deployed
  -- schema. Declaring file_url nullable and defaulting status is what let an
  -- insert that can never succeed in production pass here.
  name text NOT NULL, file_url text NOT NULL, upload_id uuid REFERENCES uploads(id) ON DELETE SET NULL,
  size text NOT NULL, ext text NOT NULL, status document_status NOT NULL,
  uploaded_by uuid NOT NULL, uploaded_at timestamptz NOT NULL DEFAULT now(), archived_at timestamptz,
  -- Versioning columns (migration 0003). Declared here because packages/db models
  -- them, so every Drizzle read of documents selects them.
  current_version_id uuid, version_count integer NOT NULL DEFAULT 1
);
-- Modelled on the DEPLOYED table, which carries two generations of columns:
-- legacy's user_id + activity_type (NOT NULL) and this module's actor_id +
-- action + at. Declaring only the module's half is what let a write that can
-- never succeed in production pass here for months.
CREATE TYPE document_activity_type AS ENUM ('view','download');
CREATE TABLE document_activity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  activity_type document_activity_type NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  actor_id uuid, action text, at timestamptz DEFAULT now()
);
`;

const BROKER: SessionUser = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "Broker",
  email: "broker@example.com",
  role: "broker",
  company_id: null,
  status: "active",
  company_ids: [],
};

/** Collect a binary response body into a Buffer. */
function binaryParser(res: Request, cb: (err: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  (res as unknown as NodeJS.EventEmitter).on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
  (res as unknown as NodeJS.EventEmitter).on("end", () => cb(null, Buffer.concat(chunks)));
}

let client: PGlite;
let db: Db;
let app: express.Express;
let current: SessionUser;
let folderId: string;

beforeEach(async () => {
  client = new PGlite();
  await client.exec(DDL);
  db = drizzle(client, { schema }) as unknown as Db;
  const companyId = randomUUID();
  await db.insert(schema.companies).values({ id: companyId, name: "Acme" });
  folderId = randomUUID();
  await db.insert(schema.folders).values({ id: folderId, companyId, name: "Finance", createdBy: BROKER.id });
  current = { ...BROKER, company_ids: [companyId] };

  const requireAuth = (req: Request, _res: Response, next: NextFunction) => {
    req.user = current;
    next();
  };
  app = express();
  app.use("/", createUploadsModule({ db, requireAuth }).router);
});

afterEach(async () => {
  await client.close();
});

describe("uploads router — blob round-trip through bytea (real Postgres)", () => {
  it("stores raw bytes and streams the identical bytes + content-type back", async () => {
    const payload = Buffer.from([0, 1, 2, 3, 255, 254, 100, 42]);
    const up = await request(app)
      .post("/uploads")
      .set("Content-Type", "application/octet-stream")
      .set("x-file-name", "blob.bin")
      .send(payload);
    expect(up.status).toBe(201);
    expect(up.body.size_bytes).toBe(payload.length);

    const got = await request(app).get(`/uploads/${up.body.id}/content`).buffer(true).parse(binaryParser);
    expect(got.status).toBe(200);
    expect(got.headers["content-type"]).toContain("application/octet-stream");
    expect(Buffer.compare(got.body, payload)).toBe(0);

    // The bytes really live in the uploads table.
    expect((await db.select().from(schema.uploads)).length).toBe(1);
  });

  it("404s content for an unknown upload id", async () => {
    expect((await request(app).get(`/uploads/${randomUUID()}/content`)).status).toBe(404);
  });
});

describe("uploads router — documents under a folder (real Postgres)", () => {
  /** A document in the beforeEach folder, via the real upload → document path. */
  async function seedDocument(): Promise<string> {
    const up = (await request(app).post("/uploads")
      .set("Content-Type", "application/pdf").set("x-file-name", "lease.pdf")
      .send(Buffer.from("pdf"))).body;
    const doc = await request(app).post(`/folders/${folderId}/documents`)
      .send({ name: "Lease.pdf", upload_id: up.id, size: "3", ext: "pdf" });
    expect(doc.status).toBe(201);
    return doc.body.id as string;
  }

  it("records an activity row both engines can read", async () => {
    // The regression this file exists to prevent from recurring: writing only
    // the module's columns leaves legacy's NOT NULL ones empty, and every
    // POST /documents/:id/activity 500s while the GET keeps returning a
    // healthy-looking empty list.
    const documentId = await seedDocument();

    await request(app).post(`/documents/${documentId}/activity`).send({ action: "view" }).expect(201);

    const listed = await request(app).get(`/documents/${documentId}/activity`);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0]).toMatchObject({ action: "view", document_id: documentId });

    // Legacy reads its own columns off the same row. One row, both vocabularies.
    const legacyView = await client.query<{ user_id: string; activity_type: string }>(
      `SELECT user_id, activity_type FROM document_activity WHERE document_id = $1`,
      [documentId],
    );
    expect(legacyView.rows[0]).toMatchObject({ activity_type: "view", user_id: BROKER.id });
  });

  it("refuses an action the deployed enum cannot store, at the edge", async () => {
    const documentId = await seedDocument();

    const res = await request(app)
      .post(`/documents/${documentId}/activity`)
      .send({ action: "printed" });

    expect(res.status).toBe(400); // not a 500 from the database
  });

  it("adds a document, lists it, archives, deletes, and cascades activity", async () => {
    const up = (await request(app).post("/uploads").set("Content-Type", "application/pdf").set("x-file-name", "q1.pdf").send(Buffer.from("pdf"))).body;
    const doc = (await request(app).post(`/folders/${folderId}/documents`).send({ name: "Q1.pdf", upload_id: up.id, size: "3", ext: "pdf" })).body;
    expect(doc.company_id).toBeTruthy();

    const list = await request(app).get(`/folders/${folderId}/documents`);
    expect(list.body.map((d: { id: string }) => d.id)).toEqual([doc.id]);

    // Activity append + read.
    await request(app).post(`/documents/${doc.id}/activity`).send({ action: "download" }).expect(201);
    expect((await request(app).get(`/documents/${doc.id}/activity`)).body.length).toBe(1);

    // Archive → excluded from default list; still visible with include_archived.
    await request(app).post(`/documents/${doc.id}/archive`).expect(200);
    expect((await request(app).get(`/folders/${folderId}/documents`)).body.length).toBe(0);
    expect((await request(app).get(`/folders/${folderId}/documents?include_archived=true`)).body.length).toBe(1);

    // Delete → gone, and activity cascaded.
    await request(app).delete(`/documents/${doc.id}`).expect(204);
    expect((await db.select().from(schema.documents)).length).toBe(0);
    expect((await db.select().from(schema.documentActivity)).length).toBe(0);
  });

  describe("folder grants are enforced on the server", () => {
    const BUYER: SessionUser = { ...BROKER, id: randomUUID(), role: "buyer" };

    /** The buyer, in whatever company beforeEach just created. */
    const asBuyer = (): SessionUser => ({
      ...BUYER,
      company_id: current.company_id,
      company_ids: current.company_ids,
    });

    async function grantTo(folder: string, subject: { user?: string; group?: string }, perms = {}) {
      const p = { read: true, write: false, download: false, ...perms };
      await client.query(
        `INSERT INTO folder_access (folder_id, user_id, group_id, can_read, can_write, can_download)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [folder, subject.user ?? null, subject.group ?? null, p.read, p.write, p.download],
      );
    }

    it("leaves an ungranted folder open, exactly as before", async () => {
      // Every folder in the product is ungranted. Denying here would empty the
      // data room on the first deploy rather than tighten an existing rule.
      await seedDocument();
      current = asBuyer();

      expect((await request(app).get(`/folders/${folderId}/documents`)).status).toBe(200);
    });

    it("shuts out a buyer nobody granted, once the folder is configured", async () => {
      // The defect: this returned 200 with the full document list, because the
      // guard only ever checked company membership.
      await seedDocument();
      await grantTo(folderId, { user: randomUUID() });
      current = asBuyer();

      expect((await request(app).get(`/folders/${folderId}/documents`)).status).toBe(403);
    });

    it("lets a granted buyer in", async () => {
      await seedDocument();
      await grantTo(folderId, { user: BUYER.id });
      current = asBuyer();

      expect((await request(app).get(`/folders/${folderId}/documents`)).status).toBe(200);
    });

    it("reaches a buyer through a group", async () => {
      await seedDocument();
      const group = randomUUID();
      await client.query(`INSERT INTO buyer_groups (id, name) VALUES ($1,'Bidder A')`, [group]);
      await client.query(
        `INSERT INTO buyer_group_members (group_id, user_id) VALUES ($1,$2)`,
        [group, BUYER.id],
      );
      await grantTo(folderId, { group });
      current = asBuyer();

      expect((await request(app).get(`/folders/${folderId}/documents`)).status).toBe(200);
    });

    it("separates read from write", async () => {
      // The whole point of three capabilities: a buyer who may look at a folder
      // is not thereby allowed to put things in it.
      const up = (await request(app).post("/uploads").set("Content-Type", "application/pdf")
        .set("x-file-name", "x.pdf").send(Buffer.from("pdf"))).body;
      await grantTo(folderId, { user: BUYER.id }, { read: true, write: false });
      current = asBuyer();

      expect((await request(app).get(`/folders/${folderId}/documents`)).status).toBe(200);
      const created = await request(app).post(`/folders/${folderId}/documents`)
        .send({ name: "Sneaky.pdf", upload_id: up.id, size: "3", ext: "pdf" });
      expect(created.status).toBe(403);
    });

    it("does not let a restricted folder be walked around by addressing the document", async () => {
      const documentId = await seedDocument();
      await grantTo(folderId, { user: randomUUID() });
      current = asBuyer();

      expect((await request(app).get(`/documents/${documentId}/activity`)).status).toBe(403);
    });

    it("never gates the broker who owns the room", async () => {
      await seedDocument();
      await grantTo(folderId, { user: randomUUID() });

      expect((await request(app).get(`/folders/${folderId}/documents`)).status).toBe(200);
    });
  });

  it("400s a malformed document create and blocks cross-tenant access (403)", async () => {
    expect((await request(app).post(`/folders/${folderId}/documents`).send({ name: "x" })).status).toBe(400);
    current = { ...BROKER, role: "buyer", company_ids: [randomUUID()] };
    expect((await request(app).get(`/folders/${folderId}/documents`)).status).toBe(403);
  });
});
