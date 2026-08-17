import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import { createGateway } from "../../gateway.js";
import { parseRoutingTable } from "../../routing.js";
import { makeHarness, sessionCookie, type Harness } from "./better-test-harness.js";

/**
 * Cutover mechanics (design D1, tasks §8): when the Better Auth module is mounted
 * behind the gateway, `/auth` is served in-process while every other path
 * still falls through to the legacy proxy. This is the local-equivalent of the
 * staged flag flip — flipping the mount on/off is the whole cutover/rollback.
 */

const USER = "11111111-1111-1111-1111-111111111111";
let h: Harness;

beforeEach(async () => {
  h = await makeHarness({
    users: [{ id: USER, email: "broker@example.com", password: "correct1horse", role: "broker" }],
  });
});

afterEach(async () => {
  await h.close();
});

describe("gateway cutover with Better Auth mounted", () => {
  it("serves /auth in-process and proxies everything else to legacy", async () => {
    // Legacy points at an unreachable origin so a *proxied* request fails as 502 —
    // proving non-auth paths are NOT served in-process.
    const table = parseRoutingTable({ LEGACY_ORIGIN: "http://127.0.0.1:1" } as NodeJS.ProcessEnv);
    const gateway = createGateway(table, {
      modules: [{ path: "/auth", router: h.router }],
      proxyTimeoutMs: 500,
    });

    // /auth/login is handled in-process by Better Auth → 200 + session cookie.
    const login = await request(gateway)
      .post("/auth/login")
      .send({ email: "broker@example.com", password: "correct1horse" });
    expect(login.status).toBe(200);
    expect(sessionCookie(login.headers["set-cookie"])).toMatch(/session_token=/);

    // A non-auth path is proxied to (unreachable) legacy → 502, not served here.
    const proxied = await request(gateway).get("/api/companies");
    expect(proxied.status).toBe(502);

    // Health is always local.
    await request(gateway).get("/healthz").expect(200);
  });

  it("with the module NOT mounted, /auth also falls through to legacy (rollback)", async () => {
    const table = parseRoutingTable({ LEGACY_ORIGIN: "http://127.0.0.1:1" } as NodeJS.ProcessEnv);
    const gateway = createGateway(table, { modules: [], proxyTimeoutMs: 500 });
    // No in-process auth → the request is proxied to legacy (unreachable → 502).
    const res = await request(express().use(gateway)).post("/auth/login").send({});
    expect(res.status).toBe(502);
  });
});
