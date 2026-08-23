import express from "express";
import type { RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../shared/errors.js";
import { createBankReconciliationRouter } from "./router.js";
import type { BankReconciliationService } from "./service.js";

/**
 * The bank-reconciliation HTTP contract.
 *
 * The service decides what is valid; this covers what the router decides —
 * where the company comes from, how a query string becomes a filter, and that
 * a failure arrives as `{ success: false }` rather than as a bare error, since
 * the grid checks `success` before reading anything.
 */

const COMPANY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ITEM = "11111111-1111-4111-8111-111111111111";

const authAs = (id: string): RequestHandler => (req, _res, next) => {
  req.user = {
    id,
    name: "Dana",
    email: "dana@example.test",
    role: "broker",
    company_id: null,
    status: "active",
    company_ids: [COMPANY],
  };
  next();
};

function stub(over: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record =
    <T>(method: string, result: T) =>
    (...args: unknown[]): Promise<T> => {
      calls.push({ method, args });
      return Promise.resolve(result);
    };

  const service = {
    listAdjustments: record("listAdjustments", [{ month: "2024-03", rowKey: "d", amount: 1 }]),
    setAdjustment: record("setAdjustment", undefined),
    listAddbackItems: record("listAddbackItems", [{ id: ITEM, name: "Owner salary" }]),
    createAddbackItem: record("createAddbackItem", { id: ITEM, name: "Owner salary" }),
    updateAddbackItemAmounts: record("updateAddbackItemAmounts", undefined),
    deleteAddbackItem: record("deleteAddbackItem", undefined),
    ...over,
  } as unknown as BankReconciliationService;

  const app = express();
  app.use(createBankReconciliationRouter({ service, requireAuth: authAs("caller-1") }));
  return { app, calls };
}

const argsOf = (calls: Array<{ method: string; args: unknown[] }>, method: string) =>
  calls.filter((c) => c.method === method).at(-1)!.args;

describe("where the company comes from", () => {
  it("accepts the header, the query string and the body", async () => {
    // Different screens supply it differently, and legacy took all three.
    const { app, calls } = stub();
    await request(app)
      .get("/bank-reconciliation-adjustments")
      .set("x-client-id", COMPANY)
      .expect(200);
    await request(app).get(`/bank-reconciliation-adjustments?clientId=${COMPANY}`).expect(200);
    await request(app)
      .post("/bank-reconciliation-adjustments")
      .send({ clientId: COMPANY, month: "2024-03", rowKey: "d", amount: 1 })
      .expect(200);

    expect(argsOf(calls, "listAdjustments")[1]).toBe(COMPANY);
    expect(argsOf(calls, "setAdjustment")[1]).toBe(COMPANY);
  });

  it("prefers the header when both are present", async () => {
    // The header is what the SPA sets on every request; a stale query string
    // on a bookmarked URL must not win over it.
    const { app, calls } = stub();
    await request(app)
      .get("/bank-reconciliation-adjustments?clientId=99999999-9999-4999-8999-999999999999")
      .set("x-client-id", COMPANY)
      .expect(200);
    expect(argsOf(calls, "listAdjustments")[1]).toBe(COMPANY);
  });

  it("passes an absent company down as empty, for the service to refuse", async () => {
    const { app } = stub({
      listAdjustments: () => Promise.reject(new BadRequestError("Missing clientId")),
    });
    const res = await request(app).get("/bank-reconciliation-adjustments").expect(400);
    expect(res.body).toEqual({ success: false, error: "Missing clientId" });
  });
});

describe("adjustments", () => {
  it("answers under the envelope the grid checks", async () => {
    const { app } = stub();
    const res = await request(app)
      .get("/bank-reconciliation-adjustments")
      .set("x-client-id", COMPANY)
      .expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.adjustments).toHaveLength(1);
  });

  it("passes the cell through untouched, including an empty amount", async () => {
    // Coercion belongs in the service, so one place decides what "" means.
    const { app, calls } = stub();
    await request(app)
      .post("/bank-reconciliation-adjustments")
      .set("x-client-id", COMPANY)
      .send({ month: "2024-03", rowKey: "fees", amount: "" })
      .expect(200);
    expect(argsOf(calls, "setAdjustment")[2]).toEqual({
      month: "2024-03",
      rowKey: "fees",
      amount: "",
    });
  });
});

describe("add-back items", () => {
  it("passes the report source and section as a filter", async () => {
    const { app, calls } = stub();
    await request(app)
      .get("/bank-reconciliation-addback-items?reportSource=quickbooks_online&section=deposits")
      .set("x-client-id", COMPANY)
      .expect(200);
    expect(argsOf(calls, "listAddbackItems")[2]).toEqual({
      reportSource: "quickbooks_online",
      section: "deposits",
    });
  });

  it("omits the section entirely when none is given", async () => {
    // An explicit `undefined` section would filter on undefined rather than
    // not filtering at all.
    const { app, calls } = stub();
    await request(app)
      .get("/bank-reconciliation-addback-items?reportSource=quickbooks_online")
      .set("x-client-id", COMPANY)
      .expect(200);
    expect(argsOf(calls, "listAddbackItems")[2]).toEqual({
      reportSource: "quickbooks_online",
    });
  });

  it("creates one and answers with it", async () => {
    const { app, calls } = stub();
    const res = await request(app)
      .post("/bank-reconciliation-addback-items")
      .set("x-client-id", COMPANY)
      .send({
        section: "deposits",
        name: "Owner salary",
        monthAmounts: { "2024-01": 1000 },
        reportSource: "quickbooks_online",
      })
      .expect(200);
    expect(res.body.item.name).toBe("Owner salary");
    expect(argsOf(calls, "createAddbackItem")[2]).toMatchObject({
      section: "deposits",
      name: "Owner salary",
      monthAmounts: { "2024-01": 1000 },
    });
  });

  it("drops a month amount that is not a number", async () => {
    // The grid can send "" for a cleared month; a NaN reaching a jsonb column
    // serialises as null and reads back as a zero nobody typed.
    const { app, calls } = stub();
    await request(app)
      .post("/bank-reconciliation-addback-items")
      .set("x-client-id", COMPANY)
      .send({
        section: "deposits",
        name: "Owner salary",
        monthAmounts: { "2024-01": 1000, "2024-02": "", "2024-03": "abc" },
        reportSource: "quickbooks_online",
      })
      .expect(200);
    expect(argsOf(calls, "createAddbackItem")[2]).toMatchObject({
      monthAmounts: { "2024-01": 1000 },
    });
  });

  it("edits and deletes one, addressed by id", async () => {
    const { app, calls } = stub();
    await request(app)
      .put(`/bank-reconciliation-addback-items/${ITEM}`)
      .set("x-client-id", COMPANY)
      .send({ monthAmounts: { "2024-02": 250 } })
      .expect(200);
    await request(app)
      .delete(`/bank-reconciliation-addback-items/${ITEM}`)
      .set("x-client-id", COMPANY)
      .expect(200);

    expect(argsOf(calls, "updateAddbackItemAmounts")[2]).toBe(ITEM);
    expect(argsOf(calls, "updateAddbackItemAmounts")[3]).toEqual({ "2024-02": 250 });
    expect(argsOf(calls, "deleteAddbackItem")[2]).toBe(ITEM);
  });

  it("sends an empty map when the body carries no amounts", async () => {
    const { app, calls } = stub();
    await request(app)
      .put(`/bank-reconciliation-addback-items/${ITEM}`)
      .set("x-client-id", COMPANY)
      .send({})
      .expect(200);
    expect(argsOf(calls, "updateAddbackItemAmounts")[3]).toEqual({});
  });
});

describe("what a failure looks like on the wire", () => {
  it("carries success:false with the status, on every failure", async () => {
    for (const [err, status] of [
      [new BadRequestError("Missing reportSource"), 400],
      [new ForbiddenError("Access denied"), 403],
      [new NotFoundError("Add-back item not found."), 404],
    ] as const) {
      const { app } = stub({ deleteAddbackItem: () => Promise.reject(err) });
      const res = await request(app)
        .delete(`/bank-reconciliation-addback-items/${ITEM}`)
        .set("x-client-id", COMPANY)
        .expect(status);
      expect(res.body).toEqual({ success: false, error: err.message });
    }
  });

  it("passes an unexpected failure on rather than reporting success", async () => {
    const { app } = stub({ listAdjustments: () => Promise.reject(new Error("boom")) });
    await request(app)
      .get("/bank-reconciliation-adjustments")
      .set("x-client-id", COMPANY)
      .expect(500);
  });
});

describe("paths this router does not own", () => {
  it("leaves them for the proxy", async () => {
    const { app } = stub();
    await request(app).get("/bank-reconciliation-report").expect(404);
    await request(app).get("/extract-bank-pdf-records").expect(404);
  });
});
