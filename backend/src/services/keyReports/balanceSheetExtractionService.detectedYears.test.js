// Regression tests for: "the December <year> Balance Sheet is missing."
//
// CONFIRMED ROOT CAUSE these lock down — a multi-period Balance Sheet reported
// only its SHEET TITLE's year as a detected year, while the account rows it
// inserted correctly carried each period's own year:
//
//     detected_years = [fiscal_year] if result else []     # extract_excel.py
//
// detected_years is not cosmetic. extractionService.base.js persists it to
// key_report_document_mappings.metadata.detectedYears, and
// keyReportValidationService.resolveMappingYears/collectYears reads THAT to
// decide which fiscal years a version has a Balance Sheet for. So a monthly
// export whose columns cross a calendar year (or whose title line names a
// different year from its columns) had rows for BOTH years inserted, but the
// year missing from detected_years was reported to the user as having no
// Balance Sheet at all — which is exactly what the client saw.
//
// A second, related defect: structural (header/group) rows were stamped with
// that same title year instead of the period they belong to, which can place a
// structural-only as_of_date in a fiscal year that holds no account rows.
// generateYearlyBs (financialStatementService) selects the LATEST as_of_date for
// a fiscal year, so it could pick that date and render the year as all zeros.
//
// These tests are source-level assertions on the extractors plus behavioural
// assertions on the JS service's own year derivation. They are deliberately
// company-agnostic: no fiscal year, month or company from any real test case is
// hardcoded — a year is chosen arithmetically inside each test.
//
// Run: node --test backend/src/services/keyReports/balanceSheetExtractionService.detectedYears.test.js

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const svc = require('./balanceSheetExtractionService.js');

const PY_DIR = path.resolve(__dirname, '..', '..', '..', 'python');
const readPy = (name) => fs.readFileSync(path.join(PY_DIR, name), 'utf8');

describe('Balance Sheet detected years come from the rows, not the sheet title', () => {
  test('extract_excel.py no longer reports the title year as the only detected year', () => {
    const src = readPy('extract_excel.py');
    const bsStart = src.indexOf('def extract_balance_sheet');
    assert.ok(bsStart > 0, 'extract_balance_sheet must exist');
    const bsEnd = src.indexOf('\ndef ', bsStart + 10);
    const body = src.slice(bsStart, bsEnd === -1 ? undefined : bsEnd);

    assert.ok(
      !/detected_years\s*=\s*\[fiscal_year\]/.test(body),
      'the title-year-only detected_years is the confirmed root cause — it must not come back',
    );
    assert.ok(
      /detected_years\s*=\s*sorted\(\{[\s\S]*?r\['fiscal_year'\][\s\S]*?for r in result/.test(body),
      'detected_years must be derived from the rows actually emitted',
    );
  });

  test('structural rows are stamped with their real period year, not the title year', () => {
    const src = readPy('extract_excel.py');
    const bsStart = src.indexOf('def extract_balance_sheet');
    const bsEnd = src.indexOf('\ndef ', bsStart + 10);
    const body = src.slice(bsStart, bsEnd === -1 ? undefined : bsEnd);

    assert.ok(
      /structural_fiscal_year\s*=/.test(body),
      'a period-derived year for structural rows must be computed',
    );
    // Every structural row emission must use it. `fiscal_year` alone would
    // reintroduce the phantom-year defect.
    const structuralStamps = body.match(/'fiscal_year':\s+\w+,/g) || [];
    const titleStamps = structuralStamps.filter((s) => /'fiscal_year':\s+fiscal_year,/.test(s));
    assert.equal(titleStamps.length, 0,
      `no structural row may be stamped with the title year (found ${titleStamps.length})`);
    assert.ok(
      body.includes("'fiscal_year':     structural_fiscal_year,"),
      'structural rows must carry structural_fiscal_year',
    );
    // The account rows keep their own per-period year.
    assert.ok(body.includes("'fiscal_year':      py,"), 'account rows must keep their period year');
  });

  test('the PDF text and OCR extractors derive Balance Sheet years the same way', () => {
    for (const name of ['extract_pdf_text.py', 'extract_pdf_ocr.py']) {
      const src = readPy(name);
      assert.ok(
        /detected_years\s*=\s*sorted\(\{[\s\S]{0,400}?r\['fiscal_year'\][\s\S]{0,200}?for r in rows/.test(src),
        `${name} must derive Balance Sheet detected years from its rows`,
      );
    }
  });

  test('the parser version was bumped so stale cached parses are re-extracted', () => {
    const jsSrc = fs.readFileSync(path.join(__dirname, 'balanceSheetExtractionService.js'), 'utf8');
    const m = jsSrc.match(/this\.parserVersion\s*=\s*'v(\d+)'/);
    assert.ok(m, 'parserVersion must be set');
    assert.ok(Number(m[1]) >= 10,
      'a cached parse carries the OLD detectedYears — the version must be bumped past v9 to invalidate it',
    );
  });
});

describe('the service derives years from rows for every extraction path', () => {
  // _yearsFromRows is the single helper both the JS Excel fallback and the
  // Gemini PDF path now use, so testing it covers both.
  const service = new svc.constructor();
  const derive = (rows, fallback) => service._yearsFromRows(rows, fallback);

  test('a document spanning two fiscal years reports BOTH', () => {
    // Arithmetic, not a hardcoded year: whatever "this year" is, and the one before.
    const later = new Date().getFullYear();
    const earlier = later - 1;
    const rows = [
      { account_name: 'A', fiscal_year: earlier, as_of_date: `${earlier}-12-31`, amount: 1 },
      { account_name: 'A', fiscal_year: later, as_of_date: `${later}-12-31`, amount: 2 },
    ];
    assert.deepEqual(derive(rows, later), [earlier, later],
      'the earlier year is the one that used to disappear from the version\'s Balance Sheet coverage',
    );
  });

  test('twelve monthly periods within one year collapse to that one year', () => {
    const year = new Date().getFullYear();
    const rows = Array.from({ length: 12 }, (_, i) => ({
      account_name: 'A', fiscal_year: year,
      as_of_date: `${year}-${String(i + 1).padStart(2, '0')}-28`, amount: i,
    }));
    assert.deepEqual(derive(rows, year), [year]);
  });

  test('an implausible year is discarded rather than reported', () => {
    const year = new Date().getFullYear();
    const rows = [
      { account_name: 'A', fiscal_year: year, amount: 1 },
      { account_name: 'B', fiscal_year: 31, amount: 2 },      // a day-of-month misread as a year
      { account_name: 'C', fiscal_year: null, amount: 3 },
      { account_name: 'D', fiscal_year: 'not a year', amount: 4 },
    ];
    assert.deepEqual(derive(rows, year), [year]);
  });

  test('rows with no usable year fall back to the sheet year rather than reporting none', () => {
    const year = new Date().getFullYear();
    assert.deepEqual(derive([{ account_name: 'A', fiscal_year: null }], year), [year]);
    assert.deepEqual(derive([], null), []);
  });

  test('years are returned sorted ascending and de-duplicated', () => {
    const y = new Date().getFullYear();
    const rows = [y, y - 2, y, y - 1, y - 2].map((fy) => ({ account_name: 'A', fiscal_year: fy }));
    assert.deepEqual(derive(rows, y), [y - 2, y - 1, y]);
  });
});
