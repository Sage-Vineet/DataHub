const express = require("express");
const { serveCachedReport, REPORT_TYPES } = require("../../../services/quickbooksReportService");

const router = express.Router();

router.get("/profit-and-loss-statement", async (req, res) => {
  const clientId = req.clientId;
  const { start_date, end_date, accounting_method } = req.query;

  try {
    const cached = await serveCachedReport(
      clientId,
      REPORT_TYPES.PROFIT_AND_LOSS,
      { start_date, end_date, accounting_method },
      { disconnected: Boolean(req.qbDisconnected) },
    );

    if (!cached?.data) {
      return res.status(404).json({
        success: false,
        source: "cached_snapshot",
        disconnected: Boolean(req.qbDisconnected),
        message:
          "No finalized Profit & Loss snapshot is available. Run QuickBooks sync to generate a dataset snapshot.",
      });
    }

    return res.json({
      success: true,
      source: "cached_snapshot",
      disconnected: Boolean(req.qbDisconnected),
      lastSyncAt: cached.lastSyncedAt,
      datasetVersion: cached.datasetVersion || null,
      data: cached.data,
    });
  } catch (error) {
    console.error("[P&L Statement] Snapshot read failed:", error.message);
    return res.status(500).json({
      success: false,
      source: "cached_snapshot",
      disconnected: Boolean(req.qbDisconnected),
      message: "Failed to load Profit & Loss snapshot.",
      error: error.message,
    });
  }
});

module.exports = router;
