import express from "express";
import type { Request, RequestHandler, Response, Router } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { HttpError } from "../../shared/errors.js";
import { withCommonMiddleware } from "../../shared/router.js";
import type { QuickBooksService } from "./service.js";

export interface QuickBooksRouterDeps {
  service: QuickBooksService;
  requireAuth: RequestHandler;
}

/**
 * The QuickBooks connection's state.
 *
 * `/api/auth/quickbooks`, `/api/auth/callback` and `/refresh-token` are NOT
 * here. They are the OAuth dance, they need real Intuit credentials and a
 * browser redirect to exercise, and porting an auth flow that cannot be tested
 * against the thing it talks to is how a migration ships a subtly broken one.
 * They stay on legacy and reach it through the proxy, which is what
 * `withCommonMiddleware` leaves possible.
 */
export function createQuickBooksRouter(deps: QuickBooksRouterDeps): Router {
  const { service, requireAuth } = deps;
  const router = express.Router();
  withCommonMiddleware(router, [helmet(), pinoHttp(), express.json(), requireAuth]);

  const handle =
    (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
    (req, res, next) =>
      fn(req, res).catch((err: unknown) => {
        if (err instanceof HttpError) {
          res.status(err.status).json({ success: false, error: err.message });
          return;
        }
        next(err);
      });

  const companyOf = (req: Request): string =>
    String(
      req.headers["x-client-id"] ??
        req.query.clientId ??
        (req.body as { clientId?: unknown } | undefined)?.clientId ??
        "",
    );

  router.get("/api/auth/status", handle(async (req, res) => {
    res.json({ success: true, ...(await service.status(req.user!, companyOf(req))) });
  }));

  /**
   * Disconnect.
   *
   * A GET, which it should not be — but it is what legacy exposed and what the
   * SPA calls, and changing the verb during a port means changing the caller
   * too. Worth revisiting once nothing depends on the old shape.
   */
  router.get("/api/auth/disconnect", handle(async (req, res) => {
    res.json({ success: true, ...(await service.disconnect(req.user!, companyOf(req))) });
  }));

  return router;
}
