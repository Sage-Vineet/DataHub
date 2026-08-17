import express from "express";
import type { Request, RequestHandler, Response, Router } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { uploads as contracts } from "@datahub/contracts";
import { HttpError } from "../../shared/errors.js";
import { withCommonMiddleware } from "../../shared/router.js";
import type { UploadsService } from "./service.js";

function firstError(err: { issues: ReadonlyArray<{ message?: string }> }): string {
  return err.issues[0]?.message ?? "Invalid request.";
}

export interface UploadsRouterDeps {
  service: UploadsService;
  requireAuth: RequestHandler;
}

/**
 * The upload + document + document-activity HTTP surface. Mounted broadly at the
 * API root; only these routes are defined (manual-GL upload sub-routes stay on
 * legacy). `POST /uploads` takes a raw binary body; the rest are JSON.
 *
 * The chain is attached per-route (not via `router.use`) so paths this module does
 * not define fall through to legacy untouched — see `withCommonMiddleware`. The
 * binary route opts out of the JSON parser by declaring `rawBody` itself.
 */
export function createUploadsRouter(deps: UploadsRouterDeps): Router {
  const { service, requireAuth } = deps;
  const router = express.Router();

  // Raw body only for the binary upload; JSON for everything else.
  const rawBody = express.raw({ type: () => true, limit: process.env.UPLOAD_MAX_SIZE ?? "200mb" });
  const jsonBody = express.json();
  const bodyForRoute: RequestHandler = (req, res, next) => {
    if (req.method === "POST" && req.path === "/uploads") return next();
    jsonBody(req, res, next);
  };
  withCommonMiddleware(router, [helmet(), pinoHttp(), bodyForRoute, requireAuth]);

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
    contracts.documentListQuery.parse({ include_archived: req.query.include_archived }).include_archived;

  // ── Blobs ─────────────────────────────────────────────────────────────────
  router.post(
    "/uploads",
    rawBody,
    handle(async (req, res) => {
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const headerName = req.header("x-file-name");
      const fileName = headerName ? decodeURIComponent(headerName) : String(req.query.file_name ?? "upload");
      const contentType = req.header("content-type") ?? "application/octet-stream";
      const result = await service.storeUpload(req.user!, bytes, fileName, contentType);
      res.status(201).json(result);
    }),
  );

  router.get(
    "/uploads/:id/content",
    handle(async (req, res) => {
      const blob = await service.getUploadContent(req.params.id!);
      res.setHeader("Content-Type", blob.contentType);
      res.setHeader("Content-Disposition", `inline; filename="${blob.fileName.replace(/"/g, "")}"`);
      res.send(blob.bytes);
    }),
  );

  // ── Folder documents ────────────────────────────────────────────────────
  router.get("/folders/:id/documents", handle(async (req, res) => {
    res.json(await service.listDocuments(req.user!, req.params.id!, includeArchived(req)));
  }));

  router.post("/folders/:id/documents", handle(async (req, res) => {
    const parsed = contracts.documentCreate.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstError(parsed.error) });
      return;
    }
    res.status(201).json(await service.addDocument(req.user!, req.params.id!, parsed.data));
  }));

  router.delete("/documents/:id", handle(async (req, res) => {
    await service.deleteDocument(req.user!, req.params.id!);
    res.status(204).send();
  }));

  router.post("/documents/:id/archive", handle(async (req, res) => {
    res.json(await service.archiveDocument(req.user!, req.params.id!));
  }));

  router.post("/documents/:id/unarchive", handle(async (req, res) => {
    res.json(await service.unarchiveDocument(req.user!, req.params.id!));
  }));

  // ── Document activity ─────────────────────────────────────────────────────
  router.get("/documents/:id/activity", handle(async (req, res) => {
    res.json(await service.listActivity(req.user!, req.params.id!));
  }));

  router.post("/documents/:id/activity", handle(async (req, res) => {
    const parsed = contracts.documentActivityCreate.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstError(parsed.error) });
      return;
    }
    res.status(201).json(await service.recordActivity(req.user!, req.params.id!, parsed.data.action));
  }));

  return router;
}
