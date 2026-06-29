/**
 * Profit & Loss Extraction Service
 *
 * Supports:
 *  - QuickBooks Online / Desktop Excel exports (multi-header rows, indented accounts)
 *  - Generic P&L Excel/CSV files
 *  - PDF reports via Gemini (parsePdfWithGemini)
 *  - Multi-year columns (one row per year per account)
 *
 * Strategy:
 *  1. Read raw as array-of-arrays (header:1 mode) so we control header detection.
 *  2. Scan first 20 rows to find the "header row" (has period/year/Total labels).
 *  3. Extract fiscal year(s) from the title area or column headers.
 *  4. Parse every row where col 0 has a non-empty label → account row.
 *  5. For PDF files fall back to Gemini.
 *  6. Warnings never block inserts — only DB constraint violations do.
 */

const XLSX = require('xlsx');
const { supabase } = require('../../db');
const ExtractionServiceBase = require('./extractionService.base');
const { parsePdfWithGemini, flattenGeminiRows } = require('../geminiFinancialParser');
const { extractWithPython, detectPdfType } = require('./pythonBridge');

// Broad aliases covering QBO / QBD / generic exports
const ACCOUNT_ALIASES  = ['account', 'account name', 'name', 'description', 'account description', 'label', 'item', 'category', 'line item'];
const AMOUNT_ALIASES   = ['total', 'amount', 'balance', 'value', 'net', 'ytd', 'annual', 'fiscal year total'];
const YEAR_PATTERN     = /\b(20\d{2}|19\d{2})\b/;
const PERIOD_LABEL_RE  = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|q[1-4]|total|ytd|annual|20\d{2}|19\d{2})\b/i;

function lc(v) { return String(v || '').toLowerCase().trim(); }

function parseAmount(v) {
  if (v === '' || v == null) return null;
  const s = String(v).replace(/[$,\s]/g, '');
  if (/^\([\d.]+\)$/.test(s)) return -(parseFloat(s.slice(1, -1)) || 0);
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

function extractYearFromText(text) {
  const m = String(text).match(YEAR_PATTERN);
  return m ? parseInt(m[1], 10) : null;
}

/** Find col index that best matches one of the alias lists */
function findCol(headers, aliases) {
  for (let i = 0; i < headers.length; i++) {
    const h = lc(headers[i]);
    if (aliases.some((a) => h === a || h.includes(a))) return i;
  }
  return -1;
}

/** Score a row for how likely it is to be the column header row */
function headerScore(row) {
  let score = 0;
  for (const cell of row) {
    if (PERIOD_LABEL_RE.test(String(cell || ''))) score += 2;
    if (ACCOUNT_ALIASES.some((a) => lc(cell).includes(a))) score += 3;
    if (AMOUNT_ALIASES.some((a) => lc(cell) === a || lc(cell).includes(a))) score += 2;
  }
  return score;
}

/** Extract fiscal years from rows above the data (report title rows).
 *  Inclusive upper bound (fixes JS bug where headerIdx was exclusive,
 *  causing QBO files with the year on the header row itself to fall back). */
function extractYearsFromTitleRows(rawRows, upToIdx) {
  const years = new Set();
  // upToIdx + 1 so the header row itself is scanned (inclusive)
  for (let i = 0; i <= upToIdx && i < 15; i++) {
    for (const cell of rawRows[i]) {
      const y = extractYearFromText(String(cell || ''));
      if (y && y >= 1990 && y <= 2035) years.add(y);
    }
  }
  return Array.from(years).sort((a, b) => a - b);
}

/** Extract years from the header row columns (e.g., "2022", "2023", "2024") */
function extractYearsFromHeaderRow(headerRow) {
  const years = [];
  for (let i = 1; i < headerRow.length; i++) {
    const y = extractYearFromText(String(headerRow[i] || ''));
    if (y && y >= 1990 && y <= 2035) years.push({ colIdx: i, year: y });
  }
  return years;
}

class ProfitLossExtractionService extends ExtractionServiceBase {
  constructor() {
    super('profit_loss', 'profit_loss_entries');
  }

  async extract({ fileName, fileBuffer }) {
    const ext = (fileName || '').toLowerCase().split('.').pop();

    if (ext === 'pdf') {
      return this._extractFromPdf(fileBuffer, fileName);
    }
    return this._extractFromExcelWithFallback(fileBuffer, fileName);
  }

  // ── Excel: Python primary, JS fallback ─────────────────────────────────────
  async _extractFromExcelWithFallback(fileBuffer, fileName) {
    try {
      this.logger.log(`Trying Python extraction for Excel "${fileName}"`);
      const result = await extractWithPython('extract_excel.py', fileBuffer, {
        type: 'profit_loss',
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
        type: 'profit_loss',
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

    let fiscalYear = new Date().getFullYear();
    if (geminiResult.periodEnd) fiscalYear = new Date(geminiResult.periodEnd).getFullYear() || fiscalYear;
    else if (geminiResult.periodStart) fiscalYear = new Date(geminiResult.periodStart).getFullYear() || fiscalYear;

    const rows = flatNodes.map((node) => ({
      account_name: node.name,
      account_type: node._section || null,
      amount: node.amount || 0,
      fiscal_year: fiscalYear,
      is_total: node.type === 'total',
      is_header: node.type === 'header',
    }));

    this.logger.log(`PDF "${fileName}": ${rows.length} rows from Gemini (fiscal_year=${fiscalYear})`);
    return { rows, detectedYears: [fiscalYear] };
  }

  // ── Excel / CSV ─────────────────────────────────────────────────────────────
  async _extractFromExcel(fileBuffer, fileName) {
    const workbook = XLSX.read(fileBuffer, { type: 'buffer', cellDates: false });

    // Try named sheets first; fall back to first sheet
    const sheetName =
      workbook.SheetNames.find((n) => /income|profit|p&l|pl|earnings|revenue/i.test(n)) ||
      workbook.SheetNames[0];
    const ws = workbook.Sheets[sheetName];

    // Raw array-of-arrays so we can detect the header row ourselves
    const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    if (!raw || raw.length < 2) throw new Error('No data found in P&L sheet');

    this.logger.log(`Sheet "${sheetName}" in "${fileName}": ${raw.length} raw rows`);

    // Find header row: best scoring row in first 20
    let headerIdx = 0;
    let bestScore = 0;
    for (let i = 0; i < Math.min(20, raw.length); i++) {
      const s = headerScore(raw[i]);
      if (s > bestScore) { bestScore = s; headerIdx = i; }
    }
    this.logger.log(`  Header row at index ${headerIdx} (score=${bestScore}): ${JSON.stringify(raw[headerIdx]).slice(0, 100)}`);

    const headerRow = raw[headerIdx];

    // Check if the header row actually has useful year/column data.
    // If not (bestScore < 2), we just use positional logic.
    const yearCols = extractYearsFromHeaderRow(headerRow); // e.g. [{colIdx:1, year:2022}, {colIdx:2, year:2023}]
    const titleYears = extractYearsFromTitleRows(raw, headerIdx);

    // Determine the set of years we'll emit rows for
    let fiscalYears;
    if (yearCols.length > 0) {
      fiscalYears = yearCols; // multi-year columns
    } else {
      // Single-year: guess from title rows or current year
      const guessYear = titleYears[titleYears.length - 1] || new Date().getFullYear();
      fiscalYears = [{ colIdx: -1, year: guessYear }];
    }

    // Find the account label column: prefer col 0, but check header aliases
    const acctIdx = Math.max(0, findCol(headerRow, ACCOUNT_ALIASES));

    this.logger.log(`  Account col=${acctIdx}, year columns=${JSON.stringify(fiscalYears)}`);

    const rows = [];
    let rowsDetected = 0, rowsRejected = 0;

    for (let i = headerIdx + 1; i < raw.length; i++) {
      const row = raw[i];
      const rawName = String(row[acctIdx] || '').trim();
      if (!rawName) continue; // blank label → skip

      rowsDetected++;
      const accountName = rawName.replace(/^\s+/, ''); // strip indent spaces
      const isTotal = /^total\b/i.test(accountName) || /\btotal$/i.test(accountName) || /\bnet income\b/i.test(accountName);

      if (yearCols.length > 0) {
        // Multi-year: emit one row per year column
        for (const { colIdx, year } of yearCols) {
          const amount = parseAmount(row[colIdx]);
          if (amount === null && !isTotal) { rowsRejected++; continue; }
          rows.push({
            account_name: accountName,
            account_type: null,
            amount: amount ?? 0,
            fiscal_year: year,
            is_total: isTotal,
            is_header: false,
          });
        }
      } else {
        // Single-year: use the last numeric value in the row as the amount
        const year = fiscalYears[0].year;
        let amount = null;

        // Walk columns right-to-left to find the last numeric value
        for (let c = row.length - 1; c > acctIdx; c--) {
          const v = parseAmount(row[c]);
          if (v !== null) { amount = v; break; }
        }

        if (amount === null) { rowsRejected++; continue; }
        rows.push({
          account_name: accountName,
          account_type: null,
          amount,
          fiscal_year: year,
          is_total: isTotal,
          is_header: false,
        });
      }
    }

    this.logger.log(`  "${fileName}": Rows detected=${rowsDetected}, extracted=${rows.length}, rejected=${rowsRejected}`);
    if (!rows.length) throw new Error('No P&L data rows extracted from Excel file');

    const detectedYears = [...new Set(rows.map((r) => r.fiscal_year))].sort((a, b) => a - b);
    return { rows, detectedYears };
  }

  // ── Validation: lenient — only reject rows that would violate NOT NULL constraints ──
  async validateRows(rows) {
    let rejected = 0;
    const valid = rows.filter((row) => {
      if (!row.account_name || !row.account_name.trim()) { rejected++; return false; }
      if (!Number.isInteger(row.fiscal_year) || row.fiscal_year < 1900) { rejected++; return false; }
      return true;
    });
    if (rejected > 0) this.logger.warn(`validateRows: rejected ${rejected} rows (missing account_name or fiscal_year)`);
    return valid;
  }

  transformRows(rows, metadata) {
    return rows.map((row, idx) => ({
      version_id: metadata.versionId,
      company_id: metadata.companyId,
      source_file_id: metadata.documentId,

      fiscal_year: row.fiscal_year,
      account_name: row.account_name.trim(),
      account_number: row.account_number?.trim() || null,
      account_type: row.account_type?.trim() || null,
      category: null,
      sub_category: null,

      amount: Number(row.amount) || 0,

      hierarchy_level: row.is_header ? 0 : 1,
      parent_account_id: null,
      sort_order: idx,

      is_total: Boolean(row.is_total),

      row_hash: this.computeRowHash({ versionId: metadata.versionId, documentId: metadata.documentId, accountName: row.account_name, fiscalYear: row.fiscal_year, amount: row.amount, sortOrder: idx }),
      extracted_at: new Date().toISOString(),
    }));
  }

  async insertRows(rows) {
    return this.insertRowsChunked('profit_loss_entries', rows);
  }
}

module.exports = new ProfitLossExtractionService();
