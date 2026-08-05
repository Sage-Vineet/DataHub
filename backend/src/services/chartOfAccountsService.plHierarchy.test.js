// Regression tests for P&L document-hierarchy inheritance in the Proposed COA.
//
// CONFIRMED ROOT CAUSE these lock down: COA leaf identity is accountKey() ->
// normName(), i.e. only trim().toLowerCase(). Document MATCHING, by contrast, is
// punctuation-tolerant (pickDocHierarchy -> normStrict/fuzzy). So a GL account
// spelled differently from its own P&L document row matched the right document
// node and inherited the right hierarchy, yet was still registered under its own
// key — producing TWO chart_of_accounts rows for one real account (8 leaves for
// 7 GL accounts on a reference-shaped document/GL pair).
//
// Every account/category name below is a TEST FIXTURE only. The implementation
// reads the uploaded document, never a name list — asserted at the end.
//
// Run: node --test backend/src/services/chartOfAccountsService.plHierarchy.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');

const coa = require('./chartOfAccountsService.js');
const { buildProfitLossTreeFromData, buildBalanceSheetTreeFromData } =
  require('./keyReports/referenceTreeBuilder.js');

// Rows exactly as profitLossExtractionService emits them (bracketing layout).
const H = (n, s) => ({ account_name: n, section: s, parent_path: [], is_total: false, is_header: true,  node_type: 'hierarchy_section', values: {} });
const G = (n, s) => ({ account_name: n, section: s, parent_path: [], is_total: false, is_header: false, node_type: 'hierarchy_group',   values: {} });
const A = (n, s, v = 100) => ({ account_name: n, section: s, parent_path: [], is_total: false, is_header: false, node_type: 'account',  values: { 'FY 2025': v } });
const T = (n, s) => ({ account_name: `Total for ${n}`, section: s, parent_path: [], is_total: true, is_header: false, node_type: 'total', values: { 'FY 2025': 100 } });
const S = (n, s) => ({ account_name: n, section: s, parent_path: [], is_total: false, is_header: false, node_type: 'subtotal', values: { 'FY 2025': 100 } });

const gl = (names, year = '2025') =>
  names.map((n, i) => ({ account_name: n, transaction_date: `${year}-06-${String((i % 28) + 1).padStart(2, '0')}`, source_file_id: 'gl-1' }));

async function run(plRows, glNames, { bsRows = [], year = 2025 } = {}) {
  const profitLossTree = buildProfitLossTreeFromData({ reportName: 'Profit and Loss', periodKeys: [`FY ${year}`], rows: plRows });
  const balanceSheetTree = bsRows.length
    ? buildBalanceSheetTreeFromData({ reportName: 'Balance Sheet', rows: bsRows })
    : null;
  const glRows = gl(glNames, String(year));
  const plForModel = plRows.filter((r) => coa.isRealPostingRow(r));
  const bsForModel = bsRows.filter((r) => !r.row_type || r.row_type === 'account');
  const bucket = coa.splitAccountsAtRetainedEarningsByYear(glRows, profitLossTree);
  const { leaves } = coa.buildCoaModel(
    glRows, bsForModel, plForModel, new Map(), new Map(), bucket, year,
    { profitLossTree, balanceSheetTree },
  );
  const resolved = await coa.buildLeafHierarchies(leaves);
  return {
    all: resolved,
    pl: resolved.filter((l) => l.statementType === 'profit_loss'),
    find: (n) => resolved.find((l) => String(l.accountName).toLowerCase() === String(n).toLowerCase()),
    path: (n) => {
      const l = resolved.find((x) => String(x.accountName).toLowerCase() === String(n).toLowerCase());
      return l ? (l.levels || []).filter(Boolean) : null;
    },
  };
}
/** Document-derived tail: everything after the code-defined statement anchor. */
const tail = (levels, n) => (levels || []).slice(-n);

// ── 1/2/19. Simple Income + Expenses, exact document match ─────────────────

test('1/19. document section is inherited verbatim for an exact-name GL account', async () => {
  const plRows = [
    H('Income', 'revenue'), A('Sales', 'revenue'), T('Income', 'revenue'),
    H('Expenses', 'operating_expenses'), A('Rent', 'operating_expenses'), T('Expenses', 'operating_expenses'),
  ];
  const r = await run(plRows, ['Sales', 'Rent']);
  assert.deepEqual(tail(r.path('Sales'), 2), ['Income', 'Sales']);
  assert.deepEqual(tail(r.path('Rent'), 2), ['Expenses', 'Rent']);
  assert.equal(r.find('Sales').classificationMethod, 'document_hierarchy');
});

test('4/17. multiple expense sub-sections each survive at full depth', async () => {
  const plRows = [
    H('Expenses', 'operating_expenses'),
    G('Payroll and Labor', 'operating_expenses'), A('Payroll Taxes', 'operating_expenses'), T('Payroll and Labor', 'operating_expenses'),
    G('General and Administrative', 'operating_expenses'), A('Telephone', 'operating_expenses'), T('General and Administrative', 'operating_expenses'),
    T('Expenses', 'operating_expenses'),
  ];
  const r = await run(plRows, ['Payroll Taxes', 'Telephone']);
  assert.deepEqual(tail(r.path('Payroll Taxes'), 3), ['Expenses', 'Payroll and Labor', 'Payroll Taxes']);
  assert.deepEqual(tail(r.path('Telephone'), 3), ['Expenses', 'General and Administrative', 'Telephone']);
});

test('3. a Cost of Sales sub-section is inherited like any other document group', async () => {
  const plRows = [
    H('Expenses', 'operating_expenses'),
    G('Cost of Sales', 'operating_expenses'), A('Job Supplies', 'operating_expenses'), T('Cost of Sales', 'operating_expenses'),
    T('Expenses', 'operating_expenses'),
  ];
  const r = await run(plRows, ['Job Supplies']);
  assert.deepEqual(tail(r.path('Job Supplies'), 3), ['Expenses', 'Cost of Sales', 'Job Supplies']);
});

test("18. a shallow document (account directly under its section) gets no invented level", async () => {
  const plRows = [H('Income', 'revenue'), A('Sales', 'revenue'), T('Income', 'revenue')];
  const r = await run(plRows, ['Sales']);
  assert.deepEqual(tail(r.path('Sales'), 2), ['Income', 'Sales']);
});

test('a different client vocabulary works with no code change', async () => {
  // Same algorithm, completely different section names — nothing is hardcoded.
  const plRows = [
    H('Revenue', 'revenue'), A('Product Revenue', 'revenue'), T('Revenue', 'revenue'),
    H('Operating Expenses', 'operating_expenses'),
    G('Payroll', 'operating_expenses'), A('Wages', 'operating_expenses'), T('Payroll', 'operating_expenses'),
    T('Operating Expenses', 'operating_expenses'),
  ];
  const r = await run(plRows, ['Product Revenue', 'Wages']);
  assert.deepEqual(tail(r.path('Product Revenue'), 2), ['Revenue', 'Product Revenue']);
  assert.deepEqual(tail(r.path('Wages'), 3), ['Operating Expenses', 'Payroll', 'Wages']);
});

// ── 20. normalized / punctuation matching — the actual defect ──────────────

test('20. a GL account spelled with different punctuation merges into ONE document-named account', async () => {
  const plRows = [
    H('Expenses', 'operating_expenses'),
    G('General and Administrative', 'operating_expenses'),
    A('Bank Charges and Fees', 'operating_expenses'),
    T('General and Administrative', 'operating_expenses'),
    T('Expenses', 'operating_expenses'),
  ];
  // GL spells it with "&" — the document spells it with "and".
  const r = await run(plRows, ['Bank Charges & Fees']);
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const matching = r.pl.filter((l) => norm(l.accountName) === norm('BankChargesAndFees') || norm(l.accountName) === norm('BankChargesFees'));
  assert.equal(matching.length, 1, `exactly one account expected, got ${matching.map((m) => m.accountName).join(' | ')}`);
  // Canonical identity comes from the document, and it inherits the full path.
  assert.equal(matching[0].accountName, 'Bank Charges and Fees');
  assert.deepEqual(tail(r.path('Bank Charges and Fees'), 3),
    ['Expenses', 'General and Administrative', 'Bank Charges and Fees']);
});

test('20. it is NOT dumped under the generic section just because the name matched', async () => {
  const plRows = [
    H('Expenses', 'operating_expenses'),
    G('General and Administrative', 'operating_expenses'),
    A('Bank Charges and Fees', 'operating_expenses'),
    T('General and Administrative', 'operating_expenses'),
    T('Expenses', 'operating_expenses'),
  ];
  const r = await run(plRows, ['Bank Charges & Fees']);
  const p = r.path('Bank Charges and Fees');
  assert.ok(p.includes('General and Administrative'), `sub-section lost: ${p.join(' > ')}`);
});

test('a GL account absent from the document keeps its own GL spelling', async () => {
  const plRows = [H('Expenses', 'operating_expenses'), A('Rent', 'operating_expenses'), T('Expenses', 'operating_expenses')];
  const r = await run(plRows, ['Rent', 'Totally Unrelated GL Account']);
  assert.ok(r.find('Totally Unrelated GL Account'), 'must not be renamed to some document node');
});

// ── 5-8/24. calculated nodes never become accounts ─────────────────────────

test('5/6/7/8/24. Gross Profit / Operating Income / Pretax Income / Net Income are not COA accounts', async () => {
  const plRows = [
    H('Income', 'revenue'), A('Sales', 'revenue'), T('Income', 'revenue'),
    S('Gross Profit', 'revenue'),
    H('Expenses', 'operating_expenses'), A('Rent', 'operating_expenses'), T('Expenses', 'operating_expenses'),
    S('Operating Income', 'operating_expenses'),
    S('Pretax Income', 'other_expense'),
    S('Net Income', 'other_expense'),
  ];
  const r = await run(plRows, ['Sales', 'Rent']);
  for (const calc of ['Gross Profit', 'Operating Income', 'Pretax Income']) {
    assert.equal(r.pl.some((l) => String(l.accountName).toLowerCase() === calc.toLowerCase()), false,
      `${calc} must not be a P&L COA account`);
  }
  // Net Income exists only as the deliberate synthetic BS equity closing line.
  const ni = r.find('Net Income');
  if (ni) assert.equal(ni.statementType, 'balance_sheet', 'Net Income may only exist as the BS equity line');
});

test('24. a calculated node is not created even when the GL has no such account', async () => {
  const plRows = [
    H('Income', 'revenue'), A('Sales', 'revenue'), T('Income', 'revenue'), S('Gross Profit', 'revenue'),
  ];
  const r = await run(plRows, ['Sales']);
  assert.equal(r.pl.length, 1);
  assert.equal(r.pl[0].accountName, 'Sales');
});

// ── 9/10. duplicate names, and P&L vs BS with the same name ────────────────

test('10. the same account name in P&L and BS resolves against its OWN statement tree', async () => {
  const plRows = [
    H('Expenses', 'operating_expenses'),
    G('Payroll and Labor', 'operating_expenses'), A('Payroll', 'operating_expenses'), T('Payroll and Labor', 'operating_expenses'),
    T('Expenses', 'operating_expenses'),
  ];
  const bsRows = [
    { account_name: 'Liabilities', section: 'liabilities', parent_path: [], amount: 0, is_heading: true,  node_type: 'hierarchy_section', is_total: false, row_type: 'heading' },
    { account_name: 'Accrued Liabilities', section: 'liabilities', parent_path: [], amount: 0, is_heading: true, node_type: 'hierarchy_group', is_total: false, row_type: 'heading' },
    { account_name: 'Payroll', section: 'liabilities', parent_path: [], amount: 500, is_heading: false, node_type: 'account', is_total: false, row_type: 'account' },
    { account_name: 'Total for Accrued Liabilities', section: 'liabilities', parent_path: [], amount: 500, is_total: true, node_type: 'total', row_type: 'total' },
    { account_name: 'Total for Liabilities', section: 'liabilities', parent_path: [], amount: 500, is_total: true, node_type: 'total', row_type: 'total' },
  ];
  const r = await run(plRows, ['Payroll'], { bsRows });
  const p = r.path('Payroll');
  assert.ok(p, 'Payroll must exist');
  // Whichever statement it resolved to, it must NOT mix both trees' vocabularies.
  const onPl = p.includes('Payroll and Labor');
  const onBs = p.includes('Accrued Liabilities');
  assert.equal(onPl && onBs, false, `cross-statement contamination: ${p.join(' > ')}`);
});

// ── 11-14. multi-year: one account, fiscal-year evidence preserved ─────────

test('11/13. one multi-year P&L: an account in every year is ONE COA account', async () => {
  const plRows = [];
  for (const y of [2023, 2024, 2025]) {
    plRows.push(
      H('Expenses', 'operating_expenses'),
      G('General and Administrative', 'operating_expenses'),
      { ...A('Bank Charges and Fees', 'operating_expenses'), fiscal_year: y },
      T('General and Administrative', 'operating_expenses'),
      T('Expenses', 'operating_expenses'),
    );
  }
  const glRows = [2023, 2024, 2025].map((y) => ({ account_name: 'Bank Charges & Fees', transaction_date: `${y}-06-01`, source_file_id: 'gl-1' }));
  const profitLossTree = buildProfitLossTreeFromData({ reportName: 'P&L', periodKeys: ['FY 2025'], rows: plRows });
  const plForModel = plRows.filter((x) => coa.isRealPostingRow(x));
  const bucket = coa.splitAccountsAtRetainedEarningsByYear(glRows, profitLossTree);
  const { leaves } = coa.buildCoaModel(glRows, [], plForModel, new Map(), new Map(), bucket, 2025, { profitLossTree });
  const resolved = await coa.buildLeafHierarchies(leaves);
  const hits = resolved.filter((l) => /bank charges/i.test(l.accountName));
  assert.equal(hits.length, 1, `one account expected, got ${hits.map((h) => h.accountName).join(' | ')}`);
  // No year-suffixed variants invented.
  assert.equal(resolved.some((l) => /\b20\d\d$/.test(String(l.accountName).trim())), false);
});

test('12/14. separate yearly P&L documents also yield ONE account, plus later-year additions', async () => {
  const doc = (y, extra = []) => [
    H('Expenses', 'operating_expenses'),
    G('General and Administrative', 'operating_expenses'),
    { ...A('Telephone', 'operating_expenses'), fiscal_year: y },
    ...extra.map((n) => ({ ...A(n, 'operating_expenses'), fiscal_year: y })),
    T('General and Administrative', 'operating_expenses'),
    T('Expenses', 'operating_expenses'),
  ];
  const plRows = [...doc(2024), ...doc(2025, ['Subscriptions'])];
  const r = await run(plRows, ['Telephone', 'Subscriptions']);
  assert.equal(r.pl.filter((l) => /telephone/i.test(l.accountName)).length, 1);
  assert.ok(r.find('Subscriptions'), 'an account first appearing in a later year must exist');
  assert.deepEqual(tail(r.path('Subscriptions'), 3), ['Expenses', 'General and Administrative', 'Subscriptions']);
});

test('15. an account in different document locations across years still yields ONE account', async () => {
  const plRows = [
    // 2024 places it under one group ...
    H('Expenses', 'operating_expenses'),
    G('General and Administrative', 'operating_expenses'),
    { ...A('Payroll', 'operating_expenses'), fiscal_year: 2024 },
    T('General and Administrative', 'operating_expenses'),
    T('Expenses', 'operating_expenses'),
    // ... 2025 under another.
    H('Expenses', 'operating_expenses'),
    G('Payroll and Labor', 'operating_expenses'),
    { ...A('Payroll', 'operating_expenses'), fiscal_year: 2025 },
    T('Payroll and Labor', 'operating_expenses'),
    T('Expenses', 'operating_expenses'),
  ];
  const r = await run(plRows, ['Payroll']);
  const hits = r.pl.filter((l) => /^payroll$/i.test(l.accountName));
  assert.equal(hits.length, 1, 'must not duplicate the account per year');
  const p = r.path('Payroll');
  // It must land under ONE of the two real document groups — never a blend.
  const under = ['General and Administrative', 'Payroll and Labor'].filter((g) => p.includes(g));
  assert.equal(under.length, 1, `expected exactly one document group, got ${p.join(' > ')}`);
});

// ── 16. missing hierarchy ───────────────────────────────────────────────────

test('16. an account the document gives no group for is not given an invented one', async () => {
  const plRows = [H('Expenses', 'operating_expenses'), A('Misc', 'operating_expenses'), T('Expenses', 'operating_expenses')];
  const r = await run(plRows, ['Misc']);
  assert.deepEqual(tail(r.path('Misc'), 2), ['Expenses', 'Misc']);
});

// ── 25. no hardcoding ───────────────────────────────────────────────────────

test('25. the canonicalization reads the document, not a name list', async () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, 'chartOfAccountsService.js'), 'utf8');
  const i = src.indexOf('const canonicalDocName =');
  assert.ok(i > 0, 'canonicalDocName must exist');
  const body = src.slice(i, i + 1400);
  // It may only consult the document lookups + the existing matcher.
  assert.ok(/pickDocHierarchy/.test(body), 'must reuse the existing document matcher');
  assert.ok(/plHierarchyByName|bsHierarchyByName/.test(body), 'must consult the document lookups');
  // And must not compare against any capitalised multi-word label — that would be
  // a hardcoded category/account name. (Bare "" / ".trim()" style literals are
  // ordinary string handling, not name matching.)
  const code = body.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  const nameLiterals = (code.match(/["'][A-Z][A-Za-z]+(?: [A-Za-z&]+)+["']/g) || []);
  assert.deepEqual(nameLiterals, [], `hardcoded name literal(s) found: ${nameLiterals.join(', ')}`);
});

test('25. the fixture category names appear nowhere in production code', async () => {
  const files = ['chartOfAccountsService.js', 'keyReports/referenceTreeBuilder.js'];
  for (const f of files) {
    const src = require('fs').readFileSync(require('path').join(__dirname, f), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    for (const name of ['Payroll and Labor', 'General and Administrative', 'Cost of Sales', 'Occupancy', 'Vehicle and Travel', 'Non-Cash and Below-Line', 'Bank Charges']) {
      assert.equal(code.includes(name), false, `${f} must not contain the literal "${name}"`);
    }
  }
});
