const crypto = require("crypto");
const XLSX = require("xlsx");
const { supabase } = require("../db");
const {
  REPORT_SOURCE_KEYS,
  updateReportSourceRecord,
} = require("./reportSourceStore");

const TABLES = {
  batches: "manual_gl_batches",
  transactions: "manual_gl_staged_transactions",
  balanceSheetLines: "manual_gl_balance_sheet_lines",
};

const SHEET_TYPE = {
  STARTING: "STARTING",
  ENDING: "ENDING",
};

const REQUIRED_GL_MAPPING_FIELDS = ["date", "account_name"];
const OPTIONAL_GL_MAPPING_FIELDS = [
  "account_number",
  "account_type",
  "amount",
  "debit",
  "credit",
  "description",
  "reference",
  "transaction_type",
  "journal_type",
  "class",
  "department",
  "location",
  "category",
  "sub_category",
];

const MAPPING_CANDIDATES = {
  date: ["transaction date", "posting date", "date"],
  account_name: ["distribution account", "account name", "account"],
  account_number: ["account number", "acct number", "account #", "gl code"],
  account_type: ["account type", "type"],
  amount: ["amount", "split amount", "signed amount", "net amount"],
  debit: ["debit", "dr"],
  credit: ["credit", "cr"],
  description: ["memo/description", "description", "memo", "narration"],
  reference: ["num", "reference", "ref", "transaction id", "document"],
  transaction_type: ["transaction type", "entry type", "type"],
  journal_type: ["journal type", "transaction type", "type"],
  class: ["class"],
  department: ["department"],
  location: ["location"],
  category: ["category"],
  sub_category: ["sub category", "subcategory"],
};

const BALANCE_EPSILON = 0.01;
const DEFAULT_STAGING_LIMIT = 200000;
const MANUAL_SOURCE_KEY = REPORT_SOURCE_KEYS.MANUAL_GL;

function isMissingColumnError(error, columnName = "") {
  if (!error) return false;
  const message = String(error.message || "").toLowerCase();
  if (!message.includes("column")) return false;
  if (!columnName) return true;
  return message.includes(String(columnName).toLowerCase());
}

function isConflictTargetError(error) {
  const message = String(error?.message || "").toLowerCase();
  return message.includes("no unique or exclusion constraint matching the on conflict specification");
}

function parseBoolean(value) {
  return value === true || value === "true" || value === 1 || value === "1";
}

function isValidUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || "").trim(),
  );
}

function toNonEmptyString(value, fallback = "") {
  const text = String(value || "").trim();
  return text || fallback;
}

function normalizeKey(val) {
  return String(val || "").trim().toLowerCase();
}

function roundMoney(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Retries a Supabase operation with exponential backoff.
 * Useful for handling rate limits or temporary connection issues during large uploads.
 */
async function retrySupabaseOperation(operation, maxRetries = 3, initialDelay = 1000) {
  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    try {
      const result = await operation();
      if (result.error) throw result.error;
      return result;
    } catch (error) {
      lastError = error;
      const isRetryable = error.status === 429 || error.status === 503 || error.status === 504 || error.message?.includes("timeout") || error.message?.includes("rate limit");
      if (!isRetryable && attempt === 0) throw error; // If not retryable, fail fast on first attempt
      
      const delay = initialDelay * Math.pow(2, attempt);
      console.warn(`[ManualGL][Retry] Attempt ${attempt + 1} failed. Retrying in ${delay}ms...`, error.message);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
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
    const decodedBase64 = Buffer.from(value, "base64");
    return decodeSerializedBufferJson(decodedBase64) || decodedBase64;
  }

  return Buffer.from(String(data));
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

  let cleaned = raw
    .replace(/[$,\s]/g, "")
    .replace(/\((.*)\)/, "-$1")
    .replace(/^[=]/, "")
    .replace(/\.{2,}/g, "");

  if (/dr$/i.test(cleaned)) cleaned = `-${cleaned.replace(/dr$/i, "")}`;
  if (/cr$/i.test(cleaned)) cleaned = cleaned.replace(/cr$/i, "");

  if (!cleaned) return { value: 0, isPresent: false, isValid: true };

  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) {
    return { value: 0, isPresent: true, isValid: false };
  }

  return { value: parsed, isPresent: true, isValid: true };
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

function toIsoDate(value) {
  const date = value instanceof Date ? value : parseDateFlexible(value);
  if (!date || Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function detectHeaderRowIndex(rawRows) {
  if (!Array.isArray(rawRows) || !rawRows.length) return 0;

  let bestIndex = 0;
  let bestScore = Number.NEGATIVE_INFINITY;
  const maxRows = Math.min(rawRows.length, 60);

  for (let index = 0; index < maxRows; index += 1) {
    const row = Array.isArray(rawRows[index]) ? rawRows[index] : [];
    const keys = row.map((value) => normalizeKey(value)).filter(Boolean);
    if (!keys.length) continue;

    const uniqueCount = new Set(keys).size;
    const hasDate = keys.some((key) => key.includes("date"));
    const hasAccount = keys.some((key) => key.includes("account") || key.includes("distribution"));
    const hasAmounts = keys.some((key) => key.includes("amount") || key.includes("debit") || key.includes("credit") || key.includes("balance"));

    let score = 0;
    if (hasDate) score += 4;
    if (hasAccount) score += 4;
    if (hasAmounts) score += 3;
    score += Math.min(uniqueCount, 10) * 0.2;
    if (keys.length === 1) score -= 2;

    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }

  return bestScore >= 4 ? bestIndex : 0;
}

function parseWorksheet(sheetName, sheet) {
  const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, blankrows: false });
  if (!Array.isArray(rawRows) || rawRows.length === 0) {
    return null;
  }

  const headerRowIndex = detectHeaderRowIndex(rawRows);
  const headerRow = Array.isArray(rawRows[headerRowIndex]) ? rawRows[headerRowIndex] : [];
  const dataRows = rawRows.slice(headerRowIndex + 1);

  const sampledWidths = [headerRow.length];
  for (let i = 0; i < Math.min(dataRows.length, 300); i += 1) {
    sampledWidths.push(Array.isArray(dataRows[i]) ? dataRows[i].length : 0);
  }
  const width = Math.max(...sampledWidths, 0);

  const headers = [];
  const used = new Set();
  for (let col = 0; col < width; col += 1) {
    const base = String(headerRow[col] || "").trim() || `Column ${col + 1}`;
    let name = base;
    let suffix = 2;
    while (used.has(name)) {
      name = `${base} (${suffix})`;
      suffix += 1;
    }
    used.add(name);
    headers.push(name);
  }

  const rows = [];
  const rowNumbers = [];
  dataRows.forEach((row, offset) => {
    const values = Array.isArray(row) ? row : [];
    const mapped = {};
    let hasValue = false;
    headers.forEach((header, idx) => {
      const value = idx < values.length ? values[idx] : null;
      mapped[header] = value;
      if (value !== null && value !== undefined && String(value).trim() !== "") {
        hasValue = true;
      }
    });
    if (hasValue) {
      rows.push(mapped);
      rowNumbers.push(headerRowIndex + offset + 2);
    }
  });

  if (!rows.length) return null;

  return {
    sheetName,
    rawRows,
    headerRowIndex,
    headers,
    rows,
    rowNumbers,
  };
}

function scoreSheetForGl(sheetData) {
  if (!sheetData) return 0;
  const headerText = sheetData.headers.map((header) => normalizeKey(header)).join(" ");
  const previewText = sheetData.rows
    .slice(0, 60)
    .map((row) => Object.values(row).map((value) => normalizeKey(value)).join(" "))
    .join(" ");
  const text = `${headerText} ${previewText}`;

  let score = 0;
  if (text.includes("general ledger")) score += 3;
  if (text.includes("transaction date") || text.includes("posting date")) score += 3;
  if (text.includes("distribution account") || text.includes("account")) score += 3;
  if (text.includes("debit") || text.includes("credit") || text.includes("amount")) score += 2;
  if (text.includes("balance")) score += 1;
  score += Math.min(sheetData.rows.length / 300, 2);
  return score;
}

function scoreSheetForBalanceSheet(sheetData) {
  if (!sheetData) return 0;
  const headerText = sheetData.headers.map((header) => normalizeKey(header)).join(" ");
  const previewText = sheetData.rows
    .slice(0, 120)
    .map((row) => Object.values(row).map((value) => normalizeKey(value)).join(" "))
    .join(" ");
  const text = `${headerText} ${previewText}`;

  let score = 0;
  if (text.includes("balance sheet")) score += 5;
  if (text.includes("assets")) score += 2;
  if (text.includes("liabilities")) score += 2;
  if (text.includes("equity")) score += 2;
  if (text.includes("retained earnings")) score += 1;
  return score;
}

function selectBalanceSheetSheet(sheets = [], targetType = SHEET_TYPE.STARTING) {
  if (!Array.isArray(sheets) || sheets.length === 0) return null;

  const keywordSets = {
    [SHEET_TYPE.STARTING]: ["starting", "opening", "beginning", "start"],
    [SHEET_TYPE.ENDING]: ["ending", "closing", "end"],
  };
  const preferredKeywords = keywordSets[targetType] || [];

  const scored = sheets
    .map((sheet) => {
      const baseScore = scoreSheetForBalanceSheet(sheet);
      const nameKey = normalizeKey(sheet?.sheetName || "");
      const keywordBonus = preferredKeywords.some((keyword) => nameKey.includes(keyword)) ? 5 : 0;
      return {
        sheet,
        score: baseScore + keywordBonus,
        baseScore,
        keywordBonus,
      };
    })
    .sort((a, b) => b.score - a.score);

  return scored[0]?.sheet || null;
}

function parseWorkbook(upload) {
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
    throw new Error(`Unable to parse "${upload.file_name || upload.id}": ${error.message}`);
  }

  const parsedSheets = workbook.SheetNames
    .map((sheetName) => parseWorksheet(sheetName, workbook.Sheets[sheetName]))
    .filter(Boolean);

  if (!parsedSheets.length) {
    throw new Error("No readable worksheets found in upload.");
  }

  return parsedSheets;
}

function inferFiscalYearFromText(value) {
  const text = String(value || "");
  const matches = text.match(/(19|20)\d{2}/g);
  if (!matches || !matches.length) return null;
  const years = matches
    .map((item) => Number(item))
    .filter((year) => year >= 1900 && year <= 2100);
  if (!years.length) return null;
  return years[years.length - 1];
}

function inferFiscalYear({ upload, sheetData, fallback = null }) {
  const sheetYear = inferFiscalYearFromText(sheetData?.sheetName);
  if (sheetYear) return sheetYear;

  const titleRows = (sheetData?.rawRows || []).slice(0, Math.max(1, (sheetData?.headerRowIndex || 0) + 2));
  const titleText = titleRows.map((row) => (Array.isArray(row) ? row.join(" ") : "")).join(" ");
  const titleYear = inferFiscalYearFromText(titleText);
  if (titleYear) return titleYear;

  const fileYear = inferFiscalYearFromText(upload?.file_name);
  if (fileYear) return fileYear;

  return fallback;
}

function ensureMappingShape(mapping = {}) {
  const next = { ...mapping };
  [...REQUIRED_GL_MAPPING_FIELDS, ...OPTIONAL_GL_MAPPING_FIELDS].forEach((field) => {
    if (!Object.prototype.hasOwnProperty.call(next, field)) {
      next[field] = "";
    }
  });
  return next;
}

function resolveColumn(headers = [], provided = "", candidates = []) {
  if (provided && headers.includes(provided)) return provided;
  const normalized = headers.map((header) => ({ header, key: normalizeKey(header) }));
  for (const candidate of candidates) {
    const found = normalized.find((item) => item.key.includes(candidate));
    if (found) return found.header;
  }
  return "";
}

function resolveGlMapping(headers, mapping = {}) {
  const provided = ensureMappingShape(mapping);
  const resolved = {};

  Object.keys(MAPPING_CANDIDATES).forEach((field) => {
    resolved[field] = resolveColumn(headers, provided[field], MAPPING_CANDIDATES[field]);
  });

  const shaped = ensureMappingShape({
    ...resolved,
    ...Object.fromEntries(
      Object.entries(provided).filter(([, value]) => Boolean(value))
    ),
  });

  return shaped;
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

function normalizeAccountType(type) {
  if (!type) return "";
  const t = String(type).toLowerCase().trim();
  if (t.includes("asset")) return "asset";
  if (t.includes("liability")) return "liability";
  if (t.includes("equity")) return "equity";
  if (t.includes("revenue") || t.includes("income")) return "income";
  if (t.includes("expense")) return "expense";
  if (t.includes("cogs") || t.includes("cost of goods")) return "cogs";
  return "";
}

function inferAccountType(accountName, accountNumber = "") {
  const name = String(accountName || "").toLowerCase();
  const num = String(accountNumber || "");

  // Bank/Asset keywords
  if (/\bcash\b|\bbank\b|\bchecking\b|\bsavings\b|\breceivable\b|\binventory\b|\basset\b|\bprepaid\b/.test(name)) return "asset";
  // Liability keywords
  if (/\bpayable\b|\bloan\b|\bliability\b|\bcredit card\b|\bvisa\b|\bmastercard\b|\bamex\b|\bdebt\b/.test(name)) return "liability";
  // Equity keywords
  if (/\bequity\b|\bcapital\b|\bdraw\b|\bretained earnings\b|\bowner\b/.test(name)) return "equity";
  // Income keywords
  if (/\bsales\b|\brevenue\b|\bincome\b|\bfee\b/.test(name)) return "income";
  // COGS keywords
  if (/\bcogs\b|\bcost of goods\b|\bdirect cost\b/.test(name)) return "cogs";
  // Expense keywords
  if (/\bexpense\b|\brent\b|\butilit\b|\bsalaries\b|\bwages\b|\btravel\b|\bmeals\b|\boffice\b/.test(name)) return "expense";

  // Account Number Range Heuristics (Common 1-6 range)
  if (num.startsWith("1")) return "asset";
  if (num.startsWith("2")) return "liability";
  if (num.startsWith("3")) return "equity";
  if (num.startsWith("4")) return "income";
  if (num.startsWith("5")) return "cogs";
  if (num.startsWith("6") || num.startsWith("7") || num.startsWith("8")) return "expense";

  return "expense"; // Default to expense
}

function isContraAccount(accountName, accountType) {
  const name = String(accountName || "").toLowerCase();
  // Contra-assets
  if (name.includes("accumulated depreciation") || name.includes("allowance for")) return true;
  // Contra-revenue
  if (name.includes("returns") || name.includes("allowances") || name.includes("discounts")) {
    const type = normalizeAccountType(accountType);
    if (type === "income") return true;
  }
  return false;
}

function inferProfitLossCategory(accountName, accountType) {
  const key = normalizeKey(accountName);
  const type = normalizeAccountType(accountType) || inferAccountType(accountName);

  if (type === "income") {
    return "Revenue";
  }

  if (type !== "expense") {
    return "";
  }

  if (
    key.includes("cost of goods") ||
    key.includes("cogs") ||
    key.includes("cost of sales")
  ) {
    return "COGS";
  }

  if (
    key.includes("interest expense") ||
    key.includes("other expense") ||
    key.includes("depreciation") ||
    key.includes("amortization") ||
    key.includes("income tax") ||
    key.includes("penalt") ||
    key.includes("loss")
  ) {
    return "Other Expenses";
  }

  return "Operating Expenses";
}

function inferProfitLossSubCategory(accountName, category) {
  const key = normalizeKey(accountName);
  if (category === "Revenue") {
    if (key.includes("interest")) return "Interest Income";
    if (key.includes("refund")) return "Refunds/Discounts";
    return "Operating Revenue";
  }
  if (category === "COGS") {
    return "Cost of Goods Sold";
  }
  if (category === "Other Expenses") {
    if (key.includes("interest")) return "Interest Expense";
    if (key.includes("depreciation") || key.includes("amortization")) return "Depreciation & Amortization";
    return "Other Non-Operating";
  }
  if (category === "Operating Expenses") {
    return "Operating Expenses";
  }
  return "";
}

function buildTransactionHash(parts) {
  // Use sourceFile as a strong differentiator for multi-file staging
  const raw = parts.map((p) => String(p || "").trim().toLowerCase()).join("|");
  return crypto.createHash("sha1").update(raw).digest("hex");
}

function buildCrossFileDedupHash(tx = {}) {
  return buildTransactionHash([
    String(tx.fiscalYear || ""),
    String(tx.date || ""),
    String(tx.accountNumber || ""),
    String(tx.accountName || ""),
    roundMoney(Number(tx.debit || 0)).toFixed(2),
    roundMoney(Number(tx.credit || 0)).toFixed(2),
    roundMoney(Number(tx.netAmount || 0)).toFixed(2),
    String(tx.class || ""),
    String(tx.department || ""),
    String(tx.location || ""),
    String(tx.transactionType || ""),
    String(tx.journalType || ""),
    String(tx.reference || ""),
    String(tx.description || ""),
  ]);
}

function deriveDebitCreditFromSignedAmount(amount, accountType, accountName = "") {
  const signedAmount = roundMoney(Number(amount || 0));
  if (signedAmount === 0) {
    return { debit: 0, credit: 0 };
  }

  const normalizedType = normalizeAccountType(accountType) || inferAccountType(accountName);
  const isContra = isContraAccount(accountName, normalizedType);
  const normalDebitType = ["asset", "expense", "cogs"].includes(normalizedType);
  const increaseIsDebit = isContra ? !normalDebitType : normalDebitType;
  const isIncrease = signedAmount > 0;
  const absoluteAmount = roundMoney(Math.abs(signedAmount));

  if (isIncrease === increaseIsDebit) {
    return { debit: absoluteAmount, credit: 0 };
  }
  return { debit: 0, credit: absoluteAmount };
}

function parseGlSheetTransactions({
  companyId,
  upload,
  sheetData,
  mapping,
  fiscalYearHint = null,
}) {
  const resolvedMapping = resolveGlMapping(sheetData.headers, mapping);
  const missingRequired = REQUIRED_GL_MAPPING_FIELDS.filter((field) => !resolvedMapping[field]);
  if (missingRequired.length) {
    return {
      success: false,
      requiresManualMapping: true,
      missingRequired,
      mapping: resolvedMapping,
      error: `Missing required mapping fields: ${missingRequired.join(", ")}`,
    };
  }

  const normalizedMap = Object.fromEntries(
    Object.entries(resolvedMapping).map(([key, value]) => [key, normalizeKey(value)])
  );

  const inferredYear = inferFiscalYear({
    upload,
    sheetData,
    fallback: fiscalYearHint,
  });

  console.log(
    `[ManualGL][MultiYear] Sheet: ${sheetData.sheetName} | Inferred Year: ${inferredYear} | Row count: ${sheetData.rows?.length || 0}`,
  );

  const transactions = [];
  const warnings = [];
  let lastAccountName = "";

  sheetData.rows.forEach((row, index) => {
    const rowNumber = sheetData.rowNumbers[index] || index + 2;
    const normalizedRow = Object.fromEntries(
      Object.entries(row).map(([key, value]) => [normalizeKey(key), value])
    );

    const rawDate = normalizedRow[normalizedMap.date];
    const rawAccountName = normalizedRow[normalizedMap.account_name];
    const rawAccountNumber = normalizedMap.account_number ? normalizedRow[normalizedMap.account_number] : null;
    const rawAccountType = normalizedMap.account_type ? normalizedRow[normalizedMap.account_type] : null;
    const rawAmount = normalizedMap.amount ? normalizedRow[normalizedMap.amount] : null;
    const rawDebit = normalizedMap.debit ? normalizedRow[normalizedMap.debit] : null;
    const rawCredit = normalizedMap.credit ? normalizedRow[normalizedMap.credit] : null;
    const rawDescription = normalizedMap.description ? normalizedRow[normalizedMap.description] : null;
    const rawReference = normalizedMap.reference ? normalizedRow[normalizedMap.reference] : null;
    const rawTransactionType = normalizedMap.transaction_type ? normalizedRow[normalizedMap.transaction_type] : null;
    const rawJournalType = normalizedMap.journal_type ? normalizedRow[normalizedMap.journal_type] : null;
    const rawClass = normalizedMap.class ? normalizedRow[normalizedMap.class] : null;
    const rawDepartment = normalizedMap.department ? normalizedRow[normalizedMap.department] : null;
    const rawLocation = normalizedMap.location ? normalizedRow[normalizedMap.location] : null;
    const rawCategory = normalizedMap.category ? normalizedRow[normalizedMap.category] : null;
    const rawSubCategory = normalizedMap.sub_category ? normalizedRow[normalizedMap.sub_category] : null;

    let accountName =
      rawAccountName === null || rawAccountName === undefined
        ? ""
        : String(rawAccountName).trim();
    if (!accountName && lastAccountName) {
      accountName = lastAccountName;
    }

    // Exclude summary rows from source exports.
    if (!accountName) return;
    lastAccountName = accountName;
    const isTotalRow =
      /^(total|subtotal|net income|gross profit|beginning balance|ending balance|balance forward)/i.test(
        accountName,
      ) || /\b(total|subtotal|balance forward)\b/i.test(accountName);
    if (isTotalRow) {
      return;
    }

    let parsedDate = parseDateFlexible(rawDate);
    const amountDetail = parseAmountDetail(rawAmount);
    const debitDetail = parseAmountDetail(rawDebit);
    const creditDetail = parseAmountDetail(rawCredit);

    const accountNumber = rawAccountNumber ? String(rawAccountNumber).trim() : "";
    const accountType = normalizeAccountType(rawAccountType) || inferAccountType(accountName, accountNumber);

    let debit = roundMoney(Math.abs(debitDetail.value));
    let credit = roundMoney(Math.abs(creditDetail.value));

    if (debit === 0 && credit === 0 && amountDetail.isPresent && amountDetail.isValid) {
      const derived = deriveDebitCreditFromSignedAmount(amountDetail.value, accountType, accountName);
      debit = derived.debit;
      credit = derived.credit;
    }

    const hasAmount = debit !== 0 || credit !== 0 || (amountDetail.isPresent && amountDetail.value !== 0);
    if (!accountName && !parsedDate && !hasAmount) return;

    if (!accountName) {
      warnings.push({ row: rowNumber, message: "Missing account name. Row skipped." });
      return;
    }

    if (!parsedDate) {
      warnings.push({ row: rowNumber, message: `Missing/invalid date for account "${accountName}". Row skipped.` });
      return;
    }

    if (!hasAmount) {
      return;
    }

    const isoDate = toIsoDate(parsedDate);
    // Derive year/month from the ISO date string rather than getUTCFullYear() / getUTCMonth().
    // Rationale: parseDateFlexible() creates Date objects in local time for non-ISO input
    // (e.g. "December 31, 2023"). toISOString() then converts to UTC, which can shift a
    // Dec-31 local-midnight to Jan-01 UTC in timezones behind UTC (EST, PST, etc.), causing
    // year-end transactions to land in the wrong fiscal year. Slicing the stored ISO string
    // is always consistent because toIsoDate() is already UTC-normalised.
    const fiscalYear = (isoDate ? Number(isoDate.slice(0, 4)) : 0) || inferredYear || fiscalYearHint || null;
    const fiscalMonth = isoDate ? Number(isoDate.slice(5, 7)) : null;
    const normalizedType = normalizeAccountType(accountType) || inferAccountType(accountName, accountNumber);
    const defaultCategory =
      ["income", "cogs", "expense"].includes(normalizedType)
        ? normalizeProfitLossCategory(rawCategory, accountName, normalizedType)
        : normalizeBalanceSheetCategory(rawCategory, accountName, normalizedType);
    const category = rawCategory ? String(rawCategory).trim() : defaultCategory;
    const subCategory = rawSubCategory
      ? String(rawSubCategory).trim()
      : inferProfitLossSubCategory(accountName, category);

    const transactionType = rawTransactionType ? String(rawTransactionType).trim() : "";
    const journalType = rawJournalType ? String(rawJournalType).trim() : transactionType;
    const sourceFile = String(upload.file_name || "").trim();
    const description = rawDescription ? String(rawDescription).trim() : "";
    const reference = rawReference ? String(rawReference).trim() : "";
    const rowTransactionId = `${upload.id}:${sheetData.sheetName}:${rowNumber}`;
    const netAmount = roundMoney(credit - debit);

    const transactionHash = buildTransactionHash([
      companyId,
      upload.id, // Absolute uniqueness per upload
      sourceFile,
      String(fiscalYear || ""),
      isoDate || "",
      accountName,
      accountNumber,
      netAmount,
      description,
      reference,
      transactionType,
      journalType,
      rowNumber,
    ]);

    transactions.push({
      transactionId: rowTransactionId,
      transactionHash,
      fiscalYear,
      date: isoDate,
      accountNumber,
      accountName,
      accountType: normalizedType ? normalizedType.charAt(0).toUpperCase() + normalizedType.slice(1) : "",
      category,
      subCategory,
      debit,
      credit,
      netAmount,
      class: rawClass ? String(rawClass).trim() : "",
      department: rawDepartment ? String(rawDepartment).trim() : "",
      location: rawLocation ? String(rawLocation).trim() : "",
      journalType,
      transactionType,
      reference,
      description,
      sourceFile,
      sourceUploadId: upload.id,
      rowNumber,
      metadata: {
        sheetName: sheetData.sheetName,
        inferredFiscalYear: inferredYear || null,
        fiscalMonth,
      },
    });
  });

  return {
    success: true,
    mapping: resolvedMapping,
    warnings,
    transactions,
  };
}

function sumAmounts(items = []) {
  return roundMoney(items.reduce((sum, item) => sum + roundMoney(Number(item.amount || 0)), 0));
}

function parseBalanceSheetFromSheet(sheetData) {
  const rows = Array.isArray(sheetData.rawRows) ? sheetData.rawRows : [];
  if (!rows.length) {
    throw new Error("Balance Sheet parsing failed: file has no readable rows.");
  }

  let currentSection = "";
  let currentMajorGroup = "";
  let currentMinorGroup = "";
  const parsed = {
    asOfDate: null,
    assets: [],
    liabilities: [],
    equity: [],
  };

  const asOfText = rows
    .slice(0, 25)
    .map((row) => (Array.isArray(row) ? row.join(" ") : ""))
    .join(" ");
  const asOfMatch = asOfText.match(/as\s+of\s+([A-Za-z0-9,\-/ ]{4,60})/i);
  if (asOfMatch?.[1]) {
    parsed.asOfDate = toIsoDate(asOfMatch[1]);
  }

  rows.forEach((row, rowIndex) => {
    const values = Array.isArray(row) ? row : [];
    if (!values.length) return;

    const label = String(
      values.find((value) => /[A-Za-z]/.test(String(value || ""))) || ""
    ).trim();
    const key = normalizeKey(label);
    if (!key) return;

    if (key === "assets" || key.startsWith("assets ")) {
      currentSection = "assets";
      currentMajorGroup = "";
      currentMinorGroup = "";
      return;
    }
    if (key.includes("liabilit") && !key.includes("liabilities and equity")) {
      currentSection = "liabilities";
      currentMajorGroup = "";
      currentMinorGroup = "";
      return;
    }
    if (key.includes("equity") || key.includes("stockholder") || key.includes("shareholder")) {
      currentSection = "equity";
      currentMajorGroup = "";
      currentMinorGroup = "";
      return;
    }

    if (!currentSection || key.includes("as of") || key.startsWith("total")) return;

    let amount = null;
    for (let i = values.length - 1; i >= 0; i -= 1) {
      const parsedAmount = parseAmountDetail(values[i]);
      if (parsedAmount.isPresent && parsedAmount.isValid) {
        amount = parsedAmount.value;
        break;
      }
    }

    if (amount === null || !Number.isFinite(amount)) {
      if (currentSection === "assets") {
        if (key.includes("current assets")) {
          currentMajorGroup = "Current Assets";
          currentMinorGroup = "";
        } else if (key.includes("fixed assets")) {
          currentMajorGroup = "Fixed Assets";
          currentMinorGroup = "";
        } else if (key.includes("other assets")) {
          currentMajorGroup = "Other Assets";
          currentMinorGroup = "";
        } else if (currentMajorGroup === "Current Assets") {
          if (key.includes("bank")) currentMinorGroup = "Bank Accounts";
          if (key.includes("other current")) currentMinorGroup = "Other Current Assets";
        }
      } else if (currentSection === "liabilities") {
        if (key.includes("current liabilities")) {
          currentMajorGroup = "Current Liabilities";
          currentMinorGroup = "";
        } else if (key.includes("long-term liabilities") || key.includes("long term liabilities")) {
          currentMajorGroup = "Long-Term Liabilities";
          currentMinorGroup = "";
        } else if (currentMajorGroup === "Current Liabilities") {
          if (key.includes("credit card")) currentMinorGroup = "Credit Cards";
          if (key.includes("other current")) currentMinorGroup = "Other Current Liabilities";
        }
      } else if (currentSection === "equity") {
        if (key.includes("retained")) currentMajorGroup = "Retained Earnings";
        else if (key.includes("net income")) currentMajorGroup = "Net Income";
        else if (key.includes("owner") || key.includes("capital") || key.includes("equity")) currentMajorGroup = "Owner Equity";
      }
      return;
    }

    if (key.startsWith("accrual basis")) return;

    const accountType =
      currentSection === "assets"
        ? "asset"
        : currentSection === "liabilities"
          ? "liability"
          : "equity";
    const inferredGrouping = resolveBalanceSheetGrouping(label, accountType, "");

    let majorGroup = currentMajorGroup || inferredGrouping.majorGroup || "";
    let minorGroup = currentMinorGroup || inferredGrouping.minorGroup || "";
    // Use structural BS header context (currentMajorGroup/currentMinorGroup) to derive
    // leafCategory when available — prevents "Truck" under "Fixed Assets" header from
    // being re-classified as "Other Current Assets" by keyword inference.
    let leafCategory;
    if (
      currentMajorGroup === "Fixed Assets" ||
      currentMajorGroup === "Other Assets" ||
      currentMajorGroup === "Long-Term Liabilities"
    ) {
      leafCategory = currentMajorGroup;
    } else if (currentMinorGroup) {
      leafCategory = currentMinorGroup;
    } else {
      leafCategory = inferredGrouping.leafCategory || "";
    }

    if (currentSection === "equity") {
      if (key.includes("retained")) {
        majorGroup = "Retained Earnings";
        leafCategory = "Retained Earnings";
      } else if (key.includes("net income")) {
        majorGroup = "Net Income";
        leafCategory = "Net Income";
      } else if (!majorGroup) {
        majorGroup = "Owner Equity";
        leafCategory = "Owner Equity";
      }
    }

    if (!leafCategory) {
      leafCategory = minorGroup || majorGroup || normalizeBalanceSheetCategory("", label, accountType);
    }

    parsed[currentSection].push({
      name: label,
      amount: roundMoney(amount),
      rowNumber: rowIndex + 1,
      majorGroup,
      minorGroup,
      leafCategory,
    });
  });

  if (!parsed.asOfDate) {
    const firstDate = rows
      .slice(0, 30)
      .flat()
      .map((value) => toIsoDate(value))
      .find(Boolean);
    parsed.asOfDate = firstDate || null;
  }

  return parsed;
}

function buildBalanceSheetLineHash(line) {
  return buildTransactionHash([
    line.batch_id || "",
    normalizeKey(line.section),
    normalizeKey(line.account_name),
    roundMoney(line.amount).toFixed(2),
    line.as_of_date || "",
  ]);
}

function toBalanceSheetLineRows({
  companyId,
  batchId,
  upload,
  sheetType,
  parsed,
  sourceType = MANUAL_SOURCE_KEY,
  sourceSwitchVersion = null,
  uploadSessionId = null,
  stagedAt = new Date().toISOString(),
}) {
  const sections = ["assets", "liabilities", "equity"];
  const rows = [];
  sections.forEach((section) => {
    (parsed[section] || []).forEach((item) => {
      const row = {
        company_id: companyId,
        batch_id: batchId,
        sheet_type: sheetType,
        as_of_date: parsed.asOfDate || null,
        section,
        account_name: String(item.name || "").trim(),
        amount: roundMoney(Number(item.amount || 0)),
        source_file: String(upload.file_name || ""),
        source_upload_id: upload.id,
        row_number: Number(item.rowNumber || null),
        source_type: sourceType || MANUAL_SOURCE_KEY,
        source_switch_version: sourceSwitchVersion || null,
        upload_session_id: uploadSessionId && isValidUuid(uploadSessionId) ? uploadSessionId : null,
        staged_at: stagedAt,
        metadata: {
          source: "manual_balance_sheet_upload",
          majorGroup: item.majorGroup || null,
          minorGroup: item.minorGroup || null,
          leafCategory: item.leafCategory || null,
        },
      };
      row.line_hash = buildBalanceSheetLineHash(row);
      rows.push(row);
    });
  });
  return rows;
}

function totalsFromBalanceSheetLines(lines = []) {
  const assets = lines.filter((line) => line.section === "assets");
  const liabilities = lines.filter((line) => line.section === "liabilities");
  const equity = lines.filter((line) => line.section === "equity");

  const totalAssets = sumAmounts(assets);
  const totalLiabilities = sumAmounts(liabilities);
  const totalEquity = sumAmounts(equity);
  const expectedAssets = roundMoney(totalLiabilities + totalEquity);
  const difference = roundMoney(totalAssets - expectedAssets);

  return {
    totalAssets,
    totalLiabilities,
    totalEquity,
    expectedAssets,
    difference,
    isBalanced: Math.abs(difference) <= BALANCE_EPSILON,
  };
}

function normalizeAccountLabel(value) {
  // Normalize account name for BS lookup matching. Applied identically when building
  // the lookup map (from BS sheet) and when looking up GL accounts, so minor formatting
  // differences between the two sources never cause false misses.
  //
  // Stripping order matters:
  //   1. normalizeKey → lowercase, trim
  //   2. Strip pipe separators ("Bank of America | Checking" → "bank of america checking")
  //   3. Strip account-number suffixes like "x7890" or "#7890" BEFORE the generic
  //      non-alphanumeric sweep, so the surrounding space collapse removes the gap.
  //   4. Strip 4+ digit standalone numbers that are account codes not part of the name.
  //   5. Generic non-alphanumeric → space (handles &, /, -, etc.)
  //   6. Remove filler conjunctions so "Cash & Cash Equivalents" = "Cash and Cash Equivalents".
  //   7. Collapse whitespace.
  return normalizeKey(value)
    .replace(/\|/g, " ")                  // pipe separators → space
    .replace(/\bx\d+\b/g, "")            // "x7890" account-number suffixes
    .replace(/#\d+\b/g, "")              // "#1234" account-number suffixes
    .replace(/\b\d{4,}\b/g, "")          // standalone 4+ digit codes (e.g. "1010")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\band\b|\bor\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildAmountByAccount(lines = []) {
  const map = new Map();
  lines.forEach((line) => {
    const key = normalizeAccountLabel(line.account_name);
    if (!key) return;
    map.set(key, roundMoney(Number(line.amount || 0)));
  });
  return map;
}

function computeBalanceSheetRollforwardValidation({
  startingLines = [],
  endingLines = [],
  transactions = [],
  profitLossSummary = null,
}) {
  const hasStartingSheet = startingLines.length > 0;
  const hasEndingSheet = endingLines.length > 0;
  const missingSheets = [
    ...(hasStartingSheet ? [] : [SHEET_TYPE.STARTING]),
    ...(hasEndingSheet ? [] : [SHEET_TYPE.ENDING]),
  ];

  const startTotals = totalsFromBalanceSheetLines(startingLines);
  const endTotals = totalsFromBalanceSheetLines(endingLines);

  const startMap = buildAmountByAccount(startingLines);
  const endMap = buildAmountByAccount(endingLines);
  const activityMap = new Map();

  transactions.forEach((tx) => {
    const accountType = normalizeAccountType(tx.accountType) || inferAccountType(tx.accountName, tx.accountNumber);
    if (!["asset", "liability", "equity"].includes(accountType)) return;
    const key = normalizeAccountLabel(tx.accountName);
    if (!key) return;

    const contra = isContraAccount(tx.accountName, accountType);
    const netAmount = roundMoney(Number(tx.netAmount || 0)); // credit - debit
    let delta = accountType === "asset" ? -netAmount : netAmount;
    if (contra) delta = -delta;
    delta = roundMoney(delta);
    activityMap.set(key, roundMoney((activityMap.get(key) || 0) + delta));
  });

  const allKeys = new Set([...startMap.keys(), ...endMap.keys(), ...activityMap.keys()]);
  const mismatches = [];
  const missingInEnding = [];
  const missingInStarting = [];

  allKeys.forEach((key) => {
    const opening = roundMoney(startMap.get(key) || 0);
    const activity = roundMoney(activityMap.get(key) || 0);
    const expectedClosing = roundMoney(opening + activity);
    const actualClosing = roundMoney(endMap.get(key) || 0);
    const variance = roundMoney(actualClosing - expectedClosing);

    if (!endMap.has(key)) {
      missingInEnding.push({ account: key, opening, activity, expectedClosing });
    }
    if (!startMap.has(key)) {
      missingInStarting.push({ account: key, actualClosing });
    }

    if (Math.abs(variance) > BALANCE_EPSILON) {
      mismatches.push({
        account: key,
        opening,
        activity,
        expectedClosing,
        actualClosing,
        variance,
      });
    }
  });

  const netIncome = roundMoney(
    Number(profitLossSummary?.totals?.netProfitConsolidated || 0)
  );
  const openingBalance = roundMoney(startTotals.totalAssets - startTotals.totalLiabilities);
  const closingBalance = roundMoney(endTotals.totalAssets - endTotals.totalLiabilities);
  const adjustments = roundMoney(closingBalance - openingBalance - netIncome);

  const equationVariance = roundMoney(
    openingBalance + netIncome + adjustments - closingBalance
  );

  const isEquationValid =
    hasStartingSheet &&
    hasEndingSheet &&
    Math.abs(equationVariance) <= BALANCE_EPSILON;

  return {
    openingBalance,
    closingBalance,
    netIncome,
    adjustments,
    equationVariance,
    missingSheets,
    hasStartingSheet,
    hasEndingSheet,
    isComplete: hasStartingSheet && hasEndingSheet,
    startTotals,
    endTotals,
    mismatches,
    missingInEnding,
    missingInStarting,
    isBalanced: startTotals.isBalanced && endTotals.isBalanced,
    isEquationValid,
    isValid:
      hasStartingSheet &&
      hasEndingSheet &&
      startTotals.isBalanced &&
      endTotals.isBalanced &&
      isEquationValid &&
      mismatches.length === 0,
  };
}

async function loadUpload(uploadId) {
  const { data, error } = await supabase
    .from("uploads")
    .select("id, file_name, content_type, data")
    .eq("id", uploadId)
    .maybeSingle();

  if (error) throw new Error(`Upload read failed: ${error.message}`);
  if (!data) throw new Error(`Upload not found: ${uploadId}`);
  return data;
}

async function loadCompanySourceContext(companyId) {
  if (!companyId) {
    return {
      sourceSwitchVersion: new Date().toISOString(),
      sourceType: MANUAL_SOURCE_KEY,
      wasManualActive: false,
      activeSource: null,
    };
  }

  const now = new Date().toISOString();
  const { data: company, error } = await supabase
    .from("companies")
    .select("id, data_source_type, quickbooks_connected, manual_upload_active, last_source_switch_at, updated_at")
    .eq("id", companyId)
    .maybeSingle();

  if (error && error.code !== "PGRST116") {
    throw new Error(`Failed to load company source state: ${error.message}`);
  }

  const currentSource = String(company?.data_source_type || "").trim();
  const isManualActive = currentSource === MANUAL_SOURCE_KEY;
  const sourceSwitchVersion =
    company?.last_source_switch_at ||
    company?.updated_at ||
    now;

  return {
    sourceSwitchVersion,
    sourceType: MANUAL_SOURCE_KEY,
    wasManualActive: isManualActive && company?.manual_upload_active === true,
    activeSource: currentSource || null,
  };
}

async function createBatch({
  companyId,
  createdBy = null,
  batchName = "",
  sourceType = MANUAL_SOURCE_KEY,
  sourceSwitchVersion = null,
  uploadSessionId = null,
}) {
  const now = new Date().toISOString();
  const normalizedSessionId =
    uploadSessionId && isValidUuid(uploadSessionId)
      ? uploadSessionId
      : crypto.randomUUID();
  const normalizedVersion = sourceSwitchVersion || now;
  const basePayload = {
    company_id: companyId,
    source: "manual_gl",
    status: "processing",
    batch_name: batchName || `manual-gl-${now.slice(0, 10)}`,
    created_by: createdBy || null,
    metadata: {
      createdFrom: "manual_gl_multi_year",
      sourceType: sourceType || MANUAL_SOURCE_KEY,
      sourceSwitchVersion: normalizedVersion,
      uploadSessionId: normalizedSessionId,
    },
    updated_at: now,
  };

  let payload = {
    ...basePayload,
    source_type: sourceType || MANUAL_SOURCE_KEY,
    source_switch_version: normalizedVersion,
    upload_session_id: normalizedSessionId,
    staged_at: now,
  };

  const insertBatch = async (nextPayload) =>
    supabase
      .from(TABLES.batches)
      .insert(nextPayload)
      .select("*")
      .single();

  let { data, error } = await insertBatch(payload);

  if (error && isMissingColumnError(error)) {
    payload = { ...basePayload };
    ({ data, error } = await insertBatch(payload));
  }

  if (error) throw new Error(`Failed to create staging batch: ${error.message}`);
  return data;
}

async function updateBatch(batchId, patch = {}) {
  const now = new Date().toISOString();
  const { data: current, error: currentError } = await supabase
    .from(TABLES.batches)
    .select("id, metadata")
    .eq("id", batchId)
    .maybeSingle();

  if (currentError) throw new Error(`Failed to load staging batch: ${currentError.message}`);
  if (!current) return null;

  const payload = {
    ...(patch.status ? { status: patch.status } : {}),
    ...(patch.batch_name ? { batch_name: patch.batch_name } : {}),
    metadata: {
      ...(current.metadata && typeof current.metadata === "object" ? current.metadata : {}),
      ...(patch.metadata && typeof patch.metadata === "object" ? patch.metadata : {}),
    },
    updated_at: now,
  };

  const { data, error } = await supabase
    .from(TABLES.batches)
    .update(payload)
    .eq("id", batchId)
    .select("*")
    .single();

  if (error) throw new Error(`Failed to update staging batch: ${error.message}`);
  return data;
}

async function insertTransactions({
  companyId,
  batchId,
  transactions = [],
  sourceType = MANUAL_SOURCE_KEY,
  sourceSwitchVersion = null,
  uploadSessionId = null,
}) {
  if (!transactions.length) {
    return { inserted: 0, duplicates: 0 };
  }

  const uniqueByHash = new Map();
  transactions.forEach((tx) => {
    if (!tx?.transactionHash) return;
    if (!uniqueByHash.has(tx.transactionHash)) {
      uniqueByHash.set(tx.transactionHash, tx);
    }
  });

  const stagedAt = new Date().toISOString();
  const normalizedSessionId =
    uploadSessionId && isValidUuid(uploadSessionId) ? uploadSessionId : null;
  const normalizedVersion = sourceSwitchVersion || null;
  const baseRows = Array.from(uniqueByHash.values()).map((tx) => ({
    company_id: companyId,
    batch_id: batchId,
    transaction_id: tx.transactionId,
    fiscal_year: tx.fiscalYear,
    txn_date: tx.date,
    account_number: tx.accountNumber || null,
    account_name: tx.accountName,
    account_type: tx.accountType || null,
    category: tx.category || null,
    sub_category: tx.subCategory || null,
    debit: roundMoney(Number(tx.debit || 0)),
    credit: roundMoney(Number(tx.credit || 0)),
    net_amount: roundMoney(Number(tx.netAmount || 0)),
    class: tx.class || null,
    department: tx.department || null,
    location: tx.location || null,
    journal_type: tx.journalType || null,
    transaction_type: tx.transactionType || null,
    reference: tx.reference || null,
    description: tx.description || null,
    source_file: tx.sourceFile || null,
    source_upload_id: tx.sourceUploadId || null,
    row_number: tx.rowNumber || null,
    transaction_hash: tx.transactionHash,
    metadata: tx.metadata || {},
  }));
  let rows = baseRows.map((row) => ({
    ...row,
    source_type: sourceType || MANUAL_SOURCE_KEY,
    source_switch_version: normalizedVersion,
    upload_session_id: normalizedSessionId,
    staged_at: stagedAt,
  }));

  const yearGroups = {};
  rows.forEach(r => {
    const yr = r.fiscal_year || "Unknown";
    yearGroups[yr] = (yearGroups[yr] || 0) + 1;
  });

  console.log("[ManualGL][MultiYear] === STAGING AUDIT ===");
  console.log(`[ManualGL][MultiYear] Total Unique Transactions: ${rows.length}`);
  console.log("[ManualGL][MultiYear] Grouped by Year:", JSON.stringify(yearGroups, null, 2));
  console.log("===============================");

  let processed = 0;
  const chunkSize = 500; // Reduced from 1000 for better stability

  for (let index = 0; index < rows.length; index += chunkSize) {
    const chunk = rows.slice(index, index + chunkSize);
    
    console.log(`[ManualGL][MultiYear] Upserting chunk ${index / chunkSize + 1} (${chunk.length} rows)`);

    await retrySupabaseOperation(async () => {
      let result = await supabase
        .from(TABLES.transactions)
        .upsert(chunk, {
          onConflict: "company_id,batch_id,transaction_hash",
          ignoreDuplicates: true,
        });

      if (
        result.error &&
        (isMissingColumnError(result.error) || isConflictTargetError(result.error))
      ) {
        const legacyChunk = chunk.map(
          ({
            source_type,
            source_switch_version,
            upload_session_id,
            staged_at,
            ...legacy
          }) => legacy,
        );
        rows = rows.map(
          ({
            source_type,
            source_switch_version,
            upload_session_id,
            staged_at,
            ...legacy
          }) => legacy,
        );
        result = await supabase
          .from(TABLES.transactions)
          .upsert(legacyChunk, {
            onConflict: isConflictTargetError(result.error)
              ? "company_id,transaction_hash"
              : "company_id,batch_id,transaction_hash",
            ignoreDuplicates: true,
          });
      }

      return result;
    });

    processed += chunk.length;
  }

  return { inserted: processed, duplicates: 0, yearGroups };
}

async function replaceBalanceSheetLines({
  companyId,
  batchId,
  sheetType,
  lines = [],
}) {
  const { error: deleteError } = await supabase
    .from(TABLES.balanceSheetLines)
    .delete()
    .eq("company_id", companyId)
    .eq("batch_id", batchId)
    .eq("sheet_type", sheetType);

  if (deleteError) {
    console.error(`[ManualGL][MultiYear] Error clearing existing ${sheetType} balance sheet lines:`, deleteError);
    // Continue anyway; the unique constraint will protect against stale data
  }

  if (!lines.length) {
    return { inserted: 0 };
  }

  const baseLines = lines.map((line) => ({
    ...line,
    line_hash: line.line_hash || buildBalanceSheetLineHash(line),
  }));
  let { error } = await supabase
    .from(TABLES.balanceSheetLines)
    .upsert(baseLines, {
      onConflict: "company_id,batch_id,sheet_type,line_hash",
      ignoreDuplicates: true,
    });

  if (error && (isMissingColumnError(error) || isConflictTargetError(error))) {
    const legacyLines = baseLines.map(
      ({
        source_type,
        source_switch_version,
        upload_session_id,
        staged_at,
        ...legacy
      }) => legacy,
    );
    const legacyResult = await supabase
      .from(TABLES.balanceSheetLines)
      .upsert(legacyLines, {
        onConflict: isConflictTargetError(error)
          ? "company_id,sheet_type,line_hash"
          : "company_id,batch_id,sheet_type,line_hash",
        ignoreDuplicates: true,
      });
    error = legacyResult.error;
  }

  if (error) {
    throw new Error(`Failed to save ${sheetType} balance sheet lines: ${error.message}`);
  }

  return { inserted: lines.length };
}

function parseMultiValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean);
  }
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseIntegerValues(value) {
  return parseMultiValue(value)
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item));
}

function applyTextFilter(query, column, value, exactList = false) {
  const values = parseMultiValue(value);
  if (!values.length) return query;
  if (exactList || values.length > 1) {
    return query.in(column, values);
  }
  return query.ilike(column, `%${values[0]}%`);
}

function parseManualFilterQuery(rawFilters = {}) {
  const rawUploadSessionId = toNonEmptyString(
    rawFilters.uploadSessionId || rawFilters.upload_session_id || "",
  );
  return {
    batchId: rawFilters.batchId || rawFilters.batch_id || "",
    fiscalYears: parseIntegerValues(rawFilters.fiscalYears || rawFilters.fiscalYear || rawFilters.year || rawFilters.years),
    fiscalMonths: parseIntegerValues(rawFilters.fiscalMonths || rawFilters.fiscalMonth || rawFilters.month || rawFilters.months)
      .filter((month) => month >= 1 && month <= 12),
    startDate: rawFilters.startDate || rawFilters.start_date || "",
    endDate: rawFilters.endDate || rawFilters.end_date || "",
    accountName: rawFilters.accountName || rawFilters.account_name || "",
    accountNumber: rawFilters.accountNumber || rawFilters.account_number || "",
    accountType: rawFilters.accountType || rawFilters.account_type || "",
    category: rawFilters.category || "",
    subCategory: rawFilters.subCategory || rawFilters.sub_category || "",
    department: rawFilters.department || "",
    class: rawFilters.class || "",
    location: rawFilters.location || "",
    sourceFile: rawFilters.sourceFile || rawFilters.source_file || "",
    reportType: rawFilters.reportType || rawFilters.report_type || "",
    transactionType: rawFilters.transactionType || rawFilters.transaction_type || "",
    journalType: rawFilters.journalType || rawFilters.journal_type || "",
    sourceType: toNonEmptyString(rawFilters.sourceType || rawFilters.source_type || ""),
    sourceSwitchVersion: toNonEmptyString(rawFilters.sourceSwitchVersion || rawFilters.source_switch_version || ""),
    uploadSessionId: isValidUuid(rawUploadSessionId) ? rawUploadSessionId : "",
    allBatches: parseBoolean(rawFilters.allBatches || rawFilters.all_batches),
    limit: Number(rawFilters.limit || 0) > 0
      ? Math.min(Number(rawFilters.limit), DEFAULT_STAGING_LIMIT)
      : DEFAULT_STAGING_LIMIT,
  };
}

async function queryStagedTransactions(companyId, rawFilters = {}) {
  const parsedFilters = parseManualFilterQuery(rawFilters);
  const filters = {
    ...parsedFilters,
    batchId: toNonEmptyString(parsedFilters.batchId),
  };

  if (!companyId) {
    return { filters, rows: [] };
  }

  if (!filters.batchId && !filters.allBatches) {
    const latestBatch = await getLatestManualBatch(companyId, {
      sourceType: filters.sourceType || MANUAL_SOURCE_KEY,
      sourceSwitchVersion: filters.sourceSwitchVersion || "",
      uploadSessionId: filters.uploadSessionId || "",
      status: "staged",
    });
    if (!latestBatch?.id) {
      return { filters, rows: [] };
    }
    filters.batchId = latestBatch.id;
    filters.sourceType = filters.sourceType || latestBatch.source_type || MANUAL_SOURCE_KEY;
    filters.sourceSwitchVersion =
      filters.sourceSwitchVersion ||
      latestBatch.source_switch_version ||
      latestBatch.metadata?.sourceSwitchVersion ||
      "";
    filters.uploadSessionId =
      filters.uploadSessionId ||
      latestBatch.upload_session_id ||
      latestBatch.metadata?.uploadSessionId ||
      "";
  }

  const buildQuery = (includeSourceColumns = true) => {
    let query = supabase
    .from(TABLES.transactions)
    .select("*")
    .eq("company_id", companyId);

    if (filters.batchId) {
      query = query.eq("batch_id", filters.batchId);
    }

    if (includeSourceColumns) {
      if (filters.sourceType) query = query.eq("source_type", filters.sourceType);
      if (filters.sourceSwitchVersion) {
        query = query.eq("source_switch_version", filters.sourceSwitchVersion);
      }
      if (filters.uploadSessionId) {
        query = query.eq("upload_session_id", filters.uploadSessionId);
      }
    }

    query = query.order("id", { ascending: true });

    if (filters.fiscalYears.length) {
      query = query.in("fiscal_year", filters.fiscalYears);
    } else {
      if (filters.startDate) query = query.gte("txn_date", filters.startDate);
      if (filters.endDate) query = query.lte("txn_date", filters.endDate);
    }

    query = applyTextFilter(query, "account_name", filters.accountName);
    query = applyTextFilter(query, "account_number", filters.accountNumber);
    query = applyTextFilter(query, "account_type", filters.accountType, true);
    query = applyTextFilter(query, "category", filters.category, true);
    query = applyTextFilter(query, "sub_category", filters.subCategory, true);
    query = applyTextFilter(query, "department", filters.department, true);
    query = applyTextFilter(query, "class", filters.class, true);
    query = applyTextFilter(query, "location", filters.location, true);
    query = applyTextFilter(query, "source_file", filters.sourceFile, true);
    query = applyTextFilter(query, "transaction_type", filters.transactionType, true);
    query = applyTextFilter(query, "journal_type", filters.journalType, true);

    // Note: reportType is intentionally NOT used to filter by account_type here.
    // build-payload functions (buildBalanceSheetPayload, calculateProfitLossBuckets)
    // already classify accounts via normalizeAccountType + inferAccountType, which
    // handles all raw DB values ("Bank", "Other Current Asset", etc.) correctly.
    // Applying a case-sensitive SQL account_type filter here would exclude valid accounts.

    return query;
  };

  const fetchPagedRows = async (includeSourceColumns = true) => {
    const maxRows = Math.max(1, Number(filters.limit || DEFAULT_STAGING_LIMIT));
    const pageSize = 1000; // Supabase/PostgREST max page size.
    const rows = [];
    let offset = 0;

    while (rows.length < maxRows) {
      const chunkSize = Math.min(pageSize, maxRows - rows.length);
      const rangeEnd = offset + chunkSize - 1;
      const query = buildQuery(includeSourceColumns).range(offset, rangeEnd);

      const { data, error } = await query;
      if (error) {
        return { rows: [], error };
      }

      const chunk = Array.isArray(data) ? data : [];
      if (!chunk.length) break;

      rows.push(...chunk);
      offset += chunk.length;

      if (chunk.length < pageSize) break;
    }

    return { rows, error: null };
  };

  let { rows, error } = await fetchPagedRows(true);
  if (error && isMissingColumnError(error)) {
    ({ rows, error } = await fetchPagedRows(false));
  }
  if (error) throw new Error(`Failed to load staged transactions: ${error.message}`);

  if (Array.isArray(filters.fiscalMonths) && filters.fiscalMonths.length > 0) {
    rows = rows.filter((row) => {
      const txnDate = String(row.txn_date || "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(txnDate)) return false;
      const month = Number(txnDate.slice(5, 7));
      return filters.fiscalMonths.includes(month);
    });
  }

  // Preserve original presentation order after keyset pagination fetch.
  rows.sort((a, b) => {
    const aDate = String(a?.txn_date || "");
    const bDate = String(b?.txn_date || "");
    if (aDate !== bDate) return aDate.localeCompare(bDate);
    return Number(a?.id || 0) - Number(b?.id || 0);
  });

  return { filters, rows };
}

function normalizeStagedTransactionRow(row) {
  if (!row) return null;

  const txId = row.transaction_id || row.transactionId || "";
  const rawDate = row.txn_date || row.date || null;
  const isoDate = toIsoDate(rawDate) || (rawDate ? String(rawDate) : null);
  const accountNumber = row.account_number || row.accountNumber || "";
  const accountName = row.account_name || row.accountName || "";
  const rawType = row.account_type || row.accountType || "";
  const normalizedType = normalizeAccountType(rawType) || inferAccountType(accountName, accountNumber);
  const parsedFiscalYear =
    Number(row.fiscal_year || row.fiscalYear || 0) ||
    (isoDate && /^\d{4}-\d{2}-\d{2}$/.test(isoDate) ? Number(isoDate.slice(0, 4)) : null);
  const parsedFiscalMonth =
    Number(row.fiscal_month || row.fiscalMonth || 0) ||
    (isoDate && /^\d{4}-\d{2}-\d{2}$/.test(isoDate) ? Number(isoDate.slice(5, 7)) : null);

  return {
    transactionId: txId,
    fiscalYear: Number.isInteger(parsedFiscalYear) ? parsedFiscalYear : null,
    fiscalMonth: Number.isInteger(parsedFiscalMonth) ? parsedFiscalMonth : null,
    date: isoDate,
    accountNumber,
    accountName,
    accountType: normalizedType,
    category: row.category || "",
    subCategory: row.sub_category || row.subCategory || "",
    debit: roundMoney(Number(row.debit || 0)),
    credit: roundMoney(Number(row.credit || 0)),
    netAmount: roundMoney(Number(row.net_amount || row.netAmount || 0)),
    class: row.class || "",
    department: row.department || "",
    location: row.location || "",
    journalType: row.journal_type || row.journalType || "",
    transactionType: row.transaction_type || row.transactionType || "",
    reference: row.reference || "",
    description: row.description || "",
    sourceFile: row.source_file || row.sourceFile || "",
    sourceUploadId: row.source_upload_id || row.sourceUploadId || null,
    rowNumber: row.row_number || row.rowNumber || null,
    batchId: row.batch_id || row.batchId || null,
    sourceType: row.source_type || row.sourceType || MANUAL_SOURCE_KEY,
    sourceSwitchVersion: row.source_switch_version || row.sourceSwitchVersion || null,
    uploadSessionId: row.upload_session_id || row.uploadSessionId || null,
    stagedAt: row.staged_at || row.stagedAt || null,
  };
}

function normalizeProfitLossCategory(category, accountName, accountType) {
  const type = normalizeAccountType(accountType) || inferAccountType(accountName);
  const name = String(accountName || "").toLowerCase();

  if (type === "income") return "Revenue";
  if (type === "cogs") return "COGS";
  if (type === "expense") {
    if (/\binterest\b|\btax\b|\bother\b|\bnon-operating\b/.test(name)) return "Other Expenses";
    return "Operating Expenses";
  }
  return "";
}

function normalizeBalanceSheetCategory(category, accountName, accountType) {
  const explicit = String(category || "").trim();
  if (explicit) {
    return explicit;
  }

  const type = normalizeAccountType(accountType) || inferAccountType(accountName);
  const name = String(accountName || "").toLowerCase();

  if (type === "asset") {
    if (/\bfixed\b|\bequipment\b|\bvehicle\b|\bland\b|\bbuilding\b|\bdepreciation\b|\bfurniture\b|\bfixtures\b|\bimprovement\b|\bamortization\b|\btruck\b|\bvan\b|\btrailer\b|\bmachinery\b|\bauto\b|\bcomputer\b/.test(name)) {
      return "Fixed Assets";
    }
    if (/\bconstruction\b|\blong[\s-]?term\b|\bother asset\b/.test(name)) {
      return "Other Assets";
    }
    if (/\bcash\b|\bbank\b|\bchecking\b|\bsavings\b|\bmoney market\b/.test(name)) {
      return "Bank Accounts";
    }
    if (/\breceivable\b|\binventory\b|\bdue from\b|\bprepaid\b|\bloan to\b/.test(name)) {
      return "Other Current Assets";
    }
    return "Other Assets";
  }
  if (type === "liability") {
    if (/\bcredit card\b|\bvisa\b|\bmastercard\b|\bamex\b|\bchase ink\b|\bcapital one\b|\bsam'?s\b/.test(name)) {
      return "Credit Cards";
    }
    if (/\blong[\s-]?term\b|\bmortgage\b|\bbetson\b|\bporsche\b|\bprovident bank\b|\bgovernment loan\b|\bnotes? payable\b/.test(name)) {
      return "Long-Term Liabilities";
    }
    if (/\bloan\b|\bpayable\b|\baccrued\b|\btax\b|\beidl\b|\bppp\b|\bofficer\b/.test(name)) {
      return "Other Current Liabilities";
    }
    return "Other Current Liabilities";
  }
  if (type === "equity") {
    if (/\bnet income\b/.test(name)) return "Net Income";
    if (/\bretained earnings\b/.test(name)) return "Retained Earnings";
    return "Owner Equity";
  }
  return "";
}

function resolveBalanceSheetGrouping(accountName, accountType, explicitCategory = "") {
  const type = normalizeAccountType(accountType) || inferAccountType(accountName);
  const name = String(accountName || "").toLowerCase();
  const normalizedCategory = normalizeKey(explicitCategory);
  const result = {
    sectionKey: null,
    majorGroup: "",
    minorGroup: "",
    leafCategory: "",
  };

  if (type === "asset") {
    result.sectionKey = "Assets";

    if (
      normalizedCategory.includes("fixed asset") ||
      /\bfixed\b|\bequipment\b|\bvehicle\b|\bland\b|\bbuilding\b|\bdepreciation\b|\bfurniture\b|\bfixtures\b|\bimprovement\b|\bamortization\b|\btruck\b|\bvan\b|\btrailer\b|\bmachinery\b|\bauto\b|\bcomputer\b/.test(name)
    ) {
      result.majorGroup = "Fixed Assets";
      result.leafCategory = "Fixed Assets";
      return result;
    }

    if (
      normalizedCategory.includes("other asset") ||
      /\bconstruction\b|\blong[\s-]?term\b|\bother long\b|\bother asset\b/.test(name)
    ) {
      result.majorGroup = "Other Assets";
      result.leafCategory = "Other Assets";
      return result;
    }

    result.majorGroup = "Current Assets";
    if (
      normalizedCategory.includes("bank") ||
      /\bcash\b|\bbank\b|\bchecking\b|\bsavings\b|\bmoney market\b/.test(name)
    ) {
      result.minorGroup = "Bank Accounts";
      result.leafCategory = "Bank Accounts";
    } else {
      result.minorGroup = "Other Current Assets";
      result.leafCategory = "Other Current Assets";
    }
    return result;
  }

  if (type === "liability") {
    result.sectionKey = "Liabilities";

    if (
      normalizedCategory.includes("long") ||
      /\blong[\s-]?term\b|\bmortgage\b|\bbetson\b|\bporsche\b|\bprovident bank\b|\bgovernment loan\b|\bnotes? payable\b/.test(name)
    ) {
      result.majorGroup = "Long-Term Liabilities";
      result.leafCategory = "Long-Term Liabilities";
      return result;
    }

    result.majorGroup = "Current Liabilities";
    if (
      normalizedCategory.includes("credit card") ||
      /\bcredit card\b|\bvisa\b|\bmastercard\b|\bamex\b|\bchase ink\b|\bcapital one\b|\bsam'?s\b/.test(name)
    ) {
      result.minorGroup = "Credit Cards";
      result.leafCategory = "Credit Cards";
    } else {
      result.minorGroup = "Other Current Liabilities";
      result.leafCategory = "Other Current Liabilities";
    }
    return result;
  }

  if (type === "equity") {
    result.sectionKey = "Equity";
    if (/\bnet income\b/.test(name) || normalizedCategory.includes("net income")) {
      result.majorGroup = "Net Income";
      result.leafCategory = "Net Income";
      return result;
    }
    if (/\bretained earnings\b/.test(name) || normalizedCategory.includes("retained")) {
      result.majorGroup = "Retained Earnings";
      result.leafCategory = "Retained Earnings";
      return result;
    }
    result.majorGroup = "Owner Equity";
    result.leafCategory = "Owner Equity";
    return result;
  }

  return result;
}

function calculateProfitLossBuckets(transactions = []) {
  const yearly = new Map();
  const monthly = new Map();

  const ensureYear = (year) => {
    if (!yearly.has(year)) {
      yearly.set(year, {
        fiscalYear: year,
        Revenue: 0,
        COGS: 0,
        "Operating Expenses": 0,
        "Other Expenses": 0,
      });
    }
    return yearly.get(year);
  };

  const ensureMonth = (monthKey, year) => {
    if (!monthly.has(monthKey)) {
      monthly.set(monthKey, {
        month: monthKey,
        fiscalYear: year,
        Revenue: 0,
        COGS: 0,
        "Operating Expenses": 0,
        "Other Expenses": 0,
      });
    }
    return monthly.get(monthKey);
  };

  transactions.forEach((tx) => {
    const accountType = normalizeAccountType(tx.accountType) || inferAccountType(tx.accountName, tx.accountNumber);
    if (!["income", "cogs", "expense"].includes(accountType)) return;

    const category = normalizeProfitLossCategory(tx.category, tx.accountName, tx.accountType);
    if (!category) return;

    const year = Number(tx.fiscalYear || (String(tx.date || "").slice(0, 4))) || 0;
    const month = String(tx.date || "").slice(0, 7);
    const signed = roundMoney(Number(tx.netAmount || 0));
    const normalizedAmount = category === "Revenue" ? signed : roundMoney(-signed);

    const yearRow = ensureYear(year);
    yearRow[category] = roundMoney((yearRow[category] || 0) + normalizedAmount);

    if (month && /^\d{4}-\d{2}$/.test(month)) {
      const monthRow = ensureMonth(month, year);
      monthRow[category] = roundMoney((monthRow[category] || 0) + normalizedAmount);
    }
  });

  const finalizeLine = (bucket) => {
    const grossProfit = roundMoney(bucket.Revenue - bucket.COGS);
    const operatingIncome = roundMoney(grossProfit - bucket["Operating Expenses"]);
    const netProfit = roundMoney(operatingIncome - bucket["Other Expenses"]);
    return {
      ...bucket,
      "Gross Profit": grossProfit,
      "Operating Income": operatingIncome,
      "Net Profit": netProfit,
    };
  };

  const yearlyRows = Array.from(yearly.values())
    .map(finalizeLine)
    .sort((a, b) => a.fiscalYear - b.fiscalYear);
  const monthlyRows = Array.from(monthly.values())
    .map(finalizeLine)
    .sort((a, b) => a.month.localeCompare(b.month));

  if (yearlyRows.length > 0) {
    console.log(`[ManualGL][PL][Debug] Yearly aggregation results:`);
    yearlyRows.forEach((row) => {
      console.log(
        `  Year ${row.fiscalYear}: Revenue=${row.Revenue}, COGS=${row.COGS},`,
        `OpEx=${row["Operating Expenses"]}, OtherEx=${row["Other Expenses"]},`,
        `GrossProfit=${row["Gross Profit"]}, NetProfit=${row["Net Profit"]}`,
      );
    });
  }

  return { yearlyRows, monthlyRows };
}

function buildSummaryLines(yearlyRows = []) {
  const years = yearlyRows.map((row) => row.fiscalYear).filter((year) => Number.isInteger(year));
  const metrics = [
    "Revenue",
    "COGS",
    "Gross Profit",
    "Operating Expenses",
    "Operating Income",
    "Other Expenses",
    "Net Profit",
  ];

  const lines = metrics.map((metric) => {
    const byYear = {};
    years.forEach((year) => {
      const row = yearlyRows.find((item) => item.fiscalYear === year);
      byYear[year] = roundMoney(Number(row?.[metric] || 0));
    });
    const consolidated = roundMoney(Object.values(byYear).reduce((sum, value) => sum + Number(value || 0), 0));
    return {
      key: metric.toLowerCase().replace(/\s+/g, "_"),
      label: metric,
      valuesByYear: byYear,
      consolidated,
    };
  });

  return { years, lines };
}

function buildYearComparison(yearlyRows = []) {
  return yearlyRows.map((row, index) => {
    const previous = index > 0 ? yearlyRows[index - 1] : null;
    const delta = roundMoney(Number(row["Net Profit"] || 0) - Number(previous?.["Net Profit"] || 0));
    const pct = previous && Number(previous["Net Profit"]) !== 0
      ? roundMoney((delta / Math.abs(Number(previous["Net Profit"]))) * 100)
      : null;

    return {
      fiscalYear: row.fiscalYear,
      revenue: roundMoney(Number(row.Revenue || 0)),
      cogs: roundMoney(Number(row.COGS || 0)),
      grossProfit: roundMoney(Number(row["Gross Profit"] || 0)),
      operatingExpenses: roundMoney(Number(row["Operating Expenses"] || 0)),
      operatingIncome: roundMoney(Number(row["Operating Income"] || 0)),
      otherExpenses: roundMoney(Number(row["Other Expenses"] || 0)),
      netProfit: roundMoney(Number(row["Net Profit"] || 0)),
      netProfitDeltaVsPreviousYear: delta,
      netProfitDeltaPctVsPreviousYear: pct,
    };
  });
}

function buildProfitLossHierarchicalRows(transactions = [], yearlyRows = [], displayYear = null) {
  const accountMap = new Map();

  transactions.forEach((tx) => {
    const txFY = Number(tx.fiscalYear || 0);
    if (displayYear && txFY !== displayYear) return;

    const accountType = normalizeAccountType(tx.accountType) || inferAccountType(tx.accountName, tx.accountNumber);
    if (!['income', 'cogs', 'expense'].includes(accountType)) return;

    const category = normalizeProfitLossCategory(tx.category, tx.accountName, tx.accountType);
    if (!category) return;

    const key = `${category}::${tx.accountNumber || ''}::${tx.accountName}`;
    if (!accountMap.has(key)) {
      accountMap.set(key, { accountName: tx.accountName, accountNumber: tx.accountNumber || '', category, total: 0 });
    }
    const netAmount = roundMoney(Number(tx.netAmount || 0));
    accountMap.get(key).total = roundMoney(accountMap.get(key).total + (category === 'Revenue' ? netAmount : -netAmount));
  });

  const byCategory = { Revenue: [], COGS: [], 'Operating Expenses': [], 'Other Expenses': [] };
  accountMap.forEach((acc) => { if (byCategory[acc.category]) byCategory[acc.category].push(acc); });
  Object.values(byCategory).forEach((arr) => arr.sort((a, b) => a.accountName.localeCompare(b.accountName)));

  const yearRow = displayYear ? yearlyRows.find(r => r.fiscalYear === displayYear) : (yearlyRows[yearlyRows.length - 1] || null);
  const get = (key) => yearRow ? roundMoney(yearRow[key] || 0) : 0;

  const toAccountRows = (accounts, prefix) => accounts.map((acc, i) => ({
    id: `${prefix}-${i}-${acc.accountNumber}`,
    name: acc.accountName,
    amount: acc.total,
    type: 'data',
  }));

  const rows = [];

  const incomeTotal = get('Revenue');
  rows.push({
    id: 'income', name: 'Income', type: 'header', amount: incomeTotal,
    children: [
      ...toAccountRows(byCategory.Revenue, 'inc'),
      { id: 'total-income', name: 'Total Income', amount: incomeTotal, type: 'total' },
    ],
  });

  if (byCategory.COGS.length > 0) {
    const cogsTotal = get('COGS');
    rows.push({
      id: 'cogs', name: 'Cost of Goods Sold', type: 'header', amount: cogsTotal,
      children: [
        ...toAccountRows(byCategory.COGS, 'cogs'),
        { id: 'total-cogs', name: 'Total Cost of Goods Sold', amount: cogsTotal, type: 'total' },
      ],
    });
  }

  rows.push({ id: 'gross-profit', name: 'Gross Profit', amount: get('Gross Profit'), type: 'total' });

  const expenseTotal = get('Operating Expenses');
  rows.push({
    id: 'expenses', name: 'Expenses', type: 'header', amount: expenseTotal,
    children: [
      ...toAccountRows(byCategory['Operating Expenses'], 'exp'),
      { id: 'total-expenses', name: 'Total Expenses', amount: expenseTotal, type: 'total' },
    ],
  });

  rows.push({ id: 'net-operating-income', name: 'Net Operating Income', amount: get('Operating Income'), type: 'total' });

  if (byCategory['Other Expenses'].length > 0) {
    const otherTotal = get('Other Expenses');
    rows.push({
      id: 'other-income-expense', name: 'Other Income/Expense', type: 'header', amount: -otherTotal,
      children: [
        ...toAccountRows(byCategory['Other Expenses'], 'other'),
        { id: 'total-other', name: 'Total Other Income/Expense', amount: -otherTotal, type: 'total' },
      ],
    });
  }

  rows.push({ id: 'net-income', name: 'Net Income', amount: get('Net Profit'), type: 'total' });

  return rows;
}

function buildProfitLossSummaryPayload(transactions = [], filters = {}) {
  const { yearlyRows, monthlyRows } = calculateProfitLossBuckets(transactions);
  const summary = buildSummaryLines(yearlyRows);
  const yearComparison = buildYearComparison(yearlyRows);

  const netProfitByYear = {};
  yearlyRows.forEach(row => {
    netProfitByYear[row.fiscalYear] = row["Net Profit"] || 0;
  });

  const selectedYears = Array.isArray(filters.fiscalYears) && filters.fiscalYears.length > 0
    ? filters.fiscalYears : summary.years;
  const displayYear = selectedYears.length > 0 ? selectedYears[selectedYears.length - 1] : null;
  const hierarchicalRows = buildProfitLossHierarchicalRows(transactions, yearlyRows, displayYear);

  return {
    source: "manual_gl_staged_transactions",
    reportType: "profit_loss_summary",
    filters,
    years: summary.years,
    lines: summary.lines,
    monthlyBreakdown: monthlyRows,
    yearComparison,
    netProfitByYear,
    hierarchicalRows,
  };
}

function buildProfitLossDetailPayload(transactions = [], filters = {}) {
  const { yearlyRows, monthlyRows } = calculateProfitLossBuckets(transactions);
  const years = yearlyRows.map((row) => row.fiscalYear).filter((year) => Number.isInteger(year));

  const accountsMap = new Map();
  transactions.forEach((tx) => {
    const accountType = normalizeAccountType(tx.accountType) || inferAccountType(tx.accountName, tx.accountNumber);
    if (!["income", "cogs", "expense"].includes(accountType)) return;

    const category = normalizeProfitLossCategory(tx.category, tx.accountName, tx.accountType);
    if (!category) return;

    const key = `${tx.accountNumber || ""}::${tx.accountName}`;
    if (!accountsMap.has(key)) {
      accountsMap.set(key, {
        accountNumber: tx.accountNumber || "",
        accountName: tx.accountName,
        category,
        accountType,
        yearlyTotals: {},
        totalNet: 0,
      });
    }
    const acc = accountsMap.get(key);
    const signed = roundMoney(Number(tx.netAmount || 0));
    const amount = category === "Revenue" ? signed : roundMoney(-signed);
    acc.yearlyTotals[tx.fiscalYear] = roundMoney((acc.yearlyTotals[tx.fiscalYear] || 0) + amount);
    acc.totalNet = roundMoney(acc.totalNet + amount);
  });

  const accounts = Array.from(accountsMap.values()).sort((a, b) => {
    if (a.category !== b.category) return a.category.localeCompare(b.category);
    return a.accountName.localeCompare(b.accountName);
  });

  const groupedCategories = Array.from(new Set(accounts.map(a => a.category))).filter(Boolean).map(catName => {
    const catAccounts = accounts.filter(a => a.category === catName);
    const totalsByYear = {};
    years.forEach(y => {
      totalsByYear[y] = roundMoney(catAccounts.reduce((sum, acc) => sum + (acc.yearlyTotals[y] || 0), 0));
    });
    return {
      category: catName,
      totalsByYear,
      accounts: catAccounts
    };
  });

  return {
    source: "manual_gl_staged_transactions",
    reportType: "profit_loss_detail",
    filters,
    years,
    categories: groupedCategories,
    accounts,
    monthlyBreakdown: monthlyRows,
  };
}

function buildBalanceSheetPayload(transactions = [], filters = {}, netProfitByYear = {}, startingLines = []) {
  const normalized = transactions.filter(Boolean);

  // Years present in user-selected filter (may be empty → "show all").
  const selectedYears = Array.isArray(filters.fiscalYears)
    ? filters.fiscalYears.map((year) => Number(year)).filter((year) => Number.isInteger(year) && year > 0)
    : [];

  // Base years: every fiscal year that has at least one GL transaction.
  const txYears = Array.from(
    new Set(
      normalized
        .map((tx) => Number(tx.fiscalYear || 0))
        .filter((year) => Number.isInteger(year) && year > 0),
    ),
  ).sort((a, b) => a - b);

  // Extended year range: merge GL years with the user-requested display years.
  //
  // WHY: A Balance Sheet is a cumulative roll-forward (opening + movement = closing).
  // If the user selects year 2024 but there are no 2024 GL transactions, the "years"
  // array would only contain 2023. The 2024 balance sheet would be missing from the
  // payload, showing $0 for every account instead of the carry-forward 2023 closing
  // balances. By extending to include 2024, the rolling loop correctly outputs
  // `balancesByYear[2024] = balancesByYear[2023] + 0` for every static account.
  //
  // Fill ALL intermediate years so that carry-forward is always applied in order.
  // E.g. if GL has [2022, 2025] and user wants [2024]:
  //   extendedYears = [2022, 2023, 2024, 2025]
  // This ensures the 2023→2024 carry-forward happens even without 2023 transactions.
  const allYearSeeds = [...new Set([...txYears, ...selectedYears])];
  let years;
  if (allYearSeeds.length === 0) {
    years = [];
  } else {
    const minYear = Math.min(...allYearSeeds);
    const maxYear = Math.max(...allYearSeeds);
    years = [];
    for (let y = minYear; y <= maxYear; y++) years.push(y);
  }

  const displayYear =
    (selectedYears.length ? selectedYears[selectedYears.length - 1] : null) ||
    (years.length ? years[years.length - 1] : null);

  const accountsByKey = new Map();
  const ensureAccount = ({ accountNumber = "", accountName = "", accountType = "", category = "", source = "tx" }) => {
    const normalizedType = normalizeAccountType(accountType) || inferAccountType(accountName, accountNumber);
    if (!["asset", "liability", "equity"].includes(normalizedType)) return null;

    const grouping = resolveBalanceSheetGrouping(accountName, normalizedType, category);
    const key = `${normalizedType}::${normalizeAccountLabel(accountName)}`;
    if (!accountsByKey.has(key)) {
      accountsByKey.set(key, {
        key,
        accountName,
        accountNumber: accountNumber || "",
        accountType: normalizedType,
        grouping,
        openingBalance: 0,
        activityByYear: {},
        balancesByYear: {},
        sources: new Set([source]),
      });
    }
    const existing = accountsByKey.get(key);
    if (!existing.accountNumber && accountNumber) existing.accountNumber = accountNumber;
    if (source) existing.sources.add(source);
    if (!existing.grouping?.leafCategory && grouping?.leafCategory) {
      existing.grouping = grouping;
    }
    return existing;
  };

  // Opening balances from starting balance sheet lines.
  startingLines.forEach((line) => {
    let accountName = String(line.account_name || "").trim();
    if (!accountName) return;
    const accountType =
      line.section === "assets"
        ? "asset"
        : line.section === "liabilities"
          ? "liability"
          : line.section === "equity"
            ? "equity"
            : "";
    if (!accountType) return;

    const metadata = line.metadata && typeof line.metadata === "object" ? line.metadata : {};
    let impliedCategory = metadata.leafCategory || metadata.minorGroup || metadata.majorGroup || "";
    if (accountType === "equity" && /\bnet income\b/i.test(accountName)) {
      accountName = "Retained Earnings";
      impliedCategory = "Retained Earnings";
    }
    const account = ensureAccount({
      accountName,
      accountType,
      category: impliedCategory,
      source: "starting",
    });
    if (!account) return;
    account.openingBalance = roundMoney(account.openingBalance + Number(line.amount || 0));
  });

  // Activity from staged GL transactions.
  normalized.forEach((tx) => {
    const account = ensureAccount({
      accountNumber: tx.accountNumber || "",
      accountName: tx.accountName || "",
      accountType: tx.accountType || "",
      category: tx.category || "",
      source: "tx",
    });
    if (!account) return;

    const txYear = Number(tx.fiscalYear || 0);
    if (!Number.isInteger(txYear) || txYear <= 0) return;
    if (!years.includes(txYear)) return;

    const contra = isContraAccount(tx.accountName, account.accountType);
    const netAmount = Number(tx.netAmount || 0); // credit - debit
    let delta = account.accountType === "asset" ? -netAmount : netAmount;
    if (contra) delta = -delta;
    delta = roundMoney(delta);

    account.activityByYear[txYear] = roundMoney((account.activityByYear[txYear] || 0) + delta);
  });

  const accounts = Array.from(accountsByKey.values());
  accounts.forEach((account) => {
    let running = roundMoney(account.openingBalance || 0);
    years.forEach((year) => {
      running = roundMoney(running + Number(account.activityByYear[year] || 0));
      account.balancesByYear[year] = running;
    });
  });

  const sections = {
    Assets: { label: "Assets", totalByYear: {}, categories: [] },
    Liabilities: { label: "Liabilities", totalByYear: {}, categories: [] },
    Equity: { label: "Equity", totalByYear: {}, categories: [] },
  };

  const categoryOrder = {
    Assets: ["Bank Accounts", "Other Current Assets", "Fixed Assets", "Other Assets"],
    Liabilities: ["Credit Cards", "Other Current Liabilities", "Long-Term Liabilities"],
    Equity: ["Owner Equity", "Retained Earnings", "Net Income"],
  };

  const categoriesBySection = {
    Assets: new Map(),
    Liabilities: new Map(),
    Equity: new Map(),
  };

  const addCategoryAccount = (sectionKey, categoryLabel, accountPayload) => {
    if (!sections[sectionKey]) return;
    const normalizedLabel = categoryLabel || "Uncategorized";
    if (!categoriesBySection[sectionKey].has(normalizedLabel)) {
      categoriesBySection[sectionKey].set(normalizedLabel, {
        label: normalizedLabel,
        totalByYear: {},
        accounts: [],
      });
    }
    categoriesBySection[sectionKey].get(normalizedLabel).accounts.push(accountPayload);
  };

  const retainedAccounts = [];
  const ownerEquityAccounts = [];
  let explicitNetIncomeAccounts = [];

  accounts.forEach((account) => {
    const grouping = account.grouping || resolveBalanceSheetGrouping(account.accountName, account.accountType, account.grouping?.leafCategory || "");
    const sectionKey = grouping.sectionKey;
    if (!sectionKey || !sections[sectionKey]) return;

    const payload = {
      name: account.accountName,
      number: account.accountNumber || "",
      balancesByYear: { ...account.balancesByYear },
      activityByYear: { ...account.activityByYear },
    };

    if (sectionKey !== "Equity") {
      addCategoryAccount(sectionKey, grouping.leafCategory || "Other", payload);
      return;
    }

    if (grouping.majorGroup === "Retained Earnings") {
      retainedAccounts.push(payload);
      return;
    }
    if (grouping.majorGroup === "Net Income") {
      explicitNetIncomeAccounts.push(payload);
      return;
    }
    ownerEquityAccounts.push(payload);
  });

  if (!categoriesBySection.Equity.has("Owner Equity")) {
    categoriesBySection.Equity.set("Owner Equity", {
      label: "Owner Equity",
      totalByYear: {},
      accounts: [],
    });
  }
  ownerEquityAccounts.forEach((payload) => addCategoryAccount("Equity", "Owner Equity", payload));

  const retainedEarningsActivityMagnitude = retainedAccounts.reduce((sum, account) => {
    return sum + Object.values(account.activityByYear || {}).reduce((inner, value) => inner + Math.abs(Number(value || 0)), 0);
  }, 0);
  const shouldCarryForwardNetIncome =
    explicitNetIncomeAccounts.length === 0 && retainedEarningsActivityMagnitude <= BALANCE_EPSILON;

  // Derive the starting BS year so we don't double-count net income that is already
  // reflected in the starting BS opening balance. Only carry forward net income from
  // GL years that fall AFTER the starting BS date.
  const startingBsYear = (() => {
    const dateStr = startingLines.find((l) => l.as_of_date)?.as_of_date;
    if (!dateStr) return null;
    const yr = new Date(dateStr).getFullYear();
    return Number.isInteger(yr) && yr > 0 ? yr : null;
  })();

  const retainedByYearCarry = {};
  let cumulativePriorNet = 0;
  years.forEach((year, index) => {
    if (index > 0) {
      const priorYear = years[index - 1];
      // Skip if the prior year is already covered by the starting BS opening balance
      if (!startingBsYear || priorYear > startingBsYear) {
        cumulativePriorNet = roundMoney(cumulativePriorNet + Number(netProfitByYear[priorYear] || 0));
      }
    }
    retainedByYearCarry[year] = shouldCarryForwardNetIncome ? cumulativePriorNet : 0;
  });

  const retainedAccountsWithCarry = retainedAccounts.length
    ? retainedAccounts.map((account) => ({
      ...account,
      balancesByYear: Object.fromEntries(
        years.map((year) => [
          year,
          roundMoney(Number(account.balancesByYear?.[year] || 0) + Number(retainedByYearCarry[year] || 0)),
        ]),
      ),
    }))
    : years.length
      ? [
        {
          name: "Retained Earnings",
          number: "",
          balancesByYear: Object.fromEntries(
            years.map((year) => [year, roundMoney(Number(retainedByYearCarry[year] || 0))]),
          ),
        },
      ]
      : [];

  retainedAccountsWithCarry.forEach((payload) => addCategoryAccount("Equity", "Retained Earnings", payload));

  const netIncomeAccounts = explicitNetIncomeAccounts.length
    ? explicitNetIncomeAccounts
    : years.length
      ? [
        {
          name: "Net Income",
          number: "",
          balancesByYear: Object.fromEntries(
            years.map((year) => [year, roundMoney(Number(netProfitByYear[year] || 0))]),
          ),
        },
      ]
      : [];
  netIncomeAccounts.forEach((payload) => addCategoryAccount("Equity", "Net Income", payload));

  Object.entries(categoriesBySection).forEach(([sectionKey, categoryMap]) => {
    const orderedCategories = Array.from(categoryMap.values()).sort((a, b) => {
      const order = categoryOrder[sectionKey] || [];
      const aIndex = order.indexOf(a.label);
      const bIndex = order.indexOf(b.label);
      if (aIndex >= 0 && bIndex >= 0) return aIndex - bIndex;
      if (aIndex >= 0) return -1;
      if (bIndex >= 0) return 1;
      return a.label.localeCompare(b.label);
    });

    orderedCategories.forEach((category) => {
      category.accounts.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
      years.forEach((year) => {
        const total = roundMoney(
          category.accounts.reduce((sum, account) => sum + Number(account.balancesByYear?.[year] || 0), 0),
        );
        category.totalByYear[year] = total;
        sections[sectionKey].totalByYear[year] = roundMoney(
          Number(sections[sectionKey].totalByYear[year] || 0) + total,
        );
      });
      sections[sectionKey].categories.push(category);
    });
  });

  // If equation variance remains after classification, park it in retained earnings adjustment.
  const retainedCategory =
    sections.Equity.categories.find((category) => category.label === "Retained Earnings") ||
    (() => {
      const category = { label: "Retained Earnings", totalByYear: {}, accounts: [] };
      sections.Equity.categories.push(category);
      return category;
    })();

  const balancingAdjustmentAccount = {
    name: "Retained Earnings Adjustment",
    number: "",
    balancesByYear: {},
  };
  let hasBalancingAdjustment = false;

  years.forEach((year) => {
    const assets = roundMoney(Number(sections.Assets.totalByYear?.[year] || 0));
    const liabilities = roundMoney(Number(sections.Liabilities.totalByYear?.[year] || 0));
    const equity = roundMoney(Number(sections.Equity.totalByYear?.[year] || 0));
    const variance = roundMoney(assets - (liabilities + equity));
    balancingAdjustmentAccount.balancesByYear[year] = variance;

    if (Math.abs(variance) <= BALANCE_EPSILON) return;

    hasBalancingAdjustment = true;
    retainedCategory.totalByYear[year] = roundMoney(
      Number(retainedCategory.totalByYear?.[year] || 0) + variance,
    );
    sections.Equity.totalByYear[year] = roundMoney(
      Number(sections.Equity.totalByYear?.[year] || 0) + variance,
    );
  });

  if (hasBalancingAdjustment) {
    retainedCategory.accounts.push(balancingAdjustmentAccount);
    retainedCategory.accounts.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  }

  const getYearValue = (totalByYear = {}, year) => roundMoney(Number(totalByYear?.[year] || 0));
  const audit = years.map((year) => {
    const assets = getYearValue(sections.Assets.totalByYear, year);
    const liabilities = getYearValue(sections.Liabilities.totalByYear, year);
    const equity = getYearValue(sections.Equity.totalByYear, year);
    const liabilitiesAndEquity = roundMoney(liabilities + equity);
    const difference = roundMoney(assets - liabilitiesAndEquity);
    return {
      year,
      assets,
      liabilitiesAndEquity,
      difference,
      isBalanced: Math.abs(difference) <= BALANCE_EPSILON,
    };
  });

  const byCategory = (sectionKey, label) =>
    sections[sectionKey]?.categories?.find((category) => category.label === label) || null;
  const sumCategory = (sectionKey, labels, year) =>
    roundMoney(
      labels.reduce(
        (sum, label) => sum + Number(byCategory(sectionKey, label)?.totalByYear?.[year] || 0),
        0,
      ),
    );
  const displayAmount = (sectionKey, label) =>
    displayYear ? Number(byCategory(sectionKey, label)?.totalByYear?.[displayYear] || 0) : 0;

  const toAccountRows = (category, prefix) =>
    (category?.accounts || []).map((account, index) => ({
      id: `${prefix}-${index}`,
      name: account.name,
      amount: displayYear ? Number(account.balancesByYear?.[displayYear] || 0) : 0,
      type: "data",
    }));

  const categoryNode = (sectionKey, label, prefix) => {
    const category = byCategory(sectionKey, label);
    if (!category) return null;
    const amount = displayAmount(sectionKey, label);
    return {
      id: `${prefix}-${normalizeKey(label).replace(/\s+/g, "-")}`,
      name: label,
      amount,
      type: "header",
      children: [
        ...toAccountRows(category, `${prefix}-acc`),
        {
          id: `${prefix}-total-${normalizeKey(label).replace(/\s+/g, "-")}`,
          name: `Total for ${label}`,
          amount,
          type: "total",
        },
      ],
    };
  };

  const currentAssetsTotal = displayYear
    ? sumCategory("Assets", ["Bank Accounts", "Other Current Assets"], displayYear)
    : 0;
  const currentLiabilitiesTotal = displayYear
    ? sumCategory("Liabilities", ["Credit Cards", "Other Current Liabilities"], displayYear)
    : 0;
  const assetsTotal = displayYear ? getYearValue(sections.Assets.totalByYear, displayYear) : 0;
  const liabilitiesTotal = displayYear ? getYearValue(sections.Liabilities.totalByYear, displayYear) : 0;
  const equityTotal = displayYear ? getYearValue(sections.Equity.totalByYear, displayYear) : 0;
  const liabilitiesAndEquityTotal = roundMoney(liabilitiesTotal + equityTotal);

  const currentAssetsNode = {
    id: "current-assets",
    name: "Current Assets",
    amount: currentAssetsTotal,
    type: "header",
    children: [
      categoryNode("Assets", "Bank Accounts", "assets-bank"),
      categoryNode("Assets", "Other Current Assets", "assets-oca"),
      {
        id: "current-assets-total",
        name: "Total for Current Assets",
        amount: currentAssetsTotal,
        type: "total",
      },
    ].filter(Boolean),
  };

  const currentLiabilitiesNode = {
    id: "current-liabilities",
    name: "Current Liabilities",
    amount: currentLiabilitiesTotal,
    type: "header",
    children: [
      categoryNode("Liabilities", "Credit Cards", "liab-cc"),
      categoryNode("Liabilities", "Other Current Liabilities", "liab-ocl"),
      {
        id: "current-liabilities-total",
        name: "Total for Current Liabilities",
        amount: currentLiabilitiesTotal,
        type: "total",
      },
    ].filter(Boolean),
  };

  const assetsNode = {
    id: "assets",
    name: "Assets",
    amount: assetsTotal,
    type: "header",
    children: [
      currentAssetsNode,
      categoryNode("Assets", "Fixed Assets", "assets-fixed"),
      categoryNode("Assets", "Other Assets", "assets-other"),
      {
        id: "assets-total",
        name: "Total for Assets",
        amount: assetsTotal,
        type: "total",
      },
    ].filter(Boolean),
  };

  const liabilitiesNode = {
    id: "liabilities",
    name: "Liabilities",
    amount: liabilitiesTotal,
    type: "header",
    children: [
      currentLiabilitiesNode,
      categoryNode("Liabilities", "Long-Term Liabilities", "liab-ltl"),
      {
        id: "liabilities-total",
        name: "Total for Liabilities",
        amount: liabilitiesTotal,
        type: "total",
      },
    ].filter(Boolean),
  };

  const equityNode = {
    id: "equity",
    name: "Equity",
    amount: equityTotal,
    type: "header",
    children: [
      categoryNode("Equity", "Owner Equity", "eq-owner"),
      categoryNode("Equity", "Retained Earnings", "eq-retained"),
      categoryNode("Equity", "Net Income", "eq-net-income"),
      {
        id: "equity-total",
        name: "Total for Equity",
        amount: equityTotal,
        type: "total",
      },
    ].filter(Boolean),
  };

  const liabilitiesAndEquityNode = {
    id: "liabilities-and-equity",
    name: "Liabilities and Equity",
    amount: liabilitiesAndEquityTotal,
    type: "header",
    children: [
      liabilitiesNode,
      equityNode,
      {
        id: "liabilities-and-equity-total",
        name: "Total for Liabilities and Equity",
        amount: liabilitiesAndEquityTotal,
        type: "total",
      },
    ],
  };

  console.log(
    `[ManualGL][BS][Debug] buildBalanceSheetPayload — internal years: [${years.join(", ")}]`,
    `| displayYear: ${displayYear}`,
    `| accounts classified: Assets=${
      sections.Assets.categories.reduce((s, c) => s + c.accounts.length, 0)
    }, Liabilities=${
      sections.Liabilities.categories.reduce((s, c) => s + c.accounts.length, 0)
    }, Equity=${
      sections.Equity.categories.reduce((s, c) => s + c.accounts.length, 0)
    }`,
  );
  if (displayYear) {
    console.log(
      `[ManualGL][BS][Debug] Totals for displayYear ${displayYear}:`,
      `Assets=${sections.Assets.totalByYear?.[displayYear] ?? 0},`,
      `Liabilities=${sections.Liabilities.totalByYear?.[displayYear] ?? 0},`,
      `Equity=${sections.Equity.totalByYear?.[displayYear] ?? 0}`,
    );
  }

  return {
    source: "manual_gl_staged_transactions",
    reportType: "balance_sheet",
    filters,
    years,
    displayYear,
    sections,
    hierarchicalRows: [assetsNode, liabilitiesAndEquityNode],
    audit,
  };
}

async function getBalanceSheetSummaryFromStage(companyId, filters = {}) {
  const effectiveBatchId =
    filters.batchId ||
    (await getLatestManualBatch(companyId, { status: "staged" }))?.id;

  // Load starting + ending BS lines (needed for opening balance and query-time re-classification).
  let startingLines = [];
  let endingLines = [];
  if (effectiveBatchId) {
    [startingLines, endingLines] = await Promise.all([
      loadBatchBalanceSheetLines(companyId, effectiveBatchId, SHEET_TYPE.STARTING),
      loadBatchBalanceSheetLines(companyId, effectiveBatchId, SHEET_TYPE.ENDING),
    ]);
  }

  // STEP 2: Query ALL transactions for the batch, cumulative and unfiltered by year.
  // This is intentional: BS balances are rolling totals — e.g. the Dec-31-2023 balance
  // for an asset account equals openingBalance + 2022 activity + 2023 activity.
  // Year filtering is applied to the RESPONSE after computation (see STEP 5).
  const normalizedFilters = parseManualFilterQuery(filters);
  const targetYears = Array.isArray(normalizedFilters.fiscalYears)
    ? normalizedFilters.fiscalYears.map((y) => Number(y)).filter(Number.isInteger)
    : [];
  let maxYear = null;
  if (targetYears.length) {
    maxYear = Math.max(...targetYears);
  }

  console.log(
    `[ManualGL][BS][Debug] === Balance Sheet Report ===`,
    `| selectedYears: ${JSON.stringify(targetYears)}`,
    `| maxYear: ${maxYear}`,
    `| batchId: ${effectiveBatchId || "none"}`,
  );

  const { rows } = await queryStagedTransactions(companyId, {
    ...filters,
    batchId: effectiveBatchId || filters.batchId || "",
    reportType: "",
    fiscalYear: null,
    fiscalYears: [],
    startDate: "",
    endDate: "",
    limit: DEFAULT_STAGING_LIMIT,
  });

  console.log(`[ManualGL][BS][Debug] Total staged transactions in batch: ${rows.length}`);

  let cumulativeRows = rows;
  if (maxYear) {
    cumulativeRows = rows.filter((r) => Number(r.fiscal_year || 0) <= maxYear);
  }

  console.log(
    `[ManualGL][BS][Debug] Cumulative rows after maxYear (${maxYear}) filter: ${cumulativeRows.length}`,
    `(excluded future years: ${rows.length - cumulativeRows.length})`,
  );

  // Log year distribution of cumulative rows
  const cumulativeYearGroups = {};
  cumulativeRows.forEach((r) => {
    const yr = r.fiscal_year || "unknown";
    cumulativeYearGroups[yr] = (cumulativeYearGroups[yr] || 0) + 1;
  });
  console.log(`[ManualGL][BS][Debug] Cumulative rows by year:`, JSON.stringify(cumulativeYearGroups));

  let normalized = cumulativeRows.map(normalizeStagedTransactionRow).filter(Boolean);

  // STEP 3: Re-classify using BS lines from DB so the BS report is accurate even
  // for data staged before the BS-driven classification was implemented.
  const bsLookup = buildBsLookupFromDbLines(startingLines, endingLines);
  if (bsLookup.size > 0) {
    normalized = reclassifyNormalizedTransactions(normalized, bsLookup);
  }

  const bsAccountCount = normalized.filter((tx) =>
    ["asset", "liability", "equity"].includes(normalizeAccountType(tx.accountType) || ""),
  ).length;
  const plAccountCount = normalized.filter((tx) =>
    ["income", "cogs", "expense"].includes(normalizeAccountType(tx.accountType) || ""),
  ).length;
  console.log(
    `[ManualGL][BS][Debug] After reclassification — BS transactions: ${bsAccountCount}, P&L transactions: ${plAccountCount}, total: ${normalized.length}`,
  );

  // Build P&L once from the same normalized dataset to derive netProfitByYear
  // for Retained Earnings / Net Income reconciliation.
  const pnlPayload = buildProfitLossSummaryPayload(normalized, {
    ...normalizedFilters,
    batchId: normalizedFilters.batchId || effectiveBatchId || "",
  });

  console.log(
    `[ManualGL][BS][Debug] Internal P&L netProfitByYear (for retained earnings):`,
    JSON.stringify(pnlPayload.netProfitByYear || {}),
  );

  // STEP 4: Build reconciled Balance Sheet using cumulative transactions.
  const payload = buildBalanceSheetPayload(
    normalized,
    {
      ...normalizedFilters,
      batchId: normalizedFilters.batchId || effectiveBatchId || "",
    },
    pnlPayload.netProfitByYear || {},
    startingLines,
  );

  console.log(
    `[ManualGL][BS][Debug] Built BS payload — internal years: [${(payload.years || []).join(", ")}]`,
    `| displayYear: ${payload.displayYear}`,
    `| assets total: ${payload.sections?.Assets?.totalByYear?.[payload.displayYear] ?? "n/a"}`,
    `| liabilities total: ${payload.sections?.Liabilities?.totalByYear?.[payload.displayYear] ?? "n/a"}`,
    `| equity total: ${payload.sections?.Equity?.totalByYear?.[payload.displayYear] ?? "n/a"}`,
  );

  // Per-year balance equation validation (Assets = Liabilities + Equity).
  // Logged at every BS report call so discrepancies surface in server logs
  // without waiting for a staging re-run.
  if (Array.isArray(payload.audit) && payload.audit.length > 0) {
    console.log("[ManualGL][BS][Validation] ═══ Per-Year Balance Equation Check ═══");
    payload.audit.forEach((a) => {
      const diffStr = a.difference !== 0 ? ` ← VARIANCE: ${a.difference}` : "";
      const status = a.isBalanced ? "BALANCED ✓" : "IMBALANCED ✗";
      console.log(
        `[ManualGL][BS][Validation]   Year ${a.year}: ` +
        `Assets=${a.assets}  L+E=${a.liabilitiesAndEquity}  ${status}${diffStr}`,
      );
    });
    const totalImbalanced = payload.audit.filter((a) => !a.isBalanced).length;
    if (totalImbalanced > 0) {
      console.warn(
        `[ManualGL][BS][Validation] *** ${totalImbalanced} year(s) are IMBALANCED — ` +
        `check account classification and opening balance accuracy ***`,
      );
    }
    console.log("[ManualGL][BS][Validation] ═══════════════════════════════════════");
  }

  // STEP 5: Restrict the response to ONLY the user-selected year(s).
  // The internal computation correctly used cumulative data for rolling balances.
  // Exposing all cumulative years in the response would cause cross-year contamination
  // in the frontend (spurious year columns, wrong totals when a single year is selected).
  if (targetYears.length > 0) {
    const restricted = restrictBsPayloadToSelectedYears(payload, targetYears);
    console.log(
      `[ManualGL][BS][Debug] Response years after restriction: [${(restricted.years || []).join(", ")}]`,
    );
    return restricted;
  }

  return payload;
}

// ─── BS-Driven Account Classification Engine ─────────────────────────────────

/**
 * Builds a normalized account-name → BS classification lookup map from
 * one or two parsed balance sheets (starting and/or ending).
 *
 * Normalization: lowercase + strip non-alphanumeric → "accounts receivable"
 * so minor formatting differences between GL and BS don't break matching.
 *
 * Starting sheet takes precedence when the same account appears in both.
 */
function buildBsLookupFromParsedSheets(startingParsed = null, endingParsed = null) {
  const map = new Map();

  function addSheet(parsed) {
    if (!parsed) return;
    ["assets", "liabilities", "equity"].forEach((section) => {
      const items = parsed[section];
      if (!Array.isArray(items)) return;
      items.forEach((item) => {
        const key = normalizeAccountLabel(String(item.name || ""));
        if (!key) return;
        if (map.has(key)) return; // first-seen wins (starting BS takes priority)
        const accountType =
          section === "assets"
            ? "asset"
            : section === "liabilities"
              ? "liability"
              : "equity";
        const majorGroup = item.majorGroup || "";
        const minorGroup = item.minorGroup || "";
        map.set(key, {
          accountType,
          section,
          majorGroup,
          minorGroup,
          leafCategory: item.leafCategory || minorGroup || majorGroup || "",
          hierarchyPath: [section, majorGroup, minorGroup].filter(Boolean).join(" > "),
        });
      });
    });
  }

  // Starting sheet is checked first so it wins on conflicts
  addSheet(startingParsed);
  addSheet(endingParsed);

  console.log(`[ManualGL][BsLookup] Built lookup map with ${map.size} unique accounts.`);
  if (map.size > 0) {
    const sample = Array.from(map.keys()).slice(0, 10);
    console.log("[ManualGL][BsLookup] Sample BS accounts:", sample);
  }

  return map;
}

/**
 * Builds a BS lookup map from rows already stored in manual_gl_balance_sheet_lines.
 * Used for query-time re-classification so reports are accurate even for data
 * that was staged before the BS-driven classification was implemented.
 */
function buildBsLookupFromDbLines(startingLines = [], endingLines = []) {
  const map = new Map();

  function addLines(lines) {
    lines.forEach((line) => {
      const key = normalizeAccountLabel(String(line.account_name || ""));
      if (!key || map.has(key)) return;
      const section = String(line.section || "");
      const accountType = section === "assets" ? "asset"
        : section === "liabilities" ? "liability"
        : section === "equity" ? "equity"
        : null;
      if (!accountType) return;
      const metadata = line.metadata && typeof line.metadata === "object" ? line.metadata : {};
      const majorGroup = metadata.majorGroup || "";
      const minorGroup = metadata.minorGroup || "";
      // Prefer structural majorGroup over stored leafCategory for fixed groupings where
      // legacy data may have an incorrect leafCategory from before the BS-driven fix.
      // e.g. majorGroup="Fixed Assets" but leafCategory="Other Current Assets" → use majorGroup.
      const AUTHORITATIVE_MAJOR_GROUPS = new Set(["Fixed Assets", "Other Assets", "Long-Term Liabilities"]);
      const rawLeaf = metadata.leafCategory || minorGroup || majorGroup || "";
      const leafCategory = AUTHORITATIVE_MAJOR_GROUPS.has(majorGroup) ? majorGroup : rawLeaf;
      map.set(key, {
        accountType,
        section,
        majorGroup,
        minorGroup,
        leafCategory,
        hierarchyPath: [section, majorGroup, minorGroup].filter(Boolean).join(" > "),
      });
    });
  }

  addLines(startingLines); // Starting wins on conflict
  addLines(endingLines);
  return map;
}

/**
 * Re-classifies already-normalized transaction rows (output of normalizeStagedTransactionRow)
 * using a BS lookup map. Rows found in the BS lookup are updated to the correct BS type;
 * rows not found keep their existing classification (no forced-to-expense fallback here,
 * because the stored keyword-based type may already be correct for legitimate P&L accounts).
 */
function reclassifyNormalizedTransactions(normalizedRows = [], bsLookupMap = new Map()) {
  if (!bsLookupMap || !bsLookupMap.size) return normalizedRows;

  return normalizedRows.map((tx) => {
    const lookupKey = normalizeAccountLabel(String(tx.accountName || ""));
    const bsEntry = bsLookupMap.get(lookupKey);

    if (bsEntry) {
      const bsType = bsEntry.accountType; // 'asset' | 'liability' | 'equity'
      const bsCategory = normalizeBalanceSheetCategory(bsEntry.leafCategory, tx.accountName, bsType);
      return {
        ...tx,
        accountType: bsType,
        category: bsCategory || bsEntry.leafCategory || tx.category || "",
        subCategory: bsEntry.leafCategory || tx.subCategory || "",
      };
    }

    // Not in BS → keep existing type intact (preserves correct keyword P&L accounts)
    return tx;
  });
}

/**
 * Loads the BS lookup map for a given batch from the DB.
 * Returns an empty Map if no BS lines exist or on error.
 */
async function loadBsLookupForBatch(companyId, batchId) {
  if (!companyId || !batchId) return new Map();
  try {
    const [startingLines, endingLines] = await Promise.all([
      loadBatchBalanceSheetLines(companyId, batchId, SHEET_TYPE.STARTING),
      loadBatchBalanceSheetLines(companyId, batchId, SHEET_TYPE.ENDING),
    ]);
    const lookup = buildBsLookupFromDbLines(startingLines, endingLines);
    if (lookup.size > 0) {
      console.log(`[ManualGL][QueryClassify] Query-time BS lookup for batch ${batchId}: ${lookup.size} accounts`);
    }
    return lookup;
  } catch (err) {
    console.warn(`[ManualGL][QueryClassify] Could not load BS lookup for batch ${batchId}:`, err.message);
    return new Map();
  }
}

/**
 * Classifies each GL transaction as Balance Sheet or Profit & Loss using
 * the balance sheet lookup map.
 *
 * Rule (per spec):
 *   - Account in starting OR ending BS → BALANCE_SHEET (type = asset/liability/equity)
 *   - Account NOT in either BS         → PROFIT_LOSS   (type = income/cogs/expense)
 *
 * When no BS is provided (map is empty) the function returns transactions
 * unchanged — falling back to the existing keyword-based classification.
 */
function classifyGlTransactionsWithBsLookup(transactions = [], bsLookupMap = new Map()) {
  if (!bsLookupMap || !bsLookupMap.size) {
    console.log(
      "[ManualGL][Classify] No BS lookup map available — using keyword-based classification (fallback).",
    );
    return transactions;
  }

  let bsMatched = 0;
  let plClassified = 0;
  let ambiguous = 0;
  const ambiguousAccounts = [];
  const unmatchedByName = new Set();
  // Track first-seen accounts for per-account debug log (avoid flooding for repeated transactions)
  const debuggedAccounts = new Set();

  const result = transactions.map((tx) => {
    const lookupKey = normalizeAccountLabel(String(tx.accountName || ""));
    const bsEntry = bsLookupMap.get(lookupKey);

    // ── BALANCE SHEET account ──
    if (bsEntry) {
      bsMatched++;
      const bsType = bsEntry.accountType; // 'asset' | 'liability' | 'equity'
      const bsCategory = normalizeBalanceSheetCategory(
        bsEntry.leafCategory,
        tx.accountName,
        bsType,
      );

      if (!debuggedAccounts.has(lookupKey)) {
        debuggedAccounts.add(lookupKey);
        console.log(
          `[ManualGL][DistribSection] MATCHED "${tx.accountName}" → section: ${bsEntry.section}, ` +
          `type: ${bsType}, majorGroup: "${bsEntry.majorGroup || ""}", ` +
          `minorGroup: "${bsEntry.minorGroup || ""}", path: "${bsEntry.hierarchyPath || bsEntry.section}"`,
        );
      }

      return {
        ...tx,
        accountType: bsType.charAt(0).toUpperCase() + bsType.slice(1),
        category: bsCategory || bsEntry.leafCategory || "",
        subCategory: bsEntry.leafCategory || bsCategory || "",
        metadata: {
          ...(tx.metadata || {}),
          statementType: "BALANCE_SHEET",
          bsSection: bsEntry.section,
          bsMajorGroup: bsEntry.majorGroup || "",
          bsMinorGroup: bsEntry.minorGroup || "",
          bsLeafCategory: bsEntry.leafCategory || "",
          bsHierarchyPath: bsEntry.hierarchyPath || bsEntry.section,
          classifiedBy: "bs_lookup",
        },
      };
    }

    // ── PROFIT & LOSS account ──
    plClassified++;
    unmatchedByName.add(tx.accountName);

    if (!debuggedAccounts.has(lookupKey)) {
      debuggedAccounts.add(lookupKey);
      console.log(
        `[ManualGL][DistribSection] UNMATCHED "${tx.accountName}" — not found in starting or ending balance sheet → classified as P&L`,
      );
    }

    // Determine P&L sub-type via keyword inference
    const rawKeywordType =
      normalizeAccountType(tx.accountType) ||
      inferAccountType(tx.accountName, tx.accountNumber);

    let plType = rawKeywordType;

    // If keyword says this looks like a BS account but it's NOT in the BS,
    // log it and default to expense (safest conservative assumption).
    if (["asset", "liability", "equity"].includes(rawKeywordType)) {
      ambiguous++;
      ambiguousAccounts.push({
        accountName: tx.accountName,
        keywordType: rawKeywordType,
      });
      plType = "expense";
    }

    if (!["income", "cogs", "expense"].includes(plType)) {
      plType = "expense";
    }

    const plCategory = normalizeProfitLossCategory(
      tx.category,
      tx.accountName,
      plType,
    );
    const plSubCategory = inferProfitLossSubCategory(tx.accountName, plCategory);

    return {
      ...tx,
      accountType:
        plType === "income" ? "Income" : plType === "cogs" ? "Cogs" : "Expense",
      category: plCategory || "Operating Expenses",
      subCategory: plSubCategory || "",
      metadata: {
        ...(tx.metadata || {}),
        statementType: "PROFIT_LOSS",
        classifiedBy: "bs_lookup_miss",
        originalKeywordType:
          rawKeywordType !== plType ? rawKeywordType : undefined,
      },
    };
  });

  console.log(
    `[ManualGL][Classify] Result: ${bsMatched} Balance Sheet, ${plClassified} P&L, ${ambiguous} ambiguous-forced-to-expense`,
  );

  if (ambiguous > 0) {
    const uniqueAmbiguous = [
      ...new Map(ambiguousAccounts.map((a) => [a.accountName, a])).values(),
    ].slice(0, 30);
    console.warn(
      "[ManualGL][Classify] Ambiguous accounts (keyword says BS type but NOT in balance sheets — treated as P&L Expense):",
      uniqueAmbiguous.map((a) => `"${a.accountName}" (${a.keywordType})`).join(", "),
    );
  }

  if (unmatchedByName.size > 0) {
    const sample = Array.from(unmatchedByName).slice(0, 20);
    console.log(
      `[ManualGL][Classify] ${unmatchedByName.size} unique GL accounts classified as P&L (not found in balance sheets). Sample:`,
      sample,
    );
  }

  return result;
}

// ─── Distribution Account Section Validation ─────────────────────────────────

/**
 * Builds a per-sheet (starting / ending) section breakdown for every account
 * found in the balance sheets. Unlike buildBsLookupFromParsedSheets this keeps
 * both sheets independent so cross-year inconsistencies can be detected.
 *
 * Returns Map<normalizedKey, { starting: entry|null, ending: entry|null }>
 * where entry = { accountType, section, majorGroup, minorGroup, leafCategory, hierarchyPath }
 */
function buildDetailedBsSectionMap(startingParsed = null, endingParsed = null) {
  const map = new Map();

  function extractEntry(section, item) {
    const accountType =
      section === "assets" ? "asset"
        : section === "liabilities" ? "liability"
          : "equity";
    const majorGroup = item.majorGroup || "";
    const minorGroup = item.minorGroup || "";
    return {
      accountType,
      section,
      majorGroup,
      minorGroup,
      leafCategory: item.leafCategory || minorGroup || majorGroup || "",
      hierarchyPath: [section, majorGroup, minorGroup].filter(Boolean).join(" > "),
    };
  }

  function addSheet(parsed, sheetKey) {
    if (!parsed) return;
    ["assets", "liabilities", "equity"].forEach((section) => {
      (parsed[section] || []).forEach((item) => {
        const key = normalizeAccountLabel(String(item.name || ""));
        if (!key) return;
        if (!map.has(key)) map.set(key, { starting: null, ending: null });
        map.get(key)[sheetKey] = extractEntry(section, item);
      });
    });
  }

  addSheet(startingParsed, "starting");
  addSheet(endingParsed, "ending");

  console.log(`[ManualGL][DetailedSectionMap] Built detailed section map with ${map.size} unique accounts.`);
  return map;
}

/**
 * Validates every unique GL distribution account against the detailed section
 * map. Produces four buckets:
 *   matched                — found in ≥1 sheet; logs section + hierarchy path
 *   unmatched              — not in either balance sheet
 *   crossYearInconsistencies — section differs between starting and ending sheet
 *   conflicts              — keyword-inferred type contradicts BS section placement
 *
 * All findings are logged immediately. The returned object is stored in batch
 * metadata so it can be surfaced to the UI or external review.
 */
function validateDistributionAccountSections(glAccountNames = [], detailedSectionMap) {
  const matched = [];
  const unmatched = [];
  const crossYearInconsistencies = [];
  const conflicts = [];

  const seenKeys = new Set();

  for (const accountName of glAccountNames) {
    if (!accountName) continue;
    const key = normalizeAccountLabel(accountName);
    if (!key || seenKeys.has(key)) continue;
    seenKeys.add(key);

    const entry = detailedSectionMap ? detailedSectionMap.get(key) : null;
    if (!entry || (!entry.starting && !entry.ending)) {
      unmatched.push({ accountName, normalizedKey: key });
      console.log(`[ManualGL][DistribValidate] UNMATCHED "${accountName}" — not present in starting or ending balance sheet`);
      continue;
    }

    const { starting, ending } = entry;
    const foundIn = [];
    if (starting) foundIn.push("STARTING");
    if (ending) foundIn.push("ENDING");

    // Detect cross-year section inconsistency
    if (starting && ending && starting.section !== ending.section) {
      crossYearInconsistencies.push({
        accountName,
        startingSection: starting.section,
        endingSection: ending.section,
        startingPath: starting.hierarchyPath,
        endingPath: ending.hierarchyPath,
      });
      console.warn(
        `[ManualGL][DistribValidate] CROSS-YEAR INCONSISTENCY "${accountName}" — ` +
        `Starting: ${starting.section} (${starting.hierarchyPath}) vs ` +
        `Ending: ${ending.section} (${ending.hierarchyPath})`,
      );
    }

    // Effective classification — starting sheet wins
    const effective = starting || ending;

    // Detect keyword-vs-BS-section conflicts
    const keywordType = inferAccountType(accountName, "");
    if (
      keywordType &&
      keywordType !== effective.accountType &&
      (
        (keywordType === "asset" && ["liability", "equity"].includes(effective.accountType)) ||
        (keywordType === "liability" && effective.accountType === "asset") ||
        (keywordType === "equity" && effective.accountType === "asset")
      )
    ) {
      conflicts.push({
        accountName,
        keywordType,
        bsSection: effective.section,
        bsAccountType: effective.accountType,
        hierarchyPath: effective.hierarchyPath,
        issue: `Keyword infers "${keywordType}" but BS places account under "${effective.section}"`,
      });
      console.warn(
        `[ManualGL][DistribValidate] CONFLICT "${accountName}" — ` +
        `keyword type "${keywordType}" vs BS section "${effective.section}" (${effective.hierarchyPath})`,
      );
    }

    matched.push({
      accountName,
      foundIn,
      section: effective.section,
      accountType: effective.accountType,
      majorGroup: effective.majorGroup,
      minorGroup: effective.minorGroup,
      leafCategory: effective.leafCategory,
      hierarchyPath: effective.hierarchyPath,
      startingSection: starting ? starting.section : null,
      endingSection: ending ? ending.section : null,
    });

    console.log(
      `[ManualGL][DistribValidate] MATCHED "${accountName}" → ` +
      `section: ${effective.section}, type: ${effective.accountType}, ` +
      `path: "${effective.hierarchyPath}" [found in: ${foundIn.join(", ")}]`,
    );
  }

  console.log(
    `[ManualGL][DistribValidate] Summary — matched: ${matched.length}, ` +
    `unmatched: ${unmatched.length}, crossYearInconsistencies: ${crossYearInconsistencies.length}, ` +
    `conflicts: ${conflicts.length}`,
  );

  return { matched, unmatched, crossYearInconsistencies, conflicts };
}

// ─── Multi-Year Detection ─────────────────────────────────────────────────────

/**
 * Inspects a flat array of classified/parsed transactions and returns an audit
 * object describing how many fiscal years are present and how many transactions
 * belong to each one. Used for logging and for storing rich metadata in the batch.
 *
 * @param {Array} transactions  - Parsed transaction objects (camelCase shape from parseGlSheetTransactions)
 * @returns {{ years: number[], perYearCounts: Object, isMultiYear: boolean, fileType: string }}
 */
function detectMultipleYears(transactions = []) {
  const perYearCounts = {};
  let invalidDateCount = 0;

  transactions.forEach((tx) => {
    const yr = tx.fiscalYear;
    if (!Number.isInteger(yr) || yr <= 0) {
      invalidDateCount += 1;
      return;
    }
    perYearCounts[yr] = (perYearCounts[yr] || 0) + 1;
  });

  const years = Object.keys(perYearCounts)
    .map(Number)
    .sort((a, b) => a - b);

  const isMultiYear = years.length > 1;
  const fileType = isMultiYear ? "MULTI_YEAR_GL" : "SINGLE_YEAR_GL";

  return { years, perYearCounts, isMultiYear, fileType, invalidDateCount };
}

/**
 * Logs a structured summary of year detection results to the console.
 * Call this immediately after all GL files have been parsed and classified,
 * before any DB inserts, so the staging log contains clear evidence of the
 * multi-year scenario if one is detected.
 */
function logYearDetectionAudit(detection) {
  const { years, perYearCounts, isMultiYear, fileType, invalidDateCount } = detection;
  console.log("[ManualGL][YearDetection] ==========================================");
  console.log(`[ManualGL][YearDetection] File type detected : ${fileType}`);
  console.log(`[ManualGL][YearDetection] Fiscal years found : [${years.join(", ") || "none"}]`);
  if (isMultiYear) {
    console.log("[ManualGL][YearDetection] *** MULTI-YEAR GL FILE — processing each year independently ***");
  }
  years.forEach((yr) => {
    console.log(`[ManualGL][YearDetection]   ${yr} → ${perYearCounts[yr]} transactions`);
  });
  if (invalidDateCount > 0) {
    console.warn(
      `[ManualGL][YearDetection]   ${invalidDateCount} transactions have no parseable fiscal year and will be excluded from year-grouped reports`,
    );
  }
  console.log("[ManualGL][YearDetection] ==========================================");
}

async function stageMultiYearGlUpload({
  companyId,
  glUploadIds = [],
  startingBalanceSheetUploadId = "",
  endingBalanceSheetUploadId = "",
  mapping = {},
  uploadedBy = null,
  batchName = "",
}) {
  console.log("[ManualGL][MultiYear] === START ===", {
    companyId,
    glUploadIds,
    startingBalanceSheetUploadId,
    endingBalanceSheetUploadId,
    mappingKeys: Object.keys(mapping || {}),
    batchName,
  });
  if (!companyId) throw new Error("companyId is required");

  const normalizedUploadIds = Array.from(
    new Set(
      (Array.isArray(glUploadIds) ? glUploadIds : [])
        .map((item) => String(item || "").trim())
        .filter(Boolean),
    ),
  );

  if (!normalizedUploadIds.length) {
    throw new Error("At least one GL uploadId is required.");
  }

  if (!startingBalanceSheetUploadId) {
    console.warn(
      "[ManualGL][MultiYear] No Starting Balance Sheet provided — classification will fall back to keyword inference. " +
      "Provide a Starting Balance Sheet for accurate BS vs P&L bifurcation.",
    );
  }
  if (!endingBalanceSheetUploadId) {
    console.warn(
      "[ManualGL][MultiYear] No Ending Balance Sheet provided — classification will fall back to keyword inference. " +
      "Provide an Ending Balance Sheet for accurate BS vs P&L bifurcation.",
    );
  }

  const sourceContext = await loadCompanySourceContext(companyId);
  const sourceSwitchVersion = sourceContext.sourceSwitchVersion || new Date().toISOString();
  const sourceType = sourceContext.sourceType || MANUAL_SOURCE_KEY;
  const uploadSessionId = crypto.randomUUID();
  const stageStartedAt = new Date().toISOString();

  console.log("[ManualGL][MultiYear] Creating batch...");
  const batch = await createBatch({
    companyId,
    createdBy: uploadedBy,
    batchName,
    sourceType,
    sourceSwitchVersion,
    uploadSessionId,
  });
  console.log("[ManualGL][MultiYear] Batch created:", batch.id);
  const effectiveMapping = ensureMappingShape(mapping || {});

  const parsingWarnings = [];
  const resolvedMappings = {};
  const filesParsed = [];
  const filesRequiringMapping = [];

  // Tracks parsed BS data so we can insert lines after GL classification
  const balanceSheetInfo = {
    startingParsed: null,
    endingParsed: null,
    startingUpload: null,
    endingUpload: null,
    inserted: { starting: 0, ending: 0 },
  };

  try {
    // ── PHASE 1: Parse Balance Sheets FIRST ──────────────────────────────────
    // We must know BS accounts before classifying GL transactions, so BS files
    // are parsed here (not inserted yet — that happens after GL classification).

    if (startingBalanceSheetUploadId) {
      console.log(
        "[ManualGL][MultiYear] Phase 1 – Parsing STARTING balance sheet:",
        startingBalanceSheetUploadId,
      );
      try {
        const startUpload = await loadUpload(String(startingBalanceSheetUploadId).trim());
        const startSheets = parseWorkbook(startUpload);
        const startSheet = selectBalanceSheetSheet(startSheets, SHEET_TYPE.STARTING);
        if (startSheet) {
          balanceSheetInfo.startingParsed = parseBalanceSheetFromSheet(startSheet);
          balanceSheetInfo.startingUpload = startUpload;
          console.log(
            "[ManualGL][MultiYear] Starting BS parsed — assets:",
            balanceSheetInfo.startingParsed.assets?.length,
            "liabilities:",
            balanceSheetInfo.startingParsed.liabilities?.length,
            "equity:",
            balanceSheetInfo.startingParsed.equity?.length,
          );
        }
      } catch (bsErr) {
        console.error("[ManualGL][MultiYear] Failed to parse STARTING balance sheet:", bsErr.message);
      }
    }

    if (endingBalanceSheetUploadId) {
      console.log(
        "[ManualGL][MultiYear] Phase 1 – Parsing ENDING balance sheet:",
        endingBalanceSheetUploadId,
      );
      try {
        const endUpload = await loadUpload(String(endingBalanceSheetUploadId).trim());
        const endSheets = parseWorkbook(endUpload);
        const endSheet = selectBalanceSheetSheet(endSheets, SHEET_TYPE.ENDING);
        if (endSheet) {
          balanceSheetInfo.endingParsed = parseBalanceSheetFromSheet(endSheet);
          balanceSheetInfo.endingUpload = endUpload;
          console.log(
            "[ManualGL][MultiYear] Ending BS parsed — assets:",
            balanceSheetInfo.endingParsed.assets?.length,
            "liabilities:",
            balanceSheetInfo.endingParsed.liabilities?.length,
            "equity:",
            balanceSheetInfo.endingParsed.equity?.length,
          );
        }
      } catch (bsErr) {
        console.error("[ManualGL][MultiYear] Failed to parse ENDING balance sheet:", bsErr.message);
      }
    }

    // ── PHASE 2: Build BS account lookup map ─────────────────────────────────
    // Maps normalised account name → { accountType, section, majorGroup, minorGroup, leafCategory, hierarchyPath }.
    // Empty map means no BS was provided → fall back to keyword classification.

    const bsLookupMap = buildBsLookupFromParsedSheets(
      balanceSheetInfo.startingParsed,
      balanceSheetInfo.endingParsed,
    );

    // Separate per-sheet map used exclusively for distribution account validation
    // (keeps starting and ending independent so cross-year inconsistencies are detectable).
    const detailedSectionMap = buildDetailedBsSectionMap(
      balanceSheetInfo.startingParsed,
      balanceSheetInfo.endingParsed,
    );

    const hasBsLookup = bsLookupMap.size > 0;
    console.log(
      `[ManualGL][MultiYear] Phase 2 – BS lookup map: ${bsLookupMap.size} accounts (${hasBsLookup ? "data-driven classification" : "keyword-based fallback"})`,
    );

    // ── PHASE 3: Parse GL files, classify, then insert ───────────────────────
    // Each file's transactions are classified using the BS lookup before
    // being persisted, so account_type in the DB is always BS-driven.

    let totalInserted = 0;
    let totalDuplicates = 0;
    let totalCrossFileDuplicates = 0;
    const combinedYearGroups = {};
    const seenCrossFileHashes = new Map();

    // Collect all classified transactions for in-memory validation summary
    const allClassifiedTransactions = [];

    for (const uploadId of normalizedUploadIds) {
      try {
        const upload = await loadUpload(uploadId);
        const sheets = parseWorkbook(upload);
        const scored = sheets
          .map((sheet) => ({ sheet, score: scoreSheetForGl(sheet) }))
          .sort((a, b) => b.score - a.score);

        const candidateSheets = scored.filter((item) => item.score >= 4).map((item) => item.sheet);
        const selectedSheets = candidateSheets.length > 0 ? candidateSheets : [scored[0].sheet];

        const bestSheet = selectedSheets[0];
        const fileYearHint = inferFiscalYear({ upload, sheetData: bestSheet });

        let rawFileTransactions = [];
        let fileParsedAtLeastOne = false;

        for (const sheetData of selectedSheets) {
          const parsed = parseGlSheetTransactions({
            companyId,
            upload,
            sheetData,
            mapping: effectiveMapping,
            fiscalYearHint: fileYearHint,
          });

          if (!parsed.success) continue;

          fileParsedAtLeastOne = true;
          resolvedMappings[uploadId] = parsed.mapping;
          rawFileTransactions.push(...parsed.transactions);
          parsingWarnings.push(
            ...parsed.warnings.map((w) => ({ ...w, uploadId, fileName: upload.file_name })),
          );
        }

        if (!fileParsedAtLeastOne || rawFileTransactions.length === 0) {
          filesRequiringMapping.push({ uploadId, fileName: upload.file_name });
          continue;
        }

        // Apply BS-driven classification (or keyword fallback when no BS)
        const classifiedTransactions = classifyGlTransactionsWithBsLookup(
          rawFileTransactions,
          bsLookupMap,
        );

        const dedupedTransactions = [];
        let fileCrossFileDuplicates = 0;
        classifiedTransactions.forEach((tx) => {
          const crossFileHash = buildCrossFileDedupHash(tx);
          const sourceUploadId = String(tx.sourceUploadId || "");
          const firstSeenUploadId = seenCrossFileHashes.get(crossFileHash);

          // Only de-duplicate when the same business transaction appears
          // across different uploads within the same staging batch.
          if (firstSeenUploadId && firstSeenUploadId !== sourceUploadId) {
            fileCrossFileDuplicates += 1;
            return;
          }

          if (!firstSeenUploadId) {
            seenCrossFileHashes.set(crossFileHash, sourceUploadId);
          }
          dedupedTransactions.push(tx);
        });
        totalCrossFileDuplicates += fileCrossFileDuplicates;

        allClassifiedTransactions.push(...dedupedTransactions);

        const insertStats = await insertTransactions({
          companyId,
          batchId: batch.id,
          transactions: dedupedTransactions,
          sourceType,
          sourceSwitchVersion,
          uploadSessionId,
        });

        totalInserted += insertStats.inserted;
        totalDuplicates += insertStats.duplicates || 0;

        Object.entries(insertStats.yearGroups || {}).forEach(([year, count]) => {
          combinedYearGroups[year] = (combinedYearGroups[year] || 0) + count;
        });

        filesParsed.push(upload.file_name);
        console.log(
          `[ManualGL][MultiYear] Staged ${insertStats.inserted} classified rows from "${upload.file_name}" ` +
          `(cross-file duplicates skipped: ${fileCrossFileDuplicates})`,
        );
      } catch (fileErr) {
        console.error(`[ManualGL][MultiYear] Error processing GL file ${uploadId}:`, fileErr);
      }
    }

    if (totalInserted === 0 && filesRequiringMapping.length > 0) {
      const firstFail = filesRequiringMapping[0];
      await updateBatch(batch.id, {
        status: "failed",
        metadata: {
          requiresManualMapping: true,
          failedUploadId: firstFail.uploadId,
          failedFileName: firstFail.fileName,
        },
      });
      return {
        success: false,
        requiresManualMapping: true,
        batchId: batch.id,
        failedUploadId: firstFail.uploadId,
        fileName: firstFail.fileName,
        error: "Mapping required for one or more files.",
      };
    }

    console.log(
      `[ManualGL][MultiYear] Phase 3 complete — ${totalInserted} classified transactions persisted.`,
    );

    // ── PHASE 3a: Multi-year detection ───────────────────────────────────────
    // Inspect every classified transaction to determine whether this upload
    // spans a single year or multiple years. The result is logged immediately
    // for debugging, and stored in batch metadata so callers can surface the
    // file type to the UI without re-scanning transactions.
    const yearDetection = detectMultipleYears(allClassifiedTransactions);
    logYearDetectionAudit(yearDetection);

    // ── PHASE 3b: Validate distribution account section classifications ───────
    // Collect every unique GL account name, then check WHERE each appears in the
    // balance sheet hierarchy. Detects unmatched accounts, cross-year section
    // inconsistencies, and keyword-vs-BS conflicts. Results are stored in the
    // batch metadata for downstream review.
    const uniqueGlAccounts = [
      ...new Set(
        allClassifiedTransactions.map((tx) => tx.accountName).filter(Boolean),
      ),
    ];
    console.log(
      `[ManualGL][MultiYear] Phase 3b – validating ${uniqueGlAccounts.length} unique distribution accounts against balance sheet hierarchy...`,
    );
    const distributionValidation = validateDistributionAccountSections(uniqueGlAccounts, detailedSectionMap);

    // ── PHASE 4: Insert Balance Sheet lines ──────────────────────────────────
    // Now that GL is stored, persist the BS line data we parsed in Phase 1.

    if (balanceSheetInfo.startingParsed && balanceSheetInfo.startingUpload) {
      const lines = toBalanceSheetLineRows({
        companyId,
        batchId: batch.id,
        upload: balanceSheetInfo.startingUpload,
        sheetType: SHEET_TYPE.STARTING,
        parsed: balanceSheetInfo.startingParsed,
        sourceType,
        sourceSwitchVersion,
        uploadSessionId,
        stagedAt: stageStartedAt,
      });
      const result = await replaceBalanceSheetLines({
        companyId,
        batchId: batch.id,
        sheetType: SHEET_TYPE.STARTING,
        lines,
      });
      balanceSheetInfo.inserted.starting = result.inserted;
      console.log(
        `[ManualGL][MultiYear] Phase 4 – STARTING BS lines inserted: ${result.inserted}`,
      );
    }

    if (balanceSheetInfo.endingParsed && balanceSheetInfo.endingUpload) {
      const lines = toBalanceSheetLineRows({
        companyId,
        batchId: batch.id,
        upload: balanceSheetInfo.endingUpload,
        sheetType: SHEET_TYPE.ENDING,
        parsed: balanceSheetInfo.endingParsed,
        sourceType,
        sourceSwitchVersion,
        uploadSessionId,
        stagedAt: stageStartedAt,
      });
      const result = await replaceBalanceSheetLines({
        companyId,
        batchId: batch.id,
        sheetType: SHEET_TYPE.ENDING,
        lines,
      });
      balanceSheetInfo.inserted.ending = result.inserted;
      console.log(
        `[ManualGL][MultiYear] Phase 4 – ENDING BS lines inserted: ${result.inserted}`,
      );
    }

    // ── PHASE 5: Summary, validation, batch update ───────────────────────────

    const normalizedTransactions = allClassifiedTransactions
      .map(normalizeStagedTransactionRow)
      .filter(Boolean);

    console.log("[ManualGL][MultiYear] Building P&L summary from classified transactions...");
    const summaryPayload = buildProfitLossSummaryPayload(normalizedTransactions, {
      batchId: batch.id,
    });
    console.log("[ManualGL][MultiYear] P&L summary built, years:", summaryPayload.years);

    // Log classification quality metrics
    const bsAccounts = normalizedTransactions.filter((tx) =>
      ["asset", "liability", "equity"].includes(
        normalizeAccountType(tx.accountType) || "",
      ),
    ).length;
    const plAccounts = normalizedTransactions.filter((tx) =>
      ["income", "cogs", "expense"].includes(
        normalizeAccountType(tx.accountType) || "",
      ),
    ).length;
    console.log(
      `[ManualGL][MultiYear] Classification audit — BS transactions: ${bsAccounts}, P&L transactions: ${plAccounts}, total: ${normalizedTransactions.length}`,
    );

    let validation = null;
    if (balanceSheetInfo.startingParsed || balanceSheetInfo.endingParsed) {
      const startingLines = await loadBatchBalanceSheetLines(
        companyId,
        batch.id,
        SHEET_TYPE.STARTING,
      );
      const endingLines = await loadBatchBalanceSheetLines(
        companyId,
        batch.id,
        SHEET_TYPE.ENDING,
      );
      validation = computeBalanceSheetRollforwardValidation({
        startingLines,
        endingLines,
        transactions: normalizedTransactions,
        profitLossSummary: summaryPayload,
      });
      if (validation.mismatches?.length > 0) {
        console.warn(
          "[ManualGL][MultiYear] Balance Sheet rollforward mismatches:",
          validation.mismatches.slice(0, 10),
        );
      }
    }

    console.log("[ManualGL][MultiYear] Updating batch to staged...");
    await updateBatch(batch.id, {
      status: "staged",
      metadata: {
        requiresManualMapping: false,
        glUploadIds: normalizedUploadIds,
        startingBalanceSheetUploadId: startingBalanceSheetUploadId || null,
        endingBalanceSheetUploadId: endingBalanceSheetUploadId || null,
        filesParsed,
        insertedTransactions: totalInserted,
        duplicateTransactionsSkipped: totalDuplicates,
        crossFileDuplicateTransactionsSkipped: totalCrossFileDuplicates,
        warningsCount: parsingWarnings.length,
        classificationMode: hasBsLookup ? "bs_driven" : "keyword_fallback",
        bsLookupAccountCount: bsLookupMap.size,
        // Multi-year detection results (from Phase 3a)
        fileType: yearDetection.fileType,
        isMultiYearUpload: yearDetection.isMultiYear,
        yearsDetected: yearDetection.years,
        perYearTransactionCounts: yearDetection.perYearCounts,
        invalidDateTransactionCount: yearDetection.invalidDateCount,
        sourceType,
        sourceSwitchVersion,
        uploadSessionId,
        stageStartedAt,
        stageCompletedAt: new Date().toISOString(),
        validation,
        distributionValidation: {
          matchedCount: distributionValidation.matched.length,
          unmatchedCount: distributionValidation.unmatched.length,
          crossYearInconsistencies: distributionValidation.crossYearInconsistencies,
          conflicts: distributionValidation.conflicts,
          unmatched: distributionValidation.unmatched.map((u) => u.accountName),
        },
      },
    });

    console.log("[ManualGL][MultiYear] Updating report source record...");
    try {
      await updateReportSourceRecord(companyId, REPORT_SOURCE_KEYS.MANUAL_GL, {
        isAvailable: true,
        isConnected: false,
        lastSyncedAt: new Date().toISOString(),
        metadata: {
          latestBatchId: batch.id,
          latestBatchCreatedAt: batch.created_at || stageStartedAt,
          latestBatchStatus: "staged",
          sourceType,
          sourceSwitchVersion,
          uploadSessionId,
          glUploadCount: normalizedUploadIds.length,
          insertedTransactions: totalInserted,
          classificationMode: hasBsLookup ? "bs_driven" : "keyword_fallback",
        },
      });
    } catch (syncError) {
      console.warn("[ManualGL][MultiYear] Failed to refresh report source:", syncError.message);
    }

    return {
      success: true,
      batchId: batch.id,
      insertedTransactions: totalInserted,
      yearGroups: combinedYearGroups,
      duplicateTransactionsSkipped: totalDuplicates,
      crossFileDuplicateTransactionsSkipped: totalCrossFileDuplicates,
      warnings: parsingWarnings.slice(0, 500),
      mapping: effectiveMapping,
      filesParsed,
      validation,
      yearsDetected: yearDetection.years,
      fileType: yearDetection.fileType,
      isMultiYearUpload: yearDetection.isMultiYear,
      perYearTransactionCounts: yearDetection.perYearCounts,
      classificationMode: hasBsLookup ? "bs_driven" : "keyword_fallback",
    };
  } catch (error) {
    console.error("[ManualGL][MultiYear] === FAILED ===", error.message, error.stack);
    try {
      const [txCleanup, bsCleanup] = await Promise.all([
        supabase
          .from(TABLES.transactions)
          .delete()
          .eq("company_id", companyId)
          .eq("batch_id", batch.id),
        supabase
          .from(TABLES.balanceSheetLines)
          .delete()
          .eq("company_id", companyId)
          .eq("batch_id", batch.id),
      ]);

      if (txCleanup.error) {
        console.error(
          "[ManualGL][MultiYear] Failed to rollback staged transactions:",
          txCleanup.error.message,
        );
      }
      if (bsCleanup.error) {
        console.error(
          "[ManualGL][MultiYear] Failed to rollback staged balance-sheet lines:",
          bsCleanup.error.message,
        );
      }
    } catch (rollbackError) {
      console.error(
        "[ManualGL][MultiYear] Rollback operation crashed:",
        rollbackError.message,
      );
    }

    try {
      await updateBatch(batch.id, {
        status: "failed",
        metadata: { error: error.message, rolledBack: true },
      });
    } catch (updateError) {
      console.error("[ManualGL][MultiYear] Failed to update batch status:", updateError.message);
    }
    throw error;
  }
}

/**
 * Restricts a BS payload to only the specified selected years.
 *
 * Internally the BS computation uses CUMULATIVE transactions (e.g. 2022+2023 for a
 * 2023 report) so that running balances are correct.  But the API response should
 * only expose data for the year(s) the user actually requested — otherwise the
 * frontend sees columns/totals for years the user never asked for and renders
 * cross-year contaminated values.
 *
 * NOTE: balancesByYear[selectedYear] already contains the FULL rolling balance
 * (openingBalance + all prior-year activity + selectedYear activity), so restricting
 * the key set does NOT lose precision.
 */
function restrictBsPayloadToSelectedYears(payload, selectedYears) {
  if (!selectedYears || !selectedYears.length) return payload;

  const yearsSet = new Set(selectedYears.map((y) => Number(y)));
  const filteredYears = (payload.years || []).filter((y) => yearsSet.has(Number(y)));

  if (!filteredYears.length) {
    console.log(
      `[ManualGL][YearRestrict] No payload years match selectedYears ${JSON.stringify(selectedYears)} — returning unrestricted payload.`,
    );
    return payload;
  }

  const keepYear = (yr) => yearsSet.has(Number(yr));

  const filterByYear = (obj) => {
    if (!obj || typeof obj !== "object") return obj;
    return Object.fromEntries(Object.entries(obj).filter(([k]) => keepYear(k)));
  };

  const filterSections = (sections) => {
    if (!sections) return sections;
    const result = {};
    Object.entries(sections).forEach(([sectionKey, section]) => {
      result[sectionKey] = {
        ...section,
        totalByYear: filterByYear(section.totalByYear),
        categories: (section.categories || []).map((cat) => ({
          ...cat,
          totalByYear: filterByYear(cat.totalByYear),
          accounts: (cat.accounts || []).map((acc) => ({
            ...acc,
            balancesByYear: filterByYear(acc.balancesByYear || {}),
            activityByYear: filterByYear(acc.activityByYear || {}),
          })),
        })),
      };
    });
    return result;
  };

  const filteredAudit = (payload.audit || []).filter((a) => keepYear(a.year));

  console.log(
    `[ManualGL][YearRestrict] BS response years restricted from [${(payload.years || []).join(", ")}] → [${filteredYears.join(", ")}]`,
  );

  return {
    ...payload,
    years: filteredYears,
    sections: filterSections(payload.sections),
    audit: filteredAudit,
  };
}

async function getCashflowSummaryFromStage(companyId, filters = {}) {
  // 1. P&L gives us Net Income per year (already filtered to selectedYears).
  const pnl = await getProfitLossSummaryFromStage(companyId, filters);
  const selectedYears = (pnl.years || []).filter((y) => Number.isInteger(y) && y > 0);

  // 2. Balance Sheet for period movements.
  //    CRITICAL: we need the FULL cumulative BS (all years up to max selected year)
  //    so that year-over-year deltas are correct. If we pass the year filter directly,
  //    restrictBsPayloadToSelectedYears() strips prior years from totalByYear, making
  //    the "previous year" balance unavailable and computing the delta as the full
  //    absolute balance instead of the change. Fetch without year restriction, then
  //    we narrow the output ourselves below.
  const bsFilters = {
    ...filters,
    fiscalYears: [],   // suppress year-restriction in the BS fetch
    fiscalYear: null,
  };
  const bs = await getBalanceSheetSummaryFromStage(companyId, bsFilters);

  // The BS payload contains totalByYear for every year in the batch. We build
  // the cash flow using cumulative rolling balances, then expose only selectedYears.
  const allBsYears = (bs.years || []).sort((a, b) => a - b);

  const sections = {
    Operating: { label: "Cash Flow from Operating Activities", items: [], totalByYear: {} },
    Investing: { label: "Cash Flow from Investing Activities", items: [], totalByYear: {} },
    Financing: { label: "Cash Flow from Financing Activities", items: [], totalByYear: {} },
  };

  // Seed Operating with Net Income for every selected year.
  selectedYears.forEach((year) => {
    sections.Operating.totalByYear[year] = roundMoney(Number(pnl.netProfitByYear?.[year] || 0));
  });

  // Build movements from BS category rolling balances (indirect method).
  // "Movement" = change from end of prior year to end of current year.
  // For assets:  an increase is a cash OUTFLOW → negative to cash flow.
  // For liabilities/equity: an increase is a cash INFLOW → positive to cash flow.
  const bsCategories = [];
  ["Assets", "Liabilities", "Equity"].forEach((sKey) => {
    const sectionData = bs.sections?.[sKey];
    if (!sectionData) return;
    (sectionData.categories || []).forEach((cat) => bsCategories.push({ ...cat, sectionType: sKey }));
  });

  bsCategories.forEach((cat) => {
    const label = String(cat.label || "").toLowerCase();

    // Classify into operating / investing / financing buckets.
    let flowType = "Operating";
    if (label.includes("fixed asset") || label.includes("other asset")) flowType = "Investing";
    if (
      label.includes("long-term") ||
      label.includes("loan") ||
      label.includes("owner equity") ||
      label.includes("retained earnings") ||
      label.includes("net income")
    ) {
      flowType = "Financing";
    }

    // Cash accounts are the result, not a movement — exclude from movements.
    if (label.includes("bank account") || label === "cash") return;

    const sign = cat.sectionType === "Assets" ? -1 : 1;
    const yearMovements = {};

    selectedYears.forEach((year) => {
      // Find the prior year from the FULL allBsYears list so the delta is correct
      // even when the user selects only a subset of years.
      const priorYearIdx = allBsYears.indexOf(year) - 1;
      const priorYear = priorYearIdx >= 0 ? allBsYears[priorYearIdx] : null;

      const current = roundMoney(Number(cat.totalByYear?.[year] || 0));
      const prior = priorYear != null ? roundMoney(Number(cat.totalByYear?.[priorYear] || 0)) : 0;
      const move = roundMoney((current - prior) * sign);

      yearMovements[year] = move;
      sections[flowType].totalByYear[year] = roundMoney(
        (sections[flowType].totalByYear[year] || 0) + move,
      );
    });

    sections[flowType].items.push({ label: `Change in ${cat.label}`, yearMovements });
  });

  const netCashChange = {};
  selectedYears.forEach((year) => {
    netCashChange[year] = roundMoney(
      (sections.Operating.totalByYear[year] || 0) +
      (sections.Investing.totalByYear[year] || 0) +
      (sections.Financing.totalByYear[year] || 0),
    );
  });

  console.log(
    `[ManualGL][Cashflow][Debug] years: [${selectedYears.join(", ")}]`,
    `| netCashChange: ${JSON.stringify(netCashChange)}`,
  );

  return {
    source: "manual_gl_staged_transactions",
    reportType: "cash_flow",
    filters,
    years: selectedYears,
    sections,
    netCashChange,
  };
}

async function getProfitLossSummaryFromStage(companyId, filters = {}) {
  const { filters: normalizedFilters, rows } = await queryStagedTransactions(companyId, filters);
  let normalized = rows.map(normalizeStagedTransactionRow).filter(Boolean);

  const selectedYears = normalizedFilters.fiscalYears || [];
  console.log(
    `[ManualGL][PL][Debug] === P&L Summary Report ===`,
    `| selectedYears: ${JSON.stringify(selectedYears)}`,
    `| total transactions after year filter: ${normalized.length}`,
    `| batchId: ${normalizedFilters.batchId || "none"}`,
  );

  // Re-classify using BS lines from DB so reports are accurate even for data
  // staged before the BS-driven classification was implemented.
  if (normalizedFilters.batchId) {
    const bsLookup = await loadBsLookupForBatch(companyId, normalizedFilters.batchId);
    if (bsLookup.size > 0) {
      normalized = reclassifyNormalizedTransactions(normalized, bsLookup);
    }
  }

  const plCount = normalized.filter((tx) =>
    ["income", "cogs", "expense"].includes(normalizeAccountType(tx.accountType) || ""),
  ).length;
  const bsCount = normalized.filter((tx) =>
    ["asset", "liability", "equity"].includes(normalizeAccountType(tx.accountType) || ""),
  ).length;
  console.log(
    `[ManualGL][PL][Debug] After reclassification — P&L transactions: ${plCount}, BS transactions (excluded): ${bsCount}`,
  );

  const summary = buildProfitLossSummaryPayload(normalized, normalizedFilters);

  console.log(
    `[ManualGL][PL][Debug] P&L result — years: ${JSON.stringify(summary.years)},`,
    `netProfitByYear: ${JSON.stringify(summary.netProfitByYear || {})}`,
  );

  return summary;
}

async function getProfitLossDetailFromStage(companyId, filters = {}) {
  const { filters: normalizedFilters, rows } = await queryStagedTransactions(companyId, filters);
  let normalized = rows.map(normalizeStagedTransactionRow).filter(Boolean);

  const selectedYears = normalizedFilters.fiscalYears || [];
  console.log(
    `[ManualGL][PL-Detail][Debug] selectedYears: ${JSON.stringify(selectedYears)},`,
    `total transactions after year filter: ${normalized.length}`,
  );

  // Re-classify using BS lines — matches the reclassification in getProfitLossSummaryFromStage
  // so BS accounts stored with wrong type in legacy data are excluded from P&L detail.
  if (normalizedFilters.batchId) {
    const bsLookup = await loadBsLookupForBatch(companyId, normalizedFilters.batchId);
    if (bsLookup.size > 0) {
      normalized = reclassifyNormalizedTransactions(normalized, bsLookup);
    }
  }

  const plCount = normalized.filter((tx) =>
    ["income", "cogs", "expense"].includes(normalizeAccountType(tx.accountType) || ""),
  ).length;
  const bsCount = normalized.filter((tx) =>
    ["asset", "liability", "equity"].includes(normalizeAccountType(tx.accountType) || ""),
  ).length;
  console.log(
    `[ManualGL][PL-Detail][Debug] After reclassification — P&L accounts: ${plCount}, BS accounts (excluded): ${bsCount}`,
  );

  return buildProfitLossDetailPayload(normalized, normalizedFilters);
}

async function getStageTransactions(companyId, filters = {}) {
  const { filters: normalizedFilters, rows } = await queryStagedTransactions(companyId, filters);
  return {
    source: "manual_gl_staged_transactions",
    filters: normalizedFilters,
    count: rows.length,
    rows: rows.map(normalizeStagedTransactionRow),
  };
}

async function getStageFilterOptions(companyId, filters = {}) {
  // For discovery, we want to see ALL available years, accounts, etc.
  // So we ignore most filters, keeping only the companyId and batchId (if specified).
  const discoveryFilters = {
    batchId: filters.batchId || "",
    limit: DEFAULT_STAGING_LIMIT,
  };

  console.log(`[ManualGL][MultiYear] Discovery: Fetching options for company ${companyId}`, discoveryFilters);
  const { rows } = await queryStagedTransactions(companyId, discoveryFilters);
  console.log(`[ManualGL][MultiYear] Discovery: Found ${rows.length} rows for discovery.`);
  if (rows.length > 0) {
    console.log(`[ManualGL][MultiYear] Discovery: First row fiscal_year: ${rows[0].fiscal_year}, fiscalYear: ${rows[0].fiscalYear}`);
  }

  const addValue = (set, value) => {
    if (value === null || value === undefined) return;
    const text = String(value).trim();
    if (!text) return;
    set.add(text);
  };

  const options = {
    fiscalYear: new Set(),
    fiscalMonth: new Set(),
    accountName: new Set(),
    accountNumber: new Set(),
    accountType: new Set(),
    category: new Set(),
    subCategory: new Set(),
    department: new Set(),
    class: new Set(),
    location: new Set(),
    sourceFile: new Set(),
    transactionType: new Set(),
    journalType: new Set(),
    reportType: new Set(["profit_loss", "balance_sheet"]),
  };

  rows.forEach((row) => {
    if (row.fiscal_year) options.fiscalYear.add(String(row.fiscal_year));
    const rowDate = String(row.txn_date || "").trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(rowDate)) {
      options.fiscalMonth.add(String(Number(rowDate.slice(5, 7))));
    }
    addValue(options.accountName, row.account_name);
    addValue(options.accountNumber, row.account_number);
    addValue(options.accountType, row.account_type);
    addValue(options.category, row.category);
    addValue(options.subCategory, row.sub_category);
    addValue(options.department, row.department);
    addValue(options.class, row.class);
    addValue(options.location, row.location);
    addValue(options.sourceFile, row.source_file);
    addValue(options.transactionType, row.transaction_type);
    addValue(options.journalType, row.journal_type);
  });

  return {
    source: "manual_gl_staged_transactions",
    rowCount: rows.length,
    options: Object.fromEntries(
      Object.entries(options).map(([key, set]) => [
        key,
        Array.from(set).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
      ])
    ),
  };
}

async function loadBatchBalanceSheetLines(companyId, batchId, sheetType) {
  const { data, error } = await supabase
    .from(TABLES.balanceSheetLines)
    .select("*")
    .eq("company_id", companyId)
    .eq("batch_id", batchId)
    .eq("sheet_type", sheetType);

  if (error) {
    throw new Error(`Failed to load ${sheetType} balance sheet lines: ${error.message}`);
  }

  return data || [];
}

async function validateBatchBalanceSheet(companyId, batchId = "") {
  const effectiveBatchId =
    batchId || (await getLatestManualBatch(companyId, { status: "staged" }))?.id;
  if (!effectiveBatchId) {
    throw new Error("No staged batch available for validation.");
  }

  const staged = await getStageTransactions(companyId, { batchId: effectiveBatchId, limit: 200000 });
  const summary = buildProfitLossSummaryPayload(staged.rows, { batchId: effectiveBatchId });

  const startingLines = await loadBatchBalanceSheetLines(companyId, effectiveBatchId, SHEET_TYPE.STARTING);
  const endingLines = await loadBatchBalanceSheetLines(companyId, effectiveBatchId, SHEET_TYPE.ENDING);
  const validation = computeBalanceSheetRollforwardValidation({
    startingLines,
    endingLines,
    transactions: staged.rows,
    profitLossSummary: summary,
  });

  await updateBatch(effectiveBatchId, {
    metadata: {
      validation,
    },
  });

  return {
    source: "manual_gl_staged_transactions",
    batchId: effectiveBatchId,
    validation,
  };
}

async function getLatestManualBatch(companyId, options = {}) {
  const sourceType = toNonEmptyString(options.sourceType || "");
  const sourceSwitchVersion = toNonEmptyString(options.sourceSwitchVersion || "");
  const rawUploadSessionId = toNonEmptyString(options.uploadSessionId || "");
  const uploadSessionId = isValidUuid(rawUploadSessionId) ? rawUploadSessionId : "";
  const status = toNonEmptyString(options.status || "");

  const runQuery = async (includeSourceColumns = true) => {
    let query = supabase
      .from(TABLES.batches)
      .select("*")
      .eq("company_id", companyId)
      .order("created_at", { ascending: false })
      .limit(1);

    if (status) {
      query = query.eq("status", status);
    }

    if (includeSourceColumns) {
      if (sourceType) query = query.eq("source_type", sourceType);
      if (sourceSwitchVersion) {
        query = query.eq("source_switch_version", sourceSwitchVersion);
      }
      if (uploadSessionId) {
        query = query.eq("upload_session_id", uploadSessionId);
      }
    }

    return query.single();
  };

  let { data, error } = await runQuery(true);
  if (error && isMissingColumnError(error)) {
    ({ data, error } = await runQuery(false));
  }

  if (error && error.code !== "PGRST116") {
    throw new Error(`Failed to fetch latest manual batch: ${error.message}`);
  }

  return data || null;
}

async function listManualGlBatches(companyId) {
  const { data, error } = await supabase
    .from(TABLES.batches)
    .select("id, batch_name, status, created_at, updated_at, metadata")
    .eq("company_id", companyId)
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(`Failed to list manual GL batches: ${error.message}`);
  }

  return data || [];
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ─── Monthly Detail: Profit & Loss ───────────────────────────────────────────

function buildProfitLossMonthlyDetailPayload(transactions = [], year, filters = {}, selectedMonth = null) {
  const resolvedSelectedMonth = (Number.isInteger(Number(selectedMonth)) && Number(selectedMonth) >= 1 && Number(selectedMonth) <= 12)
    ? Number(selectedMonth) : null;
  const months = resolvedSelectedMonth !== null ? [resolvedSelectedMonth] : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  const accountMap = new Map();

  if (resolvedSelectedMonth !== null) {
    console.log(`[ManualGL][PL-Monthly][Filter] Period-only month: ${resolvedSelectedMonth} of year ${year}`);
  }

  transactions.forEach((tx) => {
    const txYear = Number(tx.fiscalYear);
    if (year && txYear !== year) return;

    const accountType = normalizeAccountType(tx.accountType) || inferAccountType(tx.accountName, tx.accountNumber);
    if (!['income', 'cogs', 'expense'].includes(accountType)) return;

    const txDate = String(tx.date || '');
    const monthNum = txDate.length >= 7 ? parseInt(txDate.slice(5, 7), 10) : 0;
    if (!monthNum || monthNum < 1 || monthNum > 12) return;

    // Period-only filter: skip months outside selected month
    if (resolvedSelectedMonth !== null && monthNum !== resolvedSelectedMonth) return;

    const category = normalizeProfitLossCategory(tx.category, tx.accountName, tx.accountType);
    if (!category) return;

    const accountKey = `${category}::${tx.accountNumber || ''}::${tx.accountName}`;
    if (!accountMap.has(accountKey)) {
      accountMap.set(accountKey, {
        accountName: tx.accountName,
        accountNumber: tx.accountNumber || '',
        category,
        accountType,
        monthly: {},
        total: 0,
      });
    }

    const acc = accountMap.get(accountKey);
    // net_amount = credit - debit (negative for expenses, positive for income)
    // Display convention: income positive, expenses shown as positive cost
    const netAmount = roundMoney(Number(tx.netAmount || 0));
    const displayAmount = category === 'Revenue' ? netAmount : roundMoney(-netAmount);

    acc.monthly[monthNum] = roundMoney((acc.monthly[monthNum] || 0) + displayAmount);
    acc.total = roundMoney(acc.total + displayAmount);
  });

  const byCategory = { Revenue: [], COGS: [], 'Operating Expenses': [], 'Other Expenses': [] };
  accountMap.forEach((acc) => {
    if (byCategory[acc.category]) byCategory[acc.category].push(acc);
  });
  Object.values(byCategory).forEach((arr) => arr.sort((a, b) => a.accountName.localeCompare(b.accountName)));

  const calcMonthlyTotals = (accounts) => {
    const monthly = {};
    months.forEach((m) => {
      monthly[m] = roundMoney(accounts.reduce((sum, acc) => sum + (acc.monthly[m] || 0), 0));
    });
    return { monthly, total: roundMoney(accounts.reduce((sum, acc) => sum + acc.total, 0)) };
  };

  const incomeTotals = calcMonthlyTotals(byCategory.Revenue);
  const cogsTotals = calcMonthlyTotals(byCategory.COGS);
  const expenseTotals = calcMonthlyTotals(byCategory['Operating Expenses']);
  const otherTotals = calcMonthlyTotals(byCategory['Other Expenses']);

  const grossProfitMonthly = {};
  months.forEach((m) => {
    grossProfitMonthly[m] = roundMoney((incomeTotals.monthly[m] || 0) - (cogsTotals.monthly[m] || 0));
  });
  const grossProfitTotal = roundMoney(incomeTotals.total - cogsTotals.total);

  const netOperatingMonthly = {};
  months.forEach((m) => {
    netOperatingMonthly[m] = roundMoney((grossProfitMonthly[m] || 0) - (expenseTotals.monthly[m] || 0));
  });
  const netOperatingTotal = roundMoney(grossProfitTotal - expenseTotals.total);

  const netOtherMonthly = {};
  months.forEach((m) => { netOtherMonthly[m] = roundMoney(-(otherTotals.monthly[m] || 0)); });
  const netOtherTotal = roundMoney(-otherTotals.total);

  const netIncomeMonthly = {};
  months.forEach((m) => {
    netIncomeMonthly[m] = roundMoney((netOperatingMonthly[m] || 0) + (netOtherMonthly[m] || 0));
  });
  const netIncomeTotal = roundMoney(netOperatingTotal + netOtherTotal);

  const sections = [];
  sections.push({
    key: 'income', label: 'Income',
    accounts: byCategory.Revenue,
    monthlyTotals: incomeTotals.monthly, total: incomeTotals.total,
    totalLabel: 'Total For Income',
  });
  if (byCategory.COGS.length > 0) {
    sections.push({
      key: 'cogs', label: 'Cost of Goods Sold',
      accounts: byCategory.COGS,
      monthlyTotals: cogsTotals.monthly, total: cogsTotals.total,
      totalLabel: 'Total For Cost of Goods Sold',
    });
  }
  sections.push({ key: 'gross_profit', label: 'Gross Profit', isCalculated: true, monthlyTotals: grossProfitMonthly, total: grossProfitTotal });
  sections.push({
    key: 'expenses', label: 'Expenses',
    accounts: byCategory['Operating Expenses'],
    monthlyTotals: expenseTotals.monthly, total: expenseTotals.total,
    totalLabel: 'Total For Expenses',
  });
  sections.push({ key: 'net_operating_income', label: 'Net Operating Income', isCalculated: true, monthlyTotals: netOperatingMonthly, total: netOperatingTotal });
  if (byCategory['Other Expenses'].length > 0) {
    sections.push({
      key: 'other_income_expense', label: 'Other Income/Expense',
      accounts: byCategory['Other Expenses'],
      monthlyTotals: otherTotals.monthly, total: otherTotals.total,
      totalLabel: 'Total For Other Income/Expense',
    });
    sections.push({ key: 'net_other_income', label: 'Net Other Income', isCalculated: true, monthlyTotals: netOtherMonthly, total: netOtherTotal });
  }
  sections.push({ key: 'net_income', label: 'Net Income', isCalculated: true, monthlyTotals: netIncomeMonthly, total: netIncomeTotal });

  return { source: 'manual_staged', reportType: 'profit_loss_monthly_detail', year: year || null, months, monthNames: MONTH_NAMES, sections, filters };
}

async function getProfitLossMonthlyDetailFromStage(companyId, filters = {}) {
  const { filters: normalizedFilters, rows } = await queryStagedTransactions(companyId, filters);
  let normalized = rows.map(normalizeStagedTransactionRow).filter(Boolean);

  const selectedYear =
    Array.isArray(normalizedFilters.fiscalYears) && normalizedFilters.fiscalYears.length > 0
      ? Math.max(...normalizedFilters.fiscalYears.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0))
      : null;

  console.log(
    `[ManualGL][PL-Monthly][Debug] selectedYear: ${selectedYear},`,
    `total transactions after year filter: ${normalized.length}`,
  );

  // Re-classify using BS lines — keeps BS accounts out of P&L monthly totals
  // (matches the reclassification logic used in getProfitLossSummaryFromStage).
  if (normalizedFilters.batchId) {
    const bsLookup = await loadBsLookupForBatch(companyId, normalizedFilters.batchId);
    if (bsLookup.size > 0) {
      normalized = reclassifyNormalizedTransactions(normalized, bsLookup);
    }
  }

  const plCount = normalized.filter((tx) =>
    ["income", "cogs", "expense"].includes(normalizeAccountType(tx.accountType) || ""),
  ).length;
  console.log(`[ManualGL][PL-Monthly][Debug] P&L transactions after reclassification: ${plCount}`);

  const fallbackYear =
    selectedYear ||
    (normalized.length
      ? Math.max(
        ...normalized
          .map((tx) => Number(tx.fiscalYear || 0))
          .filter((value) => Number.isInteger(value) && value > 0),
      )
      : null);

  const selectedMonth = Array.isArray(normalizedFilters.fiscalMonths) && normalizedFilters.fiscalMonths.length > 0
    ? normalizedFilters.fiscalMonths[0] : null;
  console.log(`[ManualGL][PL-Monthly][Filter] selectedMonth: ${selectedMonth}`);

  return buildProfitLossMonthlyDetailPayload(normalized, fallbackYear, normalizedFilters, selectedMonth);
}

// ─── Monthly Detail: Balance Sheet ───────────────────────────────────────────

function buildBalanceSheetMonthlyDetailPayload(transactions = [], year, filters = {}, startingLines = [], netProfitByYear = {}, selectedMonth = null) {
  const resolvedSelectedMonth = (Number.isInteger(Number(selectedMonth)) && Number(selectedMonth) >= 1 && Number(selectedMonth) <= 12)
    ? Number(selectedMonth) : null;
  // For BS, months are cumulative: always show from Jan up to (and including) selectedMonth
  const allMonths = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  const months = resolvedSelectedMonth !== null ? allMonths.slice(0, resolvedSelectedMonth) : allMonths;
  const lastMonth = resolvedSelectedMonth !== null ? resolvedSelectedMonth : 12;

  if (resolvedSelectedMonth !== null) {
    console.log(`[ManualGL][BS-Monthly][Filter] Cumulative through month: ${resolvedSelectedMonth} of year ${year}`);
  }

  const derivedYears = Array.from(
    new Set(
      transactions
        .map((tx) => Number(tx.fiscalYear || 0))
        .filter((value) => Number.isInteger(value) && value > 0),
    ),
  ).sort((a, b) => a - b);
  const selectedYear =
    (Number.isInteger(Number(year)) && Number(year) > 0 ? Number(year) : null) ||
    (derivedYears.length ? derivedYears[derivedYears.length - 1] : null);

  const accountMap = new Map();
  const ensureAccount = ({ accountNumber = "", accountName = "", accountType = "", category = "", source = "tx" }) => {
    const normalizedType = normalizeAccountType(accountType) || inferAccountType(accountName, accountNumber);
    if (!["asset", "liability", "equity"].includes(normalizedType)) return null;

    const grouping = resolveBalanceSheetGrouping(accountName, normalizedType, category);
    const key = normalizedType + "::" + normalizeAccountLabel(accountName);
    if (!accountMap.has(key)) {
      accountMap.set(key, {
        key,
        accountName,
        accountNumber: accountNumber || "",
        accountType: normalizedType,
        grouping,
        openingBalance: 0,
        monthlyDelta: {},
        monthlyBalance: {},
        sources: new Set([source]),
      });
    }
    const existing = accountMap.get(key);
    if (!existing.accountNumber && accountNumber) existing.accountNumber = accountNumber;
    if (source) existing.sources.add(source);
    return existing;
  };

  startingLines.forEach((line) => {
    let accountName = String(line.account_name || "").trim();
    if (!accountName) return;
    const accountType =
      line.section === "assets"
        ? "asset"
        : line.section === "liabilities"
          ? "liability"
          : line.section === "equity"
            ? "equity"
            : "";
    if (!accountType) return;

    const metadata = line.metadata && typeof line.metadata === "object" ? line.metadata : {};
    let impliedCategory = metadata.leafCategory || metadata.minorGroup || metadata.majorGroup || "";
    if (accountType === "equity" && /\bnet income\b/i.test(accountName)) {
      accountName = "Retained Earnings";
      impliedCategory = "Retained Earnings";
    }
    const account = ensureAccount({
      accountName,
      accountType,
      category: impliedCategory,
      source: "starting",
    });
    if (!account) return;
    account.openingBalance = roundMoney(account.openingBalance + Number(line.amount || 0));
  });

  transactions.forEach((tx) => {
    const account = ensureAccount({
      accountNumber: tx.accountNumber || "",
      accountName: tx.accountName || "",
      accountType: tx.accountType || "",
      category: tx.category || "",
      source: "tx",
    });
    if (!account) return;

    const txYear = Number(tx.fiscalYear || 0);
    if (!Number.isInteger(txYear) || txYear <= 0) return;
    if (selectedYear && txYear > selectedYear) return;

    const txMonth = Number(tx.fiscalMonth || (String(tx.date || "").length >= 7 ? Number(String(tx.date).slice(5, 7)) : 0));
    const contra = isContraAccount(tx.accountName, account.accountType);
    const netAmount = Number(tx.netAmount || 0);
    let delta = account.accountType === "asset" ? -netAmount : netAmount;
    if (contra) delta = -delta;
    delta = roundMoney(delta);

    if (!selectedYear || txYear < selectedYear) {
      account.openingBalance = roundMoney(account.openingBalance + delta);
      return;
    }

    if (txMonth >= 1 && txMonth <= 12) {
      account.monthlyDelta[txMonth] = roundMoney((account.monthlyDelta[txMonth] || 0) + delta);
    }
  });

  const monthlyProfit = Object.fromEntries(months.map((month) => [month, 0]));
  if (selectedYear) {
    const { monthlyRows } = calculateProfitLossBuckets(
      transactions.filter((tx) => Number(tx.fiscalYear || 0) === selectedYear),
    );
    monthlyRows
      .filter((row) => Number(row.fiscalYear || 0) === selectedYear)
      .forEach((row) => {
        const month = Number(String(row.month || "").slice(5, 7));
        if (month >= 1 && month <= 12) {
          monthlyProfit[month] = roundMoney(Number(row["Net Profit"] || 0));
        }
      });
  }

  const explicitNetIncomeAccounts = Array.from(accountMap.values()).filter(
    (account) => account.accountType === "equity" && account.grouping?.majorGroup === "Net Income",
  );
  const retainedAccounts = Array.from(accountMap.values()).filter(
    (account) => account.accountType === "equity" && account.grouping?.majorGroup === "Retained Earnings",
  );

  const retainedHasTransactionActivity = retainedAccounts.some((account) => account.sources?.has("tx"));
  const shouldCarryForwardNetIncome =
    explicitNetIncomeAccounts.length === 0 && !retainedHasTransactionActivity;

  if (selectedYear && shouldCarryForwardNetIncome) {
    const priorNetIncome = derivedYears
      .filter((yr) => yr < selectedYear)
      .reduce((sum, yr) => roundMoney(sum + Number(netProfitByYear[yr] || 0)), 0);

    if (priorNetIncome !== 0) {
      const retainedAccount =
        retainedAccounts[0] ||
        ensureAccount({
          accountName: "Retained Earnings",
          accountType: "equity",
          category: "Retained Earnings",
          source: "synthetic",
        });
      if (retainedAccount) {
        retainedAccount.openingBalance = roundMoney(retainedAccount.openingBalance + priorNetIncome);
      }
    }
  }

  if (selectedYear && explicitNetIncomeAccounts.length === 0) {
    const netIncomeAccount = ensureAccount({
      accountName: "Net Income",
      accountType: "equity",
      category: "Net Income",
      source: "synthetic",
    });
    if (netIncomeAccount) {
      months.forEach((month) => {
        netIncomeAccount.monthlyDelta[month] = roundMoney(
          (netIncomeAccount.monthlyDelta[month] || 0) + Number(monthlyProfit[month] || 0),
        );
      });
    }
  }

  accountMap.forEach((account) => {
    let running = roundMoney(account.openingBalance || 0);
    months.forEach((month) => {
      running = roundMoney(running + Number(account.monthlyDelta[month] || 0));
      account.monthlyBalance[month] = running;
    });
  });

  const sectionOrder = ["Assets", "Liabilities", "Equity"];
  const categoryOrder = {
    Assets: ["Bank Accounts", "Other Current Assets", "Fixed Assets", "Other Assets"],
    Liabilities: ["Credit Cards", "Other Current Liabilities", "Long-Term Liabilities"],
    Equity: ["Owner Equity", "Retained Earnings", "Net Income"],
  };

  const sectionBuckets = {
    Assets: { label: "Assets", categories: new Map(), monthlyTotals: {}, total: 0 },
    Liabilities: { label: "Liabilities", categories: new Map(), monthlyTotals: {}, total: 0 },
    Equity: { label: "Equity", categories: new Map(), monthlyTotals: {}, total: 0 },
  };
  months.forEach((month) => {
    sectionOrder.forEach((sectionKey) => {
      sectionBuckets[sectionKey].monthlyTotals[month] = 0;
    });
  });

  const ensureCategory = (sectionKey, label) => {
    if (!sectionBuckets[sectionKey].categories.has(label)) {
      sectionBuckets[sectionKey].categories.set(label, {
        label,
        accounts: [],
        monthlyTotals: Object.fromEntries(months.map((month) => [month, 0])),
        total: 0,
      });
    }
    return sectionBuckets[sectionKey].categories.get(label);
  };

  accountMap.forEach((account) => {
    const grouping = account.grouping || resolveBalanceSheetGrouping(account.accountName, account.accountType, "");
    const sectionKey = grouping.sectionKey;
    if (!sectionKey || !sectionBuckets[sectionKey]) return;
    const categoryLabel = grouping.leafCategory || "Other";
    const category = ensureCategory(sectionKey, categoryLabel);

    const row = {
      name: account.accountName,
      number: account.accountNumber || "",
      monthly: {},
      total: 0,
    };

    months.forEach((month) => {
      const value = roundMoney(Number(account.monthlyBalance[month] || 0));
      row.monthly[month] = value;
      category.monthlyTotals[month] = roundMoney(category.monthlyTotals[month] + value);
      sectionBuckets[sectionKey].monthlyTotals[month] = roundMoney(
        sectionBuckets[sectionKey].monthlyTotals[month] + value,
      );
    });
    row.total = roundMoney(row.monthly[lastMonth] || 0);
    category.accounts.push(row);
  });

  const sections = {};
  sectionOrder.forEach((sectionKey) => {
    const bucket = sectionBuckets[sectionKey];
    const ordered = Array.from(bucket.categories.values()).sort((a, b) => {
      const order = categoryOrder[sectionKey] || [];
      const aIndex = order.indexOf(a.label);
      const bIndex = order.indexOf(b.label);
      if (aIndex >= 0 && bIndex >= 0) return aIndex - bIndex;
      if (aIndex >= 0) return -1;
      if (bIndex >= 0) return 1;
      return a.label.localeCompare(b.label);
    });

    ordered.forEach((category) => {
      category.accounts.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
      category.total = roundMoney(category.monthlyTotals[lastMonth] || 0);
    });

    bucket.total = roundMoney(bucket.monthlyTotals[lastMonth] || 0);
    sections[sectionKey] = {
      label: bucket.label,
      categories: ordered,
      monthlyTotals: bucket.monthlyTotals,
      total: bucket.total,
    };
  });

  const retainedCategory =
    sections.Equity.categories.find((category) => category.label === "Retained Earnings") ||
    (() => {
      const category = {
        label: "Retained Earnings",
        accounts: [],
        monthlyTotals: Object.fromEntries(months.map((month) => [month, 0])),
        total: 0,
      };
      sections.Equity.categories.push(category);
      return category;
    })();

  const adjustmentRow = { name: "Retained Earnings Adjustment", number: "", monthly: {}, total: 0 };
  let hasAdjustment = false;
  months.forEach((month) => {
    const assets = roundMoney(Number(sections.Assets.monthlyTotals?.[month] || 0));
    const liabilities = roundMoney(Number(sections.Liabilities.monthlyTotals?.[month] || 0));
    const equity = roundMoney(Number(sections.Equity.monthlyTotals?.[month] || 0));
    const variance = roundMoney(assets - (liabilities + equity));
    adjustmentRow.monthly[month] = variance;

    if (Math.abs(variance) <= BALANCE_EPSILON) return;
    hasAdjustment = true;
    retainedCategory.monthlyTotals[month] = roundMoney(
      Number(retainedCategory.monthlyTotals?.[month] || 0) + variance,
    );
    sections.Equity.monthlyTotals[month] = roundMoney(
      Number(sections.Equity.monthlyTotals?.[month] || 0) + variance,
    );
  });

  if (hasAdjustment) {
    adjustmentRow.total = roundMoney(adjustmentRow.monthly[lastMonth] || 0);
    retainedCategory.accounts.push(adjustmentRow);
    retainedCategory.accounts.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  }

  retainedCategory.total = roundMoney(retainedCategory.monthlyTotals?.[lastMonth] || 0);
  sections.Equity.total = roundMoney(sections.Equity.monthlyTotals?.[lastMonth] || 0);

  return {
    source: "manual_gl_staged_transactions",
    reportType: "balance_sheet_monthly_detail",
    year: selectedYear,
    months,
    monthNames: MONTH_NAMES,
    sections,
    filters,
  };
}

async function getBalanceSheetMonthlyDetailFromStage(companyId, filters = {}) {
  const normalizedFilters = parseManualFilterQuery(filters);
  const effectiveBatchId =
    normalizedFilters.batchId || (await getLatestManualBatch(companyId, { status: "staged" }))?.id;
  const targetYear =
    Array.isArray(normalizedFilters.fiscalYears) && normalizedFilters.fiscalYears.length > 0
      ? Math.max(...normalizedFilters.fiscalYears.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0))
      : null;

  let startingLines = [];
  let endingLines = [];
  if (effectiveBatchId) {
    [startingLines, endingLines] = await Promise.all([
      loadBatchBalanceSheetLines(companyId, effectiveBatchId, SHEET_TYPE.STARTING),
      loadBatchBalanceSheetLines(companyId, effectiveBatchId, SHEET_TYPE.ENDING),
    ]);
  }

  // Query cumulative rows and let the payload builder create opening + monthly balances for selected year.
  // fiscalMonths is intentionally cleared: the BS payload builder needs ALL months' transactions to compute
  // the correct cumulative running balance. Month restriction is applied via the months[] array in the builder.
  const { rows } = await queryStagedTransactions(companyId, {
    ...normalizedFilters,
    reportType: "",
    fiscalYear: null,
    fiscalYears: [],
    fiscalMonths: [],
    startDate: "",
    endDate: "",
    limit: DEFAULT_STAGING_LIMIT,
  });

  let normalized = rows.map(normalizeStagedTransactionRow).filter(Boolean);
  const bsLookup = buildBsLookupFromDbLines(startingLines, endingLines);
  if (bsLookup.size > 0) {
    normalized = reclassifyNormalizedTransactions(normalized, bsLookup);
  }

  const pnlPayload = buildProfitLossSummaryPayload(normalized, {
    ...normalizedFilters,
    batchId: normalizedFilters.batchId || effectiveBatchId || "",
  });

  if (targetYear) {
    normalized = normalized.filter((tx) => Number(tx.fiscalYear || 0) <= targetYear);
  }

  const selectedMonth = Array.isArray(normalizedFilters.fiscalMonths) && normalizedFilters.fiscalMonths.length > 0
    ? normalizedFilters.fiscalMonths[0] : null;
  console.log(`[ManualGL][BS-Monthly][Filter] targetYear: ${targetYear}, selectedMonth: ${selectedMonth}`);

  return buildBalanceSheetMonthlyDetailPayload(
    normalized,
    targetYear,
    { ...normalizedFilters, batchId: normalizedFilters.batchId || effectiveBatchId || "" },
    startingLines,
    pnlPayload.netProfitByYear || {},
    selectedMonth,
  );
}

module.exports = {
  parseManualFilterQuery,
  stageMultiYearGlUpload,
  getStageTransactions,
  getStageFilterOptions,
  getProfitLossSummaryFromStage,
  getProfitLossDetailFromStage,
  getProfitLossMonthlyDetailFromStage,
  getBalanceSheetSummaryFromStage,
  getBalanceSheetMonthlyDetailFromStage,
  getCashflowSummaryFromStage,
  validateBatchBalanceSheet,
  getLatestManualBatch,
  listManualGlBatches,
  // Multi-year detection utility — usable by callers (e.g., upload controllers)
  // to surface file type information without re-staging.
  detectMultipleYears,
};
