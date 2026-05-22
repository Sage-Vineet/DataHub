const express = require("express");
const {
  fetchAndCacheReport,
  REPORT_TYPES,
} = require("../../../services/quickbooksReportService");

const router = express.Router();

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

  // Reports are snapshot-first and read from DB regardless of connection state.
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
      source: "cached_snapshot",
      disconnected: Boolean(req.qbDisconnected),
      lastSyncAt: result.lastSyncedAt,
      datasetVersion: result.datasetVersion || null,
    });
  } catch (error) {
    const status = /No finalized snapshot/i.test(error.message) ? 404 : 500;
    console.error("Balance Sheet API Error:", error.message);
    return res.status(status).json({
      success: false,
      source: "cached_snapshot",
      disconnected: Boolean(req.qbDisconnected),
      message: error.message || "Failed to fetch balance sheet snapshot.",
    });
  }
});

module.exports = router;
