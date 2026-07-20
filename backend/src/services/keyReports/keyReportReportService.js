

const { supabase } = require('../../db');
const generatedReportSnapshots = require('./generatedReportSnapshotService');
const { buildCashFlow, generatedCfToRows } = require('../manualCashFlowService');
const { fetchAllRows } = require('./pagedFetch');
// chartOfAccountsService — ensureAccountExistsInCoa removed; COA is completed in Phase 2c before reports run
const { listEbitdaAdjustments } = require('../ebitdaAdjustmentStore');
// NOTE: financialStatementService is lazy-required inside getQoeReport / getKpiReport
// to avoid the circular dependency: financialStatementService → keyReportReportService.


// ─── helpers ─────────────────────────────────────────────────────────────────

function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Leading account code in a GL account name ("4035 Cast Bronze" → "4035",
// "4035 INCOME - REVENUE:Cast Bronze" → "4035"). It is the one key shared by
// both the leaf and full-hierarchy-path spellings of the same account. The
// split_account fallbacks below dedup on it so a QuickBooks "by-account" GL
// (where every account has its own posting section, addressed by its leaf name,
// while split_account carries the full path) does not count each revenue/expense
// account twice — once from its own section and again from the offsetting split
// rows — which otherwise doubles Net Income and unbalances the Balance Sheet.
function glLeadingCode(name) {
  const m = String(name || "").trim().match(/^(\d{3,7})\b/);
  return m ? m[1] : null;
}

// Canonical identity keys for a GL account name, robust to the leaf-vs-full-path
// and numbered-vs-unnumbered spelling differences between the posting
// (account_name) and offsetting (split_account) sides of the same account:
//   "4035 Cast Bronze"                  → code "4035", leaf "cast bronze"
//   "4035 INCOME - REVENUE:Cast Bronze" → code "4035", leaf "cast bronze"
//   "RV Sign Income" / "4200 RV Sign Income" → leaf "rv sign income" (+ code)
// The split_account fallbacks skip any split that shares ANY key with an account
// already posting its own section, so a full "by-account" GL is never
// double-counted.
function glAcctKeys(name) {
  const s = String(name || "").trim();
  const keys = [];
  const code = glLeadingCode(s);
  if (code) keys.push("c:" + code);
  const leaf = s.split(":").pop().replace(/^\d{3,7}[\s\-.]+/, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (leaf) keys.push("l:" + leaf);
  return keys;
}

// A persisted generated_report_snapshots row (P&L / Cash Flow) is only refreshed
// by a full Sync (forceGenerate+persist). Chart of Accounts reclassification
// (regenerate / manual edit / reset — see routes/keyReports.js) writes directly to
// chart_of_accounts and does NOT touch the snapshot, so a snapshot generated before
// the latest COA change would silently keep serving stale section totals (including
// Net Income) even though the COA — and any live, non-cached view built from it —
// is already correct. Treat the snapshot as stale whenever the COA was touched at
// or after it was generated, so the caller falls back to a live recompute instead.
async function isSnapshotStale(versionId, generatedAt) {
  if (!generatedAt) return true;
  try {
    const { data, error } = await supabase
      .from('chart_of_accounts')
      .select('updated_at')
      .eq('version_id', versionId)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data?.updated_at) return false; // no COA rows / column missing → trust the snapshot
    return new Date(data.updated_at).getTime() >= new Date(generatedAt).getTime();
  } catch {
    return false; // never let a staleness check itself break report generation
  }
}

// Standardized audit log required by the Key Reports report contract (spec #14).
// Emitted ONCE PER FISCAL YEAR so it is provable, per year, which table the data
// came from and whether the year was generated from GL or rendered directly from
// an extracted report table. NO Manual GL endpoint is ever involved.
//   [KEY_REPORTS_REPORT] { versionId, sourceType, fiscalYear, rowsRead,
//                          generatedFromGL, generatedFromExtractedReport }
function auditReport(versionId, sourceType, fiscalYear, rowsRead, opts = {}) {
  console.log('[KEY_REPORTS_REPORT]', {
    versionId,
    sourceType,
    fiscalYear: fiscalYear ?? null,
    rowsRead: Number(rowsRead) || 0,
    generatedFromGL: Boolean(opts.generatedFromGL),
    generatedFromExtractedReport: Boolean(opts.generatedFromExtractedReport),
  });
}

/** Distinct fiscal years present in any entry table for this version. */
async function getDistinctYears(table, versionId, yearCol, isDateCol = false) {
  let data;
  try {
    data = await fetchAllRows(() => supabase.from(table).select(yearCol).eq('version_id', versionId));
  } catch (_e) { return []; }
  if (!data) return [];
  const set = new Set();
  for (const row of data) {
    const raw = row[yearCol];
    if (raw == null) continue;
    const year = isDateCol ? parseInt(String(raw).slice(0, 4), 10) : Number(raw);
    if (year >= 1990 && year <= 2100) set.add(year);
  }
  return Array.from(set).sort((a, b) => a - b);
}

// ─── Fiscal-year resolution (date filters → year list, spec #11–#13) ──────────

/**
 * Resolve the list of fiscal years a report should render, driven by the date
 * filter the user picked on the Reports page.
 *
 *   - Explicit single `year`            → [year]
 *   - `startDate`/`endDate` range       → every year that HAS data and whose year
 *                                          falls inside [start.year, end.year].
 *       01/01/2022–31/12/2025 → [2022,2023,2024,2025]   (spec #12)
 *       01/01/2022–31/12/2022 → [2022]                  (spec #13)
 *   - nothing                           → every year that has data.
 *
 * "Has data" = the year appears in balance_sheet_entries OR general_ledger_entries.
 * P&L has no table — its years are implied by the GL (the P&L source). A year that
 * exists only in GL is still offered, and empty years never produce blank columns.
 */
async function resolveYears(versionId, { year, startDate, endDate } = {}) {
  if (year) {
    const y = parseInt(String(year), 10);
    return y > 0 ? [y] : [];
  }

  // GL years come from transaction_date directly (date_dimension refactor,
  // migration 069 — fiscal_year/fiscal_month no longer exist on
  // general_ledger_entries). getDistinctYears' isDateCol mode parses the year
  // out of the date string itself, so there is no longer a "fiscal_year is
  // null but transaction_date has it" split to fall back on.
  const [bsYears, glYears] = await Promise.all([
    getDistinctYears('balance_sheet_entries', versionId, 'fiscal_year'),
    getDistinctYears('general_ledger_entries', versionId, 'transaction_date', true),
  ]);

  const set = new Set([...bsYears, ...glYears]);

  let years = Array.from(set).filter((y) => y >= 1990 && y <= 2100).sort((a, b) => a - b);

  const lo = startDate ? parseInt(String(startDate).slice(0, 4), 10) : null;
  const hi = endDate ? parseInt(String(endDate).slice(0, 4), 10) : null;
  if (lo) years = years.filter((y) => y >= lo);
  if (hi) years = years.filter((y) => y <= hi);

  return years;
}

/** True when an extracted report table already holds rows for this fiscal year. */
async function hasExtractedRows(table, versionId, year) {
  let query = supabase
    .from(table)
    .select('id', { count: 'exact', head: true })
    .eq('version_id', versionId)
    .eq('fiscal_year', year);

  if (table === 'balance_sheet_entries' || table === 'profit_loss_entries') {
    query = query.or('is_generated.is.null,is_generated.eq.false');
  }

  const { count, error } = await query;
  if (error) return false;
  return (count || 0) > 0;
}

// ─── GL account classification (self-contained — no Manual GL dependency) ──────
//
// general_ledger_entries has no account_type column, so every account's type is
// resolved from the Chart of Accounts (the single classification authority —
// see chartOfAccountsService). There is no keyword/name-based fallback: an
// account not found in the COA resolves to 'unknown' and is surfaced via the
// unclassified/console.warn tracking already in aggregateGLByAccount /
// aggregateGLForBS below, not silently guessed.

function resolveReportTypeFromCoaType(accountType) {
  const t = String(accountType || '').toLowerCase();
  if (/asset/.test(t)) return 'asset';
  if (/liab/.test(t)) return 'liability';
  if (/equity|capital/.test(t)) return 'equity';
  if (/income|revenue/.test(t)) return 'revenue';
  if (/expense|cogs|cost/.test(t)) return 'expense';
  return 'unknown';
}

function coaLookupKey(name, accountNumber = null) {
  const normalizedName = String(name || '').trim().toLowerCase();
  const normalizedNumber = accountNumber ? String(accountNumber).trim().toLowerCase() : '';
  return `${normalizedNumber}::${normalizedName}`;
}

async function loadCoaAccountTypeLookup(versionId) {
  const lookup = new Map();
  const { data, error } = await supabase
    .from("chart_of_accounts")
    .select("account_name, adjusted_name, base_account, account_number, account_type, metadata")
    .eq("version_id", versionId);

  if (error) {
    console.warn(`[KeyReports][COA] Could not load account classification map: ${error.message}`);
    return lookup;
  }

  for (const row of data || []) {
    if (row.metadata?.is_group || !row.account_type) continue;
    for (const name of [row.account_name, row.adjusted_name, row.base_account]) {
      if (!String(name || '').trim()) continue;
      const numberedKey = coaLookupKey(name, row.account_number);
      const nameOnlyKey = coaLookupKey(name, null);
      if (!lookup.has(numberedKey)) lookup.set(numberedKey, row.account_type);
      if (!lookup.has(nameOnlyKey)) lookup.set(nameOnlyKey, row.account_type);
    }
  }
  return lookup;
}

function classifyAccountFromLookup(lookup, name, accountNumber = null) {
  if (!name) return 'unknown';
  const rawType = lookup.get(coaLookupKey(name, accountNumber))
    || lookup.get(coaLookupKey(name, null));
  return resolveReportTypeFromCoaType(rawType);
}

// ─── Root Cause 8: temporary per-account diagnostic logging ───────────────────
// Off by default (zero cost — no extra query, no console output) since a real
// GL can have hundreds of accounts per year. Enable with
// KEY_REPORT_DIAGNOSTIC_LOG=on to print, for every GL account touched during
// report generation, exactly which Chart of Accounts row it resolved to and
// why — so a future reconciliation mismatch can be traced without re-running
// a one-off investigation script.
function diagnosticLogEnabled() {
  return String(process.env.KEY_REPORT_DIAGNOSTIC_LOG || '').toLowerCase() === 'on';
}

async function loadCoaDiagnosticLookup(versionId) {
  const lookup = new Map();
  if (!diagnosticLogEnabled()) return lookup;
  const { data, error } = await supabase
    .from('chart_of_accounts')
    .select('account_name, adjusted_name, base_account, account_number, account_type, hierarchy_path, classification_method, match_source, metadata')
    .eq('version_id', versionId);
  if (error || !data) return lookup;
  for (const row of data) {
    if (row.metadata?.is_group) continue;
    for (const name of [row.account_name, row.adjusted_name, row.base_account]) {
      if (!String(name || '').trim()) continue;
      const key = coaLookupKey(name, row.account_number);
      const nameOnlyKey = coaLookupKey(name, null);
      if (!lookup.has(key)) lookup.set(key, row);
      if (!lookup.has(nameOnlyKey)) lookup.set(nameOnlyKey, row);
    }
  }
  return lookup;
}

/**
 * Print one diagnostic line per GL account: name, resolved COA type/hierarchy,
 * classification provenance, AI confidence, whether it feeds Net Income, and
 * its final aggregated amount for the year. `includedInNi` / `reason` are
 * supplied by the caller since only it knows how the amount was actually used
 * (e.g. aggregateGLForBS's unknown-account override vs. a normal revenue/expense line).
 */
function logGlAccountDiagnostic(versionId, year, name, accountNumber, coaDiagLookup, finalAmount, includedInNi, reason) {
  if (!diagnosticLogEnabled()) return;
  const coaRow = coaDiagLookup.get(coaLookupKey(name, accountNumber)) || coaDiagLookup.get(coaLookupKey(name, null));
  console.log(
    `[KeyReports][Diagnostic] v=${versionId} FY${year} | Account="${name}" | COA Type=${coaRow?.account_type ?? 'MISSING'} | ` +
    `Hierarchy=${coaRow?.hierarchy_path ?? 'n/a'} | Classification Source=${coaRow?.classification_method ?? 'none'}/${coaRow?.match_source ?? 'none'} | ` +
    `AI Confidence=${coaRow?.metadata?.ai_confidence ?? 'n/a'} | Needs Review=${Boolean(coaRow?.metadata?.needs_review)} | ` +
    `Included in Net Income=${includedInNi} | Reason=${reason} | Final Amount=${Number(finalAmount || 0).toFixed(2)}`
  );
}

// QB GL uses natural-balance convention: increases in any account's natural
// direction are stored as positive amounts (asset debits positive, liability/
// equity/revenue credits positive, expense debits positive). No sign flip needed.
function naturalBalanceMovement(accountType, amount) {
  return safeNum(amount);
}

function netIncomeMovement(accountType, amount) {
  const value = safeNum(amount);
  // Natural-balance: revenue positive → adds to NI; expense/cogs positive → reduces NI.
  if (accountType === 'revenue') return value;
  if (accountType === 'expense' || accountType === 'cogs') return -value;
  return 0;
}

/** GL account key for a row — the account this row posts to. */
function glAccountName(row) {
  return (row.account_name && String(row.account_name).trim()) || '';
}

/** Signed movement (debit − credit) for a GL transaction row. */
function glNetMovement(row) {
  return safeNum(row.amount); // amount is the signed movement
}


async function fetchAllGLRows(versionId, year, columns, rowType = 'TRANSACTION') {
  const PAGE = 1000;
  const out = [];
  for (let from = 0; ; from += PAGE) {
    // fiscal_year no longer exists on general_ledger_entries (migration 069 —
    // date_dimension refactor); every row (including BEGINNING_BALANCE/TOTAL_ROW,
    // which the extractor now stamps with a Jan-1/Dec-31 sentinel date for their
    // year) has a real transaction_date, so a plain range filter is sufficient —
    // no more null-fiscal_year fallback needed.
    let q = supabase
      .from('general_ledger_entries')
      .select(columns)
      .eq('version_id', versionId)
      .gte('transaction_date', `${year}-01-01`)
      .lte('transaction_date', `${year}-12-31`);
    // Include pre-migration-050 rows that have null row_type (valid transaction rows).
    if (rowType) q = q.or(`row_type.eq.${rowType},row_type.is.null`);
    const { data, error } = await q
      .order('row_number', { ascending: true, nullsFirst: false })
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || !data.length) break;
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

/**
 * Read TRANSACTION GL rows for EXACTLY one fiscal year, aggregated per
 * account_name. Used for P&L report generation (existing callers).
 * Returns { accounts: Map(name→{net,type}), rowsRead }.
 */
async function aggregateGLByAccount(versionId, year) {
  const rows = await fetchAllGLRows(
    versionId, year,
    'account_name, split_account, amount, running_balance, row_type, transaction_date, account_number',
  );

  const coaTypes = await loadCoaAccountTypeLookup(versionId);
  const coaDiagLookup = await loadCoaDiagnosticLookup(versionId);

  // Accounts that already post their own account_name row this year — the
  // split_account fallback below only fires for revenue/expense accounts that
  // don't. Mirrors aggregateGLForBS's plDistSeen rule exactly so the P&L total
  // and the Balance Sheet/Cash Flow Net Income agree for the same version+year.
  const plDistSeen = new Set();
  const plDistKeys = new Set();
  for (const row of rows) {
    const n = glAccountName(row);
    if (!n) continue;
    const t = classifyAccountFromLookup(coaTypes, n, row.account_number);
    if (t === 'revenue' || t === 'expense') {
      plDistSeen.add(n);
      for (const k of glAcctKeys(n)) plDistKeys.add(k);
    }
  }

  const accounts = new Map();
  const unclassified = [];
  for (const row of rows) {
    const name = glAccountName(row);
    if (!name) continue;
    const type = classifyAccountFromLookup(coaTypes, name, row.account_number);
    if (type === 'unknown') {
      unclassified.push({
        transaction_date: row.transaction_date,
        account_name: row.account_name,
        split_account: row.split_account,
        amount: row.amount,
        running_balance: row.running_balance,
      });
    }
    if (!accounts.has(name)) accounts.set(name, { name, net: 0, type });
    accounts.get(name).net += glNetMovement(row);

    // P&L split fallback — same rule as aggregateGLForBS: pick up a
    // revenue/expense account that only appears via split_account this year
    // (e.g. a partial GL export), attributed as its own line under that name.
    const splitName = (row.split_account && String(row.split_account).trim()) || '';
    if (!splitName) continue;
    const splitType = classifyAccountFromLookup(coaTypes, splitName, null);
    const splitKeys = glAcctKeys(splitName);
    if ((splitType === 'revenue' || splitType === 'expense')
        && !plDistSeen.has(splitName)
        && !splitKeys.some((k) => plDistKeys.has(k))) {
      if (!accounts.has(splitName)) accounts.set(splitName, { name: splitName, net: 0, type: splitType });
      accounts.get(splitName).net += safeNum(row.amount);
    }
  }
  if (unclassified.length) {
    console.warn(`[KeyReports][GL] versionId=${versionId} FY${year}: ${unclassified.length} unclassified GL accounts:`,
      unclassified.map(u => `${u.account_name} (split:${u.split_account}) amt=${u.amount} rb=${u.running_balance}`).join(' | '));
  }
  if (diagnosticLogEnabled()) {
    for (const acc of accounts.values()) {
      const includedInNi = acc.type === 'revenue' || acc.type === 'expense';
      const reason = acc.type === 'revenue' ? 'revenue account — adds to Net Income'
        : acc.type === 'expense' ? 'expense account — reduces Net Income'
        : acc.type === 'cogs' ? 'cogs account — reduces Net Income'
        : acc.type === 'unknown' ? 'no Chart of Accounts match — excluded from this per-account P&L view (see aggregateGLForBS for the Net Income override)'
        : `${acc.type} account — Balance Sheet item, not part of Net Income`;
      logGlAccountDiagnostic(versionId, year, acc.name, null, coaDiagLookup, acc.net, includedInNi, reason);
    }
  }
  return { accounts, rowsRead: rows.length };
}

// Month-aware version of aggregateGLForBS. Groups GL rows by transaction_date month
// and returns a Map<monthNum, {bsMap, netIncome}> for cumulative monthly BS computation.
// Returns null when no rows have a valid transaction_date (monthly breakdown impossible).
async function aggregateGLForBSByMonth(versionId, year) {
  const rows = await fetchAllGLRows(
    versionId, year,
    'account_name, split_account, amount, row_type, transaction_date, account_number',
  );
  if (!rows.length) return null;

  const coaTypes = await loadCoaAccountTypeLookup(versionId);

  const plDistSeen = new Set();
  const plDistKeys = new Set();
  for (const row of rows) {
    const n = (row.account_name && String(row.account_name).trim()) || '';
    if (!n) continue;
    const t = classifyAccountFromLookup(coaTypes, n, row.account_number);
    if (t === 'revenue' || t === 'expense') {
      plDistSeen.add(n);
      for (const k of glAcctKeys(n)) plDistKeys.add(k);
    }
  }

  const byMonth = new Map();
  let hasDateData = false;

  for (const row of rows) {
    const dateStr  = String(row.transaction_date || '');
    const monthNum = parseInt(dateStr.slice(5, 7), 10);
    if (!(monthNum >= 1 && monthNum <= 12)) continue;
    hasDateData = true;

    if (!byMonth.has(monthNum)) byMonth.set(monthNum, { bsMap: new Map(), netIncome: 0 });
    const mData    = byMonth.get(monthNum);
    const distName = (row.account_name && String(row.account_name).trim()) || '';
    const splitName= (row.split_account && String(row.split_account).trim()) || '';
    const amount   = safeNum(row.amount);
    const distType = distName ? classifyAccountFromLookup(coaTypes, distName, row.account_number) : 'unknown';
    const splitType= splitName ? classifyAccountFromLookup(coaTypes, splitName, null) : 'unknown';

    if (distType === 'asset' || distType === 'liability' || distType === 'equity') {
      if (!mData.bsMap.has(distName)) mData.bsMap.set(distName, { net: 0, type: distType });
      mData.bsMap.get(distName).net += naturalBalanceMovement(distType, amount);
    } else if (distType === 'revenue' || distType === 'expense') {
      mData.netIncome += netIncomeMovement(distType, amount);
    }

    // P&L split fallback
    const splitKeys = glAcctKeys(splitName);
    if (splitName && (splitType === 'revenue' || splitType === 'expense')
        && !plDistSeen.has(splitName)
        && !splitKeys.some((k) => plDistKeys.has(k))) {
      mData.netIncome += amount;
    }
  }

  return hasDateData ? byMonth : null;
}

async function aggregateGLForBS(versionId, year) {
  const rows = await fetchAllGLRows(
    versionId, year,
    'account_name, split_account, amount, running_balance, row_type, transaction_date, account_number',
  );

  const coaTypes = await loadCoaAccountTypeLookup(versionId);
  const coaDiagLookup = await loadCoaDiagnosticLookup(versionId);

  const plDistSeen = new Set();
  const plDistKeys = new Set();
  for (const row of rows) {
    const n = (row.account_name && String(row.account_name).trim()) || '';
    if (!n) continue;
    const t = classifyAccountFromLookup(coaTypes, n, row.account_number);
    if (t === 'revenue' || t === 'expense') {
      plDistSeen.add(n);
      for (const k of glAcctKeys(n)) plDistKeys.add(k);
    }
  }

  const bsMap = new Map();
  let netIncome = 0;
  const unclassified = [];
  const unclassifiedNetByName = new Map(); // diagnostic-only accumulator, see below

  for (const row of rows) {
    const distName = (row.account_name && String(row.account_name).trim()) || '';
    const splitName = (row.split_account && String(row.split_account).trim()) || '';
    const amount = safeNum(row.amount);

    const distType = distName ? classifyAccountFromLookup(coaTypes, distName, row.account_number) : 'unknown';
    const splitType = splitName ? classifyAccountFromLookup(coaTypes, splitName, null) : 'unknown';

    // ── account_name (primary posting account) ─────────────────────────────
    if (distType === 'asset') {
      if (!bsMap.has(distName)) bsMap.set(distName, { net: 0, type: 'asset' });
      bsMap.get(distName).net += naturalBalanceMovement(distType, amount);
    } else if (distType === 'liability') {
      if (!bsMap.has(distName)) bsMap.set(distName, { net: 0, type: 'liability' });
      bsMap.get(distName).net += naturalBalanceMovement(distType, amount);
    } else if (distType === 'equity') {
      if (!bsMap.has(distName)) bsMap.set(distName, { net: 0, type: 'equity' });
      bsMap.get(distName).net += naturalBalanceMovement(distType, amount);
    } else if (distType === 'revenue') {
      // Revenue credits are positive in QB's natural-balance GL export → add to NI.
      netIncome += netIncomeMovement(distType, amount);
    } else if (distType === 'expense') {
      // Expense debits are positive → subtract from NI.
      netIncome += netIncomeMovement(distType, amount);
    } else {
      // Root Cause 5 fix: an account absent from chart_of_accounts (not
      // classified as asset/liability/equity/revenue/expense) must still
      // contribute to Net Income — money must never silently disappear.
      // Confirmed live: "Augusta Rule", 20 real transactions across 3 fiscal
      // years, previously entirely excluded from Net Income. Defaults to the
      // same natural-balance treatment as expense (debit-positive reduces
      // NI) — empirically verified correct for this exact case; a genuinely
      // revenue-like unclassified account would show as an unusually large
      // negative contribution here, which is still visible in `unclassified`
      // below for manual review, never silently gone.
      netIncome += netIncomeMovement('expense', amount);
      unclassified.push({
        transaction_date: row.transaction_date,
        account_name: row.account_name,
        split_account: row.split_account,
        amount: row.amount,
        running_balance: row.running_balance,
      });
      if (diagnosticLogEnabled()) {
        unclassifiedNetByName.set(distName, (unclassifiedNetByName.get(distName) || 0) + netIncomeMovement('expense', amount));
      }
    }

    // ── split_account ──────────────────────────────────────────────────────
    // Asset/Liability/Equity: NOT posted — QB already exports those accounts'
    // own account_name rows, so applying the inverse here causes double-counting.
    // P&L: contribute to Net Income only as a fallback for P&L accounts that
    // have no account_name row in this year's GL (e.g. partial exports).
    if (!splitName) continue;
    const splitKeys = glAcctKeys(splitName);
    if ((splitType === 'revenue' || splitType === 'expense')
        && !plDistSeen.has(splitName)
        && !splitKeys.some((k) => plDistKeys.has(k))) {
      // splitAmount = -amount; netIncome += -(splitAmount) = amount
      netIncome += amount;
    }
  }

  if (unclassified.length) {
    console.warn(
      `[KeyReports][BS][GL] versionId=${versionId} FY${year}: ${unclassified.length} unclassified account_name(s) — ` +
      `included in Net Income (treated as expense-like, natural-balance) but EXCLUDED from the Balance Sheet (no known asset/liability/equity type) — flagged for manual review:`,
      unclassified.map(u =>
        `  account_name="${u.account_name}" split_account="${u.split_account}" amount=${u.amount} running_balance=${u.running_balance} transaction_date=${u.transaction_date}`
      ).join('\n')
    );
  }

  if (diagnosticLogEnabled()) {
    for (const [name, acc] of bsMap) {
      logGlAccountDiagnostic(versionId, year, name, null, coaDiagLookup, acc.net, false, `${acc.type} account — Balance Sheet item, not part of Net Income`);
    }
    for (const [name, netAmount] of unclassifiedNetByName) {
      logGlAccountDiagnostic(versionId, year, name, null, coaDiagLookup, netAmount, true,
        'no Chart of Accounts match — Root Cause 5 override: included in Net Income (treated as expense-like, natural-balance), excluded from Balance Sheet, flagged for manual review');
    }
  }

  return { bsMap, netIncome, unclassified, rowsRead: rows.length };
}

// ─── GL → report generation (spec #6, #7, #8) ─────────────────────────────────

function slug(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 40);
}

/**
 * Build a single-year P&L tree purely from this year's GL transactions.
 * Revenue accounts (credit balances) render as positive income; expense accounts
 * (debit balances) render as positive expense. Only rows with fiscal_year = year
 * are used (spec #8) — guaranteed by aggregateGLByAccount.
 */
function buildPLFromGL(accounts, year) {
  const col = `y${year}`;
  const mk = (prefix, name, type, amount) => ({
    id: `${prefix}-${slug(name)}`,
    name,
    type,
    amount,
    amounts: { [col]: amount },
  });

  const revenue = [];
  const expense = [];
  for (const acc of accounts.values()) {
    // acc.type was already resolved from the COA by aggregateGLByAccount — no
    // second classification pass needed.
    if (acc.type === 'revenue') revenue.push({ name: acc.name, amount: acc.net });
    else if (acc.type === 'expense') expense.push({ name: acc.name, amount: acc.net });
  }
  const totalIncome = revenue.reduce((s, a) => s + a.amount, 0);
  const totalExpense = expense.reduce((s, a) => s + a.amount, 0);
  const netIncome = totalIncome - totalExpense;

  const incomeSection = {
    ...mk('section', 'Income', 'header', totalIncome),
    children: [
      ...revenue.map((r) => mk('entry', r.name, 'data', r.amount)),
      mk('total', 'Total Income', 'total', totalIncome),
    ],
  };
  const expenseSection = {
    ...mk('section', 'Expenses', 'header', totalExpense),
    children: [
      ...expense.map((r) => mk('entry', r.name, 'data', r.amount)),
      mk('total', 'Total Expenses', 'total', totalExpense),
    ],
  };

  return [incomeSection, expenseSection, mk('total', 'Net Income', 'total', netIncome)];
}

/** Accumulate a signed balance into a name→{name,balance,type} map. */
function addBalance(map, name, delta, type) {
  if (!map.has(name)) map.set(name, { name, balance: 0, type: type || 'unknown' });
  const entry = map.get(name);
  entry.balance += delta;
  if (type && (entry.type === 'unknown' || !entry.type)) entry.type = type;
}

/** Map of leaf-account closing balances taken directly from extracted BS entries. */
function extractedBalancesMap(entries) {
  const propagated = propagateMissingSection(entries);
  const map = new Map();
  for (const e of propagated) {
    const name = (e.account_name || '').trim();
    if (!name) continue;
    // "Net Income" on a QB Balance Sheet is a real equity line but is sometimes
    // marked is_total=true. Include it so the prior-year carry-forward gets the
    // correct NI amount to close into Retained Earnings.
    const isNetIncomeLine = /^net\s+income$/i.test(name);
    if (e.is_total && !isNetIncomeLine) continue;
    if (e.hierarchy_level === 0 && !e.is_total) continue; // pure section header
    const sec = e._resolvedSection;
    const type = sec === 'assets' ? 'asset' : sec === 'liabilities' ? 'liability' : sec === 'equity' ? 'equity' : 'unknown';
    map.set(name, { name, balance: safeNum(e.amount), type });
  }
  return map;
}

/**
 * Closing balances per account for a fiscal year, in natural sign
 * (assets +debit, liabilities/equity +credit). Implements the carry-forward
 * chain of spec #7:
 *
 *   BS(year) = BS(year-1 closing) + GL(year)
 *
 * - If an extracted Balance Sheet exists for `year`, its leaf balances are used
 *   verbatim (spec #5 — never regenerate when an extracted report exists).
 * - Otherwise prior-year closing is resolved recursively (extracted if present,
 *   else generated) and this year's GL movements are added on top. Current-year
 *   net income (revenue − expense) rolls into Retained Earnings so the sheet
 *   balances by double-entry construction.
 *
 * Returns { balances, rowsRead, generatedFromGL, asOfDate }.
 */
/**
 * Authoritative monthly balances: the latest month-end GENERATED snapshot for the
 * year (is_generated = true), produced by the Phase-4 monthly engine. When present
 * it takes precedence over any uploaded balance sheet (which is the opening seed +
 * reconciliation input only — client requirement).
 */
async function latestGeneratedBsForYear(versionId, year) {
  const { data: dr } = await supabase
    .from('balance_sheet_entries')
    .select('as_of_date')
    .eq('version_id', versionId)
    .eq('fiscal_year', year)
    .eq('is_generated', true)
    .order('as_of_date', { ascending: false })
    .limit(1);
  const asOf = dr?.[0]?.as_of_date;
  if (!asOf) return null;

  const { data, error } = await supabase
    .from('balance_sheet_entries')
    .select('account_name, account_type, section, amount')
    .eq('version_id', versionId)
    .eq('fiscal_year', year)
    .eq('is_generated', true)
    .eq('as_of_date', asOf);
  if (error || !data?.length) return null;

  const balances = new Map();
  for (const e of data) {
    const name = String(e.account_name || '').trim();
    if (!name) continue;
    const type = e.account_type
      || (e.section === 'assets' ? 'asset' : e.section === 'liabilities' ? 'liability' : e.section === 'equity' ? 'equity' : 'unknown');
    addBalance(balances, name, safeNum(e.amount), type);
  }
  return { balances, rowsRead: data.length, generatedFromGL: true, asOfDate: asOf };
}

async function bsBalancesForYear(versionId, year, depth = 0) {
  // Phase 4: a generated monthly snapshot is the authoritative Balance Sheet for
  // the year. Prefer it over uploaded entries / fresh GL carry-forward.
  const generated = await latestGeneratedBsForYear(versionId, year);
  if (generated) return generated;

  if (await hasExtractedRows('balance_sheet_entries', versionId, year)) {
    const { data, error } = await supabase
      .from('balance_sheet_entries')
      .select('account_name, account_type, section, amount, hierarchy_level, is_total, sort_order, fiscal_year, as_of_date')
      .eq('version_id', versionId)
      .eq('fiscal_year', year)
      .or('is_generated.is.null,is_generated.eq.false')
      .order('sort_order', { ascending: true, nullsFirst: false })
      .order('id', { ascending: true });
    if (error) throw error;
    const entries = data || [];
    const asOf = entries.reduce((acc, e) => (e.as_of_date && (!acc || e.as_of_date > acc) ? e.as_of_date : acc), null);
    return {
      balances: extractedBalancesMap(entries),
      rowsRead: entries.length,
      generatedFromGL: false,
      asOfDate: asOf || `${year}-12-31`,
    };
  }

  // No extracted BS for this year → generate from GL with carry-forward.
  const balances = new Map();
  let rowsRead = 0;

  // Prior-year closing (bounded recursion guards against runaway / missing data).
  // Year-end accounting close: prior "Net Income" rolls into Retained Earnings so
  // the new year opens with a clean Net Income line for the current period only.
  if (depth < 15 && year > 1990) {
    const prior = await bsBalancesForYear(versionId, year - 1, depth + 1);
    if (prior && prior.balances.size) {
      let priorNetIncome = 0;
      for (const [, v] of prior.balances) {
        if (/^net\s+income$/i.test(v.name.trim())) {
          priorNetIncome += v.balance;
        } else {
          addBalance(balances, v.name, v.balance, v.type);
        }
      }
      // Close prior-year Net Income into Retained Earnings (accounting year-end close).
      if (Math.abs(priorNetIncome) > 0.005) {
        addBalance(balances, 'Retained Earnings', priorNetIncome, 'equity');
      }
      rowsRead += prior.rowsRead;
    }
  }

  const { bsMap, netIncome, unclassified, rowsRead: glRows } = await aggregateGLForBS(versionId, year);
  rowsRead += glRows;

  for (const [name, acc] of bsMap) {
    // QB GL uses natural-balance convention: assets, liabilities, and equity all store
    // their movements as positive when the balance increases. No sign flip needed here —
    // netting at bsMap level already captures both debits and credits correctly.
    if (acc.type === 'asset') addBalance(balances, name, acc.net, 'asset');
    else if (acc.type === 'liability') addBalance(balances, name, acc.net, 'liability');
    else if (acc.type === 'equity') addBalance(balances, name, acc.net, 'equity');
  }
  // Current-year Net Income is a separate equity line — NOT merged into Retained Earnings.
  // RE = accumulated prior-year earnings; Net Income = this year only (matches QB presentation).
  if (Math.abs(netIncome) > 0.005) addBalance(balances, 'Net Income', netIncome, 'equity');

  return { balances, rowsRead, generatedFromGL: true, asOfDate: `${year}-12-31`, bsMap, unclassified };
}

/** Single-year BS tree from a natural-sign balances map (shape matches buildBSHierarchicalRows). */
function buildBSFromBalances(balances, year) {
  const col = `y${year}`;
  const groups = { assets: [], liabilities: [], equity: [] };
  for (const acc of balances.values()) {
    const section =
      acc.type === 'asset' ? 'assets' : acc.type === 'liability' ? 'liabilities' : acc.type === 'equity' ? 'equity' : null;
    if (!section) continue;
    if (Math.abs(acc.balance) < 0.005) continue;
    groups[section].push({ name: acc.name, amount: acc.balance });
  }

  const hierarchicalRows = [];
  const sectionTotals = { assets: 0, liabilities: 0, equity: 0 };

  for (const section of BS_SECTION_ORDER) {
    const items = groups[section];
    const total = items.reduce((s, i) => s + i.amount, 0);
    sectionTotals[section] = total;
    if (!items.length) continue;

    const children = items.map((i) => ({
      id: `bs-${section}-${slug(i.name)}`,
      name: i.name,
      type: 'data',
      amount: i.amount,
      amounts: { [col]: i.amount },
    }));
    children.push({
      id: `bs-${section}-total`,
      name: `Total ${BS_SECTION_LABELS[section]}`,
      type: 'total',
      amount: total,
      amounts: { [col]: total },
    });
    hierarchicalRows.push({
      id: section,
      name: BS_SECTION_LABELS[section],
      type: 'header',
      amount: total,
      amounts: { [col]: total },
      children,
    });
  }

  const le = sectionTotals.liabilities + sectionTotals.equity;
  hierarchicalRows.push({
    id: 'total-le',
    name: 'Total Liabilities and Equity',
    type: 'total',
    amount: le,
    amounts: { [col]: le },
  });

  return { hierarchicalRows, sectionTotals };
}


// ─── Month-view aggregation (spec #9) ─────────────────────────────────────────

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Aggregate one fiscal year's GL transactions per account AND per transaction
 * month (spec #9 — "group by transaction month"). Only fiscal_year = year rows
 * are read (spec #8). Returns { byAccount: Map(name→{type,months:Map(m→net)}),
 * monthsPresent: Set<1..12>, rowsRead }.
 */
async function aggregateGLByAccountMonth(versionId, year) {
  const rows = await fetchAllGLRows(
    versionId, year,
    'account_name, amount, transaction_date, row_type, account_number',
  );

  const coaTypes = await loadCoaAccountTypeLookup(versionId);

  const byAccount = new Map();
  const monthsPresent = new Set();
  for (const row of rows) {
    const name = glAccountName(row);
    if (!name || !row.transaction_date) continue;
    const month = parseInt(String(row.transaction_date).slice(5, 7), 10);
    if (!(month >= 1 && month <= 12)) continue;
    monthsPresent.add(month);
    if (!byAccount.has(name)) {
      const type = classifyAccountFromLookup(coaTypes, name, row.account_number);
      byAccount.set(name, { name, type, months: new Map() });
    }
    const acc = byAccount.get(name);
    acc.months.set(month, (acc.months.get(month) || 0) + glNetMovement(row));
  }
  return { byAccount, monthsPresent, rowsRead: rows.length };
}

/** Month column descriptors (Jan..Dec) for the months that have data. */
function monthCols(year, monthsPresent) {
  return Array.from(monthsPresent)
    .sort((a, b) => a - b)
    .map((m) => ({ key: `m${year}_${String(m).padStart(2, '0')}`, label: `${MONTH_ABBR[m - 1]} ${String(year).slice(-2)}`, month: m }));
}

/** Single-year monthly P&L tree from GL (income/expense summed per month). */
function buildPLFromGLMonthly(agg, year) {
  const cols = monthCols(year, agg.monthsPresent);
  const lastKey = cols.length ? cols[cols.length - 1].key : `m${year}_12`;
  const monthAmount = (acc, sign) => {
    const amounts = {};
    for (const c of cols) amounts[c.key] = sign * (acc.months.get(c.month) || 0);
    return amounts;
  };
  const sumCols = (...maps) => {
    const out = {};
    for (const c of cols) out[c.key] = maps.reduce((s, m) => s + (m[c.key] || 0), 0);
    return out;
  };

  const revenue = [];
  const expense = [];
  for (const acc of agg.byAccount.values()) {
    if (acc.type === 'revenue') revenue.push({ name: acc.name, amounts: monthAmount(acc, +1) });
    else if (acc.type === 'expense') expense.push({ name: acc.name, amounts: monthAmount(acc, +1) });
  }
  const totalIncome = sumCols(...revenue.map((r) => r.amounts));
  const totalExpense = sumCols(...expense.map((r) => r.amounts));
  const netIncome = {};
  for (const c of cols) netIncome[c.key] = (totalIncome[c.key] || 0) - (totalExpense[c.key] || 0);

  const node = (prefix, name, type, amounts, children) => ({
    id: `${prefix}-${slug(name)}`, name, type, amount: safeNum(amounts[lastKey]), amounts, ...(children ? { children } : {}),
  });

  const hierarchicalRows = [
    node('section', 'Income', 'header', totalIncome, [
      ...revenue.map((r) => node('entry', r.name, 'data', r.amounts)),
      node('total', 'Total Income', 'total', totalIncome),
    ]),
    node('section', 'Expenses', 'header', totalExpense, [
      ...expense.map((r) => node('entry', r.name, 'data', r.amounts)),
      node('total', 'Total Expenses', 'total', totalExpense),
    ]),
    node('total', 'Net Income', 'total', netIncome),
  ];
  return { hierarchicalRows, yearCols: cols };
}

// ─── P&L Summary ─────────────────────────────────────────────────────────────

/**
 * Build hierarchical P&L rows from flat profit_loss_entries.
 *
 * Strategy: walk rows in sort_order.
 *   hierarchy_level === 0 → section header (starts a new group).
 *   is_total === true      → total row for the current section (or a grand total).
 *   otherwise              → data row under the current section.
 *
 * When multiple fiscal years are requested the returned rows carry an `amounts`
 * map so the comparative columns renderer can work without further joins.
 */
function buildPLHierarchicalRows(entriesByYear, years) {
  if (!years.length) return [];

  // Build master account order as the UNION of all years, preserving the first
  // occurrence order. Using only the first year as master would silently drop
  // accounts that appear in later years but not the earliest one.
  const masterOrder = [];
  const masterSet = new Set();

  for (const y of years) {
    for (const entry of (entriesByYear[y] || [])) {
      const key = entry.account_name?.trim() || '';
      if (key && !masterSet.has(key)) {
        masterSet.add(key);
        masterOrder.push({
          key,
          isTotal: Boolean(entry.is_total),
          isHeader: entry.hierarchy_level === 0 && !entry.is_total,
        });
      }
    }
  }

  // For each name, gather amount per year.
  const amountLookup = {}; // name → { y2023: X, y2024: Y }
  for (const year of years) {
    const col = `y${year}`;
    for (const entry of (entriesByYear[year] || [])) {
      const key = entry.account_name?.trim() || '';
      if (!key) continue;
      if (!amountLookup[key]) amountLookup[key] = {};
      amountLookup[key][col] = safeNum(entry.amount);
    }
  }

  const yearCols = years.map(y => ({ key: `y${y}`, label: `FY ${y}` }));

  // Assemble the hierarchical tree.
  const result = [];
  let currentSection = null;

  for (const { key, isTotal, isHeader } of masterOrder) {
    const amounts = amountLookup[key] || {};
    // Primary amount: last available year
    const primaryAmount = safeNum(amounts[`y${years[years.length - 1]}`] || 0);

    if (isHeader) {
      currentSection = {
        id: `section-${key.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')}`,
        name: key,
        type: 'header',
        amount: 0,
        amounts,
        children: [],
      };
      result.push(currentSection);
    } else if (isTotal) {
      const node = {
        id: `total-${key.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')}`,
        name: key,
        type: 'total',
        amount: primaryAmount,
        amounts,
      };
      if (currentSection && !result.find(r => r === node)) {
        currentSection.amount = primaryAmount;
        currentSection.children.push(node);
      } else {
        result.push(node);
      }
    } else {
      const node = {
        id: `entry-${key.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')}`,
        name: key,
        type: 'data',
        amount: primaryAmount,
        amounts,
      };
      if (currentSection) {
        currentSection.children.push(node);
      } else {
        result.push(node);
      }
    }
  }

  return { hierarchicalRows: result, yearCols };
}

// ─── P&L year-view adapter (COA-tree engine → hierarchicalRows) ───────────────
//
// Converts financialStatementService's per-year `statement` object (the same
// COA parent_account_id-tree computation used by /reports/financial-statements,
// QoE, and KPI) into the generic hierarchicalRows tree the P&L tab already
// renders. This replaces the standalone GL-keyword-classified builder
// (buildPLFromGL) for the year view, so there is exactly one engine computing
// P&L numbers. The Chart of Accounts is the same for every year within a
// version, so multi-year columns are built by matching each account's stable
// systemId (falling back to name) across years — no separate merge pass needed.

function plRowSlug(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
}

function plAmountsAcrossYears(years, byYear, pick) {
  const amounts = {};
  for (const y of years) amounts[`y${y}`] = safeNum(pick(byYear.get(y)));
  return amounts;
}

function plFlatSection(id, label, years, byYear, getAccounts, getTotal) {
  const lastYear = years[years.length - 1];
  const lastAccounts = getAccounts(byYear.get(lastYear)) || [];
  const children = lastAccounts.map((a) => {
    const key = a.systemId || a.name;
    return {
      id: `entry-${plRowSlug(key)}`,
      name: a.adjustedName || a.name,
      type: 'data',
      amount: safeNum(a.amount),
      amounts: plAmountsAcrossYears(years, byYear, (stmt) => {
        const match = (getAccounts(stmt) || []).find((x) => (x.systemId || x.name) === key);
        return match ? match.amount : 0;
      }),
    };
  });
  const total = {
    id: `total-${plRowSlug(id)}`,
    name: `Total ${label}`,
    type: 'total',
    amount: safeNum(getTotal(byYear.get(lastYear))),
    amounts: plAmountsAcrossYears(years, byYear, getTotal),
  };
  return {
    id: `section-${plRowSlug(id)}`,
    name: label,
    type: 'header',
    amount: total.amount,
    amounts: total.amounts,
    children: [...children, total],
  };
}

function plGroupedSection(id, label, years, byYear, getGroups, getTotal) {
  const lastYear = years[years.length - 1];
  const lastGroups = getGroups(byYear.get(lastYear)) || {};
  const groupNodes = Object.keys(lastGroups).map((glabel) => {
    const lastGroup = lastGroups[glabel];
    const children = (lastGroup.accounts || []).map((a) => {
      const key = a.systemId || a.name;
      return {
        id: `entry-${plRowSlug(key)}`,
        name: a.adjustedName || a.name,
        type: 'data',
        amount: safeNum(a.amount),
        amounts: plAmountsAcrossYears(years, byYear, (stmt) => {
          const grp = (getGroups(stmt) || {})[glabel];
          const match = (grp?.accounts || []).find((x) => (x.systemId || x.name) === key);
          return match ? match.amount : 0;
        }),
      };
    });
    const groupTotal = {
      id: `total-${plRowSlug(glabel)}`,
      name: `Total ${glabel}`,
      type: 'total',
      amount: safeNum(lastGroup.total),
      amounts: plAmountsAcrossYears(years, byYear, (stmt) => (getGroups(stmt) || {})[glabel]?.total),
    };
    return {
      id: `section-${plRowSlug(glabel)}`,
      name: glabel,
      type: 'header',
      amount: groupTotal.amount,
      amounts: groupTotal.amounts,
      children: [...children, groupTotal],
    };
  });
  const overallTotal = {
    id: `total-${plRowSlug(id)}`,
    name: `Total ${label}`,
    type: 'total',
    amount: safeNum(getTotal(byYear.get(lastYear))),
    amounts: plAmountsAcrossYears(years, byYear, getTotal),
  };
  return {
    id: `section-${plRowSlug(id)}`,
    name: label,
    type: 'header',
    amount: overallTotal.amount,
    amounts: overallTotal.amounts,
    children: [...groupNodes, overallTotal],
  };
}

function plTotalRow(id, name, years, byYear, getValue) {
  const lastYear = years[years.length - 1];
  return {
    id: `total-${plRowSlug(id)}`,
    name,
    type: 'total',
    amount: safeNum(getValue(byYear.get(lastYear))),
    amounts: plAmountsAcrossYears(years, byYear, getValue),
  };
}

/**
 * @param {{year:string, statement:object}[]} plYearly financialStatementService's
 *   reports.profitAndLoss.yearly, filtered to the requested years.
 */
function plYearlyToRows(plYearly) {
  if (!plYearly?.length) return { hierarchicalRows: [], yearCols: [] };
  const years = plYearly.map((e) => Number(e.year)).sort((a, b) => a - b);
  const yearCols = years.map((y) => ({ key: `y${y}`, label: `FY ${y}` }));
  const byYear = new Map(plYearly.map((e) => [Number(e.year), e.statement]));
  const lastStmt = byYear.get(years[years.length - 1]);

  // Fixed section titles — stmt.revenue.label / stmt.costOfSales.label /
  // stmt.operatingExpenses.label hold a deep hierarchy rollup label (e.g.
  // "Gross Profit"), not a section title; they're meant for a different
  // consumer and must not be used as header names here.
  const rows = [
    plFlatSection('income', 'Income', years, byYear,
      (s) => s.revenue.accounts, (s) => s.revenue.total),
  ];
  if ((lastStmt.costOfSales.accounts || []).length) {
    rows.push(plFlatSection('cogs', 'Cost of Sales', years, byYear,
      (s) => s.costOfSales.accounts, (s) => s.costOfSales.total));
  }
  rows.push(plTotalRow('gross-profit', 'Gross Profit', years, byYear, (s) => s.grossProfit));
  rows.push(plGroupedSection('operating-expenses', 'Operating Expenses', years, byYear,
    (s) => s.operatingExpenses.groups, (s) => s.operatingExpenses.total));
  rows.push(plTotalRow('operating-income', 'Net Operating Income', years, byYear, (s) => s.operatingIncome));
  rows.push(plTotalRow('net-income', 'Net Income', years, byYear, (s) => s.netIncome));

  return { hierarchicalRows: rows, yearCols };
}

/**
 * GET /key-reports/versions/:versionId/reports/profit-loss
 *
 * Returns the P&L report compatible with getBalanceSheet()-style output
 * (rows = hierarchical tree) AND with the multi-year detail format
 * (rows + columns.yearCols for the comparative renderer).
 */
async function getProfitLossReport(versionId, {
  year, startDate, endDate, period, forceGenerate = false, persist = false, companyId = null,
} = {}) {
  if (!versionId) throw new Error('versionId is required');

  const isSnapshotEligible = !startDate && !endDate && period !== 'month';
  if (!forceGenerate && isSnapshotEligible) {
    const snapshot = await generatedReportSnapshots.getSnapshot(versionId, 'profit_loss', { year, period: 'year' });
    if (snapshot && !(await isSnapshotStale(versionId, snapshot.generatedAt))) {
      return { ...snapshot, source: 'generated_report_snapshots' };
    }
    if (snapshot) console.log(`[KeyReports][PL] versionId=${versionId} snapshot stale (COA changed since ${snapshot.generatedAt}) — recomputing live`);
  }

  const years = await resolveYears(versionId, { year, startDate, endDate });
  console.log(`[KeyReports][PL] versionId=${versionId} years=[${years.join(',')}] range=${startDate || '-'}..${endDate || '-'} period=${period || 'year'}`);

  if (!years.length) {
    console.warn(`[KeyReports][PL] versionId=${versionId} NO DATA — run Sync first`);
    return {
      source: 'key_reports_entry_tables',
      hierarchicalRows: [],
      rows: [],
      years: [],
      yearCols: [],
      columns: { yearCols: [], ytdComparison: null },
    };
  }

  // Month view (spec #9): for a single fiscal year that has GL transactions,
  // break the year into transaction-month columns (Jan…Dec). Extracted P&L
  // tables are annual only, so month view is meaningful only on GL-backed years.
  if (period === 'month' && years.length === 1) {
    const y = years[0];
    const agg = await aggregateGLByAccountMonth(versionId, y);
    if (agg.monthsPresent.size) {
      const { hierarchicalRows, yearCols } = buildPLFromGLMonthly(agg, y);
      auditReport(versionId, 'profit_loss', y, agg.rowsRead, { generatedFromGL: true });
      console.log(`[KeyReports][PL] versionId=${versionId} FY${y} MONTH view cols=${yearCols.length}`);
      return {
        source: 'key_reports_entry_tables',
        hierarchicalRows,
        rows: hierarchicalRows,
        years: [y],
        yearCols,
        columns: { yearCols, ytdComparison: null },
      };
    }
  }

  // Per year: Profit & Loss is generated ENTIRELY from general_ledger_entries
  // (client requirement — there is no profit_loss_entries table), via the same
  // COA parent_account_id-tree engine that /reports/financial-statements, QoE,
  // and KPI use (financialStatementService) — a single P&L computation, no
  // separate keyword-classified builder for this view.
  const { generateFinancialStatements } = require('./financialStatementService');
  const fs = await generateFinancialStatements(versionId, {});
  const plYearly = (fs?.reports?.profitAndLoss?.yearly || []).filter((e) => years.includes(Number(e.year)));
  const anyGenerated = plYearly.length > 0;
  for (const y of years) auditReport(versionId, 'profit_loss', y, 0, { generatedFromGL: true, engine: 'financialStatementService' });

  const { hierarchicalRows, yearCols } = plYearlyToRows(plYearly);
  const treesByYear = {};
  for (const e of plYearly) treesByYear[e.year] = plYearlyToRows([e]).hierarchicalRows;

  console.log(`[KeyReports][PL] versionId=${versionId} hierarchicalRows=${hierarchicalRows.length} generatedFromGL=${anyGenerated}`);

  const result = {
    source: 'key_reports_entry_tables',
    hierarchicalRows,
    rows: hierarchicalRows,
    years,
    yearCols,
    columns: { yearCols, ytdComparison: null },
  };

  if (persist) {
    if (!companyId) throw new Error('companyId is required when persisting generated reports');
    const snapshots = [{ scope: { period: 'year' }, payload: result }];
    for (const y of years) {
      const rows = treesByYear[y] || [];
      const cols = [{ key: `y${y}`, label: `FY ${y}` }];
      snapshots.push({
        scope: { year: y, period: 'year' },
        payload: { ...result, hierarchicalRows: rows, rows, years: [y], yearCols: cols, columns: { yearCols: cols, ytdComparison: null } },
      });
    }
    result.persistedSnapshots = await generatedReportSnapshots.replaceSnapshots(companyId, versionId, 'profit_loss', snapshots);
  }
  // Internal sync handoff: Cash Flow can reuse these trees instead of scanning
  // the GL again. The property is removed before snapshot serialization above.
  result.generatedTreesByYear = treesByYear;
  return result;
}

// ─── Balance Sheet Summary ────────────────────────────────────────────────────

const BS_SECTION_ORDER = ['assets', 'liabilities', 'equity'];
const BS_SECTION_LABELS = { assets: 'Assets', liabilities: 'Liabilities', equity: 'Equity' };

function normalizeBSSection(raw) {
  if (!raw) return null;
  const n = String(raw).toLowerCase().replace(/\s+/g, '');
  if (n.includes('asset')) return 'assets';
  if (n.includes('liab')) return 'liabilities';
  if (n.includes('equity') || n.includes('capital') || n.includes('owner') || n.includes('member')) return 'equity';
  return null;
}

/**
 * Build hierarchical BS rows from flat balance_sheet_entries.
 *
 * Uses the `section` / `account_type` column to group into Assets /
 * Liabilities / Equity, then walks each group in sort_order to detect
 * header vs data vs total rows.
 *
 * For multi-year requests each row carries an `amounts` map.
 *
 * Section-propagation pass: entries whose section/account_type is null
 * (e.g. from older Python extraction that lacked context tracking) inherit
 * the section of the preceding entry that DID have a section. This ensures
 * leaf entries like "Business Checking (7454)" are never silently dropped.
 */
function propagateMissingSection(entries) {
  let lastSection = null;
  return entries.map((e) => {
    const raw = e.account_type || e.section || '';
    const resolved = normalizeBSSection(raw) || normalizeBSSection(e.account_name);
    if (resolved) {
      lastSection = resolved;
      return { ...e, _resolvedSection: resolved };
    }
    return { ...e, _resolvedSection: lastSection };
  });
}

function buildBSHierarchicalRows(entriesByYear, years) {
  if (!years.length) return { hierarchicalRows: [], yearCols: [], asOfDate: null };

  // Group entries by BS section for each year.
  const sectionData = {}; // section → [{ name, isTotal, isHeader, amounts }]
  let latestAsOfDate = null;

  for (const y of years) {
    const col = `y${y}`;
    // Apply section-propagation so entries with null section inherit from context.
    const propagated = propagateMissingSection(entriesByYear[y] || []);
    for (const entry of propagated) {
      if (entry.as_of_date && (!latestAsOfDate || entry.as_of_date > latestAsOfDate)) {
        latestAsOfDate = entry.as_of_date;
      }
      const section = entry._resolvedSection;
      if (!section) continue;

      if (!sectionData[section]) sectionData[section] = {};
      const rawName = entry.account_name?.trim() || '';
      if (!rawName) continue;
      // Normalize "Total for X" / "Total of X" → "Total X" so extracted total rows
      // merge correctly with generated "Total X" rows in the multi-year union step.
      const key = entry.is_total
        ? rawName.replace(/^total\s+for\s+/i, 'Total ').replace(/^total\s+of\s+/i, 'Total ')
        : rawName;
      // "Total Liabilities and Equity" is a cross-section summary row generated at
      // the top level (L + E). Keeping it inside the equity section would cause it
      // to be picked as the equity totalEntry and overstate equity.
      if (/total\s+liabilit/i.test(key) && /equity/i.test(key)) continue;

      if (!sectionData[section][key]) {
        sectionData[section][key] = {
          name: key,
          isTotal: Boolean(entry.is_total),
          isHeader: entry.hierarchy_level === 0 && !entry.is_total,
          amounts: {},
          sortOrder: entry.sort_order ?? 9999,
        };
      }
      sectionData[section][key].amounts[col] = safeNum(entry.amount);
    }
  }

  const yearCols = years.map((y, i) => ({ key: `y${y}`, label: `FY ${y}`, isCurrent: i === years.length - 1 }));
  const lastYearCol = `y${years[years.length - 1]}`;

  const hierarchicalRows = [];

  for (const section of BS_SECTION_ORDER) {
    if (!sectionData[section]) continue;

    const entries = Object.values(sectionData[section]).sort((a, b) => a.sortOrder - b.sortOrder);
    const children = [];

    for (const e of entries) {
      if (e.isHeader) continue; // pure section headers are implicit
      const amount = safeNum(e.amounts[lastYearCol]);
      children.push({
        id: `bs-${section}-${e.name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '').slice(0, 40)}`,
        name: e.name,
        type: e.isTotal ? 'total' : 'data',
        amount,
        amounts: e.amounts,
      });
    }

    // Pick the SECTION GRAND TOTAL, not the first subtotal. A section like
    // Liabilities contains several is_total rows (Total Credit Cards, Total
    // Current Liabilities, … Total Liabilities); `find` would grab the first
    // ("Total Credit Cards") and badly understate the section. Prefer an exact
    // "Total <Section>" name match; otherwise fall back to the LAST is_total row
    // (the grand total always appears last in a section); otherwise sum data rows.
    const wantTotalName = `total ${BS_SECTION_LABELS[section]}`.toLowerCase();
    const normName = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const totalRows = entries.filter(e => e.isTotal && /total/i.test(e.name));
    const totalEntry =
      totalRows.find(e => normName(e.name) === wantTotalName) ||
      (totalRows.length ? totalRows[totalRows.length - 1] : null);
    const sectionAmount = totalEntry
      ? safeNum(totalEntry.amounts[lastYearCol])
      : children.filter(c => c.type === 'data').reduce((s, c) => s + c.amount, 0);

    const sectionAmounts = {};
    for (const y of years) {
      const col = `y${y}`;
      if (totalEntry) {
        sectionAmounts[col] = safeNum(totalEntry.amounts[col]);
      } else {
        // No grand-total row — sum all line items that are NOT sub-section subtotals.
        // Entries starting with "Total" are sub-totals (e.g. "Total Current Liabilities")
        // that would double-count. "Net Income" is a real line item even when is_total=true.
        sectionAmounts[col] = entries
          .filter(e => !e.isHeader && !/^total\b/i.test(e.name))
          .reduce((s, e) => s + safeNum(e.amounts[col] || 0), 0);
      }
    }

    hierarchicalRows.push({
      id: section,
      name: BS_SECTION_LABELS[section],
      type: 'header',
      amount: sectionAmount,
      amounts: sectionAmounts,
      children,
    });
  }

  // Append "Total Liabilities and Equity" if we have both.
  if (sectionData.liabilities || sectionData.equity) {
    const totalAmounts = {};
    for (const y of years) {
      const col = `y${y}`;
      const liabRow = hierarchicalRows.find(r => r.id === 'liabilities');
      const eqRow = hierarchicalRows.find(r => r.id === 'equity');
      totalAmounts[col] = safeNum(liabRow?.amounts?.[col] || 0) + safeNum(eqRow?.amounts?.[col] || 0);
    }
    hierarchicalRows.push({
      id: 'total-le',
      name: 'Total Liabilities and Equity',
      type: 'total',
      amount: safeNum(totalAmounts[lastYearCol]),
      amounts: totalAmounts,
    });
  }

  return { hierarchicalRows, yearCols, asOfDate: latestAsOfDate };
}

// ─── General Ledger ───────────────────────────────────────────────────────────

/**
 * GET /key-reports/versions/:versionId/reports/general-ledger
 *
 * Returns all GL rows (transaction + header + total rows) for a given year.
 */
async function getGeneralLedgerReport(versionId, { year, startDate, endDate, page = 1, pageSize = 500 } = {}) {
  if (!versionId) throw new Error('versionId is required');
  console.log(`[KeyReports][GL] versionId=${versionId} year=${year || 'all'} range=${startDate || '-'}..${endDate || '-'} page=${page}`);

  const parsedPage = Math.max(1, parseInt(page, 10) || 1);
  const parsedSize = Math.min(2000, Math.max(1, parseInt(pageSize, 10) || 500));
  const from = (parsedPage - 1) * parsedSize;
  const to = from + parsedSize - 1;

  // fiscal_year/fiscal_month no longer exist on general_ledger_entries
  // (migration 069). Filtering uses transaction_date directly (robust — never
  // depends on date_id having resolved); year/month/quarter/month_name for
  // display come from the key_report_date_dimension join instead.
  let query = supabase
    .from('general_ledger_entries')
    .select(
      'id,row_type,row_number,transaction_date,date_id,account_name,account_number,transaction_type,transaction_number,memo,split_account,vendor,customer,entity_type,amount,debit_amount,credit_amount,running_balance,coa_id,key_report_date_dimension(year,month,quarter,month_name)',
      { count: 'exact' }
    )
    .eq('version_id', versionId)
    .order('row_number', { ascending: true, nullsFirst: false })
    .order('id', { ascending: true })
    .range(from, to);

  // A single year wins (spec #8 — never mix years); otherwise an explicit
  // date range narrows the transaction_date window (spec #11).
  if (year) {
    const y = parseInt(String(year), 10);
    if (y > 0) query = query.gte('transaction_date', `${y}-01-01`).lte('transaction_date', `${y}-12-31`);
  } else {
    if (startDate) query = query.gte('transaction_date', String(startDate));
    if (endDate) query = query.lte('transaction_date', String(endDate));
  }

  const { data, count, error } = await query;
  if (error) throw error;

  const years = await getDistinctYears('general_ledger_entries', versionId, 'transaction_date', true);
  auditReport(versionId, 'general_ledger', year ? parseInt(String(year), 10) : null, count || 0, { generatedFromGL: true });

  return {
    source: 'key_reports_entry_tables',
    reportType: 'general_ledger',
    rows: data || [],
    total: count || 0,
    page: parsedPage,
    pageSize: parsedSize,
    years,
  };
}

// ─── Bank Statements ──────────────────────────────────────────────────────────

/**
 * GET /key-reports/versions/:versionId/reports/bank-statement
 */
async function getBankStatementReport(versionId, { year, page = 1, pageSize = 500 } = {}) {
  if (!versionId) throw new Error('versionId is required');
  console.log(`[KeyReports][Audit] getBankStatementReport versionId=${versionId} year=${year || 'all'} page=${page} sourceTables=bank_statement_entries`);

  const parsedPage = Math.max(1, parseInt(page, 10) || 1);
  const parsedSize = Math.min(2000, Math.max(1, parseInt(pageSize, 10) || 500));
  const from = (parsedPage - 1) * parsedSize;
  const to = from + parsedSize - 1;

  let query = supabase
    .from('bank_statement_entries')
    .select(
      'id,transaction_date,statement_date,bank_account,bank_name,description,reference,amount,transaction_type,running_balance',
      { count: 'exact' }
    )
    .eq('version_id', versionId)
    .order('transaction_date', { ascending: true, nullsFirst: false })
    .order('id', { ascending: true })
    .range(from, to);

  if (year) {
    const y = parseInt(String(year), 10);
    if (y > 0) {
      query = query.gte('statement_date', `${y}-01-01`).lte('statement_date', `${y}-12-31`);
    }
  }

  const { data, count, error } = await query;
  if (error) throw error;

  const years = await getDistinctYears('bank_statement_entries', versionId, 'statement_month', true);
  auditReport(versionId, 'bank_statement', year ? parseInt(String(year), 10) : null, count || 0, { generatedFromExtractedReport: true });

  return {
    source: 'key_reports_entry_tables',
    reportType: 'bank_statement',
    rows: data || [],
    total: count || 0,
    page: parsedPage,
    pageSize: parsedSize,
    years,
  };
}

// ─── Tax Returns ──────────────────────────────────────────────────────────────

/**
 * GET /key-reports/versions/:versionId/reports/tax-return
 */
async function getTaxReturnReport(versionId, { year } = {}) {
  if (!versionId) throw new Error('versionId is required');
  console.log(`[KeyReports][Audit] getTaxReturnReport versionId=${versionId} year=${year || 'all'} sourceTables=tax_return_entries`);

  let query = supabase
    .from('tax_return_entries')
    .select('id,tax_year,form_type,field_name,field_label,field_value,field_amount,line_number,schedule,section')
    .eq('version_id', versionId)
    .order('id', { ascending: true });

  if (year) {
    const y = parseInt(String(year), 10);
    if (y > 0) query = query.eq('tax_year', y);
  }

  const { data, error } = await query;
  if (error) throw error;

  const years = await getDistinctYears('tax_return_entries', versionId, 'tax_year');
  auditReport(versionId, 'tax_return', year ? parseInt(String(year), 10) : null, (data || []).length, { generatedFromExtractedReport: true });

  return {
    source: 'key_reports_entry_tables',
    reportType: 'tax_return',
    rows: data || [],
    years,
  };
}

// ─── Cash Flow ─────────────────────────────────────────────────────────────────

/** Raw balance_sheet_entries rows for a single fiscal year (version-isolated). */
/**
 * Union-merge per-year Cash Flow trees into one multi-year tree keyed by name.
 * All years share the same section structure (Operating / Investing / Financing
 * + summary rows); financing children (per-named loan) may differ year to year,
 * so we union by normalized name and carry an `amounts` map ({ y2023, y2024 }).
 */
function mergeCfByYear(treesByYear, years) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const lastCol = `y${years[years.length - 1]}`;

  function union(nodeArraysByYear) {
    const order = [];
    const map = new Map();
    years.forEach((y, yi) => {
      (nodeArraysByYear[yi] || []).forEach((node) => {
        const k = norm(node.name);
        if (!k) return;
        if (!map.has(k)) {
          order.push(k);
          map.set(k, { name: node.name, type: node.type, id: node.id, amounts: {}, childrenByYear: years.map(() => []) });
        }
        const m = map.get(k);
        m.amounts[`y${y}`] = safeNum(node.amount);
        const kids = node.children || [];
        if (kids.length >= m.childrenByYear[yi].length) m.childrenByYear[yi] = kids;
        if (m.type !== 'header' && node.type === 'header') { m.name = node.name; m.type = node.type; }
      });
    });
    return order.map((k) => {
      const m = map.get(k);
      const children = union(m.childrenByYear);
      return {
        id: m.id,
        name: m.name,
        type: m.type,
        amount: safeNum(m.amounts[lastCol]),
        amounts: m.amounts,
        children: children.length ? children : undefined,
      };
    });
  }

  return union(years.map((y) => treesByYear[y] || []));
}

/**
 * GET /key-reports/versions/:versionId/reports/cashflow
 *
 * Builds a GAAP indirect-method Cash Flow statement from this version's
 * general_ledger_entries (P&L net income, derived via buildPLFromGL) + the
 * balance_sheet_entries deltas (Operating / Investing / Financing classification
 * via the shared buildCashFlow engine). Reads are version-isolated and never touch
 * Manual GL staging, batches, or qb_synced_reports.
 */
async function getCashflowReport(versionId, {
  year, startDate, endDate, forceGenerate = false, persist = false, companyId = null,
  profitLossTreesByYear = null,
} = {}) {
  if (!versionId) throw new Error('versionId is required');

  if (!forceGenerate && !startDate && !endDate) {
    const snapshot = await generatedReportSnapshots.getSnapshot(versionId, 'cash_flow', { year, period: 'year' });
    if (snapshot && !(await isSnapshotStale(versionId, snapshot.generatedAt))) {
      return { ...snapshot, source: 'generated_report_snapshots' };
    }
    if (snapshot) console.log(`[KeyReports][CF] versionId=${versionId} snapshot stale (COA changed since ${snapshot.generatedAt}) — recomputing live`);
  }

  console.log(`[KeyReports][CF] versionId=${versionId} year=${year || 'all'} range=${startDate || '-'}..${endDate || '-'}`);

  // Cash Flow requires P&L net income (from GL) + Balance Sheet deltas. Drive the
  // year list off the same resolver the other reports use, then apply the date-range
  // filter (spec #11–#13).
  let years = await resolveYears(versionId, { year, startDate, endDate });

  if (!years.length) {
    console.warn(`[KeyReports][CF] versionId=${versionId} NO GL/BS DATA — run Sync first`);
    auditReport(versionId, 'cashflow', null, 0, { generatedFromExtractedReport: true });
    return {
      source: 'key_reports_entry_tables',
      hierarchicalRows: [],
      rows: [],
      years: [],
      yearCols: [],
      columns: { yearCols: [], ytdComparison: null },
    };
  }

  let rowsRead = 0;
  const treesByYear = {};

  for (const y of years) {
    // Build single-year BS trees (current + prior) and the P&L tree, then run the
    // shared indirect-method engine. Prior-year BS is optional (deltas → 0 when absent).
    // P&L is derived from the General Ledger (no profit_loss_entries table).
    // Balance Sheets come from the authoritative balances source (generated monthly
    // snapshot preferred via bsBalancesForYear), so cash flow is built from GL P&L
    // + the stored monthly Balance Sheets — not raw uploaded rows.
    const [bsCurr, bsPrev, plAgg] = await Promise.all([
      bsBalancesForYear(versionId, y),
      bsBalancesForYear(versionId, y - 1),
      profitLossTreesByYear?.[y]
        ? Promise.resolve({ accounts: null, rowsRead: 0 })
        : aggregateGLByAccount(versionId, y),
    ]);
    rowsRead += (bsCurr.rowsRead || 0) + (bsPrev.rowsRead || 0) + (plAgg.rowsRead || 0);

    const bsCurrTree = buildBSFromBalances(bsCurr.balances, y).hierarchicalRows;
    const bsPrevTree = bsPrev.balances?.size
      ? buildBSFromBalances(bsPrev.balances, y - 1).hierarchicalRows
      : [];
    const plTree = profitLossTreesByYear?.[y] || buildPLFromGL(plAgg.accounts, y) || [];

    const cf = buildCashFlow({
      bsPrevRows: bsPrevTree,
      bsCurrRows: bsCurrTree,
      plRows: plTree,
      year: y,
    });
    treesByYear[y] = generatedCfToRows(cf);
  }

  const yearCols = years.map((y, i) => ({ key: `y${y}`, label: `FY ${y}`, isCurrent: i === years.length - 1 }));
  const hierarchicalRows = mergeCfByYear(treesByYear, years);
  // Single-year (latest) tree for the Summary view — plain `.amount`, no columns.
  const rows = treesByYear[years[years.length - 1]] || [];

  for (const y of years) {
    auditReport(versionId, 'cashflow', y, rowsRead, { generatedFromExtractedReport: true });
  }
  console.log(`[KeyReports][CF] versionId=${versionId} years=[${years.join(',')}] sections=${hierarchicalRows.length}`);

  const result = {
    source: 'key_reports_entry_tables',
    hierarchicalRows,
    rows,
    years,
    yearCols,
    columns: { yearCols, ytdComparison: null },
  };

  if (persist) {
    if (!companyId) throw new Error('companyId is required when persisting generated reports');
    const snapshots = [{ scope: { period: 'year' }, payload: result }];
    for (const y of years) {
      const rowsForYear = treesByYear[y] || [];
      const cols = [{ key: `y${y}`, label: `FY ${y}`, isCurrent: true }];
      snapshots.push({
        scope: { year: y, period: 'year' },
        payload: { ...result, hierarchicalRows: rowsForYear, rows: rowsForYear, years: [y], yearCols: cols, columns: { yearCols: cols, ytdComparison: null } },
      });
    }
    result.persistedSnapshots = await generatedReportSnapshots.replaceSnapshots(companyId, versionId, 'cash_flow', snapshots);
  }
  return result;
}

const TB_LEVEL_KEYS = Array.from({ length: 15 }, (_, i) => `level_${i + 1}`);

/**
 * Chart-of-accounts hierarchy lookup keyed by normalized account name, for
 * attaching level_1..level_15 / hierarchy_path / sort_order / normal_balance /
 * statement_type to entry-table rows at report-serving time. The COA itself
 * remains the only place hierarchy is assigned — this never derives or
 * regenerates any hierarchy value, it only reads what's already stored.
 */
async function loadCoaHierarchyMap(versionId) {
  const cols = ["account_name", "adjusted_name", "base_account", "account_type",
    "statement_type", "normal_balance", "sort_order", "hierarchy_path", "metadata",
    ...TB_LEVEL_KEYS].join(", ");
  const { data } = await supabase
    .from("chart_of_accounts")
    .select(cols)
    .eq("version_id", versionId);

  const map = new Map();
  for (const r of data || []) {
    if (r.metadata?.is_group) continue;
    const entry = {
      accountType: r.account_type || null,
      statementType: r.statement_type || null,
      normalBalance: r.normal_balance || null,
      sortOrder: r.sort_order ?? null,
      hierarchyPath: r.hierarchy_path || null,
      levels: TB_LEVEL_KEYS.map((k) => r[k] || null),
    };
    for (const n of [r.account_name, r.adjusted_name, r.base_account]) {
      const k = String(n || "").trim().toLowerCase();
      if (k && !map.has(k)) map.set(k, entry);
    }
  }
  return map;
}

/**
 * GET /key-reports/versions/:versionId/reports/trial-balance
 *
 * Returns the Trial Balance generated from the General Ledger and stored in
 * trial_balance_entries by the Phase-3 engine (keyReportAccountingService
 * .generateTrialBalance). Read-only — never recomputed here. Hierarchy and
 * normal_balance are attached from chart_of_accounts (the single source of
 * truth for both), never derived here.
 */
async function getTrialBalanceReport(versionId, { year } = {}) {
  if (!versionId) throw new Error('versionId is required');

  const [data, coaMap] = await Promise.all([
    fetchAllRows(() => {
      let q = supabase
        .from('trial_balance_entries')
        .select('fiscal_year, account_name, account_number, account_type, total_debits, total_credits, net_balance, opening_balance, closing_balance')
        .eq('version_id', versionId)
        .order('fiscal_year', { ascending: true })
        .order('account_name', { ascending: true });
      if (year) q = q.eq('fiscal_year', parseInt(String(year), 10));
      return q;
    }),
    loadCoaHierarchyMap(versionId),
  ]);

  const rows = (data || []).map((r) => {
    const coa = coaMap.get(String(r.account_name || '').trim().toLowerCase()) || null;
    return {
      fiscalYear: r.fiscal_year,
      account: r.account_name,
      accountNumber: r.account_number,
      accountType: coa?.accountType || r.account_type,
      statementType: coa?.statementType || null,
      normalBalance: coa?.normalBalance || null,
      levels: coa?.levels || null,
      hierarchyPath: coa?.hierarchyPath || null,
      sortOrder: coa?.sortOrder ?? null,
      totalDebits: safeNum(r.total_debits),
      totalCredits: safeNum(r.total_credits),
      netBalance: safeNum(r.net_balance),
      openingBalance: safeNum(r.opening_balance),
      closingBalance: safeNum(r.closing_balance),
    };
  });

  // Sort by COA sort_order (falling back to alphabetical for anything not yet
  // mapped in the COA) instead of raw insertion/alphabetical order, so the
  // Trial Balance presents accounts in the same order as every other report.
  rows.sort((a, b) => {
    if (a.fiscalYear !== b.fiscalYear) return a.fiscalYear - b.fiscalYear;
    const ao = a.sortOrder, bo = b.sortOrder;
    if (ao != null && bo != null && ao !== bo) return ao - bo;
    if (ao != null && bo == null) return -1;
    if (ao == null && bo != null) return 1;
    return String(a.account).localeCompare(String(b.account));
  });

  const years = Array.from(new Set(rows.map((r) => r.fiscalYear))).sort((a, b) => a - b);
  const totals = rows.reduce(
    (t, r) => {
      t.totalDebits += r.totalDebits;
      t.totalCredits += r.totalCredits;
      return t;
    },
    { totalDebits: 0, totalCredits: 0 },
  );
  totals.balanced = Math.abs(totals.totalDebits - totals.totalCredits) < 0.5;

  return { source: 'trial_balance_entries', rows, years, totals };
}

/**
 * GET /key-reports/versions/:versionId/reports/reconciliation
 *
 * Returns the reconciliation of the generated ending Balance Sheet against the
 * uploaded ending Balance Sheet (bs_reconciliation_entries), produced by the
 * Phase-5 engine. Read-only.
 */
async function getReconciliationReport(versionId, { year } = {}) {
  if (!versionId) throw new Error('versionId is required');

  const data = await fetchAllRows(() => {
    let q = supabase
      .from('bs_reconciliation_entries')
      .select('fiscal_year, account_name, account_type, section, generated_balance, uploaded_balance, variance, status, needs_review')
      .eq('version_id', versionId)
      .order('needs_review', { ascending: false })
      .order('account_name', { ascending: true });
    if (year) q = q.eq('fiscal_year', parseInt(String(year), 10));
    return q;
  });

  const rows = (data || []).map((r) => ({
    fiscalYear: r.fiscal_year,
    account: r.account_name,
    accountType: r.account_type,
    section: r.section,
    generatedBalance: safeNum(r.generated_balance),
    uploadedBalance: safeNum(r.uploaded_balance),
    variance: safeNum(r.variance),
    status: r.status,
    needsReview: r.needs_review,
  }));

  const summary = rows.reduce(
    (s, r) => {
      if (r.status === 'match') s.matched += 1;
      else if (r.status === 'difference') s.differences += 1;
      else if (r.status === 'missing_in_generated') s.missingInGenerated += 1;
      else if (r.status === 'missing_in_uploaded') s.missingInUploaded += 1;
      s.totalVariance += Math.abs(r.variance);
      return s;
    },
    { matched: 0, differences: 0, missingInGenerated: 0, missingInUploaded: 0, totalVariance: 0 },
  );
  summary.totalVariance = Math.round(summary.totalVariance * 100) / 100;
  summary.reconciled = rows.length > 0 && summary.differences === 0 && summary.missingInGenerated === 0 && summary.missingInUploaded === 0;
  summary.hasData = rows.length > 0;

  return { source: 'bs_reconciliation_entries', rows, summary };
}

// ─── QoE (Quality of Earnings) ───────────────────────────────────────────────

/**
 * GET /key-reports/versions/:versionId/reports/qoe
 *
 * Returns a Quality of Earnings (QoE) report for each fiscal year:
 *   - EBITDA base (Net Income + D&A + Interest + Taxes) from GL-driven P&L
 *   - User-entered EBITDA adjustments from `ebitda_adjustments` tables
 *   - Adjusted EBITDA per year
 *
 * Adjustment values are keyed by year in `adjustment.values[year].value`.
 */
async function getQoeReport(versionId, { year } = {}) {
  if (!versionId) throw new Error('versionId is required');

  // Look up companyId (needed for ebitdaAdjustmentStore scope)
  const { data: versionRow } = await supabase
    .from('key_report_versions')
    .select('company_id')
    .eq('id', versionId)
    .single();
  const companyId = versionRow?.company_id;

  // Lazy require to avoid circular dependency (financialStatementService imports this module)
  const { generateFinancialStatements } = require('./financialStatementService');

  // Fetch financial statements to derive EBITDA components per year
  const financials = await generateFinancialStatements(versionId, {
    year: year ? parseInt(String(year), 10) : undefined,
  });

  const plYearly = financials.reports?.profitAndLoss?.yearly || [];

  // Fetch EBITDA adjustments (user-entered) scoped to this version
  let ebitdaResult = { adjustments: [] };
  if (companyId) {
    try {
      ebitdaResult = await listEbitdaAdjustments({ companyId, versionId });
    } catch (err) {
      console.warn('[KeyReports][QoE] Failed to load EBITDA adjustments:', err.message);
    }
  }
  const adjustments = ebitdaResult.adjustments || [];

  // D&A / Interest / Tax expense accounts are tagged once at COA classification
  // time (reportTagRules) — sum by that stored tag instead of scanning group or
  // account names by keyword here.
  function sumExpenseAccountsByTag(groups, tag) {
    let total = 0;
    for (const grp of Object.values(groups || {})) {
      for (const acc of (grp.accounts || [])) {
        if (acc.reportTag === tag) total += safeNum(acc.amount);
      }
    }
    return total;
  }

  // Build per-year QoE rows
  const years = plYearly.map(pl => Number(pl.year));

  const byYear = plYearly.map(pl => {
    const yr    = Number(pl.year);
    const stmt  = pl.statement || {};
    const ni    = safeNum(stmt.netIncome);
    const rev   = safeNum(stmt.revenue?.total);
    const cogs  = safeNum(stmt.costOfSales?.total);
    const gp    = safeNum(stmt.grossProfit);
    const opExp = safeNum(stmt.operatingExpenses?.total);
    const expGroups = stmt.operatingExpenses?.groups || {};

    // D&A / Interest / Taxes — accounts tagged once at COA classification time
    const da       = sumExpenseAccountsByTag(expGroups, 'depreciation_amortization');
    const interest = sumExpenseAccountsByTag(expGroups, 'interest_expense');
    const taxes    = sumExpenseAccountsByTag(expGroups, 'income_tax');

    const ebitda = safeNum(ni + da + interest + taxes);

    // Sum adjustments for this year
    let totalAdjustments = 0;
    const adjDetails = [];
    for (const adj of adjustments) {
      if (adj.status && adj.status !== 'approved' && adj.status !== 'active') continue;
      const yrData = adj.values?.[String(yr)];
      const adjVal = safeNum(yrData?.value);
      if (adjVal !== 0) {
        totalAdjustments += adjVal;
        adjDetails.push({
          id: adj.id,
          typeKey: adj.typeKey,
          typeName: adj.type?.label || adj.typeKey,
          name: adj.name,
          description: adj.description,
          amount: adjVal,
        });
      }
    }

    const adjustedEbitda = safeNum(ebitda + totalAdjustments);
    const ebitdaMargin         = rev !== 0 ? Math.round((ebitda / rev) * 10000) / 100 : null;
    const adjustedEbitdaMargin = rev !== 0 ? Math.round((adjustedEbitda / rev) * 10000) / 100 : null;

    return {
      year: yr,
      revenue: rev,
      costOfSales: cogs,
      grossProfit: gp,
      operatingExpenses: opExp,
      netIncome: ni,
      depreciation: da,
      interestExpense: interest,
      taxExpense: taxes,
      ebitda,
      ebitdaMargin,
      totalAdjustments,
      adjustments: adjDetails,
      adjustedEbitda,
      adjustedEbitdaMargin,
    };
  });

  console.log(`[KeyReports][QoE] versionId=${versionId} years=[${years.join(',')}] adjustments=${adjustments.length}`);

  return {
    source: 'gl_and_ebitda_adjustments',
    years,
    byYear,
    adjustmentTypes: ebitdaResult.types || [],
  };
}

// ─── KPI Report ───────────────────────────────────────────────────────────────

/**
 * GET /key-reports/versions/:versionId/reports/kpi
 *
 * Returns standard KPI metrics derived from the COA-driven Balance Sheet and
 * P&L statements (generated by financialStatementService).
 *
 * KPIs per fiscal year:
 *   Liquidity   → currentRatio, workingCapital
 *   Leverage    → debtToEquity, debtRatio
 *   Profitability → grossMargin, netMargin, returnOnAssets, returnOnEquity
 *   Size        → totalAssets, totalLiabilities, totalEquity, revenue
 */
async function getKpiReport(versionId, { year } = {}) {
  if (!versionId) throw new Error('versionId is required');

  // Lazy require to avoid circular dependency (financialStatementService imports this module)
  const { generateFinancialStatements } = require('./financialStatementService');

  const financials = await generateFinancialStatements(versionId, {
    year: year ? parseInt(String(year), 10) : undefined,
  });

  const plYearly = financials.reports?.profitAndLoss?.yearly || [];
  const bsYearly = financials.reports?.balanceSheet?.yearly  || [];

  // Index BS by year for fast lookup
  const bsByYear = new Map(bsYearly.map(bs => [Number(bs.year), bs]));

  // Spot accounts (cash, A/R, inventory, A/P, D&A, interest, tax) are tagged
  // once at COA classification time (reportTagRules) — sum by that stored tag
  // instead of scanning account/group names by keyword here.
  function sumExpenseAccountsByTag(groups, tag) {
    let total = 0;
    for (const grp of Object.values(groups || {})) {
      for (const acc of (grp.accounts || [])) {
        if (acc.reportTag === tag) total += safeNum(acc.amount);
      }
    }
    return total;
  }
  function sumAccountsByTag(accounts, tag) {
    let total = 0;
    for (const acc of accounts || []) {
      if (acc.reportTag === tag) total += safeNum(acc.amount);
    }
    return total;
  }

  const years = plYearly.map(pl => Number(pl.year));

  const byYear = plYearly.map(pl => {
    const yr   = Number(pl.year);
    const stmt = pl.statement || {};
    const bs   = bsByYear.get(yr);
    const bss  = bs?.statement || {};

    // ── P&L metrics ──────────────────────────────────────────────────────────
    const revenue  = safeNum(stmt.revenue?.total);
    const cogs     = safeNum(stmt.costOfSales?.total);
    const grossProfit = safeNum(stmt.grossProfit);
    const netIncome   = safeNum(stmt.netIncome);
    const opExpenses  = safeNum(stmt.operatingExpenses?.total);
    const ebitGroups  = stmt.operatingExpenses?.groups || {};
    const da          = sumExpenseAccountsByTag(ebitGroups, 'depreciation_amortization');
    const interest    = sumExpenseAccountsByTag(ebitGroups, 'interest_expense');
    const taxes       = sumExpenseAccountsByTag(ebitGroups, 'income_tax');
    const ebitda      = safeNum(netIncome + da + interest + taxes);

    // ── Balance Sheet metrics ─────────────────────────────────────────────────
    const totalAssets      = safeNum(bss.totalAssets);
    const totalLiabilities = safeNum(bss.liabilities?.total);
    const totalEquity      = safeNum(bss.equity?.total);

    // Section-level totals
    const currentAssets      = safeNum(bss.assets?.currentAssets?.total);
    const fixedAssets        = safeNum(bss.assets?.fixedAssets?.total);
    const otherAssets        = safeNum(bss.assets?.otherAssets?.total);
    const currentLiabilities = safeNum(bss.liabilities?.currentLiabilities?.total);
    const longTermLiabilities = safeNum(bss.liabilities?.longTermLiabilities?.total);

    // Spot accounts: cash, A/R, inventory, A/P
    const curAssetAccounts = [
      ...Object.values(bss.assets?.currentAssets?.groups || {}).flatMap(g => g.accounts || []),
      ...Object.values(bss.assets?.otherAssets?.groups  || {}).flatMap(g => g.accounts || []),
    ];
    const cashAndBank        = sumAccountsByTag(curAssetAccounts, 'cash');
    const accountsReceivable = sumAccountsByTag(curAssetAccounts, 'accounts_receivable');
    const inventory          = sumAccountsByTag(curAssetAccounts, 'inventory');

    const curLiabAccounts = Object.values(bss.liabilities?.currentLiabilities?.groups  || {}).flatMap(g => g.accounts || []);
    const ltLiabAccounts  = Object.values(bss.liabilities?.longTermLiabilities?.groups || {}).flatMap(g => g.accounts || []);
    const accountsPayable = sumAccountsByTag(curLiabAccounts, 'accounts_payable');
    const longTermDebt    = safeNum(longTermLiabilities) ||
      sumAccountsByTag(ltLiabAccounts, 'long_term_debt');

    // ── Computed ratios ───────────────────────────────────────────────────────
    const pct = (v) => v !== null ? Math.round(v * 10000) / 100 : null; // to %
    const ratio = (n, d) => d !== 0 ? Math.round((n / d) * 1000) / 1000 : null;

    const currentRatio    = ratio(currentAssets, currentLiabilities);
    const workingCapital  = safeNum(currentAssets - currentLiabilities);
    const debtToEquity    = ratio(totalLiabilities, totalEquity);
    const debtRatio       = ratio(totalLiabilities, totalAssets);
    const grossMargin     = pct(ratio(grossProfit, revenue));
    const netMargin       = pct(ratio(netIncome, revenue));
    const ebitdaMargin    = pct(ratio(ebitda, revenue));
    const returnOnAssets  = pct(ratio(netIncome, totalAssets));
    const returnOnEquity  = pct(ratio(netIncome, totalEquity));
    const assetTurnover   = ratio(revenue, totalAssets);

    return {
      year: yr,
      // Size
      revenue,
      costOfSales: cogs,
      grossProfit,
      netIncome,
      ebitda,
      totalAssets,
      totalLiabilities,
      totalEquity,
      // Balance Sheet sections
      currentAssets,
      fixedAssets,
      otherAssets,
      currentLiabilities,
      longTermLiabilities,
      // Spot accounts
      cashAndBank,
      accountsReceivable,
      inventory,
      accountsPayable,
      longTermDebt,
      // Ratios
      currentRatio,
      workingCapital,
      debtToEquity,
      debtRatio,
      grossMargin,
      netMargin,
      ebitdaMargin,
      returnOnAssets,
      returnOnEquity,
      assetTurnover,
    };
  });

  console.log(`[KeyReports][KPI] versionId=${versionId} years=[${years.join(',')}]`);

  return {
    source: 'generated_financial_statements',
    years,
    byYear,
    validation: financials.validation || [],
  };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  getProfitLossReport,
  getTrialBalanceReport,
  getReconciliationReport,
  getGeneralLedgerReport,
  getBankStatementReport,
  getTaxReturnReport,
  getCashflowReport,
  getQoeReport,
  getKpiReport,
  // Pure builders exported for the accuracy-validation harness (test fixtures).
  buildPLHierarchicalRows,
  buildBSHierarchicalRows,
  mergeCfByYear,
  // GL carry-forward generator (BS(year)=BS(year-1)+GL(year)) — reused by the
  // COA-driven financialStatementService as a fallback for years with no
  // uploaded balance sheet.
  bsBalancesForYear,
  aggregateGLForBSByMonth,
  aggregateGLForBS,
  aggregateGLByAccount,
  naturalBalanceMovement,
  netIncomeMovement,
};
