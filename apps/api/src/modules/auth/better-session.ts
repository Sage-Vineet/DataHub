import type { NextFunction, Request, RequestHandler, Response } from "express";
import { fromNodeHeaders } from "better-auth/node";
import type { SessionUser, UserRole, UserStatus } from "@datahub/contracts";
import type { BetterAuth } from "./better-auth.js";
import type { AuthRepository } from "./ports.js";

/** The subset of the Better Auth user we rely on (business fields via D2 mapping). */
export interface BetterAuthUser {
  id: string;
  email: string;
  name: string;
  role?: string | null;
  companyId?: string | null;
  status?: string | null;
}

/**
 * Project a Better Auth session user + its company memberships onto the wire
 * `SessionUser` (design D6) — byte-identical to what the bespoke module returned,
 * so the SPA and downstream code are unaffected.
 */
export function toSessionUser(user: BetterAuthUser, companyIds: string[]): SessionUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: (user.role ?? "buyer") as UserRole,
    company_id: (user.companyId ?? null) as string | null,
    status: (user.status ?? "active") as UserStatus,
    company_ids: companyIds,
  };
}

/** Resolve the current session (cookie or bearer) or null. */
export async function resolveSessionUser(
  auth: BetterAuth,
  repo: AuthRepository,
  req: Request,
): Promise<SessionUser | null> {
  const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
  const user = (session as { user?: BetterAuthUser } | null)?.user;
  if (!user) return null;
  const companyIds = await repo.listCompanyIdsForUser(user.id);
  return toSessionUser(user, companyIds);
}

/**
 * Require a valid Better Auth session; attaches `req.user` or responds 401.
 * Reads the httpOnly session cookie (or a Bearer token via the bearer plugin),
 * never a token from browser storage (M2/M3).
 */
export function requireBetterAuth(auth: BetterAuth, repo: AuthRepository): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const user = await resolveSessionUser(auth, repo, req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    req.user = user;
    next();
  };
}
