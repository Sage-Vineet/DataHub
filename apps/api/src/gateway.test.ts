import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGateway } from "./gateway.js";
import { parseRoutingTable } from "./routing.js";
import { withCommonMiddleware } from "./shared/router.js";

interface Upstream {
  url: string;
  server: Server;
  lastHeaders: Record<string, string | string[] | undefined>;
}

/** Start a mock upstream that echoes what it received and can stream a download. */
function startUpstream(label: string): Promise<Upstream> {
  const state: Upstream = { url: "", server: undefined as unknown as Server, lastHeaders: {} };
  const app = express();
  app.use(express.raw({ type: "*/*", limit: "50mb" }));

  app.get("/stream", (_req, res) => {
    res.setHeader("Content-Type", "text/plain");
    let n = 0;
    const timer = setInterval(() => {
      res.write(`chunk-${n}\n`);
      if (++n >= 5) {
        clearInterval(timer);
        res.end();
      }
    }, 5);
  });

  app.all("/*", (req, res) => {
    state.lastHeaders = req.headers;
    const body = req.body as Buffer;
    res.status(req.method === "POST" ? 201 : 200).json({
      upstream: label,
      method: req.method,
      url: req.url,
      query: req.query,
      auth: req.headers.authorization ?? null,
      xff: req.headers["x-forwarded-for"] ?? null,
      bodyLength: Buffer.isBuffer(body) ? body.length : 0,
      body: Buffer.isBuffer(body) && body.length < 1000 ? body.toString("utf8") : undefined,
    });
  });

  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const port = (server.address() as AddressInfo).port;
      state.url = `http://127.0.0.1:${port}`;
      state.server = server;
      resolve(state);
    });
  });
}

let legacy: Upstream;
let api: Upstream;

beforeAll(async () => {
  legacy = await startUpstream("legacy");
  api = await startUpstream("api");
});

afterAll(async () => {
  legacy.server.close();
  api.server.close();
});

function gateway(routes?: string) {
  const table = parseRoutingTable({
    LEGACY_ORIGIN: legacy.url,
    API_ORIGIN: api.url,
    ...(routes ? { GATEWAY_ROUTES: routes } : {}),
  });
  return createGateway(table, { proxyTimeoutMs: 800 });
}

describe("gateway", () => {
  it("serves /healthz without proxying", async () => {
    const res = await request(gateway()).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", service: "gateway" });
  });

  it("declares the live feature set, so the SPA can hide what is switched off", async () => {
    const table = parseRoutingTable({ LEGACY_ORIGIN: legacy.url });
    const app = createGateway(table, { features: { qa: true, cim: false } });

    const res = await request(app).get("/healthz");

    expect(res.body.features).toEqual({ qa: true, cim: false });
  });

  it("reports an empty feature set rather than omitting the key", async () => {
    // The client reads `features` unconditionally; a missing key would make
    // "nothing is enabled" indistinguishable from "this gateway is too old to
    // say", and the client's safe default depends on telling those apart.
    const res = await request(gateway()).get("/healthz");

    expect(res.body.features).toEqual({});
  });

  it("keeps the feature payload off the module route surface", async () => {
    // /healthz lives on the gateway app, not a module router. If it ever moved
    // onto one, route-contract.test.ts would start comparing it against a legacy
    // path that does not exist.
    const table = parseRoutingTable({ LEGACY_ORIGIN: legacy.url });
    const app = createGateway(table, { features: { qa: true }, modules: [] });

    const res = await request(app).get("/healthz");

    expect(res.status).toBe(200);
    expect(res.body.service).toBe("gateway");
  });

  it("forwards unmapped paths to legacy, preserving method/query/status", async () => {
    const res = await request(gateway()).get("/companies?active=true");
    expect(res.status).toBe(200);
    expect(res.body.upstream).toBe("legacy");
    expect(res.body.method).toBe("GET");
    expect(res.body.query).toEqual({ active: "true" });
  });

  it("preserves POST body and returns upstream status", async () => {
    const res = await request(gateway()).post("/things").send({ a: 1 });
    expect(res.status).toBe(201);
    expect(res.body.upstream).toBe("legacy");
    expect(JSON.parse(res.body.body)).toEqual({ a: 1 });
  });

  it("routes a flipped prefix to the new module and rolls back when removed", async () => {
    const flipped = await request(gateway("/api/new=api")).get("/api/new/thing");
    expect(flipped.body.upstream).toBe("api");
    const rolledBack = await request(gateway()).get("/api/new/thing");
    expect(rolledBack.body.upstream).toBe("legacy");
  });

  it("preserves Authorization and adds X-Forwarded-For", async () => {
    const res = await request(gateway()).get("/me").set("Authorization", "Bearer tok123");
    expect(res.body.auth).toBe("Bearer tok123");
    expect(res.body.xff).toBeTruthy();
  });

  it("passes a large upload through without truncation", async () => {
    const big = Buffer.alloc(2 * 1024 * 1024, 0x61); // 2 MB
    const res = await request(gateway())
      .post("/upload")
      .set("Content-Type", "application/octet-stream")
      .send(big);
    expect(res.status).toBe(201);
    expect(res.body.bodyLength).toBe(big.length);
  });

  it("relays a streamed download intact", async () => {
    const res = await request(gateway()).get("/stream");
    expect(res.status).toBe(200);
    expect(res.text).toBe("chunk-0\nchunk-1\nchunk-2\nchunk-3\nchunk-4\n");
  });

  it("returns 502 when the upstream is unreachable", async () => {
    const table = parseRoutingTable({ LEGACY_ORIGIN: "http://127.0.0.1:1" });
    const res = await request(createGateway(table, { proxyTimeoutMs: 500 })).get("/anything");
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("gateway_upstream_error");
  });

  /**
   * Regression: a mounted module must not disturb paths it does not define.
   *
   * Domain modules mount broadly (`/`, `/auth`) and own only some paths under that
   * mount. If their helmet/body-parser/session chain were attached with
   * `router.use()`, every unmatched path would be 401'd by the guard or have its
   * body consumed before the proxy saw it — silently breaking unmigrated legacy
   * neighbours such as the QuickBooks OAuth routes under `/api/auth/*`.
   * `withCommonMiddleware` attaches the chain per-route so fall-through is clean.
   */
  describe("module fall-through", () => {
    /** A domain-style router: per-route chain, with a guard that would 401 everything. */
    function domainRouter() {
      const router = express.Router();
      const denyAll: express.RequestHandler = (_req, res) => {
        res.status(401).json({ error: "unauthenticated" });
      };
      withCommonMiddleware(router, [express.json(), denyAll]);
      router.get("/companies/:id/folders", (_req, res) => {
        res.json({ served: "in-process" });
      });
      return router;
    }

    function gatewayWithModule() {
      const table = parseRoutingTable({ LEGACY_ORIGIN: legacy.url });
      return createGateway(table, {
        modules: [{ path: "/", router: domainRouter() }],
        proxyTimeoutMs: 800,
      });
    }

    it("serves a path the module defines", async () => {
      const res = await request(gatewayWithModule()).get("/companies/c1/folders");
      expect(res.status).toBe(401); // the guard ran — proving the route is in-process
    });

    it("proxies an undefined path to legacy instead of 401ing it", async () => {
      const res = await request(gatewayWithModule()).get("/api/auth/callback?code=abc");
      expect(res.status).toBe(200);
      expect(res.body.upstream).toBe("legacy");
      expect(res.body.url).toBe("/api/auth/callback?code=abc");
    });

    it("leaves the body of an undefined path unconsumed for the proxy", async () => {
      const res = await request(gatewayWithModule())
        .post("/api/auth/transfer-confirm")
        .send({ realmId: "9130347" });
      expect(res.status).toBe(201);
      expect(res.body.upstream).toBe("legacy");
      // The decisive assertion: the body reached legacy intact.
      expect(JSON.parse(res.body.body)).toEqual({ realmId: "9130347" });
    });

    it.each([
      "/api/auth/quickbooks",
      "/api/auth/callback",
      "/api/auth/status",
      "/api/auth/disconnect",
    ])("keeps legacy QuickBooks OAuth route %s on legacy", async (path) => {
      const res = await request(gatewayWithModule()).get(path);
      expect(res.status).toBe(200);
      expect(res.body.upstream).toBe("legacy");
    });
  });

  describe("beforeProxy (the legacy auth bridge seam)", () => {
    /** Stamps a header so the upstream echo tells us whether it ran. */
    const stamp: express.RequestHandler = (req, _res, next) => {
      req.headers.authorization = "Bearer minted-for-legacy";
      next();
    };

    function gatewayWithBridge() {
      const table = parseRoutingTable({ LEGACY_ORIGIN: legacy.url });
      return createGateway(table, {
        modules: [{ path: "/served", router: (() => {
          const r = express.Router();
          r.get("/in-process", (req, res) => res.json({ auth: req.headers.authorization ?? null }));
          return r;
        })() }],
        beforeProxy: stamp,
        proxyTimeoutMs: 800,
      });
    }

    it("runs for a request bound for legacy", async () => {
      const res = await request(gatewayWithBridge())
        .get("/reminders")
        .set("Authorization", "Bearer opaque-session-token");

      expect(res.body.upstream).toBe("legacy");
      expect(res.body.auth).toBe("Bearer minted-for-legacy");
    });

    it("never runs for a route an in-process module already claimed", async () => {
      // The bridge exists only to satisfy legacy. A module reading a re-signed
      // token instead of the real session would be validating the wrong thing.
      const res = await request(gatewayWithBridge())
        .get("/served/in-process")
        .set("Authorization", "Bearer opaque-session-token");

      expect(res.body.auth).toBe("Bearer opaque-session-token");
    });

    it("changes nothing when no bridge is configured", async () => {
      const res = await request(gateway())
        .get("/reminders")
        .set("Authorization", "Bearer opaque-session-token");

      expect(res.body.auth).toBe("Bearer opaque-session-token");
    });
  });

  it("emits credentialed-CORS headers for allow-listed origins and answers preflight", async () => {
    const table = parseRoutingTable({ LEGACY_ORIGIN: legacy.url });
    const app = createGateway(table, { corsOrigins: ["https://app.datahub.test"] });

    // Preflight from an allowed origin → 204 with credentials allowed.
    const pre = await request(app)
      .options("/auth/login")
      .set("Origin", "https://app.datahub.test");
    expect(pre.status).toBe(204);
    expect(pre.headers["access-control-allow-origin"]).toBe("https://app.datahub.test");
    expect(pre.headers["access-control-allow-credentials"]).toBe("true");

    // Every header the SPA actually sends must be allowed, or the preflight
    // fails and the app dies with a bare "Failed to fetch". `Cache-Control` is
    // the easy one to miss: apps/web/src/lib/api.js sets it on EVERY request.
    const allowed = String(pre.headers["access-control-allow-headers"])
      .split(",")
      .map((h) => h.trim().toLowerCase());
    for (const header of ["content-type", "authorization", "x-client-id", "cache-control"]) {
      expect(allowed).toContain(header);
    }

    // An origin NOT on the list gets no CORS headers.
    const other = await request(app).get("/healthz").set("Origin", "https://evil.example.com");
    expect(other.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
