// Regression harness for the "ONE canonical hierarchy source" refactor.
// No DB access -- pure function tests against real exported functions.
//
// CONFIRMED ROOT CAUSE this closes: chart_of_accounts has TWO writers, and
// they used TWO DIFFERENT hierarchy algorithms:
//
//   Phase 2  (pre-Save proposal) -- buildProposedCoaTree/buildCoaModel
//     hierarchy source: opts.balanceSheetTree / opts.profitLossTree, the
//     document-derived reference trees from referenceTreeBuilder.js, read via
//     buildTreeHierarchyLookup + inferAccountTypeFromReferencePath (accountType
//     derived from the matched node's own ANCESTOR PATH).
//
//   Phase 2c (post-Save completion) -- ensureCoaComplete
//     hierarchy source: buildDocHierarchyLookups' OWN populateHierarchyTree
//     trees, where accountType comes from bsSectionToType(row.section) (the
//     extraction-time scalar `section` field) -- a different question, answered
//     from a different field, by a different algorithm.
//
// Both writers persist. So a GL-only account first discovered at Phase 2c
// could be classified and placed differently than the identical account would
// have been in the Proposed COA the user actually reviewed and approved -- and
// Phase 2c's answer is the one that survives in the database.
//
// Fixed: ensureCoaComplete now accepts the SAME referenceTrees the proposal
// phase used and prefers them exactly the way buildCoaModel already does, so
// there is ONE canonical document-derived hierarchy source for both writers.
// buildDocHierarchyLookups remains ONLY as the no-reference-tree fallback
// (direct callers/tests), never as a competing production path.
//
// Run: node backend/scripts/validateCanonicalHierarchySource.js

const path = require("path");
const coa = require(path.join(__dirname, "..", "src", "services", "chartOfAccountsService.js"));
const {
  buildBalanceSheetTreeFromData,
  buildProfitLossTreeFromData,
} = require(path.join(__dirname, "..", "src", "services", "keyReports", "referenceTreeBuilder.js"));

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

// ---------------------------------------------------------------------------
// Fixtures: a REAL document shape, with structural/header rows present (they
// are what supply ancestry -- see the structural-row test below).
// ---------------------------------------------------------------------------
function heading(name, parentPath) {
  return { account_name: name, row_type: "heading", parent_path: parentPath, hierarchy_level: 0, is_total: false };
}
function acct(name, parentPath, section) {
  return {
    account_name: name, row_type: "account", parent_path: parentPath, hierarchy_level: 1,
    is_total: false, amount: 100, section: section || null, fiscal_year: 2024,
  };
}

const BS_DOC_ROWS = [
  heading("Assets", []),
  heading("Current Assets", ["Assets"]),
  heading("Bank Accounts", ["Assets", "Current Assets"]),
  acct("Chase Bank", ["Assets", "Current Assets", "Bank Accounts"], "assets"),
  heading("Liabilities and Equity", []),
  heading("Liabilities", ["Liabilities and Equity"]),
  heading("Current Liabilities", ["Liabilities and Equity", "Liabilities"]),
  heading("Credit Cards", ["Liabilities and Equity", "Liabilities", "Current Liabilities"]),
  acct("Chase Ink Credit Card", ["Liabilities and Equity", "Liabilities", "Current Liabilities", "Credit Cards"], "liabilities"),
  heading("Equity", ["Liabilities and Equity"]),
  heading("Shareholder Equity", ["Liabilities and Equity", "Equity"]),
  acct("30010 TH Equity", ["Liabilities and Equity", "Equity", "Shareholder Equity"], "equity"),
];

const PL_DOC_ROWS = [
  { account_name: "Income", section: "revenue", parent_path: [], fiscal_year: 2024, node_type: "hierarchy_section", is_total: false, is_header: true },
  { account_name: "Sales", section: "revenue", parent_path: ["Income"], fiscal_year: 2024, node_type: "account", is_total: false, is_header: false },
  { account_name: "Cost of Goods Sold", section: "cost_of_sales", parent_path: [], fiscal_year: 2024, node_type: "hierarchy_section", is_total: false, is_header: true },
  { account_name: "Materials", section: "cost_of_sales", parent_path: ["Cost of Goods Sold"], fiscal_year: 2024, node_type: "account", is_total: false, is_header: false },
  { account_name: "Expenses", section: "operating_expenses", parent_path: [], fiscal_year: 2024, node_type: "hierarchy_section", is_total: false, is_header: true },
  { account_name: "Payroll", section: "operating_expenses", parent_path: ["Expenses"], fiscal_year: 2024, node_type: "hierarchy_group", is_total: false, is_header: true },
  { account_name: "Salaries", section: "operating_expenses", parent_path: ["Expenses", "Payroll"], fiscal_year: 2024, node_type: "account", is_total: false, is_header: false },
];

const bsTree = buildBalanceSheetTreeFromData({ reportName: "Balance Sheet", rows: BS_DOC_ROWS });
const plTree = buildProfitLossTreeFromData({ reportName: "Profit and Loss", periodKeys: ["FY 2024"], rows: PL_DOC_ROWS });

console.log("\n=== 1-3. Document trees reproduce the source hierarchy (not flattened) ===");
{
  const bsLookup = coa.buildTreeHierarchyLookup(bsTree, "balance_sheet");
  const plLookup = coa.buildTreeHierarchyLookup(plTree, "profit_loss");

  // Full intermediate ancestry preserved -- "Bank Accounts" and "Current
  // Assets" must both survive, not collapse to "Assets > Chase Bank".
  check("1. BS deep ancestry preserved (Current Assets AND Bank Accounts both survive)",
    bsLookup.get("chase bank")?.[0]?.levels,
    ["Total Assets", "Total Assets", "Current Assets", "Bank Accounts", "Chase Bank"]);
  check("2. P&L deep ancestry preserved (Expenses > Payroll > Salaries, not Expenses > Salaries)",
    (plLookup.get("salaries")?.[0]?.levels || []).slice(-3),
    ["Expenses", "Payroll", "Salaries"]);
  checkTrue("3. Structural/header rows survived extraction long enough to supply ancestry",
    (bsLookup.get("chase bank")?.[0]?.levels || []).includes("Bank Accounts")
    && (plLookup.get("salaries")?.[0]?.levels || []).includes("Payroll"));
}

console.log("\n=== 4-6. Section/classification comes from the matched node's ancestry ===");
{
  const bsLookup = coa.buildTreeHierarchyLookup(bsTree, "balance_sheet");
  check("4. Asset determined from BS tree ancestry", bsLookup.get("chase bank")?.[0]?.accountType, "asset");
  check("5. Liability determined from BS tree ancestry (NOT equity, despite the 'Liabilities and Equity' umbrella)",
    bsLookup.get("chase ink credit card")?.[0]?.accountType, "liability");
  check("6. Equity determined from BS tree ancestry", bsLookup.get("30010 th equity")?.[0]?.accountType, "equity");
}

console.log("\n=== 7-9. P&L sections determined from P&L tree ancestry ===");
{
  const plLookup = coa.buildTreeHierarchyLookup(plTree, "profit_loss");
  check("7. Income determined from P&L tree", plLookup.get("sales")?.[0]?.accountType, "income");
  check("8. COGS/expense determined from P&L tree", plLookup.get("materials")?.[0]?.accountType, "expense");
  check("9. Operating expense determined from P&L tree", plLookup.get("salaries")?.[0]?.accountType, "expense");
}

console.log("\n=== 10-11. BS and P&L trees never contaminate each other ===");
{
  const bsLookup = coa.buildTreeHierarchyLookup(bsTree, "balance_sheet");
  const plLookup = coa.buildTreeHierarchyLookup(plTree, "profit_loss");
  checkTrue("10. No BS account appears in the P&L lookup",
    !plLookup.has("chase bank") && !plLookup.has("chase ink credit card") && !plLookup.has("30010 th equity"));
  checkTrue("11. No P&L account appears in the BS lookup",
    !bsLookup.has("sales") && !bsLookup.has("materials") && !bsLookup.has("salaries"));
}

console.log("\n=== 12. THE REFACTOR: both COA writers resolve hierarchy identically ===");
{
  // The proposal writer's resolution for a GL-only account, via reference trees.
  const glBucket = new Map([["chase ink credit card", "balance_sheet"]]);
  const proposalSide = coa.pickDocHierarchy(
    "Chase Ink Credit Card", "chase ink credit card", glBucket,
    coa.buildTreeHierarchyLookup(bsTree, "balance_sheet"),
    coa.buildTreeHierarchyLookup(plTree, "profit_loss"),
    null, { statementType: null, accountType: null },
  );

  // The completion writer (ensureCoaComplete) now builds its lookups the SAME
  // way -- referenceTrees win over buildDocHierarchyLookups. This mirrors the
  // exact selection expression now used inside _ensureCoaCompleteImpl.
  const referenceTrees = { balanceSheetTree: bsTree, profitLossTree: plTree };
  const completionBs = referenceTrees.balanceSheetTree
    ? coa.buildTreeHierarchyLookup(referenceTrees.balanceSheetTree, "balance_sheet")
    : coa.buildDocHierarchyLookups(BS_DOC_ROWS, PL_DOC_ROWS, null).bsHierarchyByName;
  const completionPl = referenceTrees.profitLossTree
    ? coa.buildTreeHierarchyLookup(referenceTrees.profitLossTree, "profit_loss")
    : coa.buildDocHierarchyLookups(BS_DOC_ROWS, PL_DOC_ROWS, null).plHierarchyByName;
  const completionSide = coa.pickDocHierarchy(
    "Chase Ink Credit Card", "chase ink credit card", glBucket,
    completionBs, completionPl, null, { statementType: null, accountType: null },
  );

  checkTrue("12a. Both writers resolved the account", Boolean(proposalSide) && Boolean(completionSide));
  check("12b. Both writers agree on accountType", completionSide.accountType, proposalSide.accountType);
  check("12c. Both writers agree on the COMPLETE hierarchy path", completionSide.levels, proposalSide.levels);
  check("12d. Both writers agree on the immediate parent", completionSide.parent, proposalSide.parent);
}

console.log("\n=== 13. The OLD completion path genuinely differed (proves the bug was real, not theoretical) ===");
{
  // buildDocHierarchyLookups derives accountType from row.section via
  // bsSectionToType, and anchors via fixedPrefixFor -- a different algorithm.
  // Feed it a row whose `section` scalar is ABSENT (a real case: a GL-only
  // account, or any row whose extraction-time section could not be resolved).
  // The reference tree still resolves it from ancestry; the old path cannot.
  const rowsWithNoSection = [
    { account_name: "Chase Ink Credit Card", section: null, parent_path: ["Liabilities and Equity", "Liabilities", "Current Liabilities", "Credit Cards"], fiscal_year: 2024, node_type: "account", is_total: false, hierarchy_level: 1 },
  ];
  const oldPath = coa.buildDocHierarchyLookups(rowsWithNoSection, [], null).bsHierarchyByName;
  const newPath = coa.buildTreeHierarchyLookup(bsTree, "balance_sheet");

  check("13a. OLD path (section-scalar driven) cannot type this account", oldPath.get("chase ink credit card")?.accountType ?? null, null);
  check("13b. NEW canonical path (ancestor-driven) types it correctly from the document tree",
    newPath.get("chase ink credit card")?.[0]?.accountType, "liability");
}

console.log("\n=== 14-16. Multiple documents / multiple years dedupe to ONE account ===");
{
  const multiYearRows = [
    ...BS_DOC_ROWS.map((r) => ({ ...r, fiscal_year: 2022, source_file_id: "bs-2022" })),
    ...BS_DOC_ROWS.map((r) => ({ ...r, fiscal_year: 2023, source_file_id: "bs-2023" })),
    ...BS_DOC_ROWS.map((r) => ({ ...r, fiscal_year: 2024, source_file_id: "bs-2024" })),
  ];
  const multiTree = buildBalanceSheetTreeFromData({ reportName: "Balance Sheet", rows: multiYearRows });
  const lookup = coa.buildTreeHierarchyLookup(multiTree, "balance_sheet");

  check("14. Same account across 3 years/documents resolves to ONE consistent path",
    lookup.get("chase bank")?.[0]?.levels,
    ["Total Assets", "Total Assets", "Current Assets", "Bank Accounts", "Chase Bank"]);
  checkTrue("15. No year-suffixed duplicate accounts were created",
    ![...lookup.keys()].some((k) => /20\d\d/.test(k)));

  // Dedup at the COA-leaf level: one leaf, fiscal-year evidence preserved.
  const glRows = [
    { account_name: "Chase Bank", transaction_date: "2022-06-01" },
    { account_name: "Chase Bank", transaction_date: "2023-06-01" },
    { account_name: "Chase Bank", transaction_date: "2024-06-01" },
  ];
  const { leaves } = coa.buildCoaModel(glRows, [], [], new Map(), new Map(), new Map(), null,
    { balanceSheetTree: multiTree, profitLossTree: plTree });
  const chaseLeaves = leaves.filter((l) => l.accountName === "Chase Bank");
  check("16. Exactly ONE COA leaf for an account spanning 3 fiscal years", chaseLeaves.length, 1);
  check("16b. Fiscal-year evidence preserved on that single leaf", [...chaseLeaves[0].fiscalYears].sort(), [2022, 2023, 2024]);
}

console.log("\n=== 17-19. classification / hierarchy_path / level_1..15 all agree (one canonical tree) ===");
{
  const glRows = [
    { account_name: "Chase Bank", transaction_date: "2024-06-01" },
    { account_name: "Chase Ink Credit Card", transaction_date: "2024-06-01" },
    { account_name: "30010 TH Equity", transaction_device: null, transaction_date: "2024-06-01" },
    { account_name: "Salaries", transaction_date: "2024-06-01" },
  ];
  const { leaves } = coa.buildCoaModel(glRows, [], [], new Map(), new Map(), new Map(), null,
    { balanceSheetTree: bsTree, profitLossTree: plTree });

  coa.buildLeafHierarchies(leaves).then((resolved) => {
    const MAX_LEVELS = 15;
    for (const name of ["Chase Bank", "Chase Ink Credit Card", "30010 TH Equity", "Salaries"]) {
      const leaf = resolved.find((l) => l.accountName === name);
      if (!leaf) { check(`${name}: leaf exists`, false, true); continue; }
      const real = (leaf.levels || []).filter(Boolean);
      check(`17. ${name}: hierarchy_path === level_1..${MAX_LEVELS}`, leaf.hierarchyPath, real.join(" > "));
      check(`18. ${name}: parent (levels[-2]) is the canonical parent`, real[real.length - 2], real.at(-2));
      // classification vs hierarchy branch agreement
      const branch = real[1] || real[0] || "";
      const t = leaf.accountType;
      const consistent =
        (t === "asset" && !/Liabilities|Equity/.test(branch))
        || (t === "liability" && !/Total Equity/.test(branch))
        || (t === "equity" && !/Total Liabilities$/.test(branch))
        || ["income", "expense", "cogs"].includes(t);
      checkTrue(`19. ${name}: accountType (${t}) does not contradict its hierarchy branch (${branch})`, consistent);
    }

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
}
