import express from "express";
import type { Request, RequestHandler, Response, Router } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { BadRequestError, HttpError } from "../../shared/errors.js";
import { REPORT_SOURCE_KEYS } from "../report-sources/ports.js";
import { withCommonMiddleware } from "../../shared/router.js";
import type { StatementExtract } from "./ports.js";
import { MissingCashFlowInputsError, type CashFlowService } from "./cash-flow.js";
import type { DashboardService, TaxComparisonService } from "./dashboard.js";
import type { BankStatementsService } from "./bank-statements.js";
import type { StatementTransactionsService } from "./statement-transactions.js";
import { toTaxReturnRows, type TaxReturnService } from "./tax-return.js";
import type { StatementsService } from "./service.js";
import type { SourceSyncService } from "./source-sync.js";

export interface StatementsRouterDeps {
  service: StatementsService;
  cashFlow: CashFlowService;
  dashboard: DashboardService;
  taxComparison: TaxComparisonService;
  /** Absent where no model is configured; the routes say so rather than failing. */
  taxReturn?: TaxReturnService;
  bankStatements?: BankStatementsService;
  statementTransactions?: StatementTransactionsService;
  /** Absent where no model is configured; the sync routes say so. */
  sourceSync?: SourceSyncService;
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
  const {
    service,
    cashFlow,
    dashboard,
    taxComparison,
    taxReturn,
    bankStatements,
    statementTransactions,
    sourceSync,
    requireAuth,
  } = deps;
  const router = express.Router();
  withCommonMiddleware(router, [helmet(), pinoHttp(), express.json(), requireAuth]);

  const handle =
    (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
    (req, res, next) =>
      fn(req, res).catch((err: unknown) => {
        if (err instanceof MissingCashFlowInputsError) {
          // The list, not just the sentence: the page turns `missingInputs`
          // into the files to go and upload.
          res.status(err.status).json({
            success: false,
            error: err.message,
            fiscalYear: err.fiscalYear,
            missingInputs: err.missingInputs,
          });
          return;
        }
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

  /**
   * The sync service, or a 503 saying why not.
   *
   * A 503 rather than a 500: no model is configured on this server, which is a
   * deployment fact rather than a fault, and the difference tells whoever is
   * reading the log where to go.
   */
  const requireSync = (): SourceSyncService => {
    if (!sourceSync) {
      throw new HttpError(503, "Statement extraction is not configured on this server.");
    }
    return sourceSync;
  };

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

  /**
   * `defaultSourceKey` is required, not optional.
   *
   * Both mounts supply one — the manual uploads and the QMS pull are separate
   * sources and a request naming neither still means one of them. Optional, it
   * left a branch for "no source at all" that neither call site can reach, and
   * a source-less resolve would answer whichever statement happened to be
   * newest across both.
   */
  const latestOf = (defaultSourceKey: string) =>
    handle(async (req: Request, res: Response) => {
      const sourceKey = str(req.query.sourceKey) ?? defaultSourceKey;
      const extract = await service.resolve(
        req.user!,
        companyOf(req),
        req.params.statementType!.toLowerCase(),
        {
          sourceKey,
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
    });

  /**
   * The Excel-and-PDF upload source.
   *
   * Pinned rather than open, because the page these serve has one picker per
   * source and an unpinned route would mix them: a QuickBooks export and a
   * hand-built spreadsheet in one dropdown produce a statement that is from
   * neither, and nothing on screen would say which row came from where.
   * `?sourceKey=` still overrides, for a caller that means to ask.
   */
  const MANUAL = REPORT_SOURCE_KEYS.MANUAL_UPLOAD;

  router.get("/manual-report-uploads/reports/:statementType/latest", latestOf(MANUAL));

  /**
   * One entry in the file picker.
   *
   * A different shape from `asView` because it answers a different question.
   * `asView` says "here is the statement"; this says "here is a file you could
   * choose", and what a person picks by is its NAME — which `asView` has no
   * reason to carry and legacy's list carried as `fileName`.
   *
   * `rowId` is legacy's name for the extract id, kept because it is what the
   * picker sets as its option value. Renaming it would be a rename for its own
   * sake that silently empties the dropdown.
   */
  const asFile = (extract: StatementExtract) => ({
    rowId: extract.id,
    documentId: extract.documentId,
    fileName: extract.documentName ?? "Unknown file",
    folderName: extract.folderName,
    data: extract.payload,
    periodStart: extract.periodStart,
    periodEnd: extract.periodEnd,
    asOfDate: extract.asOfDate,
    fiscalYear: extract.fiscalYear,
    updatedAt: extract.updatedAt,
    lastSyncedAt: extract.extractedAt,
  });

  /** Required for the same reason as `latestOf` above. */
  const listFiles = (defaultSourceKey: string) =>
    handle(async (req: Request, res: Response) => {
      const year = Number.parseInt(String(req.query.fiscalYear ?? ""), 10);
      const statementType = req.params.statementType!.toLowerCase();
      const sourceKey = str(req.query.sourceKey) ?? defaultSourceKey;
      const files = await service.list(req.user!, companyOf(req), statementType, {
        sourceKey,
        ...(Number.isInteger(year) ? { fiscalYear: year } : {}),
        ...(str(req.query.keyReportVersionId)
          ? { keyReportVersionId: str(req.query.keyReportVersionId)! }
          : {}),
      });
      res.json({ success: true, statementType, files: files.map(asFile) });
    });

  router.get("/manual-report-uploads/reports/:statementType/all", listFiles(MANUAL));

  router.get("/manual-report-uploads/source-tree", handle(async (req, res) => {
    const tree = await service.sourceTree(req.user!, companyOf(req), {
      sourceKey: str(req.query.sourceKey) ?? MANUAL,
    });
    res.json({ success: true, tree });
  }));

  /**
   * The QuickBooks-manual source, as its own three routes.
   *
   * Legacy had two parallel sets of handlers for this — `reports/*` and
   * `qms-reports/*` — differing only in which source they read. They are the
   * same routes with the source pinned, so they are the same handlers with the
   * source pinned; the alternative is two implementations that drift.
   *
   * They stay as distinct paths rather than becoming `?sourceKey=` because the
   * page has two independent pickers, one per source, and a single path would
   * make "which source am I looking at" a query parameter the caller could
   * forget — which is how you end up showing a spreadsheet's figures on the
   * QuickBooks tab.
   */
  /**
   * Cash flow, derived rather than stored.
   *
   * Legacy served these from a cache written during "Sync All", so a company
   * with every input uploaded still got "Run Sync All to generate cash flow
   * reports automatically" until somebody did. The inputs are on file and the
   * derivation is a pure function over them, so it runs on the request.
   */
  router.get("/manual-upload/cashflow/periods", handle(async (req, res) => {
    const periods = await cashFlow.periods(req.user!, companyOf(req), {
      sourceKey: str(req.query.sourceKey) ?? MANUAL,
    });
    res.json({ success: true, periods });
  }));

  router.get("/manual-upload/cashflow", handle(async (req, res) => {
    const raw = String(req.query.period ?? req.query.fiscalYear ?? "").trim();
    if (!/^\d{4}$/.test(raw)) {
      throw new BadRequestError(
        "period is required and must be a four-digit year, for example 2024.",
      );
    }
    const statement = await cashFlow.forFiscalYear(
      req.user!,
      companyOf(req),
      Number.parseInt(raw, 10),
      { sourceKey: str(req.query.sourceKey) ?? MANUAL },
    );
    res.json({ success: true, source: "manual_upload_generated", ...statement });
  }));

  /**
   * A source's landing dashboard.
   *
   * Derived on the request. Legacy kept it in a five-minute in-process map, so
   * uploading a corrected statement left the old figures on screen for up to
   * five minutes, two gateway instances disagreed with each other, and nothing
   * invalidated it on write — the timer was the only thing that cleared it.
   * The inputs are a handful of rows and the derivation is arithmetic.
   *
   * `source` is validated rather than ignored: the page sends which dashboard
   * it thinks it is showing, and serving one source's figures under another's
   * heading is the failure the check exists to catch.
   */
  const dashboardFor = (sourceKey: string, accepted: readonly string[], label: string) =>
    handle(async (req: Request, res: Response) => {
      const requested = str(req.query.source);
      if (requested !== undefined && !accepted.includes(requested)) {
        res.status(400).json({ success: false, message: "Invalid dashboard source" });
        return;
      }
      const built = await dashboard.build(req.user!, companyOf(req), sourceKey);
      res.json({ success: true, source: label, ...built });
    });

  /**
   * What a company's tax return says.
   *
   * Read out of the company's OWN linked document. The version this replaces
   * read a PDF off the server's filesystem, matched by filename against the
   * requested year and ignoring the company — so it never worked in a deployed
   * environment, and would have served one company's figures to all of them
   * had a file ever appeared in that directory.
   *
   * Answers `{ taxData, data }` — the figures and the nine rows the page sets
   * beside `/quickbooks-pl`'s.
   */
  const taxData = handle(async (req: Request, res: Response) => {
    if (!taxReturn) {
      res.status(503).json({
        success: false,
        error: "Tax return extraction is not configured on this server.",
      });
      return;
    }
    const result = await taxReturn.read(req.user!, companyOf(req), {
      ...(str(req.query.keyReportVersionId)
        ? { keyReportVersionId: str(req.query.keyReportVersionId)! }
        : {}),
      // `force=1` is legacy's name for it, and what the page's refresh sends.
      ...(str(req.query.force) ? { force: true } : {}),
    });
    res.json({
      success: true,
      year: result.figures.year,
      formType: result.figures.formType,
      documentId: result.documentId,
      documentName: result.documentName,
      extractedAt: result.extractedAt,
      source: result.source,
      taxData: result.figures,
      data: toTaxReturnRows(result.figures),
      reconcilingItems: result.figures.reconcilingItems,
    });
  });

  // Both paths the SPA calls. One handler, so the two cannot answer different
  // figures for the same company.
  router.get("/tax-data", taxData);
  router.get("/manual-report-uploads/tax-data", taxData);

  /**
   * The books' side of the tax reconciliation, per year.
   *
   * Legacy had three paths — a stored `pl_for_tax` blob, the parsed rows, and
   * a live Gemini extraction — and they could disagree, because the blob was
   * written by a sync that might have run against a different file from the
   * one the rows came from. One path now: the parsed rows, which is what every
   * other page in the product already believes.
   */
  router.get("/manual-report-uploads/pl-for-tax", handle(async (req, res) => {
    const built = await taxComparison.build(
      req.user!,
      companyOf(req),
      str(req.query.sourceKey) ?? REPORT_SOURCE_KEYS.MANUAL_UPLOAD,
    );
    res.json({ success: true, ...built });
  }));

  /**
   * The bank reconciliation's grid.
   *
   * One handler behind three paths, differing only in which source's
   * statements they read. Legacy had three near-identical handlers, and they
   * are the kind that drift.
   */
  const bankData = (defaultSourceKey: string) =>
    handle(async (req: Request, res: Response) => {
      if (!bankStatements) {
        res.status(503).json({
          success: false,
          error: "Bank statement extraction is not configured on this server.",
        });
        return;
      }
      const year = Number.parseInt(String(req.query.fiscalYear ?? ""), 10);
      const grid = await bankStatements.grid(req.user!, companyOf(req), {
        sourceKey: str(req.query.sourceKey) ?? defaultSourceKey,
        ...(str(req.query.keyReportVersionId)
          ? { keyReportVersionId: str(req.query.keyReportVersionId)! }
          : {}),
        ...(Number.isInteger(year) ? { fiscalYear: year } : {}),
        ...(str(req.query.force) ? { force: true } : {}),
      });
      res.json({
        success: true,
        bank_count: grid.banks.length,
        banks: grid.banks,
        months: grid.months,
        totals: grid.totals,
        // How many statements could not be dated, and how many documents were
        // read against how many were found — so a short grid can be explained
        // rather than read as a company with no bank activity.
        skipped: grid.skipped,
        documentCount: grid.documentCount,
        extractedCount: grid.extractedCount,
      });
    });

  const QMS = REPORT_SOURCE_KEYS.QUICKBOOKS_MANUAL;

  /**
   * The bank balances the BALANCE SHEET states.
   *
   * The books' side of the reconciliation, against the statements' side that
   * `/bank-data` answers. The page sets the two beside each other.
   */
  router.get("/manual-report-uploads/bs-bank-balances", handle(async (req, res) => {
    if (!bankStatements) {
      res.status(503).json({
        success: false,
        error: "Balance sheet extraction is not configured on this server.",
      });
      return;
    }
    const balances = await bankStatements.balanceSheetBalances(req.user!, companyOf(req), {
      ...(str(req.query.keyReportVersionId)
        ? { keyReportVersionId: str(req.query.keyReportVersionId)! }
        : {}),
      ...(str(req.query.force) ? { force: true } : {}),
    });
    res.json({ success: true, ...balances });
  }));

  /**
   * The transactions in a chunk of statement text.
   *
   * The caller sends TEXT. The instructions live on the server — the version
   * this replaces took `systemPrompt` from the request body and passed it to
   * the model, which made this an open proxy to a paid API for any
   * authenticated user. A caller that still sends `systemPrompt` is not
   * refused, because the page does; it is ignored, which is the point.
   */
  router.post("/parse-bank-statement", handle(async (req, res) => {
    if (!statementTransactions) {
      res.status(503).json({
        success: false,
        error: "Statement parsing is not configured on this server.",
      });
      return;
    }
    const body = req.body as { userMessage?: unknown; text?: unknown };
    const result = await statementTransactions.parse(
      req.user!,
      companyOf(req),
      String(body.text ?? body.userMessage ?? ""),
    );
    // `transactions` is what the page reads. `skipped` is new: a list shorter
    // than the statement looks exactly like a statement with fewer
    // transactions, and this says which it was.
    res.json({ transactions: result.transactions, skipped: result.skipped });
  }));

  router.get("/manual-upload/bank-data", bankData(MANUAL));
  router.get("/extract-bank-pdf-records", bankData(MANUAL));
  router.get("/manual-report-uploads/qms-bank-data", bankData(QMS));

  router.get(
    "/manual-report-uploads/qms-dashboard",
    dashboardFor(QMS, ["quickbooks_manual"], "quickbooks_manual"),
  );

  router.get(
    "/manual-report-uploads/manual-upload-dashboard",
    dashboardFor(
      MANUAL,
      ["manual_upload_excel_pdf", "manual_upload"],
      "manual_upload_excel_pdf",
    ),
  );

  router.get("/manual-report-uploads/qms-reports/:statementType/all", listFiles(QMS));

  router.get("/manual-report-uploads/qms-reports/:statementType/latest", latestOf(QMS));

  router.get("/manual-report-uploads/qms-source-tree", handle(async (req, res) => {
    const tree = await service.sourceTree(req.user!, companyOf(req), { sourceKey: QMS });
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
  /**
   * Read a source's uploaded files into statements.
   *
   * The writer behind every manual-upload page: until this has run, a company
   * that uploaded a year of statements sees an empty dashboard with nothing to
   * explain it.
   *
   * Two paths for two sources, pinned the same way `reports/*` and
   * `qms-reports/*` are — the page has two independent buttons, and making the
   * source a query parameter is how you end up syncing the wrong one.
   */
  const syncSource = (sourceKey: string): RequestHandler =>
    handle(async (req, res) => {
      const sync = requireSync();
      const body = req.body as Record<string, unknown>;
      const result = await sync.syncSource(req.user!, companyOf(req), sourceKey, {
        ...(str(body.versionId) ?? str(req.query.versionId)
          ? { versionId: (str(body.versionId) ?? str(req.query.versionId))! }
          : {}),
        ...(body.force === true || req.query.force === "true" ? { force: true } : {}),
      });
      res.json({ success: true, ...result });
    });

  router.post("/manual-report-uploads/sync-source", syncSource(MANUAL));
  router.post("/manual-report-uploads/sync-qms-source", syncSource(QMS));

  /**
   * Parse the documents a caller named, and nothing else.
   *
   * The "Choose Folder" flow. It never re-scans the source, because on a
   * company with fifty statements that is fifty model calls to read the two
   * that were just uploaded.
   */
  router.post("/manual-report-uploads/qms-parse-documents", handle(async (req, res) => {
    const sync = requireSync();
    const body = req.body as { documents?: unknown; clearFirst?: unknown };
    if (!Array.isArray(body.documents)) {
      throw new BadRequestError("documents array is required.");
    }
    const result = await sync.parseDocuments(
      req.user!,
      companyOf(req),
      QMS,
      body.documents as Array<Record<string, unknown>>,
      { clearFirst: body.clearFirst === true },
    );
    res.json({ success: true, ...result });
  }));

  router.get("/qb-bank-activity/saved", handle(async (req, res) => {
    const companyId = companyOf(req);
    // Pulls only. A company's UPLOADED bank statements are also
    // `bank_reconciliation` extracts — one per document — and without this the
    // newest of those answers here: a payload of `{ statements: [...] }` where
    // the page expects a ladder of `{ accounts, months }`. It reads
    // `data.accounts`, finds nothing, and renders an empty grid with nothing
    // to say why. Filtered on provenance rather than on the source key because
    // two spellings of "quickbooks" are in use and the distinction that
    // matters is pulled-versus-uploaded.
    const saved = await service.latestOrNull(req.user!, companyId, "bank_reconciliation", {
      provenance: "pull",
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
