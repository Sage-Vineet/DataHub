import express from "express";
import type { Request, RequestHandler, Response, Router } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { HttpError } from "../../shared/errors.js";
import { withCommonMiddleware } from "../../shared/router.js";
import type { ActivityService } from "./service.js";

export interface ActivityRouterDeps {
  service: ActivityService;
  requireAuth: RequestHandler;
}

/** The `activity` HTTP surface: the broker dashboard's cross-company feed. */
export function createActivityRouter(deps: ActivityRouterDeps): Router {
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
    "/broker/activity",
    handle(async (req, res) => {
      const feed = await service.brokerFeed(req.user!, req.query.limit);
      // Short and private: the feed is per-user and changes constantly, but the
      // dashboard refetches it on every navigation.
      res.set("Cache-Control", "private, max-age=15");
      res.json(feed);
    }),
  );

  return router;
}
