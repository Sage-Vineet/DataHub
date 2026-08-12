// Regression tests for the Schedule K / Schedule M-1 shaping of tax return data,
// the layer that feeds the Tax Reconciliation page.
//
// Two confirmed bugs are locked down here:
//
//  1. DUPLICATE CATEGORIES. canonicalizeReconLabel returned an UNRECOGNIZED label
//     verbatim, so "Other credits" from one extraction pass and "Other Credits"
//     from another survived as two separate rows — the duplicate-category problem
//     the client reported.
//
//  2. SILENT VALUE LOSS. canonicalizeReconcilingData collapsed every duplicate
//     canonical label by "keep the larger magnitude". That is right when the SAME
//     line has been re-emitted by the verification pass, but wrong when TWO
//     GENUINELY DIFFERENT lines share a category (Form 1065 line 13a "Charitable
//     Contributions Cash" and 13b "…Noncash" both canonicalize to "Charitable
//     Contributions"). The smaller real amount was silently discarded, leaving a
//     reconciling item short with nothing on screen to say so — a direct
//     contributor to "numbers do not foot".
//
// Run: node --test backend/src/services/manualReportUploadService.scheduleK.test.js

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const svc = require('../services/manualReportUploadService.js');

const { buildTaxReturnResponseData, canonicalizeReconcilingData } = svc;

const page1 = {
  formType: '1120-S',
  year: 2024,
  totalRevenue: 1000, totalCostOfGoodsSold: 400, grossProfit: 600,
  officerWages: 100, depreciation: 50, amortization: 0, interestExpense: 10,
  allOtherExpenses: 0, netIncome: 440,
};

const reconRows = (data) => data.filter((r) => r.isReconcilingItem);
const valueOf = (data, label) => reconRows(data).find((r) => r.label === label)?.taxReturn;

describe('duplicate Schedule K categories', () => {
  test('a casing variant of an unrecognized line collapses to ONE row', () => {
    const data = buildTaxReturnResponseData({
      ...page1,
      reconcilingItems: [
        { label: 'Other credits', value: 500 },
        { label: 'Other Credits', value: 500 },
      ],
    });
    const rows = reconRows(data);
    assert.equal(rows.length, 1, 'two casings of one line must not render twice');
    assert.equal(rows[0].label, 'Other Credits');
  });

  test('a recognized line under two wordings collapses to its canonical label', () => {
    const data = buildTaxReturnResponseData({
      ...page1,
      reconcilingItems: [
        { label: 'Nondeductible expenses', value: 900 },
        { label: 'Nondeductible Expenses', value: 900 },
      ],
    });
    const rows = reconRows(data);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].label, 'Nondeductible Expenses');
  });

  test('the same line re-emitted by the verification pass is NOT doubled', () => {
    // Both passes read line 16c; only one amount is real.
    const data = canonicalizeReconcilingData([
      { label: 'Nondeductible Expenses', taxReturn: 900, isReconcilingItem: true },
      { label: 'Nondeductible Expenses', taxReturn: 900, isReconcilingItem: true },
    ]);
    assert.equal(reconRows(data).length, 1);
    assert.equal(valueOf(data, 'Nondeductible Expenses'), 900, 'must not become 1800');
  });

  test('a re-emission with a slightly different reading keeps the larger magnitude', () => {
    const data = canonicalizeReconcilingData([
      { label: 'nondeductible expenses', taxReturn: 90, isReconcilingItem: true },
      { label: 'Nondeductible expenses', taxReturn: 900, isReconcilingItem: true },
    ]);
    assert.equal(reconRows(data).length, 1);
    assert.equal(valueOf(data, 'Nondeductible Expenses'), 900);
  });
});

describe('two genuinely different lines sharing one category', () => {
  test('cash and noncash charitable contributions are SUMMED, not discarded', () => {
    const data = buildTaxReturnResponseData({
      ...page1,
      reconcilingItems: [
        { label: 'Charitable Contributions Cash', value: 4000 },
        { label: 'Charitable Contributions Noncash', value: 1500 },
      ],
    });
    const rows = reconRows(data);
    assert.equal(rows.length, 1, 'one category');
    assert.equal(rows[0].label, 'Charitable Contributions');
    assert.equal(rows[0].taxReturn, 5500,
      'the noncash half used to be silently dropped by keep-the-larger');
  });

  test('both source labels are retained so the merge is auditable', () => {
    const data = buildTaxReturnResponseData({
      ...page1,
      reconcilingItems: [
        { label: 'Charitable Contributions Cash', value: 4000 },
        { label: 'Charitable Contributions Noncash', value: 1500 },
      ],
    });
    const row = reconRows(data)[0];
    assert.deepEqual(row.sourceLabels, ['Charitable Contributions Cash', 'Charitable Contributions Noncash']);
  });

  test('qualified dividends stay their OWN category and are not summed into ordinary', () => {
    // Qualified dividends are a subset disclosure of ordinary dividends, not an
    // additional amount, so SCHEDULE_K_CANON deliberately gives them their own
    // canonical label. Merging them would overstate portfolio income.
    const data = canonicalizeReconcilingData([
      { label: 'Ordinary Dividends', taxReturn: 300, isReconcilingItem: true },
      { label: 'Qualified Dividends', taxReturn: 200, isReconcilingItem: true },
    ]);
    assert.equal(reconRows(data).length, 2);
    assert.equal(valueOf(data, 'Ordinary Dividends'), 300);
    assert.equal(valueOf(data, 'Qualified Dividends'), 200);
  });

  test('two rental lines that DO share a category are summed', () => {
    // "Other Gross Rental Income" and "Other Net Rental Income" both reduce to
    // "Other Net Rental Income" via /net rental/ — different source lines, so they add.
    const data = canonicalizeReconcilingData([
      { label: 'Net Rental Income A', taxReturn: 700, isReconcilingItem: true },
      { label: 'Net Rental Income B', taxReturn: 300, isReconcilingItem: true },
    ]);
    assert.equal(reconRows(data).length, 1);
    assert.equal(valueOf(data, 'Other Net Rental Income'), 1000);
  });

  test('a negative amount is summed with its sign, not by magnitude', () => {
    const data = canonicalizeReconcilingData([
      { label: 'Charitable Contributions Cash', taxReturn: 4000, isReconcilingItem: true },
      { label: 'Charitable Contributions Noncash', taxReturn: -1000, isReconcilingItem: true },
    ]);
    assert.equal(valueOf(data, 'Charitable Contributions'), 3000);
  });
});

describe('non-reconciling rows and drops are unchanged', () => {
  test('page-1 line items pass through untouched and in order', () => {
    const data = buildTaxReturnResponseData({ ...page1, reconcilingItems: [] });
    assert.deepEqual(
      data.filter((r) => !r.isReconcilingItem).map((r) => r.label),
      // "All Other Income" carries page-1 net gain (line 4) + other income (line 5).
      // It was added deliberately: those amounts previously had no row of their own
      // and were netted into "All Other Expenses", reporting income as expense. See
      // manualReportUploadService.taxAccuracy.test.js.
      ['Total Revenue', 'Total Cost of Goods Sold', 'Gross Profit', 'Officer Wages',
        'Depreciation Expense', 'Amortization Expense', 'Total Interest Expense',
        'All Other Expenses', 'All Other Income', 'Net Income'],
    );
  });

  test('the Line 18 income reconciliation is still dropped', () => {
    const data = canonicalizeReconcilingData([
      { label: 'Income (loss) reconciliation', taxReturn: 999, isReconcilingItem: true },
      { label: 'Ordinary business income', taxReturn: 888, isReconcilingItem: true },
      { label: 'Nondeductible Expenses', taxReturn: 10, isReconcilingItem: true },
    ]);
    assert.deepEqual(reconRows(data).map((r) => r.label), ['Nondeductible Expenses']);
  });

  test('a partnership return labels officer wages as Guaranteed Payments', () => {
    const data = buildTaxReturnResponseData({ ...page1, formType: '1065', allOtherExpenses: 0, reconcilingItems: [] });
    assert.ok(data.some((r) => r.label === 'Guaranteed Payments' && !r.isReconcilingItem));
  });

  test('a non-array input is returned unchanged', () => {
    assert.equal(canonicalizeReconcilingData(null), null);
    assert.equal(canonicalizeReconcilingData(undefined), undefined);
  });
});

// A blank/unread line and a preparer's nil assertion are different facts, and the
// Tax Reconciliation page renders them differently ("Not Reported" vs a figure).
// Publishing an unread line as 0 with reported:true is what put "Nondeductible
// Expenses 0" on a report whose Schedule K line 16c prints 912 — a 0 no consumer
// could tell apart from a real reading.
describe('a Schedule K line the extraction did not read', () => {
  const item = (label, value) => buildTaxReturnResponseData({
    ...page1, reconcilingItems: [{ label, value }],
  });

  test('is published as null, flagged not reported — never as 0', () => {
    for (const missing of [null, undefined, '']) {
      const row = reconRows(item('Nondeductible Expenses', missing))[0];
      assert.ok(row, `an unread line is kept so the reviewer sees it (${String(missing)})`);
      assert.equal(row.taxReturn, null);
      assert.equal(row.source.reported, false);
    }
  });

  test('a printed zero is still left out, and a real figure is still published', () => {
    assert.equal(reconRows(item('Nondeductible Expenses', 0)).length, 0);
    const row = reconRows(item('Nondeductible Expenses', 912))[0];
    assert.equal(row.taxReturn, 912);
    assert.equal(row.source.reported, true);
  });

  test('a later pass that DOES read the line replaces the unread row', () => {
    const data = canonicalizeReconcilingData([
      { label: 'Nondeductible expenses', taxReturn: null, isReconcilingItem: true, source: { reported: false } },
      { label: 'Nondeductible Expenses', taxReturn: 912, isReconcilingItem: true, source: { reported: true } },
    ]);
    const rows = reconRows(data);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].taxReturn, 912, 'the reading wins over the blank');
    assert.equal(rows[0].source.reported, true);
  });

  test('an unread duplicate never drags a read value back to zero', () => {
    const data = canonicalizeReconcilingData([
      { label: 'Nondeductible Expenses', taxReturn: 912, isReconcilingItem: true, source: { reported: true } },
      { label: 'Nondeductible expenses', taxReturn: null, isReconcilingItem: true, source: { reported: false } },
    ]);
    assert.equal(valueOf(data, 'Nondeductible Expenses'), 912);
  });

  test('an unread line is not summed as 0 into a genuinely different line', () => {
    const data = canonicalizeReconcilingData([
      { label: 'Charitable Contributions Cash', taxReturn: 4000, isReconcilingItem: true },
      { label: 'Charitable Contributions Noncash', taxReturn: null, isReconcilingItem: true, source: { reported: false } },
    ]);
    assert.equal(valueOf(data, 'Charitable Contributions'), 4000);
  });
});

describe('Schedule M-1 normalization', () => {
  // normalizeScheduleM1 is internal; it is exercised through the extractor's
  // contract. What matters to the reconciliation is that a MISSING Schedule M-1
  // stays null rather than becoming a fabricated zero, so the page reports the
  // anchor as unavailable instead of showing an unreconciled difference equal to
  // the entire book income.
  test('the extraction prompt asks for Schedule M-1 line 1 and the reconciled total', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, 'manualReportUploadService.js'), 'utf8',
    );
    assert.ok(/SCHEDULE M-1 — BOOK-TO-TAX RECONCILIATION/.test(src), 'the M-1 block must be in the prompt');
    assert.ok(/"netIncomePerBooks"/.test(src));
    assert.ok(/"reconciledIncome"/.test(src));
    assert.ok(/function normalizeScheduleM1/.test(src));
    // The null-not-zero contract is the whole point — assert it is stated.
    assert.ok(/set "netIncomePerBooks" to null — NOT to 0/.test(src));
  });

  test('the prompt forbids sourcing Schedule M-1 from Schedule M-2 balances', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, 'manualReportUploadService.js'), 'utf8');
    assert.ok(/M-2 holds running EQUITY BALANCES, not a book-to-tax reconciliation/.test(src));
  });
});
