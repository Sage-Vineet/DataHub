import express from "express";
import type { RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { BadRequestError, ForbiddenError } from "../../shared/errors.js";
import type { SyncService } from "../sync/service.js";
import { createGlImportRouter } from "./router.js";
import { SheetParseError } from "./sheet.js";
import type { GlImportService } from "./service.js";

/**
 * The ledger-import HTTP surface.
 *
 * Two things live here rather than in the service: reading the two spellings
 * of the upload list that both arrive from the SPA, and starting the import as
 * a `sync_runs` row before answering — so a process that dies mid-import
 * leaves something reapable rather than a screen saying "idle" while rows are
 * still landing.
 */

const COMPANY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UPLOAD = "uuuuuuuu-uuuu-4uuu-8uuu-uuuuuuuuuuuu";
const VERSION = "vvvvvvvv-vvvv-4vvv-8vvv-vvvvvvvvvvvv";

const VIEW = {
  uploadId: UPLOAD,
  fileName: "gl.csv",
  columns: ["Date", "Account", "Amount"],
  sheetName: "Sheet1",
  sheetNames: ["Sheet1"],
  sample: [],
  rowCount: 2,
  mapping: { date: "Date" },
  confidence: {},
  sources: {},
  missingRequired: [],
  lowConfidenceFields: [],
  canAutoProcess: true,
  confirmed: false,
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
    columns: record("columns", VIEW),
    saveMapping: record("saveMapping", { uploadId: UPLOAD, mapping: VIEW.mapping }),
    preview: record("preview", { fileName: "gl.csv", mapping: VIEW.mapping, rows: [], skipped: {} }),
    stage: record("stage", { inserted: 2, skipped: {}, fiscalYears: [2024], files: [] }),
    ...(over.service as object | undefined),
  } as unknown as GlImportService;

  const sync = {
    start: record("start", { id: "run-1" }),
    advance: record("advance", undefined),
    finish: record("finish", undefined),
    ...(over.sync as object | undefined),
  } as unknown as SyncService;

  const app = express();
  app.use(createGlImportRouter({ service, sync, requireAuth: authAs("caller-1") }));
  return { app, calls };
}

const argsOf = (calls: Array<{ method: string; args: unknown[] }>, method: string) =>
  calls.filter((c) => c.method === method).at(-1)!.args;

/** One argument, as the object it is, so a test can read a field off it. */
const argAt = (
  calls: Array<{ method: string; args: unknown[] }>,
  method: string,
  index: number,
): Record<string, unknown> => argsOf(calls, method)[index] as Record<string, unknown>;

const post = (app: express.Express, path: string, body: unknown = undefined) => {
  const r = request(app).post(path).set("x-client-id", COMPANY);
  return body === undefined ? r : r.send(body as object);
};

describe("reading a file's columns", () => {
  it("answers the view under the envelope the page reads", async () => {
    const { app, calls } = stub();
    const res = await request(app)
      .get(`/manual-gl/columns/${UPLOAD}`)
      .set("x-client-id", COMPANY)
      .expect(200);

    expect(res.body).toMatchObject({ success: true, fileName: "gl.csv", rowCount: 2 });
    expect(argsOf(calls, "columns")[2]).toBe(UPLOAD);
  });

  it("reports a file it cannot parse as a 400, not a 500", async () => {
    // The fix is "upload a different file", and a 500 sends somebody looking
    // for a fault in the server instead.
    const { app } = stub({
      service: {
        columns: () => Promise.reject(new SheetParseError("gl.png", "not a spreadsheet")),
      },
    });
    const res = await request(app)
      .get(`/manual-gl/columns/${UPLOAD}`)
      .set("x-client-id", COMPANY)
      .expect(400);
    expect(res.body.error).toMatch(/Unable to read "gl.png"/);
  });
});

describe("saving a mapping", () => {
  it("passes the upload and the mapping through", async () => {
    const { app, calls } = stub();
    await post(app, "/manual-gl/save-mapping", {
      uploadId: UPLOAD,
      mapping: { date: "Date", account_name: "Account" },
    }).expect(200);

    expect(argsOf(calls, "saveMapping")[2]).toMatchObject({
      uploadId: UPLOAD,
      mapping: { date: "Date", account_name: "Account" },
    });
  });

  it("takes a request with no body at all", async () => {
    // Reaches the service with an empty upload id, which is where the refusal
    // lives — one place decides what a missing upload means.
    const { app, calls } = stub();
    await post(app, "/manual-gl/save-mapping").expect(200);
    expect(argsOf(calls, "saveMapping")[2]).toEqual({ uploadId: "", mapping: {} });
  });

  it("maps the service's own 400 rather than 500ing", async () => {
    const { app } = stub({
      service: { saveMapping: () => Promise.reject(new BadRequestError("uploadId is required.")) },
    });
    await post(app, "/manual-gl/save-mapping", {}).expect(400);
  });
});

describe("starting an import", () => {
  it("answers 202 with a run before the work begins", async () => {
    // The run is a row, so a process that dies leaves something reapable —
    // rather than a screen saying "idle" while rows are still landing.
    const { app, calls } = stub();
    const res = await post(app, "/manual-gl/staging/multi-year", {
      versionId: VERSION,
      uploadIds: [UPLOAD],
    }).expect(202);

    expect(res.body).toMatchObject({ success: true, runId: "run-1", jobId: "run-1" });
    expect(argsOf(calls, "start")[2]).toMatchObject({
      sourceKey: "manual_gl_upload",
      kind: "gl_import",
      totalFiles: 1,
    });
  });

  it("reads legacy's spelling of the upload list as well as the current one", async () => {
    // Both arrive from the SPA. Reading only one silently imports nothing.
    const { app, calls } = stub();
    await post(app, "/manual-gl/staging/multi-year", {
      versionId: VERSION,
      glUploadIds: [UPLOAD, "second"],
    }).expect(202);
    expect(argAt(calls, "start", 2).totalFiles).toBe(2);
  });

  it("400s a request with no uploads, and one with no body at all", async () => {
    const { app } = stub();
    await post(app, "/manual-gl/staging/multi-year", {
      versionId: VERSION,
      uploadIds: [],
    }).expect(400);
    await post(app, "/manual-gl/staging/multi-year").expect(400);
  });

  it("drops empty and absent entries from the upload list", async () => {
    // `String(null)` is `"null"`, which would reach the store as an upload id
    // and 404 "no such upload" rather than being ignored as the absent entry
    // it is.
    const { app, calls } = stub();
    await post(app, "/manual-gl/staging/multi-year", {
      versionId: VERSION,
      uploadIds: [UPLOAD, "", "   ", null, undefined, { id: "x" }],
    }).expect(202);
    expect(argAt(calls, "start", 2).totalFiles).toBe(1);
  });

  it("400s a list that is not a list", async () => {
    const { app } = stub();
    await post(app, "/manual-gl/staging/multi-year", {
      versionId: VERSION,
      uploadIds: "one-upload",
    }).expect(400);
  });

  it("passes a fiscal year start month through, and omits one that is not a number", async () => {
    const { app, calls } = stub();
    await post(app, "/manual-gl/staging/multi-year", {
      versionId: VERSION,
      uploadIds: [UPLOAD],
      fiscalYearStartMonth: 7,
    }).expect(202);
    await new Promise((r) => setImmediate(r));
    expect(argsOf(calls, "stage")[2]).toMatchObject({ fiscalYearStartMonth: 7 });

    const { app: bare, calls: bareCalls } = stub();
    await post(bare, "/manual-gl/staging/multi-year", {
      versionId: VERSION,
      uploadIds: [UPLOAD],
      fiscalYearStartMonth: "whenever",
    }).expect(202);
    await new Promise((r) => setImmediate(r));
    expect(argAt(bareCalls, "stage", 2).fiscalYearStartMonth).toBeUndefined();
  });

  it("records the failure on the run rather than losing it", async () => {
    // The response is already sent, so a failure here cannot reach the client.
    // The run is where it goes.
    const { app, calls } = stub({
      service: { stage: () => Promise.reject(new Error("the sheet is corrupt")) },
    });
    await post(app, "/manual-gl/staging/multi-year", {
      versionId: VERSION,
      uploadIds: [UPLOAD],
    }).expect(202);

    await new Promise((r) => setTimeout(r, 10));
    expect(argsOf(calls, "finish")[3]).toMatchObject({ status: "failed" });
  });

  it("finishes the run when the import lands", async () => {
    const { app, calls } = stub();
    await post(app, "/manual-gl/staging/multi-year", {
      versionId: VERSION,
      uploadIds: [UPLOAD],
    }).expect(202);

    await new Promise((r) => setTimeout(r, 10));
    expect(argsOf(calls, "finish")[3]).toMatchObject({
      status: "completed",
      result: { inserted: 2 },
    });
  });
});

describe("naming the company", () => {
  it("takes it from the header, the query, or the body", async () => {
    // Different screens supply it differently; all three must work.
    const { app, calls } = stub();
    await request(app).get(`/manual-gl/columns/${UPLOAD}`).set("x-client-id", COMPANY).expect(200);
    expect(argsOf(calls, "columns")[1]).toBe(COMPANY);

    const { app: byQuery, calls: queryCalls } = stub();
    await request(byQuery).get(`/manual-gl/columns/${UPLOAD}?clientId=${COMPANY}`).expect(200);
    expect(argsOf(queryCalls, "columns")[1]).toBe(COMPANY);

    const { app: byBody, calls: bodyCalls } = stub();
    await request(byBody)
      .post("/manual-gl/save-mapping")
      .send({ clientId: COMPANY, uploadId: UPLOAD, mapping: {} })
      .expect(200);
    expect(argsOf(bodyCalls, "saveMapping")[1]).toBe(COMPANY);
  });

  it("passes an empty company on, for the service to refuse", async () => {
    const { app, calls } = stub();
    await request(app).get(`/manual-gl/columns/${UPLOAD}`).expect(200);
    expect(argsOf(calls, "columns")[1]).toBe("");
  });

  it("maps a service refusal to its own status rather than 500ing", async () => {
    const { app } = stub({
      service: { columns: () => Promise.reject(new ForbiddenError("Access denied")) },
    });
    await request(app).get(`/manual-gl/columns/${UPLOAD}`).set("x-client-id", COMPANY).expect(403);
  });

  it("records a failure that is not an Error at all on the run", async () => {
    // A thrown string reaches the same place a thrown Error does — the run —
    // and must be readable there rather than logged as "[object Object]".
    const { app, calls } = stub({ service: { stage: () => Promise.reject("the sheet is corrupt") } });
    await post(app, "/manual-gl/staging/multi-year", {
      versionId: VERSION,
      uploadIds: [UPLOAD],
    }).expect(202);

    await new Promise((r) => setTimeout(r, 10));
    expect(argsOf(calls, "finish")[3]).toMatchObject({
      status: "failed",
      errorMessage: "the sheet is corrupt",
    });
  });
});
