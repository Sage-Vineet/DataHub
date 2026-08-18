import type { ServerResponse } from "node:http";
import express from "express";
import type { Express, RequestHandler, Response, Router } from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import { markProxiedToLegacy } from "./activity/capture.js";
import { resolveTarget, type RoutingTable } from "./routing.js";

/** An in-process module mounted ahead of the proxy (e.g. the auth module). */
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
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Client-Id");
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
  /** Upstream timeout in ms before a request is failed as 504. */
  proxyTimeoutMs?: number;
  /**
   * Tier-1 activity capture (SE-0004). Runs ahead of everything so it sees every
   * request — including the ones that proxy to legacy, which is most of them
   * during the cutover. Omitted → no capture, and no request-path change at all.
   */
  activityCapture?: RequestHandler;
  /**
   * In-process modules mounted BEFORE the catch-all proxy. Requests matching a
   * module path are served in-process; everything else falls through to legacy.
   */
  modules?: ReadonlyArray<MountedModule>;
  /**
   * Origins allowed to make credentialed (cookie) requests — needed for cookie
   * sessions when the SPA and gateway are on different origins (ADR-0007). Empty →
   * no CORS headers (same-origin deploys). CSRF for the auth endpoints is enforced
   * by Better Auth's own Origin check against its trustedOrigins.
   */
  corsOrigins?: ReadonlyArray<string>;
}

/**
 * Build the gateway Express app. Its only responsibilities: a health check and
 * a transparent, streaming reverse proxy that forwards every other request to
 * the upstream chosen by the routing table (default: legacy).
 *
 * IMPORTANT: no body parser runs before the proxy — bodies stream through
 * untouched so uploads/downloads are not buffered.
 */
export function createGateway(table: RoutingTable, options: GatewayOptions = {}): Express {
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
    res.status(200).json({ status: "ok", service: "gateway" });
  });

  // In-process modules are mounted ahead of the proxy: a migrated route-group
  // (e.g. /api/auth) is served here; everything else still falls through to legacy.
  for (const mod of options.modules ?? []) {
    app.use(mod.path, mod.router);
  }

  const proxy = createProxyMiddleware({
    // A concrete default target satisfies the middleware; `router` overrides per request.
    target: resolveTarget(table, "/"),
    changeOrigin: true,
    xfwd: true, // adds X-Forwarded-For / -Proto / -Host
    ws: true,
    proxyTimeout: options.proxyTimeoutMs ?? 30_000,
    router: (req) => resolveTarget(table, req.url ?? "/"),
    on: {
      // The one place that knows legacy is serving this request. Modules are
      // mounted ahead of the proxy, so "the proxy ran" is exactly the signal.
      proxyReq: (_proxyReq, _req, res) => {
        markProxiedToLegacy(res as Response);
      },
      error: (err, _req, res) => {
        const code = (err as NodeJS.ErrnoException).code ?? "UNKNOWN";
        const status = code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT" ? 504 : 502;
        const response = res as ServerResponse;
        if (response && typeof response.writeHead === "function" && !response.headersSent) {
          response.writeHead(status, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ error: "gateway_upstream_error", code }));
        } else if (response && typeof response.destroy === "function") {
          response.destroy();
        }
        console.error(`[gateway] upstream error (${status}): ${err.message}`);
      },
    },
  });

  app.use(proxy);
  return app;
}
