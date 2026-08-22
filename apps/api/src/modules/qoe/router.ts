import express from "express";
import type { Request, RequestHandler, Response, Router } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { qoe as contracts } from "@datahub/contracts";
import { HttpError } from "../../shared/errors.js";
import { withCommonMiddleware } from "../../shared/router.js";
import type { QoeService } from "./service.js";

function firstError(err: { issues: ReadonlyArray<{ message?: string }> }): string {
  return err.issues[0]?.message ?? "Invalid request.";
}

export interface QoeRouterDeps {
  service: QoeService;
  requireAuth: RequestHandler;
}

/**
 * The QoE SDE/EBITDA bridge (`QE - 0004`).
 *
 * Mounted at `/qoe`, a path legacy does not serve, so this module adds surface
 * rather than shadowing it — the legacy `/ebitda-adjustments` routes stay
 * reachable as a rollback target until this has soaked.
 */
export function createQoeRouter(deps: QoeRouterDeps): Router {
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

  router.get(
    "/qoe/bridge",
    handle(async (req, res) => {
      const parsed = contracts.bridgeQuery.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: firstError(parsed.error) });
        return;
      }
      const { version_id, years, aggregation, data_source } = parsed.data;
      res.json(
        await service.bridge(req.user!, version_id, {
          years,
          aggregation,
          dataSource: data_source,
        }),
      );
    }),
  );

  router.get(
    "/qoe/balance-sheet",
    handle(async (req, res) => {
      const parsed = contracts.statementQuery.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: firstError(parsed.error) });
        return;
      }
      res.json(
        await service.balanceSheet(req.user!, parsed.data.version_id, {
          years: parsed.data.years,
        }),
      );
    }),
  );

  router.get(
    "/qoe/income-statement",
    handle(async (req, res) => {
      const parsed = contracts.statementQuery.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: firstError(parsed.error) });
        return;
      }
      res.json(
        await service.incomeStatement(req.user!, parsed.data.version_id, {
          years: parsed.data.years,
          aggregation: parsed.data.aggregation,
        }),
      );
    }),
  );

  router.get(
    "/qoe/trial-balance",
    handle(async (req, res) => {
      const parsed = contracts.statementQuery.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: firstError(parsed.error) });
        return;
      }
      res.json(
        await service.trialBalance(req.user!, parsed.data.version_id, {
          years: parsed.data.years,
          aggregation: parsed.data.aggregation,
        }),
      );
    }),
  );

  router.get(
    "/qoe/addbacks",
    handle(async (req, res) => {
      const versionId = String(req.query.version_id ?? "");
      if (!versionId) {
        res.status(400).json({ error: "version_id query parameter is required." });
        return;
      }
      res.json(await service.listAddbacks(req.user!, versionId));
    }),
  );

  router.post(
    "/qoe/addbacks",
    handle(async (req, res) => {
      const parsed = contracts.addbackCreate.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: firstError(parsed.error) });
        return;
      }
      const d = parsed.data;
      res.status(201).json(
        await service.createAddback(req.user!, {
          companyId: d.company_id,
          versionId: d.version_id,
          kind: d.kind,
          dataSource: d.data_source,
          typeKey: d.type_key,
          name: d.name,
          linkedAccountId: d.linked_account_id ?? null,
          vendorScope: d.vendor_scope,
          granularity: d.granularity,
          values: d.values ?? {},
          recastNormalizedValue: d.recast_normalized_value ?? null,
          groupId: d.group_id ?? null,
          groupLabel: d.group_label ?? null,
          explanation: d.explanation ?? null,
          commentary: d.commentary ?? null,
          createdBy: req.user!.id,
        }),
      );
    }),
  );

  router.delete(
    "/qoe/addbacks/:id",
    handle(async (req, res) => {
      await service.deleteAddback(req.user!, req.params.id!);
      res.status(204).end();
    }),
  );

  // Returns an UNSAVED draft. QE-0004 forbids auto-posting commentary.
  router.post(
    "/qoe/addbacks/:id/commentary/draft",
    handle(async (req, res) => {
      res.json(await service.draftCommentary(req.user!, req.params.id!));
    }),
  );

  // The explicit human confirmation that persists it.
  router.put(
    "/qoe/addbacks/:id/commentary",
    handle(async (req, res) => {
      const commentary = String((req.body as { commentary?: unknown })?.commentary ?? "");
      res.json(await service.saveCommentary(req.user!, req.params.id!, commentary));
    }),
  );

  /**
   * Classify the chart of accounts. `?dry_run=true` reports what would happen
   * without writing, which is what the review panel reads before the user
   * commits to it.
   */
  router.post(
    "/qoe/versions/:versionId/classify",
    handle(async (req, res) => {
      const dryRun = String(req.query.dry_run ?? "") === "true";
      res.json(await service.classify(req.user!, req.params.versionId!, { dryRun }));
    }),
  );

  /**
   * Reclassify an account (UAT #2). The legacy equivalent exists but sits
   * behind a JWT the gateway's session does not issue, so it is unreachable
   * from a Better Auth login.
   */
  router.put(
    "/qoe/versions/:versionId/accounts/:accountId/classification",
    handle(async (req, res) => {
      const parsed = contracts.accountClassificationUpdate.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: firstError(parsed.error) });
        return;
      }
      await service.setAccountClassification(
        req.user!,
        req.params.versionId!,
        req.params.accountId!,
        parsed.data.account_type,
      );
      res.status(204).end();
    }),
  );

  router.put(
    "/qoe/versions/:versionId/accounts/:accountId/role",
    handle(async (req, res) => {
      const parsed = contracts.accountRoleUpdate.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: firstError(parsed.error) });
        return;
      }
      await service.setAccountRole(
        req.user!,
        req.params.versionId!,
        req.params.accountId!,
        parsed.data.ebitda_role,
      );
      res.status(204).end();
    }),
  );

  return router;
}
