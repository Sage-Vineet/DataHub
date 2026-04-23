const express = require("express");
const router = express.Router();
const multer = require("multer");
const fs = require("fs");
const XLSX = require("xlsx");
const path = require("path");
const os = require("os");
const pool = require("../../../db");

const upload = multer({ dest: os.tmpdir() });

/**
 * Helper to normalize amounts from various string formats
 */
const normalizeAmount = (val) => {
  if (val == null || val === "") return 0;
  if (typeof val === "number") return val;
  // Remove currency symbols, commas and extra spaces
  const cleaned = String(val).replace(/[^\d.-]/g, "");
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
};

/**
 * @swagger
 * /upload-bank-statement:
 *   post:
 *     tags:
 *       - Reconciliation
 *     summary: Upload and parse bank statement (Excel)
 *     description: Extracts transactions from an Excel file and returns them for review.
 */
router.post("/upload-bank-statement", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const filePath = req.file.path;
    const lowerFileName = req.file.originalname.toLowerCase();
    const password = req.body.password || "";
    const transactions = [];

    console.log(`📁 Processing Excel file: ${req.file.originalname}`);

    if (lowerFileName.endsWith(".xlsx") || lowerFileName.endsWith(".xls")) {
      const workbook = XLSX.readFile(filePath, {
        password: password || undefined,
      });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, {
        header: 1,
        defval: "",
      });

      let dateCol = 0,
        narrationCol = 1,
        withdrawCol = 4,
        depositCol = 5;

      // Attempt to find the header row dynamically
      const headerRow = rows.find((r) =>
        r.some((c) => String(c).toLowerCase().includes("date")),
      );

      if (headerRow) {
        headerRow.forEach((cell, idx) => {
          const c = String(cell).toLowerCase();
          if (c.includes("date") && !c.includes("value")) dateCol = idx;
          if (c.includes("narration") || c.includes("description") || c.includes("particulars"))
            narrationCol = idx;
          if (c.includes("withdrawal") || c.includes("debit") || c.includes("dr"))
            withdrawCol = idx;
          if (c.includes("deposit") || c.includes("credit") || c.includes("cr"))
            depositCol = idx;
        });
      }

      rows.forEach((row) => {
        const date = row[dateCol];
        const narration = row[narrationCol];
        const withdraw = normalizeAmount(row[withdrawCol]);
        const deposit = normalizeAmount(row[depositCol]);

        let amount = 0;
        if (withdraw) amount = -Math.abs(withdraw);
        if (deposit) amount = Math.abs(deposit);

        // Basic validation for a transaction row
        if (date && narration && amount !== 0) {
          transactions.push({
            date: String(date).trim(),
            narration: String(narration).trim(),
            amount,
          });
        }
      });

      console.log(`✓ Excel file processed: ${transactions.length} transactions extracted`);
    } else {
      console.warn(`⚠ Unsupported file format: ${req.file.originalname}`);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      return res.status(400).json({ error: "Unsupported file format. Please upload .xls or .xlsx" });
    }

    // Clean up temporary file
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    res.json({
      success: true,
      message: `${transactions.length} transactions extracted`,
      transactions: transactions
    });

  } catch (error) {
    console.error("Bank Statement Processing Error:", error);
    // Ensure cleanup on error
    if (req.file && req.file.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ 
      error: "Failed to process bank statement", 
      details: error.message 
    });
  }
});

module.exports = router;
