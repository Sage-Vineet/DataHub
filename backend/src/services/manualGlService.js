const { supabase } = require("../db");
const XLSX = require("xlsx");

const MANUAL_GL_REPORT_TYPE = "manual_gl_upload";
const MANUAL_GL_GENERATED_REPORT_TYPE = "manual_gl_generated_report";
const MANUAL_GL_SOURCE = "manual_gl";
const QUICKBOOKS_REPORT_TYPES = {
  BALANCE_SHEET: "balance_sheet",
  PROFIT_AND_LOSS: "profit_and_loss",
  CASH_FLOW: "cash_flow",
  GENERAL_LEDGER: "general_ledger",
};
const MANUAL_GL_REQUIRED_MAPPING_FIELDS = ["date", "account_name", "debit", "credit"];
const MANUAL_GL_OPTIONAL_MAPPING_FIELDS = [
  "split_amount",
  "description",
  "transaction_type",
  "balance",
  "reference",
  "account_type",
  "account_number",
  "amount",
];
const AUTO_MAPPING_CONFIDENCE_THRESHOLD = 0.52;
const AUTO_MAPPING_HEADER_KEYWORDS = {
  date: ["date", "txn date", "transaction date", "posting date", "post date"],
  account_name: ["account", "ledger", "account name", "distribution account", "gl account"],
  debit: ["debit", "dr", "withdrawal", "money out"],
  credit: ["credit", "cr", "deposit", "money in"],
  split_amount: ["split amount", "amount", "transaction amount", "net amount", "signed amount"],
  description: ["description", "narration", "memo", "details", "remarks", "note"],
  transaction_type: ["transaction type", "type", "entry type", "journal type"],
  balance: ["balance", "running balance", "closing balance"],
  reference: ["reference", "ref", "document", "journal no", "transaction id", "voucher"],
  account_type: ["account type", "type"],
  account_number: ["account number", "acct number", "account #", "gl code"],
};
const AUTO_MAPPING_SCORE_THRESHOLD = {
  date: 0.48,
  account_name: 0.45,
  debit: 0.4,
  credit: 0.4,
  split_amount: 0.42,
  description: 0.28,
  transaction_type: 0.3,
  balance: 0.35,
  reference: 0.25,
  account_type: 0.3,
  account_number: 0.3,
};

async function upsertManualGlUpload({
  companyId,
  uploadId,
  fileName,
  fileUrl,
  uploadedBy = null,
  status = "uploaded",
  mapping = null,
}) {
  if (!companyId) throw new Error("companyId is required");
  if (!uploadId) throw new Error("uploadId is required");

  const now = new Date().toISOString();
  const reportParams = { uploadId };
  const normalizedMapping = mapping ? ensureMappingShape(mapping) : null;
  const payload = {
    manual_gl: {
      uploadId,
      fileName: fileName || null,
      fileUrl: fileUrl || null,
      status,
      mapping: normalizedMapping,
      uploadedBy,
      uploadedAt: now,
    },
  };

  const { data, error } = await supabase
    .from("qb_synced_reports")
    .upsert(
      {
        company_id: companyId,
        report_type: MANUAL_GL_REPORT_TYPE,
        report_params: reportParams,
        data: payload,
        source: MANUAL_GL_SOURCE,
        status,
        mapping: normalizedMapping,
        last_synced_at: now,
        updated_at: now,
      },
      { onConflict: "company_id,report_type,report_params" }
    )
    .select("id, company_id, report_type, report_params, source, status, mapping, data, last_synced_at, created_at, updated_at")
    .single();

  if (error) throw new Error(`Manual GL save failed: ${error.message}`);
  return data;
}

async function listManualGlUploads(companyId) {
  if (!companyId) throw new Error("companyId is required");

  const { data, error } = await supabase
    .from("qb_synced_reports")
    .select("id, report_type, report_params, source, status, mapping, data, last_synced_at, created_at, updated_at")
    .eq("company_id", companyId)
    .eq("report_type", MANUAL_GL_REPORT_TYPE)
    .eq("source", MANUAL_GL_SOURCE)
    .order("updated_at", { ascending: false });

  if (error) throw new Error(`Manual GL fetch failed: ${error.message}`);
  return data || [];
}

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
    } catch (_error) {
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

function detectHeaderRowIndex(rows) {
  if (!Array.isArray(rows) || !rows.length) return 0;

  let bestIndex = 0;
  let bestScore = Number.NEGATIVE_INFINITY;
  const maxRows = Math.min(rows.length, 60);
  const monthHint = /(january|february|march|april|may|june|july|august|september|october|november|december)/i;

  for (let index = 0; index < maxRows; index += 1) {
    const row = Array.isArray(rows[index]) ? rows[index] : [];
    const cells = row.map((value) => normalizeKey(value)).filter(Boolean);
    if (!cells.length) continue;

    const uniqueCount = new Set(cells).size;
    const hasDate = cells.some((value) => value.includes("date"));
    const hasAccount = cells.some((value) => value.includes("account") || value.includes("gl"));
    const hasAmounts = cells.some((value) =>
      value.includes("amount") || value.includes("balance") || value.includes("debit") || value.includes("credit")
    );

    let score = 0;
    if (hasDate) score += 4;
    if (hasAccount) score += 4;
    if (hasAmounts) score += 3;
    score += Math.min(uniqueCount, 10) * 0.2;
    if (cells.length === 1) score -= 2;
    if (cells.some((value) => monthHint.test(value))) score -= 2;

    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }

  return bestScore >= 4 ? bestIndex : 0;
}

function parseManualGlSheet(upload, emptyRowsMessage) {
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
  const headerRowIndex = detectHeaderRowIndex(rawRows);
  const headerRow = Array.isArray(rawRows[headerRowIndex]) ? rawRows[headerRowIndex] : [];
  const dataRows = rawRows.slice(headerRowIndex + 1);

  const sampledWidths = [headerRow.length];
  for (let index = 0; index < Math.min(dataRows.length, 200); index += 1) {
    sampledWidths.push(Array.isArray(dataRows[index]) ? dataRows[index].length : 0);
  }
  const width = Math.max(...sampledWidths, 0);

  const headers = [];
  const usedHeaders = new Set();
  for (let colIndex = 0; colIndex < width; colIndex += 1) {
    const base = String(headerRow[colIndex] || "").trim() || `Column ${colIndex + 1}`;
    let name = base;
    let suffix = 2;
    while (usedHeaders.has(name)) {
      name = `${base} (${suffix})`;
      suffix += 1;
    }
    usedHeaders.add(name);
    headers.push(name);
  }

  const rows = [];
  const rowNumbers = [];
  dataRows.forEach((row, rowOffset) => {
    const cells = Array.isArray(row) ? row : [];
    const mapped = {};
    let hasValue = false;

    headers.forEach((header, colIndex) => {
      const value = colIndex < cells.length ? cells[colIndex] : null;
      mapped[header] = value;
      if (value !== null && value !== undefined && String(value).trim() !== "") {
        hasValue = true;
      }
    });

    if (hasValue) {
      rows.push(mapped);
      rowNumbers.push(headerRowIndex + rowOffset + 2);
    }
  });

  if (!rows.length) {
    throw new Error(emptyRowsMessage);
  }

  return {
    rows,
    columns: headers,
    headerRowIndex,
    rowNumbers,
  };
}

function resolveColumn(columns, providedValues = [], candidates = []) {
  const normalizedColumns = columns.map((column) => ({
    column,
    key: normalizeKey(column),
  }));
  const exactMatch = new Map();
  normalizedColumns.forEach(({ column, key }) => {
    if (key && !exactMatch.has(key)) {
      exactMatch.set(key, column);
    }
  });

  for (const value of providedValues) {
    const normalized = normalizeKey(value);
    if (normalized && exactMatch.has(normalized)) {
      return exactMatch.get(normalized);
    }
  }

  for (const candidate of candidates) {
    const found = normalizedColumns.find((item) => item.key.includes(candidate));
    if (found) return found.column;
  }

  return "";
}

function pickColumn(columns, provided, candidates) {
  if (provided && columns.includes(provided)) return provided;
  const normalized = columns.map((column) => ({ column, key: normalizeKey(column) }));
  for (const candidate of candidates) {
    const found = normalized.find((item) => item.key.includes(candidate));
    if (found) return found.column;
  }
  return null;
}

function roundMoney(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function parseAmountDetail(value) {
  if (value === null || value === undefined) {
    return { value: 0, isPresent: false, isValid: true };
  }
  if (typeof value === "number") {
    return { value: Number.isFinite(value) ? value : 0, isPresent: true, isValid: Number.isFinite(value) };
  }

  const raw = String(value).trim();
  if (!raw) return { value: 0, isPresent: false, isValid: true };

  let cleaned = raw.replace(/[$,\s]/g, "").replace(/\((.*)\)/, "-$1");
  if (/dr$/i.test(cleaned)) cleaned = `-${cleaned.replace(/dr$/i, "")}`;
  if (/cr$/i.test(cleaned)) cleaned = cleaned.replace(/cr$/i, "");

  if (!cleaned) return { value: 0, isPresent: false, isValid: true };
  const num = Number(cleaned);
  if (!Number.isFinite(num)) return { value: 0, isPresent: true, isValid: false };
  return { value: num, isPresent: true, isValid: true };
}

function parseDateFlexible(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;

  if (typeof value === "number") {
    const excelEpoch = new Date(1899, 11, 30);
    return new Date(excelEpoch.getTime() + value * 86400000);
  }

  const raw = String(value).trim();
  if (!raw) return null;

  let parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) return parsed;

  const parts = raw.split(/[\/\-]/);
  if (parts.length === 3) {
    if (parts[0].length === 4) {
      parsed = new Date(`${parts[0]}-${parts[1]}-${parts[2]}`);
    } else {
      parsed = new Date(`${parts[2]}-${parts[0]}-${parts[1]}`);
      if (Number.isNaN(parsed.getTime())) {
        parsed = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
      }
    }
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  return null;
}

function toIsoDate(dateValue) {
  const date = dateValue instanceof Date ? dateValue : parseDateFlexible(dateValue);
  if (!date || Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function isLikelySummaryLabel(accountName) {
  const key = normalizeKey(accountName);
  if (!key) return false;
  return (
    key === "beginning balance" ||
    key === "opening balance" ||
    key === "ending balance" ||
    key === "subtotal" ||
    key === "total" ||
    key.startsWith("total for")
  );
}

function normalizeAccountType(value) {
  const key = normalizeKey(value);
  if (!key) return "";

  if (key === "asset" || key === "assets") return "asset";
  if (key === "liability" || key === "liabilities") return "liability";
  if (key === "equity") return "equity";
  if (key === "income" || key === "revenue" || key === "sales") return "income";
  if (key === "expense" || key === "expenses" || key === "cost" || key === "cogs") return "expense";
  return "";
}

function formatAccountType(value) {
  const normalized = normalizeAccountType(value);
  if (!normalized) return "";
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function inferAccountType(accountName) {
  const key = normalizeKey(accountName);
  if (!key) return "expense";

  if (
    key.includes("cash") ||
    key.includes("bank") ||
    key.includes("asset") ||
    key.includes("receivable") ||
    key.includes("inventory") ||
    key.includes("prepaid") ||
    key.includes("fixed asset")
  ) return "asset";

  if (
    key.includes("liabil") ||
    key.includes("payable") ||
    key.includes("loan") ||
    key.includes("credit card") ||
    key.includes("accrued")
  ) return "liability";

  if (
    key.includes("equity") ||
    key.includes("capital") ||
    key.includes("retained earning") ||
    key.includes("owner")
  ) return "equity";

  if (
    key.includes("income") ||
    key.includes("revenue") ||
    key.includes("sales") ||
    key.includes("interest income") ||
    key.includes("other income")
  ) return "income";

  return "expense";
}

function isCashOrBankAccount(accountName) {
  const key = normalizeKey(accountName);
  if (!key) return false;
  return key.includes("cash") || key.includes("bank") || key.includes("checking") || key.includes("savings");
}

function tokenizeKey(value) {
  return normalizeKey(value)
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function containsLetters(value) {
  return /[a-z]/i.test(String(value || ""));
}

function looksLikeTransactionTypeValue(value) {
  const key = normalizeKey(value);
  if (!key) return false;
  return (
    key.includes("transfer") ||
    key.includes("journal") ||
    key.includes("entry") ||
    key.includes("payment") ||
    key.includes("invoice") ||
    key.includes("bill") ||
    key.includes("deposit") ||
    key.includes("withdraw") ||
    key.includes("purchase") ||
    key.includes("sale") ||
    key.includes("refund")
  );
}

function looksLikeDescriptionValue(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  return text.split(/\s+/).length >= 3 || text.length >= 16;
}

function looksLikeAccountTypeValue(value) {
  return Boolean(normalizeAccountType(value));
}

function profileColumnValues(rows, column, sampleLimit = 300) {
  const stats = {
    sampled: 0,
    nonEmpty: 0,
    dateLike: 0,
    numericLike: 0,
    textLike: 0,
    positiveLike: 0,
    negativeLike: 0,
    transactionTypeHints: 0,
    descriptionHints: 0,
    accountTypeHints: 0,
    unique: new Set(),
  };

  for (let index = 0; index < rows.length && stats.sampled < sampleLimit; index += 1) {
    stats.sampled += 1;
    const value = rows[index]?.[column];
    if (value === null || value === undefined || String(value).trim() === "") continue;

    stats.nonEmpty += 1;
    const asText = String(value).trim();
    stats.unique.add(asText.toLowerCase());

    const dateValue = parseDateFlexible(value);
    if (dateValue && !Number.isNaN(dateValue.getTime())) {
      stats.dateLike += 1;
    }

    const amountDetail = parseAmountDetail(value);
    if (amountDetail.isPresent && amountDetail.isValid) {
      stats.numericLike += 1;
      if (amountDetail.value > 0) stats.positiveLike += 1;
      if (amountDetail.value < 0) stats.negativeLike += 1;
    }

    if (containsLetters(value)) {
      stats.textLike += 1;
    }

    if (looksLikeTransactionTypeValue(value)) {
      stats.transactionTypeHints += 1;
    }
    if (looksLikeDescriptionValue(value)) {
      stats.descriptionHints += 1;
    }
    if (looksLikeAccountTypeValue(value)) {
      stats.accountTypeHints += 1;
    }
  }

  const denominator = Math.max(stats.nonEmpty, 1);
  return {
    column,
    nonEmpty: stats.nonEmpty,
    sampled: stats.sampled,
    uniqueCount: stats.unique.size,
    dateRatio: stats.dateLike / denominator,
    numericRatio: stats.numericLike / denominator,
    textRatio: stats.textLike / denominator,
    positiveRatio: stats.positiveLike / denominator,
    negativeRatio: stats.negativeLike / denominator,
    transactionTypeRatio: stats.transactionTypeHints / denominator,
    descriptionRatio: stats.descriptionHints / denominator,
    accountTypeRatio: stats.accountTypeHints / denominator,
    uniqueRatio: Math.min(stats.unique.size / denominator, 1),
  };
}

function headerKeywordScore(column, keywords = []) {
  const key = normalizeKey(column);
  if (!key) return 0;

  let score = 0;
  const tokens = tokenizeKey(column);
  for (const phrase of keywords) {
    const keyword = normalizeKey(phrase);
    if (!keyword) continue;

    if (key === keyword) {
      score = Math.max(score, 1.25);
      continue;
    }
    if (key.includes(keyword)) {
      score = Math.max(score, 1.0);
      continue;
    }

    const keywordTokens = tokenizeKey(keyword);
    if (!keywordTokens.length) continue;
    const matchCount = keywordTokens.filter((token) => tokens.includes(token)).length;
    if (matchCount > 0) {
      score = Math.max(score, 0.55 + (matchCount / keywordTokens.length) * 0.35);
    }
  }
  return score;
}

function fieldValueScore(field, profile) {
  if (!profile) return 0;

  if (field === "date") {
    return profile.dateRatio * 1.2 + (1 - profile.numericRatio) * 0.1;
  }

  if (field === "account_name") {
    return profile.textRatio * 0.8 + profile.uniqueRatio * 0.4 + (1 - profile.numericRatio) * 0.2;
  }

  if (field === "debit") {
    return profile.numericRatio * 0.95 + profile.negativeRatio * 0.15;
  }

  if (field === "credit") {
    return profile.numericRatio * 0.95 + profile.positiveRatio * 0.15;
  }

  if (field === "split_amount") {
    const hasBothSigns = profile.positiveRatio > 0.05 && profile.negativeRatio > 0.05 ? 0.25 : 0;
    return profile.numericRatio + hasBothSigns;
  }

  if (field === "description") {
    return profile.textRatio * 0.55 + profile.descriptionRatio * 0.6;
  }

  if (field === "transaction_type") {
    return profile.textRatio * 0.35 + profile.transactionTypeRatio * 0.9;
  }

  if (field === "balance") {
    return profile.numericRatio * 0.9;
  }

  if (field === "reference") {
    return profile.uniqueRatio * 0.5 + profile.textRatio * 0.35;
  }

  if (field === "account_type") {
    return profile.accountTypeRatio * 1.1 + profile.textRatio * 0.2;
  }

  if (field === "account_number") {
    return profile.numericRatio * 0.55 + profile.uniqueRatio * 0.25;
  }

  return 0;
}

function scoreColumnForField(field, column, profile) {
  const keywords = AUTO_MAPPING_HEADER_KEYWORDS[field] || [];
  const headerScore = headerKeywordScore(column, keywords);
  const valueScore = fieldValueScore(field, profile);

  const blended = roundMoney((headerScore * 0.65 + valueScore * 0.35) * 1000) / 1000;
  return {
    field,
    column,
    headerScore: roundMoney(headerScore),
    valueScore: roundMoney(valueScore),
    total: blended,
  };
}

function hasUserProvidedMapping(mapping, field, columns) {
  const value = mapping?.[field];
  if (!value) return false;
  return columns.includes(value);
}

function validateDetectedMapping(mapping, confidence = {}, requiredThreshold = AUTO_MAPPING_CONFIDENCE_THRESHOLD) {
  const missingRequired = [];
  const lowConfidenceFields = [];

  if (!mapping.date) missingRequired.push("date");
  if (!mapping.account_name) missingRequired.push("account_name");

  const hasDebitAndCredit = Boolean(mapping.debit && mapping.credit);
  const hasSplit = Boolean(mapping.split_amount);
  if (!hasSplit && !hasDebitAndCredit) {
    missingRequired.push("debit_credit_or_split_amount");
  }

  ["date", "account_name"].forEach((field) => {
    const fieldConfidence = confidence[field] ?? 0;
    if (mapping[field] && fieldConfidence < requiredThreshold) {
      lowConfidenceFields.push(field);
    }
  });

  if (hasDebitAndCredit) {
    const debitConfidence = confidence.debit ?? 0;
    const creditConfidence = confidence.credit ?? 0;
    if (debitConfidence < requiredThreshold) lowConfidenceFields.push("debit");
    if (creditConfidence < requiredThreshold) lowConfidenceFields.push("credit");
  } else if (hasSplit) {
    const splitConfidence = confidence.split_amount ?? 0;
    if (splitConfidence < requiredThreshold) lowConfidenceFields.push("split_amount");
  }

  const uniqueLowConfidence = Array.from(new Set(lowConfidenceFields));
  return {
    missingRequired,
    lowConfidenceFields: uniqueLowConfidence,
    canAutoProcess: missingRequired.length === 0 && uniqueLowConfidence.length === 0,
  };
}

function autoDetectManualGlMapping({ columns = [], rows = [], mapping = {} }) {
  const provided = ensureMappingShape(mapping || {});
  const detected = ensureMappingShape({});
  const confidence = {};
  const sources = {};
  const usedColumns = new Set();

  const profiles = Object.fromEntries(
    columns.map((column) => [column, profileColumnValues(rows, column)])
  );

  const fieldsInPriority = [
    "date",
    "account_name",
    "debit",
    "credit",
    "split_amount",
    "description",
    "transaction_type",
    "balance",
    "reference",
    "account_type",
    "account_number",
  ];

  fieldsInPriority.forEach((field) => {
    if (hasUserProvidedMapping(provided, field, columns)) {
      detected[field] = provided[field];
      confidence[field] = 1;
      sources[field] = "manual";
      usedColumns.add(provided[field]);
    }
  });

  const assignField = (field, allowUsedColumn = false) => {
    if (detected[field]) return;
    let best = null;

    columns.forEach((column) => {
      if (!allowUsedColumn && usedColumns.has(column)) return;
      const score = scoreColumnForField(field, column, profiles[column]);
      if (!best || score.total > best.total) {
        best = score;
      }
    });

    if (!best) return;
    const minScore = AUTO_MAPPING_SCORE_THRESHOLD[field] ?? 0.35;
    if (best.total >= minScore) {
      detected[field] = best.column;
      confidence[field] = Math.max(0, Math.min(1, best.total));
      sources[field] = "auto";
      if (!allowUsedColumn) usedColumns.add(best.column);
    }
  };

  ["date", "account_name", "debit", "credit", "balance", "description", "transaction_type", "reference", "account_type", "account_number"].forEach((field) => {
    assignField(field);
  });

  // Split amount can reuse a numeric amount-like column when debit/credit are unavailable.
  if (!detected.split_amount) {
    assignField("split_amount");
  }
  if (!detected.split_amount) {
    assignField("split_amount", true);
  }

  // Prefer split-only model when a single signed amount column is strong and one of debit/credit is missing.
  if ((!detected.debit || !detected.credit) && detected.split_amount) {
    confidence.debit = confidence.debit || 0;
    confidence.credit = confidence.credit || 0;
  }

  // Optional fallback: if both debit/credit missing and split still missing, pick strongest numeric amount column.
  if (!detected.debit && !detected.credit && !detected.split_amount) {
    let bestNumeric = null;
    columns.forEach((column) => {
      const profile = profiles[column];
      if (!profile) return;
      const score = roundMoney((profile.numericRatio + profile.positiveRatio + profile.negativeRatio * 0.5) * 1000) / 1000;
      if (!bestNumeric || score > bestNumeric.score) {
        bestNumeric = { column, score };
      }
    });

    if (bestNumeric && bestNumeric.score >= 0.6) {
      detected.split_amount = bestNumeric.column;
      confidence.split_amount = Math.max(confidence.split_amount || 0, Math.min(1, bestNumeric.score));
      sources.split_amount = "auto-value";
    }
  }

  const providedNonEmpty = Object.fromEntries(
    Object.entries(provided).filter(([, value]) => Boolean(value))
  );
  const merged = ensureMappingShape({ ...detected, ...providedNonEmpty });
  Object.keys(merged).forEach((field) => {
    if (!merged[field]) return;
    if (!confidence[field]) confidence[field] = sources[field] === "manual" ? 1 : 0;
    if (!sources[field]) sources[field] = hasUserProvidedMapping(provided, field, columns) ? "manual" : "auto";
  });

  const validation = validateDetectedMapping(merged, confidence, AUTO_MAPPING_CONFIDENCE_THRESHOLD);
  return {
    mapping: merged,
    confidence,
    sources,
    profiles,
    ...validation,
  };
}

function normalizeStatementType(statementType) {
  const normalized = normalizeKey(statementType).replace(/[\s-]+/g, "_");
  if (normalized === "pl" || normalized === "p_l" || normalized === "profit_and_loss") {
    return QUICKBOOKS_REPORT_TYPES.PROFIT_AND_LOSS;
  }
  if (
    normalized === "balance_sheet" ||
    normalized === "balancesheet" ||
    normalized === "bs"
  ) {
    return QUICKBOOKS_REPORT_TYPES.BALANCE_SHEET;
  }
  if (
    normalized === "cash_flow" ||
    normalized === "cashflow" ||
    normalized === "cash_flow_statement" ||
    normalized === "cf"
  ) {
    return QUICKBOOKS_REPORT_TYPES.CASH_FLOW;
  }
  return normalized;
}

function ensureMappingShape(mapping = {}) {
  const next = { ...mapping };
  [...MANUAL_GL_REQUIRED_MAPPING_FIELDS, ...MANUAL_GL_OPTIONAL_MAPPING_FIELDS].forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(next, key)) {
      next[key] = "";
    }
  });
  return next;
}

function resolveManualGlMapping(columns, mapping = {}, rows = []) {
  const heuristic = {
    date: resolveColumn(columns, [mapping.date, mapping.dateColumn], ["transaction date", "posting date", "date"]),
    account_name: resolveColumn(
      columns,
      [mapping.account_name, mapping.accountColumn],
      ["distribution account", "account name", "account"]
    ),
    debit: resolveColumn(columns, [mapping.debit, mapping.debitColumn], ["debit", "withdrawal", "dr"]),
    credit: resolveColumn(columns, [mapping.credit, mapping.creditColumn], ["credit", "deposit", "cr"]),
    split_amount: resolveColumn(
      columns,
      [mapping.split_amount, mapping.splitAmount, mapping.splitAmountColumn, mapping.split],
      ["split amount", "split", "amount"]
    ),
    description: resolveColumn(
      columns,
      [mapping.description, mapping.descriptionColumn],
      ["description", "memo", "narration", "details", "split"]
    ),
    transaction_type: resolveColumn(
      columns,
      [mapping.transaction_type, mapping.typeColumn],
      ["transaction type", "type", "category"]
    ),
    balance: resolveColumn(columns, [mapping.balance, mapping.balanceColumn], ["balance", "running balance"]),
    reference: resolveColumn(
      columns,
      [mapping.reference, mapping.referenceColumn, mapping.ref],
      ["reference", "ref", "document", "txn id", "transaction id", "journal"]
    ),
    account_type: resolveColumn(
      columns,
      [mapping.account_type, mapping.accountType, mapping.accountTypeColumn],
      ["account type", "type"]
    ),
    amount: resolveColumn(columns, [mapping.amount, mapping.amountColumn], ["amount", "net"]),
    account_number: resolveColumn(
      columns,
      [mapping.account_number, mapping.accountNumber, mapping.accountNumberColumn],
      ["account number", "acct number", "account #"]
    ),
  };

  // Backward compatibility: if caller mapped amount earlier, use it as split_amount fallback.
  if (!heuristic.split_amount && heuristic.amount) {
    heuristic.split_amount = heuristic.amount;
  }

  const merged = ensureMappingShape({ ...heuristic, ...mapping });
  if (Array.isArray(rows) && rows.length > 0) {
    return autoDetectManualGlMapping({ columns, rows, mapping: merged }).mapping;
  }
  return merged;
}

function normalizeMappingKeys(resolvedMapping) {
  const shaped = ensureMappingShape(resolvedMapping || {});
  return Object.fromEntries(
    Object.entries(shaped).map(([key, value]) => [key, normalizeKey(value)])
  );
}

function validateMapping(resolvedMapping, columns) {
  const shapedMapping = ensureMappingShape(resolvedMapping || {});

  if (!shapedMapping.date) {
    throw new Error(`Unable to determine date column. Available columns: ${columns.join(", ")}`);
  }
  if (!shapedMapping.account_name) {
    throw new Error(`Unable to determine account column. Available columns: ${columns.join(", ")}`);
  }
  if (
    !shapedMapping.debit &&
    !shapedMapping.credit &&
    !shapedMapping.split_amount &&
    !shapedMapping.amount
  ) {
    throw new Error(
      `Unable to determine debit/credit/split column. Available columns: ${columns.join(", ")}`
    );
  }
}

function validateMappingForAutoProcess(resolvedMapping, confidence = {}, minimumConfidence = AUTO_MAPPING_CONFIDENCE_THRESHOLD) {
  const shaped = ensureMappingShape(resolvedMapping || {});
  const missing = [];
  const lowConfidence = [];

  if (!shaped.date) missing.push("date");
  if (!shaped.account_name) missing.push("account_name");

  const hasSplit = Boolean(shaped.split_amount);
  const hasDebitAndCredit = Boolean(shaped.debit && shaped.credit);
  if (!hasSplit && !hasDebitAndCredit) {
    missing.push("debit_and_credit_or_split_amount");
  }

  if (shaped.date && (confidence.date ?? 0) < minimumConfidence) lowConfidence.push("date");
  if (shaped.account_name && (confidence.account_name ?? 0) < minimumConfidence) lowConfidence.push("account_name");

  if (hasSplit) {
    if ((confidence.split_amount ?? 0) < minimumConfidence) lowConfidence.push("split_amount");
  } else {
    if (shaped.debit && (confidence.debit ?? 0) < minimumConfidence) lowConfidence.push("debit");
    if (shaped.credit && (confidence.credit ?? 0) < minimumConfidence) lowConfidence.push("credit");
  }

  return {
    isValid: missing.length === 0 && lowConfidence.length === 0,
    missing,
    lowConfidence: Array.from(new Set(lowConfidence)),
  };
}

function normalizeManualGlRows({
  rows,
  rowNumbers,
  resolvedMapping,
  rawMapping = {},
}) {
  const normalizedMapping = normalizeMappingKeys(resolvedMapping);
  const errors = [];
  const glEntries = [];
  const accountTypeMap =
    rawMapping.accountTypeMap && typeof rawMapping.accountTypeMap === "object"
      ? rawMapping.accountTypeMap
      : {};

  let lastValidDate = null;
  let lastValidAccount = "";

  rows.forEach((row, index) => {
    const rowNum = rowNumbers[index] || index + 2;
    const normalizedRow = Object.fromEntries(
      Object.entries(row).map(([key, value]) => [normalizeKey(key), value])
    );

    const rawDate = normalizedRow[normalizedMapping.date];
    const rawAccount = normalizedRow[normalizedMapping.account_name];
    const rawDebit = normalizedMapping.debit ? normalizedRow[normalizedMapping.debit] : null;
    const rawCredit = normalizedMapping.credit ? normalizedRow[normalizedMapping.credit] : null;
    const rawSplitAmount = normalizedMapping.split_amount ? normalizedRow[normalizedMapping.split_amount] : null;
    const rawAmount = normalizedMapping.amount ? normalizedRow[normalizedMapping.amount] : null;
    const rawBalance = normalizedMapping.balance ? normalizedRow[normalizedMapping.balance] : null;
    const rawDescription = normalizedMapping.description ? normalizedRow[normalizedMapping.description] : null;
    const rawTransactionType = normalizedMapping.transaction_type ? normalizedRow[normalizedMapping.transaction_type] : null;
    const rawReference = normalizedMapping.reference ? normalizedRow[normalizedMapping.reference] : null;
    const rawAccountType = normalizedMapping.account_type ? normalizedRow[normalizedMapping.account_type] : null;
    const rawAccountNumber = normalizedMapping.account_number ? normalizedRow[normalizedMapping.account_number] : null;

    const debitDetail = parseAmountDetail(rawDebit);
    const creditDetail = parseAmountDetail(rawCredit);
    const splitDetail = parseAmountDetail(rawSplitAmount);
    const amountDetail = parseAmountDetail(rawAmount);
    const balanceDetail = parseAmountDetail(rawBalance);

    const hasNumericInput =
      debitDetail.isPresent || creditDetail.isPresent || splitDetail.isPresent || amountDetail.isPresent || balanceDetail.isPresent;
    const accountCandidate = rawAccount === null || rawAccount === undefined ? "" : String(rawAccount).trim();
    const dateEmpty = !rawDate || String(rawDate).trim() === "";

    if (!accountCandidate && dateEmpty && !hasNumericInput) return;

    let accountName = accountCandidate;
    if (!accountName && lastValidAccount) accountName = lastValidAccount;
    if (accountName && !isLikelySummaryLabel(accountName)) {
      lastValidAccount = accountName;
    }

    if (isLikelySummaryLabel(accountName) && dateEmpty) {
      return;
    }

    let parsedDate = parseDateFlexible(rawDate);
    if (parsedDate) {
      lastValidDate = parsedDate;
    } else if (dateEmpty && lastValidDate) {
      parsedDate = lastValidDate;
    }

    let debit = roundMoney(debitDetail.value);
    let credit = roundMoney(creditDetail.value);
    const splitAmount = resolvedMapping.split_amount ? roundMoney(splitDetail.value) : null;
    const fallbackAmount = roundMoney(amountDetail.value);

    if (debit === 0 && credit === 0) {
      if (splitDetail.isPresent && splitAmount) {
        if (splitAmount > 0) credit = Math.abs(splitAmount);
        else debit = Math.abs(splitAmount);
      } else if (amountDetail.isPresent && fallbackAmount) {
        if (fallbackAmount > 0) credit = Math.abs(fallbackAmount);
        else debit = Math.abs(fallbackAmount);
      }
    }

    const hasMeaningfulAmount = debit !== 0 || credit !== 0 || (balanceDetail.isPresent && balanceDetail.value !== 0);
    if (!hasMeaningfulAmount && !parsedDate && !accountName) {
      return;
    }
    if (!hasMeaningfulAmount && !splitDetail.isPresent && !amountDetail.isPresent) {
      return;
    }

    let hasError = false;
    if (!parsedDate) {
      errors.push({ row: rowNum, message: dateEmpty ? "Missing date" : `Invalid date format: ${rawDate}` });
      hasError = true;
    }
    if (!accountName) {
      errors.push({ row: rowNum, message: "Missing account name" });
      hasError = true;
    }

    if (hasError) return;

    const mappedTypeFromAccount =
      accountTypeMap[accountName] || accountTypeMap[normalizeKey(accountName)] || "";
    const normalizedType =
      normalizeAccountType(rawAccountType) ||
      normalizeAccountType(mappedTypeFromAccount) ||
      inferAccountType(accountName);

    glEntries.push({
      date: toIsoDate(parsedDate),
      account_name: accountName,
      account_number: rawAccountNumber ? String(rawAccountNumber).trim() : "",
      account_type: formatAccountType(normalizedType),
      description: rawDescription ? String(rawDescription).trim() : "",
      transaction_type: rawTransactionType ? String(rawTransactionType).trim() : "",
      reference: rawReference ? String(rawReference).trim() : "",
      debit: roundMoney(Math.abs(debit)),
      credit: roundMoney(Math.abs(credit)),
      split_amount: resolvedMapping.split_amount ? splitAmount : null,
      balance: resolvedMapping.balance ? roundMoney(balanceDetail.value) : null,
      amount: roundMoney(credit - debit),
      source: MANUAL_GL_SOURCE,
    });
  });

  return { errors, glEntries };
}

function buildFinancialReportsFromGl(glEntries) {
  const assetMap = {};
  const liabilityMap = {};
  const equityMap = {};
  const incomeMap = {};
  const expenseMap = {};
  const cashByMonth = {};
  const cashByAccount = {};

  let totalIncome = 0;
  let totalExpense = 0;
  let totalCashInflow = 0;
  let totalCashOutflow = 0;

  glEntries.forEach((entry) => {
    const account = String(entry.account_name || "").trim() || "Uncategorized";
    const type = normalizeAccountType(entry.account_type) || inferAccountType(account);
    const debit = roundMoney(Math.abs(parseAmountDetail(entry.debit).value));
    const credit = roundMoney(Math.abs(parseAmountDetail(entry.credit).value));

    if (type === "asset") {
      assetMap[account] = roundMoney((assetMap[account] || 0) + (debit - credit));
    } else if (type === "liability") {
      liabilityMap[account] = roundMoney((liabilityMap[account] || 0) + (credit - debit));
    } else if (type === "equity") {
      equityMap[account] = roundMoney((equityMap[account] || 0) + (credit - debit));
    } else if (type === "income") {
      const current = incomeMap[account] || { account, credits: 0, debits: 0, net: 0 };
      current.credits = roundMoney(current.credits + credit);
      current.debits = roundMoney(current.debits + debit);
      current.net = roundMoney(current.credits - current.debits);
      incomeMap[account] = current;
      totalIncome = roundMoney(totalIncome + credit);
    } else {
      const current = expenseMap[account] || { account, debits: 0, credits: 0, net: 0 };
      current.debits = roundMoney(current.debits + debit);
      current.credits = roundMoney(current.credits + credit);
      current.net = roundMoney(current.debits - current.credits);
      expenseMap[account] = current;
      totalExpense = roundMoney(totalExpense + debit);
    }

    if (isCashOrBankAccount(account)) {
      totalCashInflow = roundMoney(totalCashInflow + credit);
      totalCashOutflow = roundMoney(totalCashOutflow + debit);

      const monthKey = entry.date ? String(entry.date).slice(0, 7) : "Unknown";
      const monthRow = cashByMonth[monthKey] || { month: monthKey, inflow: 0, outflow: 0, netCashChange: 0 };
      monthRow.inflow = roundMoney(monthRow.inflow + credit);
      monthRow.outflow = roundMoney(monthRow.outflow + debit);
      monthRow.netCashChange = roundMoney(monthRow.inflow - monthRow.outflow);
      cashByMonth[monthKey] = monthRow;

      const accountRow = cashByAccount[account] || { account, inflow: 0, outflow: 0, netCashChange: 0 };
      accountRow.inflow = roundMoney(accountRow.inflow + credit);
      accountRow.outflow = roundMoney(accountRow.outflow + debit);
      accountRow.netCashChange = roundMoney(accountRow.inflow - accountRow.outflow);
      cashByAccount[account] = accountRow;
    }
  });

  const netIncome = roundMoney(totalIncome - totalExpense);
  if (netIncome !== 0) {
    equityMap["Current Period Net Income"] = roundMoney((equityMap["Current Period Net Income"] || 0) + netIncome);
  }

  const assets = Object.entries(assetMap).map(([account, balance]) => ({ account, balance })).sort((a, b) => a.account.localeCompare(b.account));
  const liabilities = Object.entries(liabilityMap).map(([account, balance]) => ({ account, balance })).sort((a, b) => a.account.localeCompare(b.account));
  const equity = Object.entries(equityMap).map(([account, balance]) => ({ account, balance })).sort((a, b) => a.account.localeCompare(b.account));
  const income = Object.values(incomeMap).sort((a, b) => a.account.localeCompare(b.account));
  const expenses = Object.values(expenseMap).sort((a, b) => a.account.localeCompare(b.account));
  const monthly = Object.values(cashByMonth).sort((a, b) => a.month.localeCompare(b.month));
  const cashAccounts = Object.values(cashByAccount).sort((a, b) => a.account.localeCompare(b.account));

  const totalAssets = roundMoney(assets.reduce((sum, item) => sum + item.balance, 0));
  const totalLiabilities = roundMoney(liabilities.reduce((sum, item) => sum + item.balance, 0));
  const totalEquity = roundMoney(equity.reduce((sum, item) => sum + item.balance, 0));
  const totalNetCashChange = roundMoney(totalCashInflow - totalCashOutflow);

  return {
    balance_sheet: {
      assets,
      liabilities,
      equity,
      totalAssets,
      totalLiabilities,
      totalEquity,
      netIncome,
      isBalanced: Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.01,
    },
    profit_and_loss: {
      income,
      expenses,
      totalIncome,
      totalExpense,
      netIncome,
      totalRevenue: totalIncome,
      revenue: income,
      netProfit: netIncome,
    },
    cash_flow: {
      cashAccounts,
      monthly,
      monthlyNet: monthly.map((row) => ({ month: row.month, netCashChange: row.netCashChange })),
      totalInflow: totalCashInflow,
      totalOutflow: totalCashOutflow,
      totalNetCashChange,
    },
  };
}

function formatQuickbooksMoney(value) {
  let amount = roundMoney(parseAmountDetail(value).value);
  if (Math.abs(amount) < 0.005) amount = 0;
  if (!Number.isFinite(amount)) return "0.00";
  return amount.toFixed(2);
}

function buildQuickbooksDataRow(label, amount, id = "") {
  const row = {
    type: "Data",
    ColData: [
      id ? { id, value: String(label || "") } : { value: String(label || "") },
      { value: formatQuickbooksMoney(amount) },
    ],
  };
  return row;
}

function buildQuickbooksSection({ name, rows = [], total = 0, totalLabel = "" }) {
  const section = {
    type: "Section",
    group: normalizeKey(name).replace(/[^a-z0-9]+/g, "_") || "section",
    Header: { ColData: [{ value: String(name || "Section") }] },
    Summary: {
      ColData: [
        { value: totalLabel || `Total ${name}` },
        { value: formatQuickbooksMoney(total) },
      ],
    },
  };

  if (Array.isArray(rows) && rows.length > 0) {
    section.Rows = { Row: rows };
  }

  return section;
}

function resolveGlDateRange(glEntries = []) {
  const dates = glEntries
    .map((entry) => String(entry?.date || "").slice(0, 10))
    .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))
    .sort();

  const today = new Date().toISOString().slice(0, 10);
  return {
    startDate: dates[0] || today,
    endDate: dates[dates.length - 1] || today,
  };
}

function buildQuickbooksReportHeader(reportName, startDate, endDate) {
  return {
    ReportName: reportName,
    Time: new Date().toISOString(),
    StartPeriod: startDate,
    EndPeriod: endDate,
    ReportBasis: "Accrual",
    Currency: "USD",
  };
}

function buildQuickbooksProfitAndLossReport(report, startDate, endDate) {
  const incomeRows = (report?.income || []).map((item) =>
    buildQuickbooksDataRow(item.account, item.net, item.account)
  );
  const expenseRows = (report?.expenses || []).map((item) =>
    buildQuickbooksDataRow(item.account, item.net, item.account)
  );

  const rows = [
    buildQuickbooksSection({
      name: "Income",
      rows: incomeRows,
      total: report?.totalIncome || 0,
      totalLabel: "Total Income",
    }),
    buildQuickbooksSection({
      name: "Expenses",
      rows: expenseRows,
      total: report?.totalExpense || 0,
      totalLabel: "Total Expenses",
    }),
    buildQuickbooksDataRow("Net Income", report?.netIncome || 0),
  ];

  return {
    Header: buildQuickbooksReportHeader("ProfitAndLoss", startDate, endDate),
    Columns: {
      Column: [{ ColTitle: "Account" }, { ColTitle: "Total", ColType: "Money" }],
    },
    Rows: { Row: rows },
  };
}

function buildQuickbooksBalanceSheetReport(report, startDate, endDate) {
  const assetsRows = (report?.assets || []).map((item) =>
    buildQuickbooksDataRow(item.account, item.balance, item.account)
  );
  const liabilitiesRows = (report?.liabilities || []).map((item) =>
    buildQuickbooksDataRow(item.account, item.balance, item.account)
  );
  const equityRows = (report?.equity || []).map((item) =>
    buildQuickbooksDataRow(item.account, item.balance, item.account)
  );

  const liabilitiesSection = buildQuickbooksSection({
    name: "Liabilities",
    rows: liabilitiesRows,
    total: report?.totalLiabilities || 0,
    totalLabel: "Total Liabilities",
  });
  const equitySection = buildQuickbooksSection({
    name: "Equity",
    rows: equityRows,
    total: report?.totalEquity || 0,
    totalLabel: "Total Equity",
  });
  const liabilitiesAndEquity = buildQuickbooksSection({
    name: "Liabilities and Equity",
    rows: [liabilitiesSection, equitySection],
    total: roundMoney((report?.totalLiabilities || 0) + (report?.totalEquity || 0)),
    totalLabel: "Total Liabilities and Equity",
  });

  return {
    Header: buildQuickbooksReportHeader("BalanceSheet", startDate, endDate),
    Columns: {
      Column: [{ ColTitle: "Account" }, { ColTitle: "Total", ColType: "Money" }],
    },
    Rows: {
      Row: [
        buildQuickbooksSection({
          name: "Assets",
          rows: assetsRows,
          total: report?.totalAssets || 0,
          totalLabel: "Total Assets",
        }),
        liabilitiesAndEquity,
      ],
    },
  };
}

function buildQuickbooksCashFlowReport(report, startDate, endDate) {
  const inflowRows = (report?.cashAccounts || [])
    .filter((item) => roundMoney(item.inflow || 0) !== 0)
    .map((item) => buildQuickbooksDataRow(item.account, item.inflow, item.account));

  const outflowRows = (report?.cashAccounts || [])
    .filter((item) => roundMoney(item.outflow || 0) !== 0)
    .map((item) => buildQuickbooksDataRow(item.account, -Math.abs(item.outflow || 0), item.account));

  return {
    Header: buildQuickbooksReportHeader("CashFlow", startDate, endDate),
    Columns: {
      Column: [{ ColTitle: "Account" }, { ColTitle: "Total", ColType: "Money" }],
    },
    Rows: {
      Row: [
        buildQuickbooksSection({
          name: "Cash Inflows",
          rows: inflowRows,
          total: report?.totalInflow || 0,
          totalLabel: "Total Cash Inflows",
        }),
        buildQuickbooksSection({
          name: "Cash Outflows",
          rows: outflowRows,
          total: -Math.abs(report?.totalOutflow || 0),
          totalLabel: "Total Cash Outflows",
        }),
        buildQuickbooksDataRow("Net Cash Change", report?.totalNetCashChange || 0),
      ],
    },
  };
}

function buildQuickbooksGeneralLedgerReport(glEntries, startDate, endDate) {
  const byAccount = new Map();

  (glEntries || []).forEach((entry) => {
    const accountName = String(entry?.account_name || "").trim() || "Uncategorized";
    if (!byAccount.has(accountName)) {
      byAccount.set(accountName, []);
    }
    byAccount.get(accountName).push(entry);
  });

  const accountSections = Array.from(byAccount.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([accountName, entries]) => {
      const sorted = [...entries].sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
      let runningBalance = 0;
      const rows = sorted.map((entry) => {
        const debit = roundMoney(parseAmountDetail(entry.debit).value);
        const credit = roundMoney(parseAmountDetail(entry.credit).value);
        const amount = roundMoney(credit - debit);
        const balanceValue = entry.balance !== null && entry.balance !== undefined
          ? roundMoney(parseAmountDetail(entry.balance).value)
          : roundMoney(runningBalance + amount);

        runningBalance = balanceValue;
        const ref = String(entry.reference || "").trim();
        const memo = String(entry.description || "").trim();
        const transactionType = String(entry.transaction_type || "").trim() || "Manual GL";

        return {
          type: "Data",
          ColData: [
            { value: String(entry.date || "") },
            { value: transactionType },
            { value: ref },
            { value: memo },
            { value: accountName },
            { value: memo },
            { value: formatQuickbooksMoney(amount) },
            { value: formatQuickbooksMoney(balanceValue) },
          ],
        };
      });

      return {
        type: "Section",
        Header: {
          ColData: [
            {
              id: sorted[0]?.account_number || normalizeKey(accountName),
              value: accountName,
            },
          ],
        },
        Rows: { Row: rows },
        Summary: {
          ColData: [
            { value: `Total ${accountName}` },
            { value: formatQuickbooksMoney(rows.length ? runningBalance : 0) },
          ],
        },
      };
    });

  return {
    Header: buildQuickbooksReportHeader("GeneralLedger", startDate, endDate),
    Columns: {
      Column: [
        { ColTitle: "Date", ColType: "Date" },
        { ColTitle: "Transaction Type", ColType: "String" },
        { ColTitle: "Reference", ColType: "String" },
        { ColTitle: "Description", ColType: "String" },
        { ColTitle: "Account", ColType: "String" },
        { ColTitle: "Split", ColType: "String" },
        { ColTitle: "Amount", ColType: "Money" },
        { ColTitle: "Balance", ColType: "Money" },
      ],
    },
    Rows: { Row: accountSections },
  };
}

function buildQuickbooksPayloadsFromGl({ reports, glEntries }) {
  const { startDate, endDate } = resolveGlDateRange(glEntries);
  return {
    [QUICKBOOKS_REPORT_TYPES.BALANCE_SHEET]: buildQuickbooksBalanceSheetReport(
      reports.balance_sheet,
      startDate,
      endDate
    ),
    [QUICKBOOKS_REPORT_TYPES.PROFIT_AND_LOSS]: buildQuickbooksProfitAndLossReport(
      reports.profit_and_loss,
      startDate,
      endDate
    ),
    [QUICKBOOKS_REPORT_TYPES.CASH_FLOW]: buildQuickbooksCashFlowReport(
      reports.cash_flow,
      startDate,
      endDate
    ),
    [QUICKBOOKS_REPORT_TYPES.GENERAL_LEDGER]: buildQuickbooksGeneralLedgerReport(
      glEntries,
      startDate,
      endDate
    ),
  };
}

async function getManualGlUploadRecord({ companyId, uploadId }) {
  const query = supabase
    .from("qb_synced_reports")
    .select("id, report_params, status, mapping, data, updated_at")
    .eq("company_id", companyId)
    .eq("report_type", MANUAL_GL_REPORT_TYPE)
    .eq("source", MANUAL_GL_SOURCE)
    .contains("report_params", { uploadId })
    .order("updated_at", { ascending: false })
    .limit(1);

  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(`Manual GL fetch failed: ${error.message}`);
  return data || null;
}

async function persistProcessedManualGl({
  companyId,
  uploadId,
  mapping,
  glEntries,
}) {
  const now = new Date().toISOString();
  const normalizedMapping = ensureMappingShape(mapping || {});
  const payload = {
    company_id: companyId,
    report_type: MANUAL_GL_REPORT_TYPE,
    report_params: { uploadId },
    data: {
      manual_gl: {
        companyId,
        source: MANUAL_GL_SOURCE,
        uploadId,
        status: "processed",
        mapping: normalizedMapping,
        glEntries,
        processedAt: now,
      },
    },
    source: MANUAL_GL_SOURCE,
    status: "processed",
    mapping: normalizedMapping,
    last_synced_at: now,
    updated_at: now,
  };

  const { data, error } = await supabase
    .from("qb_synced_reports")
    .upsert(payload, { onConflict: "company_id,report_type,report_params" })
    .select()
    .single();

  if (error) throw new Error(`Failed to save processed data: ${error.message}`);
  return data;
}

async function persistGeneratedReports({ companyId, uploadId, mapping, reports, glEntries = [] }) {
  const now = new Date().toISOString();
  const normalizedMapping = ensureMappingShape(mapping || {});
  const statements = [
    ["balance_sheet", reports.balance_sheet],
    ["profit_and_loss", reports.profit_and_loss],
    ["cash_flow", reports.cash_flow],
  ];

  for (const [statementType, report] of statements) {
    const { error } = await supabase
      .from("qb_synced_reports")
      .upsert(
        {
          company_id: companyId,
          report_type: MANUAL_GL_GENERATED_REPORT_TYPE,
          report_params: { uploadId, statementType },
          data: {
            manual_gl_report: {
              uploadId,
              statementType,
              source: MANUAL_GL_SOURCE,
              mapping: normalizedMapping,
              generatedAt: now,
              report,
            },
          },
          source: MANUAL_GL_SOURCE,
          status: "generated",
          mapping: normalizedMapping,
          last_synced_at: now,
          updated_at: now,
        },
        { onConflict: "company_id,report_type,report_params" }
      );

    if (error) throw new Error(`Failed to save ${statementType}: ${error.message}`);
  }

  const quickbooksPayloads = buildQuickbooksPayloadsFromGl({ reports, glEntries });
  for (const [reportType, payload] of Object.entries(quickbooksPayloads)) {
    const { error } = await supabase
      .from("qb_synced_reports")
      .upsert(
        {
          company_id: companyId,
          report_type: reportType,
          report_params: { manualUploadId: uploadId },
          data: payload,
          source: MANUAL_GL_SOURCE,
          status: "generated",
          mapping: normalizedMapping,
          last_synced_at: now,
          updated_at: now,
        },
        { onConflict: "company_id,report_type,report_params" }
      );

    if (error) {
      throw new Error(`Failed to save QuickBooks-compatible ${reportType}: ${error.message}`);
    }
  }
}

async function loadUpload(uploadId) {
  const { data: upload, error } = await supabase
    .from("uploads")
    .select("id, file_name, content_type, data")
    .eq("id", uploadId)
    .maybeSingle();

  if (error) throw new Error(`Upload read failed: ${error.message}`);
  if (!upload) throw new Error("Upload not found");
  return upload;
}

async function generateManualGlReports({ companyId, uploadId, mapping = {} }) {
  if (!companyId) throw new Error("companyId is required");
  if (!uploadId) throw new Error("uploadId is required");

  let glEntries = [];
  let resolvedMapping = null;

  const existing = await getManualGlUploadRecord({ companyId, uploadId });
  if (existing?.data?.manual_gl?.glEntries?.length) {
    glEntries = existing.data.manual_gl.glEntries;
    resolvedMapping = ensureMappingShape({ ...(existing.mapping || {}), ...(mapping || {}) });
  } else {
    const upload = await loadUpload(uploadId);
    const { rows, columns, rowNumbers } = parseManualGlSheet(
      upload,
      "No data rows found in upload. Ensure the first sheet has tabular rows with headers."
    );
    const autoDetection = autoDetectManualGlMapping({ columns, rows, mapping });
    resolvedMapping = ensureMappingShape(autoDetection.mapping);
    const readiness = validateMappingForAutoProcess(resolvedMapping, autoDetection.confidence);
    if (!readiness.isValid) {
      throw new Error(
        `Auto mapping confidence is low or required fields are missing. Missing: ${readiness.missing.join(", ") || "none"}, Low confidence: ${readiness.lowConfidence.join(", ") || "none"}`
      );
    }
    const normalized = normalizeManualGlRows({
      rows,
      rowNumbers,
      resolvedMapping,
      rawMapping: { ...mapping, __autoMappingConfidence: autoDetection.confidence },
    });
    if (!normalized.glEntries.length) {
      throw new Error("No valid GL rows found after normalization.");
    }
    if (normalized.errors.length) {
      console.warn("[ManualGL] Auto processing skipped invalid rows:", normalized.errors.slice(0, 10));
    }
    glEntries = normalized.glEntries;
    await persistProcessedManualGl({ companyId, uploadId, mapping: resolvedMapping, glEntries });
  }

  const reports = buildFinancialReportsFromGl(glEntries);
  await persistGeneratedReports({ companyId, uploadId, mapping: resolvedMapping, reports, glEntries });
  await upsertManualGlUpload({ companyId, uploadId, status: "generated", mapping: resolvedMapping });

  return { uploadId, mapping: resolvedMapping, reports };
}

async function getLatestGeneratedManualGlReport({ companyId, statementType, uploadId = "" }) {
  const normalizedType = normalizeStatementType(statementType);
  let query = supabase
    .from("qb_synced_reports")
    .select("id, report_params, data, updated_at, mapping")
    .eq("company_id", companyId)
    .eq("report_type", MANUAL_GL_GENERATED_REPORT_TYPE)
    .eq("source", MANUAL_GL_SOURCE)
    .contains("report_params", { statementType: normalizedType });

  if (uploadId) query = query.contains("report_params", { uploadId });

  const { data, error } = await query.order("updated_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error(`Generated report fetch failed: ${error.message}`);
  return data || null;
}

async function getLatestManualGlQuickbooksReport({ companyId, statementType }) {
  const reportType = normalizeStatementType(statementType);
  const { data, error } = await supabase
    .from("qb_synced_reports")
    .select("id, report_type, report_params, data, updated_at, mapping")
    .eq("company_id", companyId)
    .eq("report_type", reportType)
    .eq("source", MANUAL_GL_SOURCE)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Manual GL QuickBooks report fetch failed: ${error.message}`);
  return data || null;
}

async function getManualGlColumns(uploadId) {
  const upload = await loadUpload(uploadId);
  const { rows, columns } = parseManualGlSheet(upload, "No data rows found in upload.");
  const preview = rows.slice(0, 20);
  const autoDetection = autoDetectManualGlMapping({ columns, rows, mapping: {} });
  return {
    columns,
    preview,
    autoMapping: autoDetection.mapping,
    autoDetection: {
      canAutoProcess: autoDetection.canAutoProcess,
      missingRequired: autoDetection.missingRequired,
      lowConfidenceFields: autoDetection.lowConfidenceFields,
      confidence: autoDetection.confidence,
    },
  };
}

async function processManualGlData({ companyId, uploadId, mapping = {} }) {
  if (!companyId) throw new Error("companyId is required");
  if (!uploadId) throw new Error("uploadId is required");

  const upload = await loadUpload(uploadId);
  const { rows, columns, rowNumbers } = parseManualGlSheet(upload, "No data rows found in upload.");

  const autoDetection = autoDetectManualGlMapping({ columns, rows, mapping });
  const resolvedMapping = ensureMappingShape(autoDetection.mapping);
  const readiness = validateMappingForAutoProcess(resolvedMapping, autoDetection.confidence);
  if (!readiness.isValid) {
    return {
      success: false,
      requiresManualMapping: true,
      autoMapping: resolvedMapping,
      autoDetection: {
        confidence: autoDetection.confidence,
        missingRequired: readiness.missing,
        lowConfidenceFields: readiness.lowConfidence,
      },
      errors: [
        {
          row: 0,
          message: `Required columns missing/low confidence. Missing: ${readiness.missing.join(", ") || "none"}, Low confidence: ${readiness.lowConfidence.join(", ") || "none"}`,
        },
      ],
    };
  }

  const normalized = normalizeManualGlRows({
    rows,
    rowNumbers,
    resolvedMapping,
    rawMapping: { ...mapping, __autoMappingConfidence: autoDetection.confidence },
  });
  if (!normalized.glEntries.length) {
    return {
      success: false,
      requiresManualMapping: true,
      autoMapping: resolvedMapping,
      autoDetection: {
        confidence: autoDetection.confidence,
        missingRequired: [],
        lowConfidenceFields: [],
      },
      errors: [{ row: 0, message: "No valid rows found after normalization. Please confirm mapping." }],
    };
  }

  if (normalized.errors.length > 0) {
    console.warn("Manual GL skipped invalid rows (first 10):", normalized.errors.slice(0, 10));
  }

  const persisted = await persistProcessedManualGl({
    companyId,
    uploadId,
    mapping: resolvedMapping,
    glEntries: normalized.glEntries,
  });

  const reports = buildFinancialReportsFromGl(normalized.glEntries);
  await persistGeneratedReports({
    companyId,
    uploadId,
    mapping: resolvedMapping,
    reports,
    glEntries: normalized.glEntries,
  });

  await upsertManualGlUpload({
    companyId,
    uploadId,
    status: "processed",
    mapping: resolvedMapping,
  });

  return {
    success: true,
    data: persisted,
    reports,
    autoMapping: resolvedMapping,
    autoDetection: {
      confidence: autoDetection.confidence,
      missingRequired: [],
      lowConfidenceFields: [],
    },
    warnings: normalized.errors.slice(0, 100),
    skippedRows: normalized.errors.length,
  };
}

module.exports = {
  upsertManualGlUpload,
  listManualGlUploads,
  generateManualGlReports,
  getLatestGeneratedManualGlReport,
  getLatestManualGlQuickbooksReport,
  getManualGlColumns,
  processManualGlData,
};
