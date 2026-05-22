const express = require("express");
const router = express.Router();
const { supabase } = require("../../../db");
const {
  normalizeBankBinary,
  extractBankStatementsFromPdfBase64,
  extractBankStatementsFromExcelBuffer,
  buildBankResponseShape,
} = require("../../../services/bankStatementExtractor");

const MANUAL_REPORT_UPLOAD_SOURCE = "manual_report_upload";
const QMS_REPORT_UPLOAD_SOURCE = "quickbooks_manual_upload";
const BANK_RECONCILIATION_TYPE = "bank_reconciliation";

// Maps frontend REPORT_SOURCE_KEYS values → backend cache source + DataRoom folder root
const SOURCE_CONFIG = {
  manual_upload_excel_pdf: {
    cacheSource: MANUAL_REPORT_UPLOAD_SOURCE,
    folderRootName: "Manual Upload Source",
  },
  quickbooks_manual: {
    cacheSource: QMS_REPORT_UPLOAD_SOURCE,
    folderRootName: "Quickbooks Manual Source",
  },
};
const DEFAULT_SOURCE_CONFIG = SOURCE_CONFIG.manual_upload_excel_pdf;

// Middleware to extract clientId with multiple fallbacks
const extractClientId = (req, res, next) => {
  let clientId = req.clientId;
  if (!clientId && req.query.clientId) clientId = req.query.clientId;
  if (!clientId && req.headers["x-client-id"]) clientId = req.headers["x-client-id"];
  if (!clientId && req.headers.referer) {
    const match = req.headers.referer.match(/\/client\/([^/]+)/) ||
      req.headers.referer.match(/\/workspace\/([^/]+)/);
    if (match) clientId = match[1];
  }
  if (clientId) req.clientId = clientId;
  next();
};

// ─────────────────────────────────────────────────────────────────────────────
// DataRoom: get PDF documents from "Bank Reconciliation" folder
// ─────────────────────────────────────────────────────────────────────────────
async function getBankReconciliationDocuments(companyId, folderRootName = "Manual Upload Source") {
  const { data: sourceFolder } = await supabase
    .from("folders")
    .select("id")
    .eq("company_id", companyId)
    .is("parent_id", null)
    .ilike("name", folderRootName)
    .maybeSingle();

  if (!sourceFolder) {
    console.log(`[BankPDF] "${folderRootName}" folder not found for company ${companyId}`);
    return [];
  }

  // Find "Bank Statement" (or legacy "Bank Reconciliation") subfolder
  let bankFolder = null;
  for (const folderName of ["Bank Statement", "Bank Reconciliation"]) {
    const { data: found } = await supabase
      .from("folders")
      .select("id")
      .eq("company_id", companyId)
      .ilike("name", folderName)
      .or(`parent_id.eq.${sourceFolder.id}`)
      .maybeSingle();
    if (found) { bankFolder = found; break; }
  }

  if (!bankFolder) {
    console.log(`[BankPDF] "Bank Statement" subfolder not found for company ${companyId}`);
    return [];
  }

  const { data: documents, error } = await supabase
    .from("documents")
    .select("id, name, upload_id, file_url")
    .eq("folder_id", bankFolder.id)
    .order("uploaded_at", { ascending: false });

  if (error) console.warn(`[BankPDF] Error fetching documents: ${error.message}`);
  console.log(`[BankPDF] Found ${documents?.length || 0} document(s) in Bank Statement folder for company ${companyId}`);
  return documents || [];
}

/**
 * @swagger
 * /api/bank-vs-books:
 *   get:
 *     tags: [Reconciliation]
 *     summary: Bank vs Books transaction matching
 */
router.get("/bank-vs-books", extractClientId, async (req, res) => {
  try {
    if (!req.clientId) return res.status(400).json({ error: "Missing Client ID" });

    const [bankRes, bookRes] = await Promise.all([
      supabase.from("bank_transactions").select("txn_date, narration, amount")
        .eq("client_id", req.clientId).order("txn_date", { ascending: true }),
      supabase.from("reconciliation_transactions").select("txn_date, name, amount")
        .eq("client_id", req.clientId).order("txn_date", { ascending: true }),
    ]);

    if (bankRes.error) throw bankRes.error;
    if (bookRes.error) throw bookRes.error;

    const bankRows = bankRes.data || [];
    const bookRows = bookRes.data || [];

    const reconciled = bankRows.map((b) => {
      const match = bookRows.find(
        (r) => Math.abs(b.amount) === Math.abs(r.amount) && b.txn_date === r.txn_date,
      );
      let remark = "Unmatched (Bank)";
      if (match) remark = b.amount === match.amount ? "Matched" : "Amount Mismatch";
      return {
        bank_date: b.txn_date, bank_narration: b.narration, bank_amount: b.amount,
        book_date: match ? match.txn_date : null, book_name: match ? match.name : null,
        book_amount: match ? match.amount : null, remark,
      };
    });

    res.json({ totalRecords: reconciled.length, data: reconciled });
  } catch (error) {
    console.error("Reconciliation Error:", error);
    res.status(500).json({ error: "Failed to reconcile transactions" });
  }
});

/**
 * @swagger
 * /api/reconciliation-data:
 *   get:
 *     tags: [Reconciliation]
 *     summary: Fetch bank and books transactions
 */
router.get("/reconciliation-data", extractClientId, async (req, res) => {
  try {
    if (!req.clientId) return res.status(400).json({ error: "Missing Client ID" });
    const [bankData, booksData] = await Promise.all([
      supabase.from("bank_transactions").select("txn_date, narration, amount")
        .eq("client_id", req.clientId).order("txn_date", { ascending: true }),
      supabase.from("reconciliation_transactions").select("txn_date, name, amount")
        .eq("client_id", req.clientId).order("txn_date", { ascending: true }),
    ]);

    if (bankData.error) throw bankData.error;
    if (booksData.error) throw booksData.error;

    res.json({
      bank_transactions: (bankData.data || []).map((b) => ({ date: b.txn_date, name: b.narration, amount: b.amount })),
      reconciliation_transactions: (booksData.data || []).map((r) => ({ date: r.txn_date, name: r.name, amount: r.amount })),
    });
  } catch (error) {
    console.error("Fetch Error:", error);
    res.status(500).json({ error: "Failed to fetch reconciliation data" });
  }
});

/**
 * @swagger
 * /api/reconciliation-variance:
 *   get:
 *     tags: [Reconciliation]
 *     summary: Calculate variance between bank and books
 */
router.get("/reconciliation-variance", extractClientId, async (req, res) => {
  try {
    if (!req.clientId) return res.status(400).json({ error: "Missing Client ID" });

    const [bankSumRes, bookSumRes] = await Promise.all([
      supabase.from("bank_transactions").select("amount").eq("client_id", req.clientId),
      supabase.from("reconciliation_transactions").select("amount").eq("client_id", req.clientId),
    ]);

    if (bankSumRes.error) throw bankSumRes.error;
    if (bookSumRes.error) throw bookSumRes.error;

    const bankTotal = (bankSumRes.data || []).reduce((sum, row) => sum + (parseFloat(row.amount) || 0), 0);
    const booksTotal = (bookSumRes.data || []).reduce((sum, row) => sum + (parseFloat(row.amount) || 0), 0);
    const variance_amount = bankTotal - booksTotal;
    const variance_percentage = booksTotal !== 0 ? (variance_amount / booksTotal) * 100 : 0;

    res.json({
      bank_total: bankTotal, books_total: booksTotal,
      variance_amount, variance_percentage: parseFloat(variance_percentage.toFixed(2)),
    });
  } catch (error) {
    console.error("Variance Error:", error);
    res.status(500).json({ error: "Failed to calculate variance" });
  }
});

/**
 * @swagger
 * /api/extract-bank-pdf-records:
 *   get:
 *     tags: [Reconciliation]
 *     summary: Extract bank-wise summary records from PDF bank statements using Gemini AI
 */
router.get("/extract-bank-pdf-records", extractClientId, async (req, res) => {
  try {
    if (!req.clientId) {
      return res.status(400).json({ success: false, error: "Missing clientId." });
    }

    // Resolve source config — isolates cache and folder per active connection source.
    const sourceKey = req.query.source || "manual_upload_excel_pdf";
    const { cacheSource, folderRootName } = SOURCE_CONFIG[sourceKey] || DEFAULT_SOURCE_CONFIG;
    console.log(`[BankPDF] source="${sourceKey}" → cacheSource="${cacheSource}", folder="${folderRootName}"`);

    // ── Check for cached sync result for THIS source only ───────────────────
    const { data: cached } = await supabase
      .from("qb_synced_reports")
      .select("data, updated_at")
      .eq("company_id", req.clientId)
      .eq("source", cacheSource)
      .eq("report_type", BANK_RECONCILIATION_TYPE)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (cached?.data?.bank_reconciliation) {
      const bd = cached.data.bank_reconciliation;
      // Only serve cache when it actually has data — empty cache means a prior extraction failed.
      if (bd.banks?.length > 0) {
        console.log(`[BankPDF] Returning cached sync result for company ${req.clientId} (source=${cacheSource})`);
        return res.json({
          success: true,
          source: "cache",
          bank_count: bd.banks.length,
          banks: bd.banks,
          months: bd.months || [],
          totals: bd.totals || [],
          syncedAt: bd.syncedAt || cached.updated_at,
          documentCount: bd.documentCount || bd.banks.length,
        });
      }
      console.log(`[BankPDF] Cache exists but banks[] is empty for company ${req.clientId} (source=${cacheSource}) — falling through to live extraction`);
    }

    // ── No cache — live Gemini extraction from the correct source folder ─────
    console.log(`[BankPDF] No cached result for company ${req.clientId} (source=${cacheSource}), running live extraction from "${folderRootName}"`);
    const documents = await getBankReconciliationDocuments(req.clientId, folderRootName);

    if (!documents.length) {
      return res.json({
        success: true,
        banks: [],
        months: [],
        totals: [],
        source: "empty",
        message: `No bank statement files found in "${folderRootName}". Upload PDF or Excel files to ${folderRootName} → Bank Statement in the Data Room.`,
      });
    }

    const allStatements = [];
    const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

    for (const doc of documents) {
      const fileName = String(doc.name || "bank_statement");
      const ext = fileName.toLowerCase().split(".").pop();
      const isPdf = ext === "pdf";
      const isExcel = ["xlsx", "xls", "csv"].includes(ext);

      if (!isPdf && !isExcel) {
        console.log(`[BankPDF] Skipping unsupported file: "${fileName}"`);
        continue;
      }

      let buffer = null;

      // 1. Direct upload_id
      if (doc.upload_id) {
        const { data: upload, error: uploadError } = await supabase
          .from("uploads").select("data").eq("id", doc.upload_id).maybeSingle();
        if (uploadError) console.warn(`[BankPDF] DB error loading "${fileName}": ${uploadError.message}`);
        else if (upload?.data) buffer = normalizeBankBinary(upload.data);
      }

      // 2. Specific /uploads/UUID/content URL pattern
      if (!buffer && doc.file_url) {
        const specificMatch = String(doc.file_url).match(/\/uploads\/([0-9a-f-]{36})\/content/i);
        if (specificMatch) {
          const { data: upload2 } = await supabase
            .from("uploads").select("data").eq("id", specificMatch[1]).maybeSingle();
          if (upload2?.data) {
            buffer = normalizeBankBinary(upload2.data);
            console.log(`[BankPDF] Loaded "${fileName}" via inferred upload id`);
          }
        }
      }

      // 3. Any UUID found anywhere in file_url (handles non-standard storage paths)
      if (!buffer && doc.file_url) {
        const uuidMatch = String(doc.file_url).match(UUID_RE);
        if (uuidMatch) {
          const { data: upload3 } = await supabase
            .from("uploads").select("data").eq("id", uuidMatch[0]).maybeSingle();
          if (upload3?.data) {
            buffer = normalizeBankBinary(upload3.data);
            console.log(`[BankPDF] Loaded "${fileName}" via URL UUID fallback`);
          }
        }
      }

      if (!buffer?.length) {
        console.warn(`[BankPDF] No binary data for "${fileName}", skipping`);
        continue;
      }

      try {
        let statements;
        if (isExcel) {
          statements = await extractBankStatementsFromExcelBuffer(buffer, fileName);
        } else {
          statements = await extractBankStatementsFromPdfBase64(buffer.toString("base64"), fileName);
        }
        allStatements.push(...statements);
      } catch (err) {
        console.error(`[BankPDF] Extraction failed for "${fileName}": ${err.message}`);
      }
    }

    if (!allStatements.length) {
      return res.status(422).json({
        success: false,
        error: "Gemini could not extract any bank statement data from the uploaded files.",
      });
    }

    const { banks, months, totals } = buildBankResponseShape(allStatements);

    return res.json({ success: true, source: "live", bank_count: banks.length, banks, months, totals });
  } catch (error) {
    console.error("[BankPDF] Extraction error:", error);
    return res.status(500).json({ success: false, error: error.message || "Failed to extract bank PDF records." });
  }
});

module.exports = router;
