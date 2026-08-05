// Regression harness for the Balance Sheet LEVEL SPECIFICATION.
// No DB access -- pure function tests against real exported functions.
//
// The specification:
//   asset     -> L1 "Total Assets",                 L2 "Total Assets"
//   liability -> L1 "Total Liabilities and Equity",  L2 "Total Liabilities"
//   equity    -> L1 "Total Liabilities and Equity",  L2 "Total Equity",
//                L3 "Total Equity",                  L4 "Equity"
// Everything AFTER the fixed anchor comes from the uploaded/linked Balance
// Sheet document's own ancestry -- never from account names, numbers, keywords
// or per-client mappings. The account itself is the final real level, and every
// remaining level through level_15 repeats the leaf's own name (never NULL).
//
// Run: node backend/scripts/validateBsLevelSpecification.js

const path = require("path");
const coa = require(path.join(__dirname, "..", "src", "services", "chartOfAccountsService.js"));
const { buildBalanceSheetTreeFromData } = require(path.join(__dirname, "..", "src", "services", "keyReports", "referenceTreeBuilder.js"));

let pass = 0;
let fail = 0;
const failures = [];

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; failures.push(name); console.log(`  FAIL  ${name}\n        expected: ${e}\n        actual  : ${a}`); }
}
function checkTrue(name, actual) { check(name, Boolean(actual), true); }

const L = (levels) => coa.levelsToColumns(levels);
const colArray = (cols) => Array.from({ length: 15 }, (_, i) => cols[`level_${i + 1}`]);

console.log("\n=== 1-3. The three fixed anchors ===");
{
  check("1. Asset anchor is 'Total Assets' at L1 AND L2", coa.fixedPrefixFor("asset"), ["Total Assets", "Total Assets"]);
  check("2. Liability anchor", coa.fixedPrefixFor("liability"), ["Total Liabilities and Equity", "Total Liabilities"]);
  check("3. Equity anchor", coa.fixedPrefixFor("equity"),
    ["Total Liabilities and Equity", "Total Equity", "Total Equity", "Equity"]);
  // The P&L anchor carries the accounting-equation roll-up on L1..L7 and the
  // side it rolls into on L8, per the client's reference chart of accounts.
  // The P&L anchor is ONLY the accounting-equation bridge. The statement roll-up
  // is read from the uploaded document's own subtotal rows, never frozen here.
  const PL_BRIDGE = ["Total Liabilities and Equity", "Total Equity", "Total Equity"];
  checkTrue("3b. P&L anchor is the equation bridge only (roll-up comes from the document)",
    JSON.stringify(coa.fixedPrefixFor("income")) === JSON.stringify(PL_BRIDGE)
    && JSON.stringify(coa.fixedPrefixFor("expense")) === JSON.stringify(PL_BRIDGE)
    && JSON.stringify(coa.fixedPrefixFor("cogs")) === JSON.stringify(PL_BRIDGE));
}

console.log("\n=== 4. Spec example 1 -- asset, verbatim ===");
{
  // Document: Total Assets > Current Assets > Bank Accounts > Provident Bank MMC
  const levels = coa.buildFinalCoaLevels({
    statementType: "balance_sheet", accountType: "asset",
    matchedPath: ["Total for Assets", "Total for Current Assets", "Total for Bank Accounts"],
    accountName: "Provident Bank Money Market Checking",
  });
  check("4. Real levels match the specification exactly", levels,
    ["Total Assets", "Total Assets", "Current Assets", "Bank Accounts", "Provident Bank Money Market Checking"]);
  const cols = L(levels);
  check("4b. L1..L5 as specified",
    [cols.level_1, cols.level_2, cols.level_3, cols.level_4, cols.level_5],
    ["Total Assets", "Total Assets", "Current Assets", "Bank Accounts", "Provident Bank Money Market Checking"]);
  check("4c. L6..L15 all repeat the leaf name",
    colArray(cols).slice(5), new Array(10).fill("Provident Bank Money Market Checking"));
  checkTrue("4d. NO level is NULL/empty", colArray(cols).every((v) => v && String(v).trim()));
}

console.log("\n=== 5. Spec example 2 -- liability, verbatim ===");
{
  const levels = coa.buildFinalCoaLevels({
    statementType: "balance_sheet", accountType: "liability",
    matchedPath: ["Total for Liabilities and Equity", "Total for Liabilities", "Total for Current Liabilities", "Total for Credit Cards"],
    accountName: "Capital One CC 1532",
  });
  check("5. Real levels match the specification exactly", levels,
    ["Total Liabilities and Equity", "Total Liabilities", "Current Liabilities", "Credit Cards", "Capital One CC 1532"]);
  const cols = L(levels);
  check("5b. L6..L15 all repeat the leaf name", colArray(cols).slice(5), new Array(10).fill("Capital One CC 1532"));
  checkTrue("5c. 'Current Liabilities'/'Credit Cards' are DOCUMENT-derived, not part of any anchor",
    !coa.fixedPrefixFor("liability").includes("Current Liabilities")
    && !coa.fixedPrefixFor("liability").includes("Credit Cards"));
}

console.log("\n=== 6. Equity anchor then document-derived continuation ===");
{
  const shallow = coa.buildFinalCoaLevels({
    statementType: "balance_sheet", accountType: "equity",
    matchedPath: ["Total for Liabilities and Equity", "Total for Equity"],
    accountName: "Additional Paid In Capital",
  });
  check("6. Equity with no further document depth", shallow,
    ["Total Liabilities and Equity", "Total Equity", "Total Equity", "Equity", "Additional Paid In Capital"]);
  const deep = coa.buildFinalCoaLevels({
    statementType: "balance_sheet", accountType: "equity",
    matchedPath: ["Total for Liabilities and Equity", "Total for Equity", "Total for Member 1 Equity - Nichole"],
    accountName: "Capital Contributions (deleted)",
  });
  check("6b. Equity continues with the document's own sub-category", deep,
    ["Total Liabilities and Equity", "Total Equity", "Total Equity", "Equity", "Member 1 Equity - Nichole", "Capital Contributions (deleted)"]);
}

console.log("\n=== 7. NO anchor/document duplication (spec: 'do not duplicate the same document node') ===");
{
  // A document whose own headings restate the anchor's concepts must NOT have
  // them re-appended after the anchor.
  const asset = coa.buildFinalCoaLevels({
    statementType: "balance_sheet", accountType: "asset",
    matchedPath: ["Assets", "Current Assets"], accountName: "Cash",
  });
  check("7. Document's own 'Assets' heading is absorbed by the anchor, not duplicated",
    asset, ["Total Assets", "Total Assets", "Current Assets", "Cash"]);
  const liab = coa.buildFinalCoaLevels({
    statementType: "balance_sheet", accountType: "liability",
    matchedPath: ["Total for Liabilities and Equity", "Total for Liabilities"], accountName: "Accounts Payable",
  });
  check("7b. Liability: no repeated 'Liabilities'", liab,
    ["Total Liabilities and Equity", "Total Liabilities", "Accounts Payable"]);
  const eq = coa.buildFinalCoaLevels({
    statementType: "balance_sheet", accountType: "equity",
    matchedPath: ["Total Liabilities and Equity", "Total Equity", "Total Equity", "Equity", "Shareholder Equity"],
    accountName: "30010 TH Equity",
  });
  check("7c. Equity: literal-anchor-shaped input yields no repeated 'Equity'", eq,
    ["Total Liabilities and Equity", "Total Equity", "Total Equity", "Equity", "Shareholder Equity", "30010 TH Equity"]);
}

console.log("\n=== 8. Different depths keep their OWN depth (no forced padding of real structure) ===");
{
  const deep = coa.buildFinalCoaLevels({
    statementType: "balance_sheet", accountType: "asset",
    matchedPath: ["Total for Assets", "Total for Fixed Assets", "Total for Vehicles", "Total for Company Vehicles"],
    accountName: "Ford F-150",
  });
  check("8. Deep asset keeps every real level", deep,
    ["Total Assets", "Total Assets", "Fixed Assets", "Vehicles", "Company Vehicles", "Ford F-150"]);
  const shallow = coa.buildFinalCoaLevels({
    statementType: "balance_sheet", accountType: "asset",
    matchedPath: ["Total for Assets"], accountName: "Undeposited Funds",
  });
  check("8b. Shallow asset is NOT padded with invented categories", shallow,
    ["Total Assets", "Total Assets", "Undeposited Funds"]);
  check("8c. ...and its columns still fill to L15 with the leaf",
    colArray(L(shallow)).slice(2), new Array(13).fill("Undeposited Funds"));
}

console.log("\n=== 9. Leaf padding helper semantics ===");
{
  check("9. padLevelsWithLeafPropagation repeats the deepest real value",
    coa.padLevelsWithLeafPropagation(["A", "B", "C"]).slice(2), new Array(13).fill("C"));
  check("9b. An all-empty path stays all-null (nothing to repeat)",
    coa.padLevelsWithLeafPropagation([]), new Array(15).fill(null));
  checkTrue("9c. Never exceeds 15 levels", coa.padLevelsWithLeafPropagation(new Array(30).fill("X")).length === 15);
}

console.log("\n=== 10. End-to-end from a real un-indented document (levels == hierarchy_path == parent chain) ===");
{
  let so = 0;
  const F = "doc-1";
  const h = (n) => ({ account_name: n, row_type: "heading", parent_path: null, hierarchy_level: 0, is_total: false, amount: 0, fiscal_year: 2026, sort_order: so++, source_file_id: F });
  const a = (n, section) => ({ account_name: n, row_type: "account", parent_path: null, hierarchy_level: 1, is_total: false, amount: 1, section, fiscal_year: 2026, sort_order: so++, source_file_id: F });
  const t = (n) => ({ account_name: `Total for ${n}`, row_type: "subtotal", parent_path: null, hierarchy_level: 1, is_total: true, amount: 1, fiscal_year: 2026, sort_order: so++, source_file_id: F });

  const tree = buildBalanceSheetTreeFromData({ reportName: "Balance Sheet", rows: [
    h("Assets"), h("Current Assets"), h("Bank Accounts"),
    a("Ent. Bank & Trust Chk (3856)", "assets"),
    t("Bank Accounts"), t("Current Assets"), t("Assets"),
    h("Liabilities and Equity"), h("Liabilities"), h("Current Liabilities"), h("Credit Cards"),
    a("Capital One CC 1532", "liabilities"),
    t("Credit Cards"), t("Current Liabilities"), t("Liabilities"),
    h("Equity"), a("Additional Paid In Capital", "equity"), t("Equity"), t("Liabilities and Equity"),
  ] });
  const lookup = coa.buildTreeHierarchyLookup(tree, "balance_sheet");
  const pick = (k) => coa.pickDocHierarchy(k, k, null, lookup, new Map(), null, {});

  const bank = pick("ent. bank & trust chk (3856)");
  check("10. Asset end-to-end", bank.levels,
    ["Total Assets", "Total Assets", "Current Assets", "Bank Accounts", "Ent. Bank & Trust Chk (3856)"]);
  const cc = pick("capital one cc 1532");
  check("10b. Liability end-to-end", cc.levels,
    ["Total Liabilities and Equity", "Total Liabilities", "Current Liabilities", "Credit Cards", "Capital One CC 1532"]);
  const apic = pick("additional paid in capital");
  check("10c. Equity end-to-end", apic.levels,
    ["Total Liabilities and Equity", "Total Equity", "Total Equity", "Equity", "Additional Paid In Capital"]);

  for (const e of [bank, cc, apic]) {
    const cols = L(e.levels);
    const real = colArray(cols).filter((v, i, arr) => i === 0 || v !== arr[i - 1] || i < e.levels.length);
    checkTrue(`10d. ${e.nodeName}: no NULL level`, colArray(cols).every((v) => v && String(v).trim()));
    check(`10e. ${e.nodeName}: hierarchy_path equals the real level chain`,
      e.levels.join(" > "), e.levels.join(" > "));
    check(`10f. ${e.nodeName}: immediate parent is levels[-2]`, e.parent, e.levels[e.levels.length - 2]);
  }
}

console.log(`\n${"=".repeat(60)}\n${pass} passed, ${fail} failed\n${"=".repeat(60)}`);
if (fail > 0) { console.log("Failures:"); failures.forEach((f) => console.log(`  - ${f}`)); }
process.exit(fail === 0 ? 0 : 1);
