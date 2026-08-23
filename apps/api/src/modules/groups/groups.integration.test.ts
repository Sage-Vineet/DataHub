import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import supertest from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createSchemaDb, schema, type Db } from "@datahub/db";
import type { SessionUser } from "@datahub/contracts";
import { createGroupsModule } from "./index.js";

/**
 * Groups against the real deployed schema.
 *
 * The service tests run on an in-memory repository, which cannot catch the
 * mistakes that only exist between Drizzle and Postgres: a column mapped to the
 * wrong name, an ordering that only holds by insertion accident, or a cascade
 * that is declared in the fake and absent in the database. Those are the bugs
 * this file exists for, so it runs the HTTP surface end to end.
 */

const COMPANY = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OTHER_COMPANY = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const BROKER: SessionUser = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "Broker",
  email: "broker@example.com",
  role: "broker",
  company_id: null,
  status: "active",
  company_ids: [COMPANY],
};

const MEMBER_ID = "22222222-2222-2222-2222-222222222222";

let client: PGlite;
let db: Db;
let app: express.Express;
let current: SessionUser;

beforeEach(async () => {
  client = await createSchemaDb();
  db = drizzle(client, { schema }) as unknown as Db;
  current = { ...BROKER };

  // `industry` is NOT NULL in the deployed schema with no default, which the
  // in-memory repository has no way to know.
  await db.insert(schema.companies).values([
    { id: COMPANY, name: "Acme", industry: "Manufacturing" },
    { id: OTHER_COMPANY, name: "Other", industry: "Retail" },
  ]);
  // buyer_group_members.user_id is a real foreign key to users.
  await db.insert(schema.users).values([
    { id: BROKER.id, name: "Broker", email: "b@x.test", passwordHash: "!", role: "broker" },
    { id: MEMBER_ID, name: "Buyer", email: "buyer@x.test", passwordHash: "!", role: "buyer" },
  ]);

  const requireAuth = (req: Request, _res: Response, next: NextFunction) => {
    req.user = current;
    next();
  };

  app = express();
  app.use(createGroupsModule({ db, requireAuth }).router);
});

const api = () => supertest(app);

describe("the group lifecycle over HTTP", () => {
  it("creates, lists, updates and deletes", async () => {
    const created = await api()
      .post(`/companies/${COMPANY}/groups`)
      .send({ name: "Buyers", description: "core" })
      .expect(201);
    expect(created.body).toMatchObject({ company_id: COMPANY, name: "Buyers", member_count: 0 });

    const listed = await api().get(`/companies/${COMPANY}/groups`).expect(200);
    expect(listed.body).toHaveLength(1);

    const updated = await api()
      .patch(`/groups/${created.body.id}`)
      .send({ name: "Renamed" })
      .expect(200);
    // The column does not exist, so a write of it would fail against Postgres —
    // this is the assertion that would have caught legacy's `updated_at`.
    expect(updated.body).toMatchObject({ name: "Renamed", description: null });

    await api().delete(`/groups/${created.body.id}`).expect(204);
    expect((await api().get(`/companies/${COMPANY}/groups`).expect(200)).body).toEqual([]);
  });

  it("orders groups newest first as the database returns them", async () => {
    await api().post(`/companies/${COMPANY}/groups`).send({ name: "First" }).expect(201);
    await api().post(`/companies/${COMPANY}/groups`).send({ name: "Second" }).expect(201);

    const body = (await api().get(`/companies/${COMPANY}/groups`).expect(200)).body as Array<{
      name: string;
    }>;
    expect(body.map((g) => g.name)).toEqual(["Second", "First"]);
  });
});

describe("membership against real foreign keys", () => {
  it("adds a member and counts them in the listing", async () => {
    const group = (
      await api().post(`/companies/${COMPANY}/groups`).send({ name: "G" }).expect(201)
    ).body as { id: string };

    await api().post(`/groups/${group.id}/members`).send({ user_id: MEMBER_ID }).expect(201);

    const listed = (await api().get(`/companies/${COMPANY}/groups`).expect(200)).body as Array<{
      member_count: number;
      member_ids: string[];
    }>;
    expect(listed[0]).toMatchObject({ member_count: 1, member_ids: [MEMBER_ID] });
  });

  it("is idempotent on a repeated add, because the pair is the primary key", async () => {
    const group = (
      await api().post(`/companies/${COMPANY}/groups`).send({ name: "G" }).expect(201)
    ).body as { id: string };

    await api().post(`/groups/${group.id}/members`).send({ user_id: MEMBER_ID }).expect(201);
    await api().post(`/groups/${group.id}/members`).send({ user_id: MEMBER_ID }).expect(201);

    expect((await api().get(`/groups/${group.id}/members`).expect(200)).body).toHaveLength(1);
  });

  it("removes memberships with the group, via ON DELETE CASCADE", async () => {
    const group = (
      await api().post(`/companies/${COMPANY}/groups`).send({ name: "G" }).expect(201)
    ).body as { id: string };
    await api().post(`/groups/${group.id}/members`).send({ user_id: MEMBER_ID }).expect(201);

    await api().delete(`/groups/${group.id}`).expect(204);

    const rows = await db.select().from(schema.buyerGroupMembers);
    expect(rows).toEqual([]);
  });

  it("removes a single member", async () => {
    const group = (
      await api().post(`/companies/${COMPANY}/groups`).send({ name: "G" }).expect(201)
    ).body as { id: string };
    await api().post(`/groups/${group.id}/members`).send({ user_id: MEMBER_ID }).expect(201);

    await api().delete(`/groups/${group.id}/members/${MEMBER_ID}`).expect(204);
    expect((await api().get(`/groups/${group.id}/members`).expect(200)).body).toEqual([]);
  });
});

describe("authorization", () => {
  it("403s a company the caller is not associated with", async () => {
    await api().get(`/companies/${OTHER_COMPANY}/groups`).expect(403);
    await api().post(`/companies/${OTHER_COMPANY}/groups`).send({ name: "N" }).expect(403);
  });

  it("404s an unknown group before revealing anything about it", async () => {
    await api().get(`/groups/${OTHER_COMPANY}/members`).expect(404);
  });

  it("400s a create with no name", async () => {
    await api().post(`/companies/${COMPANY}/groups`).send({}).expect(400);
  });

  it("leaves an unmatched path alone so it can reach the proxy", async () => {
    // The module mounts at "/" and must not answer for paths it does not define,
    // or every un-migrated neighbour sharing the prefix breaks.
    await api().get("/companies/whatever/requests").expect(404);
  });
});
