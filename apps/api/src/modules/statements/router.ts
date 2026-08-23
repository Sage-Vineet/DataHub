import express from "express";
import type { Request, RequestHandler, Response, Router } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { HttpError } from "../../shared/errors.js";
import { withCommonMiddleware } from "../../shared/router.js";
import type { StatementExtract } from "./ports.js";
import type { StatementsService } from "./service.js";

export interface StatementsRouterDeps {
  service: StatementsService;
  requireAuth: RequestHandler;
}

/**
 * Statements read out of uploaded documents.
 *
 * The wire shape keeps legacy's `{ success, source, statementType, data }`,
 * because the Reports page reads `data` and checks `source` to decide how to
 * render — but `data` is now the extracted statement itself rather than
 * legacy's `data.manual_report_upload.report`, which was an envelope inside an
 * envelope. The document the statement came from is named alongside it, which
 * legacy never surfaced: a reader looking at a figure could not see which file
 * it was read out of.
 */
export function createStatementsRouter(deps: StatementsRouterDeps): Router {
  const { service, requireAuth } = deps;
  const router = express.Router();
  withCommonMiddleware(router, [helmet(), pinoHttp(), express.json(), requireAuth]);

  const handle =
    (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
    (req, res, next) =>
      fn(req, res).catch((err: unknown) => {
        if (err instanceof HttpError) {
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

  const str = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

  const asView = (extract: StatementExtract) => ({
    success: true,
    source: extract.sourceKey,
    statementType: extract.statementType,
    // Where this came from. Legacy reported neither, so a reader who doubted a
    // figure had no way back to the file it was read out of — or, for a pulled
    // statement, to the run that pulled it and the question it was asked.
    documentId: extract.documentId,
    documentName: extract.documentName,
    syncRunId: extract.syncRunId,
    datasetVersionId: extract.datasetVersionId,
    reportParams: extract.reportParams,
    extractId: extract.id,
    data: extract.payload,
    periodStart: extract.periodStart,
    periodEnd: extract.periodEnd,
    asOfDate: extract.asOfDate,
    fiscalYear: extract.fiscalYear,
    updatedAt: extract.updatedAt,
    lastSyncedAt: extract.extractedAt,
  });

  router.get("/manual-report-uploads/reports/:statementType/latest", handle(async (req, res) => {
    const extract = await service.resolve(
      req.user!,
      companyOf(req),
      String(req.params.statementType ?? "").toLowerCase(),
      {
        ...(str(req.query.sourceKey) ? { sourceKey: str(req.query.sourceKey)! } : {}),
        // `rowId` is legacy's name for it, kept so existing callers still work.
        ...(str(req.query.extractId) ?? str(req.query.rowId)
          ? { extractId: (str(req.query.extractId) ?? str(req.query.rowId))! }
          : {}),
        ...(str(req.query.keyReportVersionId)
          ? { keyReportVersionId: str(req.query.keyReportVersionId)! }
          : {}),
      },
    );
    res.json(asView(extract));
  }));

  router.get("/manual-report-uploads/reports/:statementType/all", handle(async (req, res) => {
    const year = Number.parseInt(String(req.query.fiscalYear ?? ""), 10);
    const reports = await service.list(
      req.user!,
      companyOf(req),
      String(req.params.statementType ?? "").toLowerCase(),
      {
        ...(str(req.query.sourceKey) ? { sourceKey: str(req.query.sourceKey)! } : {}),
        ...(Number.isInteger(year) ? { fiscalYear: year } : {}),
      },
    );
    res.json({ success: true, reports: reports.map(asView) });
  }));

  router.get("/manual-report-uploads/source-tree", handle(async (req, res) => {
    const tree = await service.sourceTree(req.user!, companyOf(req), {
      ...(str(req.query.sourceKey) ? { sourceKey: str(req.query.sourceKey)! } : {}),
    });
    res.json({ success: true, tree });
  }));

  /**
   * The saved bank reconciliation.
   *
   * Legacy kept this in `qb_bank_reconciliation_snapshots` — one row per
   * company holding a payload, a date range and an accounting method. That is
   * a statement with a period and a provenance, which is what
   * `statement_extracts` already is, so it is one of those with
   * `statement_type = "bank_reconciliation"` rather than a table of its own.
   *
   * Answers `{ found: false }` rather than 404 when there is none: the page
   * calls this on load to restore what it can WITHOUT a live QuickBooks
   * connection, and a 404 there reads as an error rather than as "nothing
   * saved yet".
   */
  router.get("/qb-bank-activity/saved", handle(async (req, res) => {
    const companyId = companyOf(req);
    const saved = await service.latestOrNull(req.user!, companyId, "bank_reconciliation", {
      ...(str(req.query.sourceKey) ? { sourceKey: str(req.query.sourceKey)! } : {}),
    });

    if (!saved) {
      res.json({ found: false });
      return;
    }

    const params = saved.reportParams as { accountingMethod?: unknown };
    res.json({
      found: true,
      updatedAt: saved.updatedAt,
      startDate: saved.periodStart,
      endDate: saved.periodEnd,
      accountingMethod:
        typeof params.accountingMethod === "string" ? params.accountingMethod : "Accrual",
      data: saved.payload,
      extractId: saved.id,
    });
  }));

  return router;
}
