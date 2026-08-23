import express from "express";
import type { Request, RequestHandler, Response, Router } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { HttpError } from "../../shared/errors.js";
import { withCommonMiddleware } from "../../shared/router.js";
import type { WorkspaceService } from "./service.js";

export interface WorkspaceRouterDeps {
  service: WorkspaceService;
  requireAuth: RequestHandler;
}

/**
 * Which company a workspace request is about.
 *
 * Legacy accepted it from a header, a query parameter, or by pattern-matching
 * the Referer — the SPA supplies it differently from different screens. All
 * three are caller-controlled, so the value is only ever a *claim*; the service
 * authorizes it before touching anything.
 */
export function resolveCompanyId(req: Request): string | undefined {
  const header = req.headers["x-client-id"];
  if (typeof header === "string" && header.trim() !== "") return header.trim();

  const query = req.query.clientId;
  if (typeof query === "string" && query.trim() !== "") return query.trim();

  const referer = req.headers.referer;
  if (typeof referer === "string") {
    const match = /\/client\/([^/?#]+)/.exec(referer) ?? /\/workspace\/([^/?#]+)/.exec(referer);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

/** The `workspace` HTTP surface: persisted page state and the CIM questionnaire. */
export function createWorkspaceRouter(deps: WorkspaceRouterDeps): Router {
  const { service, requireAuth } = deps;
  const router = express.Router();
  withCommonMiddleware(router, [helmet(), pinoHttp(), express.json(), requireAuth]);

  const handle =
    (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
    (req, res, next) =>
      fn(req, res).catch((err: unknown) => {
        if (err instanceof HttpError) {
          // Legacy answered `{ success: false, error }` here rather than the
          // bare `{ error }` the newer modules use, and the SPA reads `success`.
          res.status(err.status).json({ success: false, error: err.message });
          return;
        }
        next(err);
      });

  router.get(
    "/cim-questionnaire",
    handle(async (req, res) => {
      res.json(await service.getQuestionnaire(req.user!, resolveCompanyId(req)));
    }),
  );

  router.put(
    "/cim-questionnaire",
    handle(async (req, res) => {
      const body = req.body as { state?: unknown } | undefined;
      res.json(await service.saveQuestionnaire(req.user!, resolveCompanyId(req), body?.state));
    }),
  );

  router.get(
    "/workspace-page-state/:pageKey",
    handle(async (req, res) => {
      res.json(await service.getPageState(req.user!, resolveCompanyId(req), req.params.pageKey!));
    }),
  );

  router.put(
    "/workspace-page-state/:pageKey",
    handle(async (req, res) => {
      const body = req.body as { state?: unknown } | undefined;
      res.json(
        await service.savePageState(
          req.user!,
          resolveCompanyId(req),
          req.params.pageKey!,
          body?.state,
        ),
      );
    }),
  );

  router.delete(
    "/workspace-page-state/:pageKey",
    handle(async (req, res) => {
      res.json(await service.clearPageState(req.user!, resolveCompanyId(req), req.params.pageKey!));
    }),
  );

  return router;
}
