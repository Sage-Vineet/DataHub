const express = require("express");
const router = express.Router();
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const os = require("os");
const pool = require("../../../db");
const Anthropic = require("@anthropic-ai/sdk");
const anthropicApiKey = (process.env.ANTHROPIC_API_KEY || "").trim();
const client = anthropicApiKey
  ? new Anthropic({ apiKey: anthropicApiKey })
  : null;
const ANTHROPIC_MODEL =
  process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514";

const normalizeAmount = (value) => {
  if (value === undefined || value === null || value === "") return 0;
  if (typeof value === "number") return value;
  const parsed = parseFloat(String(value).replace(/,/g, "").trim());
  return Number.isNaN(parsed) ? 0 : parsed;
};

const stripParseEnvelope = (userMessage = "") => {
  const text = String(userMessage || "");
  const marker = "Statement text:";
  const idx = text.indexOf(marker);
  return idx >= 0 ? text.slice(idx + marker.length).trim() : text.trim();
};

const normalizeDatePart = (value) =>
  String(value || "")
    .trim()
    .replace(/,/g, " ");

const toIsoDate = (value) => {
  const raw = normalizeDatePart(value);
  if (!raw) return "";

  const isoMatch = raw.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  const numericMatch = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (numericMatch) {
    let [, first, second, year] = numericMatch;
    if (year.length === 2) year = `20${year}`;
    const firstNum = Number(first);
    const secondNum = Number(second);
    const dayFirst = firstNum > 12 || secondNum > 12 ? firstNum <= 31 : true;
    const day = dayFirst ? firstNum : secondNum;
    const month = dayFirst ? secondNum : firstNum;
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  const longMonthMatch = raw.match(
    /^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{2,4})$|^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{2,4})$/,
  );
  if (longMonthMatch) {
    const monthLookup = {
      jan: 1,
      january: 1,
      feb: 2,
      february: 2,
      mar: 3,
      march: 3,
      apr: 4,
      april: 4,
      may: 5,
      jun: 6,
      june: 6,
      jul: 7,
      july: 7,
      aug: 8,
      august: 8,
      sep: 9,
      sept: 9,
      september: 9,
      oct: 10,
      october: 10,
      nov: 11,
      november: 11,
      dec: 12,
      december: 12,
    };
    const day = Number(longMonthMatch[1] || longMonthMatch[5]);
    const monthName = (
      longMonthMatch[2] ||
      longMonthMatch[4] ||
      ""
    ).toLowerCase();
    let year = String(longMonthMatch[3] || longMonthMatch[6] || "");
    if (year.length === 2) year = `20${year}`;
    const month = monthLookup[monthName];
    if (month && day) {
      return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }

  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }

  return "";
};

const isNoiseLine = (line) =>
  /^(page\s*\d+|page no|statement period|opening balance|closing balance|account number|account no|branch|date\s+description|txn\s+date|downloaded on|printed on|address\s*:|customer id|ifsc|micr|currency|remarks?|s\.? no\.?)/i.test(
    line,
  ) || line.length < 6;

const extractReference = (text) => {
  const patterns = [
    /\b(?:utr|upi|neft|rtgs|imps|txn|txnid|transaction id|cheque|check|ref|reference)\s*[:\-]?\s*([A-Za-z0-9/-]{4,})/i,
    /\b(?:chq|cheque|check)\s*[:\-]?\s*([A-Za-z0-9/-]{4,})/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1].trim();
  }

  return "";
};

const inferTransactionType = (text, amount) => {
  if (amount < 0) return "debit";
  if (amount > 0) {
    if (
      /\b(cr|credit|deposit|received|receipt|interest|refund|salary|payout)\b/i.test(
        text,
      )
    ) {
      return "credit";
    }
    if (
      /\b(dr|debit|withdraw|withdrawal|payment|paid|fee|charge|transfer|upi|imps|neft|rtgs|ecs|pos|atm)\b/i.test(
        text,
      )
    ) {
      return "debit";
    }
    return "credit";
  }
  return "debit";
};

const normalizeSignedAmount = (rawAmount, text) => {
  const amount = Math.abs(Number(rawAmount) || 0);
  if (amount === 0) return 0;
  if (
    /\b(dr|debit|withdraw|withdrawal|payment|paid|fee|charge|transfer|upi|imps|neft|rtgs|ecs|pos|atm)\b/i.test(
      text,
    )
  ) {
    return -amount;
  }
  if (
    /\b(cr|credit|deposit|received|receipt|interest|refund|salary|payout)\b/i.test(
      text,
    )
  ) {
    return amount;
  }
  return amount;
};

const parseLocalStatement = (userMessage = "") => {
  const text = stripParseEnvelope(userMessage);
  if (!text) return [];

  const lines = text
    .replace(/\r/g, "\n")
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const transactions = [];
  const datePattern =
    /(\d{4}[/-]\d{1,2}[/-]\d{1,2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{2,4}|[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{2,4})/;

  for (const line of lines) {
    if (isNoiseLine(line)) continue;

    const dateMatch = line.match(datePattern);
    if (!dateMatch || dateMatch.index == null) continue;

    const date = toIsoDate(dateMatch[1]);
    if (!date) continue;

    const afterDate = line.slice(dateMatch.index + dateMatch[1].length).trim();
    if (!afterDate) continue;

    const tailMatch = afterDate.match(
      /^(.*?)(-?\d[\d,]*(?:\.\d{1,2})?)(?:\s+(-?\d[\d,]*(?:\.\d{1,2})?))?(?:\s+(CR|DR|C|D))?\s*$/i,
    );
    if (!tailMatch) continue;

    const narration = tailMatch[1].trim().replace(/\s{2,}/g, " ");
    if (
      !narration ||
      /^(opening balance|closing balance|balance carried forward)$/i.test(
        narration,
      )
    ) {
      continue;
    }

    const firstAmount = parseFloat(String(tailMatch[2]).replace(/,/g, ""));
    const secondAmount = tailMatch[3]
      ? parseFloat(String(tailMatch[3]).replace(/,/g, ""))
      : null;
    const typeHint = (tailMatch[4] || "").toUpperCase();

    let amount = normalizeSignedAmount(
      firstAmount,
      `${narration} ${typeHint}`.trim(),
    );
    if (typeHint === "CR" || typeHint === "C") amount = Math.abs(firstAmount);
    if (typeHint === "DR" || typeHint === "D") amount = -Math.abs(firstAmount);

    if (Number.isNaN(amount) || amount === 0) continue;

    const reference = extractReference(narration);
    transactions.push({
      date,
      name: narration,
      amount,
      type: inferTransactionType(narration, amount),
      reference,
      balance:
        secondAmount !== null && !Number.isNaN(secondAmount)
          ? secondAmount
          : null,
    });
  }

  return transactions;
};

const parseAnthropicTransactions = async (systemPrompt, userMessage) => {
  if (!client) {
    return parseLocalStatement(userMessage);
  }

  try {
    const msg = await client.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 8192,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    });
    const text = msg.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    const cleaned = text.replace(/^```(?:json)?\s*|```\s*$/gm, "").trim();
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    const message = String(error?.message || error || "");
    if (
      /could not resolve authentication method|api key|auth token|not configured|invalid authentication/i.test(
        message,
      )
    ) {
      return parseLocalStatement(userMessage);
    }
    throw error;
  }
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

// Middleware to extract clientId from headers/query before processing
const extractClientId = (req, res, next) => {
  let clientId = req.headers["x-client-id"];

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
    console.log(`✓ Client ID extracted: ${clientId}`);
  } else {
    console.warn("⚠ No Client ID found in request headers/query/referer");
  }

  next();
};

router.post(
  "/upload-bank-statement",
  extractClientId,
  (req, res, next) => {
    if (req.headers["content-type"]?.includes("application/json"))
      return next();
    upload.single("file")(req, res, next);
  },
  async (req, res) => {
    let filePath = "";

    try {
      if (!req.clientId) {
        console.error("❌ Missing Client ID in upload-bank-statement");
        return res.status(400).json({
          error:
            "Missing Client ID. Please open the statement from a company workspace.",
        });
      }

      console.log(`📤 Processing bank statement for client: ${req.clientId}`);
      let transactions = [];

      /* -------------------------
         PDF — text sent as JSON from frontend
      -------------------------- */
      if (req.headers["content-type"]?.includes("application/json")) {
        const {
          type,
          text,
          rawText,
          transactions: normalizedTransactions,
        } = req.body;
        const statementText = String(text || rawText || "").trim();

        if (type === "normalized" && Array.isArray(normalizedTransactions)) {
          transactions = normalizedTransactions
            .map(normalizeTransactionRow)
            .filter(Boolean);
          if (!transactions.length && statementText) {
            transactions = parseHdfcText(statementText);
          }
        } else if (statementText) {
          transactions = parseHdfcText(statementText);
          console.log("PDF transactions parsed:", transactions.length);
          console.log(
            "Sample:",
            JSON.stringify(transactions.slice(0, 5), null, 2),
          );
        } else {
          console.warn("Bank statement upload received no parsable text.");
          transactions = [];
        }
      }

      /* -------------------------
         EXCEL — raw file via FormData
      -------------------------- */
      if (req.file) {
        filePath = req.file.path;
        const lowerFileName = req.file.originalname.toLowerCase();
        const password = req.body.password || "";

        console.log(`📁 Processing Excel file: ${req.file.originalname}`);
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
      console.log(
        `✓ Bank statement uploaded successfully for client ${req.clientId}: ${transactions.length} transactions`,
      );
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

router.post("/parse-bank-statement", async (req, res) => {
  try {
    const { systemPrompt, userMessage } = req.body;
    const transactions = await parseAnthropicTransactions(
      systemPrompt,
      userMessage,
    );
    res.json({ transactions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
