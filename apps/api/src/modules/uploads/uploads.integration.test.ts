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
CREATE TYPE document_status AS ENUM ('active','processing','error');
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
CREATE TABLE uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), file_name text NOT NULL, content_type text NOT NULL,
  size_bytes integer NOT NULL, data bytea NOT NULL, prefix text, uploaded_by uuid, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  folder_id uuid NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  name text NOT NULL, file_url text, upload_id uuid REFERENCES uploads(id) ON DELETE SET NULL,
  size text NOT NULL, ext text NOT NULL, status document_status NOT NULL DEFAULT 'active',
  uploaded_by uuid NOT NULL, uploaded_at timestamptz NOT NULL DEFAULT now(), archived_at timestamptz
);
CREATE TABLE document_activity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  actor_id uuid, action text NOT NULL, at timestamptz NOT NULL DEFAULT now()
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
  it("adds a document, lists it, archives, deletes, and cascades activity", async () => {
    const up = (await request(app).post("/uploads").set("Content-Type", "application/pdf").set("x-file-name", "q1.pdf").send(Buffer.from("pdf"))).body;
    const doc = (await request(app).post(`/folders/${folderId}/documents`).send({ name: "Q1.pdf", upload_id: up.id, size: "3", ext: "pdf" })).body;
    expect(doc.company_id).toBeTruthy();

    const list = await request(app).get(`/folders/${folderId}/documents`);
    expect(list.body.map((d: { id: string }) => d.id)).toEqual([doc.id]);

    // Activity append + read.
    await request(app).post(`/documents/${doc.id}/activity`).send({ action: "downloaded" }).expect(201);
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

  it("400s a malformed document create and blocks cross-tenant access (403)", async () => {
    expect((await request(app).post(`/folders/${folderId}/documents`).send({ name: "x" })).status).toBe(400);
    current = { ...BROKER, role: "buyer", company_ids: [randomUUID()] };
    expect((await request(app).get(`/folders/${folderId}/documents`)).status).toBe(403);
  });
});
