const express = require("express");
const router = express.Router();
const pool = require("../../../db");

// Middleware to extract clientId with multiple fallbacks
const extractClientId = (req, res, next) => {
  let clientId = req.clientId;
  if (!clientId && req.query.clientId) {
    clientId = req.query.clientId;
  }
  if (!clientId && req.headers.referer) {
    const referer = req.headers.referer;
    const match = referer.match(/\/client\/([^/]+)/);
    if (match) {
      clientId = match[1];
    }
  }
  if (clientId) {
    req.clientId = clientId;
  }
  next();
};

/**
 * @swagger
 * tags:
 *   name: Reconciliation
 *   description: Bank vs Books reconciliation APIs
 */

/**
 * @swagger
 * /api/bank-vs-books:
 *   get:
 *     tags:
 *       - Reconciliation
 *     summary: Bank vs Books transaction matching
 */
router.get("/bank-vs-books", extractClientId, async (req, res) => {
  try {
    if (!req.clientId) {
      return res.status(400).json({ error: "Missing Client ID" });
    }
    const query = `
      SELECT
        b.txn_date AS bank_date,
        b.narration AS bank_narration,
        b.amount AS bank_amount,
        r.txn_date AS book_date,
        r.name AS book_name,
        r.amount AS book_amount,
        CASE
          WHEN r.amount IS NULL THEN 'Unmatched (Bank)'
          WHEN b.amount = r.amount AND b.txn_date = r.txn_date THEN 'Matched'
          ELSE 'Amount Mismatch'
        END AS remark
      FROM bank_transactions b
      LEFT JOIN reconciliation_transactions r
      ON ABS(b.amount) = ABS(r.amount)
      AND b.txn_date = r.txn_date
      AND b.client_id = r.client_id
      WHERE b.client_id = $1
      ORDER BY b.txn_date
    `;

    const result = await pool.query(query, [req.clientId]);
    res.json({ totalRecords: result.rows.length, data: result.rows });
  } catch (error) {
    console.error("Reconciliation Error:", error);
    res.status(500).json({ error: "Failed to reconcile transactions" });
  }
});

/**
 * @swagger
 * /api/reconciliation-data:
 *   get:
 *     tags:
 *       - Reconciliation
 *     summary: Fetch bank and books transactions
 */
router.get("/reconciliation-data", extractClientId, async (req, res) => {
  try {
    if (!req.clientId) {
      return res.status(400).json({ error: "Missing Client ID" });
    }
    const bankData = await pool.query(
      `
      SELECT txn_date AS date, narration AS name, amount
      FROM bank_transactions
      WHERE client_id = $1
      ORDER BY txn_date
    `,
      [req.clientId],
    );

    const booksData = await pool.query(
      `
      SELECT txn_date AS date, name, amount
      FROM reconciliation_transactions
      WHERE client_id = $1
      ORDER BY txn_date
    `,
      [req.clientId],
    );

    res.json({
      bank_transactions: bankData.rows,
      reconciliation_transactions: booksData.rows,
    });
  } catch (error) {
    console.error("Fetch Error:", error);
    res.status(500).json({ error: "Failed to fetch reconciliation data" });
  }
});

/**
 * @swagger
 * /api/reconciliation-variance:
 *   get:
 *     tags:
 *       - Reconciliation
 *     summary: Calculate variance between bank and books
 */
router.get("/reconciliation-variance", extractClientId, async (req, res) => {
  try {
    if (!req.clientId) {
      return res.status(400).json({ error: "Missing Client ID" });
    }
    const result = await pool.query(
      `
      SELECT
        bank_total,
        books_total,
        (bank_total - books_total) AS variance_amount,
        ROUND(((bank_total - books_total) / NULLIF(books_total,0)) * 100,2) AS variance_percentage
      FROM
      (
        SELECT
          (SELECT SUM(amount) FROM bank_transactions WHERE client_id = $1) AS bank_total,
          (SELECT SUM(amount) FROM reconciliation_transactions WHERE client_id = $1) AS books_total
      ) totals
    `,
      [req.clientId],
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Variance Error:", error);
    res.status(500).json({ error: "Failed to calculate variance" });
  }
});

module.exports = router;
