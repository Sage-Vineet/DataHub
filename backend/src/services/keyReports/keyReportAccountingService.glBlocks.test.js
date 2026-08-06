// Regression tests for: "Trial Balance does not balance — imbalance exactly
// 118,800 (FY2024, FY2025) and 49,500 (FY2026)".
//
// CONFIRMED ROOT CAUSE these lock down: linkGlToCoa mapped GL rows to a COA
// leaf by NAME, keeping the first match. One P&L legitimately lists "Business
// Process Outsourcing" twice — under Income and under Cost of goods sold — and
// the GL prints them as two separate blocks with the identical heading (checked:
// no path qualifier in the Distribution account column either). All 118 GL rows
// therefore linked to the income leaf, so the cost-of-goods amount was counted
// as revenue: missing from expenses AND added to income, i.e. twice the block
// total in the accounting equation.
//
// Measured on the real export, and matching each year's reported imbalance:
//   FY2024  block1 = 100,800.00  block2 = 59,400.00   -> 2 x 59,400 = 118,800
//   FY2025  block1 = 100,800.00  block2 = 59,400.00   -> 2 x 59,400 = 118,800
//   FY2026  block1 =  25,200.00  block2 = 24,750.00   -> 2 x 24,750 =  49,500
//
// Run: node --test backend/src/services/keyReports/keyReportAccountingService.glBlocks.test.js

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { splitGlRowsIntoBlocks } = require('./keyReportAccountingService.js');

const r = (row_number, amount = 0) => ({ id: `r${row_number}`, row_number, amount });
const sum = (b) => b.reduce((t, x) => t + x.amount, 0);

describe('splitting one account name into its document blocks', () => {
  // The real FY2024 shape: rows 2620-2631 then 2945-2980.
  const fy2024 = [
    ...Array.from({ length: 12 }, (_, i) => r(2620 + i, 8400)),
    ...Array.from({ length: 36 }, (_, i) => r(2945 + i, 1650)),
  ];

  test('the two blocks are found at the row_number jump', () => {
    const blocks = splitGlRowsIntoBlocks(fy2024, 2);
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].length, 12);
    assert.equal(blocks[1].length, 36);
  });

  test('block totals match the two P&L accounts', () => {
    const [a, b] = splitGlRowsIntoBlocks(fy2024, 2);
    assert.equal(sum(a), 100800);
    assert.equal(sum(b), 59400);
  });

  test('blocks come back in document order', () => {
    const [a, b] = splitGlRowsIntoBlocks(fy2024, 2);
    assert.ok(a[a.length - 1].row_number < b[0].row_number,
      'block order is what pairs them with leaves in statement order');
  });

  test('input order does not matter — rows are sorted by row_number first', () => {
    const shuffled = fy2024.slice().reverse();
    const [a, b] = splitGlRowsIntoBlocks(shuffled, 2);
    assert.equal(sum(a), 100800);
    assert.equal(sum(b), 59400);
  });
});

describe('the split never fires when it should not', () => {
  test('an ordinary single-leaf account is returned whole', () => {
    const rows = [r(10, 1), r(11, 2), r(12, 3)];
    for (const n of [1, 0, undefined, null]) {
      const blocks = splitGlRowsIntoBlocks(rows, n);
      assert.equal(blocks.length, 1, `blockCount=${n} must not split`);
      assert.equal(blocks[0].length, 3);
    }
  });

  test('a contiguous run is never split, even when two blocks are requested', () => {
    // Consecutive row_numbers are one account's own rows. Asking for two blocks
    // where the document shows one must not invent a boundary.
    const rows = [r(10), r(11), r(12), r(13)];
    const blocks = splitGlRowsIntoBlocks(rows, 2);
    assert.equal(blocks.length, 1, 'gap size 1 is never a boundary');
  });

  test('empty input yields no blocks', () => {
    assert.deepEqual(splitGlRowsIntoBlocks([], 2), []);
    assert.deepEqual(splitGlRowsIntoBlocks(null, 2), []);
  });

  test('a single row yields a single block', () => {
    assert.equal(splitGlRowsIntoBlocks([r(5)], 2).length, 1);
  });
});

describe('more than two same-named accounts', () => {
  test('three leaves cut at the two largest gaps', () => {
    const rows = [r(10), r(11), r(500), r(501), r(900)];
    const blocks = splitGlRowsIntoBlocks(rows, 3);
    assert.equal(blocks.length, 3);
    assert.deepEqual(blocks.map((b) => b.length), [2, 2, 1]);
  });

  test('the LARGEST gaps win, not merely the first ones encountered', () => {
    // A small gap early (a dropped row) must not outrank a real block boundary.
    const rows = [r(10), r(12), r(13), r(800)];
    const blocks = splitGlRowsIntoBlocks(rows, 2);
    assert.equal(blocks.length, 2);
    assert.deepEqual(blocks.map((b) => b.length), [3, 1], 'the 787-row jump is the boundary, not the 2-row one');
  });

  test('never returns more blocks than requested', () => {
    const rows = [r(10), r(200), r(400), r(600)];
    assert.equal(splitGlRowsIntoBlocks(rows, 2).length, 2);
    assert.equal(splitGlRowsIntoBlocks(rows, 3).length, 3);
  });

  test('every input row appears exactly once across the blocks', () => {
    const rows = [r(10), r(11), r(500), r(900), r(901)];
    for (const n of [1, 2, 3, 4]) {
      const flat = splitGlRowsIntoBlocks(rows, n).flat();
      assert.equal(flat.length, rows.length, `blockCount=${n} must not lose or duplicate rows`);
      assert.deepEqual(new Set(flat.map((x) => x.id)).size, rows.length);
    }
  });
});
