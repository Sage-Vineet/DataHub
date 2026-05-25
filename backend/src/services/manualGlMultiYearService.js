const crypto = require("crypto");
const XLSX = require("xlsx");
const { supabase } = require("../db");
const {
  REPORT_SOURCE_KEYS,
  updateReportSourceRecord,
} = require("./reportSourceStore");
const {
  startUploadLifecycle,
  finalizeUploadLifecycle,
  failUploadLifecycle,
  getActiveDatasetVersion,
  ensureLegacyDatasetVersion,
} = require("./datasetVersionService");
const {
  getActiveUploadBatch,
  resolveReportBatchId,
  REPORT_BATCH_MODE,
} = require("./manualGlActiveBatchService");
const {
  getActiveUploadSessionMap,
  getLatestUploadSessionVersion,
  findExistingStagedUploadSessionsByYearHash,
} = require("./manualGlUploadSessionService");

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
  "vendor_name",
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

// Column candidate lists are ordered most-specific â†’ least-specific.
// resolveColumn picks the first match, so longer/more-distinctive strings win
// before short ambiguous ones like "dr", "num", "type".
const MAPPING_CANDIDATES = {
  date: [
    "transaction date", "posting date", "journal date", "entry date",
    "trx date", "txn date", "posted date", "value date", "effective date",
    "doc date", "document date", "invoice date", "date",
  ],
  account_name: [
    "distribution account", "gl account name", "account description",
    "account title", "ledger account", "nominal account", "gl account",
    "g/l account", "chart of accounts name", "account name", "account",
  ],
  account_number: [
    "chart of accounts code", "gl account number", "account number",
    "account no", "acct number", "acct no", "gl code", "gl number",
    "ledger code", "ledger number", "account code", "coa code",
    "account id", "acct #", "account #",
  ],
  account_type: ["account type", "acct type"],
  amount: [
    "split amount", "signed amount", "transaction amount", "entry amount",
    "net amount", "amount",
  ],
  debit: ["debit amount", "debits", "dr amount", "debit", "dr"],
  credit: ["credit amount", "credits", "cr amount", "credit", "cr"],
  vendor_name: [
    "vendor name", "payee name", "customer name", "party name",
    "vendor", "payee", "customer", "counterparty", "name",
  ],
  description: [
    "memo/description", "transaction description", "entry description",
    "description", "particulars", "details", "narration",
    "remarks", "remark", "notes", "memo", "comment",
  ],
  reference: [
    "transaction id", "transaction number", "document number", "doc number",
    "voucher number", "voucher no", "check number", "check no",
    "invoice number", "invoice no", "reference number", "batch number",
    "batch no", "doc no", "po number", "journal number",
    "reference", "document", "voucher", "invoice", "ref", "num",
  ],
  transaction_type: ["transaction type", "txn type", "entry type", "type"],
  journal_type: ["journal entry type", "journal type", "j/e type"],
  class: ["class code", "class"],
  department: ["cost centre", "cost center", "dept code", "department", "dept"],
  location: ["branch", "site", "property", "location"],
  category: ["gl category", "category"],
  sub_category: ["sub-category", "sub category", "subcategory", "sub cat"],
};

const BALANCE_EPSILON = 0.01;
const DEFAULT_STAGING_LIMIT = 200000;
const MANUAL_SOURCE_KEY = REPORT_SOURCE_KEYS.MANUAL_GL;
// Default to calendar-year unless an explicit fiscal calendar is provided by caller.
const DEFAULT_FISCAL_YEAR_START_MONTH = 1;
const DEFAULT_FISCAL_YEAR_START_DAY = 1;
const MAX_SKIP_SAMPLES = 500;
const PROCESSING_BATCH_STALE_MINUTES = 30;

// Pre-compiled account-type inference regexes.
// Defined once at module load â€” NOT inside inferAccountType() â€” so they are
// never recompiled during the 100K-500K transaction classification loop.
const RE_ACCT_ASSET = /\bcash\b|\bbank\b|\bchecking\b|\bsavings\b|\breceivable\b|\ba\/r\b|\binventory\b|\basset\b|\bprepaid\b|\bfixed asset\b|\bequipment\b|\bmachinery\b|\bvehicle\b|\btruck\b|\bfurniture\b|\bfixture\b|\bcomputer\b|\bbuilding\b|\bland\b/;
const RE_ACCT_LIABILITY = /\bpayable\b|\bloan\b|\bliability\b|\bcredit card\b|\bcc\b|\bvisa\b|\bmastercard\b|\bamex\b|\bdebt\b|\bnote payable\b|\bnotes payable\b/;
const RE_ACCT_EQUITY = /\bequity\b|\bcapital\b|\bdraw\b|\bretained earnings\b|\bowner\b/;
const RE_ACCT_INCOME = /\bsales\b|\brevenue\b|\bincome\b|\bfee\b/;
const RE_ACCT_COGS = /\bcogs\b|\bcost of goods\b|\bdirect cost\b/;
const RE_ACCT_EXPENSE = /\bexpense\b|\brent\b|\butilit\b|\bsalaries\b|\bwages\b|\btravel\b|\bmeals\b|\boffice\b/;

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

function isUniqueConstraintError(error, constraintName = "") {
  if (!error) return false;
  const message = String(error.message || "").toLowerCase();
  if (!message.includes("duplicate key value violates unique constraint")) return false;
  if (!constraintName) return true;
  return message.includes(String(constraintName).toLowerCase());
}

function isProcessingBatchConstraintError(error) {
  if (!error) return false;
  if (isUniqueConstraintError(error, "uq_manual_gl_batches_company_processing")) return true;
  const message = String(error.message || "").toLowerCase();
  return (
    isUniqueConstraintError(error) &&
    message.includes("manual_gl_batches") &&
    message.includes("batch_status") &&
    message.includes("processing")
  );
}

function isDatasetVersionConstraintError(error) {
  if (!error) return false;
  if (isUniqueConstraintError(error, "uq_manual_gl_batches_company_dataset_version")) return true;
  const message = String(error.message || "").toLowerCase();
  return (
    isUniqueConstraintError(error) &&
    message.includes("manual_gl_batches") &&
    message.includes("dataset_version")
  );
}

async function releaseStaleProcessingBatchLocks(
  companyId,
  sourceType = MANUAL_SOURCE_KEY,
  nowIso = new Date().toISOString(),
) {
  if (!companyId) return 0;

  const staleCutoff = new Date(
    Date.now() - PROCESSING_BATCH_STALE_MINUTES * 60 * 1000,
  ).toISOString();
  const fullPayload = {
    status: "failed",
    batch_status: "failed",
    is_active: false,
    is_archived: true,
    processing_completed_at: nowIso,
    updated_at: nowIso,
  };

  let query = supabase
    .from(TABLES.batches)
    .update(fullPayload)
    .eq("company_id", companyId)
    .eq("batch_status", "processing")
    .lt("updated_at", staleCutoff);

  if (sourceType) {
    query = query.eq("source_type", sourceType);
  }

  let { data, error } = await query.select("id");

  if (error && isMissingColumnError(error, "source_type")) {
    ({ data, error } = await supabase
      .from(TABLES.batches)
      .update(fullPayload)
      .eq("company_id", companyId)
      .eq("batch_status", "processing")
      .lt("updated_at", staleCutoff)
      .select("id"));
  }

  if (error && isMissingColumnError(error)) {
    const legacyPayload = {
      status: "failed",
      updated_at: nowIso,
    };

    let legacyQuery = supabase
      .from(TABLES.batches)
      .update(legacyPayload)
      .eq("company_id", companyId)
      .eq("status", "processing")
      .lt("updated_at", staleCutoff);

    if (sourceType) {
      legacyQuery = legacyQuery.eq("source_type", sourceType);
    }

    ({ data, error } = await legacyQuery.select("id"));

    if (error && isMissingColumnError(error, "source_type")) {
      ({ data, error } = await supabase
        .from(TABLES.batches)
        .update(legacyPayload)
        .eq("company_id", companyId)
        .eq("status", "processing")
        .lt("updated_at", staleCutoff)
        .select("id"));
    }
  }

  if (error) {
    console.warn("[ManualGL][MultiYear] Failed to clear stale processing batches:", error.message);
    return 0;
  }

  return Array.isArray(data) ? data.length : 0;
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

/**
 * Scans the first N rows of a sheet for keywords matching "Company", "Client", etc.
 * extraction of potential company name associated with the GL dataset.
 */
function detectCompanyInGl(sheetData, maxRows = 100) {
  if (!sheetData?.rows?.length) return null;

  const keywords = ["company", "client", "business", "entity", "customer", "firm"];
  const rows = sheetData.rows.slice(0, maxRows);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const cells = Object.values(row);

    for (let j = 0; j < cells.length; j++) {
      const cell = String(cells[j] || "").trim().toLowerCase();

      // Look for "Keyword:" or "Keyword :"
      for (const kw of keywords) {
        if (cell.startsWith(kw) && (cell.includes(":") || cell.includes(" - "))) {
          // If the cell contains both keyword and value (e.g. "Company: TCS")
          const parts = cell.split(/[:\-]/);
          if (parts.length > 1 && parts[1].trim()) {
            return parts[1].trim();
          }
          // If the value is in the next cell
          if (j + 1 < cells.length && cells[j + 1]) {
            return String(cells[j + 1]).trim();
          }
        }
      }
    }
  }

  return null;
}

/**
 * Validates whether the selected fiscal years are already staged for the company.
   * Implements strict collision detection for multi-year uploads.
   */
async function checkExistingStagedFiscalYears(companyId, fiscalYears = [], dataHash = null) {
  const normalizedYears = Array.from(
    new Set(
      (Array.isArray(fiscalYears) ? fiscalYears : [])
        .map((year) => Number(year))
        .filter((year) => Number.isInteger(year) && year > 0),
    ),
  ).sort((a, b) => a - b);

  if (!companyId || normalizedYears.length === 0) {
    return { isDuplicate: false, duplicateYears: [], duplicates: [], matches: [] };
  }

  const requestedYearHashes = Array.isArray(dataHash)
    ? dataHash
      .map((item) => ({
        fiscalYear: Number(item?.fiscalYear || 0),
        dataHash: String(item?.dataHash || "").trim(),
      }))
      .filter((item) => Number.isInteger(item.fiscalYear) && item.fiscalYear > 0 && item.dataHash)
    : typeof dataHash === "string" && dataHash.trim()
      ? normalizedYears.map((fiscalYear) => ({ fiscalYear, dataHash: dataHash.trim() }))
      : [];

  console.log(
    `[ManualGL][Validation] Checking duplicates for company ${companyId}; years=[${normalizedYears.join(", ")}]; ` +
    `hashPairs=${requestedYearHashes.length}`,
  );

  if (requestedYearHashes.length === 0) {
    return { isDuplicate: false, duplicateYears: [], duplicates: [], matches: [] };
  }

  try {
    const lookup = await findExistingStagedUploadSessionsByYearHash({
      companyId,
      yearHashes: requestedYearHashes,
    });

    const matches = Array.isArray(lookup?.matches) ? lookup.matches : [];
    const duplicateYears = Array.from(
      new Set(
        matches
          .map((entry) => Number(entry?.fiscalYear || 0))
          .filter((year) => Number.isInteger(year) && year > 0),
      ),
    ).sort((a, b) => a - b);

    console.log(
      `[ManualGL][Validation] Duplicate query result: stagedRows=${lookup?.rows?.length || 0}, ` +
      `matchedYears=[${duplicateYears.join(", ")}]`,
    );

    if (duplicateYears.length === normalizedYears.length) {
      const firstMatch = matches[0]?.existingSession || null;
      return {
        isDuplicate: true,
        message: "The selected fiscal year data is already staged.",
        existingVersion: Number(firstMatch?.version_no || 0) || null,
        activeBatchId: firstMatch?.staging_batch_id || null,
        duplicateYears,
        duplicates: duplicateYears,
        matches,
      };
    }

    return {
      isDuplicate: false,
      duplicateYears,
      duplicates: duplicateYears,
      matches,
    };
  } catch (error) {
    console.error("[ManualGL][Validation] Duplicate check failed:", error.message);
    return { isDuplicate: false, duplicateYears: [], duplicates: [], matches: [] };
  }
}

/**
 * Builds a deterministic SHA-256 hash for a collection of transactions.
 * Used to detect duplicate datasets regardless of filename or upload session.
 */
function buildDatasetHash(transactions = []) {
  if (!transactions.length) return null;

  // Build from normalized business fields (NOT upload-id dependent hashes) so
  // the same dataset always yields the same checksum across re-uploads.
  const sortedHashes = transactions
    .map((tx) => buildCrossFileDedupHash(tx))
    .filter(Boolean)
    .sort();

  if (!sortedHashes.length) return null;

  const digest = crypto.createHash("sha256");
  sortedHashes.forEach((h) => digest.update(h));
  digest.update(`#count:${sortedHashes.length}`);

  return digest.digest("hex");
}

function roundMoney(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

// â”€â”€â”€ Balance Normalization Engine â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Single source of truth for all debit/credit sign conventions.
// Every report and aggregation MUST route through these functions.
// DO NOT scatter inline debit-credit arithmetic outside this section.

/**
 * Computes the natural (accounting-standard) balance for an account.
 *
 * Normal balance rules:
 *   Assets     (+Dr) : balance = debits âˆ’ credits   â†’ positive when Dr > Cr
 *   Expenses   (+Dr) : balance = debits âˆ’ credits   â†’ positive when Dr > Cr
 *   COGS       (+Dr) : balance = debits âˆ’ credits   â†’ positive when Dr > Cr
 *   Liabilities(+Cr) : balance = credits âˆ’ debits   â†’ positive when Cr > Dr
 *   Equity     (+Cr) : balance = credits âˆ’ debits   â†’ positive when Cr > Dr
 *   Revenue    (+Cr) : balance = credits âˆ’ debits   â†’ positive when Cr > Dr
 *
 * @param {number} debit       - gross debit amount (always â‰¥ 0)
 * @param {number} credit      - gross credit amount (always â‰¥ 0)
 * @param {string} accountType - "asset"|"liability"|"equity"|"income"|"cogs"|"expense"
 * @param {boolean} isContra   - true for contra accounts (reverses the normal sign)
 * @returns {number}           - signed natural balance (positive = normal balance)
 */
function computeNaturalBalance(debit, credit, accountType, isContra = false) {
  const dr = roundMoney(Math.abs(Number(debit) || 0));
  const cr = roundMoney(Math.abs(Number(credit) || 0));
  const type = String(accountType || "").toLowerCase();
  const normalDebitSide = type === "asset" || type === "expense" || type === "cogs";
  const effectiveDebitSide = isContra ? !normalDebitSide : normalDebitSide;
  return effectiveDebitSide ? roundMoney(dr - cr) : roundMoney(cr - dr);
}

/**
 * Computes the activity DELTA to apply to a running Balance Sheet balance.
 * For a BS roll-forward: endingBalance = openingBalance + sum(activityDelta).
 *
 * A delta of +X means the balance grew by X in the natural direction for the account type.
 * A delta of âˆ’X means the balance shrank.
 *
 * Internally derived from netAmount = credit âˆ’ debit (the DB convention).
 *
 * @param {number} netAmount   - credit minus debit (from the staged transaction)
 * @param {string} accountType - "asset"|"liability"|"equity"
 * @param {boolean} isContra   - true for contra accounts
 * @returns {number}
 */
function computeBsActivityDelta(netAmount, accountType, isContra = false) {
  const net = roundMoney(Number(netAmount) || 0);
  const type = String(accountType || "").toLowerCase();
  // For assets: natural balance grows with debits â†’ delta = âˆ’(creditâˆ’debit) = debitâˆ’credit
  // For liabilities/equity: natural balance grows with credits â†’ delta = creditâˆ’debit
  const assetSide = type === "asset";
  const effectiveAssetSide = isContra ? !assetSide : assetSide;
  return effectiveAssetSide ? roundMoney(-net) : roundMoney(net);
}

/**
 * Normalizes the raw amount stored in a starting/ending Balance Sheet line to
 * the "natural balance" direction for that account section.
 *
 * Problem: Many accounting exports (QuickBooks, Xero, etc.) display liability
 * and some equity accounts with parenthetical/negative signs in CSV/Excel exports
 * because the underlying ledger stores them as credit-side entries. On the rendered
 * Balance Sheet these are POSITIVE values (e.g., "Credit Card 206,412.44" means
 * the company OWES $206,412). When the parser reads "(206,412.44)" it produces
 * âˆ’206,412.44. That negative sign propagates into the opening balance and inverts
 * every subsequent roll-forward calculation.
 *
 * Rules:
 *   LIABILITY: negative â†’ flip to positive (natural credit balance), except for
 *     genuine debit-balance exceptions (customer deposits, advance payments).
 *   EQUITY: negative â†’ flip to positive unless the account name clearly represents
 *     a reduction account (owner's draw, withdrawal, distribution, deficit, net loss).
 *   ASSET: preserve sign as-is (assets are naturally debit-balance).
 *
 * @param {number} rawAmount   - signed amount as parsed from the BS file
 * @param {string} accountType - "asset"|"liability"|"equity"
 * @param {string} accountName - used to detect genuine sign exceptions
 * @returns {number}           - amount in natural-balance direction
 */
function normalizeBsLineAmount(rawAmount, accountType, accountName = "") {
  const amount = roundMoney(Number(rawAmount) || 0);
  if (amount === 0) return 0;
  const type = String(accountType || "").toLowerCase();
  if (type === "asset") return amount; // assets are debit-balance: preserve sign as-is
  if (amount > 0) return amount;       // already positive: no adjustment needed for any type

  const name = normalizeKey(accountName);

  if (type === "liability") {
    // Negative liability â†’ natural positive (company owes money shown as positive).
    // Exception: genuine debit-balance accounts (e.g. overpaid vendor â†’ asset-like).
    const isGenuineCreditBalance =
      /\bcustomer deposit\b|\badvance\b|\bdeposit received\b|\bprepaid revenue\b|\bdeferred revenue\b|\bdeferred income\b/.test(name);
    return isGenuineCreditBalance ? amount : Math.abs(amount);
  }

  if (type === "equity") {
    // Negative equity entries in BS exports:
    //   â€“ Owner's draw / distributions REDUCE equity â†’ legitimately negative â†’ preserve.
    //   â€“ Accumulated deficit / net loss â†’ legitimately negative â†’ preserve.
    //   â€“ Capital contributions exported with parenthetical formatting â†’ flip to positive.
    const isReductionAccount =
      /\bdraw\b|\bwithdrawal\b|\bdistribution\b|\bdeficit\b|\baccum(?:ulated)?\s+loss\b/.test(name);
    return isReductionAccount ? amount : Math.abs(amount);
  }

  return amount;
}

// â”€â”€â”€ End Balance Normalization Engine â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function parseIntegerInRange(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  if (parsed < min || parsed > max) return fallback;
  return parsed;
}

function resolveFiscalCalendarConfig(config = {}) {
  const fiscalYearStartMonth = parseIntegerInRange(
    config.fiscalYearStartMonth ?? process.env.MANUAL_GL_FISCAL_YEAR_START_MONTH,
    1,
    12,
    DEFAULT_FISCAL_YEAR_START_MONTH,
  );
  const fiscalYearStartDay = parseIntegerInRange(
    config.fiscalYearStartDay ?? process.env.MANUAL_GL_FISCAL_YEAR_START_DAY,
    1,
    31,
    DEFAULT_FISCAL_YEAR_START_DAY,
  );

  return {
    fiscalYearStartMonth,
    fiscalYearStartDay,
  };
}

function computeFiscalYearFromIsoDate(isoDate, fiscalCalendar = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(isoDate || ""))) return null;
  const [rawYear, rawMonth, rawDay] = String(isoDate).split("-").map((part) => Number(part));
  if (!Number.isInteger(rawYear) || !Number.isInteger(rawMonth) || !Number.isInteger(rawDay)) {
    return null;
  }

  const calendar = resolveFiscalCalendarConfig(fiscalCalendar);
  if (
    rawMonth > calendar.fiscalYearStartMonth ||
    (rawMonth === calendar.fiscalYearStartMonth && rawDay >= calendar.fiscalYearStartDay)
  ) {
    return rawYear;
  }

  return rawYear - 1;
}

// Returns the END year of the fiscal period (Aprilâ€“March â†’ 2023 for the year ending March 2023).
// For January fiscal years the start and end year are identical, so this is a no-op.
function computeFiscalYearEndLabel(isoDate, fiscalCalendar = {}) {
  const calendar = resolveFiscalCalendarConfig(fiscalCalendar);
  const startYear = computeFiscalYearFromIsoDate(isoDate, fiscalCalendar);
  if (!Number.isInteger(startYear) || startYear <= 0) return startYear;
  return calendar.fiscalYearStartMonth !== 1 ? startYear + 1 : startYear;
}

// Returns the ISO date (YYYY-MM-DD) of the last day of fiscal year `endLabel`.
// For January fiscal (month=1): Dec 31 of `endLabel`.
// For April fiscal (month=4): March 31 of `endLabel` (since the FY starting April of
// endLabel-1 ends on March 31 of endLabel).
// General: the FY ends on the day before the fiscal start month, in calendar year `endLabel`.
function computeFiscalYearEndDate(endLabel, fiscalCalendar = {}) {
  const calendar = resolveFiscalCalendarConfig(fiscalCalendar);
  const year = Number(endLabel);
  if (!Number.isInteger(year) || year <= 0) return null;

  if (calendar.fiscalYearStartMonth === 1) {
    return `${year}-12-31`;
  }
  // The FY ends in the month before fiscalYearStartMonth, in year `endLabel`.
  // E.g. April start (month 4) â†’ ends in month 3 (March) of `endLabel`.
  const endMonth = calendar.fiscalYearStartMonth - 1; // 1-indexed month
  const lastDay = new Date(year, endMonth, 0).getDate(); // day 0 of next month = last day of endMonth
  return `${year}-${String(endMonth).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
}

function formatFiscalYearLabel(endYear, fiscalYearStartMonth = 1) {
  if (!Number.isInteger(endYear) || endYear <= 0) return "";
  return fiscalYearStartMonth !== 1 ? `${endYear - 1}-${endYear}` : `${endYear}-${endYear + 1}`;
}

// Extract unique fiscal years from staged transaction rows.
// Uses only the stored fiscal_year column â€” does NOT infer from dates or filenames.
function getAvailableFiscalYears(rows = []) {
  const yearSet = new Set();
  for (const row of rows) {
    const yr = Number(row.fiscal_year ?? row.fiscalYear ?? 0);
    if (Number.isInteger(yr) && yr > 0) yearSet.add(yr);
  }
  return Array.from(yearSet).sort((a, b) => a - b);
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

  // Support trailing minus format: 123.45- => -123.45
  if (/-$/.test(cleaned)) {
    cleaned = `-${cleaned.replace(/-$/, "")}`;
  }
  // Support prefixed CR/DR tokens in exports such as "CR123.45" / "DR123.45".
  if (/^dr/i.test(cleaned)) cleaned = `-${cleaned.replace(/^dr/i, "")}`;
  if (/^cr/i.test(cleaned)) cleaned = cleaned.replace(/^cr/i, "");
  if (/dr$/i.test(cleaned)) cleaned = `-${cleaned.replace(/dr$/i, "")}`;
  if (/cr$/i.test(cleaned)) cleaned = cleaned.replace(/cr$/i, "");

  if (!cleaned) return { value: 0, isPresent: false, isValid: true };

  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) {
    return { value: 0, isPresent: true, isValid: false };
  }

  return { value: parsed, isPresent: true, isValid: true };
}

// Month abbreviation â†’ 1-indexed month number. Defined once at module level.
const MONTH_ABBR_MAP = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function parseDateFlexible(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;

  if (typeof value === "number") {
    // Excel serial dates are day offsets from 1899-12-30.
    // Parse in UTC, then materialize a local date-only object to avoid timezone drift.
    const excelEpochUtc = Date.UTC(1899, 11, 30);
    const utcDate = new Date(excelEpochUtc + value * 86400000);
    return new Date(
      utcDate.getUTCFullYear(),
      utcDate.getUTCMonth(),
      utcDate.getUTCDate(),
    );
  }

  const raw = String(value).trim();
  if (!raw) return null;

  // Strip time component from timestamps so date-only parsing handles the rest.
  // Covers: "2024-01-15 12:30:00", "2024-01-15T00:00:00Z", "01/15/2024 08:00"
  const dateOnly = raw
    .replace(/[\sT][0-2]\d:[0-5]\d(:[0-5]\d)?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/, "")
    .trim();
  const useRaw = dateOnly || raw;

  // YYYYMMDD â€” no separator, exactly 8 digits (NetSuite, some ERP exports)
  if (/^\d{8}$/.test(useRaw)) {
    const y = Number(useRaw.slice(0, 4));
    const m = Number(useRaw.slice(4, 6));
    const d = Number(useRaw.slice(6, 8));
    const date = new Date(y, m - 1, d);
    if (!Number.isNaN(date.getTime()) && date.getMonth() === m - 1) return date;
  }

  // ISO YYYY-MM-DD â€” most reliable, handle explicitly before JS Date constructor
  const isoMatch = useRaw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const y = Number(isoMatch[1]);
    const m = Number(isoMatch[2]);
    const d = Number(isoMatch[3]);
    if (Number.isInteger(y) && Number.isInteger(m) && Number.isInteger(d)) {
      const date = new Date(y, m - 1, d);
      if (!Number.isNaN(date.getTime())) return date;
    }
  }

  // Named-month: DD-Mon-YYYY, D-Mon-YY, DD Mon YYYY, 1 January 2024
  // Covers Sage, Xero, many manual exports: "15-Jan-2024", "01-Jan-24"
  const namedMonthMatch = useRaw.match(/^(\d{1,2})[-\s\/]([A-Za-z]{3,9})[-\s\/](\d{2,4})$/);
  if (namedMonthMatch) {
    const day = Number(namedMonthMatch[1]);
    const abbr = namedMonthMatch[2].toLowerCase().slice(0, 3);
    const yearRaw = Number(namedMonthMatch[3]);
    const year = namedMonthMatch[3].length === 2
      ? (yearRaw >= 50 ? 1900 + yearRaw : 2000 + yearRaw)
      : yearRaw;
    const month = MONTH_ABBR_MAP[abbr];
    if (month && Number.isInteger(day) && Number.isInteger(year)) {
      const date = new Date(year, month - 1, day);
      if (!Number.isNaN(date.getTime()) && date.getMonth() === month - 1) return date;
    }
  }

  // Try native Date constructor â€” handles many locale-aware formats:
  // "Jan 15, 2024", "January 15, 2024", "15 Jan 2024", RFC 2822, etc.
  let parsed = new Date(useRaw);
  if (!Number.isNaN(parsed.getTime())) return parsed;

  // Separator-split: M/D/YYYY, D/M/YYYY, YYYY/MM/DD (slash), YYYY.MM.DD (dot),
  // and two-digit year variants like M/D/YY.
  const parts = useRaw.split(/[\/\-\.]/).map((part) => part.trim());
  if (parts.length === 3) {
    const n1 = Number(parts[0]);
    const n2 = Number(parts[1]);
    const n3 = Number(parts[2]);

    let year = null;
    let month = null;
    let day = null;

    if (parts[0].length === 4 && Number.isInteger(n1)) {
      // YYYY/MM/DD or YYYY.MM.DD
      year = n1; month = n2; day = n3;
    } else if (parts[2].length === 4 && Number.isInteger(n3)) {
      // M/D/YYYY or D/M/YYYY â€” use >12 heuristic to disambiguate
      year = n3;
      if (Number.isInteger(n1) && Number.isInteger(n2)) {
        if (n1 > 12 && n2 <= 12) { day = n1; month = n2; }
        else if (n2 > 12 && n1 <= 12) { month = n1; day = n2; }
        else { month = n1; day = n2; } // ambiguous â†’ M/D convention
      }
    } else if (parts[2].length === 2 && Number.isInteger(n3)) {
      // Two-digit year: M/D/YY or D/M/YY
      // Pivot: YY < 50 â†’ 2000s, YY >= 50 â†’ 1900s
      year = n3 >= 50 ? 1900 + n3 : 2000 + n3;
      if (Number.isInteger(n1) && Number.isInteger(n2)) {
        if (n1 > 12 && n2 <= 12) { day = n1; month = n2; }
        else if (n2 > 12 && n1 <= 12) { month = n1; day = n2; }
        else { month = n1; day = n2; }
      }
    }

    if (Number.isInteger(year) && Number.isInteger(month) && Number.isInteger(day)) {
      parsed = new Date(year, month - 1, day);
      if (
        !Number.isNaN(parsed.getTime()) &&
        parsed.getFullYear() === year &&
        parsed.getMonth() === month - 1 &&
        parsed.getDate() === day
      ) {
        return parsed;
      }
    }
  }

  return null;
}

function toIsoDate(value) {
  const date = value instanceof Date ? value : parseDateFlexible(value);
  if (!date || Number.isNaN(date.getTime())) return null;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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

    // Date-like column keywords (QuickBooks, Xero, Sage, NetSuite, Dynamics)
    const hasDate = keys.some((key) =>
      key.includes("date") || key.includes("posting") ||
      key.includes("journal") || key === "period"
    );
    // Account-like column keywords
    const hasAccount = keys.some((key) =>
      key.includes("account") || key.includes("distribution") ||
      key.includes("ledger") || key.includes("nominal") ||
      key.includes("gl code") || key.includes("chart of")
    );
    // Amount-like column keywords
    const hasAmounts = keys.some((key) =>
      key.includes("amount") || key.includes("debit") || key.includes("credit") ||
      key.includes("balance") || key === "dr" || key === "cr" ||
      key.includes("value")
    );
    // Extra GL structural indicators (Sage, Xero: voucher, narration, particulars)
    const hasGlIndicator = keys.some((key) =>
      key.includes("voucher") || key.includes("narration") ||
      key.includes("particulars") || key.includes("reference") ||
      key.includes("transaction")
    );

    let score = 0;
    if (hasDate) score += 4;
    if (hasAccount) score += 4;
    if (hasAmounts) score += 3;
    if (hasGlIndicator) score += 1;
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
  const normalized = headers.map((h) => ({ header: h, key: normalizeKey(h) }));
  for (const candidate of candidates) {
    // Short candidates (â‰¤3 chars: "dr", "cr", "num", "ref") require a word-boundary
    // match to prevent false positives: "dr" must not match "address";
    // "num" must not match "account number"; "cr" must not match "description".
    const isShort = candidate.length <= 3;
    const found = normalized.find(({ key }) => {
      if (key === candidate) return true;
      if (isShort) {
        return (
          key.startsWith(candidate + " ") ||
          key.startsWith(candidate + "/") ||
          key.startsWith(candidate + "-") ||
          key.endsWith(" " + candidate) ||
          key.endsWith("/" + candidate)
        );
      }
      return key.includes(candidate);
    });
    if (found) return found.header;
  }
  return "";
}

// Priority order for de-conflicting when two fields both resolve to the same column.
// Earlier position = higher priority (that field keeps the column; others are cleared).
const FIELD_DEDUP_PRIORITY = [
  "date", "account_name", "account_number", "debit", "credit",
  "amount", "vendor_name", "description", "reference", "account_type",
  "transaction_type", "journal_type", "class", "department",
  "location", "category", "sub_category",
];

function resolveGlMapping(headers, mapping = {}) {
  const provided = ensureMappingShape(mapping);
  const resolved = {};

  Object.keys(MAPPING_CANDIDATES).forEach((field) => {
    resolved[field] = resolveColumn(headers, provided[field], MAPPING_CANDIDATES[field]);
  });

  // De-conflict: if two fields mapped to the same column, the higher-priority field
  // (earlier in FIELD_DEDUP_PRIORITY) keeps it; the lower-priority one is cleared.
  const usedColumns = new Map();
  for (const field of FIELD_DEDUP_PRIORITY) {
    const col = resolved[field];
    if (!col) continue;
    if (usedColumns.has(col)) {
      resolved[field] = "";
    } else {
      usedColumns.set(col, field);
    }
  }

  const shaped = ensureMappingShape({
    ...resolved,
    // Explicit user-provided overrides always win regardless of conflicts.
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
    key === "closing balance" ||
    key === "subtotal" ||
    key === "sub-total" ||
    key === "total" ||
    key === "totals" ||
    key === "grand total" ||
    key === "net total" ||
    key === "carried forward" ||
    key === "carry forward" ||
    key === "balance c/f" ||
    key === "balance b/f" ||
    key === "bal c/f" ||
    key === "bal b/f" ||
    key === "c/f" ||
    key === "b/f" ||
    key.startsWith("total for ") ||
    key.startsWith("subtotal for ") ||
    key.startsWith("sub-total for ") ||
    key.startsWith("total - ")
  );
}

// When no date column is found via MAPPING_CANDIDATES, scan cell values across all
// columns and pick the one where â‰¥50% of sampled non-empty cells parse as a
// plausible date (year 2000â€“2060). Prevents hard failures on unusual header names.
function detectDateColumnFallback(headers, rows) {
  const MAX_SCAN_ROWS = Math.min(rows.length, 60);
  let bestHeader = "";
  let bestDateCount = 0;

  for (const header of headers) {
    let dateLikeCount = 0;
    let totalValues = 0;

    for (let i = 0; i < MAX_SCAN_ROWS; i += 1) {
      const cell = rows[i][header];
      if (cell === null || cell === undefined || String(cell).trim() === "") continue;
      totalValues += 1;
      const parsedCell = parseDateFlexible(cell);
      if (parsedCell) {
        const yr = parsedCell.getFullYear();
        if (yr >= 2000 && yr <= 2060) dateLikeCount += 1;
      }
    }

    if (totalValues === 0) continue;
    const ratio = dateLikeCount / totalValues;
    if (ratio >= 0.5 && dateLikeCount > bestDateCount) {
      bestDateCount = dateLikeCount;
      bestHeader = header;
    }
  }

  return bestHeader;
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

  // Use pre-compiled module-level constants (see RE_ACCT_* at top of file).
  if (RE_ACCT_ASSET.test(name)) return "asset";
  if (RE_ACCT_LIABILITY.test(name)) return "liability";
  if (RE_ACCT_EQUITY.test(name)) return "equity";
  if (RE_ACCT_INCOME.test(name)) return "income";
  if (RE_ACCT_COGS.test(name)) return "cogs";
  if (RE_ACCT_EXPENSE.test(name)) return "expense";

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
  // Normalize strings and round numbers for absolute determinism
  const parts = [
    String(tx.fiscalYear || "").trim(),
    String(tx.date || "").trim(),
    String(tx.accountNumber || "").trim().toLowerCase(),
    String(tx.accountName || "").trim().toLowerCase(),
    roundMoney(Number(tx.debit || 0)).toFixed(2),
    roundMoney(Number(tx.credit || 0)).toFixed(2),
    roundMoney(Number(tx.netAmount || 0)).toFixed(2),
    String(tx.class || "").trim().toLowerCase(),
    String(tx.department || "").trim().toLowerCase(),
    String(tx.location || "").trim().toLowerCase(),
    String(tx.transactionType || "").trim().toLowerCase(),
    String(tx.journalType || "").trim().toLowerCase(),
    String(tx.reference || "").trim().toLowerCase(),
    String(tx.description || "").trim().toLowerCase(),
  ];

  const raw = parts.join("|");
  return crypto.createHash("sha1").update(raw).digest("hex");
}

function sha256Hex(parts = []) {
  const digest = crypto.createHash("sha256");
  parts.forEach((part) => {
    digest.update(String(part ?? ""));
    digest.update("|");
  });
  return digest.digest("hex");
}

function buildYearDataHash(transactions = []) {
  const canonical = transactions
    .map((tx) => buildCrossFileDedupHash(tx))
    .sort();
  return sha256Hex([...canonical, `rows:${canonical.length}`]);
}

function buildYearFileHash(uploadHashes = []) {
  const normalized = uploadHashes
    .map((item) => String(item || "").trim().toLowerCase())
    .filter(Boolean)
    .sort();
  return normalized.length ? sha256Hex([...normalized, `files:${normalized.length}`]) : null;
}

function assignFiscalYearAndRefreshHash(
  transactions = [],
  {
    companyId,
    fiscalCalendar = {},
    useFiscalYearMode = true,
  } = {},
) {
  const calendar = resolveFiscalCalendarConfig(fiscalCalendar);

  return transactions.map((tx) => {
    const isoDate = String(tx.date || "");
    const calendarYear =
      /^\d{4}-\d{2}-\d{2}$/.test(isoDate) ? Number(isoDate.slice(0, 4)) : null;
    const fiscalYearFromDate = computeFiscalYearEndLabel(isoDate, calendar);
    const fiscalYear = useFiscalYearMode
      ? (fiscalYearFromDate || calendarYear || tx.fiscalYear || null)
      : (calendarYear || tx.fiscalYear || fiscalYearFromDate || null);

    const metadata = {
      ...(tx.metadata && typeof tx.metadata === "object" ? tx.metadata : {}),
      calendarYear: Number.isInteger(calendarYear) ? calendarYear : null,
      fiscalYear,
      fiscalYearLabel: formatFiscalYearLabel(fiscalYear, calendar.fiscalYearStartMonth),
      fiscalYearStartMonth: calendar.fiscalYearStartMonth,
      fiscalYearStartDay: calendar.fiscalYearStartDay,
      fiscalYearMode: useFiscalYearMode ? "fiscal" : "calendar",
    };

    const transactionHash = buildTransactionHash([
      companyId,
      tx.sourceUploadId || "",
      tx.sourceFile || "",
      String(fiscalYear || ""),
      isoDate || "",
      tx.accountName || "",
      tx.accountNumber || "",
      roundMoney(Number(tx.netAmount || 0)),
      tx.description || "",
      tx.reference || "",
      tx.transactionType || "",
      tx.journalType || "",
      tx.rowNumber || "",
    ]);

    return {
      ...tx,
      fiscalYear,
      metadata,
      transactionHash,
    };
  });
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
  fiscalCalendar = {},
}) {
  const resolvedMapping = resolveGlMapping(sheetData.headers, mapping);

  // Fallback: if no date column matched via MAPPING_CANDIDATES, scan cell values
  // across all columns and pick the one with the most date-like cells.
  if (!resolvedMapping.date) {
    const fallbackDateCol = detectDateColumnFallback(sheetData.headers, sheetData.rows);
    if (fallbackDateCol) {
      resolvedMapping.date = fallbackDateCol;
      console.log(`[GLParser] Fallback date column detected via cell-scan: "${fallbackDateCol}"`);
    }
  }

  // Structured column-detection log emitted for every GL sheet parsed.
  console.log("[GLParser]", JSON.stringify({
    sheetName: sheetData.sheetName,
    detectedDateColumn: resolvedMapping.date || null,
    detectedDebitColumn: resolvedMapping.debit || null,
    detectedCreditColumn: resolvedMapping.credit || null,
    detectedAmountColumn: resolvedMapping.amount || null,
    detectedVendorColumn: resolvedMapping.vendor_name || null,
    detectedAccountNameColumn: resolvedMapping.account_name || null,
    detectedAccountNumberColumn: resolvedMapping.account_number || null,
    detectedDescriptionColumn: resolvedMapping.description || null,
    detectedReferenceColumn: resolvedMapping.reference || null,
    headers: sheetData.headers,
  }));

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
  const resolvedFiscalCalendar = resolveFiscalCalendarConfig(fiscalCalendar);

  console.log(
    `[ManualGL][MultiYear] Sheet: ${sheetData.sheetName} | Inferred Year: ${inferredYear} | Row count: ${sheetData.rows?.length || 0}`,
  );

  const transactions = [];
  const warnings = [];
  const stats = {
    sheetName: sheetData.sheetName || "",
    totalRows: Array.isArray(sheetData.rows) ? sheetData.rows.length : 0,
    parsedRows: 0,
    skippedRows: 0,
    skippedByReason: {
      missing_account_name: 0,
      balance_forward_row: 0,
      summary_or_total_row: 0,
      missing_or_invalid_date: 0,
      no_amount: 0,
      invalid_amount: 0,
    },
    inferredYearHint: inferredYear || null,
    fiscalYearStartMonth: resolvedFiscalCalendar.fiscalYearStartMonth,
    fiscalYearStartDay: resolvedFiscalCalendar.fiscalYearStartDay,
  };

  const addWarning = (warning) => {
    if (warnings.length < MAX_SKIP_SAMPLES) {
      warnings.push(warning);
    }
  };

  const markSkipped = (reason, rowNumber, message, detail = null) => {
    stats.skippedRows += 1;
    stats.skippedByReason[reason] = (stats.skippedByReason[reason] || 0) + 1;
    addWarning({
      row: rowNumber,
      reason,
      message,
      ...(detail && typeof detail === "object" ? { detail } : {}),
    });
  };

  const hasValue = (value) =>
    !(value === null || value === undefined || String(value).trim() === "");

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
    const rawVendorName = normalizedMap.vendor_name ? normalizedRow[normalizedMap.vendor_name] : null;
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

    if (!accountName) {
      markSkipped("missing_account_name", rowNumber, "Missing account name. Row skipped.");
      return;
    }

    lastAccountName = accountName;
    const accountKey = normalizeKey(accountName);
    const rawDescriptionKey = rawDescription ? normalizeKey(String(rawDescription).trim()) : "";
    const rawReferenceKey = rawReference ? normalizeKey(String(rawReference).trim()) : "";
    // Detect structural/summary rows that must never count as GL activity.
    // QuickBooks and other accounting exports include per-account summary rows
    // (beginning balance, ending balance, balance forward) that represent
    // carry-forward totals, NOT new transactions. Including these as activity
    // double-counts the opening/closing balance and corrupts all subsequent
    // roll-forward calculations.
    // Detect QBO "Balance Forward" / "Beginning Balance" / "Ending Balance" carry-forward
    // rows separately from generic aggregate/total rows so the staging response can report
    // exactly how many of these corrupting entries were caught.
    const isBalanceForwardRow =
      /^(beginning balance|ending balance|balance forward)\b/i.test(accountKey) ||
      /^(beginning balance|beg\.?\s*bal|beg\s+bal|opening balance|open\.?\s*bal|balance forward|bal\.?\s*fwd|ending balance|end\.?\s*bal|end\s+bal|opening balance equity|initial balance)\b/i.test(rawDescriptionKey) ||
      /^(beginning balance|beg\.?\s*bal|balance forward|bal\.?\s*fwd|ending balance)\b/i.test(rawReferenceKey);

    const isTotalRow =
      !isBalanceForwardRow && (
        /^(total|subtotal|net income|gross profit)\b/i.test(accountKey) ||
        accountKey.startsWith("total for ")
      );

    if (isBalanceForwardRow) {
      markSkipped(
        "balance_forward_row",
        rowNumber,
        `Balance forward/opening/ending row "${accountName}" skipped â€” not a GL transaction.`,
      );
      return;
    }
    if (isTotalRow) {
      markSkipped(
        "summary_or_total_row",
        rowNumber,
        `Summary row "${accountName}" skipped.`,
      );
      return;
    }

    const parsedDate = parseDateFlexible(rawDate);
    const amountDetail = parseAmountDetail(rawAmount);
    const debitDetail = parseAmountDetail(rawDebit);
    const creditDetail = parseAmountDetail(rawCredit);
    const invalidAmountFields = [];
    if (amountDetail.isPresent && !amountDetail.isValid) invalidAmountFields.push("amount");
    if (debitDetail.isPresent && !debitDetail.isValid) invalidAmountFields.push("debit");
    if (creditDetail.isPresent && !creditDetail.isValid) invalidAmountFields.push("credit");

    const accountNumber = rawAccountNumber ? String(rawAccountNumber).trim() : "";
    const accountType = normalizeAccountType(rawAccountType) || inferAccountType(accountName, accountNumber);

    let debit = roundMoney(Math.abs(debitDetail.value));
    let credit = roundMoney(Math.abs(creditDetail.value));

    if (debit === 0 && credit === 0 && amountDetail.isPresent && amountDetail.isValid) {
      const derived = deriveDebitCreditFromSignedAmount(amountDetail.value, accountType, accountName);
      debit = derived.debit;
      credit = derived.credit;
    }

    const hasAmount =
      debit !== 0 ||
      credit !== 0 ||
      (amountDetail.isPresent && amountDetail.value !== 0);
    const hasAnyAmountField =
      hasValue(rawAmount) || hasValue(rawDebit) || hasValue(rawCredit);

    if (invalidAmountFields.length > 0 && !hasAmount) {
      markSkipped(
        "invalid_amount",
        rowNumber,
        `Invalid amount value for account "${accountName}" (${invalidAmountFields.join(", ")}). Row skipped.`,
      );
      return;
    }

    if (!parsedDate) {
      // Treat structural account heading rows as "no amount" rather than invalid-date data errors.
      if (!hasAnyAmountField && !hasAmount) {
        markSkipped(
          "no_amount",
          rowNumber,
          `Account heading row "${accountName}" has no transactional amount. Row skipped.`,
        );
      } else {
        markSkipped(
          "missing_or_invalid_date",
          rowNumber,
          `Missing/invalid date for account "${accountName}". Row skipped.`,
        );
      }
      return;
    }

    if (!hasAmount) {
      markSkipped(
        "no_amount",
        rowNumber,
        `No debit/credit amount for account "${accountName}". Row skipped.`,
      );
      return;
    }

    const isoDate = toIsoDate(parsedDate);
    if (!isoDate) {
      markSkipped(
        "missing_or_invalid_date",
        rowNumber,
        `Could not normalize date for account "${accountName}". Row skipped.`,
      );
      return;
    }

    const fiscalYear =
      computeFiscalYearEndLabel(isoDate, resolvedFiscalCalendar) ||
      inferredYear ||
      fiscalYearHint ||
      null;
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
    const vendorName = rawVendorName ? String(rawVendorName).trim() : "";
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
      vendorName,
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
      vendorName,
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
        fiscalYear,
        fiscalYearLabel: formatFiscalYearLabel(fiscalYear, resolvedFiscalCalendar.fiscalYearStartMonth),
        fiscalYearStartMonth: resolvedFiscalCalendar.fiscalYearStartMonth,
        fiscalYearStartDay: resolvedFiscalCalendar.fiscalYearStartDay,
      },
    });

    stats.parsedRows += 1;
  });

  return {
    success: true,
    mapping: resolvedMapping,
    warnings,
    transactions,
    stats,
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
    // leafCategory when available â€” prevents "Truck" under "Fixed Assets" header from
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
  datasetVersionId = null,
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
        dataset_version_id: datasetVersionId,
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
  //   1. normalizeKey â†’ lowercase, trim
  //   2. Strip pipe separators ("Bank of America | Checking" â†’ "bank of america checking")
  //   3. Strip account-number suffixes like "x7890" or "#7890" BEFORE the generic
  //      non-alphanumeric sweep, so the surrounding space collapse removes the gap.
  //   4. Strip 4+ digit standalone numbers that are account codes not part of the name.
  //   5. Generic non-alphanumeric â†’ space (handles &, /, -, etc.)
  //   6. Remove filler conjunctions so "Cash & Cash Equivalents" = "Cash and Cash Equivalents".
  //   7. Collapse whitespace.
  return normalizeKey(value)
    .replace(/\|/g, " ")                  // pipe separators â†’ space
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
  datasetVersionId = null,
  sourceType = MANUAL_SOURCE_KEY,
  sourceSwitchVersion = null,
  uploadSessionId = null,
  datasetHash = null,
  fiscalYearStart = null,
  fiscalYearEnd = null,
}) {
  const now = new Date().toISOString();
  const normalizedSessionId =
    uploadSessionId && isValidUuid(uploadSessionId)
      ? uploadSessionId
      : crypto.randomUUID();
  const normalizedVersion = sourceSwitchVersion || now;
  let datasetVersion = null;

  try {
    const { data: nextVersion, error: versionError } = await supabase
      .rpc("next_manual_gl_dataset_version", { p_company_id: companyId });

    if (!versionError && Number.isInteger(Number(nextVersion)) && Number(nextVersion) > 0) {
      datasetVersion = Number(nextVersion);
    } else if (versionError) {
      console.warn("[ManualGL][MultiYear] Dataset version RPC fallback:", versionError.message);
    }
  } catch (error) {
    console.warn("[ManualGL][MultiYear] Dataset version RPC unavailable:", error.message);
  }

  if (!datasetVersion) {
    const runVersionLookup = async (includeSourceType = true) => {
      let query = supabase
        .from(TABLES.batches)
        .select("dataset_version")
        .eq("company_id", companyId)
        .not("dataset_version", "is", null)
        .order("dataset_version", { ascending: false })
        .limit(1);
      if (includeSourceType) {
        query = query.eq("source_type", MANUAL_SOURCE_KEY);
      }
      return query.maybeSingle();
    };

    let { data: latestVersionRow, error: latestVersionError } = await runVersionLookup(true);

    if (latestVersionError && isMissingColumnError(latestVersionError, "source_type")) {
      ({ data: latestVersionRow, error: latestVersionError } = await runVersionLookup(false));
    }

    if (latestVersionError && !isMissingColumnError(latestVersionError, "dataset_version")) {
      throw new Error(`Failed to resolve dataset version: ${latestVersionError.message}`);
    }

    const latestDatasetVersion = Number(latestVersionRow?.dataset_version || 0);
    if (Number.isInteger(latestDatasetVersion) && latestDatasetVersion > 0) {
      datasetVersion = latestDatasetVersion + 1;
    } else {
      datasetVersion = 1;
    }
  }

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
      datasetVersion,
    },
    updated_at: now,
  };

  let payload = {
    ...basePayload,
    dataset_version_id: datasetVersionId,
    source_type: sourceType || MANUAL_SOURCE_KEY,
    source_switch_version: normalizedVersion,
    upload_session_id: normalizedSessionId,
    staged_at: now,
    batch_status: "processing",
    is_active: false,
    is_archived: false,
    dataset_version: datasetVersion,
    uploaded_by: createdBy || null,
    uploaded_at: now,
    processing_started_at: now,
    dataset_hash: datasetHash,
    fiscal_year_start: fiscalYearStart,
    fiscal_year_end: fiscalYearEnd,
  };

  const insertBatch = async (nextPayload) =>
    supabase
      .from(TABLES.batches)
      .insert(nextPayload)
      .select("*")
      .single();

  const insertWithSchemaFallback = async (nextPayload) => {
    let { data, error } = await insertBatch(nextPayload);

    if (error && isMissingColumnError(error)) {
      const fallbackPayloads = [
        {
          ...basePayload,
          source_type: sourceType || MANUAL_SOURCE_KEY,
        },
        { ...basePayload },
      ];

      for (const fallbackPayload of fallbackPayloads) {
        ({ data, error } = await insertBatch(fallbackPayload));
        if (!error || !isMissingColumnError(error)) break;
      }
    }

    return { data, error };
  };

  let { data, error } = await insertWithSchemaFallback(payload);

  // Recovery path #1:
  // A prior upload may have crashed and left a stale `processing` lock row.
  if (error && isProcessingBatchConstraintError(error)) {
    const releasedCount = await releaseStaleProcessingBatchLocks(companyId, sourceType, now);
    if (releasedCount > 0) {
      console.warn(
        `[ManualGL][MultiYear] Cleared ${releasedCount} stale processing batch lock(s) before retry.`,
      );
      ({ data, error } = await insertWithSchemaFallback(payload));
    }
    if (error && isProcessingBatchConstraintError(error)) {
      throw new Error(
        "Another Manual GL upload is currently processing for this company. Please wait for it to complete and retry.",
      );
    }
  }

  // Recovery path #2:
  // Concurrent requests can race on dataset_version assignment.
  let versionRetryCount = 0;
  while (
    error &&
    isDatasetVersionConstraintError(error) &&
    versionRetryCount < 3 &&
    Number.isInteger(Number(payload.dataset_version))
  ) {
    versionRetryCount += 1;
    const nextDatasetVersion = Number(payload.dataset_version) + 1;
    payload = {
      ...payload,
      dataset_version: nextDatasetVersion,
      metadata: {
        ...(payload.metadata && typeof payload.metadata === "object" ? payload.metadata : {}),
        datasetVersion: nextDatasetVersion,
      },
    };
    ({ data, error } = await insertWithSchemaFallback(payload));
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

  const fullPayload = {
    ...(patch.status ? { status: patch.status } : {}),
    ...(patch.batch_name ? { batch_name: patch.batch_name } : {}),
    ...(patch.batch_status ? { batch_status: patch.batch_status } : {}),
    ...(typeof patch.is_active === "boolean" ? { is_active: patch.is_active } : {}),
    ...(typeof patch.is_archived === "boolean" ? { is_archived: patch.is_archived } : {}),
    ...(Number.isInteger(Number(patch.dataset_version))
      ? { dataset_version: Number(patch.dataset_version) }
      : {}),
    ...(patch.upload_checksum ? { upload_checksum: patch.upload_checksum } : {}),
    ...(patch.uploaded_by !== undefined ? { uploaded_by: patch.uploaded_by } : {}),
    ...(patch.uploaded_at ? { uploaded_at: patch.uploaded_at } : {}),
    ...(patch.processing_started_at ? { processing_started_at: patch.processing_started_at } : {}),
    ...(patch.processing_completed_at ? { processing_completed_at: patch.processing_completed_at } : {}),
    ...(patch.activated_at ? { activated_at: patch.activated_at } : {}),
    ...(patch.activated_by !== undefined ? { activated_by: patch.activated_by } : {}),
    ...(patch.deactivated_at ? { deactivated_at: patch.deactivated_at } : {}),
    ...(patch.deactivated_by !== undefined ? { deactivated_by: patch.deactivated_by } : {}),
    metadata: {
      ...(current.metadata && typeof current.metadata === "object" ? current.metadata : {}),
      ...(patch.metadata && typeof patch.metadata === "object" ? patch.metadata : {}),
    },
    updated_at: now,
  };

  let { data, error } = await supabase
    .from(TABLES.batches)
    .update(fullPayload)
    .eq("id", batchId)
    .select("*")
    .single();

  if (error && isMissingColumnError(error)) {
    // Backward-compatible fallback for pre-026 schema.
    const legacyPayload = {
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.batch_name ? { batch_name: patch.batch_name } : {}),
      metadata: fullPayload.metadata,
      updated_at: now,
    };

    ({ data, error } = await supabase
      .from(TABLES.batches)
      .update(legacyPayload)
      .eq("id", batchId)
      .select("*")
      .single());
  }

  if (error) throw new Error(`Failed to update staging batch: ${error.message}`);
  return data;
}

async function insertTransactions({
  companyId,
  batchId,
  transactions = [],
  datasetVersionId = null,
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
    upload_batch_id: batchId,
    transaction_id: tx.transactionId,
    fiscal_year: tx.fiscalYear,
    txn_date: tx.date,
    account_number: tx.accountNumber || null,
    account_name: tx.accountName,
    vendor_name: tx.vendorName || null,
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
    raw_row_reference: tx.rawRowReference || {
      sourceUploadId: tx.sourceUploadId || null,
      rowNumber: tx.rowNumber || null,
      sourceFile: tx.sourceFile || null,
    },
    metadata: tx.metadata || {},
  }));
  let rows = baseRows.map((row) => ({
    ...row,
    dataset_version_id: datasetVersionId,
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
            upload_batch_id,
            vendor_name,
            raw_row_reference,
            ...legacy
          }) => legacy,
        );
        rows = rows.map(
          ({
            source_type,
            source_switch_version,
            upload_session_id,
            staged_at,
            upload_batch_id,
            vendor_name,
            raw_row_reference,
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

async function fetchBatchTransactions(companyId, batchId, fiscalYears = [], columns = "*") {
  if (!companyId || !batchId) return [];

  const years = Array.isArray(fiscalYears)
    ? fiscalYears.map((year) => Number(year)).filter((year) => Number.isInteger(year) && year > 0)
    : [];

  const pageSize = 1000;
  const rows = [];
  let offset = 0;

  while (true) {
    let query = supabase
      .from(TABLES.transactions)
      .select(columns)
      .eq("company_id", companyId)
      .eq("upload_batch_id", batchId)
      .order("id", { ascending: true })
      .range(offset, offset + pageSize - 1);

    if (years.length) {
      query = query.in("fiscal_year", years);
    }

    let { data, error } = await query;

    if (error && isMissingColumnError(error, "upload_batch_id")) {
      let fallback = supabase
        .from(TABLES.transactions)
        .select(columns)
        .eq("company_id", companyId)
        .eq("batch_id", batchId)
        .order("id", { ascending: true })
        .range(offset, offset + pageSize - 1);

      if (years.length) {
        fallback = fallback.in("fiscal_year", years);
      }

      ({ data, error } = await fallback);
    }

    if (error) {
      throw new Error(`Failed to load batch transactions: ${error.message}`);
    }

    const chunk = Array.isArray(data) ? data : [];
    if (!chunk.length) break;

    rows.push(...chunk);
    if (chunk.length < pageSize) break;
    offset += chunk.length;
  }

  return rows;
}

async function computeBatchYearSummaries(companyId, batchId, fiscalYears = []) {
  const rows = await fetchBatchTransactions(companyId, batchId, fiscalYears);
  const grouped = new Map();

  rows.forEach((row) => {
    const normalized = normalizeStagedTransactionRow(row);
    const fiscalYear = Number(normalized?.fiscalYear || 0);
    if (!Number.isInteger(fiscalYear) || fiscalYear <= 0) return;
    if (!grouped.has(fiscalYear)) grouped.set(fiscalYear, []);
    grouped.get(fiscalYear).push(normalized);
  });

  const summaries = {};
  grouped.forEach((transactions, fiscalYear) => {
    summaries[fiscalYear] = {
      fiscalYear,
      rowCount: transactions.length,
      sourceUploadIds: Array.from(
        new Set(transactions.map((tx) => String(tx.sourceUploadId || "").trim()).filter(Boolean)),
      ).sort(),
      fileHash: null,
      dataHash: buildYearDataHash(transactions),
    };
  });

  return summaries;
}

async function copyBatchTransactionsForYears({
  companyId,
  sourceBatchId,
  targetBatchId,
  fiscalYears = [],
  datasetVersionId = null,
  sourceType = MANUAL_SOURCE_KEY,
  sourceSwitchVersion = null,
  uploadSessionId = null,
}) {
  const years = Array.isArray(fiscalYears)
    ? fiscalYears.map((year) => Number(year)).filter((year) => Number.isInteger(year) && year > 0)
    : [];
  if (!companyId || !sourceBatchId || !targetBatchId || years.length === 0) {
    return { inserted: 0, yearGroups: {} };
  }

  const rows = await fetchBatchTransactions(companyId, sourceBatchId, years);
  if (!rows.length) {
    return { inserted: 0, yearGroups: {} };
  }

  const stagedAt = new Date().toISOString();
  const normalizedSessionId =
    uploadSessionId && isValidUuid(uploadSessionId) ? uploadSessionId : null;
  const normalizedVersion = sourceSwitchVersion || null;
  const payloads = rows.map((row) => ({
    company_id: companyId,
    batch_id: targetBatchId,
    upload_batch_id: targetBatchId,
    transaction_id: row.transaction_id,
    fiscal_year: row.fiscal_year,
    txn_date: row.txn_date,
    account_number: row.account_number,
    account_name: row.account_name,
    vendor_name: row.vendor_name || null,
    account_type: row.account_type || null,
    category: row.category || null,
    sub_category: row.sub_category || null,
    debit: row.debit,
    credit: row.credit,
    net_amount: row.net_amount,
    class: row.class || null,
    department: row.department || null,
    location: row.location || null,
    journal_type: row.journal_type || null,
    transaction_type: row.transaction_type || null,
    reference: row.reference || null,
    description: row.description || null,
    source_file: row.source_file || null,
    source_upload_id: row.source_upload_id || null,
    row_number: row.row_number || null,
    transaction_hash: buildTransactionHash([targetBatchId, row.transaction_hash]),
    raw_row_reference: row.raw_row_reference || {
      sourceUploadId: row.source_upload_id || null,
      rowNumber: row.row_number || null,
      sourceFile: row.source_file || null,
    },
    metadata: {
      ...(row.metadata && typeof row.metadata === "object" ? row.metadata : {}),
      carriedForwardFromBatchId: sourceBatchId,
    },
    dataset_version_id: datasetVersionId,
    source_type: sourceType || MANUAL_SOURCE_KEY,
    source_switch_version: normalizedVersion,
    upload_session_id: normalizedSessionId,
    staged_at: stagedAt,
  }));

  const yearGroups = {};
  payloads.forEach((row) => {
    const yearKey = row.fiscal_year || "Unknown";
    yearGroups[yearKey] = (yearGroups[yearKey] || 0) + 1;
  });

  const chunkSize = 500;
  for (let index = 0; index < payloads.length; index += chunkSize) {
    const chunk = payloads.slice(index, index + chunkSize);
    let { error } = await supabase
      .from(TABLES.transactions)
      .upsert(chunk, {
        onConflict: "company_id,batch_id,transaction_hash",
        ignoreDuplicates: true,
      });

    if (error && (isMissingColumnError(error) || isConflictTargetError(error))) {
      const legacyChunk = chunk.map(
        ({
          source_type,
          source_switch_version,
          upload_session_id,
          staged_at,
          upload_batch_id,
          vendor_name,
          raw_row_reference,
          ...legacy
        }) => legacy,
      );

      const legacyResult = await supabase
        .from(TABLES.transactions)
        .upsert(legacyChunk, {
          onConflict: isConflictTargetError(error)
            ? "company_id,transaction_hash"
            : "company_id,batch_id,transaction_hash",
          ignoreDuplicates: true,
        });

      error = legacyResult.error;
    }

    if (error) {
      throw new Error(`Failed to carry forward staged transactions: ${error.message}`);
    }
  }

  return {
    inserted: payloads.length,
    yearGroups,
  };
}

async function copyBalanceSheetLinesFromBatch({
  companyId,
  sourceBatchId,
  targetBatchId,
  sheetType,
  datasetVersionId = null,
  sourceType = MANUAL_SOURCE_KEY,
  sourceSwitchVersion = null,
  uploadSessionId = null,
}) {
  if (!companyId || !sourceBatchId || !targetBatchId || !sheetType) {
    return { inserted: 0 };
  }

  const lines = await loadBatchBalanceSheetLines(companyId, sourceBatchId, sheetType);
  if (!lines.length) {
    return { inserted: 0 };
  }

  const stagedAt = new Date().toISOString();
  const normalizedSessionId =
    uploadSessionId && isValidUuid(uploadSessionId) ? uploadSessionId : null;
  const normalizedVersion = sourceSwitchVersion || null;

  const payloads = lines.map((line) => ({
    company_id: companyId,
    batch_id: targetBatchId,
    sheet_type: line.sheet_type,
    as_of_date: line.as_of_date || null,
    section: line.section,
    account_name: line.account_name,
    amount: line.amount,
    source_file: line.source_file || null,
    source_upload_id: line.source_upload_id || null,
    row_number: line.row_number || null,
    line_hash: buildBalanceSheetLineHash({
      ...line,
      batch_id: targetBatchId,
    }),
    source_type: sourceType || MANUAL_SOURCE_KEY,
    source_switch_version: normalizedVersion,
    upload_session_id: normalizedSessionId,
    staged_at: stagedAt,
    metadata: {
      ...(line.metadata && typeof line.metadata === "object" ? line.metadata : {}),
      carriedForwardFromBatchId: sourceBatchId,
    },
    dataset_version_id: datasetVersionId,
  }));

  const result = await replaceBalanceSheetLines({
    companyId,
    batchId: targetBatchId,
    sheetType,
    lines: payloads,
  });

  return result;
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

function parsePositiveIntegerValue(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
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
  const rawDatasetVersionId = toNonEmptyString(
    rawFilters.datasetVersionId || rawFilters.dataset_version_id || "",
  );
  let rawDatasetVersion = toNonEmptyString(
    rawFilters.datasetVersion ||
    rawFilters.dataset_version ||
    rawFilters.versionNumber ||
    rawFilters.version_number ||
    "",
  );
  const rawUploadSessionId = toNonEmptyString(
    rawFilters.uploadSessionId || rawFilters.upload_session_id || rawFilters.versionId || rawFilters.version_id || "",
  );
  const rawVersionId = toNonEmptyString(
    rawFilters.versionId || rawFilters.version_id || rawUploadSessionId || "",
  );
  if (!rawDatasetVersion && rawVersionId && !isValidUuid(rawVersionId)) {
    rawDatasetVersion = rawVersionId;
  }
  const datasetVersion = parsePositiveIntegerValue(rawDatasetVersion);
  const rawVersionMode = toNonEmptyString(
    rawFilters.versionMode || rawFilters.version_mode || "",
  ).toLowerCase();
  const includeArchived = parseBoolean(
    rawFilters.includeArchived ||
    rawFilters.include_archived ||
    rawFilters.allowArchived ||
    rawFilters.allow_archived ||
    rawFilters.historical,
  ) || rawVersionMode === REPORT_BATCH_MODE.HISTORICAL || rawVersionMode === "archived" || !!rawVersionId || !!datasetVersion;

  return {
    batchId: rawFilters.batchId || rawFilters.batch_id || "",
    datasetVersionId: rawDatasetVersionId,
    datasetVersion,
    versionId: rawVersionId,
    versionMode: includeArchived ? REPORT_BATCH_MODE.HISTORICAL : REPORT_BATCH_MODE.ACTIVE,
    includeArchived,
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

  if (!filters.batchId && (filters.versionId || filters.uploadSessionId)) {
    const resolvedBatchFromVersion = await resolveReportBatchId(companyId, "", {
      ...filters,
      allowExplicitBatch: true,
      includeArchived: true,
      versionMode: REPORT_BATCH_MODE.HISTORICAL,
      versionId: filters.versionId || "",
      uploadSessionId: filters.uploadSessionId || "",
    });
    if (resolvedBatchFromVersion) {
      filters.batchId = resolvedBatchFromVersion;
    }
  }

  if (!filters.batchId && Number.isInteger(Number(filters.datasetVersion)) && Number(filters.datasetVersion) > 0) {
    const resolvedBatchFromDatasetVersion = await resolveReportBatchId(companyId, "", {
      ...filters,
      allowExplicitBatch: true,
      includeArchived: true,
      versionMode: REPORT_BATCH_MODE.HISTORICAL,
      datasetVersion: Number(filters.datasetVersion),
    });
    if (resolvedBatchFromDatasetVersion) {
      filters.batchId = resolvedBatchFromDatasetVersion;
    }
  }

  if (!filters.batchId && !filters.allBatches && !filters.datasetVersionId && !filters.datasetVersion) {
    const activeBatch = await getActiveUploadBatch(companyId);
    if (activeBatch?.id) {
      filters.batchId = activeBatch.id;
    } else {
      // Backward-compatible fallback for legacy dataset-version-only installs.
      let activeVersion = await getActiveDatasetVersion(companyId);
      if (!activeVersion) {
        activeVersion = await ensureLegacyDatasetVersion(companyId);
      }
      if (!activeVersion) {
        return { filters, rows: [] };
      }
      filters.datasetVersionId = activeVersion.id;
    }
  }

  const buildQuery = (includeSourceColumns = true, batchColumn = "upload_batch_id") => {
    let query = supabase
      .from(TABLES.transactions)
      .select("*")
      .eq("company_id", companyId);

    if (filters.datasetVersionId) {
      query = query.eq("dataset_version_id", filters.datasetVersionId);
    } else if (filters.batchId) {
      query = query.eq(batchColumn, filters.batchId);
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

  const fetchPagedRows = async (
    includeSourceColumns = true,
    batchColumn = "upload_batch_id",
  ) => {
    const maxRows = Math.max(1, Number(filters.limit || DEFAULT_STAGING_LIMIT));
    const pageSize = 1000; // Supabase/PostgREST max page size.
    const rows = [];
    let offset = 0;

    while (rows.length < maxRows) {
      const chunkSize = Math.min(pageSize, maxRows - rows.length);
      const rangeEnd = offset + chunkSize - 1;
      const query = buildQuery(includeSourceColumns, batchColumn).range(offset, rangeEnd);

      const { data, error } = await query;
      if (error) {
        return { rows: [], error, batchColumn };
      }

      const chunk = Array.isArray(data) ? data : [];
      if (!chunk.length) break;

      rows.push(...chunk);
      offset += chunk.length;

      if (chunk.length < pageSize) break;
    }

    return { rows, error: null, batchColumn };
  };

  let { rows, error, batchColumn } = await fetchPagedRows(true, "upload_batch_id");
  if (error && isMissingColumnError(error, "upload_batch_id")) {
    ({ rows, error, batchColumn } = await fetchPagedRows(true, "batch_id"));
  } else if (error && isMissingColumnError(error)) {
    ({ rows, error, batchColumn } = await fetchPagedRows(false, "upload_batch_id"));
    if (error && isMissingColumnError(error, "upload_batch_id")) {
      ({ rows, error, batchColumn } = await fetchPagedRows(false, "batch_id"));
    }
  }

  // Legacy resilience: if upload_batch_id exists but historical rows were not backfilled,
  // retry on batch_id so prior installs still render.
  if (
    !error &&
    rows.length === 0 &&
    !filters.datasetVersionId &&
    filters.batchId &&
    batchColumn === "upload_batch_id"
  ) {
    const legacy = await fetchPagedRows(true, "batch_id");
    if (!legacy.error && Array.isArray(legacy.rows) && legacy.rows.length > 0) {
      rows = legacy.rows;
      batchColumn = legacy.batchColumn;
    }
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
  const metadata =
    row.metadata && typeof row.metadata === "object"
      ? row.metadata
      : {};
  const rowFiscalCalendar = resolveFiscalCalendarConfig({
    fiscalYearStartMonth: metadata.fiscalYearStartMonth,
    fiscalYearStartDay: metadata.fiscalYearStartDay,
  });
  const accountNumber = row.account_number || row.accountNumber || "";
  const accountName = row.account_name || row.accountName || "";
  const rawType = row.account_type || row.accountType || "";
  const normalizedType = normalizeAccountType(rawType) || inferAccountType(accountName, accountNumber);
  const parsedFiscalYear =
    Number(row.fiscal_year || row.fiscalYear || 0) ||
    Number(metadata.fiscalYear || 0) ||
    computeFiscalYearEndLabel(isoDate, rowFiscalCalendar);
  const parsedFiscalMonth =
    Number(row.fiscal_month || row.fiscalMonth || 0) ||
    (isoDate && /^\d{4}-\d{2}-\d{2}$/.test(isoDate) ? Number(isoDate.slice(5, 7)) : null);

  return {
    id: row.id || row.row_id || null,
    transactionId: txId,
    fiscalYear: Number.isInteger(parsedFiscalYear) ? parsedFiscalYear : null,
    fiscalMonth: Number.isInteger(parsedFiscalMonth) ? parsedFiscalMonth : null,
    date: isoDate,
    transactionDate: isoDate,
    accountNumber,
    accountName,
    vendorName: row.vendor_name || row.vendorName || "",
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
    batchId:
      row.upload_batch_id ||
      row.uploadBatchId ||
      row.batch_id ||
      row.batchId ||
      null,
    uploadBatchId:
      row.upload_batch_id ||
      row.uploadBatchId ||
      row.batch_id ||
      row.batchId ||
      null,
    rawRowReference:
      row.raw_row_reference && typeof row.raw_row_reference === "object"
        ? row.raw_row_reference
        : (row.rawRowReference && typeof row.rawRowReference === "object" ? row.rawRowReference : null),
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

    const year =
      Number(tx.fiscalYear || 0) ||
      computeFiscalYearEndLabel(tx.date, resolveFiscalCalendarConfig()) ||
      0;
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
  // Resolve displayYear to the last available year so account-level rows always
  // match the header totals. Without this guard, a null displayYear would let ALL
  // years' transaction amounts accumulate into account rows while the section
  // totals (pulled from yearlyRows) would only reflect the last year â€” producing
  // inflated account-level numbers in a multi-year GL view.
  const resolvedDisplayYear =
    (Number.isInteger(displayYear) && displayYear > 0)
      ? displayYear
      : (yearlyRows.length > 0 ? yearlyRows[yearlyRows.length - 1].fiscalYear : null);

  const accountMap = new Map();

  transactions.forEach((tx) => {
    const txFY = Number(tx.fiscalYear || 0);
    if (resolvedDisplayYear && txFY !== resolvedDisplayYear) return;

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

  const yearRow = resolvedDisplayYear ? yearlyRows.find(r => r.fiscalYear === resolvedDisplayYear) : (yearlyRows[yearlyRows.length - 1] || null);
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
  const years = yearlyRows
    .map((row) => Number(row.fiscalYear))
    .filter((year) => Number.isInteger(year) && year > 0)
    .sort((a, b) => a - b);
  const validYears = new Set(years);

  const accountsMap = new Map();
  let detailIndex = 0;

  transactions.forEach((tx) => {
    const accountType = normalizeAccountType(tx.accountType) || inferAccountType(tx.accountName, tx.accountNumber);
    if (!["income", "cogs", "expense"].includes(accountType)) return;

    const category = normalizeProfitLossCategory(tx.category, tx.accountName, tx.accountType);
    if (!category) return;

    const fiscalYear = Number(tx.fiscalYear || 0);
    if (!Number.isInteger(fiscalYear) || fiscalYear <= 0 || !validYears.has(fiscalYear)) return;

    const accountKey = `${tx.accountNumber || ""}::${tx.accountName || ""}`;
    if (!accountsMap.has(accountKey)) {
      accountsMap.set(accountKey, {
        accountNumber: tx.accountNumber || "",
        accountName: tx.accountName || "",
        subCategory: tx.subCategory || "",
        category,
        accountType,
        yearlyTotals: {},
        totalNet: 0,
        transactions: [],
      });
    }

    const account = accountsMap.get(accountKey);
    if (!account.subCategory && tx.subCategory) {
      account.subCategory = String(tx.subCategory).trim();
    }

    const signed = roundMoney(Number(tx.netAmount || 0));
    const amount = category === "Revenue" ? signed : roundMoney(-signed);
    account.yearlyTotals[fiscalYear] = roundMoney((account.yearlyTotals[fiscalYear] || 0) + amount);
    account.totalNet = roundMoney(account.totalNet + amount);

    const txDate = tx.transactionDate || tx.date || null;
    const txRowNumber = Number.isInteger(Number(tx.rowNumber)) ? Number(tx.rowNumber) : null;
    const txId = String(tx.transactionId || tx.id || "").trim();
    const txKey = txId || `pl-detail-${fiscalYear}-${detailIndex}`;
    detailIndex += 1;

    account.transactions.push({
      id: txKey,
      transactionId: txId || txKey,
      fiscalYear,
      transactionDate: txDate,
      date: txDate,
      accountName: tx.accountName || "",
      accountNumber: tx.accountNumber || "",
      vendorName: tx.vendorName || "",
      memo: tx.description || "",
      description: tx.description || "",
      journalType: tx.journalType || "",
      transactionType: tx.transactionType || "",
      reference: tx.reference || "",
      debit: roundMoney(Number(tx.debit || 0)),
      credit: roundMoney(Number(tx.credit || 0)),
      signedAmount: amount,
      amount,
      sourceFile: tx.sourceFile || "",
      sourceUploadId: tx.sourceUploadId || null,
      rowNumber: txRowNumber,
      batchId: tx.uploadBatchId || tx.batchId || null,
      rawRowReference:
        tx.rawRowReference && typeof tx.rawRowReference === "object"
          ? tx.rawRowReference
          : null,
      class: tx.class || "",
      department: tx.department || "",
      location: tx.location || "",
    });
  });

  const accounts = Array.from(accountsMap.values()).sort((a, b) => {
    if (a.category !== b.category) return a.category.localeCompare(b.category);
    return String(a.accountName || "").localeCompare(String(b.accountName || ""));
  });

  accounts.forEach((account) => {
    account.transactions.sort((left, right) => {
      const leftYear = Number(left.fiscalYear || 0);
      const rightYear = Number(right.fiscalYear || 0);
      if (leftYear !== rightYear) return leftYear - rightYear;
      const leftDate = String(left.transactionDate || left.date || "");
      const rightDate = String(right.transactionDate || right.date || "");
      if (leftDate !== rightDate) return leftDate.localeCompare(rightDate);
      const leftRow = Number(left.rowNumber || 0);
      const rightRow = Number(right.rowNumber || 0);
      if (leftRow !== rightRow) return leftRow - rightRow;
      return String(left.transactionId || "").localeCompare(String(right.transactionId || ""));
    });
  });

  const categoryOrder = ["Revenue", "COGS", "Operating Expenses", "Other Expenses"];
  const uniqueCategories = Array.from(new Set(accounts.map((account) => account.category))).filter(Boolean);
  uniqueCategories.sort((left, right) => {
    const leftIndex = categoryOrder.indexOf(left);
    const rightIndex = categoryOrder.indexOf(right);
    if (leftIndex !== -1 || rightIndex !== -1) {
      if (leftIndex === -1) return 1;
      if (rightIndex === -1) return -1;
      return leftIndex - rightIndex;
    }
    return left.localeCompare(right);
  });

  const groupedCategories = uniqueCategories.map((categoryName) => {
    const categoryAccounts = accounts.filter((account) => account.category === categoryName);
    const totalsByYear = {};
    years.forEach((year) => {
      totalsByYear[year] = roundMoney(
        categoryAccounts.reduce((sum, account) => sum + Number(account.yearlyTotals?.[year] || 0), 0),
      );
    });
    const total = roundMoney(categoryAccounts.reduce((sum, account) => sum + Number(account.totalNet || 0), 0));
    return {
      category: categoryName,
      totalsByYear,
      total,
      accounts: categoryAccounts,
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
    rowCount: accounts.reduce((sum, account) => sum + (Array.isArray(account.transactions) ? account.transactions.length : 0), 0),
  };
}

function buildBalanceSheetPayload(transactions = [], filters = {}, netProfitByYear = {}, startingLines = [], fiscalCalendar = {}) {
  const normalized = transactions.filter(Boolean);

  // Years present in user-selected filter (may be empty â†’ "show all").
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
  // This ensures the 2023â†’2024 carry-forward happens even without 2023 transactions.
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
    account.openingBalance = roundMoney(account.openingBalance + normalizeBsLineAmount(line.amount, accountType, accountName));
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
    const delta = computeBsActivityDelta(tx.netAmount, account.accountType, contra);

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

  // Phase 7: MissingAccountDetector â€” warn when a starting-BS account has zero balance
  // across all computed years. Most common cause: re-staging without re-uploading the starting BS.
  if (startingLines.length > 0) {
    const zeroBsAccounts = accounts.filter(
      (a) => a.sources.has("starting") && Object.values(a.balancesByYear).every((v) => v === 0),
    );
    if (zeroBsAccounts.length > 0) {
      console.warn(
        `[ManualGL][BS][MissingAccountDetector] ${zeroBsAccounts.length} starting-BS account(s) resolved to $0 across all years.`,
        `This usually means the starting BS was not re-uploaded when the GL was re-staged.`,
        `Affected accounts: ${zeroBsAccounts.map((a) => `"${a.accountName}" (${a.accountType})`).join(", ")}`,
      );
    }
  } else {
    console.warn(
      `[ManualGL][BS][MissingAccountDetector] startingLines is empty â€” no opening balances loaded.`,
      `Static BS accounts (e.g. fixed assets with no GL activity) will show $0.`,
      `Re-upload the starting Balance Sheet to fix this.`,
    );
  }

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

  // Carry net income for prior year Y only when the starting BS predates the END of
  // fiscal year Y â€” i.e. FY Y's net income has NOT yet been closed into the opening
  // retained-earnings balance.
  //
  // We use a direct ISO-date comparison against computeFiscalYearEndDate so the guard
  // is correct regardless of whether transactions were labeled with calendar-year keys
  // (BUG-2 fix: non-explicit fiscal calendar â†’ calendar year) or true fiscal-year end
  // labels (explicit April or other fiscal calendar).  The old approach compared integer
  // year labels using ">" which failed when the default April calendar (month=4) was
  // applied to a calendar-year company: computeFiscalYearEndLabel("2022-12-31", month=4)
  // returned 2023, blocking the legitimate carry of 2023 net income into 2024 RE.
  const startingBsDateStr = startingLines.find((l) => l.as_of_date)?.as_of_date || null;
  const bsCalendar = resolveFiscalCalendarConfig(fiscalCalendar);

  const retainedByYearCarry = {};
  let cumulativePriorNet = 0;
  years.forEach((year, index) => {
    if (index > 0) {
      const priorYear = years[index - 1];
      // Carry priorYear's NI only when the starting BS is dated BEFORE the end of
      // that fiscal year (meaning its net income has NOT been closed into opening RE).
      const fiscalEndDate = computeFiscalYearEndDate(priorYear, bsCalendar);
      const priorYearNotYetClosed = !startingBsDateStr || !fiscalEndDate || startingBsDateStr < fiscalEndDate;
      if (priorYearNotYetClosed) {
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

  // Capture pre-adjustment variance per year BEFORE mutating section totals so
  // the audit can surface the real imbalance to server logs and the API caller.
  // The force-balance below parks any variance into Retained Earnings so the
  // rendered sheet always nets to zero â€” but hiding the root cause makes
  // debugging impossible, so we track it separately.
  const rawVarianceByYear = {};

  years.forEach((year) => {
    const assets = roundMoney(Number(sections.Assets.totalByYear?.[year] || 0));
    const liabilities = roundMoney(Number(sections.Liabilities.totalByYear?.[year] || 0));
    const equity = roundMoney(Number(sections.Equity.totalByYear?.[year] || 0));
    const variance = roundMoney(assets - (liabilities + equity));
    rawVarianceByYear[year] = variance;
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
    // rawVariance is the pre-force-balance gap; difference is always â‰¤ BALANCE_EPSILON
    // after the adjustment above.  Expose both so callers can detect real data issues.
    const rawVariance = rawVarianceByYear[year] ?? difference;
    return {
      year,
      assets,
      liabilitiesAndEquity,
      difference,
      rawVariance,
      isBalanced: Math.abs(rawVariance) <= BALANCE_EPSILON,
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
    `[ManualGL][BS][Debug] buildBalanceSheetPayload â€” internal years: [${years.join(", ")}]`,
    `| displayYear: ${displayYear}`,
    `| accounts classified: Assets=${sections.Assets.categories.reduce((s, c) => s + c.accounts.length, 0)
    }, Liabilities=${sections.Liabilities.categories.reduce((s, c) => s + c.accounts.length, 0)
    }, Equity=${sections.Equity.categories.reduce((s, c) => s + c.accounts.length, 0)
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

  // Phase 4/8: ReconciliationEngine â€” per-year double-entry check (total debits = total credits).
  // Uses the full normalized transaction set (all account types, not just BS) so we verify
  // whether the source GL journals are internally balanced. A non-zero netGlVariance here
  // points to corrupted GL data BEFORE classification, not a BS-specific bug.
  const glReconciliation = years.map((year) => {
    const yearTxs = normalized.filter((tx) => Number(tx.fiscalYear || 0) === year);
    const totalDebits = roundMoney(yearTxs.reduce((sum, tx) => sum + Math.abs(Number(tx.debit || 0)), 0));
    const totalCredits = roundMoney(yearTxs.reduce((sum, tx) => sum + Math.abs(Number(tx.credit || 0)), 0));
    const netGlVariance = roundMoney(totalCredits - totalDebits);
    const isGlBalanced = Math.abs(netGlVariance) <= BALANCE_EPSILON;
    if (!isGlBalanced) {
      console.warn(
        `[ManualGL][BS][ReconciliationEngine] Year ${year}: GL debits (${totalDebits}) â‰  credits (${totalCredits}).`,
        `Net variance: ${netGlVariance}. Source GL may contain unbalanced journal entries.`,
      );
    }
    return { year, totalDebits, totalCredits, netGlVariance, isGlBalanced };
  });

  return {
    source: "manual_gl_staged_transactions",
    reportType: "balance_sheet",
    filters,
    years,
    displayYear,
    sections,
    hierarchicalRows: [assetsNode, liabilitiesAndEquityNode],
    audit,
    glReconciliation,
  };
}

async function getBalanceSheetSummaryFromStage(companyId, filters = {}) {
  const effectiveBatchId =
    filters.batchId || (await resolveReportBatchId(companyId));

  // Load starting + ending BS lines and batch metadata in parallel.
  let startingLines = [];
  let endingLines = [];
  let batchMeta = {};
  if (effectiveBatchId) {
    [startingLines, endingLines, batchMeta] = await Promise.all([
      loadBatchBalanceSheetLines(companyId, effectiveBatchId, SHEET_TYPE.STARTING),
      loadBatchBalanceSheetLines(companyId, effectiveBatchId, SHEET_TYPE.ENDING),
      loadBatchMetadata(effectiveBatchId),
    ]);
  }
  // When a batch was staged WITHOUT an explicit fiscal calendar (calendar-year company),
  // the old code (pre-BUG2-fix) applied the April default and assigned wrong end-year labels
  // to Aprâ€“Dec transactions. We correct at query time so re-staging is not required.
  const fiscalCalendarExplicit = batchMeta.fiscalCalendarExplicit === true;

  // STEP 2: Query ALL transactions for the batch, cumulative and unfiltered by year.
  // This is intentional: BS balances are rolling totals â€” e.g. the Dec-31-2023 balance
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
    `| fiscalCalendarExplicit: ${fiscalCalendarExplicit}`,
  );

  const { rows: rawRows } = await queryStagedTransactions(companyId, {
    ...filters,
    batchId: effectiveBatchId || filters.batchId || "",
    reportType: "",
    fiscalYear: null,
    fiscalYears: [],
    startDate: "",
    endDate: "",
    limit: DEFAULT_STAGING_LIMIT,
  });

  // Apply calendar-year correction for non-explicit-fiscal-calendar batches.
  // For explicit fiscal calendars (April, etc.) the stored labels are correct.
  const rows = fiscalCalendarExplicit ? rawRows : applyCalendarYearCorrection(rawRows);

  console.log(`[ManualGL][BS][Debug] Total staged transactions in batch: ${rows.length}`);

  // Distribute rows by corrected fiscal_year for the audit log.
  const rawYearGroups = {};
  rawRows.forEach((r) => { const yr = r.fiscal_year || "unknown"; rawYearGroups[yr] = (rawYearGroups[yr] || 0) + 1; });
  const correctedYearGroups = {};
  rows.forEach((r) => { const yr = r.fiscal_year || "unknown"; correctedYearGroups[yr] = (correctedYearGroups[yr] || 0) + 1; });
  if (!fiscalCalendarExplicit) {
    console.log(`[ManualGL][BS][Debug] Year distribution BEFORE correction:`, JSON.stringify(rawYearGroups));
    console.log(`[ManualGL][BS][Debug] Year distribution AFTER correction:`, JSON.stringify(correctedYearGroups));
  }

  let cumulativeRows = rows;
  if (maxYear) {
    cumulativeRows = rows.filter((r) => Number(r.fiscal_year || 0) <= maxYear);
  }

  console.log(
    `[ManualGL][BS][Debug] Cumulative rows after maxYear (${maxYear}) filter: ${cumulativeRows.length}`,
    `(excluded future years: ${rows.length - cumulativeRows.length})`,
  );

  // CRITICAL: Exclude GL transactions on/before the starting BS as_of_date.
  //
  // Root cause of the "exact 2x doubling" bug:
  // The starting BS opening balance already reflects ALL activity through its as_of_date
  // (e.g. 2022-12-31 means all 2022 journal entries are baked into every account's
  // opening balance). If we also include those 2022 GL rows as "activity", the
  // buildBalanceSheetPayload rolling loop adds them on top of an opening balance that
  // already contains them â†’ every account doubles.
  //
  // Fix: only pass GL transactions that occurred AFTER the starting BS date.
  // The starting BS opening balance covers everything up to and including that date.
  const startingBsDate = startingLines.find((l) => l.as_of_date)?.as_of_date || null;
  if (startingBsDate) {
    const preFilterCount = cumulativeRows.length;
    cumulativeRows = cumulativeRows.filter((r) => String(r.txn_date || "") > startingBsDate);
    const excluded = preFilterCount - cumulativeRows.length;
    if (excluded > 0) {
      console.log(
        `[ManualGL][BS][Debug] Excluded ${excluded}/${preFilterCount} GL rows on/before starting BS date ` +
        `(${startingBsDate}) to prevent double-counting of pre-opening activity.`,
      );
    }
  } else if (startingLines.length > 0) {
    console.warn(
      `[ManualGL][BS][Debug] Starting BS lines exist but no as_of_date found â€” ` +
      `cannot filter pre-opening GL rows. Upload a starting BS with a parseable "As of" date ` +
      `to prevent double-counting.`,
    );
  }

  // Log year distribution of cumulative rows
  const cumulativeYearGroups = {};
  cumulativeRows.forEach((r) => {
    const yr = r.fiscal_year || "unknown";
    cumulativeYearGroups[yr] = (cumulativeYearGroups[yr] || 0) + 1;
  });
  console.log(`[ManualGL][BS][Debug] Cumulative rows by year (after pre-BS exclusion):`, JSON.stringify(cumulativeYearGroups));

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
    `[ManualGL][BS][Debug] After reclassification â€” BS transactions: ${bsAccountCount}, P&L transactions: ${plAccountCount}, total: ${normalized.length}`,
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

  // Reconstruct fiscal calendar from batch metadata so the RE carry-forward guard
  // uses the correct fiscal year-end date (calendar-year â†’ month=1, April FY â†’ month=4).
  const batchFiscalCalendar = fiscalCalendarExplicit
    ? { fiscalYearStartMonth: batchMeta.fiscalYearStartMonth, fiscalYearStartDay: batchMeta.fiscalYearStartDay }
    : { fiscalYearStartMonth: 1, fiscalYearStartDay: 1 };

  // STEP 4: Build reconciled Balance Sheet using cumulative transactions.
  const payload = buildBalanceSheetPayload(
    normalized,
    {
      ...normalizedFilters,
      batchId: normalizedFilters.batchId || effectiveBatchId || "",
    },
    pnlPayload.netProfitByYear || {},
    startingLines,
    batchFiscalCalendar,
  );

  console.log(
    `[ManualGL][BS][Debug] Built BS payload â€” internal years: [${(payload.years || []).join(", ")}]`,
    `| displayYear: ${payload.displayYear}`,
    `| assets total: ${payload.sections?.Assets?.totalByYear?.[payload.displayYear] ?? "n/a"}`,
    `| liabilities total: ${payload.sections?.Liabilities?.totalByYear?.[payload.displayYear] ?? "n/a"}`,
    `| equity total: ${payload.sections?.Equity?.totalByYear?.[payload.displayYear] ?? "n/a"}`,
  );

  // Per-year balance equation validation (Assets = Liabilities + Equity).
  // Logged at every BS report call so discrepancies surface in server logs
  // without waiting for a staging re-run.
  if (Array.isArray(payload.audit) && payload.audit.length > 0) {
    console.log("[ManualGL][BS][Validation] === Per-Year Balance Equation Check ===");
    payload.audit.forEach((a) => {
      const diffStr = a.rawVariance !== 0
        ? ` -> RAW VARIANCE: ${a.rawVariance} (force-balanced via RE adjustment)`
        : "";
      const status = a.isBalanced ? "BALANCED [OK]" : "IMBALANCED [X]";
      console.log(
        `[ManualGL][BS][Validation]   Year ${a.year}: ` +
        `Assets=${a.assets}  L+E=${a.liabilitiesAndEquity}  ${status}${diffStr}`,
      );
    });
    const totalImbalanced = payload.audit.filter((a) => !a.isBalanced).length;
    if (totalImbalanced > 0) {
      console.warn(
        `[ManualGL][BS][Validation] *** ${totalImbalanced} year(s) are IMBALANCED - ` +
        `check account classification and opening balance accuracy ***`,
      );
    }
    console.log("[ManualGL][BS][Validation] ========================================");
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

// â”€â”€â”€ BS-Driven Account Classification Engine â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Builds a normalized account-name â†’ BS classification lookup map from
 * one or two parsed balance sheets (starting and/or ending).
 *
 * Normalization: lowercase + strip non-alphanumeric â†’ "accounts receivable"
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
      // e.g. majorGroup="Fixed Assets" but leafCategory="Other Current Assets" â†’ use majorGroup.
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

    // Not in BS â†’ keep existing type intact (preserves correct keyword P&L accounts)
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
 *   - Account in starting OR ending BS â†’ BALANCE_SHEET (type = asset/liability/equity)
 *   - Account NOT in either BS         â†’ PROFIT_LOSS   (type = income/cogs/expense)
 *
 * When no BS is provided (map is empty) the function returns transactions
 * unchanged â€” falling back to the existing keyword-based classification.
 */
function classifyGlTransactionsWithBsLookup(transactions = [], bsLookupMap = new Map()) {
  if (!bsLookupMap || !bsLookupMap.size) {
    console.log(
      "[ManualGL][Classify] No BS lookup map available â€” using keyword-based classification (fallback).",
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

    // â”€â”€ BALANCE SHEET account â”€â”€
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
          `[ManualGL][DistribSection] MATCHED "${tx.accountName}" â†’ section: ${bsEntry.section}, ` +
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

    // â”€â”€ PROFIT & LOSS account â”€â”€
    plClassified++;
    unmatchedByName.add(tx.accountName);

    if (!debuggedAccounts.has(lookupKey)) {
      debuggedAccounts.add(lookupKey);
      console.log(
        `[ManualGL][DistribSection] UNMATCHED "${tx.accountName}" â€” not found in starting or ending balance sheet â†’ classified as P&L`,
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
      "[ManualGL][Classify] Ambiguous accounts (keyword says BS type but NOT in balance sheets â€” treated as P&L Expense):",
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

// â”€â”€â”€ Distribution Account Section Validation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
 *   matched                â€” found in â‰¥1 sheet; logs section + hierarchy path
 *   unmatched              â€” not in either balance sheet
 *   crossYearInconsistencies â€” section differs between starting and ending sheet
 *   conflicts              â€” keyword-inferred type contradicts BS section placement
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
      console.log(`[ManualGL][DistribValidate] UNMATCHED "${accountName}" â€” not present in starting or ending balance sheet`);
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
        `[ManualGL][DistribValidate] CROSS-YEAR INCONSISTENCY "${accountName}" â€” ` +
        `Starting: ${starting.section} (${starting.hierarchyPath}) vs ` +
        `Ending: ${ending.section} (${ending.hierarchyPath})`,
      );
    }

    // Effective classification â€” starting sheet wins
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
        `[ManualGL][DistribValidate] CONFLICT "${accountName}" â€” ` +
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
      `[ManualGL][DistribValidate] MATCHED "${accountName}" â†’ ` +
      `section: ${effective.section}, type: ${effective.accountType}, ` +
      `path: "${effective.hierarchyPath}" [found in: ${foundIn.join(", ")}]`,
    );
  }

  console.log(
    `[ManualGL][DistribValidate] Summary â€” matched: ${matched.length}, ` +
    `unmatched: ${unmatched.length}, crossYearInconsistencies: ${crossYearInconsistencies.length}, ` +
    `conflicts: ${conflicts.length}`,
  );

  return { matched, unmatched, crossYearInconsistencies, conflicts };
}

// â”€â”€â”€ Multi-Year Detection â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
    console.log("[ManualGL][YearDetection] *** MULTI-YEAR GL FILE â€” processing each year independently ***");
  }
  years.forEach((yr) => {
    console.log(`[ManualGL][YearDetection]   ${yr} â†’ ${perYearCounts[yr]} transactions`);
  });
  if (invalidDateCount > 0) {
    console.warn(
      `[ManualGL][YearDetection]   ${invalidDateCount} transactions have no parseable fiscal year and will be excluded from year-grouped reports`,
    );
  }
  console.log("[ManualGL][YearDetection] ==========================================");
}

// â”€â”€â”€ Multi-Year Normalization Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Splits a flat array of parsed transactions into a Map keyed by fiscal year.
 * This is the canonical "normalization" step: a multi-year GL file produces the
 * same per-year datasets as if each year had been uploaded as a separate file.
 *
 * Transactions with no parseable fiscal year are grouped under the key 'unknown'
 * and excluded from all year-specific report logic.
 */
function splitTransactionsByFiscalYear(transactions = []) {
  const yearMap = new Map();

  transactions.forEach((tx) => {
    const yr = Number.isInteger(Number(tx.fiscalYear)) && Number(tx.fiscalYear) > 0
      ? Number(tx.fiscalYear)
      : "unknown";

    if (!yearMap.has(yr)) yearMap.set(yr, []);
    yearMap.get(yr).push(tx);
  });

  return yearMap;
}

/**
 * Computes per-year statistics for a year-split Map.
 * Returns an object mapping year â†’ { count, dateRange, uniqueAccountCount, debitTotal, creditTotal }.
 * Used for staging metadata and per-year audit logging.
 */
function computePerYearStats(yearMap) {
  const stats = {};

  yearMap.forEach((transactions, year) => {
    if (year === "unknown") return;

    const dates = transactions.map((tx) => tx.date).filter(Boolean).sort();
    const accountNames = new Set(transactions.map((tx) => tx.accountName).filter(Boolean));
    const debitTotal = roundMoney(transactions.reduce((s, tx) => s + Number(tx.debit || 0), 0));
    const creditTotal = roundMoney(transactions.reduce((s, tx) => s + Number(tx.credit || 0), 0));

    stats[year] = {
      count: transactions.length,
      dateRange: dates.length > 0 ? { min: dates[0], max: dates[dates.length - 1] } : null,
      uniqueAccountCount: accountNames.size,
      debitTotal,
      creditTotal,
    };
  });

  return stats;
}

function computeUploadedYearSummaries(yearMap, fileHashesByUploadId = new Map()) {
  const summaries = {};

  yearMap.forEach((transactions, year) => {
    const fiscalYear = Number(year);
    if (!Number.isInteger(fiscalYear) || fiscalYear <= 0) return;

    const sourceUploadIds = Array.from(
      new Set(transactions.map((tx) => String(tx.sourceUploadId || "").trim()).filter(Boolean)),
    ).sort();

    const uploadHashes = sourceUploadIds
      .map((uploadId) => fileHashesByUploadId.get(uploadId))
      .filter(Boolean);

    summaries[fiscalYear] = {
      fiscalYear,
      rowCount: transactions.length,
      sourceUploadIds,
      fileHash: buildYearFileHash(uploadHashes),
      dataHash: buildYearDataHash(transactions),
    };
  });

  return summaries;
}

function extractYearsFromBatchMetadata(metadata = {}) {
  if (!metadata || typeof metadata !== "object") return [];

  const years = new Set();
  const directYears = Array.isArray(metadata.yearsDetected) ? metadata.yearsDetected : [];
  directYears.forEach((year) => {
    const parsed = Number(year);
    if (Number.isInteger(parsed) && parsed > 0) {
      years.add(parsed);
    }
  });

  const perYearStats = metadata.perYearStats && typeof metadata.perYearStats === "object"
    ? metadata.perYearStats
    : {};
  Object.keys(perYearStats).forEach((yearKey) => {
    const parsed = Number(yearKey);
    if (Number.isInteger(parsed) && parsed > 0) {
      years.add(parsed);
    }
  });

  return Array.from(years).sort((a, b) => a - b);
}

/**
 * Logs a structured per-year audit table immediately after year-splitting so
 * the server logs carry clear evidence of what each year contains.
 */
function logPerYearSplitAudit(perYearStats, isMultiYear) {
  if (!isMultiYear) return;

  console.log("[ManualGL][YearSplit] ==========================================");
  console.log("[ManualGL][YearSplit] Multi-year GL â€” per-year dataset summary:");
  Object.entries(perYearStats).forEach(([year, stat]) => {
    const range = stat.dateRange ? `${stat.dateRange.min} â†’ ${stat.dateRange.max}` : "no dates";
    console.log(
      `[ManualGL][YearSplit]   FY ${year}: ${stat.count} transactions | ` +
      `${stat.uniqueAccountCount} accounts | ${range} | ` +
      `Dr=${stat.debitTotal} Cr=${stat.creditTotal}`,
    );
  });
  console.log("[ManualGL][YearSplit] Each year will be queried independently via fiscal_year filter.");
  console.log("[ManualGL][YearSplit] ==========================================");
}

function computeDebitCreditConsistency(transactions = []) {
  const perYear = {};
  let totalDebit = 0;
  let totalCredit = 0;

  transactions.forEach((tx) => {
    const fiscalYear = Number(tx.fiscalYear || 0);
    const yearKey = Number.isInteger(fiscalYear) && fiscalYear > 0 ? String(fiscalYear) : "unknown";
    const debit = roundMoney(Number(tx.debit || 0));
    const credit = roundMoney(Number(tx.credit || 0));
    totalDebit = roundMoney(totalDebit + debit);
    totalCredit = roundMoney(totalCredit + credit);

    if (!perYear[yearKey]) {
      perYear[yearKey] = { debit: 0, credit: 0, difference: 0, isBalanced: true };
    }
    perYear[yearKey].debit = roundMoney(perYear[yearKey].debit + debit);
    perYear[yearKey].credit = roundMoney(perYear[yearKey].credit + credit);
  });

  Object.keys(perYear).forEach((yearKey) => {
    const bucket = perYear[yearKey];
    bucket.difference = roundMoney(bucket.credit - bucket.debit);
    bucket.isBalanced = Math.abs(bucket.difference) <= BALANCE_EPSILON;
  });

  const overallDifference = roundMoney(totalCredit - totalDebit);
  return {
    overall: {
      debit: totalDebit,
      credit: totalCredit,
      difference: overallDifference,
      isBalanced: Math.abs(overallDifference) <= BALANCE_EPSILON,
    },
    perYear,
  };
}

function logDebitCreditConsistencyAudit(audit = {}) {
  const overall = audit?.overall || {};
  console.log("[ManualGL][DebitCredit] ==========================================");
  console.log(
    `[ManualGL][DebitCredit] Overall Dr=${overall.debit || 0} Cr=${overall.credit || 0} Diff=${overall.difference || 0} Balanced=${overall.isBalanced ? "YES" : "NO"}`,
  );

  Object.entries(audit?.perYear || {})
    .sort((a, b) => {
      const aNum = Number(a[0]);
      const bNum = Number(b[0]);
      if (!Number.isNaN(aNum) && !Number.isNaN(bNum)) return aNum - bNum;
      return String(a[0]).localeCompare(String(b[0]));
    })
    .forEach(([year, bucket]) => {
      console.log(
        `[ManualGL][DebitCredit] FY ${year}: Dr=${bucket.debit} Cr=${bucket.credit} Diff=${bucket.difference} Balanced=${bucket.isBalanced ? "YES" : "NO"}`,
      );
    });

  console.log("[ManualGL][DebitCredit] ==========================================");
}

async function stageMultiYearGlUpload({
  companyId,
  glUploadIds = [],
  startingBalanceSheetUploadId = "",
  endingBalanceSheetUploadId = "",
  mapping = {},
  fiscalYearStartMonth = null,
  fiscalYearStartDay = null,
  uploadedBy = null,
  batchName = "",
  useDatasetLifecycle = true,
  deferLifecycleFinalization = false,
}) {
  const fiscalCalendar = resolveFiscalCalendarConfig({
    fiscalYearStartMonth,
    fiscalYearStartDay,
  });
  const isFiscalCalendarExplicit =
    (fiscalYearStartMonth !== null && fiscalYearStartMonth !== undefined) ||
    (fiscalYearStartDay !== null && fiscalYearStartDay !== undefined);

  console.log("[ManualGL][MultiYear] === START ===", {
    companyId,
    glUploadIds,
    startingBalanceSheetUploadId,
    endingBalanceSheetUploadId,
    mappingKeys: Object.keys(mapping || {}),
    fiscalYearStartMonth: fiscalCalendar.fiscalYearStartMonth,
    fiscalYearStartDay: fiscalCalendar.fiscalYearStartDay,
    fiscalCalendarExplicit: isFiscalCalendarExplicit,
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
      "[ManualGL][MultiYear] No Starting Balance Sheet provided â€” classification will fall back to keyword inference. " +
      "Provide a Starting Balance Sheet for accurate BS vs P&L bifurcation.",
    );
  }
  if (!endingBalanceSheetUploadId) {
    console.warn(
      "[ManualGL][MultiYear] No Ending Balance Sheet provided â€” classification will fall back to keyword inference. " +
      "Provide an Ending Balance Sheet for accurate BS vs P&L bifurcation.",
    );
  }

  const sourceContext = await loadCompanySourceContext(companyId);
  const sourceSwitchVersion = sourceContext.sourceSwitchVersion || new Date().toISOString();
  const sourceType = sourceContext.sourceType || MANUAL_SOURCE_KEY;
  const uploadSessionId = crypto.randomUUID();
  const stageStartedAt = new Date().toISOString();

  let uploadJob = null;
  let datasetVersion = null;

  let batch = null;
  const effectiveMapping = ensureMappingShape(mapping || {});

  // Fetch target company details for identity validation
  const targetCompany = await supabase
    .from("companies")
    .select("name, legal_name")
    .eq("id", companyId)
    .maybeSingle();
  const targetCompanyName = normalizeKey(targetCompany?.data?.name || "");
  const targetLegalName = normalizeKey(targetCompany?.data?.legal_name || "");

  const parsingWarnings = [];
  const resolvedMappings = {};
  const filesParsed = [];
  const filesRequiringMapping = [];
  const parseAuditByFile = [];
  const fileHashesByUploadId = new Map();
  const preparedFilePayloads = [];
  const parsingTotals = {
    totalRows: 0,
    parsedRows: 0,
    skippedRows: 0,
    duplicateRowsWithinFile: 0,
    skippedByReason: {},
  };

  // Tracks parsed BS data so we can insert lines after GL classification
  const balanceSheetInfo = {
    startingParsed: null,
    endingParsed: null,
    startingUpload: null,
    endingUpload: null,
    inserted: { starting: 0, ending: 0 },
  };

  try {
    // â”€â”€ PHASE 1: Parse Balance Sheets FIRST â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // We must know BS accounts before classifying GL transactions, so BS files
    // are parsed here (not inserted yet â€” that happens after GL classification).

    if (startingBalanceSheetUploadId) {
      console.log(
        "[ManualGL][MultiYear] Phase 1 â€“ Parsing STARTING balance sheet:",
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
            "[ManualGL][MultiYear] Starting BS parsed â€” assets:",
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
        "[ManualGL][MultiYear] Phase 1 â€“ Parsing ENDING balance sheet:",
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
            "[ManualGL][MultiYear] Ending BS parsed â€” assets:",
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

    // â”€â”€ PHASE 2: Build BS account lookup map â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Maps normalised account name â†’ { accountType, section, majorGroup, minorGroup, leafCategory, hierarchyPath }.
    // Empty map means no BS was provided â†’ fall back to keyword classification.

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
      `[ManualGL][MultiYear] Phase 2 â€“ BS lookup map: ${bsLookupMap.size} accounts (${hasBsLookup ? "data-driven classification" : "keyword-based fallback"})`,
    );

    // â”€â”€ PHASE 3: Parse GL files, classify, then insert â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
        fileHashesByUploadId.set(
          uploadId,
          crypto.createHash("sha256").update(normalizeUploadBinary(upload.data)).digest("hex"),
        );
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
        const fileParseAudit = {
          uploadId,
          fileName: upload.file_name || upload.id,
          sheetCount: selectedSheets.length,
          totalRows: 0,
          parsedRows: 0,
          skippedRows: 0,
          skippedByReason: {},
          sheets: [],
        };

        for (const sheetData of selectedSheets) {
          const parsed = parseGlSheetTransactions({
            companyId,
            upload,
            sheetData,
            mapping: effectiveMapping,
            fiscalYearHint: fileYearHint,
            fiscalCalendar,
          });

          if (!parsed.success) continue;

          // STRICT COMPANY IDENTITY VALIDATION
          const detectedName = normalizeKey(detectCompanyInGl(sheetData));
          if (detectedName && targetCompanyName) {
            // Check against both trade name and legal name
            const isMatch =
              detectedName === targetCompanyName ||
              detectedName === targetLegalName ||
              targetCompanyName.includes(detectedName) ||
              targetLegalName.includes(detectedName) ||
              detectedName.includes(targetCompanyName) ||
              detectedName.includes(targetLegalName);

            if (!isMatch) {
              console.error(
                `[ManualGL][Identity] REJECTED: Uploaded file "${upload.file_name}" metadata "${detectedName}" does not match company "${targetCompany?.data?.name}".`,
              );
              throw new Error(
                `The uploaded GL file (${upload.file_name}) appears to belong to another company ("${detectedName}"). Please ensure you are uploading data for your active company.`,
              );
            }
          }

          fileParsedAtLeastOne = true;
          resolvedMappings[uploadId] = parsed.mapping;
          rawFileTransactions.push(...parsed.transactions);
          const sheetStats = parsed.stats || {};
          fileParseAudit.totalRows += Number(sheetStats.totalRows || 0);
          fileParseAudit.parsedRows += Number(sheetStats.parsedRows || 0);
          fileParseAudit.skippedRows += Number(sheetStats.skippedRows || 0);
          Object.entries(sheetStats.skippedByReason || {}).forEach(([reason, count]) => {
            fileParseAudit.skippedByReason[reason] =
              (fileParseAudit.skippedByReason[reason] || 0) + Number(count || 0);
          });
          fileParseAudit.sheets.push(sheetStats);
          parsingWarnings.push(
            ...parsed.warnings.map((w) => ({ ...w, uploadId, fileName: upload.file_name })),
          );
        }

        parseAuditByFile.push(fileParseAudit);
        parsingTotals.totalRows += fileParseAudit.totalRows;
        parsingTotals.parsedRows += fileParseAudit.parsedRows;
        parsingTotals.skippedRows += fileParseAudit.skippedRows;
        Object.entries(fileParseAudit.skippedByReason).forEach(([reason, count]) => {
          parsingTotals.skippedByReason[reason] =
            (parsingTotals.skippedByReason[reason] || 0) + Number(count || 0);
        });

        if (!fileParsedAtLeastOne || rawFileTransactions.length === 0) {
          filesRequiringMapping.push({ uploadId, fileName: upload.file_name });
          console.warn(
            `[ManualGL][MultiYear] File "${upload.file_name}" produced no parseable GL transactions.`,
            fileParseAudit,
          );
          continue;
        }

        console.log(
          `[ManualGL][ParseAudit] ${upload.file_name}: totalRows=${fileParseAudit.totalRows}, parsed=${fileParseAudit.parsedRows}, skipped=${fileParseAudit.skippedRows}`,
        );

        const calendarYearsInFile = Array.from(
          new Set(
            rawFileTransactions
              .map((tx) => (String(tx.date || "").slice(0, 4)))
              .map((year) => Number(year))
              .filter((year) => Number.isInteger(year) && year > 0),
          ),
        ).sort((a, b) => a - b);
        // Only switch to fiscal-year labelling when the caller explicitly
        // provided a non-default fiscal calendar.  Auto-switching when the GL
        // spans >1 calendar year caused the April default (month 4) to silently
        // offset ALL year labels by +1, splitting calendar-year 2023 data
        // across "FY2023" and "FY2024" buckets and producing wrong totals.
        const useFiscalYearModeForFile = isFiscalCalendarExplicit;
        rawFileTransactions = assignFiscalYearAndRefreshHash(rawFileTransactions, {
          companyId,
          fiscalCalendar,
          useFiscalYearMode: useFiscalYearModeForFile,
        });

        const uniqueWithinFile = new Map();
        let duplicateRowsWithinFile = 0;
        rawFileTransactions.forEach((tx) => {
          const hash = String(tx.transactionHash || "");
          if (!hash) return;
          if (uniqueWithinFile.has(hash)) {
            duplicateRowsWithinFile += 1;
            return;
          }
          uniqueWithinFile.set(hash, tx);
        });
        rawFileTransactions = Array.from(uniqueWithinFile.values());

        fileParseAudit.calendarYearsDetected = calendarYearsInFile;
        fileParseAudit.fiscalYearMode = useFiscalYearModeForFile ? "fiscal" : "calendar";
        fileParseAudit.duplicateRowsWithinFile = duplicateRowsWithinFile;
        parsingTotals.duplicateRowsWithinFile += duplicateRowsWithinFile;
        console.log(
          `[ManualGL][YearMode] ${upload.file_name}: mode=${fileParseAudit.fiscalYearMode} | calendarYears=[${calendarYearsInFile.join(", ")}] | duplicateRowsWithinFile=${duplicateRowsWithinFile}`,
        );

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
        preparedFilePayloads.push({
          uploadId,
          fileName: upload.file_name,
          transactions: dedupedTransactions,
        });

        filesParsed.push(upload.file_name);
        console.log(
          `[ManualGL][MultiYear] Prepared ${dedupedTransactions.length} classified rows from "${upload.file_name}" ` +
          `(cross-file duplicates skipped: ${fileCrossFileDuplicates})`,
        );
      } catch (fileErr) {
        console.error(`[ManualGL][MultiYear] Error processing GL file ${uploadId}:`, fileErr);
      }
    }

    console.log(
      `[ManualGL][ParseAudit] Totals: rows=${parsingTotals.totalRows}, parsed=${parsingTotals.parsedRows}, skipped=${parsingTotals.skippedRows}, duplicateRowsWithinFile=${parsingTotals.duplicateRowsWithinFile}`,
    );
    if (Object.keys(parsingTotals.skippedByReason || {}).length > 0) {
      console.log(
        "[ManualGL][ParseAudit] Skipped by reason:",
        JSON.stringify(parsingTotals.skippedByReason, null, 2),
      );
    }

    if (preparedFilePayloads.length === 0 && filesRequiringMapping.length > 0) {
      const firstFail = filesRequiringMapping[0];
      return {
        success: false,
        requiresManualMapping: true,
        failedUploadId: firstFail.uploadId,
        fileName: firstFail.fileName,
        error: "Mapping required for one or more files.",
      };
    }

    if (allClassifiedTransactions.length === 0) {
      throw new Error("No valid GL transactions were parsed from the selected files.");
    }


    // â”€â”€ PHASE 3a: Multi-year detection + explicit year-split normalization â”€â”€â”€â”€â”€â”€
    // Inspect every classified transaction to determine whether this upload
    // spans a single year or multiple years. The result is logged immediately
    // for debugging, and stored in batch metadata so callers can surface the
    // file type to the UI without re-scanning transactions.
    //
    // NORMALIZATION: We explicitly split the flat transaction array into a
    // per-year Map so each year's dataset is isolated. A multi-year GL file
    // therefore produces the same per-year datasets as uploading each year
    // as a separate file â€” the fiscal_year column on every staged transaction
    // is the canonical isolation boundary for all downstream queries.
    const yearDetection = detectMultipleYears(allClassifiedTransactions);
    logYearDetectionAudit(yearDetection);

    const yearSplitMap = splitTransactionsByFiscalYear(allClassifiedTransactions);
    const perYearStats = computePerYearStats(yearSplitMap);
    logPerYearSplitAudit(perYearStats, yearDetection.isMultiYear);
    const debitCreditAudit = computeDebitCreditConsistency(allClassifiedTransactions);
    logDebitCreditConsistencyAudit(debitCreditAudit);
    const uploadedYearSummaries = computeUploadedYearSummaries(yearSplitMap, fileHashesByUploadId);
    const uploadedYears = Object.keys(uploadedYearSummaries)
      .map((year) => Number(year))
      .filter((year) => Number.isInteger(year) && year > 0)
      .sort((a, b) => a - b);

    let activeBatch = await getActiveUploadBatch(companyId);
    const activeSessionMap = await getActiveUploadSessionMap(companyId);
    const activeBatchMetadata = activeBatch?.id ? await loadBatchMetadata(activeBatch.id) : {};
    let activeYearSummaries =
      activeBatchMetadata?.uploadedYearSummaries && typeof activeBatchMetadata.uploadedYearSummaries === "object"
        ? activeBatchMetadata.uploadedYearSummaries
        : {};

    if (activeBatch?.id && Object.keys(activeYearSummaries).length === 0) {
      activeYearSummaries = await computeBatchYearSummaries(companyId, activeBatch.id);
    }

    const metadataYears = extractYearsFromBatchMetadata(activeBatchMetadata);
    const activeYears = (
      activeSessionMap.size > 0
        ? Array.from(activeSessionMap.keys())
        : metadataYears.length > 0
          ? metadataYears
          : Object.keys(activeYearSummaries).map((year) => Number(year))
    )
      .filter((year) => Number.isInteger(Number(year)) && Number(year) > 0)
      .map(Number)
      .sort((a, b) => a - b);

    const uploadedYearHashPairs = uploadedYears
      .map((fiscalYear) => ({
        fiscalYear,
        dataHash: uploadedYearSummaries?.[fiscalYear]?.dataHash || "",
      }))
      .filter((item) => Number.isInteger(item.fiscalYear) && item.fiscalYear > 0 && item.dataHash);

    // DETERMINISTIC DATASET HASHING & DUPLICATE PREVENTION
    const datasetHash = buildDatasetHash(allClassifiedTransactions);
    console.log(`[ManualGL][MultiYear] Generated dataset hash: ${datasetHash}`);
    console.log(
      "[ManualGL][MultiYear] Generated year hashes:",
      uploadedYearHashPairs.map((item) => `${item.fiscalYear}:${item.dataHash.slice(0, 12)}`).join(", "),
    );
    const fiscalYearStart = uploadedYears.length > 0 ? uploadedYears[0] : null;
    const fiscalYearEnd = uploadedYears.length > 0 ? uploadedYears[uploadedYears.length - 1] : null;

    // Duplicate detection MUST run before any DB writes.
    const collisionCheck = await checkExistingStagedFiscalYears(
      companyId,
      uploadedYears,
      uploadedYearHashPairs,
    );
    const exactDuplicateYearSet = new Set(
      Array.isArray(collisionCheck?.duplicateYears) ? collisionCheck.duplicateYears.map(Number) : [],
    );

    const stagedYears = [];
    const versionPlan = [];

    for (const fiscalYear of uploadedYears) {
      if (exactDuplicateYearSet.has(fiscalYear)) {
        continue;
      }

      const uploadedSummary = uploadedYearSummaries[fiscalYear];
      const activeSession = activeSessionMap.get(fiscalYear) || null;
      const fallbackActiveSummary = activeYearSummaries?.[fiscalYear] || null;
      const activeDataHash = String(
        activeSession?.data_hash ||
        activeSession?.dataHash ||
        fallbackActiveSummary?.data_hash ||
        fallbackActiveSummary?.dataHash ||
        "",
      ).trim();

      if (activeDataHash && uploadedSummary.dataHash === activeDataHash) {
        exactDuplicateYearSet.add(fiscalYear);
        continue;
      }

      let nextVersionNo = null;
      if (Number.isInteger(Number(activeSession?.version_no)) && Number(activeSession.version_no) > 0) {
        nextVersionNo = Number(activeSession.version_no) + 1;
      } else {
        const latestStoredVersion = await getLatestUploadSessionVersion(companyId, fiscalYear);
        if (latestStoredVersion) {
          nextVersionNo = latestStoredVersion + 1;
        } else if (fallbackActiveSummary) {
          nextVersionNo = 2;
        } else {
          nextVersionNo = 1;
        }
      }

      stagedYears.push(fiscalYear);
      versionPlan.push({
        fiscalYear,
        versionNo: nextVersionNo,
        rowCount: uploadedSummary.rowCount,
        fileHash: uploadedSummary.fileHash,
        dataHash: uploadedSummary.dataHash,
        sourceUploadIds: uploadedSummary.sourceUploadIds,
        metadata: {
          previousActiveSessionId: activeSession?.id || null,
          previousActiveBatchId: activeBatch?.id || null,
        },
      });

      console.log(
        `[ManualGL][VersionPlan] fiscalYear=${fiscalYear} versionNo=${nextVersionNo} ` +
        `rowCount=${uploadedSummary.rowCount} dataHash=${String(uploadedSummary.dataHash || "").slice(0, 12)}...`,
      );
    }

    const exactDuplicateYears = Array.from(exactDuplicateYearSet).sort((a, b) => a - b);

    if (stagedYears.length === 0 && exactDuplicateYears.length > 0) {
      return {
        success: false,
        blockedAsDuplicate: true,
        noChangesDetected: true,
        duplicateFiscalYears: exactDuplicateYears,
        duplicateYears: exactDuplicateYears,
        existingVersion: collisionCheck?.existingVersion || null,
        activeBatchId: collisionCheck?.activeBatchId || null,
        message: "The selected GL data is already staged for this company and fiscal year.",
      };
    }

    const carryForwardYears = activeYears.filter((year) => !stagedYears.includes(year));

    console.log("[ManualGL][VersionPlan]", {
      uploadedYears,
      stagedYears,
      exactDuplicateYears,
      carryForwardYears,
      activeBatchId: activeBatch?.id || null,
    });

    if (useDatasetLifecycle) {
      console.log("[ManualGL][MultiYear] Starting upload lifecycle...");
      const lifecycle = await startUploadLifecycle(
        companyId,
        batchName || "Multi-Year GL Upload",
        uploadedBy,
      );
      uploadJob = lifecycle.job || null;
      datasetVersion = lifecycle.version || null;
    }

    console.log("[ManualGL][MultiYear] Creating batch...");
    batch = await createBatch({
      companyId,
      createdBy: uploadedBy,
      batchName,
      datasetVersionId: datasetVersion?.id || null,
      sourceType,
      sourceSwitchVersion,
      uploadSessionId,
      datasetHash,
      fiscalYearStart,
      fiscalYearEnd,
    });
    console.log("[ManualGL][MultiYear] Batch created:", batch.id);

    for (const prepared of preparedFilePayloads) {
      const yearScopedTransactions = prepared.transactions.filter((tx) =>
        stagedYears.includes(Number(tx.fiscalYear || 0)),
      );

      if (!yearScopedTransactions.length) continue;

      const insertStats = await insertTransactions({
        companyId,
        batchId: batch.id,
        transactions: yearScopedTransactions,
        datasetVersionId: datasetVersion?.id || null,
        sourceType,
        sourceSwitchVersion,
        uploadSessionId,
      });

      totalInserted += insertStats.inserted;
      totalDuplicates += insertStats.duplicates || 0;

      Object.entries(insertStats.yearGroups || {}).forEach(([year, count]) => {
        combinedYearGroups[year] = (combinedYearGroups[year] || 0) + count;
      });
    }

    if (activeBatch?.id && carryForwardYears.length > 0) {
      const carryForwardStats = await copyBatchTransactionsForYears({
        companyId,
        sourceBatchId: activeBatch.id,
        targetBatchId: batch.id,
        fiscalYears: carryForwardYears,
        datasetVersionId: datasetVersion?.id || null,
        sourceType,
        sourceSwitchVersion,
        uploadSessionId,
      });

      totalInserted += carryForwardStats.inserted;
      Object.entries(carryForwardStats.yearGroups || {}).forEach(([year, count]) => {
        combinedYearGroups[year] = (combinedYearGroups[year] || 0) + count;
      });
    }

    console.log(
      `[ManualGL][MultiYear] Phase 3 persisted ${totalInserted} rows across years ` +
      `[${[...stagedYears, ...carryForwardYears].sort((a, b) => a - b).join(", ")}].`,
    );

    // Per-year P&L validation â€” runs calculateProfitLossBuckets on each year's
    // isolated transactions to confirm the split produces self-consistent numbers.
    if (yearDetection.isMultiYear) {
      console.log("[ManualGL][YearSplit] Running per-year P&L validation...");
      yearSplitMap.forEach((yearTxns, year) => {
        if (year === "unknown") return;
        const normalized = yearTxns.map(normalizeStagedTransactionRow).filter(Boolean);
        const { yearlyRows } = calculateProfitLossBuckets(normalized);
        const row = yearlyRows.find((r) => r.fiscalYear === year);
        if (row) {
          console.log(
            `[ManualGL][YearSplit][FY${year}] Revenue=${row.Revenue} COGS=${row.COGS}` +
            ` OpEx=${row["Operating Expenses"]} OtherEx=${row["Other Expenses"]}` +
            ` GrossProfit=${row["Gross Profit"]} NetProfit=${row["Net Profit"]}`,
          );
        }
      });
    }

    // â”€â”€ PHASE 3b: Validate distribution account section classifications â”€â”€â”€â”€â”€â”€â”€
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
      `[ManualGL][MultiYear] Phase 3b â€“ validating ${uniqueGlAccounts.length} unique distribution accounts against balance sheet hierarchy...`,
    );
    const distributionValidation = validateDistributionAccountSections(uniqueGlAccounts, detailedSectionMap);

    // â”€â”€ PHASE 4: Insert Balance Sheet lines â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Now that GL is stored, persist the BS line data we parsed in Phase 1.

    const finalYears = Array.from(new Set([...stagedYears, ...carryForwardYears])).sort((a, b) => a - b);
    const earliestFinalYear = finalYears.length ? finalYears[0] : null;
    const latestFinalYear = finalYears.length ? finalYears[finalYears.length - 1] : null;
    const earliestUploadedYear = stagedYears.length ? Math.min(...stagedYears) : null;
    const latestUploadedYear = stagedYears.length ? Math.max(...stagedYears) : null;
    const shouldUseUploadedStarting =
      balanceSheetInfo.startingParsed &&
      balanceSheetInfo.startingUpload &&
      earliestUploadedYear !== null &&
      earliestUploadedYear === earliestFinalYear;
    const shouldUseUploadedEnding =
      balanceSheetInfo.endingParsed &&
      balanceSheetInfo.endingUpload &&
      latestUploadedYear !== null &&
      latestUploadedYear === latestFinalYear;

    if (shouldUseUploadedStarting) {
      const lines = toBalanceSheetLineRows({
        companyId,
        batchId: batch.id,
        upload: balanceSheetInfo.startingUpload,
        sheetType: SHEET_TYPE.STARTING,
        parsed: balanceSheetInfo.startingParsed,
        datasetVersionId: datasetVersion?.id || null,
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
        `[ManualGL][MultiYear] Phase 4 â€“ STARTING BS lines inserted: ${result.inserted}`,
      );
    }

    if (!shouldUseUploadedStarting && activeBatch?.id) {
      const result = await copyBalanceSheetLinesFromBatch({
        companyId,
        sourceBatchId: activeBatch.id,
        targetBatchId: batch.id,
        sheetType: SHEET_TYPE.STARTING,
        datasetVersionId: datasetVersion?.id || null,
        sourceType,
        sourceSwitchVersion,
        uploadSessionId,
      });
      balanceSheetInfo.inserted.starting = result.inserted;
    }

    if (shouldUseUploadedEnding) {
      const lines = toBalanceSheetLineRows({
        companyId,
        batchId: batch.id,
        upload: balanceSheetInfo.endingUpload,
        sheetType: SHEET_TYPE.ENDING,
        parsed: balanceSheetInfo.endingParsed,
        datasetVersionId: datasetVersion?.id || null,
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
        `[ManualGL][MultiYear] Phase 4 â€“ ENDING BS lines inserted: ${result.inserted}`,
      );
    }

    // â”€â”€ PHASE 5: Summary, validation, batch update â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    if (!shouldUseUploadedEnding && activeBatch?.id) {
      const result = await copyBalanceSheetLinesFromBatch({
        companyId,
        sourceBatchId: activeBatch.id,
        targetBatchId: batch.id,
        sheetType: SHEET_TYPE.ENDING,
        datasetVersionId: datasetVersion?.id || null,
        sourceType,
        sourceSwitchVersion,
        uploadSessionId,
      });
      balanceSheetInfo.inserted.ending = result.inserted;
    }

    const stagedForBatch = await getStageTransactions(companyId, {
      batchId: batch.id,
      includeArchived: true,
      versionMode: REPORT_BATCH_MODE.HISTORICAL,
      limit: DEFAULT_STAGING_LIMIT,
    });
    const normalizedTransactions = (Array.isArray(stagedForBatch?.rows) ? stagedForBatch.rows : [])
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
      `[ManualGL][MultiYear] Classification audit â€” BS transactions: ${bsAccounts}, P&L transactions: ${plAccounts}, total: ${normalizedTransactions.length}`,
    );

    let validation = null;
    if (balanceSheetInfo.startingParsed || balanceSheetInfo.endingParsed || activeBatch?.id) {
      // Both reads are independent â€” run in parallel instead of sequentially.
      const [startingLines, endingLines] = await Promise.all([
        loadBatchBalanceSheetLines(companyId, batch.id, SHEET_TYPE.STARTING),
        loadBatchBalanceSheetLines(companyId, batch.id, SHEET_TYPE.ENDING),
      ]);
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
      batch_status: "staged",
      is_archived: false,
      processing_completed_at: new Date().toISOString(),
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
        parsingTotals,
        parseAuditByFile,
        classificationMode: hasBsLookup ? "bs_driven" : "keyword_fallback",
        bsLookupAccountCount: bsLookupMap.size,
        fiscalCalendar,
        fiscalCalendarExplicit: isFiscalCalendarExplicit,
        // Multi-year detection + explicit year-split results (from Phase 3a)
        fileType: yearDetection.fileType,
        isMultiYearUpload: yearDetection.isMultiYear,
        yearsDetected: yearDetection.years,
        stagedFiscalYears: stagedYears,
        carryForwardFiscalYears: carryForwardYears,
        skippedDuplicateFiscalYears: exactDuplicateYears,
        perYearTransactionCounts: yearDetection.perYearCounts,
        invalidDateTransactionCount: yearDetection.invalidDateCount,
        // Per-year stats from the normalization split â€” mirrors what would be
        // produced by uploading each year as a separate single-year GL file.
        perYearStats,
        uploadedYearSummaries,
        uploadSessionVersionPlan: versionPlan,
        debitCreditAudit,
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
          fiscalCalendar,
          fiscalCalendarExplicit: isFiscalCalendarExplicit,
          stagedFiscalYears: stagedYears,
          carryForwardFiscalYears: carryForwardYears,
          skippedDuplicateFiscalYears: exactDuplicateYears,
        },
      });
    } catch (syncError) {
      console.warn("[ManualGL][MultiYear] Failed to refresh report source:", syncError.message);
    }

    if (useDatasetLifecycle && !deferLifecycleFinalization && uploadJob?.id && datasetVersion?.id) {
      console.log("[ManualGL][MultiYear] Finalizing upload lifecycle...");
      await finalizeUploadLifecycle(uploadJob.id, datasetVersion.id, companyId, batch.id);
    }

    return {
      success: true,
      batchId: batch.id,
      uploadJobId: uploadJob?.id || null,
      datasetVersionId: datasetVersion?.id || null,
      insertedTransactions: totalInserted,
      yearGroups: combinedYearGroups,
      duplicateTransactionsSkipped: totalDuplicates,
      crossFileDuplicateTransactionsSkipped: totalCrossFileDuplicates,
      duplicateRowsWithinFile: parsingTotals.duplicateRowsWithinFile || 0,
      warnings: parsingWarnings.slice(0, 500),
      parsingTotals,
      parseAuditByFile,
      fiscalCalendar,
      fiscalCalendarExplicit: isFiscalCalendarExplicit,
      mapping: effectiveMapping,
      filesParsed,
      validation,
      yearsDetected: yearDetection.years,
      stagedFiscalYears: stagedYears,
      carryForwardFiscalYears: carryForwardYears,
      skippedDuplicateFiscalYears: exactDuplicateYears,
      fileType: yearDetection.fileType,
      isMultiYearUpload: yearDetection.isMultiYear,
      perYearTransactionCounts: yearDetection.perYearCounts,
      perYearStats,
      uploadedYearSummaries,
      uploadSessionVersionPlan: versionPlan,
      debitCreditAudit,
      classificationMode: hasBsLookup ? "bs_driven" : "keyword_fallback",
    };
  } catch (error) {
    console.error("[ManualGL][MultiYear] === FAILED ===", error.message, error.stack);
    try {
      if (useDatasetLifecycle && typeof failUploadLifecycle === "function") {
        await failUploadLifecycle(uploadJob?.id, datasetVersion?.id, error.message);
      }
    } catch (lifecycleErr) {
      console.error("[ManualGL][MultiYear] Failed to fail upload lifecycle:", lifecycleErr);
    }
    try {
      const batchId = batch?.id || null;
      const [txCleanup, bsCleanup] = batchId
        ? await Promise.all([
          supabase
            .from(TABLES.transactions)
            .delete()
            .eq("company_id", companyId)
            .eq("batch_id", batchId),
          supabase
            .from(TABLES.balanceSheetLines)
            .delete()
            .eq("company_id", companyId)
            .eq("batch_id", batchId),
        ])
        : [{ error: null }, { error: null }];

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
      if (batch?.id) {
        await updateBatch(batch.id, {
          status: "failed",
          batch_status: "failed",
          is_archived: true,
          processing_completed_at: new Date().toISOString(),
          metadata: { error: error.message, rolledBack: true },
        });
      }
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
 * only expose data for the year(s) the user actually requested â€” otherwise the
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
      `[ManualGL][YearRestrict] No payload years match selectedYears ${JSON.stringify(selectedYears)} â€” returning unrestricted payload.`,
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
    `[ManualGL][YearRestrict] BS response years restricted from [${(payload.years || []).join(", ")}] â†’ [${filteredYears.join(", ")}]`,
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

  // Build a "year-zero" anchor for each BS category: the opening balance from the
  // starting balance sheet (openingBalance is baked into balancesByYear[firstYear]
  // already, so for the first year the prior-year proxy is openingBalance, not 0).
  // Without this anchor the first year's movement would equal the full cumulative
  // balance (openingBalance + activity) instead of just the GL activity.
  const categoryOpeningBalance = {};
  ["Assets", "Liabilities", "Equity"].forEach((sKey) => {
    const sectionData = bs.sections?.[sKey];
    if (!sectionData) return;
    (sectionData.categories || []).forEach((cat) => {
      const label = cat.label || "";
      if (allBsYears.length === 0) return;
      const firstYear = allBsYears[0];
      // Opening balance = what the category held BEFORE the first GL year.
      // For every account in the category: openingBalance is reflected in
      // balancesByYear[firstYear] as (openingBalance + firstYearActivity).
      // We derive it by summing per-account openingBalance from the accounts array.
      // If accounts expose activityByYear we can subtract it; otherwise approximate
      // by assuming the category total at firstYear includes the opening.
      const firstYearTotal = roundMoney(Number(cat.totalByYear?.[firstYear] || 0));
      const firstYearActivity = roundMoney(
        (cat.accounts || []).reduce(
          (sum, acc) => sum + roundMoney(Number(acc.activityByYear?.[firstYear] || 0)),
          0,
        ),
      );
      categoryOpeningBalance[label] = roundMoney(firstYearTotal - firstYearActivity);
    });
  });

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
  // For assets:  an increase is a cash OUTFLOW â†’ negative to cash flow.
  // For liabilities/equity: an increase is a cash INFLOW â†’ positive to cash flow.
  const bsCategories = [];
  ["Assets", "Liabilities", "Equity"].forEach((sKey) => {
    const sectionData = bs.sections?.[sKey];
    if (!sectionData) return;
    (sectionData.categories || []).forEach((cat) => bsCategories.push({ ...cat, sectionType: sKey }));
  });

  // Collect bank/cash balances across ALL BS years (for beginning/ending cash).
  const cashBalanceByYear = {};

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

    // Cash/bank accounts are the result â€” collect their balances, then skip movements.
    if (label.includes("bank account") || label === "cash") {
      allBsYears.forEach((y) => {
        cashBalanceByYear[y] = roundMoney(
          (cashBalanceByYear[y] || 0) + Number(cat.totalByYear?.[y] || 0),
        );
      });
      return;
    }

    const sign = cat.sectionType === "Assets" ? -1 : 1;
    const yearMovements = {};

    selectedYears.forEach((year) => {
      // Find the prior year from the FULL allBsYears list so the delta is correct
      // even when the user selects only a subset of years.
      const priorYearIdx = allBsYears.indexOf(year) - 1;
      const priorYear = priorYearIdx >= 0 ? allBsYears[priorYearIdx] : null;

      const current = roundMoney(Number(cat.totalByYear?.[year] || 0));
      // For the first GL year there is no prior DB row, so use the opening balance
      // derived from the starting balance sheet as the anchor â€” prevents the full
      // cumulative balance (openingBalance + activity) from appearing as the movement.
      const prior = priorYear != null
        ? roundMoney(Number(cat.totalByYear?.[priorYear] || 0))
        : roundMoney(categoryOpeningBalance[cat.label] || 0);
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

  // Build frontend-ready hierarchicalRows for CashflowSummary component.
  // yearCols uses String keys to match amounts map keys in the component.
  const yearCols = selectedYears.map((y) => ({ key: String(y), label: `FY ${y}` }));

  const buildAmounts = (valuesByYear) => {
    const amounts = {};
    selectedYears.forEach((y) => { amounts[String(y)] = valuesByYear[y] || 0; });
    return amounts;
  };

  const SECTION_KEYS = ["Operating", "Investing", "Financing"];
  const SECTION_TOTAL_LABELS = {
    Operating: "Net Cash from Operating Activities",
    Investing: "Net Cash from Investing Activities",
    Financing: "Net Cash from Financing Activities",
  };

  const hierarchicalRows = [];

  SECTION_KEYS.forEach((sKey) => {
    const sec = sections[sKey];
    if (!sec) return;

    const children = [];

    if (sKey === "Operating") {
      children.push({
        id: "net-income",
        name: "Net Income",
        amounts: buildAmounts(pnl.netProfitByYear || {}),
      });
    }

    sec.items.forEach((item, idx) => {
      const hasValue = selectedYears.some((y) => (item.yearMovements?.[y] || 0) !== 0);
      if (!hasValue) return;
      children.push({
        id: `${sKey.toLowerCase()}-item-${idx}`,
        name: item.label,
        amounts: buildAmounts(item.yearMovements || {}),
      });
    });

    const headerAmounts = buildAmounts(sec.totalByYear);

    hierarchicalRows.push({
      id: `${sKey.toLowerCase()}-header`,
      name: sec.label,
      type: "header",
      amounts: headerAmounts,
      children,
    });

    hierarchicalRows.push({
      id: `${sKey.toLowerCase()}-total`,
      name: SECTION_TOTAL_LABELS[sKey],
      type: "total",
      amounts: headerAmounts,
    });
  });

  hierarchicalRows.push({
    id: "net-cash-change",
    name: "Net Change in Cash",
    type: "total",
    amounts: buildAmounts(netCashChange),
  });

  const beginningCashAmounts = {};
  const endingCashAmounts = {};
  selectedYears.forEach((year) => {
    const priorYearIdx = allBsYears.indexOf(year) - 1;
    const priorYear = priorYearIdx >= 0 ? allBsYears[priorYearIdx] : null;
    beginningCashAmounts[String(year)] = priorYear != null ? (cashBalanceByYear[priorYear] || 0) : 0;
    endingCashAmounts[String(year)] = cashBalanceByYear[year] || 0;
  });

  hierarchicalRows.push({ id: "beginning-cash", name: "Beginning Cash", amounts: beginningCashAmounts });
  hierarchicalRows.push({ id: "ending-cash", name: "Ending Cash", type: "total", amounts: endingCashAmounts });

  console.log(
    `[ManualGL][Cashflow][Debug] years: [${selectedYears.join(", ")}]`,
    `| netCashChange: ${JSON.stringify(netCashChange)}`,
    `| hierarchicalRows count: ${hierarchicalRows.length}`,
  );

  return {
    source: "manual_gl_staged_transactions",
    reportType: "cash_flow",
    filters,
    years: selectedYears,
    sections,
    netCashChange,
    hierarchicalRows,
    yearCols,
    beginningCash: beginningCashAmounts,
    endingCash: endingCashAmounts,
  };
}

async function getProfitLossSummaryFromStage(companyId, filters = {}) {
  // For calendar-year batches (fiscalCalendarExplicit = false), the DB fiscal_year column
  // may hold wrong April-offset labels (BUG2). We bypass the fiscal_year DB filter and
  // instead fetch by date range, then correct + filter in memory.
  const preFilters = parseManualFilterQuery(filters);
  const preBatchId = preFilters.batchId ||
    (await resolveReportBatchId(companyId));
  const batchMeta = await loadBatchMetadata(preBatchId);
  const fiscalCalendarExplicit = batchMeta.fiscalCalendarExplicit === true;

  const selectedYearsForBypass = preFilters.fiscalYears || [];
  let queryFilters = { ...filters, batchId: preBatchId || filters.batchId || "" };

  if (!fiscalCalendarExplicit && selectedYearsForBypass.length) {
    // Convert year filter to date-range so the query fetches by txn_date instead of fiscal_year.
    const minYear = Math.min(...selectedYearsForBypass);
    const maxYearPl = Math.max(...selectedYearsForBypass);
    queryFilters = {
      ...queryFilters,
      fiscalYears: [],
      fiscalYear: null,
      startDate: `${minYear}-01-01`,
      endDate: `${maxYearPl}-12-31`,
    };
    console.log(
      `[ManualGL][PL][Debug] BUG2-bypass: converted fiscalYears ${JSON.stringify(selectedYearsForBypass)} ` +
      `â†’ date range ${minYear}-01-01 to ${maxYearPl}-12-31`,
    );
  }

  const { filters: normalizedFilters, rows: rawRows } = await queryStagedTransactions(companyId, queryFilters);
  const correctedRows = fiscalCalendarExplicit ? rawRows : applyCalendarYearCorrection(rawRows);

  // After correction, filter by selected years in memory (preserves correct rows only).
  const selectedYears = preFilters.fiscalYears || [];
  const filteredRows = (!fiscalCalendarExplicit && selectedYears.length)
    ? correctedRows.filter((r) => selectedYears.includes(Number(r.fiscal_year || 0)))
    : correctedRows;

  let normalized = filteredRows.map(normalizeStagedTransactionRow).filter(Boolean);

  const effectiveBatchId = normalizedFilters.batchId || preBatchId || "";
  console.log(
    `[ManualGL][PL][Debug] === P&L Summary Report ===`,
    `| selectedYears: ${JSON.stringify(selectedYears)}`,
    `| total transactions after year filter: ${normalized.length}`,
    `| batchId: ${effectiveBatchId}`,
    `| fiscalCalendarExplicit: ${fiscalCalendarExplicit}`,
  );

  // Re-classify using BS lines from DB so reports are accurate even for data
  // staged before the BS-driven classification was implemented.
  if (effectiveBatchId) {
    const bsLookup = await loadBsLookupForBatch(companyId, effectiveBatchId);
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
    `[ManualGL][PL][Debug] After reclassification â€” P&L transactions: ${plCount}, BS transactions (excluded): ${bsCount}`,
  );

  // Restore original fiscalYears into the filter passed to the builder so that
  // displayYear is correct even when we bypassed the DB fiscal_year filter above.
  const summary = buildProfitLossSummaryPayload(normalized, {
    ...normalizedFilters,
    fiscalYears: selectedYears.length ? selectedYears : (normalizedFilters.fiscalYears || []),
  });

  console.log(
    `[ManualGL][PL][Debug] P&L result â€” years: ${JSON.stringify(summary.years)},`,
    `netProfitByYear: ${JSON.stringify(summary.netProfitByYear || {})}`,
  );

  return summary;
}

async function getProfitLossDetailFromStage(companyId, filters = {}) {
  const preFilters = parseManualFilterQuery(filters);
  const preBatchId = preFilters.batchId ||
    (await resolveReportBatchId(companyId));
  const batchMeta = await loadBatchMetadata(preBatchId);
  const fiscalCalendarExplicit = batchMeta.fiscalCalendarExplicit === true;

  const selectedYearsForBypass = preFilters.fiscalYears || [];
  let queryFilters = { ...filters, batchId: preBatchId || filters.batchId || "" };

  if (!fiscalCalendarExplicit && selectedYearsForBypass.length) {
    const minYear = Math.min(...selectedYearsForBypass);
    const maxYearPl = Math.max(...selectedYearsForBypass);
    queryFilters = {
      ...queryFilters,
      fiscalYears: [],
      fiscalYear: null,
      startDate: `${minYear}-01-01`,
      endDate: `${maxYearPl}-12-31`,
    };
  }

  const { filters: normalizedFilters, rows: rawRows } = await queryStagedTransactions(companyId, queryFilters);
  const correctedRows = fiscalCalendarExplicit ? rawRows : applyCalendarYearCorrection(rawRows);
  const selectedYears = preFilters.fiscalYears || [];
  const filteredRows = (!fiscalCalendarExplicit && selectedYears.length)
    ? correctedRows.filter((r) => selectedYears.includes(Number(r.fiscal_year || 0)))
    : correctedRows;

  let normalized = filteredRows.map(normalizeStagedTransactionRow).filter(Boolean);
  const effectiveBatchId = normalizedFilters.batchId || preBatchId || "";

  console.log(
    `[ManualGL][PL-Detail][Debug] selectedYears: ${JSON.stringify(selectedYears)},`,
    `total transactions after year filter: ${normalized.length}`,
  );

  // Re-classify using BS lines â€” matches the reclassification in getProfitLossSummaryFromStage
  // so BS accounts stored with wrong type in legacy data are excluded from P&L detail.
  if (effectiveBatchId) {
    const bsLookup = await loadBsLookupForBatch(companyId, effectiveBatchId);
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
    `[ManualGL][PL-Detail][Debug] After reclassification â€” P&L accounts: ${plCount}, BS accounts (excluded): ${bsCount}`,
  );

  return buildProfitLossDetailPayload(normalized, {
    ...normalizedFilters,
    fiscalYears: selectedYears.length ? selectedYears : (normalizedFilters.fiscalYears || []),
  });
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
  const emptyOptions = Object.fromEntries(
    ["fiscalYear", "fiscalMonth", "accountName", "accountNumber", "accountType",
      "category", "subCategory", "department", "class", "location", "sourceFile",
      "transactionType", "journalType", "reportType"].map((k) =>
        k === "reportType" ? [k, ["profit_loss", "balance_sheet"]] : [k, []]
      ),
  );

  const incomingBatchId = toNonEmptyString(filters.batchId || "");
  const datasetVersion = parsePositiveIntegerValue(
    filters.datasetVersion ||
    filters.dataset_version ||
    filters.versionNumber ||
    filters.version_number ||
    "",
  );
  const includeArchived =
    filters.includeArchived === true ||
    toNonEmptyString(filters.versionMode || "").toLowerCase() === REPORT_BATCH_MODE.HISTORICAL;
  const batchId = await resolveReportBatchId(companyId, incomingBatchId, {
    allowExplicitBatch: includeArchived,
    includeArchived,
    versionMode: includeArchived ? REPORT_BATCH_MODE.HISTORICAL : REPORT_BATCH_MODE.ACTIVE,
    versionId: toNonEmptyString(filters.versionId || ""),
    uploadSessionId: toNonEmptyString(filters.uploadSessionId || ""),
    datasetVersion,
  });
  const activeBatch = await getActiveUploadBatch(companyId);
  const activeBatchId = activeBatch?.id || null;

  console.log(
    `[ManualGL][FilterOptions][ReportFilters] company=${companyId} ` +
    `datasetVersion=${datasetVersion || "none"} requestedBatchId=${incomingBatchId || "none"} ` +
    `resolvedBatchId=${batchId || "none"} includeArchived=${includeArchived}`,
  );

  if (!batchId && !datasetVersion) {
    return {
      source: "manual_gl_active_batch",
      activeBatchId,
      resolvedBatchId: null,
      requestedBatchId: incomingBatchId || null,
      versionMode: includeArchived ? REPORT_BATCH_MODE.HISTORICAL : REPORT_BATCH_MODE.ACTIVE,
      rowCount: 0,
      options: emptyOptions,
    };
  }

  // Snapshot-first read for fast and immutable filter option rendering.
  try {
    let snapshotQuery = supabase
      .from("reporting_snapshots")
      .select("snapshot_payload, upload_batch_id, dataset_version")
      .eq("company_id", companyId)
      .eq("report_type", "filter_options")
      .eq("fiscal_year", -1)
      .order("generated_at", { ascending: false });

    if (datasetVersion) {
      snapshotQuery = snapshotQuery.eq("dataset_version", datasetVersion);
    } else if (batchId) {
      snapshotQuery = snapshotQuery.eq("upload_batch_id", batchId);
    }

    const { data: filterSnapshot, error: snapshotError } = await snapshotQuery.limit(1).maybeSingle();

    if (!snapshotError && filterSnapshot?.snapshot_payload?.options) {
      const payload = filterSnapshot.snapshot_payload;
      const snapshotBatchId = toNonEmptyString(
        payload?.resolvedBatchId ||
        payload?.activeBatchId ||
        filterSnapshot?.upload_batch_id ||
        batchId ||
        "",
      );
      return {
        source: "manual_gl_reporting_snapshot",
        activeBatchId,
        resolvedBatchId: snapshotBatchId || null,
        requestedBatchId: incomingBatchId || null,
        versionMode: includeArchived ? REPORT_BATCH_MODE.HISTORICAL : REPORT_BATCH_MODE.ACTIVE,
        rowCount: Number(payload.rowCount || 0),
        options: payload.options || emptyOptions,
      };
    }
  } catch (_) {
    // reporting_snapshots may not exist until migration 026 is applied.
  }

  if (!batchId) {
    return {
      source: "manual_gl_active_batch",
      activeBatchId,
      resolvedBatchId: null,
      requestedBatchId: incomingBatchId || null,
      versionMode: includeArchived ? REPORT_BATCH_MODE.HISTORICAL : REPORT_BATCH_MODE.ACTIVE,
      rowCount: 0,
      options: emptyOptions,
    };
  }

  console.log(
    `[ManualGL][FilterOptions] Resolving options for batch ${batchId} datasetVersion=${datasetVersion || "none"}`,
  );

  const DISCOVERY_COLS = [
    "fiscal_year", "txn_date", "account_name", "account_number", "account_type",
    "category", "sub_category", "department", "class", "location",
    "source_file", "transaction_type", "journal_type",
  ].join(", ");

  const fetchNarrow = async (includeSourceType = true) => {
    let query = supabase
      .from(TABLES.transactions)
      .select(DISCOVERY_COLS)
      .eq("company_id", companyId)
      .eq("upload_batch_id", batchId);

    if (includeSourceType && filters.sourceType) {
      query = query.eq("source_type", filters.sourceType);
    }

    query = query.order("id", { ascending: true });

    const pageSize = 1000;
    const maxRows = DEFAULT_STAGING_LIMIT;
    const rows = [];
    let offset = 0;

    while (rows.length < maxRows) {
      const chunkSize = Math.min(pageSize, maxRows - rows.length);
      const { data, error } = await query.range(offset, offset + chunkSize - 1);
      if (error) return { rows: [], error };
      const chunk = Array.isArray(data) ? data : [];
      if (!chunk.length) break;
      rows.push(...chunk);
      offset += chunk.length;
      if (chunk.length < pageSize) break;
    }

    return { rows, error: null };
  };

  let { rows, error } = await fetchNarrow(true);
  if (error && isMissingColumnError(error, "upload_batch_id")) {
    const fetchLegacyBatch = async (includeSourceType = true) => {
      let query = supabase
        .from(TABLES.transactions)
        .select(DISCOVERY_COLS)
        .eq("company_id", companyId)
        .eq("batch_id", batchId);

      if (includeSourceType && filters.sourceType) {
        query = query.eq("source_type", filters.sourceType);
      }

      query = query.order("id", { ascending: true });

      const pageSize = 1000;
      const maxRows = DEFAULT_STAGING_LIMIT;
      const legacyRows = [];
      let offset = 0;

      while (legacyRows.length < maxRows) {
        const chunkSize = Math.min(pageSize, maxRows - legacyRows.length);
        const { data, error: fetchError } = await query.range(offset, offset + chunkSize - 1);
        if (fetchError) return { rows: [], error: fetchError };
        const chunk = Array.isArray(data) ? data : [];
        if (!chunk.length) break;
        legacyRows.push(...chunk);
        offset += chunk.length;
        if (chunk.length < pageSize) break;
      }

      return { rows: legacyRows, error: null };
    };

    ({ rows, error } = await fetchLegacyBatch(true));
    if (error && isMissingColumnError(error)) {
      ({ rows, error } = await fetchLegacyBatch(false));
    }
  } else if (error && isMissingColumnError(error)) {
    ({ rows, error } = await fetchNarrow(false));
  }
  if (error) throw new Error(`Failed to fetch filter options: ${error.message}`);

  console.log(`[ManualGL][FilterOptions] Scanned ${rows.length} rows for batch ${batchId}`);

  const addValue = (set, value) => {
    if (value === null || value === undefined) return;
    const text = String(value).trim();
    if (text) set.add(text);
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

  const availableFiscalYears = getAvailableFiscalYears(rows);
  availableFiscalYears.forEach((yr) => options.fiscalYear.add(String(yr)));

  rows.forEach((row) => {
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
    activeBatchId,
    resolvedBatchId: batchId,
    requestedBatchId: incomingBatchId || null,
    versionMode: includeArchived ? REPORT_BATCH_MODE.HISTORICAL : REPORT_BATCH_MODE.ACTIVE,
    rowCount: rows.length,
    options: Object.fromEntries(
      Object.entries(options).map(([key, set]) => [
        key,
        Array.from(set).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
      ]),
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
    batchId || (await resolveReportBatchId(companyId));
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
  if (!companyId) return null;

  const sourceType = toNonEmptyString(options.sourceType || "");
  const sourceSwitchVersion = toNonEmptyString(options.sourceSwitchVersion || "");
  const rawUploadSessionId = toNonEmptyString(options.uploadSessionId || "");
  const uploadSessionId = isValidUuid(rawUploadSessionId) ? rawUploadSessionId : "";
  const status = toNonEmptyString(options.status || "").toLowerCase();

  if (!status || status === "active") {
    const active = await getActiveUploadBatch(companyId);
    if (active) {
      if (sourceType && toNonEmptyString(active.source_type) !== sourceType) {
        // Continue to query fallback path below.
      } else {
        return active;
      }
    }
    if (status === "active") return null;
  }

  const runQuery = async (config = {}) => {
    const includeSourceColumns = config.includeSourceColumns !== false;
    const useBatchStatusColumn = config.useBatchStatusColumn === true;

    let query = supabase
      .from(TABLES.batches)
      .select("*")
      .eq("company_id", companyId);

    if (status) {
      if (useBatchStatusColumn) {
        query = query.eq("batch_status", status);
      } else {
        const statusFallback = status === "active" ? "staged" : status;
        query = query.eq("status", statusFallback);
      }
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

    return query.order("created_at", { ascending: false }).limit(1).maybeSingle();
  };

  let { data, error } = await runQuery({
    includeSourceColumns: true,
    useBatchStatusColumn: Boolean(status),
  });

  if (error && isMissingColumnError(error)) {
    ({ data, error } = await runQuery({
      includeSourceColumns: false,
      useBatchStatusColumn: false,
    }));
  }

  if (error && error.code !== "PGRST116") {
    throw new Error(`Failed to fetch latest manual batch: ${error.message}`);
  }

  return data || null;
}

async function loadBatchMetadata(batchId) {
  if (!batchId) return {};
  const { data } = await supabase
    .from(TABLES.batches)
    .select("metadata")
    .eq("id", batchId)
    .maybeSingle();
  return (data?.metadata && typeof data.metadata === "object") ? data.metadata : {};
}

// Corrects stored fiscal_year values for calendar-year batches where BUG 2 caused
// the April default fiscal calendar to assign wrong year labels during staging.
// Safe no-op: when fiscal_year already equals the calendar year (correctly staged data),
// returns the row unchanged. Never touches rows for April-calendar batches.
function applyCalendarYearCorrection(rows) {
  let correctedCount = 0;
  const result = rows.map((row) => {
    const dateStr = String(row.txn_date || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return row;
    const calendarYear = Number(dateStr.slice(0, 4));
    const storedYear = Number(row.fiscal_year || 0);
    if (!calendarYear || calendarYear === storedYear) return row;
    correctedCount++;
    return { ...row, fiscal_year: calendarYear };
  });
  if (correctedCount > 0) {
    console.log(
      `[ManualGL][FYCorrection] Corrected fiscal_year for ${correctedCount}/${rows.length} rows ` +
      `to calendar year from txn_date (BUG2 artifact).`,
    );
  }
  return result;
}

async function listManualGlBatches(companyId) {
  const runQuery = async (includeVersionColumns = true) => {
    let query = supabase
      .from(TABLES.batches)
      .select(
        includeVersionColumns
          ? "id, batch_name, status, batch_status, is_active, is_archived, dataset_version, upload_checksum, created_at, updated_at, metadata, activated_at, deactivated_at"
          : "id, batch_name, status, batch_status, is_active, upload_checksum, created_at, updated_at, metadata, activated_at, deactivated_at",
      )
      .eq("company_id", companyId)
      .eq("source_type", MANUAL_SOURCE_KEY);

    if (includeVersionColumns) {
      query = query
        .order("dataset_version", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false });
    } else {
      query = query.order("created_at", { ascending: false });
    }

    return query;
  };

  let { data, error } = await runQuery(true);

  if (error && isMissingColumnError(error, "dataset_version")) {
    ({ data, error } = await runQuery(false));
  } else if (error && isMissingColumnError(error, "source_type")) {
    ({ data, error } = await supabase
      .from(TABLES.batches)
      .select("id, batch_name, status, batch_status, is_active, upload_checksum, created_at, updated_at, metadata, activated_at, deactivated_at")
      .eq("company_id", companyId)
      .order("created_at", { ascending: false }));
  }

  if (error) {
    throw new Error(`Failed to list manual GL batches: ${error.message}`);
  }

  return data || [];
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// â”€â”€â”€ Monthly Detail: Profit & Loss â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
  const preFilters = parseManualFilterQuery(filters);
  const preBatchId = preFilters.batchId ||
    (await resolveReportBatchId(companyId));
  const batchMeta = await loadBatchMetadata(preBatchId);
  const fiscalCalendarExplicit = batchMeta.fiscalCalendarExplicit === true;

  const selectedYearsForBypass = preFilters.fiscalYears || [];
  let queryFilters = { ...filters, batchId: preBatchId || filters.batchId || "" };

  if (!fiscalCalendarExplicit && selectedYearsForBypass.length) {
    const minYear = Math.min(...selectedYearsForBypass);
    const maxYearPl = Math.max(...selectedYearsForBypass);
    queryFilters = {
      ...queryFilters,
      fiscalYears: [],
      fiscalYear: null,
      startDate: `${minYear}-01-01`,
      endDate: `${maxYearPl}-12-31`,
    };
  }

  const { filters: normalizedFilters, rows: rawRows } = await queryStagedTransactions(companyId, queryFilters);
  const correctedRows = fiscalCalendarExplicit ? rawRows : applyCalendarYearCorrection(rawRows);
  const selectedYears = preFilters.fiscalYears || [];
  const filteredRows = (!fiscalCalendarExplicit && selectedYears.length)
    ? correctedRows.filter((r) => selectedYears.includes(Number(r.fiscal_year || 0)))
    : correctedRows;

  let normalized = filteredRows.map(normalizeStagedTransactionRow).filter(Boolean);
  const effectiveBatchId = normalizedFilters.batchId || preBatchId || "";

  const selectedYear =
    selectedYears.length > 0
      ? Math.max(...selectedYears.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0))
      : null;

  console.log(
    `[ManualGL][PL-Monthly][Debug] selectedYear: ${selectedYear},`,
    `total transactions after year filter: ${normalized.length}`,
  );

  // Re-classify using BS lines â€” keeps BS accounts out of P&L monthly totals
  // (matches the reclassification logic used in getProfitLossSummaryFromStage).
  if (effectiveBatchId) {
    const bsLookup = await loadBsLookupForBatch(companyId, effectiveBatchId);
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

// â”€â”€â”€ Monthly Detail: Balance Sheet â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function buildBalanceSheetMonthlyDetailPayload(transactions = [], year, filters = {}, startingLines = [], netProfitByYear = {}, selectedMonth = null, fiscalCalendar = {}) {
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
    // Only carry net income for years whose fiscal period ended AFTER the starting BS date.
    // Years already closed into the starting BS opening balance must not be double-counted.
    const startingBsDateStr = startingLines.find((l) => l.as_of_date)?.as_of_date || null;
    const bsCalendar = resolveFiscalCalendarConfig(fiscalCalendar);
    const priorNetIncome = derivedYears
      .filter((yr) => {
        if (yr >= selectedYear) return false;
        const fiscalEndDate = computeFiscalYearEndDate(yr, bsCalendar);
        return !startingBsDateStr || !fiscalEndDate || startingBsDateStr < fiscalEndDate;
      })
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
    normalizedFilters.batchId || (await resolveReportBatchId(companyId));
  const targetYear =
    Array.isArray(normalizedFilters.fiscalYears) && normalizedFilters.fiscalYears.length > 0
      ? Math.max(...normalizedFilters.fiscalYears.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0))
      : null;

  let startingLines = [];
  let endingLines = [];
  let batchMetaMonthly = {};
  if (effectiveBatchId) {
    [startingLines, endingLines, batchMetaMonthly] = await Promise.all([
      loadBatchBalanceSheetLines(companyId, effectiveBatchId, SHEET_TYPE.STARTING),
      loadBatchBalanceSheetLines(companyId, effectiveBatchId, SHEET_TYPE.ENDING),
      loadBatchMetadata(effectiveBatchId),
    ]);
  }
  const fiscalCalendarExplicitMonthly = batchMetaMonthly.fiscalCalendarExplicit === true;

  // Query cumulative rows and let the payload builder create opening + monthly balances for selected year.
  // fiscalMonths is intentionally cleared: the BS payload builder needs ALL months' transactions to compute
  // the correct cumulative running balance. Month restriction is applied via the months[] array in the builder.
  const { rows: rawRowsMonthly } = await queryStagedTransactions(companyId, {
    ...normalizedFilters,
    reportType: "",
    fiscalYear: null,
    fiscalYears: [],
    fiscalMonths: [],
    startDate: "",
    endDate: "",
    limit: DEFAULT_STAGING_LIMIT,
  });

  const rowsMonthly = fiscalCalendarExplicitMonthly ? rawRowsMonthly : applyCalendarYearCorrection(rawRowsMonthly);

  let normalized = rowsMonthly.map(normalizeStagedTransactionRow).filter(Boolean);
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

  const batchFiscalCalendarMonthly = fiscalCalendarExplicitMonthly
    ? { fiscalYearStartMonth: batchMetaMonthly.fiscalYearStartMonth, fiscalYearStartDay: batchMetaMonthly.fiscalYearStartDay }
    : { fiscalYearStartMonth: 1, fiscalYearStartDay: 1 };

  return buildBalanceSheetMonthlyDetailPayload(
    normalized,
    targetYear,
    { ...normalizedFilters, batchId: normalizedFilters.batchId || effectiveBatchId || "" },
    startingLines,
    pnlPayload.netProfitByYear || {},
    selectedMonth,
    batchFiscalCalendarMonthly,
  );
}

// â”€â”€â”€ Monthly Detail: Cash Flow â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function buildCashflowMonthlyDetailPayload(transactions = [], year, filters = {}, startingLines = [], selectedMonth = null) {
  const resolvedSelectedMonth = (Number.isInteger(Number(selectedMonth)) && Number(selectedMonth) >= 1 && Number(selectedMonth) <= 12)
    ? Number(selectedMonth) : null;
  const allMonths = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  const months = resolvedSelectedMonth !== null ? allMonths.slice(0, resolvedSelectedMonth) : allMonths;
  const lastMonth = resolvedSelectedMonth !== null ? resolvedSelectedMonth : 12;
  const selectedYear = (Number.isInteger(Number(year)) && Number(year) > 0) ? Number(year) : null;

  if (!selectedYear) {
    return {
      source: "manual_gl_staged_transactions",
      reportType: "cash_flow_monthly_detail",
      year: null,
      months,
      monthNames: MONTH_NAMES,
      sections: [],
      filters,
    };
  }

  const getMonth = (tx) => Number(
    tx.fiscalMonth ||
    (String(tx.date || "").length >= 7 ? Number(String(tx.date).slice(5, 7)) : 0),
  );

  // --- Step 1: Monthly P&L net income (period-only for target year) ---
  const monthlyNetIncome = {};
  months.forEach((m) => { monthlyNetIncome[m] = 0; });
  transactions
    .filter((tx) => Number(tx.fiscalYear || 0) === selectedYear)
    .forEach((tx) => {
      const acctType = normalizeAccountType(tx.accountType || "");
      if (!["income", "cogs", "expense"].includes(acctType)) return;
      const txMonth = getMonth(tx);
      if (txMonth >= 1 && txMonth <= 12) {
        monthlyNetIncome[txMonth] = roundMoney(monthlyNetIncome[txMonth] + Number(tx.netAmount || 0));
      }
    });

  // --- Step 2: Cash opening balance (starting lines + prior-year transaction deltas) ---
  const isCashCat = (catLabel) => {
    const l = String(catLabel || "").toLowerCase();
    return l.includes("bank account") || l === "cash";
  };

  let cashOpeningBalance = 0;
  startingLines.forEach((line) => {
    if (line.section !== "assets") return;
    const grouping = resolveBalanceSheetGrouping(String(line.account_name || ""), "asset", line.metadata?.leafCategory || "");
    if (isCashCat(grouping?.leafCategory)) {
      cashOpeningBalance = roundMoney(cashOpeningBalance + Number(line.amount || 0));
    }
  });
  transactions
    .filter((tx) => Number(tx.fiscalYear || 0) < selectedYear)
    .forEach((tx) => {
      const acctType = normalizeAccountType(tx.accountType || "");
      if (acctType !== "asset") return;
      const grouping = resolveBalanceSheetGrouping(tx.accountName || "", acctType, tx.category || "");
      if (!isCashCat(grouping?.leafCategory)) return;
      const netAmount = Number(tx.netAmount || 0);
      const contra = isContraAccount(tx.accountName, "asset");
      let delta = -netAmount;
      if (contra) delta = -delta;
      cashOpeningBalance = roundMoney(cashOpeningBalance + delta);
    });

  // --- Step 3: Current-year monthly cash balance ---
  const cashDeltaByMonth = {};
  months.forEach((m) => { cashDeltaByMonth[m] = 0; });
  transactions
    .filter((tx) => Number(tx.fiscalYear || 0) === selectedYear)
    .forEach((tx) => {
      const acctType = normalizeAccountType(tx.accountType || "");
      if (acctType !== "asset") return;
      const grouping = resolveBalanceSheetGrouping(tx.accountName || "", acctType, tx.category || "");
      if (!isCashCat(grouping?.leafCategory)) return;
      const txMonth = getMonth(tx);
      if (txMonth < 1 || txMonth > 12) return;
      const netAmount = Number(tx.netAmount || 0);
      const contra = isContraAccount(tx.accountName, "asset");
      let delta = -netAmount;
      if (contra) delta = -delta;
      cashDeltaByMonth[txMonth] = roundMoney(cashDeltaByMonth[txMonth] + delta);
    });

  const cashMonthlyBalance = {};
  let runningCash = cashOpeningBalance;
  months.forEach((m) => {
    runningCash = roundMoney(runningCash + (cashDeltaByMonth[m] || 0));
    cashMonthlyBalance[m] = runningCash;
  });

  // --- Step 4: BS category monthly movements ---
  // Cashflow indirect method: impact = netAmount for all BS accounts.
  // netAmount = credit - debit:
  //   Asset increases (debit) â†’ netAmount < 0 â†’ outflow âœ“
  //   Liability increases (credit) â†’ netAmount > 0 â†’ inflow âœ“
  const cfSections = {
    Operating: { key: "operating", label: "Operating Activities", items: new Map(), monthlyTotals: {}, total: 0 },
    Investing: { key: "investing", label: "Investing Activities", items: new Map(), monthlyTotals: {}, total: 0 },
    Financing: { key: "financing", label: "Financing Activities", items: new Map(), monthlyTotals: {}, total: 0 },
  };
  months.forEach((m) => {
    cfSections.Operating.monthlyTotals[m] = monthlyNetIncome[m] || 0;
    cfSections.Investing.monthlyTotals[m] = 0;
    cfSections.Financing.monthlyTotals[m] = 0;
  });
  cfSections.Operating.total = roundMoney(months.reduce((s, m) => s + (monthlyNetIncome[m] || 0), 0));

  transactions
    .filter((tx) => Number(tx.fiscalYear || 0) === selectedYear)
    .forEach((tx) => {
      const acctType = normalizeAccountType(tx.accountType || "");
      if (!["asset", "liability", "equity"].includes(acctType)) return;

      const grouping = resolveBalanceSheetGrouping(tx.accountName || "", acctType, tx.category || "");
      const catLabel = grouping?.leafCategory || (acctType === "asset" ? "Other Current Assets" : acctType === "liability" ? "Other Current Liabilities" : "Owner Equity");
      const catLow = String(catLabel).toLowerCase();

      if (isCashCat(catLabel)) return; // captured as beginning/ending cash
      if (catLow.includes("net income") || catLow.includes("retained earnings")) return; // double-counted via P&L

      const txMonth = getMonth(tx);
      if (!months.includes(txMonth)) return;

      const impact = roundMoney(Number(tx.netAmount || 0));
      if (impact === 0) return;

      // Contra accounts (e.g. accumulated depreciation add-back) stay in Operating.
      const isContra = isContraAccount(tx.accountName, acctType);
      let cfSection = "Operating";
      if (!isContra) {
        if (catLow.includes("fixed asset") || catLow.includes("other asset")) cfSection = "Investing";
        if (catLow.includes("long-term") || catLow.includes("loan") || catLow.includes("owner equity")) cfSection = "Financing";
      }

      const sec = cfSections[cfSection];
      if (!sec.items.has(catLabel)) {
        sec.items.set(catLabel, { name: `Change in ${catLabel}`, monthly: {}, total: 0 });
      }
      const item = sec.items.get(catLabel);
      item.monthly[txMonth] = roundMoney((item.monthly[txMonth] || 0) + impact);
      item.total = roundMoney(item.total + impact);
      sec.monthlyTotals[txMonth] = roundMoney(sec.monthlyTotals[txMonth] + impact);
      sec.total = roundMoney(sec.total + impact);
    });

  // --- Step 5: Assemble sections for frontend ---
  const sections = [];
  ["Operating", "Investing", "Financing"].forEach((sKey) => {
    const sec = cfSections[sKey];
    const accounts = [];
    if (sKey === "Operating") {
      accounts.push({
        accountName: "Net Income",
        monthly: { ...monthlyNetIncome },
        total: roundMoney(months.reduce((s, m) => s + (monthlyNetIncome[m] || 0), 0)),
      });
    }
    sec.items.forEach((item) => accounts.push({ accountName: item.name, monthly: { ...item.monthly }, total: item.total }));
    sections.push({
      key: sec.key,
      label: sec.label,
      accounts,
      monthlyTotals: { ...sec.monthlyTotals },
      total: sec.total,
      totalLabel: `Net Cash from ${sKey} Activities`,
    });
  });

  const netCashMonthly = {};
  months.forEach((m) => {
    netCashMonthly[m] = roundMoney(
      (cfSections.Operating.monthlyTotals[m] || 0) +
      (cfSections.Investing.monthlyTotals[m] || 0) +
      (cfSections.Financing.monthlyTotals[m] || 0),
    );
  });
  sections.push({ key: "net_cash_change", label: "Net Change in Cash", isCalculated: true, monthlyTotals: netCashMonthly, total: roundMoney(months.reduce((s, m) => s + (netCashMonthly[m] || 0), 0)) });

  const beginningCashMonthly = {};
  months.forEach((m, i) => { beginningCashMonthly[m] = i === 0 ? cashOpeningBalance : (cashMonthlyBalance[months[i - 1]] || 0); });
  sections.push({ key: "beginning_cash", label: "Beginning Cash", isCalculated: true, monthlyTotals: beginningCashMonthly, total: beginningCashMonthly[months[0]] || 0 });
  sections.push({ key: "ending_cash", label: "Ending Cash", isCalculated: true, monthlyTotals: { ...cashMonthlyBalance }, total: cashMonthlyBalance[lastMonth] || 0 });

  return {
    source: "manual_gl_staged_transactions",
    reportType: "cash_flow_monthly_detail",
    year: selectedYear,
    months,
    monthNames: MONTH_NAMES,
    sections,
    filters,
  };
}

async function getCashflowMonthlyDetailFromStage(companyId, filters = {}) {
  const normalizedFilters = parseManualFilterQuery(filters);
  const effectiveBatchId = normalizedFilters.batchId || (await resolveReportBatchId(companyId));
  const targetYear = Array.isArray(normalizedFilters.fiscalYears) && normalizedFilters.fiscalYears.length > 0
    ? Math.max(...normalizedFilters.fiscalYears.map(Number).filter((y) => Number.isInteger(y) && y > 0))
    : null;

  let startingLines = [];
  let endingLines = [];
  let batchMetaCf = {};
  if (effectiveBatchId) {
    [startingLines, endingLines, batchMetaCf] = await Promise.all([
      loadBatchBalanceSheetLines(companyId, effectiveBatchId, SHEET_TYPE.STARTING),
      loadBatchBalanceSheetLines(companyId, effectiveBatchId, SHEET_TYPE.ENDING),
      loadBatchMetadata(effectiveBatchId),
    ]);
  }
  const fiscalCalendarExplicitCf = batchMetaCf.fiscalCalendarExplicit === true;

  const { rows: rawRowsCf } = await queryStagedTransactions(companyId, {
    ...normalizedFilters,
    reportType: "",
    fiscalYear: null,
    fiscalYears: [],
    fiscalMonths: [],
    startDate: "",
    endDate: "",
    limit: DEFAULT_STAGING_LIMIT,
  });

  const rowsCf = fiscalCalendarExplicitCf ? rawRowsCf : applyCalendarYearCorrection(rawRowsCf);

  let normalized = rowsCf.map(normalizeStagedTransactionRow).filter(Boolean);
  const bsLookup = buildBsLookupFromDbLines(startingLines, endingLines);
  if (bsLookup.size > 0) {
    normalized = reclassifyNormalizedTransactions(normalized, bsLookup);
  }

  const selectedMonth = Array.isArray(normalizedFilters.fiscalMonths) && normalizedFilters.fiscalMonths.length > 0
    ? normalizedFilters.fiscalMonths[0] : null;
  console.log(`[ManualGL][CF-Monthly][Filter] targetYear: ${targetYear}, selectedMonth: ${selectedMonth}`);

  return buildCashflowMonthlyDetailPayload(
    normalized,
    targetYear,
    { ...normalizedFilters, batchId: normalizedFilters.batchId || effectiveBatchId || "" },
    startingLines,
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
  getCashflowMonthlyDetailFromStage,
  validateBatchBalanceSheet,
  getLatestManualBatch,
  listManualGlBatches,
  // Multi-year detection utility â€” usable by callers (e.g., upload controllers)
  // to surface file type information without re-staging.
  detectMultipleYears,
  getAvailableFiscalYears,
  checkExistingStagedFiscalYears,
  retrySupabaseOperation,
};

