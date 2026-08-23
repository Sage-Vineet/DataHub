const express = require("express");
const { requireAuth } = require("../middleware/auth");
const {
  STATEMENT_TYPES,
  MANUAL_REPORT_UPLOAD_SOURCE,
  getLatestManualUploadedReport,
  getAllManualUploadedReports,
  syncManualReportFolder,
  syncManualUploadSource,
  getManualUploadSourceTree,
  syncQMSUploadSource,
  parseAndSaveQMSDocuments,
  getSyncProgress,
  getManualUploadProgress,
  extractAndCacheReportAsOfDate,
  extractTaxDataWithVerification,
  validateTaxExtraction,
  clearTaxExtractCache,
  buildTaxReturnResponseData,
  extractPLForTax,
  buildPLForTaxData,
  extractPLLineItemsFromRows,
  buildQMSDashboardData,
  buildManualUploadDashboardData,
} = require("../services/manualReportUploadService");
const { parsePdfWithGemini } = require("../services/geminiFinancialParser");
const { supabase } = require("../db");
const { canAccessCompany } = require("../services/permissionService");
const { runBsBankBalancesExtraction, runBankExtraction } = require("./quickbooks/reconciliation/bankVsBooks");
const keyReportService = require("../services/keyReports/keyReportService");

// Version-aware cache for Key Reports-resolved tax return extraction. Kept
// separate from the Sync All tax_return cache so existing data is untouched;
// keyed by the linked document set so switching the active version refreshes it.
const TAX_RETURN_KR_CACHE_TYPE = "tax_return_kr_v1";

// Extracts monthly Total Income and Total Expenses from the latest P&L stored in qb_synced_reports.
// Returns { totalIncome: { "YYYY-MM": number }, totalExpenses: { "YYYY-MM": number } } or null.
async function extractPlFinancials(clientId, source, { keyReportVersionId = null, datasetVersion = null } = {}) {
  try {
    const query = supabase
      .from("qb_synced_reports")
      .select("data")
      .eq("company_id", clientId)
      .eq("source", source)
      .eq("report_type", "profit_and_loss");

    if (keyReportVersionId) {
      query.eq("key_report_version_id", keyReportVersionId);
    } else if (datasetVersion) {
      query.eq("dataset_version", datasetVersion);
    }

    const { data: row } = await query
      .order("updated_at", { ascending: false })
      .order("last_synced_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!row?.data?.manual_report_upload?.report) return null;
    const report = row.data.manual_report_upload.report;
    const rows = report.rows || [];
    const periods = report.periods || [];

    const flat = [];
    const flatten = (items) => {
      for (const item of (items || [])) {
        flat.push(item);
        if (item.children) flatten(item.children);
      }
    };
    flatten(rows);

    const lc = (s) => String(s || "").toLowerCase().trim();

    // Find the best matching row: prefer type="total", then any match.
    // Also fall back to section header (type="header") when no explicit total row exists.
    const findRow = (totalPatterns, headerPatterns) => {
      const hits = flat.filter((r) => totalPatterns.some((p) => lc(r.name).includes(p)));
      if (hits.length) {
        const totals = hits.filter((r) => r.type === "total");
        return totals.length ? totals[totals.length - 1] : hits[hits.length - 1];
      }
      // Fallback: exact-name section header (e.g. "Income", "Revenue", "Expenses")
      if (headerPatterns) {
        return flat.find((r) => r.type === "header" && headerPatterns.some((p) => lc(r.name) === p)) || null;
      }
      return null;
    };

    const incomeRow = findRow(
      ["total income", "total revenue", "net revenue", "total sales", "gross revenue", "operating revenue"],
      ["income", "revenue", "sales", "gross profit"],
    );
    const expensesRow = findRow(
      ["total expenses", "total operating expenses", "total expense"],
      ["expenses", "operating expenses", "expense"],
    );
    if (!incomeRow && !expensesRow) return null;

    const MONTHS = {
      jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
      jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12"
    };

    // Infer year from report dates — used when period labels lack a year component (e.g. "Jan", "Feb")
    const baseYear = (() => {
      const d = report.asOfDate || report.periodEnd || report.periodStart;
      return d ? parseInt(String(d).split("-")[0], 10) : null;
    })();

    const periodToKey = (label) => {
      const s = String(label || "").trim();
      // "Jan 25", "Jan-25", "January 2025", etc.
      const m = s.match(/^([a-z]+)[\s.\-_]*(\d{2,4})$/i);
      if (m) {
        const mm = MONTHS[m[1].slice(0, 3).toLowerCase()];
        if (mm) { let yr = parseInt(m[2], 10); if (yr < 100) yr += 2000; return `${yr}-${mm}`; }
      }
      // "2025-01" ISO format
      const m2 = s.match(/^(\d{4})-(\d{1,2})$/);
      if (m2) return `${m2[1]}-${String(m2[2]).padStart(2, "0")}`;
      // Year-less label ("Jan", "February") — use inferred base year
      if (baseYear) {
        const mm = MONTHS[s.slice(0, 3).toLowerCase()];
        if (mm) return `${baseYear}-${mm}`;
      }
      return null;
    };

    if (periods.length > 0) {
      const totalIncome = {}, totalExpenses = {};
      periods.forEach((label, i) => {
        if (/^total$/i.test(String(label).trim())) return;
        const k = periodToKey(label);
        if (!k) return;
        const inc = incomeRow?.colAmounts?.[i];
        if (inc != null) totalIncome[k] = inc;
        const exp = expensesRow?.colAmounts?.[i];
        if (exp != null) totalExpenses[k] = exp;
      });
      if (Object.keys(totalIncome).length || Object.keys(totalExpenses).length) {
        return { totalIncome, totalExpenses };
      }
      // colAmounts may be missing — fall through to single-amount path
    }

    // Annual P&L (no period columns) — map single total to December of detected year
    const asOfDate = report.asOfDate || report.periodEnd;
    const year = asOfDate ? String(asOfDate).split("-")[0] : (baseYear ? String(baseYear) : null);
    const income = typeof incomeRow?.amount === "number" ? incomeRow.amount : null;
    const expense = typeof expensesRow?.amount === "number" ? expensesRow.amount : null;
    if (!year || (income == null && expense == null)) return null;
    return {
      totalIncome: income != null ? { [`${year}-12`]: income } : {},
      totalExpenses: expense != null ? { [`${year}-12`]: expense } : {},
    };
  } catch (e) {
    console.warn(`[PLFinancials] extractPlFinancials failed (non-fatal): ${e.message}`);
    return null;
  }
}

const router = express.Router();
router.use(requireAuth);

function normalizeUploadBinary(data) {
  if (!data) return Buffer.alloc(0);
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
  return Buffer.alloc(0);
}

function resolveClientId(req) {
  let clientId = req.headers["x-client-id"] || req.query.clientId;
  if (!clientId && req.headers.referer) {
    const match =
      req.headers.referer.match(/\/client\/([^/]+)/) ||
      req.headers.referer.match(/\/workspace\/([^/]+)/);
    if (match) clientId = match[1];
  }
  return clientId;
}

router.use((req, res, next) => {
  // This router is mounted at "/" so router.use() intercepts every request.
  // Only enforce financial-report access control for paths that belong to this router.
  const p = req.path || '';
  if (!p.startsWith('/manual-report-uploads') && !p.startsWith('/manual-upload')) {
    return next();
  }
  const clientId = resolveClientId(req);
  if (clientId && !canAccessCompany(req.user, clientId)) {
    return res.status(403).json({ error: "You do not have permission to access financial reports for this company." });
  }
  return next();
});


router.post("/manual-report-uploads/sync-source", async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(400).json({ success: false, error: "Missing clientId." });
    const result = await syncManualUploadSource(clientId);
    return res.json({ success: true, ...result });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});


router.post("/manual-report-uploads/sync-qms-source", async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(400).json({ success: false, error: "Missing clientId." });
    const result = await syncQMSUploadSource(clientId);
    return res.json({ success: true, ...result });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

/*
 * POST /manual-report-uploads/qms-parse-documents
 * Targeted parse for the "Choose Folder" upload flow.
 * Body: { documents: [{ uploadId, documentId, statementType, fileName }] }
 * Only processes the specific documents passed — never re-scans the entire QMS folder tree.
 */
router.post("/manual-report-uploads/qms-parse-documents", async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(400).json({ success: false, error: "Missing clientId." });
    const { documents, clearFirst = false } = req.body || {};
    if (!Array.isArray(documents) || documents.length === 0) {
      return res.status(400).json({ success: false, error: "documents array is required." });
    }
    const result = await parseAndSaveQMSDocuments(clientId, documents, { clearFirst });
    return res.json({ success: true, ...result });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

/* ===========================
   GET /manual-report-uploads/reports/:statementType/all
   Returns all uploaded files for a given statement type, ordered by upload date.
   Used to populate the file selector (Summary view) and build multi-file
   comparative columns (Detailed view).
=========================== */
/* ===========================
   GET /manual-report-uploads/qms-reports/:statementType/all
   Same as /reports/:statementType/all but filtered to quickbooks_manual_upload source.
=========================== */

/* ===========================
   GET /manual-report-uploads/qms-bank-data
   Returns the aggregated bank reconciliation data synced from the QMS Bank Statement folder.
   Response shape: { success, banks, months, totals } — same as /extract-bank-pdf-records.
=========================== */
router.get("/manual-report-uploads/qms-bank-data", async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(400).json({ success: false, error: "Missing clientId." });

    const datasetVersion = String(req.query.datasetVersion || "").trim() || null;
    const keyReportVersionId = String(req.query.keyReportVersionId || "").trim() || null;

    // Bank statement is resolved from the SELECTED Key Reports version (single
    // source of truth, active when none selected); P&L financials remain QMS-scoped.
    const [{ body: bankBody }, plFinancials] = await Promise.all([
      runBankExtraction(clientId, "quickbooks_manual_upload", "Manual Upload Source", datasetVersion, keyReportVersionId),
      extractPlFinancials(clientId, "quickbooks_manual_upload").catch(() => null),
    ]);

    return res.json({
      success: true,
      banks: bankBody?.banks || [],
      months: bankBody?.months || [],
      totals: bankBody?.totals || [],
      message: bankBody?.message,
      plFinancials,
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || "Failed to fetch QMS bank data." });
  }
});


/* ===========================
   GET /manual-upload/dashboard
   Dedicated Manual Upload (Excel/PDF) dashboard endpoint — isolated from QMS.
   Only reads manual_report_upload source data; never touches QMS cache or files.
   Strict source validation: requires source=manual_upload, returns 400 otherwise.
=========================== */

/* ===========================
   GET /manual-report-uploads/qms-reports/:statementType/latest
   Same as /reports/:statementType/latest but filtered to quickbooks_manual_upload source.
   Accepts optional ?rowId= to fetch a specific row by ID.
=========================== */

/* ===========================
   GET /manual-report-uploads/tax-data
   Returns multi-year tax return data for manual upload mode.
   1. Checks qb_synced_reports for data stored by Sync All (fast path).
   2. Falls back to real-time Gemini extraction from DataRoom PDFs.
=========================== */
// Enrich a cached tax-year object with a `status` field when it is missing.
// The data array (label/taxReturn pairs) is converted back to raw field names
// so validateTaxExtraction can run the same formula checks used at extraction time.
function enrichTaxYearWithStatus(yearObj) {
  if (yearObj && yearObj.status) return yearObj;
  const dataArr = Array.isArray(yearObj?.data) ? yearObj.data : [];
  const findVal = (...labels) => {
    for (const lbl of labels) {
      const item = dataArr.find((d) => d.label === lbl);
      if (item) return Number(item.taxReturn || 0);
    }
    return 0;
  };
  const reconstructed = {
    year:                 yearObj?.year || 0,
    totalRevenue:         findVal("Total Revenue"),
    totalCostOfGoodsSold: findVal("Total Cost of Goods Sold"),
    grossProfit:          findVal("Gross Profit"),
    officerWages:         findVal("Officer Wages", "Guaranteed Payments"),
    depreciation:         findVal("Depreciation Expense"),
    amortization:         findVal("Amortization Expense"),
    interestExpense:      findVal("Total Interest Expense"),
    allOtherExpenses:     findVal("All Other Expenses"),
    netIncome:            findVal("Net Income"),
  };
  const { status } = validateTaxExtraction(reconstructed);
  return { ...yearObj, status };
}

function enrichTaxYears(taxYears) {
  const enriched = {};
  for (const [yr, obj] of Object.entries(taxYears || {})) {
    enriched[yr] = enrichTaxYearWithStatus(obj);
  }
  return enriched;
}


/* ===========================
   GET /manual-report-uploads/pl-for-tax
   Returns Gemini-extracted P&L data keyed by fiscal year.
   1. Checks qb_synced_reports for cached P&L data (fast path).
   2. Falls back to real-time Gemini extraction from DataRoom Profit & Loss folder.
=========================== */

/* ===========================
   GET /manual-upload/cashflow/periods
   List all periods for which an automatic Cash Flow can be generated.
   A period is available when BS(Y-1), BS(Y), and P&L(Y) are all uploaded.
=========================== */

/* ===========================
   GET /manual-upload/cashflow?period=2022[&force=1]
   Return a generated Cash Flow statement for the given year.

   Flow:
     1. If ?force=1 is absent, check for a cached generated statement → return it.
     2. Otherwise generate fresh from uploaded BS + P&L files, cache, and return.

   Success response:
   {
     success: true,
     source: "manual_upload_generated",
     period: "2022",
     generatedAt: "...",
     inputs: { bsPrevFile, bsCurrFile, plFile, ... },
     operatingActivities: [ { label, amount, type }, ... ],
     netOperating: 0,
     investingActivities: [ ... ],
     netInvesting: 0,
     financingActivities: [ ... ],
     netFinancing: 0,
     beginningCash: 0,
     endingCash: 0,
     netCashIncrease: 0,
     cashValidated: true
   }

   Failure response (missing files):
   {
     success: false,
     source: "manual_upload_generated",
     message: "...",
     missingInputs: ["Balance Sheet 2021", ...]
   }
=========================== */

/* ===========================
   GET /manual-upload/bank-data
   Returns bank reconciliation data from Manual Upload Source folder ONLY.
   Isolated to "manual_report_upload" cache + "Manual Upload Source" DataRoom folder.
   Never reads from Quickbooks Manual Source or QMS caches.
   Response shape: { success, source: "manual_upload", banks, months, totals }
              or: { success: true, empty: true, message: "..." }
=========================== */
router.get("/manual-upload/bank-data", async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(400).json({ success: false, error: "Missing clientId." });

    // Optional Key Reports scoping so a selected Version (not just the active one)
    // drives which documents this Manual Upload flow reads.
    const datasetVersion = String(req.query.datasetVersion || "").trim() || null;
    const keyReportVersionId = String(req.query.keyReportVersionId || "").trim() || null;

    // Fetch P&L financials in parallel — merges Sales/Expenses per Financials into this response
    const plFinancialsPromise = extractPlFinancials(clientId, MANUAL_REPORT_UPLOAD_SOURCE, {
      keyReportVersionId,
      datasetVersion
    }).catch(() => null);

    // Start BS bank accounts fetch in parallel — merges /bs-bank-balances into this response
    const bsBankAccountsPromise = runBsBankBalancesExtraction(
      clientId, MANUAL_REPORT_UPLOAD_SOURCE, "Manual Upload Source", null, datasetVersion, keyReportVersionId
    ).then(r => {
      const b = r?.body;
      if (b?.bankAccounts?.length > 0) {
        return { year: b.year ?? null, fileName: b.fileName ?? null, documentId: b.documentId ?? null, bankAccounts: b.bankAccounts };
      }
      return null;
    }).catch(e => {
      console.warn(`[BANK SOURCE] BS bank accounts non-fatal: ${e.message}`);
      return null;
    });

    console.log(`[BANK SOURCE] source=manual_upload clientId=${clientId} — resolving bank statement from active Key Reports version...`);

    // Bank statement is resolved strictly from the active Key Reports version
    // (version-aware cache + live extraction handled by runBankExtraction). BS
    // bank accounts and P&L financials remain manual_upload-source-scoped.
    const { body: bankBody } = await runBankExtraction(clientId, MANUAL_REPORT_UPLOAD_SOURCE, "Manual Upload Source", datasetVersion, keyReportVersionId);
    const [balanceSheetBankAccounts, plFinancials] = await Promise.all([bsBankAccountsPromise, plFinancialsPromise]);

    if (!bankBody?.banks?.length) {
      return res.json({
        success: true,
        empty: true,
        source: "manual_upload",
        banks: [],
        months: [],
        totals: [],
        message: bankBody?.message || "No Bank Statement is linked in the active Key Reports version. Link a Bank Statement in Key Reports and sync before using Bank Reconciliation.",
        balanceSheetBankAccounts,
        plFinancials,
      });
    }

    return res.json({
      success: true,
      source: "manual_upload",
      banks: bankBody.banks,
      months: bankBody.months || [],
      totals: bankBody.totals || [],
      syncedAt: bankBody.syncedAt,
      balanceSheetBankAccounts,
      plFinancials,
    });
  } catch (error) {
    console.error("[BANK SOURCE] Error:", error);
    return res.status(500).json({ success: false, error: error.message || "Failed to fetch manual upload bank data." });
  }
});

/* ===========================
   GET /manual-report-uploads/tax-reconciliation-overrides
   Returns user-saved Schedule K overrides for this company.
=========================== */

/* ===========================
   PUT /manual-report-uploads/tax-reconciliation-overrides
   Saves (upserts) the full user-edited Schedule K overrides for this company.
   Body: { overrides: { [year]: { [label]: { taxReturn, pl } } } }
=========================== */

module.exports = router;
