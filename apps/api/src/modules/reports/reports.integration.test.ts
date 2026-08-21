import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSchemaDb, schema, type Db } from "@datahub/db";
import type { SessionUser } from "@datahub/contracts";
import { createReportsModule } from "./index.js";


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
  app.use("/", createReportsModule({ db, requireAuth }).router);
});
afterEach(async () => { await client.close(); });

describe("reports router — version lifecycle (real Postgres)", () => {
  it("creates (auto-numbered), lists, updates, duplicates, and enforces one active version", async () => {
    const v1 = (await request(app).post("/key-reports/versions").send({ company_id: companyId, version_name: "First" })).body;
    const v2 = (await request(app).post("/key-reports/versions").send({ company_id: companyId })).body;
    // Legacy wire shape is camelCase — the SPA reads these names directly.
    expect([v1.versionNumber, v2.versionNumber]).toEqual([1, 2]);

    // Legacy envelope: { success, versions, activeVersionId }.
    const listed = (await request(app).get(`/key-reports/versions?company_id=${companyId}`)).body;
    expect(listed.success).toBe(true);
    expect(listed.versions.length).toBe(2);
    expect(listed.activeVersionId).toBeNull();

    // The SPA sends the company as X-Client-Id, never as ?company_id.
    const viaHeader = await request(app)
      .get("/key-reports/versions")
      .set("X-Client-Id", companyId);
    expect(viaHeader.status).toBe(200);
    expect(viaHeader.body.versions.length).toBe(2);

    await request(app).put(`/key-reports/versions/${v1.id}`).send({ status: "synced", metadata: { note: "x" } }).expect(200);

    // Legacy envelope for the detail read — the SPA store reads `detail.version`.
    const detail = (await request(app).get(`/key-reports/versions/${v1.id}`)).body;
    expect(detail.success).toBe(true);
    expect(detail.version.id).toBe(v1.id);
    expect(detail.version.versionName).toBe("First");

    const dup = (await request(app).post(`/key-reports/versions/${v1.id}/duplicate`)).body;
    expect(dup.versionNumber).toBe(3);
    expect(dup.isActive).toBe(false);
    expect(dup.versionName).toBe("First");

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
