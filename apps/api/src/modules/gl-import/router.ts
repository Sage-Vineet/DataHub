import express from "express";
import type { Request, RequestHandler, Response, Router } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { HttpError } from "../../shared/errors.js";
import { withCommonMiddleware } from "../../shared/router.js";
import type { ColumnMapping } from "./column-mapping.js";
import { SheetParseError } from "./sheet.js";
import type { GlImportService } from "./service.js";

export interface GlImportRouterDeps {
  service: GlImportService;
  requireAuth: RequestHandler;
}

/**
 * Reading an uploaded general ledger, and agreeing what its columns mean.
 *
 * `/manual-gl/staging/multi-year` is NOT here. It writes the ledger, and
 * writing is the half that needs a dataset version to write into and a sync run
 * to report against — both now exist, but wiring them together is a change with
 * consequences for every report, and it should land on its own rather than
 * riding in with the reading half.
 */
export function createGlImportRouter(deps: GlImportRouterDeps): Router {
  const { service, requireAuth } = deps;
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

  return router;
}
