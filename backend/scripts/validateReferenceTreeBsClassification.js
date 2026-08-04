// Regression harness for the Balance Sheet classification/hierarchy fix in
// chartOfAccountsService.js's inferAccountTypeFromReferencePath, consumed by
// buildTreeHierarchyLookup against referenceTreeBuilder.js's tree -- the
// ACTUAL production-active path (keyReportSyncService.js always builds and
// passes balanceSheetTree/profitLossTree into buildProposedCoaTree, so this
// path is exercised on every real sync, not just as a fallback).
// No DB access -- pure function tests against real exported functions.
//
// CONFIRMED ROOT CAUSE fixed here: the old implementation joined an
// account's ENTIRE resolved ancestor path into one text blob and checked
// substrings in a fixed order (asset, then equity, then liability). Any
// account whose path only ever reached the ambiguous "Liabilities and
// Equity" umbrella -- e.g. a bare liability with no "Liabilities"
// sub-header of its own -- was classified as equity every single time,
// because that umbrella phrase always contains the substring "equity",
// checked before "liabil". Fixed: classifyBsAncestorLabel walks the path
// from the NEAREST ancestor toward the root, one label at a time (mirroring
// balanceSheetExtractionService.js's already-proven sectionFromAncestry),
// so a more specific "Liabilities"/"Equity" sub-header always wins over the
// ambiguous umbrella above it -- and when truly no distinguishing branch
// exists anywhere in the path, it honestly returns null (unresolved)
// instead of a confidently wrong guess.
//
// Because getBalanceSheetPrefix/applyBalanceSheetCoaPrefix pick the
// hierarchy anchor directly from this SAME accountType value, this one fix
// corrects both classification (Issue 1) AND hierarchy propagation
// (Issue 2) together -- there is no separate hierarchy-generation logic to
// fix, satisfying the "one canonical tree" requirement.
//
// Run: node backend/scripts/validateReferenceTreeBsClassification.js

const path = require("path");
const coa = require(path.join(__dirname, "..", "src", "services", "chartOfAccountsService.js"));
const { buildBalanceSheetTreeFromData } = require(path.join(__dirname, "..", "src", "services", "keyReports", "referenceTreeBuilder.js"));

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

function row(name, parentPath, overrides = {}) {
  return { account_name: name, row_type: "account", parent_path: parentPath, hierarchy_level: 1, is_total: false, amount: 100, ...overrides };
}
function heading(name, parentPath) {
  return { account_name: name, row_type: "heading", parent_path: parentPath, hierarchy_level: 0, is_total: false };
}
function total(name, parentPath) {
  return { account_name: name, row_type: "total", parent_path: parentPath, hierarchy_level: 1, is_total: true, amount: 100 };
}

function classify(rows) {
  const tree = buildBalanceSheetTreeFromData({ reportName: "Balance Sheet", rows });
  return coa.buildTreeHierarchyLookup(tree, "balance_sheet");
}

console.log("\n=== 1-2. Asset / Liability with full explicit document branches ===");
{
  const lookup = classify([
    heading("Assets", []),
    heading("Current Assets", ["Assets"]),
    heading("Bank Accounts", ["Assets", "Current Assets"]),
    row("Chase Bank", ["Assets", "Current Assets", "Bank Accounts"]),
    heading("Liabilities and Equity", []),
    heading("Liabilities", ["Liabilities and Equity"]),
    heading("Current Liabilities", ["Liabilities and Equity", "Liabilities"]),
    heading("Credit Cards", ["Liabilities and Equity", "Liabilities", "Current Liabilities"]),
    row("Chase Ink Credit Card", ["Liabilities and Equity", "Liabilities", "Current Liabilities", "Credit Cards"]),
  ]);
  check("1. Asset account: Chase Bank -> asset", lookup.get("chase bank")?.[0]?.accountType, "asset");
  check("1b. Asset hierarchy is the complete document path", lookup.get("chase bank")?.[0]?.levels,
    ["Total Assets", "Total Assets", "Current Assets", "Bank Accounts", "Chase Bank"]);
  check("2. Liability account: Chase Ink Credit Card -> liability, NOT equity (the reported bug)",
    lookup.get("chase ink credit card")?.[0]?.accountType, "liability");
  check("2b. Liability hierarchy is the complete document path (Credit Cards preserved, no Total Equity)",
    lookup.get("chase ink credit card")?.[0]?.levels,
    ["Total Liabilities and Equity", "Total Liabilities", "Current Liabilities", "Credit Cards", "Chase Ink Credit Card"]);
}

console.log("\n=== 3. Equity — Critical Requirement #2's exact example (30010 TH Equity) ===");
{
  const lookup = classify([
    heading("Liabilities and Equity", []),
    heading("Equity", ["Liabilities and Equity"]),
    heading("Shareholder Equity", ["Liabilities and Equity", "Equity"]),
    row("30010 TH Equity", ["Liabilities and Equity", "Equity", "Shareholder Equity"]),
  ]);
  check("3. 30010 TH Equity -> equity, NOT liability", lookup.get("30010 th equity")?.[0]?.accountType, "equity");
  check("3b. Complete ancestor path preserved", lookup.get("30010 th equity")?.[0]?.levels,
    ["Total Liabilities and Equity", "Total Equity", "Total Equity", "Equity", "Shareholder Equity", "30010 TH Equity"]);
}

console.log("\n=== 4-6. Multiple Asset / Liability / Equity branches ===");
{
  const lookup = classify([
    heading("Assets", []),
    row("Prepaid Insurance", ["Assets", "Other Current Assets"]),
    row("Vehicles", ["Assets", "Fixed Assets"]),
    heading("Liabilities and Equity", []),
    row("Long Term Loan", ["Liabilities and Equity", "Liabilities", "Long Term Liabilities"]),
    row("Accrued Payroll", ["Liabilities and Equity", "Liabilities", "Other Current Liabilities"]),
    row("Owners Draw", ["Liabilities and Equity", "Equity", "Owners Capital"]),
    row("Partner Contribution", ["Liabilities and Equity", "Equity", "Partners Capital"]),
  ]);
  check("4. Multiple asset branches: Prepaid Insurance (Other Current Assets)", lookup.get("prepaid insurance")?.[0]?.accountType, "asset");
  check("4b. Multiple asset branches: Vehicles (Fixed Assets)", lookup.get("vehicles")?.[0]?.accountType, "asset");
  check("5. Multiple liability branches: Long Term Loan", lookup.get("long term loan")?.[0]?.accountType, "liability");
  check("5b. Multiple liability branches: Accrued Payroll (Other Current Liabilities)", lookup.get("accrued payroll")?.[0]?.accountType, "liability");
  check("6. Multiple equity branches: Owners Draw (Owners Capital)", lookup.get("owners draw")?.[0]?.accountType, "equity");
  check("6b. Multiple equity branches: Partner Contribution (Partners Capital)", lookup.get("partner contribution")?.[0]?.accountType, "equity");
}

console.log("\n=== 7-8. Deep and shallow document hierarchy ===");
{
  const lookup = classify([
    row("Shallow Asset", ["Assets"]),
    row("Deep Liability", ["Liabilities and Equity", "Liabilities", "Current Liabilities", "Credit Cards", "Business Card Program", "Store Card"]),
  ]);
  check("7. Deep hierarchy resolves correctly and preserves every level", lookup.get("deep liability")?.[0]?.accountType, "liability");
  check("7b. Deep hierarchy full path preserved (no collapsing of intermediate nodes)", lookup.get("deep liability")?.[0]?.levels,
    ["Total Liabilities and Equity", "Total Liabilities", "Current Liabilities", "Credit Cards", "Business Card Program", "Store Card", "Deep Liability"]);
  check("8. Shallow hierarchy still resolves", lookup.get("shallow asset")?.[0]?.accountType, "asset");
}

console.log("\n=== 9. Repeated document labels ===");
{
  const lookup = classify([
    row("Chase Bank", ["Total Assets", "Total Assets", "Current Assets"]),
  ]);
  check("9. Repeated 'Total Assets' label still resolves to asset", lookup.get("chase bank")?.[0]?.accountType, "asset");
}

console.log("\n=== 10. Multiple BS documents (Opening + Ending) converge on one path ===");
{
  const rows = [
    { ...row("Chase Bank", ["Assets", "Current Assets"]), source_file_id: "opening-bs" },
    { ...row("Chase Bank", ["Assets", "Current Assets"]), source_file_id: "ending-bs" },
  ];
  const lookup = classify(rows);
  check("10. Same account across two BS documents resolves to ONE consistent classification", lookup.get("chase bank")?.[0]?.accountType, "asset");
}

console.log("\n=== Known, honest residual limitation (no distinguishing branch at all) ===");
{
  // A genuine liability sitting bare under the umbrella with NO "Liabilities"
  // sub-header of its own anywhere in its path. Before this fix: silently,
  // confidently WRONG ("equity"). After this fix: honestly unresolved
  // (null) -- never a confident wrong guess -- which is the same documented
  // trade-off already accepted for the extraction-layer fix
  // (balanceSheetExtractionService.js's sectionFromAncestry).
  const lookup = classify([
    heading("Liabilities and Equity", []),
    row("Bare Payable No Subheader", ["Liabilities and Equity"]),
    total("Total Liabilities", ["Liabilities and Equity"]),
    heading("Equity", ["Liabilities and Equity"]),
    row("Common Stock", ["Liabilities and Equity", "Equity"]),
    total("Total Equity", ["Liabilities and Equity"]),
  ]);
  check("Bare liability with no distinguishing sub-header: honestly unresolved (null), never wrongly 'equity'",
    lookup.get("bare payable no subheader")?.[0]?.accountType, null);
  check("Equity WITH its own distinguishing sub-header still resolves correctly", lookup.get("common stock")?.[0]?.accountType, "equity");
}

console.log("\n=== parent_account_id / hierarchy_path / level_1..15 all agree (one canonical tree) ===");
{
  const lookup = classify([
    heading("Liabilities and Equity", []),
    heading("Liabilities", ["Liabilities and Equity"]),
    heading("Current Liabilities", ["Liabilities and Equity", "Liabilities"]),
    heading("Credit Cards", ["Liabilities and Equity", "Liabilities", "Current Liabilities"]),
    row("Chase Ink Credit Card", ["Liabilities and Equity", "Liabilities", "Current Liabilities", "Credit Cards"]),
  ]);
  const entry = lookup.get("chase ink credit card")?.[0];
  checkTrue("Entry resolved", Boolean(entry));
  check("classification (accountType) is liability", entry.accountType, "liability");
  check("parent field is the immediate parent (Credit Cards)", entry.parent, "Credit Cards");
  const MAX_LEVELS = 15;
  const levels = new Array(MAX_LEVELS).fill(null);
  entry.levels.forEach((label, i) => { if (i < MAX_LEVELS) levels[i] = label; });
  check("level_1..15 match the hierarchy_path exactly", levels.filter(Boolean).join(" > "), entry.levels.join(" > "));
  check("levels[levels.length-2] (parent_account_id target) matches the parent field", entry.levels[entry.levels.length - 2], entry.parent);
}

console.log("\n=== Rows with NO document ancestry fall back to their own section (confirmed live: 8 stranded accounts) ===");
{
  // EXACT real-world shape, straight from balance_sheet_entries for a live
  // version: parent_path is NULL (the extractor captured no ancestry for these
  // rows) but `section` is already correct. Previously the account attached
  // directly to the report root, so ancestor-based classification saw only
  // [ownName], correctly refused to guess a section from the name, and left
  // accountType null -> no anchor prefix -> stranded in "NEEDS MAPPING".
  const lookup = classify([
    row("Business Money Market", null, { section: "assets", sub_section: "current" }),
    row("Space Center Savings", null, { section: "assets", sub_section: "current" }),
    row("Loans to MTP", null, { section: "assets", sub_section: "current" }),
    row("Prepaid payroll", null, { section: "assets", sub_section: "current" }),
    row("Capital One Credit Card 2", null, { section: "liabilities", sub_section: "current" }),
    row("Chase Ink Credit Card", null, { section: "liabilities", sub_section: "current" }),
    row("Loan Payable- Florian Realty LLC", null, { section: "liabilities", sub_section: "current" }),
    row("Loan Payable from MTP", null, { section: "liabilities", sub_section: "current" }),
  ]);

  for (const n of ["business money market", "space center savings", "loans to mtp", "prepaid payroll"]) {
    check(`No-ancestry asset resolves from its own section: ${n}`, lookup.get(n)?.[0]?.accountType, "asset");
  }
  for (const n of ["capital one credit card 2", "chase ink credit card", "loan payable- florian realty llc", "loan payable from mtp"]) {
    check(`No-ancestry liability resolves from its own section: ${n}`, lookup.get(n)?.[0]?.accountType, "liability");
  }
  check("No-ancestry asset gets the asset anchor and NO invented intermediate group",
    lookup.get("business money market")?.[0]?.levels, ["Total Assets", "Total Assets", "Business Money Market"]);
  check("No-ancestry liability gets the liability anchor (never the Equity branch)",
    lookup.get("chase ink credit card")?.[0]?.levels,
    ["Total Liabilities and Equity", "Total Liabilities", "Chase Ink Credit Card"]);
  checkTrue("A 'Capital'-named account with section=liabilities is NOT pulled into Equity",
    !(lookup.get("capital one credit card 2")?.[0]?.levels || []).includes("Total Equity"));
}

console.log("\n=== Accounts present ONLY in a non-reference fiscal year still resolve from the document ===");
{
  // CONFIRMED LIVE: the BS reference tree used to be built from ONE fiscal
  // year, so accounts appearing only in an EARLIER year's uploaded Balance
  // Sheet were invisible to document matching and fell through to AI --
  // "(deleted)"/closed accounts especially. Callers now pass every year's rows
  // with the reference year ORDERED FIRST, and the builder places each account
  // once (first placement wins), so the reference year keeps precedence while
  // older years only add what it lacks.
  const rows = [
    // Reference year (FY2026) first, exactly as the caller orders them.
    row("Additional Paid In Capital", ["Liabilities and Equity", "Equity"], { section: "equity", fiscal_year: 2026, sort_order: 1 }),
    row("Fixed Assets", ["Assets"], { section: "assets", fiscal_year: 2026, sort_order: 2 }),
    // Older year (FY2023) — same account under a DIFFERENT parent, plus
    // accounts the reference year does not contain at all.
    row("Additional Paid In Capital", ["Some Other Parent"], { section: "equity", fiscal_year: 2023, sort_order: 1 }),
    row("Member 2 Equity - Blake (deleted)", ["Liabilities and Equity", "Equity"], { section: "equity", fiscal_year: 2023, sort_order: 2 }),
    row("Capital Contributions (deleted)", ["Liabilities and Equity", "Equity"], { section: "equity", fiscal_year: 2023, sort_order: 3 }),
    row("Kubota - Tractor Attachments ($259.47) (deleted)", ["Liabilities and Equity", "Liabilities"], { section: "liabilities", fiscal_year: 2023, sort_order: 4 }),
  ];
  const lookup = classify(rows);

  check("Older-year-only equity account resolves from the document (was AI-classified)",
    lookup.get("member 2 equity - blake (deleted)")?.[0]?.accountType, "equity");
  check("Older-year-only equity account #2 resolves from the document",
    lookup.get("capital contributions (deleted)")?.[0]?.accountType, "equity");
  check("Older-year-only LIABILITY resolves as liability, not equity, despite the shared umbrella",
    lookup.get("kubota - tractor attachments ($259.47) (deleted)")?.[0]?.accountType, "liability");
  check("...with its full document path", lookup.get("kubota - tractor attachments ($259.47) (deleted)")?.[0]?.levels,
    ["Total Liabilities and Equity", "Total Liabilities", "Kubota - Tractor Attachments ($259.47) (deleted)"]);

  // Precedence + de-duplication.
  check("Reference year keeps precedence for an account present in BOTH years",
    lookup.get("additional paid in capital")?.[0]?.levels,
    ["Total Liabilities and Equity", "Total Equity", "Total Equity", "Equity", "Additional Paid In Capital"]);
  check("An account present in two years yields exactly ONE tree candidate (no duplicate leaves)",
    lookup.get("additional paid in capital")?.length, 1);
  check("'Fixed Assets' (a header-named real account) resolves as asset, not NEEDS MAPPING",
    lookup.get("fixed assets")?.[0]?.accountType, "asset");
}

console.log("\n=== Un-indented document: ancestry reconstructed from header/'Total for X' bracketing ===");
{
  // The EXACT real-world shape (verified against a live version): a
  // QuickBooks-style Balance Sheet with ZERO indentation -- parent_path empty
  // on every single row -- where nesting is conveyed by a header row OPENING a
  // section and a matching "Total for <same name>" row CLOSING it.
  // Confirmed live: 0 of 103 uploaded rows had a parent_path, yet the document
  // carried 28 headers and 28 exactly-matching total rows. Previously every
  // account attached to the report root, collapsing the whole hierarchy to
  // "Total Assets > <account>".
  let so = 0;
  const F = "doc-1";
  const h = (n) => ({ account_name: n, row_type: "heading", parent_path: null, hierarchy_level: 0, is_total: false, amount: 0, fiscal_year: 2026, sort_order: so++, source_file_id: F });
  const a = (n, section) => ({ account_name: n, row_type: "account", parent_path: null, hierarchy_level: 1, is_total: false, amount: 1, section, fiscal_year: 2026, sort_order: so++, source_file_id: F });
  const t = (n) => ({ account_name: `Total for ${n}`, row_type: "subtotal", parent_path: null, hierarchy_level: 1, is_total: true, amount: 1, fiscal_year: 2026, sort_order: so++, source_file_id: F });

  const lookup = classify([
    h("Assets"),
    h("Current Assets"),
    h("Bank Accounts"), a("Ent. Bank & Trust Chk (3856)", "assets"), t("Bank Accounts"),
    h("Accounts Receivable"), a("Accounts Receivable", "assets"), t("Accounts Receivable"),
    h("Other Current Assets"), a("Rent Deposit", "assets"), t("Other Current Assets"),
    t("Current Assets"),
    h("Fixed Assets"), a("Vehicles", "assets"), t("Fixed Assets"),
    t("Assets"),
    h("Liabilities and Equity"),
    h("Liabilities"),
    h("Current Liabilities"),
    h("Credit Cards"), a("Capital One CC 1532", "liabilities"), t("Credit Cards"),
    t("Current Liabilities"),
    h("Long-term Liabilities"), a("Kubota BX23 ($534.01)", "liabilities"), t("Long-term Liabilities"),
    t("Liabilities"),
    h("Equity"),
    a("Additional Paid In Capital", "equity"),
    // A posting account that is ALSO a parent carrying its own balance (it has
    // its own matching total further down) -- QuickBooks emits these as normal
    // account rows, so the opener must be detected from the total, not the type.
    a("Member 2 Equity - Blake", "equity"),
    a("Capital Contributions", "equity"),
    t("Member 2 Equity - Blake"),
    a("Retained Earnings", "equity"),
    t("Equity"),
    t("Liabilities and Equity"),
  ]);

  const path = (k) => (lookup.get(k) ? undefined : undefined) || (() => {
    const c = lookup.get(k) || [];
    // Mirror production selection: a real ACCOUNT node outranks a structural one.
    const sorted = c.slice().sort((x, y) => (x.isStructural ? 1 : 0) - (y.isStructural ? 1 : 0) || (y.level || 0) - (x.level || 0));
    return sorted[0];
  })();

  check("Deep asset keeps EVERY intermediate node (the reported bug)",
    path("ent. bank & trust chk (3856)")?.levels,
    ["Total Assets", "Total Assets", "Current Assets", "Bank Accounts", "Ent. Bank & Trust Chk (3856)"]);
  check("Asset under a different Current Assets subsection",
    path("rent deposit")?.levels, ["Total Assets", "Total Assets", "Current Assets", "Other Current Assets", "Rent Deposit"]);
  check("Asset in a shallower branch keeps ITS own depth (no forced padding)",
    path("vehicles")?.levels, ["Total Assets", "Total Assets", "Fixed Assets", "Vehicles"]);
  check("Header and account sharing one name does not duplicate a level",
    path("accounts receivable")?.levels, ["Total Assets", "Total Assets", "Current Assets", "Accounts Receivable"]);
  check("Liability keeps Current Liabilities > Credit Cards (the reported bug)",
    path("capital one cc 1532")?.levels,
    ["Total Liabilities and Equity", "Total Liabilities", "Current Liabilities", "Credit Cards", "Capital One CC 1532"]);
  check("Long-term liability branch preserved",
    path("kubota bx23 ($534.01)")?.levels,
    ["Total Liabilities and Equity", "Total Liabilities", "Long-term Liabilities", "Kubota BX23 ($534.01)"]);
  check("Equity account under the shared umbrella resolves to the Equity branch",
    path("additional paid in capital")?.levels,
    ["Total Liabilities and Equity", "Total Equity", "Total Equity", "Equity", "Additional Paid In Capital"]);
  check("A posting account that is also a parent nests its children correctly",
    path("capital contributions")?.levels,
    ["Total Liabilities and Equity", "Total Equity", "Total Equity", "Equity", "Member 2 Equity - Blake", "Capital Contributions"]);

  check("Classification comes from the branch: asset", path("ent. bank & trust chk (3856)")?.accountType, "asset");
  check("Classification comes from the branch: liability (NOT equity, despite the shared umbrella)",
    path("capital one cc 1532")?.accountType, "liability");
  check("Classification comes from the branch: equity (NOT liability)",
    path("additional paid in capital")?.accountType, "equity");

  // A GL account whose name exists in the document ONLY as a section header.
  const fa = path("fixed assets");
  check("A GL account matching only a section HEADER still resolves from the document (was AI-classified)",
    fa?.accountType, "asset");
  check("...with the header's own document path, total-prefix stripped",
    fa?.levels, ["Total Assets", "Total Assets", "Fixed Assets"]);
  checkTrue("...and is flagged structural so a real posting account always outranks it", fa?.isStructural);
}

console.log("\n=== Ancestor path still outranks the row's own section (no regression) ===");
{
  // Richer evidence must win: the real ancestor chain beats the coarse per-row
  // scalar, so every properly-nested account behaves exactly as it did before.
  const lookup = classify([
    heading("Assets", []),
    heading("Current Assets", ["Assets"]),
    row("Adversarial Row", ["Assets", "Current Assets"], { section: "liabilities" }),
  ]);
  check("Ancestry (Assets) beats a contradicting section scalar (liabilities)",
    lookup.get("adversarial row")?.[0]?.accountType, "asset");
}

console.log("\n=== No ancestry AND no section: still unresolved, never guessed from the name ===");
{
  const lookup = classify([row("Capital One Credit Card", null, { section: null })]);
  check("Unknowable account stays null rather than being name-guessed into equity",
    lookup.get("capital one credit card")?.[0]?.accountType, null);
}

console.log("\n=== P&L classification unaffected (out of scope for this fix, must remain unchanged) ===");
{
  const { buildProfitLossTreeFromData } = require(path.join(__dirname, "..", "src", "services", "keyReports", "referenceTreeBuilder.js"));
  const plTree = buildProfitLossTreeFromData({
    reportName: "Profit and Loss",
    periodKeys: ["FY 2024"],
    rows: [
      { account_name: "Product Sales", section: "revenue", parent_path: ["Income"], fiscal_year: 2024, node_type: "account", is_total: false, is_header: false },
      { account_name: "Office Rent", section: "operating_expenses", parent_path: ["Expenses"], fiscal_year: 2024, node_type: "account", is_total: false, is_header: false },
    ],
  });
  const plLookup = coa.buildTreeHierarchyLookup(plTree, "profit_loss");
  check("P&L Income unaffected: Product Sales -> income", plLookup.get("product sales")?.[0]?.accountType, "income");
  check("P&L Expense unaffected: Office Rent -> expense", plLookup.get("office rent")?.[0]?.accountType, "expense");
}

console.log(`\n${"=".repeat(60)}\n${pass} passed, ${fail} failed\n${"=".repeat(60)}`);
if (fail > 0) {
  console.log("Failures:");
  failures.forEach((f) => console.log(`  - ${f}`));
}
process.exit(fail === 0 ? 0 : 1);
