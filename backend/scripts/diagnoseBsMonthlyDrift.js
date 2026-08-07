/**
 * Diagnose the monthly Balance Sheet drift.
 *
 * SYMPTOM this isolates: the generated monthly Balance Sheet is offset from the
 * uploaded document by a CONSTANT amount per account, across every month of a
 * year — e.g. Accounts Receivable (A/R) ran +64,411.80 high in every month of
 * FY2024, including December, where the Trial Balance and the uploaded sheet
 * agree exactly.
 *
 * WHAT IS ALREADY RULED OUT (don't re-test these):
 *   - the ending-BS seed  (matches TB closing to 0.00)
 *   - the year-end anchors (uploaded 2024/2025 both match TB closing exactly)
 *   - BEGINNING_BALANCE rows leaking in as movement (their `amount` is null)
 *   - double-seeding from lifetimeBalances (lifetime net != the offset)
 *
 * WHAT THIS TESTS: whether aggregateGLForBSByMonth's summed monthly movement
 * for an account equals that account's Trial Balance yearly net. The backward
 * engine unwinds using those monthly movements, so if they disagree with the TB
 * the walk lands short by exactly the difference — which is the signature we see.
 *
 * A likely cause it will expose: aggregateGLForBSByMonth keys accounts as
 *   row.coa_id || ('unlinked:' + name)
 * so an account whose GL rows are only PARTIALLY linked to a coa_id splits into
 * two buckets, and the unwind applies only one of them.
 *
 * Usage:
 *   node backend/scripts/diagnoseBsMonthlyDrift.js --versionId=<uuid> [--account="Accounts Receivable"]
 */

require('dotenv').config();
const path = require('path');
const { supabase } = require(path.join(__dirname, '..', 'src', 'db'));
const { aggregateGLForBSByMonth } = require(path.join(__dirname, '..', 'src', 'services', 'keyReports', 'keyReportReportService'));

function arg(name, dflt = null) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}

const versionId = arg('versionId');
const accountFilter = arg('account', '');
if (!versionId) {
  console.error('Usage: node backend/scripts/diagnoseBsMonthlyDrift.js --versionId=<uuid> [--account="A/R"]');
  process.exit(1);
}

const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;

(async () => {
  const { data: tbAll, error } = await supabase
    .from('trial_balance_entries')
    .select('fiscal_year, account_name, account_type, opening_balance, net_balance, closing_balance')
    .eq('version_id', versionId);
  if (error) throw error;

  const years = [...new Set((tbAll || []).map((r) => Number(r.fiscal_year)))].sort();
  const BS_TYPES = ['asset', 'liability', 'equity'];

  let grandMismatch = 0;

  for (const year of years) {
    const byMonth = await aggregateGLForBSByMonth(versionId, year);
    if (!byMonth) { console.log(`FY${year}: no monthly data`); continue; }

    // Sum every month's movement per account NAME (the TB has no coa_id, so
    // name is the only shared key — this is also what exposes a split bucket:
    // two keys with the same name collapse here but not in the engine).
    const summed = new Map();      // name -> total movement
    const keysPerName = new Map(); // name -> Set(bucket keys)  <-- the split detector
    for (const mData of byMonth.values()) {
      for (const [key, acc] of mData.bsMap) {
        const n = String(acc.name || '').trim().toLowerCase();
        if (!n) continue;
        summed.set(n, r2((summed.get(n) || 0) + Number(acc.net || 0)));
        if (!keysPerName.has(n)) keysPerName.set(n, new Set());
        keysPerName.get(n).add(key);
      }
    }

    const tb = (tbAll || []).filter((r) => Number(r.fiscal_year) === year
      && BS_TYPES.includes(String(r.account_type || '').toLowerCase()));

    console.log(`\n===== FY${year} — monthly movement vs Trial Balance net`);
    let printed = 0;
    for (const row of tb) {
      const n = String(row.account_name || '').trim().toLowerCase();
      if (accountFilter && !n.includes(accountFilter.trim().toLowerCase())) continue;
      const monthly = summed.get(n) ?? 0;
      const tbNet = r2(row.net_balance);
      const diff = r2(monthly - tbNet);
      const keys = keysPerName.get(n);
      const split = keys && keys.size > 1;
      if (Math.abs(diff) > 0.5 || split) {
        printed += 1;
        grandMismatch += Math.abs(diff);
        console.log(
          `  ${String(row.account_name).slice(0, 34).padEnd(36)}` +
          ` monthlySum=${String(monthly).padStart(13)}  tbNet=${String(tbNet).padStart(13)}` +
          `  DIFF=${String(diff).padStart(12)}` +
          (split ? `   << SPLIT INTO ${keys.size} BUCKETS: ${[...keys].join(' , ')}` : ''),
        );
      }
    }
    if (!printed) console.log('  (every account agrees — no drift from this year)');
  }

  console.log(`\ntotal absolute mismatch across all years: ${r2(grandMismatch)}`);
  console.log(`
INTERPRETING THIS
  * DIFF != 0 for an account  -> the monthly aggregation disagrees with the TB.
      The backward walk unwinds with these monthly numbers, so it lands short by
      exactly this amount. Fix the aggregation, not the walk.
  * "SPLIT INTO n BUCKETS"    -> confirmed cause: the same account is being
      tracked under more than one key (coa_id vs "unlinked:<name>"). Fix by
      resolving every GL row to a coa_id before aggregating (run linkGlToCoa),
      or by keying the bsMap on the resolved account NAME instead of coa_id.
  * All DIFF = 0              -> the aggregation is fine; the defect is in the
      backward walk itself (generateMonthlyBalanceSheetsReverse), and the right
      move is to switch monthly generation to the FORWARD path:
          month_end(acct, m) = TB opening(acct, year) + sum(GL movement Jan..m)
      which is correct by construction and needs no unwinding.
`);
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
