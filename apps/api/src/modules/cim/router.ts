import express from "express";
import type { Request, RequestHandler, Response, Router } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { cim as contracts } from "@datahub/contracts";
import { HttpError } from "../../shared/errors.js";
import { withCommonMiddleware } from "../../shared/router.js";
import type { CimService } from "./service.js";

function firstError(err: { issues: ReadonlyArray<{ message?: string }> }): string {
  return err.issues[0]?.message ?? "Invalid request.";
}

export interface CimRouterDeps {
  service: CimService;
  requireAuth: RequestHandler;
}

/** Rendered decks arrive as raw bytes; 50 MB is well past a narrative CIM. */
const PUBLISH_LIMIT = "50mb";

/**
 * The `/cim/*` surface (`CM - 0001`, `CM - 0004`).
 *
 * Mounted at the API root with paths written in full, and deliberately NOT
 * registered in `moduleSurfaces()` — that absence, not the prefix, keeps it out
 * of `route-contract.test.ts`, the same way `qoe` works.
 *
 * Note that `/cim-questionnaire` is a LEGACY path and is not claimed here.
 * Express matches `/cim/...` as its own segment, so the two do not collide.
 */
export function createCimRouter(deps: CimRouterDeps): Router {
  const { service, requireAuth } = deps;
  const router = express.Router();

  // Raw body for the publish route only. A JSON parser that swallowed a PDF
  // would corrupt the artifact the whole freeze is built around.
  const rawBody = express.raw({ type: () => true, limit: PUBLISH_LIMIT });
  const jsonBody = express.json({ limit: "25mb" });
  const bodyForRoute: RequestHandler = (req, res, next) => {
    if (req.method === "POST" && /^\/cim\/versions\/[^/]+\/publish$/.test(req.path)) {
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

  // ── decks and versions ────────────────────────────────────────────────────

  router.get(
    "/cim/companies/:companyId/decks",
    handle(async (req, res) => {
      res.json(await service.listDecks(req.user!, req.params.companyId!));
    }),
  );

  router.post(
    "/cim/companies/:companyId/decks",
    handle(async (req, res) => {
      const parsed = contracts.deckCreate.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: firstError(parsed.error) });
        return;
      }
      res.status(201).json(await service.createDeck(req.user!, req.params.companyId!, parsed.data));
    }),
  );

  router.get(
    "/cim/decks/:deckId/versions",
    handle(async (req, res) => {
      res.json(await service.listVersions(req.user!, req.params.deckId!));
    }),
  );

  router.post(
    "/cim/decks/:deckId/versions",
    handle(async (req, res) => {
      res.status(201).json(await service.createDraftFrom(req.user!, req.params.deckId!));
    }),
  );

  router.get(
    "/cim/versions/:id",
    handle(async (req, res) => {
      res.json(await service.getVersion(req.user!, req.params.id!));
    }),
  );

  router.put(
    "/cim/versions/:id/blocks",
    handle(async (req, res) => {
      const parsed = contracts.blockBulkUpsert.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: firstError(parsed.error) });
        return;
      }
      res.json(await service.saveBlocks(req.user!, req.params.id!, parsed.data));
    }),
  );

  router.post(
    "/cim/versions/:id/approval",
    handle(async (req, res) => {
      res.json(await service.recordApproval(req.user!, req.params.id!));
    }),
  );

  // ── guided Q&A ────────────────────────────────────────────────────────────

  router.get(
    "/cim/versions/:id/gaps",
    handle(async (req, res) => {
      res.json(await service.gaps(req.user!, req.params.id!));
    }),
  );

  router.post(
    "/cim/versions/:id/questions",
    handle(async (req, res) => {
      const parsed = contracts.generateRequest.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: firstError(parsed.error) });
        return;
      }
      res.status(201).json(await service.generate(req.user!, req.params.id!, parsed.data));
    }),
  );

  router.get(
    "/cim/versions/:id/review-queue",
    handle(async (req, res) => {
      res.json(await service.reviewQueue(req.user!, req.params.id!));
    }),
  );

  router.post(
    "/cim/blocks/:blockId/accept-answer",
    handle(async (req, res) => {
      const parsed = contracts.acceptAnswer.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: firstError(parsed.error) });
        return;
      }
      res.json(await service.acceptAnswer(req.user!, req.params.blockId!, parsed.data));
    }),
  );

  router.post(
    "/cim/blocks/:blockId/discard-answer",
    handle(async (req, res) => {
      const parsed = contracts.discardAnswer.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: firstError(parsed.error) });
        return;
      }
      await service.discardAnswer(req.user!, req.params.blockId!, parsed.data);
      res.status(204).end();
    }),
  );

  // ── health and publication ────────────────────────────────────────────────

  router.get(
    "/cim/versions/:id/health",
    handle(async (req, res) => {
      res.json(await service.health(req.user!, req.params.id!));
    }),
  );

  /**
   * Freeze a version around the rendered document.
   *
   * The bytes are produced by the client — every export in this repository is
   * browser-side, and standing up a headless renderer server-side is a change
   * with its own risks. What happens here is what makes the freeze mean
   * something: hash the artifact, store it, land it in the data room, lock the
   * version. Immutability comes from the write lock plus the content hash, not
   * from where the pixels were rasterised.
   */
  router.post(
    "/cim/versions/:id/publish",
    handle(async (req, res) => {
      const body = req.body as unknown;
      if (!Buffer.isBuffer(body)) {
        res.status(400).json({ error: "The rendered document must be sent as a raw binary body." });
        return;
      }
      const pageCountHeader = req.get("x-page-count");
      const pageCount = pageCountHeader ? Number(pageCountHeader) : null;
      res.status(201).json(
        await service.publish(req.user!, req.params.id!, body, {
          contentType: req.get("content-type") ?? "application/pdf",
          pageCount: Number.isFinite(pageCount) ? pageCount : null,
        }),
      );
    }),
  );

  return router;
}
