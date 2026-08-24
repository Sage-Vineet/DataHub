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

function app(over: Partial<Record<string, unknown>> = {}, repoOver: Partial<Record<string, unknown>> = {}) {
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
      findCompanyIdByContactEmail: () => Promise.resolve(null),
      setUserCompanyId: () => Promise.resolve(),
      linkUserCompany: () => Promise.resolve(),
      companyHasFolders: () => Promise.resolve(false),
      createDefaultFolders: () => Promise.resolve(),
      ...repoOver,
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

describe("where the bearer token comes back from", () => {
  /**
   * The bearer plugin returns it as a `set-auth-token` HEADER. Older wiring
   * put it in the response body. Both are read, and the tests below exist
   * because the header path is the only one a live Better Auth exercises — so
   * the body path would rot unnoticed until an upgrade moved it back.
   *
   * The empty string matters too: a non-cookie client reading `token` off this
   * response gets `""` rather than `undefined`, so it fails its own check
   * rather than sending the literal "undefined" as a credential.
   */
  const loginWith = (signIn: unknown) =>
    request(app({ signInEmail: signIn as () => Promise<unknown> }))
      .post("/auth/login")
      .send({ email: "a@b.test", password: "correct1horse" });

  const user = { id: "11111111-1111-4111-8111-111111111111", role: "broker" };

  it("takes it from the header when Better Auth sets one", async () => {
    const res = await loginWith(() =>
      Promise.resolve({
        headers: new Headers({ "set-auth-token": "from-the-header" }),
        response: { user, token: "from-the-body" },
      }),
    ).expect(200);
    expect(res.body.token).toBe("from-the-header");
  });

  it("falls back to the body when there is no header", async () => {
    const res = await loginWith(() =>
      Promise.resolve({ headers: new Headers(), response: { user, token: "from-the-body" } }),
    ).expect(200);
    expect(res.body.token).toBe("from-the-body");
  });

  it("answers an empty token rather than undefined when there is neither", async () => {
    const res = await loginWith(() =>
      Promise.resolve({ headers: new Headers(), response: { user } }),
    ).expect(200);
    expect(res.body.token).toBe("");
  });
});

describe("a signed-in user Better Auth gave no role", () => {
  it("is provisioned as a client rather than left with nothing attached", async () => {
    /**
     * `users.role` has a default, but the row Better Auth hands back mid-login
     * may not carry it. Treating an absent role as anything but a buyer skips
     * provisioning, and the account signs in with no company and no folders —
     * an empty data room that looks like a permissions fault.
     *
     * Provisioning must not be able to FAIL the login either: the credential
     * was valid. Inside the catch it reported a correct password as "Invalid
     * credentials", which sends somebody to reset a password that was never
     * wrong.
     */
    const looked: string[] = [];
    const server = app(
      {
        signInEmail: () =>
          Promise.resolve({
            headers: new Headers(),
            response: {
              user: { id: "22222222-2222-4222-8222-222222222222", email: "a@b.test" },
            },
          }),
      },
      {
        findCompanyIdByContactEmail: (email: string) => {
          looked.push(email);
          return Promise.resolve(null);
        },
      },
    );

    const res = await request(server)
      .post("/auth/login")
      .send({ email: "a@b.test", password: "correct1horse" });

    expect(res.status).toBe(200);
    // Provisioning was ATTEMPTED, which is what the absent role decides.
    expect(looked).toEqual(["a@b.test"]);
  });

  it("signs in anyway when provisioning throws", async () => {
    // The credential was valid. Inside the catch this reported a correct
    // password as "Invalid credentials", which sends somebody to reset a
    // password that was never wrong.
    const server = app(
      {
        signInEmail: () =>
          Promise.resolve({
            headers: new Headers(),
            response: {
              user: { id: "22222222-2222-4222-8222-222222222222", email: "a@b.test" },
            },
          }),
      },
      { findCompanyIdByContactEmail: () => Promise.reject(new Error("the database is down")) },
    );

    const res = await request(server)
      .post("/auth/login")
      .send({ email: "a@b.test", password: "correct1horse" });

    expect(res.status).toBe(200);
    expect(res.status).not.toBe(401);
  });
});
