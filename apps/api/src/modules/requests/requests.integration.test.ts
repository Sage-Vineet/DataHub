import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSchemaDb, schema, type Db } from "@datahub/db";
import type { SessionUser } from "@datahub/contracts";
import { createRequestsModule } from "./index.js";


const BROKER: SessionUser = { id: "11111111-1111-1111-1111-111111111111", name: "B", email: "b@x.com", role: "broker", company_id: null, status: "active", company_ids: [] };
const base = { title: "Send Q1", description: "please", category: "Finance", response_type: "Upload", priority: "medium", due_date: "2099-12-31" };

let client: PGlite;
let db: Db;
let app: express.Express;
let current: SessionUser;
let companyId: string;

beforeEach(async () => {
  client = await createSchemaDb();
  db = drizzle(client, { schema }) as unknown as Db;
  // The acting user needs a row: the deployed schema's foreign keys are real,
  // so anything created on their behalf points at a person who has to exist.
  await db.insert(schema.users).values({
    id: BROKER.id, name: BROKER.name, email: `${BROKER.id}@x.test`,
    passwordHash: "!", role: "broker",
  });
  companyId = randomUUID();
  await db.insert(schema.companies).values({ id: companyId, name: "Acme", industry: "" });
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
    // A real document row: every column below is NOT NULL in the deployed schema.
    const folderRow = (await db.execute(sql`
      INSERT INTO folders (company_id, name, created_by) VALUES (${companyId}, 'F', ${BROKER.id})
      RETURNING id`)) as unknown as { rows: Array<{ id: string }> };
    await db.execute(sql`
      INSERT INTO documents (id, company_id, folder_id, name, file_url, size, ext, status, uploaded_by)
      VALUES (${docId}, ${companyId}, ${folderRow.rows[0]!.id}, 'D.pdf', '', '1', 'pdf', 'under-review', ${BROKER.id})`);
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
