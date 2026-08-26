import { firstError } from "../../shared/first-error.js";
import express from "express";
import type { Request, RequestHandler, Response, Router } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { users as contracts } from "@datahub/contracts";
import { HttpError } from "../../shared/errors.js";
import { emitActivity } from "../../activity/capture.js";
import { withCommonMiddleware } from "../../shared/router.js";
import type { UsersService } from "./service.js";

export interface UsersRouterDeps {
  service: UsersService;
  requireAuth: RequestHandler;
}

/**
 * The `/api/users` HTTP surface — the 10 legacy endpoints, parity shapes. Static
 * named routes (`find-by-email`, `broker-team/*`) are declared before `/:id`.
 */
export function createUsersRouter(deps: UsersRouterDeps): Router {
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

  router.get("/", handle(async (req, res) => {
    res.json(await service.list(req.user!));
  }));

  router.post("/", handle(async (req, res) => {
    const parsed = contracts.userCreate.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstError(parsed.error) });
      return;
    }
    res.status(201).json(await service.create(req.user!, parsed.data));
  }));

  router.get("/find-by-email", handle(async (req, res) => {
    const email = String(req.query.email ?? "");
    if (!email) {
      res.status(400).json({ error: "email query parameter is required." });
      return;
    }
    const user = await service.findByEmail(req.user!, email);
    if (!user) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(user);
  }));

  router.post("/broker-team/invite", handle(async (req, res) => {
    const parsed = contracts.brokerTeamInvite.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstError(parsed.error) });
      return;
    }
    await service.inviteBrokerToTeam(req.user!, parsed.data.invited_broker_id);
    res.status(201).json({ message: "Broker invited to team." });
  }));

  router.delete("/broker-team/invite/:invitedBrokerId", handle(async (req, res) => {
    await service.removeBrokerFromTeam(req.user!, req.params.invitedBrokerId!);
    res.status(204).send();
  }));

  router.get("/:id", handle(async (req, res) => {
    res.json(await service.get(req.user!, req.params.id!));
  }));

  router.patch("/:id", handle(async (req, res) => {
    const parsed = contracts.userUpdate.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstError(parsed.error) });
      return;
    }
    res.json(await service.update(req.user!, req.params.id!, parsed.data));
  }));

  router.delete("/:id", handle(async (req, res) => {
    await service.delete(req.user!, req.params.id!);
    res.status(204).send();
  }));

  router.post("/:id/add-companies", handle(async (req, res) => {
    const parsed = contracts.companyMembership.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstError(parsed.error) });
      return;
    }
    const result = await service.addCompanies(req.user!, req.params.id!, parsed.data.company_ids);
    emitActivity(res, {
      event_type: "access.granted",
      subject_id: req.params.id,
      payload: { company_ids: parsed.data.company_ids, granted_by: req.user!.id },
    });
    res.json(result);
  }));

  router.delete("/:id/remove-companies", handle(async (req, res) => {
    const parsed = contracts.companyMembership.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstError(parsed.error) });
      return;
    }
    const result = await service.removeCompanies(req.user!, req.params.id!, parsed.data.company_ids);
    emitActivity(res, {
      event_type: "access.revoked",
      subject_id: req.params.id,
      payload: { company_ids: parsed.data.company_ids, revoked_by: req.user!.id },
    });
    res.json(result);
  }));

  return router;
}
