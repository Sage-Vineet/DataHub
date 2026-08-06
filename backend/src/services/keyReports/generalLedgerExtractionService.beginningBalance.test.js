// Regression tests for: "Trial Balance reports NO_EQUITY_ACCOUNTS / ONE_SIDED_LEDGER".
//
// CONFIRMED ROOT CAUSE these lock down: both GL parsers looked for the
// "Beginning Balance" sentinel in column 0 only. A very common export layout
// indents the ledger grid by one column -- the ACCOUNT HEADING sits alone in
// column 0 and every detail row (including the "Beginning Balance" label)
// starts at the detected account column. On such a file row[0] is empty for
// that row, so the branch never matched: the row fell through to the
// transaction branch, had no date, and was silently discarded.
//
// Measured on the real export used here: 52 "Beginning Balance" rows in the
// workbooks, 0 reaching the database. That destroyed every opening balance AND
// removed the equity accounts entirely -- they carry an opening balance and no
// transactions, so with the row gone they produced no GL rows at all and
// vanished from the Trial Balance. NO_EQUITY_ACCOUNTS was a true symptom of a
// parser defect, not a data gap.
//
// Run: node --test backend/src/services/keyReports/generalLedgerExtractionService.beginningBalance.test.js

const { test, before, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const svc = require('./generalLedgerExtractionService.js');

// The fixtures are the real uploaded workbooks at the repo root.
const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const GL_RE = /General Ledger.*\.xlsx$/i;
const files = fs.existsSync(ROOT)
  ? fs.readdirSync(ROOT).filter((f) => GL_RE.test(f) && /Sage Healthy/i.test(f)).sort()
  : [];

// Opening balances per workbook, counted directly in the source files.
const EXPECTED_BEGINNING_BALANCES = 52;

describe('GL beginning-balance extraction (indented-grid layout)', { skip: files.length === 0 ? 'GL fixtures not present' : false }, () => {
  let rows = [];

  before(async () => {
    for (const f of files) {
      const r = await svc.extract({ fileName: f, fileBuffer: fs.readFileSync(path.join(ROOT, f)) });
      rows.push(...(r.rows || []));
    }
  });

  const bb = () => rows.filter((r) => r.row_type === 'BEGINNING_BALANCE');

  test('the sentinel is found even though the grid starts in column 1', () => {
    assert.equal(bb().length, EXPECTED_BEGINNING_BALANCES,
      'every opening balance in the workbooks must be extracted');
  });

  test('an opening balance is attributed to its OWNING account, never to the sentinel label', () => {
    // Grouping the Trial Balance by "Beginning Balance" would strand every
    // opening balance under one bogus account.
    for (const r of bb()) {
      assert.ok(r.account_name, 'account_name must be populated');
      assert.ok(!/^beginning balance$/i.test(String(r.account_name)));
    }
  });

  test('every opening balance carries a date — general_ledger_entries has no fiscal_year column', () => {
    // Migration 069 removed fiscal_year; transaction_date IS the year key and
    // every downstream read filters on it by range. A dateless opening balance
    // parses fine and still never reaches the Trial Balance.
    for (const r of bb()) {
      const y = r.year || r.fiscal_year;
      assert.ok(Number.isInteger(Number(y)) && Number(y) > 0,
        `opening balance for ${r.account_name} must resolve a year`);
    }
  });

  test('equity accounts that carry ONLY an opening balance are present in the ledger', () => {
    // The reported failure: these produced zero rows, so the Trial Balance had
    // no equity at all and the accounting equation could not close.
    const byAccount = new Map();
    for (const r of rows) {
      const k = String(r.account_name || '');
      if (!k) continue;
      byAccount.set(k, (byAccount.get(k) || 0) + 1);
    }
    const equityOnly = [...byAccount.keys()].filter((n) => /(- Equity|Retained Earnings)$/i.test(n) && !/^Total for/i.test(n));
    assert.ok(equityOnly.length > 0, 'the fixture must contain equity accounts');
    for (const n of equityOnly) {
      assert.ok(byAccount.get(n) > 0, `${n} must produce at least one GL row`);
    }
  });

  test('"Total for X" rows still parse as totals — they really are in column 0', () => {
    // The fix is deliberately scoped to the beginning-balance lookup. Widening
    // the column-0 read would turn ordinary detail rows into bogus totals or
    // section headers, so this guards the other direction.
    const totals = rows.filter((r) => r.row_type === 'TOTAL_ROW');
    assert.ok(totals.length > 0, 'total rows must still be recognised');
    for (const r of totals) assert.ok(/^total/i.test(String(r.account_name || '')));
  });

  test('no detail row was misread as an account header', () => {
    const headers = rows.filter((r) => r.row_type === 'ACCOUNT_HEADER');
    for (const r of headers) {
      assert.ok(!/^beginning balance$/i.test(String(r.account_name || '')));
    }
  });
});

describe('the export is double-sided — contra reconstruction would double-count', { skip: files.length === 0 ? 'GL fixtures not present' : false }, () => {
  // ONE_SIDED_LEDGER was a FALSE POSITIVE: it fired on `sum(net_balance) != 0`,
  // which is the naive positive-vs-negative total that generateTrialBalance's
  // own header warns about -- `amount` uses the natural-balance convention, so
  // the sum is non-zero on healthy data by design. This asserts the evidence
  // that overturned it, so nobody "fixes" it by synthesising contra rows.
  const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const leaf = (s) => norm(String(s || '').split(':').pop());

  test('every split_account target already exists as a real account section', async () => {
    for (const f of files) {
      const r = await svc.extract({ fileName: f, fileBuffer: fs.readFileSync(path.join(ROOT, f)) });
      const txns = (r.rows || []).filter((x) => (x.row_type || 'TRANSACTION') === 'TRANSACTION');
      const ownFull = new Set(txns.map((x) => norm(x.account_name)).filter(Boolean));
      const ownLeaf = new Set(txns.map((x) => leaf(x.account_name)).filter(Boolean));
      const refs = txns.filter((x) => x.split_account);
      assert.ok(refs.length > 0, `${f} must reference split accounts`);
      const unresolved = refs.filter(
        (x) => !ownFull.has(norm(x.split_account)) && !ownLeaf.has(leaf(x.split_account)),
      );
      assert.equal(unresolved.length, 0,
        `${f}: the contra side is already a real row, so the ledger is NOT one-sided`);
    }
  });
});
