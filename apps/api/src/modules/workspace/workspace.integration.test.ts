import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import supertest from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createSchemaDb, schema, type Db } from "@datahub/db";
import type { SessionUser } from "@datahub/contracts";
import { createWorkspaceModule, resolveCompanyId } from "./index.js";

/**
 * Workspace state against the real schema.
 *
 * The one thing only Postgres can prove here is the upsert: the table is unique
 * on (company, page key), so a second save must update rather than raise a
 * constraint violation. An in-memory Map cannot fail that test.
 */

const COMPANY = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const USER = "11111111-1111-1111-1111-111111111111";

const user: SessionUser = {
  id: USER,
  name: "Dana",
  email: "dana@example.com",
  role: "broker",
  company_id: null,
  status: "active",
  company_ids: [COMPANY],
};

let db: Db;
let app: express.Express;
let current: SessionUser;

beforeEach(async () => {
  const client: PGlite = await createSchemaDb();
  db = drizzle(client, { schema }) as unknown as Db;
  current = { ...user };

  await db.insert(schema.companies).values([
    { id: COMPANY, name: "Acme", industry: "Manufacturing" },
    { id: OTHER, name: "Other", industry: "Retail" },
  ]);

  const requireAuth = (req: Request, _res: Response, next: NextFunction) => {
    req.user = current;
    next();
  };
  app = express();
  app.use(createWorkspaceModule({ db, requireAuth }).router);
});

const api = () => supertest(app);
const withCompany = (r: supertest.Test) => r.set("x-client-id", COMPANY);

describe("page state over HTTP", () => {
  it("saves, reads back and clears", async () => {
    await withCompany(api().put("/workspace-page-state/cim-prep"))
      .send({ state: { step: 2 } })
      .expect(200);

    const read = await withCompany(api().get("/workspace-page-state/cim-prep")).expect(200);
    expect(read.body).toMatchObject({ success: true, userId: USER });
    expect(read.body.state).toEqual({ step: 2 });

    await withCompany(api().delete("/workspace-page-state/cim-prep")).expect(200);
    expect((await withCompany(api().get("/workspace-page-state/cim-prep")).expect(200)).body.state).toBeNull();
  });

  it("updates on a second save rather than violating the unique constraint", async () => {
    // (company_id, page_key) is UNIQUE. This is the assertion the in-memory
    // repository is structurally incapable of failing.
    await withCompany(api().put("/workspace-page-state/k")).send({ state: { v: 1 } }).expect(200);
    await withCompany(api().put("/workspace-page-state/k")).send({ state: { v: 2 } }).expect(200);

    expect((await withCompany(api().get("/workspace-page-state/k")).expect(200)).body.state).toEqual({ v: 2 });
    expect(await db.select().from(schema.workspacePageState)).toHaveLength(1);
  });

  it("stores JSON of any shape, because the server does not read it", async () => {
    const payload = { nested: { list: [1, "two", null], flag: true } };
    await withCompany(api().put("/workspace-page-state/k")).send({ state: payload }).expect(200);
    expect((await withCompany(api().get("/workspace-page-state/k")).expect(200)).body.state).toEqual(payload);
  });
});

describe("the questionnaire over HTTP", () => {
  it("is shared: one user writes it and another reads it", async () => {
    await withCompany(api().put("/cim-questionnaire")).send({ state: { items: { q1: "a" } } }).expect(200);

    current = { ...user, id: "22222222-2222-2222-2222-222222222222", role: "buyer" };
    const read = await withCompany(api().get("/cim-questionnaire")).expect(200);
    expect(read.body.state.items).toEqual({ q1: "a" });
  });

  it("does not collide with a page state of the same name", async () => {
    // One is key-scoped by user and the other is not; they must be two rows.
    await withCompany(api().put("/cim-questionnaire")).send({ state: { items: { q: "shared" } } }).expect(200);
    await withCompany(api().put("/workspace-page-state/cim-questionnaire"))
      .send({ state: { mine: true } })
      .expect(200);

    expect(await db.select().from(schema.workspacePageState)).toHaveLength(2);
    expect((await withCompany(api().get("/cim-questionnaire")).expect(200)).body.state.items).toEqual({
      q: "shared",
    });
  });
});

describe("resolving the company", () => {
  it("accepts a query parameter", async () => {
    await api().put(`/workspace-page-state/k?clientId=${COMPANY}`).send({ state: { a: 1 } }).expect(200);
  });

  it("accepts a workspace Referer", async () => {
    await api()
      .get("/workspace-page-state/k")
      .set("referer", `https://app.example.com/workspace/${COMPANY}/cim`)
      .expect(200);
  });

  it("400s when there is no company anywhere", async () => {
    const res = await api().get("/workspace-page-state/k").expect(400);
    // Legacy's envelope, which the SPA reads.
    expect(res.body).toEqual({ success: false, error: "Missing clientId." });
  });

  it("403s a company the caller is not on", async () => {
    await api().get("/workspace-page-state/k").set("x-client-id", OTHER).expect(403);
  });

  it("reads header, then query, then Referer", () => {
    const req = (over: Partial<Request>): Request => ({ headers: {}, query: {}, ...over }) as Request;
    expect(resolveCompanyId(req({ headers: { "x-client-id": "h" }, query: { clientId: "q" } }))).toBe("h");
    expect(resolveCompanyId(req({ query: { clientId: "q" } }))).toBe("q");
    expect(resolveCompanyId(req({ headers: { referer: "https://x/client/r/page" } }))).toBe("r");
    expect(resolveCompanyId(req({ headers: { referer: "https://x/nothing" } }))).toBeUndefined();
    expect(resolveCompanyId(req({}))).toBeUndefined();
    // Blank is not a value.
    expect(resolveCompanyId(req({ headers: { "x-client-id": "  " } }))).toBeUndefined();
  });
});
