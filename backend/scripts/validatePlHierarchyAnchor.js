// Standalone regression harness for the document-driven P&L hierarchy refactor
// and the companion GROUP/ACCOUNT node-type validation fix. No DB access —
// pure function tests against real exported functions, fixtures only.
// Run: node backend/scripts/validatePlHierarchyAnchor.js

const path = require("path");
const coa = require(path.join(__dirname, "..", "src", "services", "chartOfAccountsService.js"));
const fin = require(path.join(__dirname, "..", "src", "services", "keyReports", "financialStatementService.js"));

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

function checkTrue(name, actual) {
  check(name, Boolean(actual), true);
}

// Anchor updated to match the current spec: Level 1 = Total Liabilities and
// Equity, Level 2 = Total Equity, Level 3 = Total Equity (repeated) — not
// "Net Income", which is no longer part of the fixed anchor at all.
const ANCHOR = ["Total Liabilities and Equity", "Total Equity", "Total Equity"];

// ── 1. Anchor shape + heading preservation ─────────────────────────────────
console.log("\n1. Anchor shape + document heading preservation");
{
  const plRows = [
    { account_name: "Sales", section: "revenue", parent_path: ["Income"], fiscal_year: 2024, node_type: "account", is_total: false, is_header: false },
    { account_name: "Materials", section: "cost_of_sales", parent_path: ["Cost of Goods Sold"], fiscal_year: 2024, node_type: "account", is_total: false, is_header: false },
    { account_name: "Rent", section: "operating_expenses", parent_path: ["Operating Expenses", "Facilities"], fiscal_year: 2024, node_type: "account", is_total: false, is_header: false },
  ];
  const { plHierarchyByName } = coa.buildDocHierarchyLookups([], plRows, null);

  check("Income > Sales preserved", plHierarchyByName.get("sales")?.levels, [...ANCHOR, "Income", "Sales"]);
  check("Cost of Goods Sold > Materials preserved", plHierarchyByName.get("materials")?.levels, [...ANCHOR, "Cost of Goods Sold", "Materials"]);
  check("Operating Expenses > Facilities > Rent preserved (2 real doc levels)", plHierarchyByName.get("rent")?.levels, [...ANCHOR, "Operating Expenses", "Facilities", "Rent"]);

  const salesPath = plHierarchyByName.get("sales").levels;
  const materialsPath = plHierarchyByName.get("materials").levels;
  checkTrue("income and cogs share first 3 anchor levels", salesPath.slice(0, 3).join("|") === materialsPath.slice(0, 3).join("|"));
  checkTrue("income and cogs diverge at index 3", salesPath[3] !== materialsPath[3]);
}

// ── 2. Anchor-label trimming still works ───────────────────────────────────
console.log("\n2. Redundant leading anchor label trimmed (not duplicated)");
{
  const plRows = [
    { account_name: "Sales", section: "revenue", parent_path: ["Total Equity", "Income"], fiscal_year: 2024, node_type: "account", is_total: false, is_header: false },
  ];
  const { plHierarchyByName } = coa.buildDocHierarchyLookups([], plRows, null);
  check("leading 'Total Equity' stripped, not duplicated", plHierarchyByName.get("sales")?.levels, [...ANCHOR, "Income", "Sales"]);
}

// ── 3. appendLeaf self-duplicate still stripped ────────────────────────────
console.log("\n3. Trailing self-duplicate stripped");
{
  const plRows = [
    { account_name: "Sales", section: "revenue", parent_path: ["Income", "Sales"], fiscal_year: 2024, node_type: "account", is_total: false, is_header: false },
  ];
  const { plHierarchyByName } = coa.buildDocHierarchyLookups([], plRows, null);
  check("no doubled trailing 'Sales'", plHierarchyByName.get("sales")?.levels, [...ANCHOR, "Income", "Sales"]);
}

// ── 4. Multi-document P&L deterministic tie-break ──────────────────────────
console.log("\n4. Multi-document P&L merge (depth -> frequency -> recency)");
{
  // Depth: flat vs nested for the same account -> deeper wins.
  let plRows = [
    { account_name: "Consulting", section: "revenue", parent_path: ["Income"], fiscal_year: 2023, node_type: "account", is_total: false, is_header: false },
    { account_name: "Consulting", section: "revenue", parent_path: ["Income", "Product Revenue"], fiscal_year: 2023, node_type: "account", is_total: false, is_header: false },
  ];
  let result = coa.buildDocHierarchyLookups([], plRows, null);
  check("deeper path wins on depth", result.plHierarchyByName.get("consulting")?.levels, [...ANCHOR, "Income", "Product Revenue", "Consulting"]);
  check("depth tier tallied", result.plResolvedByDepthCount, 1);

  // Frequency: two equal-depth candidates, one repeated -> frequency wins.
  plRows = [
    { account_name: "Interest", section: "revenue", parent_path: ["Other Income"], fiscal_year: 2023, node_type: "account", is_total: false, is_header: false },
    { account_name: "Interest", section: "revenue", parent_path: ["Other Income"], fiscal_year: 2023, node_type: "account", is_total: false, is_header: false },
    { account_name: "Interest", section: "revenue", parent_path: ["Income"], fiscal_year: 2023, node_type: "account", is_total: false, is_header: false },
  ];
  result = coa.buildDocHierarchyLookups([], plRows, null);
  check("more-frequent path wins", result.plHierarchyByName.get("interest")?.levels, [...ANCHOR, "Other Income", "Interest"]);
  check("frequency tier tallied", result.plResolvedByFrequencyCount, 1);
  check("merged-nodes count reflects the repeated occurrence", result.plMergedNodesCount, 1);

  // Recency: equal depth, equal frequency, different fiscal year -> newest wins.
  plRows = [
    { account_name: "Royalties", section: "revenue", parent_path: ["Other Income"], fiscal_year: 2022, node_type: "account", is_total: false, is_header: false },
    { account_name: "Royalties", section: "revenue", parent_path: ["Income"], fiscal_year: 2024, node_type: "account", is_total: false, is_header: false },
  ];
  result = coa.buildDocHierarchyLookups([], plRows, null);
  check("newest fiscal year wins", result.plHierarchyByName.get("royalties")?.levels, [...ANCHOR, "Income", "Royalties"]);
  check("recency tier tallied", result.plResolvedByRecencyCount, 1);
}

// ── 5. BS regression guard — behaviour-preserving refactor ─────────────────
console.log("\n5. Balance Sheet side unaffected by the shared-helper refactor");
{
  const bsRows = [
    { account_name: "Checking", section: "assets", parent_path: ["Current Assets", "Bank Accounts"], fiscal_year: 2024, hierarchy_level: 2, is_total: false },
    { account_name: "Checking", section: "assets", parent_path: ["Current Assets", "Bank Accounts"], fiscal_year: 2025, hierarchy_level: 2, is_total: false },
  ];
  const { bsHierarchyByName, mergedNodesCount, conflictingPathsCount } = coa.buildDocHierarchyLookups(bsRows, [], 2025);
  check("BS path resolved as expected", bsHierarchyByName.get("checking")?.levels, ["Total Assets", "Total Assets", "Current Assets", "Bank Accounts", "Checking"]);
  check("BS merged nodes counted", mergedNodesCount, 1);
  check("BS conflicting paths (same path, still 1 candidate) is 0", conflictingPathsCount, 0);
}

// ── 6. AI-hierarchy pass prepends the (now 3-level) anchor ─────────────────
console.log("\n6. buildLeafHierarchies AI pass prepends PL_FIXED_PREFIX");
{
  (async () => {
    // buildLeafHierarchies no longer has an AI-hierarchy-generation pass at
    // all (removed since this was written) -- an account with NO document
    // match (client-COA or document-position) now correctly stays
    // needsMapping/unresolved rather than getting an AI-guessed hierarchy.
    // "AI must not generate hierarchy" is now enforced structurally, not just
    // by convention.
    const leaves = [{
      accountName: "Electric",
      accountNumber: null,
      accountType: "expense",
      classificationMethod: null,
      matchLevels: null,
      aiLevels: ["Operating Expenses", "Utilities"],
      aiNormalizedName: null,
    }];
    const resolved = await coa.buildLeafHierarchies(leaves, new Map());
    checkTrue("no document/client-COA match -> needsMapping (no AI-guessed hierarchy)", resolved[0].needsMapping === true);
    checkTrue("no document/client-COA match -> levels all null", (resolved[0].levels || []).every((v) => !v));

    // ── 7. validateCoaNodeTree: group/account label collision is VALID ──
    console.log("\n7. Type-aware collision fix: a GROUP and an ACCOUNT sharing a label/path");
    // Under the current anchor (Total Liabilities and Equity > Total Equity >
    // Total Equity), a P&L leaf like Rent synthesizes ancestor GROUP nodes at
    // each prefix, including one literally named "Total Equity" (the anchor's
    // own repeated 3rd level). A real equity ACCOUNT also named "Total Equity"
    // sitting at that exact same path is exactly the class of collision the
    // type-aware fix must allow (different node types, same label/path).
    const hierarchical = [
      { accountName: "Rent", levels: [...ANCHOR, "Operating Expenses", "Rent"] },
      { accountName: "Total Equity", levels: ["Total Liabilities and Equity", "Total Equity", "Total Equity"] },
    ];
    const tree = coa.buildCoaNodeTree(hierarchical);
    const result = coa.validateCoaNodeTree(tree, hierarchical);
    checkTrue("leafUsedAsParentCount === 0 (no false positive)", result.leafUsedAsParentCount === 0);
    checkTrue("hierarchyValid === true", result.hierarchyValid === true);
    check("groupAccountLabelCollisions === 1 (the Total Equity pair)", result.groupAccountLabelCollisions, 1);

    // ── 8. financialStatementService: section labels via groupLabelFor reuse ──
    console.log("\n8. P&L section header labels derived from real parent, not level_6/level_7");
    const nodes = [
      { id: "grp-income", account_name: "Income", metadata: { is_group: true }, parent_account_id: null },
      { id: "grp-cogs", account_name: "Cost of Goods Sold", metadata: { is_group: true }, parent_account_id: null },
      { id: "grp-opex", account_name: "Operating Expenses", metadata: { is_group: true }, parent_account_id: null },
      { id: "grp-anchor", account_name: "Total Equity", metadata: { is_group: true }, parent_account_id: null },
      {
        id: "sales", account_name: "Sales", account_type: "income", parent_account_id: "grp-income",
        metadata: {}, level_1: "Total Liabilities and Equity", level_2: "Total Equity", level_3: "Total Equity", level_4: "Income", level_5: "Sales", level_6: "Sales", level_7: "Sales",
        hierarchy_path: "Total Liabilities and Equity > Total Equity > Total Equity > Income > Sales",
      },
      {
        id: "materials", account_name: "Materials", account_type: "cogs", parent_account_id: "grp-cogs",
        metadata: {}, level_1: "Total Liabilities and Equity", level_2: "Total Equity", level_3: "Total Equity", level_4: "Cost of Goods Sold", level_5: "Materials", level_6: "Materials", level_7: "Materials",
        hierarchy_path: "Total Liabilities and Equity > Total Equity > Total Equity > Cost of Goods Sold > Materials",
      },
      {
        id: "rent", account_name: "Rent", account_type: "expense", parent_account_id: "grp-opex",
        metadata: {}, level_1: "Total Liabilities and Equity", level_2: "Total Equity", level_3: "Total Equity", level_4: "Operating Expenses", level_5: "Rent", level_6: "Rent", level_7: "Rent",
        hierarchy_path: "Total Liabilities and Equity > Total Equity > Total Equity > Operating Expenses > Rent",
      },
      // Flat account with literally no document heading -- direct parent IS the anchor.
      {
        id: "flatexp", account_name: "Misc Expense", account_type: "expense", parent_account_id: "grp-anchor",
        metadata: {}, level_1: "Total Liabilities and Equity", level_2: "Total Equity", level_3: "Total Equity", level_4: "Misc Expense", level_5: "Misc Expense",
        hierarchy_path: "Total Liabilities and Equity > Total Equity > Total Equity > Misc Expense",
      },
    ];
    const { byId, leaves: plLeaves } = fin.buildTree(nodes);
    for (const n of plLeaves) { n.signedAmount = 100; n.displayAmount = 100; }
    const stmt = fin.buildPlStatement(plLeaves, byId);
    check("revenue.label from real 'Income' parent", stmt.revenue.label, "Income");
    check("costOfSales.label from real 'Cost of Goods Sold' parent", stmt.costOfSales.label, "Cost of Goods Sold");
    // operatingExpenses.label is majority-vote across expense leaves ("Operating Expenses" x1, "Other"-excluded flat leaf).
    check("operatingExpenses.label majority is 'Operating Expenses'", stmt.operatingExpenses.label, "Operating Expenses");
    // A leaf with zero real document heading (direct parent IS the bare anchor)
    // must never be mislabeled with the anchor's own label "Total Equity" — it
    // may legitimately fall back to its own account name (pre-existing
    // groupLabelFor ancestry-scan behavior, unrelated to this refactor) but
    // never the anchor label itself.
    checkTrue(
      "flat expense leaf's group label is never the anchor label 'Total Equity'",
      fin.groupLabelFor(nodes.find((n) => n.id === "flatexp"), byId) !== "Total Equity",
    );

    // ── 9. Equity fixed anchor is 4 levels, real sub-heading survives ──────
    console.log("\n9. Equity anchor (4 levels) + document sub-heading preserved");
    const EQUITY_ANCHOR = ["Total Liabilities and Equity", "Total Equity", "Total Equity", "Equity"];
    check("fixedPrefixFor('equity') is the 4-level anchor", coa.fixedPrefixFor("equity"), EQUITY_ANCHOR);
    {
      // Worked example from spec: "Equity > Owner's Equity > Capital,
      // Distributions" -- the document's own leading "Equity" heading
      // restates the anchor's own last label and must be trimmed; "Owner's
      // Equity" is real, distinct structure and must survive as Level 5.
      const bsRows = [
        { account_name: "Capital", section: "equity", parent_path: ["Equity", "Owner's Equity"], fiscal_year: 2024, hierarchy_level: 2, is_total: false },
        { account_name: "Distributions", section: "equity", parent_path: ["Equity", "Owner's Equity"], fiscal_year: 2024, hierarchy_level: 2, is_total: false },
      ];
      const { bsHierarchyByName } = coa.buildDocHierarchyLookups(bsRows, [], null);
      check("Capital: Equity heading trimmed, Owner's Equity survives", bsHierarchyByName.get("capital")?.levels, [...EQUITY_ANCHOR, "Owner's Equity", "Capital"]);
      check("Distributions: same real sub-heading preserved", bsHierarchyByName.get("distributions")?.levels, [...EQUITY_ANCHOR, "Owner's Equity", "Distributions"]);
    }
    {
      // A document heading that is NOT a restatement of the anchor's own
      // wording (e.g. "Stockholders' Equity" for a corporation) must survive
      // exactly as-is -- never conflated with the generic "Equity" strip.
      const bsRows = [
        { account_name: "Common Stock", section: "equity", parent_path: ["Stockholders' Equity"], fiscal_year: 2024, hierarchy_level: 1, is_total: false },
      ];
      const { bsHierarchyByName } = coa.buildDocHierarchyLookups(bsRows, [], null);
      check("Stockholders' Equity heading is real structure, not stripped", bsHierarchyByName.get("common stock")?.levels, [...EQUITY_ANCHOR, "Stockholders' Equity", "Common Stock"]);
    }

    // ── 10. Financial statement sections expose a real hierarchy tree ──────
    console.log("\n10. buildBsStatement/buildPlStatement: equity + P&L sections are trees, not flat lists");
    {
      const bsNodes = [
        { id: "eq-anchor", account_name: "Equity", metadata: { is_group: true }, parent_account_id: null },
        { id: "eq-owner", account_name: "Owner's Equity", metadata: { is_group: true }, parent_account_id: "eq-anchor" },
        {
          id: "capital", account_name: "Capital", account_type: "equity", parent_account_id: "eq-owner", metadata: {},
          level_1: "Total Liabilities and Equity", level_2: "Total Equity", level_3: "Total Equity", level_4: "Equity", level_5: "Owner's Equity", level_6: "Capital", level_7: "Capital",
          hierarchy_path: "Total Liabilities and Equity > Total Equity > Total Equity > Equity > Owner's Equity > Capital",
        },
        {
          id: "asset-cash", account_name: "Checking", account_type: "asset", parent_account_id: null, metadata: {},
          level_1: "Total Assets", level_2: "Total Assets", level_3: "Checking", level_4: "Checking",
          hierarchy_path: "Total Assets > Total Assets > Checking",
        },
        {
          id: "liab-ap", account_name: "AP", account_type: "liability", parent_account_id: null, metadata: {},
          level_1: "Total Liabilities and Equity", level_2: "Total Liabilities", level_3: "AP", level_4: "AP",
          hierarchy_path: "Total Liabilities and Equity > Total Liabilities > AP",
        },
      ];
      const { byId: bsById, leaves: bsLeaves } = fin.buildTree(bsNodes);
      for (const n of bsLeaves) { n.signedAmount = 100; n.displayAmount = 100; }
      const bsStmt = fin.buildBsStatement(bsLeaves, bsById);
      checkTrue("equity.hierarchy is present (not just flat accounts)", Array.isArray(bsStmt.equity.hierarchy));
      // Root -> "Total Liabilities and Equity" (collapsed dup) -> "Total Equity" -> "Equity" -> "Owner's Equity" -> Capital leaf + Total Owner's Equity row.
      const eqRoot = bsStmt.equity.hierarchy[0];
      check("equity root label", eqRoot?.name, "Total Liabilities and Equity");
      const eqL2 = eqRoot?.children?.find((c) => c.name === "Total Equity");
      const eqL3 = eqL2?.children?.find((c) => c.name === "Equity");
      const eqL4 = eqL3?.children?.find((c) => c.name === "Owner's Equity");
      checkTrue("Owner's Equity container reached at depth 4 below root", Boolean(eqL4));
      checkTrue("Capital leaf nested under Owner's Equity (not flattened)", (eqL4?.children || []).some((c) => c.name === "Capital"));

      const plNodes = [
        { id: "grp-income", account_name: "Income", metadata: { is_group: true }, parent_account_id: null },
        {
          id: "sales", account_name: "Sales", account_type: "income", parent_account_id: "grp-income", metadata: {},
          level_1: "Total Liabilities and Equity", level_2: "Total Equity", level_3: "Total Equity", level_4: "Income", level_5: "Sales", level_6: "Sales",
          hierarchy_path: "Total Liabilities and Equity > Total Equity > Total Equity > Income > Sales",
        },
      ];
      const { byId: plById, leaves: plLeaves2 } = fin.buildTree(plNodes);
      for (const n of plLeaves2) { n.signedAmount = 500; n.displayAmount = 500; }
      const plStmt = fin.buildPlStatement(plLeaves2, plById);
      checkTrue("revenue.hierarchy is present", Array.isArray(plStmt.revenue.hierarchy));
      // The shared anchor (2 real containers post-collapse: "Total Liabilities
      // and Equity" > "Total Equity") is stripped for P&L sections -- the
      // "Revenue" wrapper the frontend adds stands in for it -- so the
      // document's own real heading ("Income") is the FIRST container here.
      check("revenue.hierarchy root is the real document heading, anchor stripped", plStmt.revenue.hierarchy[0]?.name, "Income");
      checkTrue("Sales leaf nested under Income", (plStmt.revenue.hierarchy[0]?.children || []).some((c) => c.name === "Sales"));
    }

    console.log(`\n${"=".repeat(60)}\n${pass} passed, ${fail} failed\n${"=".repeat(60)}`);
    if (fail) { console.log("Failed checks:", failures.join(", ")); process.exit(1); }
    process.exit(0);
  })().catch((err) => {
    console.error("FATAL:", err);
    process.exit(1);
  });
}
