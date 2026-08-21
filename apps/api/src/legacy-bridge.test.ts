import type { Request } from "express";
import jwt from "jsonwebtoken";
import { describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@datahub/contracts";
import { LEGACY_TOKEN_TTL_SECONDS, legacyAuthBridge, mintLegacyToken } from "./legacy-bridge.js";

const SECRET = "test-secret-not-a-real-one";
const USER: SessionUser = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Blake Broker",
  email: "b@x.test",
  role: "broker",
  company_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  status: "active",
  company_ids: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
};

function reqWith(headers: Record<string, string> = {}): Request {
  return { headers: { ...headers } } as unknown as Request;
}

async function run(bridge: ReturnType<typeof legacyAuthBridge>, req: Request) {
  const next = vi.fn();
  await bridge(req, {} as never, next);
  return next;
}

describe("mintLegacyToken", () => {
  it("signs the exact payload legacy verifies", () => {
    // backend/src/services/authService.js signs `{ sub: userId }` and
    // backend/src/middleware/auth.js reads only `payload.sub`. Anything else in
    // here would be a second source of truth for a decision legacy makes from
    // the database.
    const decoded = jwt.verify(mintLegacyToken(USER.id, SECRET), SECRET) as jwt.JwtPayload;

    expect(decoded.sub).toBe(USER.id);
    expect(Object.keys(decoded).sort()).toEqual(["exp", "iat", "sub"]);
  });

  it("expires within the hop it was minted for", () => {
    const decoded = jwt.verify(mintLegacyToken(USER.id, SECRET), SECRET) as jwt.JwtPayload;

    expect(decoded.exp! - decoded.iat!).toBe(LEGACY_TOKEN_TTL_SECONDS);
  });

  it("cannot be verified with a different secret", () => {
    const token = mintLegacyToken(USER.id, SECRET);

    expect(() => jwt.verify(token, "some-other-secret")).toThrow();
  });
});

describe("legacyAuthBridge", () => {
  it("replaces the Better Auth token with one legacy can read", async () => {
    // The decisive case: the SPA sends its own session token, legacy cannot
    // verify it, and before this bridge existed every such request 401'd.
    const bridge = legacyAuthBridge({ resolveUser: async () => USER, secret: SECRET });
    const req = reqWith({ authorization: "Bearer better-auth-opaque-session-token" });

    await run(bridge, req);

    const token = String(req.headers.authorization).slice("Bearer ".length);
    expect(token).not.toBe("better-auth-opaque-session-token");
    expect((jwt.verify(token, SECRET) as jwt.JwtPayload).sub).toBe(USER.id);
  });

  it("mints from a cookie session, where no bearer was sent at all", async () => {
    const bridge = legacyAuthBridge({ resolveUser: async () => USER, secret: SECRET });
    const req = reqWith({ cookie: "better-auth.session_token=abc" });

    await run(bridge, req);

    expect((jwt.verify(
      String(req.headers.authorization).slice("Bearer ".length),
      SECRET,
    ) as jwt.JwtPayload).sub).toBe(USER.id);
  });

  it("leaves an anonymous request completely untouched", async () => {
    // The whole safety argument. No resolved session means no minting, so the
    // bridge can only ever restate an identity the gateway already established
    // — it can never invent one. Legacy still refuses, exactly as before.
    const bridge = legacyAuthBridge({ resolveUser: async () => null, secret: SECRET });
    const req = reqWith();

    const next = await run(bridge, req);

    expect(req.headers.authorization).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });

  it("does not upgrade a forged token when the session does not resolve", async () => {
    const bridge = legacyAuthBridge({ resolveUser: async () => null, secret: SECRET });
    const req = reqWith({ authorization: "Bearer forged" });

    await run(bridge, req);

    expect(req.headers.authorization).toBe("Bearer forged");
  });

  it("passes the request on when resolving throws, rather than 500ing it", async () => {
    // A component whose entire job is to be invisible must not be the thing that
    // fails the request. Legacy still decides; the caller sees legacy's answer.
    const bridge = legacyAuthBridge({
      resolveUser: async () => {
        throw new Error("session store unreachable");
      },
      secret: SECRET,
    });
    const req = reqWith({ authorization: "Bearer whatever" });

    const next = await run(bridge, req);

    expect(next).toHaveBeenCalledOnce();
    expect(next.mock.calls[0]).toHaveLength(0); // next(), never next(err)
    expect(req.headers.authorization).toBe("Bearer whatever");
  });

  it("mints per request rather than reusing one token", async () => {
    const sign = vi.fn((id: string) => `signed-for-${id}`);
    const bridge = legacyAuthBridge({ resolveUser: async () => USER, secret: SECRET, sign });

    await run(bridge, reqWith());
    await run(bridge, reqWith());

    expect(sign).toHaveBeenCalledTimes(2);
  });
});
