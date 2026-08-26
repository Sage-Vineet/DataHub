import express from "express";
import type { RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { ForbiddenError, NotFoundError } from "../../shared/errors.js";
import { createQoeRouter } from "./router.js";
import type { QoeService } from "./service.js";

/**
 * The `/qoe` HTTP contract.
 *
 * Every read takes its version and period selection from the query string, and
 * a request that names no version must be refused rather than answered for some
 * default — a bridge silently computed for the wrong engagement is the failure
 * mode worth spending a test on.
 */

const VERSION = "vvvvvvvv-vvvv-4vvv-8vvv-vvvvvvvvvvvv";

const authAs = (id: string): RequestHandler => (req, _res, next) => {
  req.user = {
    id,
    name: "Dana",
    email: "dana@example.test",
    role: "broker",
    company_id: null,
    status: "active",
    company_ids: [],
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
    bridge: record("bridge", { periods: [] }),
    balanceSheet: record("balanceSheet", { lines: [] }),
    incomeStatement: record("incomeStatement", { periods: [] }),
    trialBalance: record("trialBalance", { rows: [] }),
    listAddbacks: record("listAddbacks", []),
    createAddback: record("createAddback", { id: "ab1" }),
    deleteAddback: record("deleteAddback", undefined),
    draftCommentary: record("draftCommentary", { commentary: "draft" }),
    saveCommentary: record("saveCommentary", { id: "ab1" }),
    setAccountClassification: record("setAccountClassification", undefined),
    setAccountRole: record("setAccountRole", undefined),
    ...over,
  } as unknown as QoeService;

  const app = express();
  app.use(createQoeRouter({ service, requireAuth: authAs("caller-1") }));
  return { app, calls };
}

const argsOf = (calls: Array<{ method: string; args: unknown[] }>, method: string) =>
  calls.filter((c) => c.method === method).at(-1)!.args;

describe("the statements", () => {
  it("serves the bridge, balance sheet, income statement and trial balance", async () => {
    const { app, calls } = stub();
    for (const path of ["bridge", "balance-sheet", "income-statement", "trial-balance"]) {
      await request(app).get(`/qoe/${path}?version_id=${VERSION}`).expect(200);
    }
    expect(calls.map((c) => c.method)).toEqual([
      "bridge",
      "balanceSheet",
      "incomeStatement",
      "trialBalance",
    ]);
  });

  it("refuses a request that names no version", async () => {
    // Answering for some default would compute a bridge for the wrong
    // engagement and look entirely normal doing it.
    const { app, calls } = stub();
    for (const path of ["bridge", "balance-sheet", "income-statement", "trial-balance"]) {
      await request(app).get(`/qoe/${path}`).expect(400);
    }
    expect(calls).toEqual([]);
  });

  it("defaults the aggregation to annual rather than leaving it unset", async () => {
    const { app, calls } = stub();
    await request(app).get(`/qoe/bridge?version_id=${VERSION}`).expect(200);
    expect(argsOf(calls, "bridge")[2]).toMatchObject({ aggregation: "annual" });
  });

  it("passes an explicit aggregation and year selection through", async () => {
    const { app, calls } = stub();
    await request(app)
      .get(`/qoe/bridge?version_id=${VERSION}&aggregation=monthly&years=2023,2024`)
      .expect(200);
    expect(argsOf(calls, "bridge")[2]).toMatchObject({
      aggregation: "monthly",
      years: [2023, 2024],
    });
  });

  it("400s an aggregation it does not recognise", async () => {
    const { app } = stub();
    await request(app).get(`/qoe/bridge?version_id=${VERSION}&aggregation=hourly`).expect(400);
  });
});

describe("add-backs", () => {
  it("lists them for a version", async () => {
    const { app, calls } = stub();
    await request(app).get(`/qoe/addbacks?version_id=${VERSION}`).expect(200);
    expect(argsOf(calls, "listAddbacks")[1]).toBe(VERSION);
  });

  it("400s a list with no version", async () => {
    const { app } = stub();
    const res = await request(app).get("/qoe/addbacks").expect(400);
    expect(res.body.error).toMatch(/version_id/);
  });

  it("400s a create the contract rejects", async () => {
    const { app, calls } = stub();
    await request(app).post("/qoe/addbacks").send({}).expect(400);
    expect(calls).toEqual([]);
  });

  it("deletes one", async () => {
    const { app, calls } = stub();
    await request(app).delete("/qoe/addbacks/ab1").expect(204);
    expect(argsOf(calls, "deleteAddback")[1]).toBe("ab1");
  });
});

describe("commentary", () => {
  it("drafts and saves against the same add-back", async () => {
    const { app, calls } = stub();
    await request(app).post("/qoe/addbacks/ab1/commentary/draft").send({}).expect(200);
    await request(app).put("/qoe/addbacks/ab1/commentary").send({ commentary: "Final" }).expect(200);

    expect(calls.map((c) => c.method)).toEqual(["draftCommentary", "saveCommentary"]);
    for (const call of calls) expect(call.args).toContain("ab1");
  });
});

describe("what a domain error becomes on the wire", () => {
  it("403s an engagement the caller cannot see", async () => {
    const { app } = stub({ bridge: () => Promise.reject(new ForbiddenError("denied")) });
    await request(app).get(`/qoe/bridge?version_id=${VERSION}`).expect(403);
  });

  it("404s a version that does not exist", async () => {
    const { app } = stub({ bridge: () => Promise.reject(new NotFoundError("Not found")) });
    await request(app).get(`/qoe/bridge?version_id=${VERSION}`).expect(404);
  });

  it("passes an unexpected failure on", async () => {
    const { app } = stub({ bridge: () => Promise.reject(new Error("boom")) });
    await request(app).get(`/qoe/bridge?version_id=${VERSION}`).expect(500);
  });
});
