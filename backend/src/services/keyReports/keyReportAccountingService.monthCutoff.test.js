// Regression tests for: "the generated Balance Sheet does not reconcile with
// the uploaded Balance Sheet — every account is off by a constant amount in
// every month of every year."
//
// CONFIRMED ROOT CAUSE these lock down. Both monthly Balance Sheet engines
// bounded their month loop with a DAY-granularity compare:
//
//     const monthEndCutoff = gate.glEndDate;          // last TRANSACTION date
//     if (monthEndDate(year, m) > monthEndCutoff) ... // calendar MONTH-END
//
// The General Ledger's final month is partial by definition — the last
// transaction almost never lands on the last calendar day — so for that month
// `monthEndDate(...) > glEndDate` was true and the iteration was skipped.
//
// In the REVERSE engine that `continue` skipped BOTH halves of the iteration:
// emitting the snapshot AND un-subtracting that month's GL activity. The final
// month's movement therefore stayed in the running balance forever, so every
// earlier snapshot — back through every prior year — was off by a CONSTANT
// per-account amount equal to that one skipped month. The uploaded Ending
// Balance Sheet's own month (the anchor, and the only ground-truth month) was
// never emitted at all.
//
// Measured live before the fix (Sage Healthy, version 6f2cbcab, GL ending
// 2026-07-24 with an uploaded Ending BS dated 2026-07-31) — the generated sheet
// was off by exactly July-2026's GL movement in EVERY month of 2024/2025/2026:
//     Accrued Revenue         -128,110.74      KeyBank              +10,881.70
//     Accounts Receivable      +64,411.80      Mercury Credit Card   +2,988.79
//     Payments to deposit      +45,787.04      Mercury Checking      -2,200.00
//     Accrued Expenses          -4,950.00      Retained Earnings     -7,268.99
// Accounts with no July activity matched the uploaded document to the cent,
// which is what pins the cause to the single skipped month. After the fix all
// 31 months reconcile exactly, with zero account-level differences.
//
// Note that Assets = Liabilities + Equity held in every month BOTH before and
// after — a skipped month's movement is itself a balanced set of journal
// entries — which is exactly why assertMonthBalances never flagged any of it.
// A balance check alone cannot catch this class of defect; reconciliation
// against the uploaded document is what catches it.
//
// Run: node --test backend/src/services/keyReports/keyReportAccountingService.monthCutoff.test.js

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, 'keyReportAccountingService.js'), 'utf8');

// Same implementation as the module-private helper under test.
function monthEndDate(year, m) {
  const isLeap = (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0));
  const lastDay = [31, isLeap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  return `${year}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// A faithful miniature of generateMonthlyBalanceSheetsReverse's month walk:
// seed from the uploaded Ending BS, then for each month (latest first) snapshot
// the running balance and un-subtract that month's GL movement. `cutoff` picks
// which comparison rule to use, so the two can be run against identical data.
// ---------------------------------------------------------------------------
function reverseWalk({ endingBalance, movementsByMonth, year, glEndDate, rule }) {
  const cutoffMonth = glEndDate.slice(0, 7);
  const snapshots = new Map();
  let running = endingBalance;
  for (let m = 12; m >= 1; m--) {
    const asOf = monthEndDate(year, m);
    const skip = rule === 'day'
      ? asOf > glEndDate            // the defect
      : asOf.slice(0, 7) > cutoffMonth; // the fix
    if (skip) continue;
    snapshots.set(asOf, running);
    running -= (movementsByMonth[m] || 0);
  }
  return { snapshots, beforeFirstMonth: running };
}

// GL runs Jan–Jul; the last transaction is on the 24th, so July is partial.
// The uploaded Ending BS is dated 2026-07-31 and says the account is at 86,049.51.
const GL_END_DATE = '2026-07-24';
const MOVEMENTS = { 1: 5000, 2: 7000, 3: -1500, 4: 12000, 5: 3000, 6: 2500, 7: 10881.70 };
const ENDING_BALANCE = 86049.51;
const YEAR = 2026;
// Truth: month-end balance = ending balance minus every later month's movement.
const TRUTH = (() => {
  const t = new Map(); let b = ENDING_BALANCE;
  for (let m = 7; m >= 1; m--) { t.set(monthEndDate(YEAR, m), b); b -= MOVEMENTS[m]; }
  return { byMonth: t, opening: b };
})();

describe('the GL\'s final partial month is emitted and unwound', () => {
  const fixed = reverseWalk({
    endingBalance: ENDING_BALANCE, movementsByMonth: MOVEMENTS, year: YEAR,
    glEndDate: GL_END_DATE, rule: 'month',
  });

  test('the uploaded Ending BS month is present — it is the anchor month', () => {
    assert.equal(fixed.snapshots.has('2026-07-31'), true,
      'the one month that is ground truth must not be dropped');
    assert.equal(fixed.snapshots.get('2026-07-31'), ENDING_BALANCE);
  });

  test('every month reconciles to the uploaded document exactly', () => {
    for (const [asOf, expected] of TRUTH.byMonth) {
      assert.equal(fixed.snapshots.get(asOf), expected, `${asOf} must match the uploaded figure`);
    }
  });

  test('an account that did not exist before the GL unwinds to exactly zero', () => {
    // This is the "phantom KeyBank/Mercury balance in FY2024" report: the
    // pre-GL residual is what leaked into earlier years as a fake balance.
    // Nothing suppresses it — it simply lands on zero once every month is
    // unwound, and snapshotRows already skips a zero balance.
    const onlyJuly = reverseWalk({
      endingBalance: 10881.70, movementsByMonth: { 7: 10881.70 }, year: YEAR,
      glEndDate: GL_END_DATE, rule: 'month',
    });
    assert.equal(onlyJuly.beforeFirstMonth, 0,
      'an account whose only activity is in the final month must unwind to 0, not to a phantom balance');
  });

  test('months after the GL\'s last activity are still never fabricated', () => {
    for (const m of [8, 9, 10, 11, 12]) {
      assert.equal(fixed.snapshots.has(monthEndDate(YEAR, m)), false,
        `${monthEndDate(YEAR, m)} is past the last GL activity and must not be generated`);
    }
  });
});

describe('the old day-granularity rule reproduces the reported symptom', () => {
  const broken = reverseWalk({
    endingBalance: ENDING_BALANCE, movementsByMonth: MOVEMENTS, year: YEAR,
    glEndDate: GL_END_DATE, rule: 'day',
  });

  test('the anchor month is missing entirely', () => {
    assert.equal(broken.snapshots.has('2026-07-31'), false);
  });

  test('every earlier month is off by exactly the skipped month\'s movement', () => {
    for (let m = 6; m >= 1; m--) {
      const asOf = monthEndDate(YEAR, m);
      const delta = broken.snapshots.get(asOf) - TRUTH.byMonth.get(asOf);
      assert.equal(Math.round(delta * 100) / 100, MOVEMENTS[7],
        `${asOf} drifts by the un-unwound final month — the constant offset that was reported`);
    }
  });

  test('the phantom pre-GL balance is that same un-unwound movement', () => {
    const onlyJuly = reverseWalk({
      endingBalance: 10881.70, movementsByMonth: { 7: 10881.70 }, year: YEAR,
      glEndDate: GL_END_DATE, rule: 'day',
    });
    assert.equal(onlyJuly.beforeFirstMonth, 10881.70,
      'this residual is exactly the "KeyBank has an FY2024 balance it never had" report');
  });
});

describe('both engines compare at month granularity in the production source', () => {
  test('neither engine still compares a month-end against the raw glEndDate', () => {
    assert.equal(/monthEndCutoff/.test(SRC), false,
      'monthEndCutoff was the day-granularity bound — it must not come back');
  });

  test('the cutoff is derived by truncating glEndDate to its month', () => {
    const decls = SRC.match(/const cutoffMonth = String\(gate\?\.glEndDate \|\| monthEndDate\(endYear, 12\)\)\.slice\(0, 7\);/g) || [];
    assert.equal(decls.length, 2, 'both the forward and reverse engines must declare it');
  });

  test('every month comparison against the cutoff is month-truncated too', () => {
    const compares = SRC.match(/asOf(?:\.slice\(0, 7\))? [<>]=? cutoffMonth/g) || [];
    assert.ok(compares.length >= 4, `expected the four loop bounds, found ${compares.length}`);
    for (const c of compares) {
      assert.ok(c.includes('.slice(0, 7)'),
        `"${c}" compares a full date against a YYYY-MM cutoff — the original defect`);
    }
  });
});
