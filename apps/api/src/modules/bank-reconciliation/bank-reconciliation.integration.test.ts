import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSchemaDb, schema, type Db } from "@datahub/db";
import type { SessionUser } from "@datahub/contracts";
import { createBankReconciliationModule } from "./index.js";

/**
 * The reconciliation grid against a real database.
 *
 * What only a real Postgres can prove: the unique index that makes saving a
 * cell an upsert, and that an update scoped to a company matches nothing when
 * the item belongs to another one — the two places where the schema, not the
 * code, is what keeps the behaviour honest.
 */

const BROKER: SessionUser = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "B",
  email: "b@x.com",
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
let otherId: string;

beforeEach(async () => {
  client = await createSchemaDb();
  db = drizzle(client, { schema }) as unknown as Db;
  await db.insert(schema.users).values({
    id: BROKER.id,
    name: BROKER.name,
    email: `${BROKER.id}@x.test`,
    passwordHash: "!",
    role: "broker",
  });
  companyId = randomUUID();
  otherId = randomUUID();
  await db.insert(schema.companies).values([
    { id: companyId, name: "Acme", industry: "" },
    { id: otherId, name: "Other", industry: "" },
  ]);
  current = { ...BROKER, company_ids: [companyId, otherId] };

  const requireAuth = (req: Request, _res: Response, next: NextFunction) => {
    req.user = current;
    next();
  };
  app = express();
  app.use("/", createBankReconciliationModule({ db, requireAuth }).router);
});

afterEach(async () => {
  await client.close();
});

const asCompany = (id: string) => (path: string) =>
  request(app).get(path).set("X-Client-Id", id);

describe("adjustments (real Postgres)", () => {
  it("saves a cell once, however many times the grid writes it", async () => {
    for (const amount of [10, 20, 30]) {
      await request(app)
        .post("/bank-reconciliation-adjustments")
        .set("X-Client-Id", companyId)
        .send({ month: "2024-03", rowKey: "deposits", amount })
        .expect(200);
    }

    const rows = await db.select().from(schema.bankReconciliationAdjustments);
    expect(rows).toHaveLength(1);

    const res = await asCompany(companyId)("/bank-reconciliation-adjustments").expect(200);
    expect(res.body.adjustments).toEqual([{ month: "2024-03", rowKey: "deposits", amount: 30 }]);
  });

  it("keeps a cell per (month, rowKey)", async () => {
    for (const [month, rowKey] of [
      ["2024-03", "deposits"],
      ["2024-03", "fees"],
      ["2024-04", "deposits"],
    ]) {
      await request(app)
        .post("/bank-reconciliation-adjustments")
        .set("X-Client-Id", companyId)
        .send({ month, rowKey, amount: 1 })
        .expect(200);
    }
    expect(await db.select().from(schema.bankReconciliationAdjustments)).toHaveLength(3);
  });

  it("round-trips a decimal without losing the cents", async () => {
    // The column is numeric(18,2) and comes back as a string.
    await request(app)
      .post("/bank-reconciliation-adjustments")
      .set("X-Client-Id", companyId)
      .send({ month: "2024-03", rowKey: "deposits", amount: 1234.56 })
      .expect(200);

    const res = await asCompany(companyId)("/bank-reconciliation-adjustments").expect(200);
    expect(res.body.adjustments[0].amount).toBeCloseTo(1234.56, 2);
  });

  it("keeps one company's grid out of another's", async () => {
    await request(app)
      .post("/bank-reconciliation-adjustments")
      .set("X-Client-Id", companyId)
      .send({ month: "2024-03", rowKey: "deposits", amount: 5 })
      .expect(200);

    const res = await asCompany(otherId)("/bank-reconciliation-adjustments").expect(200);
    expect(res.body.adjustments).toEqual([]);
  });

  it("403s a company the caller cannot reach", async () => {
    current = { ...BROKER, company_ids: [] };
    await asCompany(companyId)("/bank-reconciliation-adjustments").expect(403);
  });
});

describe("add-back items (real Postgres)", () => {
  const create = (id: string, over: Record<string, unknown> = {}) =>
    request(app)
      .post("/bank-reconciliation-addback-items")
      .set("X-Client-Id", id)
      .send({
        section: "deposits",
        name: "Owner salary",
        monthAmounts: { "2024-01": 1000 },
        reportSource: "quickbooks_online",
        ...over,
      });

  it("creates, lists and edits one", async () => {
    const created = await create(companyId).expect(200);
    const id = created.body.item.id as string;
    expect(created.body.item.source).toBe("manual");

    await request(app)
      .put(`/bank-reconciliation-addback-items/${id}`)
      .set("X-Client-Id", companyId)
      .send({ monthAmounts: { "2024-02": 250.75 } })
      .expect(200);

    const listed = await asCompany(companyId)(
      "/bank-reconciliation-addback-items?reportSource=quickbooks_online",
    ).expect(200);
    expect(listed.body.items[0].monthAmounts).toEqual({ "2024-02": 250.75 });
  });

  it("filters by report source and section", async () => {
    await create(companyId).expect(200);
    await create(companyId, { name: "Interest", section: "withdrawals" }).expect(200);
    await create(companyId, { name: "Elsewhere", reportSource: "manual_upload" }).expect(200);

    const operating = await asCompany(companyId)(
      "/bank-reconciliation-addback-items?reportSource=quickbooks_online&section=deposits",
    ).expect(200);
    expect(operating.body.items.map((i: { name: string }) => i.name)).toEqual(["Owner salary"]);

    const allQb = await asCompany(companyId)(
      "/bank-reconciliation-addback-items?reportSource=quickbooks_online",
    ).expect(200);
    expect(allQb.body.items).toHaveLength(2);
  });

  it("400s a listing that names no report source", async () => {
    await asCompany(companyId)("/bank-reconciliation-addback-items").expect(400);
  });

  it("404s an edit to another company's item, and does not change it", async () => {
    // The company is in the WHERE clause, so the update matches nothing — and
    // reporting that as success is what let a silent no-op look like a save.
    const created = await create(companyId).expect(200);
    const id = created.body.item.id as string;

    await request(app)
      .put(`/bank-reconciliation-addback-items/${id}`)
      .set("X-Client-Id", otherId)
      .send({ monthAmounts: { "2024-02": 999 } })
      .expect(404);

    const listed = await asCompany(companyId)(
      "/bank-reconciliation-addback-items?reportSource=quickbooks_online",
    ).expect(200);
    expect(listed.body.items[0].monthAmounts).toEqual({ "2024-01": 1000 });
  });

  it("404s an edit to an item that is gone", async () => {
    const created = await create(companyId).expect(200);
    const id = created.body.item.id as string;

    await request(app)
      .delete(`/bank-reconciliation-addback-items/${id}`)
      .set("X-Client-Id", companyId)
      .expect(200);
    await request(app)
      .put(`/bank-reconciliation-addback-items/${id}`)
      .set("X-Client-Id", companyId)
      .send({ monthAmounts: { "2024-02": 1 } })
      .expect(404);
  });

  it("404s a delete of another company's item, and leaves it in place", async () => {
    const created = await create(companyId).expect(200);
    const id = created.body.item.id as string;

    await request(app)
      .delete(`/bank-reconciliation-addback-items/${id}`)
      .set("X-Client-Id", otherId)
      .expect(404);

    const listed = await asCompany(companyId)(
      "/bank-reconciliation-addback-items?reportSource=quickbooks_online",
    ).expect(200);
    expect(listed.body.items).toHaveLength(1);
  });

  it("orders by sort order, then by when it was created", async () => {
    // `sort_order` defaults to 0 for everything, so without the tiebreak the
    // order a reader sees would shuffle between requests.
    await create(companyId, { name: "First" }).expect(200);
    await create(companyId, { name: "Second" }).expect(200);
    await create(companyId, { name: "Third" }).expect(200);

    const listed = await asCompany(companyId)(
      "/bank-reconciliation-addback-items?reportSource=quickbooks_online",
    ).expect(200);
    expect(listed.body.items.map((i: { name: string }) => i.name)).toEqual([
      "First",
      "Second",
      "Third",
    ]);
  });
});
