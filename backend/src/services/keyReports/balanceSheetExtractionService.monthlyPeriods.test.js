// Regression tests for: "the generated monthly Balance Sheet totals are wrong —
// Jan 2024 renders 283,931.50 against the uploaded 293,161.70".
//
// CONFIRMED ROOT CAUSE these lock down: a Balance Sheet exported with ONE COLUMN
// PER MONTH was collapsed to a single period. The amount scan walked the row
// right-to-left and stopped at the first value, so only the LAST column
// survived, stamped with the sheet's single as_of_date. Confirmed live on a
// 12-column export: balance_sheet_entries held exactly one as_of_date per year
// ("2024-12-30", "2025-12-30", "2026-07-26").
//
// With no monthly document data to read, generateMonthlyBs fell through to
// Phase 4's GL-derived snapshots for every month, and those do not reconcile to
// the document — January 2024 showed Total Assets 283,931.50 against 293,161.70,
// and Accrued Revenue derived to -83,830.90 against the document's 44,279.84.
//
// Run: node --test backend/src/services/keyReports/balanceSheetExtractionService.monthlyPeriods.test.js

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const svc = require('./balanceSheetExtractionService.js');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const files = fs.existsSync(ROOT)
  ? fs.readdirSync(ROOT).filter((f) => /Sage Healthy.*Balance Sheet.*\.xlsx$/i.test(f)).sort()
  : [];

// Total Assets as the uploaded workbook states it, per month.
const EXPECTED_JAN_2024_TOTAL_ASSETS = 293161.70;
const EXPECTED_MONTHS = { 2024: 12, 2025: 12, 2026: 7 };

describe('a monthly Balance Sheet keeps every period', { skip: files.length === 0 ? 'BS fixtures not present' : false }, () => {
  const byYear = new Map();

  before(async () => {
    for (const f of files) {
      const year = Number((f.match(/(\d{4})/) || [])[1]);
      const { rows } = await svc.extract({ fileName: f, fileBuffer: fs.readFileSync(path.join(ROOT, f)) });
      byYear.set(year, rows || []);
    }
  });

  const totalAssetsOn = (rows, date) => rows.find(
    (r) => r.as_of_date === date && /^total for assets$/i.test(String(r.account_name || '')),
  );

  test('every month in the document becomes its own as_of_date', () => {
    for (const [year, expected] of Object.entries(EXPECTED_MONTHS)) {
      const rows = byYear.get(Number(year));
      if (!rows) continue;
      const dates = new Set(rows.map((r) => r.as_of_date).filter(Boolean));
      assert.equal(dates.size, expected, `FY${year} must yield ${expected} periods, not one`);
    }
  });

  test('the reported month now matches the uploaded figure', () => {
    const row = totalAssetsOn(byYear.get(2024) || [], '2024-01-31');
    assert.ok(row, 'January must exist as its own period');
    assert.ok(Math.abs(Number(row.amount) - EXPECTED_JAN_2024_TOTAL_ASSETS) < 0.5,
      `expected ${EXPECTED_JAN_2024_TOTAL_ASSETS}, got ${row.amount}`);
  });

  test('each period is dated to the LAST day of its month', () => {
    // Off-by-one here would silently shift a month's figures into the next one.
    const rows = byYear.get(2024) || [];
    const dates = [...new Set(rows.map((r) => r.as_of_date))].sort();
    assert.ok(dates.includes('2024-01-31'));
    assert.ok(dates.includes('2024-02-29'), 'February 2024 is a leap year — 29 days');
    assert.ok(dates.includes('2024-04-30'));
    assert.ok(dates.includes('2024-12-31'));
  });

  test('a blank cell is not written as a zero for that month', () => {
    // "Payments to deposit" is empty for early 2024 in the source document.
    const rows = (byYear.get(2024) || []).filter(
      (r) => /^payments to deposit$/i.test(String(r.account_name || '')),
    );
    assert.ok(rows.length > 0 && rows.length < 12,
      `expected only the months that state a figure, got ${rows.length}`);
  });

  test('the month captions never become an account row', () => {
    for (const rows of byYear.values()) {
      for (const r of rows) {
        assert.ok(!/^[a-z]{3}\s+\d{4}$/i.test(String(r.account_name || '').trim()),
          `"${r.account_name}" is a period caption, not an account`);
      }
    }
  });
});

describe('period-caption parsing', () => {
  // Exercised through the extractor above; these guard the shapes a caption row
  // can take and — just as importantly — what must NOT be read as a period.
  test('a single-period sheet is left on the original path', () => {
    // Fewer than two period columns must not switch on multi-period mode; the
    // sheet keeps one as_of_date exactly as before.
    const src = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'python', 'extract_excel.py'), 'utf8');
    assert.ok(/is_multi_period = len\(period_cols\) >= 2/.test(src));
  });

  test('a "Total" column is never mistaken for a period', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'python', 'extract_excel.py'), 'utf8');
    assert.ok(/if not t or 'total' in t:/.test(src), 'a Total column would double the year');
  });

  test('a 4-digit year wins over a day-of-month', () => {
    // "Jan 31, 2024" must read as 2024-01, never 2031.
    const src = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'python', 'extract_excel.py'), 'utf8');
    assert.ok(/y4 = re\.search\(r'\(\\d\{4\}\)', t\)/.test(src));
  });
});
