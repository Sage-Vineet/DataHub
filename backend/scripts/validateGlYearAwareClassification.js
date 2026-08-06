// Regression harness for year-aware GL Retained-Earnings boundary detection
// (splitAccountsAtRetainedEarningsByYear in chartOfAccountsService.js).
// No DB access -- pure function tests against real exported functions.
//
// Root cause fixed here: splitAccountsAtRetainedEarnings (UNCHANGED by this
// fix) used to be called ONCE across the entire multi-year GL. A real GL
// export spanning several fiscal years -- each with its own "Retained
// Earnings" heading -- would only ever match the FIRST occurrence
// (Array.prototype.findIndex), silently misbucketing every later year's real
// Balance Sheet accounts as Profit & Loss. splitAccountsAtRetainedEarningsByYear
// groups GL rows by fiscal year (glRowYear, already used elsewhere in this
// file), runs the existing per-year-boundary function once per year, then
// merges results -- an account every year agrees on keeps that bucket; a
// genuine cross-year conflict is logged and left unresolved (never a hard
// gate anyway) rather than silently guessed.
//
// Run: node backend/scripts/validateGlYearAwareClassification.js

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

// One fiscal year's worth of GL rows: Chase Bank / Accounts Receivable (BS,
// before RE) and Charges and Bank / Office Rent (P&L, after RE) -- plus that
// year's own "Retained Earnings" heading as the boundary.
function yearRows(year, { bsExtra = [], plExtra = [] } = {}) {
  const d = `${year}-06-15`;
  return [
    { account_name: "Chase Bank", transaction_date: d },
    { account_name: "Accounts Receivable", transaction_date: d },
    ...bsExtra.map((n) => ({ account_name: n, transaction_date: d })),
    { account_name: "Retained Earnings", transaction_date: d },
    { account_name: "Charges and Bank", transaction_date: d },
    { account_name: "Office Rent", transaction_date: d },
    ...plExtra.map((n) => ({ account_name: n, transaction_date: d })),
  ];
}

const YEARS = [2022, 2023, 2024, 2025];

console.log("\n=== TEST 1 — one multi-year GL file (all years concatenated in one row array) ===");
{
  const glRows = YEARS.flatMap((y) => yearRows(y));
  const merged = coa.splitAccountsAtRetainedEarningsByYear(glRows, null);
  check("1a. Chase Bank -> balance_sheet", merged.get("chase bank"), "balance_sheet");
  check("1b. Accounts Receivable -> balance_sheet", merged.get("accounts receivable"), "balance_sheet");
  check("1c. Charges and Bank -> profit_loss", merged.get("charges and bank"), "profit_loss");
  check("1d. Office Rent -> profit_loss", merged.get("office rent"), "profit_loss");
  check("1e. Retained Earnings itself -> profit_loss (boundary account, matches splitAccountsAtRetainedEarnings' own convention)",
    merged.get("retained earnings"), "profit_loss");
}

console.log("\n=== TEST 2 — multiple single-year GL files (same transactions, different row/file grouping order) ===");
{
  // Simulate 4 separately-uploaded single-year files: extraction normalizes
  // both scenarios into the same flat row shape (no file boundary concept),
  // so this is the same row set as Test 1 but built by concatenating
  // per-file arrays in reverse year order, proving the result depends only
  // on each row's own transaction_date, never on file/row order.
  const file2025 = yearRows(2025);
  const file2024 = yearRows(2024);
  const file2023 = yearRows(2023);
  const file2022 = yearRows(2022);
  const glRows = [...file2025, ...file2024, ...file2023, ...file2022];
  const merged = coa.splitAccountsAtRetainedEarningsByYear(glRows, null);
  const mergedOneFile = coa.splitAccountsAtRetainedEarningsByYear(YEARS.flatMap((y) => yearRows(y)), null);

  check("2a. Chase Bank -> balance_sheet (matches Test 1)", merged.get("chase bank"), "balance_sheet");
  check("2b. Charges and Bank -> profit_loss (matches Test 1)", merged.get("charges and bank"), "profit_loss");
  check("2c. Multi-file-order result is IDENTICAL to the single-multi-year-file result",
    Array.from(merged.entries()).sort(), Array.from(mergedOneFile.entries()).sort());
}

console.log("\n=== TEST 3 — duplicated P&L account across 4 years collapses to ONE classification ===");
{
  const glRows = YEARS.flatMap((y) => yearRows(y));
  const merged = coa.splitAccountsAtRetainedEarningsByYear(glRows, null);
  check("3. Charges and Bank -> profit_loss (single entry covering all 4 years)", merged.get("charges and bank"), "profit_loss");
  checkTrue("3b. Only one bucket entry exists for this account (Map, not an array of 4)", typeof merged.get("charges and bank") === "string");
}

console.log("\n=== TEST 4 — duplicated BS account across 4 years collapses to ONE classification ===");
{
  const glRows = YEARS.flatMap((y) => yearRows(y));
  const merged = coa.splitAccountsAtRetainedEarningsByYear(glRows, null);
  check("4. Chase Bank -> balance_sheet (single entry covering all 4 years)", merged.get("chase bank"), "balance_sheet");
}

console.log("\n=== TEST 5 — different accounts present in different years, all appear exactly once in the final set ===");
{
  const glRows = [
    ...yearRows(2022, { bsExtra: ["Account A", "Account B"] }),
    ...yearRows(2023, { bsExtra: ["Account B", "Account C"] }),
    ...yearRows(2024, { bsExtra: ["Account A", "Account C"] }),
  ];
  const merged = coa.splitAccountsAtRetainedEarningsByYear(glRows, null);
  check("5a. Account A -> balance_sheet", merged.get("account a"), "balance_sheet");
  check("5b. Account B -> balance_sheet", merged.get("account b"), "balance_sheet");
  check("5c. Account C -> balance_sheet", merged.get("account c"), "balance_sheet");
}

console.log("\n=== TEST 6 — each year finds its OWN Retained Earnings boundary independently ===");
{
  // FY2022 has 3 extra BS accounts before its own Retained Earnings heading;
  // FY2023 has none. Under the OLD single-pass bug, FY2023's own RE heading
  // would never be found (findIndex stops at the FIRST RE occurrence, in
  // FY2022's block) and FY2023's real BS accounts ("FY23 Only Asset") would
  // be misbucketed as profit_loss. The per-year wrapper must get this right
  // regardless of how many rows precede each year's own boundary.
  const glRows = [
    ...yearRows(2022, { bsExtra: ["Prepaid Insurance", "Fixed Assets", "Other Current Assets"] }),
    { account_name: "FY23 Only Asset", transaction_date: "2023-02-01" },
    { account_name: "Retained Earnings", transaction_date: "2023-02-01" },
    { account_name: "FY23 Only Expense", transaction_date: "2023-02-01" },
  ];
  const merged = coa.splitAccountsAtRetainedEarningsByYear(glRows, null);
  check("6a. FY2022's extra BS account resolves correctly", merged.get("prepaid insurance"), "balance_sheet");
  check("6b. FY2023's own asset (found via FY2023's OWN Retained Earnings, not FY2022's index) -> balance_sheet",
    merged.get("fy23 only asset"), "balance_sheet");
  check("6c. FY2023's own expense -> profit_loss", merged.get("fy23 only expense"), "profit_loss");
}

console.log("\n=== TEST 7 — conflicting year classifications are detected, logged, and left unresolved (never guessed) ===");
{
  // "Mystery Account" sits on the Balance Sheet side (before Retained
  // Earnings) in FY2024 only, and on the Profit & Loss side (after Retained
  // Earnings) in every other year -- a genuine conflict.
  const glRows = [
    ...yearRows(2022, { plExtra: ["Mystery Account"] }),
    ...yearRows(2023, { plExtra: ["Mystery Account"] }),
    ...yearRows(2024, { bsExtra: ["Mystery Account"] }),
    ...yearRows(2025, { plExtra: ["Mystery Account"] }),
  ];
  const originalWarn = console.warn;
  let warnedConflict = false;
  console.warn = (...args) => {
    if (String(args[0] || "").includes("[GL_ACCOUNT_CONFLICT]") && String(args.join(" ")).includes("mystery account")) warnedConflict = true;
    originalWarn(...args);
  };
  const merged = coa.splitAccountsAtRetainedEarningsByYear(glRows, null);
  console.warn = originalWarn;

  checkTrue("7a. Conflict was logged via [GL_ACCOUNT_CONFLICT]", warnedConflict);
  check("7b. No biased bucket hint applied for the conflicted account (omitted, not guessed)", merged.get("mystery account"), undefined);
  check("7c. Unrelated accounts in the SAME years are unaffected by the conflict", merged.get("chase bank"), "balance_sheet");
  check("7d. Unrelated P&L accounts in the SAME years are unaffected", merged.get("charges and bank"), "profit_loss");
}

console.log("\n=== TEST 8 — Proposed COA contains exactly ONE node per unique logical account (buildCoaModel) ===");
{
  const glRows = YEARS.flatMap((y) => yearRows(y));
  const glBucketByKey = coa.splitAccountsAtRetainedEarningsByYear(glRows, null);
  const { leaves } = coa.buildCoaModel(glRows, [], [], new Map(), new Map(), glBucketByKey, null, {});
  const chargesAndBank = leaves.filter((l) => l.accountName === "Charges and Bank");
  const chaseBank = leaves.filter((l) => l.accountName === "Chase Bank");

  check("8a. Exactly ONE leaf for 'Charges and Bank' despite appearing in 4 fiscal years", chargesAndBank.length, 1);
  check("8b. Exactly ONE leaf for 'Chase Bank' despite appearing in 4 fiscal years", chaseBank.length, 1);
  check("8c. That one leaf's statementType is profit_loss (from the merged GL bucket hint)", chargesAndBank[0]?.statementType, "profit_loss");
  check("8d. That one leaf's statementType is balance_sheet (from the merged GL bucket hint)", chaseBank[0]?.statementType, "balance_sheet");
}

console.log("\n=== TEST 9 — a duplicated account has ONE document-derived hierarchy, not one per year ===");
{
  const glRows = YEARS.flatMap((y) => yearRows(y));
  const glBucketByKey = coa.splitAccountsAtRetainedEarningsByYear(glRows, null);
  const { leaves } = coa.buildCoaModel(glRows, [], [], new Map(), new Map(), glBucketByKey, null, {});
  const chaseBank = leaves.find((l) => l.accountName === "Chase Bank");

  checkTrue("9a. Chase Bank leaf exists", Boolean(chaseBank));
  check("9b. fiscalYears evidence preserved for all 4 years (Critical Rule #5) even though the leaf itself is one node",
    Array.from(chaseBank.fiscalYears).sort(), YEARS);
  checkTrue("9c. No 'Chase Bank 2022' / 'Chase Bank 2023' etc. leaves were created (year-suffixed names)",
    !leaves.some((l) => /chase bank\s*20\d\d/i.test(l.accountName)));
}

console.log(`\n${"=".repeat(60)}\n${pass} passed, ${fail} failed\n${"=".repeat(60)}`);
if (fail > 0) {
  console.log("Failures:");
  failures.forEach((f) => console.log(`  - ${f}`));
}
process.exit(fail === 0 ? 0 : 1);
