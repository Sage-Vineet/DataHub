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
import { createUsersModule } from "./index.js";
import { DrizzleUsersRepository } from "./repository.drizzle.js";


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
  client = await createSchemaDb();
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
    await db.insert(schema.companies).values({ id: companyId, name: "Acme", contactEmail: "owner@acme.com", industry: "" });
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

    // One row per reassignment target, each carrying what the deployed schema
    // requires. These used to name a single column apiece, which only parsed
    // because the hand-written DDL made everything else optional.
    const companyId = await seedCompany();
    await db.execute(sql`
      INSERT INTO requests (company_id, title, description, category, response_type, priority, status, due_date, created_by)
      VALUES (${companyId}, 'T', 'D', 'Finance', 'Upload', 'medium', 'pending', current_date + 7, ${tid})`);
    const folderRow = (await db.execute(sql`
      INSERT INTO folders (company_id, name, created_by) VALUES (${companyId}, 'F', ${tid})
      RETURNING id`)) as unknown as { rows: Array<{ id: string }> };
    await db.execute(sql`
      INSERT INTO documents (company_id, folder_id, name, file_url, size, ext, status, uploaded_by)
      VALUES (${companyId}, ${folderRow.rows[0]!.id}, 'D.pdf', '', '1', 'pdf', 'under-review', ${tid})`);
    await db.execute(sql`
      INSERT INTO activity_log (company_id, type, message, created_by)
      VALUES (${companyId}, 'request', 'seeded', ${tid})`);
    await db.insert(schema.userCompanies).values({ userId: tid, companyId });

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
    await db.insert(schema.companies).values({ id, name: "C", industry: "" });
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
