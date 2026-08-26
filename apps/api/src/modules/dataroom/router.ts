import { firstError } from "../../shared/first-error.js";
import express from "express";
import type { Request, RequestHandler, Response, Router } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { dataroom as contracts, MAX_CHUNK_BYTES } from "@datahub/contracts";
import { HttpError } from "../../shared/errors.js";
import { withCommonMiddleware } from "../../shared/router.js";
import type { StoragePort } from "../uploads/ports.js";
import type { DataRoomService } from "./service.js";

export interface DataRoomRouterDeps {
  service: DataRoomService;
  requireAuth: RequestHandler;
  /** Reused from the uploads module to stream a version's stored bytes back. */
  storage: StoragePort;
  /** Per-sub-feature switches, so one unfinished thing can be killed on its own. */
  features?: { versions?: boolean; comments?: boolean; chunkedUpload?: boolean };
}

/**
 * The `/dataroom/*` surface: document versioning, comments, and chunked upload.
 *
 * Mounted at the API root with every route written out in full, and — critically
 * — this module is NOT registered in `moduleSurfaces()` (`src/parity/routes.ts`).
 * That absence, not the prefix, is what keeps it out of `route-contract.test.ts`;
 * `qoe` works the same way. Registering it there would compare these paths
 * against a legacy surface that has never served them, and every route would
 * fail as an orphan.
 *
 * The chain attaches per route rather than via `router.use`, so an unmatched path
 * reaches the proxy exactly as it arrived.
 */
export function createDataRoomRouter(deps: DataRoomRouterDeps): Router {
  const { service, requireAuth, storage } = deps;
  const features = {
    versions: deps.features?.versions ?? true,
    comments: deps.features?.comments ?? true,
    chunkedUpload: deps.features?.chunkedUpload ?? true,
  };
  const router = express.Router();

  // Raw body for chunk PUTs only; JSON everywhere else. Same shape as the
  // uploads module's binary route — the parser is chosen per path, not globally,
  // because a JSON parser that swallowed a chunk body would corrupt the file.
  const rawBody = express.raw({ type: () => true, limit: MAX_CHUNK_BYTES });
  const jsonBody = express.json();
  const bodyForRoute: RequestHandler = (req, res, next) => {
    if (req.method === "PUT" && /^\/dataroom\/uploads\/sessions\/[^/]+\/chunks\/\d+$/.test(req.path)) {
      return rawBody(req, res, next);
    }
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

  /**
   * A disabled sub-feature answers 404 rather than falling through.
   *
   * Falling through would reach the catch-all proxy and hit legacy, which serves
   * nothing here and would answer with something the client cannot interpret —
   * the exact failure the feature payload on `/healthz` exists to prevent. An
   * explicit 404 is honest and terminal.
   */
  const requireFeature =
    (on: boolean, name: string): RequestHandler =>
    (_req, res, next) => {
      if (!on) {
        res.status(404).json({ error: `The ${name} feature is not enabled.` });
        return;
      }
      next();
    };

  // ── versions ──────────────────────────────────────────────────────────────

  router.get(
    "/dataroom/documents/:id/versions",
    requireFeature(features.versions, "document versions"),
    handle(async (req, res) => {
      res.json(await service.listVersions(req.user!, req.params.id!));
    }),
  );

  router.get(
    "/dataroom/versions/:versionId/content",
    requireFeature(features.versions, "document versions"),
    handle(async (req, res) => {
      const uploadId = await service.versionUploadId(req.user!, req.params.versionId!);
      const blob = await storage.get(uploadId);
      if (!blob) {
        res.status(404).json({ error: "Stored content not found." });
        return;
      }
      res.setHeader("Content-Type", blob.contentType);
      res.setHeader("Content-Disposition", `inline; filename="${blob.fileName.replace(/"/g, "")}"`);
      res.send(blob.bytes);
    }),
  );

  router.post(
    "/dataroom/documents/:id/versions/:versionId/restore",
    requireFeature(features.versions, "document versions"),
    handle(async (req, res) => {
      const parsed = contracts.versionRestore.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: firstError(parsed.error) });
        return;
      }
      const restored = await service.restoreVersion(
        req.user!,
        req.params.id!,
        req.params.versionId!,
        parsed.data.note ?? null,
      );
      res.status(201).json(restored);
    }),
  );

  // ── comments ──────────────────────────────────────────────────────────────

  router.get(
    "/dataroom/documents/:id/comments",
    requireFeature(features.comments, "document comments"),
    handle(async (req, res) => {
      res.json(await service.listComments(req.user!, req.params.id!));
    }),
  );

  router.post(
    "/dataroom/documents/:id/comments",
    requireFeature(features.comments, "document comments"),
    handle(async (req, res) => {
      const parsed = contracts.commentCreate.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: firstError(parsed.error) });
        return;
      }
      res.status(201).json(await service.addComment(req.user!, req.params.id!, parsed.data));
    }),
  );

  router.delete(
    "/dataroom/comments/:id",
    requireFeature(features.comments, "document comments"),
    handle(async (req, res) => {
      await service.deleteComment(req.user!, req.params.id!);
      res.status(204).end();
    }),
  );

  // ── chunked upload ────────────────────────────────────────────────────────

  router.post(
    "/dataroom/uploads/sessions",
    requireFeature(features.chunkedUpload, "chunked upload"),
    handle(async (req, res) => {
      const parsed = contracts.uploadSessionCreate.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: firstError(parsed.error) });
        return;
      }
      res.status(201).json(await service.openSession(req.user!, parsed.data));
    }),
  );

  router.get(
    "/dataroom/uploads/sessions/:id",
    requireFeature(features.chunkedUpload, "chunked upload"),
    handle(async (req, res) => {
      res.json(await service.getSession(req.user!, req.params.id!));
    }),
  );

  router.put(
    "/dataroom/uploads/sessions/:id/chunks/:index",
    requireFeature(features.chunkedUpload, "chunked upload"),
    handle(async (req, res) => {
      const index = Number(req.params.index);
      const body = req.body as unknown;
      if (!Buffer.isBuffer(body)) {
        res.status(400).json({ error: "A chunk must be sent as a raw binary body." });
        return;
      }
      res.json(await service.putChunk(req.user!, req.params.id!, index, body));
    }),
  );

  router.post(
    "/dataroom/uploads/sessions/:id/complete",
    requireFeature(features.chunkedUpload, "chunked upload"),
    handle(async (req, res) => {
      res.status(201).json(await service.completeSession(req.user!, req.params.id!));
    }),
  );

  router.delete(
    "/dataroom/uploads/sessions/:id",
    requireFeature(features.chunkedUpload, "chunked upload"),
    handle(async (req, res) => {
      await service.abortSession(req.user!, req.params.id!);
      res.status(204).end();
    }),
  );

  return router;
}
