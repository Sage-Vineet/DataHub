const express = require("express");
const axios = require("axios");
const tokenManager = require("../../../tokenManager");
const { getQBConfig } = require("../../../qbconfig");

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
  const qb = getQBConfig(req.clientId);

  // Validate required config
  if (!qb.accessToken || !qb.realmId) {
    return res.status(400).json({
      error: "Missing QuickBooks configuration. Please authenticate first.",
    });
  }

  // Build URL with optional query parameters
  let url = `${qb.baseUrl}/v3/company/${qb.realmId}/reports/GeneralLedger?minorversion=75`;

  // Add optional query parameters from request
  const { start_date, end_date, account } = req.query;
  const params = [];

  if (start_date) params.push(`start_date=${start_date}`);
  if (end_date) params.push(`end_date=${end_date}`);
  if (account) params.push(`account=${account}`);

  if (params.length > 0) {
    url += `&${params.join("&")}`;
  }

  console.log(`📊 Fetching General Ledger report for company: ${qb.realmId}`);

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
        const newAccessToken = await tokenManager.refreshAccessToken(req.clientId);

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
    console.error("❌ General Ledger API Error:", error.message);
    return res.status(error.response?.status || 500).json({
      error: "Failed to fetch General Ledger report",
      details: error.response?.data || error.message,
    });
  }
});

module.exports = router;
