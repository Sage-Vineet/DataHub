// Tests for the Tax Reconciliation source adapters.
//
// Run: node --test src/lib/taxReconciliationSources.test.js
//
// These cover the shape translation between what each endpoint returns and what
// the calculation engine consumes — the layer where a year, a Balance Sheet
// period, or a saved user override can silently go missing. Every fixture is
// synthetic; no company, year or figure from a real test case is hardcoded.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  bsStatementToRowTree,
  collectBsPeriods,
  normalizeTaxYears,
  toEngineOverrides,
  unionFiscalYears,
} from './taxReconciliationSources.js';
import { bsAmountFor, resolveBsPeriod } from './taxReconciliation.js';

describe('unionFiscalYears', () => {
  test('a year present in only ONE source still survives', () => {
    // The year with books but no return, and the year with a return but no
    // books, both used to be at risk of being dropped from the column set.
    const pl = { 2022: [], 2023: [] };
    const tax = { 2023: {}, 2024: {} };
    assert.deepEqual(unionFiscalYears(pl, tax), [2022, 2023, 2024]);
  });

  test('string and numeric keys collapse to one year', () => {
    assert.deepEqual(unionFiscalYears({ 2023: [] }, { '2023': {} }), [2023]);
  });

  test('implausible and non-numeric keys are discarded', () => {
    assert.deepEqual(unionFiscalYears({ 2023: [], abc: [], 12: [], 9999: [] }), [2023]);
  });

  test('an empty or missing source contributes nothing and does not throw', () => {
    assert.deepEqual(unionFiscalYears(null, undefined, {}), []);
  });
});

describe('normalizeTaxYears', () => {
  const response = {
    success: true,
    years: {
      2023: {
        year: 2023, fileName: 'a.pdf', status: 'Verified',
        scheduleM1: { netIncomePerBooks: 100, reconciledIncome: null, lines: [] },
        data: [{ label: 'Net Income', taxReturn: 90, isReconcilingItem: false }],
      },
      2024: { year: 2024, data: [] },
    },
  };

  test('years are keyed numerically and keep their file, status and Schedule M-1', () => {
    const out = normalizeTaxYears(response);
    assert.deepEqual(Object.keys(out).map(Number).sort(), [2023, 2024]);
    assert.equal(out[2023].fileName, 'a.pdf');
    assert.equal(out[2023].status, 'Verified');
    assert.equal(out[2023].scheduleM1.netIncomePerBooks, 100);
  });

  test('a null Schedule M-1 stays null and is NOT coerced to zero', () => {
    // A missing M-1 line 1 and a real book income of 0 are different facts: the
    // engine reports the first as unavailable and the second as a figure.
    const out = normalizeTaxYears(response);
    assert.equal(out[2024].scheduleM1, null);
    assert.notEqual(out[2024].scheduleM1, 0);
  });

  test('an unsuccessful or empty response yields no years rather than throwing', () => {
    assert.deepEqual(normalizeTaxYears({ success: false }), {});
    assert.deepEqual(normalizeTaxYears(null), {});
    assert.deepEqual(normalizeTaxYears({ success: true, years: {} }), {});
  });

  test('a malformed data field becomes an empty array, not undefined', () => {
    const out = normalizeTaxYears({ success: true, years: { 2024: { year: 2024, data: 'nope' } } });
    assert.deepEqual(out[2024].data, []);
  });
});

describe('Balance Sheet period collection', () => {
  const statement = (ar, ap) => ({
    totalAssets: ar,
    totalLiabilities: ap,
    totalEquity: ar - ap,
    assets: {
      hierarchy: [{
        id: 'ca', name: 'Current Assets', type: 'header', amount: ar,
        children: [{ id: 'ar', name: 'Accounts Receivable', type: 'account', amount: ar }],
      }],
    },
    liabilities: {
      hierarchy: [{
        id: 'cl', name: 'Current Liabilities', type: 'header', amount: ap,
        children: [{ id: 'ap', name: 'Accounts Payable', type: 'account', amount: ap }],
      }],
    },
    equity: { hierarchy: [] },
  });

  test('monthly and yearly periods are both collected, sorted by date', () => {
    const periods = collectBsPeriods({
      monthly: [
        { asOfDate: '2024-02-29', statement: statement(20, 10) },
        { asOfDate: '2024-01-31', statement: statement(10, 5) },
      ],
      yearly: [{ asOfDate: '2023-12-31', statement: statement(5, 2) }],
    });
    assert.deepEqual(periods.map((p) => p.asOfDate), ['2023-12-31', '2024-01-31', '2024-02-29']);
    assert.deepEqual(periods.map((p) => p.source), ['yearly', 'monthly', 'monthly']);
  });

  test('a period with no readable statement is skipped rather than added empty', () => {
    const periods = collectBsPeriods({
      monthly: [{ asOfDate: '2024-01-31', statement: null }],
      yearly: [{ asOfDate: '2024-12-31', statement: statement(1, 1) }],
    });
    assert.deepEqual(periods.map((p) => p.asOfDate), ['2024-12-31']);
  });

  test('a single-year response with only a row tree still yields a period', () => {
    const periods = collectBsPeriods({
      years: [2024],
      hierarchicalRows: bsStatementToRowTree(statement(7, 3)),
    });
    assert.equal(periods.length, 1);
    assert.equal(periods[0].asOfDate, '2024-12-31');
  });

  test('the collected periods drive resolveBsPeriod end-to-end', () => {
    // The whole point of this adapter: a fiscal year's ending and the prior
    // year's beginning must both be resolvable from what the endpoint returned.
    const periods = collectBsPeriods({
      monthly: [
        { asOfDate: '2023-12-31', statement: statement(1000, 500) },
        { asOfDate: '2024-06-30', statement: statement(9999, 9999) },
        { asOfDate: '2024-12-31', statement: statement(1500, 800) },
      ],
      yearly: [],
    });
    const ending = resolveBsPeriod(periods, 2024);
    const beginning = resolveBsPeriod(periods, 2023);
    assert.equal(ending.found, true);
    assert.equal(beginning.found, true);
    assert.equal(bsAmountFor(ending.rows, 'Accounts Receivable').amount, 1500);
    assert.equal(bsAmountFor(beginning.rows, 'Accounts Receivable').amount, 1000);
    assert.equal(bsAmountFor(ending.rows, 'Accounts Payable').amount, 800);
    // A mid-year period is never mistaken for the year-end one.
    assert.notEqual(ending.asOfDate, '2024-06-30');
  });

  test('a year whose required period is absent stays unresolved — no substitution', () => {
    const periods = collectBsPeriods({
      monthly: [{ asOfDate: '2024-11-30', statement: statement(1, 1) }],
      yearly: [],
    });
    const resolved = resolveBsPeriod(periods, 2024);
    assert.equal(resolved.found, false);
    assert.match(resolved.reason, /December 2024 Balance Sheet is not available/);
  });

  test('an empty response yields no periods rather than throwing', () => {
    assert.deepEqual(collectBsPeriods(null), []);
    assert.deepEqual(collectBsPeriods({}), []);
  });

  test('the rebuilt tree keeps section totals out of the leaf sums', () => {
    const rows = bsStatementToRowTree(statement(100, 40));
    // Total rows must not be double-counted with the accounts they roll up.
    assert.equal(bsAmountFor(rows, 'Accounts Receivable').amount, 100);
    assert.equal(bsAmountFor(rows, 'Accounts Payable').amount, 40);
  });

  test('a null statement produces an empty tree, not a crash', () => {
    assert.deepEqual(bsStatementToRowTree(null), []);
  });
});

describe('toEngineOverrides', () => {
  test('the persisted flat per-year map reaches every section bucket', () => {
    // Overrides saved before the sectioned layout existed must keep working.
    const stored = { 2024: { 'Nondeductible Expenses': { taxReturn: 500 } } };
    const engine = toEngineOverrides(stored);
    for (const bucket of ['m1', 'cashAccrual', 'other', 'scheduleK']) {
      assert.equal(engine[2024][bucket]['Nondeductible Expenses'].taxReturn, 500, bucket);
    }
  });

  test('an empty or missing map is safe', () => {
    assert.deepEqual(toEngineOverrides(null), {});
    assert.deepEqual(toEngineOverrides({}), {});
  });

  test('years are preserved as their original keys so the engine can find them', () => {
    const engine = toEngineOverrides({ 2022: {}, 2023: {} });
    assert.deepEqual(Object.keys(engine).sort(), ['2022', '2023']);
  });
});
