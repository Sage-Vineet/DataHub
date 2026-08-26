import type { RequestHandler, Router } from "express";

type RouteMethod = "get" | "post" | "put" | "patch" | "delete";

const ROUTE_METHODS: ReadonlyArray<RouteMethod> = ["get", "post", "put", "patch", "delete"];

type RouteRegistrar = (path: string, ...handlers: RequestHandler[]) => Router;

/**
 * Attach shared middleware (helmet, pino, body parsing, the session guard) to
 * every route registered on `router` *after* this call — instead of via
 * `router.use()`.
 *
 * Why this exists: a domain module owns only *some* paths under its mount point;
 * everything else must fall through to the legacy backend (ADR-0003). With
 * `router.use()`, Express runs that middleware for **every** request reaching the
 * mount, including paths the module does not define. That is not a no-op:
 *
 *   - `requireAuth` rejects the request with 401 instead of letting it proxy.
 *   - `express.json()` consumes the request stream, so the proxy forwards a body-less
 *     request (the gateway deliberately keeps bodies unparsed so they stream through).
 *
 * Both break unmigrated neighbours that share the prefix — most visibly the legacy
 * QuickBooks OAuth routes under `/api/auth/*`.
 *
 * One consequence worth stating, because handlers were guarding against the
 * opposite: once `express.json()` is in this chain, `req.body` is ALWAYS at
 * least `{}`. It is set for a request with no body at all, and for one whose
 * `Content-Type` the parser declines — `undefined` happens only where no
 * parser is mounted, which is not the case for any router built through here.
 * So `req.body ?? {}` in a handler is a fallback that cannot fire.
 *
 * Registering the chain per-route instead means an unmatched path leaves the router
 * untouched and reaches the proxy exactly as it arrived.
 */
export function withCommonMiddleware(
  router: Router,
  common: ReadonlyArray<RequestHandler>,
): Router {
  const shared = [...common];
  for (const method of ROUTE_METHODS) {
    const register = router[method].bind(router) as RouteRegistrar;
    const wrapped: RouteRegistrar = (path, ...handlers) => register(path, ...shared, ...handlers);
    (router as unknown as Record<RouteMethod, RouteRegistrar>)[method] = wrapped;
  }
  return router;
}
