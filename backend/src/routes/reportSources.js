const express = require("express");
const { requireAuth } = require("../middleware/auth");
const {
  REPORT_SOURCE_KEYS,
  setSelectedReportSource,
  syncReportSourceRecords,
} = require("../services/reportSourceStore");

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

router.get("/report-sources", async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) {
      return res.status(400).json({ success: false, error: "Missing clientId." });
    }

    const sources = await syncReportSourceRecords(clientId);
    const selectedSource =
      sources.find((source) => source.isSelected)?.sourceKey ||
      REPORT_SOURCE_KEYS.QUICKBOOKS;

    return res.json({
      success: true,
      sources,
      selectedSource,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || "Failed to load report sources.",
    });
  }
});

router.put("/report-sources/selected", async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    const sourceKey = String(req.body?.sourceKey || "").trim();

    if (!clientId) {
      return res.status(400).json({ success: false, error: "Missing clientId." });
    }

    if (!sourceKey) {
      return res.status(400).json({ success: false, error: "sourceKey is required." });
    }

    const sources = await setSelectedReportSource(clientId, sourceKey);
    const selectedSource =
      sources.find((source) => source.isSelected)?.sourceKey ||
      REPORT_SOURCE_KEYS.QUICKBOOKS;

    return res.json({
      success: true,
      sources,
      selectedSource,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || "Failed to save report source.",
    });
  }
});

module.exports = router;
