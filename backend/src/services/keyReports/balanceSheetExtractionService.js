/**
 * Balance Sheet Extraction Service
 *
 * Supports:
 *  - QuickBooks Online / Desktop Excel exports
 *  - Generic Balance Sheet Excel/CSV files
 *  - PDF reports via Gemini (parsePdfWithGemini)
 *
 * Strategy:
 *  1. Read raw as array-of-arrays (header:1 mode).
 *  2. Extract as_of_date from column headers or title rows.
 *  3. Col 0 = account name, rightmost numeric col = amount.
 *  4. Validate leniently — only reject rows that violate NOT NULL DB constraints.
 *  5. PDF fallback via Gemini.
 */

const XLSX = require('xlsx');
const { supabase } = require('../../db');
const ExtractionServiceBase = require('./extractionService.base');
const { parsePdfWithGemini, flattenGeminiRows } = require('../geminiFinancialParser');
const { extractWithPython, detectPdfType } = require('./pythonBridge');

const ACCOUNT_ALIASES = ['account', 'account name', 'name', 'description', 'account description', 'label', 'item'];
const DATE_PATTERN    = /\b(20\d{2}|19\d{2})\b/;
// Matches "As of Dec 31, 2024", "December 31, 2024", "12/31/2024", etc.
const AS_OF_PATTERN   = /(?:as\s+of\s+)?(\w+\s+\d{1,2},?\s*\d{4}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}|\d{4}-\d{2}-\d{2})/i;

function lc(v) { return String(v || '').toLowerCase().trim(); }

function parseAmount(v) {
  if (v === '' || v == null) return null;
  const s = String(v).replace(/[$,\s]/g, '');
  if (/^\([\d.]+\)$/.test(s)) return -(parseFloat(s.slice(1, -1)) || 0);
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

function parseAsOfDate(text) {
  const t = String(text || '');
  const m = t.match(AS_OF_PATTERN);
  if (!m) return null;
  const d = new Date(m[1]);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().split('T')[0];
}

function extractYearFromText(text) {
  const m = String(text).match(DATE_PATTERN);
  return m ? parseInt(m[1], 10) : null;
}

function findCol(headers, aliases) {
  for (let i = 0; i < headers.length; i++) {
    const h = lc(headers[i]);
    if (aliases.some((a) => h === a || h.includes(a))) return i;
  }
  return -1;
}

/**
 * Recognize a bare section-HEADER line (literal text like "ASSETS",
 * "Current Liabilities", "Liabilities and Equity", "Owner's Equity" printed
 * on the document with no amount). This reads what the document itself says,
 * not a guess — it must NEVER be used to classify an ordinary account line
 * from its own name (that would be a hardcoded keyword guess); see the two
 * call sites below.
 *
 * A line matches ONLY if EVERY word in it is drawn from a small closed
 * header-vocabulary set — not a substring test on the whole string (that
 * previously matched "capital" inside "Capital One Credit Card", a real
 * account, misfiring it as an equity header and corrupting the section
 * context for every account after it), and not a single fixed phrase either
 * (too narrow — real documents use "Current Liabilities", "Liabilities and
 * Equity", etc., not just "Liabilities" alone).
 */
const HEADER_WORDS = new Set([
  'total', 'current', 'fixed', 'long', 'term', 'other', 'and',
  'asset', 'assets', 'liability', 'liabilities',
]);
const EQUITY_WORDS = new Set([
  'equity', 'capital', 'owner', 'owners', 'member', 'members', 'stockholder', 'stockholders', 'partner', 'partners',
]);
for (const w of EQUITY_WORDS) HEADER_WORDS.add(w);

function inferSection(accountName) {
  const n = lc(accountName).replace(/'/g, '').trim();
  if (!n) return null;
  const words = n.replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
  if (!words.length || !words.every((w) => HEADER_WORDS.has(w))) return null;

  const hasAsset = words.some((w) => w === 'asset' || w === 'assets');
  const hasLiability = words.some((w) => w === 'liability' || w === 'liabilities');
  const hasEquity = words.some((w) => EQUITY_WORDS.has(w));

  if (hasAsset) return 'assets';
  if (hasLiability && hasEquity) {
    // Combined "Liabilities and Equity" style header — resolve by which
    // marker word appears first; liabilities-first is the overwhelmingly
    // common convention, but this handles either order.
    const liabIdx = n.indexOf('liabilit');
    let equityIdx = Infinity;
    for (const w of EQUITY_WORDS) {
      const i = n.indexOf(w);
      if (i !== -1 && i < equityIdx) equityIdx = i;
    }
    return equityIdx < liabIdx ? 'equity' : 'liabilities';
  }
  if (hasLiability) return 'liabilities';
  if (hasEquity) return 'equity';
  return null;
}

/**
 * A second, additive qualifier read from the SAME bare header line as
 * inferSection — current | fixed | long_term | other | null. Stored
 * separately (balance_sheet_entries.sub_section, migration 075) rather than
 * folded into section's own values, since other services do exact-string
 * checks against section === "assets"/"liabilities"/"equity" for real
 * Balance Sheet / Cash Flow generation logic. Only ever called on the same
 * already-confirmed header line inferSection matched — never on an account's
 * own name.
 */
function inferSubSection(accountName) {
  const n = lc(accountName).replace(/'/g, '').trim();
  if (!n) return null;
  const words = n.replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
  if (words.some((w) => w === 'current')) return 'current';
  if (words.some((w) => w === 'fixed')) return 'fixed';
  if (words.some((w) => w === 'long') && words.some((w) => w === 'term')) return 'long_term';
  if (words.some((w) => w === 'other')) return 'other';
  return null;
}

class BalanceSheetExtractionService extends ExtractionServiceBase {
  constructor() {
    super('balance_sheet', 'balance_sheet_entries');
    // inferSection()'s header-detection logic changed (whole-word-set
    // classifier replacing an unanchored substring test that misfired on
    // "Capital One Credit Card" and similar real accounts) — bump this
    // service's own parser_version so the extraction cache is invalidated
    // and every previously-cached Balance Sheet gets re-parsed with the
    // fixed logic on the next sync, instead of silently reusing stale rows
    // extracted before the fix (which is what was still happening).
    // v3: added sub_section (current/fixed/long_term/other) alongside section
    // — bump again so previously-cached rows (which lack this field) get
    // re-extracted rather than silently missing it forever.
    this.parserVersion = 'v3';
  }

  async extract({ fileName, fileBuffer }) {
    const ext = (fileName || '').toLowerCase().split('.').pop();
    if (ext === 'pdf') return this._extractFromPdf(fileBuffer, fileName);
    return this._extractFromExcelWithFallback(fileBuffer, fileName);
  }

  // ── Excel: Python primary, JS fallback ─────────────────────────────────────
  async _extractFromExcelWithFallback(fileBuffer, fileName) {
    try {
      this.logger.log(`Trying Python extraction for Excel "${fileName}"`);
      const result = await extractWithPython('extract_excel.py', fileBuffer, {
        type: 'balance_sheet',
        filename: fileName,
      });
      if (result.rows && result.rows.length > 0) {
        this.logger.log(`Python extracted ${result.rows.length} rows from "${fileName}"`);
        return { rows: result.rows, detectedYears: result.detected_years };
      }
      this.logger.warn(`Python returned 0 rows for "${fileName}", falling back to JS`);
    } catch (err) {
      this.logger.warn(`Python extraction failed for "${fileName}", falling back to JS: ${err.message}`);
    }
    return this._extractFromExcel(fileBuffer, fileName);
  }

  // ── PDF: Python text-layer primary, Gemini fallback ─────────────────────────
  async _extractFromPdf(fileBuffer, fileName) {
    try {
      const pdfType = await detectPdfType(fileBuffer);
      this.logger.log(`PDF "${fileName}" type=${pdfType}`);

      const scriptName = pdfType === 'scanned' ? 'extract_pdf_ocr.py' : 'extract_pdf_text.py';
      const result = await extractWithPython(scriptName, fileBuffer, {
        type: 'balance_sheet',
        filename: fileName,
      });
      if (result.rows && result.rows.length > 0) {
        this.logger.log(`Python (${scriptName}) extracted ${result.rows.length} rows from PDF "${fileName}"`);
        return { rows: result.rows, detectedYears: result.detected_years };
      }
      this.logger.warn(`Python returned 0 rows for PDF "${fileName}", falling back to Gemini`);
    } catch (err) {
      this.logger.warn(`Python PDF extraction failed for "${fileName}", falling back to Gemini: ${err.message}`);
    }
    return this._extractFromPdfGemini(fileBuffer, fileName);
  }

  async _extractFromPdfGemini(fileBuffer, fileName) {
    this.logger.log(`Parsing PDF "${fileName}" via Gemini`);
    const geminiResult = await parsePdfWithGemini(fileBuffer, fileName);
    const flatNodes = flattenGeminiRows(geminiResult.rows || []);

    let asOfDate = geminiResult.asOfDate || null;
    if (!asOfDate && geminiResult.periodEnd) asOfDate = geminiResult.periodEnd;
    if (!asOfDate) asOfDate = new Date().toISOString().split('T')[0];

    const fiscalYear = new Date(asOfDate).getFullYear() || new Date().getFullYear();

    const rows = flatNodes.map((node) => ({
      account_name: node.name,
      // Only Gemini's own structural read of the document — never guessed
      // from the account's own name (see inferSection's doc comment).
      section: node._section || null,
      amount: node.amount || 0,
      as_of_date: asOfDate,
      fiscal_year: fiscalYear,
      is_total: node.type === 'total',
    }));

    this.logger.log(`PDF "${fileName}": ${rows.length} rows (as_of_date=${asOfDate})`);
    return { rows, detectedYears: [fiscalYear] };
  }

  // ── Excel / CSV ─────────────────────────────────────────────────────────────
  async _extractFromExcel(fileBuffer, fileName) {
    const workbook = XLSX.read(fileBuffer, { type: 'buffer', cellDates: false });
    const sheetName =
      workbook.SheetNames.find((n) => /balance\s*sheet|bs\b/i.test(n)) ||
      workbook.SheetNames[0];
    const ws = workbook.Sheets[sheetName];
    const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    if (!raw || raw.length < 2) throw new Error('No data found in Balance Sheet');

    this.logger.log(`Sheet "${sheetName}" in "${fileName}": ${raw.length} raw rows`);

    // Scan first 20 rows: collect as_of_date and find best-scoring header row.
    // Score-based (not last-match) — fixes the bug where a data row like
    // "Accounts Payable" would push headerIdx past all the real data rows.
    let asOfDate = null;
    let titleFiscalYear = null;
    let headerIdx = 0;
    let bestHeaderScore = 0;

    for (let i = 0; i < Math.min(20, raw.length); i++) {
      const rowText = raw[i].join(' ');
      if (!asOfDate) {
        const d = parseAsOfDate(rowText);
        if (d) { asOfDate = d; titleFiscalYear = new Date(d).getFullYear(); }
      }
      if (!titleFiscalYear) {
        const y = extractYearFromText(rowText);
        if (y) titleFiscalYear = y;
      }
      // Score this row as a potential header
      let score = 0;
      if (ACCOUNT_ALIASES.some((a) => lc(rowText).includes(a))) score += 3;
      if (/as\s+of|as-of/i.test(rowText)) score += 4;
      if (/balance|total/i.test(rowText)) score += 2;
      if (extractYearFromText(rowText)) score += 3;
      if (score > bestHeaderScore) { bestHeaderScore = score; headerIdx = i; }
    }

    if (!asOfDate) {
      const year = titleFiscalYear || new Date().getFullYear();
      asOfDate = `${year}-12-31`;
    }
    const fiscalYear = titleFiscalYear || new Date(asOfDate).getFullYear();

    this.logger.log(`  as_of_date=${asOfDate}, fiscal_year=${fiscalYear}, header at row ${headerIdx}`);

    // Account col: col 0 by default, or detected from header row
    const headerRow = raw[headerIdx];
    const acctIdx = Math.max(0, findCol(headerRow, ACCOUNT_ALIASES));

    let currentSection = null;
    const rows = [];
    let rowsDetected = 0, rowsRejected = 0;

    for (let i = headerIdx + 1; i < raw.length; i++) {
      const row = raw[i];
      const rawName = String(row[acctIdx] || '').trim();
      if (!rawName) continue;

      rowsDetected++;

      // Detect section headers (ASSETS, LIABILITIES, EQUITY)
      const sectionMatch = inferSection(rawName);
      if (sectionMatch && !parseAmount(row[row.length - 1])) {
        // This row is a pure section header (no amount) — track section
        currentSection = rawName;
        // Still emit a header row so the hierarchy is preserved
        rows.push({
          account_name: rawName,
          section: sectionMatch,
          sub_section: inferSubSection(rawName),
          amount: 0,
          as_of_date: asOfDate,
          fiscal_year: fiscalYear,
          is_total: false,
          is_section_header: true,
        });
        continue;
      }

      // Find the rightmost numeric value as the amount
      let amount = null;
      for (let c = row.length - 1; c > acctIdx; c--) {
        const v = parseAmount(row[c]);
        if (v !== null) { amount = v; break; }
      }

      if (amount === null) { rowsRejected++; continue; }

      const accountName = rawName.replace(/^\s+/, '');
      const isTotal = /^total\b/i.test(accountName) || /\btotal$/i.test(accountName);

      rows.push({
        account_name: accountName,
        account_number: null,
        // Section comes from the last section-HEADER line actually seen above
        // this row in the document — never guessed from this row's own account
        // name when no header has appeared yet (see inferSection's doc comment).
        section: currentSection ? inferSection(currentSection) : null,
        sub_section: currentSection ? inferSubSection(currentSection) : null,
        amount,
        as_of_date: asOfDate,
        fiscal_year: fiscalYear,
        is_total: isTotal,
      });
    }

    this.logger.log(`  "${fileName}": Rows detected=${rowsDetected}, extracted=${rows.length}, rejected=${rowsRejected}`);
    if (!rows.length) throw new Error('No Balance Sheet data rows extracted from Excel file');

    return { rows, detectedYears: [fiscalYear] };
  }

  // ── Validation: lenient ─────────────────────────────────────────────────────
  async validateRows(rows) {
    let rejected = 0;
    const valid = rows.filter((row) => {
      if (!row.account_name?.trim()) { rejected++; return false; }
      // as_of_date and fiscal_year are always set by extract() — only check they're not garbage
      if (!row.as_of_date) { rejected++; return false; }
      if (!Number.isInteger(row.fiscal_year) || row.fiscal_year < 1900) { rejected++; return false; }
      return true;
    });
    if (rejected > 0) this.logger.warn(`validateRows: rejected ${rejected} rows`);
    return valid;
  }

  transformRows(rows, metadata) {
    return rows.map((row, idx) => ({
      version_id: metadata.versionId,
      company_id: metadata.companyId,
      source_file_id: metadata.documentId,

      as_of_date: row.as_of_date,
      fiscal_year: row.fiscal_year,

      account_name: row.account_name.trim(),
      account_number: row.account_number?.trim() || null,
      // account_type is never set at extraction time — it previously aliased
      // `section` directly (e.g. "assets", a plural section id, not a real
      // "asset" account_type value), which downstream code had to work around.
      // The only authoritative source of account_type is Gemini/COA classification.
      account_type: null,
      section: row.section || null,
      sub_section: row.sub_section || null,

      amount: Number(row.amount) || 0,

      hierarchy_level: row.is_section_header ? 0 : 1,
      sort_order: idx,
      is_total: Boolean(row.is_total),

      // Include documentId + the row's position so rows that share the same
      // account name, date, and amount (e.g. multiple 0.00 lines, or an account
      // repeated across sections) don't collapse to one hash and violate the
      // idx_balance_sheet_entries_hash unique constraint — which previously failed
      // the whole BS insert and halted generation. Mirrors the P&L row_hash.
      row_hash: this.computeRowHash({ versionId: metadata.versionId, documentId: metadata.documentId, accountName: row.account_name, asOfDate: row.as_of_date, amount: row.amount, sortOrder: idx }),
      extracted_at: new Date().toISOString(),
    }));
  }

  async insertRows(rows) {
    if (!rows.length) return { success: true };
    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      const { error } = await supabase.from('balance_sheet_entries').insert(chunk);
      if (error) {
        this.logger.error(`Insert chunk failed: ${error.message}`);
        return { success: false, error: error.message };
      }
    }
    this.logger.log(`Inserted ${rows.length} rows into balance_sheet_entries`);
    return { success: true };
  }
}

module.exports = new BalanceSheetExtractionService();
