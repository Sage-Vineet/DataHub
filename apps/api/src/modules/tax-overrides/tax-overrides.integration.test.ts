import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionUser } from "@datahub/contracts";
import { createSchemaDb, schema, type Db } from "@datahub/db";
import { createTaxOverridesModule } from "./index.js";
import type { TaxOverridesService } from "./service.js";

/**
 * Hand corrections to a tax reconciliation, against real Postgres.
 *
 * The two things worth proving against a real database rather than a fake:
 * that a save REPLACES (a cell removed on screen stays removed), and that the
 * per-cell unique index holds — legacy stored one blob per company, so neither
 * property existed to break.
 */

const BROKER: SessionUser = {
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  name: "Bea",
  email: "bea@example.test",
  role: "broker",
  company_id: null,
  status: "active",
  company_ids: [],
};

let client: PGlite;
let db: Db;
let app: express.Express;
let service: TaxOverridesService;
let companyId: string;
let current: SessionUser;

beforeEach(async () => {
  client = await createSchemaDb();
  db = drizzle(client, { schema }) as unknown as Db;
  companyId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  current = { ...BROKER, company_ids: [companyId] };

  await db.insert(schema.companies).values({ id: companyId, name: "Acme", industry: "" });
  await db.insert(schema.users).values({
    id: BROKER.id,
    name: BROKER.name,
    email: BROKER.email,
    role: "broker",
    passwordHash: "!",
  });

  const requireAuth = (req: Request, _res: Response, next: NextFunction) => {
    req.user = current;
    next();
  };
  app = express();
  const module = createTaxOverridesModule({ db, requireAuth });
  app.use("/", module.router);
  service = module.service;
});

afterEach(async () => {
  await client.close();
});

const PATH = "/manual-report-uploads/tax-reconciliation-overrides";

const save = (overrides: unknown) =>
  request(app).put(PATH).set("X-Client-Id", companyId).send({ overrides });

const load = () => request(app).get(PATH).set("X-Client-Id", companyId);

describe("tax reconciliation overrides (real Postgres)", () => {
  it("stores a correction and reads it back in the page's shape", async () => {
    await save({ "2024": { "Meals & Entertainment": { taxReturn: 1200, pl: 900 } } }).expect(200);

    const res = await load().expect(200);
    expect(res.body.overrides).toEqual({
      "2024": { "Meals & Entertainment": { taxReturn: 1200, pl: 900 } },
    });
    expect(res.body.updatedAt).toBeTruthy();
  });

  it("replaces rather than merging, so a removed line stays removed", async () => {
    // The property legacy's single blob could not have got wrong and an upsert
    // would: the page sends the whole map, so a cell absent from it has been
    // deleted. Merging would bring it back on the next load, and removing it
    // again would not help.
    await save({
      "2024": { Meals: { taxReturn: 1200, pl: 900 }, Travel: { taxReturn: 300, pl: 250 } },
    }).expect(200);
    await save({ "2024": { Meals: { taxReturn: 1200, pl: 900 } } }).expect(200);

    const res = await load().expect(200);
    expect(Object.keys(res.body.overrides["2024"])).toEqual(["Meals"]);
  });

  it("clears every correction when the page sends an empty map", async () => {
    await save({ "2024": { Meals: { taxReturn: 1200, pl: 900 } } }).expect(200);
    await save({}).expect(200);
    const res = await load().expect(200);
    expect(res.body.overrides).toEqual({});
    expect(res.body.updatedAt).toBeNull();
  });

  it("keeps a cleared field apart from a zero, all the way to the column", async () => {
    // Cleared means "use what was extracted"; zero means "this line really is
    // nil". A numeric column stores both, and collapsing them at any layer
    // turns every cleared cell into a claim that the figure is nothing.
    await save({ "2024": { Meals: { taxReturn: "", pl: 0 } } }).expect(200);
    const res = await load().expect(200);
    expect(res.body.overrides["2024"].Meals).toEqual({ taxReturn: null, pl: 0 });
  });

  it("keeps the cents", async () => {
    await save({ "2024": { Meals: { taxReturn: 1234.56, pl: -78.9 } } }).expect(200);
    const res = await load().expect(200);
    expect(res.body.overrides["2024"].Meals).toEqual({ taxReturn: 1234.56, pl: -78.9 });
  });

  it("holds one correction per line per year", async () => {
    // Two rows for one cell would leave the reconciliation picking whichever
    // came back first. The page can genuinely send a duplicate — a label
    // edited into one that already exists — so last wins rather than failing.
    await save({
      "2024": { Meals: { taxReturn: 1, pl: 1 } },
    }).expect(200);
    await service.replaceAll(current, companyId, [
      { fiscalYear: 2024, lineLabel: "Meals", taxReturnAmount: 1, bookAmount: 1, userAdded: false },
      { fiscalYear: 2024, lineLabel: "Meals", taxReturnAmount: 2, bookAmount: 2, userAdded: false },
    ]);

    const stored = await db.select().from(schema.taxReconciliationOverrides);
    expect(stored).toHaveLength(1);
    expect(Number(stored[0]!.taxReturnAmount)).toBe(2);
  });

  it("keeps the years apart", async () => {
    await save({
      "2023": { Meals: { taxReturn: 100, pl: 90 } },
      "2024": { Meals: { taxReturn: 200, pl: 180 } },
    }).expect(200);
    const res = await load().expect(200);
    expect(res.body.overrides["2023"].Meals.taxReturn).toBe(100);
    expect(res.body.overrides["2024"].Meals.taxReturn).toBe(200);
  });

  it("records who made the correction", async () => {
    // These are manual adjustments to figures that reach a valuation. "Who
    // changed this, and when" is the first question about a number that moved,
    // and legacy's one blob per company could not answer it for any cell.
    await save({ "2024": { Meals: { taxReturn: 1200, pl: 900 } } }).expect(200);
    const [row] = await db.select().from(schema.taxReconciliationOverrides);
    expect(row!.updatedBy).toBe(BROKER.id);
  });

  it("carries the user-added flag through storage", async () => {
    await save({ "2024": { "Officer Life Insurance": { pl: 4200, userAdded: true } } }).expect(200);
    const res = await load().expect(200);
    expect(res.body.overrides["2024"]["Officer Life Insurance"].userAdded).toBe(true);
  });

  it("answers with what was stored, not with what was sent", async () => {
    // The page has just rewritten its own map; answering with the saved state
    // is what lets it notice a cell that did not survive.
    const res = await save({ "2024": { "  ": { taxReturn: 1 }, Meals: { taxReturn: 2 } } }).expect(
      200,
    );
    expect(Object.keys(res.body.overrides["2024"])).toEqual(["Meals"]);
  });

  it("keeps one company's corrections off another's page", async () => {
    const other = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    await db.insert(schema.companies).values({ id: other, name: "Beta", industry: "" });
    current = { ...current, company_ids: [companyId, other] };

    await save({ "2024": { Meals: { taxReturn: 100, pl: 90 } } }).expect(200);
    const res = await request(app).get(PATH).set("X-Client-Id", other).expect(200);
    expect(res.body.overrides).toEqual({});
  });

  it("does not wipe another company when one is saved", async () => {
    // The replace is scoped to the company. Without the WHERE it would empty
    // the table, and the only sign would be every other client's corrections
    // quietly gone.
    const other = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    await db.insert(schema.companies).values({ id: other, name: "Beta", industry: "" });
    current = { ...current, company_ids: [companyId, other] };

    await save({ "2024": { Meals: { taxReturn: 100, pl: 90 } } }).expect(200);
    await request(app)
      .put(PATH)
      .set("X-Client-Id", other)
      .send({ overrides: { "2024": { Travel: { taxReturn: 5, pl: 5 } } } })
      .expect(200);

    const res = await load().expect(200);
    expect(res.body.overrides["2024"].Meals.taxReturn).toBe(100);
  });

  it("403s a company the caller cannot reach", async () => {
    const stranger = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    await request(app).get(PATH).set("X-Client-Id", stranger).expect(403);
    await request(app)
      .put(PATH)
      .set("X-Client-Id", stranger)
      .send({ overrides: {} })
      .expect(403);
  });

  it("400s without a company", async () => {
    await request(app).get(PATH).expect(400);
  });

  it("400s on a body that is not an override map", async () => {
    await request(app).put(PATH).set("X-Client-Id", companyId).send({}).expect(400);
    await save("everything").expect(400);
    await save({ recent: { Meals: {} } }).expect(400);
  });

  it("refuses a save far larger than any real reconciliation", async () => {
    // The page sends the whole map on every edit, so a runaway client would
    // rewrite every row each time. Refusing plainly beats writing tens of
    // thousands of rows in one transaction.
    //
    // Asserted at the service, because over HTTP the JSON body limit rejects a
    // map this size with a 413 before the count is ever counted. Both refusals
    // are wanted; they just catch it at different layers, and testing only the
    // outer one would leave the inner guard unexercised.
    const overrides = Array.from({ length: 5_001 }, (_, i) => ({
      fiscalYear: 2024,
      lineLabel: `Line ${i}`,
      taxReturnAmount: 1,
      bookAmount: null,
      userAdded: false,
    }));
    await expect(service.replaceAll(current, companyId, overrides)).rejects.toThrow(
      /Too many overrides/,
    );
    expect(await db.select().from(schema.taxReconciliationOverrides)).toEqual([]);
  });

  it("refuses a body too large to be a reconciliation at all", async () => {
    const lines: Record<string, unknown> = {};
    for (let i = 0; i < 5_001; i += 1) lines[`Line ${i}`] = { taxReturn: 1 };
    await save({ "2024": lines }).expect(413);
  });

  it("reports the most recent edit, not the oldest", async () => {
    // The page shows one "saved at" for the whole screen, and telling somebody
    // an earlier time would read as their save not having happened.
    await save({ "2024": { Meals: { taxReturn: 1 } } }).expect(200);
    const first = (await load().expect(200)).body.updatedAt as string;
    await save({
      "2024": { Meals: { taxReturn: 1 }, Travel: { taxReturn: 2 } },
    }).expect(200);
    const second = (await load().expect(200)).body.updatedAt as string;
    expect(second >= first).toBe(true);
  });
});
