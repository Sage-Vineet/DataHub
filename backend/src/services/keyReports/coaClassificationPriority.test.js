// Regression tests for: "accounts missing from the uploaded Balance Sheet and
// P&L fall back to Gemini, and Gemini classifies them incorrectly --
// Equity -> P&L, Expense -> Balance Sheet, Income -> Liability,
// Liability -> Expense."
//
// ROOT CAUSES these lock down (all four verified in the source before the fix):
//
// 1. Gemini was classifying from the ACCOUNT NAME AND NOTHING ELSE. An account
//    reaches AI only when the uploaded COA and both uploaded statements failed
//    to resolve it, so its bsSection/plSection are null by construction and the
//    prompt line carried just the name. No GL evidence was ever sent.
//
// 2. AI_OVERRIDE_CONFIDENCE_FLOOR = 0.95 let a confident model answer BLOCK the
//    document's own section evidence from correcting it -- an inversion of the
//    stated priority order, triggered precisely when the model was most
//    overconfident (it self-scores, and the prompt tells it >=0.90 means
//    "unambiguous").
//
// 3. statementType was assignable independently of accountType, so
//    accountType:"equity" + statementType:"profit_loss" was reachable;
//    getFinalCoaPrefix then matched statementType==="profit_loss", found
//    "equity" among none of cogs/expense/income, and fell through to the P&L
//    anchor. That is the reported "Equity -> P&L" WITH NO AI MISTAKE AT ALL.
//
// 4. Nothing ever validated the AI's account TYPE. The one existing check
//    (hierarchyContradictsClassification) compares the AI's hierarchy against
//    the AI's OWN type -- internal consistency, not correctness -- so
//    "Retained Earnings -> expense" with expense-shaped levels passed cleanly.
//
// THE EVIDENCE THE FIX RESTS ON, measured against live data (version 2b00b21b,
// 10,470 GL rows, 81 accounts) BEFORE the code was written:
//   * non-zero BEGINNING_BALANCE  -> 20/20 accounts are Balance Sheet types,
//                                    0 are P&L types. Enforced as a HARD rule.
//   * year-over-year continuity   -> 34/37 correct (92%), and all 3 errors
//                                    predicted "permanent" for an operating
//                                    expense, i.e. they would have VETOED the
//                                    correct answer. NOT enforced; prompt hint only.
//   * debit/credit columns        -> non-zero on 10 of 10,470 rows, and the
//                                    signed `amount` uses natural-balance
//                                    convention (income increases are POSITIVE,
//                                    same sign as an expense). Normal balance is
//                                    therefore NOT derivable here and is not used.
//
// Run: node --test backend/src/services/keyReports/coaClassificationPriority.test.js

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { buildGlEvidence, allowedAccountTypesFor, describeGlEvidence } = require('./coaGlEvidence');
const {
  statementForAccountType, allowedAccountTypes, checkClassification,
} = require('./coaAccountingConstraints');
const { inferTypeFromAccountNumberBlock } = require('./coaHierarchyEvidence');

const SERVICE_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'chartOfAccountsService.js'), 'utf8');

// GL row helpers shaped exactly as general_ledger_entries rows arrive.
const opening = (name, year, running) =>
  ({ account_name: name, row_type: 'BEGINNING_BALANCE', running_balance: running, transaction_date: `${year}-01-01` });
const txn = (name, year, amount, running = null) =>
  ({ account_name: name, row_type: 'TRANSACTION', amount, running_balance: running, transaction_date: `${year}-06-15` });

// ── P2: the GL evidence itself ──────────────────────────────────────────────

describe('GL evidence proves permanence, and never over-claims', () => {
  test('a non-zero opening balance proves a Balance Sheet account', () => {
    const ev = buildGlEvidence([
      opening('Retained Earnings', 2025, -48200.55),
      txn('Retained Earnings', 2025, 1200),
    ]).get('retained earnings');
    assert.equal(ev.permanence, 'permanent');
    assert.deepEqual(allowedAccountTypesFor(ev), ['asset', 'liability', 'equity']);
  });

  test('NO opening balance asserts nothing at all -- absence is not evidence', () => {
    // A permanent account can legitimately lack an opener (first period ever,
    // an ERP that omits zero-balance openers, a partial export). Asserting
    // "temporal" from absence would veto correct classifications.
    const ev = buildGlEvidence([txn('Interest Expense', 2025, 900)]).get('interest expense');
    assert.equal(ev.permanence, null);
    assert.equal(allowedAccountTypesFor(ev), null, 'must impose NO constraint');
  });

  test('a ZERO opening balance is not treated as proof of permanence', () => {
    const ev = buildGlEvidence([
      { account_name: 'Payroll Tax', row_type: 'BEGINNING_BALANCE', running_balance: 0, transaction_date: '2025-01-01' },
      txn('Payroll Tax', 2025, 500),
    ]).get('payroll tax');
    assert.equal(ev.permanence, null);
  });

  test('continuity is computed but is NEVER a constraint (measured 92%, mis-vetoes)', () => {
    const ev = buildGlEvidence([
      txn('Charges', 2024, 100, 100), txn('Charges', 2024, 50, 150),
      txn('Charges', 2025, 60, 155), txn('Charges', 2025, 40, 195),
    ]).get('charges');
    assert.equal(typeof ev.carriesAcrossYears, 'boolean', 'still exposed for the prompt');
    assert.equal(ev.permanence, null, 'but must not become a permanence claim');
    assert.equal(allowedAccountTypesFor(ev), null, 'and must not constrain anything');
  });

  test('no normal-balance / debit-credit signal is derived anywhere', () => {
    const src = fs.readFileSync(path.join(__dirname, 'coaGlEvidence.js'), 'utf8');
    const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert.equal(/normalBalance|debit_amount|credit_amount/.test(code), false,
      'the signed amount uses natural-balance convention -- sign carries no debit/credit meaning');
  });
});

// ── P4: the four reported failure modes ─────────────────────────────────────

describe('the four reported misclassifications are now rejected', () => {
  const permanentEv = buildGlEvidence([opening('X', 2025, 5000), txn('X', 2025, 10)]).get('x');

  test('Equity -> P&L is impossible: statement side is derived from type', () => {
    assert.equal(statementForAccountType('equity'), 'balance_sheet');
    const v = checkClassification({ accountType: 'equity', statementType: 'profit_loss' });
    assert.ok(v, 'must be rejected');
    assert.equal(v.violation, 'statement_type_mismatch');
  });

  test('Expense -> Balance Sheet is rejected', () => {
    const v = checkClassification({ accountType: 'expense', statementType: 'balance_sheet' });
    assert.equal(v.violation, 'statement_type_mismatch');
  });

  test('Liability -> Expense is rejected when the GL proves permanence', () => {
    const v = checkClassification({ accountType: 'expense', glEvidence: permanentEv });
    assert.ok(v, 'a permanent account cannot be an expense');
    assert.equal(v.violation, 'contradicts_gl_permanence');
  });

  test('Income -> Liability is rejected when the GL proves permanence is absent', () => {
    // The mirror case: an account the DOCUMENT places in an income section
    // cannot be re-typed to liability by the model.
    const v = checkClassification({ accountType: 'liability', documentAccountType: 'income' });
    assert.equal(v.violation, 'contradicts_document');
  });

  test('"Retained Earnings -> expense" is rejected without naming the account', () => {
    const v = checkClassification({ accountType: 'expense', glEvidence: permanentEv });
    assert.equal(v.violation, 'contradicts_gl_permanence');
    const src = fs.readFileSync(path.join(__dirname, 'coaAccountingConstraints.js'), 'utf8');
    const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    for (const banned of [/retained\s*earnings/i, /owner\s*draw/i, /net\s*income/i, /payroll/i, /interest/i]) {
      assert.equal(banned.test(code), false, `constraints must not hardcode ${banned}`);
    }
  });

  test('a CORRECT classification on the same evidence is accepted', () => {
    assert.equal(checkClassification({ accountType: 'equity', glEvidence: permanentEv }), null);
    assert.equal(checkClassification({ accountType: 'asset', glEvidence: permanentEv }), null);
    assert.equal(checkClassification({ accountType: 'liability', glEvidence: permanentEv }), null);
  });

  test('an account with no evidence is left completely unconstrained', () => {
    for (const t of ['asset', 'liability', 'equity', 'income', 'cogs', 'expense']) {
      assert.equal(checkClassification({ accountType: t }), null, `${t} must pass with no evidence`);
    }
  });
});

// ── Priority ordering ───────────────────────────────────────────────────────

describe('evidence narrows in priority order and AI can never widen it', () => {
  test('a document section collapses the allowed set to exactly that type', () => {
    const { allowed } = allowedAccountTypes({ documentAccountType: 'income' });
    assert.deepEqual(allowed, ['income']);
  });

  test('GL permanence narrows to the three Balance Sheet types', () => {
    const ev = buildGlEvidence([opening('X', 2025, 10)]).get('x');
    const { allowed } = allowedAccountTypes({ glEvidence: ev });
    assert.deepEqual(allowed, ['asset', 'liability', 'equity']);
  });

  test('a hierarchy hint contradicting proven evidence is DROPPED, not applied', () => {
    const ev = buildGlEvidence([opening('X', 2025, 10)]).get('x');
    const { allowed } = allowedAccountTypes({ glEvidence: ev, hierarchyAccountTypes: ['expense'] });
    assert.deepEqual(allowed, ['asset', 'liability', 'equity'],
      'the proof must survive; the weaker hint must not empty the set');
  });

  test('no evidence at all means no constraint', () => {
    assert.equal(allowedAccountTypes({}).allowed, null);
  });
});

// ── P3: hierarchy evidence ──────────────────────────────────────────────────

describe('account-number block consensus', () => {
  const peers = [
    { accountNumber: '30010', accountType: 'equity' },
    { accountNumber: '30020', accountType: 'equity' },
    { accountNumber: '60010', accountType: 'expense' },
  ];

  test('a unanimous block lends its type', () => {
    const got = inferTypeFromAccountNumberBlock({ accountNumber: '30030' }, peers);
    assert.equal(got.accountType, 'equity');
  });

  test('a block that disagrees is not evidence', () => {
    const mixed = [
      { accountNumber: '30010', accountType: 'equity' },
      { accountNumber: '30020', accountType: 'liability' },
    ];
    assert.equal(inferTypeFromAccountNumberBlock({ accountNumber: '30030' }, mixed), null);
  });

  test('a consensus outside the allowed set is discarded', () => {
    const got = inferTypeFromAccountNumberBlock({ accountNumber: '30030' }, peers, { allowed: ['income'] });
    assert.equal(got, null, 'must never override harder evidence');
  });

  test('an account with no number yields nothing', () => {
    assert.equal(inferTypeFromAccountNumberBlock({ accountNumber: null }, peers), null);
  });
});

// ── The service wiring ──────────────────────────────────────────────────────

describe('chartOfAccountsService no longer lets AI outrank evidence', () => {
  test('the AI override floor is unreachable, so section evidence always applies', () => {
    // Direction matters: the guards read `confidence >= FLOOR` and act on
    // `if (!aiConfident)`. A floor of 0 would do the OPPOSITE of the fix.
    assert.ok(/const AI_OVERRIDE_CONFIDENCE_FLOOR = Number\.POSITIVE_INFINITY;/.test(SERVICE_SRC),
      'floor must be above the maximum possible confidence (1.0)');
    assert.equal(/const AI_OVERRIDE_CONFIDENCE_FLOOR = 0\.95;/.test(SERVICE_SRC), false);
  });

  test('statementType is derived from accountType, never supplied independently', () => {
    assert.ok(
      /statementType: \(accountType \? statementForAccountType\(accountType\) : null\) \|\| partitionStatementType/
        .test(SERVICE_SRC),
      'the GL partition hint must not outrank the account\'s own type',
    );
    assert.equal(
      /statementType: partitionStatementType \|\| \(accountType \? statementTypeFor\(accountType\) : null\)/
        .test(SERVICE_SRC),
      false, 'the old inverted precedence must be gone',
    );
  });

  test('every AI classification is run through the constraint veto', () => {
    assert.ok(/constraintViolation = checkClassification\(\{/.test(SERVICE_SRC));
    assert.ok(/accountType = null; \/\/ falls through to needsReview/.test(SERVICE_SRC),
      'a rejected type must be discarded, not merely flagged');
  });

  test('a rejected classification also discards the AI hierarchy it implied', () => {
    assert.ok(/accountTypeOverriddenByStructuralEvidence \|\| constraintViolation/.test(SERVICE_SRC));
  });

  test('an anchor mismatch now reaches the reviewer instead of only the log', () => {
    const idx = SERVICE_SRC.indexOf('kind: "anchor_mismatch"');
    assert.ok(idx > 0);
    const after = SERVICE_SRC.slice(idx, idx + 1200);
    assert.ok(/leaf\.needsReview = true;/.test(after), 'was console.warn only');
  });

  test('the GL evidence actually reaches the Gemini prompt', () => {
    const cls = fs.readFileSync(path.join(__dirname, 'geminiCoaClassifier.js'), 'utf8');
    assert.ok(/\$\{allowed\}\$\{glEv\}/.test(cls), 'evidence must be interpolated into the account line');
    assert.ok(/attachGlEvidenceForAi\(needsAi, glRows, matchResults\)/.test(SERVICE_SRC));
    assert.ok(/attachGlEvidenceForAi\(needsAi, glRowsInOrder, matchResults\)/.test(SERVICE_SRC),
      'ensureCoaComplete uses glRowsInOrder -- glRows is not in scope there');
  });
});
