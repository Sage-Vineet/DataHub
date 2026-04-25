/**
 * Universal Bank Statement Parser
 *
 * ARCHITECTURE:
 *   For XLS/XLSX files:
 *     1. DIRECT PARSE (preferred) — detects column headers and extracts
 *        transactions structurally. No AI call needed. Supports HDFC, SBI,
 *        ICICI, Axis, Kotak, and any bank using standard Debit/Credit columns.
 *     2. AI FALLBACK — for unrecognized formats, emits labeled column text
 *        so the AI understands what each column means.
 *
 *   For PDF files:
 *     - Always uses AI (page text → Claude API).
 *
 * Browser → Your backend (/parse-bank-statement) → Anthropic API
 *
 * BACKEND ROUTE  →  POST /parse-bank-statement
 *   const Anthropic = require("@anthropic-ai/sdk");
 *   const client = new Anthropic();
 *   app.post("/parse-bank-statement", async (req, res) => {
 *     try {
 *       const { systemPrompt, userMessage } = req.body;
 *       const msg = await client.messages.create({
 *         model: "claude-sonnet-4-20250514",
 *         max_tokens: 8192,
 *         system: systemPrompt,
 *         messages: [{ role: "user", content: userMessage }],
 *       });
 *       const text = msg.content.filter(b => b.type === "text").map(b => b.text).join("");
 *       const cleaned = text.replace(/^```(?:json)?\s*|```\s*$/gm, "").trim();
 *       res.json({ transactions: JSON.parse(cleaned) });
 *     } catch (err) {
 *       res.status(500).json({ error: err.message });
 *     }
 *   });
 */

const API_BASE_URL =
  typeof import.meta !== "undefined" && import.meta.env?.VITE_API_BASE_URL
    ? import.meta.env.VITE_API_BASE_URL
    : "http://localhost:4000";

const PARSE_ENDPOINT = `${API_BASE_URL}/parse-bank-statement`;

function getStoredToken() {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem("leo-auth-token");
}

const PAGES_PER_CHUNK = 6;
const PAGE_OVERLAP = 1;
const SINGLE_REQUEST_MAX_LINES = 500;

const SYSTEM_PROMPT = `You are a universal bank statement parser. Your task is to extract EVERY transaction from the bank statement text provided and return them as a JSON array.

CRITICAL — READ THIS CAREFULLY:
1. Return ONLY a raw JSON array. Absolutely no markdown, no backticks, no explanation text. Start with [ and end with ].
2. Extract ALL transactions without exception. Do NOT stop early. Do NOT summarize. Do NOT skip any row.
3. Each transaction object must have EXACTLY these 6 fields:
   { "date": "YYYY-MM-DD", "name": "description", "amount": 1234.56, "type": "debit" or "credit", "reference": "ref number or empty string", "balance": 12345.67 or null }
4. Date: convert DD/MM/YYYY → YYYY-MM-DD, "15 Jan 2026" → "2026-01-15", DD/MM/YY → YYYY-MM-DD.
5. Amount: credits/deposits = POSITIVE. debits/withdrawals = NEGATIVE.
6. Separate columns: if Withdrawal and Deposit are separate columns, withdrawal = negative, deposit = positive.
7. Strip currency symbols (₹ $ £ €) and comma separators. "1,23,456.78" → 123456.78
8. SKIP: column headers, opening/closing balance summary rows, account info lines, blank lines, page markers.
9. If a description spans multiple lines, join them into one "name" string.
10. If zero transactions in chunk, return exactly: []
11. HDFC: "Chq/Ref No" = reference. Narration = name.`;

// ─── AI call ──────────────────────────────────────────────────────────────────

async function parseChunkViaBackend(text, bankHint, headers = {}) {
  const userMessage = bankHint ? `Bank: ${bankHint}\n\n${text}` : text;
  const token = getStoredToken();
  const response = await fetch(PARSE_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token
        ? {
            Authorization: `Bearer ${token}`,
            "X-Access-Token": token,
            "X-Auth-Token": token,
            "X-Token": token,
          }
        : {}),
      ...headers,
    },
    body: JSON.stringify({ systemPrompt: SYSTEM_PROMPT, userMessage }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err?.error || err?.message || `HTTP ${response.status}`);
  }
  const data = await response.json();
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.transactions)) return data.transactions;
  const raw =
    typeof data.result === "string"
      ? data.result
      : typeof data.text === "string"
        ? data.text
        : "";
  if (!raw) return [];
  const cleaned = raw.replace(/^```(?:json)?\s*|```\s*$/gm, "").trim();
  try {
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    console.warn(
      "[bankParser] Could not parse AI response:",
      cleaned.slice(0, 400),
    );
    return [];
  }
}

// ─── Bank name detection ──────────────────────────────────────────────────────

export function detectBankName(text) {
  const lower = text.toLowerCase();
  const BANKS = [
    { keywords: ["hdfc bank", "hdfc"], label: "HDFC Bank" },
    { keywords: ["state bank of india"], label: "State Bank of India" },
    { keywords: ["icici bank", "icici"], label: "ICICI Bank" },
    { keywords: ["axis bank"], label: "Axis Bank" },
    {
      keywords: ["kotak mahindra bank", "kotak mahindra"],
      label: "Kotak Mahindra Bank",
    },
    { keywords: ["punjab national bank"], label: "Punjab National Bank" },
    { keywords: ["bank of baroda"], label: "Bank of Baroda" },
    { keywords: ["union bank of india"], label: "Union Bank of India" },
    { keywords: ["bank of india"], label: "Bank of India" },
    { keywords: ["canara bank"], label: "Canara Bank" },
    { keywords: ["idfc first bank"], label: "IDFC First Bank" },
    { keywords: ["indusind bank"], label: "IndusInd Bank" },
    { keywords: ["yes bank"], label: "Yes Bank" },
    { keywords: ["federal bank"], label: "Federal Bank" },
    { keywords: ["rbl bank"], label: "RBL Bank" },
    { keywords: ["bandhan bank"], label: "Bandhan Bank" },
    { keywords: ["indian bank"], label: "Indian Bank" },
    {
      keywords: ["au small finance bank", "au bank"],
      label: "AU Small Finance Bank",
    },
    { keywords: ["karnataka bank"], label: "Karnataka Bank" },
    { keywords: ["south indian bank"], label: "South Indian Bank" },
    { keywords: ["saraswat bank"], label: "Saraswat Bank" },
    { keywords: ["sbi"], label: "State Bank of India" },
    { keywords: ["pnb"], label: "Punjab National Bank" },
    { keywords: ["jpmorgan chase", "chase bank"], label: "JPMorgan Chase" },
    { keywords: ["bank of america"], label: "Bank of America" },
    { keywords: ["wells fargo"], label: "Wells Fargo" },
    { keywords: ["citibank"], label: "Citibank" },
    { keywords: ["standard chartered"], label: "Standard Chartered" },
    { keywords: ["hsbc"], label: "HSBC" },
    { keywords: ["barclays"], label: "Barclays" },
    { keywords: ["deutsche bank"], label: "Deutsche Bank" },
  ];
  for (const bank of BANKS) {
    if (bank.keywords.some((kw) => lower.includes(kw))) return bank.label;
  }
  return "";
}

// ─── Sanitize & deduplicate ───────────────────────────────────────────────────

function sanitize(txn) {
  if (!txn || typeof txn !== "object") return null;
  const date = String(txn.date ?? "").trim();
  const name = String(txn.name ?? "").trim();
  const amount = Number(txn.amount);
  const type = txn.type === "credit" ? "credit" : "debit";
  const reference = String(txn.reference ?? "").trim();
  const balance =
    txn.balance != null && !Number.isNaN(Number(txn.balance))
      ? Number(txn.balance)
      : null;
  if (!date || date === "null" || date === "undefined") return null;
  if (!name) return null;
  if (Number.isNaN(amount)) return null;
  return { date, name, amount, type, reference, balance };
}

function deduplicate(transactions) {
  const seen = new Set();
  return transactions.filter((txn) => {
    const balanceKey = txn.balance !== null ? txn.balance.toFixed(2) : "no-bal";
    const refKey = txn.reference || balanceKey;
    const key = `${txn.date}||${txn.name.toLowerCase().trim()}||${txn.amount}||${refKey}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── PDF chunking ─────────────────────────────────────────────────────────────

function groupSectionsIntoChunks(sections) {
  const step = PAGES_PER_CHUNK - PAGE_OVERLAP;
  const groups = [];
  for (let i = 0; i < sections.length; i += step) {
    const slice = sections.slice(i, i + PAGES_PER_CHUNK);
    groups.push({
      label: `pages ${i + 1}–${i + slice.length}`,
      text: slice.map((s) => s.text).join("\n"),
    });
  }
  return groups;
}

// ─────────────────────────────────────────────────────────────────────────────
// DIRECT STRUCTURED PARSERS (no AI needed for XLS/XLSX)
// ─────────────────────────────────────────────────────────────────────────────

/** Parse DD/MM/YY or DD/MM/YYYY → YYYY-MM-DD */
function parseIndianDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (!m) return null;
  let [, dd, mm, yy] = m;
  if (yy.length === 2) yy = `20${yy}`;
  return `${yy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

/** Strip currency symbols and commas, return float or null */
function parseAmount(raw) {
  if (raw == null || raw === "") return null;
  const n = Number(String(raw).replace(/[₹$£€,\s]/g, ""));
  return Number.isNaN(n) ? null : n;
}

function isSeparatorCell(v) {
  const s = String(v ?? "").trim();
  return s === "" || /^\*+$/.test(s);
}

// ── HDFC ──────────────────────────────────────────────────────────────────────
// Columns: Date | Narration | Chq./Ref.No. | Value Dt | Withdrawal Amt. | Deposit Amt. | Closing Balance

function detectHdfcHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const joined = rows[i].map((c) => String(c ?? "").toLowerCase()).join(" ");
    if (
      joined.includes("narration") &&
      joined.includes("withdrawal") &&
      joined.includes("deposit") &&
      joined.includes("closing balance")
    )
      return i;
  }
  return -1;
}

function parseHdfc(rows, headerIdx) {
  const transactions = [];
  for (let i = headerIdx + 2; i < rows.length; i++) {
    const row = rows[i];
    if (isSeparatorCell(row[0])) continue;
    const date = parseIndianDate(row[0]);
    if (!date) continue;
    const narration = String(row[1] ?? "").trim();
    const refNo = String(row[2] ?? "").trim();
    const withdrawal = parseAmount(row[4]);
    const deposit = parseAmount(row[5]);
    const balance = parseAmount(row[6]);
    if (withdrawal == null && deposit == null) continue;
    if (withdrawal != null && withdrawal !== 0) {
      transactions.push({
        date,
        name: narration || "Unknown",
        amount: -Math.abs(withdrawal),
        type: "debit",
        reference: refNo,
        balance,
      });
    }
    if (deposit != null && deposit !== 0) {
      transactions.push({
        date,
        name: narration || "Unknown",
        amount: Math.abs(deposit),
        type: "credit",
        reference: refNo,
        balance,
      });
    }
  }
  return transactions;
}

// ── SBI ───────────────────────────────────────────────────────────────────────
// Columns: Txn Date | Value Date | Description | Ref No./Cheque No. | Debit | Credit | Balance

function detectSbiHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const joined = rows[i].map((c) => String(c ?? "").toLowerCase()).join(" ");
    if (
      joined.includes("txn date") &&
      joined.includes("debit") &&
      joined.includes("credit") &&
      joined.includes("balance")
    )
      return i;
  }
  return -1;
}

function parseSbi(rows, headerIdx) {
  const transactions = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (isSeparatorCell(row[0])) continue;
    const date = parseIndianDate(row[0]);
    if (!date) continue;
    const desc = String(row[2] ?? "").trim();
    const refNo = String(row[3] ?? "").trim();
    const debit = parseAmount(row[4]);
    const credit = parseAmount(row[5]);
    const balance = parseAmount(row[6]);
    if (debit != null && debit !== 0) {
      transactions.push({
        date,
        name: desc || "Unknown",
        amount: -Math.abs(debit),
        type: "debit",
        reference: refNo,
        balance,
      });
    }
    if (credit != null && credit !== 0) {
      transactions.push({
        date,
        name: desc || "Unknown",
        amount: Math.abs(credit),
        type: "credit",
        reference: refNo,
        balance,
      });
    }
  }
  return transactions;
}

// ── ICICI ─────────────────────────────────────────────────────────────────────
// Columns: Transaction Date | Transaction Remarks | Withdrawal Amount (INR) | Deposit Amount (INR) | Balance (INR)

function detectIciciHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const joined = rows[i].map((c) => String(c ?? "").toLowerCase()).join(" ");
    if (
      joined.includes("transaction date") &&
      joined.includes("transaction remarks") &&
      joined.includes("withdrawal amount")
    )
      return i;
  }
  return -1;
}

function parseIcici(rows, headerIdx) {
  const transactions = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (isSeparatorCell(row[0])) continue;
    const date = parseIndianDate(row[0]);
    if (!date) continue;
    const desc = String(row[1] ?? "").trim();
    const withdrawal = parseAmount(row[2]);
    const deposit = parseAmount(row[3]);
    const balance = parseAmount(row[4]);
    if (withdrawal == null && deposit == null) continue;
    if (withdrawal != null && withdrawal !== 0) {
      transactions.push({
        date,
        name: desc || "Unknown",
        amount: -Math.abs(withdrawal),
        type: "debit",
        reference: "",
        balance,
      });
    }
    if (deposit != null && deposit !== 0) {
      transactions.push({
        date,
        name: desc || "Unknown",
        amount: Math.abs(deposit),
        type: "credit",
        reference: "",
        balance,
      });
    }
  }
  return transactions;
}

// ── Axis Bank ─────────────────────────────────────────────────────────────────
// Columns: Tran Date | CHQNO | PARTICULARS | DR | CR | BAL

function detectAxisHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const joined = rows[i].map((c) => String(c ?? "").toLowerCase()).join(" ");
    if (
      joined.includes("tran date") &&
      (joined.includes(" dr") || joined.includes(" cr")) &&
      joined.includes("bal")
    )
      return i;
  }
  return -1;
}

function parseAxis(rows, headerIdx) {
  const headers = rows[headerIdx].map((c) =>
    String(c ?? "")
      .toLowerCase()
      .trim(),
  );
  const colDate = headers.findIndex(
    (h) => h.includes("tran date") || h === "date",
  );
  const colDesc = headers.findIndex(
    (h) =>
      h.includes("particular") ||
      h.includes("narration") ||
      h.includes("description"),
  );
  const colRef = headers.findIndex(
    (h) => h.includes("chq") || h.includes("ref"),
  );
  const colDr = headers.findIndex(
    (h) => h === "dr" || h === "debit" || h.includes("withdrawal"),
  );
  const colCr = headers.findIndex(
    (h) => h === "cr" || h === "credit" || h.includes("deposit"),
  );
  const colBal = headers.findIndex((h) => h === "bal" || h.includes("balance"));
  if (colDate < 0 || colDr < 0 || colCr < 0) return null;
  const transactions = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (isSeparatorCell(row[colDate])) continue;
    const date = parseIndianDate(row[colDate]);
    if (!date) continue;
    const desc = colDesc >= 0 ? String(row[colDesc] ?? "").trim() : "Unknown";
    const refNo = colRef >= 0 ? String(row[colRef] ?? "").trim() : "";
    const dr = parseAmount(row[colDr]);
    const cr = parseAmount(row[colCr]);
    const balance = colBal >= 0 ? parseAmount(row[colBal]) : null;
    if (dr != null && dr !== 0) {
      transactions.push({
        date,
        name: desc || "Unknown",
        amount: -Math.abs(dr),
        type: "debit",
        reference: refNo,
        balance,
      });
    }
    if (cr != null && cr !== 0) {
      transactions.push({
        date,
        name: desc || "Unknown",
        amount: Math.abs(cr),
        type: "credit",
        reference: refNo,
        balance,
      });
    }
  }
  return transactions;
}

// ── Kotak Bank ────────────────────────────────────────────────────────────────
// Columns: Transaction Date | Description | Chq / Ref No. | Debit | Credit | Balance

function detectKotakHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const joined = rows[i].map((c) => String(c ?? "").toLowerCase()).join(" ");
    if (
      joined.includes("transaction date") &&
      joined.includes("description") &&
      joined.includes("debit") &&
      joined.includes("credit")
    )
      return i;
  }
  return -1;
}

function parseKotak(rows, headerIdx) {
  const transactions = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (isSeparatorCell(row[0])) continue;
    const date = parseIndianDate(row[0]);
    if (!date) continue;
    const desc = String(row[1] ?? "").trim();
    const refNo = String(row[2] ?? "").trim();
    const debit = parseAmount(row[3]);
    const credit = parseAmount(row[4]);
    const balance = parseAmount(row[5]);
    if (debit != null && debit !== 0) {
      transactions.push({
        date,
        name: desc || "Unknown",
        amount: -Math.abs(debit),
        type: "debit",
        reference: refNo,
        balance,
      });
    }
    if (credit != null && credit !== 0) {
      transactions.push({
        date,
        name: desc || "Unknown",
        amount: Math.abs(credit),
        type: "credit",
        reference: refNo,
        balance,
      });
    }
  }
  return transactions;
}

// ── Single Amount column with Dr/Cr suffix (Bank of India, UCO, some cooperative banks) ──
// Columns: Date | Narration/Description | Ref | Amount | Dr/Cr | Balance

function detectDrCrSuffixHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const joined = rows[i].map((c) => String(c ?? "").toLowerCase()).join(" ");
    if (
      joined.includes("date") &&
      joined.includes("amount") &&
      (joined.includes("dr/cr") ||
        joined.includes("cr/dr") ||
        joined.includes("type"))
    )
      return i;
  }
  return -1;
}

function parseDrCrSuffix(rows, headerIdx) {
  const headers = rows[headerIdx].map((c) =>
    String(c ?? "")
      .toLowerCase()
      .trim(),
  );
  const colDate = headers.findIndex(
    (h) => h === "date" || h.includes("value date") || h.includes("txn date"),
  );
  const colDesc = headers.findIndex(
    (h) =>
      h.includes("narration") ||
      h.includes("description") ||
      h.includes("particulars"),
  );
  const colRef = headers.findIndex(
    (h) => h.includes("ref") || h.includes("chq") || h.includes("cheque"),
  );
  const colAmt = headers.findIndex(
    (h) =>
      h === "amount" || h.includes("amount (inr)") || h.includes("txn amount"),
  );
  const colType = headers.findIndex(
    (h) =>
      h === "type" || h === "dr/cr" || h === "cr/dr" || h.includes("dr / cr"),
  );
  const colBal = headers.findIndex((h) => h.includes("balance"));
  if (colDate < 0 || colAmt < 0 || colType < 0) return null;
  const transactions = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (isSeparatorCell(row[colDate])) continue;
    const date = parseIndianDate(row[colDate]);
    if (!date) continue;
    const desc = colDesc >= 0 ? String(row[colDesc] ?? "").trim() : "Unknown";
    const refNo = colRef >= 0 ? String(row[colRef] ?? "").trim() : "";
    const amt = parseAmount(row[colAmt]);
    const typeRaw = String(row[colType] ?? "")
      .trim()
      .toLowerCase();
    const balance = colBal >= 0 ? parseAmount(row[colBal]) : null;
    if (amt == null || amt === 0) continue;
    const isDebit = typeRaw === "dr" || typeRaw === "debit" || typeRaw === "d";
    transactions.push({
      date,
      name: desc || "Unknown",
      amount: isDebit ? -Math.abs(amt) : Math.abs(amt),
      type: isDebit ? "debit" : "credit",
      reference: refNo,
      balance,
    });
  }
  return transactions;
}

// ── Generic two-column (catch-all for any bank with Debit + Credit columns) ──

function detectGenericHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const joined = rows[i].map((c) => String(c ?? "").toLowerCase()).join(" ");
    if (
      (joined.includes("debit") || joined.includes("withdrawal")) &&
      (joined.includes("credit") || joined.includes("deposit")) &&
      joined.includes("balance")
    )
      return i;
  }
  return -1;
}

function parseGeneric(rows, headerIdx) {
  const headers = rows[headerIdx].map((c) =>
    String(c ?? "")
      .toLowerCase()
      .trim(),
  );
  const colDate = headers.findIndex(
    (h) => h.includes("date") && !h.includes("value"),
  );
  const colDesc = headers.findIndex(
    (h) =>
      h.includes("narration") ||
      h.includes("description") ||
      h.includes("particulars") ||
      h.includes("remarks") ||
      h.includes("details"),
  );
  const colRef = headers.findIndex(
    (h) =>
      h.includes("ref") ||
      h.includes("chq") ||
      h.includes("cheque") ||
      h.includes("utr"),
  );
  const colDebit = headers.findIndex(
    (h) => h.includes("debit") || h.includes("withdrawal"),
  );
  const colCredit = headers.findIndex(
    (h) => h.includes("credit") || h.includes("deposit"),
  );
  const colBalance = headers.findIndex((h) => h.includes("balance"));
  if (colDate < 0 || colDebit < 0 || colCredit < 0) return null;
  const transactions = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (isSeparatorCell(row[colDate])) continue;
    const date = parseIndianDate(row[colDate]);
    if (!date) continue;
    const desc = colDesc >= 0 ? String(row[colDesc] ?? "").trim() : "Unknown";
    const refNo = colRef >= 0 ? String(row[colRef] ?? "").trim() : "";
    const debit = parseAmount(row[colDebit]);
    const credit = parseAmount(row[colCredit]);
    const balance = colBalance >= 0 ? parseAmount(row[colBalance]) : null;
    if (debit != null && debit !== 0) {
      transactions.push({
        date,
        name: desc || "Unknown",
        amount: -Math.abs(debit),
        type: "debit",
        reference: refNo,
        balance,
      });
    }
    if (credit != null && credit !== 0) {
      transactions.push({
        date,
        name: desc || "Unknown",
        amount: Math.abs(credit),
        type: "credit",
        reference: refNo,
        balance,
      });
    }
  }
  return transactions;
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

function tryDirectParse(rows) {
  // Try each known format in priority order
  const attempts = [
    () => {
      const i = detectHdfcHeader(rows);
      if (i >= 0) {
        const t = parseHdfc(rows, i);
        if (t.length)
          return { format: "HDFC Bank", transactions: t, headerIdx: i };
      }
      return null;
    },
    () => {
      const i = detectSbiHeader(rows);
      if (i >= 0) {
        const t = parseSbi(rows, i);
        if (t.length)
          return {
            format: "State Bank of India",
            transactions: t,
            headerIdx: i,
          };
      }
      return null;
    },
    () => {
      const i = detectIciciHeader(rows);
      if (i >= 0) {
        const t = parseIcici(rows, i);
        if (t.length)
          return { format: "ICICI Bank", transactions: t, headerIdx: i };
      }
      return null;
    },
    () => {
      const i = detectAxisHeader(rows);
      if (i >= 0) {
        const t = parseAxis(rows, i);
        if (t && t.length)
          return { format: "Axis Bank", transactions: t, headerIdx: i };
      }
      return null;
    },
    () => {
      const i = detectKotakHeader(rows);
      if (i >= 0) {
        const t = parseKotak(rows, i);
        if (t.length)
          return {
            format: "Kotak Mahindra Bank",
            transactions: t,
            headerIdx: i,
          };
      }
      return null;
    },
    () => {
      const i = detectDrCrSuffixHeader(rows);
      if (i >= 0) {
        const t = parseDrCrSuffix(rows, i);
        if (t && t.length)
          return { format: "Generic (Dr/Cr)", transactions: t, headerIdx: i };
      }
      return null;
    },
    () => {
      const i = detectGenericHeader(rows);
      if (i >= 0) {
        const t = parseGeneric(rows, i);
        if (t && t.length)
          return { format: "Generic", transactions: t, headerIdx: i };
      }
      return null;
    },
  ];
  for (const attempt of attempts) {
    const result = attempt();
    if (result) return result;
  }
  return null;
}

// ── Text representation for AI fallback ──────────────────────────────────────

function rowsToLabeledText(rows, headerIdx) {
  if (headerIdx < 0) {
    return rows
      .map((row, i) => {
        const vals = row.map((c) => String(c ?? "").trim()).filter(Boolean);
        return vals.length ? `Row ${i + 1}: ${vals.join(" | ")}` : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  const colNames = rows[headerIdx].map((c) => String(c ?? "").trim());
  const lines = ["COLUMNS: " + colNames.join(" | "), "---"];
  for (let i = headerIdx + 2; i < rows.length; i++) {
    const row = rows[i];
    if (row.every((c) => isSeparatorCell(c))) continue;
    const labeled = colNames
      .map((col, j) => {
        const v = String(row[j] ?? "").trim();
        return v ? `${col}: ${v}` : "";
      })
      .filter(Boolean)
      .join(" | ");
    if (labeled) lines.push(labeled);
  }
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTED: readExcelFile  (drop-in replacement)
// ─────────────────────────────────────────────────────────────────────────────

export const readExcelFile = async (file, password) => {
  const XLSX = await import("xlsx");
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, {
    type: "array",
    password,
    cellDates: false,
    raw: true,
  });

  return workbook.SheetNames.map((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      defval: "",
      raw: true,
    });

    const directResult = tryDirectParse(rows);

    if (directResult) {
      const summaryText = rowsToLabeledText(rows, directResult.headerIdx);
      return {
        title: sheetName,
        text: summaryText,
        rowCount: rows.length,
        transactions: directResult.transactions, // ← pre-parsed, use directly
        bankFormat: directResult.format,
        directlyParsed: true,
      };
    }

    // Fallback: labeled text for AI
    const genericIdx = detectGenericHeader(rows);
    const fallbackText =
      genericIdx >= 0
        ? rowsToLabeledText(rows, genericIdx)
        : rows
            .map((row) =>
              row
                .map((c) => String(c ?? "").trim())
                .filter(Boolean)
                .join(" | "),
            )
            .filter(Boolean)
            .join("\n");

    return {
      title: sheetName,
      text: fallbackText || "No readable rows found in this sheet.",
      rowCount: rows.length,
      transactions: null,
      directlyParsed: false,
    };
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTED: parseAllSections  (used for PDF, and Excel AI fallback)
// ─────────────────────────────────────────────────────────────────────────────

export async function parseAllSections(
  sections,
  onProgress = null,
  extraHeaders = {},
) {
  const validSections = sections.filter((s) => s.text?.trim().length >= 10);
  if (validSections.length === 0) {
    return {
      bankName: "",
      transactions: [],
      parseErrors: ["No readable content found in the file."],
    };
  }

  const fullText = validSections.map((s) => s.text).join("\n");
  const bankName = detectBankName(fullText);
  const parseErrors = [];
  const allTransactions = [];
  const totalLines = fullText.split("\n").length;

  if (onProgress)
    onProgress(
      bankName
        ? `Detected ${bankName} — preparing to parse...`
        : `Preparing to parse ${validSections.length} page(s)...`,
    );

  if (totalLines <= SINGLE_REQUEST_MAX_LINES) {
    if (onProgress) onProgress("Parsing all transactions in one pass...");
    try {
      const raw = await parseChunkViaBackend(fullText, bankName, extraHeaders);
      allTransactions.push(...raw.map(sanitize).filter(Boolean));
    } catch (err) {
      console.error("[bankParser] Single-pass error:", err.message);
      parseErrors.push(`Full document: ${err.message}`);
    }
  } else {
    const chunks = groupSectionsIntoChunks(validSections);
    if (onProgress)
      onProgress(
        `Large file — splitting into ${chunks.length} chunk(s) with overlap...`,
      );
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const pct = Math.round(((i + 1) / chunks.length) * 100);
      if (onProgress)
        onProgress(
          `Parsing chunk ${i + 1}/${chunks.length} (${chunk.label}) — ${pct}%...`,
        );
      try {
        const raw = await parseChunkViaBackend(
          chunk.text,
          bankName,
          extraHeaders,
        );
        allTransactions.push(...raw.map(sanitize).filter(Boolean));
      } catch (err) {
        console.error(`[bankParser] Chunk ${i + 1} error:`, err.message);
        parseErrors.push(`Chunk ${i + 1} (${chunk.label}): ${err.message}`);
      }
    }
  }

  const deduped = deduplicate(allTransactions);
  deduped.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (onProgress)
    onProgress(
      `Complete — ${deduped.length} transaction${deduped.length !== 1 ? "s" : ""} extracted.`,
    );
  console.log(
    `[bankParser] Total raw: ${allTransactions.length} → after dedup: ${deduped.length}`,
  );
  return { bankName, transactions: deduped, parseErrors };
}
