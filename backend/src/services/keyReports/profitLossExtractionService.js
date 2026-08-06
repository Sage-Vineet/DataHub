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

// Recognizes the document's OWN bare section-header labels (a row with a label
// but no amount in any column) — the same literal-header-text approach as
// balanceSheetExtractionService's inferSection. This is universal P&L statement
// vocabulary, never an account-name keyword rule, and is used only to tag which
// section a row falls under for validation/reporting — never to build hierarchy.
const SECTION_HEADER_PATTERNS = [
  { key: 'revenue', re: /^(income|revenue|sales|total income|total revenue)$/i },
  { key: 'cost_of_sales', re: /^(cost of goods sold|cost of sales|cogs|total cost of goods sold|total cost of sales)$/i },
  { key: 'operating_expenses', re: /^(expenses|expense|operating expenses|total expenses|total operating expenses)$/i },
  // Root Cause 2 fix: these were previously unrecognized, so a row under one of
  // these real headers silently inherited whatever section came before it
  // (typically "Operating Expenses") — confirmed live: "Rental Income" and
  // "Interest Earned" both landed in operating_expenses and were later typed
  // as expense instead of income.
  {
    key: 'other_income',
    re: /^(other income|other revenue|interest income|interest earned|financial income|extraordinary income|total other income|total other revenue|net other income)$/i,
  },
  {
    key: 'other_expense',
    re: /^(other expense|other expenses|financial expense|financial expenses|extraordinary expense|extraordinary expenses|total other expense|total other expenses)$/i,
  },
];

function matchSectionHeader(label) {
  const norm = String(label || '').trim();
  if (!norm) return null;
  for (const { key, re } of SECTION_HEADER_PATTERNS) {
    if (re.test(norm)) return key;
  }
  return null;
}

// CONFIRMED ROOT CAUSE of a real production bug: a row's `section` used to
// come from `currentSection`, a single FLAT variable updated only when a
// header row's OWN text matched one of SECTION_HEADER_PATTERNS. That is
// fragile in two ways: (1) an intermediate header that ISN'T one of those
// literal patterns (e.g. "Payroll Expenses", "Store Expenses", "Department
// Expenses" — an arbitrary company-specific grouping) simply leaves
// currentSection unchanged, which only happens to be correct if no OTHER
// branch of the document was visited in between; (2) once the row-walk moves
// through a sibling branch under a DIFFERENT recognized header,
// currentSection is left pointing at that sibling's section — a later
// return to an unrecognized-header branch then inherits the WRONG section
// from wherever the walk last was, not from that row's own real ancestry.
// Confirmed live: expense/COGS accounts nested under a non-standard
// intermediate header came back with account_type = NULL.
//
// The fix: every row already carries its own real ancestor chain
// (`parentPath`, built from the document's own indentation — see
// ancestorStack below). Walking that chain from the ROOT (outermost, index 0)
// downward and taking the FIRST label that matches one of the same fixed
// anchors is self-contained per row — immune to sibling-branch pollution,
// and correct regardless of how many unrecognized intermediate headers sit
// between the leaf and its true section, since intermediate labels that
// don't match are simply skipped over, never assigned a type of their own.
// No new patterns, no regex beyond the existing SECTION_HEADER_PATTERNS, no
// hardcoded company-specific names.
function sectionFromAncestry(parentPath) {
  for (const label of parentPath || []) {
    const key = matchSectionHeader(label);
    if (key) return key;
  }
  return null;
}

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
    // Bump whenever SECTION_HEADER_PATTERNS or row-classification logic changes —
    // otherwise already-cached extractions (keyed by parser_version) keep serving
    // pre-fix section assignments forever. Bumped for Root Cause 2 (Other
    // Income/Other Expense section recognition).
    // v3: added parent_path (real N-level hierarchy read from the document's
    // own indentation, e.g. ["Expenses", "Payroll and Labor"]) — bump so
    // previously-cached parses (which lack this field) get re-extracted.
    // v4: header/group/subtotal rows are now preserved in `rows` (node_type:
    // hierarchy_section/hierarchy_group/subtotal/total/account) instead of
    // being silently dropped — bump again so cached parses get refreshed.
    // v5: `section` is now derived per-row from that row's own real ancestor
    // chain (sectionFromAncestry over parent_path) instead of a single flat
    // `currentSection` variable that could be polluted by a sibling branch or
    // left unset by a non-standard intermediate header — confirmed root
    // cause of P&L accounts (Expense/COGS nested under a company-specific
    // header) getting account_type=NULL. Also fixes the PDF/Gemini path,
    // which previously never produced a usable `section` at all. Bump so
    // every cached P&L parse — which carries the OLD, wrong section — is
    // re-extracted rather than serving stale NULLs forever.
    // v6: added a retry-and-sanity-check around the Python extraction call
    // (_extractFromExcelWithFallback) — a run that returns real leaf rows but
    // with EVERY parent_path empty is now retried once before being accepted,
    // since a transient bad run could otherwise get cached under the current
    // parser_version and silently persist. Bump so any such bad cached parse
    // is discarded and re-attempted with the new safeguard.
    // v7: CONFIRMED ROOT CAUSE — the ancestor stack (both this JS fallback and
    // extract_excel.py's Python primary path) pushed EVERY row, including a
    // real leaf/total/subtotal account with its own posted amount, onto the
    // parent_path stack. Whenever two sibling accounts' extracted indent
    // values weren't perfectly monotonic (common indent noise in real
    // exports), the first sibling was silently retained as the "parent" of
    // the second, corrupting Level 3+ in the generated Chart of Accounts.
    // Fixed: only header/group rows (no amount) may remain ancestors. Bump so
    // every previously-cached parse — which may carry a phantom leaf-as-
    // parent entry in parent_path — is re-extracted with the fix applied.
    this.parserVersion = 'v7';
  }

  async extract({ fileName, fileBuffer }) {
    const ext = (fileName || '').toLowerCase().split('.').pop();

    if (ext === 'pdf') {
      return this._extractFromPdf(fileBuffer, fileName);
    }
    return this._extractFromExcelWithFallback(fileBuffer, fileName);
  }

  // ── Excel: Python primary, JS fallback ─────────────────────────────────────
  // See balanceSheetExtractionService.js's identical method for the full
  // rationale — retries Python once before falling back to JS, and treats a
  // suspiciously flat result (real leaf rows but zero hierarchy) as worth
  // retrying too, not just an outright failure.
  _isExtractionSuspicious(rows) {
    const leafRows = (rows || []).filter((r) => !r.is_header && !r.is_total);
    const rowsWithParent = leafRows.filter((r) => Array.isArray(r.parent_path) && r.parent_path.length > 0);
    return leafRows.length > 3 && rowsWithParent.length === 0;
  }

  async _extractFromExcelWithFallback(fileBuffer, fileName) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const suffix = attempt > 1 ? ` (retry ${attempt})` : '';
      try {
        this.logger.log(`Trying Python extraction for Excel "${fileName}"${suffix}`);
        const result = await extractWithPython('extract_excel.py', fileBuffer, {
          type: 'profit_loss',
          filename: fileName,
        });
        if (result.rows && result.rows.length > 0) {
          const suspiciouslyFlat = this._isExtractionSuspicious(result.rows);
          if (suspiciouslyFlat && attempt === 1) {
            this.logger.warn(
              `Python extraction for "${fileName}" returned ${result.rows.length} row(s) with NO hierarchy ` +
              `at all (every parent_path empty) — suspicious for a real P&L, retrying once before accepting it.`,
            );
            continue;
          }
          if (suspiciouslyFlat) {
            this.logger.warn(
              `Python extraction for "${fileName}" is STILL flat after a retry — accepting it (no better source ` +
              `available) but this will be re-checked and re-extracted on the next sync instead of being trusted ` +
              `from cache.`,
            );
          }
          this.logger.log(`Python extracted ${result.rows.length} rows from "${fileName}"`);
          return { rows: result.rows, detectedYears: result.detected_years };
        }
        this.logger.warn(`Python returned 0 rows for "${fileName}"${attempt < 2 ? ', retrying' : ', falling back to JS'}`);
      } catch (err) {
        this.logger.warn(`Python extraction failed for "${fileName}"${attempt < 2 ? ', retrying' : ', falling back to JS'}: ${err.message}`);
      }
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
      account_type: null,
      // CONFIRMED BUG (fixed here): this used to be `node._section || null`
      // written into `account_type` directly — node._section is just the
      // RAW text of the nearest enclosing header (e.g. "Payroll and Labor"),
      // never a canonical revenue/cost_of_sales/expense key, and
      // buildDocHierarchyLookups (chartOfAccountsService.js) reads `.section`
      // via plSectionToType, not `.account_type` — so every PDF-sourced P&L
      // row reached the COA generator with a meaningless account_type and no
      // usable section at all. Same ancestry-walk fix as the Excel path:
      // node._parent_path is Gemini's own real ancestor chain (see
      // flattenGeminiRows), walked from the root for the first recognized
      // anchor — intermediate non-matching headers are simply skipped over.
      section: sectionFromAncestry(node._parent_path),
      // Gemini's own nested tree, flattened to its full ancestor chain (see
      // flattenGeminiRows) — e.g. ["Expenses", "Payroll and Labor"].
      parent_path: node._parent_path || [],
      amount: node.amount || 0,
      fiscal_year: fiscalYear,
      is_total: node.type === 'total',
      is_header: node.type === 'header',
      node_type: node.type === 'header'
        ? (matchSectionHeader(node.name) ? 'hierarchy_section' : 'hierarchy_group')
        : node.type === 'total'
          ? (/^(gross profit|net operating income|net other income|operating income|net income|net loss)$/i.test(String(node.name || '').trim()) ? 'subtotal' : 'total')
          : 'account',
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
    // Tracks which bare section header (Revenue / Cost of Sales / Operating
    // Expenses) we're currently under, per the document's OWN structure — used
    // only to tag rows for later validation, never to build hierarchy.
    let currentSection = null;

    // Real multi-level hierarchy, read from the document's own indentation —
    // same stack discipline as balanceSheetExtractionService.js: a row whose
    // indent is <= the stack's top pops it, so what's left is that row's real
    // ancestor chain, however deep (e.g. ["Expenses", "Payroll and Labor"]).
    // A bare header row (no amount) still pushes onto the stack — it never
    // becomes its own data row, but real accounts nested under it must still
    // see it as an ancestor.
    const ancestorStack = [];

    for (let i = headerIdx + 1; i < raw.length; i++) {
      const row = raw[i];
      const cellRaw = String(row[acctIdx] ?? '');
      const accountName = cellRaw.trim();
      if (!accountName) continue; // blank label → skip

      const indent = (cellRaw.match(/^[ \t]*/)[0] || '').replace(/\t/g, '    ').length;
      while (ancestorStack.length && ancestorStack[ancestorStack.length - 1].indent >= indent) ancestorStack.pop();
      const parentPath = ancestorStack.map((a) => a.label);

      const isTotal = /^total\b/i.test(accountName) || /\btotal$/i.test(accountName) || /\bnet income\b/i.test(accountName);
      // A computed statement-level subtotal (as opposed to a "Total for X"
      // group rollup) — the document's own literal label, never guessed.
      // Computed statement lines, by the document's own literal label. Extending
      // this list keeps a roll-up row from being mistaken for a posting account
      // (which would give it a COA leaf and a system id). Statement-line
      // vocabulary only -- never an account name.
      const isSubtotal = /^(gross profit|gross margin|net operating income|operating income|net other income|pretax income|pre-tax income|income before taxes|profit before tax(?:es)?|net income|net loss|profit for the year)$/i.test(accountName);

      // A bare section-header row has a label but no amount in ANY column and
      // isn't itself a total line — e.g. "Income", "Cost of Goods Sold".
      const hasAnyAmount = yearCols.length > 0
        ? yearCols.some(({ colIdx }) => parseAmount(row[colIdx]) !== null)
        : row.slice(acctIdx + 1).some((v) => parseAmount(v) !== null);
      if (!hasAnyAmount && !isTotal) {
        const headerKey = matchSectionHeader(accountName);
        ancestorStack.push({ indent, label: accountName });
        if (headerKey) currentSection = headerKey;
        // Preserved (never silently dropped) so the full document hierarchy
        // reaches the COA generator — recognized (headerKey) or not (e.g. an
        // arbitrary group like "Payroll and Labor"), same node_type
        // convention as balanceSheetExtractionService.js. P&L has no
        // persisted table (never reaches filterRowsBeforeInsertion), so this
        // is purely additive; keyReportSyncService's plAccountRows already
        // filters out is_header rows before they reach COA leaf-building.
        const headerYears = yearCols.length > 0 ? yearCols.map((yc) => yc.year) : [fiscalYears[0].year];
        for (const year of headerYears) {
          rows.push({
            account_name: accountName,
            account_type: null,
            section: headerKey || sectionFromAncestry(parentPath) || currentSection,
            parent_path: parentPath,
            amount: 0,
            fiscal_year: year,
            is_total: false,
            is_header: true,
            node_type: headerKey ? 'hierarchy_section' : 'hierarchy_group',
          });
        }
        continue;
      }

      rowsDetected++;

      if (yearCols.length > 0) {
        // Multi-year: emit one row per year column
        for (const { colIdx, year } of yearCols) {
          const amount = parseAmount(row[colIdx]);
          if (amount === null && !isTotal) { rowsRejected++; continue; }
          rows.push({
            account_name: accountName,
            account_type: null,
            section: sectionFromAncestry(parentPath) || currentSection,
            parent_path: parentPath,
            amount: amount ?? 0,
            fiscal_year: year,
            is_total: isTotal,
            is_header: false,
            node_type: isSubtotal ? 'subtotal' : isTotal ? 'total' : 'account',
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
          section: sectionFromAncestry(parentPath) || currentSection,
          parent_path: parentPath,
          amount,
          fiscal_year: year,
          is_total: isTotal,
          is_header: false,
          node_type: isSubtotal ? 'subtotal' : isTotal ? 'total' : 'account',
        });
      }
      // CONFIRMED ROOT CAUSE (fixed here, mirrors balanceSheetExtractionService.js
      // / extract_excel.py's identical fix): a leaf/total/subtotal row — one
      // with its own posted amount — must never be pushed onto the ancestor
      // stack. Only the header/group branch above (which `continue`s before
      // reaching here) may remain a parent for later rows.
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
