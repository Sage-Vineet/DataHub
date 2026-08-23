import express from "express";
import type { RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { ForbiddenError, NotFoundError } from "../../shared/errors.js";
import { createChartOfAccountsRouter, readPatch } from "./router.js";
import type { ChartOfAccountsService } from "./service.js";

/**
 * The HTTP contract.
 *
 * The service is tested against a fake repository elsewhere; what is left here
 * is what only the router decides — which body fields become a patch, what a
 * domain error turns into on the wire, and that the envelope carries `success`,
 * which the Key Reports screens check before reading anything else.
 */

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

/** A service where every method is scripted and every call recorded. */
function stub(over: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record =
    <T>(method: string, result: T) =>
    (...args: unknown[]): Promise<T> => {
      calls.push({ method, args });
      return Promise.resolve(result);
    };

  const service = {
    list: record("list", { versionId: "v1", flat: [], tree: [], accountCount: 0 }),
    history: record("history", { adjustments: [], classificationHistory: [] }),
    hierarchyLevels: record("hierarchyLevels", []),
    updateAccount: record("updateAccount", { id: "a1" }),
    resetAccount: record("resetAccount", { id: "a1" }),
    saveHierarchy: record("saveHierarchy", { updated: 2 }),
    resetVersion: record("resetVersion", { reset: 3 }),
    ...over,
  } as unknown as ChartOfAccountsService;

  const app = express();
  app.use(createChartOfAccountsRouter({ service, requireAuth: authAs("user-1") }));
  return { app, calls, service };
}

const lastArgs = (calls: Array<{ method: string; args: unknown[] }>, method: string) =>
  calls.filter((c) => c.method === method).at(-1)!.args;

describe("reading", () => {
  it("returns the chart under a success envelope", async () => {
    const { app } = stub();
    const res = await request(app).get("/key-reports/versions/v1/chart-of-accounts").expect(200);
    expect(res.body).toMatchObject({ success: true, versionId: "v1", accountCount: 0 });
  });

  it("returns both audit trails", async () => {
    const { app } = stub();
    const res = await request(app)
      .get("/key-reports/versions/v1/chart-of-accounts/history")
      .expect(200);
    expect(res.body).toMatchObject({ success: true, adjustments: [], classificationHistory: [] });
  });

  it("returns the hierarchy vocabulary", async () => {
    const { app } = stub();
    const res = await request(app).get("/key-reports/hierarchy-levels").expect(200);
    expect(res.body).toEqual({ success: true, levels: [] });
  });
});

describe("turning a body into a patch", () => {
  it("passes through the fields an edit may set", async () => {
    const { app, calls } = stub();
    await request(app)
      .patch("/key-reports/chart-of-accounts/a1")
      .send({
        adjustedName: "Renamed",
        accountType: "asset",
        statementType: "balance_sheet",
        isActive: false,
        movedParent: true,
        levels: ["A", "B"],
      })
      .expect(200);

    expect(lastArgs(calls, "updateAccount")[2]).toEqual({
      adjustedName: "Renamed",
      accountType: "asset",
      statementType: "balance_sheet",
      isActive: false,
      movedParent: true,
      levels: ["A", "B"],
    });
  });

  it("ignores fields an edit may not set", async () => {
    // A caller must not be able to rewrite `originalName` — that is what reset
    // restores from — or claim somebody else made the change.
    const { app, calls } = stub();
    await request(app)
      .patch("/key-reports/chart-of-accounts/a1")
      .send({ originalName: "forged", changedBy: "someone-else", versionId: "other" })
      .expect(200);

    expect(lastArgs(calls, "updateAccount")[2]).toEqual({});
  });

  it("coerces a stray level entry to null rather than into the hierarchy path", () => {
    expect(readPatch({ levels: ["A", 7, null, "", { x: 1 }, "B"] })).toEqual({
      levels: ["A", null, null, null, null, "B"],
    });
  });

  it("ignores a wrongly-typed scalar rather than passing it on", () => {
    expect(readPatch({ adjustedName: 5, isActive: "yes", movedParent: "true" })).toEqual({});
  });

  it("tolerates no body at all", () => {
    expect(readPatch(undefined)).toEqual({});
    expect(readPatch(null)).toEqual({});
  });
});

describe("editing and resetting", () => {
  it("returns the updated account", async () => {
    const { app } = stub();
    const res = await request(app).patch("/key-reports/chart-of-accounts/a1").send({}).expect(200);
    expect(res.body).toEqual({ success: true, account: { id: "a1" } });
  });

  it("resets one account", async () => {
    const { app, calls } = stub();
    await request(app).post("/key-reports/chart-of-accounts/a1/reset").expect(200);
    expect(lastArgs(calls, "resetAccount")[1]).toBe("a1");
  });

  it("returns the refreshed chart with a bulk save, so the grid need not refetch", async () => {
    const { app, calls } = stub();
    const res = await request(app)
      .post("/key-reports/versions/v1/chart-of-accounts/save")
      .send({ nodes: [{ accountId: "a1", adjustedName: "X" }] })
      .expect(200);

    expect(res.body).toMatchObject({ success: true, updated: 2, versionId: "v1" });
    expect(lastArgs(calls, "saveHierarchy")[2]).toHaveLength(1);
  });

  it("treats a missing or malformed `nodes` as an empty batch", async () => {
    const { app, calls } = stub();
    await request(app).post("/key-reports/versions/v1/chart-of-accounts/save").send({}).expect(200);
    await request(app)
      .post("/key-reports/versions/v1/chart-of-accounts/save")
      .send({ nodes: "not an array" })
      .expect(200);

    for (const call of calls.filter((c) => c.method === "saveHierarchy")) {
      expect(call.args[2]).toEqual([]);
    }
  });

  it("resets a whole version and returns the refreshed chart", async () => {
    const { app } = stub();
    const res = await request(app)
      .post("/key-reports/versions/v1/chart-of-accounts/reset")
      .expect(200);
    expect(res.body).toMatchObject({ success: true, reset: 3, versionId: "v1" });
  });
});

describe("what a domain error becomes on the wire", () => {
  it("404s a missing version, in legacy's envelope", async () => {
    const { app } = stub({
      list: () => Promise.reject(new NotFoundError("Report version not found.")),
    });
    const res = await request(app).get("/key-reports/versions/nope/chart-of-accounts").expect(404);
    // `success: false`, not a bare `{ error }` — the screens read `success`.
    expect(res.body).toEqual({ success: false, error: "Report version not found." });
  });

  it("403s a company the caller is not on", async () => {
    const { app } = stub({ list: () => Promise.reject(new ForbiddenError("denied")) });
    await request(app).get("/key-reports/versions/v1/chart-of-accounts").expect(403);
  });

  it("passes an unexpected failure to the error handler rather than reporting success", async () => {
    const { app } = stub({ list: () => Promise.reject(new Error("boom")) });
    await request(app).get("/key-reports/versions/v1/chart-of-accounts").expect(500);
  });
});

describe("paths this router does not own", () => {
  it("leaves them alone so they can reach the proxy", async () => {
    const { app } = stub();
    await request(app).get("/key-reports/versions/v1/mappings").expect(404);
    await request(app).get("/companies/x/folders").expect(404);
  });
});
