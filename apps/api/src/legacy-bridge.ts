import jwt from "jsonwebtoken";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { SessionUser } from "@datahub/contracts";

/**
 * Mint a legacy-readable token for a request on its way to legacy.
 *
 * ADR-0007 moved identity to Better Auth, whose session token is an opaque
 * database-backed string. Legacy verifies an HS256 JWT signed with `JWT_SECRET`
 * and reads exactly one claim from it (`sub`, the user id) before loading the
 * user itself — see `backend/src/middleware/auth.js`. The two are not the same
 * kind of object, so after the auth cutover every request the SPA sends to a
 * route legacy still owns comes back `401 Invalid token`: legacy receives the
 * Better Auth token, fails to verify it, and refuses.
 *
 * The effect is not subtle. Reminders, the activity log, the chart of accounts,
 * report sources, the legacy CIM prep screen and the client CIM questionnaire
 * are all still legacy-owned, and all of them were dead in the browser while
 * every in-process module worked perfectly — which is why no test caught it.
 *
 * This bridges the gap for exactly as long as the cutover lasts: resolve the
 * session the gateway already trusts, and re-sign it in the shape legacy reads.
 * When the last route-group moves in-process, delete this file.
 *
 * ## Why this is not an authentication bypass
 *
 * A token is minted **only** from a session that already resolved. No session,
 * no header change — the request reaches legacy exactly as it would have, and
 * legacy refuses it exactly as it would have. The bridge can only ever restate
 * an identity the gateway had already established; it cannot invent one.
 *
 * Two further limits, both deliberate:
 *
 *   - The token lives for 60 seconds. It is minted per request and consumed
 *     immediately by the next hop, so a longer life buys nothing and widens the
 *     replay window if one ever leaked into a log.
 *   - It carries `sub` and nothing else. Legacy reads only `sub`; adding role or
 *     company claims would create a second, staler source of truth for
 *     authorization decisions legacy already makes from the database.
 */

/** Seconds a minted token remains valid. One hop, immediately. */
export const LEGACY_TOKEN_TTL_SECONDS = 60;

export interface LegacyAuthBridgeOptions {
  /** Resolve the caller from the gateway's own session, or null if anonymous. */
  resolveUser: (req: Request) => Promise<SessionUser | null>;
  /** The secret legacy verifies with. Must be the same value on both sides. */
  secret: string;
  /** Overridable for tests; defaults to the real signer. */
  sign?: (userId: string, secret: string) => string;
}

/** Sign the exact payload `backend/src/services/authService.js` signs. */
export function mintLegacyToken(userId: string, secret: string): string {
  return jwt.sign({ sub: userId }, secret, { expiresIn: LEGACY_TOKEN_TTL_SECONDS });
}

/**
 * Attach a legacy-readable Authorization header to requests bound for legacy.
 *
 * Mount immediately before the catch-all proxy, so it never runs for a route an
 * in-process module already claimed.
 */
export function legacyAuthBridge(options: LegacyAuthBridgeOptions): RequestHandler {
  const sign = options.sign ?? mintLegacyToken;

  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const user = await options.resolveUser(req);
      if (user?.id) {
        req.headers.authorization = `Bearer ${sign(user.id, options.secret)}`;
      }
    } catch {
      // A bridge that cannot resolve a session must not fail the request. Legacy
      // still gets it and still decides; the caller sees legacy's own 401 rather
      // than a 500 from a component whose entire job is to be invisible.
    }
    next();
  };
}
