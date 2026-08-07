// ============================================================================
// Key Reports — vendor reference data for the EBITDA adjustment editor.
//
// SOURCE OF TRUTH: general_ledger_entries, and nothing else. The vendor/customer
// columns are populated by the Key Reports extraction pipeline itself, so this
// reads them back directly:
//
//   SELECT DISTINCT vendor FROM general_ledger_entries
//    WHERE company_id = ? AND version_id = ?
//      AND vendor IS NOT NULL AND TRIM(vendor) <> ''
//
// (expressed through the Supabase client + fetchAllRows below, because
// PostgREST caps an unpaginated read at ~1000 rows — see pagedFetch).
//
// DELIBERATELY NOT USED — the EBITDA page previously took its vendors from the
// Manual GL Upload path (ebitdaAdjustmentService.loadVendorReferenceData ->
// getManualStagedProfitLossVendorDetail), which reads the manual staging tables.
// A Key Reports version has no rows there, which is why the dropdown always
// read "No vendors found". No manual_gl table, no staging table, no cached
// vendor list and no legacy vendor API is consulted here.
//
// Why the per-account breakdown is returned as well as the flat list: the
// adjustment editor narrows the dropdown to the vendors that actually posted to
// the account the adjustment is linked to, and falls back to the full list when
// the account has none. Computing that server-side keeps it one query instead of
// one per account.
// ============================================================================

const { supabase } = require("../../db");
const { fetchAllRows } = require("./pagedFetch");

const TABLE_GL = "general_ledger_entries";

// A GL row that represents a real posting. A missing row_type predates the
// tagging migration and only ever held real postings; BEGINNING_BALANCE and
// TOTAL_ROW carry no vendor attribution worth surfacing.
function isPostingRow(row) {
  const t = row?.row_type;
  return !t || t === "TRANSACTION";
}

const clean = (v) => String(v ?? "").trim();

function yearOf(row) {
  const y = Number(String(row?.transaction_date || "").slice(0, 4));
  return Number.isInteger(y) && y > 1900 ? y : null;
}

/**
 * Distinct vendors for a version, with per-account attribution and totals.
 *
 * @param {string} companyId
 * @param {string} versionId
 * @param {object} [opts]
 * @param {string} [opts.accountName] restrict to one account (the dropdown is
 *   account-specific when the adjustment is linked to an account)
 * @param {"vendor"|"customer"} [opts.field="vendor"] which counterparty column
 * @returns {Promise<{
 *   vendors: Array<{ label, total, yearlyTotals, accounts: string[] }>,
 *   accounts: Array<{ label, total, yearlyTotals, vendors: string[] }>,
 *   years: number[],
 * }>}
 */
async function getVendorReference(companyId, versionId, opts = {}) {
  const field = opts.field === "customer" ? "customer" : "vendor";
  const accountFilter = clean(opts.accountName).toLowerCase();

  if (!companyId || !versionId) return { vendors: [], accounts: [], years: [] };

  const rows = await fetchAllRows(() => {
    let q = supabase
      .from(TABLE_GL)
      .select(`account_name, account_section, ${field}, amount, transaction_date, row_type`)
      .eq("company_id", companyId)
      .eq("version_id", versionId)
      .not(field, "is", null);
    return q;
  });

  const vendorMap = new Map(); // vendor -> { label, total, yearlyTotals, accounts:Map }
  const accountMap = new Map(); // account -> { label, total, yearlyTotals, vendors:Set }
  const years = new Set();

  for (const row of rows || []) {
    if (!isPostingRow(row)) continue;
    const vendor = clean(row[field]);
    if (!vendor) continue; // TRIM(vendor) <> ''
    const account = clean(row.account_name || row.account_section);
    if (accountFilter && account.toLowerCase() !== accountFilter) continue;

    const amount = Number(row.amount) || 0;
    const year = yearOf(row);
    if (year) years.add(year);

    if (!vendorMap.has(vendor)) {
      vendorMap.set(vendor, { label: vendor, total: 0, yearlyTotals: {}, accounts: new Map() });
    }
    const v = vendorMap.get(vendor);
    v.total += amount;
    if (year) v.yearlyTotals[year] = (v.yearlyTotals[year] || 0) + amount;
    if (account) v.accounts.set(account, (v.accounts.get(account) || 0) + amount);

    if (account) {
      if (!accountMap.has(account)) {
        accountMap.set(account, { label: account, total: 0, yearlyTotals: {}, vendors: new Set() });
      }
      const a = accountMap.get(account);
      a.total += amount;
      if (year) a.yearlyTotals[year] = (a.yearlyTotals[year] || 0) + amount;
      a.vendors.add(vendor);
    }
  }

  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const roundMap = (obj) => Object.fromEntries(Object.entries(obj).map(([k, n]) => [k, round2(n)]));

  const vendors = [...vendorMap.values()]
    .map((v) => ({
      label: v.label,
      total: round2(v.total),
      yearlyTotals: roundMap(v.yearlyTotals),
      accounts: [...v.accounts.keys()].sort((a, b) => a.localeCompare(b)),
    }))
    // Largest exposure first, then alphabetical — same ordering the adjustment
    // editor already uses for the Manual GL list, so the control behaves
    // identically whichever source is selected.
    .sort((a, b) => Math.abs(b.total) - Math.abs(a.total) || a.label.localeCompare(b.label));

  const accounts = [...accountMap.values()]
    .map((a) => ({
      label: a.label,
      total: round2(a.total),
      yearlyTotals: roundMap(a.yearlyTotals),
      vendors: [...a.vendors].sort((x, y) => x.localeCompare(y)),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  return { vendors, accounts, years: [...years].sort((a, b) => b - a) };
}

module.exports = { getVendorReference };
