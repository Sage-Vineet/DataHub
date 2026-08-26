import express from "express";
import type { Express, RequestHandler, Router } from "express";

/** An in-process module the gateway mounts (e.g. the auth module). */
export interface MountedModule {
  path: string;
  router: Router;
}

/**
 * Minimal credentialed-CORS: reflect an allow-listed Origin and permit cookies.
 * Only emits headers for origins on the list, so it never widens access blindly.
 */
function corsMiddleware(origins: ReadonlyArray<string>): RequestHandler {
  const allow = new Set(origins);
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allow.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Vary", "Origin");
      // Cache-Control is on this list because the SPA sends `Cache-Control:
      // no-store` on EVERY request (apps/web/src/lib/api.js). Omitting it fails
      // the preflight with HeaderDisallowedByPreflightResponse, which surfaces
      // in the UI as a bare "Failed to fetch" on login — i.e. the whole app is
      // dead on any cross-origin deploy, which is every deploy where the SPA
      // and gateway are on different hosts.
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, X-Client-Id, Cache-Control",
      );
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      if (req.method === "OPTIONS") {
        res.status(204).end();
        return;
      }
    }
    next();
  };
}

export interface GatewayOptions {
  /**
   * Tier-1 activity capture (SE-0004). Runs ahead of everything so it sees every
   * request. Omitted → no capture, and no request-path change at all.
   */
  activityCapture?: RequestHandler;
  /** In-process modules. A request matching a module path is served by it. */
  modules?: ReadonlyArray<MountedModule>;
  /**
   * Origins allowed to make credentialed (cookie) requests — needed for cookie
   * sessions when the SPA and gateway are on different origins (ADR-0007). Empty →
   * no CORS headers (same-origin deploys). CSRF for the auth endpoints is enforced
   * by Better Auth's own Origin check against its trustedOrigins.
   */
  corsOrigins?: ReadonlyArray<string>;
  /**
   * The live feature-flag set, reported by `/healthz` so the SPA can hide what is
   * switched off instead of rendering it broken.
   *
   * This matters more than it looks. A module flipped off without the client
   * knowing produces a live nav entry and a request that 404s, which the SPA
   * renders as a spinner that never settles. Declaring availability is what
   * makes the kill switch subtract a feature rather than break one.
   *
   * It rides on `/healthz` rather than a new endpoint because this handler lives
   * on the gateway app rather than a module router.
   */
  features?: Readonly<Record<string, boolean>>;
}

/**
 * Build the gateway Express app: a health check, the in-process modules, and a
 * 404 for anything else.
 *
 * It used to end in a transparent streaming reverse proxy that forwarded every
 * unmatched request to the legacy backend, which is what made it a gateway
 * rather than a server. There is nothing behind it now — every route the SPA
 * calls is served in-process — so an unmatched path is a path that does not
 * exist, and saying so beats forwarding it to a host that is not listening.
 *
 * The name is kept. It still fronts the SPA, still owns CORS and the activity
 * envelope, and renaming it would touch every compose file, script and doc for
 * no gain.
 */
export function createGateway(options: GatewayOptions = {}): Express {
  const app = express();

  // Credentialed CORS (for cross-origin cookie sessions) runs first so it also
  // covers preflight for the in-process modules and the proxy. No-op when unset.
  if (options.corsOrigins && options.corsOrigins.length > 0) {
    app.use(corsMiddleware(options.corsOrigins));
  }

  // Capture attaches before the modules and the proxy so one envelope covers the
  // request whichever engine ends up serving it. It reads no body and writes
  // nothing to the response — see `activity/capture.ts`.
  if (options.activityCapture) {
    app.use(options.activityCapture);
  }

  // Liveness — independent of upstream availability, never proxied.
  app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok", service: "gateway", features: options.features ?? {} });
  });

  // Every route the SPA calls is one of these.
  for (const mod of options.modules ?? []) {
    app.use(mod.path, mod.router);
  }

  // Anything not matched above does not exist. This was the catch-all proxy to
  // legacy; the JSON shape is kept because clients already read `error`.
  app.use((req, res) => {
    res.status(404).json({ error: "not_found", path: req.path });
  });

  return app;
}