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

  it("derives the reminders board from requests and their send history", async () => {
    // The chase loop end to end: create a request, hit Remind, and the reminders
    // board must show the send. Legacy served this read off Supabase and 500d;
    // the SPA renders 0 Due / 0 Scheduled when it does, so a broker creating
    // reminders never sees one.
    await db
      .update(schema.companies)
      .set({ contactName: "Cal Contact", contactEmail: "cal@acme.test", contactPhone: "+1 555 0100" })
      .where(sql`id = ${companyId}`);

    const created = await request(app)
      .post(`/companies/${companyId}/requests`)
      .send({ ...base, priority: "high", due_date: "2099-12-31" })
      .expect(201);
    const id = created.body.id;

    const before = await request(app).get(`/companies/${companyId}/reminders`).expect(200);
    expect(before.body).toHaveLength(1);
    expect(before.body[0].request_id).toBe(id);
    expect(before.body[0].sent_count).toBe(0);
    expect(before.body[0].frequency_label).toBe("Daily"); // high → daily
    expect(before.body[0].company_contact_email).toBe("cal@acme.test");

    await request(app).post(`/requests/${id}/reminders`).expect(201);

    const after = await request(app).get(`/companies/${companyId}/reminders`).expect(200);
    expect(after.body[0].sent_count).toBe(1);
    // The join has to resolve the sender — "sent by 111…" is not an answer.
    expect(after.body[0].history[0].sent_by_name).toBe("B");
    expect(after.body[0].last_sent_at).not.toBe(before.body[0].last_sent_at);
  });

  it("keeps another tenant's reminders off the board, and 403s a stranger", async () => {
    const otherCompany = randomUUID();
    await db.insert(schema.companies).values({ id: otherCompany, name: "Rival", industry: "" });
    current = { ...BROKER, company_ids: [companyId, otherCompany] };
    await request(app).post(`/companies/${otherCompany}/requests`).send(base).expect(201);
    await request(app).post(`/companies/${companyId}/requests`).send(base).expect(201);

    const mine = await request(app).get(`/companies/${companyId}/reminders`).expect(200);
    expect(mine.body).toHaveLength(1);
    expect(mine.body[0].company_id).toBe(companyId);

    current = { ...BROKER, role: "buyer", company_ids: [randomUUID()] };
    await request(app).get(`/companies/${companyId}/reminders`).expect(403);
  });

  it("400s a malformed create and blocks cross-tenant (403)", async () => {
    expect((await request(app).post(`/companies/${companyId}/requests`).send({ title: "x" })).status).toBe(400);
    current = { ...BROKER, role: "buyer", company_ids: [randomUUID()] };
    expect((await request(app).get(`/companies/${companyId}/requests`)).status).toBe(403);
  });
});
