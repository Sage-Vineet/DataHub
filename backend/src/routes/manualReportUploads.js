const express = require("express");
const { requireAuth } = require("../middleware/auth");
const {
  STATEMENT_TYPES,
  getLatestManualUploadedReport,
  syncManualReportFolder,
} = require("../services/manualReportUploadService");

const router = express.Router();
router.use(requireAuth);

function resolveClientId(req) {
  let clientId = req.headers["x-client-id"] || req.query.clientId;
  if (!clientId && req.headers.referer) {
    const match =
      req.headers.referer.match(/\/client\/([^/]+)/) ||
      req.headers.referer.match(/\/workspace\/([^/]+)/);
    if (match) clientId = match[1];
  }
  return clientId;
}

router.post("/manual-report-uploads/sync", async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    const folderId = String(req.body?.folderId || "").trim();
    const folderName = String(req.body?.folderName || "").trim();

    if (!clientId) {
      return res.status(400).json({ success: false, error: "Missing clientId." });
    }
    if (!folderId) {
      return res.status(400).json({ success: false, error: "folderId is required." });
    }

    const result = await syncManualReportFolder({
      companyId: clientId,
      folderId,
      folderName,
    });

    return res.json({ success: true, ...result });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || "Failed to sync manual report folder.",
    });
  }
});

router.get("/manual-report-uploads/reports/:statementType/latest", async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    const statementType = String(req.params.statementType || "").trim().toLowerCase();

    if (!clientId) {
      return res.status(400).json({ success: false, error: "Missing clientId." });
    }

    const validTypes = Object.values(STATEMENT_TYPES);
    if (!validTypes.includes(statementType)) {
      return res.status(400).json({ success: false, error: "Invalid statementType." });
    }

    const row = await getLatestManualUploadedReport({
      companyId: clientId,
      statementType,
    });

    if (!row) {
      return res.status(404).json({
        success: false,
        error: "No manual uploaded report found.",
      });
    }

    return res.json({
      success: true,
      source: "manual_upload_excel_pdf",
      statementType,
      data: row.data?.manual_report_upload?.report || null,
      reportParams: row.report_params || {},
      updatedAt: row.updated_at || null,
      lastSyncedAt: row.last_synced_at || null,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || "Failed to fetch manual uploaded report.",
    });
  }
});

module.exports = router;
