import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { schema, type Db } from "@datahub/db";
import type { SessionUser } from "@datahub/contracts";
import { createReportsModule } from "./index.js";

const DDL = `
CREATE TYPE company_status AS ENUM ('active','inactive');
CREATE TABLE companies (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, project_name text, industry text,
  status company_status NOT NULL DEFAULT 'active', since date, logo text, contact_name text, contact_email text, contact_phone text,
  profit_metric text NOT NULL DEFAULT 'adjusted_ebitda', data_source_type text, quickbooks_connected boolean NOT NULL DEFAULT false,
  manual_upload_active boolean NOT NULL DEFAULT false, last_source_switch_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE key_report_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  version_number integer NOT NULL, version_name text, status text NOT NULL DEFAULT 'draft',
  is_active boolean NOT NULL DEFAULT false, resolved_batch_id uuid, resolved_dataset_version integer,
  last_synced_at timestamptz, metadata jsonb NOT NULL DEFAULT '{}'::jsonb, created_by uuid, updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_krv_company_number UNIQUE (company_id, version_number));
CREATE UNIQUE INDEX krv_one_active ON key_report_versions (company_id) WHERE is_active;
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
  app.use("/", createReportsModule({ db, requireAuth }).router);
});
afterEach(async () => { await client.close(); });

describe("reports router — version lifecycle (real Postgres)", () => {
  it("creates (auto-numbered), lists, updates, duplicates, and enforces one active version", async () => {
    const v1 = (await request(app).post("/key-reports/versions").send({ company_id: companyId, version_name: "First" })).body;
    const v2 = (await request(app).post("/key-reports/versions").send({ company_id: companyId })).body;
    expect([v1.version_number, v2.version_number]).toEqual([1, 2]);

    expect((await request(app).get(`/key-reports/versions?company_id=${companyId}`)).body.length).toBe(2);

    await request(app).put(`/key-reports/versions/${v1.id}`).send({ status: "synced", metadata: { note: "x" } }).expect(200);

    const dup = (await request(app).post(`/key-reports/versions/${v1.id}/duplicate`)).body;
    expect(dup.version_number).toBe(3);
    expect(dup.is_active).toBe(false);

    // Activate v1, then v2 — the partial-unique index means only one stays active.
    await request(app).post(`/key-reports/versions/${v1.id}/activate`).expect(200);
    await request(app).post(`/key-reports/versions/${v2.id}/activate`).expect(200);
    const active = (await db.select().from(schema.keyReportVersions)).filter((r) => r.isActive);
    expect(active.map((r) => r.id)).toEqual([v2.id]);
  });

  it("400s malformed create, 403s cross-tenant, and 501s the deferred sync via fall-through", async () => {
    const v = (await request(app).post("/key-reports/versions").send({ company_id: companyId })).body;
    expect((await request(app).post("/key-reports/versions").send({})).status).toBe(400);
    current = { ...BROKER, role: "buyer", company_ids: [randomUUID()] };
    expect((await request(app).get(`/key-reports/versions?company_id=${companyId}`)).status).toBe(403);
    // The sync route is NOT defined here (falls through to legacy in prod); the module
    // never handles it, so a direct call 404s on this isolated app — proving it's not migrated.
    current = { ...BROKER, company_ids: [companyId] };
    expect((await request(app).post(`/key-reports/versions/${v.id}/sync`)).status).toBe(404);
  });
});
