import express from "express";
import type { Request, RequestHandler, Response, Router } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { withCommonMiddleware } from "../../shared/router.js";
import type { CoaReviewService } from "./service.js";

/**
 * The chart-of-accounts reasonableness review.
 *
 * Paths match the ones legacy serves on `data_room`
 * (`backend/src/routes/keyReports.js`) exactly, because a module that answers on
 * a different path is silently inert — the request sails past it and proxies to
 * legacy, so the flag "works" and nothing has migrated. `ba/rearch` never took
 * the legacy routes, so on this branch the module is the only implementation;
 * matching anyway is what keeps a future cutover a flag flip.
 *
 *   GET  /key-reports/versions/:versionId/hierarchy-recommendations
 *   POST /key-reports/hierarchy-recommendations/:recommendationId/apply
 *   POST /key-reports/hierarchy-recommendations/:recommendationId/accept
 *   POST /key-reports/hierarchy-recommendations/:recommendationId/reject
 *   POST /key-reports/hierarchy-recommendations/:recommendationId/ignore
 *
 * `accept`/`ignore` are the original engine's names and are kept: the existing
 * SPA hook calls them, and renaming them would be a client change disguised as a
 * port. `apply` differs from `accept` in exactly one way, which is the reason it
 * exists — it reports a stale recommendation as **409**, so the SPA can offer a
 * regenerate instead of showing a generic failure.
 *
 * One deliberate difference from legacy: its `accept` and `apply` also echoed
 * the refreshed chart of accounts into the response and warmed a report cache.
 * Reading the chart of accounts belongs to whatever owns it, not to the advisory
 * layer, so this returns only the outcome and the client refetches. That is a
 * smaller response and one fewer reason for this module to depend on that one.
 */

export interface CoaReviewRouterDeps {
  /**
   * A service for THIS request.
   *
   * Request-scoped rather than a singleton because the hierarchy writer is: it
   * forwards the caller's own credentials to the route that owns the chart of
   * accounts, so a reviewer who cannot edit an account cannot apply a
   * recommendation to it either. A boot-time service would have to hold a
   * service identity, which turns the review UI into a privilege escalation.
   * Constructing one is three object references.
   */
  serviceFor: (req: Request) => CoaReviewService;
  requireAuth: RequestHandler;
}

export function createCoaReviewRouter({ serviceFor, requireAuth }: CoaReviewRouterDeps): Router {
  const router = express.Router();
  withCommonMiddleware(router, [helmet(), pinoHttp(), express.json(), requireAuth]);

  const handle =
    (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
    (req, res, next) =>
      fn(req, res).catch(next);

  /** The acting user, or null. Recorded on every decision. */
  const actor = (req: Request): string | null =>
    (req as Request & { user?: { id?: string } }).user?.id ?? null;

  router.get(
    "/key-reports/versions/:versionId/hierarchy-recommendations",
    handle(async (req, res) => {
      const recommendations = await serviceFor(req).listRecommendations(String(req.params.versionId));
      res.json({ success: true, recommendations });
    }),
  );

  router.post(
    "/key-reports/hierarchy-recommendations/:recommendationId/apply",
    handle(async (req, res) => {
      const result = await serviceFor(req).applyRecommendation(
        String(req.params.recommendationId),
        actor(req),
      );
      if (!result.ok) {
        // 409 for a stale recommendation, 422 for one that is merely
        // inapplicable. The distinction is the point of this endpoint: a
        // conflict is regenerable, and telling a reviewer to re-run is a very
        // different message from telling them the proposal was unsafe.
        res.status(result.conflict ? 409 : 422).json({ success: false, ...result });
        return;
      }
      res.json({ success: true, ...result });
    }),
  );

  router.post(
    "/key-reports/hierarchy-recommendations/:recommendationId/accept",
    handle(async (req, res) => {
      try {
        const result = await serviceFor(req).acceptRecommendation(
          String(req.params.recommendationId),
          actor(req),
        );
        res.json({ success: true, ...result });
      } catch (err) {
        // `acceptRecommendation` keeps the original throwing contract. The
        // conflict flag it carries is surfaced the same way `apply` does it, so
        // the two endpoints cannot disagree about what a stale row means.
        const e = err as Error & { code?: string; conflict?: boolean };
        res
          .status(e.conflict ? 409 : 422)
          .json({ success: false, code: e.code, message: e.message });
      }
    }),
  );

  const decline: RequestHandler = handle(async (req, res) => {
    const result = await serviceFor(req).rejectRecommendation(
      String(req.params.recommendationId),
      actor(req),
      typeof req.body?.reason === "string" ? req.body.reason : null,
    );
    res.json({ success: true, ...result });
  });

  router.post("/key-reports/hierarchy-recommendations/:recommendationId/reject", decline);
  /** Legacy alias for the same operation — the original engine's name. */
  router.post("/key-reports/hierarchy-recommendations/:recommendationId/ignore", decline);

  return router;
}
