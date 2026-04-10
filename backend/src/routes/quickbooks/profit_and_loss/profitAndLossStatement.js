const express = require("express");
const axios = require("axios");
const tokenManager = require("../../../tokenManager");
const { getQBConfig } = require("../../../qbconfig");

const router = express.Router();

/**
 * @swagger
 * /profit-and-loss-statement:
 *   get:
 *     summary: Get Profit and Loss Report
 *     description: Retrieves the Profit and Loss (Income Statement) report from QuickBooks with optional filters
 *     parameters:
 *       - name: start_date
 *         in: query
 *         description: Start date for the report (YYYY-MM-DD)
 *         required: false
 *         schema:
 *           type: string
 *           format: date
 *         example: 2026-01-01
 *       - name: end_date
 *         in: query
 *         description: End date for the report (YYYY-MM-DD)
 *         required: false
 *         schema:
 *           type: string
 *           format: date
 *         example: 2026-01-30
 *       - name: accounting_method
 *         in: query
 *         description: Accounting method (Accrual or Cash)
 *         required: false
 *         schema:
 *           type: string
 *           enum: [Accrual, Cash]
 *         example: Accrual
 *     responses:
 *       200:
 *         description: Profit and Loss report retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       400:
 *         description: Missing QuickBooks configuration or invalid parameters
 *       401:
 *         description: Authentication failed
 *       500:
 *         description: Server error
 */
router.get("/profit-and-loss-statement", async (req, res) => {
  const qb = getQBConfig();

  // Validate QuickBooks configuration
  if (!qb.accessToken || !qb.realmId) {
    return res.status(400).json({
      error: "Missing QuickBooks configuration. Please authenticate first.",
    });
  }

  let { start_date, end_date, accounting_method } = req.query;

  console.log("=".repeat(60));
  console.log("📊 PROFIT AND LOSS REQUEST");
  console.log("=".repeat(60));
  console.log(`📅 Start Date: ${start_date || "Not specified"}`);
  console.log(`📅 End Date: ${end_date || "Not specified"}`);
  console.log(`📚 Accounting Method: ${accounting_method || "Not specified"}`);
  console.log("=".repeat(60));

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

  try {
    // Build query parameters
    const queryParams = [];

    if (start_date) queryParams.push(`start_date=${start_date}`);
    if (end_date) queryParams.push(`end_date=${end_date}`);
    if (accounting_method)
      queryParams.push(`accounting_method=${accounting_method}`);
    queryParams.push("minorversion=75");

    const url = `${qb.baseUrl}/v3/company/${qb.realmId}/reports/ProfitAndLoss${queryParams.length ? `?${queryParams.join("&")}` : ""}`;

    console.log(`🔗 FULL URL: ${url}`);
    console.log("=".repeat(60));

    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${qb.accessToken}`,
        Accept: "application/json",
        "User-Agent": "QuickBooks-Integration/1.0",
      },
    });

    console.log("✅ Profit and Loss report fetched successfully!");

    // Log report summary
    if (response.data && response.data.Header) {
      console.log(`📊 Report Time: ${response.data.Header.Time}`);
      console.log(
        `📊 Report Basis: ${response.data.Header.ReportBasis || "Not specified"}`,
      );
      if (response.data.Header.StartPeriod && response.data.Header.EndPeriod) {
        console.log(
          `📅 Period: ${response.data.Header.StartPeriod} to ${response.data.Header.EndPeriod}`,
        );
      }
    }

    // Return raw QuickBooks response
    return res.json(response.data);
  } catch (error) {
    console.error("❌ Profit and Loss API Error:", error.message);

    if (error.response) {
      console.error("📝 Status Code:", error.response.status);
      console.error(
        "📝 Response Data:",
        JSON.stringify(error.response.data, null, 2),
      );

      // Handle 401 Unauthorized - Token expired
      if (error.response.status === 401) {
        console.log("⚠️ Token expired, attempting to refresh...");

        try {
          const newAccessToken = await tokenManager.refreshAccessToken();
          console.log("✅ Token refreshed successfully!");

          // Build query parameters again for retry
          const queryParams = [];
          if (start_date) queryParams.push(`start_date=${start_date}`);
          if (end_date) queryParams.push(`end_date=${end_date}`);
          if (accounting_method)
            queryParams.push(`accounting_method=${accounting_method}`);
          queryParams.push("minorversion=75");

          const retryUrl = `${qb.baseUrl}/v3/company/${qb.realmId}/reports/ProfitAndLoss${queryParams.length ? `?${queryParams.join("&")}` : ""}`;

          const retryResponse = await axios.get(retryUrl, {
            headers: {
              Authorization: `Bearer ${newAccessToken}`,
              Accept: "application/json",
              "User-Agent": "QuickBooks-Integration/1.0",
            },
          });

          console.log("✅ Retry successful with new token!");
          return res.json(retryResponse.data);
        } catch (refreshError) {
          console.error("❌ Token refresh failed:", refreshError.message);
          return res.status(401).json({
            error: "Authentication failed. Please re-authenticate.",
            details: refreshError.message,
          });
        }
      }

      // Return the exact QuickBooks error response
      return res.status(error.response.status).json(error.response.data);
    }

    return res.status(500).json({
      error: "Failed to fetch Profit and Loss report",
      details: error.message,
    });
  }
});

module.exports = router;
