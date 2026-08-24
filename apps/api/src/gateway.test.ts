import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createGateway } from "./gateway.js";
import { withCommonMiddleware } from "./shared/router.js";

/**
 * The gateway app.
 *
 * It used to be a reverse proxy with a health check bolted on: everything the
 * modules did not claim was streamed to the legacy backend, and most of this
 * file tested that streaming — bodies through unbuffered, X-Forwarded headers,
 * upstream 502s, a fake legacy upstream to receive it all.
 *
 * There is no upstream now. What is left is CORS, the activity envelope, the
 * modules, and a 404 for everything else — and the 404 is the part worth
 * testing hardest, because it used to be a proxy hop and anything still relying
 * on that would now be silently unreachable rather than loudly broken.
 */

const gateway = (options: Parameters<typeof createGateway>[0] = {}) => createGateway(options);

describe("liveness", () => {
  it("answers /healthz", async () => {
    const res = await request(gateway()).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", service: "gateway" });
  });

  it("declares the live feature set, so the SPA can hide what is switched off", async () => {
    const res = await request(gateway({ features: { qa: true, cim: false } })).get("/healthz");
    expect(res.body.features).toEqual({ qa: true, cim: false });
  });

  it("reports an empty feature set rather than omitting the key", async () => {
    // The client reads `features` unconditionally; a missing key would make
    // "nothing is enabled" indistinguishable from "this gateway is too old to
    // say", and the client's safe default depends on telling those apart.
    const res = await request(gateway()).get("/healthz");
    expect(res.body.features).toEqual({});
  });
});

describe("a path no module claims", () => {
  /** A domain-style router with a guard that would 401 everything it reaches. */
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

  const withModule = () => gateway({ modules: [{ path: "/", router: domainRouter() }] });

  it("serves a path a module defines", async () => {
    // 401 rather than 200: the guard ran, which is what proves the route is
    // in-process rather than falling past the module.
    const res = await request(withModule()).get("/companies/c1/folders");
    expect(res.status).toBe(401);
  });

  it("404s an unclaimed path rather than reaching for an upstream", async () => {
    /**
     * This was a proxy hop. Anything still depending on it — a client calling a
     * route nobody migrated, a typo in a module mount — used to reach legacy
     * and get an answer; now it gets a 404 that says which path.
     *
     * Naming the path matters more than it looks: the failure it replaces is a
     * request that resolved to something the SPA could not interpret, and the
     * whole point of answering here is that a 404 is legible.
     */
    const res = await request(withModule()).get("/nothing/here?code=abc");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found", path: "/nothing/here" });
  });

  it("404s a POST without consuming or complaining about its body", async () => {
    // No body parser runs ahead of the modules, so a POST to an unclaimed path
    // must not 400 on a body nothing read.
    const res = await request(withModule())
      .post("/nothing/here")
      .send({ realmId: "9130347" });
    expect(res.status).toBe(404);
    expect(res.body.path).toBe("/nothing/here");
  });

  it("404s every method the same way", async () => {
    const app = withModule();
    for (const method of ["get", "put", "patch", "delete"] as const) {
      const res = await request(app)[method]("/nothing/here");
      expect(res.status, method).toBe(404);
    }
  });

  it("still 404s when no module is mounted at all", async () => {
    const res = await request(gateway()).get("/companies");
    expect(res.status).toBe(404);
  });
});

describe("credentialed CORS", () => {
  const app = () => gateway({ corsOrigins: ["https://app.datahub.test"] });

  it("answers preflight from an allow-listed origin, with credentials", async () => {
    const pre = await request(app())
      .options("/auth/login")
      .set("Origin", "https://app.datahub.test");

    expect(pre.status).toBe(204);
    expect(pre.headers["access-control-allow-origin"]).toBe("https://app.datahub.test");
    expect(pre.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("allows every header the SPA actually sends", async () => {
    // Miss one and the preflight fails and the app dies with a bare "Failed to
    // fetch". `Cache-Control` is the easy one to miss: apps/web/src/lib/api.js
    // sets it on EVERY request.
    const pre = await request(app())
      .options("/auth/login")
      .set("Origin", "https://app.datahub.test");

    const allowed = String(pre.headers["access-control-allow-headers"])
      .split(",")
      .map((h) => h.trim().toLowerCase());
    for (const header of ["content-type", "authorization", "x-client-id", "cache-control"]) {
      expect(allowed).toContain(header);
    }
  });

  it("gives an origin that is not on the list no CORS headers at all", async () => {
    const res = await request(app()).get("/healthz").set("Origin", "https://evil.example.com");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
