import express from "express";
import type { Request, RequestHandler, Response, Router } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { HttpError } from "../../shared/errors.js";
import { withCommonMiddleware } from "../../shared/router.js";
import type { GroupsService } from "./service.js";

export interface GroupsRouterDeps {
  service: GroupsService;
  requireAuth: RequestHandler;
}

/**
 * The `groups` HTTP surface, on legacy's paths.
 *
 * `/companies/:companyId/groups` shares a prefix with the companies module and
 * `/groups/*` is its own — both mount at `/`, and `withCommonMiddleware` keeps
 * unmatched paths untouched so they still reach the proxy.
 */
export function createGroupsRouter(deps: GroupsRouterDeps): Router {
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

  router.get(
    "/companies/:companyId/groups",
    handle(async (req, res) => {
      res.json(await service.list(req.user!, req.params.companyId!));
    }),
  );

  router.post(
    "/companies/:companyId/groups",
    handle(async (req, res) => {
      res.status(201).json(await service.create(req.user!, req.params.companyId!, req.body));
    }),
  );

  router.patch(
    "/groups/:id",
    handle(async (req, res) => {
      res.json(await service.update(req.user!, req.params.id!, req.body));
    }),
  );

  router.delete(
    "/groups/:id",
    handle(async (req, res) => {
      await service.remove(req.user!, req.params.id!);
      res.status(204).send();
    }),
  );

  router.get(
    "/groups/:id/members",
    handle(async (req, res) => {
      res.json(await service.listMembers(req.user!, req.params.id!));
    }),
  );

  router.post(
    "/groups/:id/members",
    handle(async (req, res) => {
      res.status(201).json(await service.addMember(req.user!, req.params.id!, req.body));
    }),
  );

  router.delete(
    "/groups/:id/members/:userId",
    handle(async (req, res) => {
      await service.removeMember(req.user!, req.params.id!, req.params.userId!);
      res.status(204).send();
    }),
  );

  return router;
}
