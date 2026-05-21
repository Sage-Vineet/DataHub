const path = require("path");
const { Worker } = require("worker_threads");
const XLSX = require("xlsx");
const { supabase } = require("../db");
const { processBalanceSheet } = require("./balanceSheetService");
const {
  REPORT_SOURCE_KEYS,
  updateReportSourceRecord,
} = require("./reportSourceStore");
const { parsePdfWithGemini } = require("./geminiFinancialParser");
const {
  normalizeBankBinary,
  extractBankStatementsFromPdfBase64,
  buildBankResponseShape,
} = require("./bankStatementExtractor");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const PDF_WORKER_PATH = path.join(__dirname, "../workers/pdfParser.js");
const PDF_PARSE_TIMEOUT_MS = 30000;

const MANUAL_REPORT_UPLOAD_SOURCE = "manual_report_upload";
const STATEMENT_TYPES = {
  BALANCE_SHEET: "balance_sheet",
  PROFIT_AND_LOSS: "profit_and_loss",
  CASH_FLOW: "cash_flow",
  BANK_RECONCILIATION: "bank_reconciliation",
  TAX_RETURN: "tax_return",
};

/* =========================================================
   TAX RETURN EXTRACTION — Gemini vision (image-based PDFs)
   Sends raw PDF bytes to Gemini as inline multimodal data.
   Works for both text-based and scanned/image-based PDFs.
========================================================= */

const TAX_GEMINI_MODELS = ["gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-2.0-flash"];
const _taxExtractCache = new Map();
const _taxExtractSleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TAX_EXTRACTION_PROMPT = `
You are extracting data from a US Business Income Tax Return.
This may be a scanned (image-based) PDF — use your vision capability to read every page carefully.
Do NOT guess or interpolate — only report what is visually printed on the form.

STEP 1 — DETECT THE FORM TYPE
Look at the very top of Page 1 for the form number:
  - "Form 1120-S" → S-Corporation return
  - "Form 1065"   → Partnership return
  - "Form 1120"   → C-Corporation return
Set "formType" to "1120-S", "1065", or "1120" accordingly. Default to "1120-S" if unclear.

═══════════════════════════════════════════════════════
FORM 1120-S (S-CORPORATION) — read PAGE 1 and PAGE 3
═══════════════════════════════════════════════════════

PAGE 1 — INCOME & DEDUCTIONS (Form 1120-S):
  Line 1a  — Gross receipts or sales
  Line 1b  — Returns and allowances
  Line 1c  — Balance (far-right column) → "totalRevenue"
  Line 2   — Cost of goods sold         → "totalCostOfGoodsSold"
  Line 3   — Gross profit               → "grossProfit"
  Line 7   — Compensation of officers   → "officerWages"
  Line 13  — Interest                   → "interestExpense"
  Line 14  — Depreciation               → "depreciation"
  Line 19  — Other deductions           → "allOtherExpenses" (and check attached statement for amortization)
  Line 21  — Ordinary business income   → "netIncome"

PAGE 3 ONLY — SCHEDULE K (Form 1120-S), Lines 2–16f:
  SKIP Line 1 (= netIncome already captured).
  For each non-zero line add to reconcilingItems:
  2->"Net Rental Real Estate Income", 3c->"Other Net Rental Income",
  4->"Interest Income", 5a->"Ordinary Dividends", 5b->"Qualified Dividends",
  6->"Royalties", 7->"Net Short-Term Capital Gain (Loss)",
  8a->"Net Long-Term Capital Gain (Loss)", 9->"Net Section 1231 Gain (Loss)",
  10->"Other Income (Loss)", 11->"Section 179 Deduction",
  12a->"Charitable Contributions", 12b->"Investment Interest Expense",
  12c->"Section 59(e)(2) Expenditures", 12d->"Other Deductions",
  13a->"Low-Income Housing Credit Sec42(j)(5)", 13b->"Low-Income Housing Credit Other",
  13c->"Qualified Rehabilitation Expenditures", 13d->"Other Real Estate Credits",
  13e->"Other Rental Credits", 13f->"Biofuel Producer Credit", 13g->"Other Credits",
  15a->"Post-1986 Depreciation Adjustment", 15b->"Adjusted Gain or Loss",
  15c->"Depletion Other Than Oil and Gas",
  15d->"Oil Gas Geothermal Properties Gross Income",
  15e->"Oil Gas Geothermal Properties Deductions", 15f->"Other AMT Items",
  16a->"Tax-Exempt Interest Income", 16b->"Other Tax-Exempt Income",
  16c->"Nondeductible Expenses", 16d->"Distributions",
  16e->"Repayment of Loans from Shareholders", 16f->"Foreign Taxes Paid or Accrued"

═══════════════════════════════════════════════════════
FORM 1065 (PARTNERSHIP) — read PAGE 1 and ONLY the partnership-level SCHEDULE K page
═══════════════════════════════════════════════════════

⚠️ CRITICAL — SCHEDULE K-1 WARNING:
  The PDF contains MANY pages labelled "Schedule K-1" (one per partner). These are INDIVIDUAL partner pages.
  You MUST COMPLETELY IGNORE every page that has "Schedule K-1" anywhere in its header or title.
  ONLY read the SINGLE page titled exactly "Schedule K  Partners' Distributive Share Items".
  That Schedule K page has a column labelled "Total amount" (or similar) showing the WHOLE PARTNERSHIP totals.
  ANY value from a Schedule K-1 page is WRONG. Do not use it.

PAGE 1 — INCOME & DEDUCTIONS (Form 1065):
  Line 1a  — Gross receipts or sales
  Line 1b  — Returns and allowances
  Line 1c  — Balance (far-right column) → "totalRevenue"
  Line 2   — Cost of goods sold         → "totalCostOfGoodsSold"
  Line 3   — Gross profit               → "grossProfit"
  Line 10  — Guaranteed payments to partners → "officerWages" (use 0 if blank)
  Line 15  — Interest                   → "interestExpense"
  Line 16c — Net depreciation (far-right column) → "depreciation"
             ⚠️ If the far-right column for Line 16c is blank or empty, enter 0.
             Do NOT substitute any value from Schedule K or Schedule K-1 for this field.
  Line 21  — Other deductions (NOT Line 22) → "allOtherExpenses"
             ⚠️ Use ONLY Line 21 "Other deductions". Do NOT use Line 22 "Total deductions".
             Line 22 is the sum of all deductions and will be much larger — ignore it.
  Line 23  — Ordinary business income (loss) → "netIncome"

  "amortization":
    Look for a statement attached to Line 21 (may be labelled "Statement 1", "Statement 2", etc.)
    If the statement lists "Amortization" or "Amortization expense" as a line item, use that amount.
    Otherwise use 0.

SCHEDULE K page — Partners' Distributive Share Items (Form 1065):
  ⚠️ READ ONLY the page titled "Schedule K  Partners' Distributive Share Items".
     This page shows totals for the ENTIRE PARTNERSHIP in a single column (often "Total amount").
  ⚠️ DO NOT read any page with "Schedule K-1" in the title — those are partner-specific pages.
  SKIP Line 1 (= netIncome already captured).
  Only include reconcilingItems entries where the value in the "Total amount" column is non-zero.
  For each non-zero line add to reconcilingItems:
  2 ->"Net Rental Real Estate Income",
  3a->"Other Gross Rental Income", 3c->"Other Net Rental Income",
  4c->"Guaranteed Payments Total",
  5 ->"Interest Income",
  6a->"Ordinary Dividends", 6b->"Qualified Dividends",
  7 ->"Royalties",
  8 ->"Net Short-Term Capital Gain (Loss)",
  9a->"Net Long-Term Capital Gain (Loss)", 9c->"Unrecaptured Section 1250 Gain",
  10->"Net Section 1231 Gain (Loss)",
  11->"Other Income (Loss)",
  12->"Section 179 Deduction",
  13a->"Charitable Contributions Cash", 13b->"Charitable Contributions Noncash",
  13c->"Investment Interest Expense",
  13d2->"Section 59(e)(2) Expenditures",
  14a->"Net Earnings from Self-Employment",
  14b->"Gross Farming or Fishing Income", 14c->"Gross Nonfarm Income",
  15a->"Low-Income Housing Credit Sec42(j)(5)", 15b->"Low-Income Housing Credit Other",
  15c->"Qualified Rehabilitation Expenditures", 15d->"Other Real Estate Credits",
  15e->"Other Rental Credits", 15f->"Other Credits",
  17a->"Post-1986 Depreciation Adjustment", 17b->"Adjusted Gain or Loss",
  17c->"Depletion Other Than Oil and Gas",
  18a->"Tax-Exempt Interest Income", 18b->"Other Tax-Exempt Income",
  18c->"Nondeductible Expenses",
  19a->"Distributions of Cash and Marketable Securities",
  19b->"Distributions of Other Property",
  20a->"Investment Income", 20b->"Investment Expenses",
  21 ->"Total Foreign Taxes Paid or Accrued"

═══════════════════════════════════════════════════════
FORM 1120 (C-CORPORATION) — read PAGE 1 only
═══════════════════════════════════════════════════════

PAGE 1 — INCOME & DEDUCTIONS (Form 1120):
  Line 1c  — Gross receipts balance     → "totalRevenue"
  Line 2   — Cost of goods sold         → "totalCostOfGoodsSold"
  Line 3   — Gross profit               → "grossProfit"
  Line 12  — Compensation of officers   → "officerWages"
  Line 17  — Interest                   → "interestExpense"
  Line 20  — Depreciation               → "depreciation"
  Line 26  — Other deductions           → "allOtherExpenses"
  Line 28  — Taxable income before NOL  → "netIncome"
  reconcilingItems: [] (no Schedule K for C-Corp)

═══════════════════════════════════════════════════════
COMMON RULES FOR ALL FORMS
═══════════════════════════════════════════════════════

CRITICAL — totalRevenue:
  ALWAYS use Line 1c (the Balance/far-right column), NOT Line 1a.
  If Line 1b is blank, Line 1c = Line 1a.

"year": 4-digit tax year printed at top-right of Page 1 (e.g. 2023).

OUTPUT RULES:
- Return ONLY a raw JSON object. No markdown, no backticks, no explanation.
- All dollar amounts: plain integers (no commas, decimals, or $ signs).
- Negative amounts: negative integer (e.g. -5000).
- reconcilingItems: array of { "label": string, "value": integer }. Empty [] if none.
- Only include reconcilingItems entries where value is non-zero.

JSON schema:
{
  "formType": "1120-S",
  "year": 0,
  "totalRevenue": 0,
  "totalCostOfGoodsSold": 0,
  "grossProfit": 0,
  "officerWages": 0,
  "depreciation": 0,
  "amortization": 0,
  "interestExpense": 0,
  "allOtherExpenses": 0,
  "netIncome": 0,
  "reconcilingItems": []
}
`.trim();

function buildTaxReturnResponseData(tax) {
  // For Form 1065 (Partnership): allOtherExpenses comes directly from Line 21
  // "Other deductions" — it already excludes guaranteed payments, interest, etc.
  // For 1120-S / 1120: derive it from gross profit minus known expense lines.
  const isPartnership = String(tax.formType || "").includes("1065");
  const allOtherExpenses = isPartnership
    ? Number(tax.allOtherExpenses || 0)
    : Number(tax.grossProfit || 0) -
      Number(tax.officerWages || 0) -
      Number(tax.depreciation || 0) -
      Number(tax.amortization || 0) -
      Number(tax.interestExpense || 0) -
      Number(tax.netIncome || 0);

  // Label officer wages as "Guaranteed Payments" for partnerships
  const officerWagesLabel = isPartnership ? "Guaranteed Payments" : "Officer Wages";

  const page1 = {
    "Total Revenue": tax.totalRevenue,
    "Total Cost of Goods Sold": tax.totalCostOfGoodsSold,
    "Gross Profit": tax.grossProfit,
    [officerWagesLabel]: tax.officerWages,
    "Depreciation Expense": tax.depreciation,
    "Amortization Expense": tax.amortization,
    "Total Interest Expense": tax.interestExpense,
    "All Other Expenses": allOtherExpenses,
    "Net Income": tax.netIncome,
  };

  const data = Object.entries(page1).map(([label, value]) => ({
    label,
    taxReturn: Number(value || 0),
    isReconcilingItem: false,
  }));

  (Array.isArray(tax.reconcilingItems) ? tax.reconcilingItems : []).forEach((item) => {
    if (item.label && item.value !== 0) {
      data.push({ label: item.label, taxReturn: Number(item.value || 0), isReconcilingItem: true });
    }
  });

  return data;
}

function clearTaxExtractCache(cacheKey) {
  if (cacheKey) _taxExtractCache.delete(cacheKey);
  else _taxExtractCache.clear();
}

async function extractTaxDataFromBuffer(pdfBuffer, cacheKey) {
  if (_taxExtractCache.has(cacheKey)) return _taxExtractCache.get(cacheKey);

  const promise = (async () => {
    const pdfBase64 = pdfBuffer.toString("base64");
    let lastError = null;

    for (const modelName of TAX_GEMINI_MODELS) {
      let retries = 3;
      let delay = 5000;
      while (retries > 0) {
        try {
          console.log(`[TaxExtract] model=${modelName} key=${cacheKey}`);
          const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
          const model = genAI.getGenerativeModel({ model: modelName });
          const result = await model.generateContent([
            { inlineData: { mimeType: "application/pdf", data: pdfBase64 } },
            { text: TAX_EXTRACTION_PROMPT },
          ]);
          let text = result.response.text().trim();
          text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
          const parsed = JSON.parse(text);
          ["year","totalRevenue","totalCostOfGoodsSold","grossProfit","officerWages",
           "depreciation","amortization","interestExpense","allOtherExpenses","netIncome"]
            .forEach((f) => { parsed[f] = Number(parsed[f]) || 0; });
          if (!parsed.formType) parsed.formType = "1120-S";
          if (!Array.isArray(parsed.reconcilingItems)) parsed.reconcilingItems = [];
          parsed.reconcilingItems = parsed.reconcilingItems
            .map((i) => ({ label: String(i.label || "").trim(), value: Number(i.value) || 0 }))
            .filter((i) => i.label && i.value !== 0);
          console.log(`[TaxExtract] formType=${parsed.formType} year=${parsed.year} via ${modelName}`);
          return parsed;
        } catch (err) {
          lastError = err;
          const msg = String(err.message || err);
          if (msg.includes("404") || msg.toLowerCase().includes("not found")) break;
          if ((msg.includes("429") || msg.toLowerCase().includes("quota")) && retries > 1) {
            await _taxExtractSleep(delay);
            delay *= 2;
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
  })();

  promise.catch(() => _taxExtractCache.delete(cacheKey));
  _taxExtractCache.set(cacheKey, promise);
  return promise;
}

/* =========================================================
   PROFIT & LOSS EXTRACTION — Gemini vision for Tax Reconciliation
   Reads a P&L PDF and extracts the 10 line items + fiscal year.
========================================================= */

const PL_FOR_TAX_PROMPT = `
You are extracting data from a Profit & Loss (Income Statement) report.
This may be a scanned or text-based PDF — use your vision capability to read it carefully.
Do NOT guess or interpolate — only report what is visually printed.

DETECT THE FISCAL YEAR:
  Look for a date range or period header such as:
    "January 1 – December 31, 2023" → year = 2023
    "For the year ended December 31, 2022" → year = 2022
    "FY 2024" → year = 2024
  Use the ENDING year of the period (the year the fiscal year closes).
  If there is only one year mentioned anywhere in the header, use that.

EXTRACT THESE 10 VALUES (all integers, use 0 if blank/absent):
  "year"                — 4-digit fiscal year (as described above)
  "totalRevenue"        — Total Revenue / Total Income / Net Sales (top-line)
  "totalCostOfGoodsSold"— Cost of Goods Sold / COGS / Cost of Sales
  "grossProfit"         — Gross Profit (Revenue minus COGS)
  "officerWages"        — Officer Compensation / Officer Wages / S-Corp Officer Pay
                          (0 if not separately listed)
  "depreciation"        — Depreciation Expense (0 if not listed)
  "amortization"        — Amortization Expense (0 if not listed; ignore if combined with depreciation)
  "interestExpense"     — Interest Expense / Loan Interest / Bank Interest (0 if not listed)
  "allOtherExpenses"    — All Other Expenses / Other Operating Expenses / Other Deductions
                          If not explicitly labeled, compute:
                          allOtherExpenses = Total Expenses − officerWages − depreciation
                                            − amortization − interestExpense
  "allOtherIncome"      — Other Income / Non-operating Income (0 if not listed)
  "netIncome"           — Net Income / Net Profit / Net Loss (bottom line; negative = loss)

OUTPUT RULES:
- Return ONLY a raw JSON object. No markdown, no backticks, no explanation.
- All dollar amounts: plain integers (no commas, decimals, or $ signs).
- Negative amounts: negative integer (e.g. -5000).

JSON schema:
{
  "year": 0,
  "totalRevenue": 0,
  "totalCostOfGoodsSold": 0,
  "grossProfit": 0,
  "officerWages": 0,
  "depreciation": 0,
  "amortization": 0,
  "interestExpense": 0,
  "allOtherExpenses": 0,
  "allOtherIncome": 0,
  "netIncome": 0
}
`.trim();

const _plForTaxCache = new Map();

async function extractPLForTax(pdfBuffer, cacheKey) {
  if (_plForTaxCache.has(cacheKey)) return _plForTaxCache.get(cacheKey);

  const promise = (async () => {
    const pdfBase64 = pdfBuffer.toString("base64");
    let lastError = null;

    for (const modelName of TAX_GEMINI_MODELS) {
      let retries = 3;
      let delay = 5000;
      while (retries > 0) {
        try {
          console.log(`[PLForTax] model=${modelName} key=${cacheKey}`);
          const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
          const model = genAI.getGenerativeModel({ model: modelName });
          const result = await model.generateContent([
            { inlineData: { mimeType: "application/pdf", data: pdfBase64 } },
            { text: PL_FOR_TAX_PROMPT },
          ]);
          let text = result.response.text().trim();
          text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
          const parsed = JSON.parse(text);
          ["year","totalRevenue","totalCostOfGoodsSold","grossProfit","officerWages",
           "depreciation","amortization","interestExpense","allOtherExpenses","allOtherIncome","netIncome"]
            .forEach((f) => { parsed[f] = Number(parsed[f]) || 0; });
          console.log(`[PLForTax] year=${parsed.year} via ${modelName}`);
          return parsed;
        } catch (err) {
          lastError = err;
          const msg = String(err.message || err);
          if (msg.includes("404") || msg.toLowerCase().includes("not found")) break;
          if ((msg.includes("429") || msg.toLowerCase().includes("quota")) && retries > 1) {
            await _taxExtractSleep(delay);
            delay *= 2;
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
  })();

  promise.catch(() => _plForTaxCache.delete(cacheKey));
  _plForTaxCache.set(cacheKey, promise);
  return promise;
}

function extractPLLineItemsFromRows(rows, year) {
  function flatten(items, result = []) {
    for (const item of (items || [])) {
      const label = String(item.name || "").trim();
      if (!label) continue;
      result.push({ label, value: typeof item.amount === "number" ? item.amount : 0, type: String(item.type || "data") });
      if (Array.isArray(item.children)) flatten(item.children, result);
    }
    return result;
  }
  const flat = flatten(rows);
  const lc = (s) => s.toLowerCase().trim();
  const find = (patterns, preferTotal = true) => {
    const matches = flat.filter((row) => patterns.some((p) => lc(row.label).includes(lc(p)) || lc(p).includes(lc(row.label))));
    if (!matches.length) return 0;
    if (preferTotal) {
      const totals = matches.filter((r) => r.type === "total");
      if (totals.length) return totals[totals.length - 1].value;
    }
    return matches[matches.length - 1].value;
  };
  const officerWages    = find(["officer compensation", "officer wages", "officer salary", "officer pay"], false);
  const depreciation    = find(["depreciation expense", "depreciation"], false);
  const amortization    = find(["amortization expense", "amortization"], false);
  const interestExpense = find(["total interest expense", "interest expense", "loan interest"], false);
  const totalExpenses   = find(["total expenses", "total operating expenses", "total expense"]);
  const allOtherExpenses = totalExpenses > 0 ? Math.max(0, totalExpenses - (officerWages + depreciation + amortization + interestExpense)) : 0;
  return {
    year,
    totalRevenue:         find(["total income", "total revenue", "net revenue", "total sales"]),
    totalCostOfGoodsSold: find(["total cost of goods sold", "cost of goods sold", "cost of sales"]),
    grossProfit:          find(["gross profit", "gross margin"]),
    officerWages,
    depreciation,
    amortization,
    interestExpense,
    allOtherExpenses,
    allOtherIncome:       find(["total other income", "other income", "other revenue"]),
    netIncome:            find(["net income", "net loss", "net earnings", "net profit"]),
  };
}

function buildPLForTaxData(pl) {
  return [
    { label: "Total Revenue",            pl: Number(pl.totalRevenue || 0) },
    { label: "Total Cost of Goods Sold", pl: Number(pl.totalCostOfGoodsSold || 0) },
    { label: "Gross Profit",             pl: Number(pl.grossProfit || 0) },
    { label: "Officer Wages",            pl: Number(pl.officerWages || 0) },
    { label: "Depreciation Expense",     pl: Number(pl.depreciation || 0) },
    { label: "Amortization Expense",     pl: Number(pl.amortization || 0) },
    { label: "Total Interest Expense",   pl: Number(pl.interestExpense || 0) },
    { label: "All Other Expenses",       pl: Number(pl.allOtherExpenses || 0) },
    { label: "All Other Income",         pl: Number(pl.allOtherIncome || 0) },
    { label: "Net Income",               pl: Number(pl.netIncome || 0) },
  ];
}

async function syncTaxReturnFolder(companyId, folder, now) {
  const { data: documents } = await supabase
    .from("documents")
    .select("id, name, upload_id, file_url")
    .eq("folder_id", folder.id)
    .order("name", { ascending: true });

  if (!documents?.length) {
    return { success: false, reason: "No files in Tax Reconciliation folder", processed: [], failed: [] };
  }

  const taxYears = {};
  const processedDocs = [];
  const failedDocs = [];

  for (const doc of documents) {
    const fileName = String(doc.name || "");
    const lowerName = fileName.toLowerCase();

    let buffer = null;

    if (doc.upload_id) {
      const { data: up } = await supabase
        .from("uploads").select("data").eq("id", doc.upload_id).maybeSingle();
      if (up?.data) buffer = normalizeUploadBinary(up.data);
    }

    if (!buffer?.length && doc.file_url) {
      const m = String(doc.file_url).match(/\/uploads\/([0-9a-f-]{36})\/content/i);
      if (m) {
        const { data: up } = await supabase
          .from("uploads").select("data").eq("id", m[1]).maybeSingle();
        if (up?.data) buffer = normalizeUploadBinary(up.data);
      }
    }

    if (!buffer?.length) {
      console.warn(`[TaxReturnSync] No binary for "${fileName}"`);
      continue;
    }

    if (!lowerName.endsWith(".pdf")) {
      console.log(`[TaxReturnSync] Skipping non-PDF "${fileName}"`);
      continue;
    }

    try {
      const cacheKey = `tax_sync_${companyId}_${doc.upload_id || lowerName}`;
      const extracted = await extractTaxDataFromBuffer(buffer, cacheKey);
      if (extracted?.year) {
        const year = Number(extracted.year);
        taxYears[year] = { year, fileName, data: buildTaxReturnResponseData(extracted) };
        processedDocs.push({ documentId: doc.id, fileName, folderName: folder.name, statementType: STATEMENT_TYPES.TAX_RETURN, taxYear: year });
        console.log(`[TaxReturnSync] Stored year=${year} from "${fileName}"`);
      } else {
        failedDocs.push({ documentId: doc.id, fileName, folderName: folder.name, reason: "Year not detected in PDF" });
      }
    } catch (err) {
      console.error(`[TaxReturnSync] Gemini failed for "${fileName}": ${err.message}`);
      failedDocs.push({ documentId: doc.id, fileName, folderName: folder.name, reason: err.message });
    }
  }

  if (!Object.keys(taxYears).length) {
    return { success: false, reason: "No tax data could be extracted from PDFs", processed: [], failed: failedDocs };
  }

  // Upsert one aggregate record per company for all tax years
  const { data: existing } = await supabase
    .from("qb_synced_reports")
    .select("id")
    .eq("company_id", companyId)
    .eq("source", MANUAL_REPORT_UPLOAD_SOURCE)
    .eq("report_type", STATEMENT_TYPES.TAX_RETURN)
    .maybeSingle();

  const payload = {
    company_id: companyId,
    report_type: STATEMENT_TYPES.TAX_RETURN,
    report_params: { sourceFolderName: SOURCE_FOLDER_NAME, folderId: folder.id, folderName: folder.name },
    data: { tax_return: { taxYears, syncedAt: now, documentCount: processedDocs.length } },
    source: MANUAL_REPORT_UPLOAD_SOURCE,
    status: "synced",
    last_synced_at: now,
    updated_at: now,
  };

  let upsertError;
  if (existing?.id) {
    ({ error: upsertError } = await supabase
      .from("qb_synced_reports").update(payload).eq("id", existing.id));
  } else {
    ({ error: upsertError } = await supabase
      .from("qb_synced_reports").insert(payload));
  }

  if (upsertError) throw new Error(`Failed to store tax return data: ${upsertError.message}`);

  console.log(`[TaxReturnSync] Saved ${Object.keys(taxYears).length} year(s) for company ${companyId}`);
  return { success: true, processed: processedDocs, failed: failedDocs };
}

async function syncPLForTaxFolder(companyId, folder, now) {
  const PL_FOR_TAX_REPORT_TYPE = "pl_for_tax";

  const { data: documents } = await supabase
    .from("documents")
    .select("id, name, upload_id, file_url")
    .eq("folder_id", folder.id)
    .order("name", { ascending: true });

  if (!documents?.length) {
    return { success: false, reason: "No files in Profit & Loss folder", processed: [], failed: [] };
  }

  const plYears = {};
  const processedDocs = [];
  const failedDocs = [];

  for (const doc of documents) {
    const fileName = String(doc.name || "");
    const lowerName = fileName.toLowerCase();

    if (!lowerName.endsWith(".pdf")) {
      console.log(`[PLForTaxSync] Skipping non-PDF "${fileName}"`);
      continue;
    }

    let buffer = null;
    if (doc.upload_id) {
      const { data: up } = await supabase.from("uploads").select("data").eq("id", doc.upload_id).maybeSingle();
      if (up?.data) buffer = normalizeUploadBinary(up.data);
    }
    if (!buffer?.length && doc.file_url) {
      const m = String(doc.file_url).match(/\/uploads\/([0-9a-f-]{36})\/content/i);
      if (m) {
        const { data: up } = await supabase.from("uploads").select("data").eq("id", m[1]).maybeSingle();
        if (up?.data) buffer = normalizeUploadBinary(up.data);
      }
    }

    if (!buffer?.length) {
      console.warn(`[PLForTaxSync] No binary for "${fileName}"`);
      continue;
    }

    try {
      const cacheKey = `pl_sync_${companyId}_${doc.upload_id || lowerName}`;
      _plForTaxCache.delete(cacheKey); // invalidate so re-sync gets fresh data
      const extracted = await extractPLForTax(buffer, cacheKey);
      if (extracted?.year) {
        const year = Number(extracted.year);
        plYears[year] = { year, fileName, data: buildPLForTaxData(extracted) };
        processedDocs.push({ documentId: doc.id, fileName, folderName: folder.name, statementType: PL_FOR_TAX_REPORT_TYPE, plYear: year });
        console.log(`[PLForTaxSync] Stored year=${year} from "${fileName}"`);
      } else {
        failedDocs.push({ documentId: doc.id, fileName, folderName: folder.name, reason: "Year not detected in PDF" });
      }
    } catch (geminiErr) {
      console.warn(`[PLForTaxSync] Gemini failed for "${fileName}", trying text fallback: ${geminiErr.message}`);
      // Text-extraction fallback for text-based PDFs (when Gemini is unavailable)
      try {
        const fakeUpload = { data: buffer, file_name: fileName, content_type: "application/pdf" };
        const parsed = await parseStoredReport(fakeUpload, STATEMENT_TYPES.PROFIT_AND_LOSS);
        if (parsed?.report?.rows?.length) {
          let year = parsed.report.asOfDate ? parseInt(String(parsed.report.asOfDate).split("-")[0], 10) : 0;
          if (!year) { const m = fileName.match(/\b(20\d{2})\b/); if (m) year = parseInt(m[1], 10); }
          if (year) {
            const pl = extractPLLineItemsFromRows(parsed.report.rows, year);
            plYears[year] = { year, fileName, data: buildPLForTaxData(pl) };
            processedDocs.push({ documentId: doc.id, fileName, folderName: folder.name, statementType: PL_FOR_TAX_REPORT_TYPE, plYear: year });
            console.log(`[PLForTaxSync] Text fallback: year=${year} from "${fileName}"`);
            continue;
          }
        }
        failedDocs.push({ documentId: doc.id, fileName, folderName: folder.name, reason: "Could not extract P&L data from PDF" });
      } catch (fbErr) {
        console.error(`[PLForTaxSync] Both Gemini and text fallback failed for "${fileName}": ${fbErr.message}`);
        failedDocs.push({ documentId: doc.id, fileName, folderName: folder.name, reason: geminiErr.message });
      }
    }
  }

  if (!Object.keys(plYears).length) {
    return { success: false, reason: "No P&L data could be extracted from PDFs", processed: [], failed: failedDocs };
  }

  const { data: existing } = await supabase.from("qb_synced_reports").select("id")
    .eq("company_id", companyId).eq("source", MANUAL_REPORT_UPLOAD_SOURCE)
    .eq("report_type", PL_FOR_TAX_REPORT_TYPE).maybeSingle();

  const payload = {
    company_id: companyId,
    report_type: PL_FOR_TAX_REPORT_TYPE,
    report_params: { sourceFolderName: SOURCE_FOLDER_NAME, folderId: folder.id, folderName: folder.name },
    data: { pl_for_tax: { plYears, syncedAt: now, documentCount: processedDocs.length } },
    source: MANUAL_REPORT_UPLOAD_SOURCE,
    status: "synced",
    last_synced_at: now,
    updated_at: now,
  };

  let upsertError;
  if (existing?.id) {
    ({ error: upsertError } = await supabase.from("qb_synced_reports").update(payload).eq("id", existing.id));
  } else {
    ({ error: upsertError } = await supabase.from("qb_synced_reports").insert(payload));
  }

  if (upsertError) throw new Error(`Failed to store P&L for tax data: ${upsertError.message}`);
  console.log(`[PLForTaxSync] Saved ${Object.keys(plYears).length} year(s) for company ${companyId}`);
  return { success: true, processed: processedDocs, failed: failedDocs };
}

function normalizeUploadBinary(data) {
  if (!data) return Buffer.alloc(0);
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.from(data);
  if (typeof data === "object" && data.type === "Buffer" && Array.isArray(data.data)) {
    return Buffer.from(data.data);
  }
  if (typeof data === "string") {
    const value = data.trim();
    if (/^\\x[0-9a-f]+$/i.test(value)) return Buffer.from(value.slice(2), "hex");
    if (/^0x[0-9a-f]+$/i.test(value)) return Buffer.from(value.slice(2), "hex");
    return Buffer.from(value, "base64");
  }
  return Buffer.from(String(data));
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeSlug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function hasCellValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function parseAmount(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;

  const raw = String(value).trim();
  if (!raw) return null;

  const cleaned = raw
    .replace(/[$,\s]/g, "")
    .replace(/\((.*)\)/, "-$1")
    .replace(/^[=]/, "")
    .replace(/\.{2,}/g, "");

  if (!/^[-+]?[\d.]+$/.test(cleaned)) return null;
  const numeric = Number(cleaned);
  return Number.isFinite(numeric) ? numeric : null;
}

function roundMoney(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

const MONTH_INDEX = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function toIsoDate(dateStr = "") {
  if (!dateStr) return null;
  const s = String(dateStr).trim().replace(/,/g, "");

  // "March 31 2025" / "Jan 1 2025"
  const longMatch = s.match(/^([a-z]+)\s+(\d{1,2})\s+(\d{4})$/i);
  if (longMatch) {
    const month = MONTH_INDEX[longMatch[1].toLowerCase()];
    if (month !== undefined) {
      return `${longMatch[3]}-${String(month + 1).padStart(2, "0")}-${String(parseInt(longMatch[2], 10)).padStart(2, "0")}`;
    }
  }

  // "January 2023" — month + year only
  const monthYearMatch = s.match(/^([a-z]+)\s+(\d{4})$/i);
  if (monthYearMatch) {
    const month = MONTH_INDEX[monthYearMatch[1].toLowerCase()];
    if (month !== undefined) {
      return `${monthYearMatch[2]}-${String(month + 1).padStart(2, "0")}-01`;
    }
  }

  // MM/DD/YYYY or MM-DD-YYYY
  const numericMatch = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);
  if (numericMatch) {
    let year = parseInt(numericMatch[3], 10);
    if (year < 100) year += 2000;
    return `${year}-${String(parseInt(numericMatch[1], 10)).padStart(2, "0")}-${String(parseInt(numericMatch[2], 10)).padStart(2, "0")}`;
  }

  // YYYY-MM-DD
  const isoMatch = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (isoMatch) {
    return `${isoMatch[1]}-${String(parseInt(isoMatch[2], 10)).padStart(2, "0")}-${String(parseInt(isoMatch[3], 10)).padStart(2, "0")}`;
  }

  return null;
}

function firstTextCell(cells = []) {
  for (const cell of cells) {
    const text = String(cell || "").trim();
    if (/[a-z]/i.test(text)) return text;
  }
  return "";
}

function findAmountInCells(cells = []) {
  for (let index = cells.length - 1; index >= 0; index -= 1) {
    const amount = parseAmount(cells[index]);
    if (amount !== null) return roundMoney(amount);
  }
  return null;
}

const MONTH_PERIOD_RE = /^(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)[\s.\-_]*(\d{2,4})?\s*$/i;
const MONTH_ABBR_MAP = { january:"Jan",february:"Feb",march:"Mar",april:"Apr",may:"May",june:"Jun",july:"Jul",august:"Aug",september:"Sep",october:"Oct",november:"Nov",december:"Dec" };

function normalizePeriodLabel(cell) {
  const s = String(cell || "").trim();
  const m = s.match(/^(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)[\s.\-_]*(\d{2,4})?\s*$/i);
  if (!m) return s;
  const full = m[1].toLowerCase();
  const abbr = MONTH_ABBR_MAP[full] || (full[0].toUpperCase() + full.slice(1, 3));
  const yr = m[2] ? String(m[2]).slice(-2) : "";
  return yr ? `${abbr} ${yr}` : abbr;
}

function detectPeriodColumns(rawRows) {
  for (let i = 0; i < Math.min(10, rawRows.length); i++) {
    const row = Array.isArray(rawRows[i]) ? rawRows[i] : [];
    const periods = [];
    for (let j = 0; j < row.length; j++) {
      const cell = String(row[j] || "").trim();
      if (MONTH_PERIOD_RE.test(cell)) {
        periods.push({ label: normalizePeriodLabel(cell), colIdx: j });
      }
    }
    if (periods.length >= 3) {
      for (let j = 0; j < row.length; j++) {
        const cell = String(row[j] || "").trim();
        if (/^total$/i.test(cell)) {
          periods.push({ label: "Total", colIdx: j });
          break;
        }
      }
      return { headerRowIdx: i, periods };
    }
  }
  return null;
}

function extractRowsFromWorkbook(buffer, fileName = "", contentType = "") {
  let workbook;
  try {
    if (String(fileName).toLowerCase().endsWith(".csv") || String(contentType).toLowerCase().includes("csv")) {
      workbook = XLSX.read(buffer.toString("utf8"), { type: "string" });
    } else {
      workbook = XLSX.read(buffer, { type: "buffer" });
    }
  } catch (error) {
    throw new Error(`Unable to parse workbook: ${error.message}`);
  }

  const sheetName = workbook.SheetNames[0];
  const sheet = sheetName ? workbook.Sheets[sheetName] : null;
  if (!sheet) throw new Error("No worksheet found.");

  const rawRows = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: null,
    blankrows: false,
  });

  return rawRows.filter((row) => Array.isArray(row) && row.some(hasCellValue));
}

function extractPdfLines(buffer) {
  return new Promise((resolve, reject) => {
    // Copy the buffer into a fresh ArrayBuffer so it can be safely transferred
    // to the worker thread without sharing memory with the main thread pool.
    const owned = Buffer.from(buffer);
    const arrayBuffer = owned.buffer.slice(
      owned.byteOffset,
      owned.byteOffset + owned.byteLength,
    );

    const worker = new Worker(PDF_WORKER_PATH, {
      workerData: { arrayBuffer },
      transferList: [arrayBuffer],
    });

    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error("PDF parsing timed out"));
    }, PDF_PARSE_TIMEOUT_MS);

    const cleanup = () => clearTimeout(timer);

    worker.once("message", (msg) => {
      cleanup();
      if (msg.success) {
        resolve(
          String(msg.text)
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean),
        );
      } else {
        reject(new Error(msg.error || "PDF parsing failed"));
      }
    });

    worker.once("error", (err) => {
      cleanup();
      reject(err);
    });

    worker.once("exit", (code) => {
      cleanup();
      if (code !== 0) reject(new Error(`PDF worker exited with code ${code}`));
    });
  });
}

function isStandaloneYear(str = "") {
  return /^\d{4}$/.test(String(str).replace(/[$,()]/g, "").trim());
}

function isPageIndicatorLine(line = "") {
  const s = String(line).trim().toLowerCase();
  return /^page\s+\d+(\s+of\s+\d+)?$/.test(s) || /^\d+$/.test(s);
}

function extractAsOfDateFromLines(lines = []) {
  // "As of [date]" — used by Balance Sheet headers
  const asOfPattern = /as\s+of\s+([a-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4}|\d{4}[-/]\d{1,2}[-/]\d{1,2})/i;
  for (const line of lines.slice(0, 40)) {
    const match = line.match(asOfPattern);
    if (match?.[1]) {
      const date = toIsoDate(match[1].trim());
      if (date) return date;
    }
  }
  // Period range — used by P&L / Cash Flow headers (e.g. "January-December, 2022", "Oct 2021 - Sep 2022").
  // Match before the generic month pattern so the footer export date is not captured.
  const M = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
  const periodRange = new RegExp(`(?:${M})(?:\\s+\\d{4})?[\\s,\\-–]+(?:${M}),?\\s+(\\d{4})`, "i");
  for (const line of lines.slice(0, 20)) {
    const m = line.match(periodRange);
    if (m?.[1]) return `${m[1]}-12-31`;
  }
  // Generic "Month Day, Year" — last resort; may match footer timestamps
  const monthPattern = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},?\s+\d{4}/i;
  for (const line of lines.slice(0, 40)) {
    const match = line.match(monthPattern);
    if (match) {
      const date = toIsoDate(match[0]);
      if (date) return date;
    }
  }
  return null;
}

// Extracts start and end dates from a P&L/CF period header line.
// e.g. "January-December, 2022" → { start: "2022-01-01", end: "2022-12-31" }
//      "October 2021 - September 2022" → { start: "2021-10-01", end: "2022-09-30" }
function extractPeriodDatesFromLines(lines = []) {
  const MONTH_MAP = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
  const M = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
  // Two-month range: "(Month[ year]) - (Month[ year])"
  const rangeRe = new RegExp(
    `(${M})(?:\\s+(\\d{4}))?[\\s,\\-–]+` +
    `(${M}),?\\s+(\\d{4})`,
    "i",
  );
  for (const line of lines.slice(0, 20)) {
    const m = line.match(rangeRe);
    if (!m) continue;
    const startMonthKey = m[1].slice(0, 3).toLowerCase();
    const startMonthNum = MONTH_MAP[startMonthKey];
    const endMonthKey = m[3].slice(0, 3).toLowerCase();
    const endMonthNum = MONTH_MAP[endMonthKey];
    const endYear = parseInt(m[4], 10);
    const startYear = m[2] ? parseInt(m[2], 10) : endYear;
    if (!startMonthNum || !endMonthNum || !endYear) continue;
    const endDay = new Date(endYear, endMonthNum, 0).getDate(); // last day of end month
    return {
      start: `${startYear}-${String(startMonthNum).padStart(2, "0")}-01`,
      end: `${endYear}-${String(endMonthNum).padStart(2, "0")}-${String(endDay).padStart(2, "0")}`,
    };
  }
  return null;
}

function detectStatementType({ fileName = "", rows = [], lines = [] }) {
  const haystack = [
    fileName,
    ...rows.slice(0, 80).map((row) => (Array.isArray(row) ? row.join(" ") : "")),
    ...lines.slice(0, 120),
  ]
    .join(" ")
    .toLowerCase();

  const isBalanceSheet =
    haystack.includes("balance sheet") ||
    (haystack.includes("assets") &&
      haystack.includes("liabilities") &&
      haystack.includes("equity"));

  if (
    haystack.includes("cash flow") ||
    haystack.includes("operating activities") ||
    haystack.includes("investing activities") ||
    haystack.includes("financing activities")
  ) {
    return STATEMENT_TYPES.CASH_FLOW;
  }

  if (isBalanceSheet) {
    return STATEMENT_TYPES.BALANCE_SHEET;
  }

  if (
    haystack.includes("profit and loss") ||
    haystack.includes("profit & loss") ||
    haystack.includes("income statement") ||
    haystack.includes("ordinary income") ||
    haystack.includes("net income")
  ) {
    return STATEMENT_TYPES.PROFIT_AND_LOSS;
  }

  return null;
}

function buildNode(name, amount, type = "data", id = "", firstPeriodAmount = null, colAmounts = null) {
  const node = {
    id: id || `${type}-${normalizeSlug(name) || "row"}`,
    name: String(name || "").trim(),
    amount: roundMoney(Number(amount || 0)),
    type,
  };
  if (firstPeriodAmount !== null && firstPeriodAmount !== undefined) {
    node.firstPeriodAmount = roundMoney(Number(firstPeriodAmount));
  }
  if (Array.isArray(colAmounts) && colAmounts.length > 0) {
    node.colAmounts = colAmounts;
  }
  return node;
}

function buildSectionNode(name, children = [], id = "") {
  const normalizedChildren = Array.isArray(children) ? children.filter(Boolean) : [];
  const totalRow = normalizedChildren
    .slice()
    .reverse()
    .find((child) => child.type === "total");
  const computedAmount = totalRow
    ? totalRow.amount
    : roundMoney(
        normalizedChildren
          .filter((child) => child.type !== "total")
          .reduce((sum, child) => sum + Number(child.amount || 0), 0),
      );

  const node = {
    id: id || `section-${normalizeSlug(name) || "group"}`,
    name,
    amount: computedAmount,
    type: "header",
    children: normalizedChildren.length ? normalizedChildren : undefined,
  };

  const numPeriods = (normalizedChildren.find((c) => c.colAmounts)?.colAmounts || []).length;
  if (numPeriods > 0) {
    if (totalRow?.colAmounts?.length === numPeriods) {
      node.colAmounts = totalRow.colAmounts;
    } else {
      node.colAmounts = Array.from({ length: numPeriods }, (_, i) =>
        roundMoney(
          normalizedChildren
            .filter((c) => c.type !== "total")
            .reduce((sum, c) => sum + (c.colAmounts?.[i] || 0), 0),
        ),
      );
    }
  }

  return node;
}

function normalizeSectionName(value = "") {
  return normalizeText(value)
    .replace(/^total for\s+/, "")
    .replace(/^total\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isMetadataLikeLabel(label = "") {
  const normalized = normalizeText(label);
  return (
    normalized.startsWith("as of ") ||
    normalized.includes("accrual basis") ||
    normalized.includes("cash basis") ||
    normalized.includes("gmt") ||
    normalized.includes("am ") ||
    normalized.includes("pm ") ||
    /\bthrough\b/.test(normalized) ||
    /^(january|february|march|april|may|june|july|august|september|october|november|december)\b/.test(normalized) ||
    /^page\s+\d+/.test(normalized)
  );
}

function getBalanceSheetSectionLevel(label = "") {
  const normalized = normalizeSectionName(label);
  if (!normalized) return null;

  if (
    normalized === "assets" ||
    normalized === "liabilities and equity" ||
    normalized === "liabilities & equity"
  ) {
    return 0;
  }

  if (
    normalized === "liabilities" ||
    normalized === "equity" ||
    normalized === "current assets" ||
    normalized === "fixed assets" ||
    normalized === "other assets" ||
    normalized === "current liabilities" ||
    normalized === "long-term liabilities" ||
    normalized === "long term liabilities"
  ) {
    return 1;
  }

  if (
    normalized === "bank accounts" ||
    normalized === "other current assets" ||
    normalized === "credit cards" ||
    normalized === "other current liabilities"
  ) {
    return 2;
  }

  return null;
}

function matchBalanceSheetSectionStack(stack = [], totalLabel = "") {
  const normalizedTotal = normalizeSectionName(totalLabel);
  if (!normalizedTotal) return -1;

  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const sectionName = normalizeSectionName(stack[index]?.name || "");
    // Only match exact equality OR the section name is a substring of the total label
    // (e.g. "bank accounts" inside "total bank accounts" → normalizedTotal.includes(sectionName)).
    // Do NOT match the reverse (sectionName.includes(normalizedTotal)) because that causes
    // "liabilities & equity" to match "total liabilities", wiping the root from the stack.
    if (sectionName === normalizedTotal || normalizedTotal.includes(sectionName)) {
      return index;
    }
  }

  return -1;
}

function finalizeBalanceSheetSections(nodes = []) {
  return (Array.isArray(nodes) ? nodes : []).map((node) => {
    if (!node?.children) return node;
    return buildSectionNode(
      node.name,
      finalizeBalanceSheetSections(node.children),
      node.id,
    );
  });
}

function parseBalanceSheetHierarchy(entries = []) {
  const roots = [];
  const stack = [];

  const appendToCurrent = (node) => {
    if (stack.length) {
      stack[stack.length - 1].children.push(node);
      return;
    }
    roots.push(node);
  };

  entries.forEach((entry) => {
    const label = String(entry?.label || "").trim();
    if (!label || isMetadataLikeLabel(label)) return;

    const amount = entry?.amount;
    const isTotal = normalizeText(label).startsWith("total ");

    if (amount === null) {
      const level = getBalanceSheetSectionLevel(label);
      if (level === null) return;

      while (stack.length > level) {
        stack.pop();
      }

      const sectionNode = {
        id: `section-${normalizeSlug(label) || entry.index || "group"}`,
        name: label,
        children: [],
      };
      appendToCurrent(sectionNode);
      stack.push(sectionNode);
      return;
    }

    if (isTotal) {
      const matchedIndex = matchBalanceSheetSectionStack(stack, label);

      // Only pop deeper sections when we have an actual match.
      // If matchedIndex is -1 (unrecognised total such as "TOTAL LIABILITIES" when
      // only "LIABILITIES & EQUITY" is on the stack), we leave the stack as-is so
      // subsequent siblings (e.g. Equity) still nest under the right parent.
      if (matchedIndex >= 0) {
        while (stack.length - 1 > matchedIndex) {
          stack.pop();
        }
      }

      const totalNode = buildNode(
        label,
        amount,
        "total",
        `total-${normalizeSlug(label) || entry.index || "row"}`,
        null,
        entry.colAmounts ?? null,
      );
      appendToCurrent(totalNode);

      if (matchedIndex >= 0) {
        stack.splice(matchedIndex);
      }
      return;
    }

    appendToCurrent(
      buildNode(
        label,
        amount,
        "data",
        `${normalizeSlug(label) || "row"}-${entry.index + 1}`,
        null,
        entry.colAmounts ?? null,
      ),
    );
  });

  return finalizeBalanceSheetSections(roots);
}

function extractEntriesFromRows(rows = [], periodInfo = null) {
  const skipIdx = periodInfo?.headerRowIdx ?? -1;
  return rows
    .map((row, index) => {
      if (index === skipIdx) return null;
      const cells = Array.isArray(row) ? row : [];
      const entry = {
        label: firstTextCell(cells),
        amount: findAmountInCells(cells),
        index,
      };
      if (periodInfo?.periods?.length) {
        entry.colAmounts = periodInfo.periods.map(({ colIdx }) => {
          const val = parseAmount(cells[colIdx]);
          return val !== null ? roundMoney(val) : 0;
        });
      }
      return entry;
    })
    .filter((entry) => entry && entry.label);
}

function extractEntriesFromLines(lines = []) {
  const entries = [];
  let i = 0;

  while (i < lines.length) {
    const line = String(lines[i]).trim();

    if (!line || isPageIndicatorLine(line)) {
      i++;
      continue;
    }

    // Pattern 0: Multi-column line — 2+ dollar-prefixed amounts on the same line.
    // e.g. "Revenue  $1,000  $1,200  ...  $15,000"
    //      "Discounts  $383.88  $479.11  ...  $-22,266.07"
    // Label = text before the first $, firstPeriodAmount = first $ value, amount = last $ value.
    const dollarMatches = [...line.matchAll(/\$-?\d[\d,]*(?:\.\d+)?/g)];
    if (dollarMatches.length >= 2) {
      const firstDollarIdx = dollarMatches[0].index;
      const potentialLabel = line.slice(0, firstDollarIdx).replace(/[\s.\-_]+$/, "").trim();
      if (potentialLabel) {
        const firstPeriodAmount = roundMoney(parseAmount(dollarMatches[0][0]) || 0);
        const totalAmount = roundMoney(parseAmount(dollarMatches[dollarMatches.length - 1][0]) || 0);
        entries.push({ label: potentialLabel, amount: totalAmount, firstPeriodAmount, index: i });
        i++;
        continue;
      }
    }

    // Pattern 1: label and amount on the same line.
    // Handles: "Checking  12,345.00"  "Revenue  (5,000.00)"  "Retained Earnings  $-116,747.37"  "Account  -"
    const inlineMatch = line.match(/^(.*)\s+(\$-?\d[\d,]*(?:\.\d+)?|\(?-?\$?\d[\d,]*(?:\.\d+)?\)?|-)\s*$/);
    if (inlineMatch) {
      const potentialLabel = inlineMatch[1].replace(/[\s.\-_]+$/, "").trim();
      const amountStr = inlineMatch[2];

      if (potentialLabel && !isStandaloneYear(amountStr)) {
        const parsedAmt = amountStr === "-" ? 0 : (parseAmount(amountStr) || 0);
        entries.push({ label: potentialLabel, amount: roundMoney(parsedAmt), index: i });
        i++;
        continue;
      }
    }

    // Pattern 1.5: Amount directly concatenated to label with no whitespace separator.
    // QuickBooks PDF exports often lose the column gap when parsed by pdf-parse.
    // e.g. "Total for Income$111,604.89", "In8 Revenue Share30,591.39", "Net Income-$166,405.04"
    // Strategy: find the rightmost financial amount at the end of the line.
    const concatAmtSuffix = line.match(/(-?\$\d{1,3}(?:,\d{3})*(?:\.\d+)?|\$-?\d{1,3}(?:,\d{3})*(?:\.\d+)?|-?\d{1,3}(?:,\d{3})+\.\d{2,}|-?\d+\.\d{2})$/);
    if (concatAmtSuffix) {
      const matchedAmt = concatAmtSuffix[1];
      const splitAt = line.lastIndexOf(matchedAmt);
      const potentialLabel = line.slice(0, splitAt).replace(/[\s.\-_]+$/, "").trim();
      // Only accept if label is non-empty, not purely numeric, and not a year.
      if (potentialLabel && potentialLabel.length >= 2 && !/^\d+$/.test(potentialLabel) && !isStandaloneYear(matchedAmt)) {
        entries.push({ label: potentialLabel, amount: roundMoney(parseAmount(matchedAmt) || 0), index: i });
        i++;
        continue;
      }
    }

    // Pattern 2: label on this line, standalone amount on the very next line.
    // Handles PDFs where label and value appear on alternating lines.
    if (i + 1 < lines.length) {
      const nextLine = String(lines[i + 1]).trim();
      const isNextAmount =
        (/^\$?-?\d[\d,]*(?:\.\d+)?$/.test(nextLine) || /^\(-?\d[\d,]*(?:\.\d+)?\)$/.test(nextLine) || nextLine === "-") &&
        !isPageIndicatorLine(nextLine) &&
        !isStandaloneYear(nextLine);

      if (isNextAmount) {
        const parsedAmt = nextLine === "-" ? 0 : (parseAmount(nextLine) || 0);
        entries.push({ label: line, amount: roundMoney(parsedAmt), index: i });
        i += 2;
        continue;
      }
    }

    // No amount found — section header or metadata line.
    entries.push({ label: line, amount: null, index: i });
    i++;
  }

  return entries.filter((entry) => entry.label);
}

function normalizeSectionLabel(value = "") {
  return normalizeText(value)
    .replace(/^total for\s+/, "")
    .replace(/^total\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isCrossSectionSummary(label = "") {
  const norm = normalizeText(label);
  return (
    /^gross profit/.test(norm) ||
    /^gross loss/.test(norm) ||
    /^net operating income/.test(norm) ||
    /^net operating loss/.test(norm) ||
    /^net other income/.test(norm) ||
    /^net other expense/.test(norm) ||
    /^net income/.test(norm) ||
    /^net loss/.test(norm) ||
    /^net earnings/.test(norm)
  );
}

function parseSectionedStatement(entries = [], sectionDefinitions = [], options = {}) {
  const rows = [];
  let currentSection = null;
  const exactMatchOnly = options.exactMatchOnly !== false;

  const findSection = (label = "") => {
    const normalized = normalizeSectionLabel(label);
    return sectionDefinitions.find((section) =>
      section.matches.some((keyword) => {
        const normalizedKeyword = normalizeSectionLabel(keyword);
        return exactMatchOnly
          ? normalized === normalizedKeyword
          : normalized.includes(normalizedKeyword);
      }),
    );
  };

  entries.forEach((entry) => {
    const section = findSection(entry.label);
    if (section && entry.amount === null) {
      if (currentSection?.id === section.id) {
        // Already in this section — update name to the simpler form if the current
        // has a "/" (wrapper like "Ordinary Income/Expense") and the new label doesn't.
        if (currentSection.name.includes("/") && !entry.label.includes("/")) {
          currentSection.name = entry.label;
        }
        return;
      }
      currentSection = {
        name: entry.label,
        id: section.id,
        children: [],
      };
      rows.push(currentSection);
      return;
    }

    if (entry.amount === null) return;

    // Summary rows that sit between sections (Gross Profit, Net Operating Income, etc.)
    // must appear at top level, not inside whatever section happened to be open.
    if (isCrossSectionSummary(entry.label)) {
      currentSection = null;
      rows.push(
        buildNode(
          entry.label,
          entry.amount,
          "total",
          `${normalizeSlug(entry.label) || "row"}-${entry.index + 1}`,
          entry.firstPeriodAmount ?? null,
          entry.colAmounts ?? null,
        ),
      );
      return;
    }

    const target = currentSection?.children ? currentSection.children : rows;
    const normalizedLabel = normalizeText(entry.label);
    const type =
      normalizedLabel.includes("total ") ||
      normalizedLabel.includes("net income") ||
      normalizedLabel.includes("gross profit") ||
      normalizedLabel.includes("net cash") ||
      normalizedLabel.includes("ending cash") ||
      normalizedLabel.includes("ending balance")
        ? "total"
        : "data";

    target.push(
      buildNode(
        entry.label,
        entry.amount,
        type,
        `${normalizeSlug(entry.label) || "row"}-${entry.index + 1}`,
        entry.firstPeriodAmount ?? null,
        entry.colAmounts ?? null,
      ),
    );
  });

  return rows.map((row) =>
    row?.children ? buildSectionNode(row.name, row.children, row.id) : row,
  );
}

// Statement types that require AI (Gemini) parsing in QMS mode.
// Balance Sheet, P&L, and Cash Flow use the rule-based parser only.
const QMS_AI_STATEMENT_TYPES = new Set(["tax_return", "bank_statement", "bank_reconciliation"]);

async function parseStoredReport(upload, forcedStatementType = null, { skipAI = false } = {}) {
  const buffer = normalizeUploadBinary(upload?.data);
  const fileName = String(upload?.file_name || "");
  const contentType = String(upload?.content_type || "");
  const lowerFileName = fileName.toLowerCase();
  const isPdf = lowerFileName.endsWith(".pdf") || contentType.toLowerCase().includes("pdf");

  // ── Gemini path for PDFs ────────────────────────────────────────────────
  // Skipped when skipAI=true (QMS mode for non-AI statement types).
  if (isPdf && process.env.GEMINI_API_KEY && !skipAI) {
    try {
      const geminiResult = await parsePdfWithGemini(buffer, fileName);
      if (Array.isArray(geminiResult.rows) && geminiResult.rows.length > 0) {
        const statementType = forcedStatementType || geminiResult.statementType;
        console.log(`[ManualReportUpload] Gemini parsed "${fileName}" as ${statementType} (${geminiResult.rows.length} top-level rows)`);
        return {
          statementType,
          parserType: "gemini",
          report: {
            rows: geminiResult.rows,
            asOfDate: geminiResult.asOfDate || geminiResult.periodEnd || null,
            periodStart: geminiResult.periodStart || null,
            periodEnd: geminiResult.periodEnd || geminiResult.asOfDate || null,
          },
        };
      }
    } catch (geminiError) {
      console.warn(`[ManualReportUpload] Gemini failed for "${fileName}", falling back to text extraction: ${geminiError.message}`);
    }
  }

  // ── Text-extraction fallback (Excel / non-Gemini PDF) ──────────────────
  let rows = [];
  let lines = [];
  let parserType = "excel";

  if (isPdf) {
    parserType = "pdf";
    lines = await extractPdfLines(buffer);
    console.log(`[ManualReportUpload] PDF text fallback "${fileName}" → ${lines.length} lines`);
    if (lines.length > 0) console.log(`[ManualReportUpload] First 10 lines:`, lines.slice(0, 10));
  } else {
    rows = extractRowsFromWorkbook(buffer, fileName, contentType);
  }

  // Detect monthly period columns in Excel files (e.g. "P&L by Month" with Jan 22 … Dec 25 headers)
  const periodInfo = (!isPdf && rows.length) ? detectPeriodColumns(rows) : null;

  const statementType = forcedStatementType || detectStatementType({ fileName, rows, lines });
  console.log(`[ManualReportUpload] "${fileName}" detected as: ${statementType || "unknown"}${forcedStatementType ? " (forced)" : ""}${periodInfo ? ` [${periodInfo.periods.length} period columns]` : ""}`);
  if (!statementType) return null;

  if (statementType === STATEMENT_TYPES.BALANCE_SHEET) {
    let asOfDate = null;

    if (parserType === "pdf") {
      asOfDate = extractAsOfDateFromLines(lines);
    } else {
      try {
        const structured = processBalanceSheet({ rawRows: rows });
        asOfDate = structured.asOfDate || null;
      } catch (error) {
        console.warn(
          `[ManualReportUpload] Balance Sheet normalization fallback for ${fileName}: ${error.message}`,
        );
      }
    }

    const entries = rows.length ? extractEntriesFromRows(rows, periodInfo) : extractEntriesFromLines(lines);
    const hierarchyRows = parseBalanceSheetHierarchy(entries);

    return {
      statementType,
      parserType,
      report: {
        rows: hierarchyRows.length ? hierarchyRows : [],
        asOfDate,
        ...(periodInfo ? { periods: periodInfo.periods.map((p) => p.label) } : {}),
      },
    };
  }

  const entries = rows.length ? extractEntriesFromRows(rows, periodInfo) : extractEntriesFromLines(lines);
  const sectionDefinitions =
    statementType === STATEMENT_TYPES.PROFIT_AND_LOSS
      ? [
          {
            id: "income",
            name: "Income",
            matches: ["income", "revenue", "ordinary income", "ordinary income/expense"],
          },
          {
            id: "cost-of-sales",
            name: "Cost of Sales",
            matches: ["cost of goods sold", "cost of sales", "cost of goods sold/cost of sales"],
          },
          {
            id: "expenses",
            name: "Expenses",
            matches: ["expenses", "expense", "operating expenses"],
          },
          {
            id: "other-income",
            name: "Other Income / Expense",
            matches: ["other income", "other expense", "other income / expense", "other income expense", "net other income"],
          },
        ]
      : [
          { id: "operating", name: "Operating Activities", matches: ["operating activities"] },
          { id: "investing", name: "Investing Activities", matches: ["investing activities"] },
          { id: "financing", name: "Financing Activities", matches: ["financing activities"] },
        ];

  const exactMatchOnly = parserType !== "pdf" && statementType === STATEMENT_TYPES.PROFIT_AND_LOSS;

  // Extract date period for P&L / Cash Flow
  let reportAsOfDate = null;
  let reportPeriodStart = null;
  let reportPeriodEnd = null;

  if (parserType === "pdf" && lines.length > 0) {
    // Try to extract a precise period range first (e.g. "January-December, 2022")
    const periodDates = extractPeriodDatesFromLines(lines);
    if (periodDates) {
      reportPeriodStart = periodDates.start;
      reportPeriodEnd = periodDates.end;
      reportAsOfDate = periodDates.end;
    } else {
      reportAsOfDate = extractAsOfDateFromLines(lines);
    }
  }
  if (!reportAsOfDate && parserType === "excel" && rows.length > 0) {
    // Scan first 10 rows for a 4-digit year (e.g. "January through December 2024")
    for (const row of rows.slice(0, 10)) {
      const rowText = (Array.isArray(row) ? row : []).map((c) => String(c || "")).join(" ");
      const yearMatch = rowText.match(/\b(20\d{2})\b/);
      if (yearMatch) {
        reportAsOfDate = `${yearMatch[1]}-12-31`;
        break;
      }
    }
  }
  // Fallback: try to infer year from fileName (e.g. "ProfitLoss_2023.pdf")
  if (!reportAsOfDate) {
    const yearInName = String(fileName).match(/\b(20\d{2})\b/);
    if (yearInName) reportAsOfDate = `${yearInName[1]}-12-31`;
  }

  return {
    statementType,
    parserType,
    report: {
      rows: parseSectionedStatement(entries, sectionDefinitions, { exactMatchOnly }),
      asOfDate: reportAsOfDate,
      ...(reportPeriodStart ? { periodStart: reportPeriodStart } : {}),
      ...(reportPeriodEnd ? { periodEnd: reportPeriodEnd } : {}),
      ...(periodInfo ? { periods: periodInfo.periods.map((p) => p.label) } : {}),
    },
  };
}

async function loadUpload(uploadId) {
  const { data: upload, error } = await supabase
    .from("uploads")
    .select("id, file_name, content_type, data")
    .eq("id", uploadId)
    .maybeSingle();

  if (error) throw new Error(`Upload read failed: ${error.message}`);
  if (!upload) throw new Error("Upload not found.");
  return upload;
}

async function loadUploadForDoc(doc) {
  if (doc.upload_id) {
    const { data: up } = await supabase
      .from("uploads").select("id, file_name, content_type, data").eq("id", doc.upload_id).maybeSingle();
    if (up?.data) return up;
  }
  if (doc.file_url) {
    const m = String(doc.file_url).match(/\/uploads\/([0-9a-f-]{36})\/content/i);
    if (m) {
      const { data: up } = await supabase
        .from("uploads").select("id, file_name, content_type, data").eq("id", m[1]).maybeSingle();
      if (up?.data) return up;
    }
  }
  throw new Error("No upload binary found for this document");
}

async function syncManualReportFolder({ companyId, folderId, folderName = "" }) {
  if (!companyId) throw new Error("companyId is required");
  if (!folderId) throw new Error("folderId is required");

  const { data: documents, error } = await supabase
    .from("documents")
    .select("id, name, upload_id, file_url")
    .eq("folder_id", folderId)
    .not("upload_id", "is", null)
    .order("uploaded_at", { ascending: false });

  if (error) {
    throw new Error(`Failed to load folder documents: ${error.message}`);
  }

  const processed = [];
  const skipped = [];
  const now = new Date().toISOString();

  // Process all documents in parallel — each PDF spins up its own worker thread
  // so the main event loop stays free and multiple files don't queue behind each other.
  const settlements = await Promise.allSettled(
    (documents || []).map(async (document) => {
      const upload = await loadUpload(document.upload_id);
      const parsed = await parseStoredReport(upload);

      if (!parsed?.statementType || !parsed?.report?.rows?.length) {
        return { skipped: true, documentId: document.id, fileName: document.name, reason: "Unsupported or unreadable report" };
      }

      // Remove any previous record for this exact document before inserting the fresh one.
      // (report_params is JSONB — no unique constraint exists on it, so upsert onConflict
      // is not usable; delete-then-insert achieves the same idempotent result.)
      await supabase
        .from("qb_synced_reports")
        .delete()
        .eq("company_id", companyId)
        .eq("source", MANUAL_REPORT_UPLOAD_SOURCE)
        .eq("report_type", parsed.statementType)
        .filter("report_params->>documentId", "eq", document.id);

      const { error: upsertError } = await supabase
        .from("qb_synced_reports")
        .insert({
          company_id: companyId,
          report_type: parsed.statementType,
          report_params: {
            folderId,
            folderName,
            documentId: document.id,
            uploadId: document.upload_id,
            fileName: document.name,
          },
          data: {
            manual_report_upload: {
              statementType: parsed.statementType,
              parserType: parsed.parserType,
              folderId,
              folderName,
              documentId: document.id,
              uploadId: document.upload_id,
              fileName: document.name,
              fileUrl: document.file_url || null,
              report: parsed.report,
              syncedAt: now,
            },
          },
          source: MANUAL_REPORT_UPLOAD_SOURCE,
          status: "synced",
          last_synced_at: now,
          updated_at: now,
        });

      if (upsertError) throw new Error(upsertError.message);

      return { skipped: false, documentId: document.id, fileName: document.name, statementType: parsed.statementType };
    }),
  );

  for (let idx = 0; idx < settlements.length; idx++) {
    const doc = (documents || [])[idx];
    const settlement = settlements[idx];
    if (settlement.status === "fulfilled") {
      const val = settlement.value;
      if (val.skipped) {
        skipped.push({ documentId: val.documentId, fileName: val.fileName, reason: val.reason });
      } else {
        processed.push({ documentId: val.documentId, fileName: val.fileName, statementType: val.statementType });
      }
    } else {
      skipped.push({ documentId: doc?.id, fileName: doc?.name, reason: settlement.reason?.message || "Processing failed" });
    }
  }

  try {
    await updateReportSourceRecord(companyId, REPORT_SOURCE_KEYS.MANUAL_UPLOAD, {
      isAvailable: processed.length > 0,
      isConnected: false,
      lastSyncedAt: processed.length > 0 ? now : null,
      metadata: {
        selectedFolderId: folderId,
        selectedFolderName: folderName || null,
        syncedReportTypes: Array.from(new Set(processed.map((item) => item.statementType))),
        processedCount: processed.length,
        skippedCount: skipped.length,
      },
    });
  } catch (updateError) {
    console.warn("[ManualReportUpload] Failed to update source record:", updateError.message);
  }

  return {
    folderId,
    folderName,
    processed,
    skipped,
    processedCount: processed.length,
  };
}

async function getLatestManualUploadedReport({ companyId, statementType }) {
  if (!companyId) throw new Error("companyId is required");
  if (!statementType) throw new Error("statementType is required");

  const { data, error } = await supabase
    .from("qb_synced_reports")
    .select("id, report_type, report_params, data, updated_at, last_synced_at")
    .eq("company_id", companyId)
    .eq("source", MANUAL_REPORT_UPLOAD_SOURCE)
    .eq("report_type", statementType)
    .order("updated_at", { ascending: false })
    .order("last_synced_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Manual uploaded report fetch failed: ${error.message}`);
  }

  return data || null;
}

async function getAllManualUploadedReports({ companyId, statementType }) {
  if (!companyId) throw new Error("companyId is required");
  if (!statementType) throw new Error("statementType is required");

  const { data, error } = await supabase
    .from("qb_synced_reports")
    .select("id, report_type, report_params, data, updated_at, last_synced_at")
    .eq("company_id", companyId)
    .eq("source", MANUAL_REPORT_UPLOAD_SOURCE)
    .eq("report_type", statementType)
    .order("updated_at", { ascending: true });

  if (error) {
    throw new Error(`Manual uploaded reports fetch failed: ${error.message}`);
  }

  return data || [];
}

// ── Manual Upload Source sync ─────────────────────────────────────────────────

const SOURCE_FOLDER_NAME = "Manual Upload Source";
const QMS_FOLDER_NAME = "Quickbooks Manual Source";
const QMS_REPORT_UPLOAD_SOURCE = "quickbooks_manual_upload";

async function getAllQMSUploadedReports({ companyId, statementType }) {
  if (!companyId) throw new Error("companyId is required");
  if (!statementType) throw new Error("statementType is required");

  const { data, error } = await supabase
    .from("qb_synced_reports")
    .select("id, report_type, report_params, data, updated_at, last_synced_at")
    .eq("company_id", companyId)
    .eq("source", QMS_REPORT_UPLOAD_SOURCE)
    .eq("report_type", statementType)
    .order("updated_at", { ascending: true });

  if (error) throw new Error(`QMS uploaded reports fetch failed: ${error.message}`);
  return data || [];
}

async function getLatestQMSUploadedReport({ companyId, statementType }) {
  if (!companyId) throw new Error("companyId is required");
  if (!statementType) throw new Error("statementType is required");

  const { data, error } = await supabase
    .from("qb_synced_reports")
    .select("id, report_type, report_params, data, updated_at, last_synced_at")
    .eq("company_id", companyId)
    .eq("source", QMS_REPORT_UPLOAD_SOURCE)
    .eq("report_type", statementType)
    .order("updated_at", { ascending: false })
    .order("last_synced_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`QMS latest report fetch failed: ${error.message}`);
  return data || null;
}

async function syncBankReconciliationFolder(companyId, folder, now) {
  const { data: documents } = await supabase
    .from("documents")
    .select("id, name, upload_id, file_url")
    .eq("folder_id", folder.id)
    .order("uploaded_at", { ascending: false });

  if (!documents?.length) {
    return { success: false, reason: "No files in folder", processed: [] };
  }

  const allStatements = [];
  const processedDocs = [];

  for (const doc of documents) {
    const fileName = String(doc.name || "bank_statement.pdf");
    if (!fileName.toLowerCase().endsWith(".pdf")) {
      console.log(`[BankSync] Skipping non-PDF: "${fileName}"`);
      continue;
    }

    let buffer = null;

    if (doc.upload_id) {
      const { data: upload } = await supabase
        .from("uploads").select("data").eq("id", doc.upload_id).maybeSingle();
      if (upload?.data) buffer = normalizeBankBinary(upload.data);
    }

    if (!buffer && doc.file_url) {
      const urlMatch = String(doc.file_url).match(/\/uploads\/([0-9a-f-]{36})\/content/i);
      if (urlMatch) {
        const { data: upload2 } = await supabase
          .from("uploads").select("data").eq("id", urlMatch[1]).maybeSingle();
        if (upload2?.data) {
          buffer = normalizeBankBinary(upload2.data);
          console.log(`[BankSync] Loaded "${fileName}" via inferred upload id`);
        }
      }
    }

    if (!buffer?.length) {
      console.warn(`[BankSync] No binary data for "${fileName}", skipping`);
      continue;
    }

    try {
      const statements = await extractBankStatementsFromPdfBase64(buffer.toString("base64"), fileName);
      allStatements.push(...statements);
      processedDocs.push({ documentId: doc.id, fileName, statementType: STATEMENT_TYPES.BANK_RECONCILIATION });
    } catch (err) {
      console.error(`[BankSync] Gemini failed for "${fileName}": ${err.message}`);
    }
  }

  if (!allStatements.length) {
    return { success: false, reason: "No bank statement data could be extracted", processed: [] };
  }

  const { banks, months, totals } = buildBankResponseShape(allStatements);

  // Upsert one aggregate record per company for bank reconciliation
  const { data: existing } = await supabase
    .from("qb_synced_reports")
    .select("id")
    .eq("company_id", companyId)
    .eq("source", MANUAL_REPORT_UPLOAD_SOURCE)
    .eq("report_type", STATEMENT_TYPES.BANK_RECONCILIATION)
    .maybeSingle();

  const payload = {
    company_id: companyId,
    report_type: STATEMENT_TYPES.BANK_RECONCILIATION,
    report_params: { sourceFolderName: SOURCE_FOLDER_NAME, folderName: folder.name },
    data: {
      bank_reconciliation: {
        banks,
        months,
        totals,
        syncedAt: now,
        documentCount: processedDocs.length,
      },
    },
    source: MANUAL_REPORT_UPLOAD_SOURCE,
    status: "synced",
    last_synced_at: now,
    updated_at: now,
  };

  let upsertError;
  if (existing?.id) {
    ({ error: upsertError } = await supabase
      .from("qb_synced_reports").update(payload).eq("id", existing.id));
  } else {
    ({ error: upsertError } = await supabase
      .from("qb_synced_reports").insert(payload));
  }

  if (upsertError) throw new Error(upsertError.message);

  console.log(`[BankSync] Stored bank reconciliation data for company ${companyId}: ${banks.length} bank(s), ${months.length} month(s)`);
  return { success: true, processed: processedDocs };
}

// Maps lowercase subfolder name → forced statement type
const SUBFOLDER_STATEMENT_MAP = {
  "balance sheet": STATEMENT_TYPES.BALANCE_SHEET,
  "profit & loss": STATEMENT_TYPES.PROFIT_AND_LOSS,
  "profit and loss": STATEMENT_TYPES.PROFIT_AND_LOSS,
  "cashflow": STATEMENT_TYPES.CASH_FLOW,
  "cash flow": STATEMENT_TYPES.CASH_FLOW,
  "bank reconciliation": STATEMENT_TYPES.BANK_RECONCILIATION,
  "bank statement": STATEMENT_TYPES.BANK_RECONCILIATION,
  "tax reconciliation": STATEMENT_TYPES.TAX_RETURN,
  "tax return": STATEMENT_TYPES.TAX_RETURN,
};

async function getManualUploadSourceTree(companyId) {
  if (!companyId) throw new Error("companyId is required");

  const { data: sourceFolder } = await supabase
    .from("folders")
    .select("id, name")
    .eq("company_id", companyId)
    .is("parent_id", null)
    .ilike("name", SOURCE_FOLDER_NAME)
    .maybeSingle();

  if (!sourceFolder) return null;

  const { data: children } = await supabase
    .from("folders")
    .select("id, name")
    .eq("parent_id", sourceFolder.id)
    .order("created_at", { ascending: true });

  const result = [];

  for (const child of (children || [])) {
    const nameLower = child.name.toLowerCase().trim();

    if (nameLower === "reports") {
      const { data: reportChildren } = await supabase
        .from("folders")
        .select("id, name")
        .eq("parent_id", child.id)
        .order("created_at", { ascending: true });

      const subItems = await Promise.all((reportChildren || []).map(async (rc) => {
        const { count } = await supabase
          .from("documents")
          .select("id", { count: "exact", head: true })
          .eq("folder_id", rc.id);
        return {
          id: rc.id,
          name: rc.name,
          statementType: SUBFOLDER_STATEMENT_MAP[rc.name.toLowerCase().trim()] || null,
          fileCount: count || 0,
        };
      }));

      result.push({ id: child.id, name: child.name, isGroup: true, children: subItems });
    } else {
      const { count } = await supabase
        .from("documents")
        .select("id", { count: "exact", head: true })
        .eq("folder_id", child.id);

      result.push({
        id: child.id,
        name: child.name,
        statementType: SUBFOLDER_STATEMENT_MAP[nameLower] || null,
        fileCount: count || 0,
        isGroup: false,
      });
    }
  }

  return { id: sourceFolder.id, name: sourceFolder.name, children: result };
}

async function syncManualUploadSource(companyId) {
  if (!companyId) throw new Error("companyId is required");

  const sourceTree = await getManualUploadSourceTree(companyId);
  if (!sourceTree) {
    throw new Error(`"${SOURCE_FOLDER_NAME}" folder not found in DataRoom.`);
  }

  // Collect all leaf folders that map to a statement type
  const foldersToSync = [];
  for (const item of sourceTree.children) {
    if (item.isGroup) {
      for (const sub of (item.children || [])) {
        if (sub.statementType) foldersToSync.push({ folder: sub, statementType: sub.statementType });
      }
    } else if (item.statementType) {
      foldersToSync.push({ folder: item, statementType: item.statementType });
    }
  }

  // Clear all existing manual upload records for this company so removed/renamed
  // files don't leave stale rows behind after re-sync.
  const { error: deleteError } = await supabase
    .from("qb_synced_reports")
    .delete()
    .eq("company_id", companyId)
    .eq("source", MANUAL_REPORT_UPLOAD_SOURCE);

  if (deleteError) {
    throw new Error(`Failed to clear existing records before sync: ${deleteError.message}`);
  }

  const now = new Date().toISOString();
  const processed = [];
  const failed = [];

  for (const { folder, statementType } of foldersToSync) {
    // Bank reconciliation uses Gemini bank extraction — handled separately
    if (statementType === STATEMENT_TYPES.BANK_RECONCILIATION) {
      try {
        const bankResult = await syncBankReconciliationFolder(companyId, folder, now);
        processed.push(...(bankResult.processed || []));
        failed.push(...(bankResult.failed || []));
        if (!bankResult.success && !bankResult.failed?.length && bankResult.reason !== "No files in folder") {
          failed.push({ fileName: folder.name, folderName: folder.name, reason: bankResult.reason || "Bank extraction failed" });
        }
      } catch (err) {
        failed.push({ fileName: folder.name, folderName: folder.name, reason: err.message });
      }
      continue;
    }

    // Tax reconciliation uses Gemini vision (image-based PDF support) — handled separately
    if (statementType === STATEMENT_TYPES.TAX_RETURN) {
      try {
        console.log(`[Sync] Processing Tax Reconciliation folder "${folder.name}"...`);
        const taxResult = await syncTaxReturnFolder(companyId, folder, now);
        processed.push(...(taxResult.processed || []));
        failed.push(...(taxResult.failed || []));
      } catch (err) {
        failed.push({ fileName: folder.name, folderName: folder.name, reason: err.message });
      }
      continue;
    }

    // Profit & Loss: also run Gemini/text extraction for Tax Reconciliation page (pl_for_tax)
    // This is a secondary operation — failures here don't affect the main P&L sync result
    if (statementType === STATEMENT_TYPES.PROFIT_AND_LOSS) {
      try {
        console.log(`[Sync] Running P&L extraction for Tax Recon page from "${folder.name}"...`);
        await syncPLForTaxFolder(companyId, folder, now);
      } catch (err) {
        console.warn(`[Sync] P&L extraction for tax recon skipped: ${err.message}`);
      }
      // Fall through to run the normal Excel/pattern-matching P&L sync as well
    }

    const { data: documents } = await supabase
      .from("documents")
      .select("id, name, upload_id, file_url")
      .eq("folder_id", folder.id)
      .order("uploaded_at", { ascending: false });

    if (!documents?.length) {
      // Empty folder — silently skip, don't count as failed
      continue;
    }

    const settlements = await Promise.allSettled(
      documents.map(async (doc) => {
        let upload;
        try {
          upload = await loadUploadForDoc(doc);
        } catch (err) {
          return { failed: true, documentId: doc.id, fileName: doc.name, folderName: folder.name, reason: err.message };
        }
        const parsed = await parseStoredReport(upload, statementType);

        if (!parsed?.report?.rows?.length) {
          return { failed: true, documentId: doc.id, fileName: doc.name, folderName: folder.name, reason: "No parseable data in file" };
        }

        const resolvedUploadId = upload.id || doc.upload_id || null;
        // All existing records for this company were deleted above; plain insert is safe.
        const { error: upsertError } = await supabase
          .from("qb_synced_reports")
          .insert({
            company_id: companyId,
            report_type: statementType,
            report_params: {
              sourceFolderName: SOURCE_FOLDER_NAME,
              folderId: folder.id,
              folderName: folder.name,
              documentId: doc.id,
              uploadId: resolvedUploadId,
              fileName: doc.name,
            },
            data: {
              manual_report_upload: {
                statementType,
                parserType: parsed.parserType,
                folderId: folder.id,
                folderName: folder.name,
                documentId: doc.id,
                uploadId: resolvedUploadId,
                fileName: doc.name,
                fileUrl: doc.file_url || null,
                report: parsed.report,
                syncedAt: now,
              },
            },
            source: MANUAL_REPORT_UPLOAD_SOURCE,
            status: "synced",
            last_synced_at: now,
            updated_at: now,
          });

        if (upsertError) throw new Error(upsertError.message);
        return { failed: false, documentId: doc.id, fileName: doc.name, statementType, folderName: folder.name };
      }),
    );

    for (let i = 0; i < settlements.length; i++) {
      const s = settlements[i];
      if (s.status === "fulfilled") {
        s.value.failed ? failed.push(s.value) : processed.push(s.value);
      } else {
        failed.push({ folderName: folder.name, fileName: documents[i]?.name, reason: s.reason?.message });
      }
    }
  }

  try {
    await updateReportSourceRecord(companyId, REPORT_SOURCE_KEYS.MANUAL_UPLOAD, {
      isAvailable: processed.length > 0,
      isConnected: false,
      lastSyncedAt: processed.length > 0 ? now : null,
      metadata: {
        sourceFolderName: SOURCE_FOLDER_NAME,
        syncedReportTypes: Array.from(new Set(processed.map((p) => p.statementType))),
        processedCount: processed.length,
        failedCount: failed.length,
      },
    });
  } catch (e) {
    console.warn("[ManualReportUpload] Failed to update source record:", e.message);
  }

  return {
    sourceFolderName: SOURCE_FOLDER_NAME,
    processedCount: processed.length,
    processed,
    failed,
  };
}

/**
 * Lazily extracts asOfDate from the source binary when it was not saved during sync.
 * Tries: PDF text extraction → Excel row scan → filename regex.
 * If found, patches the qb_synced_reports row so the next call is instant.
 */
async function extractAndCacheReportAsOfDate(reportRow) {
  if (!reportRow?.id) return null;

  const uploadId =
    reportRow?.data?.manual_report_upload?.uploadId ||
    reportRow?.report_params?.uploadId ||
    null;

  if (!uploadId) {
    // Last-resort: year in fileName from report_params
    const fn = String(reportRow?.report_params?.fileName || reportRow?.data?.manual_report_upload?.fileName || "");
    const m = fn.match(/\b(20\d{2})\b/);
    return m ? `${m[1]}-12-31` : null;
  }

  let upload = null;
  try {
    upload = await loadUpload(uploadId);
  } catch {
    return null;
  }

  const buffer = normalizeUploadBinary(upload?.data);
  const fileName = String(upload?.file_name || reportRow?.report_params?.fileName || "");
  const contentType = String(upload?.content_type || "");
  const isPdf =
    fileName.toLowerCase().endsWith(".pdf") ||
    contentType.toLowerCase().includes("pdf");

  let asOfDate = null;

  // PDF: run text extractor then scan header lines
  if (isPdf && buffer?.length) {
    try {
      const lines = await extractPdfLines(buffer);
      asOfDate = extractAsOfDateFromLines(lines);
      // Also try a year-range pattern: "January through December 2023"
      if (!asOfDate) {
        for (const line of lines.slice(0, 40)) {
          const m = line.match(/\b(20\d{2})\b/);
          if (m) { asOfDate = `${m[1]}-12-31`; break; }
        }
      }
    } catch { /* ignore PDF parse failure */ }
  }

  // Excel: scan first rows for year
  if (!asOfDate && !isPdf && buffer?.length) {
    try {
      const rows = extractRowsFromWorkbook(buffer, fileName, contentType);
      for (const row of rows.slice(0, 10)) {
        const text = (Array.isArray(row) ? row : []).map((c) => String(c || "")).join(" ");
        const m = text.match(/\b(20\d{2})\b/);
        if (m) { asOfDate = `${m[1]}-12-31`; break; }
      }
    } catch { /* ignore */ }
  }

  // Filename fallback
  if (!asOfDate) {
    const m = fileName.match(/\b(20\d{2})\b/);
    if (m) asOfDate = `${m[1]}-12-31`;
  }

  // Gemini vision fallback — for image-based PDFs where text extraction fails.
  // Send only the first page bytes with a minimal year-detection prompt.
  if (!asOfDate && isPdf && buffer?.length && process.env.GEMINI_API_KEY) {
    try {
      const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });
      const result = await model.generateContent([
        {
          inlineData: {
            mimeType: "application/pdf",
            data: buffer.toString("base64"),
          },
        },
        "Look at this financial document. What is the fiscal year or reporting period it covers? " +
        "Reply ONLY with a raw JSON object: {\"year\": 2023} — use the END year if it spans multiple years.",
      ]);
      const raw = result.response.text().trim()
        .replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
      const parsed = JSON.parse(raw);
      if (parsed?.year && /^20\d{2}$/.test(String(parsed.year))) {
        asOfDate = `${parsed.year}-12-31`;
        console.log(`[ManualReport] Gemini vision detected year=${parsed.year} for record ${reportRow.id}`);
      }
    } catch (e) {
      console.warn(`[ManualReport] Gemini year fallback failed: ${e.message}`);
    }
  }

  // Patch the stored record so subsequent calls are instant
  if (asOfDate) {
    try {
      const mu = reportRow.data?.manual_report_upload || {};
      const updatedData = {
        ...reportRow.data,
        manual_report_upload: {
          ...mu,
          report: { ...(mu.report || {}), asOfDate },
        },
      };
      await supabase.from("qb_synced_reports").update({ data: updatedData }).eq("id", reportRow.id);
      console.log(`[ManualReport] Lazily patched asOfDate=${asOfDate} for record ${reportRow.id}`);
    } catch (e) {
      console.warn(`[ManualReport] Failed to patch asOfDate: ${e.message}`);
    }
  }

  return asOfDate;
}

async function getQMSUploadSourceTree(companyId) {
  if (!companyId) throw new Error("companyId is required");

  const { data: sourceFolder } = await supabase
    .from("folders")
    .select("id, name")
    .eq("company_id", companyId)
    .is("parent_id", null)
    .ilike("name", QMS_FOLDER_NAME)
    .maybeSingle();

  if (!sourceFolder) return null;

  const { data: children } = await supabase
    .from("folders")
    .select("id, name")
    .eq("parent_id", sourceFolder.id)
    .order("created_at", { ascending: true });

  const result = [];

  for (const child of (children || [])) {
    const nameLower = child.name.toLowerCase().trim();

    if (nameLower === "reports") {
      const { data: reportChildren } = await supabase
        .from("folders")
        .select("id, name")
        .eq("parent_id", child.id)
        .order("created_at", { ascending: true });

      const subItems = await Promise.all((reportChildren || []).map(async (rc) => {
        const { count } = await supabase
          .from("documents")
          .select("id", { count: "exact", head: true })
          .eq("folder_id", rc.id);
        return {
          id: rc.id,
          name: rc.name,
          statementType: SUBFOLDER_STATEMENT_MAP[rc.name.toLowerCase().trim()] || null,
          fileCount: count || 0,
        };
      }));

      result.push({ id: child.id, name: child.name, isGroup: true, children: subItems });
    } else {
      const { count } = await supabase
        .from("documents")
        .select("id", { count: "exact", head: true })
        .eq("folder_id", child.id);

      result.push({
        id: child.id,
        name: child.name,
        statementType: SUBFOLDER_STATEMENT_MAP[nameLower] || null,
        fileCount: count || 0,
        isGroup: false,
      });
    }
  }

  return { id: sourceFolder.id, name: sourceFolder.name, children: result };
}

async function syncQMSUploadSource(companyId) {
  if (!companyId) throw new Error("companyId is required");

  const sourceTree = await getQMSUploadSourceTree(companyId);
  if (!sourceTree) {
    throw new Error(`"${QMS_FOLDER_NAME}" folder not found in DataRoom.`);
  }

  const foldersToSync = [];
  for (const item of sourceTree.children) {
    if (item.isGroup) {
      for (const sub of (item.children || [])) {
        if (sub.statementType) foldersToSync.push({ folder: sub, statementType: sub.statementType });
      }
    } else if (item.statementType) {
      foldersToSync.push({ folder: item, statementType: item.statementType });
    }
  }

  // Clear all existing QMS records for this company before re-syncing.
  const { error: deleteError } = await supabase
    .from("qb_synced_reports")
    .delete()
    .eq("company_id", companyId)
    .eq("source", QMS_REPORT_UPLOAD_SOURCE);

  if (deleteError) throw new Error(`Failed to clear QMS records: ${deleteError.message}`);

  const now = new Date().toISOString();
  const processed = [];
  const failed = [];

  for (const { folder, statementType } of foldersToSync) {
    if (statementType === STATEMENT_TYPES.BANK_RECONCILIATION) {
      try {
        const bankResult = await syncBankReconciliationFolder(companyId, folder, now);
        processed.push(...(bankResult.processed || []));
        failed.push(...(bankResult.failed || []));
        if (!bankResult.success && !bankResult.failed?.length && bankResult.reason !== "No files in folder") {
          failed.push({ fileName: folder.name, folderName: folder.name, reason: bankResult.reason || "Bank extraction failed" });
        }
      } catch (err) {
        failed.push({ fileName: folder.name, folderName: folder.name, reason: err.message });
      }
      continue;
    }

    if (statementType === STATEMENT_TYPES.TAX_RETURN) {
      try {
        const taxResult = await syncTaxReturnFolder(companyId, folder, now);
        processed.push(...(taxResult.processed || []));
        failed.push(...(taxResult.failed || []));
      } catch (err) {
        failed.push({ fileName: folder.name, folderName: folder.name, reason: err.message });
      }
      continue;
    }

    const { data: documents } = await supabase
      .from("documents")
      .select("id, name, upload_id, file_url")
      .eq("folder_id", folder.id)
      .order("uploaded_at", { ascending: false });

    if (!documents?.length) continue;

    const settlements = await Promise.allSettled(
      documents.map(async (doc) => {
        let upload;
        try {
          upload = await loadUploadForDoc(doc);
        } catch (err) {
          return { failed: true, documentId: doc.id, fileName: doc.name, folderName: folder.name, reason: err.message };
        }
        // TAX_RETURN and BANK_RECONCILIATION are handled by their own AI-powered
        // sync functions above. The main loop only sees BS/PL/CF — always rule-based.
        const parsed = await parseStoredReport(upload, statementType, { skipAI: true });

        if (!parsed?.report?.rows?.length) {
          return { failed: true, documentId: doc.id, fileName: doc.name, folderName: folder.name, reason: "No parseable data in file" };
        }

        const resolvedUploadId = upload.id || doc.upload_id || null;

        const { error: insertError } = await supabase
          .from("qb_synced_reports")
          .insert({
            company_id: companyId,
            report_type: statementType,
            report_params: {
              sourceFolderName: QMS_FOLDER_NAME,
              folderId: folder.id,
              folderName: folder.name,
              documentId: doc.id,
              uploadId: resolvedUploadId,
              fileName: doc.name,
            },
            data: {
              manual_report_upload: {
                statementType,
                parserType: parsed.parserType,
                folderId: folder.id,
                folderName: folder.name,
                documentId: doc.id,
                uploadId: resolvedUploadId,
                fileName: doc.name,
                fileUrl: doc.file_url || null,
                report: parsed.report,
                syncedAt: now,
              },
            },
            source: QMS_REPORT_UPLOAD_SOURCE,
            status: "synced",
            last_synced_at: now,
            updated_at: now,
          });

        if (insertError) throw new Error(insertError.message);
        return { failed: false, documentId: doc.id, fileName: doc.name, statementType, folderName: folder.name };
      }),
    );

    for (let i = 0; i < settlements.length; i++) {
      const s = settlements[i];
      if (s.status === "fulfilled") {
        s.value.failed ? failed.push(s.value) : processed.push(s.value);
      } else {
        failed.push({ folderName: folder.name, fileName: documents[i]?.name, reason: s.reason?.message });
      }
    }
  }

  try {
    await updateReportSourceRecord(companyId, REPORT_SOURCE_KEYS.QUICKBOOKS_MANUAL, {
      isAvailable: processed.length > 0,
      isConnected: false,
      lastSyncedAt: processed.length > 0 ? now : null,
      metadata: {
        sourceFolderName: QMS_FOLDER_NAME,
        syncedReportTypes: Array.from(new Set(processed.map((p) => p.statementType))),
        processedCount: processed.length,
        failedCount: failed.length,
      },
    });
  } catch (e) {
    console.warn("[QMSUpload] Failed to update source record:", e.message);
  }

  return {
    sourceFolderName: QMS_FOLDER_NAME,
    processedCount: processed.length,
    processed,
    failed,
  };
}

// Targeted parse: only processes the specific documents that were just uploaded.
// Used by the "Choose Folder" upload flow so we never re-scan the entire QMS folder tree.
// clearFirst=true: wipes all existing QMS synced reports before parsing (used by the Sync button
// so old files from previous sessions are replaced by the current session's uploads).
async function parseAndSaveQMSDocuments(companyId, documents, { clearFirst = false } = {}) {
  if (!companyId) throw new Error("companyId is required");
  if (!Array.isArray(documents) || documents.length === 0) return { processed: [], failed: [] };

  if (clearFirst) {
    const { error: delErr } = await supabase
      .from("qb_synced_reports")
      .delete()
      .eq("company_id", companyId)
      .eq("source", QMS_REPORT_UPLOAD_SOURCE);
    if (delErr) throw new Error(`Failed to clear QMS records: ${delErr.message}`);
  }

  const now = new Date().toISOString();
  const processed = [];
  const failed = [];

  for (const { uploadId, statementType, fileName } of documents) {
    if (!uploadId || !statementType) {
      failed.push({ fileName, reason: "Missing uploadId or statementType" });
      continue;
    }

    // Fetch upload binary
    let upload = null;
    try {
      upload = await loadUploadForDoc({ upload_id: uploadId });
    } catch (err) {
      failed.push({ fileName, reason: `Binary not found: ${err.message}` });
      continue;
    }

    // In QMS mode: only tax_return and bank_statement use AI (Gemini).
    // Balance Sheet, P&L, and Cash Flow always use the rule-based parser.
    const skipAI = !QMS_AI_STATEMENT_TYPES.has(statementType);
    let parsed;
    try {
      parsed = await parseStoredReport(upload, statementType, { skipAI });
    } catch (err) {
      failed.push({ fileName, reason: `Parse error: ${err.message}` });
      continue;
    }

    if (!parsed?.report?.rows?.length) {
      failed.push({ fileName, reason: "No parseable data found in file" });
      continue;
    }

    // When not clearing the whole table first, remove any prior record for this upload
    if (!clearFirst) {
      await supabase
        .from("qb_synced_reports")
        .delete()
        .eq("company_id", companyId)
        .eq("source", QMS_REPORT_UPLOAD_SOURCE)
        .eq("report_type", statementType)
        .filter("report_params->>uploadId", "eq", String(uploadId));
    }

    const resolvedFileName = fileName || upload.file_name;
    const { error: insertError } = await supabase.from("qb_synced_reports").insert({
      company_id: companyId,
      report_type: statementType,
      report_params: { uploadId, fileName: resolvedFileName },
      data: {
        manual_report_upload: {
          statementType,
          parserType: parsed.parserType,
          uploadId,
          fileName: resolvedFileName,
          report: parsed.report,
          syncedAt: now,
        },
      },
      source: QMS_REPORT_UPLOAD_SOURCE,
      status: "synced",
      last_synced_at: now,
      updated_at: now,
    });

    if (insertError) {
      failed.push({ fileName, reason: insertError.message });
      continue;
    }

    processed.push({ fileName, statementType });
  }

  // Update source record availability
  try {
    if (processed.length > 0) {
      await updateReportSourceRecord(companyId, REPORT_SOURCE_KEYS.QUICKBOOKS_MANUAL, {
        isAvailable: true,
        isConnected: false,
        lastSyncedAt: now,
        metadata: {
          sourceFolderName: QMS_FOLDER_NAME,
          syncedReportTypes: Array.from(new Set(processed.map((p) => p.statementType))),
          processedCount: processed.length,
          failedCount: failed.length,
        },
      });
    }
  } catch (e) {
    console.warn("[QMSUpload] Failed to update source record:", e.message);
  }

  return { processed, failed, processedCount: processed.length };
}

module.exports = {
  MANUAL_REPORT_UPLOAD_SOURCE,
  STATEMENT_TYPES,
  syncManualReportFolder,
  syncManualUploadSource,
  getManualUploadSourceTree,
  getQMSUploadSourceTree,
  syncQMSUploadSource,
  parseAndSaveQMSDocuments,
  getLatestManualUploadedReport,
  getAllManualUploadedReports,
  getLatestQMSUploadedReport,
  getAllQMSUploadedReports,
  extractAndCacheReportAsOfDate,
  extractTaxDataFromBuffer,
  clearTaxExtractCache,
  buildTaxReturnResponseData,
  syncTaxReturnFolder,
  extractPLForTax,
  buildPLForTaxData,
  syncPLForTaxFolder,
  extractPLLineItemsFromRows,
};
