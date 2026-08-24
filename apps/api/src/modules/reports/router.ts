import { firstError } from "../../shared/first-error.js";
import express from "express";
import type { Request, RequestHandler, Response, Router } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { reports as contracts } from "@datahub/contracts";
import { toPage, toPageSize } from "./extracted-data.js";
import { HttpError } from "../../shared/errors.js";
import { withCommonMiddleware } from "../../shared/router.js";
import type { ReportsService } from "./service.js";

/**
 * Serialize to the legacy wire shape.
 *
 * The internal contract (`reportVersionResponse`) is snake_case, but legacy
 * emits camelCase — `backend/src/services/keyReports/keyReportService.js`
 * `normalizeVersion()` — and the SPA reads `versionName`, `versionNumber` and
 * `isActive` directly. Returning the contract shape on the wire rendered the
 * version selector as "Version undefined" and made `isActive` always falsey, so
 * no version was ever auto-selected. Parity is the contract at the boundary;
 * the internal shape stays as it is.
 */
function toLegacyVersion(v: contracts.ReportVersionResponse) {
  return {
    id: v.id,
    companyId: v.company_id,
    versionNumber: v.version_number,
    versionName: v.version_name,
    status: v.status,
    isActive: v.is_active,
    resolvedBatchId: v.resolved_batch_id,
    lastSyncedAt: v.last_synced_at,
    metadata: v.metadata,
    createdBy: v.created_by,
  };
}

export interface ReportsRouterDeps {
  service: ReportsService;
  requireAuth: RequestHandler;
}

/**
 * Key-report *version* lifecycle (parity paths). Mounted broadly under `/api`; only
 * these routes are defined, so sync/mappings/chart-of-accounts/extracted-data fall
 * through to the legacy GL engine (design D2).
 */
export function createReportsRouter(deps: ReportsRouterDeps): Router {
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

  /**
   * List is company-scoped. Legacy resolves the company from the `X-Client-Id`
   * header (or `?clientId`), NOT from `?company_id` — and the SPA only ever
   * sends the header (`apps/web/src/lib/api.js` sets it on every request).
   * Accepting only `company_id` made this endpoint 400 for the real client,
   * which broke every screen behind the key-report version selector the moment
   * REPORTS_MODULE_ENABLED was turned on.
   *
   * The response envelope matches legacy for the same reason: the SPA store
   * reads `res.versions`, so returning a bare array left it with an empty list
   * and no error to show.
   */
  router.get("/key-reports/versions", handle(async (req, res) => {
    const companyId = String(
      req.query.company_id ?? req.query.clientId ?? req.headers["x-client-id"] ?? "",
    );
    if (!companyId) {
      res.status(400).json({ error: "company_id query parameter is required." });
      return;
    }
    const versions = await service.list(req.user!, companyId);
    res.json({
      success: true,
      versions: versions.map(toLegacyVersion),
      activeVersionId: versions.find((v) => v.is_active)?.id ?? null,
    });
  }));

  /**
   * The SPA speaks camelCase on this surface, in both directions.
   *
   * `toLegacyVersion` already handles the response half. This is the request
   * half, and it was missing: `createKeyReportVersion(clientId, {})` sends
   * `{ companyId }` and legacy's handler read `req.body.versionName`, while the
   * contract wants `company_id` and `version_name`. So "New version" answered
   * 400 for every caller the moment the module served the route — and it does,
   * since the demo sets `REPORTS_MODULE_ENABLED=true`.
   *
   * The company also arrives as `X-Client-Id` on some screens, the same way it
   * does on the list route above.
   *
   * Normalized here rather than widened in the contract: the internal shape
   * stays snake_case, and the translation lives at the boundary where the rest
   * of it already does.
   */
  const toCreateBody = (req: Request): unknown => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const companyId =
      body.company_id ?? body.companyId ?? req.query.clientId ?? req.headers["x-client-id"];
    const versionName = body.version_name ?? body.versionName;
    return {
      ...body,
      ...(companyId === undefined ? {} : { company_id: companyId }),
      ...(versionName === undefined ? {} : { version_name: versionName }),
    };
  };

  /** The same translation for a partial update. */
  const toUpdateBody = (req: Request): unknown => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const versionName = body.version_name ?? body.versionName;
    return { ...body, ...(versionName === undefined ? {} : { version_name: versionName }) };
  };

  router.post("/key-reports/versions", handle(async (req, res) => {
    const parsed = contracts.reportVersionCreate.safeParse(toCreateBody(req));
    if (!parsed.success) {
      res.status(400).json({ error: firstError(parsed.error) });
      return;
    }
    // Legacy answers `{ success, version }`; the SPA store reads `.version`.
    res.status(201).json({
      success: true,
      version: toLegacyVersion(await service.create(req.user!, parsed.data)),
    });
  }));

  /**
   * Legacy returns `{ success, version, mappingsByCategory, syncLogs,
   * validationResults }` and the SPA store reads `detail.version`. Returning a
   * bare version object left `detail.version` undefined, which drove
   * `selectKeyReportContext` into its INACTIVE branch — the version list
   * rendered but nothing downstream of it activated.
   *
   * Mappings, sync logs and validation results are still served by legacy
   * (design D2), so they are reported as null rather than fabricated as empty:
   * a caller can tell "not migrated here" from "none exist".
   */
  router.get("/key-reports/versions/:versionId", handle(async (req, res) => {
    const version = await service.get(req.user!, req.params.versionId!);
    res.json({
      success: true,
      version: toLegacyVersion(version),
      mappingsByCategory: null,
      syncLogs: null,
      validationResults: null,
    });
  }));

  /**
   * The raw rows behind a version, a page at a time.
   *
   * So somebody can check a figure against the file it came from. `dataType`
   * selects a table, which is why it is validated against a closed set rather
   * than passed through — an unknown value is a 400, not something that
   * reaches a query builder.
   */
  router.get("/key-reports/versions/:versionId/extracted-data", handle(async (req, res) => {
    const year = Number.parseInt(String(req.query.year ?? ""), 10);
    const page = await service.extractedData(req.user!, req.params.versionId!, {
      dataType: String(req.query.dataType ?? ""),
      ...(Number.isInteger(year) ? { year } : {}),
      ...(req.query.page !== undefined ? { page: toPage(req.query.page) } : {}),
      ...(req.query.pageSize !== undefined ? { pageSize: toPageSize(req.query.pageSize) } : {}),
      ...(typeof req.query.search === "string" ? { search: req.query.search } : {}),
    });
    res.json({ success: true, ...page });
  }));

  router.put("/key-reports/versions/:versionId", handle(async (req, res) => {
    const parsed = contracts.reportVersionUpdate.safeParse(toUpdateBody(req));
    if (!parsed.success) {
      res.status(400).json({ error: firstError(parsed.error) });
      return;
    }
    res.json({
      success: true,
      version: toLegacyVersion(await service.update(req.user!, req.params.versionId!, parsed.data)),
    });
  }));

  /**
   * `{ success, version }`, not a bare version.
   *
   * The Key Reports page does `const res = await duplicateKeyReportVersion(...)`
   * and then `if (res?.version?.id) setSelectedVersionId(res.version.id)`. A
   * bare version leaves `res.version` undefined, so the copy is created and
   * never selected — the screen looks like nothing happened.
   */
  router.post("/key-reports/versions/:versionId/duplicate", handle(async (req, res) => {
    res.status(201).json({
      success: true,
      version: toLegacyVersion(await service.duplicate(req.user!, req.params.versionId!)),
    });
  }));

  router.post("/key-reports/versions/:versionId/activate", handle(async (req, res) => {
    res.json({
      success: true,
      version: toLegacyVersion(await service.activate(req.user!, req.params.versionId!)),
    });
  }));

  router.delete("/key-reports/versions/:versionId", handle(async (req, res) => {
    await service.delete(req.user!, req.params.versionId!);
    res.status(204).send();
  }));

  router.get(
    "/key-reports/versions/:versionId/reports/financial-statements",
    handle(async (req, res) => {
      const year = Number.parseInt(String(req.query.year ?? ""), 10);
      const statements = await service.financialStatements(req.user!, req.params.versionId!, {
        year: Number.isFinite(year) ? year : undefined,
        currency: typeof req.query.currency === "string" ? req.query.currency : undefined,
        companyName: typeof req.query.companyName === "string" ? req.query.companyName : undefined,
      });
      // `success` is part of the shape the view checks before reading `reports`.
      res.json({ success: true, ...statements });
    }),
  );

  /**
   * The Profit & Loss.
   *
   * Company-scoped like its legacy counterpart, and resolved from the same
   * `X-Client-Id` header the SPA sets on every request — `?clientId` and
   * `?company_id` are accepted too, because the legacy handler took both.
   *
   * `fiscalYear` may repeat (`?fiscalYear=2023&fiscalYear=2024`) to put one
   * comparative column on the table per year, which is how the multi-select on
   * the Reports page sends it.
   */
  /** The company, from any of the three places the SPA sends it. */
  const companyOf = (req: Request): string => {
    const companyId = String(
      req.query.clientId ?? req.query.company_id ?? req.headers["x-client-id"] ?? "",
    );
    if (!companyId) throw new HttpError(400, "Missing clientId.");
    return companyId;
  };

  /**
   * The years to put comparative columns on.
   *
   * Accepts a repeated `fiscalYear` (how the multi-select sends it) and a
   * comma-separated `fiscalYears`, because both reach these endpoints.
   */
  const yearsOf = (req: Request): number[] => {
    const raw = req.query.fiscalYear ?? req.query.fiscalYears;
    return (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw])
      .flatMap((value) => String(value).split(","))
      .map((value) => Number.parseInt(value.trim(), 10))
      .filter((year) => Number.isInteger(year) && year > 0);
  };

  router.get("/reports/profit-loss", handle(async (req, res) => {
    const payload = await service.profitLoss(req.user!, companyOf(req), {
      fiscalYears: yearsOf(req),
    });
    // `success` is part of the envelope the page checks before reading the rows.
    res.json({ success: true, ...payload });
  }));

  router.get("/reports/balance-sheet", handle(async (req, res) => {
    const payload = await service.balanceSheet(req.user!, companyOf(req), {
      fiscalYears: yearsOf(req),
    });
    res.json({ success: true, ...payload });
  }));

  /**
   * The month-by-month P&L.
   *
   * `fiscalYear` is a single year here, not a set — the table's columns are the
   * months of one year, so a second year has nowhere to go.
   */
  /**
   * One year and a set of its months — the window every monthly-detail view
   * takes. `year` is accepted alongside `fiscalYear` because both reach these
   * endpoints, and an unparseable year is omitted rather than sent on as NaN.
   */
  const monthWindowOf = (req: Request): { fiscalYear?: number; months: number[] } => {
    const year = Number.parseInt(String(req.query.fiscalYear ?? req.query.year ?? ""), 10);
    const raw = req.query.month ?? req.query.months;
    const months = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw])
      .flatMap((value) => String(value).split(","))
      .map((value) => Number.parseInt(value.trim(), 10))
      .filter((month) => Number.isInteger(month) && month >= 1 && month <= 12);
    return { ...(Number.isInteger(year) && year > 0 ? { fiscalYear: year } : {}), months };
  };

  router.get("/reports/profit-loss/monthly-detail", handle(async (req, res) => {
    const payload = await service.monthlyDetail(req.user!, companyOf(req), monthWindowOf(req));
    res.json({ success: true, ...payload });
  }));

  router.get("/reports/balance-sheet/monthly-detail", handle(async (req, res) => {
    const payload = await service.balanceSheetMonthlyDetail(
      req.user!,
      companyOf(req),
      monthWindowOf(req),
    );
    res.json({ success: true, ...payload });
  }));

  router.get("/key-reports/versions/:versionId/mappings", handle(async (req, res) => {
    const mappingsByCategory = await service.listMappings(req.user!, req.params.versionId!);
    res.json({ success: true, mappingsByCategory });
  }));

  /**
   * Link documents to a category.
   *
   * `documentId` and `documentIds` are both accepted because the SPA sends
   * whichever suits the screen — one file from a picker, a whole selection from
   * a multi-select.
   */
  router.post("/key-reports/versions/:versionId/mappings", handle(async (req, res) => {
    const body = (req.body ?? {}) as {
      reportCategory?: unknown;
      documentId?: unknown;
      documentIds?: unknown;
    };
    const documentIds = Array.isArray(body.documentIds)
      ? body.documentIds.map(String)
      : body.documentId
        ? [String(body.documentId)]
        : [];

    const mappings = await service.linkMappings(req.user!, req.params.versionId!, {
      reportCategory: String(body.reportCategory ?? ""),
      documentIds,
    });
    res.status(201).json({ success: true, mappings });
  }));

  /**
   * Unlink one. Addressed by mapping id rather than nested under its version,
   * because that is the id the list hands back — and access is checked against
   * the mapping's own company rather than trusting the caller to name it.
   */
  router.delete("/key-reports/mappings/:mappingId", handle(async (req, res) => {
    await service.deleteMapping(req.user!, req.params.mappingId!);
    res.status(204).send();
  }));

  /**
   * Build the version's entry tables from the files linked to it.
   *
   * The tables this fills are the financial engine's input — the balance sheet
   * is rolled forward from `balance_sheet_entries` and the chart of accounts is
   * regenerated from them — so this is the route that turns uploaded files into
   * every figure the product reports.
   */
  router.post("/key-reports/versions/:versionId/sync", handle(async (req, res) => {
    const result = await service.sync(req.user!, req.params.versionId!);
    res.json({ success: true, ...(result as Record<string, unknown>) });
  }));

  router.get("/key-reports/versions/:versionId/sync-logs", handle(async (req, res) => {
    const limit = Number.parseInt(String(req.query.limit ?? ""), 10);
    const syncLogs = await service.listSyncLogs(
      req.user!,
      req.params.versionId!,
      Number.isFinite(limit) ? limit : undefined,
    );
    res.json({ success: true, syncLogs });
  }));

  /**
   * The Key Reports introduction popup, per user.
   *
   * The caller is taken from the session and never from the request, so one
   * user cannot read or set another's.
   */
  router.get("/key-reports/popup-preference", handle(async (req, res) => {
    res.json({ success: true, dismissed: await service.getPopupDismissed(req.user!) });
  }));

  router.put("/key-reports/popup-preference", handle(async (req, res) => {
    const raw = (req.body ?? {}) as { dismissed?: unknown };
    // Legacy accepted the string "true" as well as the boolean, because some
    // callers send a form value. Anything else is false rather than an error —
    // the worst outcome of a bad body here is a popup shown once more.
    const dismissed = raw.dismissed === true || raw.dismissed === "true";
    res.json({ success: true, dismissed: await service.setPopupDismissed(req.user!, dismissed) });
  }));

  router.get("/manual-gl/staging/filter-options", handle(async (req, res) => {
    const payload = await service.filterOptions(req.user!, companyOf(req));
    res.json({ success: true, ...payload });
  }));

  router.get("/manual-gl/validation/balance-sheet", handle(async (req, res) => {
    const payload = await service.validateBalanceSheet(req.user!, companyOf(req));
    res.json({ success: true, ...payload });
  }));

  router.get("/reports/profit-loss/detail-vendor", handle(async (req, res) => {
    const payload = await service.vendorDetail(req.user!, companyOf(req), {
      fiscalYears: yearsOf(req),
    });
    res.json({ success: true, ...payload });
  }));

  router.get("/reports/cashflow/monthly-detail", handle(async (req, res) => {
    const payload = await service.cashFlowMonthlyDetail(
      req.user!,
      companyOf(req),
      monthWindowOf(req),
    );
    res.json({ success: true, ...payload });
  }));

  router.get("/reports/cashflow", handle(async (req, res) => {
    const payload = await service.cashFlow(req.user!, companyOf(req), {
      fiscalYears: yearsOf(req),
    });
    res.json({ success: true, ...payload });
  }));

  return router;
}
