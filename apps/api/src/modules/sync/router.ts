import express from "express";
import type { Request, RequestHandler, Response, Router } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { HttpError } from "../../shared/errors.js";
import { withCommonMiddleware } from "../../shared/router.js";
import type { SyncService } from "./service.js";

export interface SyncRouterDeps {
  service: SyncService;
  requireAuth: RequestHandler;
}

/**
 * Watching a sync.
 *
 * Legacy served this from two module-level Maps, so the answer depended on
 * which process the poll landed on and vanished on restart. The paths are
 * unchanged; what is behind them is a table.
 *
 * `/manual-report-uploads/sync-progress` and `/manual-upload/sync-progress`
 * were separate endpoints over separate Maps for the QMS and Excel/PDF paths.
 * They are one endpoint now, narrowed by `sourceKey` — the distinction was in
 * which Map got written, not in what a caller was asking.
 */
export function createSyncRouter(deps: SyncRouterDeps): Router {
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
        next(err);
      });

  const companyOf = (req: Request): string =>
    String(
      req.headers["x-client-id"] ??
        req.query.clientId ??
        (req.body as { clientId?: unknown } | undefined)?.clientId ??
        "",
    );

  const sourceOf = (req: Request): { sourceKey?: string } => {
    const raw = req.query.sourceKey;
    return typeof raw === "string" && raw.trim() !== "" ? { sourceKey: raw.trim() } : {};
  };

  const progress = handle(async (req, res) => {
    res.json({
      success: true,
      ...(await service.progress(req.user!, companyOf(req), sourceOf(req))),
    });
  });

  router.get("/manual-report-uploads/sync-progress", progress);
  router.get("/manual-upload/sync-progress", progress);

  router.get("/manual-report-uploads/sync-history", handle(async (req, res) => {
    const limit = Number.parseInt(String(req.query.limit ?? ""), 10);
    const runs = await service.history(
      req.user!,
      companyOf(req),
      Number.isFinite(limit) ? limit : undefined,
    );
    res.json({ success: true, runs });
  }));

  return router;
}
