"use strict";

const assert = require("assert");
const {
  buildCoaModel,
  buildLeafHierarchies,
  buildTree,
  serializeProposedTree,
  splitAccountsAtRetainedEarnings,
  buildTreeHierarchyLookup,
  cleanDynamicCoaLevelLabel,
  ensureAccountLeaf,
  validateFinalCoaTree,
} = require("../src/services/chartOfAccountsService");

const BS_TREE = {
  name: "Balance Sheet",
  nodeType: "REPORT",
  children: [
    {
      name: "Total Liabilities and Equity",
      nodeType: "SECTION",
      children: [
        {
          name: "Total Liabilities",
          nodeType: "SECTION",
          children: [
            {
              name: "Current Liabilities",
              nodeType: "SECTION",
              children: [
                { name: "Capital One - Credit Card", nodeType: "ACCOUNT", accountType: "liability", children: [] },
                { name: "Credit Card Payable", nodeType: "ACCOUNT", accountType: "liability", children: [] },
                { name: "Accrued Meals Tax", nodeType: "ACCOUNT", accountType: "liability", children: [] },
              ],
            },
            { name: "Loan Payable - Officer", nodeType: "ACCOUNT", accountType: "liability", children: [] },
            { name: "Government Loan Payable - SBA", nodeType: "ACCOUNT", accountType: "liability", children: [] },
          ],
        },
        {
          name: "Total Equity",
          nodeType: "SECTION",
          children: [
            { name: "Owner's Equity", nodeType: "ACCOUNT", accountType: "equity", children: [] },
            { name: "Retained Earnings", nodeType: "ACCOUNT", accountType: "equity", children: [] },
          ],
        },
      ],
    },
  ],
};

const PL_TREE = {
  name: "Profit and Loss",
  nodeType: "REPORT",
  children: [
    {
      name: "Income",
      nodeType: "SECTION",
      children: [
        { name: "Retained Earnings", nodeType: "ACCOUNT", accountType: "income", children: [] },
        { name: "Discounts/Refunds Given", nodeType: "ACCOUNT", accountType: "income", children: [] },
        { name: "Interest Income", nodeType: "ACCOUNT", accountType: "income", children: [] },
        { name: "Sales", nodeType: "ACCOUNT", accountType: "income", children: [] },
      ],
    },
  ],
};

function glRows(names) {
  return names.map((account_name, index) => ({
    id: index + 1,
    account_name,
    fiscal_year: 2026,
  }));
}

function firstLevels(leaf) {
  return (leaf.levels || []).filter(Boolean);
}

function bucketFor(buckets, accountName) {
  const target = accountName.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  for (const [key, value] of buckets.entries()) {
    const comparable = String(key).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (comparable === target) return value;
  }
  return undefined;
}

function lookupFor(lookup, accountName) {
  const target = accountName.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  for (const [key, value] of lookup.entries()) {
    const comparable = String(key).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (comparable === target) return value?.[0];
  }
  return undefined;
}

(async () => {
  assert.strictEqual(cleanDynamicCoaLevelLabel("Total Credit Cards"), "Credit Cards");
  assert.deepStrictEqual(
    ensureAccountLeaf({ hierarchyPath: ["Current Liabilities"], accountName: "Capital One - Credit Card" }),
    ["Current Liabilities", "Capital One - Credit Card"],
  );

  const ordered = glRows([
    "Loan Payable - Provident Bank",
    "Retained Earnings",
    "Discounts/Refunds Given",
    "Interest Income",
    "Sales",
  ]);
  const buckets = splitAccountsAtRetainedEarnings(ordered, PL_TREE);
  assert.strictEqual(bucketFor(buckets, "Loan Payable - Provident Bank"), "balance_sheet");
  assert.strictEqual(bucketFor(buckets, "Retained Earnings"), "profit_loss");
  assert.strictEqual(bucketFor(buckets, "Discounts/Refunds Given"), "profit_loss");
  assert.strictEqual(bucketFor(buckets, "Interest Income"), "profit_loss");
  assert.strictEqual(bucketFor(buckets, "Sales"), "profit_loss");

  const bsLookup = buildTreeHierarchyLookup(BS_TREE, "balance_sheet");
  const liabilities = [
    "Capital One - Credit Card",
    "Credit Card Payable",
    "Accrued Meals Tax",
    "Loan Payable - Officer",
    "Government Loan Payable - SBA",
  ];
  for (const name of liabilities) {
    const entry = lookupFor(bsLookup, name);
    assert(entry, `Missing lookup for ${name}`);
    assert.strictEqual(entry.levels[0], "Total Liabilities and Equity");
    assert.strictEqual(entry.levels[1], "Total Liabilities");
    assert.notStrictEqual(entry.levels[1], "Total Equity");
  }

  const equity = lookupFor(bsLookup, "Owner's Equity");
  assert(equity, "Missing equity lookup");
  assert.strictEqual(equity.levels[0], "Total Liabilities and Equity");
  assert.strictEqual(equity.levels[1], "Total Equity");

  const modelRows = glRows([
    "Capital One - Credit Card",
    "Credit Card Payable",
    "Accrued Meals Tax",
    "Loan Payable - Officer",
    "Government Loan Payable - SBA",
    "Retained Earnings",
    "Discounts/Refunds Given",
    "Interest Income",
    "Sales",
  ]);
  const modelBuckets = splitAccountsAtRetainedEarnings(modelRows, PL_TREE);
  const { leaves } = buildCoaModel(modelRows, [], [], new Map(), new Map(), modelBuckets, 2026, {
    balanceSheetTree: BS_TREE,
    profitLossTree: PL_TREE,
  });
  const hierarchical = await buildLeafHierarchies(leaves);
  const byName = new Map(hierarchical.map((leaf) => [String(leaf.accountName).toLowerCase(), leaf]));

  const capitalOne = byName.get("capital one - credit card");
  assert(capitalOne, "Missing Capital One response leaf");
  assert.strictEqual(capitalOne.statementType, "balance_sheet");
  assert.deepStrictEqual(firstLevels(capitalOne).slice(0, 2), ["Total Liabilities and Equity", "Total Liabilities"]);

  const retained = byName.get("retained earnings");
  assert(retained, "Missing Retained Earnings response leaf");
  assert.strictEqual(retained.statementType, "profit_loss");
  assert.deepStrictEqual(firstLevels(retained).slice(0, 3), ["Total Liabilities and Equity", "Total Equity", "Total Equity"]);

  const proposedTree = serializeProposedTree(buildTree(hierarchical));
  const validation = validateFinalCoaTree(proposedTree);
  if (!validation.valid) {
    console.error("[validateReferenceTreeGlComparison] validation errors:", validation);
  }
  assert.strictEqual(validation.valid, true, validation.errors?.join("\n"));

  console.log("[validateReferenceTreeGlComparison] PASS");
  console.log("Capital One - Credit Card:", {
    statementType: capitalOne.statementType,
    levels: firstLevels(capitalOne),
  });
  console.log("Retained Earnings:", {
    statementType: retained.statementType,
    levels: firstLevels(retained),
  });
})();
