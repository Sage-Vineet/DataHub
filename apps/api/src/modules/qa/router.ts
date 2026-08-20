import express from "express";
import type { Request, RequestHandler, Response, Router } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { qa as contracts } from "@datahub/contracts";
import { HttpError } from "../../shared/errors.js";
import { withCommonMiddleware } from "../../shared/router.js";
import type { QaService } from "./service.js";

function firstError(err: { issues: ReadonlyArray<{ message?: string }> }): string {
  return err.issues[0]?.message ?? "Invalid request.";
}

export interface QaRouterDeps {
  service: QaService;
  requireAuth: RequestHandler;
  features?: { presentation?: boolean; nominations?: boolean };
}

/**
 * The `/qa/*` surface (`QA - 0001`, `QA - 0002`, `QA - 0003`).
 *
 * Note what is absent: there is no PATCH or DELETE for a response anywhere in
 * this file. `QA - 0002` makes a posted response permanently immutable, and the
 * enforcement is that the verb does not exist — not a guard that a later change
 * could relax. A correction goes through POST with `supersedes_id`.
 *
 * Mounted at the API root with paths written out in full, and deliberately NOT
 * registered in `moduleSurfaces()` — that absence, not the prefix, is what keeps
 * it out of `route-contract.test.ts`, exactly as `qoe` works.
 */
export function createQaRouter(deps: QaRouterDeps): Router {
  const { service, requireAuth } = deps;
  const features = {
    presentation: deps.features?.presentation ?? true,
    nominations: deps.features?.nominations ?? true,
  };
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

  /** A disabled sub-feature 404s rather than falling through to legacy. */
  const requireFeature =
    (on: boolean, name: string): RequestHandler =>
    (_req, res, next) => {
      if (!on) {
        res.status(404).json({ error: `The ${name} feature is not enabled.` });
        return;
      }
      next();
    };

  // ── categories and nomination ─────────────────────────────────────────────

  router.get(
    "/qa/companies/:companyId/categories",
    handle(async (req, res) => {
      res.json(await service.listCategories(req.user!, req.params.companyId!));
    }),
  );

  router.put(
    "/qa/companies/:companyId/categories/:categoryId/nominees",
    requireFeature(features.nominations, "category nomination"),
    handle(async (req, res) => {
      const parsed = contracts.nomineesReplace.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: firstError(parsed.error) });
        return;
      }
      res.json(
        await service.replaceNominees(
          req.user!,
          req.params.companyId!,
          req.params.categoryId!,
          parsed.data,
        ),
      );
    }),
  );

  // ── items ─────────────────────────────────────────────────────────────────

  router.get(
    "/qa/companies/:companyId/items",
    handle(async (req, res) => {
      const parsed = contracts.itemListQuery.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: firstError(parsed.error) });
        return;
      }
      res.json(await service.listItems(req.user!, req.params.companyId!, parsed.data));
    }),
  );

  router.post(
    "/qa/companies/:companyId/items",
    handle(async (req, res) => {
      const parsed = contracts.itemCreate.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: firstError(parsed.error) });
        return;
      }
      // Provenance fields are server context, not client input: a caller that
      // set `origin` would be claiming its question came from the QoE generator.
      // Trusted producers reach the service directly, never through this route.
      const { origin: _o, module_tag: _m, section_tag: _s, account_ref: _a, external_ref: _e, ...safe } =
        parsed.data;
      res
        .status(201)
        .json(await service.createItem(req.user!, req.params.companyId!, safe));
    }),
  );

  router.get(
    "/qa/items/:id",
    handle(async (req, res) => {
      res.json(await service.getItem(req.user!, req.params.id!));
    }),
  );

  router.patch(
    "/qa/items/:id",
    handle(async (req, res) => {
      const parsed = contracts.itemUpdate.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: firstError(parsed.error) });
        return;
      }
      res.json(await service.updateItem(req.user!, req.params.id!, parsed.data));
    }),
  );

  router.post(
    "/qa/items/:id/assignees",
    handle(async (req, res) => {
      const parsed = contracts.assigneesReplace.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: firstError(parsed.error) });
        return;
      }
      res.json(await service.replaceAssignees(req.user!, req.params.id!, parsed.data));
    }),
  );

  // ── responses ─────────────────────────────────────────────────────────────

  router.post(
    "/qa/items/:id/responses",
    handle(async (req, res) => {
      const parsed = contracts.responseCreate.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: firstError(parsed.error) });
        return;
      }
      res.status(201).json(await service.postResponse(req.user!, req.params.id!, parsed.data));
    }),
  );

  // ── presentable versions ──────────────────────────────────────────────────

  router.post(
    "/qa/items/:id/presentation",
    requireFeature(features.presentation, "presentable versions"),
    handle(async (req, res) => {
      const parsed = contracts.presentationCreate.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: firstError(parsed.error) });
        return;
      }
      res.status(201).json(await service.writePresentation(req.user!, req.params.id!, parsed.data));
    }),
  );

  router.post(
    "/qa/items/:id/presentation/:presentationId/publish",
    requireFeature(features.presentation, "presentable versions"),
    handle(async (req, res) => {
      res.json(
        await service.publishPresentation(req.user!, req.params.id!, req.params.presentationId!),
      );
    }),
  );

  router.get(
    "/qa/items/:id/audit",
    handle(async (req, res) => {
      res.json(await service.audit(req.user!, req.params.id!));
    }),
  );

  // ── attachments and visibility ────────────────────────────────────────────

  router.post(
    "/qa/items/:id/attachments",
    handle(async (req, res) => {
      const parsed = contracts.attachmentCreate.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: firstError(parsed.error) });
        return;
      }
      await service.attach(req.user!, req.params.id!, parsed.data);
      res.status(204).end();
    }),
  );

  router.post(
    "/qa/items/:id/visibility",
    handle(async (req, res) => {
      const parsed = contracts.visibilityRule.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: firstError(parsed.error) });
        return;
      }
      await service.setVisibility(req.user!, req.params.id!, parsed.data);
      res.status(204).end();
    }),
  );

  return router;
}
