import express from "express";
import type { Request, RequestHandler, Response, Router } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { reports as contracts } from "@datahub/contracts";
import { HttpError } from "../../shared/errors.js";
import { withCommonMiddleware } from "../../shared/router.js";
import type { ReportsService } from "./service.js";

function firstError(err: { issues: ReadonlyArray<{ message?: string }> }): string {
  return err.issues[0]?.message ?? "Invalid request.";
}

export interface ReportsRouterDeps {
  service: ReportsService;
  requireAuth: RequestHandler;
}

/**
 * Key-report *version* lifecycle (parity paths). Mounted broadly under `/api`; only
 * these routes are defined, so sync/mappings/chart-of-accounts/extracted-data fall
 * through to the legacy GL engine (design D2).
 */
export function createReportsRouter(deps: ReportsRouterDeps): Router {
  const { service, requireAuth } = deps;
  const router = express.Router();
  withCommonMiddleware(router, [helmet(), pinoHttp(), express.json(), requireAuth]);

  const handle =
    (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
    (req, res, next) =>
      fn(req, res).catch((err: unknown) => {
        if (err instanceof HttpError) {
          res.status(err.status).json({ error: err.message });
          return;
        }
        next(err);
      });

  // List is company-scoped via ?company_id (parity with legacy).
  router.get("/key-reports/versions", handle(async (req, res) => {
    const companyId = String(req.query.company_id ?? "");
    if (!companyId) {
      res.status(400).json({ error: "company_id query parameter is required." });
      return;
    }
    res.json(await service.list(req.user!, companyId));
  }));

  router.post("/key-reports/versions", handle(async (req, res) => {
    const parsed = contracts.reportVersionCreate.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstError(parsed.error) });
      return;
    }
    res.status(201).json(await service.create(req.user!, parsed.data));
  }));

  router.get("/key-reports/versions/:versionId", handle(async (req, res) => {
    res.json(await service.get(req.user!, req.params.versionId!));
  }));

  router.put("/key-reports/versions/:versionId", handle(async (req, res) => {
    const parsed = contracts.reportVersionUpdate.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstError(parsed.error) });
      return;
    }
    res.json(await service.update(req.user!, req.params.versionId!, parsed.data));
  }));

  router.post("/key-reports/versions/:versionId/duplicate", handle(async (req, res) => {
    res.status(201).json(await service.duplicate(req.user!, req.params.versionId!));
  }));

  router.post("/key-reports/versions/:versionId/activate", handle(async (req, res) => {
    res.json(await service.activate(req.user!, req.params.versionId!));
  }));

  router.delete("/key-reports/versions/:versionId", handle(async (req, res) => {
    await service.delete(req.user!, req.params.versionId!);
    res.status(204).send();
  }));

  return router;
}
