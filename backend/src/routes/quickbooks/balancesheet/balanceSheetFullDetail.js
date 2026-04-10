const express = require("express");
const axios = require("axios");
const tokenManager = require("../../../tokenManager");
const { getQBConfig } = require("../../../qbconfig");

const router = express.Router();

/**
 * @swagger
 * /balance-sheet-detail:
 *   get:
 *     summary: Get Balance Sheet Detail Report
 *     description: Retrieves the detailed Balance Sheet report from QuickBooks with transaction-level details
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
 *         example: 2026-01-30
 *       - in: query
 *         name: accounting_method
 *         schema:
 *           type: string
 *           enum: [Accrual, Cash]
 *         description: Accounting method (Accrual or Cash)
 *         required: false
 *         example: Cash
 *       - in: query
 *         name: summarize_column_by
 *         schema:
 *           type: string
 *           enum: [Total, Month, Quarter, Year]
 *         description: How to summarize columns (defaults to Total)
 *         required: false
 *         example: Total
 *     responses:
 *       200:
 *         description: Balance Sheet Detail report retrieved successfully
 *       400:
 *         description: Missing QuickBooks configuration
 *       401:
 *         description: Authentication failed
 *       500:
 *         description: Server error
 */
router.get("/balance-sheet-detail", async (req, res) => {
  const qb = getQBConfig();

  let { start_date, end_date, accounting_method, summarize_column_by } =
    req.query;

  console.log("=".repeat(60));
  console.log("📊 BALANCE SHEET DETAIL REQUEST");
  console.log("=".repeat(60));
  console.log(`📅 Start Date: ${start_date || "Not specified"}`);
  console.log(`📅 End Date: ${end_date || "Not specified"}`);
  console.log(`📚 Accounting Method: ${accounting_method || "Not specified"}`);
  console.log(
    `📊 Summarize Column By: ${summarize_column_by || "Not specified (default: Total)"}`,
  );
  console.log("=".repeat(60));

  // Clean and validate inputs
  start_date = start_date?.trim();
  end_date = end_date?.trim();
  accounting_method = accounting_method?.trim();
  summarize_column_by = summarize_column_by?.trim();

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

  const validSummarizeOptions = ["Total", "Month", "Quarter", "Year"];
  if (
    !summarize_column_by ||
    !validSummarizeOptions.includes(summarize_column_by)
  ) {
    summarize_column_by = "Total";
    console.log(`📊 Using default summarize_column_by: ${summarize_column_by}`);
  }

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

  if (start_date && end_date && start_date > end_date) {
    return res.status(400).json({
      error: "start_date cannot be later than end_date",
      start_date,
      end_date,
    });
  }

  try {
    // Build query parameters
    const queryParams = [];

    if (start_date) queryParams.push(`start_date=${start_date}`);
    if (end_date) queryParams.push(`end_date=${end_date}`);
    if (accounting_method)
      queryParams.push(`accounting_method=${accounting_method}`);
    if (summarize_column_by)
      queryParams.push(`summarize_column_by=${summarize_column_by}`);
    queryParams.push("minorversion=75");

    const url = `${qb.baseUrl}/v3/company/${qb.realmId}/reports/BalanceSheet${queryParams.length ? `?${queryParams.join("&")}` : ""}`;

    console.log(`🔗 FULL URL: ${url}`);
    console.log("=".repeat(60));

    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${qb.accessToken}`,
        Accept: "application/json",
        "User-Agent": "QuickBooks-Integration/1.0",
      },
    });

    console.log("✅ Balance Sheet Detail fetched successfully!");

    // Send the raw QuickBooks response directly
    return res.json(response.data);
  } catch (error) {
    console.error("❌ Balance Sheet Detail API Error:", error.message);

    if (error.response) {
      console.error("📝 Status Code:", error.response.status);
      console.error(
        "📝 Response Data:",
        JSON.stringify(error.response.data, null, 2),
      );

      // Send the error response exactly as from QuickBooks
      return res.status(error.response.status).json(error.response.data);
    }

    return res.status(500).json({
      error: "Failed to fetch Balance Sheet Detail report",
      details: error.message,
    });
  }
});

/**
 * @swagger
 * /all-reports:
 *   get:
 *     summary: Get All Financial Reports
 *     description: Fetch multiple QuickBooks reports with date filters
 *     tags:
 *       - Reports
 *     parameters:
 *       - in: query
 *         name: start_date
 *         required: true
 *         schema:
 *           type: string
 *           format: date
 *         example: 2026-01-01
 *         description: Start date for reports
 *
 *       - in: query
 *         name: end_date
 *         required: true
 *         schema:
 *           type: string
 *           format: date
 *         example: 2026-01-30
 *         description: End date for reports
 *
 *       - in: query
 *         name: accounting_method
 *         required: false
 *         schema:
 *           type: string
 *           enum: [Cash, Accrual]
 *         example: Cash
 *         description: Accounting method
 *
 *     responses:
 *       200:
 *         description: Reports fetched successfully
 *       500:
 *         description: Failed to fetch reports
 */
router.get("/all-reports", async (req, res) => {
  const qb = getQBConfig();

  const { start_date, end_date, accounting_method } = req.query;

  try {
    const headers = {
      Authorization: `Bearer ${qb.accessToken}`,
      Accept: "application/json",
    };

    const base = `${qb.baseUrl}/v3/company/${qb.realmId}/reports`;

    const params = `start_date=${start_date}&end_date=${end_date}&accounting_method=${accounting_method}`;

    const reportCalls = {
      accountList: axios.get(`${base}/AccountList`, { headers }),

      agedPayableDetail: axios.get(`${base}/AgedPayableDetail?${params}`, {
        headers,
      }),

      agedReceivableDetail: axios.get(
        `${base}/AgedReceivableDetail?${params}`,
        { headers },
      ),

      balanceSheet: axios.get(`${base}/BalanceSheet?${params}`, { headers }),

      cashSales: axios.get(`${base}/CashSales?${params}`, { headers }),

      generalLedger: axios.get(`${base}/GeneralLedger?${params}`, { headers }),

      trialBalance: axios.get(`${base}/TrialBalance?${params}`, { headers }),
    };

    const results = await Promise.allSettled(Object.values(reportCalls));
    const reportNames = Object.keys(reportCalls);
    const combinedReports = {};

    results.forEach((result, index) => {
      const name = reportNames[index];

      if (result.status === "fulfilled") {
        combinedReports[name] = result.value.data;
      } else {
        console.log(`Report failed: ${name}`);
        console.log(result.reason.response?.data || result.reason.message);

        combinedReports[name] = {
          error: "Permission denied or report not available",
        };
      }
    });

    res.json(combinedReports);
  } catch (error) {
    console.error("QuickBooks Reports Error:", error);

    res.status(500).json({
      error: "Failed to fetch reports",
      details: error.message,
    });
  }
});

module.exports = router;
