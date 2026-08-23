import express from "express";
import type { Request, RequestHandler, Response, Router } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { HttpError } from "../../shared/errors.js";
import { withCommonMiddleware } from "../../shared/router.js";
import type { ColumnMapping } from "./column-mapping.js";
import { SheetParseError } from "./sheet.js";
import type { SyncService } from "../sync/service.js";
import type { GlImportService } from "./service.js";

export interface GlImportRouterDeps {
  service: GlImportService;
  /** Staging is a sync run, so its progress survives a restart. */
  sync: SyncService;
  requireAuth: RequestHandler;
}

/**
 * Reading an uploaded general ledger, agreeing what its columns mean, and
 * writing it into a version.
 */
export function createGlImportRouter(deps: GlImportRouterDeps): Router {
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
        // An unreadable file is the user's problem to fix, not a server fault:
        // 400 with the message, which already names the file and what to
        // upload instead.
        if (err instanceof SheetParseError) {
          res.status(400).json({ success: false, error: err.message });
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

  router.get("/manual-gl/columns/:uploadId", handle(async (req, res) => {
    const view = await service.columns(req.user!, companyOf(req), req.params.uploadId!);
    res.json({ success: true, ...view });
  }));

  router.post("/manual-gl/save-mapping", handle(async (req, res) => {
    const body = (req.body ?? {}) as { uploadId?: unknown; mapping?: unknown };
    const saved = await service.saveMapping(req.user!, companyOf(req), {
      uploadId: String(body.uploadId ?? ""),
      mapping: (body.mapping ?? {}) as Partial<ColumnMapping>,
    });
    res.json({ success: true, ...saved });
  }));

  /**
   * What this file would import.
   *
   * Not a legacy path. Legacy went straight from mapping to writing rows, so
   * the first sight of what a mapping actually does was the ledger it had
   * already produced.
   */
  router.get("/manual-gl/preview/:uploadId", handle(async (req, res) => {
    const limit = Number.parseInt(String(req.query.limit ?? ""), 10);
    const preview = await service.preview(req.user!, companyOf(req), req.params.uploadId!);
    const capped = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 500) : 50;
    res.json({
      success: true,
      fileName: preview.fileName,
      mapping: preview.mapping,
      rowCount: preview.rows.length,
      skipped: preview.skipped,
      rows: preview.rows.slice(0, capped),
    });
  }));

  /**
   * Write the uploads into a version.
   *
   * Answers 202 with a run id and does the work afterwards, which is legacy's
   * contract and the right one for a job that takes minutes.
   *
   * What is different is where the progress lives. Legacy ran this in a
   * `setImmediate` and reported through an in-memory Map, so a restart
   * mid-import left the screen saying "idle" while rows were still landing —
   * and no record afterwards that it had ever started. The run is a row now:
   * a process that dies leaves something reapable, and the import is
   * idempotent, so the retry that follows costs nothing.
   */
  router.post("/manual-gl/staging/multi-year", handle(async (req, res) => {
    const body = (req.body ?? {}) as {
      versionId?: unknown;
      glUploadIds?: unknown;
      uploadIds?: unknown;
      mapping?: unknown;
      fiscalYearStartMonth?: unknown;
    };
    const companyId = companyOf(req);
    // `glUploadIds` is legacy's name; `uploadIds` reads better and both arrive.
    const raw = Array.isArray(body.glUploadIds) ? body.glUploadIds : body.uploadIds;
    const uploadIds = (Array.isArray(raw) ? raw : []).map(String).filter(Boolean);
    const versionId = String(body.versionId ?? "");
    const startMonth = Number.parseInt(String(body.fiscalYearStartMonth ?? ""), 10);

    if (uploadIds.length === 0) {
      throw new HttpError(400, "At least one upload is required.");
    }

    const run = await sync.start(req.user!, companyId, {
      sourceKey: "manual_gl_upload",
      kind: "gl_import",
      totalFiles: uploadIds.length,
    });

    res.status(202).json({
      success: true,
      runId: run.id,
      // Legacy's name for it, so existing pollers keep working.
      jobId: run.id,
      message: "Import started. Poll /manual-report-uploads/sync-progress for progress.",
    });

    // After the response, and every step recorded on the run rather than in
    // memory. Failures here cannot reach the client — the run is where they go.
    void (async () => {
      try {
        const result = await service.stage(
          req.user!,
          companyId,
          {
            versionId,
            uploadIds,
            mapping: (body.mapping ?? {}) as Partial<ColumnMapping>,
            ...(Number.isInteger(startMonth) ? { fiscalYearStartMonth: startMonth } : {}),
          },
          {
            onFile: async (fileName, index) => {
              await sync.advance(req.user!, companyId, run.id, {
                processedFiles: index,
                currentFile: fileName,
                currentStep: "importing",
              });
            },
          },
        );

        await sync.advance(req.user!, companyId, run.id, {
          processedFiles: uploadIds.length,
          currentStep: "completed",
        });
        await sync.finish(req.user!, companyId, run.id, {
          status: "completed",
          result: {
            inserted: result.inserted,
            skipped: result.skipped,
            fiscalYears: result.fiscalYears,
            files: result.files,
          },
        });
      } catch (err) {
        await sync
          .finish(req.user!, companyId, run.id, {
            status: "failed",
            errorMessage: err instanceof Error ? err.message : String(err),
          })
          // A failure to record a failure must not become an unhandled
          // rejection that takes the process with it.
          .catch(() => undefined);
      }
    })();
  }));

  return router;
}
