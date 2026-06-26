/**
 * Key Reports — Report Accuracy Validation Harness
 * =================================================
 *
 * Validates the Key Reports report ENGINE (keyReportReportService builders +
 * the shared indirect-method cash-flow engine) against the actual uploaded
 * reports for "Space Entertainment Center, LLC".
 *
 * Ground-truth figures below are transcribed directly from the uploaded PDFs:
 *   - 2022 BS & PL - Space Entertainement Center LLC.pdf
 *   - 2023 BS & PL - Space Entertainment Center LLC.pdf
 *
 * It feeds entry-table-shaped rows (exactly the shape balance_sheet_entries /
 * profit_loss_entries hold) through the real builders and compares every section
 * total to the PDF, printing a mismatch table:  Account | Expected | Generated | Diff.
 *
 * This requires NO database — it exercises the pure aggregation logic, which is
 * where report accuracy is won or lost. Run with:  node scripts/validateKeyReportsAccuracy.js
 */

const {
  buildBSHierarchicalRows,
  buildPLHierarchicalRows,
} = require('../src/services/keyReports/keyReportReportService');
const { buildCashFlow, generatedCfToRows } = require('../src/services/manualCashFlowService');

// ── fixture builders ──────────────────────────────────────────────────────────

let _sort = 0;
function bs(section, name, amount, isTotal = false) {
  return { account_name: name, section, account_type: section, amount, hierarchy_level: 1, is_total: isTotal, sort_order: _sort++ };
}
function pl(name, amount, { isTotal = false, isHeader = false } = {}) {
  return { account_name: name, amount, hierarchy_level: isHeader ? 0 : 1, is_total: isTotal, sort_order: _sort++ };
}

// ── 2022 Balance Sheet (from PDF) ───────────────────────────────────────────────
function bs2022() {
  _sort = 0;
  return [
    bs('Assets', 'Business Checking (7454)', 0),
    bs('Assets', 'Business Money Market', 0),
    bs('Assets', 'Provident Bank Business Checking', 85945.15),
    bs('Assets', 'Provident Bank Money Market Checking', 250437.94),
    bs('Assets', 'Total Bank Accounts', 336383.09, true),
    bs('Assets', 'Due from ERTC', 18861.0),
    bs('Assets', 'Inventory', 18020.0),
    bs('Assets', 'Total Other Current Assets', 36881.0, true),
    bs('Assets', 'Total Current Assets', 373264.09, true),
    bs('Assets', 'Accumulated Depreciation- F&F', -64987.37),
    bs('Assets', 'Furniture & Fixtures', 138779.67),
    bs('Assets', 'Machinery & Equipment', 1353905.30),
    bs('Assets', 'Total Fixed Assets', 769536.10, true),
    bs('Assets', 'Other Long-term Assets', 4568.0),
    bs('Assets', 'Total Other Assets', 4568.0, true),
    bs('Assets', 'Total Assets', 1147368.19, true),

    bs('Liabilities', 'Capital One - Credit Card', 32902.09),
    bs('Liabilities', 'Total Credit Cards', 63723.72, true),
    bs('Liabilities', 'Loan Payable- Officer', -415381.60),
    bs('Liabilities', 'Total Other Current Liabilities', -411326.60, true),
    bs('Liabilities', 'Total Current Liabilities', -347602.88, true),
    bs('Liabilities', 'Loan Payable- Provident Bank', 774721.59),
    bs('Liabilities', 'Total Long-Term Liabilities', 1484597.39, true),
    bs('Liabilities', 'Total Liabilities', 1136994.51, true),

    bs('Equity', 'Retained Earnings', -105522.70),
    bs('Equity', 'Net Income', 115896.38),
    bs('Equity', 'Total Equity', 10373.68, true),
  ];
}

// ── 2023 Balance Sheet (from PDF) ───────────────────────────────────────────────
function bs2023() {
  _sort = 0;
  return [
    bs('Assets', 'Provident Bank Business Checking', 6461.52),
    bs('Assets', 'Total Bank Accounts', 6461.52, true),
    bs('Assets', 'Inventory', 18995.0),
    bs('Assets', 'Loans to MTP', 308279.29),
    bs('Assets', 'Total Other Current Assets', 327274.29, true),
    bs('Assets', 'Total Current Assets', 333735.81, true),
    bs('Assets', 'Total Fixed Assets', 511843.10, true),
    bs('Assets', 'Total Other Assets', 4568.0, true),
    bs('Assets', 'Total Assets', 850146.91, true),

    bs('Liabilities', 'Total Credit Cards', 100256.10, true),
    bs('Liabilities', 'Total Other Current Liabilities', -670580.20, true),
    bs('Liabilities', 'Total Current Liabilities', -570324.10, true),
    bs('Liabilities', 'Total Long-Term Liabilities', 1306018.21, true),
    bs('Liabilities', 'Total Liabilities', 735694.11, true),

    bs('Equity', 'Retained Earnings', 10373.68),
    bs('Equity', 'Net Income', 104079.12),
    bs('Equity', 'Total Equity', 114452.80, true),
  ];
}

// ── 2023 Profit & Loss (from PDF) ────────────────────────────────────────────────
function pl2023() {
  _sort = 0;
  return [
    pl('Income', 0, { isHeader: true }),
    pl('Sales', 2948440.32),
    pl('Interest Income', 1679.44),
    pl('Discounts/Refunds Given', -22266.07),
    pl('Total Income', 2927853.69, { isTotal: true }),
    pl('Expenses', 0, { isHeader: true }),
    pl('Depreciation', 527538.0),
    pl('Payroll Expenses', 746144.45),
    pl('Total Expenses', 2823774.57, { isTotal: true }),
    pl('Net Income', 104079.12, { isTotal: true }),
  ];
}

// ── comparison + reporting ──────────────────────────────────────────────────────

const findNode = (rows, name) => {
  const want = String(name).toLowerCase().replace(/\s+/g, ' ').trim();
  let hit = null;
  const walk = (ns) => (ns || []).forEach((n) => {
    if (String(n.name).toLowerCase().replace(/\s+/g, ' ').trim() === want) hit = n;
    if (n.children) walk(n.children);
  });
  walk(rows);
  return hit;
};

const mismatches = [];
function check(label, expected, generated) {
  const diff = Math.round(((generated ?? NaN) - expected) * 100) / 100;
  const ok = Number.isFinite(generated) && Math.abs(diff) <= 0.01;
  mismatches.push({ Account: label, Expected: expected, Generated: generated, Difference: diff, status: ok ? 'OK' : 'MISMATCH' });
  return ok;
}

console.log('\n=== Key Reports Accuracy Validation: Space Entertainment Center, LLC ===\n');

// Balance Sheet — 2022 + 2023 multi-year build (mirrors getBalanceSheetReport).
const { hierarchicalRows: bsRows } = buildBSHierarchicalRows({ 2022: bs2022(), 2023: bs2023() }, [2022, 2023]);
const assets = findNode(bsRows, 'Assets');
const liab = findNode(bsRows, 'Liabilities');
const eq = findNode(bsRows, 'Equity');
const tle = findNode(bsRows, 'Total Liabilities and Equity');

console.log('— Balance Sheet (FY2023 column) —');
check('Total Assets', 850146.91, assets?.amounts?.y2023);
check('Total Liabilities', 735694.11, liab?.amounts?.y2023);
check('Total Equity', 114452.80, eq?.amounts?.y2023);
check('Total Liabilities and Equity', 850146.91, tle?.amounts?.y2023);
// Accounting identity: Assets must equal Liabilities + Equity.
check('Balance check (A = L + E)', 850146.91, (liab?.amounts?.y2023 || 0) + (eq?.amounts?.y2023 || 0));

console.log('  FY2022 column:');
check('Total Assets (2022)', 1147368.19, assets?.amounts?.y2022);
check('Total Liabilities (2022)', 1136994.51, liab?.amounts?.y2022);
check('Total Equity (2022)', 10373.68, eq?.amounts?.y2022);

// Profit & Loss — 2023 (mirrors getProfitLossReport).
const { hierarchicalRows: plRows } = buildPLHierarchicalRows({ 2023: pl2023() }, [2023]);
console.log('\n— Profit & Loss (FY2023) —');
check('Total Income', 2927853.69, findNode(plRows, 'Total Income')?.amount);
check('Total Expenses', 2823774.57, findNode(plRows, 'Total Expenses')?.amount);
check('Net Income', 104079.12, findNode(plRows, 'Net Income')?.amount);

// Cash Flow — 2023 (indirect, prior-year = 2022) — engine wiring + reconciliation.
const bsCurrTree = buildBSHierarchicalRows({ 2023: bs2023() }, [2023]).hierarchicalRows;
const bsPrevTree = buildBSHierarchicalRows({ 2022: bs2022() }, [2022]).hierarchicalRows;
const plTree = buildPLHierarchicalRows({ 2023: pl2023() }, [2023]).hierarchicalRows;
const cf = buildCashFlow({ bsPrevRows: bsPrevTree, bsCurrRows: bsCurrTree, plRows: plTree, year: 2023 });
const cfRows = generatedCfToRows(cf);
console.log('\n— Cash Flow (FY2023, indirect) —');
console.log('  Net Income (operating)   :', cf.data.operatingActivities[0].value);
console.log('  Depreciation (operating) :', cf.data.operatingActivities[1].value);
console.log('  Total Operating          :', cf.data.totalOperating);
console.log('  Total Investing          :', cf.data.totalInvesting);
console.log('  Total Financing          :', cf.data.totalFinancing);
console.log('  Beginning Cash (2022 BS) :', cf.data.beginningCash, '(expected 336383.09)');
console.log('  Net Cash Change          :', cf.data.netCashChange);
console.log('  Computed Ending Cash     :', cf.data.endingCash);
console.log('  BS Ending Cash (2023)    :', 6461.52);
console.log('  Reconciliation status    :', cf.data.reconciliationReport?.reconciliationStatus);
console.log('  CF section rows built     :', cfRows.length, '(expect 6: 3 sections + 3 summary rows)');
check('Cash Flow: Beginning Cash = prior-year BS cash', 336383.09, cf.data.beginningCash);
check('Cash Flow: engine produced full statement', 6, cfRows.length);

// ── Mismatch table ──────────────────────────────────────────────────────────────
console.log('\n=== Mismatch Report ===');
console.table(mismatches.map(({ status, ...row }) => ({ ...row, status })));

const failed = mismatches.filter((m) => m.status === 'MISMATCH');
if (failed.length) {
  console.error(`\n❌ ${failed.length} mismatch(es) — report logic does NOT match the uploaded reports.`);
  process.exit(1);
}
console.log('\n✅ All section totals match the uploaded actual reports.');
