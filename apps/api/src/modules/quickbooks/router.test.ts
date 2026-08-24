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
import type { QuickBooksBankActivityService } from "./reports/bank-activity.js";
import { ComplexInvoiceUpdateError, type QuickBooksWritesService } from "./reports/writes.js";
import { RealmAlreadyLinkedError, type QuickBooksOAuthService } from "./oauth.js";
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

  const bankActivity = {
    ladders: record("ladders", { success: true, accounts: [], months: [], truncated: [] }),
    oneLadder: record("oneLadder", { success: true, account: { accountId: "35" }, monthlyData: [] }),
    ...(over.bankActivity as object | undefined),
  } as unknown as QuickBooksBankActivityService;

  const writes = {
    createCustomer: record("createCustomer", { customer: { Id: "7" } }),
    updateInvoice: record("updateInvoice", { invoice: { Id: "42" }, changed: true }),
    ...(over.writes as object | undefined),
  } as unknown as QuickBooksWritesService;

  const oauth =
    over.oauth === null
      ? undefined
      : ({
          startAuthorization: (...args: unknown[]) => {
            calls.push({ method: "startAuthorization", args });
            return { authorizeUrl: "https://intuit.test/authorize" };
          },
          completeCallback: record("completeCallback", {
            redirect: "/broker/companies",
            companyId: COMPANY,
            realmId: "4620816365000000000",
            realmCompanyName: "Acme Books",
          }),
          refresh: record("refresh", { expiresAt: "2026-08-24T13:00:00.000Z" }),
          transfer: record("transfer", { movedFrom: null }),
          ...(over.oauth as object | undefined),
        } as unknown as QuickBooksOAuthService);

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
      bankActivity,
      writes,
      ...(oauth ? { oauth } : {}),
      ...(over.noFrontendUrl === true ? {} : { frontendUrl: "https://app.test" }),
      entities,
      requireAuth: over.noAuth
        ? ((_req, _res, next) => {
            next();
          })
        : authAs("caller-1"),
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

describe("the bank activity ladder", () => {
  const RANGE = "start_date=2026-01-01&end_date=2026-02-28";

  it("serves the ladder for a valid range", async () => {
    const { app, calls } = stub();
    const res = await get(app, `/qb-bank-activity?${RANGE}`).expect(200);

    expect(res.body.success).toBe(true);
    expect(argsOf(calls, "ladders")[2]).toEqual({
      startDate: "2026-01-01",
      endDate: "2026-02-28",
      accountingMethod: "Accrual",
    });
  });

  it("takes the accounting basis when one is asked for", async () => {
    const { app, calls } = stub();
    await get(app, `/qb-bank-activity?${RANGE}&accounting_method=Cash`).expect(200);
    expect(argsOf(calls, "ladders")[2]).toMatchObject({ accountingMethod: "Cash" });
  });

  it("400s a range it cannot read rather than asking QuickBooks", async () => {
    // Legacy pasted both dates into the QuickBooks query language unchecked.
    const { app, calls } = stub();
    await get(app, "/qb-bank-activity?start_date=yesterday&end_date=2026-02-28").expect(400);
    expect(calls.filter((c) => c.method === "ladders")).toEqual([]);
  });

  it("400s a request with no range at all", async () => {
    const { app } = stub();
    await get(app, "/qb-bank-activity").expect(400);
  });

  it("drills into one account", async () => {
    const { app, calls } = stub();
    const res = await get(app, `/qb-one-bank-activity?accountId=35&${RANGE}`).expect(200);

    expect(res.body.account.accountId).toBe("35");
    expect(argsOf(calls, "oneLadder")[2]).toBe("35");
  });

  it("passes an absent accountId on for the service to refuse", async () => {
    // The service owns that rule, so the drill-down and anything else calling
    // it answer the same way.
    const { app, calls } = stub();
    await get(app, `/qb-one-bank-activity?${RANGE}`).expect(200);
    expect(argsOf(calls, "oneLadder")[2]).toBe("");
  });
});

describe("the two writes", () => {
  it("creates a customer under the envelope the page reads", async () => {
    const { app, calls } = stub();
    const res = await request(app)
      .post("/customers")
      .set("x-client-id", COMPANY)
      .send({ name: "Acme Ltd" })
      .expect(200);

    expect(res.body).toMatchObject({ success: true, customer: { Id: "7" } });
    expect(argsOf(calls, "createCustomer")[2]).toMatchObject({ name: "Acme Ltd" });
  });

  it("updates an invoice, naming the one in the path", async () => {
    const { app, calls } = stub();
    const res = await request(app)
      .put("/api/invoices/42")
      .set("x-client-id", COMPANY)
      .send({ invoiceNumber: "INV-9" })
      .expect(200);

    expect(res.body).toMatchObject({ success: true, data: { Id: "42" } });
    expect(argsOf(calls, "updateInvoice")[2]).toBe("42");
  });

  it("says so when there was nothing to change", async () => {
    const { app } = stub({
      writes: { updateInvoice: () => Promise.resolve({ invoice: { Id: "42" }, changed: false }) },
    });
    const res = await request(app)
      .put("/api/invoices/42")
      .set("x-client-id", COMPANY)
      .send({})
      .expect(200);
    expect(res.body.message).toMatch(/No actionable fields/);
  });

  it("sends a restructuring attempt to QuickBooks itself", async () => {
    // Telling somebody "not allowed" without telling them where it IS allowed
    // leaves them stuck on a form they cannot submit.
    const { app } = stub({
      writes: {
        updateInvoice: () => Promise.reject(new ComplexInvoiceUpdateError(["amount"])),
      },
    });
    const res = await request(app)
      .put("/api/invoices/42")
      .set("x-client-id", COMPANY)
      .send({ amount: 100 })
      .expect(400);

    expect(res.body).toMatchObject({ redirectToQuickBooks: true, fields: ["amount"] });
  });

  it("takes a create with no body at all, for the service to refuse", async () => {
    const { app, calls } = stub();
    await request(app).post("/customers").set("x-client-id", COMPANY).expect(200);
    expect(argsOf(calls, "createCustomer")[2]).toEqual({});
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
    // An unmatched path has to reach the proxy untouched, which is what
    // 404-from-this-router means in isolation.
    //
    // The OAuth dance was listed here and no longer is: this router serves it,
    // and leaving the assertions would have pinned the routes as absent rather
    // than noticing they had arrived.
    const { app } = stub();
    await get(app, "/api/auth/nothing-here").expect(404);
  });
});

describe("the OAuth dance", () => {
  it("sends the browser to Intuit", async () => {
    const { app } = stub();
    const res = await get(app, "/api/auth/quickbooks").expect(302);
    expect(res.headers.location).toBe("https://intuit.test/authorize");
  });

  it("renews a token", async () => {
    const { app, calls } = stub();
    const res = await get(app, "/refresh-token").expect(200);
    expect(res.body.success).toBe(true);
    expect(argsOf(calls, "refresh")[1]).toBe(COMPANY);
  });

  it("moves a realm to this company", async () => {
    const { app, calls } = stub();
    await request(app)
      .post("/api/auth/transfer-confirm")
      .set("x-client-id", COMPANY)
      .send({ realmId: "4620816365000000000" })
      .expect(200);
    expect(argsOf(calls, "transfer")[2]).toBe("4620816365000000000");
  });

  it("names the client a realm is already attached to", async () => {
    // The page turns this into "already connected to <client> — move it?", so
    // it has to say which.
    const { app } = stub({
      oauth: {
        transfer: () =>
          Promise.reject(new RealmAlreadyLinkedError("4620816365000000000", "other-company")),
      },
    });
    const res = await request(app)
      .post("/api/auth/transfer-confirm")
      .set("x-client-id", COMPANY)
      .send({ realmId: "4620816365000000000" })
      .expect(409);

    expect(res.body).toMatchObject({
      code: "QB_REALM_ALREADY_LINKED",
      linkedCompanyId: "other-company",
      requiresConfirmation: true,
    });
  });

  it("answers the callback with a REDIRECT, whatever happened", async () => {
    // A browser is sitting on this URL. A JSON error body leaves somebody
    // looking at raw text with no way back into the application.
    const { app } = stub();
    const ok = await request(app)
      .get("/api/auth/callback?code=c&realmId=r&state=s")
      .expect(302);
    expect(ok.headers.location).toContain("qbStatus=connected");

    const { app: failing } = stub({
      oauth: { completeCallback: () => Promise.reject(new Error("That attempt has expired.")) },
    });
    const bad = await request(failing)
      .get("/api/auth/callback?code=c&realmId=r&state=stale")
      .expect(302);
    expect(bad.headers.location).toContain("qbStatus=error");
    expect(bad.headers.location).toContain(encodeURIComponent("That attempt has expired."));
  });

  it("does not require a session on the callback", async () => {
    // Intuit redirects a browser here carrying none.
    const { app } = stub({ noAuth: true });
    await request(app).get("/api/auth/callback?code=c&realmId=r&state=s").expect(302);
  });

  it("503s the dance where OAuth is not configured", async () => {
    const { app } = stub({ oauth: null });
    await get(app, "/api/auth/quickbooks").expect(503);
    await get(app, "/refresh-token").expect(503);
    const res = await request(app).get("/api/auth/callback?code=c").expect(302);
    expect(res.headers.location).toContain("Not+configured");
  });
});

describe("what the router does with a failure it does not recognise", () => {
  it("hands it to the error handler rather than answering 200", async () => {
    // Everything above this maps a KNOWN failure onto a status. A surprise —
    // a null dereference, a driver error — must not be dressed up as one of
    // them, because a 502 says "Intuit answered badly" about a fault that is
    // ours.
    const { app } = stub({ entities: { list: () => Promise.reject(new Error("boom")) } });
    await get(app, "/customers").expect(500);
  });

  it("still redirects the callback when the failure is not an Error", async () => {
    // A rejection with a non-Error — a string, a Promise.reject(undefined) —
    // still leaves a browser on this URL, so it still has to land somewhere in
    // the application.
    const { app } = stub({
      oauth: { completeCallback: () => Promise.reject("a bare string") },
    });
    const res = await request(app).get("/api/auth/callback?code=c&realmId=r&state=s").expect(302);
    expect(res.headers.location).toContain("qbStatus=error");
    expect(res.headers.location).toContain(encodeURIComponent("Could not connect QuickBooks."));
  });

  it("redirects within the app when no frontend URL is configured", async () => {
    // A relative location, which is what the SPA is serving the callback from
    // anyway when the two share an origin.
    const { app } = stub({ noFrontendUrl: true });
    const res = await request(app).get("/api/auth/callback?code=c&realmId=r&state=s").expect(302);
    expect(res.headers.location).toBe("/#/broker/companies?qbStatus=connected");
  });
});

describe("a request that carries no body at all", () => {
  /**
   * Not a contrivance: `express.json()` leaves `req.body` undefined when the
   * request has no `Content-Type`, and a `fetch` with no `body` sends none. A
   * handler reading `req.body.x` would throw a TypeError and answer 500 for
   * what is really a 400.
   */
  it("treats a bodiless customer create as an empty one", async () => {
    const { app, calls } = stub();
    await request(app).post("/customers").set("x-client-id", COMPANY).expect(200);
    expect(argsOf(calls, "createCustomer")[2]).toEqual({});
  });

  it("treats a bodiless invoice update as an empty one", async () => {
    const { app, calls } = stub();
    await request(app).put("/api/invoices/42").set("x-client-id", COMPANY).expect(200);
    expect(argsOf(calls, "updateInvoice")[2]).toBe("42");
    expect(argsOf(calls, "updateInvoice")[3]).toEqual({});
  });

  it("takes the sync options from the query when there is no body to hold them", async () => {
    // The SPA posts these as a query string on one path and as JSON on another.
    const { app, calls } = stub();
    await request(app)
      .post("/api/quickbooks/sync?yearsBack=3&accountingMethod=Cash")
      .set("x-client-id", COMPANY)
      .expect(200);
    expect(argsOf(calls, "syncStart")[2]).toEqual({ yearsBack: 3, accountingMethod: "Cash" });
  });

  it("passes a bodiless transfer through as an unnamed realm", async () => {
    // The router does not decide this. `QuickBooksOAuthService.transfer` throws
    // `Missing realmId.` for an empty one, which is a 400 through the real
    // service; what has to be true here is that the router reaches it at all
    // rather than throwing on `body.realmId` first.
    const { app, calls } = stub();
    await request(app).post("/api/auth/transfer-confirm").set("x-client-id", COMPANY).expect(200);
    expect(argsOf(calls, "transfer")[2]).toBe("");
  });
});
