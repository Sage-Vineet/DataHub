const express = require("express");
const axios = require("axios");
const tokenManager = require("../../../tokenManager");
const { getQBConfig } = require("../../../qbconfig");
const { fetchAndCacheReport, fetchAndCacheQuery, serveCachedReport, REPORT_TYPES } = require("../../../services/quickbooksReportService");

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Cashflow
 *   description: Cashflow related QuickBooks APIs
 */

/**
 * @swagger
 * /qb-transactions:
 *   get:
 *     tags:
 *       - Cashflow
 *     summary: Fetch QuickBooks transactions
 *     description: Fetch transactions from QuickBooks. Filters are optional and can be provided by the user.
 *     parameters:
 *       - in: query
 *         name: start_date
 *         schema:
 *           type: string
 *           example: 2026-01-01
 *         required: false
 *         description: Start date filter
 *       - in: query
 *         name: end_date
 *         schema:
 *           type: string
 *           example: 2026-03-31
 *         required: false
 *         description: End date filter
 */
router.get("/qb-transactions", async (req, res) => {
  const clientId = req.clientId;

  // If QB is disconnected, serve cached data
  if (req.qbDisconnected) {
    try {
      const cached = await serveCachedReport(clientId, "transactions");
      if (cached) {
        return res.json({
          ...cached.data,
          _meta: { source: "cache", lastSyncedAt: cached.lastSyncedAt, isDisconnected: true },
        });
      }
      return res.status(404).json({
        error: "QuickBooks is disconnected and no cached transaction data is available.",
        isDisconnected: true,
      });
    } catch (cacheError) {
      return res.status(500).json({ error: "Failed to retrieve cached data." });
    }
  }

  const qb = getQBConfig(clientId);
  const headers = {
    Authorization: `Bearer ${qb.accessToken}`,
    Accept: "application/json",
  };

  const base = `${qb.baseUrl}/v3/company/${qb.realmId}/query`;

  const queries = {
    invoices: "SELECT * FROM Invoice MAXRESULTS 50",
    payments: "SELECT * FROM Payment MAXRESULTS 50",
    bills: "SELECT * FROM Bill MAXRESULTS 50",
    purchases: "SELECT * FROM Purchase MAXRESULTS 50",
    deposits: "SELECT * FROM Deposit MAXRESULTS 50",
  };

  const results = {};

  try {
    for (const key in queries) {
      try {
        const response = await axios.get(base, {
          headers,
          params: {
            query: queries[key],
            minorversion: 75,
          },
        });

        results[key] = response.data.QueryResponse || {};
      } catch (err) {
        console.error(`${key} error:`, err.response?.data);

        results[key] = {
          error: err.response?.data,
        };
      }
    }

    // Cache the combined transaction results
    const { upsertSyncedReport } = require("../../../services/quickbooksSyncStore");
    upsertSyncedReport({
      companyId: clientId,
      reportType: "transactions",
      reportParams: {},
      data: results,
    }).catch(err => console.error("[CashFlow] Transaction cache failed:", err.message));

    res.json(results);
  } catch (error) {
    console.error("Transactions API Error:", error);

    res.status(500).json({
      error: "Failed to fetch transactions",
    });
  }
});

/**
 * @swagger
 * /qb-cashflow:
 *   get:
 *     tags:
 *       - Cashflow
 *     summary: Fetch Cash Flow report
 *     description: Returns QuickBooks cash flow report. Filters are optional.
 *     parameters:
 *       - in: query
 *         name: start_date
 *         schema:
 *           type: string
 *           example: 2026-01-01
 *         required: false
 *         description: Report start date
 *       - in: query
 *         name: end_date
 *         schema:
 *           type: string
 *           example: 2026-03-31
 *         required: false
 *         description: Report end date
 *       - in: query
 *         name: accounting_method
 *         schema:
 *           type: string
 *           example: Accrual
 *         required: false
 *         description: Accounting method (Cash or Accrual)
 */
router.get("/qb-cashflow", async (req, res) => {
  const clientId = req.clientId;
  const { start_date, end_date, accounting_method } = req.query;

  // If QB is disconnected, serve cached data
  if (req.qbDisconnected) {
    try {
      const cached = await serveCachedReport(
        clientId,
        REPORT_TYPES.CASH_FLOW,
        { start_date, end_date, accounting_method }
      );
      if (cached) {
        return res.json({
          ...cached.data,
          _meta: { source: "cache", lastSyncedAt: cached.lastSyncedAt, isDisconnected: true },
        });
      }
      return res.status(404).json({
        error: "QuickBooks is disconnected and no cached cash flow data is available.",
        isDisconnected: true,
      });
    } catch (cacheError) {
      return res.status(500).json({ error: "Failed to retrieve cached data." });
    }
  }

  try {
    const result = await fetchAndCacheReport(
      clientId,
      REPORT_TYPES.CASH_FLOW,
      "CashFlow",
      { start_date, end_date, accounting_method }
    );

    res.json(result.data);
  } catch (error) {
    console.error("CashFlow API Error:", error.response?.data || error.message);
    res.status(error.response?.status || 500).json({
      error: "Failed to fetch cash flow report",
      details: error.response?.data || error.message,
    });
  }
});

/**
 * @swagger
 * /qb-accounts:
 *   get:
 *     tags:
 *       - Cashflow
 *     summary: Fetch accounts from QuickBooks
 *     description: Fetch QuickBooks accounts using Metadata.CreateTime filter.
 *     parameters:
 *       - in: query
 *         name: created_after
 *         schema:
 *           type: string
 *           example: 2014-03-31
 *         description: Fetch accounts created after this date
 */

router.get("/qb-accounts", async (req, res) => {
  const clientId = req.clientId;

  // If QB is disconnected, serve cached data
  if (req.qbDisconnected) {
    try {
      const cached = await serveCachedReport(clientId, "accounts");
      if (cached) {
        return res.json({
          ...cached.data,
          _meta: { source: "cache", lastSyncedAt: cached.lastSyncedAt, isDisconnected: true },
        });
      }
      return res.status(404).json({
        error: "QuickBooks is disconnected and no cached accounts data is available.",
        isDisconnected: true,
      });
    } catch (cacheError) {
      return res.status(500).json({ error: "Failed to retrieve cached data." });
    }
  }

  try {
    const result = await fetchAndCacheQuery(
      clientId,
      "accounts",
      `select * from Account where Metadata.CreateTime > '${req.query.created_after || "2014-03-31"}'`
    );

    res.json(result.data);
  } catch (error) {
    console.error(
      "Accounts API Error:",
      JSON.stringify(error.response?.data || error.message, null, 2),
    );

    res.status(500).json({
      error: "Failed to fetch accounts",
      details: error.response?.data,
    });
  }
});

/**
 * @swagger
 * /qb-cashflow-engine:
 *   get:
 *     tags:
 *       - Cashflow
 *     summary: Fetch combined QuickBooks financial data
 *     description: Returns transactions, accounts and cashflow report together with filters.
 *     parameters:
 *       - in: query
 *         name: start_date
 *         schema:
 *           type: string
 *           example: 2026-01-01
 *       - in: query
 *         name: end_date
 *         schema:
 *           type: string
 *           example: 2026-03-31
 *       - in: query
 *         name: accounting_method
 *         schema:
 *           type: string
 *           example: Accrual
 *       - in: query
 *         name: created_after
 *         schema:
 *           type: string
 *           example: 2014-03-31
 */

router.get("/qb-cashflow-engine", async (req, res) => {
  const clientId = req.clientId;

  // If QB is disconnected, serve cached data
  if (req.qbDisconnected) {
    try {
      const cached = await serveCachedReport(clientId, "cashflow_engine");
      if (cached) {
        return res.json({
          ...cached.data,
          _meta: { source: "cache", lastSyncedAt: cached.lastSyncedAt, isDisconnected: true },
        });
      }
      return res.status(404).json({
        error: "QuickBooks is disconnected and no cached engine data is available.",
        isDisconnected: true,
      });
    } catch (cacheError) {
      return res.status(500).json({ error: "Failed to retrieve cached data." });
    }
  }

  const qb = getQBConfig(clientId);

  try {
    const { start_date, end_date, accounting_method, created_after } = req.query;

    async function fetchCombined(accessToken) {
      const headers = {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      };
      const baseQuery = `${qb.baseUrl}/v3/company/${qb.realmId}/query`;

      const queries = {
        invoices: "SELECT * FROM Invoice MAXRESULTS 50",
        payments: "SELECT * FROM Payment MAXRESULTS 50",
        bills: "SELECT * FROM Bill MAXRESULTS 50",
        purchases: "SELECT * FROM Purchase MAXRESULTS 50",
        deposits: "SELECT * FROM Deposit MAXRESULTS 50",
      };

      const transactions = {};

      for (const key in queries) {
        const response = await axios.get(baseQuery, {
          headers,
          params: {
            query: queries[key],
            minorversion: 75,
          },
        });

        transactions[key] = response.data.QueryResponse || {};
      }

      const cashflowResponse = await axios.get(
        `${qb.baseUrl}/v3/company/${qb.realmId}/reports/CashFlow`,
        {
          headers,
          params: {
            start_date,
            end_date,
            accounting_method,
          },
        },
      );

      const createdAfter = created_after || "2014-03-31";
      const accountQuery = `select * from Account where Metadata.CreateTime > '${createdAfter}'`;

      const accountsResponse = await axios.get(baseQuery, {
        headers: {
          ...headers,
          "Content-Type": "text/plain",
        },
        params: {
          query: accountQuery,
          minorversion: 75,
        },
      });

      return {
        filtersUsed: {
          start_date,
          end_date,
          accounting_method,
          created_after,
        },
        transactions,
        cashflow: cashflowResponse.data,
        accounts: accountsResponse.data,
      };
    }

    let payload;
    try {
      payload = await fetchCombined(qb.accessToken);
    } catch (innerError) {
      if (innerError.response?.status === 401) {
        const newAccessToken = await tokenManager.refreshAccessToken(clientId);
        payload = await fetchCombined(newAccessToken);
      } else {
        throw innerError;
      }
    }

    // Cache the combined result
    const { upsertSyncedReport } = require("../../../services/quickbooksSyncStore");
    upsertSyncedReport({
      companyId: clientId,
      reportType: "cashflow_engine",
      reportParams: { start_date, end_date, accounting_method, created_after },
      data: payload,
    }).catch(err => console.error("[CashFlow] Engine cache failed:", err.message));

    return res.json(payload);
  } catch (error) {
    console.error("Combined API Error:", error.response?.data || error.message);

    res.status(error.response?.status || 500).json({
      error: "Failed to fetch combined QuickBooks data",
      details: error.response?.data || error.message,
    });
  }
});

module.exports = router;
