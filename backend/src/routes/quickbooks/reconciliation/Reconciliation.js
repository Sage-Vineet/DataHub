const express = require("express");
const axios = require("axios");
const { getQBConfig } = require("../../../qbconfig");
const pool = require("../../../db");

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Reconciliation
 *   description: Bank vs Books reconciliation APIs
 */

/**
 * @swagger
 * /qb-general-ledger:
 *   get:
 *     tags:
 *       - Reconciliation
 *     summary: Fetch General Ledger transactions
 */
router.get("/qb-general-ledger", async (req, res) => {
  const qb = getQBConfig(req.clientId);
  const { start_date, end_date, accounting_method } = req.query;

  try {
    const response = await axios.get(
      `${qb.baseUrl}/v3/company/${qb.realmId}/reports/GeneralLedger`,
      {
        headers: {
          Authorization: `Bearer ${qb.accessToken}`,
          Accept: "application/json",
        },
        proxy: false,
        params: {
          start_date,
          end_date,
          accounting_method,
          minorversion: 75,
        },
      },
    );

    const sections = response.data.Rows?.Row || [];
    const transactions = [];

    sections.forEach((section) => {
      if (!section.Rows) return;
      section.Rows.Row.forEach((txn) => {
        if (txn.type !== "Data") return;
        const col = txn.ColData;
        const date = col[0]?.value;
        const type = col[1]?.value;
        const name = col[3]?.value;
        const amount = col[6]?.value;
        if (date && amount) {
          transactions.push({ date, type, name, amount });
        }
      });
    });

    await pool.query("DELETE FROM reconciliation_transactions WHERE client_id = $1", [req.clientId]);
    for (const txn of transactions) {
      await pool.query(
        `INSERT INTO reconciliation_transactions (client_id, txn_date, amount, name, transaction_type) VALUES ($1,$2,$3,$4,$5)`,
        [req.clientId, txn.date, txn.amount, txn.name, txn.type],
      );
    }

    res.json({ message: "Data stored successfully", totalInserted: transactions.length });
  } catch (error) {
    console.error("GeneralLedger Error:", error);
    res.status(500).json({ error: "Failed to fetch General Ledger" });
  }
});

/**
 * @swagger
 * /qb-reconciliation-transactions:
 *   get:
 *     tags:
 *       - Reconciliation
 *     summary: Fetch transactions for reconciliation
 */
router.get("/qb-reconciliation-transactions", async (req, res) => {
  const qb = getQBConfig(req.clientId);
  const base = `${qb.baseUrl}/v3/company/${qb.realmId}/query`;
  const headers = { Authorization: `Bearer ${qb.accessToken}`, Accept: "application/json" };
  const { start_date, end_date, max_results = 50 } = req.query;

  const queries = {
    invoices: `SELECT * FROM Invoice WHERE TxnDate >= '${start_date}' AND TxnDate <= '${end_date}' MAXRESULTS ${max_results}`,
    payments: `SELECT * FROM Payment WHERE TxnDate >= '${start_date}' AND TxnDate <= '${end_date}' MAXRESULTS ${max_results}`,
    deposits: `SELECT * FROM Deposit WHERE TxnDate >= '${start_date}' AND TxnDate <= '${end_date}' MAXRESULTS ${max_results}`,
    purchases: `SELECT * FROM Purchase WHERE TxnDate >= '${start_date}' AND TxnDate <= '${end_date}' MAXRESULTS ${max_results}`,
  };

  const results = {};
  try {
    for (const key in queries) {
      const response = await axios.get(base, {
        headers,
        proxy: false,
        params: { query: queries[key], minorversion: 75 },
      });
      results[key] = response.data.QueryResponse || {};
    }
    res.json(results);
  } catch (error) {
    console.error("Reconciliation Transactions Error:", error.response?.data || error.message);
    res.status(500).json({ error: "Failed to fetch transactions" });
  }
});

/**
 * @swagger
 * /qb-trial-balance:
 *   get:
 *     tags:
 *       - Reconciliation
 *     summary: Fetch Trial Balance
 */
router.get("/qb-trial-balance", async (req, res) => {
  const qb = getQBConfig(req.clientId);
  try {
    const response = await axios.get(
      `${qb.baseUrl}/v3/company/${qb.realmId}/reports/TrialBalance`,
      {
        headers: { Authorization: `Bearer ${qb.accessToken}`, Accept: "application/json" },
        proxy: false,
        params: {
          start_date: req.query.start_date,
          end_date: req.query.end_date,
          minorversion: 75,
        },
      },
    );
    res.json(response.data);
  } catch (error) {
    console.error("TrialBalance API Error:", error.response?.data || error.message);
    res.status(500).json({ error: "Failed to fetch trial balance" });
  }
});

/**
 * @swagger
 * /qb-reconciliation-engine:
 *   get:
 *     tags:
 *       - Reconciliation
 *     summary: Fetch combined reconciliation data
 */
router.get("/qb-reconciliation-engine", async (req, res) => {
  const qb = getQBConfig(req.clientId);
  const { start_date, end_date, accounting_method } = req.query;
  const headers = { Authorization: `Bearer ${qb.accessToken}`, Accept: "application/json" };

  try {
    const [ledger, accounts, trialBalance] = await Promise.all([
      axios.get(`${qb.baseUrl}/v3/company/${qb.realmId}/reports/GeneralLedger`, {
        headers, proxy: false, params: { start_date, end_date, accounting_method, minorversion: 75 },
      }),
      axios.get(`${qb.baseUrl}/v3/company/${qb.realmId}/reports/AccountList`, {
        headers, proxy: false, params: { minorversion: 75 },
      }),
      axios.get(`${qb.baseUrl}/v3/company/${qb.realmId}/reports/TrialBalance`, {
        headers, proxy: false, params: { start_date, end_date, accounting_method, minorversion: 75 },
      }),
    ]);

    res.json({
      generalLedger: ledger.data,
      accounts: accounts.data,
      trialBalance: trialBalance.data,
    });
  } catch (error) {
    console.error("Reconciliation Engine Error:", error.response?.data || error.message);
    res.status(500).json({ error: "Failed to fetch reconciliation data" });
  }
});

/**
 * @swagger
 * /bank-transactions:
 *   post:
 *     summary: Store bank statement transactions
 */
router.post("/bank-transactions", async (req, res) => {
  const transactions = req.body;
  try {
    await pool.query("DELETE FROM bank_transactions WHERE client_id = $1", [req.clientId]);
    for (const txn of transactions) {
      await pool.query(
        `INSERT INTO bank_transactions (client_id, txn_date, narration, amount) VALUES ($1,$2,$3,$4)`,
        [req.clientId, txn.date, txn.narration, txn.amount],
      );
    }
    res.json({ message: "Bank transactions stored successfully", totalInserted: transactions.length });
  } catch (error) {
    console.error("Bank Transaction Error:", error);
    res.status(500).json({ error: "Failed to store bank transactions" });
  }
});

module.exports = router;
