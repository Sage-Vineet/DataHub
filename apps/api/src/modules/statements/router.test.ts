import express from "express";
import type { RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../shared/errors.js";
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

  const app = express();
  app.use(createStatementsRouter({ service, requireAuth: authAs("caller-1") }));
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
    expect(argsOf(calls, "resolve")[3]).toEqual({ extractId: EXTRACT });

    await latest(app, `?keyReportVersionId=${VERSION}`).expect(200);
    expect(argsOf(calls, "resolve")[3]).toEqual({ keyReportVersionId: VERSION });

    await latest(app, "?sourceKey=quickbooks_online").expect(200);
    expect(argsOf(calls, "resolve")[3]).toEqual({ sourceKey: "quickbooks_online" });
  });

  it("still answers to `rowId`, which is what legacy called it", async () => {
    const { app, calls } = stub();
    await latest(app, `?rowId=${EXTRACT}`).expect(200);
    expect(argsOf(calls, "resolve")[3]).toEqual({ extractId: EXTRACT });
  });

  it("omits an option the caller left blank rather than passing an empty string", async () => {
    // An empty `extractId` would otherwise look like a request for the extract
    // whose id is "", and 404 instead of falling through to the latest.
    const { app, calls } = stub();
    await latest(app, "?extractId=&keyReportVersionId=").expect(200);
    expect(argsOf(calls, "resolve")[3]).toEqual({});
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
  it("answers a list in the same per-item shape", async () => {
    const { app } = stub();
    const res = await request(app)
      .get("/manual-report-uploads/reports/balance_sheet/all")
      .set("x-client-id", COMPANY)
      .expect(200);
    expect(res.body.reports).toHaveLength(1);
    expect(res.body.reports[0].documentName).toBe("BS 2024.pdf");
    expect(res.body.reports[0].data).toEqual({ rows: [{ name: "Cash", amount: 100 }] });
  });

  it("passes a fiscal year filter, and ignores one that is not a year", async () => {
    const { app, calls } = stub();
    await request(app)
      .get("/manual-report-uploads/reports/balance_sheet/all?fiscalYear=2024")
      .set("x-client-id", COMPANY)
      .expect(200);
    expect(argsOf(calls, "list")[3]).toEqual({ fiscalYear: 2024 });

    await request(app)
      .get("/manual-report-uploads/reports/balance_sheet/all?fiscalYear=recent")
      .set("x-client-id", COMPANY)
      .expect(200);
    expect(argsOf(calls, "list")[3]).toEqual({});
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
    expect(argsOf(calls, "sourceTree")[2]).toEqual({});
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
    const { app } = stub();
    await request(app).get("/manual-report-uploads/qms-dashboard").expect(404);
    await request(app).get("/manual-report-uploads/tax-data").expect(404);
  });
});
