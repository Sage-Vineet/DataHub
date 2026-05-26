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
  extractAndCacheReportAsOfDate,
  extractTaxDataFromBuffer,
  clearTaxExtractCache,
  buildTaxReturnResponseData,
  extractPLForTax,
  buildPLForTaxData,
  extractPLLineItemsFromRows,
  buildQMSDashboardData,
  buildManualUploadDashboardData,
} = require("../services/manualReportUploadService");
const { parsePdfWithGemini } = require("../services/geminiFinancialParser");
const {
  normalizeBankBinary,
  extractBankStatementsFromPdfBase64,
  extractBankStatementsFromExcelBuffer,
  buildBankResponseShape,
} = require("../services/bankStatementExtractor");
const {
  getCachedCashFlow,
  listAvailablePeriods,
  generatedCfToRows,
} = require("../services/manualCashFlowService");
const { supabase } = require("../db");
const { canAccessCompany } = require("../services/permissionService");

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
  const clientId = resolveClientId(req);
  if (clientId && !canAccessCompany(req.user, clientId)) {
    return res.status(403).json({ error: "Forbidden" });
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

    let row;
    if (rowId) {
      const { data: specificRow, error: rowErr } = await supabase
        .from("qb_synced_reports")
        .select("id, report_type, report_params, data, updated_at, last_synced_at")
        .eq("id", rowId)
        .eq("company_id", clientId)
        .maybeSingle();
      if (rowErr) throw new Error(rowErr.message);
      row = specificRow;
    } else {
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

    const rows = await getAllManualUploadedReports({ companyId: clientId, statementType });

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

    const rows = await getAllQMSUploadedReports({ companyId: clientId, statementType });

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

    const { data: row, error } = await supabase
      .from("qb_synced_reports")
      .select("data")
      .eq("company_id", clientId)
      .eq("source", "quickbooks_manual_upload")
      .eq("report_type", STATEMENT_TYPES.BANK_RECONCILIATION)
      .order("last_synced_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw new Error(error.message);

    const bankData = row?.data?.bank_reconciliation || {};
    return res.json({
      success: true,
      banks: bankData.banks || [],
      months: bankData.months || [],
      totals: bankData.totals || [],
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

    let row;
    if (rowId) {
      const { data: specificRow, error: rowErr } = await supabase
        .from("qb_synced_reports")
        .select("id, report_type, report_params, data, updated_at, last_synced_at")
        .eq("id", rowId)
        .eq("company_id", clientId)
        .maybeSingle();
      if (rowErr) throw new Error(rowErr.message);
      row = specificRow;
    } else {
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
router.get("/manual-report-uploads/tax-data", async (req, res) => {
  try {
    const clientId = resolveClientId(req);
    if (!clientId) return res.status(400).json({ success: false, error: "Missing clientId." });

    // ── Fast path: return data already stored by Sync All ─────────────────
    const { data: stored } = await supabase
      .from("qb_synced_reports")
      .select("data, updated_at")
      .eq("company_id", clientId)
      .eq("report_type", STATEMENT_TYPES.TAX_RETURN)
      .eq("source", MANUAL_REPORT_UPLOAD_SOURCE)
      .maybeSingle();

    const forceRefresh = req.query.force === "1" || req.query.force === "true";

    if (!forceRefresh && stored?.data?.tax_return?.taxYears && Object.keys(stored.data.tax_return.taxYears).length > 0) {
      console.log(`[TaxData] Serving ${Object.keys(stored.data.tax_return.taxYears).length} year(s) from DB cache`);
      return res.json({
        success: true,
        years: stored.data.tax_return.taxYears,
        source: "db_cache",
        updatedAt: stored.updated_at,
      });
    }

    if (forceRefresh) {
      console.log(`[TaxData] force=1 — clearing DB + in-memory cache for fresh extraction`);
      clearTaxExtractCache();
      if (stored?.id) {
        await supabase.from("qb_synced_reports").delete()
          .eq("company_id", clientId).eq("report_type", STATEMENT_TYPES.TAX_RETURN)
          .eq("source", MANUAL_REPORT_UPLOAD_SOURCE);
      }
    }

    // ── Slow path: real-time extraction from DataRoom ──────────────────────
    // Find "Manual Upload Source" root folder
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

    // Find "Tax Return" (or legacy "Tax Reconciliation") folder (direct child or inside a Reports group)
    let taxFolder = null;
    const { data: directChildren } = await supabase
      .from("folders").select("id, name").eq("parent_id", sourceFolder.id);

    for (const child of (directChildren || [])) {
      const lc = child.name.toLowerCase().trim();
      if (lc === "tax return" || lc === "tax reconciliation") { taxFolder = child; break; }
    }
    if (!taxFolder) {
      for (const child of (directChildren || [])) {
        const { data: gc } = await supabase.from("folders").select("id, name")
          .eq("parent_id", child.id).or("name.ilike.Tax Return,name.ilike.Tax Reconciliation").maybeSingle();
        if (gc) { taxFolder = gc; break; }
      }
    }

    if (!taxFolder) {
      return res.json({ success: true, years: {}, warning: "No 'Tax Return' subfolder found. Run Sync All first." });
    }

    // Get all documents (no upload_id filter — some docs use file_url)
    const { data: documents } = await supabase
      .from("documents").select("id, name, upload_id, file_url")
      .eq("folder_id", taxFolder.id).order("name", { ascending: true });

    console.log(`[TaxData] Realtime extraction: ${(documents || []).length} doc(s) in folder id=${taxFolder.id}`);
    (documents || []).forEach((d) => console.log(`  "${d.name}" upload_id=${d.upload_id} file_url=${d.file_url}`));

    if (!(documents || []).length) {
      return res.json({ success: true, years: {}, warning: "No documents in Tax Return folder." });
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
          console.warn(`[TaxData] No binary for "${fileName}"`);
          return null;
        }

        const storedName = String(uploadData.file_name || fileName).toLowerCase();
        const ct = String(uploadData.content_type || "").toLowerCase();
        if (!storedName.endsWith(".pdf") && !ct.includes("pdf") && !fileName.toLowerCase().endsWith(".pdf")) {
          console.log(`[TaxData] Skipping non-PDF "${fileName}"`);
          return null;
        }

        const buffer = normalizeUploadBinary(uploadData.data);
        if (!buffer?.length) { console.warn(`[TaxData] Empty buffer for "${fileName}"`); return null; }

        console.log(`[TaxData] Sending "${fileName}" (${buffer.length} bytes) to Gemini...`);
        const cacheKey = `tax_rt_${clientId}_${uploadId}`;
        const extracted = await extractTaxDataFromBuffer(buffer, cacheKey);
        return { extracted, fileName };
      })
    );

    for (const s of settlements) {
      if (s.status === "fulfilled" && s.value?.extracted?.year) {
        const { extracted, fileName } = s.value;
        const year = Number(extracted.year);
        years[year] = { year, fileName, data: buildTaxReturnResponseData(extracted) };
        console.log(`[TaxData] year=${year} from "${fileName}"`);
      } else if (s.status === "rejected") {
        const msg = s.reason?.message || String(s.reason);
        warnings.push(`Extraction failed: ${msg}`);
        console.warn(`[TaxData] ${msg}`);
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

    console.log(`[BANK SOURCE] source=manual_upload clientId=${clientId} — checking cache...`);

    // 1. Check source-isolated cache (manual_report_upload only)
    const { data: cached } = await supabase
      .from("qb_synced_reports")
      .select("data, updated_at")
      .eq("company_id", clientId)
      .eq("source", MANUAL_REPORT_UPLOAD_SOURCE)
      .eq("report_type", STATEMENT_TYPES.BANK_RECONCILIATION)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (cached?.data?.bank_reconciliation?.banks?.length > 0) {
      const bd = cached.data.bank_reconciliation;
      console.log(`[BANK SOURCE] Cache hit — ${bd.banks.length} bank(s) for ${clientId}`);
      return res.json({
        success: true,
        source: "manual_upload",
        banks: bd.banks,
        months: bd.months || [],
        totals: bd.totals || [],
        syncedAt: bd.syncedAt || cached.updated_at,
      });
    }

    // 2. Live extraction from "Manual Upload Source" DataRoom folder
    console.log(`[BANK SOURCE] Cache miss — live extraction from "Manual Upload Source" for ${clientId}`);

    const { data: sourceFolder } = await supabase
      .from("folders")
      .select("id")
      .eq("company_id", clientId)
      .is("parent_id", null)
      .ilike("name", "Manual Upload Source")
      .maybeSingle();

    if (!sourceFolder) {
      console.log(`[BANK SOURCE] "Manual Upload Source" folder not found for ${clientId}`);
      return res.json({
        success: true,
        empty: true,
        source: "manual_upload",
        banks: [],
        months: [],
        totals: [],
        message: "No bank statements uploaded. Upload PDF or Excel files to Manual Upload Source → Bank Statement in the Data Room.",
      });
    }

    // Find "Bank Statement" (or legacy "Bank Reconciliation") subfolder
    let bankFolder = null;
    for (const folderName of ["Bank Statement", "Bank Reconciliation"]) {
      const { data: found } = await supabase
        .from("folders")
        .select("id")
        .eq("company_id", clientId)
        .ilike("name", folderName)
        .or(`parent_id.eq.${sourceFolder.id}`)
        .maybeSingle();
      if (found) { bankFolder = found; break; }
    }

    if (!bankFolder) {
      console.log(`[BANK SOURCE] "Bank Statement" subfolder not found for ${clientId}`);
      return res.json({
        success: true,
        empty: true,
        source: "manual_upload",
        banks: [],
        months: [],
        totals: [],
        message: "No bank statements uploaded. Create a Bank Statement folder under Manual Upload Source in the Data Room.",
      });
    }

    const { data: documents } = await supabase
      .from("documents")
      .select("id, name, upload_id, file_url")
      .eq("folder_id", bankFolder.id)
      .order("uploaded_at", { ascending: false });

    if (!documents?.length) {
      console.log(`[BANK SOURCE] No documents in Bank Statement folder for ${clientId}`);
      return res.json({
        success: true,
        empty: true,
        source: "manual_upload",
        banks: [],
        months: [],
        totals: [],
        message: "No bank statements uploaded. Upload PDF or Excel files to Manual Upload Source → Bank Statement in the Data Room.",
      });
    }

    const allStatements = [];
    const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

    for (const doc of documents) {
      const fileName = String(doc.name || "bank_statement");
      const ext = fileName.toLowerCase().split(".").pop();
      const isPdf = ext === "pdf";
      const isExcel = ["xlsx", "xls", "csv"].includes(ext);
      if (!isPdf && !isExcel) continue;

      let buffer = null;
      if (doc.upload_id) {
        const { data: upload } = await supabase
          .from("uploads").select("data").eq("id", doc.upload_id).maybeSingle();
        if (upload?.data) buffer = normalizeBankBinary(upload.data);
      }
      if (!buffer && doc.file_url) {
        const m = String(doc.file_url).match(/\/uploads\/([0-9a-f-]{36})\/content/i);
        if (m) {
          const { data: upload2 } = await supabase
            .from("uploads").select("data").eq("id", m[1]).maybeSingle();
          if (upload2?.data) buffer = normalizeBankBinary(upload2.data);
        }
      }
      if (!buffer && doc.file_url) {
        const uuidMatch = String(doc.file_url).match(UUID_RE);
        if (uuidMatch) {
          const { data: upload3 } = await supabase
            .from("uploads").select("data").eq("id", uuidMatch[0]).maybeSingle();
          if (upload3?.data) buffer = normalizeBankBinary(upload3.data);
        }
      }
      if (!buffer?.length) {
        console.warn(`[BANK SOURCE] No binary data for "${fileName}", skipping`);
        continue;
      }

      try {
        const statements = isExcel
          ? await extractBankStatementsFromExcelBuffer(buffer, fileName)
          : await extractBankStatementsFromPdfBase64(buffer.toString("base64"), fileName);
        allStatements.push(...statements);
      } catch (err) {
        console.error(`[BANK SOURCE] Extraction failed for "${fileName}": ${err.message}`);
      }
    }

    if (!allStatements.length) {
      console.log(`[BANK SOURCE] No extractable bank data in ${documents.length} file(s) for ${clientId}`);
      return res.json({
        success: true,
        empty: true,
        source: "manual_upload",
        banks: [],
        months: [],
        totals: [],
        message: "No bank statement data could be extracted from the uploaded files.",
      });
    }

    const { banks, months, totals } = buildBankResponseShape(allStatements);
    console.log(`[BANK SOURCE] Extracted ${banks.length} bank(s) from ${documents.length} file(s) for ${clientId}`);
    return res.json({ success: true, source: "manual_upload", banks, months, totals });
  } catch (error) {
    console.error("[BANK SOURCE] Error:", error);
    return res.status(500).json({ success: false, error: error.message || "Failed to fetch manual upload bank data." });
  }
});

module.exports = router;
