import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGateway } from "./gateway.js";
import { parseRoutingTable } from "./routing.js";

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
});
