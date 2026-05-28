/**
 * Gemini-powered PDF parser for financial statements.
 * Uses inline PDF data (base64) sent directly to the Gemini multimodal API.
 * Falls back gracefully — callers should catch and fall back to text extraction.
 */
const { GoogleGenerativeAI } = require("@google/generative-ai");

const GEMINI_MODELS = [
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
  "gemini-2.0-flash",
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const BALANCE_SHEET_PROMPT = `You are a financial document parser. Extract ALL data from this Balance Sheet PDF.

Return ONLY a raw JSON object — no markdown, no code fences, no explanation.

Required structure:
{
  "statementType": "balance_sheet",
  "asOfDate": "YYYY-MM-DD",
  "rows": [
    {
      "id": "assets",
      "name": "ASSETS",
      "type": "header",
      "amount": 0,
      "children": [
        {
          "id": "current-assets",
          "name": "Current Assets",
          "type": "header",
          "amount": 0,
          "children": [
            {
              "id": "bank-accounts",
              "name": "Bank Accounts",
              "type": "header",
              "amount": 0,
              "children": [
                {
                  "id": "checking-1",
                  "name": "Business Checking (7454)",
                  "type": "data",
                  "amount": 12345.67
                }
              ]
            },
            {
              "id": "total-bank-accounts",
              "name": "Total Bank Accounts",
              "type": "total",
              "amount": 12345.67
            }
          ]
        },
        {
          "id": "total-current-assets",
          "name": "Total Current Assets",
          "type": "total",
          "amount": 12345.67
        }
      ]
    }
  ]
}

Rules:
- "type": "header"  →  section heading (ASSETS, Current Assets, Bank Accounts, LIABILITIES & EQUITY, etc.)
- "type": "data"    →  individual account line item with a dollar value
- "type": "total"   →  Total rows (Total Assets, Total Current Assets, Total Bank Accounts, etc.)
- "amount"          →  plain number, no $ signs, no commas (negative for liabilities/contra-accounts, e.g. -116747.37)
- Reproduce the EXACT nesting hierarchy shown in the PDF
- Include ALL line items — even those showing zero, dash, or blank (use 0)
- For "header" nodes that contain sub-items, include "children" array
- For "data" and "total" nodes, omit "children" (or use empty array)
- "asOfDate" must be formatted as YYYY-MM-DD (e.g. "2025-03-31")
- Give each node a short unique "id" string (slug format, e.g. "checking-7454", "total-assets")`;

const PNL_PROMPT = `You are a financial document parser. Extract ALL data from this Profit & Loss (Income Statement) PDF.

Return ONLY a raw JSON object — no markdown, no code fences, no explanation.

This PDF may have multiple date columns (Jan, Feb, ..., Dec, TOTAL). Extract:
- "firstPeriodAmount" = the value in the FIRST date column (e.g. January)
- "amount" = the value in the LAST / TOTAL column

Required structure:
{
  "statementType": "profit_and_loss",
  "periodStart": "YYYY-MM-DD",
  "periodEnd": "YYYY-MM-DD",
  "rows": [
    {
      "id": "income",
      "name": "Income",
      "type": "header",
      "amount": 22266.07,
      "firstPeriodAmount": 383.88,
      "children": [
        {
          "id": "revenue-1",
          "name": "Sales Revenue",
          "type": "data",
          "amount": 22266.07,
          "firstPeriodAmount": 383.88
        },
        {
          "id": "total-income",
          "name": "Total Income",
          "type": "total",
          "amount": 22266.07,
          "firstPeriodAmount": 383.88
        }
      ]
    },
    {
      "id": "expenses",
      "name": "Expenses",
      "type": "header",
      "amount": 18000.00,
      "firstPeriodAmount": 1500.00,
      "children": [...]
    },
    {
      "id": "net-income",
      "name": "Net Income",
      "type": "total",
      "amount": 4266.07,
      "firstPeriodAmount": -1116.12
    }
  ]
}

Rules:
- "type": "header"  →  section heading (Income, Expenses, Cost of Sales, Other Income / Expense, etc.)
- "type": "data"    →  individual account line item
- "type": "total"   →  Total / Net lines (Total Income, Gross Profit, Net Income, etc.)
- "amount"          →  value from the LAST/TOTAL column (plain number, negative for losses/discounts)
- "firstPeriodAmount" → value from the FIRST month column (plain number, 0 if only one column)
- Reproduce the EXACT nesting hierarchy from the PDF
- Include ALL line items — even zeros
- "periodStart" / "periodEnd" in YYYY-MM-DD format`;

const CASHFLOW_PROMPT = `You are a financial document parser. Extract ALL data from this Cash Flow Statement PDF.

Return ONLY a raw JSON object — no markdown, no code fences, no explanation.

Required structure:
{
  "statementType": "cash_flow",
  "periodStart": "YYYY-MM-DD",
  "periodEnd": "YYYY-MM-DD",
  "rows": [
    {
      "id": "operating",
      "name": "Operating Activities",
      "type": "header",
      "amount": 0,
      "children": [
        {
          "id": "net-income-1",
          "name": "Net Income",
          "type": "data",
          "amount": 12345.67
        },
        {
          "id": "net-cash-operating",
          "name": "Net Cash from Operating Activities",
          "type": "total",
          "amount": 12345.67
        }
      ]
    },
    {
      "id": "investing",
      "name": "Investing Activities",
      "type": "header",
      "amount": 0,
      "children": [...]
    },
    {
      "id": "financing",
      "name": "Financing Activities",
      "type": "header",
      "amount": 0,
      "children": [...]
    }
  ]
}

Rules:
- "type": "header" → section (Operating Activities, Investing Activities, Financing Activities)
- "type": "data"   → individual line item
- "type": "total"  → Net Cash totals, Ending Cash Balance
- "amount"         → plain number (negative = cash outflow)
- Include ALL line items including zeros
- "periodStart" / "periodEnd" in YYYY-MM-DD format`;

const DETECT_PROMPT = `You are a financial document parser. Look at this PDF and identify what type of financial statement it is.

Return ONLY a raw JSON object with this structure:
{
  "statementType": "balance_sheet" | "profit_and_loss" | "cash_flow",
  "confidence": "high" | "medium" | "low"
}

Rules:
- "balance_sheet"   → shows ASSETS and LIABILITIES / EQUITY sections, typically "As of [date]"
- "profit_and_loss" → shows Income and Expenses over a period, may say "Profit & Loss" or "Income Statement"
- "cash_flow"       → shows Operating / Investing / Financing Activities`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getPromptForType(statementType) {
  if (statementType === "balance_sheet") return BALANCE_SHEET_PROMPT;
  if (statementType === "profit_and_loss") return PNL_PROMPT;
  if (statementType === "cash_flow") return CASHFLOW_PROMPT;
  return null;
}

function hintStatementType(fileName = "") {
  const lower = String(fileName).toLowerCase();
  if (lower.includes("balance")) return "balance_sheet";
  if (lower.includes("profit") || lower.includes("p&l") || lower.includes("income")) return "profit_and_loss";
  if (lower.includes("cash")) return "cash_flow";
  return null;
}

function parseJsonFromText(text = "") {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  return JSON.parse(cleaned);
}

function roundMoney(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function normalizeSlug(value = "") {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeNode(node, index = 0) {
  if (!node || typeof node !== "object") return null;
  const name = String(node.name || "").trim();
  if (!name) return null;

  const type = ["header", "data", "total"].includes(node.type) ? node.type : "data";
  const amount = roundMoney(parseFloat(node.amount) || 0);
  const slug = normalizeSlug(name);
  const id = String(node.id || `${type}-${slug || "row"}-${index}`);

  const normalized = { id, name, type, amount };

  if (node.firstPeriodAmount !== undefined && node.firstPeriodAmount !== null) {
    normalized.firstPeriodAmount = roundMoney(parseFloat(node.firstPeriodAmount) || 0);
  }

  if (Array.isArray(node.children) && node.children.length > 0) {
    const kids = node.children
      .map((child, i) => normalizeNode(child, i))
      .filter(Boolean);
    if (kids.length > 0) normalized.children = kids;
  }

  return normalized;
}

function normalizeGeminiResult(raw) {
  if (!raw || typeof raw !== "object") throw new Error("Gemini returned non-object response");

  const validTypes = ["balance_sheet", "profit_and_loss", "cash_flow"];
  if (!validTypes.includes(raw.statementType)) {
    throw new Error(`Unrecognised statementType: "${raw.statementType}"`);
  }

  if (!Array.isArray(raw.rows) || raw.rows.length === 0) {
    throw new Error("Gemini returned empty rows array");
  }

  const rows = raw.rows.map((row, i) => normalizeNode(row, i)).filter(Boolean);
  if (rows.length === 0) throw new Error("All Gemini rows failed normalization");

  const result = {
    statementType: raw.statementType,
    rows,
  };

  if (raw.asOfDate) result.asOfDate = String(raw.asOfDate);
  if (raw.periodStart) result.periodStart = String(raw.periodStart);
  if (raw.periodEnd) result.periodEnd = String(raw.periodEnd);

  return result;
}

// ---------------------------------------------------------------------------
// Core API call with model fallback + retry on quota
// ---------------------------------------------------------------------------

async function callGemini(base64Pdf, prompt) {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not set");

  let lastError = null;

  for (const modelName of GEMINI_MODELS) {
    let retries = 2;
    const retryDelay = 3000; // fixed 3 s — avoid exponential backoff that causes 10-min hangs

    while (retries > 0) {
      try {
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ model: modelName });

        const result = await model.generateContent([
          { inlineData: { mimeType: "application/pdf", data: base64Pdf } },
          { text: prompt },
        ]);

        return result.response.text();
      } catch (err) {
        lastError = err;
        const msg = String(err?.message || err);
        const isQuota = msg.includes("429") || msg.toLowerCase().includes("quota");
        const isNotFound = msg.includes("404") || msg.toLowerCase().includes("not found");

        console.warn(`[GeminiParser] Model ${modelName} failed: ${msg}`);

        if (isNotFound) break;
        if (isQuota && retries > 1) {
          console.log(`[GeminiParser] Rate limited on ${modelName}, waiting ${retryDelay}ms…`);
          await sleep(retryDelay);
          retries--;
        } else {
          break;
        }
      }
    }
  }

  const lastMsg = String(lastError?.message || "");
  if (lastMsg.includes("429") || lastMsg.toLowerCase().includes("quota")) {
    throw new Error("Gemini API quota exceeded — enable billing at ai.google.dev or wait for daily reset");
  }
  throw new Error(`Gemini extraction failed: ${lastMsg || "unknown error"}`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function parsePdfWithGemini(buffer, fileName = "") {
  const base64Pdf = Buffer.from(buffer).toString("base64");

  // Determine statement type from file name hint, or ask Gemini to detect it.
  let statementType = hintStatementType(fileName);

  if (!statementType) {
    const detectText = await callGemini(base64Pdf, DETECT_PROMPT);
    try {
      const detected = parseJsonFromText(detectText);
      statementType = detected?.statementType || null;
    } catch {
      // If detection itself fails, let the main prompt try without a hint.
    }
  }

  const prompt = statementType ? getPromptForType(statementType) : BALANCE_SHEET_PROMPT;
  if (!prompt) throw new Error(`No prompt for statementType: ${statementType}`);

  const responseText = await callGemini(base64Pdf, prompt);
  const raw = parseJsonFromText(responseText);

  return normalizeGeminiResult(raw);
}

module.exports = { parsePdfWithGemini };
