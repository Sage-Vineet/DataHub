import express from "express";
import type { Request, RequestHandler, Response, Router } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { HttpError } from "../../shared/errors.js";
import { withCommonMiddleware } from "../../shared/router.js";
import type { AccountPatch } from "./ports.js";
import type { ChartOfAccountsService } from "./service.js";

export interface ChartOfAccountsRouterDeps {
  service: ChartOfAccountsService;
  requireAuth: RequestHandler;
}

/** Read a patch off the request body, keeping only the fields an edit may set. */
export function readPatch(body: unknown): AccountPatch {
  const b = (body ?? {}) as Record<string, unknown>;
  const patch: AccountPatch = {};
  if (typeof b.adjustedName === "string") patch.adjustedName = b.adjustedName;
  if (typeof b.accountType === "string") patch.accountType = b.accountType;
  if (typeof b.statementType === "string") patch.statementType = b.statementType;
  if (typeof b.isActive === "boolean") patch.isActive = b.isActive;
  if (b.movedParent === true) patch.movedParent = true;
  if (Array.isArray(b.levels)) {
    // Anything that is not a non-empty string becomes a null level, so a stray
    // number or object cannot end up in a hierarchy path.
    patch.levels = b.levels.map((l) => (typeof l === "string" && l !== "" ? l : null));
  }
  return patch;
}

/** The `chart-of-accounts` HTTP surface, on legacy's paths. */
export function createChartOfAccountsRouter(deps: ChartOfAccountsRouterDeps): Router {
  const { service, requireAuth } = deps;
  const router = express.Router();
  withCommonMiddleware(router, [helmet(), pinoHttp(), express.json(), requireAuth]);

  const handle =
    (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
    (req, res, next) =>
      fn(req, res).catch((err: unknown) => {
        if (err instanceof HttpError) {
          // Legacy's envelope, which the Key Reports screens read.
          res.status(err.status).json({ success: false, error: err.message });
          return;
        }
        next(err);
      });

  router.get(
    "/key-reports/versions/:versionId/chart-of-accounts",
    handle(async (req, res) => {
      res.json({ success: true, ...(await service.list(req.user!, req.params.versionId!)) });
    }),
  );

  router.get(
    "/key-reports/versions/:versionId/chart-of-accounts/history",
    handle(async (req, res) => {
      res.json({ success: true, ...(await service.history(req.user!, req.params.versionId!)) });
    }),
  );

  router.get(
    "/key-reports/hierarchy-levels",
    handle(async (_req, res) => {
      res.json({ success: true, levels: await service.hierarchyLevels() });
    }),
  );

  router.patch(
    "/key-reports/chart-of-accounts/:accountId",
    handle(async (req, res) => {
      const account = await service.updateAccount(
        req.user!,
        req.params.accountId!,
        readPatch(req.body),
      );
      res.json({ success: true, account });
    }),
  );

  router.post(
    "/key-reports/chart-of-accounts/:accountId/reset",
    handle(async (req, res) => {
      const account = await service.resetAccount(req.user!, req.params.accountId!);
      res.json({ success: true, account });
    }),
  );

  router.post(
    "/key-reports/versions/:versionId/chart-of-accounts/save",
    handle(async (req, res) => {
      const body = req.body as { nodes?: unknown } | undefined;
      const nodes = Array.isArray(body?.nodes) ? body.nodes : [];
      const result = await service.saveHierarchy(
        req.user!,
        req.params.versionId!,
        nodes.map((n) => ({ ...(n as object), ...readPatch(n) })),
      );
      // The refreshed chart comes back with the result, so the grid does not
      // have to re-request it to show what the save did.
      const coa = await service.list(req.user!, req.params.versionId!);
      res.json({ success: true, ...result, ...coa });
    }),
  );

  router.post(
    "/key-reports/versions/:versionId/chart-of-accounts/reset",
    handle(async (req, res) => {
      const result = await service.resetVersion(req.user!, req.params.versionId!);
      const coa = await service.list(req.user!, req.params.versionId!);
      res.json({ success: true, ...result, ...coa });
    }),
  );

  return router;
}
