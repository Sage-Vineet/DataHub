// Regression test for: "Submitted Chart of Accounts failed validation:
// Business Process Outsourcing and Business Process Outsourcing would resolve
// to the identical hierarchy path" — every COA Save returning HTTP 422.
//
// CONFIRMED ROOT CAUSE this locks down: the tree builder deduped placed
// accounts by the normalized account NAME ALONE, so the second document row
// sharing a name was skipped and never became a tree node. One real chart lists
// "Business Process Outsourcing" twice — under Income (100,800.00) and under
// Cost of goods sold (59,400.00) — and they are two different accounts. With a
// single node in the tree, buildTreeHierarchyLookup had one candidate to offer,
// so both COA leaves inherited the SAME ancestry and produced identical
// hierarchy paths, failing the pre-persist duplicate-leaf-path check.
//
// Run: node --test backend/src/services/keyReports/referenceTreeBuilder.duplicateName.test.js

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { buildProfitLossTreeFromData } = require('./referenceTreeBuilder.js');

const row = (name, section, amount, over = {}) => ({
  account_name: name,
  section,
  amount,
  node_type: 'account',
  is_total: false,
  is_header: false,
  fiscal_year: 2024,
  source_file_id: 'f1',
  ...over,
});

// Shaped like the real export: a section header, a category, then the accounts.
const rows = [
  row('Income', 'revenue', null, { node_type: 'hierarchy_section', is_header: true }),
  row('Company Services', 'revenue', null, { node_type: 'hierarchy_group' }),
  row('Billing & Collections', 'revenue', 937319.64),
  row('Business Process Outsourcing', 'revenue', 100800),
  row('Total for Company Services', 'revenue', 1038119.64, { node_type: 'total', is_total: true }),
  row('Total for Income', 'revenue', 1466748.39, { node_type: 'total', is_total: true }),
  row('Cost of goods sold', 'cost_of_sales', null, { node_type: 'hierarchy_section', is_header: true }),
  row('Company Services', 'cost_of_sales', null, { node_type: 'hierarchy_group' }),
  row('Business Process Outsourcing', 'cost_of_sales', 59400),
  row('Total for Cost of goods sold', 'cost_of_sales', 600665.74, { node_type: 'total', is_total: true }),
];

const collect = (node, path, out) => {
  if (!node || typeof node !== 'object') return out;
  const next = node.nodeType === 'REPORT' ? path : [...path, node.name].filter(Boolean);
  if (node.nodeType === 'ACCOUNT' && node.name) out.push({ name: node.name, path: next });
  for (const c of node.children || []) collect(c, next, out);
  return out;
};

describe('a name the document lists twice becomes two tree nodes', () => {
  const tree = buildProfitLossTreeFromData({ rows });
  const accounts = collect(tree, [], []);
  const bpo = accounts.filter((a) => /business process outsourcing/i.test(a.name));

  test('both occurrences survive — neither is silently skipped', () => {
    assert.equal(bpo.length, 2,
      'deduping by name alone dropped the cost-of-goods account entirely');
  });

  test('they carry DIFFERENT ancestry, so their COA paths cannot collide', () => {
    const paths = bpo.map((b) => b.path.join(' > '));
    assert.notEqual(paths[0], paths[1],
      'identical paths are exactly what failed the pre-persist check');
  });

  test('each sits under the section the document put it in', () => {
    const joined = bpo.map((b) => b.path.join(' > ').toLowerCase());
    assert.ok(joined.some((p) => p.includes('income')), 'one must sit under Income');
    assert.ok(joined.some((p) => p.includes('cost of goods')), 'the other under Cost of goods sold');
  });

  test('a genuine repeat — same name, same position — still collapses to one node', () => {
    // The dedup must still do its original job: the same account appearing
    // again (another fiscal year, another source file) is ONE node.
    // Inserted at the SAME position — immediately after the original, inside
    // the same Income > Company Services scope, and from the SAME source file.
    // (source_file_id scopes the header/total bracketing, so a row from another
    // file starts its own scope and legitimately resolves to a different
    // ancestry; likewise, appending after the cost-of-goods section would place
    // it in that section. Both are genuinely different positions.)
    const at = rows.findIndex((r) => r.account_name === 'Business Process Outsourcing');
    const repeated = [
      ...rows.slice(0, at + 1),
      row('Business Process Outsourcing', 'revenue', 111000, { fiscal_year: 2025 }),
      ...rows.slice(at + 1),
    ];
    const again = collect(buildProfitLossTreeFromData({ rows: repeated }), [], [])
      .filter((a) => /business process outsourcing/i.test(a.name));
    assert.equal(again.length, 2, 'a same-position repeat must not create a third node');
  });

  test('accounts with unique names are unaffected', () => {
    const billing = accounts.filter((a) => /billing/i.test(a.name));
    assert.equal(billing.length, 1);
  });
});
