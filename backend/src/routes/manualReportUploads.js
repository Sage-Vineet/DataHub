const express = require("express");
const { requireAuth } = require("../middleware/auth");
const {
  STATEMENT_TYPES,
  MANUAL_REPORT_UPLOAD_SOURCE,
  getLatestManualUploadedReport,
  getAllManualUploadedReports,
  getLatestQMSUploadedReport,
  getAllQMSUploadedReports,
  syncManualReportFolder,
  syncManualUploadSource,
  getManualUploadSourceTree,
  getQMSUploadSourceTree,
  syncQMSUploadSource,
  parseAndSaveQMSDocuments,
  getSyncProgress,
  getManualUploadProgress,
  extractAndCacheReportAsOfDate,
  extractTaxDataWithVerification,
  // Tax returns are a Gemini-only document type; these two decide whether a file
  // can go to Gemini at all and explain it to the user when it cannot.
  resolveTaxDocumentMime,
  unreadableTaxDocumentReason,
  validateTaxExtraction,
  clearTaxExtractCache,
  buildTaxReturnResponseData,
  canonicalizeReconcilingData,
  extractPLForTax,
  buildPLForTaxData,
  extractPLLineItemsFromRows,
  buildQMSDashboardData,
  buildManualUploadDashboardData,
} = require("../services/manualReportUploadService");
const { parsePdfWithGemini } = require("../services/geminiFinancialParser");
const {
  getCachedCashFlow,
  listAvailablePeriods,
  generatedCfToRows,
} = require("../services/manualCashFlowService");
const { supabase } = require("../db");
const { canAccessCompany } = require("../services/permissionService");
const { runBsBankBalancesExtraction, runBankExtraction } = require("./quickbooks/reconciliation/bankVsBooks");
const keyReportService = require("../services/keyReports/keyReportService");
const { getMonthlyPlFinancials } = require("../services/keyReports/financialStatementService");
const { getMonthlyActivityReview } = require("../services/keyReports/activityReviewService");
const { decryptPdfEmptyPassword } = require("../services/keyReports/pythonBridge");

// True when a PDF carries an /Encrypt dictionary (referenced from the trailer).
// Gemini rejects encrypted PDFs with "The document has no pages", so these must
// be decrypted first. Matches the standard trailer form "/Encrypt N G R".
function isEncryptedPdf(buffer) {
  if (!buffer || !buffer.length) return false;
  try {
    return /\/Encrypt\s+\d+\s+\d+\s+R/.test(buffer.toString("latin1"));
  } catch {
    return false;
  }
}

// Version-aware cache for Key Reports-resolved tax return extraction. Kept
// separate from the Sync All tax_return cache so existing data is untouched;
// keyed by the linked document set so switching the active version refreshes it.
// v2: cache is now persistent PER document-set (per Key Report version) instead
// of a single overwritten row, so switching versions / refreshing reuses the
// cached extraction (incl. Schedule K) instead of re-calling Gemini. Bump also
// invalidates v1 rows so the Schedule K verification fix takes effect once.
// v4: adds encrypted-PDF handling (auto-decrypt of owner-restricted files +
// persisted `lockedFiles` for password-protected ones). Bumping from v3 discards
// stale rows that froze a partial extraction (e.g. only the one unencrypted year)
// so the new logic re-runs on next load.
// (v3 note kept for history: v2→v3 fixed the multi-year keying / partial-cache freeze.)
// v4→v5: totalRevenue prompt fix — Gemini was reading Line 6 "Total income" into
// totalRevenue instead of Line 1c "Gross receipts or sales". Bump forces re-extraction
// so cached wrong revenue values are replaced.
// v5→v6: Schedule K extraction accuracy — line-code row anchoring (16a–16f / 17a–17b are
// stacked tightly and were mis-aligned) + M-1/M-2 cross-check in the extraction and
// verification prompts. Bump forces re-extraction so cached Schedule K values are refreshed.
// v6→v7: Schedule K vs Schedule M-2 confusion — Gemini reported the M-2 Accumulated
// Adjustments Account balance (e.g. 10,977) as Schedule K "Distributions" (16d) when 16d was
// blank. Prompts now restrict every reconciling-item value to the Schedule K "Total amount"
// column and forbid sourcing from M-2 balance lines. Bump re-extracts cached wrong values.
const TAX_RETURN_KR_CACHE_TYPE = "tax_return_kr_v7";

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

router.post("/manual-report-uploads/sync", async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    const folderId = String(req.body?.folderId || "").trim();
    const folderName = String(req.body?.folderName || "").trim();

    if (!clientId) {
      return res.status(400).json({ success: false, error: "Missing clientId." });
    }
    if (!folderId) {
      return res.status(400).json({ success: false, error: "folderId is required." });
    }

    const result = await syncManualReportFolder({
      companyId: clientId,
      folderId,
      folderName,
    });

    return res.json({ success: true, ...result });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || "Failed to sync manual report folder.",
    });
  }
});

router.get("/manual-report-uploads/source-tree", async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(400).json({ success: false, error: "Missing clientId." });
    const tree = await getManualUploadSourceTree(clientId);
    return res.json({ success: true, tree });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

router.get("/manual-report-uploads/folder-files", async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    const folderId = String(req.query.folderId || "").trim();
    if (!clientId) return res.status(400).json({ success: false, error: "Missing clientId." });
    if (!folderId) return res.status(400).json({ success: false, error: "Missing folderId." });

    const { data: documents, error } = await supabase
      .from("documents")
      .select("id, name, file_url, upload_id, size, ext, uploaded_at")
      .eq("folder_id", folderId)
      .order("uploaded_at", { ascending: false });

    if (error) throw new Error(error.message);
    return res.json({ success: true, files: documents || [] });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
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

router.get("/manual-report-uploads/qms-source-tree", async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(400).json({ success: false, error: "Missing clientId." });
    const tree = await getQMSUploadSourceTree(clientId);
    return res.json({ success: true, tree });
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

router.get("/manual-upload/sync-progress", async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(400).json({ success: false, error: "Missing clientId." });
    const progress = getManualUploadProgress(clientId);
    if (!progress) {
      return res.json({ success: true, active: false, totalFiles: 0, processedFiles: 0, currentFile: "", currentStep: "idle", percentage: 0 });
    }
    return res.json({ success: true, active: true, ...progress });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

router.get("/manual-report-uploads/sync-progress", async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(400).json({ success: false, error: "Missing clientId." });
    const progress = getSyncProgress(clientId);
    if (!progress) {
      return res.json({ success: true, active: false, totalFiles: 0, processedFiles: 0, currentFile: "", currentStep: "idle", percentage: 0 });
    }
    return res.json({ success: true, active: true, ...progress });
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

router.get("/manual-report-uploads/reports/:statementType/latest", async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    const statementType = String(req.params.statementType || "").trim().toLowerCase();

    if (!clientId) {
      return res.status(400).json({ success: false, error: "Missing clientId." });
    }

    const validTypes = Object.values(STATEMENT_TYPES);
    if (!validTypes.includes(statementType)) {
      return res.status(400).json({ success: false, error: "Invalid statementType." });
    }

    // ── Generated Cash Flow intercept ─────────────────────────────────────────
    // Cash flow is generated during Sync All — never stored as an uploaded file.
    if (statementType === "cash_flow") {
      const periods = await listAvailablePeriods(clientId);

      if (!periods.length) {
        return res.status(404).json({
          success: false,
          source: "manual_upload_generated",
          error: "No cash flow reports found. Run Sync All to generate them.",
        });
      }

      const latestPeriod = Math.max(...periods.map((p) => parseInt(p.period, 10)));
      const cf = await getCachedCashFlow(clientId, String(latestPeriod));

      if (!cf) {
        return res.status(404).json({
          success: false,
          source: "manual_upload_generated",
          error: "Cash flow report not found. Run Sync All to generate cash flow reports.",
        });
      }

      return res.json({
        success: true,
        source: "manual_upload_generated",
        statementType: "cash_flow",
        data: {
          rows: generatedCfToRows(cf),
          period: cf.period,
          generatedAt: cf.generatedAt,
          inputs: cf.inputs || null,
        },
      });
    }
    // ─────────────────────────────────────────────────────────────────────────

    const rowId = String(req.query.rowId || "").trim() || null;
    const keyReportVersionId = String(req.query.keyReportVersionId || "").trim() || null;

    let row;
    if (keyReportVersionId) {
      // ── Key Reports document-driven resolution ──
      // Prioritize the document explicitly linked to THIS version for this category.
      const categoryMap = {
        profit_and_loss: "profit_loss",
        balance_sheet: "balance_sheet",
        general_ledger: "general_ledger",
        bank_statement: "bank_statement",
        tax_return: "tax_return",
      };
      const category = categoryMap[statementType];
      if (category) {
        const { documents } = await keyReportService.getLinkedDocuments(clientId, category, { versionId: keyReportVersionId });
        const doc = documents?.[0]; // Support first document for now
        if (doc?.upload_id) {
          const { data: linkedRow, error: linkedErr } = await supabase
            .from("qb_synced_reports")
            .select("id, report_type, report_params, data, updated_at, last_synced_at")
            .eq("company_id", clientId)
            .eq("report_type", statementType)
            .eq("report_params->>documentId", doc.id)
            .maybeSingle();
          if (!linkedErr && linkedRow) {
            row = linkedRow;
          }
        }
      }
    }

    if (!row && rowId) {
      const { data: specificRow, error: rowErr } = await supabase
        .from("qb_synced_reports")
        .select("id, report_type, report_params, data, updated_at, last_synced_at")
        .eq("id", rowId)
        .eq("company_id", clientId)
        .maybeSingle();
      if (rowErr) throw new Error(rowErr.message);
      row = specificRow;
    } else if (!row) {
      row = await getLatestManualUploadedReport({ companyId: clientId, statementType });
    }

    if (!row) {
      return res.status(404).json({
        success: false,
        error: "No manual uploaded report found.",
      });
    }

    const report = row.data?.manual_report_upload?.report || null;

    // If asOfDate is missing from the stored record, extract it lazily from
    // the source binary (PDF text scan / Excel row scan / filename) and
    // patch the DB so the next call is instant.
    let asOfDate = report?.asOfDate || null;
    if (!asOfDate) {
      try {
        asOfDate = await extractAndCacheReportAsOfDate(row);
      } catch (e) {
        console.warn(`[ManualReport] Lazy asOfDate extraction failed: ${e.message}`);
      }
    }

    const resolvedAsOfDate = asOfDate || report?.asOfDate || null;
    // Also surface periodStart/periodEnd so the frontend can detect the fiscal year
    // without needing to re-run extraction.
    const resolvedPeriodStart = report?.periodStart || null;
    const resolvedPeriodEnd = report?.periodEnd || resolvedAsOfDate || null;

    const reportWithDate = report
      ? {
        ...report,
        asOfDate: resolvedAsOfDate,
        periodStart: resolvedPeriodStart,
        periodEnd: resolvedPeriodEnd,
      }
      : null;

    return res.json({
      success: true,
      source: "manual_upload_excel_pdf",
      statementType,
      data: reportWithDate,
      reportParams: row.report_params || {},
      updatedAt: row.updated_at || null,
      lastSyncedAt: row.last_synced_at || null,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || "Failed to fetch manual uploaded report.",
    });
  }
});

/* ===========================
   GET /manual-report-uploads/reports/:statementType/all
   Returns all uploaded files for a given statement type, ordered by upload date.
   Used to populate the file selector (Summary view) and build multi-file
   comparative columns (Detailed view).
=========================== */
router.get("/manual-report-uploads/reports/:statementType/all", async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    const statementType = String(req.params.statementType || "").trim().toLowerCase();

    if (!clientId) {
      return res.status(400).json({ success: false, error: "Missing clientId." });
    }

    const validTypes = Object.values(STATEMENT_TYPES);
    if (!validTypes.includes(statementType)) {
      return res.status(400).json({ success: false, error: "Invalid statementType." });
    }

    const keyReportVersionId = String(req.query.keyReportVersionId || "").trim() || null;
    let rows = await getAllManualUploadedReports({ companyId: clientId, statementType });

    if (keyReportVersionId) {
      const categoryMap = {
        profit_and_loss: "profit_loss",
        balance_sheet: "balance_sheet",
        general_ledger: "general_ledger",
        bank_statement: "bank_statement",
        tax_return: "tax_return",
      };
      const category = categoryMap[statementType];
      if (category) {
        const { documents } = await keyReportService.getLinkedDocuments(clientId, category, { versionId: keyReportVersionId });
        const linkedDocIds = new Set(documents.map(d => d.id));
        rows = rows.filter(row => linkedDocIds.has(row.report_params?.documentId));
      }
    }

    const files = rows.map((row) => {
      const report = row.data?.manual_report_upload?.report || null;
      return {
        rowId: row.id,
        documentId: row.report_params?.documentId || null,
        fileName: row.report_params?.fileName || "Unknown file",
        folderName: row.report_params?.folderName || null,
        data: report
          ? {
            rows: report.rows || [],
            asOfDate: report.asOfDate || null,
            periodStart: report.periodStart || null,
            periodEnd: report.periodEnd || null,
            ...(report.periods?.length ? { periods: report.periods } : {}),
          }
          : null,
        updatedAt: row.updated_at || null,
        lastSyncedAt: row.last_synced_at || null,
      };
    });

    return res.json({ success: true, statementType, files });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || "Failed to fetch manual uploaded reports.",
    });
  }
});

/* ===========================
   GET /manual-report-uploads/qms-reports/:statementType/all
   Same as /reports/:statementType/all but filtered to quickbooks_manual_upload source.
=========================== */
router.get("/manual-report-uploads/qms-reports/:statementType/all", async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    const statementType = String(req.params.statementType || "").trim().toLowerCase();

    if (!clientId) return res.status(400).json({ success: false, error: "Missing clientId." });

    const validTypes = Object.values(STATEMENT_TYPES);
    if (!validTypes.includes(statementType)) {
      return res.status(400).json({ success: false, error: "Invalid statementType." });
    }

    const keyReportVersionId = String(req.query.keyReportVersionId || "").trim() || null;
    let rows = await getAllQMSUploadedReports({ companyId: clientId, statementType });

    if (keyReportVersionId) {
      const categoryMap = {
        profit_and_loss: "profit_loss",
        balance_sheet: "balance_sheet",
        general_ledger: "general_ledger",
        bank_statement: "bank_statement",
        tax_return: "tax_return",
      };
      const category = categoryMap[statementType];
      if (category) {
        const { documents } = await keyReportService.getLinkedDocuments(clientId, category, { versionId: keyReportVersionId });
        const linkedDocIds = new Set(documents.map(d => d.id));
        rows = rows.filter(row => linkedDocIds.has(row.report_params?.documentId));
      }
    }

    const files = rows.map((row) => {
      const report = row.data?.manual_report_upload?.report || null;
      return {
        rowId: row.id,
        documentId: row.report_params?.documentId || null,
        fileName: row.report_params?.fileName || "Unknown file",
        folderName: row.report_params?.folderName || null,
        data: report
          ? {
            rows: report.rows || [],
            asOfDate: report.asOfDate || null,
            periodStart: report.periodStart || null,
            periodEnd: report.periodEnd || null,
            ...(report.periods?.length ? { periods: report.periods } : {}),
          }
          : null,
        updatedAt: row.updated_at || null,
        lastSyncedAt: row.last_synced_at || null,
      };
    });

    return res.json({ success: true, statementType, files });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || "Failed to fetch QMS reports." });
  }
});

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

    // folderRootName is load-bearing here: runBsBankBalancesExtraction falls back to
    // scanning this DataRoom folder's Reports → Balance Sheet whenever the Key Report
    // version has no linked Balance Sheet. It said "Manual Upload Source", so QMS mode
    // extracted its bank balances out of the Manual Upload company's documents.
    const bsBankAccountsPromise = runBsBankBalancesExtraction(
      clientId,
      "quickbooks_manual_upload",
      "Quickbooks Manual Source",
      null,
      datasetVersion,
      keyReportVersionId,
    ).then((r) => {
      const b = r?.body;
      if (b?.bankAccounts?.length > 0) {
        return { year: b.year ?? null, fileName: b.fileName ?? null, documentId: b.documentId ?? null, bankAccounts: b.bankAccounts };
      }
      return null;
    }).catch((e) => {
      console.warn(`[QMS BANK SOURCE] BS bank accounts non-fatal: ${e.message}`);
      return null;
    });

    // Bank statement is resolved from the SELECTED Key Reports version (single
    // source of truth, active when none selected); P&L financials remain QMS-scoped.
    const [{ body: bankBody }, plFinancials, balanceSheetBankAccounts, activityReview] = await Promise.all([
      runBankExtraction(clientId, "quickbooks_manual_upload", "Quickbooks Manual Source", datasetVersion, keyReportVersionId),
      extractPlFinancials(clientId, "quickbooks_manual_upload").catch(() => null),
      bsBankAccountsPromise,
      keyReportVersionId
        ? getMonthlyActivityReview(keyReportVersionId).catch(() => null)
        : Promise.resolve(null),
    ]);

    return res.json({
      success: true,
      banks: bankBody?.banks || [],
      months: bankBody?.months || [],
      totals: bankBody?.totals || [],
      message: bankBody?.message,
      balanceSheetBankAccounts,
      plFinancials,
      activityReview,
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || "Failed to fetch QMS bank data." });
  }
});

router.get("/manual-report-uploads/qms-dashboard", async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(400).json({ success: false, error: "Missing clientId." });

    const requestedSource = String(req.query.source || "").trim();
    if (requestedSource !== "quickbooks_manual") {
      return res.status(400).json({ success: false, message: "Invalid dashboard source" });
    }

    console.log(`[DASHBOARD] activeSource=quickbooks_manual endpoint=/manual-report-uploads/qms-dashboard dataSource=QMS clientId=${clientId}`);

    const dashboard = await buildQMSDashboardData(clientId);
    return res.json({ success: true, source: "quickbooks_manual", ...dashboard });
  } catch (error) {
    console.error("[QMSDashboard] Route error:", error.message);
    return res.status(500).json({ success: false, error: error.message || "Failed to build QMS dashboard data." });
  }
});

/* ===========================
   GET /manual-upload/dashboard
   Dedicated Manual Upload (Excel/PDF) dashboard endpoint — isolated from QMS.
   Only reads manual_report_upload source data; never touches QMS cache or files.
   Strict source validation: requires source=manual_upload, returns 400 otherwise.
=========================== */
router.get("/manual-upload/dashboard", async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(400).json({ success: false, error: "Missing clientId." });

    const requestedSource = String(req.query.source || "").trim();
    if (requestedSource !== "manual_upload") {
      return res.status(400).json({ success: false, message: "Invalid dashboard source" });
    }

    console.log(`[DASHBOARD] activeSource=manual_upload endpoint=/manual-upload/dashboard dataSource=ManualUpload clientId=${clientId}`);

    const dashboard = await buildManualUploadDashboardData(clientId);
    return res.json({ success: true, source: "manual_upload", ...dashboard });
  } catch (error) {
    console.error("[ManualUploadDashboard] Route error:", error.message);
    return res.status(500).json({ success: false, error: error.message || "Failed to build Manual Upload dashboard data." });
  }
});

router.get("/manual-report-uploads/manual-upload-dashboard", async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(400).json({ success: false, error: "Missing clientId." });

    const requestedSource = String(req.query.source || "").trim();
    if (requestedSource && requestedSource !== "manual_upload_excel_pdf" && requestedSource !== "manual_upload") {
      return res.status(400).json({ success: false, message: "Invalid dashboard source" });
    }

    console.log(`[DASHBOARD] activeSource=manual_upload endpoint=/manual-report-uploads/manual-upload-dashboard dataSource=ManualUpload clientId=${clientId}`);

    const dashboard = await buildManualUploadDashboardData(clientId);
    return res.json({ success: true, source: "manual_upload_excel_pdf", ...dashboard });
  } catch (error) {
    console.error("[ManualUploadDashboard] Route error:", error.message);
    return res.status(500).json({ success: false, error: error.message || "Failed to build Manual Upload dashboard data." });
  }
});

/* ===========================
   GET /manual-report-uploads/qms-reports/:statementType/latest
   Same as /reports/:statementType/latest but filtered to quickbooks_manual_upload source.
   Accepts optional ?rowId= to fetch a specific row by ID.
=========================== */
router.get("/manual-report-uploads/qms-reports/:statementType/latest", async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    const statementType = String(req.params.statementType || "").trim().toLowerCase();

    if (!clientId) return res.status(400).json({ success: false, error: "Missing clientId." });

    const validTypes = Object.values(STATEMENT_TYPES);
    if (!validTypes.includes(statementType)) {
      return res.status(400).json({ success: false, error: "Invalid statementType." });
    }

    const rowId = String(req.query.rowId || "").trim() || null;
    const keyReportVersionId = String(req.query.keyReportVersionId || "").trim() || null;

    let row;
    if (keyReportVersionId) {
      const categoryMap = {
        profit_and_loss: "profit_loss",
        balance_sheet: "balance_sheet",
        general_ledger: "general_ledger",
        bank_statement: "bank_statement",
        tax_return: "tax_return",
      };
      const category = categoryMap[statementType];
      if (category) {
        const { documents } = await keyReportService.getLinkedDocuments(clientId, category, { versionId: keyReportVersionId });
        const doc = documents?.[0];
        if (doc?.upload_id) {
          const { data: linkedRow, error: linkedErr } = await supabase
            .from("qb_synced_reports")
            .select("id, report_type, report_params, data, updated_at, last_synced_at")
            .eq("company_id", clientId)
            .eq("report_type", statementType)
            .eq("report_params->>documentId", doc.id)
            .maybeSingle();
          if (!linkedErr && linkedRow) {
            row = linkedRow;
          }
        }
      }
    }

    if (!row && rowId) {
      const { data: specificRow, error: rowErr } = await supabase
        .from("qb_synced_reports")
        .select("id, report_type, report_params, data, updated_at, last_synced_at")
        .eq("id", rowId)
        .eq("company_id", clientId)
        .maybeSingle();
      if (rowErr) throw new Error(rowErr.message);
      row = specificRow;
    } else if (!row) {
      row = await getLatestQMSUploadedReport({ companyId: clientId, statementType });
    }

    if (!row) {
      return res.status(404).json({ success: false, error: "No QMS report found." });
    }

    const report = row.data?.manual_report_upload?.report || null;
    let asOfDate = report?.asOfDate || null;
    if (!asOfDate) {
      try { asOfDate = await extractAndCacheReportAsOfDate(row); } catch { /* ignore */ }
    }

    const resolvedAsOfDate = asOfDate || report?.asOfDate || null;
    const reportWithDate = report
      ? { ...report, asOfDate: resolvedAsOfDate, periodStart: report.periodStart || null, periodEnd: report.periodEnd || resolvedAsOfDate || null }
      : null;

    return res.json({
      success: true,
      source: "quickbooks_manual_upload",
      statementType,
      data: reportWithDate,
      reportParams: row.report_params || {},
      updatedAt: row.updated_at || null,
      lastSyncedAt: row.last_synced_at || null,
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || "Failed to fetch QMS report." });
  }
});

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
  // Always canonicalize + de-dup Schedule K reconciling items on the way out, so
  // even previously-cached rows (duplicate/variant labels, or a spurious Line 18
  // "Income (loss) reconciliation" row) are cleaned WITHOUT a cache rebuild.
  const dataArr = canonicalizeReconcilingData(Array.isArray(yearObj?.data) ? yearObj.data : []);
  const base = { ...yearObj, data: dataArr };
  if (base.status) return base;
  const findVal = (...labels) => {
    for (const lbl of labels) {
      const item = dataArr.find((d) => d.label === lbl);
      if (item) return Number(item.taxReturn || 0);
    }
    return 0;
  };
  const reconstructed = {
    year:                 yearObj?.year || 0,
    // The "Total Revenue" ROW publishes Form 1120-S line 6 TOTAL income, not line 1c
    // gross receipts — see taxPage1Rows. Reading it back into `totalRevenue` (which
    // the extractor defines as gross receipts) would make the validator's gross-profit
    // identity fail by exactly the other income on every such return.
    totalIncome:          findVal("Total Revenue"),
    totalCostOfGoodsSold: findVal("Total Cost of Goods Sold"),
    grossProfit:          findVal("Gross Profit"),
    officerWages:         findVal("Officer Wages", "Guaranteed Payments"),
    depreciation:         findVal("Depreciation Expense"),
    amortization:         findVal("Amortization Expense"),
    interestExpense:      findVal("Total Interest Expense"),
    allOtherExpenses:     findVal("All Other Expenses"),
    // Page-1 income above gross profit (Form 1120-S lines 4 and 5), carried on the
    // "All Other Income" row. REQUIRED: validateTaxExtraction's net-income identity
    // starts at TOTAL income, so omitting this makes every return that reports other
    // income fail the check by exactly that amount and land on "Needs Review".
    otherIncome:          findVal("All Other Income"),
    netIncome:            findVal("Net Income"),
    // Gross receipts is NOT among the published rows, so it cannot be recovered.
    // null (not 0) so the validator SKIPS the gross-receipts identity instead of
    // reporting a fabricated failure against a zero it invented.
    totalRevenue:         null,
  };
  const { status } = validateTaxExtraction(reconstructed);
  return { ...base, status };
}

function enrichTaxYears(taxYears) {
  const enriched = {};
  for (const [yr, obj] of Object.entries(taxYears || {})) {
    enriched[yr] = enrichTaxYearWithStatus(obj);
  }
  return enriched;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reusable core for Tax Reconciliation data.
//
// Resolves the tax return(s) linked in the SELECTED Key Reports version, serves
// from the version-aware cache when warm, otherwise Gemini-extracts and caches
// (keyed by the linked-document signature). Returns the response body object; the
// route forwards it verbatim, and the Generate flow calls it to PRE-WARM the
// cache so the Tax Reconciliation page loads instantly instead of running a
// multi-minute live extraction on first visit.
// ─────────────────────────────────────────────────────────────────────────────
async function runTaxExtraction(clientId, { datasetVersion = null, keyReportVersionId = null, forceRefresh = false } = {}) {
  // Centralised resolver: one call yields the selected version's full document
  // context; the tax_return field is the source set for this reconciliation. An
  // explicit Key Reports versionId takes priority over the dataset version.
  const { versionId, taxReturn: linkedDocs } = await keyReportService.getVersionReportContext(
    clientId,
    { datasetVersion, versionId: keyReportVersionId },
  );
  const documentSignature = linkedDocs.map((d) => d.id).filter(Boolean).sort().join(",");

  if (!linkedDocs.length) {
    // Fall back to tax return data synced via the connection page (Sync All).
    // Both manual_upload and quickbooks_manual sync tax returns with
    // source=MANUAL_REPORT_UPLOAD_SOURCE and report_type="tax_return".
    const { data: synced } = await supabase
      .from("qb_synced_reports")
      .select("data, updated_at")
      .eq("company_id", clientId)
      .eq("source", MANUAL_REPORT_UPLOAD_SOURCE)
      .eq("report_type", STATEMENT_TYPES.TAX_RETURN)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const taxYears = synced?.data?.tax_return?.taxYears;
    if (taxYears && Object.keys(taxYears).length > 0) {
      console.log(`[TaxData] No KR mapping — using connection-page synced tax data for ${clientId} (${Object.keys(taxYears).length} year(s))`);
      return {
        success: true,
        years: enrichTaxYears(taxYears),
        source: "synced",
        updatedAt: synced.updated_at,
      };
    }
    return {
      success: true,
      years: {},
      source: "empty",
      warning: "No tax return data found. Upload tax return PDFs via the Connections page and sync, or link a Tax Return in Key Reports.",
    };
  }

  // ── Fast path: version-aware Key Reports cache (persistent per document set)
  //    Each version's linked docs produce a distinct signature and its own cache
  //    row, so switching versions reuses that version's cache instead of
  //    re-extracting via Gemini.
  const { data: storedRows } = await supabase
    .from("qb_synced_reports")
    .select("data, updated_at")
    .eq("company_id", clientId)
    .eq("report_type", TAX_RETURN_KR_CACHE_TYPE)
    .eq("source", MANUAL_REPORT_UPLOAD_SOURCE)
    .order("updated_at", { ascending: false });
  const stored = (storedRows || []).find(
    (r) => r?.data?.tax_return?.documentSignature === documentSignature,
  );

  if (
    !forceRefresh &&
    stored?.data?.tax_return?.taxYears &&
    Object.keys(stored.data.tax_return.taxYears).length > 0
  ) {
    console.log(`[TaxData] Serving ${Object.keys(stored.data.tax_return.taxYears).length} year(s) from KR cache (version=${versionId})`);
    // Re-emit the "password-protected" notice on cache hits too, so the user
    // keeps seeing which linked returns couldn't be read (until they replace them).
    const lockedFiles = Array.isArray(stored.data.tax_return.lockedFiles) ? stored.data.tax_return.lockedFiles : [];
    const cachedWarnings = lockedFiles.map(
      (name) => `"${name}" is password-protected and could not be read. Please upload an unlocked copy of this tax return.`,
    );
    return {
      success: true,
      years: enrichTaxYears(stored.data.tax_return.taxYears),
      source: "db_cache",
      updatedAt: stored.updated_at,
      warnings: cachedWarnings.length ? cachedWarnings : undefined,
    };
  }

  if (forceRefresh) {
    console.log(`[TaxData] force=1 — clearing in-memory cache for fresh extraction`);
    clearTaxExtractCache();
  }

  // ── Real-time extraction over the Key Reports-linked documents ─────────
  const documents = linkedDocs;
  console.log(`[TaxData] Realtime extraction over ${documents.length} Key Reports-linked tax return document(s) (version=${versionId})`);
  documents.forEach((d) => console.log(`  "${d.name}" upload_id=${d.upload_id} file_url=${d.file_url}`));

  const years = {};
  const warnings = [];
  const lockedFiles = [];

  const settlements = await Promise.allSettled(
    documents.map(async (doc) => {
      const fileName = String(doc.name || "");
      let uploadId = doc.upload_id || null;
      let uploadData = null;

      if (uploadId) {
        const { data: up } = await supabase.from("uploads")
          .select("id, data, file_name, content_type").eq("id", uploadId).maybeSingle();
        if (up?.data) uploadData = up;
      }
      if (!uploadData && doc.file_url) {
        const m = String(doc.file_url).match(/\/uploads\/([0-9a-f-]{36})\/content/i);
        if (m) {
          uploadId = m[1];
          const { data: up } = await supabase.from("uploads")
            .select("id, data, file_name, content_type").eq("id", uploadId).maybeSingle();
          if (up?.data) uploadData = up;
        }
      }

      // Every early return below used to be a SILENT `return null`: a linked return
      // that never reached Gemini produced a missing fiscal-year column with no
      // explanation anywhere in the UI, indistinguishable from a return that
      // genuinely held no data. Each now reports why the file was not read.
      if (!uploadData?.data) {
        console.warn(`[TaxData] No binary for "${fileName}"`);
        return { unreadable: true, fileName, reason: `"${fileName}" has no readable file contents — nothing was sent to Gemini.` };
      }

      const storedName = String(uploadData.file_name || fileName);
      const ct = String(uploadData.content_type || "");
      // Tax returns are read ONLY by Gemini, directly from the original file, so
      // the accepted formats are exactly the ones Gemini takes as inline data
      // (PDF + images — a scanned return is as common as a digital one). Anything
      // else is refused outright rather than handed to a table reader.
      const mimeType = resolveTaxDocumentMime(storedName, ct)
        || resolveTaxDocumentMime(fileName, ct);
      if (!mimeType) {
        console.log(`[TaxData] "${fileName}" is not a Gemini-readable format`);
        return { unreadable: true, fileName, reason: unreadableTaxDocumentReason(fileName) };
      }

      let buffer = normalizeUploadBinary(uploadData.data);
      if (!buffer?.length) {
        console.warn(`[TaxData] Empty buffer for "${fileName}"`);
        return { unreadable: true, fileName, reason: `"${fileName}" is empty — nothing was sent to Gemini.` };
      }

      // Encrypted PDFs make Gemini fail with "The document has no pages" — which
      // silently dropped the return. Try a best-effort decrypt (handles the
      // common owner-restricted / empty-user-password case); if it still needs a
      // real password, report it clearly instead of losing the file.
      if (mimeType === "application/pdf" && isEncryptedPdf(buffer)) {
        console.log(`[TaxData] "${fileName}" is encrypted — attempting decrypt…`);
        const decrypted = await decryptPdfEmptyPassword(buffer);
        if (decrypted?.length) {
          console.log(`[TaxData] Decrypted "${fileName}" (${buffer.length} → ${decrypted.length} bytes)`);
          buffer = decrypted;
        } else {
          console.warn(`[TaxData] "${fileName}" is password-protected — cannot read`);
          return { locked: true, fileName };
        }
      }

      console.log(`[TaxData] Sending "${fileName}" (${buffer.length} bytes, ${mimeType}) to Gemini...`);
      const cacheKey = `tax_rt_${clientId}_${uploadId}`;
      const { extracted, status } = await extractTaxDataWithVerification(buffer, cacheKey, { mimeType });
      return { extracted, fileName, status };
    })
  );

  // Pull a 4-digit tax year (2000-2099) out of a filename, e.g.
  // "2023 RETURN ACCEPTED …" → 2023. Used as a fallback / tie-breaker so
  // distinctly-named returns are never collapsed by a mis-read content year.
  const yearFromFileName = (name) => {
    const m = String(name || "").match(/\b(20\d{2})\b/);
    const y = m ? Number(m[1]) : 0;
    return y >= 2000 && y <= 2099 ? y : 0;
  };

  for (const s of settlements) {
    if (s.status === "fulfilled" && s.value?.unreadable) {
      // Linked, but never reached Gemini. Surfaced so the user knows the document
      // was not read at all, instead of silently losing a fiscal year.
      warnings.push(s.value.reason);
      console.warn(`[TaxData] unreadable: ${s.value.reason}`);
      continue;
    }
    if (s.status === "fulfilled" && s.value?.locked) {
      // Encrypted PDF that needs a real password — surface it so the user knows
      // exactly which file to replace, instead of it vanishing from the table.
      lockedFiles.push(s.value.fileName);
      warnings.push(`"${s.value.fileName}" is password-protected and could not be read. Please upload an unlocked copy of this tax return.`);
      console.warn(`[TaxData] locked (password-protected): "${s.value.fileName}"`);
      continue;
    }
    if (s.status === "fulfilled" && s.value?.extracted) {
      const { extracted, fileName, status } = s.value;
      const contentYear = Number(extracted.year) || 0;
      const fileYear = yearFromFileName(fileName);
      // Prefer the year printed on the form; fall back to the filename year
      // when the form year is missing / out of range so the document is never
      // silently dropped (previously a year of 0 was filtered out entirely).
      let year = (contentYear >= 2010 && contentYear <= 2030) ? contentYear : fileYear;

      // Collision guard: if this key is already taken by a DIFFERENT document,
      // disambiguate using the filename year so two returns can't overwrite one
      // another (IRS forms can print the same top-right form/revision year).
      if (
        year && years[year] && years[year].fileName !== fileName &&
        fileYear && fileYear !== year && !years[fileYear]
      ) {
        year = fileYear;
      }

      if (!year) {
        warnings.push(`Could not determine the tax year for "${fileName}" — skipped.`);
        console.warn(`[TaxData] No year for "${fileName}" (content=${extracted.year}) — skipped`);
        continue;
      }
      if (years[year] && years[year].fileName !== fileName) {
        warnings.push(`Two tax returns resolved to ${year} ("${years[year].fileName}" and "${fileName}"); showing the latter.`);
      }
      // scheduleM1 is carried alongside `data` (not inside it): it anchors the
      // book-to-tax reconciliation (Schedule M-1 line 1 "Net income (loss) per
      // books") rather than being a label/amount row, and the Tax Reconciliation
      // engine reads it as `taxYear.scheduleM1`. It stays null when the return
      // has no Schedule M-1 so the page reports the anchor as unavailable instead
      // of showing a fabricated zero.
      years[year] = {
        year,
        fileName,
        status: status || "Needs Review",
        scheduleM1: extracted.scheduleM1 || null,
        data: buildTaxReturnResponseData(extracted),
      };
      console.log(`[TaxData] year=${year} (content=${contentYear}, file=${fileYear}) status=${status} from "${fileName}"`);
    } else if (s.status === "rejected") {
      const msg = s.reason?.message || String(s.reason);
      warnings.push(`Extraction failed: ${msg}`);
      console.warn(`[TaxData] ${msg}`);
    }
  }

  // Persist a version-aware cache so subsequent loads of the same version are
  // instant. Persistent PER document set: update this version's row if present,
  // otherwise insert — other versions' cache rows are left intact so switching
  // back to them stays a cache hit (no re-extraction).
  if (Object.keys(years).length > 0) {
    const now = new Date().toISOString();
    const payload = { tax_return: { taxYears: years, documentSignature, lockedFiles } };
    try {
      const { data: existingRows } = await supabase
        .from("qb_synced_reports")
        .select("id, data")
        .eq("company_id", clientId)
        .eq("report_type", TAX_RETURN_KR_CACHE_TYPE)
        .eq("source", MANUAL_REPORT_UPLOAD_SOURCE);
      const existing = (existingRows || []).find(
        (r) => r?.data?.tax_return?.documentSignature === documentSignature,
      );
      if (existing?.id) {
        await supabase
          .from("qb_synced_reports")
          .update({ data: payload, status: "synced", last_synced_at: now, updated_at: now })
          .eq("id", existing.id);
      } else {
        await supabase.from("qb_synced_reports").insert({
          company_id: clientId,
          report_type: TAX_RETURN_KR_CACHE_TYPE,
          source: MANUAL_REPORT_UPLOAD_SOURCE,
          data: payload,
          status: "synced",
          last_synced_at: now,
          updated_at: now,
        });
      }
    } catch (cacheErr) {
      console.warn(`[TaxData] KR cache write failed (non-fatal): ${cacheErr.message}`);
    }
  }

  return {
    success: true,
    years,
    source: "realtime",
    documentCount: documents.length,
    warnings: warnings.length ? warnings : undefined,
  };
}

/* ===========================
   GET /manual-report-uploads/tax-data
   Returns multi-year tax return data for the selected Key Reports version.
   Thin wrapper around runTaxExtraction (shared with the Generate warm-up path).
=========================== */
router.get("/manual-report-uploads/tax-data", async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(400).json({ success: false, error: "Missing clientId." });

    // ── Resolve the source tax return(s) from the SELECTED Key Reports version
    //    (from the chosen Manual GL dataset version), falling back to the active
    //    version when none is selected. The linked document set keys the cache, so
    //    switching versions (Version 1 → Tax_2024.pdf, Version 2 → Tax_2025.pdf)
    //    refreshes it.
    const datasetVersion = String(req.query.datasetVersion || "").trim() || null;
    const keyReportVersionId = String(req.query.keyReportVersionId || "").trim() || null;
    const forceRefresh = req.query.force === "1" || req.query.force === "true";

    const body = await runTaxExtraction(clientId, { datasetVersion, keyReportVersionId, forceRefresh });
    return res.json(body);
  } catch (err) {
    console.error("[TaxData] Error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/* ===========================
   GET /manual-report-uploads/pl-for-tax
   Returns Gemini-extracted P&L data keyed by fiscal year.
   1. Checks qb_synced_reports for cached P&L data (fast path).
   2. Falls back to real-time Gemini extraction from DataRoom Profit & Loss folder.
=========================== */
router.get("/manual-report-uploads/pl-for-tax", async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(400).json({ success: false, error: "Missing clientId." });

    const PL_FOR_TAX_REPORT_TYPE = "pl_for_tax";

    // ── Fast path: return data already stored by Sync All ─────────────────
    const { data: stored } = await supabase
      .from("qb_synced_reports")
      .select("data, updated_at")
      .eq("company_id", clientId)
      .eq("report_type", PL_FOR_TAX_REPORT_TYPE)
      .eq("source", MANUAL_REPORT_UPLOAD_SOURCE)
      .maybeSingle();

    const forceRefreshPL = req.query.force === "1" || req.query.force === "true";

    if (!forceRefreshPL && stored?.data?.pl_for_tax?.plYears && Object.keys(stored.data.pl_for_tax.plYears).length > 0) {
      console.log(`[PLForTax] Serving ${Object.keys(stored.data.pl_for_tax.plYears).length} year(s) from DB cache`);
      return res.json({
        success: true,
        years: stored.data.pl_for_tax.plYears,
        source: "db_cache",
        updatedAt: stored.updated_at,
      });
    }

    // ── Fast path 2: Use pre-parsed rows stored during Excel/PDF Sync ─────────
    // Covers Excel files (.xlsx/.xls/.csv) which the Gemini slow path skips,
    // and any PDF already synced via "Sync All".
    const parsedFiles = await getAllManualUploadedReports({ companyId: clientId, statementType: "profit_and_loss" });
    const validFiles = (parsedFiles || []).filter((f) => f.data?.manual_report_upload?.report?.rows?.length > 0);

    if (validFiles.length > 0) {
      const currentYear = new Date().getFullYear();
      const yearsFromParsed = {};

      for (const file of validFiles) {
        const report = file.data.manual_report_upload.report;
        const fileName = file.report_params?.fileName || "Unknown";
        const periods = report.periods || [];

        // Year detection: asOfDate → periodEnd → periodStart → filename
        let year = 0;
        const dateSrc = report.asOfDate || report.periodEnd || report.periodStart;
        if (dateSrc) {
          const parsed = parseInt(String(dateSrc).split("-")[0], 10);
          if (parsed >= 2000 && parsed <= currentYear + 1) year = parsed;
        }
        if (!year) {
          const m = fileName.match(/\b(20\d{2})\b/);
          if (m) year = parseInt(m[1], 10);
        }
        if (!year) year = currentYear;

        // For multi-period files (monthly columns): use Total col or sum months
        const totalIdx = periods.length > 0
          ? periods.findIndex((p) => /^total$/i.test(String(p).trim()))
          : -1;
        const normalizeNode = (node) => ({
          ...node,
          amount: Array.isArray(node.colAmounts) && node.colAmounts.length > 0
            ? totalIdx >= 0
              ? (node.colAmounts[totalIdx] || 0)
              : node.colAmounts.reduce((s, v) => s + (v || 0), 0)
            : (typeof node.amount === "number" ? node.amount : 0),
          children: Array.isArray(node.children) ? node.children.map(normalizeNode) : undefined,
        });
        const normalizedRows = report.rows.map(normalizeNode);

        const pl = extractPLLineItemsFromRows(normalizedRows, year);

        // If two files share a year, keep the most recently updated
        if (!yearsFromParsed[year] || new Date(file.updated_at) > new Date(yearsFromParsed[year]._updatedAt)) {
          yearsFromParsed[year] = { year, fileName, data: buildPLForTaxData(pl), _updatedAt: file.updated_at };
        }
      }

      // Strip internal tracking field before responding
      Object.values(yearsFromParsed).forEach((v) => delete v._updatedAt);

      if (Object.keys(yearsFromParsed).length > 0) {
        console.log(`[PLForTax] Serving ${Object.keys(yearsFromParsed).length} year(s) from pre-parsed report rows`);
        return res.json({ success: true, years: yearsFromParsed, source: "parsed_rows" });
      }
    }

    // ── Slow path: real-time extraction from DataRoom ──────────────────────
    const { data: sourceFolder, error: sfErr } = await supabase
      .from("folders")
      .select("id, name")
      .eq("company_id", clientId)
      .is("parent_id", null)
      .ilike("name", "Manual Upload Source")
      .maybeSingle();

    if (sfErr) throw new Error(sfErr.message);
    if (!sourceFolder) {
      return res.json({ success: true, years: {}, warning: "No 'Manual Upload Source' folder found. Run Sync All first." });
    }

    // Find "Profit & Loss" folder (direct child or inside a Reports group)
    let plFolder = null;
    const { data: directChildren } = await supabase
      .from("folders").select("id, name").eq("parent_id", sourceFolder.id);

    const PL_NAMES = ["profit & loss", "profit and loss", "p&l", "income statement"];
    for (const child of (directChildren || [])) {
      if (PL_NAMES.includes(child.name.toLowerCase().trim())) { plFolder = child; break; }
    }
    if (!plFolder) {
      for (const child of (directChildren || [])) {
        const { data: grandChildren } = await supabase.from("folders").select("id, name").eq("parent_id", child.id);
        for (const gc of (grandChildren || [])) {
          if (PL_NAMES.includes(gc.name.toLowerCase().trim())) { plFolder = gc; break; }
        }
        if (plFolder) break;
      }
    }

    if (!plFolder) {
      return res.json({ success: true, years: {}, warning: "No 'Profit & Loss' subfolder found. Run Sync All first." });
    }

    const { data: documents } = await supabase
      .from("documents").select("id, name, upload_id, file_url")
      .eq("folder_id", plFolder.id).order("name", { ascending: true });

    console.log(`[PLForTax] Realtime extraction: ${(documents || []).length} doc(s) in folder id=${plFolder.id}`);

    if (!(documents || []).length) {
      return res.json({ success: true, years: {}, warning: "No documents in Profit & Loss folder." });
    }

    const years = {};
    const warnings = [];

    const settlements = await Promise.allSettled(
      (documents || []).map(async (doc) => {
        const fileName = String(doc.name || "");
        let uploadId = doc.upload_id || null;
        let uploadData = null;

        if (uploadId) {
          const { data: up } = await supabase.from("uploads")
            .select("id, data, file_name, content_type").eq("id", uploadId).maybeSingle();
          if (up?.data) uploadData = up;
        }
        if (!uploadData && doc.file_url) {
          const m = String(doc.file_url).match(/\/uploads\/([0-9a-f-]{36})\/content/i);
          if (m) {
            uploadId = m[1];
            const { data: up } = await supabase.from("uploads")
              .select("id, data, file_name, content_type").eq("id", uploadId).maybeSingle();
            if (up?.data) uploadData = up;
          }
        }

        if (!uploadData?.data) {
          console.warn(`[PLForTax] No binary for "${fileName}"`);
          return null;
        }

        const storedName = String(uploadData.file_name || fileName).toLowerCase();
        const ct = String(uploadData.content_type || "").toLowerCase();
        if (!storedName.endsWith(".pdf") && !ct.includes("pdf") && !fileName.toLowerCase().endsWith(".pdf")) {
          console.log(`[PLForTax] Skipping non-PDF "${fileName}"`);
          return null;
        }

        const buffer = normalizeUploadBinary(uploadData.data);
        if (!buffer?.length) { console.warn(`[PLForTax] Empty buffer for "${fileName}"`); return null; }

        console.log(`[PLForTax] Sending "${fileName}" (${buffer.length} bytes) to Gemini...`);
        const cacheKey = `pl_rt_${clientId}_${uploadId || fileName}`;
        try {
          const extracted = await extractPLForTax(buffer, cacheKey);
          return { extracted, fileName };
        } catch (geminiErr) {
          // Fallback: PDF text extraction for text-based P&L PDFs
          console.warn(`[PLForTax] Gemini failed for "${fileName}", trying text fallback: ${geminiErr.message}`);
          try {
            const geminiResult = await parsePdfWithGemini(buffer, fileName);
            if (Array.isArray(geminiResult?.rows) && geminiResult.rows.length > 0) {
              let year = geminiResult.asOfDate ? parseInt(String(geminiResult.asOfDate).split("-")[0], 10) : 0;
              if (!year) { const m = fileName.match(/\b(20\d{2})\b/); if (m) year = parseInt(m[1], 10); }
              if (year) {
                const pl = extractPLLineItemsFromRows(geminiResult.rows, year);
                return { extracted: pl, fileName };
              }
            }
          } catch { /* text fallback also failed */ }
          throw geminiErr; // let the settlement catch it
        }
      })
    );

    for (const s of settlements) {
      if (s.status === "fulfilled" && s.value?.extracted?.year) {
        const { extracted, fileName } = s.value;
        const year = Number(extracted.year);
        years[year] = { year, fileName, data: buildPLForTaxData(extracted) };
        console.log(`[PLForTax] year=${year} from "${fileName}"`);
      } else if (s.status === "rejected") {
        const msg = s.reason?.message || String(s.reason);
        warnings.push(`Extraction failed: ${msg}`);
        console.warn(`[PLForTax] ${msg}`);
      }
    }

    // Cache result in DB so next call is instant
    if (Object.keys(years).length > 0) {
      try {
        const now = new Date().toISOString();
        const { data: existing } = await supabase.from("qb_synced_reports").select("id")
          .eq("company_id", clientId).eq("report_type", PL_FOR_TAX_REPORT_TYPE)
          .eq("source", MANUAL_REPORT_UPLOAD_SOURCE).maybeSingle();
        const payload = {
          company_id: clientId,
          report_type: PL_FOR_TAX_REPORT_TYPE,
          source: MANUAL_REPORT_UPLOAD_SOURCE,
          data: { pl_for_tax: { plYears: years, syncedAt: now } },
          status: "synced",
          last_synced_at: now,
          updated_at: now,
        };
        if (existing?.id) {
          await supabase.from("qb_synced_reports").update(payload).eq("id", existing.id);
        } else {
          await supabase.from("qb_synced_reports").insert(payload);
        }
      } catch (cacheErr) {
        console.warn(`[PLForTax] Failed to cache result: ${cacheErr.message}`);
      }
    }

    return res.json({
      success: true,
      years,
      source: "realtime",
      documentCount: (documents || []).length,
      warnings: warnings.length ? warnings : undefined,
    });
  } catch (err) {
    console.error("[PLForTax] Error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/* ===========================
   GET /manual-upload/cashflow/periods
   List all periods for which an automatic Cash Flow can be generated.
   A period is available when BS(Y-1), BS(Y), and P&L(Y) are all uploaded.
=========================== */
router.get("/manual-upload/cashflow/periods", async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(400).json({ success: false, error: "Missing clientId." });

    const periods = await listAvailablePeriods(clientId);
    return res.json({ success: true, periods });
  } catch (error) {
    console.error("[CashFlowPeriods] Error:", error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

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
router.get("/manual-upload/cashflow", async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(400).json({ success: false, error: "Missing clientId." });

    const period = String(req.query.period || "").trim();
    if (!period || !/^\d{4}$/.test(period)) {
      return res.status(400).json({
        success: false,
        error: "period query param is required and must be a 4-digit year (e.g. 2022).",
      });
    }

    // Read pre-generated CF — created during Sync All, never on-demand
    const cached = await getCachedCashFlow(clientId, period);
    if (cached) {
      console.log(`[ManualCashFlow] Serving pre-generated statement for period=${period}`);
      return res.json({ ...cached, source: "manual_upload_generated" });
    }

    return res.status(404).json({
      success: false,
      source: "manual_upload_generated",
      error: `No cash flow report found for ${period}. Run Sync All to generate cash flow reports automatically.`,
      period,
    });
  } catch (error) {
    console.error("[ManualCashFlow] Error:", error.message);
    return res.status(500).json({
      success: false,
      source: "manual_upload_generated",
      error: error.message,
    });
  }
});

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
    // When a Key Report Version drives this request the active connection source
    // is "key_reports" — report that in the response instead of the underlying
    // manual_upload flow used to read the linked documents.
    const responseSource = keyReportVersionId ? "key_reports" : "manual_upload";

    // Fetch P&L financials in parallel — merges Sales/Expenses per Financials into
    // this response. In Key Reports mode (a version is selected) the figures come
    // from THIS version's generated P&L: Sales per Financials = monthly accrual
    // revenue (revenue.total), Expenses per Financials = monthly Total Operating
    // Expenses (operatingExpenses.total). Otherwise (plain Manual Upload) fall back
    // to the uploaded-P&L extraction.
    const plFinancialsPromise = keyReportVersionId
      ? getMonthlyPlFinancials(keyReportVersionId).catch((e) => {
          console.warn(`[BANK SOURCE] KR P&L financials failed (non-fatal): ${e.message}`);
          return null;
        })
      : extractPlFinancials(clientId, MANUAL_REPORT_UPLOAD_SOURCE, {
          keyReportVersionId,
          datasetVersion,
        }).catch(() => null);

    // Key Reports mode: auto-derive every Activity Review adjustment row (Change
    // in AR, Change in Current/LT Liabilities, Depreciation, Amortization, Bad
    // Debt, Fixed Asset Purchases/Disposals, AR Retentions) from THIS version's
    // financial statements. Non-fatal — the frontend also mirrors this from the
    // financial-statements payload, so a null here never blanks the table.
    const activityReviewPromise = keyReportVersionId
      ? getMonthlyActivityReview(keyReportVersionId).catch((e) => {
          console.warn(`[BANK SOURCE] KR Activity Review failed (non-fatal): ${e.message}`);
          return null;
        })
      : Promise.resolve(null);

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

    console.log(`[BANK SOURCE] source=${responseSource} clientId=${clientId} — resolving bank statement from active Key Reports version...`);

    // Bank statement is resolved strictly from the active Key Reports version
    // (version-aware cache + live extraction handled by runBankExtraction). BS
    // bank accounts and P&L financials remain manual_upload-source-scoped.
    const { body: bankBody } = await runBankExtraction(clientId, MANUAL_REPORT_UPLOAD_SOURCE, "Manual Upload Source", datasetVersion, keyReportVersionId);
    const [balanceSheetBankAccounts, plFinancials, activityReview] = await Promise.all([
      bsBankAccountsPromise, plFinancialsPromise, activityReviewPromise,
    ]);

    if (!bankBody?.banks?.length) {
      return res.json({
        success: true,
        empty: true,
        source: responseSource,
        banks: [],
        months: [],
        totals: [],
        message: bankBody?.message || "No Bank Statement is linked in the active Key Reports version. Link a Bank Statement in Key Reports and sync before using Bank Reconciliation.",
        balanceSheetBankAccounts,
        plFinancials,
        activityReview,
      });
    }

    return res.json({
      success: true,
      source: responseSource,
      banks: bankBody.banks,
      months: bankBody.months || [],
      totals: bankBody.totals || [],
      syncedAt: bankBody.syncedAt,
      balanceSheetBankAccounts,
      plFinancials,
      activityReview,
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
router.get("/manual-report-uploads/tax-reconciliation-overrides", async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(400).json({ success: false, error: "Missing clientId." });

    const { data } = await supabase
      .from("qb_synced_reports")
      .select("data, updated_at")
      .eq("company_id", clientId)
      .eq("report_type", "tax_reconciliation_overrides")
      .maybeSingle();

    return res.json({
      success: true,
      overrides: data?.data?.overrides || {},
      updatedAt: data?.updated_at || null,
    });
  } catch (err) {
    console.error("[TaxOverrides GET] Error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/* ===========================
   PUT /manual-report-uploads/tax-reconciliation-overrides
   Saves (upserts) the full user-edited Schedule K overrides for this company.
   Body: { overrides: { [year]: { [label]: { taxReturn, pl } } } }
=========================== */
router.put("/manual-report-uploads/tax-reconciliation-overrides", async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(400).json({ success: false, error: "Missing clientId." });

    const { overrides } = req.body || {};
    if (!overrides || typeof overrides !== "object") {
      return res.status(400).json({ success: false, error: "Missing or invalid overrides object." });
    }

    const now = new Date().toISOString();

    const { data: existing } = await supabase
      .from("qb_synced_reports")
      .select("id")
      .eq("company_id", clientId)
      .eq("report_type", "tax_reconciliation_overrides")
      .maybeSingle();

    const payload = {
      company_id: clientId,
      report_type: "tax_reconciliation_overrides",
      source: MANUAL_REPORT_UPLOAD_SOURCE,
      data: { overrides },
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

    return res.json({ success: true, updatedAt: now });
  } catch (err) {
    console.error("[TaxOverrides PUT] Error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
// Exposed for the Key Reports Generate flow to pre-warm the Tax Reconciliation
// cache (same extraction + cache-key path the page uses).
module.exports.runTaxExtraction = runTaxExtraction;
// Pure helper, exposed so the published-row → validator round trip can be tested
// directly. The two must agree on what each row means: when the "Total Revenue"
// row changed from gross receipts to total income, reading it back into the
// gross-receipts field silently failed the gross-profit identity.
module.exports.enrichTaxYearWithStatus = enrichTaxYearWithStatus;
