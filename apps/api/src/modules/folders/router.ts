import express from "express";
import type { Request, RequestHandler, Response, Router } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { folders as contracts } from "@datahub/contracts";
import { HttpError } from "../../shared/errors.js";
import type { FoldersService } from "./service.js";

function firstError(err: { issues: ReadonlyArray<{ message?: string }> }): string {
  return err.issues[0]?.message ?? "Invalid request.";
}

export interface FoldersRouterDeps {
  service: FoldersService;
  requireAuth: RequestHandler;
}

/**
 * The folder + folder-access HTTP surface (parity paths). Mounted broadly under
 * `/api`; only these routes are defined, so document sub-routes (`/folders/:id/
 * documents`) fall through to legacy until the uploads phase.
 */
export function createFoldersRouter(deps: FoldersRouterDeps): Router {
  const { service, requireAuth } = deps;
  const router = express.Router();
  router.use(helmet());
  router.use(pinoHttp());
  router.use(express.json());
  router.use(requireAuth);

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

  const includeArchived = (req: Request): boolean =>
    contracts.folderListQuery.parse({ include_archived: req.query.include_archived }).include_archived;

  // ── Company-scoped folder routes ──────────────────────────────────────────
  router.get("/companies/:companyId/folders/tree", handle(async (req, res) => {
    res.json(await service.tree(req.user!, req.params.companyId!, includeArchived(req)));
  }));

  router.get("/companies/:companyId/folders", handle(async (req, res) => {
    res.json(await service.list(req.user!, req.params.companyId!, includeArchived(req)));
  }));

  router.post("/companies/:companyId/folders", handle(async (req, res) => {
    const parsed = contracts.folderCreate.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstError(parsed.error) });
      return;
    }
    res.status(201).json(await service.create(req.user!, req.params.companyId!, parsed.data));
  }));

  router.post("/companies/:companyId/folders/ensure-defaults", handle(async (req, res) => {
    res.json(await service.ensureDefaultsForCompany(req.user!, req.params.companyId!));
  }));

  // ── Folder-scoped routes ──────────────────────────────────────────────────
  router.patch("/folders/:id", handle(async (req, res) => {
    const parsed = contracts.folderUpdate.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstError(parsed.error) });
      return;
    }
    res.json(await service.update(req.user!, req.params.id!, parsed.data));
  }));

  router.delete("/folders/:id", handle(async (req, res) => {
    await service.delete(req.user!, req.params.id!);
    res.status(204).send();
  }));

  router.post("/folders/:id/move", handle(async (req, res) => {
    const parsed = contracts.folderMove.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstError(parsed.error) });
      return;
    }
    res.json(await service.move(req.user!, req.params.id!, parsed.data.parent_id));
  }));

  router.post("/folders/:id/archive", handle(async (req, res) => {
    res.json(await service.archive(req.user!, req.params.id!));
  }));

  router.post("/folders/:id/unarchive", handle(async (req, res) => {
    res.json(await service.unarchive(req.user!, req.params.id!));
  }));

  // ── Folder-access routes ──────────────────────────────────────────────────
  router.get("/folders/:id/access", handle(async (req, res) => {
    res.json(await service.listAccess(req.user!, req.params.id!));
  }));

  router.post("/folders/:id/access", handle(async (req, res) => {
    const parsed = contracts.folderAccessCreate.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstError(parsed.error) });
      return;
    }
    res.status(201).json(await service.createAccess(req.user!, req.params.id!, parsed.data));
  }));

  router.patch("/folder-access/:id", handle(async (req, res) => {
    const parsed = contracts.folderAccessUpdate.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstError(parsed.error) });
      return;
    }
    res.json(await service.updateAccess(req.user!, req.params.id!, parsed.data));
  }));

  router.delete("/folder-access/:id", handle(async (req, res) => {
    await service.deleteAccess(req.user!, req.params.id!);
    res.status(204).send();
  }));

  return router;
}
