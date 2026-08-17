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
import { createFoldersModule } from "./index.js";
import { EXPECTED_FOLDER_COUNT } from "./hierarchy.js";

const DDL = `
CREATE TYPE company_status AS ENUM ('active','inactive');
CREATE TABLE companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, project_name text, industry text,
  status company_status NOT NULL DEFAULT 'active', since date, logo text,
  contact_name text, contact_email text, contact_phone text,
  profit_metric text NOT NULL DEFAULT 'adjusted_ebitda', data_source_type text,
  quickbooks_connected boolean NOT NULL DEFAULT false, manual_upload_active boolean NOT NULL DEFAULT false,
  last_source_switch_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE folders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL, parent_id uuid, name text NOT NULL, color text,
  created_by uuid NOT NULL, archived_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX folders_company_parent_name_uq
  ON folders (company_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), name);
CREATE TABLE folder_access (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  folder_id uuid NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  user_id uuid, group_id uuid,
  can_read boolean NOT NULL DEFAULT true, can_write boolean NOT NULL DEFAULT false,
  can_download boolean NOT NULL DEFAULT false, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT folder_access_one_subject CHECK ((user_id IS NOT NULL) <> (group_id IS NOT NULL))
);
CREATE TABLE report_source_records (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), folder_id uuid);
CREATE TABLE buyer_groups (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
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
let companyId: string;

beforeEach(async () => {
  client = new PGlite();
  await client.exec(DDL);
  db = drizzle(client, { schema }) as unknown as Db;
  companyId = randomUUID();
  await db.insert(schema.companies).values({ id: companyId, name: "Acme" });
  current = { ...BROKER };

  const requireAuth = (req: Request, _res: Response, next: NextFunction) => {
    req.user = current;
    next();
  };
  app = express();
  app.use("/", createFoldersModule({ db, requireAuth }).router);
});

afterEach(async () => {
  await client.close();
});

describe("folders router — provisioning is idempotent (D2, real Postgres)", () => {
  it("creates the standard set once; a second call makes no duplicates", async () => {
    const first = await request(app).post(`/companies/${companyId}/folders/ensure-defaults`);
    expect(first.status).toBe(200);
    const countAfterFirst = (await db.select().from(schema.folders)).length;
    expect(countAfterFirst).toBe(EXPECTED_FOLDER_COUNT);

    await request(app).post(`/companies/${companyId}/folders/ensure-defaults`).expect(200);
    expect((await db.select().from(schema.folders)).length).toBe(EXPECTED_FOLDER_COUNT);

    // The tree nests the two manual-source subtrees under their parents.
    const tree = await request(app).get(`/companies/${companyId}/folders/tree`);
    const mus = tree.body.find((n: { name: string }) => n.name === "Manual Upload Source");
    expect(mus.children.map((c: { name: string }) => c.name)).toContain("Reports");
  });
});

describe("folders router — CRUD + archive (real Postgres)", () => {
  it("creates, renames, moves, archives with the archived filter", async () => {
    const parent = (await request(app).post(`/companies/${companyId}/folders`).send({ name: "Parent" })).body;
    const child = (await request(app).post(`/companies/${companyId}/folders`).send({ name: "Child", parent_id: parent.id })).body;

    await request(app).patch(`/folders/${child.id}`).send({ name: "Renamed", color: "#fff" }).expect(200);
    await request(app).post(`/folders/${child.id}/archive`).expect(200);

    const live = await request(app).get(`/companies/${companyId}/folders`);
    expect(live.body.map((f: { name: string }) => f.name)).not.toContain("Renamed");
    const all = await request(app).get(`/companies/${companyId}/folders?include_archived=true`);
    expect(all.body.map((f: { name: string }) => f.name)).toContain("Renamed");
  });

  it("honours the ?includeArchived spelling the SPA actually sends", async () => {
    // The test above asks using the module's own parameter name, which is why the
    // mismatch went unnoticed: legacy and apps/web/src/lib/api.js send
    // `includeArchived`. Reading only snake_case made the filter silently inert —
    // the query parsed fine and returned the unfiltered list.
    const folder = (
      await request(app).post(`/companies/${companyId}/folders`).send({ name: "Archived Wire" })
    ).body;
    await request(app).post(`/folders/${folder.id}/archive`).expect(200);

    const defaulted = await request(app).get(`/companies/${companyId}/folders`);
    expect(defaulted.body.map((f: { name: string }) => f.name)).not.toContain("Archived Wire");

    const camel = await request(app).get(`/companies/${companyId}/folders?includeArchived=true`);
    expect(camel.body.map((f: { name: string }) => f.name)).toContain("Archived Wire");

    const tree = await request(app).get(
      `/companies/${companyId}/folders/tree?includeArchived=true`,
    );
    expect(JSON.stringify(tree.body)).toContain("Archived Wire");
  });
});

describe("folders router — protected delete + access cascade (D3/D5)", () => {
  it("409s a folder linked to a Key Report; deletes an unlinked one and cascades access", async () => {
    const linked = (await request(app).post(`/companies/${companyId}/folders`).send({ name: "Linked" })).body;
    const free = (await request(app).post(`/companies/${companyId}/folders`).send({ name: "Free" })).body;
    await db.execute(sql`INSERT INTO report_source_records (folder_id) VALUES (${linked.id})`);

    // Grant access on the free folder, then delete it → access cascades away.
    await request(app).post(`/folders/${free.id}/access`).send({ user_id: randomUUID(), can_write: true }).expect(201);
    expect((await db.select().from(schema.folderAccess)).length).toBe(1);

    expect((await request(app).delete(`/folders/${linked.id}`)).status).toBe(409);
    expect((await db.select().from(schema.folders).where(sql`id = ${linked.id}`)).length).toBe(1); // untouched

    await request(app).delete(`/folders/${free.id}`).expect(204);
    expect((await db.select().from(schema.folders).where(sql`id = ${free.id}`)).length).toBe(0);
    expect((await db.select().from(schema.folderAccess)).length).toBe(0); // cascaded
  });
});

describe("folders router — access grants enforce one subject (D4)", () => {
  it("accepts a user-only grant, 400s both/neither", async () => {
    const folder = (await request(app).post(`/companies/${companyId}/folders`).send({ name: "F" })).body;
    await request(app).post(`/folders/${folder.id}/access`).send({ user_id: randomUUID() }).expect(201);
    expect((await request(app).post(`/folders/${folder.id}/access`).send({ user_id: randomUUID(), group_id: randomUUID() })).status).toBe(400);
    expect((await request(app).post(`/folders/${folder.id}/access`).send({ can_read: true })).status).toBe(400);
  });
});
