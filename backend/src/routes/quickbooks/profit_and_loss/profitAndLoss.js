const express = require("express");
const axios = require("axios");
const tokenManager = require("../../../tokenManager");
const { getQBConfig } = require("../../../qbconfig");

const router = express.Router();

function normalizeAccountingMethod(accountingMethod) {
  const normalized = accountingMethod?.trim().toLowerCase();

  if (normalized === "cash") return "Cash";
  if (normalized === "accrual") return "Accrual";

  return undefined;
}

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
  const qb = getQBConfig(req.clientId);

  // Build URL without any user inputs - just the basic report
  const url = `${qb.baseUrl}/v3/company/${qb.realmId}/reports/ProfitAndLoss?minorversion=75`;

  console.log(`📊 Fetching Profit and Loss report for company: ${qb.realmId}`);

  try {
    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${qb.accessToken}`,
        Accept: "application/json",
        "User-Agent": "QuickBooks-Integration/1.0",
      },
    });

    return res.json({ success: true, data: response.data });
  } catch (error) {
    // Handle 401 Unauthorized - Token expired
    if (error.response && error.response.status === 401) {
      console.log("⚠️ Token expired, attempting to refresh...");

      try {
        const newAccessToken = await tokenManager.refreshAccessToken();

        // Retry the request with new token
        const retryResponse = await axios.get(url, {
          headers: {
            Authorization: `Bearer ${newAccessToken}`,
            Accept: "application/json",
            "User-Agent": "QuickBooks-Integration/1.0",
          },
        });

        return res.json({
          success: true,
          data: retryResponse.data,
          refreshed: true,
        });
      } catch (refreshError) {
        console.error("❌ Token refresh failed:", refreshError.message);
        return res.status(401).json({
          error: "Authentication failed. Please re-authenticate.",
          details: refreshError.response?.data || refreshError.message,
        });
      }
    }

    // Handle other errors
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
  const qb = getQBConfig(req.clientId);

  // Extract query parameters
  let { start_date, end_date, accounting_method } = req.query;

  console.log("=".repeat(60));
  console.log("📊 PROFIT AND LOSS DETAIL REQUEST");
  console.log("=".repeat(60));
  console.log(`📅 Start Date: ${start_date || "Not specified"}`);
  console.log(`📅 End Date: ${end_date || "Not specified"}`);
  console.log(`📚 Accounting Method: ${accounting_method || "Not specified"}`);
  console.log("=".repeat(60));

  // Clean inputs
  start_date = start_date?.trim();
  end_date = end_date?.trim();
  accounting_method = normalizeAccountingMethod(accounting_method);

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

  // Build query parameters
  const queryParams = [];

  if (start_date) queryParams.push(`start_date=${start_date}`);
  if (end_date) queryParams.push(`end_date=${end_date}`);
  if (accounting_method)
    queryParams.push(`accounting_method=${accounting_method}`);
  queryParams.push("minorversion=75");

  // Build URL with filters
  const url = `${qb.baseUrl}/v3/company/${qb.realmId}/reports/ProfitAndLossDetail${queryParams.length ? `?${queryParams.join("&")}` : ""}`;

  console.log(`🔗 FULL URL: ${url}`);
  console.log("=".repeat(60));

  try {
    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${qb.accessToken}`,
        Accept: "application/json",
        "User-Agent": "QuickBooks-Integration/1.0",
      },
    });

    console.log("✅ Profit and Loss Detail fetched successfully!");

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
    // Handle other errors
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
