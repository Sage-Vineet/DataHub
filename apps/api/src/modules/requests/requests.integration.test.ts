import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { schema, type Db } from "@datahub/db";
import type { SessionUser } from "@datahub/contracts";
import { createRequestsModule } from "./index.js";

const DDL = `
CREATE TYPE company_status AS ENUM ('active','inactive');
CREATE TYPE request_category AS ENUM ('Finance','Legal','Compliance','HR','Tax','M&A','Other');
CREATE TYPE response_type AS ENUM ('Upload','Narrative','Both');
CREATE TYPE request_priority AS ENUM ('critical','high','medium','low');
CREATE TYPE request_status AS ENUM ('pending','in-review','completed','blocked');
CREATE TABLE companies (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, project_name text, industry text,
  status company_status NOT NULL DEFAULT 'active', since date, logo text, contact_name text, contact_email text, contact_phone text,
  profit_metric text NOT NULL DEFAULT 'adjusted_ebitda', data_source_type text, quickbooks_connected boolean NOT NULL DEFAULT false,
  manual_upload_active boolean NOT NULL DEFAULT false, last_source_switch_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE requests (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title text NOT NULL, sub_label text, description text NOT NULL, category request_category NOT NULL, response_type response_type NOT NULL,
  priority request_priority NOT NULL, status request_status NOT NULL, due_date date NOT NULL, assigned_to uuid,
  visible boolean NOT NULL DEFAULT true, reminder_frequency_days integer NOT NULL DEFAULT 7, submission_source text NOT NULL DEFAULT 'broker',
  -- text in the deployed schema, not an enum: the database accepts any string
  -- here, so the service is the only thing narrowing it.
  approval_status text NOT NULL DEFAULT 'approved', approved_by uuid, approved_at timestamptz, created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE request_reminders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), request_id uuid NOT NULL REFERENCES requests(id) ON DELETE CASCADE, sent_by uuid NOT NULL, sent_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE request_narratives (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), request_id uuid NOT NULL UNIQUE REFERENCES requests(id) ON DELETE CASCADE, content text NOT NULL, updated_by uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE documents (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
CREATE TABLE request_documents (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), request_id uuid NOT NULL REFERENCES requests(id) ON DELETE CASCADE, document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE, visible boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now());
`;

const BROKER: SessionUser = { id: "11111111-1111-1111-1111-111111111111", name: "B", email: "b@x.com", role: "broker", company_id: null, status: "active", company_ids: [] };
const base = { title: "Send Q1", description: "please", category: "Finance", response_type: "Upload", priority: "medium", due_date: "2099-12-31" };

let client: PGlite;
let db: Db;
let app: express.Express;
let current: SessionUser;
let companyId: string;

beforeEach(async () => {
  client = new PGlite();
  await client.exec(DDL);
  db = drizzle(client, { schema }) as unknown as Db;
  companyId = randomUUID();
  await db.insert(schema.companies).values({ id: companyId, name: "Acme" });
  current = { ...BROKER, company_ids: [companyId] };
  const requireAuth = (req: Request, _res: Response, next: NextFunction) => { req.user = current; next(); };
  app = express();
  app.use("/", createRequestsModule({ db, requireAuth }).router);
});
afterEach(async () => { await client.close(); });

describe("requests router — CRUD + sub-resources (real Postgres)", () => {
  it("creates (single + bulk), reads, updates, approves, and deletes with cascade", async () => {
    const created = await request(app).post(`/companies/${companyId}/requests`).send(base);
    expect(created.status).toBe(201);
    expect(created.body.reminder_frequency_days).toBe(2); // medium → 2
    const id = created.body.id;

    await request(app).post(`/companies/${companyId}/requests/bulk`).send({ items: [base, { ...base, title: "Second" }] }).expect(201);
    expect((await request(app).get(`/companies/${companyId}/requests`)).body.length).toBe(3);

    await request(app).patch(`/requests/${id}`).send({ status: "in-review", priority: "low" }).expect(200);
    expect((await request(app).get(`/requests/${id}`)).body.reminder_frequency_days).toBe(7);

    await request(app).post(`/requests/${id}/approve`).send({}).expect(200);

    // Narrative (1:1 upsert), reminder, document link.
    await request(app).patch(`/requests/${id}/narrative`).send({ content: "final" }).expect(200);
    expect((await request(app).get(`/requests/${id}/narrative`)).body.content).toBe("final");
    await request(app).post(`/requests/${id}/reminders`).expect(201);
    const docId = randomUUID();
    await db.execute(sql`INSERT INTO documents (id) VALUES (${docId})`);
    await request(app).post(`/requests/${id}/documents`).send({ document_id: docId }).expect(201);
    expect((await request(app).get(`/requests/${id}/documents`)).body.length).toBe(1);

    // Delete cascades reminders/narrative/document links.
    await request(app).delete(`/requests/${id}`).expect(204);
    expect((await db.select().from(schema.requestReminders)).length).toBe(0);
    expect((await db.select().from(schema.requestNarratives)).length).toBe(0);
    expect((await db.select().from(schema.requestDocuments)).length).toBe(0);
  });

  it("400s a malformed create and blocks cross-tenant (403)", async () => {
    expect((await request(app).post(`/companies/${companyId}/requests`).send({ title: "x" })).status).toBe(400);
    current = { ...BROKER, role: "buyer", company_ids: [randomUUID()] };
    expect((await request(app).get(`/companies/${companyId}/requests`)).status).toBe(403);
  });
});
