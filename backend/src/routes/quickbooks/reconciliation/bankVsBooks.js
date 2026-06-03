const express = require("express");
const router = express.Router();
const { supabase } = require("../../../db");
const {
  normalizeBankBinary,
  extractBankStatementsFromPdfBase64,
  extractBankStatementsFromExcelBuffer,
  buildBankResponseShape,
} = require("../../../services/bankStatementExtractor");
const {
  extractBsBankBalancesWithGemini,
  extractBsBankBalancesFromExcelText,
} = require("../../../services/geminiFinancialParser");
const XLSX = require("xlsx");

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
const BS_BANK_BALANCES_CACHE_TYPE = "bs_bank_balances_cache_v2";
const BS_BANK_SECTION_RE = /bank|checking|savings|cash/i;
const UUID_RE_BS = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// ── Helpers ───────────────────────────────────────────────────────────────────

function bsLastFour(name) {
  const m = String(name || "").match(/\b(\d{4})\b/);
  return m ? m[1] : "";
}

// Recursively collect leaf bank account nodes from a hierarchical BS row tree
function extractLeafBankAccounts(rows, insideBankSection = false) {
  const result = [];
  for (const row of (rows || [])) {
    const isBankSection = insideBankSection || BS_BANK_SECTION_RE.test(row.name || "");
    if (row.type === "data" && isBankSection) {
      result.push({
        name: row.name,
        accountNumber: bsLastFour(row.name),
        amount: parseFloat(row.amount) || 0,
      });
    }
    if (Array.isArray(row.children) && row.children.length > 0) {
      result.push(...extractLeafBankAccounts(row.children, isBankSection));
    }
  }
  return result;
}

// Extract year from a qb_synced_reports BS record (asOfDate → filename → null)
function extractBsYearFromRecord(record) {
  const asOf = record?.data?.manual_report_upload?.report?.asOfDate;
  if (asOf) {
    const y = parseInt(String(asOf).slice(0, 4), 10);
    if (y > 2000) return y;
  }
  const fn = String(record?.report_params?.fileName || record?.data?.manual_report_upload?.fileName || "");
  const m = fn.match(/\b(20\d{2})\b/);
  if (m) return parseInt(m[1], 10);
  return null;
}

// ── Document location ─────────────────────────────────────────────────────────
// Resolves the latest Balance Sheet document for the active source.
// Tries: [Root] → Reports → Balance Sheet
//   then: [Root] → Balance Sheet  (no intermediate "Reports" group)
// Returns the single most-recently-uploaded document, or null.
async function getLatestBsDocument(companyId, folderRootName) {
  const { data: rootFolder } = await supabase
    .from("folders").select("id")
    .eq("company_id", companyId).is("parent_id", null)
    .ilike("name", folderRootName).maybeSingle();

  if (!rootFolder) {
    console.log(`[BsBankBalances] Source root "${folderRootName}" not found for company ${companyId}`);
    return null;
  }

  let bsFolderId = null;

  // Primary path: Root → Reports → Balance Sheet
  const { data: reportsFolder } = await supabase
    .from("folders").select("id")
    .eq("company_id", companyId).eq("parent_id", rootFolder.id)
    .ilike("name", "Reports").maybeSingle();

  if (reportsFolder) {
    const { data: bsUnderReports } = await supabase
      .from("folders").select("id")
      .eq("company_id", companyId).eq("parent_id", reportsFolder.id)
      .ilike("name", "Balance Sheet").maybeSingle();
    if (bsUnderReports) bsFolderId = bsUnderReports.id;
  }

  // Fallback path: Root → Balance Sheet (direct)
  if (!bsFolderId) {
    const { data: bsDirect } = await supabase
      .from("folders").select("id")
      .eq("company_id", companyId).eq("parent_id", rootFolder.id)
      .ilike("name", "Balance Sheet").maybeSingle();
    if (bsDirect) bsFolderId = bsDirect.id;
  }

  if (!bsFolderId) {
    console.log(`[BsBankBalances] Balance Sheet folder not found under "${folderRootName}" for company ${companyId}`);
    return null;
  }

  const { data: docs } = await supabase
    .from("documents").select("id, name, upload_id, file_url, uploaded_at")
    .eq("folder_id", bsFolderId)
    .order("uploaded_at", { ascending: false })
    .limit(5); // take up to 5 so we can pick the best year

  if (!docs?.length) {
    console.log(`[BsBankBalances] No documents in Balance Sheet folder for company ${companyId}`);
    return null;
  }

  console.log(`[BsBankBalances] Found ${docs.length} BS document(s) in "${folderRootName}" for company ${companyId}: ${docs.map((d) => d.name).join(", ")}`);
  return docs; // return all so caller can pick the best year
}

// Load raw buffer from uploads table, trying multiple resolution paths
async function loadBufferForDoc(doc) {
  if (doc.upload_id) {
    const { data: up } = await supabase.from("uploads").select("data").eq("id", doc.upload_id).maybeSingle();
    if (up?.data) return normalizeBankBinary(up.data);
  }
  if (doc.file_url) {
    const url = String(doc.file_url);
    const specific = url.match(/\/uploads\/([0-9a-f-]{36})\/content/i);
    if (specific) {
      const { data: up2 } = await supabase.from("uploads").select("data").eq("id", specific[1]).maybeSingle();
      if (up2?.data) return normalizeBankBinary(up2.data);
    }
    const uuid = url.match(UUID_RE_BS);
    if (uuid) {
      const { data: up3 } = await supabase.from("uploads").select("data").eq("id", uuid[0]).maybeSingle();
      if (up3?.data) return normalizeBankBinary(up3.data);
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main BS bank-balance extraction pipeline
//
// Per-request flow:
//   1. Locate the latest Balance Sheet document(s) from the active source folder
//   2. Cache hit? — only valid if the documentId matches the current latest file
//   3. Load binary → Gemini PDF vision (PDF) or XLSX→CSV→Gemini text (Excel/CSV)
//   4. Fallback: tree-walk the pre-parsed rows already stored in qb_synced_reports
//   5. Cache result keyed by documentId; delete stale cache first
// ─────────────────────────────────────────────────────────────────────────────
async function runBsBankBalancesExtraction(clientId, cacheSource, folderRootName, fiscalYear = null) {
  // 1. Always locate the latest Balance Sheet document first
  const bsDocs = await getLatestBsDocument(clientId, folderRootName);
  if (!bsDocs?.length) {
    return {
      statusCode: 200,
      body: {
        success: true, source: "empty", year: null, bankAccounts: [],
        message: `No Balance Sheet files found in "${folderRootName}" → Reports → Balance Sheet.`,
      },
    };
  }

  // When a fiscal year is requested (Manual GL), prefer the Balance Sheet file
  // whose name carries that year so the "per Balance Sheet" column reflects the
  // selected version's year — not merely the most-recent upload. V8's sort is
  // stable, so files without the year keep their recency order behind it.
  if (fiscalYear) {
    const yr = String(fiscalYear);
    bsDocs.sort(
      (a, b) =>
        (String(a.name || "").includes(yr) ? 0 : 1) -
        (String(b.name || "").includes(yr) ? 0 : 1),
    );
  }

  // Use the most recently uploaded document as the canonical file
  const latestDoc = bsDocs[0];

  // 2. Cache check — only valid if built from the SAME document, and (when a
  //    fiscal year is requested) for that same year, so a cached other-year
  //    balance sheet is never served for the selected version's year.
  const { data: cached } = await supabase
    .from("qb_synced_reports")
    .select("data, updated_at")
    .eq("company_id", clientId)
    .eq("source", cacheSource)
    .eq("report_type", BS_BANK_BALANCES_CACHE_TYPE)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (
    cached?.data?.bankAccounts?.length > 0 &&
    cached.data.documentId === latestDoc.id &&
    (!fiscalYear || String(cached.data.year) === String(fiscalYear))
  ) {
    console.log(`[BsBankBalances] Cache hit — file="${latestDoc.name}" for ${clientId}`);
    return { statusCode: 200, body: { success: true, source: "cache", ...cached.data } };
  }

  // 3. Extract from the latest document via Gemini
  let bankAccounts = [];
  let year = null;
  let matchedFile = null;

  for (const doc of bsDocs) {
    const fileName = String(doc.name || "balance_sheet");
    const ext = fileName.toLowerCase().split(".").pop();
    const isPdf = ext === "pdf";
    const isExcel = ["xlsx", "xls", "csv"].includes(ext);
    if (!isPdf && !isExcel) continue;

    const buffer = await loadBufferForDoc(doc);
    if (!buffer?.length) {
      console.warn(`[BsBankBalances] No binary data for "${fileName}", skipping`);
      continue;
    }

    try {
      let result;
      if (isPdf) {
        result = await extractBsBankBalancesWithGemini(buffer, fileName);
      } else {
        // Excel/CSV: convert first sheet to CSV text, then send to Gemini as text
        const workbook = XLSX.read(buffer, { type: "buffer" });
        const csvText = XLSX.utils.sheet_to_csv(workbook.Sheets[workbook.SheetNames[0]]);
        result = await extractBsBankBalancesFromExcelText(csvText);
        console.log(`[BsBankBalances] Gemini Excel extraction for "${fileName}"`);
      }

      if (result?.bankAccounts?.length) {
        bankAccounts = result.bankAccounts;
        year = result.year;
        matchedFile = fileName;
        console.log(`[BsBankBalances] Extracted ${bankAccounts.length} account(s) year=${year} from "${fileName}"`);
        break;
      }
      console.log(`[BsBankBalances] Gemini returned 0 accounts for "${fileName}"`);
    } catch (err) {
      console.error(`[BsBankBalances] Gemini extraction failed for "${fileName}": ${err.message}`);
    }
  }

  // 4. Fallback: tree-walk the pre-parsed BS rows already stored by Sync All
  if (!bankAccounts.length) {
    console.log(`[BsBankBalances] Gemini extraction empty; falling back to tree-walk on synced BS records`);
    const { data: bsRecords } = await supabase
      .from("qb_synced_reports")
      .select("data, report_params, updated_at")
      .eq("company_id", clientId)
      .eq("source", cacheSource)
      .eq("report_type", "balance_sheet")
      .order("updated_at", { ascending: false });

    for (const record of (bsRecords || [])) {
      const rows = record?.data?.manual_report_upload?.report?.rows;
      if (!rows?.length) continue;
      const extracted = extractLeafBankAccounts(rows);
      if (extracted.length) {
        bankAccounts = extracted;
        year = extractBsYearFromRecord(record);
        matchedFile = record?.report_params?.fileName || "synced_record";
        console.log(`[BsBankBalances] Tree-walk found ${extracted.length} account(s) year=${year} from "${matchedFile}"`);
        break;
      }
    }
  }

  if (!bankAccounts.length) {
    console.log(`[BsBankBalances] No bank accounts found for ${clientId} — check that the Balance Sheet has been uploaded and synced`);
    return {
      statusCode: 200,
      body: {
        success: true, source: "empty", year: null, bankAccounts: [],
        message: "No bank accounts found in Balance Sheet. Upload a Balance Sheet PDF or Excel file and sync.",
      },
    };
  }

  // 5. Cache result — delete stale entry first, then insert fresh (document-keyed)
  const now = new Date().toISOString();
  const cachePayload = { year, bankAccounts, documentId: latestDoc.id, fileName: matchedFile, syncedAt: now };
  try {
    await supabase.from("qb_synced_reports")
      .delete()
      .eq("company_id", clientId)
      .eq("source", cacheSource)
      .eq("report_type", BS_BANK_BALANCES_CACHE_TYPE);
    await supabase.from("qb_synced_reports").insert({
      company_id: clientId,
      report_type: BS_BANK_BALANCES_CACHE_TYPE,
      source: cacheSource,
      data: cachePayload,
      status: "synced",
      last_synced_at: now,
      updated_at: now,
    });
  } catch (cacheErr) {
    console.warn(`[BsBankBalances] Cache write failed (non-fatal): ${cacheErr.message}`);
  }

  // Debug log — mirrors the shape the user requested
  console.log(`[BsBankBalances] Result: ${JSON.stringify({
    clientId,
    detectedYear: year,
    balanceSheetSource: cacheSource,
    matchedBalanceSheetFile: matchedFile,
    bankAccounts: bankAccounts.map((a) => ({ name: a.name, accountNumber: a.accountNumber, amount: a.amount })),
  })}`);

  return { statusCode: 200, body: { success: true, source: "live", ...cachePayload } };
}

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

// ─────────────────────────────────────────────────────────────────────────────
// Shared extraction helper — cache-check + live Gemini/Excel extraction.
// Accepts an explicit (cacheSource, folderRootName) pair so each source can
// target its own isolated cache partition and DataRoom folder.
// Returns { statusCode, body } — the caller forwards these directly to res.
// ─────────────────────────────────────────────────────────────────────────────
async function runBankExtraction(clientId, cacheSource, folderRootName) {
  // 1. Check source-specific cache
  const { data: cached } = await supabase
    .from("qb_synced_reports")
    .select("data, updated_at")
    .eq("company_id", clientId)
    .eq("source", cacheSource)
    .eq("report_type", BANK_RECONCILIATION_TYPE)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (cached?.data?.bank_reconciliation) {
    const bd = cached.data.bank_reconciliation;
    if (bd.banks?.length > 0) {
      console.log(`[BankPDF] Cache hit for ${clientId} (source=${cacheSource})`);
      return {
        statusCode: 200,
        body: {
          success: true,
          source: "cache",
          bank_count: bd.banks.length,
          banks: bd.banks,
          months: bd.months || [],
          totals: bd.totals || [],
          syncedAt: bd.syncedAt || cached.updated_at,
          documentCount: bd.documentCount || bd.banks.length,
        },
      };
    }
    console.log(`[BankPDF] Cache empty for ${clientId} (source=${cacheSource}) — falling through to live extraction`);
  }

  // 2. No usable cache — live extraction from the correct source folder
  console.log(`[BankPDF] Live extraction for ${clientId} from "${folderRootName}"`);
  const documents = await getBankReconciliationDocuments(clientId, folderRootName);

  if (!documents.length) {
    return {
      statusCode: 200,
      body: {
        success: true,
        banks: [],
        months: [],
        totals: [],
        source: "empty",
        message: `No bank statement files found in "${folderRootName}". Upload PDF or Excel files to ${folderRootName} → Bank Statement in the Data Room.`,
      },
    };
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

    if (doc.upload_id) {
      const { data: upload, error: uploadError } = await supabase
        .from("uploads").select("data").eq("id", doc.upload_id).maybeSingle();
      if (uploadError) console.warn(`[BankPDF] DB error loading "${fileName}": ${uploadError.message}`);
      else if (upload?.data) buffer = normalizeBankBinary(upload.data);
    }
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
      const statements = isExcel
        ? await extractBankStatementsFromExcelBuffer(buffer, fileName)
        : await extractBankStatementsFromPdfBase64(buffer.toString("base64"), fileName);
      allStatements.push(...statements);
    } catch (err) {
      console.error(`[BankPDF] Extraction failed for "${fileName}": ${err.message}`);
    }
  }

  if (!allStatements.length) {
    return {
      statusCode: 422,
      body: { success: false, error: "Gemini could not extract any bank statement data from the uploaded files." },
    };
  }

  const { banks, months, totals } = buildBankResponseShape(allStatements);
  return { statusCode: 200, body: { success: true, source: "live", bank_count: banks.length, banks, months, totals } };
}

// ─────────────────────────────────────────────────────────────────────────────
// Scope a bank-reconciliation response to a single fiscal (calendar) year.
//
// Used when the caller (Manual GL reconciliation) selects a dataset version +
// fiscal year so the table reflects only that year's bank activity and never
// mixes months from another staged version's year. Filtering is keyed on the
// canonical ISO `monthKey` ("YYYY-MM"); per-account and per-month totals are
// recomputed from the surviving months so the response stays self-consistent.
// ─────────────────────────────────────────────────────────────────────────────
function filterBankReconByYear(body, fiscalYear) {
  if (!fiscalYear || !body || !Array.isArray(body.banks)) return body;
  const yr = String(fiscalYear);
  const inYear = (monthKey) => String(monthKey || "").slice(0, 4) === yr;

  const banks = body.banks.map((bank) => ({
    ...bank,
    accounts: (bank.accounts || []).map((acct) => {
      const months = (acct.months || []).filter((m) => inYear(m.monthKey));
      const totals = months.reduce(
        (acc, m) => ({
          startingBalance: acc.startingBalance + (m.startingBalance || 0),
          deposits: acc.deposits + (m.deposits || 0),
          withdrawals: acc.withdrawals + (m.withdrawals || 0),
          endingBalance: acc.endingBalance + (m.endingBalance || 0),
        }),
        { startingBalance: 0, deposits: 0, withdrawals: 0, endingBalance: 0 },
      );
      return { ...acct, months, totals };
    }),
  }));

  const totals = (body.totals || []).filter((t) => inYear(t.monthKey));
  // `totals` carries both monthKey and the display label, so derive the display
  // months from it; fall back to parsing the year out of the display strings.
  const months = (body.totals || []).length
    ? totals.map((t) => t.month)
    : (body.months || []).filter((disp) => {
        const m = String(disp).match(/(20\d{2})/);
        return m ? m[1] === yr : true;
      });

  return { ...body, banks, months, totals };
}

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
    const sourceKey = req.query.source || "manual_upload_excel_pdf";
    // Optional Manual GL scoping: restrict the response to the selected dataset
    // version's fiscal year so versions never mix. datasetVersion is logged for
    // traceability; fiscalYear is the actual data filter.
    const fiscalYear = String(req.query.fiscalYear || "").trim() || null;
    const datasetVersion = String(req.query.datasetVersion || "").trim() || null;
    const { cacheSource, folderRootName } = SOURCE_CONFIG[sourceKey] || DEFAULT_SOURCE_CONFIG;
    console.log(`[BankPDF] source="${sourceKey}" → cacheSource="${cacheSource}", folder="${folderRootName}", datasetVersion=${datasetVersion}, fiscalYear=${fiscalYear}`);
    const { statusCode, body } = await runBankExtraction(req.clientId, cacheSource, folderRootName);
    const scoped = fiscalYear ? filterBankReconByYear(body, fiscalYear) : body;
    return res.status(statusCode).json(scoped);
  } catch (error) {
    console.error("[BankPDF] Extraction error:", error);
    return res.status(500).json({ success: false, error: error.message || "Failed to extract bank PDF records." });
  }
});

/* ===========================
   GET /manual-report-uploads/manual-bank-data
   Returns bank reconciliation data from Manual Upload Source folder ONLY.
   Isolated to "manual_report_upload" cache + "Manual Upload Source" DataRoom folder.
   Never reads from Quickbooks Manual Source or shared QMS caches.
   Response shape: { success, banks, months, totals } — same as /qms-bank-data.
=========================== */
router.get("/manual-report-uploads/manual-bank-data", extractClientId, async (req, res) => {
  try {
    if (!req.clientId) {
      return res.status(400).json({ success: false, error: "Missing clientId." });
    }
    const { statusCode, body } = await runBankExtraction(
      req.clientId,
      MANUAL_REPORT_UPLOAD_SOURCE,   // "manual_report_upload" — never overlaps with QMS cache
      "Manual Upload Source",         // reads only from this DataRoom folder
    );
    return res.status(statusCode).json(body);
  } catch (error) {
    console.error("[ManualBankData] Error:", error);
    return res.status(500).json({ success: false, error: error.message || "Failed to fetch manual bank data." });
  }
});

/* ===========================
   GET /manual-report-uploads/bs-bank-balances
   Returns bank account balances extracted from the Balance Sheet for a given source.
   Source: ?source=manual_upload_excel_pdf (default) | quickbooks_manual
   Response: { success, year, bankAccounts: [{name, accountNumber, amount}], source }
=========================== */
router.get("/manual-report-uploads/bs-bank-balances", extractClientId, async (req, res) => {
  try {
    if (!req.clientId) return res.status(400).json({ success: false, error: "Missing clientId." });
    const sourceKey = req.query.source || "manual_upload_excel_pdf";
    const fiscalYear = String(req.query.fiscalYear || "").trim() || null;
    const datasetVersion = String(req.query.datasetVersion || "").trim() || null;
    const { cacheSource, folderRootName } = SOURCE_CONFIG[sourceKey] || DEFAULT_SOURCE_CONFIG;
    console.log(`[BsBankBalances] source="${sourceKey}" → cacheSource="${cacheSource}", folder="${folderRootName}", datasetVersion=${datasetVersion}, fiscalYear=${fiscalYear}`);
    const { statusCode, body } = await runBsBankBalancesExtraction(req.clientId, cacheSource, folderRootName, fiscalYear);
    return res.status(statusCode).json(body);
  } catch (err) {
    console.error("[BsBankBalances] Error:", err);
    return res.status(500).json({ success: false, error: err.message || "Failed to fetch balance sheet bank balances." });
  }
});

module.exports = router;
