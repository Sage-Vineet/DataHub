const express = require("express");
const { fetchAndCacheReport, fetchOnDemandReport, REPORT_TYPES } = require("../../../services/quickbooksReportService");

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
  const { start_date, end_date, account, fresh } = req.query;

  const queryParams = {};
  if (start_date) queryParams.start_date = start_date;
  if (end_date) queryParams.end_date = end_date;
  if (account) queryParams.account = account;

  try {
    // fresh=true → fetch live from QB with the given date range and cache the result.
    // This is used by the vendor/customer breakdown when the user applies new filters.
    const fetchFn = fresh === "true" ? fetchOnDemandReport : fetchAndCacheReport;
    const result = await fetchFn(
      clientId,
      REPORT_TYPES.GENERAL_LEDGER,
      "GeneralLedger",
      queryParams
    );

    return res.json({
      success: true,
      data: result.data,
      source: fresh === "true" ? "live" : "cached_snapshot",
      disconnected: Boolean(req.qbDisconnected),
      lastSyncAt: result.lastSyncedAt,
      datasetVersion: result.datasetVersion || null,
    });
  } catch (error) {
    const status = /No finalized snapshot/i.test(error.message) ? 404 : 500;
    console.error("❌ General Ledger API Error:", error.message);
    return res.status(status).json({
      success: false,
      source: "cached_snapshot",
      disconnected: Boolean(req.qbDisconnected),
      message: error.message || "Failed to fetch General Ledger snapshot.",
    });
  }
});

module.exports = router;

