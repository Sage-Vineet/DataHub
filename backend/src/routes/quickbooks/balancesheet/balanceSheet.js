const express = require("express");
const {
  fetchAndCacheReport,
  serveCachedReport,
  REPORT_TYPES,
} = require("../../../services/quickbooksReportService");
const {
  buildQuickbooksBalanceSheetFromSnapshot,
  getLatestBalanceSheetSnapshot,
} = require("../../../services/balanceSheetSnapshotService");

const router = express.Router();

async function resolveManualSnapshotFallback(clientId, queryParams = {}) {
  const snapshotRow = await getLatestBalanceSheetSnapshot(clientId);
  if (!snapshotRow?.snapshot) return null;

  const reportPayload = buildQuickbooksBalanceSheetFromSnapshot({
    snapshot: snapshotRow.snapshot,
    accountingMethod: queryParams?.accounting_method || "Accrual",
    startDate: queryParams?.start_date || "",
    endDate: queryParams?.end_date || "",
  });

  return {
    data: reportPayload,
    source: "MANUAL_UPLOAD",
    lastSyncedAt: snapshotRow.lastSyncedAt || null,
    snapshotId: snapshotRow.id,
    stagedDataId: snapshotRow.stagedDataId,
  };
}

/**
 * @swagger
 * /balance-sheet:
 *   get:
 *     summary: Get Balance Sheet
 *     responses:
 *       200:
 *         description: Success
 */
router.get("/balance-sheet", async (req, res) => {
  const clientId = req.clientId;

  // If QB is disconnected, serve cached data first.
  if (req.qbDisconnected) {
    try {
      const cached = await serveCachedReport(clientId, REPORT_TYPES.BALANCE_SHEET);
      if (cached) {
        return res.json({
          success: true,
          data: cached.data,
          source: "cache",
          lastSyncedAt: cached.lastSyncedAt,
          isDisconnected: true,
        });
      }

      const manualSnapshot = await resolveManualSnapshotFallback(clientId, req.query || {});
      if (manualSnapshot) {
        return res.json({
          success: true,
          data: manualSnapshot.data,
          source: manualSnapshot.source,
          lastSyncedAt: manualSnapshot.lastSyncedAt,
          snapshotId: manualSnapshot.snapshotId,
          stagedDataId: manualSnapshot.stagedDataId,
          isDisconnected: true,
        });
      }

      return res.status(404).json({
        success: false,
        message: "QuickBooks is disconnected and no cached/manual Balance Sheet data is available.",
        isDisconnected: true,
      });
    } catch (cacheError) {
      return res.status(500).json({
        success: false,
        message: "Failed to retrieve cached data.",
        error: cacheError.message,
      });
    }
  }

  // QB is connected: fetch live data and cache it.
  const { clientId: _cid, minorversion, ...queryParams } = req.query;

  try {
    const result = await fetchAndCacheReport(
      clientId,
      REPORT_TYPES.BALANCE_SHEET,
      "BalanceSheet",
      queryParams
    );

    return res.json({
      success: true,
      data: result.data,
      source: result.source,
      lastSyncedAt: result.lastSyncedAt,
      refreshed: result.source === "cache" ? false : undefined,
    });
  } catch (error) {
    try {
      const manualSnapshot = await resolveManualSnapshotFallback(clientId, req.query || {});
      if (manualSnapshot) {
        return res.json({
          success: true,
          data: manualSnapshot.data,
          source: manualSnapshot.source,
          lastSyncedAt: manualSnapshot.lastSyncedAt,
          snapshotId: manualSnapshot.snapshotId,
          stagedDataId: manualSnapshot.stagedDataId,
          fallbackReason: "quickbooks_fetch_failed",
        });
      }
    } catch (snapshotError) {
      console.error("Manual snapshot fallback failed:", snapshotError.message);
    }

    console.error("Balance Sheet API Error:", error.message);
    return res.status(error.response?.status || 500).json({
      error: "Failed to fetch balance sheet",
      details: error.response?.data || error.message,
    });
  }
});

module.exports = router;
