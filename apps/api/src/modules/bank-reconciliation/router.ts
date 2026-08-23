import express from "express";
import type { Request, RequestHandler, Response, Router } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { HttpError } from "../../shared/errors.js";
import { withCommonMiddleware } from "../../shared/router.js";
import type { ReconcileService } from "./reconcile.js";
import type { BankReconciliationService } from "./service.js";

export interface BankReconciliationRouterDeps {
  service: BankReconciliationService;
  reconcile: ReconcileService;
  requireAuth: RequestHandler;
}

/**
 * The bank reconciliation's editable surface.
 *
 * Mounted at `/`, so `withCommonMiddleware` is what keeps unmatched paths
 * untouched on their way to the proxy.
 *
 * Every route is company-scoped and the company arrives the three ways legacy
 * accepted it — the header on most screens, the query string on a few, the body
 * on the writes.
 */
export function createBankReconciliationRouter(deps: BankReconciliationRouterDeps): Router {
  const { service, reconcile, requireAuth } = deps;
  const router = express.Router();
  withCommonMiddleware(router, [helmet(), pinoHttp(), express.json(), requireAuth]);

  const handle =
    (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
    (req, res, next) =>
      fn(req, res).catch((err: unknown) => {
        if (err instanceof HttpError) {
          // Legacy answers `{ success: false, error }` on this surface and the
          // grid checks `success` before reading anything.
          res.status(err.status).json({ success: false, error: err.message });
          return;
        }
        next(err);
      });

  const companyOf = (req: Request): string =>
    String(
      req.headers["x-client-id"] ??
        req.query.clientId ??
        (req.body as { clientId?: unknown } | undefined)?.clientId ??
        "",
    );

  const asAmounts = (value: unknown): Record<string, number> => {
    if (!value || typeof value !== "object") return {};
    const out: Record<string, number> = {};
    for (const [month, amount] of Object.entries(value as Record<string, unknown>)) {
      const n = Number(amount);
      if (Number.isFinite(n)) out[month] = n;
    }
    return out;
  };

  router.get("/bank-reconciliation-adjustments", handle(async (req, res) => {
    const adjustments = await service.listAdjustments(req.user!, companyOf(req));
    res.json({ success: true, adjustments });
  }));

  router.post("/bank-reconciliation-adjustments", handle(async (req, res) => {
    const body = (req.body ?? {}) as { month?: unknown; rowKey?: unknown; amount?: unknown };
    await service.setAdjustment(req.user!, companyOf(req), {
      month: String(body.month ?? ""),
      rowKey: String(body.rowKey ?? ""),
      amount: body.amount,
    });
    res.json({ success: true });
  }));

  router.get("/bank-reconciliation-addback-items", handle(async (req, res) => {
    const section = typeof req.query.section === "string" ? req.query.section : undefined;
    const items = await service.listAddbackItems(req.user!, companyOf(req), {
      reportSource: typeof req.query.reportSource === "string" ? req.query.reportSource : "",
      ...(section ? { section } : {}),
    });
    res.json({ success: true, items });
  }));

  router.post("/bank-reconciliation-addback-items", handle(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const item = await service.createAddbackItem(req.user!, companyOf(req), {
      section: String(body.section ?? ""),
      name: String(body.name ?? ""),
      source: typeof body.source === "string" ? body.source : undefined,
      monthAmounts: asAmounts(body.monthAmounts),
      reportSource: String(body.reportSource ?? ""),
    });
    res.json({ success: true, item });
  }));

  router.put("/bank-reconciliation-addback-items/:id", handle(async (req, res) => {
    const body = (req.body ?? {}) as { monthAmounts?: unknown };
    await service.updateAddbackItemAmounts(
      req.user!,
      companyOf(req),
      req.params.id!,
      asAmounts(body.monthAmounts),
    );
    res.json({ success: true });
  }));

  router.delete("/bank-reconciliation-addback-items/:id", handle(async (req, res) => {
    await service.deleteAddbackItem(req.user!, companyOf(req), req.params.id!);
    res.json({ success: true });
  }));

  /**
   * The bank against the books.
   *
   * Answers both sides — legacy mapped over the bank rows only, so a
   * transaction in the books the bank had never seen did not appear. `counts`
   * sits beside `variance` because a zero variance with exceptions on both
   * sides is two mistakes that cancel, not a reconciliation that passed.
   *
   * `totalRecords` and `data` keep legacy's names, because that is what the
   * page reads.
   */
  router.get("/bank-vs-books", handle(async (req, res) => {
    const summary = await reconcile.reconcile(req.user!, companyOf(req));
    res.json({
      success: true,
      totalRecords: summary.rows.length,
      data: summary.rows,
      counts: summary.counts,
      bankTotal: summary.bankTotal,
      booksTotal: summary.booksTotal,
      variance: summary.variance,
    });
  }));

  return router;
}
