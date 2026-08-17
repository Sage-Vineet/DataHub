import express from "express";
import type { Request, RequestHandler, Response, Router } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { requests as contracts } from "@datahub/contracts";
import { HttpError } from "../../shared/errors.js";
import { withCommonMiddleware } from "../../shared/router.js";
import type { RequestsService } from "./service.js";

function firstError(err: { issues: ReadonlyArray<{ message?: string }> }): string {
  return err.issues[0]?.message ?? "Invalid request.";
}

export interface RequestsRouterDeps {
  service: RequestsService;
  requireAuth: RequestHandler;
}

/** The `requests` HTTP surface (parity paths). Mounted broadly under `/api`. */
export function createRequestsRouter(deps: RequestsRouterDeps): Router {
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

  router.get("/companies/:companyId/requests", handle(async (req, res) => {
    res.json(await service.list(req.user!, req.params.companyId!));
  }));

  router.post("/companies/:companyId/requests", handle(async (req, res) => {
    const parsed = contracts.requestCreate.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstError(parsed.error) });
      return;
    }
    res.status(201).json(await service.create(req.user!, req.params.companyId!, parsed.data));
  }));

  router.post("/companies/:companyId/requests/bulk", handle(async (req, res) => {
    const parsed = contracts.requestBulkCreate.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstError(parsed.error) });
      return;
    }
    res.status(201).json(await service.createBulk(req.user!, req.params.companyId!, parsed.data.items, parsed.data.allow_past ?? false));
  }));

  router.get("/requests/:id", handle(async (req, res) => {
    res.json(await service.get(req.user!, req.params.id!));
  }));

  router.patch("/requests/:id", handle(async (req, res) => {
    const parsed = contracts.requestUpdate.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstError(parsed.error) });
      return;
    }
    res.json(await service.update(req.user!, req.params.id!, parsed.data));
  }));

  router.post("/requests/:id/approve", handle(async (req, res) => {
    const parsed = contracts.requestApprove.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: firstError(parsed.error) });
      return;
    }
    res.json(await service.approve(req.user!, req.params.id!, parsed.data.assigned_to ?? null));
  }));

  router.delete("/requests/:id", handle(async (req, res) => {
    await service.delete(req.user!, req.params.id!);
    res.status(204).send();
  }));

  router.post("/requests/:id/reminders", handle(async (req, res) => {
    res.status(201).json(await service.addReminder(req.user!, req.params.id!));
  }));

  router.get("/requests/:id/narrative", handle(async (req, res) => {
    const n = await service.getNarrative(req.user!, req.params.id!);
    if (!n) {
      res.status(404).json({ error: "No narrative." });
      return;
    }
    res.json(n);
  }));

  router.patch("/requests/:id/narrative", handle(async (req, res) => {
    const parsed = contracts.narrativeUpdate.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstError(parsed.error) });
      return;
    }
    res.json(await service.updateNarrative(req.user!, req.params.id!, parsed.data));
  }));

  router.get("/requests/:id/documents", handle(async (req, res) => {
    res.json(await service.listDocuments(req.user!, req.params.id!));
  }));

  router.post("/requests/:id/documents", handle(async (req, res) => {
    const parsed = contracts.requestDocumentLink.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstError(parsed.error) });
      return;
    }
    res.status(201).json(await service.linkDocument(req.user!, req.params.id!, parsed.data.document_id, parsed.data.visible ?? true));
  }));

  return router;
}
