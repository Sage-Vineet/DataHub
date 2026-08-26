import express from "express";
import type { RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { NotFoundError } from "../../shared/errors.js";
import type { SyncService } from "../sync/service.js";
import { createDatasetsRouter } from "./router.js";
import type { DatasetsService } from "./service.js";

/**
 * Dataset versions and the upload jobs that produce them.
 *
 * The router's own decisions are which query narrowing reached the service and
 * what the wire shape is. Both matter more than usual here: the SPA's store
 * calls `.find()` on the versions response, so an envelope alone hands it an
 * object with no `.find`.
 */

const COMPANY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const VERSION = {
  id: "vvvvvvvv-vvvv-4vvv-8vvv-vvvvvvvvvvvv",
  versionNumber: 3,
  label: "March import",
  sourceKey: "manual_gl_upload",
  status: "finalized",
  isActive: true,
  rowCount: 1200,
  fiscalYears: [2024, 2025],
  finalizedAt: "2026-01-01T00:00:00.000Z",
  activatedAt: "2026-01-02T00:00:00.000Z",
  createdAt: "2025-12-31T00:00:00.000Z",
};

const JOB = { id: "job-1", status: "completed", processedFiles: 4, totalFiles: 4 };

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
    list: record("list", [VERSION]),
    activate: record("activate", VERSION),
    rollback: record("rollback", { ...VERSION, isActive: false }),
    ...(over.service as object | undefined),
  } as unknown as DatasetsService;

  const sync = {
    history: record("history", [JOB]),
    progress: record("progress", { runId: "job-1", percentage: 100, active: false }),
    ...(over.sync as object | undefined),
  } as unknown as SyncService;

  const app = express();
  app.use(createDatasetsRouter({ service, sync, requireAuth: authAs("caller-1") }));
  return { app, calls };
}

const argsOf = (calls: Array<{ method: string; args: unknown[] }>, method: string) =>
  calls.filter((c) => c.method === method).at(-1)!.args;

const get = (app: express.Express, path: string) =>
  request(app).get(path).set("x-client-id", COMPANY);

describe("listing dataset versions", () => {
  it("answers a bare array, because the store calls .find on it", async () => {
    // `const versions = await listManualGlDatasetVersions(...); versions.find(...)`.
    // An envelope alone gives it an object with no `.find`, and the page fails
    // with a type error rather than an empty list.
    const { app } = stub();
    const res = await get(app, "/manual-gl/dataset-versions").expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0]).toMatchObject({ id: VERSION.id, versionNumber: 3, value: 3 });
  });

  it("carries both spellings of is_active, which the page reads either way", async () => {
    const { app } = stub();
    const res = await get(app, "/manual-gl/dataset-versions").expect(200);
    expect(res.body[0].isActive).toBe(true);
    expect(res.body[0].is_active).toBe(true);
  });

  it("passes a source and a limit through when they are given", async () => {
    const { app, calls } = stub();
    await get(app, "/manual-gl/dataset-versions?sourceType=manual_gl_upload&limit=5").expect(200);
    expect(argsOf(calls, "list")[2]).toEqual({ sourceKey: "manual_gl_upload", limit: 5 });
  });

  it("narrows by nothing when neither is given", async () => {
    // A limit of NaN is not a limit. Passing it on would reach the query as
    // `LIMIT NaN` or as zero rows, depending on the driver.
    const { app, calls } = stub();
    await get(app, "/manual-gl/dataset-versions").expect(200);
    expect(argsOf(calls, "list")[2]).toEqual({});
  });

  it("ignores a limit that is not a number", async () => {
    const { app, calls } = stub();
    await get(app, "/manual-gl/dataset-versions?limit=all").expect(200);
    expect(argsOf(calls, "list")[2]).toEqual({});
  });

  it("ignores a source sent as anything but a string", async () => {
    const { app, calls } = stub();
    await get(app, "/manual-gl/dataset-versions?sourceType[]=a&sourceType[]=b").expect(200);
    expect(argsOf(calls, "list")[2]).toEqual({});
  });
});

describe("activating and rolling back", () => {
  it("activates the version named in the path", async () => {
    const { app, calls } = stub();
    const res = await request(app)
      .post(`/manual-gl/dataset-versions/${VERSION.id}/activate`)
      .set("x-client-id", COMPANY)
      .expect(200);

    expect(res.body.version.is_active).toBe(true);
    expect(argsOf(calls, "activate")[2]).toBe(VERSION.id);
  });

  it("rolls back the version named in the path", async () => {
    const { app, calls } = stub();
    const res = await request(app)
      .post(`/manual-gl/dataset-versions/${VERSION.id}/rollback`)
      .set("x-client-id", COMPANY)
      .expect(200);

    expect(res.body.version.is_active).toBe(false);
    expect(argsOf(calls, "rollback")[2]).toBe(VERSION.id);
  });

  it("maps the service's own status rather than 500ing", async () => {
    const { app } = stub({
      service: { activate: () => Promise.reject(new NotFoundError("No such version.")) },
    });
    await request(app)
      .post(`/manual-gl/dataset-versions/${VERSION.id}/activate`)
      .set("x-client-id", COMPANY)
      .expect(404);
  });
});

describe("upload jobs", () => {
  it("lists them", async () => {
    const { app } = stub();
    const res = await get(app, "/manual-gl/upload-jobs").expect(200);
    expect(res.body.jobs).toEqual([JOB]);
  });

  it("passes a limit through, and none when it is not a number", async () => {
    const { app, calls } = stub();
    await get(app, "/manual-gl/upload-jobs?limit=7").expect(200);
    expect(argsOf(calls, "history")[2]).toBe(7);

    const { app: bare, calls: bareCalls } = stub();
    await get(bare, "/manual-gl/upload-jobs").expect(200);
    expect(argsOf(bareCalls, "history")[2]).toBeUndefined();
  });

  it("attaches live progress only to the run it is about", async () => {
    // A finished job would otherwise render somebody else's progress bar.
    const { app } = stub();
    const mine = await get(app, "/manual-gl/upload-jobs/job-1").expect(200);
    expect(mine.body.progress).toBeTruthy();

    const { app: other } = stub({
      sync: {
        history: () => Promise.resolve([{ ...JOB, id: "job-2" }]),
        progress: () => Promise.resolve({ runId: "job-1", percentage: 40, active: true }),
      },
    });
    const theirs = await get(other, "/manual-gl/upload-jobs/job-2").expect(200);
    expect(theirs.body.job.id).toBe("job-2");
    expect(theirs.body.progress).toBeUndefined();
  });

  it("404s an id no job has", async () => {
    const { app } = stub();
    const res = await get(app, "/manual-gl/upload-jobs/nope").expect(404);
    expect(res.body.error).toMatch(/No upload job/);
  });
});

describe("naming the company", () => {
  it("takes it from the header, the query, or the body", async () => {
    const { app, calls } = stub();
    await get(app, "/manual-gl/dataset-versions").expect(200);
    expect(argsOf(calls, "list")[1]).toBe(COMPANY);

    const { app: byQuery, calls: queryCalls } = stub();
    await request(byQuery).get(`/manual-gl/dataset-versions?clientId=${COMPANY}`).expect(200);
    expect(argsOf(queryCalls, "list")[1]).toBe(COMPANY);

    const { app: byBody, calls: bodyCalls } = stub();
    await request(byBody)
      .post(`/manual-gl/dataset-versions/${VERSION.id}/activate`)
      .send({ clientId: COMPANY })
      .expect(200);
    expect(argsOf(bodyCalls, "activate")[1]).toBe(COMPANY);
  });

  it("passes an empty company on, for the service to refuse", async () => {
    const { app, calls } = stub();
    await request(app).get("/manual-gl/dataset-versions").expect(200);
    expect(argsOf(calls, "list")[1]).toBe("");
  });
});
