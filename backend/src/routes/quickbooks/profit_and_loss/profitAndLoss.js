const express = require("express");
const { fetchAndCacheReport, serveCachedReport, REPORT_TYPES } = require("../../../services/quickbooksReportService");

const router = express.Router();

function normalizeDetailQuery(query = {}) {
  const start_date = String(query.start_date || "").trim();
  const end_date = String(query.end_date || "").trim();
  const accounting_method = String(query.accounting_method || "").trim();
  return { start_date, end_date, accounting_method };
}

router.get("/profit-and-loss", async (req, res) => {
  const clientId = req.clientId;

  try {
    const result = await fetchAndCacheReport(
      clientId,
      REPORT_TYPES.PROFIT_AND_LOSS,
      "ProfitAndLoss",
      {},
    );

    return res.json({
      success: true,
      source: "cached_snapshot",
      disconnected: Boolean(req.qbDisconnected),
      lastSyncAt: result.lastSyncedAt,
      datasetVersion: result.datasetVersion || null,
      data: result.data,
    });
  } catch (error) {
    const status = /No finalized snapshot/i.test(error.message) ? 404 : 500;
    console.error("[ProfitAndLoss] Snapshot read failed:", error.message);
    return res.status(status).json({
      success: false,
      source: "cached_snapshot",
      disconnected: Boolean(req.qbDisconnected),
      message: error.message || "Failed to load Profit & Loss snapshot.",
    });
  }
});

module.exports = router;
