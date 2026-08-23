import express from "express";
import type { Request, RequestHandler, Response, Router } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { HttpError } from "../../shared/errors.js";
import { withCommonMiddleware } from "../../shared/router.js";
import type { TaxOverridesService } from "./service.js";
import { toOverrideMap, toOverrides } from "./wire.js";

export interface TaxOverridesRouterDeps {
  service: TaxOverridesService;
  requireAuth: RequestHandler;
}

/**
 * Hand corrections to a tax reconciliation.
 *
 * The wire shape is legacy's `{ overrides, updatedAt }` with the nested map
 * the page holds as component state. Storage is a row per cell; the
 * translation lives in `wire.ts` so neither side has to know about the other.
 */
export function createTaxOverridesRouter(deps: TaxOverridesRouterDeps): Router {
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

  /**
   * The most recent edit across every cell.
   *
   * The page shows one "saved at" for the whole screen, and the honest answer
   * to that is the latest of them — legacy had one timestamp because it had
   * one row, and reporting the oldest or the first would tell somebody their
   * save had not happened.
   */
  const latestOf = (overrides: ReadonlyArray<{ updatedAt: string | null }>): string | null =>
    overrides.reduce<string | null>(
      (latest, o) => (o.updatedAt && (!latest || o.updatedAt > latest) ? o.updatedAt : latest),
      null,
    );

  router.get("/manual-report-uploads/tax-reconciliation-overrides", handle(async (req, res) => {
    const overrides = await service.list(req.user!, companyOf(req));
    res.json({
      success: true,
      overrides: toOverrideMap(overrides),
      updatedAt: latestOf(overrides),
    });
  }));

  router.put("/manual-report-uploads/tax-reconciliation-overrides", handle(async (req, res) => {
    const body = (req.body ?? {}) as { overrides?: unknown };
    const saved = await service.replaceAll(
      req.user!,
      companyOf(req),
      toOverrides(body.overrides),
    );
    // The saved state, not an acknowledgement. The page has just rewritten its
    // own map from what it sent; answering with what was actually stored is
    // what lets it notice a cell that did not survive.
    res.json({
      success: true,
      overrides: toOverrideMap(saved),
      updatedAt: latestOf(saved),
    });
  }));

  return router;
}
