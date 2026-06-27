

const { supabase } = require('../../db');
const { buildCashFlow, generatedCfToRows } = require('../manualCashFlowService');

// ─── helpers ─────────────────────────────────────────────────────────────────

function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
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

// Balance-Sheet integrity check (spec #15): Assets = Liabilities + Equity.
// Logs the difference for every generated/rendered year; never throws — a report
// that is slightly out of balance must still render, but the imbalance is auditable.
function validateBalanceSheet(versionId, fiscalYear, sectionTotals, opts = {}) {
  const assets = safeNum(sectionTotals.assets);
  const liabilities = safeNum(sectionTotals.liabilities);
  const equity = safeNum(sectionTotals.equity);
  const liabilitiesPlusEquity = Math.round((liabilities + equity) * 100) / 100;
  const difference = Math.round((assets - liabilitiesPlusEquity) * 100) / 100;
  const balanced = Math.abs(difference) < 0.5; // tolerate sub-dollar rounding
  console.log('[KEY_REPORTS_VALIDATION]', {
    versionId,
    fiscalYear: fiscalYear ?? null,
    totalAssets: assets,
    totalLiabilities: liabilities,
    totalEquity: equity,
    liabilitiesPlusEquity,
    difference,
    balanced,
  });
  if (!balanced) {
    console.warn(
      `[KEY_REPORTS_VALIDATION] Balance Sheet OUT OF BALANCE version=${versionId} FY${fiscalYear}: ` +
      `Assets=${assets} Liabilities=${liabilities} Equity=${equity} L+E=${liabilitiesPlusEquity} diff=${difference}`,
    );
    if (opts.unclassified && opts.unclassified.length) {
      console.warn('[KEY_REPORTS_VALIDATION] Unclassified GL accounts excluded from this year:',
        opts.unclassified.map(u =>
          `  "${u.distribution_account}" split="${u.split_account}" amt=${u.amount} rb=${u.running_balance} FY=${u.fiscal_year}`
        ).join('\n')
      );
    }
    if (opts.bsMap) {
      const top = Array.from(opts.bsMap.entries())
        .map(([name, acc]) => ({ name, type: acc.type, net: Math.round(acc.net * 100) / 100 }))
        .sort((a, b) => Math.abs(b.net) - Math.abs(a.net))
        .slice(0, 10);
      console.warn('[KEY_REPORTS_VALIDATION] Top GL movements by account (this year):', top);
    }
  }
  return { assets, liabilities, equity, difference, balanced };
}

/** Distinct fiscal years present in any entry table for this version. */
async function getDistinctYears(table, versionId, yearCol, isDateCol = false) {
  const { data, error } = await supabase
    .from(table)
    .select(yearCol)
    .eq('version_id', versionId)
    .limit(50000);
  if (error || !data) return [];
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
 * "Has data" = the year appears in profit_loss_entries, balance_sheet_entries OR
 * general_ledger_entries — so a year that exists only in GL (and will be
 * generated) is still offered, and empty years never produce blank columns.
 */
async function resolveYears(versionId, { year, startDate, endDate } = {}) {
  if (year) {
    const y = parseInt(String(year), 10);
    return y > 0 ? [y] : [];
  }

  const [plYears, bsYears, glYears] = await Promise.all([
    getDistinctYears('profit_loss_entries', versionId, 'fiscal_year'),
    getDistinctYears('balance_sheet_entries', versionId, 'fiscal_year'),
    getDistinctYears('general_ledger_entries', versionId, 'fiscal_year'),
  ]);

  const set = new Set([...plYears, ...bsYears, ...glYears]);
  let years = Array.from(set).filter((y) => y >= 1990 && y <= 2100).sort((a, b) => a - b);

  const lo = startDate ? parseInt(String(startDate).slice(0, 4), 10) : null;
  const hi = endDate ? parseInt(String(endDate).slice(0, 4), 10) : null;
  if (lo) years = years.filter((y) => y >= lo);
  if (hi) years = years.filter((y) => y <= hi);

  return years;
}

/** True when an extracted report table already holds rows for this fiscal year. */
async function hasExtractedRows(table, versionId, year) {
  const { count, error } = await supabase
    .from(table)
    .select('id', { count: 'exact', head: true })
    .eq('version_id', versionId)
    .eq('fiscal_year', year);
  if (error) return false;
  return (count || 0) > 0;
}

// ─── GL account classification (self-contained — no Manual GL dependency) ──────
//
// general_ledger_entries has no account_type column, so we classify by the
// distribution_account name keyword. This keeps Key Reports COMPLETELY isolated
// from manualGlMultiYearService.

const ASSET_KW = [
  'cash', 'bank', 'checking', 'savings', 'receivable', 'a/r', 'inventory', 'prepaid', 'deposit',
  'money market', 'equipment', 'furniture', 'vehicle', 'building', 'land', 'property', 'fixed asset',
  'accumulated depreciation', 'goodwill', 'intangible', 'investment', 'due from', 'asset',
];
const LIABILITY_KW = [
  'payable', 'a/p', 'accrued', 'credit card', 'loan', 'note payable', 'line of credit',
  'deferred', 'unearned', 'tax payable', 'payroll liab', 'liability', 'mortgage',
];
const EQUITY_KW = [
  'equity', 'capital', 'retained earnings', 'owner', 'member', 'shareholder',
  'stockholder', 'distribution', 'draw', 'common stock', 'opening balance',
];
// 'service' removed — too broad, falsely matches expense accounts like "Legal & Professional Services".
// Revenue accounts with "service" in the name typically also carry "income" or "revenue".
const REVENUE_KW = [
  'revenue', 'income', 'sales', 'fees earned', 'interest income', 'gross receipts',
  'discounts/refunds given', 'gain on sale', 'refunds to customers',
];
// 'depreciation expense' expanded to 'depreciation' alone so "Depreciation" (without the word "expense")
// is still caught. "accumulated depreciation" is in ASSET_KW and wins because ASSET is checked first.
const EXPENSE_KW = [
  'expense', 'cost of goods', 'cogs', 'cost of sales', 'salaries', 'wages', 'rent', 'utilities',
  'insurance', 'depreciation', 'amortization', 'payroll', 'supplies', 'advertising', 'marketing',
  'fees', 'interest expense', 'interest paid', 'tax expense',
  'legal', 'alarm', 'charitable', 'education', 'employee benefits',
  'meals', 'repairs', 'maintenance', 'rubbish', 'subscription',
  'telephone', 'travel', 'water', 'worker', 'car & truck', 'real estate', 'licenses',
];

// Specific expense phrases that contain liability or asset substrings and must be classified
// as expense before the broader LIABILITY_KW / ASSET_KW checks run.
// "Credit Card Charges/Fees" contains "credit card" (liability keyword).
// "Bank Charges & Fees" contains "bank" (asset keyword).
const PRIORITY_EXPENSE_KW = ['credit card charges', 'credit card fees', 'bank charges', 'bank fees'];

function classifyGLAccount(name, accountType) {
  const t = String(accountType || '').toLowerCase();
  if (t) {
    if (/asset/.test(t)) return 'asset';
    if (/liab/.test(t)) return 'liability';
    if (/equity|capital/.test(t)) return 'equity';
    if (/income|revenue/.test(t)) return 'revenue';
    if (/expense|cogs|cost/.test(t)) return 'expense';
  }
  const n = String(name || '').toLowerCase();
  const hit = (kws) => kws.some((k) => n.includes(k));
  // Priority expense: specific expense phrases checked before broader BS-account keywords so
  // "Credit Card Charges/Fees" does not match "credit card" (liability) and
  // "Bank Charges & Fees" does not match "bank" (asset).
  if (hit(PRIORITY_EXPENSE_KW)) return 'expense';
  // Revenue first; then liability before asset so "Loan Payable- Bank" hits "loan"
  // (liability) before "bank" (asset); then asset; then expense (after asset so "accumulated
  // depreciation" wins over the bare "depreciation" keyword added to EXPENSE_KW); equity last.
  if (hit(REVENUE_KW))   return 'revenue';
  if (hit(LIABILITY_KW)) return 'liability';
  if (hit(ASSET_KW))     return 'asset';
  if (hit(EXPENSE_KW))   return 'expense';
  if (hit(EQUITY_KW))    return 'equity';
  return 'unknown';
}

/** GL account key for a row — the account this row posts to. */
function glAccountName(row) {
  return (row.distribution_account && String(row.distribution_account).trim()) || '';
}

/** Signed movement (debit − credit) for a GL transaction row. */
function glNetMovement(row) {
  return safeNum(row.amount); // amount is the signed movement
}


async function fetchAllGLRows(versionId, year, columns, rowType = 'TRANSACTION') {
  const PAGE = 1000;
  const out = [];
  for (let from = 0; ; from += PAGE) {
    let q = supabase
      .from('general_ledger_entries')
      .select(columns)
      .eq('version_id', versionId)
      .eq('fiscal_year', year);
    if (rowType) q = q.eq('row_type', rowType);
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
 * distribution_account. Used for P&L report generation (existing callers).
 * Returns { accounts: Map(name→{net,type}), rowsRead }.
 */
async function aggregateGLByAccount(versionId, year) {
  const rows = await fetchAllGLRows(
    versionId, year,
    'distribution_account, split_account, amount, running_balance, row_type, fiscal_year',
  );

  const accounts = new Map();
  const unclassified = [];
  for (const row of rows) {
    const name = glAccountName(row);
    if (!name) continue;
    const type = classifyGLAccount(name, null);
    if (type === 'unknown') {
      unclassified.push({
        fiscal_year: row.fiscal_year,
        distribution_account: row.distribution_account,
        split_account: row.split_account,
        amount: row.amount,
        running_balance: row.running_balance,
      });
    }
    if (!accounts.has(name)) accounts.set(name, { name, net: 0, type });
    accounts.get(name).net += glNetMovement(row);
  }
  if (unclassified.length) {
    console.warn(`[KeyReports][GL] versionId=${versionId} FY${year}: ${unclassified.length} unclassified GL accounts:`,
      unclassified.map(u => `${u.distribution_account} (split:${u.split_account}) amt=${u.amount} rb=${u.running_balance}`).join(' | '));
  }
  return { accounts, rowsRead: rows.length };
}

/**
 * Single-side aggregation for Balance Sheet carry-forward.
 *
 * QuickBooks GL exports each account's ledger as separate rows. For each
 * TRANSACTION row only the distribution_account side is posted to the BS map.
 * Applying the inverse movement to split_account would double-count every bank
 * transfer, credit card payment, and loan movement because QB already emits a
 * dedicated distribution row for that account's own ledger.
 *
 * Sign convention (debit-positive throughout):
 *   asset:     bsMap.net += amount           (assets increase with debits)
 *   liability: bsMap.net += amount           (negated in bsBalancesForYear → balance += -amount)
 *   equity:    bsMap.net += amount           (negated in bsBalancesForYear → balance += -amount)
 *   P&L dist:  netIncome += -amount
 *   P&L split: netIncome += amount (= -(splitAmount)) — fallback only when that
 *              P&L account has no distribution row of its own in this year's GL.
 *
 * Returns { bsMap, netIncome, unclassified, rowsRead }.
 */
async function aggregateGLForBS(versionId, year) {
  const rows = await fetchAllGLRows(
    versionId, year,
    'distribution_account, split_account, amount, running_balance, row_type, fiscal_year',
  );

  // Pre-scan: record every P&L account that appears as distribution_account.
  // Prevents double-counting Net Income when QB exports both sides of a transaction:
  // the P&L distribution row (which counts NI) and a paired BS row that lists the
  // same P&L account as split_account (which must then be skipped).
  const plDistSeen = new Set();
  for (const row of rows) {
    const n = (row.distribution_account && String(row.distribution_account).trim()) || '';
    if (!n) continue;
    const t = classifyGLAccount(n, null);
    if (t === 'revenue' || t === 'expense') plDistSeen.add(n);
  }

  const bsMap = new Map();
  let netIncome = 0;
  const unclassified = [];

  for (const row of rows) {
    const distName = (row.distribution_account && String(row.distribution_account).trim()) || '';
    const splitName = (row.split_account && String(row.split_account).trim()) || '';
    const amount = safeNum(row.amount);

    const distType = distName ? classifyGLAccount(distName, null) : 'unknown';
    const splitType = splitName ? classifyGLAccount(splitName, null) : 'unknown';

    // ── distribution_account (primary posting account) ─────────────────────
    if (distType === 'asset') {
      if (!bsMap.has(distName)) bsMap.set(distName, { net: 0, type: 'asset' });
      bsMap.get(distName).net += amount;
    } else if (distType === 'liability') {
      if (!bsMap.has(distName)) bsMap.set(distName, { net: 0, type: 'liability' });
      bsMap.get(distName).net += amount;
    } else if (distType === 'equity') {
      if (!bsMap.has(distName)) bsMap.set(distName, { net: 0, type: 'equity' });
      bsMap.get(distName).net += amount;
    } else if (distType === 'revenue') {
      // Revenue credits are positive in QB's natural-balance GL export → add to NI.
      netIncome += amount;
    } else if (distType === 'expense') {
      // Expense debits are positive → subtract from NI.
      netIncome += -amount;
    } else {
      unclassified.push({
        fiscal_year: row.fiscal_year,
        distribution_account: row.distribution_account,
        split_account: row.split_account,
        amount: row.amount,
        running_balance: row.running_balance,
      });
    }

    // ── split_account ──────────────────────────────────────────────────────
    // Asset/Liability/Equity: NOT posted — QB already exports those accounts'
    // own distribution rows, so applying the inverse here causes double-counting.
    // P&L: contribute to Net Income only as a fallback for P&L accounts that
    // have no distribution row in this year's GL (e.g. partial exports).
    if (!splitName) continue;
    if ((splitType === 'revenue' || splitType === 'expense') && !plDistSeen.has(splitName)) {
      // splitAmount = -amount; netIncome += -(splitAmount) = amount
      netIncome += amount;
    }
  }

  if (unclassified.length) {
    console.warn(
      `[KeyReports][BS][GL] versionId=${versionId} FY${year}: ${unclassified.length} unclassified distribution_account(s) — these rows are EXCLUDED from the Balance Sheet and may cause an imbalance:`,
      unclassified.map(u =>
        `  distribution_account="${u.distribution_account}" split_account="${u.split_account}" amount=${u.amount} running_balance=${u.running_balance} fiscal_year=${u.fiscal_year}`
      ).join('\n')
    );
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
    if (acc.type === 'revenue') revenue.push({ name: acc.name, amount: -acc.net });
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
async function bsBalancesForYear(versionId, year, depth = 0) {
  if (await hasExtractedRows('balance_sheet_entries', versionId, year)) {
    const { data, error } = await supabase
      .from('balance_sheet_entries')
      .select('account_name, account_type, section, amount, hierarchy_level, is_total, sort_order, fiscal_year, as_of_date')
      .eq('version_id', versionId)
      .eq('fiscal_year', year)
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

/** Read section totals (assets/liabilities/equity) for one year out of a BS tree. */
function sectionTotalsFromTree(tree, year) {
  const col = `y${year}`;
  const get = (id) => {
    const node = tree.find((r) => r.id === id);
    return node ? safeNum(node.amounts?.[col] ?? node.amount) : 0;
  };
  return { assets: get('assets'), liabilities: get('liabilities'), equity: get('equity') };
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
    'distribution_account, amount, transaction_date, row_type, fiscal_year',
  );

  const byAccount = new Map();
  const monthsPresent = new Set();
  for (const row of rows) {
    const name = glAccountName(row);
    if (!name || !row.transaction_date) continue;
    const month = parseInt(String(row.transaction_date).slice(5, 7), 10);
    if (!(month >= 1 && month <= 12)) continue;
    monthsPresent.add(month);
    if (!byAccount.has(name)) {
      byAccount.set(name, { name, type: classifyGLAccount(name, null), months: new Map() });
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
    if (acc.type === 'revenue') revenue.push({ name: acc.name, amounts: monthAmount(acc, -1) });
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

/** Single-year monthly Balance Sheet tree from GL — cumulative closing per month end. */
function buildBSFromGLMonthly(agg, year, openingBalances) {
  const cols = monthCols(year, agg.monthsPresent);
  const lastKey = cols.length ? cols[cols.length - 1].key : `m${year}_12`;

  // Seed every account with its opening (prior-year closing) balance, natural sign.
  const balances = new Map();
  for (const [, v] of openingBalances) addBalance(balances, v.name, v.balance, v.type);
  for (const acc of agg.byAccount.values()) {
    if (!balances.has(acc.name)) balances.set(acc.name, { name: acc.name, balance: 0, type: acc.type });
  }

  // Cumulative running balance per account at each month end.
  const running = new Map(); // name → current cumulative balance
  for (const [name, v] of balances) running.set(name, v.balance);
  const perMonthBalances = {}; // colKey → Map(name→{balance,type})

  let retained = openingBalances.get('Retained Earnings')?.balance || 0;
  for (const c of cols) {
    let monthNet = 0;
    for (const acc of agg.byAccount.values()) {
      const delta = acc.months.get(c.month) || 0;
      if (acc.type === 'asset') running.set(acc.name, (running.get(acc.name) || 0) + delta);
      else if (acc.type === 'liability') running.set(acc.name, (running.get(acc.name) || 0) - delta);
      else if (acc.type === 'equity') running.set(acc.name, (running.get(acc.name) || 0) - delta);
      else if (acc.type === 'revenue' || acc.type === 'expense') monthNet += -delta;
    }
    retained += monthNet;
    const snapshot = new Map();
    for (const [name, v] of balances) {
      snapshot.set(name, { name, balance: running.get(name) || 0, type: v.type });
    }
    if (Math.abs(retained) > 0.005) snapshot.set('Retained Earnings', { name: 'Retained Earnings', balance: retained, type: 'equity' });
    perMonthBalances[c.key] = snapshot;
  }

  // Build hierarchical tree where each node carries amounts per month column.
  const sections = { assets: new Map(), liabilities: new Map(), equity: new Map() };
  for (const c of cols) {
    for (const [name, v] of perMonthBalances[c.key]) {
      const sec = v.type === 'asset' ? 'assets' : v.type === 'liability' ? 'liabilities' : v.type === 'equity' ? 'equity' : null;
      if (!sec) continue;
      if (!sections[sec].has(name)) sections[sec].set(name, { name, amounts: {} });
      sections[sec].get(name).amounts[c.key] = v.balance;
    }
  }

  const hierarchicalRows = [];
  const lastTotals = { assets: 0, liabilities: 0, equity: 0 };
  for (const section of BS_SECTION_ORDER) {
    const accts = Array.from(sections[section].values()).filter((a) => cols.some((c) => Math.abs(a.amounts[c.key] || 0) >= 0.005));
    if (!accts.length) continue;
    const totalAmounts = {};
    for (const c of cols) totalAmounts[c.key] = accts.reduce((s, a) => s + (a.amounts[c.key] || 0), 0);
    lastTotals[section] = safeNum(totalAmounts[lastKey]);
    const children = accts.map((a) => ({ id: `bs-${section}-${slug(a.name)}`, name: a.name, type: 'data', amount: safeNum(a.amounts[lastKey]), amounts: a.amounts }));
    children.push({ id: `bs-${section}-total`, name: `Total ${BS_SECTION_LABELS[section]}`, type: 'total', amount: safeNum(totalAmounts[lastKey]), amounts: totalAmounts });
    hierarchicalRows.push({ id: section, name: BS_SECTION_LABELS[section], type: 'header', amount: safeNum(totalAmounts[lastKey]), amounts: totalAmounts, children });
  }
  const leAmounts = {};
  for (const c of cols) {
    const liab = sections.liabilities.size ? Array.from(sections.liabilities.values()).reduce((s, a) => s + (a.amounts[c.key] || 0), 0) : 0;
    const eq = sections.equity.size ? Array.from(sections.equity.values()).reduce((s, a) => s + (a.amounts[c.key] || 0), 0) : 0;
    leAmounts[c.key] = liab + eq;
  }
  hierarchicalRows.push({ id: 'total-le', name: 'Total Liabilities and Equity', type: 'total', amount: safeNum(leAmounts[lastKey]), amounts: leAmounts });

  return { hierarchicalRows, yearCols: cols, sectionTotals: lastTotals };
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

/**
 * GET /key-reports/versions/:versionId/reports/profit-loss
 *
 * Returns the P&L report compatible with getBalanceSheet()-style output
 * (rows = hierarchical tree) AND with the multi-year detail format
 * (rows + columns.yearCols for the comparative renderer).
 */
async function getProfitLossReport(versionId, { year, startDate, endDate, period } = {}) {
  if (!versionId) throw new Error('versionId is required');

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

  // Per year: render directly from profit_loss_entries when present (spec #4);
  // otherwise generate from general_ledger_entries for that single year (spec #6, #8).
  const treesByYear = {};
  let anyGenerated = false;
  for (const y of years) {
    if (await hasExtractedRows('profit_loss_entries', versionId, y)) {
      const { data, error } = await supabase
        .from('profit_loss_entries')
        .select('account_name, account_type, amount, hierarchy_level, is_total, sort_order, fiscal_year')
        .eq('version_id', versionId)
        .eq('fiscal_year', y)
        .order('sort_order', { ascending: true, nullsFirst: false })
        .order('id', { ascending: true });
      if (error) throw error;
      const entries = data || [];
      treesByYear[y] = buildPLHierarchicalRows({ [y]: entries }, [y]).hierarchicalRows;
      auditReport(versionId, 'profit_loss', y, entries.length, { generatedFromExtractedReport: true });
    } else {
      const { accounts, rowsRead } = await aggregateGLByAccount(versionId, y);
      treesByYear[y] = buildPLFromGL(accounts, y);
      anyGenerated = true;
      auditReport(versionId, 'profit_loss', y, rowsRead, { generatedFromGL: true });
    }
  }

  const yearCols = years.map((y) => ({ key: `y${y}`, label: `FY ${y}` }));
  const hierarchicalRows = years.length === 1
    ? treesByYear[years[0]]
    : mergeCfByYear(treesByYear, years);

  console.log(`[KeyReports][PL] versionId=${versionId} hierarchicalRows=${hierarchicalRows.length} generatedFromGL=${anyGenerated}`);

  return {
    source: 'key_reports_entry_tables',
    hierarchicalRows,
    rows: hierarchicalRows,
    years,
    yearCols,
    columns: { yearCols, ytdComparison: null },
  };
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

/**
 * GET /key-reports/versions/:versionId/reports/balance-sheet
 */
async function getBalanceSheetReport(versionId, { year, startDate, endDate, period } = {}) {
  if (!versionId) throw new Error('versionId is required');

  const years = await resolveYears(versionId, { year, startDate, endDate });
  console.log(`[KeyReports][BS] versionId=${versionId} years=[${years.join(',')}] range=${startDate || '-'}..${endDate || '-'} period=${period || 'year'}`);

  if (!years.length) {
    console.warn(`[KeyReports][BS] versionId=${versionId} NO DATA — run Sync first`);
    return {
      source: 'key_reports_entry_tables',
      hierarchicalRows: [],
      rows: [],
      years: [],
      yearCols: [],
      asOfDate: null,
      columns: { yearCols: [], changeCols: [], currentMonth: '' },
    };
  }

  // Month view (spec #9): for a single fiscal year with GL transactions, show the
  // cumulative closing balance at each month end (Jan…Dec). Opening balances are
  // the prior-year closing (carry-forward chain, spec #7).
  if (period === 'month' && years.length === 1) {
    const y = years[0];
    const agg = await aggregateGLByAccountMonth(versionId, y);
    if (agg.monthsPresent.size) {
      const prior = await bsBalancesForYear(versionId, y - 1);
      const { hierarchicalRows, yearCols, sectionTotals } = buildBSFromGLMonthly(agg, y, prior.balances);
      validateBalanceSheet(versionId, y, sectionTotals);
      auditReport(versionId, 'balance_sheet', y, agg.rowsRead + prior.rowsRead, { generatedFromGL: true });
      console.log(`[KeyReports][BS] versionId=${versionId} FY${y} MONTH view cols=${yearCols.length}`);
      const changeCols = [];
      for (let i = 1; i < yearCols.length; i++) {
        changeCols.push({ key: `c${i}`, label: `${yearCols[i].label} CHANGE`, from: yearCols[i - 1].key, to: yearCols[i].key });
      }
      return {
        source: 'key_reports_entry_tables',
        hierarchicalRows,
        rows: hierarchicalRows,
        years: [y],
        yearCols,
        asOfDate: `${y}-12-31`,
        columns: { yearCols, changeCols, currentMonth: yearCols[yearCols.length - 1]?.label || '' },
      };
    }
  }

  // Per year: render directly from balance_sheet_entries when present (spec #5);
  // otherwise generate from GL using the carry-forward chain BS(y)=BS(y-1)+GL(y)
  // (spec #6, #7). Each year is built as its own single-year tree, then merged
  // into multi-year comparative columns.
  const treesByYear = {};
  let latestAsOfDate = null;
  let anyGenerated = false;

  for (const y of years) {
    if (await hasExtractedRows('balance_sheet_entries', versionId, y)) {
      const { data, error } = await supabase
        .from('balance_sheet_entries')
        .select('account_name, account_type, section, amount, hierarchy_level, is_total, sort_order, fiscal_year, as_of_date')
        .eq('version_id', versionId)
        .eq('fiscal_year', y)
        .order('sort_order', { ascending: true, nullsFirst: false })
        .order('id', { ascending: true });
      if (error) throw error;
      const entries = data || [];
      const built = buildBSHierarchicalRows({ [y]: entries }, [y]);
      treesByYear[y] = built.hierarchicalRows;
      if (built.asOfDate && (!latestAsOfDate || built.asOfDate > latestAsOfDate)) latestAsOfDate = built.asOfDate;
      auditReport(versionId, 'balance_sheet', y, entries.length, { generatedFromExtractedReport: true });
    } else {
      const { balances, rowsRead, asOfDate, bsMap, unclassified } = await bsBalancesForYear(versionId, y);
      treesByYear[y] = buildBSFromBalances(balances, y).hierarchicalRows;
      anyGenerated = true;
      if (asOfDate && (!latestAsOfDate || asOfDate > latestAsOfDate)) latestAsOfDate = asOfDate;
      auditReport(versionId, 'balance_sheet', y, rowsRead, { generatedFromGL: true });
      // Balance integrity check per year (spec #15) — pass GL details for imbalance diagnosis.
      validateBalanceSheet(versionId, y, sectionTotalsFromTree(treesByYear[y], y), { bsMap, unclassified });
      continue;
    }

    // Balance integrity check for extracted years.
    validateBalanceSheet(versionId, y, sectionTotalsFromTree(treesByYear[y], y));
  }

  const yearCols = years.map((y, i) => ({ key: `y${y}`, label: `FY ${y}`, isCurrent: i === years.length - 1 }));
  const hierarchicalRows = years.length === 1
    ? treesByYear[years[0]]
    : mergeCfByYear(treesByYear, years);

  console.log(`[KeyReports][BS] versionId=${versionId} hierarchicalRows=${hierarchicalRows.length} asOfDate=${latestAsOfDate} generatedFromGL=${anyGenerated}`);

  const changeCols = [];
  for (let i = 1; i < yearCols.length; i++) {
    changeCols.push({
      key: `c${i}`,
      label: `'${String(years[i]).slice(-2)} CHANGE`,
      from: yearCols[i - 1].key,
      to: yearCols[i].key,
    });
  }

  return {
    source: 'key_reports_entry_tables',
    hierarchicalRows,
    rows: hierarchicalRows,
    years,
    yearCols,
    asOfDate: latestAsOfDate,
    columns: {
      yearCols,
      changeCols,
      currentMonth: yearCols[yearCols.length - 1]?.label || '',
    },
  };
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

  let query = supabase
    .from('general_ledger_entries')
    .select(
      'id,row_type,row_number,fiscal_year,transaction_date,distribution_account,transaction_type,transaction_num,transaction_name,memo_description,split_account,amount,running_balance',
      { count: 'exact' }
    )
    .eq('version_id', versionId)
    .order('row_number', { ascending: true, nullsFirst: false })
    .order('id', { ascending: true })
    .range(from, to);

  // A single fiscal_year wins (spec #8 — never mix years); otherwise an explicit
  // date range narrows the transaction_date window (spec #11).
  if (year) {
    const y = parseInt(String(year), 10);
    if (y > 0) query = query.eq('fiscal_year', y);
  } else {
    if (startDate) query = query.gte('transaction_date', String(startDate));
    if (endDate) query = query.lte('transaction_date', String(endDate));
  }

  const { data, count, error } = await query;
  if (error) throw error;

  const years = await getDistinctYears('general_ledger_entries', versionId, 'fiscal_year');
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
async function fetchBSEntriesForYear(versionId, year) {
  const { data, error } = await supabase
    .from('balance_sheet_entries')
    .select('account_name, account_type, section, amount, hierarchy_level, is_total, sort_order, fiscal_year, as_of_date')
    .eq('version_id', versionId)
    .eq('fiscal_year', year)
    .order('sort_order', { ascending: true, nullsFirst: false })
    .order('id', { ascending: true });
  if (error) throw error;
  return data || [];
}

/** Raw profit_loss_entries rows for a single fiscal year (version-isolated). */
async function fetchPLEntriesForYear(versionId, year) {
  const { data, error } = await supabase
    .from('profit_loss_entries')
    .select('account_name, account_type, amount, hierarchy_level, is_total, sort_order, fiscal_year')
    .eq('version_id', versionId)
    .eq('fiscal_year', year)
    .order('sort_order', { ascending: true, nullsFirst: false })
    .order('id', { ascending: true });
  if (error) throw error;
  return data || [];
}

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
 * Builds a GAAP indirect-method Cash Flow statement PURELY from this version's
 * balance_sheet_entries + profit_loss_entries (Operating / Investing / Financing
 * classification via the shared buildCashFlow engine). Reads are version-isolated
 * and never touch Manual GL staging, batches, or qb_synced_reports.
 *
 * NOTE on source table: the spec lists general_ledger_entries as the cash-flow
 * source. In practice a Key Reports version that links only Balance Sheet + P&L
 * documents (the common case — and the only case the Cash Flow tab is enabled
 * for) has no GL rows, so the indirect method derived from BS deltas + P&L net
 * income is the correct and self-reconciling source. When GL entries exist they
 * still feed the engine indirectly via the BS/P&L the sync produced from them.
 */
async function getCashflowReport(versionId, { year, startDate, endDate } = {}) {
  if (!versionId) throw new Error('versionId is required');

  console.log(`[KeyReports][CF] versionId=${versionId} year=${year || 'all'} range=${startDate || '-'}..${endDate || '-'}`);

  // Cash Flow requires P&L (net income) — drive the year list off P&L, then apply
  // the date-range filter (spec #11–#13).
  const plYears = await getDistinctYears('profit_loss_entries', versionId, 'fiscal_year');
  let years = year
    ? [parseInt(String(year), 10)].filter((y) => y > 0)
    : plYears.filter(Boolean);
  if (!year) {
    const lo = startDate ? parseInt(String(startDate).slice(0, 4), 10) : null;
    const hi = endDate ? parseInt(String(endDate).slice(0, 4), 10) : null;
    if (lo) years = years.filter((y) => y >= lo);
    if (hi) years = years.filter((y) => y <= hi);
  }

  if (!years.length) {
    console.warn(`[KeyReports][CF] versionId=${versionId} NO P&L ROWS — run Sync first`);
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
    const [bsCurr, bsPrev, plCurr] = await Promise.all([
      fetchBSEntriesForYear(versionId, y),
      fetchBSEntriesForYear(versionId, y - 1),
      fetchPLEntriesForYear(versionId, y),
    ]);
    rowsRead += bsCurr.length + bsPrev.length + plCurr.length;

    const bsCurrTree = buildBSHierarchicalRows({ [y]: bsCurr }, [y]).hierarchicalRows;
    const bsPrevTree = bsPrev.length
      ? buildBSHierarchicalRows({ [y - 1]: bsPrev }, [y - 1]).hierarchicalRows
      : [];
    const plTree = buildPLHierarchicalRows({ [y]: plCurr }, [y]).hierarchicalRows || [];

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

  return {
    source: 'key_reports_entry_tables',
    hierarchicalRows,
    rows,
    years,
    yearCols,
    columns: { yearCols, ytdComparison: null },
  };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  getProfitLossReport,
  getBalanceSheetReport,
  getGeneralLedgerReport,
  getBankStatementReport,
  getTaxReturnReport,
  getCashflowReport,
  // Pure builders exported for the accuracy-validation harness (test fixtures).
  buildPLHierarchicalRows,
  buildBSHierarchicalRows,
  mergeCfByYear,
  // GL carry-forward generator (BS(year)=BS(year-1)+GL(year)) — reused by the
  // COA-driven financialStatementService as a fallback for years with no
  // uploaded balance sheet.
  bsBalancesForYear,
};
