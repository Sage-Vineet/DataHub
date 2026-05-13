const express = require("express");
const axios = require("axios");
const tokenManager = require("../../../tokenManager");
const { getQBConfig } = require("../../../qbconfig");
const { fetchAndCacheReport, serveCachedReport, REPORT_TYPES } = require("../../../services/quickbooksReportService");

const router = express.Router();

/**
 * @swagger
 * /profit-and-loss:
 *   get:
 *     summary: Get Profit and Loss Report
 *     description: Retrieves the Profit and Loss (Income Statement) report from QuickBooks
 *     responses:
 *       200:
 *         description: Profit and Loss report retrieved successfully
 *       401:
 *         description: Authentication failed
 *       500:
 *         description: Server error
 */
router.get("/profit-and-loss", async (req, res) => {
  const clientId = req.clientId;

  // If QB is disconnected, serve cached data
  if (req.qbDisconnected) {
    try {
      const cached = await serveCachedReport(clientId, REPORT_TYPES.PROFIT_AND_LOSS);
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
        message: "QuickBooks is disconnected and no cached data is available.",
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

  // QB is connected — fetch live and cache
  try {
    const result = await fetchAndCacheReport(
      clientId,
      REPORT_TYPES.PROFIT_AND_LOSS,
      "ProfitAndLoss"
    );

    return res.json({
      success: true,
      data: result.data,
      source: result.source,
      lastSyncedAt: result.lastSyncedAt,
    });
  } catch (error) {
    console.error("❌ Profit and Loss API Error:", error.message);
    const qbError = error.response?.data?.Fault?.Error?.[0];

    return res.status(error.response?.status || 500).json({
      success: false,
      message: qbError?.Message || error.message,
      code: qbError?.code,
      details: qbError?.Detail || error.response?.data || error.message,
    });
  }
});

/**
 * @swagger
 * /profit-and-loss-detail:
 *   get:
 *     summary: Get Profit and Loss Detail Report
 *     description: Retrieves the detailed Profit and Loss report from QuickBooks with transaction-level details
 *     parameters:
 *       - in: query
 *         name: start_date
 *         schema:
 *           type: string
 *           format: date
 *         description: Start date for the report (YYYY-MM-DD)
 *         required: false
 *         example: 2026-01-01
 *       - in: query
 *         name: end_date
 *         schema:
 *           type: string
 *           format: date
 *         description: End date for the report (YYYY-MM-DD)
 *         required: false
 *         example: 2026-03-11
 *       - in: query
 *         name: accounting_method
 *         schema:
 *           type: string
 *           enum: [Accrual, Cash]
 *         description: Accounting method (Accrual or Cash)
 *         required: false
 *         example: Cash
 *     responses:
 *       200:
 *         description: Profit and Loss Detail report retrieved successfully
 *       400:
 *         description: Missing QuickBooks configuration or invalid parameters
 *       401:
 *         description: Authentication failed
 *       500:
 *         description: Server error
 */
router.get("/profit-and-loss-detail", async (req, res) => {
  const clientId = req.clientId;

  // Extract query parameters
  let { start_date, end_date, accounting_method } = req.query;

  // If QB is disconnected, serve cached data
  if (req.qbDisconnected) {
    try {
      const cached = await serveCachedReport(
        clientId,
        REPORT_TYPES.PROFIT_AND_LOSS_DETAIL,
        { start_date, end_date, accounting_method }
      );
      if (cached) {
        return res.json({
          ...cached.data,
          _meta: {
            source: "cache",
            lastSyncedAt: cached.lastSyncedAt,
            isDisconnected: true,
          },
        });
      }
      return res.status(404).json({
        success: false,
        message: "QuickBooks is disconnected and no cached detail data is available.",
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

  // Clean inputs
  start_date = start_date?.trim();
  end_date = end_date?.trim();
  accounting_method = accounting_method?.trim();

  // Validate accounting method
  const validAccountingMethods = ["Accrual", "Cash"];
  if (
    accounting_method &&
    !validAccountingMethods.includes(accounting_method)
  ) {
    console.warn(
      `⚠️ Invalid accounting_method: ${accounting_method}. Removing filter.`,
    );
    accounting_method = undefined;
  }

  // Validate date formats if provided
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (start_date && !dateRegex.test(start_date)) {
    return res.status(400).json({
      error: "Invalid start_date format. Please use YYYY-MM-DD format.",
      received: start_date,
    });
  }

  if (end_date && !dateRegex.test(end_date)) {
    return res.status(400).json({
      error: "Invalid end_date format. Please use YYYY-MM-DD format.",
      received: end_date,
    });
  }

  // Validate date range
  if (start_date && end_date && start_date > end_date) {
    return res.status(400).json({
      error: "start_date cannot be later than end_date",
      start_date,
      end_date,
    });
  }

  // Build query parameters for QB API
  const queryParams = {};
  if (start_date) queryParams.start_date = start_date;
  if (end_date) queryParams.end_date = end_date;
  if (accounting_method) queryParams.accounting_method = accounting_method;

  try {
    const result = await fetchAndCacheReport(
      clientId,
      REPORT_TYPES.PROFIT_AND_LOSS_DETAIL,
      "ProfitAndLossDetail",
      queryParams
    );

    // Return raw QB response for backward compatibility
    return res.json(result.data);
  } catch (error) {
    if (error.response?.status === 401) {
      return res.status(401).json({
        error: "Authentication failed. Please re-authenticate.",
        details: error.response?.data || error.message,
      });
    }

    console.error("❌ Profit and Loss Detail API Error:", error.message);
    const qbError = error.response?.data?.Fault?.Error?.[0];

    return res.status(error.response?.status || 500).json({
      success: false,
      message: qbError?.Message || error.message,
      code: qbError?.code,
      details: qbError?.Detail || error.response?.data || error.message,
    });
  }
});

module.exports = router;
