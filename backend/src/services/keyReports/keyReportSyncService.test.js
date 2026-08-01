// Focused regression tests for the Proposed COA / Approved COA gate inside
// keyReportSyncService.js's generateFinancialTables (PROPOSE MODE vs APPROVE
// MODE, selected by whether `approvedTreeNodes` is passed).
//
// generateFinancialTables has heavy real dependencies (Supabase, document
// extraction services, the AI classifier, several other keyReports services)
// that make a full integration test impractical without live infrastructure.
// This file stubs out the module's OWN dependencies instead of the function
// under test, then asserts the propose/approve/halt behavior actually runs.
//
// Mocking approach: keyReportSyncService.js destructures its dependencies at
// require time, e.g.:
//   const { buildProposedCoaTree, persistApprovedCoaTree, ... } = require('../chartOfAccountsService');
// A destructured const captures the function VALUE once; reassigning a
// property on the real (or a naively faked) module object afterwards has no
// effect on keyReportSyncService's already-captured reference. To make the
// stubs reconfigurable per test, each faked module exports a stable wrapper
// function that forwards to a mutable `coaState`/`calls` object at CALL time
// (not require time) -- the wrapper reference is what gets destructured and
// frozen, but what it forwards to can still change between tests.
//
// require.cache is pre-populated for every dependency keyReportSyncService.js
// requires, BEFORE it is first required here, so its own require() calls
// resolve to these fakes instead of touching a live Supabase project.
//
// Run: node --test backend/src/services/keyReports/keyReportSyncService.test.js

const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const dbPath = require.resolve('../../db');
const coaServicePath = require.resolve('../chartOfAccountsService');
const accountingServicePath = require.resolve('./keyReportAccountingService');
const validationServicePath = require.resolve('./keyReportValidationService');
const keyReportServicePath = require.resolve('./keyReportService');
const keyReportReportServicePath = require.resolve('./keyReportReportService');

// ---------------------------------------------------------------------------
// Generic chainable Supabase query stub. Every Supabase-builder method
// (.select/.eq/.or/.gte/.lte/.range/...) returns the same chain object;
// awaiting it at any point resolves to `result` (thenable), and
// .maybeSingle()/.single() resolve directly. Good enough for the read paths
// generateFinancialTables exercises before it ever reaches the COA gate
// (clearing generated BS rows, counting entry-table rows for validation
// summaries) without needing a real Supabase project.
// ---------------------------------------------------------------------------
function makeQueryStub(result = { data: [], error: null, count: 0 }) {
  const chain = {};
  const passthroughMethods = ['select', 'eq', 'or', 'gte', 'lte', 'in', 'order', 'range', 'neq', 'is', 'not', 'limit', 'delete', 'update', 'insert', 'upsert'];
  for (const m of passthroughMethods) chain[m] = () => chain;
  chain.maybeSingle = () => Promise.resolve(result);
  chain.single = () => Promise.resolve(result);
  chain.then = (resolve) => resolve(result);
  chain.catch = () => chain;
  return chain;
}

require.cache[dbPath] = {
  exports: {
    supabase: { from: () => makeQueryStub() },
    pool: null,
    engine: 'mock',
    ready: Promise.resolve(),
    isCircuitBreakerOpen: () => false,
    recordSupabaseError: () => {},
    resetSupabaseErrors: () => {},
  },
};

// Mutable, per-test-reconfigurable behavior for the four Proposed/Approved
// COA functions. See the file-header comment for why the indirection through
// `coaState` (rather than directly reassigning the faked module's exports) is
// necessary.
const coaState = {
  buildProposedCoaTree: async () => ({ hierarchical: [], matchSummary: { documentMatchedCount: 0, aiFallbackCount: 0, needsMappingCount: 0, totalCount: 0 } }),
  persistApprovedCoaTree: async () => ({ leafCount: 0, inserted: 0, updated: 0, deleted: 0 }),
  serializeProposedTree: () => [],
  validateFinalCoaTree: () => ({ valid: true, violations: [], hierarchical: [] }),
};

// Call counters so tests can assert a function was (or, importantly, was
// NEVER) invoked -- the actual regression guard this file exists for.
const calls = {
  buildProposedCoaTree: 0,
  persistApprovedCoaTree: 0,
  validateFinalCoaTree: 0,
  generateTrialBalance: 0,
  generateMonthlyBalanceSheets: 0,
  generateReconciliation: 0,
  linkGlToCoa: 0,
};
function resetCalls() {
  for (const k of Object.keys(calls)) calls[k] = 0;
}

require.cache[coaServicePath] = {
  exports: {
    validateChartOfAccounts: () => {},
    ensureCoaComplete: async () => ({ added: 0, skipped: 0 }),
    printCoaValidationBlock: () => {},
    finalizeCoaHierarchy: async () => ({}),
    buildProposedCoaTree: (...args) => { calls.buildProposedCoaTree += 1; return coaState.buildProposedCoaTree(...args); },
    persistApprovedCoaTree: (...args) => { calls.persistApprovedCoaTree += 1; return coaState.persistApprovedCoaTree(...args); },
    serializeProposedTree: (...args) => coaState.serializeProposedTree(...args),
    validateFinalCoaTree: (...args) => { calls.validateFinalCoaTree += 1; return coaState.validateFinalCoaTree(...args); },
  },
};

require.cache[accountingServicePath] = {
  exports: {
    // A permissive gate: canGenerate:true so every test reaches Step 6 (Chart
    // of Accounts / the Propose-vs-Approve branch) rather than halting
    // earlier at the document-validation gate.
    classifyWorkflowDocuments: async () => ({
      canGenerate: true,
      hasGL: true, glRowCount: 1, glStartYear: 2024, glEndYear: 2024,
      hasOpeningBs: true, openingBsMode: 'opening', openingBs: { fiscal_year: 2024 },
      hasEndingBs: true, endingBs: { fiscal_year: 2024 },
      hasProfitLoss: true, balanceSheetMode: 'forward', bsCoverage: null, rows: [],
    }),
    generateTrialBalance: async () => { calls.generateTrialBalance += 1; return {}; },
    generateMonthlyBalanceSheets: async () => { calls.generateMonthlyBalanceSheets += 1; return {}; },
    generateMonthlyBalanceSheetsReverse: async () => { calls.generateMonthlyBalanceSheets += 1; return {}; },
    generateReconciliation: async () => { calls.generateReconciliation += 1; return {}; },
    linkGlToCoa: async () => { calls.linkGlToCoa += 1; return { linked: 0, skipped: 0 }; },
    linkBsToCoa: async () => ({ linked: 0, skipped: 0 }),
    coaTypeMap: {},
  },
};

require.cache[validationServicePath] = {
  exports: { replaceValidationResults: async () => {} },
};

require.cache[keyReportServicePath] = {
  exports: { listMappings: async () => [] },
};

require.cache[keyReportReportServicePath] = {
  exports: {},
};

const { generateCoaProposal, approveAndGenerateReports } = require('./keyReportSyncService');

function makeVersion(id) {
  return { id, companyId: `company-${id}`, versionNumber: 1 };
}

test('generateCoaProposal (PROPOSE MODE) never calls persistApprovedCoaTree and halts with coa_review_required', async () => {
  resetCalls();
  coaState.buildProposedCoaTree = async () => ({
    hierarchical: [{ accountName: 'Cash', accountType: 'asset' }],
    matchSummary: { documentMatchedCount: 1, aiFallbackCount: 0, needsMappingCount: 0, totalCount: 1 },
  });
  coaState.serializeProposedTree = (hierarchical) => hierarchical.map((leaf) => ({ key: leaf.accountName, nodeType: 'ACCOUNT' }));

  const result = await generateCoaProposal(makeVersion('propose-1'), {});

  assert.equal(result.halted, true);
  assert.equal(result.summary.haltReason, 'coa_review_required');
  assert.equal(calls.buildProposedCoaTree, 1);
  assert.equal(calls.persistApprovedCoaTree, 0);
  assert.ok(Array.isArray(result.proposedTree.nodes));
});

test('approveAndGenerateReports (APPROVE MODE) with a failing validateFinalCoaTree halts with coa_validation_failed and never persists or generates reports', async () => {
  resetCalls();
  coaState.validateFinalCoaTree = () => ({ valid: false, violations: ['duplicate node key "x"'], hierarchical: [] });

  const result = await approveAndGenerateReports(makeVersion('approve-invalid'), [{ key: 'x', nodeType: 'ACCOUNT' }], {});

  assert.equal(result.halted, true);
  assert.equal(result.summary.haltReason, 'coa_validation_failed');
  assert.equal(calls.validateFinalCoaTree, 1);
  assert.equal(calls.persistApprovedCoaTree, 0);
  assert.equal(calls.generateTrialBalance, 0);
  assert.equal(calls.generateMonthlyBalanceSheets, 0);
  assert.equal(calls.generateReconciliation, 0);
  assert.equal(calls.linkGlToCoa, 0);
});

test('approveAndGenerateReports (APPROVE MODE) when persistApprovedCoaTree throws halts with coa_save_failed and never reaches Trial Balance/report generation', async () => {
  resetCalls();
  coaState.validateFinalCoaTree = () => ({ valid: true, violations: [], hierarchical: [{ accountName: 'Cash', accountType: 'asset' }] });
  coaState.persistApprovedCoaTree = async () => { throw new Error('simulated DB write failure'); };

  const result = await approveAndGenerateReports(makeVersion('approve-save-fail'), [{ key: 'x', nodeType: 'ACCOUNT' }], {});

  assert.equal(result.halted, true);
  assert.equal(result.summary.haltReason, 'coa_save_failed');
  assert.equal(calls.persistApprovedCoaTree, 1); // it WAS called (and threw) -- this is the case under test
  assert.equal(calls.generateTrialBalance, 0);
  assert.equal(calls.generateMonthlyBalanceSheets, 0);
  assert.equal(calls.generateReconciliation, 0);
  assert.equal(calls.linkGlToCoa, 0);
});
