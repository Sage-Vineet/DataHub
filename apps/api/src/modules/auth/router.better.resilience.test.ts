import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { loadAuthConfig } from "./config.js";
import { createBetterAuthRouter, type BetterAuthRouterDeps } from "./router.better.js";
import type { AuthRepository } from "./ports.js";

/**
 * What the router does when Better Auth itself throws.
 *
 * Two endpoints swallow that deliberately, and swallowing is the *harder*
 * behaviour to keep true: nothing about the response tells you the catch ran,
 * so a refactor that let the error out would look identical in every
 * end-to-end test. That is why these are asserted against a Better Auth that
 * is guaranteed to fail rather than through the real one, which does not throw
 * for either case today and might tomorrow.
 */

const config = loadAuthConfig({
  JWT_SECRET: "an-application-secret-long-enough",
} as NodeJS.ProcessEnv);

function app(over: Partial<Record<string, unknown>> = {}) {
  const api = {
    signOut: () => Promise.reject(new Error("no session to sign out of")),
    requestPasswordResetEmailOTP: () => Promise.reject(new Error("the mail server refused")),
    signInEmail: () => Promise.reject(new Error("nope")),
    ...over,
  };
  const deps = {
    auth: { api } as unknown as BetterAuthRouterDeps["auth"],
    repo: {
      findUserByEmail: () => Promise.resolve(null),
      findUserById: () => Promise.resolve(null),
      listCompanyIdsForUser: () => Promise.resolve([]),
    } as unknown as AuthRepository,
    config,
    signupOtp: {
      sendOtp: () => Promise.resolve(),
      verifyOtp: () => Promise.resolve({ verified: true }),
    } as unknown as BetterAuthRouterDeps["signupOtp"],
  };
  const server = express();
  server.use("/auth", createBetterAuthRouter(deps));
  return server;
}

describe("logging out when Better Auth refuses", () => {
  it("clears client state and answers 204 anyway", async () => {
    // The session is already gone, which is the outcome the caller wanted.
    // Reporting a failure would leave the SPA believing it still has one.
    await request(app()).post("/auth/logout").expect(204);
  });
});

describe("forgot-password when the dispatch fails", () => {
  it("answers exactly as it does on success", async () => {
    // The generic response IS the enumeration defence. An error here would
    // distinguish a registered address from an unregistered one for anybody
    // who could make the send fail.
    const failing = await request(app()).post("/auth/forgot-password").send({ email: "a@b.test" });
    const working = await request(
      app({ requestPasswordResetEmailOTP: () => Promise.resolve({}) }),
    )
      .post("/auth/forgot-password")
      .send({ email: "a@b.test" });

    expect(failing.status).toBe(200);
    expect(failing.body).toEqual(working.body);
  });
});

describe("a login that arrives with no body at all", () => {
  it("is rate-limited under a key it can build, then refused as malformed", async () => {
    // `express.json()` leaves `req.body` undefined with no `Content-Type`, and
    // the limiter's key generator runs BEFORE the handler validates. Reading
    // `req.body.email` there would throw inside rate-limiting middleware,
    // which answers 500 rather than 400.
    await request(app()).post("/auth/login").expect(400);
  });
});
