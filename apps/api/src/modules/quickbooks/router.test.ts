import express from "express";
import type { RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { ForbiddenError, NotFoundError } from "../../shared/errors.js";
import { QuickBooksAuthError, QuickBooksRequestError } from "./reports/client.js";
import type { QuickBooksEntitiesService } from "./reports/entities.js";
import type { QuickBooksReportsService } from "./reports/service.js";
import type { QuickBooksSyncStatusService } from "./reports/status.js";
import type { QuickBooksSyncService } from "./reports/sync.js";
import { createQuickBooksRouter } from "./router.js";
import type { QuickBooksService } from "./service.js";

/**
 * The QuickBooks HTTP surface.
 *
 * Five report routes served by one handler, plus the entity and status reads.
 * What is worth testing here rather than at the service is the mapping from an
 * error to a STATUS — a rejected token and a bad report are different problems
 * with different fixes, and a page that shows "500" for both sends everybody to
 * the wrong place.
 */

const COMPANY = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const authAs = (id: string): RequestHandler => (req, _res, next) => {
  req.user = {
    id,
    name: "Uma",
    email: "uma@example.test",
    role: "broker",
    company_id: null,
    status: "active",
    company_ids: [COMPANY],
  };
  next();
};

const SERVED = {
  source: "cached_snapshot" as const,
  disconnected: false,
  lastSyncAt: "2024-06-01T00:00:00.000Z",
  datasetVersion: null,
  reportParams: { start_date: "2024-01-01" },
  data: { Header: {}, Rows: {} },
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
    status: record("status", { isConnected: true }),
    disconnect: record("disconnect", { isConnected: false }),
  } as unknown as QuickBooksService;

  const reports = {
    serve: record("serve", SERVED),
    syncGeneralLedger: record("syncGeneralLedger", { ...SERVED, totalInserted: 3 }),
    profitAndLossForTax: record("profitAndLossForTax", {
      startDate: "2024-01-01",
      endDate: "2024-12-31",
      data: [{ label: "Total Revenue", pl: 500000 }],
      source: "live_fetch",
    }),
    monthlyLineItems: record("monthlyLineItems", {
      plIncomeItems: [],
      plExpenseItems: [],
      plTotalIncome: {},
      plTotalExpenses: {},
      source: "live_fetch",
    }),
    ...(over.reports as object | undefined),
  } as unknown as QuickBooksReportsService;

  const syncStatus = {
    status: record("status", { companyId: COMPANY, syncStatus: "idle" }),
  } as unknown as QuickBooksSyncStatusService;

  const sync = {
    start: record("syncStart", { run: { id: "run-1" }, totalSteps: 17 }),
    run: record("syncRun", { fetched: 17, failed: [] }),
    ...(over.sync as object | undefined),
  } as unknown as QuickBooksSyncService;

  const entities = {
    list: record("list", SERVED),
    invoiceByDocNumber: record("invoiceByDocNumber", { ...SERVED, data: { Id: "42" } }),
    ...(over.entities as object | undefined),
  } as unknown as QuickBooksEntitiesService;

  const app = express();
  app.use(
    createQuickBooksRouter({
      service,
      reports,
      syncStatus,
      sync,
      entities,
      requireAuth: authAs("caller-1"),
    }),
  );
  return { app, calls };
}

const argsOf = (calls: Array<{ method: string; args: unknown[] }>, method: string) =>
  calls.filter((c) => c.method === method).at(-1)!.args;

const get = (app: express.Express, path: string) =>
  request(app).get(path).set("x-client-id", COMPANY);

describe("the five report routes", () => {
  it("asks for the report its path names", async () => {
    const cases = [
      ["/balance-sheet", "balance_sheet"],
      ["/profit-and-loss-statement", "profit_and_loss"],
      ["/qb-cashflow", "cash_flow"],
      ["/general-ledger", "general_ledger"],
      ["/all-reports", "account_list"],
    ] as const;

    for (const [path, type] of cases) {
      const { app, calls } = stub();
      await get(app, path).expect(200);
      expect(argsOf(calls, "serve")[2]).toBe(type);
    }
  });

  it("passes the query through", async () => {
    const { app, calls } = stub();
    await get(app, "/balance-sheet?start_date=2024-01-01&accounting_method=Cash").expect(200);
    expect(argsOf(calls, "serve")[3]).toMatchObject({
      start_date: "2024-01-01",
      accounting_method: "Cash",
    });
  });

  it("wraps the account list the way its caller reads it", async () => {
    // The SPA reads that response through eight fallback paths, all of which
    // nest under `accountList`. Serving the bare payload would be a ninth
    // shape and match none of them.
    const { app } = stub();
    const res = await get(app, "/all-reports").expect(200);
    expect(res.body.data).toEqual({ accountList: SERVED.data });
  });

  it("does not wrap the others", async () => {
    const { app } = stub();
    const res = await get(app, "/balance-sheet").expect(200);
    expect(res.body.data).toEqual(SERVED.data);
  });
});

describe("what an error becomes", () => {
  it("turns a rejected token into a 401 that says to reconnect", async () => {
    // A 500 sends somebody looking for a fault in the report. The fix here is
    // "reconnect QuickBooks", and the response has to say so.
    const { app } = stub({
      reports: { serve: () => Promise.reject(new QuickBooksAuthError()) },
    });
    const res = await get(app, "/balance-sheet").expect(401);
    expect(res.body.reconnectRequired).toBe(true);
  });

  it("turns a bad answer from Intuit into a 502, not a 500", async () => {
    // Intuit answered, and answered badly. A 500 claims the fault is here.
    const { app } = stub({
      reports: { serve: () => Promise.reject(new QuickBooksRequestError(503, "unavailable")) },
    });
    await get(app, "/balance-sheet").expect(502);
  });

  it("passes an access refusal through as a 403", async () => {
    const { app } = stub({
      reports: { serve: () => Promise.reject(new ForbiddenError("Access denied")) },
    });
    await get(app, "/balance-sheet").expect(403);
  });

  it("passes a missing report through as a 404", async () => {
    const { app } = stub({
      reports: { serve: () => Promise.reject(new NotFoundError("Nothing cached.")) },
    });
    await get(app, "/balance-sheet").expect(404);
  });
});

describe("the ledger sync", () => {
  it("reports how many transactions it stored", async () => {
    const { app } = stub();
    const res = await get(app, "/qb-general-ledger").expect(200);
    expect(res.body.totalInserted).toBe(3);
    expect(res.body.message).toBe("Data stored successfully");
  });
});

describe("the tax reconciliation's P&L", () => {
  it("answers the rows the page renders", async () => {
    const { app } = stub();
    const res = await get(app, "/quickbooks-pl").expect(200);
    expect(res.body.data).toEqual([{ label: "Total Revenue", pl: 500000 }]);
  });
});

describe("the monthly line items", () => {
  it("answers the four collections the picker reads", async () => {
    const { app } = stub();
    const res = await get(app, "/bank-reconciliation-line-items").expect(200);
    expect(res.body).toMatchObject({
      success: true,
      plIncomeItems: [],
      plExpenseItems: [],
      plTotalIncome: {},
      plTotalExpenses: {},
    });
  });
});

describe("customers and invoices", () => {
  it("asks for the entity its path names", async () => {
    for (const [path, entity] of [
      ["/customers", "customers"],
      ["/invoices", "invoices"],
    ] as const) {
      const { app, calls } = stub();
      await get(app, path).expect(200);
      expect(argsOf(calls, "list")[2]).toBe(entity);
    }
  });

  it("looks one invoice up by the number in the path", async () => {
    const { app, calls } = stub();
    const res = await get(app, "/invoices/doc/INV-2024-001").expect(200);
    expect(argsOf(calls, "invoiceByDocNumber")[2]).toBe("INV-2024-001");
    expect(res.body.data).toEqual({ Id: "42" });
  });

  it("passes an encoded number through decoded", async () => {
    const { app, calls } = stub();
    await get(app, "/invoices/doc/INV%2F2024%2F001").expect(200);
    expect(argsOf(calls, "invoiceByDocNumber")[2]).toBe("INV/2024/001");
  });
});

describe("the connection and the sync", () => {
  it("answers the connection's state", async () => {
    const { app } = stub();
    const res = await get(app, "/api/auth/status").expect(200);
    expect(res.body.isConnected).toBe(true);
  });

  it("disconnects", async () => {
    const { app } = stub();
    const res = await get(app, "/api/auth/disconnect").expect(200);
    expect(res.body.isConnected).toBe(false);
  });

  it("answers the sync's state", async () => {
    const { app } = stub();
    const res = await get(app, "/api/quickbooks/sync-status").expect(200);
    expect(res.body.syncStatus).toBe("idle");
  });
});

describe("starting a sync", () => {
  const post = (app: express.Express, body: Record<string, unknown> = {}) =>
    request(app).post("/api/quickbooks/sync").set("x-client-id", COMPANY).send(body);

  it("waits for the sync by default", async () => {
    // The SPA shows "Reports Ready" and regenerates the report the moment this
    // resolves. Answering early would have it render the data the sync was
    // about to replace.
    const { app, calls } = stub();
    const res = await post(app).expect(200);

    expect(calls.map((c) => c.method)).toEqual(["syncStart", "syncRun"]);
    expect(res.body).toMatchObject({
      success: true,
      runId: "run-1",
      fetched: 17,
      message: "All reports synced successfully",
    });
  });

  it("says how many reports could not be fetched", async () => {
    const { app } = stub({
      sync: {
        run: () =>
          Promise.resolve({
            fetched: 15,
            failed: [{ reportType: "cash_flow", period: "2019", message: "gone" }],
          }),
      },
    });
    const res = await post(app).expect(200);
    expect(res.body.message).toMatch(/15 reports; 1 could not be fetched/);
  });

  it("answers 202 for a background sync, naming a run that already exists", async () => {
    // Legacy slept sixty milliseconds hoping the row had appeared, then
    // reported whatever it found — which on a slow database was nothing.
    const { app, calls } = stub();
    const res = await post(app, { background: true }).expect(202);

    expect(res.body).toMatchObject({ runId: "run-1", totalSteps: 17 });
    expect(argsOf(calls, "syncStart")).toBeTruthy();
  });

  it("takes the flag as a query string too", async () => {
    const { app } = stub();
    await request(app)
      .post("/api/quickbooks/sync?background=true")
      .set("x-client-id", COMPANY)
      .send({})
      .expect(202);
  });

  it("still answers 202 when the background run fails outright", async () => {
    // The run row exists and closes itself; an unhandled rejection here would
    // take the process down instead.
    const { app } = stub({ sync: { run: () => Promise.reject(new Error("Intuit is down")) } });
    await post(app, { background: true }).expect(202);
  });

  it("passes the years and the accounting method through", async () => {
    const { app, calls } = stub();
    await post(app, { yearsBack: 2, accountingMethod: "Cash" }).expect(200);
    expect(argsOf(calls, "syncStart")[2]).toEqual({ yearsBack: 2, accountingMethod: "Cash" });
  });

  it("defaults the accounting method and leaves the years to the service", async () => {
    const { app, calls } = stub();
    await post(app).expect(200);
    expect(argsOf(calls, "syncStart")[2]).toEqual({ accountingMethod: "Accrual" });
  });

  it("ignores a years value that is not a number", async () => {
    const { app, calls } = stub();
    await post(app, { yearsBack: "lots" }).expect(200);
    expect(argsOf(calls, "syncStart")[2]).toEqual({ accountingMethod: "Accrual" });
  });

  it("reports an expired connection as a reconnect, not a 500", async () => {
    const { app } = stub({
      sync: { start: () => Promise.reject(new QuickBooksAuthError("Token expired")) },
    });
    const res = await post(app).expect(401);
    expect(res.body.reconnectRequired).toBe(true);
  });
});

describe("naming the company", () => {
  it("takes it from the header, the query, or the body", async () => {
    const { app, calls } = stub();
    await request(app).get("/balance-sheet").set("x-client-id", COMPANY).expect(200);
    expect(argsOf(calls, "serve")[1]).toBe(COMPANY);

    const { app: byQuery, calls: queryCalls } = stub();
    await request(byQuery).get(`/balance-sheet?clientId=${COMPANY}`).expect(200);
    expect(argsOf(queryCalls, "serve")[1]).toBe(COMPANY);
  });

  it("passes an empty company through, for the service to refuse", async () => {
    // The router does not decide access; it hands the service what it was
    // given, and one place decides.
    const { app, calls } = stub();
    await request(app).get("/balance-sheet").expect(200);
    expect(argsOf(calls, "serve")[1]).toBe("");
  });
});

describe("paths this router does not own", () => {
  it("leaves them for the proxy", async () => {
    // The OAuth dance stays on legacy until it can be exercised against a
    // sandbox realm. An unmatched path has to reach the proxy untouched.
    const { app } = stub();
    await get(app, "/api/auth/quickbooks").expect(404);
    await get(app, "/api/auth/callback").expect(404);
    await get(app, "/refresh-token").expect(404);
  });
});
