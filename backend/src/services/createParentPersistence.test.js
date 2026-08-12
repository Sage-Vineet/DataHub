// Regression tests for the "Create New Parent" COA feature.
//
// THE LIMITATION THIS FIXES (identified before implementing, per the brief's
// "identify that limitation before implementing destructive behavior"):
//
// Categories were never submitted to the backend as first-class things. The
// hierarchy travelled ONLY inside each account's own `levels` path:
//   - deserializeApprovedTree skipped every non-ACCOUNT node outright, and
//   - buildCoaNodeTree re-derived the category set purely from leaf paths.
// So a parent the user created that held no account yet was referenced by no
// leaf path at all and was SILENTLY DROPPED on Save — exactly the case the
// feature creates, because creating a parent must not move existing accounts
// into it.
//
// THE FIX keeps the generated hierarchy as the source of truth (leaf-derived
// categories are still built first and still win on accountType/statementType)
// and adds user-created parents as an explicit, additive modification:
// deserializeApprovedTree now also reports each submitted CATEGORY's own
// resolved path, and buildCoaNodeTree materializes those too. Persisted as
// ordinary is_group rows in the SAME chart_of_accounts tree — no parallel
// "custom parents" table, no duplicated hierarchy.
//
// Run: node --test backend/src/services/createParentPersistence.test.js

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const coa = require("./chartOfAccountsService.js");
const { buildCoaNodeTree, deserializeApprovedTree, validateFinalCoaTree, fixedPrefixFor } = coa;

// ── The brief's §19 fixture, in the real wire shape ─────────────────────────
//   Total Assets > Current Assets > Bank Accounts > { Checking, Savings }
const ANCHOR = fixedPrefixFor("asset"); // ["Total Assets", "Total Assets"]

function baseNodes() {
  const nodes = [];
  let prev = null;
  // The fixed GAAP anchor, exactly as the generated tree carries it.
  ANCHOR.forEach((label, i) => {
    const key = `anchor-${i}`;
    nodes.push({ key, parentKey: prev, nodeType: "CATEGORY", label, accountType: "asset", statementType: "balance_sheet" });
    prev = key;
  });
  nodes.push({ key: "cat-ca", parentKey: prev, nodeType: "CATEGORY", label: "Current Assets", accountType: "asset", statementType: "balance_sheet" });
  nodes.push({ key: "cat-bank", parentKey: "cat-ca", nodeType: "CATEGORY", label: "Bank Accounts", accountType: "asset", statementType: "balance_sheet" });
  nodes.push({
    key: "acc-chk", parentKey: "cat-bank", nodeType: "ACCOUNT", accountName: "Checking",
    accountId: "id-chk", systemId: "BS-001", accountNumber: "1000",
    accountType: "asset", statementType: "balance_sheet",
  });
  nodes.push({
    key: "acc-sav", parentKey: "cat-bank", nodeType: "ACCOUNT", accountName: "Savings",
    accountId: "id-sav", systemId: "BS-002", accountNumber: "1010",
    accountType: "asset", statementType: "balance_sheet",
  });
  return nodes;
}

// The user creates "Cash Equivalents" under Current Assets, WITHOUT moving
// Bank Accounts into it (creation and movement are separate actions).
function withNewParent() {
  return [
    ...baseNodes(),
    {
      key: "client-cat::total assets > current assets > cash equivalents",
      parentKey: "cat-ca",
      nodeType: "CATEGORY",
      label: "Cash Equivalents",
      accountType: "asset",
      statementType: "balance_sheet",
      userEdited: true,
    },
  ];
}

const pathKeys = (map) => [...map.values()].map((v) => v.pathArr.join(" > "));

describe("the limitation: an empty parent used to be dropped on Save", () => {
  test("no leaf path mentions the new parent, so leaf-derived categories alone lose it", () => {
    const { hierarchical } = deserializeApprovedTree(withNewParent());
    // Old behaviour, reproduced exactly by passing no explicit categories.
    const leafOnly = buildCoaNodeTree(hierarchical);
    assert.equal(
      pathKeys(leafOnly).some((p) => p.endsWith("Cash Equivalents")), false,
      "the leaf-derived set cannot see an empty parent — this is the bug being fixed",
    );
  });
});

describe("an empty user-created parent now survives the Save pipeline", () => {
  test("deserializeApprovedTree reports the submitted category's own resolved path", () => {
    const { categoryPaths } = deserializeApprovedTree(withNewParent());
    const created = categoryPaths.find((c) => c.pathArr[c.pathArr.length - 1] === "Cash Equivalents");
    assert.ok(created, "the new parent must be reported as an explicit category");
    assert.deepEqual(created.pathArr, ["Total Assets", "Total Assets", "Current Assets", "Cash Equivalents"]);
    assert.equal(created.accountType, "asset");
    assert.equal(created.statementType, "balance_sheet");
  });

  test("buildCoaNodeTree materializes it when given those paths", () => {
    const { hierarchical, categoryPaths } = deserializeApprovedTree(withNewParent());
    const cats = buildCoaNodeTree(hierarchical, categoryPaths);
    const created = [...cats.values()].find((c) => c.label === "Cash Equivalents");
    assert.ok(created, "the new parent must be in the desired category set");
    assert.equal(created.accountType, "asset");
    assert.equal(created.statementType, "balance_sheet");
    // Depth is derived from the parent-child chain, never hand-set: the asset
    // anchor is ["Total Assets", "Total Assets"], so Current Assets sits at 3
    // and the new parent lands at 4.
    assert.equal(created.depth, created.pathArr.length);
    assert.equal(created.depth, 4);
  });

  test("it is parented to the selected destination, not the root", () => {
    const { hierarchical, categoryPaths } = deserializeApprovedTree(withNewParent());
    const cats = buildCoaNodeTree(hierarchical, categoryPaths);
    const created = [...cats.values()].find((c) => c.label === "Cash Equivalents");
    const parent = cats.get(created.parentKey);
    assert.ok(parent, "its parent must exist in the same category set");
    assert.equal(parent.label, "Current Assets");
  });

  test("validateFinalCoaTree accepts the tree and carries categoryPaths to the persist step", () => {
    const result = validateFinalCoaTree(withNewParent());
    assert.equal(result.valid, true, `unexpected violations: ${JSON.stringify(result.violations)}`);
    assert.ok(Array.isArray(result.categoryPaths));
    assert.ok(result.categoryPaths.some((c) => c.pathArr[c.pathArr.length - 1] === "Cash Equivalents"));
  });
});

describe("creating a parent changes nothing else", () => {
  test("no account is added, removed, renumbered or re-identified", () => {
    const before = deserializeApprovedTree(baseNodes()).hierarchical;
    const after = deserializeApprovedTree(withNewParent()).hierarchical;
    assert.equal(after.length, before.length, "account count must not change");
    const key = (l) => [l.accountId, l.accountName, l.accountNumber, l.systemId, l.accountType, l.statementType].join("|");
    assert.deepEqual(after.map(key).sort(), before.map(key).sort());
  });

  test("existing accounts keep their original hierarchy — nothing is silently moved", () => {
    const before = deserializeApprovedTree(baseNodes()).hierarchical;
    const after = deserializeApprovedTree(withNewParent()).hierarchical;
    const pathOf = (list, name) => list.find((l) => l.accountName === name).hierarchyPath;
    for (const name of ["Checking", "Savings"]) {
      assert.equal(pathOf(after, name), pathOf(before, name),
        `${name} must stay exactly where it was`);
    }
    assert.equal(pathOf(after, "Checking"), "Total Assets > Total Assets > Current Assets > Bank Accounts > Checking");
  });

  test("the generated hierarchy still wins: a leaf-derived category is not overwritten", () => {
    // Submit the SAME path as an existing leaf-derived category, but tagged
    // with a conflicting type. The leaf's classification must survive.
    const { hierarchical } = deserializeApprovedTree(baseNodes());
    const cats = buildCoaNodeTree(hierarchical, [
      { pathArr: ["Total Assets", "Total Assets", "Current Assets"], accountType: "liability", statementType: "profit_loss" },
    ]);
    const currentAssets = [...cats.values()].find((c) => c.label === "Current Assets");
    assert.equal(currentAssets.accountType, "asset", "the generated hierarchy remains the source of truth");
    assert.equal(currentAssets.statementType, "balance_sheet");
  });

  test("every pre-existing category is still produced", () => {
    const withBase = buildCoaNodeTree(deserializeApprovedTree(baseNodes()).hierarchical);
    const d = deserializeApprovedTree(withNewParent());
    const withNew = buildCoaNodeTree(d.hierarchical, d.categoryPaths);
    for (const p of pathKeys(withBase)) {
      assert.ok(pathKeys(withNew).includes(p), `category "${p}" disappeared`);
    }
  });

  test("no duplicate category is produced for a path stated both ways", () => {
    const d = deserializeApprovedTree(withNewParent());
    const cats = buildCoaNodeTree(d.hierarchical, d.categoryPaths);
    const paths = pathKeys(cats);
    assert.equal(new Set(paths).size, paths.length, `duplicate categories: ${JSON.stringify(paths)}`);
  });
});

describe("invalid hierarchies are still rejected", () => {
  test("a category under a posting account is not encoded as a path", () => {
    const nodes = [...baseNodes(), {
      key: "bad-cat", parentKey: "acc-chk", nodeType: "CATEGORY", label: "Impossible",
      accountType: "asset", statementType: "balance_sheet",
    }];
    const { categoryPaths } = deserializeApprovedTree(nodes);
    assert.equal(categoryPaths.some((c) => c.pathArr.includes("Impossible")), false,
      "a category can never live under a posting account");
    // And the submitted tree is rejected outright by the existing rule.
    const result = validateFinalCoaTree(nodes);
    assert.equal(result.valid, false);
    assert.ok(result.violations.some((v) => /posting account/i.test(v)));
  });

  test("a category with a dangling parent is skipped rather than persisted", () => {
    const nodes = [...baseNodes(), {
      key: "orphan-cat", parentKey: "does-not-exist", nodeType: "CATEGORY", label: "Orphan",
      accountType: "asset", statementType: "balance_sheet",
    }];
    const { categoryPaths } = deserializeApprovedTree(nodes);
    assert.equal(categoryPaths.some((c) => c.pathArr.includes("Orphan")), false);
  });
});

describe("the feature is statement-agnostic (P&L works the same way)", () => {
  test("a new parent under a P&L category is collected identically", () => {
    const plAnchor = fixedPrefixFor("expense");
    const nodes = [];
    let prev = null;
    plAnchor.forEach((label, i) => {
      const key = `pl-anchor-${i}`;
      nodes.push({ key, parentKey: prev, nodeType: "CATEGORY", label, accountType: "expense", statementType: "profit_loss" });
      prev = key;
    });
    nodes.push({ key: "cat-opex", parentKey: prev, nodeType: "CATEGORY", label: "Operating Expenses", accountType: "expense", statementType: "profit_loss" });
    nodes.push({
      key: "acc-sw", parentKey: "cat-opex", nodeType: "ACCOUNT", accountName: "Software",
      accountId: "id-sw", systemId: "EXP-001", accountType: "expense", statementType: "profit_loss",
    });
    nodes.push({
      key: "client-cat::tech", parentKey: "cat-opex", nodeType: "CATEGORY", label: "Technology Expenses",
      accountType: "expense", statementType: "profit_loss", userEdited: true,
    });

    const d = deserializeApprovedTree(nodes);
    const cats = buildCoaNodeTree(d.hierarchical, d.categoryPaths);
    const created = [...cats.values()].find((c) => c.label === "Technology Expenses");
    assert.ok(created, "the P&L parent must be materialized by the same generic code path");
    assert.equal(created.statementType, "profit_loss");
    // Software was NOT moved into it.
    const sw = d.hierarchical.find((l) => l.accountName === "Software");
    assert.ok(sw.hierarchyPath.endsWith("Operating Expenses > Software"));
    assert.equal(sw.hierarchyPath.includes("Technology Expenses"), false);
  });
});
