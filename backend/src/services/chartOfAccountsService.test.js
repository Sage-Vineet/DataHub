// Unit tests for the Proposed COA / Approved COA split in chartOfAccountsService.js.
//
// No test framework is configured in this repo (checked both root and backend
// package.json — no jest/vitest/mocha) so this uses Node's built-in test
// runner, matching the existing ad-hoc verification convention in
// backend/scripts/validateFreshCoaGeneration.js / validatePlHierarchyAnchor.js.
//
// Run: node --test backend/src/services/chartOfAccountsService.test.js

const fs = require('fs');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const SERVICE_PATH = path.join(__dirname, 'chartOfAccountsService.js');
const coa = require(SERVICE_PATH);

test('fixedPrefixFor returns the non-redundant hierarchy anchors used by Proposed COA generation', () => {
  assert.deepEqual(coa.fixedPrefixFor('asset'), ASSET_FIXED_PREFIX);
  assert.deepEqual(coa.fixedPrefixFor('liability'), LIABILITY_FIXED_PREFIX);
  assert.deepEqual(coa.fixedPrefixFor('equity'), EQUITY_FIXED_PREFIX);
  assert.deepEqual(coa.fixedPrefixFor('income'), PL_FIXED_PREFIX);
  assert.deepEqual(coa.fixedPrefixFor('cogs'), PL_FIXED_PREFIX);
  assert.deepEqual(coa.fixedPrefixFor('expense'), PL_FIXED_PREFIX);
});

// ---------------------------------------------------------------------------
// Part 1a: buildProposedCoaTree must perform ZERO chart_of_accounts writes.
//
// Approach: a code-scan of the function's own source text, rather than
// mocking the real Supabase client. The real client (backend/src/lib/
// supabaseClient.js) requires live SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY
// credentials that won't be present in a test run — chartOfAccountsService.js
// require()-ing `../db` is itself safe (supabase is simply `null` without
// credentials — see backend/src/db/index.js), but actually CALLING any
// Supabase method on a null client would throw, so buildProposedCoaTree can't
// be exercised end-to-end here anyway. A code-scan of the exact function body
// asserting no `.insert(`/`.update(`/`.delete(`/`.upsert(` call exists is a
// more reliable regression guard for "this function performs no writes" than
// a mock that only proves today's call pattern, not tomorrow's.
// ---------------------------------------------------------------------------

function extractFunctionBody(sourceText, startMarker) {
  const startIdx = sourceText.indexOf(startMarker);
  assert.notEqual(startIdx, -1, `could not find "${startMarker}" in ${SERVICE_PATH}`);
  const afterStart = sourceText.slice(startIdx + startMarker.length);
  // Next top-level (zero-indent) function/async function declaration marks
  // the end of this function's body. Every function in this file is declared
  // at column 0, so this reliably finds the boundary without needing a full
  // brace-matching parser.
  const nextFnMatch = /\n(?:async )?function \w+\(/.exec(afterStart);
  assert.ok(nextFnMatch, `could not find the next top-level function declaration after "${startMarker}"`);
  return afterStart.slice(0, nextFnMatch.index);
}

test('buildProposedCoaTree body contains no chart_of_accounts write calls', () => {
  const sourceText = fs.readFileSync(SERVICE_PATH, 'utf8');
  const body = extractFunctionBody(sourceText, 'async function buildProposedCoaTree(');

  assert.ok(!/\.insert\s*\(/.test(body), 'buildProposedCoaTree must never call .insert(...)');
  assert.ok(!/\.update\s*\(/.test(body), 'buildProposedCoaTree must never call .update(...)');
  assert.ok(!/\.delete\s*\(/.test(body), 'buildProposedCoaTree must never call .delete(...)');
  assert.ok(!/\.upsert\s*\(/.test(body), 'buildProposedCoaTree must never call .upsert(...)');
  // It IS allowed (and expected) to read existing rows for hierarchy reuse.
  assert.ok(/\.select\s*\(/.test(body), 'sanity check: buildProposedCoaTree should still perform its expected reads');
});

test('persistApprovedCoaTree (for contrast) DOES contain write calls -- proves the scan itself is meaningful', () => {
  const sourceText = fs.readFileSync(SERVICE_PATH, 'utf8');
  const body = extractFunctionBody(sourceText, 'async function persistApprovedCoaTree(');
  const hasWrite = /\.insert\s*\(/.test(body) || /\.update\s*\(/.test(body) || /\.delete\s*\(/.test(body) || /\.upsert\s*\(/.test(body);
  assert.ok(hasWrite, 'persistApprovedCoaTree is expected to write -- if this ever fails, the scan boundaries have drifted');
});

// ---------------------------------------------------------------------------
// Part 1b: serializeProposedTree / deserializeApprovedTree / validateFinalCoaTree
// -- pure functions, no DB access, safe to test directly with hand-built
// fixtures.
// ---------------------------------------------------------------------------

// Exact fixed anchors from chartOfAccountsService.js (ASSET_FIXED_PREFIX /
// LIABILITY_FIXED_PREFIX / EQUITY_FIXED_PREFIX / PL_FIXED_PREFIX), reproduced here so a
// drift in either file is caught by a failing test rather than silently
// validating against the wrong prefix.
// Per the Balance Sheet level specification the asset anchor is "Total Assets"
// at BOTH level_1 and level_2; document-derived levels start at level_3.
const ASSET_FIXED_PREFIX = ['Total Assets', 'Total Assets'];
const LIABILITY_FIXED_PREFIX = ['Total Liabilities and Equity', 'Total Liabilities'];
// Equity's anchor is 4 levels per the Balance Sheet level specification:
// L1 "Total Liabilities and Equity", L2/L3 "Total Equity", L4 "Equity".
const EQUITY_FIXED_PREFIX = ['Total Liabilities and Equity', 'Total Equity', 'Total Equity', 'Equity'];
const PL_FIXED_PREFIX = ['Total Liabilities and Equity', 'Total Equity', 'Total Equity'];

function makeAssetLeaf(overrides = {}) {
  return {
    accountName: 'Checking',
    accountNumber: '1010',
    accountType: 'asset',
    statementType: 'balance_sheet',
    levels: [...ASSET_FIXED_PREFIX, 'Current Assets', 'Bank Accounts', 'Checking'],
    displayName: 'Checking',
    classificationMethod: 'document_hierarchy',
    matchTier: 'bs_section',
    confidence: 0.95,
    needsReview: false,
    needsMapping: false,
    sources: new Set(['balance_sheet']),
    fiscalYears: new Set([2024]),
    clientAccountId: null,
    mappedNormalBalance: 'debit',
    sortOrder: 1,
    hierarchyPath: [...ASSET_FIXED_PREFIX, 'Current Assets', 'Bank Accounts', 'Checking'].join(' > '),
    ...overrides,
  };
}

function makeExpenseLeaf(overrides = {}) {
  return {
    accountName: 'Salaries',
    accountNumber: '6010',
    accountType: 'expense',
    statementType: 'profit_loss',
    levels: [...PL_FIXED_PREFIX, 'Operating Expenses', 'Salaries'],
    displayName: 'Salaries',
    classificationMethod: 'document_hierarchy',
    matchTier: 'pl_section',
    confidence: 0.9,
    needsReview: false,
    needsMapping: false,
    sources: new Set(['profit_loss']),
    fiscalYears: new Set([2024]),
    clientAccountId: null,
    mappedNormalBalance: 'debit',
    sortOrder: 2,
    hierarchyPath: [...PL_FIXED_PREFIX, 'Operating Expenses', 'Salaries'].join(' > '),
    ...overrides,
  };
}

test('valid two-account fixture round-trips serialize -> validate as {valid:true, violations:[]}', () => {
  const hierarchical = [makeAssetLeaf(), makeExpenseLeaf()];
  const nodes = coa.serializeProposedTree(hierarchical);
  const result = coa.validateFinalCoaTree(nodes);
  assert.deepEqual(result.violations, []);
  assert.equal(result.valid, true);
});

test('serializeProposedTree includes deterministic proposal system ids and level metadata', () => {
  const assetLeaf = makeAssetLeaf();
  const expenseLeaf = makeExpenseLeaf();
  const nodes = coa.serializeProposedTree([assetLeaf, expenseLeaf]);
  const accounts = nodes.filter((n) => n.nodeType === 'ACCOUNT');
  const byName = new Map(accounts.map((n) => [n.accountName, n]));

  assert.match(byName.get('Checking').systemId, /^BS-\d{3}$/);
  assert.match(byName.get('Salaries').systemId, /^EXP-\d{3}$/);
  assert.deepEqual(byName.get('Checking').levels.filter(Boolean), assetLeaf.levels);
  assert.deepEqual(byName.get('Salaries').levels.filter(Boolean), expenseLeaf.levels);
  assert.equal(byName.get('Checking').level, assetLeaf.levels.length);
  assert.equal(byName.get('Salaries').level, expenseLeaf.levels.length);
});

test('deserializeApprovedTree preserves reviewed proposal system ids for save-time persistence', () => {
  const nodes = coa.serializeProposedTree([makeAssetLeaf()]);
  const accountNode = nodes.find((n) => n.nodeType === 'ACCOUNT');
  assert.match(accountNode.systemId, /^BS-\d{3}$/);

  const { hierarchical, violations } = coa.deserializeApprovedTree(nodes);
  assert.deepEqual(violations, []);
  assert.equal(hierarchical.length, 1);
  assert.equal(hierarchical[0].systemId, accountNode.systemId);
  assert.deepEqual(hierarchical[0].levels.filter(Boolean), makeAssetLeaf().levels);
});

test('circular parentKey reference between two CATEGORY nodes is rejected', () => {
  const nodes = [
    { key: 'catA', parentKey: 'catB', nodeType: 'CATEGORY', label: 'A', accountType: 'asset', statementType: 'balance_sheet' },
    { key: 'catB', parentKey: 'catA', nodeType: 'CATEGORY', label: 'B', accountType: 'asset', statementType: 'balance_sheet' },
    { key: 'acct1', parentKey: 'catA', nodeType: 'ACCOUNT', accountName: 'Leaf', accountType: 'asset', statementType: 'balance_sheet' },
  ];
  const result = coa.validateFinalCoaTree(nodes);
  assert.equal(result.valid, false);
  assert.ok(result.violations.some((v) => v.toLowerCase().includes('circular')));
});

test('orphan parentKey (references a key not present in the array) is rejected', () => {
  const nodes = [
    { key: 'acct1', parentKey: 'cat-does-not-exist', nodeType: 'ACCOUNT', accountName: 'Orphan Leaf', accountType: 'asset', statementType: 'balance_sheet' },
  ];
  const result = coa.validateFinalCoaTree(nodes);
  assert.equal(result.valid, false);
  assert.ok(result.violations.some((v) => v.includes('does not exist')));
});

test('duplicate key across two nodes is rejected', () => {
  const nodes = [
    { key: 'dup', parentKey: null, nodeType: 'ACCOUNT', accountName: 'A', accountType: 'asset', statementType: 'balance_sheet' },
    { key: 'dup', parentKey: null, nodeType: 'ACCOUNT', accountName: 'B', accountType: 'asset', statementType: 'balance_sheet' },
  ];
  const result = coa.validateFinalCoaTree(nodes);
  assert.equal(result.valid, false);
  assert.ok(result.violations.some((v) => v.includes('Duplicate node key')));
});

test('an ACCOUNT node referenced as another node\'s parentKey is rejected ("can never have children")', () => {
  const nodes = [
    { key: 'acctParent', parentKey: null, nodeType: 'ACCOUNT', accountName: 'ParentLeaf', accountType: 'asset', statementType: 'balance_sheet' },
    { key: 'acctChild', parentKey: 'acctParent', nodeType: 'ACCOUNT', accountName: 'ChildLeaf', accountType: 'asset', statementType: 'balance_sheet' },
  ];
  const result = coa.validateFinalCoaTree(nodes);
  assert.equal(result.valid, false);
  assert.ok(result.violations.some((v) => v.includes('can never have children')));
});

test('depth exceeding MAX_LEVELS (15) is rejected', () => {
  // 16 nested CATEGORY nodes + 1 ACCOUNT leaf = a 17-node ancestor chain,
  // which trips walkNodeAncestry's `chain.length > MAX_LEVELS + 1` (16) guard.
  const categories = [];
  let parentKey = null;
  for (let i = 0; i < 16; i += 1) {
    const key = `cat${i}`;
    categories.push({ key, parentKey, nodeType: 'CATEGORY', label: `Level ${i}`, accountType: 'asset', statementType: 'balance_sheet' });
    parentKey = key;
  }
  const account = { key: 'acctDeep', parentKey, nodeType: 'ACCOUNT', accountName: 'Deep Account', accountType: 'asset', statementType: 'balance_sheet' };
  const nodes = [...categories, account];
  const result = coa.validateFinalCoaTree(nodes);
  assert.equal(result.valid, false);
  assert.ok(result.violations.some((v) => v.includes('exceeds the maximum')));
});

test('a node missing the correct fixed anchor prefix for its accountType is rejected', () => {
  // Asset account rooted directly under "Current Assets" -- skips the
  // required ASSET_FIXED_PREFIX ("Total Assets") entirely.
  const nodes = [
    { key: 'cat:current-assets', parentKey: null, nodeType: 'CATEGORY', label: 'Current Assets', accountType: 'asset', statementType: 'balance_sheet' },
    { key: 'acct:cash', parentKey: 'cat:current-assets', nodeType: 'ACCOUNT', accountName: 'Cash', accountType: 'asset', statementType: 'balance_sheet' },
  ];
  const result = coa.validateFinalCoaTree(nodes);
  assert.equal(result.valid, false);
  assert.ok(result.violations.some((v) => v.includes('expected to start with')));
});

test('userEdited: true forces classificationMethod=manual_review, matchTier=null, confidence=1, needsReview/needsMapping=false', () => {
  const nodes = [
    { key: 'cat:ta1', parentKey: null, nodeType: 'CATEGORY', label: 'Total Assets', accountType: 'asset', statementType: 'balance_sheet' },
    {
      key: 'acct:cash', parentKey: 'cat:ta1', nodeType: 'ACCOUNT', accountName: 'Cash',
      accountType: 'asset', statementType: 'balance_sheet',
      userEdited: true,
      // Deliberately "polluted" input fields that userEdited must override.
      classificationMethod: 'client_workbook', matchTier: 'exact', confidence: 0.4,
      needsReview: true, needsMapping: true,
    },
  ];
  const { hierarchical, violations } = coa.deserializeApprovedTree(nodes);
  assert.deepEqual(violations, []);
  assert.equal(hierarchical.length, 1);
  const [leaf] = hierarchical;
  assert.equal(leaf.classificationMethod, 'manual_review');
  assert.equal(leaf.matchTier, null);
  assert.equal(leaf.confidence, 1);
  assert.equal(leaf.needsReview, false);
  assert.equal(leaf.needsMapping, false);
});

// ---------------------------------------------------------------------------
// Part 1c: classificationSourceLabel
// ---------------------------------------------------------------------------

test('classificationSourceLabel: client_workbook / document_hierarchy / rule -> DOCUMENT', () => {
  assert.equal(coa.classificationSourceLabel({ classificationMethod: 'client_workbook' }), 'DOCUMENT');
  assert.equal(coa.classificationSourceLabel({ classificationMethod: 'document_hierarchy' }), 'DOCUMENT');
  assert.equal(coa.classificationSourceLabel({ classificationMethod: 'rule' }), 'DOCUMENT');
});

test('classificationSourceLabel: matchTier "ai_hierarchy" -> AI_FALLBACK (even over a DOCUMENT-looking classificationMethod)', () => {
  assert.equal(
    coa.classificationSourceLabel({ matchTier: 'ai_hierarchy', classificationMethod: 'client_workbook' }),
    'AI_FALLBACK',
  );
});

test('classificationSourceLabel: unresolved / no-match leaf -> AI_FALLBACK (an AI-fallback ATTEMPT, not a document match)', () => {
  assert.equal(
    coa.classificationSourceLabel({ classificationMethod: null, matchTier: null, needsMapping: true }),
    'AI_FALLBACK',
  );
});

test('GL partition uses standalone Retained Earnings heading and includes it in P&L', () => {
  const rows = [
    { account_name: 'Cash' },
    { account_name: 'Loan Payable - Bank' },
    { account_name: 'Retained Earnings' },
    { account_name: '66000 Payroll Expenses' },
    { account_name: 'Office Rent' },
  ];
  const buckets = coa.splitAccountsAtRetainedEarnings(rows, null);

  assert.equal(buckets.get('cash'), 'balance_sheet');
  assert.equal(buckets.get('loan payable - bank'), 'balance_sheet');
  assert.equal(buckets.get('retained earnings'), 'profit_loss');
  assert.equal(buckets.get('66000 payroll expenses'), 'profit_loss');
  assert.equal(buckets.get('payroll expenses'), 'profit_loss');
  assert.equal(buckets.get('office rent'), 'profit_loss');
});

test('GL partition ignores retained earnings text outside parsed account headings', () => {
  const rows = [
    { account_name: 'Cash', memo: 'To Post the Distribution into Retained Earnings' },
    { account_name: 'Loan Payable - Bank', description: 'Transfer to Retained Earnings' },
    { account_name: 'Retained Earnings' },
    { account_name: 'Total for Retained Earnings' },
    { account_name: '66000 Payroll Expenses' },
  ];
  const buckets = coa.splitAccountsAtRetainedEarnings(rows, null);

  assert.equal(buckets.get('cash'), 'balance_sheet');
  assert.equal(buckets.get('loan payable - bank'), 'balance_sheet');
  assert.equal(buckets.get('retained earnings'), 'profit_loss');
  assert.equal(buckets.get('total for retained earnings'), undefined);
  assert.equal(buckets.get('payroll expenses'), 'profit_loss');
});

test('missing Retained Earnings falls back to first postable P&L account and includes that block in P&L', () => {
  const plTree = {
    name: 'Profit and Loss',
    nodeType: 'REPORT',
    children: [{
      name: 'Net Income',
      nodeType: 'CALCULATED_TOTAL',
      children: [
        { name: 'Total for Income', nodeType: 'TOTAL', children: [{ name: 'Sales', nodeType: 'ACCOUNT', children: [] }] },
      ],
    }],
  };
  const rows = [
    { account_name: 'Cash' },
    { account_name: 'Accounts Payable' },
    { account_name: '4000 Sales' },
    { account_name: 'Advertising Expense' },
  ];
  const buckets = coa.splitAccountsAtRetainedEarnings(rows, plTree);

  assert.equal(buckets.get('cash'), 'balance_sheet');
  assert.equal(buckets.get('accounts payable'), 'balance_sheet');
  assert.equal(buckets.get('4000 sales'), 'profit_loss');
  assert.equal(buckets.get('sales'), 'profit_loss');
  assert.equal(buckets.get('advertising expense'), 'profit_loss');
});

test('missing Retained Earnings creates no arbitrary boundary when first P&L account is absent from GL headings', () => {
  const plTree = { name: 'Profit and Loss', nodeType: 'REPORT', children: [{ name: 'Sales', nodeType: 'ACCOUNT', children: [] }] };
  const buckets = coa.splitAccountsAtRetainedEarnings([{ account_name: 'Cash' }, { account_name: 'Accounts Payable' }], plTree);
  assert.equal(buckets.size, 0);
});

test('multi-file GL upload computes the Retained Earnings boundary independently per source file', () => {
  // Uses splitAccountsAtRetainedEarningsByYear (the production orchestration
  // layer both real call sites use), not the bare single-pass
  // splitAccountsAtRetainedEarnings -- the bare function is one boundary-
  // finding pass over whatever rows it's handed; per-file (and per-year)
  // partitioning is this wrapper's job, via a composite (year, source file)
  // grouping key. No transaction_date is given here on purpose, to prove
  // source_file_id alone -- always set by extraction, regardless of whether
  // a row's date parses -- is enough to separate the two files' boundaries.
  const rows = [
    // File "2021" — no Balance Sheet account beyond Cash.
    { account_name: 'Cash', source_file_id: 'file-2021' },
    { account_name: 'Retained Earnings', source_file_id: 'file-2021' },
    { account_name: 'Payroll Expenses', source_file_id: 'file-2021' },
    // File "2022" — introduces a NEW Balance Sheet account (e.g. a bank
    // account opened in 2022) that never appeared in the 2021 file. Within
    // file 2022's own layout it still sits above that file's own Retained
    // Earnings line, so it must classify as balance_sheet even though it is
    // only first seen via the second file's rows.
    { account_name: 'Cash', source_file_id: 'file-2022' },
    { account_name: 'New Bank Account', source_file_id: 'file-2022' },
    { account_name: 'Retained Earnings', source_file_id: 'file-2022' },
    { account_name: 'Payroll Expenses', source_file_id: 'file-2022' },
  ];
  const buckets = coa.splitAccountsAtRetainedEarningsByYear(rows, null);

  assert.equal(buckets.get('cash'), 'balance_sheet');
  assert.equal(buckets.get('new bank account'), 'balance_sheet');
  assert.equal(buckets.get('retained earnings'), 'profit_loss');
  assert.equal(buckets.get('payroll expenses'), 'profit_loss');
});

test('same account across two fiscal years\' GL files merges into ONE leaf even when its account_number differs between years', () => {
  // Common in practice: a QuickBooks/Xero export can assign a different (or
  // no) internal account number to the identical real account from one
  // fiscal year's export to the next.
  const glRows = [
    { account_name: 'Bank Earnings', account_number: '1010', transaction_date: '2021-06-15', source_file_id: 'file-2021' },
    { account_name: 'Bank Earnings', account_number: '1015', transaction_date: '2022-07-20', source_file_id: 'file-2022' },
  ];
  const { leaves } = coa.buildCoaModel(glRows, [], [], new Map(), new Map(), new Map());
  const bankEarningsLeaves = leaves.filter((l) => l.accountName === 'Bank Earnings');

  assert.equal(bankEarningsLeaves.length, 1);
  const [leaf] = bankEarningsLeaves;
  // Keeps the first-seen account number rather than forking a second leaf.
  assert.equal(leaf.accountNumber, '1010');
  assert.deepEqual([...leaf.fiscalYears].sort(), [2021, 2022]);
});

test('partitioned document matching searches only the selected statement tree', () => {
  const bsTree = {
    name: 'Balance Sheet', nodeType: 'REPORT', children: [
      { name: 'Total for Assets', nodeType: 'TOTAL', children: [{ name: 'Interest', nodeType: 'ACCOUNT', children: [] }] },
    ],
  };
  const plTree = {
    name: 'Profit and Loss', nodeType: 'REPORT', children: [
      { name: 'Total for Expenses', nodeType: 'TOTAL', children: [{ name: 'Office Rent', nodeType: 'ACCOUNT', children: [] }] },
    ],
  };
  const bsLookup = coa.buildTreeHierarchyLookup(bsTree, 'balance_sheet');
  const plLookup = coa.buildTreeHierarchyLookup(plTree, 'profit_loss');

  assert.equal(
    coa.pickDocHierarchy('Interest', 'interest', null, bsLookup, plLookup, null, { statementType: 'profit_loss' }),
    null,
  );
  assert.equal(
    coa.pickDocHierarchy('Office Rent', 'office rent', null, bsLookup, plLookup, null, { statementType: 'balance_sheet' }),
    null,
  );
});

test('partition statement type remains authoritative over equity account type and hierarchy prefix', async () => {
  const [leaf] = await coa.buildLeafHierarchies([{
    accountName: 'Retained Earnings',
    accountType: 'equity',
    statementType: 'profit_loss',
    partitionStatementType: 'profit_loss',
    classificationMethod: 'document_hierarchy',
    matchLevels: ['Net Income', 'Net Operating Income', 'Expenses'],
    confidence: 1,
    needsReview: false,
  }]);

  assert.equal(leaf.statementType, 'profit_loss');
  assert.deepEqual(leaf.levels.filter(Boolean).slice(0, 3), PL_FIXED_PREFIX);
  assert.equal(leaf.levels.filter(Boolean).at(-1), 'Retained Earnings');
  assert.equal(leaf.levels.filter(Boolean).includes('Total Liabilities'), false);
});

test('final hierarchy builder applies statement-specific prefixes and cleaned dynamic labels', () => {
  assert.deepEqual(
    coa.buildFinalCoaLevels({ statementType: 'balance_sheet', accountType: 'asset', matchedPath: ['Total for Assets', 'Total for Current Assets', 'Total for Bank Accounts'], accountName: 'Cash Account' }),
    ['Total Assets', 'Total Assets', 'Current Assets', 'Bank Accounts', 'Cash Account'],
  );
  assert.deepEqual(
    coa.buildFinalCoaLevels({ statementType: 'balance_sheet', accountType: 'liability', matchedPath: ['Total for Liabilities and Equity', 'Total for Liabilities', 'Total for Current Liabilities', 'Total for Credit Cards'], accountName: 'Capital One - Credit Card' }),
    ['Total Liabilities and Equity', 'Total Liabilities', 'Current Liabilities', 'Credit Cards', 'Capital One - Credit Card'],
  );
  assert.deepEqual(
    coa.buildFinalCoaLevels({ statementType: 'balance_sheet', accountType: 'equity', matchedPath: ['Total for Liabilities and Equity', 'Total for Equity'], accountName: 'Net Income' }),
    ['Total Liabilities and Equity', 'Total Equity', 'Total Equity', 'Equity', 'Net Income'],
  );
  assert.deepEqual(
    coa.buildFinalCoaLevels({ statementType: 'profit_loss', accountType: 'expense', matchedPath: ['Net Income', 'Net Operating Income', 'Total for Expenses'], accountName: 'Payroll Expenses' }),
    ['Total Liabilities and Equity', 'Total Equity', 'Total Equity', 'Net Income', 'Net Operating Income', 'Expenses', 'Payroll Expenses'],
  );
});
