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
import { createFoldersModule } from "./index.js";
import { EXPECTED_FOLDER_COUNT } from "./hierarchy.js";


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
  // Membership is what grants access — brokers are not unscoped (parity with
  // legacy permissionService), so the test broker must belong to this company.
  current = { ...BROKER, company_ids: [companyId] };

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
    // The real Key-Report linkage: a file_references row against a document in
    // the folder. report_source_records has no folder_id column and never did.
    const linkedDoc = (await db.execute(sql`
      INSERT INTO documents (company_id, folder_id, name, file_url, size, ext, status, uploaded_by)
      VALUES (${companyId}, ${linked.id}, 'Linked.pdf', '', '1', 'pdf', 'under-review', ${BROKER.id})
      RETURNING id`)) as unknown as { rows: Array<{ id: string }> };
    await db.execute(sql`
      INSERT INTO file_references (company_id, document_id, linked_module, linked_entity_id, created_by)
      VALUES (${companyId}, ${linkedDoc.rows[0]!.id}, 'key_reports', ${randomUUID()}, ${BROKER.id})`);

    // Grant access on the free folder, then delete it → access cascades away.
    await request(app).post(`/folders/${free.id}/access`).send({ user_id: BROKER.id, can_write: true }).expect(201);
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
    // user_id is a foreign key in the deployed schema, so the grant names a
    // real person rather than an arbitrary uuid.
    await request(app).post(`/folders/${folder.id}/access`).send({ user_id: BROKER.id }).expect(201);
    expect((await request(app).post(`/folders/${folder.id}/access`).send({ user_id: randomUUID(), group_id: randomUUID() })).status).toBe(400);
    expect((await request(app).post(`/folders/${folder.id}/access`).send({ can_read: true })).status).toBe(400);
  });
});

/**
 * A grant response carries `group_id: null` for a user grant. Echoing that shape
 * back on create is the obvious thing for a client to do — and it is exactly
 * what the file explorer did, so every attempt to save folder access from the UI
 * returned 400 "Expected string, received null".
 *
 * The capability was fully built on both sides; nobody could use it. Staged
 * disclosure — the reason a broker buys a data room — was unreachable.
 */
describe("folders router — a grant accepts the shape it returns", () => {
  it("accepts an explicit null for the subject that does not apply", async () => {
    const folder = (await request(app).post(`/companies/${companyId}/folders`).send({ name: "Phase 1" })).body;

    const created = await request(app)
      .post(`/folders/${folder.id}/access`)
      .send({ user_id: BROKER.id, group_id: null, can_read: true, can_download: true })
      .expect(201);

    expect(created.body.user_id).toBe(BROKER.id);
    expect(created.body.group_id).toBeNull();
    expect(created.body.can_read).toBe(true);
    expect(created.body.can_download).toBe(true);
  });

  it("round-trips: a returned grant can be sent straight back", async () => {
    const folder = (await request(app).post(`/companies/${companyId}/folders`).send({ name: "Phase 2" })).body;
    const first = (await request(app)
      .post(`/folders/${folder.id}/access`)
      .send({ user_id: BROKER.id, can_read: true })).body;

    // The exact payload the API just produced, minus its identity.
    const { id: _id, folder_id: _folderId, created_by: _createdBy, ...echoed } = first;
    const other = (await request(app).post(`/companies/${companyId}/folders`).send({ name: "Phase 3" })).body;
    await request(app).post(`/folders/${other.id}/access`).send(echoed).expect(201);
  });

  it("still refuses both subjects, and still refuses neither", async () => {
    const folder = (await request(app).post(`/companies/${companyId}/folders`).send({ name: "G" })).body;
    // Null must not be mistaken for "provided" — user_id null + group_id null is
    // still neither, and must fail.
    expect((await request(app).post(`/folders/${folder.id}/access`).send({ user_id: null, group_id: null })).status).toBe(400);
    expect((await request(app).post(`/folders/${folder.id}/access`).send({ user_id: BROKER.id, group_id: randomUUID() })).status).toBe(400);
  });
});
