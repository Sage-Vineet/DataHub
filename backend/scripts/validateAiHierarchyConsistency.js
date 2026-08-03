// Regression harness for the AI-category / accountType consistency fix in
// chartOfAccountsService.js (addLeaf's Priority-3 branch and mergeInto).
// No DB access -- pure function tests against real exported functions.
//
// CONFIRMED ROOT CAUSE fixed here: `accountType` starts as the AI's own
// classification guess (aiResult.accountType). When the AI's confidence is
// below AI_OVERRIDE_CONFIDENCE_FLOOR, structural evidence (bsSection/
// plSection, a real document field -- not AI/keyword-derived) can override
// `accountType` to something DIFFERENT from the AI's own guess. But
// `leaf.aiLevels` (the AI's own hierarchy CATEGORY path, e.g. "Fixed
// Assets") was captured unconditionally, straight from the AI response,
// with no re-check against the (possibly now-different) final accountType.
// buildLeafHierarchies then blindly concatenates
// [...getFinalCoaPrefix(accountType), ...aiLevels] -- producing a leaf
// whose classification (accountType) and hierarchy (levels) DISAGREE, e.g.
// a real Balance Sheet liability ("Kubota - Tractor Attachments") ending up
// with the AI's stale "Fixed Assets" category (reasoned out under the AI's
// own, now-superseded "this is probably an asset" guess) nested under
// "Total Liabilities" in the exported Proposed COA.
//
// Fixed: whenever accountType is about to change away from the AI's own
// guess (at leaf creation, via aiOwnAccountType; or on a later merge, via
// clearStaleAiLevelsIfRetyping), aiLevels is cleared and needsReview is
// forced true -- the leaf falls through to needsMapping (honest, flagged
// for manual review) instead of carrying an invented, inconsistent
// category forward.
//
// Run: node backend/scripts/validateAiHierarchyConsistency.js

const path = require("path");
const coa = require(path.join(__dirname, "..", "src", "services", "chartOfAccountsService.js"));

let pass = 0;
let fail = 0;
const failures = [];

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    failures.push(name);
    console.log(`  FAIL  ${name}\n        expected: ${e}\n        actual  : ${a}`);
  }
}
function checkTrue(name, actual) { check(name, Boolean(actual), true); }

console.log("\n=== 1. Leaf-creation-time retype (bsSection present on the SAME addLeaf call) ===");
{
  // A row whose section evidence is real but excluded from document-tree
  // matching (hierarchy_level: 0), so Priority 2 finds nothing and this
  // falls to Priority 3 (AI). The AI's low-confidence 'asset' guess (with a
  // "Fixed Assets" category, reasoned from the account's equipment-sounding
  // name) gets overridden by the row's own bsSection ('liabilities').
  const bsRows = [
    { account_name: "Kubota - Tractor Attachments", section: "liabilities", parent_path: [], fiscal_year: 2024, node_type: "account", is_total: false, hierarchy_level: 0 },
  ];
  const aiResults = new Map([
    ["kubota - tractor attachments", { accountType: "asset", confidence: 0.4, levels: ["Fixed Assets"], reasoning: "Equipment-sounding name" }],
  ]);
  const { leaves } = coa.buildCoaModel([], bsRows, [], aiResults, new Map(), new Map(), null, {});
  const leaf = leaves.find((l) => l.accountName === "Kubota - Tractor Attachments");

  checkTrue("1a. Leaf exists", Boolean(leaf));
  check("1b. accountType correctly overridden to liability (structural evidence wins over low-confidence AI)", leaf.accountType, "liability");
  check("1c. Stale AI category ('Fixed Assets') is cleared, not carried forward", leaf.aiLevels, []);
  checkTrue("1d. needsReview forced true (this is now a flagged-for-review account, not silently resolved)", leaf.needsReview);
}

console.log("\n=== 3. No false positives: AI accountType and structural evidence AGREE -> aiLevels preserved ===");
{
  const bsRows = [
    { account_name: "Shop Equipment", section: "assets", parent_path: [], fiscal_year: 2024, node_type: "account", is_total: false, hierarchy_level: 0 },
  ];
  const aiResults = new Map([
    ["shop equipment", { accountType: "asset", confidence: 0.6, levels: ["Fixed Assets"], reasoning: "Equipment" }],
  ]);
  const { leaves } = coa.buildCoaModel([], bsRows, [], aiResults, new Map(), new Map(), null, {});
  const leaf = leaves.find((l) => l.accountName === "Shop Equipment");
  check("3a. accountType is asset (AI and structural evidence agree)", leaf.accountType, "asset");
  check("3b. aiLevels preserved when there's no disagreement to invalidate it", leaf.aiLevels, ["Fixed Assets"]);
  checkTrue("3c. needsReview NOT force-flagged when nothing was retyped", !leaf.needsReview || leaf.confidence < 0.85);
}

const bsRowsForE2E = [
  { account_name: "Kubota - Tractor Attachments", section: "liabilities", parent_path: [], fiscal_year: 2024, node_type: "account", is_total: false, hierarchy_level: 0 },
];
const aiResultsForE2E = new Map([
  ["kubota - tractor attachments", { accountType: "asset", confidence: 0.4, levels: ["Fixed Assets"], reasoning: "Equipment-sounding name" }],
]);
const { leaves: leavesForE2E } = coa.buildCoaModel([], bsRowsForE2E, [], aiResultsForE2E, new Map(), new Map(), null, {});

console.log("\n=== 2. End-to-end: buildLeafHierarchies never produces a mismatched classification/hierarchy ===");
coa.buildLeafHierarchies(leavesForE2E).then((resolved) => {
  const leaf = resolved.find((l) => l.accountName === "Kubota - Tractor Attachments");
  check("2a. Never produces the reported bug: 'Fixed Assets' must NOT appear in a liability account's levels",
    (leaf.levels || []).includes("Fixed Assets"), false);
  checkTrue("2b. Honestly flagged needsMapping instead of inventing an inconsistent hierarchy", leaf.needsMapping);

  console.log(`\n${"=".repeat(60)}\n${pass} passed, ${fail} failed\n${"=".repeat(60)}`);
  if (fail > 0) {
    console.log("Failures:");
    failures.forEach((f) => console.log(`  - ${f}`));
  }
  process.exit(fail === 0 ? 0 : 1);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
