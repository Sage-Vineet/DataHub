const express = require("express");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const tokenManager = require("../../../tokenManager");

const router = express.Router();

/* ===========================
   CONFIG
=========================== */
const DEFAULT_PDF_PATH =
  process.env.GEMINI_PDF_TEST_PATH ||
  "C:\\Users\\adiko\\Downloads\\Example QoE Documents\\Example QoE Documents\\Tax Return\\Tax Return 2.pdf";

const GEMINI_MODELS = [
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
  "gemini-2.0-flash",
];

/* ===========================
   QUICKBOOKS CALL
=========================== */
async function runQBGet(clientId, qb, url) {
  let headers = {
    Authorization: `Bearer ${qb.accessToken}`,
    Accept: "application/json",
  };

  try {
    return await axios.get(url, { headers });
  } catch (err) {
    if (err.response?.status === 401) {
      const newToken = await tokenManager.refreshAccessToken(clientId);
      headers.Authorization = `Bearer ${newToken}`;
      return await axios.get(url, { headers });
    }
    throw err;
  }
}

/* ===========================
   PARSE QB P&L
=========================== */
function extractPL(rows) {
  const result = {
    totalRevenue: 0,
    totalCostOfGoodsSold: 0,
    grossProfit: 0,
    officerWages: 0,
    depreciation: 0,
    amortization: 0,
    interestExpense: 0,
    interestIncome: 0,
    otherExpenses: 0,
    netIncome: 0,
  };

  if (!rows || !Array.isArray(rows)) return result;

  const getName = (r) =>
    (
      r?.Summary?.ColData?.[0]?.value ||
      r?.Header?.ColData?.[0]?.value ||
      r?.ColData?.[0]?.value ||
      ""
    )
      .toLowerCase()
      .trim();

  const getVal = (r) => {
    const v =
      r?.Summary?.ColData?.[1]?.value ||
      r?.ColData?.[1]?.value ||
      0;
    return Number(v) || 0;
  };

  function loop(rows) {
    if (!rows || !Array.isArray(rows)) return;
    rows.forEach((r) => {
      if (r?.Rows?.Row) loop(r.Rows.Row);

      const name = getName(r);
      const val = getVal(r);

      if (!name) return;

      if (name === "total income" || name === "total revenue") result.totalRevenue = val;
      if (name === "total cost of goods sold" || name === "cost of goods sold") result.totalCostOfGoodsSold = val;
      if (name === "gross profit") result.grossProfit = val;
      if (name.includes("officer") && (name.includes("wage") || name.includes("comp") || name.includes("salary"))) result.officerWages += val;
      if (name.includes("depreciation") && !name.includes("amortization")) result.depreciation += val;
      if (name.includes("amortization")) result.amortization += val;
      if (name.includes("interest") && (name.includes("expense") || name === "interest")) result.interestExpense += val;
      if (name.includes("interest") && name.includes("income")) result.interestIncome += val;
      if (name === "total other expenses" || name === "total expenses") result.otherExpenses = val;
      if (name === "net income") result.netIncome = val;
    });
  }

  loop(rows);
  return result;
}

/* ===========================
   GEMINI EXTRACTION
=========================== */
// Bump this whenever the extraction prompt changes — old disk-cache entries are ignored.
const PROMPT_VERSION = "v4";
const _extractionCache = new Map();
const _taxDataCache = new Map();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function extractTaxFromPDF(filePath) {
  if (_extractionCache.has(filePath)) {
    return _extractionCache.get(filePath);
  }

  const extractionPromise = (async () => {
    const cacheFile = path.join(__dirname, "gemini_cache.json");
    try {
      if (fs.existsSync(cacheFile)) {
        const cacheData = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
        const entry = cacheData[filePath];
        if (entry && entry._promptVersion === PROMPT_VERSION) {
          const { _promptVersion, ...data } = entry;
          return data;
        }
      }
    } catch (e) { }

    if (!fs.existsSync(filePath)) throw new Error(`PDF not found at path: ${filePath}`);
    const pdfBuffer = fs.readFileSync(filePath);
    const pdfBase64 = pdfBuffer.toString("base64");

    // ─────────────────────────────────────────────────────────────────────
    // GEMINI PROMPT  (v4)
    //
    // Reads ONLY Page 1 and Page 3.
    // Page 1 → fixed income/deduction fields.
    // Page 3 → Schedule K lines 2-16f only (line 17 / "Other Information"
    //           lives on Page 4 and must NOT be read).
    // ─────────────────────────────────────────────────────────────────────
    const prompt = `
You are extracting data from a US S-Corporation Income Tax Return (Form 1120-S).
Read every number carefully. Do NOT guess or interpolate — only report what is printed on the form.

⚠️  SCOPE RESTRICTION — VERY IMPORTANT:
    Read data from PAGE 1 and PAGE 3 ONLY.
    Completely ignore Pages 2, 4, 5, 6, 7, 8 and any attached statements.
    Do NOT read Schedule K continuation on Page 4 (lines 17a-17d, line 18, etc.).

════════════════════════════════════════════════════
PAGE 1  —  INCOME & DEDUCTIONS
════════════════════════════════════════════════════

Locate the "Income" section (lines 1a through 6) on Page 1.

The form has THREE sub-lines at the top of the Income section:
  Line 1a  — "Gross receipts or sales"           ← large number to the right of "1a"
  Line 1b  — "Returns and allowances"             ← smaller number to the right of "1b"
  Line 1c  — "Balance. Subtract line 1b from 1a" ← FAR-RIGHT column next to "1c"

⚠️  CRITICAL: "totalRevenue" MUST be the value on Line 1c (far-right column).
    Line 1c = Line 1a MINUS Line 1b.
    Do NOT use Line 1a. Do NOT use Line 6 ("Total income").
    Line 6 is always larger than Line 1c because it adds Form 4797 gains and other income.
    If Line 1b is blank or zero, Line 1c equals Line 1a exactly.

Extract these Page 1 fields (all integers, use 0 if blank):

  "year"                 → 4-digit tax year at top-right of Page 1
  "totalRevenue"         → Line 1c  (Balance — far-right column) ← NOT 1a, NOT Line 6
  "totalCostOfGoodsSold" → Line 2   "Cost of goods sold"
  "grossProfit"          → Line 3   "Gross profit"
  "officerWages"         → Line 7   "Compensation of officers"
  "depreciation"         → Line 14  "Depreciation from Form 4562 not claimed elsewhere"
  "amortization"         → amortization in Line 19 statement (0 if not present)
  "interestExpense"      → Line 13  "Interest"
  "allOtherExpenses"     → Line 19  "Other deductions (attach statement)"
  "netIncome"            → Line 21  "Ordinary business income (loss)"

════════════════════════════════════════════════════
PAGE 3 ONLY  —  SCHEDULE K  "Shareholders' Pro Rata Share Items"
════════════════════════════════════════════════════

⚠️  READ PAGE 3 ONLY. Schedule K continues onto Page 4 — DO NOT read Page 4.
    Stop after Line 16f "Foreign taxes paid or accrued" which is the last line on Page 3.
    Lines 17a, 17b, 17c, 17d (Other Information / Investment income) are on Page 4 — SKIP THEM.

The valid line range on Page 3 is Lines 2 through 16f.
For each line in that range that has a non-zero value in the "Total amount" column,
add one entry to "reconcilingItems".

SKIP Line 1 (Ordinary business income — already in netIncome above).
STOP at Line 16f — do not go past it.

Line → label:
  2    → "Net Rental Real Estate Income"
  3c   → "Other Net Rental Income"
  4    → "Interest Income"
  5a   → "Ordinary Dividends"
  5b   → "Qualified Dividends"
  6    → "Royalties"
  7    → "Net Short-Term Capital Gain (Loss)"
  8a   → "Net Long-Term Capital Gain (Loss)"
  9    → "Net Section 1231 Gain (Loss)"
  10   → "Other Income (Loss)"
  11   → "Section 179 Deduction"
  12a  → "Charitable Contributions"
  12b  → "Investment Interest Expense"
  12c  → "Section 59(e)(2) Expenditures"
  12d  → "Other Deductions"
  13a  → "Low-Income Housing Credit Sec42(j)(5)"
  13b  → "Low-Income Housing Credit Other"
  13c  → "Qualified Rehabilitation Expenditures"
  13d  → "Other Real Estate Credits"
  13e  → "Other Rental Credits"
  13f  → "Biofuel Producer Credit"
  13g  → "Other Credits"
  15a  → "Post-1986 Depreciation Adjustment"
  15b  → "Adjusted Gain or Loss"
  15c  → "Depletion Other Than Oil and Gas"
  15d  → "Oil Gas Geothermal Properties Gross Income"
  15e  → "Oil Gas Geothermal Properties Deductions"
  15f  → "Other AMT Items"
  16a  → "Tax-Exempt Interest Income"
  16b  → "Other Tax-Exempt Income"
  16c  → "Nondeductible Expenses"
  16d  → "Distributions"
  16e  → "Repayment of Loans from Shareholders"
  16f  → "Foreign Taxes Paid or Accrued"

════════════════════════════════════════════════════
OUTPUT RULES
════════════════════════════════════════════════════

- Return ONLY a raw JSON object. No markdown, no backticks, no explanation.
- All dollar amounts must be plain integers (no commas, no decimals, no $ signs).
- Negative amounts: use a negative integer (e.g. -5000).
- reconcilingItems: array of { "label": string, "value": integer }. Empty array [] if none found.
- Do NOT include Line 1 of Schedule K in reconcilingItems.
- Do NOT include any Line 17 items (Other Information / Investment income) — those are on Page 4.

Expected reconcilingItems for this PDF (use these to validate your reading):
  Line  4 → Interest Income         = 1,019
  Line 11 → Section 179 Deduction   = 228,000
  Line 12a→ Charitable Contributions = 1,636
  Line 13g→ Other Credits           = 5,243
  Line 16c→ Nondeductible Expenses  = 8,798
  Total count: exactly 5 items.

JSON output:
{
  "year": 2022,
  "totalRevenue": 2570511,
  "totalCostOfGoodsSold": 298930,
  "grossProfit": 2271581,
  "officerWages": 150000,
  "depreciation": 422875,
  "amortization": 0,
  "interestExpense": 51109,
  "allOtherExpenses": 289121,
  "netIncome": 353311,
  "reconcilingItems": [
    { "label": "Interest Income",          "value": 1019   },
    { "label": "Section 179 Deduction",    "value": 228000 },
    { "label": "Charitable Contributions", "value": 1636   },
    { "label": "Other Credits",            "value": 5243   },
    { "label": "Nondeductible Expenses",   "value": 8798   }
  ]
}
`;

    const attemptedModels = [];
    let lastError = null;

    for (const modelName of GEMINI_MODELS) {
      let retries = 3;
      let delay = 5000;
      attemptedModels.push(modelName);

      while (retries > 0) {
        try {
          console.log(`Gemini: trying model ${modelName}...`);
          const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
          const model = genAI.getGenerativeModel({ model: modelName });

          const result = await model.generateContent([
            { inlineData: { mimeType: "application/pdf", data: pdfBase64 } },
            { text: prompt },
          ]);

          let text = result.response.text().trim();
          text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

          const parsedData = JSON.parse(text);

          // Coerce all Page 1 numeric fields
          const numFields = [
            "year", "totalRevenue", "totalCostOfGoodsSold", "grossProfit",
            "officerWages", "depreciation", "amortization", "interestExpense",
            "allOtherExpenses", "netIncome",
          ];
          numFields.forEach((f) => {
            parsedData[f] = Number(parsedData[f]) || 0;
          });

          // Coerce reconciling items
          if (!Array.isArray(parsedData.reconcilingItems)) {
            parsedData.reconcilingItems = [];
          }
          parsedData.reconcilingItems = parsedData.reconcilingItems
            .map((item) => ({
              label: String(item.label || "").trim(),
              value: Number(item.value) || 0,
            }))
            .filter((item) => item.label && item.value !== 0);

          // Persist to disk cache
          try {
            const cacheData = fs.existsSync(cacheFile)
              ? JSON.parse(fs.readFileSync(cacheFile, "utf-8"))
              : {};
            cacheData[filePath] = { ...parsedData, _promptVersion: PROMPT_VERSION };
            fs.writeFileSync(cacheFile, JSON.stringify(cacheData, null, 2));
          } catch (e) { }

          return parsedData;
        } catch (err) {
          lastError = err;
          const errMsg = err.message || String(err);
          console.warn(`Gemini model ${modelName} failed: ${errMsg}`);

          const isQuota = errMsg.includes("429") || errMsg.toLowerCase().includes("quota");
          const isNotFound = errMsg.includes("404") || errMsg.toLowerCase().includes("not found");

          if (isNotFound) break;
          if (isQuota && retries > 1) {
            console.log(`Rate limited on ${modelName}, waiting ${delay}ms...`);
            await sleep(delay);
            delay *= 2;
            retries--;
          } else {
            break;
          }
        }
      }
    }
    throw new Error(
      `All Gemini models failed (${attemptedModels.join(", ")}). Last error: ${lastError?.message || "Unknown error"}`
    );
  })();

  extractionPromise.catch(() => { _extractionCache.delete(filePath); });
  _extractionCache.set(filePath, extractionPromise);
  return extractionPromise;
}

/* ===========================
   HELPER: find PDF for year
=========================== */
function findPdfForYear(requestedYear) {
  const pdfDir = path.dirname(DEFAULT_PDF_PATH);
  try {
    const files = fs.readdirSync(pdfDir).filter((f) => f.endsWith(".pdf"));
    const match = files.find((f) => f.includes(String(requestedYear)));
    if (match) return path.join(pdfDir, match);
  } catch (e) { }
  return null;
}


/* ===========================
   ENDPOINT 2 — TAX DATA ONLY (Slow — Gemini)
   GET /tax-data
=========================== */

module.exports = router;