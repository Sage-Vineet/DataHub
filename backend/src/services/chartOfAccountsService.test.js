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
const ASSET_FIXED_PREFIX = ['Total Assets'];
const LIABILITY_FIXED_PREFIX = ['Total Liabilities and Equity', 'Total Liabilities'];
const EQUITY_FIXED_PREFIX = ['Total Liabilities and Equity', 'Total Equity', 'Equity'];
const PL_FIXED_PREFIX = ['Total Liabilities and Equity', 'Total Equity'];

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
    { key: 'cat:ta2', parentKey: 'cat:ta1', nodeType: 'CATEGORY', label: 'Total Assets', accountType: 'asset', statementType: 'balance_sheet' },
    {
      key: 'acct:cash', parentKey: 'cat:ta2', nodeType: 'ACCOUNT', accountName: 'Cash',
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
