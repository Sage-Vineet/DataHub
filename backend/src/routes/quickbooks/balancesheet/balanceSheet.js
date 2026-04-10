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
 * /balance-sheet:
 *   get:
 *     summary: Get Balance Sheet
 *     responses:
 *       200:
 *         description: Success
 */
router.get("/balance-sheet", async (req, res) => {
  const qb = getQBConfig(req.clientId);
  const start_date = req.query.start_date?.trim();
  const end_date = req.query.end_date?.trim();
  const accounting_method = normalizeAccountingMethod(req.query.accounting_method);

  // Validate required config
  if (!qb.accessToken || !qb.realmId) {
    return res.status(400).json({
      error: "Missing QuickBooks configuration. Please authenticate first.",
    });
  }

  const params = new URLSearchParams();
  if (start_date) params.set("start_date", start_date);
  if (end_date) params.set("end_date", end_date);
  if (accounting_method) params.set("accounting_method", accounting_method);
  params.set("minorversion", "75");

  const url = `${qb.baseUrl}/v3/company/${qb.realmId}/reports/BalanceSheet?${params.toString()}`;

  try {
    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${qb.accessToken}`,
        Accept: "application/json",
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
    console.error("❌ Balance Sheet API Error:", error.message);
    return res.status(error.response?.status || 500).json({
      error: "Failed to fetch balance sheet",
      details: error.response?.data || error.message,
    });
  }
});

module.exports = router;
