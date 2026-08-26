import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { SessionUser } from "@datahub/contracts";
import type { AuthService } from "./service.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser;
    }
  }
}

function bearer(req: Request): string | null {
  const header = req.headers.authorization;
  if (header && header.startsWith("Bearer ")) return header.slice("Bearer ".length).trim();
  return null;
}

/** Require a valid session token; attaches `req.user` or responds 401. */
export function requireAuth(service: AuthService): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const token = bearer(req);
    const userId = token ? service.verifyToken(token) : null;
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const user = await service.getSessionUser(userId);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    req.user = user;
    next();
  };
}
