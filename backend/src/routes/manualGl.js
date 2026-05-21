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
  stageMultiYearGlUpload,
  getStageTransactions,
  getStageFilterOptions,
  getProfitLossSummaryFromStage,
  getProfitLossDetailFromStage,
  getProfitLossMonthlyDetailFromStage,
  getBalanceSheetSummaryFromStage,
  getBalanceSheetMonthlyDetailFromStage,
  getCashflowSummaryFromStage,
  getCashflowMonthlyDetailFromStage,
  validateBatchBalanceSheet,
  listManualGlBatches,
} = require("../services/manualGlMultiYearService");
const { uploadController } = require("../controllers/manualGl/uploadController");
const { continueController } = require("../controllers/manualGl/continueController");
const {
  listUploadJobs,
  getUploadJob,
  listDatasetVersions,
  activateDatasetVersion,
  rollbackToVersion,
} = require("../services/datasetVersionService");
const reportCache = require("../services/reportCache");

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
    const cached = reportCache.get("pl", clientId, filters);
    if (cached) return res.json({ success: true, ...cached, source: "MANUAL_STAGED" });

    const stagedPayload = await getProfitLossSummaryFromStage(clientId, filters);
    reportCache.set("pl", clientId, filters, stagedPayload);
    return res.json({ success: true, ...stagedPayload, source: "MANUAL_STAGED" });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || "Failed to fetch P&L report." });
  }
});

router.get("/reports/balance-sheet", enforceDataSource(REPORT_SOURCE_KEYS.MANUAL_GL), async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(400).json({ success: false, error: "Missing clientId." });

    const filters = parseManualFilterQuery(req.query || {});

    // reStageRequired is derived from audit data — include it in the cached payload.
    const cached = reportCache.get("bs", clientId, filters);
    if (cached) return res.json({ success: true, ...cached, source: "MANUAL_STAGED" });

    const stagedPayload = await getBalanceSheetSummaryFromStage(clientId, filters);

    const payload = { ...stagedPayload };

    reportCache.set("bs", clientId, filters, payload);
    return res.json({ success: true, ...payload, source: "MANUAL_STAGED" });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || "Failed to fetch Balance Sheet report." });
  }
});

router.get("/reports/cashflow", enforceDataSource(REPORT_SOURCE_KEYS.MANUAL_GL), async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(400).json({ success: false, error: "Missing clientId." });

    const filters = parseManualFilterQuery(req.query || {});
    const cached = reportCache.get("cf", clientId, filters);
    if (cached) return res.json({ success: true, ...cached, source: "MANUAL_STAGED" });

    const stagedPayload = await getCashflowSummaryFromStage(clientId, filters);
    reportCache.set("cf", clientId, filters, stagedPayload);
    return res.json({ success: true, ...stagedPayload, source: "MANUAL_STAGED" });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || "Failed to fetch Cash Flow report." });
  }
});

router.get("/reports/cashflow/monthly-detail", enforceDataSource(REPORT_SOURCE_KEYS.MANUAL_GL), async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(400).json({ success: false, error: "Missing clientId." });

    const filters = parseManualFilterQuery(req.query || {});
    const cached = reportCache.get("cf_monthly", clientId, filters);
    if (cached) return res.json({ success: true, ...cached });

    const payload = await getCashflowMonthlyDetailFromStage(clientId, filters);
    reportCache.set("cf_monthly", clientId, filters, payload);
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

    const result = await stageMultiYearGlUpload({
      companyId: clientId,
      glUploadIds,
      startingBalanceSheetUploadId,
      endingBalanceSheetUploadId,
      mapping,
      fiscalYearStartMonth,
      fiscalYearStartDay,
      uploadedBy: req.user?.id || null,
      batchName,
    });

    if (!result.success && result.requiresManualMapping) {
      return res.status(400).json(result);
    }

    // New batch staged — evict all cached reports for this company so next
    // report request reflects the fresh data.
    reportCache.invalidateCompany(clientId);

    return res.status(201).json(result);
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || "Failed to stage multi-year GL data.",
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

router.get("/reports/profit-loss", enforceDataSource(REPORT_SOURCE_KEYS.MANUAL_GL), async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(400).json({ success: false, error: "Missing clientId." });
    const filters = parseManualFilterQuery(req.query || {});
    const cached = reportCache.get("pl", clientId, filters);
    if (cached) return res.json({ success: true, ...cached, source: "MANUAL_STAGED" });

    const payload = await getProfitLossSummaryFromStage(clientId, filters);
    reportCache.set("pl", clientId, filters, payload);
    return res.json({ success: true, ...payload, source: "MANUAL_STAGED" });
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
    const payload = await getProfitLossDetailFromStage(clientId, filters);
    return res.json({ success: true, ...payload });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || "Failed to build staged Profit & Loss detail.",
    });
  }
});

router.get("/reports/profit-loss/monthly-detail", enforceDataSource(REPORT_SOURCE_KEYS.MANUAL_GL), async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(400).json({ success: false, error: "Missing clientId." });
    const filters = parseManualFilterQuery(req.query || {});
    const cached = reportCache.get("pl_monthly_detail", clientId, filters);
    if (cached) return res.json({ success: true, ...cached });

    const payload = await getProfitLossMonthlyDetailFromStage(clientId, filters);
    reportCache.set("pl_monthly_detail", clientId, filters, payload);
    return res.json({ success: true, ...payload });
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
    const cached = reportCache.get("bs_monthly", clientId, filters);
    if (cached) return res.json({ success: true, ...cached });

    const payload = await getBalanceSheetMonthlyDetailFromStage(clientId, filters);
    reportCache.set("bs_monthly", clientId, filters, payload);
    return res.json({ success: true, ...payload });
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
    const cached = reportCache.get("pl", clientId, filters);
    const payload = cached || await getProfitLossSummaryFromStage(clientId, filters);
    if (!cached) reportCache.set("pl", clientId, filters, payload);
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
    const cached = reportCache.get("pl", clientId, filters);
    const payload = cached || await getProfitLossSummaryFromStage(clientId, filters);
    if (!cached) reportCache.set("pl", clientId, filters, payload);
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
    const payload = await validateBatchBalanceSheet(clientId, batchId);
    return res.json({ success: true, ...payload });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || "Failed to validate balance sheet rollforward.",
    });
  }
});

// === Dataset Versions & Upload Jobs (Snapshot Architecture) ===

router.get("/manual-gl/dataset-versions", enforceDataSource(REPORT_SOURCE_KEYS.MANUAL_GL), async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(400).json({ success: false, error: "Missing clientId." });

    const versions = await listDatasetVersions(clientId, 50);
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
