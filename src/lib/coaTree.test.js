// Regression tests for the new COA tree-editor primitives added to coaTree.js
// for the Chart of Accounts review-workflow redesign: getSubtreeKeys,
// createCategory, deleteCategory, getMoveTargetsForCategory, diffCoaTrees.
// Everything else in this file (renameNode, moveNode, resolveOrCreateCategoryChain,
// etc.) already existed and is exercised only incidentally here, via the
// primitives that call it.
//
// Run: node --test src/lib/coaTree.test.js

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildIndexes, getSubtreeKeys, createCategory, deleteCategory,
  getMoveTargetsForCategory, diffCoaTrees, renameNode, moveNode,
  validateNewCategory, getHierarchyPathLabel,
} from "./coaTree.js";

// A small realistic Balance Sheet + P&L tree:
//   Total Assets (root anchor)
//     Current Assets
//       Chase Bank (account)
//     Fixed Assets            <- empty category
//   Total Liabilities and Equity (root anchor)
//     Current Liabilities
//       Accounts Payable (account)
function baseTree() {
  return [
    { key: "assets-root", parentKey: null, nodeType: "CATEGORY", label: "Total Assets", accountType: "asset", statementType: "balance_sheet" },
    { key: "current-assets", parentKey: "assets-root", nodeType: "CATEGORY", label: "Current Assets", accountType: "asset", statementType: "balance_sheet" },
    { key: "chase", parentKey: "current-assets", nodeType: "ACCOUNT", accountName: "Chase Bank", accountType: "asset", statementType: "balance_sheet" },
    { key: "fixed-assets", parentKey: "assets-root", nodeType: "CATEGORY", label: "Fixed Assets", accountType: "asset", statementType: "balance_sheet" },
    { key: "le-root", parentKey: null, nodeType: "CATEGORY", label: "Total Liabilities and Equity", accountType: "liability", statementType: "balance_sheet" },
    { key: "current-liab", parentKey: "le-root", nodeType: "CATEGORY", label: "Current Liabilities", accountType: "liability", statementType: "balance_sheet" },
    { key: "ap", parentKey: "current-liab", nodeType: "ACCOUNT", accountName: "Accounts Payable", accountType: "liability", statementType: "balance_sheet" },
  ];
}

describe("getSubtreeKeys", () => {
  test("includes the root and every descendant", () => {
    const nodes = baseTree();
    const { childrenByParentKey } = buildIndexes(nodes);
    const subtree = getSubtreeKeys(childrenByParentKey, "assets-root");
    assert.deepEqual([...subtree].sort(), ["assets-root", "chase", "current-assets", "fixed-assets"].sort());
  });

  test("a leaf account's subtree is only itself", () => {
    const nodes = baseTree();
    const { childrenByParentKey } = buildIndexes(nodes);
    const subtree = getSubtreeKeys(childrenByParentKey, "chase");
    assert.deepEqual([...subtree], ["chase"]);
  });
});

describe("createCategory", () => {
  test("creates a new empty category under an existing parent, inheriting its type", () => {
    const nodes = baseTree();
    const result = createCategory(nodes, { parentKey: "current-assets", label: "Petty Cash" });
    assert.equal(result.error, null);
    assert.equal(result.created, true);
    const created = result.nodes.find((n) => n.key === result.categoryKey);
    assert.equal(created.nodeType, "CATEGORY");
    assert.equal(created.label, "Petty Cash");
    assert.equal(created.accountType, "asset");
    assert.equal(created.statementType, "balance_sheet");
    assert.equal(created.parentKey, "current-assets");
  });

  test("creating the same path twice resolves to the SAME node — no duplicate", () => {
    const nodes = baseTree();
    const first = createCategory(nodes, { parentKey: "current-assets", label: "Petty Cash" });
    const second = createCategory(first.nodes, { parentKey: "current-assets", label: "Petty Cash" });
    assert.equal(second.error, null);
    assert.equal(second.created, false);
    assert.equal(second.categoryKey, first.categoryKey);
    assert.equal(second.nodes.length, first.nodes.length);
  });

  test("a root-level category (parentKey null) is allowed", () => {
    const nodes = baseTree();
    const result = createCategory(nodes, { parentKey: null, label: "Off Balance Sheet", accountType: "asset", statementType: "balance_sheet" });
    assert.equal(result.error, null);
    const created = result.nodes.find((n) => n.key === result.categoryKey);
    assert.equal(created.parentKey, null);
  });

  test("refuses an empty label", () => {
    const result = createCategory(baseTree(), { parentKey: "current-assets", label: "   " });
    assert.equal(result.error, "EMPTY_LABEL");
    assert.equal(result.categoryKey, null);
  });

  test("refuses a posting account as the parent", () => {
    const result = createCategory(baseTree(), { parentKey: "chase", label: "Sub-account" });
    assert.equal(result.error, "PARENT_IS_LEAF");
  });

  test("refuses a parentKey that doesn't exist in the tree", () => {
    const result = createCategory(baseTree(), { parentKey: "does-not-exist", label: "Orphan" });
    assert.equal(result.error, "INVALID_PARENT");
  });
});

describe("deleteCategory", () => {
  test("deletes a genuinely empty category", () => {
    const nodes = baseTree();
    const result = deleteCategory(nodes, "fixed-assets");
    assert.equal(result.error, null);
    assert.equal(result.nodes.some((n) => n.key === "fixed-assets"), false);
    assert.equal(result.nodes.length, nodes.length - 1);
  });

  test("refuses to delete a category that still has children", () => {
    const nodes = baseTree();
    const result = deleteCategory(nodes, "current-assets");
    assert.equal(result.error, "HAS_CHILDREN");
    assert.equal(result.nodes, nodes); // original reference, untouched
  });

  test("refuses to delete an ACCOUNT node", () => {
    const nodes = baseTree();
    const result = deleteCategory(nodes, "chase");
    assert.equal(result.error, "NOT_A_CATEGORY");
  });

  test("refuses a key that doesn't exist", () => {
    const result = deleteCategory(baseTree(), "nope");
    assert.equal(result.error, "NOT_FOUND");
  });
});

describe("getMoveTargetsForCategory", () => {
  test("only offers same-anchor destinations, excluding the category's own subtree and itself", () => {
    const nodes = baseTree();
    const targets = getMoveTargetsForCategory(nodes, nodes.find((n) => n.key === "current-assets"));
    const keys = targets.map((t) => t.node.key);
    // Same anchor (assets-root) options only, excluding current-assets itself:
    assert.ok(keys.includes("assets-root"));
    assert.ok(keys.includes("fixed-assets"));
    assert.ok(!keys.includes("current-assets"));
    // Never a destination under the opposite (Liabilities & Equity) anchor:
    assert.ok(!keys.includes("le-root"));
    assert.ok(!keys.includes("current-liab"));
  });

  test("excludes descendants of the category being moved, to prevent a cycle", () => {
    const nodes = [...baseTree(), { key: "sub-fixed", parentKey: "fixed-assets", nodeType: "CATEGORY", label: "Equipment", accountType: "asset", statementType: "balance_sheet" }];
    const targets = getMoveTargetsForCategory(nodes, nodes.find((n) => n.key === "fixed-assets"));
    const keys = targets.map((t) => t.node.key);
    assert.ok(!keys.includes("fixed-assets"));
    assert.ok(!keys.includes("sub-fixed"));
    assert.ok(keys.includes("assets-root"));
  });
});

describe("diffCoaTrees", () => {
  test("an untouched tree produces all-empty buckets", () => {
    const nodes = baseTree();
    const diff = diffCoaTrees(nodes, nodes);
    assert.deepEqual(diff, { moved: [], created: [], deleted: [], renamed: [], movedCategories: [] });
  });

  test("an account whose parentKey changed shows up in `moved`, not `movedCategories`", () => {
    const original = baseTree();
    const current = moveNode(original, "chase", "fixed-assets");
    const diff = diffCoaTrees(original, current);
    assert.equal(diff.moved.length, 1);
    assert.equal(diff.moved[0].key, "chase");
    assert.equal(diff.moved[0].fromPath, "Total Assets > Current Assets > Chase Bank");
    assert.equal(diff.moved[0].toPath, "Total Assets > Fixed Assets > Chase Bank");
    assert.equal(diff.movedCategories.length, 0);
  });

  test("a pure category reparent shows up in `movedCategories`, with zero accounts touched", () => {
    const original = baseTree();
    const current = moveNode(original, "current-assets", "fixed-assets");
    const diff = diffCoaTrees(original, current);
    assert.equal(diff.moved.length, 0, "no ACCOUNT's own parentKey changed");
    assert.equal(diff.movedCategories.length, 1);
    assert.equal(diff.movedCategories[0].key, "current-assets");
    assert.equal(diff.movedCategories[0].fromParentPath, "Total Assets");
    assert.equal(diff.movedCategories[0].toParentPath, "Total Assets > Fixed Assets");
  });

  test("a renamed category shows up in `renamed`", () => {
    const original = baseTree();
    const current = renameNode(original, "fixed-assets", "Long-Term Assets");
    const diff = diffCoaTrees(original, current);
    assert.equal(diff.renamed.length, 1);
    assert.deepEqual(diff.renamed[0], { key: "fixed-assets", from: "Fixed Assets", to: "Long-Term Assets", path: "Total Assets > Long-Term Assets" });
  });

  test("a newly created EMPTY category is flagged hasDescendantAccount:false", () => {
    const original = baseTree();
    const { nodes: current } = createCategory(original, { parentKey: "current-assets", label: "Petty Cash" });
    const diff = diffCoaTrees(original, current);
    assert.equal(diff.created.length, 1);
    assert.equal(diff.created[0].label, "Petty Cash");
    assert.equal(diff.created[0].hasDescendantAccount, false);
  });

  test("a newly created category that DOES contain an account is flagged true", () => {
    const original = baseTree();
    const { nodes: withCategory, categoryKey } = createCategory(original, { parentKey: "current-assets", label: "Petty Cash" });
    const current = moveNode(withCategory, "chase", categoryKey);
    const diff = diffCoaTrees(original, current);
    const created = diff.created.find((c) => c.key === categoryKey);
    assert.equal(created.hasDescendantAccount, true);
  });

  test("a deleted category shows up in `deleted`", () => {
    const original = baseTree();
    const { nodes: current } = deleteCategory(original, "fixed-assets");
    const diff = diffCoaTrees(original, current);
    assert.equal(diff.deleted.length, 1);
    assert.equal(diff.deleted[0].key, "fixed-assets");
    assert.equal(diff.deleted[0].path, "Total Assets > Fixed Assets");
  });
});

// ── "Create New Parent" ─────────────────────────────────────────────────────
// The client-side half of the feature: validateNewCategory guards the dialog,
// createCategory performs the edit. Together they must satisfy the brief's
// test case — create "Cash Equivalents" under "Current Assets" and have
// Bank Accounts (and its accounts) stay exactly where they are.
describe("validateNewCategory", () => {
  test("requires a name", () => {
    const r = validateNewCategory(baseTree(), "current-assets", "   ");
    assert.equal(r.ok, false);
    assert.equal(r.error, "EMPTY_NAME");
  });

  test("accepts a fresh name under an existing category", () => {
    const r = validateNewCategory(baseTree(), "current-assets", "  Cash Equivalents  ");
    assert.equal(r.ok, true);
    assert.equal(r.error, null);
  });

  test("rejects a duplicate sibling instead of silently merging into it", () => {
    // "Current Assets" already exists under the Total Assets anchor.
    const r = validateNewCategory(baseTree(), "assets-root", "current assets");
    assert.equal(r.ok, false);
    assert.equal(r.error, "DUPLICATE");
    assert.match(r.message, /already exists/i);
  });

  test("the same name under a DIFFERENT parent is fine", () => {
    const r = validateNewCategory(baseTree(), "le-root", "Current Assets");
    assert.equal(r.ok, true);
  });

  test("rejects creating a parent under a posting account", () => {
    const r = validateNewCategory(baseTree(), "chase", "Sub-group");
    assert.equal(r.ok, false);
    assert.equal(r.error, "PARENT_IS_ACCOUNT");
  });

  test("rejects a destination that no longer exists", () => {
    const r = validateNewCategory(baseTree(), "ghost", "Whatever");
    assert.equal(r.ok, false);
    assert.equal(r.error, "PARENT_NOT_FOUND");
  });

  test("a root-level parent is allowed and dedup-checked against other roots", () => {
    assert.equal(validateNewCategory(baseTree(), null, "Off Balance Sheet").ok, true);
    const dup = validateNewCategory(baseTree(), null, "Total Assets");
    assert.equal(dup.ok, false);
    assert.equal(dup.error, "DUPLICATE");
  });
});

describe("creating a parent does not disturb the existing hierarchy", () => {
  // The brief's §19 case, at tree level.
  const build = () => {
    const nodes = baseTree();
    const { nodes: withBank, categoryKey: bankKey } = createCategory(nodes, {
      parentKey: "current-assets", label: "Bank Accounts",
    });
    // Move the existing account under Bank Accounts so the fixture matches
    // "Current Assets > Bank Accounts > Chase Bank".
    return { nodes: moveNode(withBank, "chase", bankKey), bankKey };
  };

  test("the new parent lands as a SIBLING — no existing account is moved into it", () => {
    const { nodes, bankKey } = build();
    const before = getHierarchyPathLabel(buildIndexes(nodes).nodesByKey, "chase");
    const { nodes: after, categoryKey } = createCategory(nodes, {
      parentKey: "current-assets", label: "Cash Equivalents",
    });

    const idx = buildIndexes(after);
    // Chase Bank is untouched.
    assert.equal(getHierarchyPathLabel(idx.nodesByKey, "chase"), before);
    assert.equal(idx.nodesByKey.get("chase").parentKey, bankKey);
    // The new parent is a peer of Bank Accounts, and is empty.
    assert.equal(idx.nodesByKey.get(categoryKey).parentKey, "current-assets");
    assert.equal((idx.childrenByParentKey.get(categoryKey) || []).length, 0);
    // Both now sit under Current Assets.
    const siblings = (idx.childrenByParentKey.get("current-assets") || []).map((n) => n.label);
    assert.ok(siblings.includes("Bank Accounts"));
    assert.ok(siblings.includes("Cash Equivalents"));
  });

  test("no account is added or lost, and none is duplicated", () => {
    const { nodes } = build();
    const accountsOf = (list) => list.filter((n) => n.nodeType === "ACCOUNT").map((n) => n.key).sort();
    const { nodes: after } = createCategory(nodes, { parentKey: "current-assets", label: "Cash Equivalents" });
    assert.deepEqual(accountsOf(after), accountsOf(nodes));
    assert.equal(new Set(accountsOf(after)).size, accountsOf(after).length);
  });

  test("account fields the user never touched are byte-for-byte identical", () => {
    const { nodes } = build();
    const { nodes: after } = createCategory(nodes, { parentKey: "current-assets", label: "Cash Equivalents" });
    for (const before of nodes.filter((n) => n.nodeType === "ACCOUNT")) {
      assert.deepEqual(after.find((n) => n.key === before.key), before);
    }
  });

  test("the new parent inherits its destination's classification, not a guess", () => {
    const { nodes } = build();
    const { nodes: after, categoryKey } = createCategory(nodes, { parentKey: "current-assets", label: "Cash Equivalents" });
    const created = after.find((n) => n.key === categoryKey);
    assert.equal(created.accountType, "asset");
    assert.equal(created.statementType, "balance_sheet");
  });

  test("levels are derived from the new position — never hand-set", () => {
    const { nodes } = build();
    const { nodes: after, categoryKey } = createCategory(nodes, { parentKey: "current-assets", label: "Cash Equivalents" });
    const idx = buildIndexes(after);
    assert.equal(getHierarchyPathLabel(idx.nodesByKey, categoryKey), "Total Assets > Current Assets > Cash Equivalents");
    // Nothing anywhere in the tree stores a `levels` field.
    assert.equal(after.some((n) => "levels" in n), false);
  });

  test("a P&L parent behaves identically — one generic code path", () => {
    const pl = [
      { key: "pl-root", parentKey: null, nodeType: "CATEGORY", label: "Total Expenses", accountType: "expense", statementType: "profit_loss" },
      { key: "opex", parentKey: "pl-root", nodeType: "CATEGORY", label: "Operating Expenses", accountType: "expense", statementType: "profit_loss" },
      { key: "sw", parentKey: "opex", nodeType: "ACCOUNT", accountName: "Software", accountType: "expense", statementType: "profit_loss" },
    ];
    assert.equal(validateNewCategory(pl, "opex", "Technology Expenses").ok, true);
    const { nodes: after, categoryKey } = createCategory(pl, { parentKey: "opex", label: "Technology Expenses" });
    const idx = buildIndexes(after);
    assert.equal(after.find((n) => n.key === categoryKey).statementType, "profit_loss");
    // Software stayed put.
    assert.equal(idx.nodesByKey.get("sw").parentKey, "opex");
  });
});
