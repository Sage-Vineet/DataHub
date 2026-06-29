const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { enforceDataSource, REPORT_SOURCE_KEYS } = require("../middleware/dataSourceIsolation");
const {
  listManualGlUploads,
  upsertManualGlUpload,
  generateManualGlReports,
  getLatestGeneratedManualGlReport,
  getLatestManualGlQuickbooksReport,
  getManualGlColumns,
  processManualGlData,
} = require("../services/manualGlService");
const {
  parseManualFilterQuery,
  getStageTransactions,
  getStageFilterOptions,
  getProfitLossSummaryFromStage,
  getProfitLossDetailFromStage,
  getProfitLossMonthlyDetailFromStage,
  getBalanceSheetSummaryFromStage,
  getBalanceSheetMonthlyDetailFromStage,
  getCashflowSummaryFromStage,
  getCashflowMonthlyDetailFromStage,
  getProfitLossVendorDetailFromStage,
  getVendorAnalysisFromStage,
  validateBatchBalanceSheet,
  listManualGlBatches,
  getActualFiscalYearsFromDB,
  resolveEffectiveReportBatchId,
} = require("../services/manualGlMultiYearService");
const { orchestrateManualGlUpload } = require("../services/manualGlUploadOrchestrationService");
const {
  SNAPSHOT_REPORT_TYPES,
  getSnapshotForBatch,
  getSnapshotForDatasetVersion,
  getSnapshotForActiveBatch,
  generateReportingSnapshotsForBatch,
} = require("../services/manualGlReportingSnapshotService");
const {
  activateUploadBatch,
  getActiveUploadBatch,
  getUploadBatchById,
  resolveReportBatchId,
} = require("../services/manualGlActiveBatchService");
const { uploadController } = require("../controllers/manualGl/uploadController");
const { continueController } = require("../controllers/manualGl/continueController");
const {
  listUploadJobs,
  getUploadJob,
  createUploadJob,
  updateUploadJob,
  listDatasetVersions,
  activateDatasetVersion,
  rollbackToVersion,
  finalizeUploadLifecycle,
  failUploadLifecycle,
  UPLOAD_JOB_STATUS,
} = require("../services/datasetVersionService");
const reportCache = require("../services/reportCache");
const { supabase } = require("../db");

const router = express.Router();
router.use(requireAuth);

function resolveClientId(req) {
  let clientId = req.headers["x-client-id"] || req.query.clientId;
  if (!clientId && req.headers.referer) {
    const match = req.headers.referer.match(/\/client\/([^/]+)/);
    if (match) clientId = match[1];
  }
  return clientId;
}

function resolveStatementTypeFromPath(pathname = "") {
  const normalized = String(pathname || "").toLowerCase();
  if (normalized.includes("/pl")) return "profit_and_loss";
  if (normalized.includes("/balance-sheet")) return "balance_sheet";
  if (normalized.includes("/cashflow")) return "cash_flow";
  return "";
}

function resolveSelectedFiscalYear(filters = {}) {
  const fiscalYears = Array.isArray(filters?.fiscalYears)
    ? filters.fiscalYears
    : Array.isArray(filters?.fiscalYear)
      ? filters.fiscalYear
      : [];
  const parsed = fiscalYears
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);
  if (!parsed.length) return null;
  return Math.max(...parsed);
}

function resolveSelectedDatasetVersion(filters = {}) {
  const candidates = [
    filters.datasetVersion,
    filters.dataset_version,
    filters.versionNumber,
    filters.version_number,
  ];
  if (!candidates.some((item) => item !== undefined && item !== null && item !== "")) {
    const rawVersionId = String(filters.versionId || filters.version_id || "").trim();
    if (/^\d+$/.test(rawVersionId)) candidates.push(rawVersionId);
  }

  for (const candidate of candidates) {
    const parsed = Number(candidate);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function normalizeApiErrorMessage(error, fallback = "Request failed.") {
  const raw = String(error?.message || fallback).trim();
  if (!raw) return fallback;
  const compact = raw.replace(/\s+/g, " ").trim();
  const lower = compact.toLowerCase();
  const isHtmlPayload =
    lower.includes("<!doctype html") ||
    lower.includes("<html") ||
    lower.includes("<head>") ||
    lower.includes("<body>");

  if (isHtmlPayload) {
    const cfCode =
      compact.match(/error code\s*([0-9]{3})/i)?.[1] ||
      compact.match(/\b(52[0-9])\b/)?.[1] ||
      "";
    return cfCode
      ? `Upstream data service is temporarily unavailable (Cloudflare ${cfCode}). Please retry.`
      : "Upstream data service is temporarily unavailable. Please retry.";
  }

  return compact.length > 500 ? `${compact.slice(0, 500)}...` : compact;
}

function isUpstreamUnavailableMessage(message = "") {
  const normalized = String(message || "").toLowerCase();
  return (
    normalized.includes("cloudflare 52") ||
    normalized.includes("web server is down") ||
    normalized.includes("upstream unavailable") ||
    normalized.includes("service unavailable")
  );
}

function isHistoricalBatchMode(filters = {}) {
  if (!filters || typeof filters !== "object") return false;
  if (filters.includeArchived === true) return true;
  const versionMode = String(filters.versionMode || filters.version_mode || "").trim().toLowerCase();
  return versionMode === "historical" || versionMode === "archived";
}

function logManualReportFilterDebug(routeKey, companyId, filters = {}, resolvedBatchId = "") {
  const selectedVersionId = String(
    filters.versionId || filters.datasetVersionId || filters.uploadSessionId || "",
  ).trim();
  const datasetVersion = resolveSelectedDatasetVersion(filters);
  const requestedBatchId = String(filters.batchId || "").trim();
  const fiscalYears = Array.isArray(filters.fiscalYears) ? filters.fiscalYears : [];

  console.log(
    `[ManualGL][Report][${routeKey}] company=${companyId} ` +
    `selectedVersionId=${selectedVersionId || "none"} requestedBatchId=${requestedBatchId || "none"} ` +
    `resolvedBatchId=${resolvedBatchId || "none"} datasetVersion=${datasetVersion || "none"} ` +
    `includeArchived=${filters.includeArchived === true} ` +
    `fiscalYears=[${fiscalYears.join(", ")}]`,
  );
}

function hasManualDetailFilterOverrides(filters = {}) {
  if (!filters || typeof filters !== "object") return false;
  if (Array.isArray(filters.fiscalMonths) && filters.fiscalMonths.length > 0) return true;
  if (String(filters.startDate || "").trim()) return true;
  if (String(filters.endDate || "").trim()) return true;
  // statementType is an override only when it deviates from the default (profit_loss),
  // which is what the cached snapshot is generated against.
  const statementType = String(filters.statementType || "").trim().toLowerCase();
  if (statementType && statementType !== "profit_loss" && statementType !== "pl") return true;
  const textKeys = [
    "accountName",
    "accountNumber",
    "accountType",
    "vendorName",
    "category",
    "subCategory",
    "department",
    "class",
    "location",
    "sourceFile",
    "transactionType",
    "journalType",
  ];
  return textKeys.some((key) => {
    const value = filters[key];
    if (Array.isArray(value)) return value.length > 0;
    return Boolean(String(value || "").trim());
  });
}

function hasRenderableProfitLossDetailPayload(payload) {
  if (!payload || typeof payload !== "object") return false;
  const categories = Array.isArray(payload.categories) ? payload.categories : [];
  return categories.length > 0 && categories.some((cat) => Array.isArray(cat.accounts) && cat.accounts.length > 0);
}

async function tryLoadActiveSnapshot(companyId, reportType, filters = {}) {
  try {
    const fiscalYear = resolveSelectedFiscalYear(filters);
    const datasetVersion = resolveSelectedDatasetVersion(filters);
    const requestedBatchId = String(filters.batchId || "").trim();
    const keyReportVersionId = String(filters.keyReportVersionId || "").trim();
    let snapshot = null;
    let activeBatchId = requestedBatchId || null;

    if (keyReportVersionId || datasetVersion) {
      snapshot = await getSnapshotForDatasetVersion({
        companyId,
        datasetVersion,
        keyReportVersionId,
        reportType,
        fiscalYear,
      });
      if (snapshot?.upload_batch_id) {
        activeBatchId = snapshot.upload_batch_id;
      }
    }

    if (!snapshot && requestedBatchId) {
      snapshot = await getSnapshotForBatch({
        companyId,
        batchId: requestedBatchId,
        reportType,
        fiscalYear,
      });
      if (snapshot?.upload_batch_id) {
        activeBatchId = snapshot.upload_batch_id;
      }
    }

    // Intentionally no fallback to getSnapshotForActiveBatch here.
    // That fallback caused cross-version contamination: when version N had no
    // snapshot yet, the currently-active batch's snapshot (a different version)
    // was returned.  The staged-data path below queryStagedTransactions is
    // always scoped to the resolved batchId, so it is safe to fall through.

    if (!snapshot?.snapshot_payload) {
      return { payload: null, activeBatchId };
    }

    return {
      payload: snapshot.snapshot_payload,
      activeBatchId,
    };
  } catch (error) {
    console.warn("[ManualGL][Routes] Snapshot lookup failed:", error.message);
    return { payload: null, activeBatchId: null };
  }
}

async function handleCreateUpload(req, res) {
  const clientId = resolveClientId(req);
  if (!clientId) {
    return res.status(400).json({ error: "Missing clientId." });
  }

  const {
    uploadId,
    fileName,
    fileUrl,
    status = "uploaded",
    mapping = null,
  } = req.body || {};

  if (!uploadId) {
    return res.status(400).json({ error: "uploadId is required." });
  }

  const saved = await upsertManualGlUpload({
    companyId: clientId,
    uploadId,
    fileName,
    fileUrl,
    uploadedBy: req.user?.id || null,
    status,
    mapping,
  });

  return res.status(201).json({ upload: saved });
}

async function handleSaveMapping(req, res) {
  const clientId = resolveClientId(req);
  if (!clientId) return res.status(400).json({ error: "Missing clientId." });

  const { uploadId, mapping } = req.body || {};
  if (!uploadId) return res.status(400).json({ error: "uploadId is required." });
  if (!mapping) return res.status(400).json({ error: "mapping is required." });

  const saved = await upsertManualGlUpload({
    companyId: clientId,
    uploadId,
    mapping,
  });

  return res.json({ success: true, mapping: saved.mapping });
}

async function handleProcessGl(req, res) {
  const clientId = resolveClientId(req);
  if (!clientId) return res.status(400).json({ error: "Missing clientId." });

  const { uploadId, mapping } = req.body || {};
  if (!uploadId) return res.status(400).json({ error: "uploadId is required." });

  const result = await processManualGlData({ companyId: clientId, uploadId, mapping });
  if (!result.success) {
    return res.status(400).json({
      success: false,
      errors: result.errors || [],
      requiresManualMapping: Boolean(result.requiresManualMapping),
      autoMapping: result.autoMapping || null,
      autoDetection: result.autoDetection || null,
    });
  }

  return res.json({
    success: true,
    data: result.data,
    reports: result.reports,
    autoMapping: result.autoMapping || null,
    autoDetection: result.autoDetection || null,
    warnings: result.warnings || [],
    skippedRows: result.skippedRows || 0,
  });
}

async function handleGetLatestReport(req, res, statementType) {
  const clientId = resolveClientId(req);
  if (!clientId) return res.status(400).json({ error: "Missing clientId." });

  const normalizedStatementType = statementType || resolveStatementTypeFromPath(req.path) || req.params.statementType;
  const uploadId = String(req.query.uploadId || "").trim();

  // Run both independent queries in parallel instead of sequentially.
  const [row, quickbooksRow] = await Promise.all([
    getLatestGeneratedManualGlReport({
      companyId: clientId,
      statementType: normalizedStatementType,
      uploadId,
    }),
    getLatestManualGlQuickbooksReport({
      companyId: clientId,
      statementType: normalizedStatementType,
    }),
  ]);

  if (!row) {
    return res.status(404).json({ error: "No generated manual GL report found." });
  }

  return res.json({
    success: true,
    source: "manual_gl",
    statementType: normalizedStatementType,
    uploadId: row.report_params?.uploadId || null,
    generatedAt: row.updated_at || null,
    data: row.data?.manual_gl_report?.report || null,
    quickbooksSchema: quickbooksRow?.data || null,
  });
}

router.get("/manual-gl/uploads", enforceDataSource(REPORT_SOURCE_KEYS.MANUAL_GL), async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) {
      return res.status(400).json({ error: "Missing clientId." });
    }

    const uploads = await listManualGlUploads(clientId);
    return res.json({ uploads });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Failed to load manual GL uploads." });
  }
});

router.post("/manual-gl/uploads", enforceDataSource(REPORT_SOURCE_KEYS.MANUAL_GL), async (req, res) => {
  try {
    return await handleCreateUpload(req, res);
  } catch (error) {
    return res.status(500).json({ error: error.message || "Failed to save manual GL upload." });
  }
});

router.post("/manual-gl/upload", enforceDataSource(REPORT_SOURCE_KEYS.MANUAL_GL), async (req, res, next) => {
  try {
    return await uploadController(req, res);
  } catch (error) {
    return next(error);
  }
});

router.post("/manual-gl/continue", enforceDataSource(REPORT_SOURCE_KEYS.MANUAL_GL), async (req, res, next) => {
  try {
    return await continueController(req, res);
  } catch (error) {
    return next(error);
  }
});

router.post("/upload-gl", enforceDataSource(REPORT_SOURCE_KEYS.MANUAL_GL), async (req, res) => {
  try {
    return await handleCreateUpload(req, res);
  } catch (error) {
    return res.status(500).json({ error: error.message || "Failed to save manual GL upload." });
  }
});

router.post("/manual-gl/reports/generate", enforceDataSource(REPORT_SOURCE_KEYS.MANUAL_GL), async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(400).json({ error: "Missing clientId." });

    const { uploadId, mapping = {} } = req.body || {};
    if (!uploadId) return res.status(400).json({ error: "uploadId is required." });

    const result = await generateManualGlReports({
      companyId: clientId,
      uploadId,
      mapping,
    });
    return res.json({ success: true, ...result });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || "Failed to generate reports." });
  }
});

router.get("/manual-gl/reports/:statementType/latest", enforceDataSource(REPORT_SOURCE_KEYS.MANUAL_GL), async (req, res) => {
  try {
    return await handleGetLatestReport(req, res, req.params.statementType);
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || "Failed to fetch report." });
  }
});

router.get("/reports/pl", enforceDataSource(REPORT_SOURCE_KEYS.MANUAL_GL), async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(400).json({ success: false, error: "Missing clientId." });

    const filters = parseManualFilterQuery(req.query || {});
    const activeBatchId = await resolveEffectiveReportBatchId(clientId, filters);
    const cacheFilters = { ...filters, batchId: activeBatchId || filters.batchId || "" };
    logManualReportFilterDebug("reports/pl", clientId, cacheFilters, activeBatchId);

    const cached = reportCache.get("pl", clientId, cacheFilters);
    if (cached) return res.json({ success: true, ...cached, source: cached.source || "MANUAL_STAGED" });

    const snapshotResult = await tryLoadActiveSnapshot(
      clientId,
      SNAPSHOT_REPORT_TYPES.PROFIT_LOSS_SUMMARY,
      cacheFilters,
    );

    const plHierarchicalRows = snapshotResult.payload?.hierarchicalRows;
    if (snapshotResult.payload && Array.isArray(plHierarchicalRows) && plHierarchicalRows.length > 0) {
      const payload = {
        ...snapshotResult.payload,
        source: "manual_gl_reporting_snapshot",
        activeBatchId: snapshotResult.activeBatchId || activeBatchId || null,
      };
      reportCache.set("pl", clientId, cacheFilters, payload);
      return res.json({ success: true, ...payload });
    }

    const stagedPayload = await getProfitLossSummaryFromStage(clientId, cacheFilters);
    const payload = {
      ...stagedPayload,
      source: stagedPayload.source || "MANUAL_STAGED",
      activeBatchId: activeBatchId || null,
    };
    reportCache.set("pl", clientId, cacheFilters, payload);
    return res.json({ success: true, ...payload });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || "Failed to fetch P&L report." });
  }
});

router.get("/reports/balance-sheet", enforceDataSource(REPORT_SOURCE_KEYS.MANUAL_GL), async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(400).json({ success: false, error: "Missing clientId." });

    const filters = parseManualFilterQuery(req.query || {});
    const activeBatchId = await resolveEffectiveReportBatchId(clientId, filters);
    const cacheFilters = { ...filters, batchId: activeBatchId || filters.batchId || "" };
    logManualReportFilterDebug("reports/balance-sheet", clientId, cacheFilters, activeBatchId);

    const cached = reportCache.get("bs", clientId, cacheFilters);
    if (cached) return res.json({ success: true, ...cached, source: cached.source || "MANUAL_STAGED" });

    const snapshotResult = await tryLoadActiveSnapshot(
      clientId,
      SNAPSHOT_REPORT_TYPES.BALANCE_SHEET_SUMMARY,
      cacheFilters,
    );

    const bsHierarchicalRows = snapshotResult.payload?.hierarchicalRows;
    if (snapshotResult.payload && Array.isArray(bsHierarchicalRows) && bsHierarchicalRows.length > 0) {
      const payload = {
        ...snapshotResult.payload,
        source: "manual_gl_reporting_snapshot",
        activeBatchId: snapshotResult.activeBatchId || activeBatchId || null,
      };
      reportCache.set("bs", clientId, cacheFilters, payload);
      return res.json({ success: true, ...payload });
    }

    const stagedPayload = await getBalanceSheetSummaryFromStage(clientId, cacheFilters);
    const payload = {
      ...stagedPayload,
      source: stagedPayload.source || "MANUAL_STAGED",
      activeBatchId: activeBatchId || null,
    };

    reportCache.set("bs", clientId, cacheFilters, payload);
    return res.json({ success: true, ...payload });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || "Failed to fetch Balance Sheet report." });
  }
});

router.get("/reports/cashflow", enforceDataSource(REPORT_SOURCE_KEYS.MANUAL_GL), async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(400).json({ success: false, error: "Missing clientId." });

    const filters = parseManualFilterQuery(req.query || {});
    const activeBatchId = await resolveEffectiveReportBatchId(clientId, filters);
    const cacheFilters = { ...filters, batchId: activeBatchId || filters.batchId || "" };
    logManualReportFilterDebug("reports/cashflow", clientId, cacheFilters, activeBatchId);

    const cached = reportCache.get("cf", clientId, cacheFilters);
    if (cached) return res.json({ success: true, ...cached, source: cached.source || "MANUAL_STAGED" });

    const snapshotResult = await tryLoadActiveSnapshot(
      clientId,
      SNAPSHOT_REPORT_TYPES.CASHFLOW_SUMMARY,
      cacheFilters,
    );

    const cfHierarchicalRows = snapshotResult.payload?.hierarchicalRows;
    if (snapshotResult.payload && Array.isArray(cfHierarchicalRows) && cfHierarchicalRows.length > 0) {
      const payload = {
        ...snapshotResult.payload,
        source: "manual_gl_reporting_snapshot",
        activeBatchId: snapshotResult.activeBatchId || activeBatchId || null,
      };
      reportCache.set("cf", clientId, cacheFilters, payload);
      return res.json({ success: true, ...payload });
    }

    const stagedPayload = await getCashflowSummaryFromStage(clientId, cacheFilters);
    const payload = {
      ...stagedPayload,
      source: stagedPayload.source || "MANUAL_STAGED",
      activeBatchId: activeBatchId || null,
    };
    reportCache.set("cf", clientId, cacheFilters, payload);
    return res.json({ success: true, ...payload });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || "Failed to fetch Cash Flow report." });
  }
});

router.get("/reports/cashflow/monthly-detail", enforceDataSource(REPORT_SOURCE_KEYS.MANUAL_GL), async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(400).json({ success: false, error: "Missing clientId." });

    const filters = parseManualFilterQuery(req.query || {});
    const activeBatchId = await resolveEffectiveReportBatchId(clientId, filters);
    const cacheFilters = { ...filters, batchId: activeBatchId || filters.batchId || "" };
    logManualReportFilterDebug("reports/cashflow/monthly-detail", clientId, cacheFilters, activeBatchId);
    const hasMonthFilter = Array.isArray(cacheFilters.fiscalMonths) && cacheFilters.fiscalMonths.length > 0;

    const cached = reportCache.get("cf_monthly", clientId, cacheFilters);
    if (cached) return res.json({ success: true, ...cached });

    if (!hasMonthFilter) {
      const snapshotResult = await tryLoadActiveSnapshot(
        clientId,
        SNAPSHOT_REPORT_TYPES.CASHFLOW_MONTHLY_DETAIL,
        cacheFilters,
      );

      const snapshotSections = snapshotResult.payload?.sections;
      if (snapshotResult.payload && Array.isArray(snapshotSections) && snapshotSections.length > 0) {
        const payload = {
          ...snapshotResult.payload,
          source: "manual_gl_reporting_snapshot",
          activeBatchId: snapshotResult.activeBatchId || activeBatchId || null,
        };
        reportCache.set("cf_monthly", clientId, cacheFilters, payload);
        return res.json({ success: true, ...payload });
      }
    }

    const payload = await getCashflowMonthlyDetailFromStage(clientId, cacheFilters);
    reportCache.set("cf_monthly", clientId, cacheFilters, payload);
    return res.json({ success: true, ...payload });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || "Failed to fetch Cash Flow monthly detail." });
  }
});
router.get("/manual-gl/columns/:uploadId", enforceDataSource(REPORT_SOURCE_KEYS.MANUAL_GL), async (req, res) => {
  try {
    const { uploadId } = req.params;
    if (!uploadId) return res.status(400).json({ error: "uploadId is required." });

    const result = await getManualGlColumns(uploadId);
    return res.json({ success: true, ...result });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || "Failed to get columns." });
  }
});

router.post("/manual-gl/save-mapping", enforceDataSource(REPORT_SOURCE_KEYS.MANUAL_GL), async (req, res) => {
  try {
    return await handleSaveMapping(req, res);
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || "Failed to save mapping." });
  }
});

router.post("/save-mapping", enforceDataSource(REPORT_SOURCE_KEYS.MANUAL_GL), async (req, res) => {
  try {
    return await handleSaveMapping(req, res);
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || "Failed to save mapping." });
  }
});

router.post("/manual-gl/process-gl", enforceDataSource(REPORT_SOURCE_KEYS.MANUAL_GL), async (req, res) => {
  try {
    return await handleProcessGl(req, res);
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || "Failed to process GL." });
  }
});

router.post("/process-gl", enforceDataSource(REPORT_SOURCE_KEYS.MANUAL_GL), async (req, res) => {
  try {
    return await handleProcessGl(req, res);
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || "Failed to process GL." });
  }
});

router.post("/manual-gl/staging/multi-year", enforceDataSource(REPORT_SOURCE_KEYS.MANUAL_GL), async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(400).json({ success: false, error: "Missing clientId." });

    const {
      glUploadIds = [],
      startingBalanceSheetUploadId = "",
      endingBalanceSheetUploadId = "",
      mapping = {},
      fiscalYearStartMonth = null,
      fiscalYearStartDay = null,
      batchName = "",
    } = req.body || {};

    if (!Array.isArray(glUploadIds) || !glUploadIds.length) {
      return res.status(400).json({ success: false, error: "At least one GL upload ID is required." });
    }

    const job = await createUploadJob(
      clientId,
      batchName || "Multi-Year Upload",
      req.user?.id || null,
    );

    // Transition to STAGING immediately — no worker queue needed
    await updateUploadJob(job.id, {
      status: UPLOAD_JOB_STATUS.STAGING,
      progress: { stage: "orchestrating", pct: 5 },
    });

    // Return 202 right away so the frontend can begin polling
    res.status(202).json({
      success: true,
      message: "Upload job queued. Poll /manual-gl/upload-jobs/:id for progress.",
      jobId: job.id,
      versionId: null,
    });

    // Orchestrate after the response is sent — snapshot failures are isolated
    setImmediate(async () => {
      const perfStart = Date.now();
      try {
        const result = await orchestrateManualGlUpload({
          companyId: clientId,
          glUploadIds,
          startingBalanceSheetUploadId,
          endingBalanceSheetUploadId,
          mapping,
          fiscalYearStartMonth,
          fiscalYearStartDay,
          uploadedBy: req.user?.id || null,
          batchName,
          uploadJobId: job.id,
        });

        const duration = Date.now() - perfStart;

        if (result?.success !== false) {
          const completionSummary = {
            batchId: result?.activeBatchId || result?.batchId || null,
            activeBatchId: result?.activeBatchId || result?.batchId || null,
            datasetVersionId: result?.datasetVersionId || null,
            versionNumber: result?.versionNumber || result?.activeDatasetVersion || null,
            activeDatasetVersion: result?.activeDatasetVersion || result?.versionNumber || null,
            alreadyStaged: Boolean(result?.alreadyStaged),
            reportsReady: result?.reportsReady !== false,
            insertedTransactions: result?.insertedTransactions || 0,
            duplicateTransactionsSkipped: result?.duplicateTransactionsSkipped || 0,
            warnings: result?.warnings || [],
            filesParsed: result?.filesParsed || [],
            yearsDetected: result?.yearsDetected || result?.snapshotYears || [],
            noChangesDetected: Boolean(result?.noChangesDetected),
            snapshotsGenerated: result?.snapshotsGenerated || 0,
            validation: result?.validation || null,
            fiscalYears: Array.isArray(result?.fiscalYears) ? result.fiscalYears : result?.snapshotYears || [],
            existingVersion: result?.existingVersion || null,
            durationMs: duration,
          };

          if (result?.alreadyStaged) {
            await updateUploadJob(job.id, {
              status: UPLOAD_JOB_STATUS.COMPLETED,
              progress: { stage: "completed", pct: 100 },
              metadata: { completionSummary },
            });
            console.log(
              `[ManualGL][DirectExec][${job.id}] Reused existing dataset version V${completionSummary.versionNumber || "?"} ` +
              `in ${duration}ms. batchId=${completionSummary.batchId}`,
            );
          } else {
            await updateUploadJob(job.id, { metadata: { completionSummary } });
            await finalizeUploadLifecycle(job.id, result?.datasetVersionId || null, clientId, completionSummary.batchId);
            console.log(`[ManualGL][DirectExec][${job.id}] Completed in ${duration}ms. batchId=${completionSummary.batchId}`);

            // Fire-and-forget: snapshot failures must not fail the upload lifecycle
            if (completionSummary.batchId && clientId) {
              setImmediate(() => {
                generateReportingSnapshotsForBatch(clientId, completionSummary.batchId, { datasetVersionId: result?.datasetVersionId || null })
                  .then(r => {
                    console.log(`[ManualGL][DirectExec][${job.id}] Snapshots done: count=${r.snapshotCount} years=[${r.years.join(",")}]`);
                  })
                  .catch(err => {
                    console.warn(`[ManualGL][DirectExec][${job.id}] Snapshot generation failed (non-fatal):`, err.message);
                  });
              });
            }
          }
        } else {
          await failUploadLifecycle(job.id, result?.datasetVersionId || null, result?.message || "Orchestration returned failure.");
          console.warn(`[ManualGL][DirectExec][${job.id}] Orchestration failed after ${duration}ms: ${result?.message}`);
        }
      } catch (err) {
        const duration = Date.now() - perfStart;
        console.error(`[ManualGL][DirectExec][${job.id}] Critical error after ${duration}ms:`, err.message);
        await failUploadLifecycle(job.id, null, err.message).catch(() => { });
      }
    });
  } catch (error) {
    const message = normalizeApiErrorMessage(error, "Failed to stage multi-year GL data.");
    const isProcessingConflict = String(message).toLowerCase().includes("currently processing");
    const isUpstreamUnavailable = isUpstreamUnavailableMessage(message);
    const statusCode = isProcessingConflict ? 409 : isUpstreamUnavailable ? 503 : 500;
    return res.status(statusCode).json({
      success: false,
      error: message,
    });
  }
});

router.get("/manual-gl/staging/transactions", enforceDataSource(REPORT_SOURCE_KEYS.MANUAL_GL), async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(400).json({ success: false, error: "Missing clientId." });
    const filters = parseManualFilterQuery(req.query || {});
    const payload = await getStageTransactions(clientId, filters);
    return res.json({ success: true, ...payload });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || "Failed to fetch staged transactions.",
    });
  }
});

router.get("/manual-gl/staging/filter-options", enforceDataSource(REPORT_SOURCE_KEYS.MANUAL_GL), async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(400).json({ success: false, error: "Missing clientId." });
    const filters = parseManualFilterQuery(req.query || {});
    const payload = await getStageFilterOptions(clientId, filters);
    return res.json({ success: true, ...payload });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || "Failed to fetch staging filter options.",
    });
  }
});

router.get("/manual-gl/staging/fiscal-years", enforceDataSource(REPORT_SOURCE_KEYS.MANUAL_GL), async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(400).json({ success: false, error: "Missing clientId." });
    const batchId = String(req.query.batchId || "").trim();
    if (!batchId) return res.status(400).json({ success: false, error: "Missing batchId." });
    const fiscalCalendarExplicit = req.query.fiscalCalendarExplicit === "true";
    const fiscalYears = await getActualFiscalYearsFromDB(clientId, batchId, fiscalCalendarExplicit);
    return res.json({ success: true, fiscalYears });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || "Failed to fetch fiscal years." });
  }
});

router.get("/manual-gl/staging/batches", enforceDataSource(REPORT_SOURCE_KEYS.MANUAL_GL), async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(400).json({ success: false, error: "Missing clientId." });
    const batches = await listManualGlBatches(clientId);
    return res.json({ success: true, batches });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || "Failed to list manual GL batches.",
    });
  }
});

router.post("/manual-gl/staging/batches/:batchId/activate", enforceDataSource(REPORT_SOURCE_KEYS.MANUAL_GL), async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(400).json({ success: false, error: "Missing clientId." });

    const batchId = String(req.params.batchId || "").trim();
    if (!batchId) {
      return res.status(400).json({ success: false, error: "batchId is required." });
    }

    const activated = await activateUploadBatch(clientId, batchId, req.user?.id || null);
    const activeBatch = activated || (await getActiveUploadBatch(clientId));

    reportCache.invalidateCompany(clientId);

    return res.json({
      success: true,
      activeBatchId: activeBatch?.id || batchId,
      batch: activeBatch || null,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || "Failed to activate manual GL batch.",
    });
  }
});

router.get("/reports/profit-loss", enforceDataSource(REPORT_SOURCE_KEYS.MANUAL_GL), async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(400).json({ success: false, error: "Missing clientId." });
    const filters = parseManualFilterQuery(req.query || {});
    const activeBatchId = await resolveEffectiveReportBatchId(clientId, filters);
    const cacheFilters = { ...filters, batchId: activeBatchId || filters.batchId || "" };
    logManualReportFilterDebug("reports/profit-loss", clientId, cacheFilters, activeBatchId);

    const cached = reportCache.get("pl", clientId, cacheFilters);
    if (cached) return res.json({ success: true, ...cached, source: cached.source || "MANUAL_STAGED" });

    const snapshotResult = await tryLoadActiveSnapshot(
      clientId,
      SNAPSHOT_REPORT_TYPES.PROFIT_LOSS_SUMMARY,
      cacheFilters,
    );

    const pl2HierarchicalRows = snapshotResult.payload?.hierarchicalRows;
    if (snapshotResult.payload && Array.isArray(pl2HierarchicalRows) && pl2HierarchicalRows.length > 0) {
      const payload = {
        ...snapshotResult.payload,
        source: "manual_gl_reporting_snapshot",
        activeBatchId: snapshotResult.activeBatchId || activeBatchId || null,
      };
      reportCache.set("pl", clientId, cacheFilters, payload);
      return res.json({ success: true, ...payload });
    }

    const payload = await getProfitLossSummaryFromStage(clientId, cacheFilters);
    reportCache.set("pl", clientId, cacheFilters, payload);
    return res.json({ success: true, ...payload, source: payload.source || "MANUAL_STAGED", activeBatchId: activeBatchId || null });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || "Failed to build staged Profit & Loss summary.",
    });
  }
});

router.get("/reports/profit-loss/detail", enforceDataSource(REPORT_SOURCE_KEYS.MANUAL_GL), async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(400).json({ success: false, error: "Missing clientId." });
    const filters = parseManualFilterQuery(req.query || {});
    const activeBatchId = await resolveEffectiveReportBatchId(clientId, filters);
    const cacheFilters = { ...filters, batchId: activeBatchId || filters.batchId || "" };
    logManualReportFilterDebug("reports/profit-loss/detail", clientId, cacheFilters, activeBatchId);
    const skipSnapshot = hasManualDetailFilterOverrides(cacheFilters);

    if (!skipSnapshot) {
      const snapshotResult = await tryLoadActiveSnapshot(
        clientId,
        SNAPSHOT_REPORT_TYPES.PROFIT_LOSS_DETAIL,
        cacheFilters,
      );
      if (snapshotResult.payload && hasRenderableProfitLossDetailPayload(snapshotResult.payload)) {
        return res.json({
          success: true,
          ...snapshotResult.payload,
          source: "manual_gl_reporting_snapshot",
          activeBatchId: snapshotResult.activeBatchId || activeBatchId || null,
        });
      }
    }

    const payload = await getProfitLossDetailFromStage(clientId, cacheFilters);
    return res.json({ success: true, ...payload, activeBatchId: activeBatchId || null });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || "Failed to build staged Profit & Loss detail.",
    });
  }
});

router.get("/reports/profit-loss/detail-vendor", enforceDataSource(REPORT_SOURCE_KEYS.MANUAL_GL), async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(400).json({ success: false, error: "Missing clientId." });
    const filters = parseManualFilterQuery(req.query || {});
    const activeBatchId = await resolveEffectiveReportBatchId(clientId, filters);
    const cacheFilters = { ...filters, batchId: activeBatchId || filters.batchId || "" };
    logManualReportFilterDebug("reports/profit-loss/detail-vendor", clientId, cacheFilters, activeBatchId);
    const skipSnapshot = hasManualDetailFilterOverrides(cacheFilters);

    if (!skipSnapshot) {
      const snapshotResult = await tryLoadActiveSnapshot(
        clientId,
        SNAPSHOT_REPORT_TYPES.PROFIT_LOSS_DETAIL_VENDOR,
        cacheFilters,
      );
      if (snapshotResult.payload) {
        return res.json({
          success: true,
          ...snapshotResult.payload,
          source: "manual_gl_reporting_snapshot",
          activeBatchId: snapshotResult.activeBatchId || activeBatchId || null,
        });
      }
    }

    const payload = await getProfitLossVendorDetailFromStage(clientId, cacheFilters);
    return res.json({ success: true, ...payload, activeBatchId: activeBatchId || null });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || "Failed to build staged Profit & Loss vendor detail.",
    });
  }
});

// Vendor Analysis: Account -> Vendor -> Account Total, with dynamic fiscal-year columns.
router.get("/reports/vendor-analysis", enforceDataSource(REPORT_SOURCE_KEYS.MANUAL_GL), async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(400).json({ success: false, error: "Missing clientId." });
    const filters = parseManualFilterQuery(req.query || {});
    const activeBatchId = await resolveReportBatchId(clientId, filters.batchId, {
      ...filters,
      allowExplicitBatch: isHistoricalBatchMode(filters),
    });
    const cacheFilters = { ...filters, batchId: activeBatchId || filters.batchId || "" };
    logManualReportFilterDebug("reports/vendor-analysis", clientId, cacheFilters, activeBatchId);
    const skipSnapshot = hasManualDetailFilterOverrides(cacheFilters);

    if (!skipSnapshot) {
      const snapshotResult = await tryLoadActiveSnapshot(
        clientId,
        SNAPSHOT_REPORT_TYPES.VENDOR_ANALYSIS,
        cacheFilters,
      );
      if (snapshotResult.payload) {
        return res.json({
          success: true,
          ...snapshotResult.payload,
          source: "manual_gl_reporting_snapshot",
          activeBatchId: snapshotResult.activeBatchId || activeBatchId || null,
        });
      }
    }

    const payload = await getVendorAnalysisFromStage(clientId, cacheFilters);
    return res.json({ success: true, ...payload, activeBatchId: activeBatchId || null });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || "Failed to build staged Vendor Analysis report.",
    });
  }
});

router.get("/reports/profit-loss/monthly-detail", enforceDataSource(REPORT_SOURCE_KEYS.MANUAL_GL), async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(400).json({ success: false, error: "Missing clientId." });
    const filters = parseManualFilterQuery(req.query || {});
    const activeBatchId = await resolveReportBatchId(clientId, filters.batchId, {
      ...filters,
      allowExplicitBatch: isHistoricalBatchMode(filters),
    });
    console.log(`[ManualGL][Report] Resolved batchId ${activeBatchId} for filters:`, JSON.stringify(filters));
    const cacheFilters = { ...filters, batchId: activeBatchId || filters.batchId || "" };
    logManualReportFilterDebug("reports/profit-loss/monthly-detail", clientId, cacheFilters, activeBatchId);
    const hasMonthFilter = Array.isArray(cacheFilters.fiscalMonths) && cacheFilters.fiscalMonths.length > 0;

    const cached = reportCache.get("pl_monthly_detail", clientId, cacheFilters);
    if (cached) return res.json({ success: true, ...cached });

    if (!hasMonthFilter) {
      const snapshotResult = await tryLoadActiveSnapshot(
        clientId,
        SNAPSHOT_REPORT_TYPES.PROFIT_LOSS_MONTHLY_DETAIL,
        cacheFilters,
      );
      const snapshotSections = snapshotResult.payload?.sections;
      const snapshotHasAccounts = Array.isArray(snapshotSections) &&
        snapshotSections.some((s) => !s.isCalculated && Array.isArray(s.accounts) && s.accounts.length > 0);
      if (snapshotResult.payload && snapshotHasAccounts) {
        const payload = {
          ...snapshotResult.payload,
          source: "manual_gl_reporting_snapshot",
          activeBatchId: snapshotResult.activeBatchId || activeBatchId || null,
        };
        reportCache.set("pl_monthly_detail", clientId, cacheFilters, payload);
        return res.json({ success: true, ...payload });
      }
    }

    const payload = await getProfitLossMonthlyDetailFromStage(clientId, cacheFilters);
    reportCache.set("pl_monthly_detail", clientId, cacheFilters, payload);
    return res.json({ success: true, ...payload, activeBatchId: activeBatchId || null });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || "Failed to build staged Profit & Loss monthly detail.",
    });
  }
});

router.get("/reports/balance-sheet/monthly-detail", enforceDataSource(REPORT_SOURCE_KEYS.MANUAL_GL), async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(400).json({ success: false, error: "Missing clientId." });
    const filters = parseManualFilterQuery(req.query || {});
    const activeBatchId = await resolveReportBatchId(clientId, filters.batchId, {
      ...filters,
      allowExplicitBatch: isHistoricalBatchMode(filters),
    });
    console.log(`[ManualGL][Report] Resolved batchId ${activeBatchId} for filters:`, JSON.stringify(filters));
    const cacheFilters = { ...filters, batchId: activeBatchId || filters.batchId || "" };
    logManualReportFilterDebug("reports/balance-sheet/monthly-detail", clientId, cacheFilters, activeBatchId);
    const hasMonthFilter = Array.isArray(cacheFilters.fiscalMonths) && cacheFilters.fiscalMonths.length > 0;

    const cached = reportCache.get("bs_monthly", clientId, cacheFilters);
    if (cached) return res.json({ success: true, ...cached });

    if (!hasMonthFilter) {
      const snapshotResult = await tryLoadActiveSnapshot(
        clientId,
        SNAPSHOT_REPORT_TYPES.BALANCE_SHEET_MONTHLY_DETAIL,
        cacheFilters,
      );
      const snapshotSections = snapshotResult.payload?.sections;
      if (snapshotResult.payload && Array.isArray(snapshotSections) && snapshotSections.length > 0) {
        const payload = {
          ...snapshotResult.payload,
          source: "manual_gl_reporting_snapshot",
          activeBatchId: snapshotResult.activeBatchId || activeBatchId || null,
        };
        reportCache.set("bs_monthly", clientId, cacheFilters, payload);
        return res.json({ success: true, ...payload });
      }
    }

    const payload = await getBalanceSheetMonthlyDetailFromStage(clientId, cacheFilters);
    reportCache.set("bs_monthly", clientId, cacheFilters, payload);
    return res.json({ success: true, ...payload, activeBatchId: activeBatchId || null });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || "Failed to build staged Balance Sheet monthly detail.",
    });
  }
});
router.get("/reports/profit-loss/monthly", enforceDataSource(REPORT_SOURCE_KEYS.MANUAL_GL), async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(400).json({ success: false, error: "Missing clientId." });
    const filters = parseManualFilterQuery(req.query || {});
    const activeBatchId = await resolveReportBatchId(clientId, filters.batchId, {
      ...filters,
      allowExplicitBatch: isHistoricalBatchMode(filters),
    });
    console.log(`[ManualGL][Report] Resolved batchId ${activeBatchId} for filters:`, JSON.stringify(filters));
    const cacheFilters = { ...filters, batchId: activeBatchId || filters.batchId || "" };
    logManualReportFilterDebug("reports/profit-loss/monthly", clientId, cacheFilters, activeBatchId);
    const cached = reportCache.get("pl", clientId, cacheFilters);
    const payload = cached || await getProfitLossSummaryFromStage(clientId, cacheFilters);
    if (!cached) reportCache.set("pl", clientId, cacheFilters, payload);
    return res.json({
      success: true,
      source: payload.source,
      reportType: "profit_loss_monthly",
      filters: payload.filters,
      monthlyBreakdown: payload.monthlyBreakdown || [],
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || "Failed to build monthly Profit & Loss breakdown.",
    });
  }
});

router.get("/reports/profit-loss/year-comparison", enforceDataSource(REPORT_SOURCE_KEYS.MANUAL_GL), async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(400).json({ success: false, error: "Missing clientId." });
    const filters = parseManualFilterQuery(req.query || {});
    const activeBatchId = await resolveReportBatchId(clientId, filters.batchId, {
      ...filters,
      allowExplicitBatch: isHistoricalBatchMode(filters),
    });
    console.log(`[ManualGL][Report] Resolved batchId ${activeBatchId} for filters:`, JSON.stringify(filters));
    const cacheFilters = { ...filters, batchId: activeBatchId || filters.batchId || "" };
    logManualReportFilterDebug("reports/profit-loss/year-comparison", clientId, cacheFilters, activeBatchId);
    const cached = reportCache.get("pl", clientId, cacheFilters);
    const payload = cached || await getProfitLossSummaryFromStage(clientId, cacheFilters);
    if (!cached) reportCache.set("pl", clientId, cacheFilters, payload);
    return res.json({
      success: true,
      source: payload.source,
      reportType: "profit_loss_year_comparison",
      filters: payload.filters,
      yearComparison: payload.yearComparison || [],
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || "Failed to build yearly Profit & Loss comparison.",
    });
  }
});

router.get("/manual-gl/validation/balance-sheet", enforceDataSource(REPORT_SOURCE_KEYS.MANUAL_GL), async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(400).json({ success: false, error: "Missing clientId." });
    const batchId = String(req.query.batchId || req.query.batch_id || "").trim();
    const datasetVersion = String(req.query.datasetVersion || req.query.dataset_version || "").trim();
    const versionId = String(req.query.versionId || req.query.uploadSessionId || "").trim();
    // Pass version filters so validation stays scoped to the SELECTED version and
    // never falls back to another version's active/latest batch.
    const payload = await validateBatchBalanceSheet(clientId, { batchId, datasetVersion, versionId });
    return res.json({ success: true, ...payload });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || "Failed to validate balance sheet rollforward.",
    });
  }
});

// === Dataset Versions & Upload Jobs (Snapshot / Dataset Version API) ===

router.get("/manual-gl/dataset-versions", enforceDataSource(REPORT_SOURCE_KEYS.MANUAL_GL), async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(400).json({ success: false, error: "Missing clientId." });

    const requestedLimit = Math.min(Math.max(Number(req.query.limit || 200) || 200, 1), 500);
    const datasetVersions = await listDatasetVersions(clientId, requestedLimit, {
      sourceType: "manual_gl_upload",
      statuses: ["finalized", "completed"],
    });

    const versions = datasetVersions
      .map((datasetVersion) => {
        const versionNumber = Number(datasetVersion?.version_number || 0);
        if (!Number.isInteger(versionNumber) || versionNumber <= 0) {
          return null;
        }

        const status = String(datasetVersion?.status || "").toLowerCase();
        const reportsReady = status === "finalized" || status === "completed";

        return {
          value: versionNumber,
          label: `Version ${versionNumber}`,
          dataset_version: versionNumber,
          version_number: versionNumber,
          versionNumber,
          id: String(versionNumber),
          datasetVersionId: datasetVersion?.id || null,
          batchId: datasetVersion?.batch_id || null,
          status: datasetVersion?.status || null,
          sourceType: datasetVersion?.source_type || null,
          fiscalYears: Array.isArray(datasetVersion?.fiscal_years) ? datasetVersion.fiscal_years : [],
          datasetHash: datasetVersion?.dataset_hash || datasetVersion?.content_hash || null,
          reportsReady,
          isActive: Boolean(datasetVersion?.is_active),
          is_active: Boolean(datasetVersion?.is_active),
          createdAt: datasetVersion?.created_at || null,
        };
      })
      .filter(Boolean);

    console.log(
      `[ManualGL][Versions][API][Response] company=${clientId} count=${versions.length}`,
    );
    return res.json({ success: true, versions });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

router.post("/manual-gl/dataset-versions/:id/activate", enforceDataSource(REPORT_SOURCE_KEYS.MANUAL_GL), async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(400).json({ success: false, error: "Missing clientId." });

    const versionId = req.params.id;
    let targetBatch = await getUploadBatchById(clientId, versionId);
    if (!targetBatch?.id) {
      const { data: sessionRow, error: sessionError } = await supabase
        .from("manual_gl_upload_sessions")
        .select("staging_batch_id")
        .eq("company_id", clientId)
        .eq("id", versionId)
        .maybeSingle();

      if (sessionError && sessionError.code !== "PGRST116") {
        throw new Error(`Failed to resolve version session: ${sessionError.message}`);
      }

      if (sessionRow?.staging_batch_id) {
        targetBatch = await getUploadBatchById(clientId, sessionRow.staging_batch_id);
      }
    }

    if (targetBatch?.id) {
      const activatedBatch = await activateUploadBatch(clientId, targetBatch.id, req.user?.id || null);
      if (typeof reportCache.invalidateCompany === "function") {
        reportCache.invalidateCompany(clientId);
      }

      return res.json({
        success: true,
        version: activatedBatch || targetBatch,
        activeBatchId: activatedBatch?.id || targetBatch.id,
      });
    }

    const activated = await activateDatasetVersion(clientId, versionId);

    // Invalidate report cache since the active dataset changed!
    if (typeof reportCache.invalidateCompany === "function") {
      reportCache.invalidateCompany(clientId);
    }

    return res.json({ success: true, version: activated });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

router.post("/manual-gl/dataset-versions/:id/rollback", enforceDataSource(REPORT_SOURCE_KEYS.MANUAL_GL), async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(400).json({ success: false, error: "Missing clientId." });

    const versionId = req.params.id;
    let targetBatch = await getUploadBatchById(clientId, versionId);
    if (!targetBatch?.id) {
      const { data: sessionRow, error: sessionError } = await supabase
        .from("manual_gl_upload_sessions")
        .select("staging_batch_id")
        .eq("company_id", clientId)
        .eq("id", versionId)
        .maybeSingle();

      if (sessionError && sessionError.code !== "PGRST116") {
        throw new Error(`Failed to resolve rollback session: ${sessionError.message}`);
      }

      if (sessionRow?.staging_batch_id) {
        targetBatch = await getUploadBatchById(clientId, sessionRow.staging_batch_id);
      }
    }

    if (targetBatch?.id) {
      const activatedBatch = await activateUploadBatch(clientId, targetBatch.id, req.user?.id || null);
      if (typeof reportCache.invalidateCompany === "function") {
        reportCache.invalidateCompany(clientId);
      }

      return res.json({
        success: true,
        version: activatedBatch || targetBatch,
        activeBatchId: activatedBatch?.id || targetBatch.id,
      });
    }

    const activated = await rollbackToVersion(clientId, versionId);

    // Invalidate report cache since the active dataset changed!
    if (typeof reportCache.invalidateCompany === "function") {
      reportCache.invalidateCompany(clientId);
    }

    return res.json({ success: true, version: activated });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

router.get("/manual-gl/upload-jobs", enforceDataSource(REPORT_SOURCE_KEYS.MANUAL_GL), async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(400).json({ success: false, error: "Missing clientId." });

    const jobs = await listUploadJobs(clientId, 20);
    return res.json({ success: true, jobs });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

router.get("/manual-gl/upload-jobs/:id", enforceDataSource(REPORT_SOURCE_KEYS.MANUAL_GL), async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(400).json({ success: false, error: "Missing clientId." });

    const jobId = req.params.id;
    const job = await getUploadJob(jobId);

    if (!job || job.company_id !== clientId) {
      return res.status(404).json({ success: false, error: "Upload job not found." });
    }
    return res.json({ success: true, job });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;

