// Focused regression harness for generated BS/P&L reference-tree GL matching.
// Run: node backend/scripts/validateReferenceTreeGlComparison.js

const assert = require("assert");
const path = require("path");
const coa = require(path.join(__dirname, "..", "src", "services", "chartOfAccountsService.js"));
const {
  buildBalanceSheetTreeFromData,
  buildProfitLossTreeFromData,
} = require(path.join(__dirname, "..", "src", "services", "keyReports", "referenceTreeBuilder.js"));

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function hasAmounts(value) {
  return JSON.stringify(value).includes('"value"') || JSON.stringify(value).includes('"values"');
}

const balanceSheetTree = {
  name: "Balance Sheet",
  nodeType: "REPORT",
  children: [
    {
      name: "Total for Assets",
      nodeType: "TOTAL",
      value: 100,
      children: [
        {
          name: "Total for Current Assets",
          nodeType: "TOTAL",
          children: [
            { name: "HDFC Bank", nodeType: "ACCOUNT", value: 100, children: [] },
            { name: "Interest", nodeType: "ACCOUNT", value: 0, children: [] },
          ],
        },
      ],
    },
    {
      name: "Total for Liabilities and Equity",
      nodeType: "TOTAL",
      children: [
        {
          name: "Total for Liabilities",
          nodeType: "TOTAL",
          children: [
            { name: "Accounts Payable", nodeType: "ACCOUNT", value: 10, children: [] },
          ],
        },
        {
          name: "Total for Equity",
          nodeType: "TOTAL",
          children: [
            { name: "Net Income", nodeType: "ACCOUNT", value: -50, children: [] },
          ],
        },
      ],
    },
  ],
};

const profitLossTree = {
  name: "Profit and Loss",
  nodeType: "REPORT",
  children: [
    {
      name: "Net Income",
      nodeType: "CALCULATED_TOTAL",
      values: { Total: null },
      children: [
        {
          name: "Net Operating Income",
          nodeType: "CALCULATED_TOTAL",
          children: [
            {
              name: "Gross Profit",
              nodeType: "CALCULATED_TOTAL",
              children: [
                {
                  name: "Total for Income",
                  nodeType: "TOTAL",
                  children: [
                    { name: "Product Sales", nodeType: "ACCOUNT", values: { Total: 10 }, children: [] },
                    { name: "Interest", nodeType: "ACCOUNT", values: { Total: 0 }, children: [] },
                  ],
                },
                {
                  name: "Total for Expenses",
                  nodeType: "TOTAL",
                  relationship: "SUBTRACT",
                  children: [
                    { name: "Office Rent", nodeType: "ACCOUNT", values: { Total: -5 }, children: [] },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

const originalBs = clone(balanceSheetTree);
const originalPl = clone(profitLossTree);
const bsLookup = coa.buildTreeHierarchyLookup(balanceSheetTree, "balance_sheet");
const plLookup = coa.buildTreeHierarchyLookup(profitLossTree, "profit_loss");

const builtBsTree = buildBalanceSheetTreeFromData({
  reportName: "Balance Sheet",
  rows: [
    { account_name: "Business Checking (7454)", amount: 0, parent_path: ["Assets", "Current Assets", "Bank Accounts"] },
    { account_name: "Provident Bank Money Market Checking", amount: 258393.41, parent_path: ["Assets", "Current Assets", "Bank Accounts"] },
    { account_name: "Total for Bank Accounts", amount: 258393.41, is_total: true, parent_path: ["Assets", "Current Assets"] },
    { account_name: "Retained Earnings", amount: 112021.03, parent_path: ["Liabilities and Equity", "Equity"] },
    { account_name: "Net Income", amount: 169495.9, parent_path: ["Liabilities and Equity", "Equity"] },
    { account_name: "Total for Equity", amount: 281516.93, is_total: true, parent_path: ["Liabilities and Equity"] },
  ],
});
assert.deepStrictEqual(
  coa.buildTreeHierarchyLookup(builtBsTree, "balance_sheet").get("net income")[0].levels,
  ["Total Liabilities and Equity", "Total Equity", "Total Equity", "Equity", "Net Income"],
);
assert.deepStrictEqual(
  coa.buildTreeHierarchyLookup(builtBsTree, "balance_sheet").get("provident bank money market checking")[0].levels,
  ["Total Assets", "Total Assets", "Current Assets", "Bank Accounts", "Provident Bank Money Market Checking"],
);

const builtPlTree = buildProfitLossTreeFromData({
  reportName: "Profit and Loss",
  periodKeys: ["Jan 2025", "Total"],
  rows: [
    { account_name: "Sales", section: "revenue", parent_path: ["Income"], values: { "Jan 2025": 100, Total: 100 } },
    { account_name: "Total for Income", section: "revenue", is_total: true, values: { "Jan 2025": 100, Total: 100 } },
    { account_name: "Rent & Lease", section: "operating_expenses", parent_path: ["Expenses"], values: { "Jan 2025": 25, Total: 25 } },
    { account_name: "Total for Expenses", section: "operating_expenses", is_total: true, values: { "Jan 2025": 25, Total: 25 } },
  ],
});
const builtNetIncome = builtPlTree.children[0];
const builtNetOperatingIncome = builtNetIncome.children.find((n) => n.name === "Net Operating Income");
const builtGrossProfit = builtNetOperatingIncome.children.find((n) => n.name === "Gross Profit");
assert.deepStrictEqual(builtNetOperatingIncome.children.map((n) => n.name), ["Gross Profit", "Total for Expenses"]);
assert.deepStrictEqual(builtGrossProfit.children.map((n) => n.name), ["Total for Income"]);
assert.strictEqual(builtNetOperatingIncome.children.find((n) => n.name === "Total for Expenses").relationship, "SUBTRACT");
assert.deepStrictEqual(
  coa.buildTreeHierarchyLookup(builtPlTree, "profit_loss").get("rent & lease")[0].levels,
  ["Total Liabilities and Equity", "Total Equity", "Total Equity", "Expenses", "Rent & Lease"],
);
assert.deepStrictEqual(
  coa.buildTreeHierarchyLookup(builtPlTree, "profit_loss").get("sales")[0].levels,
  ["Total Liabilities and Equity", "Total Equity", "Total Equity", "Income", "Sales"],
);

assert.deepStrictEqual(bsLookup.get("hdfc bank")[0].levels, ["Total Assets", "Total Assets", "Current Assets", "HDFC Bank"]);
assert.deepStrictEqual(bsLookup.get("accounts payable")[0].levels, [
  "Total Liabilities and Equity", "Total Liabilities", "Accounts Payable",
]);
assert.deepStrictEqual(plLookup.get("product sales")[0].levels, [
  "Total Liabilities and Equity", "Total Equity", "Total Equity",
  "Income", "Product Sales",
]);
// 4, not 3: the asset anchor contributes "Total Assets" at levels 1-2 per the
// Balance Sheet level specification, then "Current Assets" > "HDFC Bank".
assert.strictEqual(bsLookup.get("hdfc bank")[0].level, 4);
assert.strictEqual(bsLookup.get("accounts payable")[0].level, 3);
assert.strictEqual(plLookup.get("product sales")[0].level, 5);
assert.deepStrictEqual(balanceSheetTree, originalBs);
assert.deepStrictEqual(profitLossTree, originalPl);

assert.strictEqual(coa.selectReferenceTree({ statementType: "balance_sheet", balanceSheetLookup: bsLookup, profitLossLookup: plLookup }), bsLookup);
assert.strictEqual(coa.selectReferenceTree({ statementType: "profit_loss", balanceSheetLookup: bsLookup, profitLossLookup: plLookup }), plLookup);
assert.strictEqual(coa.selectReferenceTree({ statementType: null, balanceSheetLookup: bsLookup, profitLossLookup: plLookup }), null);

const assetMatch = coa.pickDocHierarchy("HDFC Bank", "hdfc bank", null, bsLookup, plLookup, null, {
  statementType: "balance_sheet",
  accountType: "asset",
});
assert.strictEqual(assetMatch.nodeName, "HDFC Bank");
assert.deepStrictEqual(assetMatch.levels, ["Total Assets", "Total Assets", "Current Assets", "HDFC Bank"]);
assert.strictEqual(assetMatch.matchType, "exact");

const liabilityMatch = coa.pickDocHierarchy("Net Income", "net income", null, bsLookup, plLookup, null, { accountType: "equity" });
assert.deepStrictEqual(liabilityMatch.levels, ["Total Liabilities and Equity", "Total Equity", "Total Equity", "Equity", "Net Income"]);

const incomeMatch = coa.pickDocHierarchy("Product Sales", "product sales", null, bsLookup, plLookup, null, { accountType: "income" });
assert.deepStrictEqual(incomeMatch.levels, [
  "Total Liabilities and Equity", "Total Equity", "Total Equity",
  "Income", "Product Sales",
]);

const expenseMatch = coa.pickDocHierarchy("Office Rent", "office rent", null, bsLookup, plLookup, null, { accountType: "expense" });
assert.deepStrictEqual(expenseMatch.levels, [
  "Total Liabilities and Equity", "Total Equity", "Total Equity",
  "Expenses", "Office Rent",
]);

const sameNamePl = coa.pickDocHierarchy("Interest", "interest", null, bsLookup, plLookup, null, { statementType: "profit_loss" });
assert.deepStrictEqual(sameNamePl.levels, [
  "Total Liabilities and Equity", "Total Equity", "Total Equity",
  "Income", "Interest",
]);

const noCrossFallback = coa.pickDocHierarchy("Product Sales", "product sales", null, bsLookup, plLookup, null, { statementType: "balance_sheet" });
assert.strictEqual(noCrossFallback, null);

const fuzzyInsideSelected = coa.pickDocHierarchy("HDFC Ban", "hdfc ban", null, bsLookup, plLookup, null, { accountType: "asset" });
assert.strictEqual(fuzzyInsideSelected.nodeName, "HDFC Bank");
assert.strictEqual(fuzzyInsideSelected.matchType, "fuzzy");

// EXPECTATION DELIBERATELY CHANGED (was: assert.strictEqual(unknown, null)).
// An account with NO statement hint of any kind -- no context.statementType,
// no context.accountType, no glBucket entry -- used to resolve to null here,
// which meant it was handed to the AI fallback even when the uploaded
// document unambiguously contained it. That contradicts the standing rule
// that AI is a LAST resort, used only when the account cannot be resolved
// from document evidence at all. pickDocHierarchy now searches every
// not-yet-searched tree (BS first, then P&L, deterministically) before
// giving up, so a real document match wins over an AI guess. The
// cross-contamination guard is unaffected and still asserted above
// (noCrossFallback): when the caller DOES supply confident statementType
// evidence, the search stays hard-gated to that one statement.
const unknown = coa.pickDocHierarchy("Product Sales", "product sales", null, bsLookup, plLookup, null, {});
assert.strictEqual(unknown.nodeName, "Product Sales");
assert.strictEqual(unknown.accountType, "income");
assert.strictEqual(unknown.statementType, "profit_loss");

// A name present in NEITHER tree still correctly resolves to null (so the
// change above widened the search, it did not make the function match
// anything unconditionally).
assert.strictEqual(
  coa.pickDocHierarchy("Totally Absent Account", "totally absent account", null, bsLookup, plLookup, null, {}),
  null,
);

const multiYearGl = [
  { accountName: "HDFC Bank", fiscalYear: 2022 },
  { accountName: "HDFC Bank", fiscalYear: 2023 },
  { accountName: "HDFC Bank", fiscalYear: 2024 },
];
const uniqueMatches = new Map();
for (const row of multiYearGl) {
  const key = row.accountName.toLowerCase();
  if (!uniqueMatches.has(key)) {
    uniqueMatches.set(key, coa.pickDocHierarchy(row.accountName, key, null, bsLookup, plLookup, null, { accountType: "asset" }));
  }
}
assert.strictEqual(uniqueMatches.size, 1);
assert.deepStrictEqual(uniqueMatches.get("hdfc bank").levels, ["Total Assets", "Total Assets", "Current Assets", "HDFC Bank"]);

assert.strictEqual(hasAmounts(assetMatch), false);

assert.deepStrictEqual(
  coa.applyBalanceSheetCoaPrefix({ accountType: "asset", matchedPath: ["Total for Assets", "Total for Current Assets", "Cash"] }),
  ["Total Assets", "Total Assets", "Current Assets", "Cash"],
);
assert.deepStrictEqual(
  coa.applyBalanceSheetCoaPrefix({ accountType: "asset", matchedPath: ["Total Assets", "Cash"] }),
  // The asset anchor is "Total Assets" at L1 AND L2 per the Balance Sheet
  // level specification; the document's single "Total Assets" is absorbed by
  // the anchor rather than duplicated after it.
  ["Total Assets", "Total Assets", "Cash"],
);
assert.deepStrictEqual(
  coa.applyBalanceSheetCoaPrefix({ accountType: "liability", matchedPath: ["Total for Liabilities and Equity", "Total for Liabilities", "Accounts Payable"] }),
  ["Total Liabilities and Equity", "Total Liabilities", "Accounts Payable"],
);
assert.deepStrictEqual(
  coa.applyBalanceSheetCoaPrefix({ accountType: "equity", matchedPath: ["Total for Liabilities and Equity", "Total for Equity", "Retained Earnings"] }),
  ["Total Liabilities and Equity", "Total Equity", "Total Equity", "Equity", "Retained Earnings"],
);
assert.strictEqual(coa.cleanDynamicCoaLevelLabel("Total for Current Assets"), "Current Assets");
assert.strictEqual(coa.cleanDynamicCoaLevelLabel("Total for Bank Accounts"), "Bank Accounts");
assert.strictEqual(coa.cleanDynamicCoaLevelLabel("Total for Current Liabilities"), "Current Liabilities");
assert.strictEqual(coa.cleanDynamicCoaLevelLabel("Total for Credit Cards"), "Credit Cards");
assert.strictEqual(coa.cleanDynamicCoaLevelLabel("Total for Income"), "Income");
assert.strictEqual(coa.cleanDynamicCoaLevelLabel("Total for Expenses"), "Expenses");
assert.deepStrictEqual(
  coa.applyBalanceSheetCoaPrefix({
    accountType: "liability",
    matchedPath: ["Total for Liabilities and Equity", "Total for Liabilities", "Total for Current Liabilities", "Total for Credit Cards"],
    accountName: "Capital One - Credit Card",
  }),
  ["Total Liabilities and Equity", "Total Liabilities", "Current Liabilities", "Credit Cards", "Capital One - Credit Card"],
);
assert.deepStrictEqual(
  coa.applyBalanceSheetCoaPrefix({
    accountType: "equity",
    matchedPath: ["Total for Liabilities and Equity", "Total for Equity", "Total for Equity", "Owner Equity"],
  }),
  // Equity's anchor is 4 levels per the Balance Sheet level specification
  // (L1 "Total Liabilities and Equity", L2/L3 "Total Equity", L4 "Equity");
  // "Owner Equity" is the document's own real sub-heading below it.
  ["Total Liabilities and Equity", "Total Equity", "Total Equity", "Equity", "Owner Equity"],
);
assert.deepStrictEqual(
  coa.ensureAccountLeaf({ hierarchyPath: ["Total Assets", "Current Assets", "", null, "Bank Accounts"], accountName: "Business Checking (7454)" }),
  ["Total Assets", "Current Assets", "Bank Accounts", "Business Checking (7454)"],
);
assert.deepStrictEqual(
  coa.ensureAccountLeaf({ hierarchyPath: ["Total Assets", "Current Assets", "Total Quality Services"], accountName: "Total Quality Services" }),
  ["Total Assets", "Current Assets", "Total Quality Services"],
);
assert.deepStrictEqual(coa.fixedPrefixFor("equity"), ["Total Liabilities and Equity", "Total Equity", "Total Equity", "Equity"]);
assert.deepStrictEqual(coa.fixedPrefixFor("liability"), ["Total Liabilities and Equity", "Total Liabilities"]);
assert.deepStrictEqual(coa.fixedPrefixFor("asset"), ["Total Assets", "Total Assets"]);
assert.deepStrictEqual(coa.fixedPrefixFor("income"), ["Total Liabilities and Equity", "Total Equity", "Total Equity"]);
assert.notStrictEqual(
  coa.applyBalanceSheetCoaPrefix({ accountType: "liability", matchedPath: ["Total for Liabilities and Equity", "Total for Liabilities", "Accounts Payable"] })[1],
  "Total Equity",
);
assert.notStrictEqual(
  coa.applyBalanceSheetCoaPrefix({ accountType: "equity", matchedPath: ["Total for Liabilities and Equity", "Total for Equity", "Retained Earnings"] })[1],
  "Total Liabilities",
);
assert.deepStrictEqual(
  coa.buildTreeHierarchyLookup(profitLossTree, "profit_loss").get("product sales")[0].levels.slice(0, 3),
  ["Total Liabilities and Equity", "Total Equity", "Total Equity"],
);

const retainedEarningsBucket = coa.splitAccountsAtRetainedEarnings([
  { account_name: "Cash", split_account: "Retained Earnings", memo: "To Post the Distribution into Retained Earnings" },
  { account_name: "Loan Payable" },
  { account_name: "Retained Earnings" },
  { account_name: "Retained Earnings", row_type: "TRANSACTION" },
  { account_name: "Total for Retained Earnings", row_type: "TOTAL" },
  { account_name: "Discounts/Refunds Given" },
  { account_name: "Office Rent" },
], profitLossTree);
assert.strictEqual(retainedEarningsBucket.get("cash"), "balance_sheet");
assert.strictEqual(retainedEarningsBucket.get("loan payable"), "balance_sheet");
assert.strictEqual(retainedEarningsBucket.get("retained earnings"), "profit_loss");
assert.strictEqual(retainedEarningsBucket.get("discounts/refunds given"), "profit_loss");
assert.strictEqual(retainedEarningsBucket.get("office rent"), "profit_loss");

const codedRetainedEarningsBucket = coa.splitAccountsAtRetainedEarnings([
  { account_name: "1000 Cash" },
  { account_name: "32000 - Retained Earnings" },
  { account_name: "66000 Payroll Expenses" },
], profitLossTree);
assert.strictEqual(codedRetainedEarningsBucket.get("cash"), "balance_sheet");
assert.strictEqual(codedRetainedEarningsBucket.get("32000 - retained earnings"), "profit_loss");
assert.strictEqual(codedRetainedEarningsBucket.get("retained earnings"), "profit_loss");
assert.strictEqual(codedRetainedEarningsBucket.get("payroll expenses"), "profit_loss");

const firstPnlFallbackBucket = coa.splitAccountsAtRetainedEarnings([
  { account_name: "Cash" },
  { account_name: "Accounts Payable", memo: "Product Sales appears only in memo" },
  { account_name: "4000 Product Sales" },
  { account_name: "Office Rent" },
], profitLossTree);
assert.strictEqual(coa.findFirstProfitAndLossAccount(profitLossTree).name, "Product Sales");
assert.strictEqual(firstPnlFallbackBucket.get("cash"), "balance_sheet");
assert.strictEqual(firstPnlFallbackBucket.get("accounts payable"), "balance_sheet");
assert.strictEqual(firstPnlFallbackBucket.get("product sales"), "profit_loss");
assert.strictEqual(firstPnlFallbackBucket.get("office rent"), "profit_loss");
assert.strictEqual(coa.findFirstProfitAndLossAccount(profitLossTree).nodeType, "ACCOUNT");

const unresolvedBucket = coa.splitAccountsAtRetainedEarnings([
  { account_name: "Cash", split_account: "Product Sales" },
  { account_name: "Accounts Payable", memo: "Product Sales" },
], profitLossTree);
assert.strictEqual(unresolvedBucket.size, 0);

const manualLeaf = {
  accountName: "Manual Account",
  accountType: null,
  classificationMethod: "unclassified",
  needsReview: true,
  sources: new Set(["general_ledger"]),
  fiscalYears: new Set([2025]),
};
coa.buildLeafHierarchies([manualLeaf]).then((resolved) => {
  assert.strictEqual(resolved[0].needsMapping, true);
  assert.strictEqual(resolved[0].needsReview, true);
  console.log("Reference-tree GL comparison checks passed.");
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
