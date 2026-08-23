import express from "express";
import type { RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { ForbiddenError, HttpError, NotFoundError } from "../../shared/errors.js";
import { createReportsRouter } from "./router.js";
import type { ReportsService } from "./service.js";

/**
 * The key-report version HTTP contract.
 *
 * The service is tested against a fake repository elsewhere; this covers what
 * the router decides — how a query string becomes options, which failures
 * become which status, and that the statements endpoint answers under the
 * `success` envelope the reports view checks before reading `reports`.
 */

const VERSION = "vvvvvvvv-vvvv-4vvv-8vvv-vvvvvvvvvvvv";
const COMPANY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

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

const emptyStatements = {
  companyName: "Acme",
  currency: "USD",
  reports: {
    profitAndLoss: { yearly: [], monthly: [] },
    balanceSheet: { yearly: [], monthly: [] },
    cashFlow: { yearly: [], monthly: [] },
  },
  validation: [],
  unmappedAccounts: [],
  missingData: [],
};

const emptyProfitLoss = {
  source: "general_ledger_entries",
  reportType: "profit_loss_summary",
  filters: {},
  years: [],
  displayYear: null,
  lines: [],
  monthlyBreakdown: [],
  yearComparison: [],
  netProfitByYear: {},
  hierarchicalRows: [],
};

const emptyBalanceSheet = {
  source: "general_ledger_entries",
  reportType: "balance_sheet",
  filters: {},
  years: [],
  displayYear: null,
  sections: {
    Assets: { totalByYear: {}, categories: [] },
    Liabilities: { totalByYear: {}, categories: [] },
    Equity: { totalByYear: {}, categories: [] },
  },
  hierarchicalRows: [],
  audit: [],
};

const emptyCashFlow = {
  source: "general_ledger_entries",
  reportType: "cash_flow",
  filters: {},
  years: [],
  sections: {
    Operating: { label: "Operating Activities", items: [], totalByYear: {} },
    Investing: { label: "Investing Activities", items: [], totalByYear: {} },
    Financing: { label: "Financing Activities", items: [], totalByYear: {} },
  },
  netCashChange: {},
  hierarchicalRows: [],
  yearCols: [],
  beginningCash: {},
  endingCash: {},
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
    list: record("list", [{ id: VERSION }]),
    get: record("get", { id: VERSION }),
    create: record("create", { id: VERSION }),
    update: record("update", { id: VERSION }),
    duplicate: record("duplicate", { id: "copy" }),
    activate: record("activate", { id: VERSION }),
    delete: record("delete", undefined),
    financialStatements: record("financialStatements", emptyStatements),
    profitLoss: record("profitLoss", emptyProfitLoss),
    balanceSheet: record("balanceSheet", emptyBalanceSheet),
    cashFlow: record("cashFlow", emptyCashFlow),
    ...over,
  } as unknown as ReportsService;

  const app = express();
  app.use(createReportsRouter({ service, requireAuth: authAs("caller-1") }));
  return { app, calls };
}

const argsOf = (calls: Array<{ method: string; args: unknown[] }>, method: string) =>
  calls.filter((c) => c.method === method).at(-1)!.args;

describe("versions", () => {
  it("accepts the company from any of the three places the SPA sends it", async () => {
    // Different screens supply it differently; all three must work, and a
    // request with none must say so rather than listing nothing.
    const { app, calls } = stub();

    await request(app).get(`/key-reports/versions?company_id=${COMPANY}`).expect(200);
    await request(app).get(`/key-reports/versions?clientId=${COMPANY}`).expect(200);
    await request(app).get("/key-reports/versions").set("x-client-id", COMPANY).expect(200);

    for (const call of calls.filter((c) => c.method === "list")) {
      expect(call.args[1]).toBe(COMPANY);
    }
  });

  it("400s a list with no company anywhere", async () => {
    const { app } = stub();
    const res = await request(app).get("/key-reports/versions").expect(400);
    expect(res.body.error).toMatch(/company_id/);
  });

  it("reports which version is active alongside the list", async () => {
    const { app } = stub({
      list: () => Promise.resolve([{ id: VERSION, is_active: true }, { id: "other", is_active: false }]),
    });
    const res = await request(app).get(`/key-reports/versions?company_id=${COMPANY}`).expect(200);
    expect(res.body).toMatchObject({ success: true, activeVersionId: VERSION });
  });

  it("reads, updates, duplicates and activates one", async () => {
    const { app, calls } = stub();
    await request(app).get(`/key-reports/versions/${VERSION}`).expect(200);
    await request(app).put(`/key-reports/versions/${VERSION}`).send({ version_name: "Q3" }).expect(200);
    await request(app).post(`/key-reports/versions/${VERSION}/duplicate`).send({}).expect(201);
    await request(app).post(`/key-reports/versions/${VERSION}/activate`).send({}).expect(200);

    for (const method of ["get", "update", "duplicate", "activate"]) {
      expect(calls.map((c) => c.method)).toContain(method);
    }
  });

  it("deletes with no content", async () => {
    const { app, calls } = stub();
    await request(app).delete(`/key-reports/versions/${VERSION}`).expect(204);
    expect(argsOf(calls, "delete")[1]).toBe(VERSION);
  });
});

describe("the financial statements", () => {
  it("answers under the envelope the view checks", async () => {
    // `FinancialStatementsView` reads `success` before it reads `reports`.
    const { app } = stub();
    const res = await request(app)
      .get(`/key-reports/versions/${VERSION}/reports/financial-statements`)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.reports.balanceSheet).toEqual({ yearly: [], monthly: [] });
  });

  it("passes a year through as a number", async () => {
    const { app, calls } = stub();
    await request(app)
      .get(`/key-reports/versions/${VERSION}/reports/financial-statements?year=2024`)
      .expect(200);
    expect(argsOf(calls, "financialStatements")[2]).toMatchObject({ year: 2024 });
  });

  it("omits an unparseable year rather than filtering to NaN", async () => {
    // A NaN year matches nothing, so the statements would come back empty with
    // no indication why.
    const { app, calls } = stub();
    await request(app)
      .get(`/key-reports/versions/${VERSION}/reports/financial-statements?year=soon`)
      .expect(200);
    expect(argsOf(calls, "financialStatements")[2]).toMatchObject({ year: undefined });
  });

  it("passes currency and company name when given", async () => {
    const { app, calls } = stub();
    await request(app)
      .get(
        `/key-reports/versions/${VERSION}/reports/financial-statements?currency=GBP&companyName=Acme%20Ltd`,
      )
      .expect(200);
    expect(argsOf(calls, "financialStatements")[2]).toMatchObject({
      currency: "GBP",
      companyName: "Acme Ltd",
    });
  });
});

describe("what a domain error becomes on the wire", () => {
  it("404s a version that does not exist", async () => {
    const { app } = stub({
      financialStatements: () => Promise.reject(new NotFoundError("Report version not found.")),
    });
    await request(app)
      .get(`/key-reports/versions/${VERSION}/reports/financial-statements`)
      .expect(404);
  });

  it("403s a company the caller is not on", async () => {
    const { app } = stub({ get: () => Promise.reject(new ForbiddenError("denied")) });
    await request(app).get(`/key-reports/versions/${VERSION}`).expect(403);
  });

  it("passes an unexpected failure on", async () => {
    const { app } = stub({ get: () => Promise.reject(new Error("boom")) });
    await request(app).get(`/key-reports/versions/${VERSION}`).expect(500);
  });
});

describe("paths this router does not own", () => {
  it("leaves them for the proxy", async () => {
    const { app } = stub();
    await request(app).get(`/key-reports/versions/${VERSION}/mappings`).expect(404);
  });
});

describe("the profit & loss route", () => {
  it("accepts the company from any of the three places the SPA sends it", async () => {
    const { app, calls } = stub();

    await request(app).get(`/reports/profit-loss?clientId=${COMPANY}`).expect(200);
    await request(app).get(`/reports/profit-loss?company_id=${COMPANY}`).expect(200);
    await request(app).get("/reports/profit-loss").set("x-client-id", COMPANY).expect(200);

    for (const call of calls.filter((c) => c.method === "profitLoss")) {
      expect(call.args[1]).toBe(COMPANY);
    }
  });

  it("400s a request that names no company, rather than serving someone else's", async () => {
    const { app, calls } = stub();
    const res = await request(app).get("/reports/profit-loss").expect(400);
    expect(res.body).toEqual({ error: "Missing clientId." });
    expect(calls).toEqual([]);
  });

  it("answers under the success envelope the page checks", async () => {
    const { app } = stub();
    const res = await request(app).get(`/reports/profit-loss?clientId=${COMPANY}`).expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.reportType).toBe("profit_loss_summary");
  });

  it("takes a repeated fiscalYear as one column each", async () => {
    // How the multi-select on the Reports page sends it.
    const { app, calls } = stub();
    await request(app)
      .get(`/reports/profit-loss?clientId=${COMPANY}&fiscalYear=2023&fiscalYear=2024`)
      .expect(200);
    expect(argsOf(calls, "profitLoss")[2]).toEqual({ fiscalYears: [2023, 2024] });
  });

  it("takes a comma-separated list too", async () => {
    const { app, calls } = stub();
    await request(app)
      .get(`/reports/profit-loss?clientId=${COMPANY}&fiscalYears=2023,2024`)
      .expect(200);
    expect(argsOf(calls, "profitLoss")[2]).toEqual({ fiscalYears: [2023, 2024] });
  });

  it("drops a year that is not a year, rather than passing NaN down", async () => {
    const { app, calls } = stub();
    await request(app)
      .get(`/reports/profit-loss?clientId=${COMPANY}&fiscalYear=last-year&fiscalYear=2024`)
      .expect(200);
    expect(argsOf(calls, "profitLoss")[2]).toEqual({ fiscalYears: [2024] });
  });

  it("maps a company the caller cannot reach to 403, and a missing version to 404", async () => {
    for (const [err, status] of [
      [new ForbiddenError("denied"), 403],
      [new NotFoundError("No key-report version for this company."), 404],
    ] as const) {
      const { app } = stub({ profitLoss: () => Promise.reject(err) });
      await request(app).get(`/reports/profit-loss?clientId=${COMPANY}`).expect(status);
    }
  });

  it("passes an unexpected failure on rather than reporting an empty statement", async () => {
    // A P&L that answers 200 with no rows because the query threw is worse
    // than one that fails: the page draws an empty, confident table.
    const { app } = stub({ profitLoss: () => Promise.reject(new Error("boom")) });
    await request(app).get(`/reports/profit-loss?clientId=${COMPANY}`).expect(500);
  });
});

describe("the balance sheet route", () => {
  it("resolves the company the same three ways, and 400s without one", async () => {
    const { app, calls } = stub();
    await request(app).get(`/reports/balance-sheet?clientId=${COMPANY}`).expect(200);
    await request(app).get(`/reports/balance-sheet?company_id=${COMPANY}`).expect(200);
    await request(app).get("/reports/balance-sheet").set("x-client-id", COMPANY).expect(200);
    await request(app).get("/reports/balance-sheet").expect(400);

    expect(calls.filter((c) => c.method === "balanceSheet")).toHaveLength(3);
  });

  it("passes the requested years through", async () => {
    const { app, calls } = stub();
    await request(app)
      .get(`/reports/balance-sheet?clientId=${COMPANY}&fiscalYear=2023&fiscalYear=2024`)
      .expect(200);
    expect(argsOf(calls, "balanceSheet")[2]).toEqual({ fiscalYears: [2023, 2024] });
  });

  it("answers under the success envelope", async () => {
    const { app } = stub();
    const res = await request(app).get(`/reports/balance-sheet?clientId=${COMPANY}`).expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.reportType).toBe("balance_sheet");
  });

  it("surfaces 'no balance sheet ingested' as its own status, not as an empty sheet", async () => {
    // The page has to tell "nothing was uploaded" apart from "a company with
    // no activity", and a 200 with zeroes says neither.
    const { app } = stub({
      balanceSheet: () => Promise.reject(new HttpError(422, "No balance sheet has been ingested")),
    });
    const res = await request(app).get(`/reports/balance-sheet?clientId=${COMPANY}`).expect(422);
    expect(res.body.error).toMatch(/balance sheet/i);
  });

  it("maps access and missing-version failures to their statuses", async () => {
    for (const [err, status] of [
      [new ForbiddenError("denied"), 403],
      [new NotFoundError("No key-report version for this company."), 404],
    ] as const) {
      const { app } = stub({ balanceSheet: () => Promise.reject(err) });
      await request(app).get(`/reports/balance-sheet?clientId=${COMPANY}`).expect(status);
    }
  });
});

describe("the cash flow route", () => {
  it("resolves the company the same three ways, and 400s without one", async () => {
    const { app, calls } = stub();
    await request(app).get(`/reports/cashflow?clientId=${COMPANY}`).expect(200);
    await request(app).get(`/reports/cashflow?company_id=${COMPANY}`).expect(200);
    await request(app).get("/reports/cashflow").set("x-client-id", COMPANY).expect(200);
    await request(app).get("/reports/cashflow").expect(400);

    expect(calls.filter((c) => c.method === "cashFlow")).toHaveLength(3);
  });

  it("passes the requested years through, and answers under the envelope", async () => {
    const { app, calls } = stub();
    const res = await request(app)
      .get(`/reports/cashflow?clientId=${COMPANY}&fiscalYears=2023,2024`)
      .expect(200);
    expect(argsOf(calls, "cashFlow")[2]).toEqual({ fiscalYears: [2023, 2024] });
    expect(res.body.success).toBe(true);
    expect(res.body.reportType).toBe("cash_flow");
  });

  it("surfaces the missing balance sheet as 422, like its parent statement", async () => {
    const { app } = stub({
      cashFlow: () => Promise.reject(new HttpError(422, "No balance sheet has been ingested")),
    });
    await request(app).get(`/reports/cashflow?clientId=${COMPANY}`).expect(422);
  });

  it("passes an unexpected failure on rather than reporting no movement", async () => {
    const { app } = stub({ cashFlow: () => Promise.reject(new Error("boom")) });
    await request(app).get(`/reports/cashflow?clientId=${COMPANY}`).expect(500);
  });
});
