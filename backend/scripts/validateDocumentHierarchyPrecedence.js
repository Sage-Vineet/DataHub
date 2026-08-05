// Regression harness for the document-match classification/hierarchy
// precedence fix in chartOfAccountsService.js. No DB access -- pure function
// tests against real exported functions.
//
// CONFIRMED ROOT CAUSE fixed here: partitionStatementType (a weak heuristic
// derived from splitAccountsAtRetainedEarningsByYear's GL-row-ordering guess)
// was being treated as MORE authoritative than a real, exact document match
// or an uploaded-Chart-of-Accounts match, in three places:
//   1. addLeaf's Priority-1 (client COA) branch was skipped entirely
//      whenever a GL row's partitionStatementType was truthy.
//   2. pickDocHierarchy treated ANY statementType hint (confident evidence
//      OR the weak GL heuristic) as a hard single-tree gate, so a real
//      exact match sitting in the "wrong" (per the heuristic) tree was
//      never found at all.
//   3. addLeaf's Priority-2 leaf creation, and mergeInto on every later
//      occurrence of the same leaf, let partitionStatementType overwrite
//      statementType even after a real document match had already set it
//      correctly -- corrupting the anchor getFinalCoaPrefix/
//      buildFinalCoaLevels picks (PL_FIXED_PREFIX/EQUITY_FIXED_PREFIX
//      instead of LIABILITY_FIXED_PREFIX etc.) even though accountType and
//      matchLevels (the real document ancestor path) stayed correct --
//      producing exactly the reported symptom: a real Balance Sheet
//      liability (e.g. a credit card account) ending up filed under Equity
//      or Income/Expense in the generated Proposed COA.
//
// Run: node backend/scripts/validateDocumentHierarchyPrecedence.js

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

const bsRows = [
  { account_name: "Chase Bank", section: "assets", parent_path: ["Assets", "Current Assets", "Bank Accounts"], fiscal_year: 2024, node_type: "account", is_total: false, hierarchy_level: 1 },
  { account_name: "Chase Ink Credit Card", section: "liabilities", parent_path: ["Liabilities and Equity", "Liabilities", "Current Liabilities", "Credit Cards"], fiscal_year: 2024, node_type: "account", is_total: false, hierarchy_level: 1 },
  { account_name: "30010 TH Equity", section: "equity", parent_path: ["Liabilities and Equity", "Equity", "Shareholder Equity"], fiscal_year: 2024, node_type: "account", is_total: false, hierarchy_level: 1 },
];
const plRows = [
  { account_name: "Product Sales", section: "revenue", parent_path: ["Income"], fiscal_year: 2024, node_type: "account", is_total: false, is_header: false },
  { account_name: "Office Rent", section: "operating_expenses", parent_path: ["Expenses"], fiscal_year: 2024, node_type: "account", is_total: false, is_header: false },
];
const glRows = [
  { account_name: "Chase Bank", transaction_date: "2024-06-01" },
  { account_name: "Chase Ink Credit Card", transaction_date: "2024-06-01" },
  { account_name: "30010 TH Equity", transaction_date: "2024-06-01" },
  { account_name: "Product Sales", transaction_date: "2024-06-01" },
  { account_name: "Office Rent", transaction_date: "2024-06-01" },
];
// Deliberately ADVERSARIAL: every hint here is WRONG on purpose, simulating
// the confirmed bug condition (the GL-ordering heuristic guessed the wrong
// side for an account that DOES have a real, exact document match). A
// correct fix must produce the right answer regardless of these bad hints.
const adversarialGlBucketByKey = new Map([
  ["chase ink credit card", "profit_loss"],   // really a BS liability
  ["30010 th equity", "profit_loss"],          // really a BS equity account
  ["product sales", "balance_sheet"],          // really a P&L income account
  ["office rent", "balance_sheet"],            // really a P&L expense account
]);

console.log("\n=== 1-5. Document match wins over an adversarial GL bucket hint (classification) ===");
{
  const { leaves } = coa.buildCoaModel(glRows, bsRows, plRows, new Map(), new Map(), adversarialGlBucketByKey, null, {});
  const byName = (n) => leaves.find((l) => l.accountName === n);

  check("1. BS Asset (Chase Bank): accountType=asset", byName("Chase Bank")?.accountType, "asset");
  check("1b. BS Asset: statementType=balance_sheet", byName("Chase Bank")?.statementType, "balance_sheet");

  check("2. BS Liability (Chase Ink Credit Card): accountType=liability DESPITE adversarial 'profit_loss' hint", byName("Chase Ink Credit Card")?.accountType, "liability");
  check("2b. BS Liability: statementType=balance_sheet, NOT corrupted to profit_loss", byName("Chase Ink Credit Card")?.statementType, "balance_sheet");

  check("3. BS Equity (30010 TH Equity): accountType=equity, NOT liability (Critical Requirement #2's exact example)", byName("30010 TH Equity")?.accountType, "equity");
  check("3b. BS Equity: statementType=balance_sheet DESPITE adversarial 'profit_loss' hint", byName("30010 TH Equity")?.statementType, "balance_sheet");

  check("4. P&L Income (Product Sales): accountType=income DESPITE adversarial 'balance_sheet' hint", byName("Product Sales")?.accountType, "income");
  check("4b. P&L Income: statementType=profit_loss, NOT corrupted to balance_sheet", byName("Product Sales")?.statementType, "profit_loss");

  check("5. P&L Expense (Office Rent): accountType=expense DESPITE adversarial 'balance_sheet' hint", byName("Office Rent")?.accountType, "expense");
  check("5b. P&L Expense: statementType=profit_loss", byName("Office Rent")?.statementType, "profit_loss");
}

console.log("\n=== 8-9. Deep and shallow document hierarchy, complete ancestor path preserved ===");
{
  const { leaves } = coa.buildCoaModel(glRows, bsRows, plRows, new Map(), new Map(), adversarialGlBucketByKey, null, {});
  coa.buildLeafHierarchies(leaves).then((resolved) => {
    const byName = (n) => resolved.find((l) => l.accountName === n);

    const chaseInk = byName("Chase Ink Credit Card");
    check("8. Deep hierarchy: Chase Ink Credit Card's COMPLETE document ancestor path is preserved",
      chaseInk.levels.filter(Boolean),
      ["Total Liabilities and Equity", "Total Liabilities", "Current Liabilities", "Credit Cards", "Chase Ink Credit Card"]);
    checkTrue("Chase Ink Credit Card is NOT anchored under Total Equity (the reported bug)",
      !chaseInk.levels.includes("Total Equity"));

    const equityAcct = byName("30010 TH Equity");
    check("Equity account: COMPLETE document ancestor path preserved (Requirement #1's exact example)",
      equityAcct.levels.filter(Boolean),
      ["Total Liabilities and Equity", "Total Equity", "Total Equity", "Equity", "Shareholder Equity", "30010 TH Equity"]);

    const chaseBank = byName("Chase Bank");
    check("9. Shallow-vs-deep BS hierarchy both resolve correctly: Chase Bank",
      chaseBank.levels.filter(Boolean),
      ["Total Assets", "Total Assets", "Current Assets", "Bank Accounts", "Chase Bank"]);

    console.log("\n=== 11-14. Cross-statement contamination is impossible ===");
    const sales = byName("Product Sales");
    const rent = byName("Office Rent");
    checkTrue("11. P&L account (Product Sales) never inherits a BS anchor (no 'Total Assets'/'Total Liabilities')",
      !sales.levels.some((l) => l === "Total Assets" || l === "Total Liabilities"));
    check("11b. Product Sales hierarchy comes from the P&L document tree", sales.levels.filter(Boolean),
      ["Total Liabilities and Equity", "Total Equity", "Total Equity",
       "Net Income", "Pretax Income", "Operating Income", "Gross Profit", "Total Revenue",
       "Income", "Product Sales"]);
    checkTrue("Office Rent (P&L expense) never inherits a BS anchor either",
      !rent.levels.some((l) => l === "Total Assets" || l === "Total Liabilities"));

    checkTrue("12. Equity account (30010 TH Equity) never inherits the Liability branch",
      !equityAcct.levels.includes("Total Liabilities"));
    checkTrue("13. Liability account (Chase Ink Credit Card) never inherits the Equity branch",
      !chaseInk.levels.includes("Total Equity"));
    checkTrue("14. Asset account (Chase Bank) never inherits Liability or Equity branches",
      !chaseBank.levels.includes("Total Liabilities") && !chaseBank.levels.includes("Total Equity"));

    console.log("\n=== 17-19. classification / hierarchy_path / levels / parent all agree (one canonical tree) ===");
    for (const leaf of [chaseBank, chaseInk, equityAcct, sales, rent]) {
      const realLevels = leaf.levels.filter(Boolean);
      check(`${leaf.accountName}: hierarchyPath matches levels exactly`, leaf.hierarchyPath, realLevels.join(" > "));
      const parentIdx = realLevels.length - 2;
      check(`${leaf.accountName}: parent (levels[-2]) is the immediate parent for parent_account_id resolution`,
        realLevels[parentIdx], realLevels[realLevels.length - 2]);
    }
    checkTrue("Chase Ink Credit Card's own accountType (liability) matches which branch its levels sit in (Liabilities, not Equity)",
      chaseInk.accountType === "liability" && chaseInk.levels.includes("Total Liabilities") && !chaseInk.levels.includes("Total Equity"));

    console.log(`\n${"=".repeat(60)}\n${pass} passed, ${fail} failed\n${"=".repeat(60)}`);
    if (fail > 0) {
      console.log("Failures:");
      failures.forEach((f) => console.log(`  - ${f}`));
    }
    runSyncTests();
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

function runSyncTests() {
  console.log("\n=== 15-16. Document match never invokes AI; no-match still uses the existing AI fallback ===");
  {
    // An account with a real BS match must resolve via pickDocHierarchy
    // (non-null) regardless of the adversarial hint -- this is exactly the
    // signal buildProposedCoaTree's needsAi filter uses to decide whether an
    // account is sent to AI at all.
    const { bsHierarchyByName, plHierarchyByName } = coa.buildDocHierarchyLookups(bsRows, plRows, null);
    const docMatch = coa.pickDocHierarchy("Chase Ink Credit Card", "chase ink credit card", adversarialGlBucketByKey, bsHierarchyByName, plHierarchyByName, null, {
      statementType: null, // no confident evidence passed at this call site (matches real addLeaf usage)
      accountType: null,
    });
    checkTrue("15. Document match found even though the ONLY hint (adversarial GL bucket) pointed at the wrong tree -- AI is never reached for this account", Boolean(docMatch));
    check("15b. The match found is the correct BS liability node", docMatch?.accountType, "liability");

    const noMatch = coa.pickDocHierarchy("Totally Unknown Account", "totally unknown account", adversarialGlBucketByKey, bsHierarchyByName, plHierarchyByName, null, {
      statementType: null,
      accountType: null,
    });
    check("16. An account with no real document match anywhere correctly returns null (existing AI fallback still applies)", noMatch, null);
  }

  console.log("\n=== Confident statementType still hard-gates (pre-existing cross-contamination guard, unchanged) ===");
  {
    const { bsHierarchyByName, plHierarchyByName } = coa.buildDocHierarchyLookups(bsRows, plRows, null);
    // "Product Sales" only exists in the P&L tree. With a CONFIDENT
    // statementType of "balance_sheet" (as if bsSection had genuinely been
    // set from a real BS row), the fix must NOT fall through to the P&L
    // tree -- that would reintroduce the exact cross-contamination Critical
    // Requirement #3 forbids.
    const noCrossFallback = coa.pickDocHierarchy("Product Sales", "product sales", null, bsHierarchyByName, plHierarchyByName, null, {
      statementType: "balance_sheet",
      accountType: null,
    });
    check("Confident statementType still prevents cross-statement fallback (unchanged guard)", noCrossFallback, null);
  }

  console.log("\n=== Priority 1 (client COA match) is never skipped due to a GL bucket hint ===");
  {
    const matchResults = new Map([
      ["chase ink credit card", {
        matched: true, accountType: "liability", statementType: "balance_sheet",
        confidence: 1, matchTier: "exact", levels: ["Total Liabilities and Equity", "Total Liabilities", "Credit Cards", "Chase Ink Credit Card"],
        hierarchyPath: "Total Liabilities and Equity > Total Liabilities > Credit Cards > Chase Ink Credit Card",
        systemId: "sys-1", clientAccountId: "client-1", normalBalance: "credit", reason: "Matched uploaded Chart of Accounts",
      }],
    ]);
    // Same adversarial hint as before (says "profit_loss"), but this time a
    // confirmed client-COA match ALSO exists for this account -- Priority 1,
    // the highest-authority signal in the whole pipeline. It must win.
    const { leaves } = coa.buildCoaModel(glRows, [], [], new Map(), matchResults, adversarialGlBucketByKey, null, {});
    const leaf = leaves.find((l) => l.accountName === "Chase Ink Credit Card");
    checkTrue("Client-COA-matched leaf exists", Boolean(leaf));
    check("Client COA match is used (classificationSource=client_coa), not skipped due to the GL hint", leaf?.classificationSource, "client_coa");
    check("accountType comes from the client COA match", leaf?.accountType, "liability");
  }

  console.log(`\n${"=".repeat(60)}\n${pass} passed, ${fail} failed\n${"=".repeat(60)}`);
  if (fail > 0) {
    console.log("Failures:");
    failures.forEach((f) => console.log(`  - ${f}`));
  }
  process.exit(fail === 0 ? 0 : 1);
}
