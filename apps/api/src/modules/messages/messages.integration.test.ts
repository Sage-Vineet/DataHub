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

/**
 * The contacts listing is the entry point to direct messaging: every messaging
 * view loads it before it can render. The TypeScript rewrite defined only
 * `/direct-messages/:recipientId`, so Express matched `contacts` as a recipient
 * id and the conversation query 500'd — taking the whole capability out for both
 * roles. Legacy has always declared the literal route first
 * (`backend/src/routes/messages.js:19`).
 */
describe("messages router — direct contacts (real Postgres)", () => {
  async function addMember(name: string, role: "broker" | "buyer" = "buyer") {
    const id = randomUUID();
    await db.insert(schema.users).values({
      id, name, email: `${id}@x.test`, passwordHash: "!", role, companyId,
    });
    return id;
  }

  it("lists the deal's members and does not 500", async () => {
    const dana = await addMember("Dana Client");
    const res = await request(app).get(`/companies/${companyId}/direct-messages/contacts`).expect(200);

    expect(res.body.company).toMatchObject({ id: companyId, name: "Acme" });
    expect(res.body.contacts.map((c: { id: string }) => c.id)).toEqual([dana]);
    // Never spoken to is a real state, not an omission.
    expect(res.body.contacts[0].last_message).toBeNull();
    expect(res.body.contacts[0].name).toBe("Dana Client");
  });

  it("never parses `contacts` as a recipient id", async () => {
    await addMember("Dana Client");
    const res = await request(app).get(`/companies/${companyId}/direct-messages/contacts`).expect(200);
    // The conversation route answers with an array; the listing answers with an
    // object carrying `contacts`. If the param route wins, this is an array.
    expect(Array.isArray(res.body)).toBe(false);
    expect(res.body).toHaveProperty("contacts");
  });

  it("still resolves a real recipient id as a conversation", async () => {
    const dana = await addMember("Dana Client");
    await request(app)
      .post(`/companies/${companyId}/direct-messages/${dana}`)
      .send({ body: "can you send the lease?" })
      .expect(201);

    const convo = await request(app).get(`/companies/${companyId}/direct-messages/${dana}`).expect(200);
    expect(Array.isArray(convo.body)).toBe(true);
    expect(convo.body).toHaveLength(1);
  });

  it("excludes the caller and orders by most recent, then name", async () => {
    const quiet = await addMember("Aaron Quiet");
    const recent = await addMember("Zoe Recent");
    await request(app)
      .post(`/companies/${companyId}/direct-messages/${recent}`)
      .send({ body: "latest" })
      .expect(201);

    const res = await request(app).get(`/companies/${companyId}/direct-messages/contacts`).expect(200);
    const ids = res.body.contacts.map((c: { id: string }) => c.id);
    expect(ids).not.toContain(BROKER.id);          // nobody messages themselves
    expect(ids).toEqual([recent, quiet]);          // spoken-to first, silent still listed
    expect(res.body.contacts[0].last_message.body).toBe("latest");
  });

  it("refuses a company the caller cannot access", async () => {
    const other = randomUUID();
    await db.insert(schema.companies).values({ id: other, name: "Cardinal", industry: "" });
    await request(app).get(`/companies/${other}/direct-messages/contacts`).expect(403);
  });
});
