// Regression harness for the Balance Sheet section-classification root-cause
// fix (balanceSheetExtractionService.js's inferSection/sectionFromAncestry).
// No DB access -- pure function tests against real exported functions.
//
// Root cause fixed here: `section` used to be read off a single flat
// `currentSection` variable that was only reassigned when a recognized
// section-header LINE was itself visited, and was never rescoped when the
// document's own indentation ancestor-stack popped back past that header.
// An Equity account nested under a combined "Liabilities and Equity" umbrella
// could silently inherit a stale "Liabilities" section left over from an
// earlier sibling branch. `sectionFromAncestry` instead derives `section`
// fresh, per row, from that row's OWN real ancestor chain (`parent_path`,
// walked nearest-ancestor-first) -- immune to whatever a shared mutable
// variable happens to be pointing at.
//
// Run: node backend/scripts/validateBsSectionAncestry.js

const path = require("path");
const bs = require(path.join(__dirname, "..", "src", "services", "keyReports", "balanceSheetExtractionService.js"));

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

console.log("\n=== 1. inferSection: bare header vocabulary (single concept) ===");
{
  check("Asset test: 'Assets' -> assets", bs.inferSection("Assets"), "assets");
  check("Asset test: 'Current Assets' -> assets", bs.inferSection("Current Assets"), "assets");
  check("Asset test: 'Fixed Assets' -> assets", bs.inferSection("Fixed Assets"), "assets");
  check("Liability test: 'Liabilities' -> liabilities", bs.inferSection("Liabilities"), "liabilities");
  check("Liability test: 'Current Liabilities' -> liabilities", bs.inferSection("Current Liabilities"), "liabilities");
  check("Liability test: 'Long Term Liabilities' -> liabilities", bs.inferSection("Long Term Liabilities"), "liabilities");
  check("Equity test: 'Equity' -> equity", bs.inferSection("Equity"), "equity");
  check("Equity test: 'Owners Equity' -> equity", bs.inferSection("Owners Equity"), "equity");
  check("Equity test: 'Stockholders Equity' -> equity", bs.inferSection("Stockholders Equity"), "equity");
  check("Not a header: 'Capital One Credit Card' -> null (regression guard for the pre-existing substring-match bug)",
    bs.inferSection("Capital One Credit Card"), null);
  check("Not a header: 'Chase Bank' -> null", bs.inferSection("Chase Bank"), null);
  check("Not a header: '30010 TH Equity' (a real account name, not a header line) -> null",
    bs.inferSection("30010 TH Equity"), null);
}

console.log("\n=== 2. sectionFromAncestry: Asset branch (nearest-ancestor-first walk) ===");
{
  check("1. Asset account: Assets > Current Assets > Bank Accounts > Chase Bank",
    bs.sectionFromAncestry(["Assets", "Current Assets", "Bank Accounts"]), "assets");
  check("2. Multiple asset branches: Assets > Fixed Assets",
    bs.sectionFromAncestry(["Assets", "Fixed Assets"]), "assets");
  check("3. Multiple asset branches: Assets > Other Current Assets > Prepaid Expenses",
    bs.sectionFromAncestry(["Assets", "Other Current Assets", "Prepaid Expenses"]), "assets");
  check("4. Repeated document labels: Total Assets > Total Assets > Current Assets",
    bs.sectionFromAncestry(["Total Assets", "Total Assets", "Current Assets"]), "assets");
  check("5. Shallow hierarchy: Assets only", bs.sectionFromAncestry(["Assets"]), "assets");
}

console.log("\n=== 3. sectionFromAncestry: Liability branch under the combined umbrella ===");
{
  check("6. Liability account: Liabilities and Equity > Liabilities > Current Liabilities > Accounts Payable",
    bs.sectionFromAncestry(["Liabilities and Equity", "Liabilities", "Current Liabilities"]), "liabilities");
  check("7. Multiple liability branches: ... > Liabilities > Long Term Liabilities",
    bs.sectionFromAncestry(["Liabilities and Equity", "Liabilities", "Long Term Liabilities"]), "liabilities");
  check("8. Multiple liability branches: ... > Liabilities > Other Current Liabilities",
    bs.sectionFromAncestry(["Liabilities and Equity", "Liabilities", "Other Current Liabilities"]), "liabilities");
  check("9. Deep hierarchy with unrecognized intermediate groups still resolves via nearest recognized ancestor",
    bs.sectionFromAncestry(["Liabilities and Equity", "Liabilities", "Credit Cards", "Business Card Program", "Store Card"]), "liabilities");
}

console.log("\n=== 4. sectionFromAncestry: Equity branch under the combined umbrella (the reported bug) ===");
{
  // Exact shape from the bug report: Liabilities and Equity > Equity >
  // Shareholder Equity > 30010 TH Equity. "Shareholder Equity" itself is NOT
  // in the recognized header vocabulary ('shareholder' is not a recognized
  // word — only 'stockholder'/'stockholders' are) — the walk must skip over
  // it and keep going up to find "Equity", not stop and return null/wrong.
  check("10. CRITICAL — reported bug: Liabilities and Equity > Equity > Shareholder Equity > 30010 TH Equity => equity, NOT liability",
    bs.sectionFromAncestry(["Liabilities and Equity", "Equity", "Shareholder Equity"]), "equity");
  check("11. Multiple equity branches: ... > Equity > Owners Capital",
    bs.sectionFromAncestry(["Liabilities and Equity", "Equity", "Owners Capital"]), "equity");
  check("12. Multiple equity branches: ... > Equity > Partners Capital",
    bs.sectionFromAncestry(["Liabilities and Equity", "Equity", "Partners Capital"]), "equity");
  check("13. Shallow hierarchy: Liabilities and Equity > Equity",
    bs.sectionFromAncestry(["Liabilities and Equity", "Equity"]), "equity");
}

console.log("\n=== 5. THE ROOT-CAUSE PROOF: ancestry-based derivation is immune to a poisoned/stale currentSection ===");
{
  // This simulates EXACTLY the confirmed bug mechanism: a prior sibling
  // branch ("Liabilities" > "Current Liabilities") left the OLD flat
  // `currentSection` variable pointing at "Current Liabilities". The row
  // under test is really nested under "Equity" (its true parent_path), but
  // under the OLD design, currentSection was a single variable shared across
  // the entire document walk and was never rescoped when the ancestor stack
  // popped back past "Current Liabilities" — so the OLD formula
  // (`inferSection(currentSection)`) still used the poisoned value.
  const poisonedCurrentSection = "Current Liabilities";
  const trueParentPath = ["Liabilities and Equity", "Equity"];

  const oldResult = bs.inferSection(poisonedCurrentSection);
  const newResult = bs.sectionFromAncestry(trueParentPath);

  check("14. OLD formula (inferSection(currentSection)) reproduces the confirmed bug: gives 'liabilities' for a real Equity account",
    oldResult, "liabilities");
  check("15. NEW formula (sectionFromAncestry(parent_path)) is immune to the poisoned variable: gives 'equity' regardless of currentSection",
    newResult, "equity");
  check("16. OLD and NEW disagree on this exact case — this is the bug the fix closes", oldResult !== newResult, true);
}

console.log("\n=== 6. Known residual limitation (documented, NOT silently claimed fixed) ===");
{
  // An equity/liability leaf sitting DIRECTLY under the combined umbrella
  // with NO distinguishing "Liabilities"/"Equity" sub-header anywhere in its
  // own ancestor chain is genuinely ambiguous from document structure alone
  // — there is no tree signal left to disambiguate it without either
  // inventing a new heuristic beyond ancestor-path walking, or changing the
  // AI-fallback gating in chartOfAccountsService.js's addLeaf (out of scope
  // per this fix's explicit constraints). The existing word-order tie-break
  // in inferSection (liabilities-first wins for the literal phrase
  // "Liabilities and Equity") is UNCHANGED and still applies as the last
  // resort. This test locks in and documents that known limitation rather
  // than silently leaving it uncovered.
  check("17. Documented limitation: umbrella-only ancestor (no distinguishing branch) still defaults to 'liabilities'",
    bs.sectionFromAncestry(["Liabilities and Equity"]), "liabilities");
}

console.log(`\n${"=".repeat(60)}\n${pass} passed, ${fail} failed\n${"=".repeat(60)}`);
if (fail > 0) {
  console.log("Failures:");
  failures.forEach((f) => console.log(`  - ${f}`));
}
process.exit(fail === 0 ? 0 : 1);
