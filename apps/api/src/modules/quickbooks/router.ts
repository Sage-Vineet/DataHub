import express from "express";
import type { Request, RequestHandler, Response, Router } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { HttpError } from "../../shared/errors.js";
import { withCommonMiddleware } from "../../shared/router.js";
import { QuickBooksAuthError, QuickBooksRequestError, type QbReportType } from "./reports/client.js";
import type { QuickBooksEntitiesService } from "./reports/entities.js";
import type { QuickBooksReportsService } from "./reports/service.js";
import type { QuickBooksSyncStatusService } from "./reports/status.js";
import type { QuickBooksSyncService } from "./reports/sync.js";
import {
  requireIsoDate,
  toAccountingMethod,
  type QuickBooksBankActivityService,
} from "./reports/bank-activity.js";
import type { QuickBooksService } from "./service.js";

export interface QuickBooksRouterDeps {
  service: QuickBooksService;
  reports: QuickBooksReportsService;
  syncStatus: QuickBooksSyncStatusService;
  sync: QuickBooksSyncService;
  bankActivity: QuickBooksBankActivityService;
  entities: QuickBooksEntitiesService;
  requireAuth: RequestHandler;
}

/**
 * The QuickBooks connection's state.
 *
 * `/api/auth/quickbooks`, `/api/auth/callback` and `/refresh-token` are NOT
 * here. They are the OAuth dance, they need real Intuit credentials and a
 * browser redirect to exercise, and porting an auth flow that cannot be tested
 * against the thing it talks to is how a migration ships a subtly broken one.
 * They stay on legacy and reach it through the proxy, which is what
 * `withCommonMiddleware` leaves possible.
 */
export function createQuickBooksRouter(deps: QuickBooksRouterDeps): Router {
  const { service, reports, syncStatus, sync, bankActivity, entities, requireAuth } = deps;
  const router = express.Router();
  withCommonMiddleware(router, [helmet(), pinoHttp(), express.json(), requireAuth]);

  const handle =
    (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
    (req, res, next) =>
      fn(req, res).catch((err: unknown) => {
        if (err instanceof QuickBooksAuthError) {
          // 401, not 500: the fix is "reconnect QuickBooks", and a 500 sends
          // somebody looking for a fault in the report instead.
          res.status(401).json({ success: false, error: err.message, reconnectRequired: true });
          return;
        }
        if (err instanceof QuickBooksRequestError) {
          // 502: Intuit answered, and answered badly. Distinct from a fault
          // here, which is what a 500 would claim.
          res.status(502).json({ success: false, error: err.message });
          return;
        }
        if (err instanceof HttpError) {
          res.status(err.status).json({ success: false, error: err.message });
          return;
        }
        next(err);
      });

  /** A flag as a caller sends it: `true` in JSON, `"true"` in a query string. */
  const isTrue = (value: unknown): boolean => value === true || value === "true";

  /** A number a caller sent, or null when they sent nothing usable. */
  const numberOf = (value: unknown): number | null => {
    if (value === undefined || value === null || value === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const companyOf = (req: Request): string =>
    String(
      req.headers["x-client-id"] ??
        req.query.clientId ??
        (req.body as { clientId?: unknown } | undefined)?.clientId ??
        "",
    );

  router.get("/api/auth/status", handle(async (req, res) => {
    res.json({ success: true, ...(await service.status(req.user!, companyOf(req))) });
  }));

  /**
   * Disconnect.
   *
   * A GET, which it should not be — but it is what legacy exposed and what the
   * SPA calls, and changing the verb during a port means changing the caller
   * too. Worth revisiting once nothing depends on the old shape.
   */
  router.get("/api/auth/disconnect", handle(async (req, res) => {
    res.json({ success: true, ...(await service.disconnect(req.user!, companyOf(req))) });
  }));

  /**
   * The five report routes.
   *
   * Legacy had these as five near-identical handlers of roughly 150 lines
   * each, and they had drifted — only two of the five checked the accounting
   * basis before serving a cached report. One handler, five paths, because the
   * only thing that differs between them is which report to ask for.
   *
   * The paths stay as legacy spelled them, including `/all-reports`, which
   * despite its name returns exactly one report: the account list. Renaming it
   * during a port means changing the caller too, and the name is the SPA's
   * problem to stop using rather than this module's to fix silently.
   */
  const REPORT_ROUTES: ReadonlyArray<{
    path: string;
    type: QbReportType;
    /**
     * A key to nest the payload under, where the caller expects one.
     *
     * Only `/all-reports` has this, and it is a wart being carried rather than
     * a design. The SPA reads that response through eight fallback paths —
     * `report.accountList`, `payload.accountList`, `payload.data.accountList`,
     * `payload.data.data.accountList`, each also spelled `AccountList` — which
     * is what happens when a shape is never settled. Serving the bare payload
     * would be a NINTH shape and match none of the eight, so the wrapper stays
     * until the caller is fixed.
     */
    wrapAs?: string;
  }> = [
    { path: "/balance-sheet", type: "balance_sheet" },
    { path: "/profit-and-loss-statement", type: "profit_and_loss" },
    { path: "/qb-cashflow", type: "cash_flow" },
    { path: "/general-ledger", type: "general_ledger" },
    { path: "/all-reports", type: "account_list", wrapAs: "accountList" },
  ];

  for (const { path, type, wrapAs } of REPORT_ROUTES) {
    router.get(path, handle(async (req, res) => {
      const served = await reports.serve(
        req.user!,
        companyOf(req),
        type,
        req.query as Record<string, unknown>,
      );
      res.json({
        success: true,
        ...served,
        ...(wrapAs ? { data: { [wrapAs]: served.data } } : {}),
      });
    }));
  }

  /**
   * The state of the QuickBooks sync.
   *
   * Legacy read this from four tables that do not exist — `sync_metadata`,
   * `sync_jobs`, `finalized_datasets` and `qb_synced_reports` — so it has been
   * answering nothing. Composed here from the run, the active dataset version,
   * and what is actually held.
   */
  /**
   * Customers and invoices.
   *
   * Lists rather than reports, so there is no period to match and no coverage
   * fallback — the customer list is just the customer list. Freshness is a
   * clock: legacy went live only when the cache came back EMPTY, so a company
   * with genuinely no invoices called Intuit on every page load and one whose
   * list was stale never refetched at all.
   */
  router.get("/customers", handle(async (req, res) => {
    const served = await entities.list(req.user!, companyOf(req), "customers");
    res.json({ success: true, ...served });
  }));

  router.get("/invoices", handle(async (req, res) => {
    const served = await entities.list(req.user!, companyOf(req), "invoices");
    res.json({ success: true, ...served });
  }));

  /**
   * One invoice, by the number printed on it.
   *
   * Always live — an invoice is looked up by document number when somebody is
   * about to act on it, and a cached one is the wrong thing to show then.
   *
   * It is also the only read here that puts a URL segment into a query string.
   * Legacy pasted it in raw, so a document number containing a quote closed
   * the literal and the rest was read as query: an injection into a third
   * party's API against a client's live accounting data, reachable from a
   * path.
   */
  router.get("/invoices/doc/:docNumber", handle(async (req, res) => {
    const served = await entities.invoiceByDocNumber(
      req.user!,
      companyOf(req),
      String(req.params.docNumber ?? ""),
    );
    res.json({ success: true, ...served });
  }));

  /**
   * The general ledger, fetched and kept for reconciliation.
   *
   * Distinct from `/general-ledger`, which only serves the report. This one
   * also flattens its rows into the books side of `/bank-vs-books`, which is
   * why it is a separate path rather than a query parameter: one is a read and
   * the other replaces a table.
   */
  /**
   * The profit-and-loss figures a tax reconciliation compares against a return.
   *
   * Nine figures out of a report with hundreds of lines. It serves through the
   * same cache-then-live path as `/profit-and-loss-statement` rather than
   * fetching separately, so the two pages cannot show different numbers for
   * the same period — legacy fetched its own copy and they could.
   */
  /**
   * The month-by-month P&L behind the reconciliation's add-back picker.
   *
   * A summarised report is a different report, not a view of the annual one,
   * so it is cached under its own key — see the pull variant in the service.
   */
  router.get("/bank-reconciliation-line-items", handle(async (req, res) => {
    const items = await reports.monthlyLineItems(
      req.user!,
      companyOf(req),
      req.query as Record<string, unknown>,
    );
    res.json({ success: true, ...items });
  }));

  router.get("/quickbooks-pl", handle(async (req, res) => {
    const result = await reports.profitAndLossForTax(
      req.user!,
      companyOf(req),
      req.query as Record<string, unknown>,
    );
    res.json({ success: true, ...result });
  }));

  router.get("/qb-general-ledger", handle(async (req, res) => {
    const served = await reports.syncGeneralLedger(
      req.user!,
      companyOf(req),
      req.query as Record<string, unknown>,
    );
    res.json({
      success: true,
      message: "Data stored successfully",
      totalInserted: served.totalInserted,
      source: served.source,
      lastSyncAt: served.lastSyncAt,
    });
  }));

  /**
   * Pull the company's whole reporting history from QuickBooks.
   *
   * Two ways to wait. By default the response comes when the sync is done,
   * because that is what the SPA assumes — it shows "Reports Ready" and
   * regenerates the report the moment this resolves, and answering early
   * would have it render the data the sync was about to replace.
   *
   * `background: true` answers 202 as soon as the run EXISTS and drives it
   * afterwards, for a caller that would rather watch `/sync-status`. Legacy
   * offered the same choice but answered after a sixty-millisecond sleep,
   * hoping the row had appeared; on a slow database it had not and the
   * response named no run at all.
   */
  router.post("/api/quickbooks/sync", handle(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const companyId = companyOf(req);
    const options = {
      ...(numberOf(body.yearsBack ?? req.query.yearsBack) !== null
        ? { yearsBack: numberOf(body.yearsBack ?? req.query.yearsBack)! }
        : {}),
      accountingMethod: String(body.accountingMethod ?? req.query.accountingMethod ?? "Accrual"),
    };

    const started = await sync.start(req.user!, companyId, options);

    if (isTrue(body.background ?? req.query.background)) {
      // Deliberately not awaited. The run row already exists, so a caller
      // polling `/sync-status` sees it whatever happens next, and `run` closes
      // the run itself on any failure rather than leaving it open.
      void sync.run(req.user!, companyId, started.run.id, options).catch(() => undefined);
      res.status(202).json({
        success: true,
        source: "sync_job",
        message: "Background sync started.",
        runId: started.run.id,
        totalSteps: started.totalSteps,
      });
      return;
    }

    const outcome = await sync.run(req.user!, companyId, started.run.id, options);
    res.json({
      success: true,
      source: "sync_job",
      message:
        outcome.failed.length > 0
          ? `Synced ${outcome.fetched} reports; ${outcome.failed.length} could not be fetched.`
          : "All reports synced successfully",
      runId: started.run.id,
      totalSteps: started.totalSteps,
      fetched: outcome.fetched,
      failed: outcome.failed,
    });
  }));

  /**
   * The reconciliation page's Balance Review.
   *
   * One ladder per bank account: what moved each month, the balance that
   * implies, and the balance the books state. The range is required and
   * validated — legacy pasted both dates straight into the QuickBooks query
   * language.
   */
  const rangeOf = (req: Request) => ({
    startDate: requireIsoDate(req.query.start_date, "start_date"),
    endDate: requireIsoDate(req.query.end_date, "end_date"),
    accountingMethod: toAccountingMethod(req.query.accounting_method),
  });

  router.get("/qb-bank-activity", handle(async (req, res) => {
    res.json(await bankActivity.ladders(req.user!, companyOf(req), rangeOf(req)));
  }));

  router.get("/qb-one-bank-activity", handle(async (req, res) => {
    res.json(
      await bankActivity.oneLadder(
        req.user!,
        companyOf(req),
        String(req.query.accountId ?? ""),
        rangeOf(req),
      ),
    );
  }));

  router.get("/api/quickbooks/sync-status", handle(async (req, res) => {
    res.json({ success: true, ...(await syncStatus.status(req.user!, companyOf(req))) });
  }));

  return router;
}
