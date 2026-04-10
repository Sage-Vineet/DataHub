const express = require("express");
const router = express.Router();
const pool = require("../../../db");

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
 *     description: Compares bank statement transactions with QuickBooks transactions using date and amount
 *     responses:
 *       200:
 *         description: Reconciliation data fetched successfully
 *         content:
 *           application/json:
 *             example:
 *               totalRecords: 1
 *               data:
 *                 - bank_date: "2026-01-29"
 *                   bank_narration: "Chin's Gas and Oil"
 *                   bank_amount: -62.01
 *                   book_date: "2026-01-29"
 *                   book_name: "Chin's Gas and Oil"
 *                   book_amount: -62.01
 *                   remark: "Matched"
 *       500:
 *         description: Failed to reconcile transactions
 */

router.get("/bank-vs-books", async (req, res) => {
  try {
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

      ORDER BY b.txn_date
    `;

    const result = await pool.query(query);

    res.json({
      totalRecords: result.rows.length,
      data: result.rows,
    });
  } catch (error) {
    console.error("Reconciliation Error:", error);

    res.status(500).json({
      error: "Failed to reconcile transactions",
    });
  }
});

/**
 * @swagger
 * /api/reconciliation-data:
 *   get:
 *     tags:
 *       - Reconciliation
 *     summary: Fetch bank and books transactions
 *     description: Returns date, name/narration and amount from both bank and reconciliation tables
 *     responses:
 *       200:
 *         description: Transactions fetched successfully
 *       500:
 *         description: Failed to fetch transactions
 */

router.get("/reconciliation-data", async (req, res) => {
  try {
    const bankData = await pool.query(`
      SELECT 
        txn_date AS date,
        narration AS name,
        amount
      FROM bank_transactions
      ORDER BY txn_date
    `);

    const booksData = await pool.query(`
      SELECT
        txn_date AS date,
        name,
        amount
      FROM reconciliation_transactions
      ORDER BY txn_date
    `);

    res.json({
      bank_transactions: bankData.rows,
      reconciliation_transactions: booksData.rows,
    });
  } catch (error) {
    console.error("Fetch Error:", error);

    res.status(500).json({
      error: "Failed to fetch reconciliation data",
    });
  }
});

/**
 * @swagger
 * /api/reconciliation-variance:
 *   get:
 *     tags:
 *       - Reconciliation
 *     summary: Calculate variance between bank and books
 *     description: Returns bank total, books total, variance amount and variance percentage
 */

router.get("/reconciliation-variance", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        bank_total,
        books_total,
        (bank_total - books_total) AS variance_amount,
        ROUND(((bank_total - books_total) / NULLIF(books_total,0)) * 100,2) AS variance_percentage
      FROM
      (
        SELECT
          (SELECT SUM(amount) FROM bank_transactions) AS bank_total,
          (SELECT SUM(amount) FROM reconciliation_transactions) AS books_total
      ) totals
    `);

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Variance Error:", error);

    res.status(500).json({
      error: "Failed to calculate variance",
    });
  }
});
module.exports = router;
