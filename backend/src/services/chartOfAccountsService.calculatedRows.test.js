// Regression tests for: "Gross Profit was generated as a real COA account".
//
// CONFIRMED ROOT CAUSE these lock down: the P&L extractor already classifies
// every row STRUCTURALLY via `node_type`
// ('account' | 'total' | 'subtotal' | 'hierarchy_section' | 'hierarchy_group')
// and tags a computed statement line as `node_type: 'subtotal'`. The
// account-collection paths, however, tested only `is_total` / `is_header` and
// discarded that label. Those two flags do not cover a computed subtotal: the
// extractor derives `is_total` from /^total\b/ | /\btotal$/ | /\bnet income\b/,
// none of which match "Gross Profit" -- so it arrived with is_total=false,
// is_header=false and became a COA leaf with its own system id (INC-003) under
// Income. "Net Operating Income", "Net Other Income", "Operating Income" and
// "Net Loss" behaved identically.
//
// The fix is structural, not name-based: isRealPostingRow reads node_type. The
// account names below appear ONLY in this test file -- production code never
// matches on them.
//
// Run: node --test backend/src/services/chartOfAccountsService.calculatedRows.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');

const coa = require('./chartOfAccountsService.js');
const { isRealPostingRow } = coa;

// Rows shaped exactly as profitLossExtractionService emits them.
const plRow = (accountName, over = {}) => ({
  account_name: accountName,
  section: 'revenue',
  is_total: false,
  is_header: false,
  node_type: 'account',
  ...over,
});
const calculated = (name) => plRow(name, { node_type: 'subtotal' });

// ── the reported defect ─────────────────────────────────────────────────────

test('Gross Profit is NOT a real posting account', () => {
  assert.equal(isRealPostingRow(calculated('Gross Profit')), false);
});

test('every computed statement line the extractor tags as a subtotal is excluded', () => {
  // These are the labels the extractor's own isSubtotal test recognises. The
  // predicate does not read the name -- it reads node_type -- so an arbitrary
  // future metric tagged 'subtotal' is excluded too (asserted below).
  for (const name of [
    'Gross Profit', 'Net Operating Income', 'Net Other Income',
    'Operating Income', 'Net Income', 'Net Loss',
  ]) {
    assert.equal(isRealPostingRow(calculated(name)), false, `${name} must not be an account`);
  }
});

test('the exclusion is STRUCTURAL, not a name list — an unknown metric is excluded too', () => {
  assert.equal(isRealPostingRow(calculated('EBITDA')), false);
  assert.equal(isRealPostingRow(calculated('Contribution Margin')), false);
  assert.equal(isRealPostingRow(calculated('Some Metric Nobody Has Heard Of')), false);
});

test('conversely, a REAL account whose name merely resembles a metric is kept', () => {
  // Proves no name matching: identical names, opposite node_type -> opposite verdict.
  assert.equal(isRealPostingRow(plRow('Gross Profit', { node_type: 'account' })), true);
  assert.equal(isRealPostingRow(plRow('Interest Income')), true);
});

// ── real posting accounts must survive untouched ────────────────────────────

test('ordinary P&L accounts remain accounts', () => {
  for (const name of ['Sales', 'Discounts/Refunds Given', 'Interest Income', 'Refunds to Customers', 'Gain on Sale of Assets']) {
    assert.equal(isRealPostingRow(plRow(name)), true, `${name} must stay an account`);
  }
});

test('a parent account that carries its OWN posted amount is still an account', () => {
  // The extractor tags a row with amounts as 'account' even when a later
  // "Total for <name>" makes it a parent as well -- it can hold GL postings, so
  // it must remain a COA leaf.
  assert.equal(isRealPostingRow(plRow('Advertising and Marketing', { node_type: 'account' })), true);
});

// ── totals, headers and category rows ───────────────────────────────────────

test('group rollup totals are excluded', () => {
  assert.equal(isRealPostingRow(plRow('Total for Income', { node_type: 'total', is_total: true })), false);
  assert.equal(isRealPostingRow(plRow('Total for Expenses', { node_type: 'total', is_total: true })), false);
});

test('section headers and category groups are excluded (they carry no amounts)', () => {
  assert.equal(isRealPostingRow(plRow('Income', { node_type: 'hierarchy_section', is_header: true })), false);
  assert.equal(isRealPostingRow(plRow('Payroll expenses', { node_type: 'hierarchy_group' })), false);
});

test('is_total / is_header still exclude a row even when node_type says account', () => {
  assert.equal(isRealPostingRow(plRow('Something', { is_total: true })), false);
  assert.equal(isRealPostingRow(plRow('Something', { is_header: true })), false);
});

// ── backward compatibility ──────────────────────────────────────────────────

test('a row from an extraction predating node_type is still treated as an account', () => {
  const legacy = { account_name: 'Sales', is_total: false, is_header: false };
  assert.equal(isRealPostingRow(legacy), true, 'older parsed data must behave exactly as before');
  assert.equal(isRealPostingRow({ account_name: 'Sales', node_type: '', is_total: false }), true);
  assert.equal(isRealPostingRow({ account_name: 'Sales', node_type: null, is_total: false }), true);
});

test('node_type matching is case/whitespace tolerant', () => {
  assert.equal(isRealPostingRow(plRow('X', { node_type: ' ACCOUNT ' })), true);
  assert.equal(isRealPostingRow(plRow('X', { node_type: 'SubTotal' })), false);
});

test('malformed input never throws', () => {
  for (const bad of [null, undefined, {}]) {
    assert.doesNotThrow(() => isRealPostingRow(bad));
  }
  assert.equal(isRealPostingRow(null), false);
  assert.equal(isRealPostingRow(undefined), false);
});

// ── the predicate is actually applied where accounts are collected ──────────

test('both COA account-collection paths apply the structural gate', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, 'chartOfAccountsService.js'), 'utf8');
  // collectUniqueAccountNames (the AI/classification queue) ...
  assert.ok(/if \(r\.account_name && isRealPostingRow\(r\)\) add\(/.test(src),
    'collectUniqueAccountNames must gate plRows');
  // ... and buildCoaModel (the COA leaves themselves).
  assert.ok(/if \(!isRealPostingRow\(r\)\) continue;\s*\n\s*addLeaf\(r\.account_name/.test(src),
    'buildCoaModel must gate plRows before addLeaf');
});

test('the sync service filters plAccountRows with the same predicate', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'keyReports', 'keyReportSyncService.js'), 'utf8');
  assert.ok(/validRows\.filter\(isRealPostingRow\)/.test(src),
    'plAccountRows must use the structural predicate, not is_total/is_header alone');
  assert.equal(/validRows\.filter\(\(r\) => !r\.is_total && !r\.is_header\)/.test(src), false,
    'the old flag-only filter must be gone');
});

test('the account gate contains no "Gross Profit" name exception', () => {
  // What is forbidden is a name-based BRANCH that singles the metric out
  // (`=== "Gross Profit"`, `.includes("Gross Profit")`, a regex on it). A
  // display-LABEL map for a derived subtotal is legitimate and pre-existing --
  // keyReportSyncService's SUBTOTAL_LABEL maps the computed `grossProfit` figure
  // to its printed caption, which is exactly the "calculated row" treatment this
  // change is meant to preserve.
  const forbidden = [
    /[=!]==?\s*["'`]Gross Profit["'`]/,
    /["'`]Gross Profit["'`]\s*[=!]==?/,
    /\.includes\(\s*["'`]Gross Profit["'`]/,
    /\/[^\n]*Gross\s*Profit[^\n]*\/[gimsuy]*\.test/,
  ];
  for (const f of ['chartOfAccountsService.js', 'keyReports/keyReportSyncService.js']) {
    const src = require('fs').readFileSync(require('path').join(__dirname, f), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    for (const re of forbidden) {
      assert.equal(re.test(code), false, `${f} must not branch on the name "Gross Profit" (${re})`);
    }
  }
});

test('isRealPostingRow itself never inspects the account name', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, 'chartOfAccountsService.js'), 'utf8');
  const body = src.slice(src.indexOf('function isRealPostingRow'));
  const fnBody = body.slice(0, body.indexOf('\n}') + 2);
  assert.equal(/account_name/.test(fnBody), false, 'the predicate must be purely structural');
  assert.ok(/node_type/.test(fnBody), 'and must read the structural node_type');
});

// ── Gross Profit must STILL be produced by the report engine ───────────────

test('Gross Profit is still DERIVED by the statement builder, not sourced from an account', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, 'keyReports', 'financialStatementService.js'), 'utf8');
  assert.ok(/const grossProfit = safeNum\(totalRevenue - totalCogs\);/.test(src),
    'grossProfit must be computed as Revenue - COGS');
  assert.ok(/grossProfit,/.test(src), 'and returned on the statement');
});

test('buildPlStatement computes Gross Profit from the section totals', () => {
  const { buildPlStatement } = coa.__proto__ === undefined ? {} : {};
  // buildPlStatement lives in financialStatementService; exercise it there.
  const fs2 = require('./keyReports/financialStatementService.js');
  assert.equal(typeof fs2.buildPlStatement, 'function');
  // Two leaves: one revenue, one COGS. Gross Profit must be their difference and
  // must NOT come from any account named "Gross Profit".
  const leaves = [
    { id: 'r1', account_name: 'Sales', account_type: 'income', metadata: {}, displayAmount: 1000 },
    { id: 'c1', account_name: 'COGS - Materials', account_type: 'cogs', metadata: {}, displayAmount: 400 },
  ];
  const byId = new Map(leaves.map((l) => [l.id, { ...l, leafAmount: l.displayAmount, children: [] }]));
  const stmt = fs2.buildPlStatement(leaves, byId);
  assert.equal(stmt.revenue.total, 1000);
  assert.equal(stmt.costOfSales.total, 400);
  assert.equal(stmt.grossProfit, 600, 'Revenue - COGS');
});
