import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { schema, type Db } from "@datahub/db";
import type { SessionUser } from "@datahub/contracts";
import { createMessagesModule } from "./index.js";

const DDL = `
CREATE TYPE company_status AS ENUM ('active','inactive');
CREATE TABLE companies (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, project_name text, industry text,
  status company_status NOT NULL DEFAULT 'active', since date, logo text, contact_name text, contact_email text, contact_phone text,
  profit_metric text NOT NULL DEFAULT 'adjusted_ebitda', data_source_type text, quickbooks_connected boolean NOT NULL DEFAULT false,
  manual_upload_active boolean NOT NULL DEFAULT false, last_source_switch_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE company_messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE, sender_id uuid NOT NULL, body text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE direct_messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE, sender_id uuid NOT NULL, recipient_id uuid NOT NULL, body text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE message_groups (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE, name text NOT NULL, group_type text NOT NULL, buyer_user_id uuid, auto_created boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE message_group_members (group_id uuid NOT NULL REFERENCES message_groups(id) ON DELETE CASCADE, user_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (group_id, user_id));
CREATE TABLE group_messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), group_id uuid NOT NULL REFERENCES message_groups(id) ON DELETE CASCADE, sender_id uuid NOT NULL, body text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE group_message_reads (group_id uuid NOT NULL REFERENCES message_groups(id) ON DELETE CASCADE, user_id uuid NOT NULL, last_read_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (group_id, user_id));
`;

const BROKER: SessionUser = { id: "11111111-1111-1111-1111-111111111111", name: "B", email: "b@x.com", role: "broker", company_id: null, status: "active", company_ids: [] };

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
