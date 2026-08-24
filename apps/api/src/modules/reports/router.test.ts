import express from "express";
import type { RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import {
  BadRequestError,
  ForbiddenError,
  HttpError,
  NotFoundError,
} from "../../shared/errors.js";
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
const DOCUMENT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

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
    Operating: { label: "Cash Flow from Operating Activities", items: [], totalByYear: {} },
    Investing: { label: "Cash Flow from Investing Activities", items: [], totalByYear: {} },
    Financing: { label: "Cash Flow from Financing Activities", items: [], totalByYear: {} },
  },
  netCashChange: {},
  hierarchicalRows: [],
  yearCols: [],
  beginningCash: {},
  endingCash: {},
};

const emptyMonthlyDetail = {
  source: "general_ledger_entries",
  reportType: "profit_loss_monthly_detail",
  year: null,
  months: [],
  monthNames: [],
  sections: [],
  filters: {},
};

const emptyBsMonthlyDetail = {
  source: "general_ledger_entries",
  reportType: "balance_sheet_monthly_detail",
  year: null,
  months: [],
  monthNames: [],
  sections: {
    Assets: { label: "Assets", categories: [], monthlyTotals: {}, total: 0 },
    Liabilities: { label: "Liabilities", categories: [], monthlyTotals: {}, total: 0 },
    Equity: { label: "Equity", categories: [], monthlyTotals: {}, total: 0 },
  },
  filters: {},
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
    extractedData: record("extractedData", {
      dataType: "profit_loss",
      rows: [],
      page: 1,
      pageSize: 50,
      total: 0,
      totalPages: 1,
    }),
    delete: record("delete", undefined),
    financialStatements: record("financialStatements", emptyStatements),
    profitLoss: record("profitLoss", emptyProfitLoss),
    balanceSheet: record("balanceSheet", emptyBalanceSheet),
    cashFlow: record("cashFlow", emptyCashFlow),
    monthlyDetail: record("monthlyDetail", emptyMonthlyDetail),
    balanceSheetMonthlyDetail: record("balanceSheetMonthlyDetail", emptyBsMonthlyDetail),
    listMappings: record("listMappings", { profit_loss: [], balance_sheet: [] }),
    listSyncLogs: record("listSyncLogs", [{ id: 1, syncStatus: "completed" }]),
    getPopupDismissed: record("getPopupDismissed", false),
    setPopupDismissed: record("setPopupDismissed", true),
    sync: record("sync", { versionId: VERSION, processed: [], failed: [], years: [] }),
    linkMappings: record("linkMappings", [{ id: "m1" }]),
    deleteMapping: record("deleteMapping", undefined),
    filterOptions: record("filterOptions", {
      source: "general_ledger_entries",
      rowCount: 0,
      options: { fiscalYear: [], reportType: ["profit_loss", "balance_sheet"] },
    }),
    validateBalanceSheet: record("validateBalanceSheet", {
      source: "general_ledger_entries",
      validation: { isValid: true, mismatches: [], missingSheets: [] },
    }),
    vendorDetail: record("vendorDetail", {
      source: "general_ledger_entries",
      reportType: "vendor_analysis",
      filters: {},
      years: [],
      vendors: [],
    }),
    cashFlowMonthlyDetail: record("cashFlowMonthlyDetail", {
      source: "general_ledger_entries",
      reportType: "cash_flow_monthly_detail",
      year: null,
      months: [],
      monthNames: [],
      sections: [],
      filters: {},
    }),
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

  it("400s a create posted with no body at all, rather than 500ing", async () => {
    // The create route reads the company out of the body before the contract
    // ever sees it, so a request carrying none has to reach the contract as an
    // empty object and be refused by name — not throw on the way there.
    const { app } = stub();
    await request(app).post("/key-reports/versions").expect(400);
  });

  it("still finds the company in a header when the body carries none", async () => {
    const { app, calls } = stub();
    await request(app)
      .post("/key-reports/versions")
      .set("x-client-id", COMPANY)
      .expect(201);
    expect(argsOf(calls, "create")[1]).toMatchObject({ company_id: COMPANY });
  });

  it("400s an update posted with no body, rather than 500ing", async () => {
    // Same reason as the create above: the body is read before the contract
    // validates it, and the contract requires at least one field to change.
    const { app } = stub();
    await request(app).put(`/key-reports/versions/${VERSION}`).expect(400);
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

  it("takes camelCase as well as snake_case on create and update", async () => {
    // The SPA sends `versionName` from one screen and `version_name` from
    // another. Normalised at the boundary rather than widened in the contract,
    // so the internal shape stays one thing.
    const { app, calls } = stub();
    await request(app)
      .post("/key-reports/versions")
      .send({ companyId: COMPANY, versionName: "Q3 close" })
      .expect(201);
    expect(argsOf(calls, "create")[1]).toMatchObject({
      company_id: COMPANY,
      version_name: "Q3 close",
    });

    const { app: put, calls: putCalls } = stub();
    await request(put)
      .put(`/key-reports/versions/${VERSION}`)
      .send({ versionName: "Renamed" })
      .expect(200);
    expect(argsOf(putCalls, "update")[2]).toMatchObject({ version_name: "Renamed" });
  });

  it("400s a create with no company anywhere, naming the field", async () => {
    const { app, calls } = stub();
    const res = await request(app).post("/key-reports/versions").send({}).expect(400);
    expect(String(res.body.error)).toMatch(/company_id/);
    expect(calls.map((c) => c.method)).not.toContain("create");
  });

  it("400s an update the contract rejects", async () => {
    const { app, calls } = stub();
    await request(app)
      .put(`/key-reports/versions/${VERSION}`)
      .send({ status: "whatever" })
      .expect(400);
    expect(calls.map((c) => c.method)).not.toContain("update");
  });
});

describe("building a version's entry tables", () => {
  it("answers what it read, under the envelope the page checks", async () => {
    // These tables are the financial engine's input: the balance sheet is
    // rolled forward from them and the chart of accounts is regenerated from
    // them, so this route is what turns uploaded files into every figure the
    // product reports.
    const { app, calls } = stub();
    const res = await request(app)
      .post(`/key-reports/versions/${VERSION}/sync`)
      .set("x-client-id", COMPANY)
      .expect(200);

    expect(res.body).toMatchObject({ success: true, versionId: VERSION });
    expect(argsOf(calls, "sync")[1]).toBe(VERSION);
  });

  it("maps a refusal to its own status rather than 500ing", async () => {
    const { app } = stub({ sync: () => Promise.reject(new NotFoundError("Version not found.")) });
    await request(app).post(`/key-reports/versions/${VERSION}/sync`).expect(404);
  });
});

describe("linking documents to a version", () => {
  it("takes one document or a list of them", async () => {
    // One screen links a single file and another links a multi-select. Reading
    // only one of the two silently links nothing.
    const { app, calls } = stub();
    await request(app)
      .post(`/key-reports/versions/${VERSION}/mappings`)
      .send({ reportCategory: "balance_sheet", documentId: DOCUMENT })
      .expect(201);
    expect(argsOf(calls, "linkMappings")[2]).toMatchObject({ documentIds: [DOCUMENT] });

    const { app: many, calls: manyCalls } = stub();
    await request(many)
      .post(`/key-reports/versions/${VERSION}/mappings`)
      .send({ reportCategory: "balance_sheet", documentIds: [DOCUMENT, "second"] })
      .expect(201);
    expect(argsOf(manyCalls, "linkMappings")[2]).toMatchObject({
      documentIds: [DOCUMENT, "second"],
    });
  });

  it("passes an empty category and no documents on, for the service to refuse", async () => {
    const { app, calls } = stub();
    await request(app).post(`/key-reports/versions/${VERSION}/mappings`).expect(201);
    expect(argsOf(calls, "linkMappings")[2]).toEqual({ reportCategory: "", documentIds: [] });
  });
});

describe("the popup preference", () => {
  it("takes the string a form sends as well as the boolean", async () => {
    const { app, calls } = stub();
    await request(app).put("/key-reports/popup-preference").send({ dismissed: "true" }).expect(200);
    expect(argsOf(calls, "setPopupDismissed")[1]).toBe(true);
  });

  it("treats anything else as not dismissed rather than as an error", async () => {
    // The worst outcome of a bad body here is a popup shown once more.
    for (const dismissed of [false, "yes", 1, null, undefined]) {
      const { app, calls } = stub();
      await request(app).put("/key-reports/popup-preference").send({ dismissed }).expect(200);
      expect(argsOf(calls, "setPopupDismissed")[1]).toBe(false);
    }
  });

  it("takes a request with no body at all", async () => {
    const { app, calls } = stub();
    await request(app).put("/key-reports/popup-preference").expect(200);
    expect(argsOf(calls, "setPopupDismissed")[1]).toBe(false);
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
    // An unmatched path has to reach the proxy untouched, which is what
    // 404-from-this-router means in isolation.
    //
    // `/extracted-data` and the version SYNC were both listed here and no
    // longer are: this router serves them now, and leaving the assertions
    // would have pinned the routes as absent rather than noticing they had
    // arrived.
    const { app } = stub();
    await request(app).get("/manual-gl/nothing-here").expect(404);
  });
});

describe("the extracted-data route", () => {
  it("passes the query through and answers the page", async () => {
    const { app, calls } = stub();
    const res = await request(app)
      .get(`/key-reports/versions/${VERSION}/extracted-data?dataType=profit_loss&year=2024&page=2&pageSize=25&search=rent`)
      .expect(200);
    expect(res.body.success).toBe(true);
    expect(argsOf(calls, "extractedData")[2]).toEqual({
      dataType: "profit_loss",
      year: 2024,
      page: 2,
      pageSize: 25,
      search: "rent",
    });
  });

  it("omits what the caller did not ask, rather than passing empty values", async () => {
    // A `year` of NaN or a `page` of "" would otherwise reach the reader as a
    // filter, which is a different question from "no filter".
    const { app, calls } = stub();
    await request(app)
      .get(`/key-reports/versions/${VERSION}/extracted-data?dataType=profit_loss&year=soon`)
      .expect(200);
    expect(argsOf(calls, "extractedData")[2]).toEqual({ dataType: "profit_loss" });
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

describe("the monthly-detail route", () => {
  it("takes a single year, because the columns are that year's months", async () => {
    const { app, calls } = stub();
    await request(app)
      .get(`/reports/profit-loss/monthly-detail?clientId=${COMPANY}&fiscalYear=2024`)
      .expect(200);
    expect(argsOf(calls, "monthlyDetail")[2]).toEqual({ fiscalYear: 2024, months: [] });
  });

  it("accepts `year` as well, which is what some callers send", async () => {
    const { app, calls } = stub();
    await request(app)
      .get(`/reports/profit-loss/monthly-detail?clientId=${COMPANY}&year=2023`)
      .expect(200);
    expect(argsOf(calls, "monthlyDetail")[2]).toEqual({ fiscalYear: 2023, months: [] });
  });

  it("narrows to the months asked for, repeated or comma-separated", async () => {
    const { app, calls } = stub();
    await request(app)
      .get(`/reports/profit-loss/monthly-detail?clientId=${COMPANY}&month=1&month=2`)
      .expect(200);
    expect(argsOf(calls, "monthlyDetail")[2]).toEqual({ months: [1, 2] });

    await request(app)
      .get(`/reports/profit-loss/monthly-detail?clientId=${COMPANY}&months=6,7`)
      .expect(200);
    expect(argsOf(calls, "monthlyDetail")[2]).toEqual({ months: [6, 7] });
  });

  it("drops a month outside 1–12 rather than passing it down", async () => {
    const { app, calls } = stub();
    await request(app)
      .get(`/reports/profit-loss/monthly-detail?clientId=${COMPANY}&month=0&month=13&month=5`)
      .expect(200);
    expect(argsOf(calls, "monthlyDetail")[2]).toEqual({ months: [5] });
  });

  it("omits the year entirely when none is given, rather than sending NaN", async () => {
    const { app, calls } = stub();
    await request(app)
      .get(`/reports/profit-loss/monthly-detail?clientId=${COMPANY}&fiscalYear=whenever`)
      .expect(200);
    expect(argsOf(calls, "monthlyDetail")[2]).toEqual({ months: [] });
  });

  it("400s without a company, and answers under the envelope with one", async () => {
    const { app } = stub();
    await request(app).get("/reports/profit-loss/monthly-detail").expect(400);
    const res = await request(app)
      .get(`/reports/profit-loss/monthly-detail?clientId=${COMPANY}`)
      .expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.reportType).toBe("profit_loss_monthly_detail");
  });

  it("maps access and missing-version failures to their statuses", async () => {
    for (const [err, status] of [
      [new ForbiddenError("denied"), 403],
      [new NotFoundError("No key-report version for this company."), 404],
    ] as const) {
      const { app } = stub({ monthlyDetail: () => Promise.reject(err) });
      await request(app)
        .get(`/reports/profit-loss/monthly-detail?clientId=${COMPANY}`)
        .expect(status);
    }
  });
});

describe("the balance-sheet monthly-detail route", () => {
  it("takes the same month window as its P&L counterpart", async () => {
    const { app, calls } = stub();
    await request(app)
      .get(`/reports/balance-sheet/monthly-detail?clientId=${COMPANY}&fiscalYear=2024&months=1,2`)
      .expect(200);
    expect(argsOf(calls, "balanceSheetMonthlyDetail")[2]).toEqual({
      fiscalYear: 2024,
      months: [1, 2],
    });
  });

  it("400s without a company, and answers under the envelope with one", async () => {
    const { app } = stub();
    await request(app).get("/reports/balance-sheet/monthly-detail").expect(400);
    const res = await request(app)
      .get(`/reports/balance-sheet/monthly-detail?clientId=${COMPANY}`)
      .expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.reportType).toBe("balance_sheet_monthly_detail");
  });

  it("surfaces the missing balance sheet as 422", async () => {
    const { app } = stub({
      balanceSheetMonthlyDetail: () =>
        Promise.reject(new HttpError(422, "No balance sheet has been ingested")),
    });
    await request(app)
      .get(`/reports/balance-sheet/monthly-detail?clientId=${COMPANY}`)
      .expect(422);
  });

  it("does not answer the summary route with the monthly one", async () => {
    // `/reports/balance-sheet` and `/reports/balance-sheet/monthly-detail` are
    // siblings; `monthly-detail` must not be read as a path parameter.
    const { app, calls } = stub();
    await request(app).get(`/reports/balance-sheet?clientId=${COMPANY}`).expect(200);
    await request(app)
      .get(`/reports/balance-sheet/monthly-detail?clientId=${COMPANY}`)
      .expect(200);
    expect(calls.map((c) => c.method)).toEqual(["balanceSheet", "balanceSheetMonthlyDetail"]);
  });
});

describe("the cash-flow monthly-detail route", () => {
  it("takes the same month window, and does not shadow the summary route", async () => {
    const { app, calls } = stub();
    await request(app).get(`/reports/cashflow?clientId=${COMPANY}`).expect(200);
    await request(app)
      .get(`/reports/cashflow/monthly-detail?clientId=${COMPANY}&fiscalYear=2024&month=3`)
      .expect(200);

    expect(calls.map((c) => c.method)).toEqual(["cashFlow", "cashFlowMonthlyDetail"]);
    expect(argsOf(calls, "cashFlowMonthlyDetail")[2]).toEqual({
      fiscalYear: 2024,
      months: [3],
    });
  });

  it("400s without a company, and answers under the envelope with one", async () => {
    const { app } = stub();
    await request(app).get("/reports/cashflow/monthly-detail").expect(400);
    const res = await request(app)
      .get(`/reports/cashflow/monthly-detail?clientId=${COMPANY}`)
      .expect(200);
    expect(res.body.reportType).toBe("cash_flow_monthly_detail");
  });

  it("surfaces the missing balance sheet as 422", async () => {
    const { app } = stub({
      cashFlowMonthlyDetail: () =>
        Promise.reject(new HttpError(422, "No balance sheet has been ingested")),
    });
    await request(app).get(`/reports/cashflow/monthly-detail?clientId=${COMPANY}`).expect(422);
  });
});

describe("the vendor-detail route", () => {
  it("takes the years, and does not shadow the P&L summary", async () => {
    const { app, calls } = stub();
    await request(app).get(`/reports/profit-loss?clientId=${COMPANY}`).expect(200);
    await request(app)
      .get(`/reports/profit-loss/detail-vendor?clientId=${COMPANY}&fiscalYear=2024`)
      .expect(200);

    expect(calls.map((c) => c.method)).toEqual(["profitLoss", "vendorDetail"]);
    expect(argsOf(calls, "vendorDetail")[2]).toEqual({ fiscalYears: [2024] });
  });

  it("400s without a company, and answers under the envelope with one", async () => {
    const { app } = stub();
    await request(app).get("/reports/profit-loss/detail-vendor").expect(400);
    const res = await request(app)
      .get(`/reports/profit-loss/detail-vendor?clientId=${COMPANY}`)
      .expect(200);
    expect(res.body.reportType).toBe("vendor_analysis");
  });

  it("maps access and missing-version failures to their statuses", async () => {
    for (const [err, status] of [
      [new ForbiddenError("denied"), 403],
      [new NotFoundError("No key-report version for this company."), 404],
    ] as const) {
      const { app } = stub({ vendorDetail: () => Promise.reject(err) });
      await request(app)
        .get(`/reports/profit-loss/detail-vendor?clientId=${COMPANY}`)
        .expect(status);
    }
  });
});

describe("the balance-sheet validation route", () => {
  it("answers under the envelope, and 400s without a company", async () => {
    const { app, calls } = stub();
    await request(app).get("/manual-gl/validation/balance-sheet").expect(400);
    const res = await request(app)
      .get(`/manual-gl/validation/balance-sheet?clientId=${COMPANY}`)
      .expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.validation.isValid).toBe(true);
    expect(argsOf(calls, "validateBalanceSheet")[1]).toBe(COMPANY);
  });

  it("maps access and missing-version failures to their statuses", async () => {
    for (const [err, status] of [
      [new ForbiddenError("denied"), 403],
      [new NotFoundError("No key-report version for this company."), 404],
    ] as const) {
      const { app } = stub({ validateBalanceSheet: () => Promise.reject(err) });
      await request(app)
        .get(`/manual-gl/validation/balance-sheet?clientId=${COMPANY}`)
        .expect(status);
    }
  });
});

describe("the filter-options route", () => {
  it("answers under the envelope, and 400s without a company", async () => {
    const { app, calls } = stub();
    await request(app).get("/manual-gl/staging/filter-options").expect(400);
    const res = await request(app)
      .get(`/manual-gl/staging/filter-options?clientId=${COMPANY}`)
      .expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.options.reportType).toEqual(["profit_loss", "balance_sheet"]);
    expect(argsOf(calls, "filterOptions")[1]).toBe(COMPANY);
  });

  it("maps access and missing-version failures to their statuses", async () => {
    for (const [err, status] of [
      [new ForbiddenError("denied"), 403],
      [new NotFoundError("No key-report version for this company."), 404],
    ] as const) {
      const { app } = stub({ filterOptions: () => Promise.reject(err) });
      await request(app)
        .get(`/manual-gl/staging/filter-options?clientId=${COMPANY}`)
        .expect(status);
    }
  });
});

describe("the mappings routes", () => {
  const MAPPING = "mmmmmmmm-mmmm-4mmm-8mmm-mmmmmmmmmmmm";
  const DOCUMENT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

  it("lists under the envelope the page reads", async () => {
    const { app, calls } = stub();
    const res = await request(app).get(`/key-reports/versions/${VERSION}/mappings`).expect(200);
    expect(res.body.success).toBe(true);
    expect(Object.keys(res.body.mappingsByCategory)).toContain("profit_loss");
    expect(argsOf(calls, "listMappings")[1]).toBe(VERSION);
  });

  it("takes one document or many, because both screens exist", async () => {
    const { app, calls } = stub();
    await request(app)
      .post(`/key-reports/versions/${VERSION}/mappings`)
      .send({ reportCategory: "profit_loss", documentId: DOCUMENT })
      .expect(201);
    expect(argsOf(calls, "linkMappings")[2]).toEqual({
      reportCategory: "profit_loss",
      documentIds: [DOCUMENT],
    });

    await request(app)
      .post(`/key-reports/versions/${VERSION}/mappings`)
      .send({ reportCategory: "general_ledger", documentIds: [DOCUMENT, MAPPING] })
      .expect(201);
    expect(argsOf(calls, "linkMappings")[2]).toEqual({
      reportCategory: "general_ledger",
      documentIds: [DOCUMENT, MAPPING],
    });
  });

  it("passes an empty selection through, for the service to refuse", async () => {
    // The router does not second-guess it: the category and the emptiness are
    // both checked in the service, so one place decides what is valid.
    const { app, calls } = stub();
    await request(app)
      .post(`/key-reports/versions/${VERSION}/mappings`)
      .send({ reportCategory: "profit_loss" })
      .expect(201);
    expect(argsOf(calls, "linkMappings")[2]).toEqual({
      reportCategory: "profit_loss",
      documentIds: [],
    });
  });

  it("surfaces the service's refusal as a 400", async () => {
    const { app } = stub({
      linkMappings: () => Promise.reject(new BadRequestError("documentId(s) required.")),
    });
    await request(app)
      .post(`/key-reports/versions/${VERSION}/mappings`)
      .send({ reportCategory: "profit_loss" })
      .expect(400);
  });

  it("answers 204 on unlink, addressed by mapping id", async () => {
    const { app, calls } = stub();
    await request(app).delete(`/key-reports/mappings/${MAPPING}`).expect(204);
    expect(argsOf(calls, "deleteMapping")[1]).toBe(MAPPING);
  });

  it("maps the failures to their statuses", async () => {
    for (const [err, status] of [
      [new BadRequestError("Invalid report category: cashflow"), 400],
      [new ForbiddenError("denied"), 403],
      [new NotFoundError("Mapping not found."), 404],
    ] as const) {
      const { app } = stub({ deleteMapping: () => Promise.reject(err) });
      await request(app).delete(`/key-reports/mappings/${MAPPING}`).expect(status);
    }
  });

  it("does not read `mappings` as a version id", async () => {
    // `/key-reports/mappings/:id` and `/key-reports/versions/:id/mappings` are
    // different routes that share a word.
    const { app, calls } = stub();
    await request(app).delete(`/key-reports/mappings/${MAPPING}`).expect(204);
    expect(calls.map((c) => c.method)).toEqual(["deleteMapping"]);
  });
});

describe("sync logs and the popup preference", () => {
  it("serves the log under the envelope, with no limit by default", async () => {
    const { app, calls } = stub();
    const res = await request(app)
      .get(`/key-reports/versions/${VERSION}/sync-logs`)
      .expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.syncLogs).toHaveLength(1);
    expect(argsOf(calls, "listSyncLogs")[2]).toBeUndefined();
  });

  it("passes a limit through, and ignores one that is not a number", async () => {
    const { app, calls } = stub();
    await request(app).get(`/key-reports/versions/${VERSION}/sync-logs?limit=5`).expect(200);
    expect(argsOf(calls, "listSyncLogs")[2]).toBe(5);

    await request(app).get(`/key-reports/versions/${VERSION}/sync-logs?limit=all`).expect(200);
    expect(argsOf(calls, "listSyncLogs")[2]).toBeUndefined();
  });

  it("reads and writes the preference for the caller in the session", async () => {
    const { app, calls } = stub();
    const read = await request(app).get("/key-reports/popup-preference").expect(200);
    expect(read.body).toEqual({ success: true, dismissed: false });

    const written = await request(app)
      .put("/key-reports/popup-preference")
      .send({ dismissed: true })
      .expect(200);
    expect(written.body).toEqual({ success: true, dismissed: true });
    // The caller comes from the session, never from the body or the query.
    expect(argsOf(calls, "setPopupDismissed")[0]).toMatchObject({ id: "caller-1" });
  });

  it('accepts the string "true", because some callers send a form value', async () => {
    const { app, calls } = stub();
    await request(app).put("/key-reports/popup-preference").send({ dismissed: "true" }).expect(200);
    expect(argsOf(calls, "setPopupDismissed")[1]).toBe(true);
  });

  it("treats anything else as not dismissed rather than erroring", async () => {
    // The worst outcome of a bad body here is the popup shown once more.
    const { app, calls } = stub();
    for (const body of [{}, { dismissed: "yes" }, { dismissed: 1 }, { dismissed: null }]) {
      await request(app).put("/key-reports/popup-preference").send(body).expect(200);
      expect(argsOf(calls, "setPopupDismissed")[1]).toBe(false);
    }
  });

  it("does not read `popup-preference` as a version id", async () => {
    // `/key-reports/popup-preference` and `/key-reports/versions/:id` are
    // siblings under the same prefix.
    const { app, calls } = stub();
    await request(app).get("/key-reports/popup-preference").expect(200);
    expect(calls.map((c) => c.method)).toEqual(["getPopupDismissed"]);
  });

  it("maps a version the caller cannot reach to 403", async () => {
    const { app } = stub({ listSyncLogs: () => Promise.reject(new ForbiddenError("denied")) });
    await request(app).get(`/key-reports/versions/${VERSION}/sync-logs`).expect(403);
  });
});
