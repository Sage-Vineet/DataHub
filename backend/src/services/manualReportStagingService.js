const XLSX = require("xlsx");
const { supabase } = require("../db");
const { upsertManualGlUpload } = require("./manualGlService");
const { processBalanceSheet } = require("./balanceSheetService");

const REPORT_TYPES = {
  GENERAL_LEDGER: "GENERAL_LEDGER",
  BALANCE_SHEET: "BALANCE_SHEET",
};

const MANUAL_REPORT_STAGE_TYPE = "manual_report_stage";
const MANUAL_REPORT_STAGE_SOURCE = "manual_gl";

const GL_KEYWORDS = [
  "general ledger",
  "ledger",
  "debit",
  "credit",
  "transaction",
  "journal",
  "posting date",
  "account",
];

const BALANCE_SHEET_KEYWORDS = [
  "balance sheet",
  "assets",
  "liabilities",
  "equity",
  "retained earnings",
  "shareholder",
  "stockholder",
  "total assets",
  "revenue",
];

function normalizeUploadBinary(data) {
  if (!data) return Buffer.alloc(0);
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.from(data);
  if (typeof data === "object" && data.type === "Buffer" && Array.isArray(data.data)) {
    return Buffer.from(data.data);
  }

  const decodeSerializedBufferJson = (buffer) => {
    if (!buffer || buffer.length < 2) return null;
    const text = buffer.toString("utf8").trim();
    if (!text.startsWith("{") || !text.includes('"type":"Buffer"')) return null;
    try {
      const parsed = JSON.parse(text);
      if (parsed?.type === "Buffer" && Array.isArray(parsed.data)) {
        return Buffer.from(parsed.data);
      }
    } catch {
      return null;
    }
    return null;
  };

  if (typeof data === "string") {
    const value = data.trim();
    if (/^\\x[0-9a-f]+$/i.test(value)) {
      const decoded = Buffer.from(value.slice(2), "hex");
      return decodeSerializedBufferJson(decoded) || decoded;
    }
    if (/^0x[0-9a-f]+$/i.test(value)) {
      const decoded = Buffer.from(value.slice(2), "hex");
      return decodeSerializedBufferJson(decoded) || decoded;
    }
    const base64Decoded = Buffer.from(value, "base64");
    return decodeSerializedBufferJson(base64Decoded) || base64Decoded;
  }

  return Buffer.from(String(data));
}

function normalizeKey(value) {
  return String(value || "").trim().toLowerCase();
}

function hasCellValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function findHeaderRow(rawRows = []) {
  let bestIndex = 0;
  let bestScore = Number.NEGATIVE_INFINITY;

  const limit = Math.min(rawRows.length, 30);
  for (let index = 0; index < limit; index += 1) {
    const row = Array.isArray(rawRows[index]) ? rawRows[index] : [];
    if (!row.length) continue;

    const textCells = row
      .map((cell) => String(cell || "").trim())
      .filter((cell) => cell && /[a-z]/i.test(cell));

    const uniqueCount = new Set(textCells.map((cell) => normalizeKey(cell))).size;
    const score = textCells.length * 0.7 + uniqueCount * 0.6;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }

  return bestIndex;
}

function parseUploadRows(upload) {
  const buffer = normalizeUploadBinary(upload.data);
  const fileName = String(upload.file_name || "").toLowerCase();
  const contentType = String(upload.content_type || "").toLowerCase();

  let workbook;
  try {
    if (fileName.endsWith(".csv") || contentType.includes("csv")) {
      workbook = XLSX.read(buffer.toString("utf8"), { type: "string" });
    } else {
      workbook = XLSX.read(buffer, { type: "buffer" });
    }
  } catch (error) {
    throw new Error(
      `Unable to parse file "${upload.file_name || upload.id}". Upload a valid CSV/XLSX/XLS. ${error.message}`
    );
  }

  const sheetName = workbook.SheetNames[0];
  const sheet = sheetName ? workbook.Sheets[sheetName] : null;
  if (!sheet) {
    throw new Error("No worksheet found in upload.");
  }

  const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, blankrows: false });
  const nonEmptyRows = rawRows.filter((row) => Array.isArray(row) && row.some(hasCellValue));
  if (!nonEmptyRows.length) {
    throw new Error("The uploaded file is empty. Please upload a file with data.");
  }

  const headerRowIndex = findHeaderRow(nonEmptyRows);
  const headerRow = Array.isArray(nonEmptyRows[headerRowIndex]) ? nonEmptyRows[headerRowIndex] : [];
  const headers = headerRow.map((value, index) => String(value || `Column ${index + 1}`).trim());

  return {
    sheetName,
    headers,
    rawRows: nonEmptyRows,
    headerRowIndex,
  };
}

function detectReportType(fileData = {}) {
  const rawRows = Array.isArray(fileData.rawRows) ? fileData.rawRows : [];
  if (!rawRows.length) {
    throw new Error("Unable to detect report type: file has no readable rows.");
  }

  const headerText = (Array.isArray(fileData.headers) ? fileData.headers : [])
    .map((header) => normalizeKey(header))
    .join(" ");

  const bodyText = rawRows
    .slice(0, 80)
    .map((row) => (Array.isArray(row) ? row : []).map((cell) => normalizeKey(cell)).join(" "))
    .join(" ");
  const text = `${headerText} ${bodyText}`;

  const glHits = GL_KEYWORDS.filter((keyword) => text.includes(keyword)).length;
  const bsHits = BALANCE_SHEET_KEYWORDS.filter((keyword) => text.includes(keyword)).length;

  const hasAssets = text.includes("assets");
  const hasLiabilities = text.includes("liabilit");
  const hasEquity = text.includes("equity") || text.includes("shareholder") || text.includes("stockholder");
  const hasDate = text.includes("date");
  const hasDebit = text.includes("debit") || text.includes("dr");
  const hasCredit = text.includes("credit") || text.includes("cr");

  let reportType = REPORT_TYPES.GENERAL_LEDGER;
  if (text.includes("balance sheet") || (hasAssets && hasLiabilities && hasEquity)) {
    reportType = REPORT_TYPES.BALANCE_SHEET;
  } else if (hasDate && hasDebit && hasCredit) {
    reportType = REPORT_TYPES.GENERAL_LEDGER;
  } else if (bsHits > glHits) {
    reportType = REPORT_TYPES.BALANCE_SHEET;
  }

  return {
    reportType,
    scores: {
      generalLedger: glHits,
      balanceSheet: bsHits,
    },
    signals: {
      hasAssets,
      hasLiabilities,
      hasEquity,
      hasDate,
      hasDebit,
      hasCredit,
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

async function upsertStagedManualReport({
  companyId,
  stagedDataId,
  uploadId,
  fileName,
  fileUrl,
  reportType,
  headers = [],
  detection = {},
  structuredData = null,
  status = "staged",
}) {
  const now = new Date().toISOString();
  const stageData = {
    stagedDataId,
    uploadId,
    fileName: fileName || null,
    fileUrl: fileUrl || null,
    reportType,
    status,
    headers,
    structuredData,
    detection,
    stagedAt: now,
  };

  const payload = {
    manual_stage: stageData,
  };

  const { data, error } = await supabase
    .from("qb_synced_reports")
    .upsert(
      {
        company_id: companyId,
        report_type: MANUAL_REPORT_STAGE_TYPE,
        report_params: { stagedDataId },
        data: payload,
        source: MANUAL_REPORT_STAGE_SOURCE,
        status,
        last_synced_at: now,
        updated_at: now,
      },
      { onConflict: "company_id,report_type,report_params" }
    )
    .select("id, report_type, report_params, data, source, status, updated_at")
    .single();

  if (error) {
    throw new Error(`Failed to stage upload: ${error.message}`);
  }

  return data;
}

async function stageManualReportUpload({
  companyId,
  uploadId,
  fileName,
  fileUrl,
  uploadedBy = null,
}) {
  if (!companyId) throw new Error("companyId is required");
  if (!uploadId) throw new Error("uploadId is required");

  const upload = await loadUpload(uploadId);
  const parsedFile = parseUploadRows(upload);
  const detection = detectReportType(parsedFile);

  console.info("[ManualReport] Detected report type", {
    companyId,
    uploadId,
    reportType: detection.reportType,
    detection,
  });

  let structuredData = null;
  if (detection.reportType === REPORT_TYPES.BALANCE_SHEET) {
    structuredData = processBalanceSheet(parsedFile);
  } else {
    await upsertManualGlUpload({
      companyId,
      uploadId,
      fileName: fileName || upload.file_name,
      fileUrl,
      uploadedBy,
      status: "uploaded",
      mapping: null,
    });
  }

  const staged = await upsertStagedManualReport({
    companyId,
    stagedDataId: uploadId,
    uploadId,
    fileName: fileName || upload.file_name,
    fileUrl,
    reportType: detection.reportType,
    headers: parsedFile.headers,
    detection,
    structuredData,
    status: "staged",
  });

  console.info("[ManualReport] Staged upload", {
    companyId,
    stagedDataId: uploadId,
    reportType: detection.reportType,
  });

  return {
    stagedDataId: uploadId,
    uploadId,
    reportType: detection.reportType,
    detection,
    stagedData: staged?.data?.manual_stage || null,
  };
}

async function getStagedManualReport({ companyId, stagedDataId }) {
  const { data, error } = await supabase
    .from("qb_synced_reports")
    .select("id, report_params, data, source, status, updated_at")
    .eq("company_id", companyId)
    .eq("report_type", MANUAL_REPORT_STAGE_TYPE)
    .eq("source", MANUAL_REPORT_STAGE_SOURCE)
    .contains("report_params", { stagedDataId })
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Failed to fetch staged data: ${error.message}`);
  return data || null;
}

async function updateStagedManualReport({
  companyId,
  stagedDataId,
  status,
  patch = {},
}) {
  const staged = await getStagedManualReport({ companyId, stagedDataId });
  if (!staged) return null;

  const current = staged.data?.manual_stage || {};
  const now = new Date().toISOString();
  const nextStage = {
    ...current,
    ...patch,
    status: status || current.status || "staged",
    updatedAt: now,
  };

  const payload = {
    manual_stage: nextStage,
  };

  const { data, error } = await supabase
    .from("qb_synced_reports")
    .upsert(
      {
        company_id: companyId,
        report_type: MANUAL_REPORT_STAGE_TYPE,
        report_params: { stagedDataId },
        data: payload,
        source: MANUAL_REPORT_STAGE_SOURCE,
        status: nextStage.status,
        last_synced_at: now,
        updated_at: now,
      },
      { onConflict: "company_id,report_type,report_params" }
    )
    .select("id, report_params, data, status, updated_at")
    .single();

  if (error) {
    throw new Error(`Failed to update staged data: ${error.message}`);
  }

  return data;
}

module.exports = {
  REPORT_TYPES,
  MANUAL_REPORT_STAGE_TYPE,
  detectReportType,
  stageManualReportUpload,
  getStagedManualReport,
  updateStagedManualReport,
  loadUpload,
};
