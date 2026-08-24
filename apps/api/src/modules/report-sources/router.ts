import express from "express";
import type { Request, RequestHandler, Response, Router } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { HttpError } from "../../shared/errors.js";
import { withCommonMiddleware } from "../../shared/router.js";
import type { ReportSourcesService } from "./service.js";

export interface ReportSourcesRouterDeps {
  service: ReportSourcesService;
  requireAuth: RequestHandler;
}

/**
 * Which set of books the Reports page reads from.
 *
 * Both routes answer the FULL state, not just the part that changed. The
 * selector re-renders availability and connection badges after a switch, and a
 * response carrying only the new key would leave it showing the old ones until
 * the next load.
 */
export function createReportSourcesRouter(deps: ReportSourcesRouterDeps): Router {
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

  router.get("/report-sources", handle(async (req, res) => {
    res.json({ success: true, ...(await service.getState(req.user!, companyOf(req))) });
  }));

  router.put("/report-sources/selected", handle(async (req, res) => {
    const body = req.body as { sourceKey?: unknown };
    const state = await service.select(
      req.user!,
      companyOf(req),
      String(body.sourceKey ?? "").trim(),
    );
    res.json({ success: true, ...state });
  }));

  return router;
}
