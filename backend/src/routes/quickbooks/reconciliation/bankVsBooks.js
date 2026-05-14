const express = require("express");
const router = express.Router();
const { supabase } = require("../../../db");
const {
  normalizeBankBinary,
  extractBankStatementsFromPdfBase64,
  buildBankResponseShape,
} = require("../../../services/bankStatementExtractor");

const MANUAL_REPORT_UPLOAD_SOURCE = "manual_report_upload";
const BANK_RECONCILIATION_TYPE = "bank_reconciliation";

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
async function getBankReconciliationDocuments(companyId) {
  // Find "Manual Upload Source" root folder
  const { data: sourceFolder } = await supabase
    .from("folders")
    .select("id")
    .eq("company_id", companyId)
    .is("parent_id", null)
    .ilike("name", "Manual Upload Source")
    .maybeSingle();

  if (!sourceFolder) {
    console.log(`[BankPDF] "Manual Upload Source" folder not found for company ${companyId}`);
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

    // ── Check for cached sync result first ──────────────────────────────────
    const { data: cached } = await supabase
      .from("qb_synced_reports")
      .select("data, updated_at")
      .eq("company_id", req.clientId)
      .eq("source", MANUAL_REPORT_UPLOAD_SOURCE)
      .eq("report_type", BANK_RECONCILIATION_TYPE)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (cached?.data?.bank_reconciliation) {
      const bd = cached.data.bank_reconciliation;
      console.log(`[BankPDF] Returning cached sync result for company ${req.clientId} (synced: ${bd.syncedAt || cached.updated_at})`);
      return res.json({
        success: true,
        source: "cache",
        bank_count: bd.banks?.length || 0,
        banks: bd.banks || [],
        months: bd.months || [],
        totals: bd.totals || [],
      });
    }

    // ── No cache — live Gemini extraction ────────────────────────────────────
    console.log(`[BankPDF] No cached result for company ${req.clientId}, running live Gemini extraction`);
    const documents = await getBankReconciliationDocuments(req.clientId);

    if (!documents.length) {
      return res.status(404).json({
        success: false,
        error: "No files found in the Bank Reconciliation folder. Upload PDF bank statements to Manual Upload Source → Bank Reconciliation in the Data Room.",
      });
    }

    const allStatements = [];

    for (const doc of documents) {
      const fileName = String(doc.name || "bank_statement.pdf");
      if (!fileName.toLowerCase().endsWith(".pdf")) {
        console.log(`[BankPDF] Skipping non-PDF file: "${fileName}"`);
        continue;
      }

      let buffer = null;

      // Path 1: load binary from uploads table via upload_id
      if (doc.upload_id) {
        const { data: upload, error: uploadError } = await supabase
          .from("uploads")
          .select("data")
          .eq("id", doc.upload_id)
          .maybeSingle();

        if (uploadError) {
          console.warn(`[BankPDF] DB error loading "${fileName}": ${uploadError.message}`);
        } else if (upload?.data) {
          buffer = normalizeBankBinary(upload.data);
        }
      }

      // Path 2: extract UUID from file_url
      if (!buffer && doc.file_url) {
        try {
          const urlMatch = String(doc.file_url).match(/\/uploads\/([0-9a-f-]{36})\/content/i);
          if (urlMatch) {
            const { data: upload2 } = await supabase
              .from("uploads")
              .select("data")
              .eq("id", urlMatch[1])
              .maybeSingle();
            if (upload2?.data) {
              buffer = normalizeBankBinary(upload2.data);
              console.log(`[BankPDF] Loaded "${fileName}" via inferred upload id from file_url`);
            }
          }
        } catch (urlErr) {
          console.warn(`[BankPDF] file_url fallback failed for "${fileName}": ${urlErr.message}`);
        }
      }

      if (!buffer || !buffer.length) {
        console.warn(`[BankPDF] No binary data for "${fileName}", skipping`);
        continue;
      }

      try {
        const pdfBase64 = buffer.toString("base64");
        const statements = await extractBankStatementsFromPdfBase64(pdfBase64, fileName);
        allStatements.push(...statements);
      } catch (geminiErr) {
        console.error(`[BankPDF] Gemini failed for "${fileName}": ${geminiErr.message}`);
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
