const express = require("express");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const tokenManager = require("../../../tokenManager");
const { supabase } = require("../../../db");
const {
  extractTaxDataFromBuffer,
  buildTaxReturnResponseData,
} = require("../../../services/manualReportUploadService");

const router = express.Router();

// ── QB-Online tax-extraction constants ───────────────────────────────────────
const QB_ONLINE_SOURCE = "quickbooks_online";
const TAX_RETURN_REPORT_TYPE = "tax_return";
const UUID_RE_TAX = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const SUPPORTED_TAX_EXTS = new Set(["pdf"]);
// Prevent duplicate DataRoom extractions when the frontend fires N parallel /tax-data calls
const _qbOnlineTaxInProgress = new Map();

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
   HELPER: find PDF for year (legacy — local filesystem, kept for dev fallback)
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
   DATAROOM — Tax folder scan helpers (QB Online mode)
=========================== */

function normalizeTaxBuffer(data) {
  if (!data) return null;
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.from(data);
  if (typeof data === "object" && data.type === "Buffer" && Array.isArray(data.data)) {
    return Buffer.from(data.data);
  }
  if (typeof data === "string") {
    const v = data.trim();
    if (/^\\x[0-9a-f]+$/i.test(v)) return Buffer.from(v.slice(2), "hex");
    if (/^0x[0-9a-f]+$/i.test(v)) return Buffer.from(v.slice(2), "hex");
    return Buffer.from(v, "base64");
  }
  return null;
}

async function loadTaxDocBuffer(doc) {
  if (doc.upload_id) {
    const { data: up } = await supabase.from("uploads").select("data").eq("id", doc.upload_id).maybeSingle();
    if (up?.data) {
      const buf = normalizeTaxBuffer(up.data);
      if (buf?.length) return buf;
    }
  }
  if (doc.file_url) {
    const url = String(doc.file_url);
    const specific = url.match(/\/uploads\/([0-9a-f-]{36})\/content/i);
    if (specific) {
      const { data: up2 } = await supabase.from("uploads").select("data").eq("id", specific[1]).maybeSingle();
      if (up2?.data) { const buf = normalizeTaxBuffer(up2.data); if (buf?.length) return buf; }
    }
    const anyUuid = url.match(UUID_RE_TAX);
    if (anyUuid) {
      const { data: up3 } = await supabase.from("uploads").select("data").eq("id", anyUuid[0]).maybeSingle();
      if (up3?.data) { const buf = normalizeTaxBuffer(up3.data); if (buf?.length) return buf; }
    }
  }
  return null;
}

// Locate all tax-return folders for a company across the entire DataRoom
async function scanDataRoomForTaxFiles(clientId) {
  // Find every folder whose name starts with "Tax" (case-insensitive) for this company
  const { data: candidates } = await supabase
    .from("folders")
    .select("id, name")
    .eq("company_id", clientId)
    .ilike("name", "tax%");

  if (!candidates?.length) {
    console.log(`[Tax Folder Scan] No tax-related folders found for company ${clientId}`);
    return [];
  }

  console.log(`[Tax Folder Scan] Candidate folders: ${candidates.map((f) => f.name).join(", ")}`);

  const allDocs = [];
  for (const folder of candidates) {
    const { data: docs } = await supabase
      .from("documents")
      .select("id, name, upload_id, file_url, uploaded_at")
      .eq("folder_id", folder.id)
      .order("uploaded_at", { ascending: false });

    if (!docs?.length) continue;

    const supported = docs.filter((d) => {
      const ext = String(d.name || "").toLowerCase().split(".").pop();
      return SUPPORTED_TAX_EXTS.has(ext);
    });

    console.log(`[Tax Folder Scan] "${folder.name}": ${docs.length} file(s), ${supported.length} supported (PDF)`);
    allDocs.push(...supported);
  }

  console.log(`[Tax Folder Scan] Found ${allDocs.length} supported file(s) for company ${clientId}`);
  return allDocs;
}

// Extract all tax years from DataRoom for a company.
// Returns { taxYears: { "2024": { year, fileName, data } }, warnings: [] }
async function extractAllTaxFromDataRoom(clientId) {
  const docs = await scanDataRoomForTaxFiles(clientId);
  if (!docs.length) return { taxYears: {}, warnings: [] };

  const taxYears = {};
  const warnings = [];

  for (const doc of docs) {
    const fileName = String(doc.name || "unknown");
    console.log(`[Tax Parser] Reading file: ${fileName}`);

    const buffer = await loadTaxDocBuffer(doc);
    if (!buffer?.length) {
      const msg = `Failed to load binary data for "${fileName}"`;
      console.warn(`[Tax Parser] ${msg}`);
      warnings.push(msg);
      continue;
    }

    try {
      const cacheKey = `qb_online_${clientId}_${doc.id}`;
      const extracted = await extractTaxDataFromBuffer(buffer, cacheKey);

      if (!extracted?.year) {
        const msg = `Could not detect tax year in "${fileName}"`;
        console.warn(`[Tax Parser] ${msg}`);
        warnings.push(msg);
        continue;
      }

      const yr = Number(extracted.year);
      console.log(`[Tax Parser] Detected Year: ${yr} | File: ${fileName}`);

      const data = buildTaxReturnResponseData(extracted);
      console.log(`[Tax Parser] Extracted Fields: ${data.length} | FY ${yr}`);

      // Keep newest file per year
      const existing = taxYears[String(yr)];
      if (!existing || new Date(doc.uploaded_at) > new Date(existing.uploadedAt || 0)) {
        taxYears[String(yr)] = { year: yr, fileName, data, uploadedAt: doc.uploaded_at };
        console.log(`[Tax Reconciliation] Populating FY ${yr}`);
      }
    } catch (err) {
      const msg = `Failed to parse "${fileName}": ${err.message || err}`;
      console.error(`[Tax Parser] ${msg}`);
      warnings.push(msg);
    }
  }

  return { taxYears, warnings };
}

router.get("/quickbooks-pl", async (req, res) => {
  try {
    const clientId = req.clientId || req.query.clientId || req.headers["x-client-id"];
    const qb = req.qb;

    const startDate = req.query.start_date || "2023-01-01";
    const endDate = req.query.end_date || "2023-12-31";
    const requestedYear = parseInt(startDate.split("-")[0], 10);

    if (!qb?.accessToken) {
      return res.status(401).json({ success: false, error: "QB not connected" });
    }

    const accountingMethod =
      String(req.query.accounting_method || "Accrual").toLowerCase() === "cash"
        ? "Cash"
        : "Accrual";

    const qbRes = await runQBGet(
      clientId,
      qb,
      `${qb.baseUrl}/v3/company/${qb.realmId}/reports/ProfitAndLoss` +
      `?start_date=${startDate}&end_date=${endDate}&accounting_method=${accountingMethod}`
    );

    const pl = extractPL(qbRes?.data?.Rows?.Row || []);

    // Formula: All Other Expenses = Gross Profit − Officer Wages − Depreciation
    //           − Amortization − Interest Expense − Net Income
    const plAllOtherExpenses =
      Number(pl.grossProfit || 0) -
      Number(pl.officerWages || 0) -
      Number(pl.depreciation || 0) -
      Number(pl.amortization || 0) -
      Number(pl.interestExpense || 0) -
      Number(pl.netIncome || 0);

    // Map to the standard label set used by the frontend
    const labelMap = {
      "Total Revenue": pl.totalRevenue,
      "Total Cost of Goods Sold": pl.totalCostOfGoodsSold,
      "Gross Profit": pl.grossProfit,
      "Officer Wages": pl.officerWages,
      "Depreciation Expense": pl.depreciation,
      "Amortization Expense": pl.amortization,
      "Total Interest Expense": pl.interestExpense,
      // Derived via same formula as Tax Return column
      "All Other Expenses": plAllOtherExpenses,
      "Net Income": pl.netIncome,
    };

    const data = Object.entries(labelMap).map(([label, value]) => ({
      label,
      pl: Number(value || 0),
    }));

    return res.json({ success: true, startDate, endDate, data });
  } catch (err) {
    console.error("QB P&L Error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/* ===========================
   ENDPOINT 2 — TAX DATA (QB Online — DataRoom scan via Gemini)
   GET /tax-data?start_date=YYYY-01-01&clientId=UUID[&force=1]
=========================== */
router.get("/tax-data", async (req, res) => {
  try {
    const clientId = req.clientId || req.query.clientId || req.headers["x-client-id"];
    if (!clientId) return res.status(400).json({ success: false, error: "Missing clientId" });

    const startDate = req.query.start_date || "2023-01-01";
    const requestedYear = parseInt(startDate.split("-")[0], 10);
    const forceRefresh = req.query.force === "1" || req.query.force_refresh === "true";

    // ── 1. DB cache check ────────────────────────────────────────────────────
    if (!forceRefresh) {
      const { data: cached } = await supabase
        .from("qb_synced_reports")
        .select("data, updated_at")
        .eq("company_id", clientId)
        .eq("source", QB_ONLINE_SOURCE)
        .eq("report_type", TAX_RETURN_REPORT_TYPE)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (cached?.data?.taxYears) {
        const yearData = cached.data.taxYears[String(requestedYear)];
        if (yearData) {
          console.log(`[Tax Reconciliation] Cache hit — FY ${requestedYear} for company ${clientId}`);
          return res.json({ success: true, year: requestedYear, data: yearData.data || [], source: "db_cache" });
        }
        // Cache exists but year not found — return graceful empty (no re-extract)
        const foundYears = Object.keys(cached.data.taxYears).join(", ");
        return res.json({
          success: true, year: requestedYear, data: [],
          warning: `Tax return data found for FY ${foundYears}, but not for FY ${requestedYear}. Upload a tax return for that year.`,
          source: "db_cache",
        });
      }
    }

    // ── 2. DataRoom extraction (dedup concurrent calls per company) ──────────
    let extraction = _qbOnlineTaxInProgress.get(clientId);
    if (!extraction) {
      extraction = extractAllTaxFromDataRoom(clientId)
        .finally(() => _qbOnlineTaxInProgress.delete(clientId));
      _qbOnlineTaxInProgress.set(clientId, extraction);
    }

    const { taxYears, warnings } = await extraction;

    if (!Object.keys(taxYears).length) {
      return res.json({
        success: true, year: requestedYear, data: [],
        warning: "No tax return PDF found. Upload a tax return PDF to DataRoom → Tax folder.",
        warnings: warnings.length ? warnings : undefined,
        source: "empty",
      });
    }

    // ── 3. Persist all years to DB ───────────────────────────────────────────
    const now = new Date().toISOString();
    try {
      await supabase.from("qb_synced_reports")
        .delete()
        .eq("company_id", clientId)
        .eq("source", QB_ONLINE_SOURCE)
        .eq("report_type", TAX_RETURN_REPORT_TYPE);
      await supabase.from("qb_synced_reports").insert({
        company_id: clientId,
        report_type: TAX_RETURN_REPORT_TYPE,
        source: QB_ONLINE_SOURCE,
        data: { taxYears, syncedAt: now },
        status: "synced",
        last_synced_at: now,
        updated_at: now,
      });
      console.log(`[Tax Reconciliation] Data Saved Successfully — ${Object.keys(taxYears).length} year(s) cached`);
    } catch (cacheErr) {
      console.warn(`[Tax Reconciliation] Cache write failed (non-fatal): ${cacheErr.message}`);
    }

    // ── 4. Return requested year ─────────────────────────────────────────────
    const yearData = taxYears[String(requestedYear)];
    if (!yearData) {
      const foundYears = Object.keys(taxYears).join(", ");
      return res.json({
        success: true, year: requestedYear, data: [],
        warning: `Tax return loaded for FY ${foundYears}. No data found for FY ${requestedYear}.`,
        warnings: warnings.length ? warnings : undefined,
        source: "live",
      });
    }

    return res.json({
      success: true,
      year: requestedYear,
      data: yearData.data || [],
      fileName: yearData.fileName,
      source: "live",
      warnings: warnings.length ? warnings : undefined,
    });

  } catch (err) {
    console.error("[Tax data error]:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;