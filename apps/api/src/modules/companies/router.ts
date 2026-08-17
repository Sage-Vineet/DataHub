import express from "express";
import type { Request, RequestHandler, Response, Router } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { companies as contracts } from "@datahub/contracts";
import { HttpError } from "../../shared/errors.js";
import { withCommonMiddleware } from "../../shared/router.js";
import type { CompaniesService } from "./service.js";

function firstError(err: { issues: ReadonlyArray<{ message?: string }> }): string {
  return err.issues[0]?.message ?? "Invalid request.";
}

export interface CompaniesRouterDeps {
  service: CompaniesService;
  /** The shared session guard (Better Auth) — populates `req.user`. */
  requireAuth: RequestHandler;
}

/**
 * The `/companies` HTTP surface (parity with legacy shapes). helmet + pino are
 * scoped here; the shared `requireAuth` guard runs before every route so
 * `req.user` is always present. Errors carrying an HTTP status map to it.
 *
 * The chain is attached per-route (not via `router.use`) so paths this module
 * does not define fall through to legacy untouched — see `withCommonMiddleware`.
 */
export function createCompaniesRouter(deps: CompaniesRouterDeps): Router {
  const { service, requireAuth } = deps;
  const router = express.Router();
  withCommonMiddleware(router, [helmet(), pinoHttp(), express.json(), requireAuth]);

  const handle =
    (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
    (req, res, next) =>
      fn(req, res).catch((err: unknown) => {
        if (err instanceof HttpError) {
          res.status(err.status).json({ error: err.message });
          return;
        }
        next(err);
      });

  // List — tenant-scoped; bare array (legacy parity).
  router.get(
    "/",
    handle(async (req, res) => {
      const list = await service.list(req.user!);
      res.json(list);
    }),
  );

  // Create — broker/admin only; 201 with the company + emailQueued (legacy parity).
  router.post(
    "/",
    handle(async (req, res) => {
      const parsed = contracts.companyCreate.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: firstError(parsed.error) });
        return;
      }
      const company = await service.create(req.user!, parsed.data);
      res.status(201).json({ ...company, emailQueued: Boolean(company.contact_email) });
    }),
  );

  // Read one — bare object (legacy parity).
  router.get(
    "/:id",
    handle(async (req, res) => {
      const company = await service.get(req.user!, req.params.id!);
      res.json(company);
    }),
  );

  // Update safe fields — bare object.
  router.patch(
    "/:id",
    handle(async (req, res) => {
      const parsed = contracts.companyUpdate.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: firstError(parsed.error) });
        return;
      }
      const company = await service.update(req.user!, req.params.id!, parsed.data);
      res.json(company);
    }),
  );

  // Delete (cascade) — 200 with a message (legacy parity).
  router.delete(
    "/:id",
    handle(async (req, res) => {
      await service.delete(req.user!, req.params.id!);
      res.status(200).json({ message: "Company deleted successfully" });
    }),
  );

  return router;
}
