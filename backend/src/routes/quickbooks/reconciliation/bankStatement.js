const express = require("express");
const router = express.Router();
const multer = require("multer");
const fs = require("fs");
const XLSX = require("xlsx");
const path = require("path");
const os = require("os");
const pool = require("../../../db");

const uploadDir = path.join(os.tmpdir(), "leo-bank-uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
const upload = multer({ dest: uploadDir });

const normalizeAmount = (value) => {
  if (value === undefined || value === null || value === "") return 0;
  if (typeof value === "number") return value;
  const parsed = parseFloat(String(value).replace(/,/g, "").trim());
  return Number.isNaN(parsed) ? 0 : parsed;
};

const cleanupFile = (filePath) => {
  if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
};

// ✅ Catches amounts separated by any whitespace (1 or more spaces) at end of line
const extractTrailingAmounts = (line) => {
  const match = line.match(/\s+(-?[\d,]+\.\d{2})\s+(-?[\d,]+\.\d{2})\s*$/);
  if (match) {
    return [normalizeAmount(match[1]), normalizeAmount(match[2])];
  }
  return [];
};

const stripTrailingAmounts = (line) =>
  line.replace(/\s+(-?[\d,]+\.\d{2})\s+(-?[\d,]+\.\d{2})\s*$/, "").trim();

const cleanNarration = (raw) =>
  raw
    .replace(/\b\d{15,16}\b/g, "")
    .replace(/\b000000000000000\b/g, "")
    .replace(/\b\d{2}\/\d{2}\/\d{2,4}\b/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

const parseHdfcText = (text) => {
  const transactions = [];
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const skipPatterns = [
    /^Page No/i,
    /^Account Branch/i,
    /^Address\s*:/i,
    /^SHOP NO/i,
    /^PUNE BANGALORE/i,
    /^MR\s+/i,
    /^State\s*:/i,
    /^B NO\s+/i,
    /^BEHIND\s+/i,
    /^AHMED NAGAR/i,
    /^Email\s*:/i,
    /^AHMADNAGAR/i,
    /^MAHARASHTRA INDIA/i,
    /^A\/C Open Date/i,
    /^JOINT HOLDERS/i,
    /^RTGS\/NEFT/i,
    /^Branch Code/i,
    /^Nomination/i,
    /^From\s*:/i,
    /^Date\s+Narration/i,
    /^HDFC BANK LIMITED/i,
    /^\*Closing balance/i,
    /^Contents of this/i,
    /^this statement/i,
    /^State account branch/i,
    /^HDFC Bank GSTIN/i,
    /^Registered Office/i,
    /^https?:\/\//i,
    /^Account No/i,
    /^Account Status/i,
    /^Account Type/i,
    /^OD Limit/i,
    /^Currency/i,
    /^Cust ID/i,
    /^City\s*:/i,
    /^Phone\s+no/i,
    /^SAVINGS\s+-/i,
    /^VIRTUAL PREFERRED/i,
  ];

  const isSkip = (line) => skipPatterns.some((p) => p.test(line));
  const dateLineRegex = /^(\d{2}\/\d{2}\/\d{2,4})\s+/;

  // Group lines into blocks per transaction
  const blocks = [];
  let current = null;

  for (const line of lines) {
    if (isSkip(line)) continue;
    if (dateLineRegex.test(line)) {
      if (current) blocks.push(current);
      current = { lines: [line] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) blocks.push(current);

  for (const block of blocks) {
    const firstLine = block.lines[0];
    const dateMatch = firstLine.match(/^(\d{2}\/\d{2}\/\d{2,4})/);
    if (!dateMatch) continue;

    const rawDate = dateMatch[1];
    const [dd, mm, yy] = rawDate.split("/");
    const year = yy.length === 2 ? `20${yy}` : yy;
    const txnDate = `${year}-${mm}-${dd}`;

    // Search ALL lines in the block for trailing amounts
    let txnAmount = 0;
    let amountLineIdx = -1;

    for (let i = 0; i < block.lines.length; i++) {
      const amounts = extractTrailingAmounts(block.lines[i]);
      if (amounts.length === 2) {
        txnAmount = amounts[0]; // first = transaction amount, second = closing balance
        amountLineIdx = i;
        break;
      }
    }

    if (txnAmount === 0 || amountLineIdx === -1) {
      console.log(
        "Skipped (no amounts found):",
        rawDate,
        firstLine.slice(0, 60),
      );
      continue;
    }

    // Build narration from all lines, stripping amounts from the amount line
    const narrationParts = block.lines.map((line, idx) => {
      let part =
        idx === 0 ? line.replace(/^\d{2}\/\d{2}\/\d{2,4}\s+/, "") : line;
      if (idx === amountLineIdx) {
        part = stripTrailingAmounts(part);
      }
      return part;
    });

    const narration = cleanNarration(narrationParts.join(" "));
    if (!narration || txnAmount === 0) continue;

    // Determine deposit vs withdrawal by narration keywords
    const depositKeywords =
      /NEFT CR|ACH C-|CASH DEPOSIT|INTEREST PAID|SALARY|TPT-|IMPS.*PAYOUT/i;
    const isDeposit = depositKeywords.test(narration);
    const amount = isDeposit ? txnAmount : -txnAmount;

    transactions.push({ date: txnDate, narration, amount });
  }

  return transactions;
};

router.post(
  "/upload-bank-statement",
  (req, res, next) => {
    if (req.headers["content-type"]?.includes("application/json"))
      return next();
    upload.single("file")(req, res, next);
  },
  async (req, res) => {
    let filePath = "";

    try {
      let transactions = [];

      /* -------------------------
         PDF — text sent as JSON from frontend
      -------------------------- */
      if (req.headers["content-type"]?.includes("application/json")) {
        const { text } = req.body;
        if (!text)
          return res.status(400).json({ error: "No text content provided." });

        transactions = parseHdfcText(text);
        console.log("PDF transactions parsed:", transactions.length);
        console.log(
          "Sample:",
          JSON.stringify(transactions.slice(0, 5), null, 2),
        );
      }

      /* -------------------------
         EXCEL — raw file via FormData
      -------------------------- */
      if (req.file) {
        filePath = req.file.path;
        const lowerFileName = req.file.originalname.toLowerCase();
        const password = req.body.password || "";

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
          const headerRow = rows.find((r) =>
            r.some((c) => String(c).toLowerCase().includes("date")),
          );
          if (headerRow) {
            headerRow.forEach((cell, idx) => {
              const c = String(cell).toLowerCase();
              if (c.includes("date") && !c.includes("value")) dateCol = idx;
              if (c.includes("narration") || c.includes("description"))
                narrationCol = idx;
              if (c.includes("withdrawal") || c.includes("debit"))
                withdrawCol = idx;
              if (c.includes("deposit") || c.includes("credit"))
                depositCol = idx;
            });
          }

          rows.forEach((row) => {
            const date = row[dateCol];
            const narration = row[narrationCol];
            const withdraw = normalizeAmount(row[withdrawCol]);
            const deposit = normalizeAmount(row[depositCol]);

            let amount = 0;
            if (withdraw) amount = -withdraw;
            if (deposit) amount = deposit;

            if (date && narration && amount !== 0) {
              transactions.push({
                date,
                narration: String(narration).trim(),
                amount,
              });
            }
          });
        }
      }

      console.log("Total Transactions Extracted:", transactions.length);

      await pool.query("DELETE FROM bank_transactions WHERE client_id = $1", [
        req.clientId,
      ]);
      for (const txn of transactions) {
        await pool.query(
          `INSERT INTO bank_transactions (client_id, txn_date, narration, amount) VALUES ($1, $2, $3, $4)`,
          [req.clientId, txn.date, txn.narration, txn.amount],
        );
      }

      cleanupFile(filePath);
      res.json({
        message: "Bank statement processed successfully",
        totalRecords: transactions.length,
      });
    } catch (error) {
      console.error("Bank Statement Error:", error);
      cleanupFile(filePath);
      res.status(500).json({
        error: "Failed to process bank statement",
        details: error.message,
      });
    }
  },
);

module.exports = router;
