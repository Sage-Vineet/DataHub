import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSchemaDb, schema, type Db } from "@datahub/db";
import type { SessionUser } from "@datahub/contracts";
import { createMessagesModule } from "./index.js";


const BROKER: SessionUser = { id: "11111111-1111-1111-1111-111111111111", name: "B", email: "b@x.com", role: "broker", company_id: null, status: "active", company_ids: [] };

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
  app.use("/", createMessagesModule({ db, requireAuth }).router);
});
afterEach(async () => { await client.close(); });

describe("messages router — company + group flow (real Postgres)", () => {
  it("company conversation, group create + membership + messages + unread", async () => {
    await request(app).post(`/companies/${companyId}/messages`).send({ body: "hi team" }).expect(201);
    expect((await request(app).get(`/companies/${companyId}/messages`)).body.length).toBe(1);

    const group = (await request(app).post(`/companies/${companyId}/message-groups`).send({ name: "Deal", group_type: "deal_team" })).body;
    expect(group.auto_created).toBe(false);

    // A second member.
    const member = randomUUID();
    await request(app).post(`/message-groups/${group.id}/members`).send({ user_id: member }).expect(201);
    expect((await request(app).get(`/message-groups/${group.id}/members`)).body).toContain(member);

    await request(app).post(`/message-groups/${group.id}/messages`).send({ body: "m1" }).expect(201);
    expect((await request(app).get(`/message-groups/${group.id}/messages`)).body.length).toBe(1);

    // The other member's unread count reflects the broker's message, then resets on mark-read.
    current = { ...BROKER, id: member, company_ids: [companyId] };
    expect((await request(app).get(`/message-groups/${group.id}/messages/unread-count`)).body.unread).toBe(1);
    await request(app).post(`/message-groups/${group.id}/messages/mark-read`).expect(204);
    expect((await request(app).get(`/message-groups/${group.id}/messages/unread-count`)).body.unread).toBe(0);
  });

  it("400s a malformed send and blocks cross-tenant (403)", async () => {
    expect((await request(app).post(`/companies/${companyId}/messages`).send({ body: "" })).status).toBe(400);
    current = { ...BROKER, role: "buyer", company_ids: [randomUUID()] };
    expect((await request(app).get(`/companies/${companyId}/messages`)).status).toBe(403);
  });
});
