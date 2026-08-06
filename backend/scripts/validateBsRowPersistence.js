// Balance Sheet row-persistence regression harness (migration 085 / row_type).
// No DB access -- pure function tests against balanceSheetExtractionService's
// filterRowsBeforeInsertion override (persist EVERY row, tagged with
// row_type) and a guard proving every OTHER extraction subclass keeps its
// original drop-before-insert behavior unchanged.
//
// Run: node backend/scripts/validateBsRowPersistence.js

const path = require("path");
const bs = require(path.join(__dirname, "..", "src", "services", "keyReports", "balanceSheetExtractionService.js"));
const gl = require(path.join(__dirname, "..", "src", "services", "keyReports", "generalLedgerExtractionService.js"));

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

// Mirrors chartOfAccountsService.js's collectBsAccountsFromEntries filter
// predicate (that function is not exported, so this is a manually-kept-in-sync
// copy of the one-line rule: only row_type='account' or legacy NULL rows are
// real COA posting accounts).
const isPostingRow = (r) => !r.row_type || r.row_type === "account";

function row(overrides) {
  return {
    account_name: "Some Account",
    account_number: null,
    as_of_date: "2024-12-31",
    fiscal_year: 2024,
    section: "assets",
    sub_section: null,
    parent_path: null,
    amount: 100,
    is_section_header: false,
    node_type: "account",
    is_total: false,
    ...overrides,
  };
}

console.log("\n=== A worked Balance Sheet document (Assets > Current Assets > Bank Accounts > 2 banks > subtotal > Total) ===");
{
  const docRows = [
    row({ account_name: "Assets", is_section_header: true, amount: 0 }),
    row({ account_name: "Current Assets", is_section_header: true, amount: 0 }),
    row({ account_name: "Bank Accounts", node_type: "hierarchy_group", amount: 0 }),
    row({ account_name: "Chase Bank", amount: 1000 }),
    row({ account_name: "Bank of America", amount: 2000 }),
    row({ account_name: "Total for Bank Accounts", amount: 3000, is_total: true }),
    row({ account_name: "Total Assets", amount: 3000, is_total: true }),
    row({ account_name: "Accrual Basis Thursday, June 04, 2026", amount: 0 }),
  ];
  const transformed = bs.transformRows(docRows, { versionId: "v1", companyId: "c1", documentId: "d1", uploadId: "u1", fileName: "test.xlsx" });
  const { filteredRows, skippedLog } = bs.filterRowsBeforeInsertion(transformed);

  check("1. Every source row is persisted (8 in, 8 out)", filteredRows.length, docRows.length);
  check("2. Nothing appears in skippedLog (nothing silently dropped)", skippedLog.length, 0);

  const byName = new Map(filteredRows.map((r) => [r.account_name, r]));
  check("3. Heading row 'Assets' persisted as row_type=heading", byName.get("Assets")?.row_type, "heading");
  check("4. Heading row 'Bank Accounts' persisted as row_type=heading (unrecognized group label, hierarchy_level=0)", byName.get("Bank Accounts")?.row_type, "heading");
  check("5. Posting account 'Chase Bank' persisted as row_type=account", byName.get("Chase Bank")?.row_type, "account");
  check("6. Posting account 'Bank of America' persisted as row_type=account", byName.get("Bank of America")?.row_type, "account");
  check("7. Subtotal 'Total for Bank Accounts' persisted as row_type=subtotal", byName.get("Total for Bank Accounts")?.row_type, "subtotal");
  check("8. Statement total 'Total Assets' persisted as row_type=total", byName.get("Total Assets")?.row_type, "total");
  check("9. Metadata row (report banner) persisted as row_type=metadata", byName.get("Accrual Basis Thursday, June 04, 2026")?.row_type, "metadata");

  checkTrue("10. Original document row order preserved (sort_order is 0..7 in input order)",
    filteredRows.every((r, i) => r.sort_order === i));

  const uniqueNamesInOrder = filteredRows.map((r) => r.account_name);
  check("11. Row sequence matches source document order exactly",
    uniqueNamesInOrder, docRows.map((r) => r.account_name));

  console.log("\n  COA generation must exclude every non-account row from posting accounts:");
  const postingAccounts = filteredRows.filter(isPostingRow).map((r) => r.account_name);
  check("12. COA-generation filter keeps ONLY the 2 real posting accounts", postingAccounts, ["Chase Bank", "Bank of America"]);
  checkTrue("13. COA-generation filter excludes the subtotal ('Total for Bank Accounts') as a posting account",
    !postingAccounts.includes("Total for Bank Accounts"));
  checkTrue("14. COA-generation filter excludes the statement total ('Total Assets') as a posting account",
    !postingAccounts.includes("Total Assets"));
  checkTrue("15. COA-generation filter excludes heading rows as posting accounts",
    !postingAccounts.includes("Assets") && !postingAccounts.includes("Bank Accounts"));
}

console.log("\n=== Legacy rows (persisted before migration 085, row_type is NULL) stay COA-safe ===");
{
  const legacyAccountRow = { account_name: "Chase Bank", row_type: null };
  const legacyHeadingRow = { account_name: "Assets", row_type: null };
  checkTrue("16. A legacy account-shaped row (row_type=NULL) still passes the COA-generation filter", isPostingRow(legacyAccountRow));
  // Legacy rows never included headings at all (old drop-before-insert
  // behavior meant they were never persisted) -- this just documents that a
  // NULL row_type is treated as safe/account by the filter, matching that
  // historical guarantee. It is not a real observed case in practice.
  checkTrue("17. A NULL row_type is treated as account-safe by the COA-generation filter (backward compat)", isPostingRow(legacyHeadingRow));
}

console.log("\n=== Multi-document isolation: two documents' rows are independently classified ===");
{
  const doc1Rows = [row({ account_name: "Checking", amount: 500 })];
  const doc2Rows = [row({ account_name: "Checking", amount: 999 })];
  const t1 = bs.transformRows(doc1Rows, { versionId: "v1", companyId: "c1", documentId: "docA", uploadId: "u1", fileName: "a.xlsx" });
  const t2 = bs.transformRows(doc2Rows, { versionId: "v1", companyId: "c1", documentId: "docB", uploadId: "u2", fileName: "b.xlsx" });
  check("18. Document A's row is tagged with document A's source_file_id", t1[0].source_file_id, "docA");
  check("19. Document B's row is tagged with document B's source_file_id (independent, not overwritten)", t2[0].source_file_id, "docB");
  checkTrue("20. Same account name/amount collision across documents still produces distinct row_hash (uniqueness relies on documentId)",
    t1[0].row_hash !== t2[0].row_hash);
}

console.log("\n=== Regression guard: every OTHER extraction subclass keeps its original drop-before-insert behavior ===");
{
  const headingRow = { account_name: "Assets", hierarchy_level: 0 };
  const accountRow = { account_name: "Chase Bank", hierarchy_level: 1 };
  const { filteredRows: glFiltered, skippedLog: glSkipped } = gl.filterRowsBeforeInsertion([headingRow, accountRow]);
  check("21. GL extraction still DROPS the heading row (unchanged base-class behavior)", glFiltered.length, 1);
  check("22. GL extraction's surviving row is the real account row", glFiltered[0]?.account_name, "Chase Bank");
  checkTrue("23. GL extraction still logs the drop via skippedLog (not silently absorbed like BS)", glSkipped.length === 1);
  checkTrue("24. GL's filteredRows never carry a row_type field (BS-only concept)", glFiltered.every((r) => r.row_type === undefined));
}

console.log(`\n${"=".repeat(60)}\n${pass} passed, ${fail} failed\n${"=".repeat(60)}`);
if (fail > 0) {
  console.log("Failures:");
  failures.forEach((f) => console.log(`  - ${f}`));
}
process.exit(fail === 0 ? 0 : 1);
