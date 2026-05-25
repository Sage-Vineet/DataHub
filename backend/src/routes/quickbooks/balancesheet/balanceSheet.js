const express = require("express");
const {
  serveCachedReport,
  REPORT_TYPES,
} = require("../../../services/quickbooksReportService");

const router = express.Router();

router.get("/balance-sheet", async (req, res) => {
  const clientId = req.clientId;
  const { start_date, end_date, accounting_method } = req.query;
  const queryParams = { start_date, end_date, accounting_method };
  const disconnected = Boolean(req.qbDisconnected);

  try {
    // Step 1: try the period-specific snapshot (exact params + Accrual fallback).
    // Step 2: balance sheets are point-in-time; if no period-specific snapshot exists
    //         (no monthly BS snapshots are stored), fall back to the latest yearly snapshot.
    const result =
      await serveCachedReport(clientId, REPORT_TYPES.BALANCE_SHEET, queryParams, { disconnected }) ||
      await serveCachedReport(clientId, REPORT_TYPES.BALANCE_SHEET, {}, { disconnected });

    if (!result?.data) {
      return res.status(404).json({
        success: false,
        source: "cached_snapshot",
        disconnected,
        message:
          "No finalized Balance Sheet snapshot is available. Run QuickBooks sync to generate a dataset snapshot.",
      });
    }

    return res.json({
      success: true,
      data: result.data,
      source: "cached_snapshot",
      disconnected,
      lastSyncAt: result.lastSyncedAt,
      datasetVersion: result.datasetVersion || null,
    });
  } catch (error) {
    console.error("Balance Sheet API Error:", error.message);
    return res.status(500).json({
      success: false,
      source: "cached_snapshot",
      disconnected,
      message: error.message || "Failed to fetch balance sheet snapshot.",
    });
  }
});

module.exports = router;
