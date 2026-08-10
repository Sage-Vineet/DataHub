import type { ServerResponse } from "node:http";
import express from "express";
import type { Express, Router } from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import { resolveTarget, type RoutingTable } from "./routing.js";

/** An in-process module mounted ahead of the proxy (e.g. the auth module). */
export interface MountedModule {
  path: string;
  router: Router;
}

export interface GatewayOptions {
  /** Upstream timeout in ms before a request is failed as 504. */
  proxyTimeoutMs?: number;
  /**
   * In-process modules mounted BEFORE the catch-all proxy. Requests matching a
   * module path are served in-process; everything else falls through to legacy.
   */
  modules?: ReadonlyArray<MountedModule>;
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
