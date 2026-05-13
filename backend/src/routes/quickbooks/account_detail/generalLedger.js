const express = require("express");
const { fetchAndCacheReport, serveCachedReport, REPORT_TYPES } = require("../../../services/quickbooksReportService");

const router = express.Router();

/**
 * @swagger
 * /general-ledger:
 *   get:
 *     summary: Get General Ledger Report
 *     description: Retrieves the General Ledger report from QuickBooks
 *     parameters:
 *       - in: query
 *         name: start_date
 *         schema:
 *           type: string
 *         description: Start date for the report (YYYY-MM-DD)
 *       - in: query
 *         name: end_date
 *         schema:
 *           type: string
 *         description: End date for the report (YYYY-MM-DD)
 *       - in: query
 *         name: account
 *         schema:
 *           type: string
 *         description: Filter by specific account
 *     responses:
 *       200:
 *         description: General Ledger report retrieved successfully
 *       401:
 *         description: Authentication failed
 *       500:
 *         description: Server error
 */
router.get("/general-ledger", async (req, res) => {
  const clientId = req.clientId;
  const { start_date, end_date, account } = req.query;

  // If QB is disconnected, serve cached data
  if (req.qbDisconnected) {
    try {
      const cached = await serveCachedReport(
        clientId,
        REPORT_TYPES.GENERAL_LEDGER,
        { start_date, end_date, account }
      );
      if (cached) {
        return res.json({
          success: true,
          data: cached.data,
          source: "cache",
          lastSyncedAt: cached.lastSyncedAt,
          isDisconnected: true,
        });
      }
      return res.status(404).json({
        success: false,
        message: "QuickBooks is disconnected and no cached general ledger data is available.",
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

  // Build query parameters for QB API
  const queryParams = {};
  if (start_date) queryParams.start_date = start_date;
  if (end_date) queryParams.end_date = end_date;
  if (account) queryParams.account = account;

  try {
    const result = await fetchAndCacheReport(
      clientId,
      REPORT_TYPES.GENERAL_LEDGER,
      "GeneralLedger",
      queryParams
    );

    return res.json({
      success: true,
      data: result.data,
      source: result.source,
      lastSyncedAt: result.lastSyncedAt,
    });
  } catch (error) {
    console.error("❌ General Ledger API Error:", error.message);
    return res.status(error.response?.status || 500).json({
      error: "Failed to fetch General Ledger report",
      details: error.response?.data || error.message,
    });
  }
});

module.exports = router;

