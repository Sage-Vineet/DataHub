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
import { createUsersModule } from "./index.js";
import { DrizzleUsersRepository } from "./repository.drizzle.js";

const DDL = `
CREATE TYPE user_role AS ENUM ('admin','broker','buyer');
CREATE TYPE user_status AS ENUM ('active','inactive');
CREATE TYPE company_status AS ENUM ('active','inactive');

CREATE TABLE companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, project_name text, industry text,
  status company_status NOT NULL DEFAULT 'active', since date, logo text,
  contact_name text, contact_email text, contact_phone text,
  profit_metric text NOT NULL DEFAULT 'adjusted_ebitda', data_source_type text,
  quickbooks_connected boolean NOT NULL DEFAULT false, manual_upload_active boolean NOT NULL DEFAULT false,
  last_source_switch_at timestamptz,
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
CREATE TABLE broker_team_invites (
  team_owner_id uuid NOT NULL, invited_broker_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (team_owner_id, invited_broker_id)
);
-- Reassignment target tables (minimal).
CREATE TABLE requests (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_by uuid);
CREATE TABLE folders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_by uuid);
CREATE TABLE documents (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), uploaded_by uuid);
CREATE TABLE request_narratives (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), updated_by uuid);
CREATE TABLE request_reminders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sent_by uuid);
CREATE TABLE folder_access (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_by uuid);
CREATE TABLE reminders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_by uuid);
CREATE TABLE activity_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_by uuid);
`;

const ADMIN: SessionUser = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "Admin",
  email: "admin@example.com",
  role: "admin",
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
  current = { ...ADMIN };
  // The admin actor must exist as a row (replacement owner for deletes).
  await db.insert(schema.users).values({ id: ADMIN.id, name: "Admin", email: "admin@example.com", passwordHash: "!", role: "admin" });

  const requireAuth = (req: Request, _res: Response, next: NextFunction) => {
    req.user = current;
    next();
  };
  app = express();
  app.use("/api/users", createUsersModule({ db, requireAuth }).router);
});

afterEach(async () => {
  await client.close();
});

describe("users router — CRUD + effective_role (real Postgres)", () => {
  it("creates a user (201), lists, and reads it back", async () => {
    const res = await request(app)
      .post("/api/users")
      .send({ name: "Jo", email: "jo@example.com", password: "passw0rd1", role: "buyer", sub_role: "client_team_member" });
    expect(res.status).toBe(201);
    expect(res.body.effective_role).toBe("client"); // client sub-role
    expect(res.body.sub_role).toBe("client_team_member");

    const list = await request(app).get("/api/users");
    expect(list.status).toBe(200);
    expect(list.body.map((u: { email: string }) => u.email)).toContain("jo@example.com");

    const read = await request(app).get(`/api/users/${res.body.id}`);
    expect(read.status).toBe(200);
    expect(read.body.password_hash).toBeUndefined();
  });

  it("computes effective_role=client for a buyer whose email is a company contact (seller)", async () => {
    const companyId = randomUUID();
    await db.insert(schema.companies).values({ id: companyId, name: "Acme", contactEmail: "owner@acme.com" });
    const created = (await request(app).post("/api/users").send({
      name: "Owner", email: "owner@acme.com", password: "passw0rd1", role: "buyer", company_ids: [companyId],
    })).body;
    const read = await request(app).get(`/api/users/${created.id}`);
    expect(read.body.effective_role).toBe("client");
    expect(read.body.company_ids).toContain(companyId);
  });

  it("400s a malformed create and 404s an unknown user", async () => {
    expect((await request(app).post("/api/users").send({ email: "x@x.com" })).status).toBe(400);
    expect((await request(app).get(`/api/users/${randomUUID()}`)).status).toBe(404);
  });
});

describe("users router — transactional delete-with-reassignment (D4)", () => {
  it("reassigns created_by/uploaded_by records to the replacement then deletes, atomically", async () => {
    // Target user with records across the reassignment surface.
    const target = (await request(app).post("/api/users").send({
      name: "Gone", email: "gone@example.com", password: "passw0rd1", role: "broker", sub_role: "banker",
    })).body;
    const tid = target.id;

    await db.execute(sql`INSERT INTO requests (created_by) VALUES (${tid})`);
    await db.execute(sql`INSERT INTO folders (created_by) VALUES (${tid})`);
    await db.execute(sql`INSERT INTO documents (uploaded_by) VALUES (${tid})`);
    await db.execute(sql`INSERT INTO activity_log (created_by) VALUES (${tid})`);
    await db.insert(schema.userCompanies).values({ userId: tid, companyId: (await seedCompany()) });

    const del = await request(app).delete(`/api/users/${tid}`);
    expect(del.status).toBe(204);

    // User gone; records reassigned to the admin actor (the replacement).
    expect(await request(app).get(`/api/users/${tid}`).then((r) => r.status)).toBe(404);
    const owner = async (table: string, col: string) =>
      ((await db.execute(sql`SELECT ${sql.identifier(col)} AS who FROM ${sql.identifier(table)} LIMIT 1`)) as unknown as { rows: Array<{ who: string }> }).rows[0]!.who;
    expect(await owner("requests", "created_by")).toBe(ADMIN.id);
    expect(await owner("folders", "created_by")).toBe(ADMIN.id);
    expect(await owner("documents", "uploaded_by")).toBe(ADMIN.id);
    expect(await owner("activity_log", "created_by")).toBe(ADMIN.id);
    // Company link cleaned up.
    const links = await db.select().from(schema.userCompanies);
    expect(links.length).toBe(0);
  });

  async function seedCompany(): Promise<string> {
    const id = randomUUID();
    await db.insert(schema.companies).values({ id, name: "C" });
    return id;
  }
});

describe("users repository — broker-team invites (real Postgres)", () => {
  it("records and lists invites", async () => {
    const repo = new DrizzleUsersRepository(db);
    const owner = ADMIN.id;
    const invited = randomUUID();
    await db.insert(schema.users).values({ id: invited, name: "Peer", email: "peer@example.com", passwordHash: "!", role: "broker" });
    await repo.inviteBrokerToTeam(owner, invited);
    expect(await repo.invitedBrokerIds(owner)).toEqual([invited]);
    await repo.removeBrokerFromTeam(owner, invited);
    expect(await repo.invitedBrokerIds(owner)).toEqual([]);
  });
});
