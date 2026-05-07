const express = require("express");
const { requireAuth } = require("../middleware/auth");
const {
  listManualGlUploads,
  upsertManualGlUpload,
  generateManualGlReports,
  getLatestGeneratedManualGlReport,
  getLatestManualGlQuickbooksReport,
  getManualGlColumns,
  processManualGlData,
} = require("../services/manualGlService");
const { uploadController } = require("../controllers/manualGl/uploadController");
const { continueController } = require("../controllers/manualGl/continueController");

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
  const row = await getLatestGeneratedManualGlReport({
    companyId: clientId,
    statementType: normalizedStatementType,
    uploadId,
  });

  if (!row) {
    return res.status(404).json({ error: "No generated manual GL report found." });
  }

  const quickbooksRow = await getLatestManualGlQuickbooksReport({
    companyId: clientId,
    statementType: normalizedStatementType,
  });

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

router.get("/manual-gl/uploads", async (req, res) => {
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

router.post("/manual-gl/uploads", async (req, res) => {
  try {
    return await handleCreateUpload(req, res);
  } catch (error) {
    return res.status(500).json({ error: error.message || "Failed to save manual GL upload." });
  }
});

router.post("/manual-gl/upload", async (req, res, next) => {
  try {
    return await uploadController(req, res);
  } catch (error) {
    return next(error);
  }
});

router.post("/manual-gl/continue", async (req, res, next) => {
  try {
    return await continueController(req, res);
  } catch (error) {
    return next(error);
  }
});

router.post("/upload-gl", async (req, res) => {
  try {
    return await handleCreateUpload(req, res);
  } catch (error) {
    return res.status(500).json({ error: error.message || "Failed to save manual GL upload." });
  }
});

router.post("/manual-gl/reports/generate", async (req, res) => {
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

router.get("/manual-gl/reports/:statementType/latest", async (req, res) => {
  try {
    return await handleGetLatestReport(req, res, req.params.statementType);
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || "Failed to fetch report." });
  }
});

router.get("/reports/pl", async (req, res) => {
  try {
    return await handleGetLatestReport(req, res, "profit_and_loss");
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || "Failed to fetch P&L report." });
  }
});

router.get("/reports/balance-sheet", async (req, res) => {
  try {
    return await handleGetLatestReport(req, res, "balance_sheet");
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || "Failed to fetch Balance Sheet report." });
  }
});

router.get("/reports/cashflow", async (req, res) => {
  try {
    return await handleGetLatestReport(req, res, "cash_flow");
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || "Failed to fetch Cash Flow report." });
  }
});

router.get("/manual-gl/columns/:uploadId", async (req, res) => {
  try {
    const { uploadId } = req.params;
    if (!uploadId) return res.status(400).json({ error: "uploadId is required." });

    const result = await getManualGlColumns(uploadId);
    return res.json({ success: true, ...result });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || "Failed to get columns." });
  }
});

router.post("/manual-gl/save-mapping", async (req, res) => {
  try {
    return await handleSaveMapping(req, res);
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || "Failed to save mapping." });
  }
});

router.post("/save-mapping", async (req, res) => {
  try {
    return await handleSaveMapping(req, res);
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || "Failed to save mapping." });
  }
});

router.post("/manual-gl/process-gl", async (req, res) => {
  try {
    return await handleProcessGl(req, res);
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || "Failed to process GL." });
  }
});

router.post("/process-gl", async (req, res) => {
  try {
    return await handleProcessGl(req, res);
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || "Failed to process GL." });
  }
});

module.exports = router;
