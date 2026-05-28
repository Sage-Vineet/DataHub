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

router.get("/profit-and-loss-detail", async (req, res) => {
  const clientId = req.clientId;
  const { start_date, end_date, accounting_method } = normalizeDetailQuery(req.query);

  try {
    const detailed = await fetchAndCacheReport(
      clientId,
      REPORT_TYPES.PROFIT_AND_LOSS_DETAIL,
      "ProfitAndLossDetail",
      { start_date, end_date, accounting_method },
    );

    return res.json({
      success: true,
      source: "cached_snapshot",
      disconnected: Boolean(req.qbDisconnected),
      lastSyncAt: detailed.lastSyncedAt,
      datasetVersion: detailed.datasetVersion || null,
      data: detailed.data,
    });
  } catch (_detailError) {
    // Backward-compatible fallback to summary dataset when no detail snapshot exists.
    const fallback = await serveCachedReport(
      clientId,
      REPORT_TYPES.PROFIT_AND_LOSS,
      { start_date, end_date, accounting_method },
      { disconnected: Boolean(req.qbDisconnected) },
    );

    if (!fallback?.data) {
      return res.status(404).json({
        success: false,
        source: "cached_snapshot",
        disconnected: Boolean(req.qbDisconnected),
        message:
          "No finalized Profit & Loss detail snapshot is available. Run QuickBooks sync to generate snapshots.",
      });
    }

    return res.json({
      success: true,
      source: "cached_snapshot",
      disconnected: Boolean(req.qbDisconnected),
      lastSyncAt: fallback.lastSyncedAt,
      datasetVersion: fallback.datasetVersion || null,
      data: fallback.data,
    });
  }
});

module.exports = router;
