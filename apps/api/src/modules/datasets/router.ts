import express from "express";
import type { Request, RequestHandler, Response, Router } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { HttpError } from "../../shared/errors.js";
import { withCommonMiddleware } from "../../shared/router.js";
import type { SyncService } from "../sync/service.js";
import type { DatasetVersionRecord } from "./ports.js";
import type { DatasetsService } from "./service.js";

export interface DatasetsRouterDeps {
  service: DatasetsService;
  /** Upload jobs are sync runs; the two surfaces share one table. */
  sync: SyncService;
  requireAuth: RequestHandler;
}

/**
 * Dataset versions, and the upload jobs that produce them.
 *
 * `/manual-gl/upload-jobs` is served from `sync_runs` rather than a table of
 * its own. Legacy had `upload_jobs` and `sync_jobs` as separate absent tables
 * carrying the same fields — a job, a status, a progress count, an error — and
 * the only difference was which code path wrote them.
 */
export function createDatasetsRouter(deps: DatasetsRouterDeps): Router {
  const { service, sync, requireAuth } = deps;
  const router = express.Router();
  withCommonMiddleware(router, [helmet(), pinoHttp(), express.json(), requireAuth]);

  const handle =
    (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
    (req, res, next) =>
      fn(req, res).catch((err: unknown) => {
        if (err instanceof HttpError) {
          res.status(err.status).json({ success: false, error: err.message });
          return;
        }
        next(err);
      });

  const companyOf = (req: Request): string =>
    String(
      req.headers["x-client-id"] ??
        req.query.clientId ??
        (req.body as { clientId?: unknown } | undefined)?.clientId ??
        "",
    );

  /**
   * The wire shape the SPA reads.
   *
   * `value` alongside `versionNumber` because the dataset-version store and
   * the CIM autofill both reach for `version.value ?? version.dataset_version
   * ?? version.version_number` — three spellings of one field, and the first
   * one that exists wins. Emitting `value` means the first branch matches.
   */
  const asView = (v: DatasetVersionRecord) => ({
    id: v.id,
    value: v.versionNumber,
    versionNumber: v.versionNumber,
    label: v.label,
    sourceKey: v.sourceKey,
    status: v.status,
    isActive: v.isActive,
    is_active: v.isActive,
    rowCount: v.rowCount,
    fiscalYears: v.fiscalYears,
    finalizedAt: v.finalizedAt,
    activatedAt: v.activatedAt,
    createdAt: v.createdAt,
  });

  router.get("/manual-gl/dataset-versions", handle(async (req, res) => {
    const limit = Number.parseInt(String(req.query.limit ?? ""), 10);
    const sourceKey = typeof req.query.sourceType === "string" ? req.query.sourceType : undefined;
    const versions = await service.list(req.user!, companyOf(req), {
      ...(sourceKey ? { sourceKey } : {}),
      ...(Number.isFinite(limit) ? { limit } : {}),
    });
    // A bare array as well as the envelope: the store does
    // `const versions = await listManualGlDatasetVersions(...)` and then
    // `versions.find(...)`, so an envelope alone would give it an object with
    // no `.find`.
    res.json(versions.map(asView));
  }));

  router.post("/manual-gl/dataset-versions/:id/activate", handle(async (req, res) => {
    const version = await service.activate(req.user!, companyOf(req), req.params.id!);
    res.json({ success: true, version: asView(version) });
  }));

  router.post("/manual-gl/dataset-versions/:id/rollback", handle(async (req, res) => {
    const version = await service.rollback(req.user!, companyOf(req), req.params.id!);
    res.json({ success: true, version: asView(version) });
  }));

  router.get("/manual-gl/upload-jobs", handle(async (req, res) => {
    const limit = Number.parseInt(String(req.query.limit ?? ""), 10);
    const jobs = await sync.history(
      req.user!,
      companyOf(req),
      Number.isFinite(limit) ? limit : undefined,
    );
    res.json({ success: true, jobs });
  }));

  router.get("/manual-gl/upload-jobs/:id", handle(async (req, res) => {
    const progress = await sync.progress(req.user!, companyOf(req));
    const jobs = await sync.history(req.user!, companyOf(req), 100);
    const job = jobs.find((j) => j.id === req.params.id);
    if (!job) {
      res.status(404).json({ success: false, error: "No upload job found for that id." });
      return;
    }
    // The live progress is only about the CURRENT run, so it is attached only
    // when this is that run — otherwise a finished job would render somebody
    // else's progress bar.
    res.json({
      success: true,
      job,
      ...(progress.runId === job.id ? { progress } : {}),
    });
  }));

  return router;
}
