// Fresh COA generation regression harness (multi-client, multi-year, re-sync).
// No DB access -- pure function tests against buildDocHierarchyLookups, the
// deterministic document-hierarchy resolver that feeds generateChartOfAccounts.
// Run: node backend/scripts/validateFreshCoaGeneration.js

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

function checkTrue(name, actual) {
  check(name, Boolean(actual), true);
}

const BS_ANCHOR = { asset: ["Total Assets", "Total Assets"], liability: ["Total Liabilities and Equity", "Total Liabilities"] };
const PL_ANCHOR = ["Total Liabilities and Equity", "Total Equity", "Total Equity"];

function bsRow(name, section, parentPath, year = 2024) {
  return { account_name: name, section, parent_path: parentPath, fiscal_year: year, hierarchy_level: parentPath.length, is_total: false };
}
function plRow(name, section, parentPath, year = 2024) {
  return { account_name: name, section, parent_path: parentPath, fiscal_year: year, is_total: false, is_header: false, node_type: "account" };
}

// ── Client A: standard nesting (Assets > Current Assets > Bank Accounts > Checking) ──
console.log("\nClient A: Assets > Current Assets > Bank Accounts > Checking");
{
  const bsRows = [bsRow("Checking", "assets", ["Current Assets", "Bank Accounts"])];
  const { bsHierarchyByName } = coa.buildDocHierarchyLookups(bsRows, [], null);
  check("Client A document hierarchy wins verbatim", bsHierarchyByName.get("checking")?.levels,
    [...BS_ANCHOR.asset, "Current Assets", "Bank Accounts", "Checking"]);
}

// ── Client B: different vocabulary, same depth (Working Capital Assets > Cash and Cash Equivalents > Operating Cash) ──
console.log("\nClient B: Working Capital Assets > Cash and Cash Equivalents > Operating Cash");
{
  const bsRows = [bsRow("Operating Cash", "assets", ["Working Capital Assets", "Cash and Cash Equivalents"])];
  const { bsHierarchyByName } = coa.buildDocHierarchyLookups(bsRows, [], null);
  check("Client B's own vocabulary preserved verbatim -- no name-based inference", bsHierarchyByName.get("operating cash")?.levels,
    [...BS_ANCHOR.asset, "Working Capital Assets", "Cash and Cash Equivalents", "Operating Cash"]);
}

// ── Client C: mixed depths across two sub-trees under the same statement side ──
console.log("\nClient C: Current Assets > Cash (shallow) + Long-Term Assets > Property > Buildings (deep)");
{
  const bsRows = [
    bsRow("Cash", "assets", ["Current Assets"]),
    bsRow("Buildings", "assets", ["Long-Term Assets", "Property"]),
  ];
  const { bsHierarchyByName } = coa.buildDocHierarchyLookups(bsRows, [], null);
  check("Client C shallow leaf", bsHierarchyByName.get("cash")?.levels, [...BS_ANCHOR.asset, "Current Assets", "Cash"]);
  check("Client C deep leaf (different depth, same sync, no code branch needed)", bsHierarchyByName.get("buildings")?.levels,
    [...BS_ANCHOR.asset, "Long-Term Assets", "Property", "Buildings"]);
}

// ── Client D: P&L with Other Income / Other Expense sections + nested Operating Expenses ──
console.log("\nClient D: Revenue/Other Income/Operating Expenses(nested)/Other Expense");
{
  const plRows = [
    plRow("Product Revenue", "revenue", ["Revenue"]),
    plRow("Interest Income", "other_income", ["Other Income"]),
    plRow("Salaries", "operating_expenses", ["Operating Expenses", "Payroll"]),
    plRow("Interest Expense", "other_expense", ["Other Expense"]),
  ];
  const { plHierarchyByName } = coa.buildDocHierarchyLookups([], plRows, null);
  check("Client D Product Revenue", plHierarchyByName.get("product revenue")?.levels, [...PL_ANCHOR, "Revenue", "Product Revenue"]);
  check("Client D Interest Income (Other Income)", plHierarchyByName.get("interest income")?.levels, [...PL_ANCHOR, "Other Income", "Interest Income"]);
  check("Client D Salaries nested under Operating Expenses > Payroll", plHierarchyByName.get("salaries")?.levels,
    [...PL_ANCHOR, "Operating Expenses", "Payroll", "Salaries"]);
  check("Client D Interest Expense (Other Expense)", plHierarchyByName.get("interest expense")?.levels, [...PL_ANCHOR, "Other Expense", "Interest Expense"]);
}

// ── Multi-year union: same account appearing in 4 fiscal years must not duplicate/conflict ──
console.log("\nMulti-year (2023-2026): same account across 4 BS years converges on one path");
{
  const bsRows = [2023, 2024, 2025, 2026].map((y) => bsRow("Checking", "assets", ["Current Assets", "Bank Accounts"], y));
  const { bsHierarchyByName, mergedNodesCount } = coa.buildDocHierarchyLookups(bsRows, [], 2026);
  check("4-year union resolves to one consistent path", bsHierarchyByName.get("checking")?.levels,
    [...BS_ANCHOR.asset, "Current Assets", "Bank Accounts", "Checking"]);
  checkTrue("multi-year repetition counted as merged, not duplicated/conflicting", mergedNodesCount >= 1);
}

// ── Re-sync-with-different-documents: second call must not inherit the first's structure ──
console.log("\nRe-sync test: second document set for the 'same' account name is independent");
{
  // First "sync": Client A's own shape for Checking.
  const first = coa.buildDocHierarchyLookups([bsRow("Checking", "assets", ["Current Assets", "Bank Accounts"])], [], null);
  // Second "sync": a completely different client's document places an account
  // with the SAME leaf name under a totally different structure. Each call to
  // buildDocHierarchyLookups is independent (pure function, no shared state,
  // no DB read of a previous run) -- this is what proves a second sync cannot
  // inherit the first's hierarchy merely because a prior call resolved it.
  const second = coa.buildDocHierarchyLookups([bsRow("Checking", "assets", ["Restricted Cash"])], [], null);
  check("First call's own result", first.bsHierarchyByName.get("checking")?.levels, [...BS_ANCHOR.asset, "Current Assets", "Bank Accounts", "Checking"]);
  check("Second call resolves independently from the SECOND document, not the first", second.bsHierarchyByName.get("checking")?.levels,
    [...BS_ANCHOR.asset, "Restricted Cash", "Checking"]);
  checkTrue("the two results genuinely differ (no cross-call state leak)",
    JSON.stringify(first.bsHierarchyByName.get("checking")?.levels) !== JSON.stringify(second.bsHierarchyByName.get("checking")?.levels));
}

console.log(`\n${"=".repeat(60)}\n${pass} passed, ${fail} failed\n${"=".repeat(60)}`);
if (fail) { console.log("Failed checks:", failures.join(", ")); process.exit(1); }
process.exit(0);
