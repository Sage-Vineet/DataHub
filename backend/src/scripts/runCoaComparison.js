// ============================================================================
// Runner: Chart of Accounts vs Balance Sheet / Profit & Loss comparison
//
// For a company, compares:
//   1. COA (balance_sheet) accounts  vs  Balance Sheet accounts
//   2. COA (profit_loss)  accounts   vs  Profit & Loss accounts
// and prints which records are present in both and which are missing.
//
// P&L accounts are derived from the GL (accounts that are NOT in the balance
// sheet), because there is no dedicated profit_loss source table.
//
// Usage (from the backend/ directory):
//   node src/scripts/runCoaComparison.js [companyId]
// ============================================================================

require("dotenv").config();
const { supabase } = require("../db");
const { compareSideBySide } = require("../services/buisenessLogic");

const PAGE_SIZE = 1000;

// Fetch every value of the selected columns from `table` (paged) for a company.
async function fetchRows(table, columns, companyId) {
  const out = [];
  let from = 0;
  for (let page = 0; page < 1000; page += 1) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .eq("company_id", companyId)
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return out;
}

// Distinct, non-empty, order-preserving.
function uniqueNames(values) {
  const seen = new Set();
  const out = [];
  for (const v of values) {
    const name = String(v ?? "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

// Pick the company with the most balance_sheet_entries rows.
async function autoPickCompany() {
  const { data, error } = await supabase
    .from("balance_sheet_entries")
    .select("company_id")
    .limit(5000);
  if (error) throw new Error(error.message);
  const counts = new Map();
  for (const r of data || []) {
    if (!r.company_id) continue;
    counts.set(r.company_id, (counts.get(r.company_id) || 0) + 1);
  }
  let best = null;
  let bestCount = -1;
  for (const [id, c] of counts) {
    if (c > bestCount) { best = id; bestCount = c; }
  }
  return best;
}

(async () => {
  try {
    const companyId = process.argv[2] || (await autoPickCompany());
    if (!companyId) {
      console.error("No company found with balance sheet data. Pass a companyId explicitly.");
      process.exit(1);
    }
    console.log(`Using companyId: ${companyId}`);

    // --- Chart of Accounts: keep only LEAF posting accounts, not structural
    //     rollup nodes (Total Assets, Current Assets, Bank Accounts, ...).
    //     A row is a structural node when another COA row points to it as a
    //     parent_account_id; leaf = never referenced as a parent. ---
    const coaRows = await fetchRows(
      "chart_of_accounts",
      "id, account_name, statement_type, parent_account_id",
      companyId,
    );
    const parentIds = new Set(coaRows.map((r) => r.parent_account_id).filter(Boolean));
    const coaLeaves = coaRows.filter((r) => !parentIds.has(r.id));

    const coaBsAccounts = uniqueNames(
      coaLeaves.filter((r) => r.statement_type === "balance_sheet").map((r) => r.account_name),
    );
    const coaPnlAccounts = uniqueNames(
      coaLeaves.filter((r) => r.statement_type === "profit_loss").map((r) => r.account_name),
    );

    // --- Uploaded Balance Sheet accounts (exclude subtotal / total rows) ---
    const bsRows = await fetchRows("balance_sheet_entries", "account_name, is_total", companyId);
    const bsAccounts = uniqueNames(
      bsRows.filter((r) => r.is_total !== true).map((r) => r.account_name),
    );

    // --- Profit & Loss accounts: GL accounts NOT present in the balance sheet ---
    const glAccounts = uniqueNames(
      (await fetchRows("general_ledger_entries", "account_name", companyId)).map((r) => r.account_name),
    );
    const bsKeySet = new Set(bsAccounts.map((n) => n.toLowerCase()));
    const pnlAccounts = glAccounts.filter((n) => !bsKeySet.has(n.toLowerCase()));

    console.log(`\nCOA balance-sheet posting accounts (leaves): ${coaBsAccounts.length}`);
    console.log(`COA profit-loss posting accounts (leaves):   ${coaPnlAccounts.length}`);
    console.log(`Uploaded Balance Sheet accounts:             ${bsAccounts.length}`);
    console.log(`P&L accounts (from GL):                      ${pnlAccounts.length}`);

    // 1. Balance Sheet (left) vs COA balance-sheet posting accounts (right)
    console.log("\n\n############### BALANCE SHEET  vs  COA ###############");
    compareSideBySide("BALANCE SHEET ACCOUNT", bsAccounts, "COA ACCOUNT", coaBsAccounts);

    // 2. Profit & Loss (left) vs COA profit-loss posting accounts (right)
    console.log("\n\n############### PROFIT & LOSS  vs  COA ###############");
    compareSideBySide("P&L ACCOUNT (from GL)", pnlAccounts, "COA ACCOUNT", coaPnlAccounts);

    process.exit(0);
  } catch (err) {
    console.error("Comparison failed:", err.message);
    process.exit(1);
  }
})();
