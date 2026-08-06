// Regression tests for: "Trial Balance does not balance — Net Income overstated".
//
// The uploaded Balance Sheet balanced exactly (Assets 443,458.34 = Liabilities
// 283,542.94 + Equity 159,915.40) and its P&L reported Net Income 128,326.88,
// but the generated Trial Balance computed 234,733.08 — out by 106,406.20. The
// TB AMOUNTS were correct: an account-by-account diff against the P&L matched
// everywhere. Only the account TYPES were wrong, in two opposite directions:
//
//   Business Process Outsourcing          doc: cost of goods sold  59,400.00
//                                          -> typed income          +118,800.00
//   Reimbursement for 3rd Party Expenses  doc: income               6,196.90
//                                          -> typed expense          -12,393.80
//                                                             net = 106,406.20
//
// Two independent defects, one per row. Both are locked down here.
//
// Run: node --test backend/src/services/chartOfAccountsService.plSectionInference.test.js

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { inferAccountTypeFromReferencePath, classifyPlAncestorLabel } = require('./chartOfAccountsService.js');

// ── Defect 1: a keyword in the account's OWN name beat its actual section ───

describe('P&L section inference reads the section, not the account name', () => {
  test('the reported case: an income account whose name contains "Expenses"', () => {
    // Path as buildLeafHierarchies passes it — ancestors THEN the account's own
    // name. Flattening this to one string put both "income" and "expense" in
    // the blob, and the expense test ran first.
    const path = ['Income', 'Reimbursement for 3rd Party Expenses'];
    assert.equal(
      inferAccountTypeFromReferencePath('profit_loss', path, { excludeOwnName: true }),
      'income',
    );
  });

  test('the mirror case: an expense account whose name contains "Income"', () => {
    const path = ['Expenses', 'Loss of Income Insurance'];
    assert.equal(
      inferAccountTypeFromReferencePath('profit_loss', path, { excludeOwnName: true }),
      'expense',
    );
  });

  test('the NEAREST section ancestor wins over an outer one', () => {
    // Order-independence: the answer must not depend on which keyword the fixed
    // if-chain happened to test first.
    assert.equal(
      inferAccountTypeFromReferencePath('profit_loss', ['Income', 'Cost of Goods Sold', 'Materials'], { excludeOwnName: true }),
      'cogs',
    );
    assert.equal(
      inferAccountTypeFromReferencePath('profit_loss', ['Expenses', 'Other Income', 'Interest'], { excludeOwnName: true }),
      'income',
    );
  });

  test('an account with NO ancestry is left unresolved, never guessed from its name', () => {
    // The caller then falls back to the section the extractor read from the
    // document itself. Guessing here is what produced the reported bug.
    assert.equal(
      inferAccountTypeFromReferencePath('profit_loss', ['Reimbursement for 3rd Party Expenses'], { excludeOwnName: true }),
      null,
    );
    assert.equal(inferAccountTypeFromReferencePath('profit_loss', [], { excludeOwnName: true }), null);
  });

  test('ordinary P&L accounts still resolve', () => {
    const cases = [
      [['Income', 'Sales'], 'income'],
      [['Other Income', 'Interest Earned'], 'income'],
      [['Cost of Goods Sold', 'Company Services', 'Billing & Collections'], 'cogs'],
      [['Expenses', 'Payroll expenses', 'Wages'], 'expense'],
      [['Other Expenses', 'Bank Charges'], 'expense'],
    ];
    for (const [path, want] of cases) {
      assert.equal(
        inferAccountTypeFromReferencePath('profit_loss', path, { excludeOwnName: true }), want,
        `${path.join(' > ')} must be ${want}`);
    }
  });

  test('"Cost of Sales" resolves as cost-of-goods, not as "sales" revenue', () => {
    // Within a single label the cost tests must precede the bare "sales" test.
    // cogs, not the coarser expense — see classifyPlAncestorLabel: reporting
    // the side here left the Trial Balance with no cogs rows at all, so Gross
    // Profit collapsed to equal Revenue.
    assert.equal(classifyPlAncestorLabel('Cost of Sales'), 'cogs');
    assert.equal(classifyPlAncestorLabel('Cost of Goods Sold'), 'cogs');
    assert.equal(classifyPlAncestorLabel('COGS'), 'cogs');
    assert.equal(classifyPlAncestorLabel('Sales'), 'income');
  });

  test('a label carrying no section signal resolves to null', () => {
    for (const l of ['Company Services', 'Marigold Partners Inc.', '', null, undefined]) {
      assert.equal(classifyPlAncestorLabel(l), null);
    }
  });
});

describe('the other callers keep their ancestors-only contract', () => {
  // hierarchyContradictsClassification passes DYNAMIC ANCESTOR labels — the
  // account's own name is already excluded — so it must NOT set excludeOwnName,
  // and the default must not silently drop a real ancestor.
  test('without excludeOwnName the last label is still classified', () => {
    assert.equal(inferAccountTypeFromReferencePath('profit_loss', ['Income']), 'income');
    assert.equal(inferAccountTypeFromReferencePath('profit_loss', ['Expenses']), 'expense');
  });

  test('the balance_sheet branch is unchanged by the option plumbing', () => {
    assert.equal(inferAccountTypeFromReferencePath('balance_sheet', ['Assets', 'Current Assets']), 'asset');
    assert.equal(
      inferAccountTypeFromReferencePath('balance_sheet', ['Assets', 'Current Assets', 'Cash'], { excludeOwnName: true }),
      'asset',
    );
  });

  test('a Balance Sheet group containing a P&L word is not dragged onto the P&L', () => {
    // "Prepaid Expenses" is a real asset group; it must stay an asset.
    assert.equal(
      inferAccountTypeFromReferencePath('balance_sheet', ['Assets', 'Prepaid Expenses', 'Insurance'], { excludeOwnName: true }),
      'asset',
    );
  });

  test('an unknown statement type resolves to null', () => {
    assert.equal(inferAccountTypeFromReferencePath('something_else', ['Income', 'Sales']), null);
  });

  test('malformed input never throws', () => {
    for (const bad of [null, undefined]) {
      assert.doesNotThrow(() => inferAccountTypeFromReferencePath('profit_loss', bad));
      assert.equal(inferAccountTypeFromReferencePath('profit_loss', bad), null);
    }
  });
});

// ── Defect 2: two different accounts sharing a name collapsed into one ──────

describe('account identity forks when the document disagrees about the section', () => {
  // pickBucketTarget is a closure inside buildCoaModel, so its RULE is asserted
  // here against the source: a fork must require positive, document-derived
  // evidence from both sides, and absence of evidence must always merge.
  const src = require('fs').readFileSync(require('path').join(__dirname, 'chartOfAccountsService.js'), 'utf8');

  test('no branch resolves a name collision with bucket[0] any more', () => {
    assert.equal(/const target = bucket\[0\] \|\| null;/.test(src), false,
      'name-only identity is what merged the two "Business Process Outsourcing" accounts');
  });

  test('every collision branch goes through pickBucketTarget', () => {
    const uses = src.match(/const target = pickBucketTarget\(bucket, bsSection, plSection\);/g) || [];
    assert.equal(uses.length, 3, 'all three addLeaf branches must share one identity rule');
  });

  test('a row with no section evidence merges rather than forking', () => {
    const fn = src.slice(src.indexOf('const pickBucketTarget'));
    const body = fn.slice(0, fn.indexOf('\n  };') + 5);
    assert.ok(/if \(!incoming\) return bucket\[0\] \|\| null;/.test(body),
      'GL rows carry no section — they must never fork a real account in two');
    assert.ok(/if \(!existing \|\| existing === incoming\) return leaf;/.test(body),
      'a leaf with no section yet, or a matching one, must absorb the row');
  });

  test('the fork rule maps sections through the existing vocabulary, not names', () => {
    const fn = src.slice(src.indexOf('const documentSectionType'));
    const body = fn.slice(0, fn.indexOf('\n  };') + 5);
    assert.ok(/typeFromPlSection\(plSection\)/.test(body),
      'P&L sections must resolve through the one existing section vocabulary');
    // The BS side mirrors addLeaf's own existing structural test.
    for (const kw of ['asset', 'liab', 'equity']) assert.ok(body.includes(kw));
    // No account-name or per-client matching anywhere in the rule.
    assert.equal(/account_?[Nn]ame/.test(body), false, 'identity must not re-read the account name');
  });
});

// ── Defect 3: both forks produced the SAME node key ────────────────────────
//
// Forking the two "Business Process Outsourcing" accounts fixed the Trial
// Balance but surfaced the next layer: accountKey is number + normalized name,
// so both forks keyed to "::business process outsourcing". validateTree
// rejected the whole Proposed COA with `Duplicate node key`, blocking Save.

describe('a forked account gets a distinct but stable key', () => {
  const { accountKey } = require('./chartOfAccountsService.js');

  test('the two forks no longer collide', () => {
    const income = accountKey(null, 'Business Process Outsourcing', 'income');
    const cogs = accountKey(null, 'Business Process Outsourcing', 'cogs');
    assert.notEqual(income, cogs);
    assert.equal(income, '::business process outsourcing::income');
  });

  test('an UNFORKED account keeps a byte-identical key', () => {
    // This key is the cross-regeneration merge identity. If it changed for
    // accounts that were never forked, the next sync would insert duplicates
    // instead of updating the rows already stored.
    for (const d of [null, undefined, '', '   ']) {
      assert.equal(accountKey(null, 'Sales', d), '::sales');
      assert.equal(accountKey('4000', 'Sales', d), '4000::sales');
    }
  });

  test('the key is stable across calls and case/whitespace tolerant', () => {
    assert.equal(accountKey(' 4000 ', '  Sales  ', ' COGS '),
      accountKey('4000', 'sales', 'cogs'));
  });

  test('the discriminator is the DOCUMENT section, not the account type', () => {
    // accountType legitimately changes when a user reclassifies an account or
    // the AI revises it; the document's own section does not. Keying on the
    // former would break the merge on the very next regeneration.
    const src = require('fs').readFileSync(require('path').join(__dirname, 'chartOfAccountsService.js'), 'utf8');
    assert.ok(/sectionDiscriminator: bucket\.length \? documentSectionType\(bsSection, plSection\) : null,/.test(src),
      'the discriminator must come from documentSectionType');
    assert.ok(/section_discriminator: leaf\.sectionDiscriminator \|\| null,/.test(src),
      'it must be persisted so the next regeneration reproduces the same key');
  });

  test('persisted rows feed the discriminator back into the key', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, 'chartOfAccountsService.js'), 'utf8');
    assert.equal(/accountKey\((?:row|r)\.account_number, (?:row|r)\.account_name\)/.test(src), false,
      'every persisted-row call site must pass metadata.section_discriminator');
  });
});

// ── Defect 4: both forks inherited the SAME document hierarchy ─────────────
//
// With distinct keys the forks saved as two rows, but both resolved to
// "... > Income > Company Services > Business Process Outsourcing" — wrong for
// the cost-of-goods one, and identical, so persistApprovedCoaTree rejected the
// tree with "would resolve to the identical hierarchy path".

describe('a forked leaf resolves to its OWN document node', () => {
  const { selectDeterministicReferenceCandidate } = require('./chartOfAccountsService.js');

  // Both nodes as buildTreeHierarchyLookup registers them under one name.
  const incomeNode = {
    accountType: 'income', level: 3, nodeName: 'Business Process Outsourcing',
    levels: ['Income', 'Company Services', 'Business Process Outsourcing'],
  };
  const cogsNode = {
    accountType: 'expense', level: 3, nodeName: 'Business Process Outsourcing',
    levels: ['Cost of Goods Sold', 'Company Services', 'Business Process Outsourcing'],
  };
  const bucket = [incomeNode, cogsNode];

  test('the cost-of-goods fork picks the cost-of-goods node', () => {
    // plSectionToType says "cogs"; the candidate carries the expense SIDE.
    assert.equal(selectDeterministicReferenceCandidate(bucket, 'cogs'), cogsNode);
    assert.equal(selectDeterministicReferenceCandidate(bucket, 'expense'), cogsNode);
  });

  test('the income fork picks the income node', () => {
    assert.equal(selectDeterministicReferenceCandidate(bucket, 'income'), incomeNode);
    assert.equal(selectDeterministicReferenceCandidate(bucket, 'revenue'), incomeNode);
  });

  test('the two forks therefore get DIFFERENT hierarchy paths', () => {
    const a = selectDeterministicReferenceCandidate(bucket, 'income').levels.join(' > ');
    const b = selectDeterministicReferenceCandidate(bucket, 'cogs').levels.join(' > ');
    assert.notEqual(a, b, 'identical paths are what failed the pre-persist check');
  });

  test('with no preference the original structural/depth ordering is unchanged', () => {
    const structural = { accountType: 'income', level: 9, isStructural: true };
    const account = { accountType: 'income', level: 2, isStructural: false };
    // A real posting node still outranks a structural one regardless of depth.
    assert.equal(selectDeterministicReferenceCandidate([structural, account]), account);
    // ...and among equals, the deeper path still wins.
    const shallow = { accountType: 'asset', level: 2 };
    const deep = { accountType: 'asset', level: 5 };
    assert.equal(selectDeterministicReferenceCandidate([shallow, deep]), deep);
  });

  test('an unmatchable preference falls back to the normal ordering, never null', () => {
    const shallow = { accountType: 'asset', level: 2 };
    const deep = { accountType: 'asset', level: 5 };
    assert.equal(selectDeterministicReferenceCandidate([shallow, deep], 'liability'), deep);
  });

  test('a structural node never wins on type agreement alone', () => {
    // Type preference must not promote a section header over a real account.
    const structural = { accountType: 'expense', level: 9, isStructural: true };
    const account = { accountType: 'income', level: 2, isStructural: false };
    assert.equal(selectDeterministicReferenceCandidate([structural, account], 'expense'), account);
  });

  test('single-candidate and malformed buckets behave as before', () => {
    assert.equal(selectDeterministicReferenceCandidate([], 'income'), null);
    assert.equal(selectDeterministicReferenceCandidate(null, 'income'), null);
    assert.equal(selectDeterministicReferenceCandidate([incomeNode], 'cogs'), incomeNode);
  });
});

// ── Defect 5: the discriminator was lost on the propose → save round trip ───
//
// The fork worked and accountKey kept the two apart, but the proposed tree the
// UI receives (and posts back on Save) dropped sectionDiscriminator. Coming
// back in, both forks computed accountKey(number, name, undefined) — identical
// — collided in persistApprovedCoaTree's leavesByKey and merged into ONE row.
// The COA therefore persisted a single income leaf, every GL row linked to it,
// and the Trial Balance stayed out by the cost-of-goods amount.

describe('sectionDiscriminator survives propose → review → save', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, 'chartOfAccountsService.js'), 'utf8');

  test('serializeProposedTree emits it on every ACCOUNT node', () => {
    assert.ok(/sectionDiscriminator: leaf\.sectionDiscriminator \|\| null,/.test(src),
      'the UI must receive it, or Save cannot send it back');
  });

  test('the submitted tree reads it back into the hierarchical leaf', () => {
    assert.ok(/sectionDiscriminator: n\.sectionDiscriminator \|\| null,/.test(src),
      'without this the two forks collapse again on persist');
  });

  test('every accountKey call on a leaf passes it', () => {
    // A single unpatched call site silently re-merges the forks.
    const bare = src.match(/accountKey\(leaf\.accountNumber, leaf\.accountName\)/g) || [];
    assert.equal(bare.length, 0, 'found an accountKey(leaf...) call without the discriminator');
    const withDisc = src.match(/accountKey\(leaf\.accountNumber, leaf\.accountName, leaf\.sectionDiscriminator\)/g) || [];
    assert.ok(withDisc.length >= 4, `expected every leaf call site to pass it, found ${withDisc.length}`);
  });

  test('it is persisted so the next regeneration reproduces the same key', () => {
    assert.ok(/section_discriminator: leaf\.sectionDiscriminator \|\| null,/.test(src));
  });
});

// ── Defect 6: the DB's own uniqueness index re-merged the forks ────────────
//
// Migration 062 defined leaf identity as (version_id, account_number,
// account_name) — the name alone when no account numbers exist. With the code
// correctly forking, that index rejected the second row outright:
//   duplicate key value violates unique constraint "uq_chart_of_accounts_leaf_identity"
// Migration 088 adds the discriminator so the two may coexist.

describe('the leaf-identity index admits a legitimately forked account', () => {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '..', '..', 'sql', 'migrations');
  const file = fs.readdirSync(dir).find((f) => /coa_leaf_identity_section_discriminator/.test(f));

  test('the migration exists', () => {
    assert.ok(file, 'migration 088 must be present for a forked COA to persist');
  });

  test('it rebuilds the index with the discriminator in the identity', () => {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.ok(/DROP INDEX IF EXISTS uq_chart_of_accounts_leaf_identity/i.test(sql));
    assert.ok(/section_discriminator/.test(sql), 'the discriminator must join the identity');
    assert.ok(/CREATE UNIQUE INDEX/i.test(sql), 'it must stay UNIQUE — this is still an identity');
  });

  test('existing rows keep a byte-identical identity', () => {
    // coalesce(..., '') is what guarantees the change cannot introduce a
    // duplicate that migration 062 would have caught.
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.ok(/coalesce\(metadata->>'section_discriminator',\s*''\)/.test(sql),
      'a NULL discriminator must normalize to empty, not to NULL');
  });

  test('it stays scoped to leaf rows only', () => {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.ok(/WHERE coalesce\(metadata->>'is_group', 'false'\) <> 'true'/.test(sql),
      'structural/group rows were never covered by this index and must stay uncovered');
  });
});
