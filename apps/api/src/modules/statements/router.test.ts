import express from "express";
import type { RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../shared/errors.js";
import type { CashFlowService } from "./cash-flow.js";
import type { DashboardService, TaxComparisonService } from "./dashboard.js";
import type { TaxReturnService } from "./tax-return.js";
import { createStatementsRouter } from "./router.js";
import type { StatementsService } from "./service.js";

/**
 * The statements HTTP contract.
 *
 * The router's own decisions are which of the three narrowing options the
 * caller supplied and what the wire shape is. `rowId` is accepted alongside
 * `extractId` because that is what legacy called it and existing callers still
 * send it.
 */

const COMPANY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EXTRACT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const DOCUMENT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const VERSION = "vvvvvvvv-vvvv-4vvv-8vvv-vvvvvvvvvvvv";

const EXTRACT_ROW = {
  id: EXTRACT,
  companyId: COMPANY,
  documentId: DOCUMENT,
  documentName: "BS 2024.pdf",
  statementType: "balance_sheet",
  uploadId: null,
  sourceKey: "manual_upload_excel_pdf",
  periodStart: null,
  periodEnd: null,
  asOfDate: "2024-12-31",
  fiscalYear: 2024,
  payload: { rows: [{ name: "Cash", amount: 100 }] },
  extractedAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

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
    resolve: record("resolve", EXTRACT_ROW),
    list: record("list", [EXTRACT_ROW]),
    sourceTree: record("sourceTree", [
      { documentId: DOCUMENT, documentName: "BS 2024.pdf", statements: [] },
    ]),
    ...over,
  } as unknown as StatementsService;

  const cashFlow = {
    periods: record("periods", [{ fiscalYear: 2024, hasPriorBalanceSheet: true }]),
    forFiscalYear: record("forFiscalYear", { fiscalYear: 2024, method: "indirect" }),
    ...(over.cashFlow as object | undefined),
  } as unknown as CashFlowService;

  const dashboard = {
    build: record("build", {
      years: ["All Files"],
      reports: {},
      allFiles: { kpis: {} },
      trends: [],
    }),
    ...(over.dashboard as object | undefined),
  } as unknown as DashboardService;

  const taxReturn =
    over.taxReturn === null
      ? undefined
      : ({
          read: record("read", {
            figures: {
              year: 2023,
              formType: "1120-S",
              totalRevenue: 1250000,
              totalCostOfGoodsSold: 500000,
              grossProfit: 750000,
              officerWages: 120000,
              depreciation: 45000,
              amortization: 5000,
              interestExpense: 30000,
              netIncome: 400000,
              allOtherExpenses: 150000,
              reconcilingItems: [{ label: "Meals", value: 12500 }],
            },
            documentId: "doc-1",
            documentName: "Return 2023.pdf",
            extractedAt: "2025-01-01T00:00:00.000Z",
            source: "stored",
          }),
          ...(over.taxReturn as object | undefined),
        } as unknown as TaxReturnService);

  const taxComparison = {
    build: record("buildTaxComparison", {
      years: { "2024": { year: 2024, totalRevenue: 1000000, fileName: "PL 2024.pdf" } },
      source: "parsed_rows",
    }),
    ...(over.taxComparison as object | undefined),
  } as unknown as TaxComparisonService;

  const app = express();
  app.use(
    createStatementsRouter({
      service,
      cashFlow,
      dashboard,
      taxComparison,
      ...(taxReturn ? { taxReturn } : {}),
      requireAuth: authAs("caller-1"),
    }),
  );
  return { app, calls };
}

const argsOf = (calls: Array<{ method: string; args: unknown[] }>, method: string) =>
  calls.filter((c) => c.method === method).at(-1)!.args;

const latest = (app: express.Express, query = "") =>
  request(app)
    .get(`/manual-report-uploads/reports/balance_sheet/latest${query}`)
    .set("x-client-id", COMPANY);

describe("the latest statement", () => {
  it("answers the payload directly, not an envelope inside an envelope", async () => {
    // Legacy nested it as `data.manual_report_upload.report`.
    const { app } = stub();
    const res = await latest(app).expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual({ rows: [{ name: "Cash", amount: 100 }] });
  });

  it("names the document the statement was read out of", async () => {
    // Legacy did not, so a reader who doubted a figure had no way back to it.
    const { app } = stub();
    const res = await latest(app).expect(200);
    expect(res.body.documentId).toBe(DOCUMENT);
    expect(res.body.documentName).toBe("BS 2024.pdf");
    expect(res.body.extractId).toBe(EXTRACT);
  });

  it("carries the period and the source for the page to render", async () => {
    const { app } = stub();
    const res = await latest(app).expect(200);
    expect(res.body.asOfDate).toBe("2024-12-31");
    expect(res.body.fiscalYear).toBe(2024);
    expect(res.body.source).toBe("manual_upload_excel_pdf");
    expect(res.body.statementType).toBe("balance_sheet");
  });

  it("lower-cases the statement type from the path", async () => {
    const { app, calls } = stub();
    await request(app)
      .get("/manual-report-uploads/reports/BALANCE_SHEET/latest")
      .set("x-client-id", COMPANY)
      .expect(200);
    expect(argsOf(calls, "resolve")[2]).toBe("balance_sheet");
  });

  it("passes each narrowing option through", async () => {
    const { app, calls } = stub();
    await latest(app, `?extractId=${EXTRACT}`).expect(200);
    expect(argsOf(calls, "resolve")[3]).toEqual({ sourceKey: "manual_upload_excel_pdf", extractId: EXTRACT });

    await latest(app, `?keyReportVersionId=${VERSION}`).expect(200);
    expect(argsOf(calls, "resolve")[3]).toEqual({ sourceKey: "manual_upload_excel_pdf", keyReportVersionId: VERSION });

    await latest(app, "?sourceKey=quickbooks_online").expect(200);
    expect(argsOf(calls, "resolve")[3]).toEqual({ sourceKey: "quickbooks_online" });
  });

  it("still answers to `rowId`, which is what legacy called it", async () => {
    const { app, calls } = stub();
    await latest(app, `?rowId=${EXTRACT}`).expect(200);
    expect(argsOf(calls, "resolve")[3]).toEqual({ sourceKey: "manual_upload_excel_pdf", extractId: EXTRACT });
  });

  it("omits an option the caller left blank rather than passing an empty string", async () => {
    // An empty `extractId` would otherwise look like a request for the extract
    // whose id is "", and 404 instead of falling through to the latest.
    const { app, calls } = stub();
    await latest(app, "?extractId=&keyReportVersionId=").expect(200);
    expect(argsOf(calls, "resolve")[3]).toEqual({ sourceKey: "manual_upload_excel_pdf" });
  });

  it("404s when nothing has been extracted", async () => {
    const { app } = stub({
      resolve: () => Promise.reject(new NotFoundError("No statement has been extracted.")),
    });
    const res = await latest(app).expect(404);
    expect(res.body).toEqual({ success: false, error: "No statement has been extracted." });
  });

  it("400s an unknown statement type", async () => {
    const { app } = stub({
      resolve: () => Promise.reject(new BadRequestError("Invalid statementType: nope.")),
    });
    await request(app)
      .get("/manual-report-uploads/reports/nope/latest")
      .set("x-client-id", COMPANY)
      .expect(400);
  });

  it("403s a company the caller cannot reach", async () => {
    const { app } = stub({ resolve: () => Promise.reject(new ForbiddenError("Access denied")) });
    await latest(app).expect(403);
  });
});

describe("every statement of a type", () => {
  it("answers files a person could pick between, named by their file", async () => {
    // The picker's option label. An extract with no name to show is an entry
    // in a dropdown that cannot be told from its neighbour.
    const { app } = stub();
    const res = await request(app)
      .get("/manual-report-uploads/reports/balance_sheet/all")
      .set("x-client-id", COMPANY)
      .expect(200);
    expect(res.body.files).toHaveLength(1);
    expect(res.body.files[0].fileName).toBe("BS 2024.pdf");
    expect(res.body.files[0].data).toEqual({ rows: [{ name: "Cash", amount: 100 }] });
  });

  it("keys each file by the id the picker sets as its value", async () => {
    // `rowId` is legacy's name for the extract id. The Reports page reads it
    // to decide which file stays selected across a reload; renaming it empties
    // the dropdown silently.
    const { app } = stub();
    const res = await request(app)
      .get("/manual-report-uploads/reports/balance_sheet/all")
      .set("x-client-id", COMPANY)
      .expect(200);
    expect(res.body.files[0].rowId).toBe(EXTRACT);
  });

  it("says which file it could not name rather than omitting the field", async () => {
    // A statement pulled from an API has no document. The picker still has to
    // render a row for it, and `undefined` renders as nothing at all.
    const { app } = stub({
      list: () => Promise.resolve([{ ...EXTRACT_ROW, documentId: null, documentName: null }]),
    });
    const res = await request(app)
      .get("/manual-report-uploads/reports/balance_sheet/all")
      .set("x-client-id", COMPANY)
      .expect(200);
    expect(res.body.files[0].fileName).toBe("Unknown file");
  });

  it("narrows the list to a key-report version when one is named", async () => {
    // The picker has to agree with what the page is showing. Options the
    // version was never signed off against are worse than no options.
    const { app, calls } = stub();
    await request(app)
      .get("/manual-report-uploads/reports/balance_sheet/all?keyReportVersionId=v-1")
      .set("x-client-id", COMPANY)
      .expect(200);
    expect(argsOf(calls, "list")[3]).toEqual({ sourceKey: "manual_upload_excel_pdf", keyReportVersionId: "v-1" });
  });

  it("passes a fiscal year filter, and ignores one that is not a year", async () => {
    const { app, calls } = stub();
    await request(app)
      .get("/manual-report-uploads/reports/balance_sheet/all?fiscalYear=2024")
      .set("x-client-id", COMPANY)
      .expect(200);
    expect(argsOf(calls, "list")[3]).toEqual({ sourceKey: "manual_upload_excel_pdf", fiscalYear: 2024 });

    await request(app)
      .get("/manual-report-uploads/reports/balance_sheet/all?fiscalYear=recent")
      .set("x-client-id", COMPANY)
      .expect(200);
    expect(argsOf(calls, "list")[3]).toEqual({ sourceKey: "manual_upload_excel_pdf" });
  });

  it("does not read `all` as a statement type", async () => {
    // `/reports/:type/all` and `/reports/:type/latest` are siblings.
    const { app, calls } = stub();
    await request(app)
      .get("/manual-report-uploads/reports/balance_sheet/all")
      .set("x-client-id", COMPANY)
      .expect(200);
    expect(calls.map((c) => c.method)).toEqual(["list"]);
  });
});

describe("the source tree", () => {
  it("lists the documents and what was read out of them", async () => {
    const { app, calls } = stub();
    const res = await request(app)
      .get("/manual-report-uploads/source-tree")
      .set("x-client-id", COMPANY)
      .expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.tree[0].documentId).toBe(DOCUMENT);
    expect(argsOf(calls, "sourceTree")[2]).toEqual({ sourceKey: "manual_upload_excel_pdf" });
  });

  it("narrows to one source when asked", async () => {
    const { app, calls } = stub();
    await request(app)
      .get("/manual-report-uploads/source-tree?sourceKey=quickbooks_online")
      .set("x-client-id", COMPANY)
      .expect(200);
    expect(argsOf(calls, "sourceTree")[2]).toEqual({ sourceKey: "quickbooks_online" });
  });
});

describe("paths this router does not own", () => {
  it("leaves them for the proxy", async () => {
    // An unmatched path has to reach the proxy untouched, which is what
    // 404-from-this-router means in isolation.
    //
    // `qms-dashboard` and `tax-data` were both listed here and no longer are:
    // this router serves them now, and leaving the assertions would have
    // pinned the routes as absent rather than noticing they had arrived.
    const { app } = stub();
    await request(app).get("/manual-report-uploads/qms-bank-data").expect(404);
  });
});

describe("the books' side of the tax reconciliation", () => {
  it("answers a year per uploaded P&L", async () => {
    const { app } = stub();
    const res = await request(app)
      .get("/manual-report-uploads/pl-for-tax")
      .set("x-client-id", COMPANY)
      .expect(200);
    expect(res.body.years["2024"].totalRevenue).toBe(1000000);
    expect(res.body.source).toBe("parsed_rows");
  });

  it("reads the manual-upload source unless told otherwise", async () => {
    const { app, calls } = stub();
    await request(app)
      .get("/manual-report-uploads/pl-for-tax")
      .set("x-client-id", COMPANY)
      .expect(200);
    expect(argsOf(calls, "buildTaxComparison")[2]).toBe("manual_upload_excel_pdf");

    await request(app)
      .get("/manual-report-uploads/pl-for-tax?sourceKey=quickbooks_manual")
      .set("x-client-id", COMPANY)
      .expect(200);
    expect(argsOf(calls, "buildTaxComparison")[2]).toBe("quickbooks_manual");
  });
});

describe("the tax return", () => {
  it("answers the figures and the nine rows the page renders", async () => {
    const { app } = stub();
    const res = await request(app)
      .get("/tax-data")
      .set("x-client-id", COMPANY)
      .expect(200);
    expect(res.body.taxData.totalRevenue).toBe(1250000);
    expect(res.body.data).toHaveLength(9);
    expect(res.body.data[0]).toEqual({ label: "Total Revenue", taxReturn: 1250000 });
  });

  it("names the document it read", async () => {
    // So a reader who doubts a figure can get back to the file it came from —
    // which the version that read a PDF off the filesystem could not offer.
    const { app } = stub();
    const res = await request(app)
      .get("/tax-data")
      .set("x-client-id", COMPANY)
      .expect(200);
    expect(res.body.documentName).toBe("Return 2023.pdf");
  });

  it("serves both paths the page calls, through one handler", async () => {
    // Two handlers could answer different figures for the same company.
    const { app } = stub();
    const direct = await request(app).get("/tax-data").set("x-client-id", COMPANY).expect(200);
    const prefixed = await request(app)
      .get("/manual-report-uploads/tax-data")
      .set("x-client-id", COMPANY)
      .expect(200);
    expect(prefixed.body.taxData).toEqual(direct.body.taxData);
  });

  it("passes the version and the refresh through", async () => {
    const { app, calls } = stub();
    await request(app)
      .get("/tax-data?keyReportVersionId=v-1&force=1")
      .set("x-client-id", COMPANY)
      .expect(200);
    expect(argsOf(calls, "read")[2]).toEqual({ keyReportVersionId: "v-1", force: true });
  });

  it("omits what the caller did not ask for", async () => {
    const { app, calls } = stub();
    await request(app).get("/tax-data").set("x-client-id", COMPANY).expect(200);
    expect(argsOf(calls, "read")[2]).toEqual({});
  });

  it("says so plainly when no model is configured", async () => {
    // A 503 naming the reason, rather than a 500 from a null.
    const { app } = stub({ taxReturn: null });
    const res = await request(app).get("/tax-data").set("x-client-id", COMPANY).expect(503);
    expect(res.body.error).toMatch(/not configured/);
  });
});

describe("the dashboards", () => {
  it("serves each source under its own path", async () => {
    const { app, calls } = stub();
    await request(app)
      .get("/manual-report-uploads/qms-dashboard")
      .set("x-client-id", COMPANY)
      .expect(200);
    expect(argsOf(calls, "build")[2]).toBe("quickbooks_manual");

    await request(app)
      .get("/manual-report-uploads/manual-upload-dashboard")
      .set("x-client-id", COMPANY)
      .expect(200);
    expect(argsOf(calls, "build")[2]).toBe("manual_upload_excel_pdf");
  });

  it("accepts the source name the page sends", async () => {
    const { app } = stub();
    await request(app)
      .get("/manual-report-uploads/qms-dashboard?source=quickbooks_manual")
      .set("x-client-id", COMPANY)
      .expect(200);
    await request(app)
      .get("/manual-report-uploads/manual-upload-dashboard?source=manual_upload")
      .set("x-client-id", COMPANY)
      .expect(200);
  });

  it("refuses a source belonging to the other dashboard", async () => {
    // The page sends which dashboard it thinks it is showing. Serving one
    // source's figures under another's heading is what this catches.
    const { app } = stub();
    await request(app)
      .get("/manual-report-uploads/qms-dashboard?source=manual_upload")
      .set("x-client-id", COMPANY)
      .expect(400);
  });

  it("answers without a source, because the page does not always send one", async () => {
    const { app } = stub();
    await request(app)
      .get("/manual-report-uploads/manual-upload-dashboard")
      .set("x-client-id", COMPANY)
      .expect(200);
  });
});
