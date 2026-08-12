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
import { createCompaniesModule } from "./index.js";

// Minimal schema: business tables + every table the cascade touches.
const DDL = `
CREATE TYPE user_role AS ENUM ('admin','broker','buyer');
CREATE TYPE user_status AS ENUM ('active','inactive');
CREATE TYPE company_status AS ENUM ('active','inactive');

CREATE TABLE companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL, project_name text, industry text,
  status company_status NOT NULL DEFAULT 'active', since date, logo text,
  contact_name text, contact_email text, contact_phone text,
  profit_metric text NOT NULL DEFAULT 'adjusted_ebitda',
  data_source_type text, quickbooks_connected boolean NOT NULL DEFAULT false,
  manual_upload_active boolean NOT NULL DEFAULT false, last_source_switch_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, email text NOT NULL UNIQUE,
  phone text, password_hash text NOT NULL, role user_role NOT NULL, company_id uuid,
  status user_status NOT NULL DEFAULT 'active',
  sub_role text, designation text, buyer_company_name text, parent_user_id uuid,
  date_of_birth date, occupation text, address text, broker_company text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE user_companies (
  user_id uuid NOT NULL, company_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, company_id)
);
CREATE TABLE folders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, parent_id uuid,
  name text NOT NULL, color text, created_by uuid NOT NULL, archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE folder_access (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), folder_id uuid NOT NULL);
CREATE TABLE requests (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, status text);
CREATE TABLE request_documents (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), request_id uuid NOT NULL);
CREATE TABLE request_narratives (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), request_id uuid NOT NULL);
CREATE TABLE request_reminders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), request_id uuid NOT NULL);
CREATE TABLE buyer_groups (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL);
CREATE TABLE buyer_group_members (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), group_id uuid NOT NULL);
CREATE TABLE documents (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL);
CREATE TABLE reminders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL);
CREATE TABLE activity_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL);
CREATE TABLE company_messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL);
CREATE TABLE direct_messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL);
CREATE TABLE manual_gl_staged_transactions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL);
CREATE TABLE manual_gl_balance_sheet_lines (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL);
CREATE TABLE manual_gl_batches (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL);
CREATE TABLE report_source_records (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL);
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

let client: PGlite;
let db: Db;
let app: express.Express;
let current: SessionUser;

beforeEach(async () => {
  client = new PGlite();
  await client.exec(DDL);
  db = drizzle(client, { schema }) as unknown as Db;
  current = { ...BROKER };

  // Fake session guard: inject the current test user.
  const requireAuth = (req: Request, _res: Response, next: NextFunction) => {
    req.user = current;
    next();
  };
  const { router } = createCompaniesModule({ db, requireAuth });
  app = express();
  app.use("/api/companies", router);
});

afterEach(async () => {
  await client.close();
});

describe("companies router — CRUD (real Postgres)", () => {
  it("creates a company (201) with default folders + a synced rep, and lists it", async () => {
    const res = await request(app)
      .post("/api/companies")
      .send({ name: "Acme", contact_email: "rep@example.com", contact_name: "Rep", profit_metric: "ebitda" });
    expect(res.status).toBe(201);
    expect(res.body.profit_metric).toBe("adjusted_ebitda");
    expect(res.body.emailQueued).toBe(true);

    // Side effects landed in Postgres.
    const folders = await db.select().from(schema.folders);
    expect(folders.length).toBeGreaterThan(0);
    const rep = await db.select().from(schema.users).where(sql`email = 'rep@example.com'`);
    expect(rep.length).toBe(1);

    // On the next request the session reflects the new membership (parity: the
    // broker is now associated with the company via user_companies).
    current = { ...current, company_ids: [res.body.id] };
    const list = await request(app).get("/api/companies");
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
  });

  it("rejects a client create (403) and a nameless create (400)", async () => {
    current = { ...BROKER, role: "buyer" };
    expect((await request(app).post("/api/companies").send({ name: "X" })).status).toBe(403);
    current = { ...BROKER };
    expect((await request(app).post("/api/companies").send({})).status).toBe(400);
  });

  it("reads with stats, updates safe fields, and blocks cross-tenant (403) / missing (404)", async () => {
    const created = (await request(app).post("/api/companies").send({ name: "Acme" })).body;
    // Seed request rows for stats.
    await db.execute(sql`INSERT INTO requests (company_id, status) VALUES (${created.id}, 'pending'), (${created.id}, 'completed'), (${created.id}, 'pending')`);

    const read = await request(app).get(`/api/companies/${created.id}`);
    expect(read.status).toBe(200);
    expect(read.body.request_count).toBe(3);
    expect(read.body.pending_request_count).toBe(2);
    expect(read.body.completed_request_count).toBe(1);

    const patched = await request(app)
      .patch(`/api/companies/${created.id}`)
      .send({ name: "Renamed", quickbooks_connected: true });
    expect(patched.status).toBe(200);
    expect(patched.body.name).toBe("Renamed");
    expect(patched.body.quickbooks_connected).toBe(false); // integration field untouched

    // Cross-tenant client → 403; unknown id → 404.
    current = { ...BROKER, role: "buyer", company_ids: [] };
    expect((await request(app).get(`/api/companies/${created.id}`)).status).toBe(403);
    current = { ...BROKER };
    expect((await request(app).get(`/api/companies/${randomUUID()}`)).status).toBe(404);
  });
});

describe("companies router — transactional cascade delete (design D4)", () => {
  it("removes the company and every dependent record atomically, nulling users.company_id", async () => {
    const created = (await request(app).post("/api/companies").send({ name: "Acme" })).body;
    const id = created.id;

    // Seed dependents across the cascade surface.
    const folder = (await db.insert(schema.folders).values({ companyId: id, name: "F", createdBy: BROKER.id }).returning())[0]!;
    await db.execute(sql`INSERT INTO folder_access (folder_id) VALUES (${folder.id})`);
    const reqRow = (await db.execute(sql`INSERT INTO requests (company_id, status) VALUES (${id}, 'pending') RETURNING id`)) as unknown as { rows: Array<{ id: string }> };
    const requestId = reqRow.rows[0]!.id;
    await db.execute(sql`INSERT INTO request_documents (request_id) VALUES (${requestId})`);
    const grpRow = (await db.execute(sql`INSERT INTO buyer_groups (company_id) VALUES (${id}) RETURNING id`)) as unknown as { rows: Array<{ id: string }> };
    await db.execute(sql`INSERT INTO buyer_group_members (group_id) VALUES (${grpRow.rows[0]!.id})`);
    await db.execute(sql`INSERT INTO documents (company_id) VALUES (${id})`);
    // A user whose primary company is this one → should be nulled, not deleted.
    await db.insert(schema.users).values({ id: BROKER.id, name: "B", email: "b@example.com", passwordHash: "!", role: "broker", companyId: id });

    const del = await request(app).delete(`/api/companies/${id}`);
    expect(del.status).toBe(200);

    const count = async (table: string) =>
      Number(((await db.execute(sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)}`)) as unknown as { rows: Array<{ n: number }> }).rows[0]!.n);

    expect(await count("companies")).toBe(0);
    expect(await count("folders")).toBe(0);
    expect(await count("folder_access")).toBe(0);
    expect(await count("requests")).toBe(0);
    expect(await count("request_documents")).toBe(0);
    expect(await count("buyer_groups")).toBe(0);
    expect(await count("buyer_group_members")).toBe(0);
    expect(await count("documents")).toBe(0);

    const survivor = await db.select().from(schema.users).where(sql`id = ${BROKER.id}`);
    expect(survivor.length).toBe(1); // user survives…
    expect(survivor[0]!.companyId).toBeNull(); // …with company_id nulled
  });
});
