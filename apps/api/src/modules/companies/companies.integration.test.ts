import { eq } from "drizzle-orm";
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
import { createCompaniesModule } from "./index.js";

// Minimal schema: business tables + every table the cascade touches.

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
  client = await createSchemaDb();
  db = drizzle(client, { schema }) as unknown as Db;
  current = { ...BROKER };
  // The acting user has to exist: creating a company writes user_companies, and
  // that is a real foreign key in the deployed schema. The hand-written DDL
  // declared it as a bare uuid, so the session user never needed a row.
  await db.insert(schema.users).values({
    id: BROKER.id, name: BROKER.name, email: `${BROKER.id}@x.test`,
    passwordHash: "!", role: "broker",
  });

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
  it("creates a company when the optional industry is omitted", async () => {
    // industry is optional in the contract and NOT NULL in the deployed schema,
    // so omitting it used to be a 500 from the database rather than a create.
    const res = await request(app).post("/api/companies").send({ name: "Drift Probe Co" });

    expect(res.status).toBe(201);
    expect(res.body.industry).toBe("");
  });

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
    // Creating associates the broker with the company (user_companies); the fake
    // session guard has to reflect that, because membership — not the broker role
    // — is what grants access.
    current = { ...current, company_ids: [created.id] };
    // Seed request rows for stats. Every NOT NULL column is supplied, because
    // the schema under the test is the deployed one.
    await db.update(schema.users).set({ companyId: created.id }).where(eq(schema.users.id, BROKER.id));
    for (const status of ["pending", "completed", "pending"] as const) {
      await db.execute(sql`
        INSERT INTO requests (company_id, title, description, category, response_type, priority, status, due_date, created_by)
        VALUES (${created.id}, 'T', 'D', 'Finance', 'Upload', 'medium', ${status}, current_date + 7, ${BROKER.id})`);
    }

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
    current = { ...BROKER, company_ids: [created.id] };
    expect((await request(app).get(`/api/companies/${randomUUID()}`)).status).toBe(404);
  });
});

describe("companies router — transactional cascade delete (design D4)", () => {
  it("removes the company and every dependent record atomically, nulling users.company_id", async () => {
    const created = (await request(app).post("/api/companies").send({ name: "Acme" })).body;
    const id = created.id;
    current = { ...current, company_ids: [id] };

    // Seed dependents across the cascade surface.
    //
    // Every row below carries what the deployed schema actually requires — NOT
    // NULL columns, foreign keys, and folder_access's exclusive-subject CHECK.
    // These inserts used to name one column each, which only worked because the
    // hand-written DDL made the rest optional.
    //
    // The user comes first: folders, requests and folder_access all point at it.
    await db.update(schema.users).set({ companyId: id }).where(eq(schema.users.id, BROKER.id));
    const folder = (await db.insert(schema.folders).values({ companyId: id, name: "F", createdBy: BROKER.id }).returning())[0]!;
    await db.execute(sql`
      INSERT INTO folder_access (folder_id, user_id, created_by)
      VALUES (${folder.id}, ${BROKER.id}, ${BROKER.id})`);
    const reqRow = (await db.execute(sql`
      INSERT INTO requests (company_id, title, description, category, response_type, priority, status, due_date, created_by)
      VALUES (${id}, 'T', 'D', 'Finance', 'Upload', 'medium', 'pending', current_date + 7, ${BROKER.id})
      RETURNING id`)) as unknown as { rows: Array<{ id: string }> };
    const requestId = reqRow.rows[0]!.id;
    const docRow = (await db.execute(sql`
      INSERT INTO documents (company_id, folder_id, name, file_url, size, ext, status, uploaded_by)
      VALUES (${id}, ${folder.id}, 'D.pdf', '', '1', 'pdf', 'under-review', ${BROKER.id})
      RETURNING id`)) as unknown as { rows: Array<{ id: string }> };
    await db.execute(sql`
      INSERT INTO request_documents (request_id, document_id)
      VALUES (${requestId}, ${docRow.rows[0]!.id})`);
    const grpRow = (await db.execute(sql`
      INSERT INTO buyer_groups (company_id, name) VALUES (${id}, 'Bidders') RETURNING id`)) as unknown as { rows: Array<{ id: string }> };
    await db.execute(sql`
      INSERT INTO buyer_group_members (group_id, user_id) VALUES (${grpRow.rows[0]!.id}, ${BROKER.id})`);

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

/**
 * The activity feed reads Postgres directly.
 *
 * The legacy handler for this route queries Supabase through `safeQuery`, which
 * swallows a failure into an empty array — so with no Supabase configured the
 * endpoint answered `200 []`, and the broker dashboard, the deal tracker and the
 * client dashboard all reported "No activity yet" over rows that were sitting in
 * `activity_log` the whole time. An unreachable source and an empty one are
 * different facts and must not render identically.
 */
describe("companies router — deal activity feed (real Postgres)", () => {
  async function seedCompany(): Promise<string> {
    const created = (await request(app).post("/api/companies").send({ name: "Acme" })).body;
    // Membership, not the broker role, is what grants access — mirror what the
    // create actually did.
    current = { ...current, company_ids: [created.id] };
    await db.update(schema.users).set({ companyId: created.id }).where(eq(schema.users.id, BROKER.id));
    return created.id as string;
  }

  it("returns the rows that exist, newest first, naming the actor", async () => {
    const companyId = await seedCompany();
    await db.insert(schema.activityLog).values([
      { companyId, type: "request", message: "Requested \"FY2024 statements\"", createdBy: BROKER.id,
        createdAt: new Date("2026-08-10T10:00:00Z") },
      { companyId, type: "upload", message: "Uploaded Lease.pdf", createdBy: BROKER.id,
        createdAt: new Date("2026-08-12T10:00:00Z") },
    ]);

    const res = await request(app).get(`/api/companies/${companyId}/activity`).expect(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].message).toBe("Uploaded Lease.pdf"); // newest first
    expect(res.body[0].type).toBe("upload");
    expect(res.body[0].actor_name).toBe(BROKER.name); // not a bare uuid
    expect(res.body[1].message).toContain("FY2024");
  });

  it("returns an empty array only when the deal genuinely has no activity", async () => {
    const companyId = await seedCompany();
    await request(app).get(`/api/companies/${companyId}/activity`).expect(200).expect([]);
  });

  it("honours a limit and caps it", async () => {
    const companyId = await seedCompany();
    await db.insert(schema.activityLog).values(
      Array.from({ length: 5 }, (_, i) => ({
        companyId, type: "upload" as const, message: `Uploaded ${i}.pdf`, createdBy: BROKER.id,
        createdAt: new Date(Date.UTC(2026, 7, i + 1)),
      })),
    );
    expect((await request(app).get(`/api/companies/${companyId}/activity?limit=2`).expect(200)).body).toHaveLength(2);
    // A nonsense limit falls back rather than throwing or returning everything.
    expect((await request(app).get(`/api/companies/${companyId}/activity?limit=abc`).expect(200)).body).toHaveLength(5);
  });

  it("refuses a deal the caller cannot access", async () => {
    const companyId = await seedCompany();
    current = { ...BROKER, company_id: null, company_ids: [] };
    await request(app).get(`/api/companies/${companyId}/activity`).expect(403);
  });
});
