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
  const qb = getQBConfig(req.clientId);

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
  const qb = getQBConfig(req.clientId);
  const accounting_method = normalizeAccountingMethod(req.query.accounting_method);

  try {
    const url = `${qb.baseUrl}/v3/company/${qb.realmId}/reports/CashFlow`;

    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${qb.accessToken}`,
        Accept: "application/json",
      },
      params: {
        start_date: req.query.start_date,
        end_date: req.query.end_date,
        accounting_method,
      },
    });

    res.json(response.data);
  } catch (error) {
    console.error("CashFlow API Error:", error.response?.data || error.message);
    res.status(500).json({ error: "Failed to fetch cash flow report" });
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
  const qb = getQBConfig(req.clientId);

  try {
    const createdAfter = req.query.created_after || "2014-03-31";

    const query = `select * from Account where Metadata.CreateTime > '${createdAfter}'`;

    const url = `${qb.baseUrl}/v3/company/${qb.realmId}/query`;

    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${qb.accessToken}`,
        Accept: "application/json",
        "Content-Type": "text/plain",
      },
      params: {
        query,
        minorversion: 75,
      },
    });

    res.json(response.data);
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
  const qb = getQBConfig(req.clientId);

  const headers = {
    Authorization: `Bearer ${qb.accessToken}`,
    Accept: "application/json",
  };

  try {
    const baseQuery = `${qb.baseUrl}/v3/company/${qb.realmId}/query`;

    const { start_date, end_date, created_after } = req.query;
    const accounting_method = normalizeAccountingMethod(req.query.accounting_method);

    // =============================
    // Transactions queries
    // =============================

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

    // =============================
    // Cashflow report
    // =============================

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

    // =============================
    // Accounts query
    // =============================

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

    // =============================
    // Final combined response
    // =============================

    res.json({
      filtersUsed: {
        start_date,
        end_date,
        accounting_method,
        created_after,
      },

      transactions,
      cashflow: cashflowResponse.data,
      accounts: accountsResponse.data,
    });
  } catch (error) {
    console.error("Combined API Error:", error.response?.data || error.message);

    res.status(500).json({
      error: "Failed to fetch combined QuickBooks data",
    });
  }
});
module.exports = router;
