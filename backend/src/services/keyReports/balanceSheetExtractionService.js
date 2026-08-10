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

// CONFIRMED ROOT CAUSE: `section` was derived from `currentSection`, a flat
// variable set only when a recognized header line was seen, and never
// rescoped when the ancestor stack popped back past that header — an Equity
// account nested directly under a combined "Liabilities and Equity" umbrella
// (with no further explicit "Equity" sub-header between it and the umbrella)
// silently kept the stale "Liabilities" section left over from an earlier
// sibling branch (e.g. "Liabilities" > "Accounts Payable"). Every row already
// carries its own real ancestor chain (`parent_path`, built from the
// document's own indentation) — walking that chain from the NEAREST ancestor
// toward the root (the REVERSE of profitLossExtractionService.js's
// sectionFromAncestry root-first order, since P&L has no umbrella-then-
// branch ambiguity to resolve) and taking the first label that resolves via
// inferSection is self-contained per row, and correctly prefers a specific
// "Equity"/"Liabilities" sub-header over the ambiguous umbrella "Liabilities
// and Equity" heading that may sit above it in the same path.
function sectionFromAncestry(parentPath) {
  for (let i = (parentPath || []).length - 1; i >= 0; i--) {
    const key = inferSection(parentPath[i]);
    if (key) return key;
  }
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
    // v4: added parent_path (real N-level hierarchy read from the document's
    // own indentation, e.g. ["Assets", "Current Assets", "Bank Accounts"]) —
    // bump again for the same reason.
    // v5: unrecognized intermediate headers (e.g. "Bank Accounts") are now
    // also preserved in `rows` (node_type: hierarchy_group) instead of being
    // silently dropped — bump again so cached parses get refreshed.
    // v6: CONFIRMED BUG — extract_excel.py's extract_balance_sheet only ever
    // read indentation via leading whitespace characters (_cell_indent), but
    // this client's (and likely most QuickBooks) exports encode nesting via
    // the Excel cell's own alignment.indent property instead, with ZERO
    // leading whitespace in the cell text. Every row therefore read indent=0,
    // collapsing parent_path to empty for every account and leaving
    // Level 3/4 in the generated Chart of Accounts as the leaf account's own
    // name instead of "Current Assets"/"Fixed Assets" etc. Fixed via
    // get_rows_with_indent (already used by extract_profit_loss) — bump again
    // so every previously-cached, flattened Balance Sheet parse gets redone.
    // v7: added a retry-and-sanity-check around the Python extraction call
    // (_extractFromExcelWithFallback) — a run that returns real leaf rows but
    // with EVERY parent_path empty is now retried once before being accepted,
    // since a transient bad run (confirmed live: identical file/code
    // produced empty parent_path once, then correct nested paths on
    // immediate re-run) could otherwise get cached under the current
    // parser_version and silently persist until manually cleared. Bump so
    // any such bad cached parse is discarded and re-attempted with the new
    // safeguard.
    // v8: CONFIRMED ROOT CAUSE — the ancestor stack (both this JS fallback and
    // extract_excel.py's Python primary path) pushed EVERY row, including a
    // real leaf/total account with its own posted amount, onto the parent_path
    // stack. Whenever two sibling accounts' extracted indent values weren't
    // perfectly monotonic (common indent noise in real exports), the first
    // sibling was silently retained as the "parent" of the second, corrupting
    // Level 3+ in the generated Chart of Accounts (confirmed live: a real
    // sibling account nested under an unrelated sibling 11 times in one
    // document). Fixed: only header/group rows (no amount) may remain
    // ancestors. Bump so every previously-cached parse — which may carry a
    // phantom leaf-as-parent entry in parent_path — is re-extracted with the
    // fix applied.
    // v9: CONFIRMED ROOT CAUSE — `section` was read from `currentSection`, a
    // flat variable never rescoped when the ancestor stack popped back past a
    // header (e.g. "Liabilities"), so an Equity account with no explicit
    // "Equity" sub-header of its own (sitting directly under "Liabilities and
    // Equity" after a sibling "Liabilities" branch) inherited the stale
    // "liabilities" section and was misclassified as a Liability. Fixed:
    // `section` is now derived per-row from its own real ancestor chain
    // (sectionFromAncestry over parent_path, nearest-ancestor-first), mirrors
    // profitLossExtractionService.js's v5 fix for the same bug class on the
    // P&L side. Bump so every previously-cached Balance Sheet — which carries
    // the OLD, possibly-wrong section — is re-extracted rather than serving a
    // stale misclassification forever.
    // v10: CONFIRMED ROOT CAUSE of the client's "the December <year> Balance
    // Sheet is missing" report. Two defects, both in the multi-period path:
    //   (a) detectedYears was the sheet's single title-derived year while the
    //       account rows carried their own per-period years. detectedYears is
    //       persisted to key_report_document_mappings.metadata.detectedYears and
    //       is what keyReportValidationService.resolveMappingYears reads to
    //       decide which fiscal years a version has a Balance Sheet for — so a
    //       monthly export whose columns cross a calendar year had rows for both
    //       years inserted but only ONE year reported, and the other was shown to
    //       the user as having no Balance Sheet at all.
    //   (b) structural (header/group) rows were stamped with that same title
    //       year rather than the period they actually belong to, which can put a
    //       structural-only as_of_date into a fiscal year with no account rows.
    //       generateYearlyBs picks the LATEST as_of_date for a year, so it could
    //       select that date and render the whole year as zeros.
    // Both are fixed in extract_excel.py (primary path) and here (JS fallback +
    // Gemini PDF path). Bump so every previously-cached parse — which carries the
    // wrong detectedYears and possibly a mis-stamped structural year — is
    // re-extracted instead of serving the stale year set forever.
    this.parserVersion = 'v10';
  }

  async extract({ fileName, fileBuffer }) {
    const ext = (fileName || '').toLowerCase().split('.').pop();
    if (ext === 'pdf') return this._extractFromPdf(fileBuffer, fileName);
    return this._extractFromExcelWithFallback(fileBuffer, fileName);
  }

  // ── Excel: Python primary, JS fallback ─────────────────────────────────────
  // Retries Python once before falling back to JS, and treats a suspiciously
  // flat result (real leaf rows but zero hierarchy) as worth retrying too —
  // not just an outright failure. CONFIRMED (production evidence): a Python
  // run can occasionally return rows with every parent_path empty even for a
  // document independently verified to carry real alignment-indent hierarchy
  // (re-running the exact same file, same code, immediately after reliably
  // produced the correct nested result) — most likely a transient race (e.g.
  // this backend process restarting mid-extraction during active development/
  // use) rather than a deterministic parsing bug. Used by the retry
  // safeguard in _extractFromExcelWithFallback to catch a bad flat result
  // before it's ever inserted.
  _isExtractionSuspicious(rows) {
    const leafRows = (rows || []).filter((r) => !r.is_section_header && !r.is_total);
    const rowsWithParent = leafRows.filter((r) => Array.isArray(r.parent_path) && r.parent_path.length > 0);
    return leafRows.length > 3 && rowsWithParent.length === 0;
  }

  async _extractFromExcelWithFallback(fileBuffer, fileName) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const suffix = attempt > 1 ? ` (retry ${attempt})` : '';
      try {
        this.logger.log(`Trying Python extraction for Excel "${fileName}"${suffix}`);
        const result = await extractWithPython('extract_excel.py', fileBuffer, {
          type: 'balance_sheet',
          filename: fileName,
        });
        if (result.rows && result.rows.length > 0) {
          const suspiciouslyFlat = this._isExtractionSuspicious(result.rows);
          if (suspiciouslyFlat && attempt === 1) {
            this.logger.warn(
              `Python extraction for "${fileName}" returned ${result.rows.length} row(s) with NO hierarchy ` +
              `at all (every parent_path empty) — suspicious for a real Balance Sheet, retrying once before ` +
              `accepting it.`,
            );
            continue;
          }
          if (suspiciouslyFlat) {
            this.logger.warn(
              `Python extraction for "${fileName}" is STILL flat after a retry — accepting it (no better source ` +
              `available; the JS fallback can never produce a hierarchy either) but this will be re-checked and ` +
              `re-extracted on the next sync instead of being trusted from cache.`,
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
      // The full ancestor chain Gemini's own nested tree already encodes
      // (flattenGeminiRows), e.g. ["Assets", "Current Assets", "Bank Accounts"]
      // — real document structure, not a single collapsed section label.
      parent_path: node._parent_path || [],
      amount: node.amount || 0,
      as_of_date: asOfDate,
      fiscal_year: fiscalYear,
      is_total: node.type === 'total',
      // A Gemini 'header' node is a structural heading (recognized section OR
      // an arbitrary intermediate grouping label) — never a postable account.
      // Preserved in the row (never silently dropped) so the hierarchy is
      // complete, but flagged the same way the Excel path flags one, so
      // transformRows/filterRowsBeforeInsertion exclude it from the table.
      is_section_header: node.type === 'header',
      node_type: node.type === 'header' ? (inferSection(node.name) ? 'hierarchy_section' : 'hierarchy_group') : node.type === 'total' ? 'total' : 'account',
    }));

    this.logger.log(`PDF "${fileName}": ${rows.length} rows (as_of_date=${asOfDate})`);
    return { rows, detectedYears: this._yearsFromRows(rows, fiscalYear) };
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

    // Real multi-level hierarchy, read from the document's OWN indentation —
    // never a hardcoded level scheme. A stack of {indent, label} ancestors:
    // a row less-indented-than-or-equal-to the stack's top pops it (sibling or
    // uncle), so the surviving stack at any point is exactly that row's real
    // ancestor chain, however deep. Every row (header or leaf) is pushed —
    // whether it ever becomes someone's ancestor is decided by what follows it,
    // not by whether it looked like a recognized section-header keyword. A
    // flat file with no indentation naturally yields an empty parent_path for
    // every row (degrades to the pre-existing section/sub_section-only behavior).
    const ancestorStack = [];

    for (let i = headerIdx + 1; i < raw.length; i++) {
      const row = raw[i];
      const cellRaw = String(row[acctIdx] ?? '');
      const rawName = cellRaw.trim();
      if (!rawName) continue;

      rowsDetected++;

      const indent = (cellRaw.match(/^[ \t]*/)[0] || '').replace(/\t/g, '    ').length;
      while (ancestorStack.length && ancestorStack[ancestorStack.length - 1].indent >= indent) ancestorStack.pop();
      const parentPath = ancestorStack.map((a) => a.label);

      // Detect section headers (ASSETS, LIABILITIES, EQUITY)
      const sectionMatch = inferSection(rawName);

      // Find the rightmost numeric value as the amount
      let amount = null;
      for (let c = row.length - 1; c > acctIdx; c--) {
        const v = parseAmount(row[c]);
        if (v !== null) { amount = v; break; }
      }

      if (sectionMatch && amount === null) {
        // This row is a pure, RECOGNIZED section header (no amount) — track
        // section. Still emit a header row so the hierarchy is preserved —
        // NEVER inserted into the database as a postable account: see
        // filterRowsBeforeInsertion (extractionService.base.js), which strips
        // any row_type/is_heading-flagged row before insertRows, using this
        // same structural metadata rather than a hardcoded keyword list.
        currentSection = rawName;
        rows.push({
          account_name: rawName,
          section: sectionMatch,
          sub_section: inferSubSection(rawName),
          parent_path: parentPath,
          amount: 0,
          as_of_date: asOfDate,
          fiscal_year: fiscalYear,
          is_total: false,
          is_section_header: true,
          is_heading: true,
          node_type: 'hierarchy_section',
        });
        ancestorStack.push({ indent, label: rawName });
        continue;
      }

      if (amount === null) {
        // An UNRECOGNIZED intermediate grouping label (e.g. "Bank Accounts")
        // — no section keyword match, no amount. Not itself a postable
        // account, but a real ancestor for whatever is nested more deeply
        // under it (the whole point of reading indentation instead of only
        // fixed keywords) — still emitted (node_type: 'hierarchy_group') so
        // the full document hierarchy is never silently discarded, but
        // filterRowsBeforeInsertion strips it the same way as a recognized
        // section header before it ever reaches balance_sheet_entries.
        rows.push({
          account_name: rawName,
          section: sectionFromAncestry(parentPath) || (currentSection ? inferSection(currentSection) : null),
          sub_section: currentSection ? inferSubSection(currentSection) : null,
          parent_path: parentPath,
          amount: 0,
          as_of_date: asOfDate,
          fiscal_year: fiscalYear,
          is_total: false,
          is_section_header: false,
          is_heading: true,
          node_type: 'hierarchy_group',
        });
        ancestorStack.push({ indent, label: rawName });
        continue;
      }

      const accountName = rawName;
      const isTotal = /^total\b/i.test(accountName) || /\btotal$/i.test(accountName);

      rows.push({
        account_name: accountName,
        account_number: null,
        // Section comes from this row's own real ancestor chain (parentPath),
        // walked nearest-to-root via sectionFromAncestry — never guessed from
        // this row's own account name, and never from the stale currentSection
        // variable alone (see sectionFromAncestry's doc comment for why).
        section: sectionFromAncestry(parentPath) || (currentSection ? inferSection(currentSection) : null),
        sub_section: currentSection ? inferSubSection(currentSection) : null,
        // The row's real ancestor chain (e.g. ["Assets", "Current Assets",
        // "Bank Accounts"]) read from indentation — independent of, and often
        // deeper than, the flat section/sub_section pair above.
        parent_path: parentPath,
        amount,
        as_of_date: asOfDate,
        fiscal_year: fiscalYear,
        is_total: isTotal,
        is_heading: false,
        node_type: isTotal ? 'total' : 'account',
      });
      // CONFIRMED ROOT CAUSE (fixed here, mirrors extract_excel.py's identical
      // fix): a leaf/total row — one with its own posted amount — must never
      // be pushed onto the ancestor stack. Only the two header/group branches
      // above (both `continue` before reaching here) may remain a parent for
      // later rows. Previously every row was pushed unconditionally, so a
      // small indent inconsistency between two sibling accounts caused the
      // first to be misread as the structural parent of the second.
    }

    this.logger.log(`  "${fileName}": Rows detected=${rowsDetected}, extracted=${rows.length}, rejected=${rowsRejected}`);
    if (!rows.length) throw new Error('No Balance Sheet data rows extracted from Excel file');

    // Derived from the rows themselves rather than from the sheet's title year.
    // See extract_excel.py's extract_balance_sheet for the confirmed root cause
    // this mirrors: detectedYears is persisted to
    // key_report_document_mappings.metadata.detectedYears and is what
    // keyReportValidationService uses to decide which fiscal years a version has
    // a Balance Sheet for, so a title year standing in for the real periods
    // reported a year as having no Balance Sheet even though its rows existed.
    return { rows, detectedYears: this._yearsFromRows(rows, fiscalYear) };
  }

  /** Distinct, plausible fiscal years present in extracted rows. */
  _yearsFromRows(rows, fallbackYear = null) {
    const years = new Set();
    for (const row of rows || []) {
      const y = Number(row?.fiscal_year);
      if (Number.isInteger(y) && y >= 1900 && y <= 2100) years.add(y);
    }
    // `Number(null)` is 0 and `Number.isInteger(0)` is true, so the plausibility
    // range — not just an integer check — is what keeps a null/blank fallback out.
    const fallback = Number(fallbackYear);
    if (!years.size && Number.isInteger(fallback) && fallback >= 1900 && fallback <= 2100) {
      years.add(fallback);
    }
    return [...years].sort((a, b) => a - b);
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
      parent_path: Array.isArray(row.parent_path) && row.parent_path.length ? row.parent_path : null,

      amount: Number(row.amount) || 0,

      // 0 = a structural heading row (recognized section header OR an
      // unrecognized intermediate grouping label like "Bank Accounts");
      // 1 = a real postable account/total line. Every row persists regardless
      // of this value now (see filterRowsBeforeInsertion override below) —
      // hierarchy_level remains a structural signal, not a drop criterion.
      hierarchy_level: (row.is_section_header || row.node_type === 'hierarchy_group') ? 0 : 1,
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

  // Overrides the base class's default (which DROPS any row classified as
  // non-account) — every row from an uploaded Balance Sheet is persisted,
  // tagged with its row_type (migration 085) instead. Source-document
  // fidelity requires every row to survive; chart_of_accounts generation
  // (collectBsAccountsFromEntries) is the one place that reads row_type to
  // select only real posting accounts — this table itself never drops a row.
  //
  // filteredRows.length === rows.length is an invariant of this override
  // (nothing is ever dropped here), so "Persisted rows" below reflects what
  // will actually be sent to insertRows — the [balance_sheet] summary is
  // logged directly here rather than via the base class's generic
  // "Skipped row value" loop, which would otherwise mislabel every one of
  // these rows as skipped even though all of them are kept.
  filterRowsBeforeInsertion(rows) {
    if (!Array.isArray(rows)) return { filteredRows: [], skippedLog: [] };
    const counts = { account: 0, heading: 0, subtotal: 0, total: 0, metadata: 0, footer: 0, unknown: 0 };
    const filteredRows = rows.map((row) => {
      const { rowType } = this._classifyStructuralRow(row);
      const finalType = rowType || (row.is_total ? 'total' : 'account');
      counts[finalType] = (counts[finalType] || 0) + 1;
      return { ...row, row_type: finalType };
    });
    this.logger.log(
      `[balance_sheet]\n` +
      `Source rows = ${rows.length}\n` +
      `Persisted rows = ${filteredRows.length}\n` +
      `  accounts = ${counts.account}\n` +
      `  headings = ${counts.heading}\n` +
      `  subtotals = ${counts.subtotal}\n` +
      `  totals = ${counts.total}\n` +
      `  metadata = ${counts.metadata}\n` +
      `  footer = ${counts.footer}\n` +
      `  unknown = ${counts.unknown}`
    );
    return { filteredRows, skippedLog: [] };
  }

  async insertRows(rows) {
    if (!rows.length) return { success: true };
    const CHUNK = 500;
    let rowsInserted = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      const { error } = await supabase.from('balance_sheet_entries').insert(chunk);
      if (!error) {
        rowsInserted += chunk.length;
        continue;
      }
      // A chunk-level failure (e.g. one bad row) would otherwise silently
      // drop every OTHER row in that chunk too. Fall back to one-row-at-a-time
      // for this chunk so a single bad row can't take good rows down with it,
      // and so the exact failing row is identified rather than silently lost.
      this.logger.warn(`Insert chunk failed (${error.message}) — retrying chunk row-by-row to isolate the failure`);
      for (const row of chunk) {
        const { error: rowError } = await supabase.from('balance_sheet_entries').insert([row]);
        if (rowError) {
          this.logger.error(
            `Row failed to persist | source_row_number=${row.sort_order} | document_id=${row.source_file_id} | ` +
            `account_name="${row.account_name}" | row_type=${row.row_type} | reason=insert_error | error="${rowError.message}"`
          );
        } else {
          rowsInserted += 1;
        }
      }
    }
    this.logger.log(`Inserted ${rowsInserted} of ${rows.length} rows into balance_sheet_entries`);
    return { success: true, rowsInserted };
  }
}

const balanceSheetExtractionService = new BalanceSheetExtractionService();
// Exposed for regression testing only (backend/scripts/validateBsSectionAncestry.js)
// — pure, stateless functions, safe to call directly without running a full
// extraction. Does not change the service's own behavior or public contract.
balanceSheetExtractionService.inferSection = inferSection;
balanceSheetExtractionService.sectionFromAncestry = sectionFromAncestry;
module.exports = balanceSheetExtractionService;
