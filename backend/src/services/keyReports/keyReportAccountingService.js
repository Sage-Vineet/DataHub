// ============================================================================
// KEY REPORTS — ACCOUNTING WORKFLOW ENGINE
//
// The post-extraction accounting workflow that runs AFTER the extraction
// pipeline has stored raw data into the entry tables. It implements the
// client's required sequence:
//
//   [1] VALIDATE AVAILABLE DOCUMENTS   ← this module (classifyWorkflowDocuments)
//   [2] GENERATE CHART OF ACCOUNTS      (chartOfAccountsService)
//   [3] GENERATE TRIAL BALANCE          (M5)
//   [4] MONTHLY BALANCE SHEET ENGINE    (M4)
//   [5] RECONCILE vs UPLOADED ENDING BS (M6)
//
// General Ledger is the accounting source of truth. If no GL exists the
// accounting workflow is HALTED (per the client's Data Table WF): downstream
// generation is skipped and a validation error is surfaced.
//
// This module performs NO extraction — it only reads the entry tables the
// extraction pipeline already populated. Extraction stays unchanged.
// ============================================================================

const { supabase } = require("../../db");

const TABLE_GL = "general_ledger_entries";
const TABLE_BS = "balance_sheet_entries";

// First/last fiscal year present in the General Ledger (TRANSACTION rows).
async function glYearRange(companyId, versionId) {
  const base = () =>
    supabase
      .from(TABLE_GL)
      .select("fiscal_year")
      .eq("company_id", companyId)
      .eq("version_id", versionId)
      .not("fiscal_year", "is", null);

  const [{ data: minRows }, { data: maxRows }] = await Promise.all([
    base().order("fiscal_year", { ascending: true }).limit(1),
    base().order("fiscal_year", { ascending: false }).limit(1),
  ]);

  const minYear = minRows?.[0]?.fiscal_year ? Number(minRows[0].fiscal_year) : null;
  const maxYear = maxRows?.[0]?.fiscal_year ? Number(maxRows[0].fiscal_year) : null;
  return { minYear, maxYear };
}

// Earliest/latest GL transaction date (month granularity for the roll-forward).
async function glDateRange(companyId, versionId) {
  const base = () =>
    supabase
      .from(TABLE_GL)
      .select("transaction_date")
      .eq("company_id", companyId)
      .eq("version_id", versionId)
      .not("transaction_date", "is", null);

  const [{ data: minRows }, { data: maxRows }] = await Promise.all([
    base().order("transaction_date", { ascending: true }).limit(1),
    base().order("transaction_date", { ascending: false }).limit(1),
  ]);

  return {
    minDate: minRows?.[0]?.transaction_date || null,
    maxDate: maxRows?.[0]?.transaction_date || null,
  };
}

// Earliest/latest EXTRACTED (is_generated = false/null) balance-sheet snapshot.
async function extractedBsBounds(companyId, versionId) {
  const base = () =>
    supabase
      .from(TABLE_BS)
      .select("as_of_date, fiscal_year")
      .eq("company_id", companyId)
      .eq("version_id", versionId)
      .or("is_generated.eq.false,is_generated.is.null");

  const [{ data: earliest }, { data: latest }] = await Promise.all([
    base().order("as_of_date", { ascending: true }).limit(1),
    base().order("as_of_date", { ascending: false }).limit(1),
  ]);

  return {
    earliest: earliest?.[0] || null,
    latest: latest?.[0] || null,
  };
}

async function glRowCount(companyId, versionId) {
  const { count } = await supabase
    .from(TABLE_GL)
    .select("id", { count: "exact", head: true })
    .eq("company_id", companyId)
    .eq("version_id", versionId);
  return count || 0;
}

/**
 * PHASE 1 — Validate available documents.
 *
 * Determines which accounting documents are usable and whether the accounting
 * workflow may proceed. Pure read; never throws on missing data.
 *
 * Rules (client Data Table WF):
 *   - General Ledger REQUIRED. Absent ⇒ canGenerate = false (halt downstream).
 *   - Opening Balance Sheet REQUIRED for the roll-forward. Absent ⇒
 *     canGenerate = false (halt downstream) — without it every generated
 *     balance would start from a fabricated zero opening position.
 *   - Ending Balance Sheet OPTIONAL — used only for reconciliation.
 *
 * @returns {Promise<{
 *   hasGL: boolean,
 *   glRowCount: number,
 *   glStartYear: number|null,
 *   glEndYear: number|null,
 *   glStartDate: string|null,
 *   glEndDate: string|null,
 *   openingBs: {as_of_date: string, fiscal_year: number}|null,
 *   endingBs: {as_of_date: string, fiscal_year: number}|null,
 *   hasOpeningBs: boolean,
 *   hasEndingBs: boolean,
 *   canGenerate: boolean,
 *   rows: Array<object>,   // validation rows (key_report_validation_results shape)
 * }>}
 */
async function classifyWorkflowDocuments(companyId, versionId) {
  const rows = [];
  if (!companyId || !versionId) {
    return {
      hasGL: false, glRowCount: 0, glStartYear: null, glEndYear: null,
      glStartDate: null, glEndDate: null, openingBs: null, endingBs: null,
      hasOpeningBs: false, hasEndingBs: false, canGenerate: false, rows,
      haltReason: "general_ledger_required",
      haltMessage: "Sync completed, but the accounting workflow was halted: no General Ledger data was found. Link a General Ledger file and re-sync.",
    };
  }

  const glCount = await glRowCount(companyId, versionId);
  const hasGL = glCount > 0;

  if (!hasGL) {
    rows.push({
      dataType: "general_ledger",
      year: null,
      status: "error",
      severity: "error",
      message:
        "Upload a General Ledger before generating Key Reports. " +
        "No General Ledger data was found — the accounting workflow is halted. " +
        "Link a General Ledger file and re-sync.",
      metadata: { gate: "gl_required", canGenerate: false },
    });
    return {
      hasGL: false, glRowCount: 0, glStartYear: null, glEndYear: null,
      glStartDate: null, glEndDate: null, openingBs: null, endingBs: null,
      hasOpeningBs: false, hasEndingBs: false, canGenerate: false, rows,
      haltReason: "general_ledger_required",
      haltMessage: "Sync completed, but the accounting workflow was halted: no General Ledger data was found. Link a General Ledger file and re-sync.",
    };
  }

  const [{ minYear: fyMinYear, maxYear: fyMaxYear }, { minDate, maxDate }, { earliest, latest }] =
    await Promise.all([
      glYearRange(companyId, versionId),
      glDateRange(companyId, versionId),
      extractedBsBounds(companyId, versionId),
    ]);

  // Reconcile the fiscal-year bounds with the years implied by transaction_date.
  // A GL row can have a valid transaction_date but a NULL fiscal_year (e.g. a
  // year whose date-parsing set the date column but not the year, or rows
  // extracted before fiscal_year was backfilled). glYearRange() ignores those
  // rows, so relying on it alone SILENTLY DROPS such a year from every generator
  // that loops glStartYear..glEndYear (Trial Balance, Monthly Balance Sheet, the
  // P&L validation rows). The report renderers, by contrast, recover those years
  // via resolveYears()'s transaction_date fallback — producing the classic
  // "final fiscal year is missing from the generated reports" defect.
  //
  // Folding the transaction_date-derived min/max into the authoritative bounds
  // keeps every generator on the SAME year set the renderers use. Generic — no
  // company- or year-specific logic; works for any first/last year.
  const yearOfIsoDate = (d) => {
    const y = d ? parseInt(String(d).slice(0, 4), 10) : NaN;
    return Number.isInteger(y) && y >= 1990 && y <= 2100 ? y : null;
  };
  const minDateYear = yearOfIsoDate(minDate);
  const maxDateYear = yearOfIsoDate(maxDate);

  const minCandidates = [fyMinYear, minDateYear].filter((v) => Number.isInteger(v));
  const maxCandidates = [fyMaxYear, maxDateYear].filter((v) => Number.isInteger(v));
  const minYear = minCandidates.length ? Math.min(...minCandidates) : null;
  const maxYear = maxCandidates.length ? Math.max(...maxCandidates) : null;

  if ((fyMinYear !== minYear || fyMaxYear !== maxYear)) {
    console.warn(
      `[KeyReports][GateYears] version=${versionId} fiscal_year bounds [${fyMinYear}..${fyMaxYear}] ` +
      `extended to [${minYear}..${maxYear}] using transaction_date — a year had rows with NULL fiscal_year.`,
    );
  }

  const glStartDate = minDate || (minYear ? `${minYear}-01-01` : null);
  const glEndDate = maxDate || (maxYear ? `${maxYear}-12-31` : null);

  // Opening BS = an extracted snapshot at/before the GL start (typically the
  // prior year-end), or whose fiscal year precedes the first GL year.
  const hasOpeningBs = Boolean(
    earliest &&
      ((glStartDate && earliest.as_of_date && earliest.as_of_date <= glStartDate) ||
        (minYear && Number(earliest.fiscal_year) < minYear)),
  );

  // Ending BS = an extracted snapshot for (or after) the last GL year — the one
  // reconciliation compares the generated ending balances against.
  const hasEndingBs = Boolean(
    latest && maxYear && Number(latest.fiscal_year) >= maxYear,
  );

  if (!hasOpeningBs) {
    rows.push({
      dataType: "balance_sheet",
      year: minYear || null,
      status: "error",
      severity: "error",
      message:
        "An Opening Balance Sheet is required to generate financial statements. " +
        "Please upload and link an Opening Balance Sheet (a snapshot at or " +
        "before the General Ledger's start date) and re-sync.",
      metadata: { gate: "opening_bs_required", canGenerate: false, glStartDate },
    });
    return {
      hasGL: true,
      glRowCount: glCount,
      glStartYear: minYear,
      glEndYear: maxYear,
      glStartDate,
      glEndDate,
      openingBs: null,
      endingBs: hasEndingBs ? latest : null,
      hasOpeningBs: false,
      hasEndingBs,
      canGenerate: false,
      rows,
      haltReason: "opening_balance_sheet_required",
      haltMessage: "Sync completed, but the accounting workflow was halted: no Opening Balance Sheet was found. Link an Opening Balance Sheet and re-sync.",
    };
  }

  return {
    hasGL: true,
    glRowCount: glCount,
    glStartYear: minYear,
    glEndYear: maxYear,
    glStartDate,
    glEndDate,
    openingBs: hasOpeningBs ? earliest : null,
    endingBs: hasEndingBs ? latest : null,
    hasOpeningBs,
    hasEndingBs,
    canGenerate: true,
    rows,
  };
}

// ============================================================================
// PHASE 4 — Monthly Balance Sheet engine
//
// The uploaded Balance Sheet is only the OPENING position. The authoritative
// monthly Balance Sheet records are GENERATED here and STORED in
// balance_sheet_entries with is_generated = true, one snapshot per month-end:
//
//   Opening Balance Sheet
//        + January GL activity   = January Balance Sheet   (store)
//        + February GL activity  = February Balance Sheet  (store)
//        … repeated to the final GL month.
//
// Each generated month becomes the opening balance for the next. Uploaded
// balance sheets are NEVER copied into storage — they are the opening seed
// (prior period-end) and, for the ending BS, reconciliation input only.
// ============================================================================

const { round2 } = (() => {
  const r = (v) => Math.round((Number(v) || 0) * 100) / 100;
  return { round2: r };
})();

const SECTION_BY_TYPE = Object.freeze({ asset: "assets", liability: "liabilities", equity: "equity" });

function monthEndDate(year, m) {
  const isLeap = (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0));
  const lastDay = [31, isLeap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  return `${year}-${String(m).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
}

// Natural-sign accumulation. GL aggregation converts debit-minus-credit values
// before they reach this running monthly balance map.
function addRun(map, name, delta, type) {
  const key = String(name || "").trim();
  if (!key) return;
  if (!map.has(key)) map.set(key, { name: key, balance: 0, type: type || "unknown" });
  const e = map.get(key);
  e.balance += Number(delta) || 0;
  if (type && (e.type === "unknown" || !e.type)) e.type = type;
}

// Build the per-account balance_sheet_entries rows for one month-end snapshot
// from the running natural-sign balances + the current-year cumulative Net Income.
function snapshotRows({ versionId, companyId, year, asOfDate, running, cumulativeNetIncome, sortStart }) {
  const rows = [];
  let sort = sortStart;
  const push = (name, amount, type) => {
    if (Math.abs(round2(amount)) < 0.005) return;
    const section = SECTION_BY_TYPE[type] || "equity";
    rows.push({
      version_id: versionId,
      company_id: companyId,
      source_file_id: null,
      as_of_date: asOfDate,
      fiscal_year: year,
      account_name: name,
      account_number: null,
      account_type: type,
      section,
      amount: round2(amount),
      hierarchy_level: 2,
      parent_account_id: null,
      sort_order: sort++,
      is_total: false,
      is_generated: true,
    });
  };
  for (const v of running.values()) push(v.name, v.balance, v.type);
  // Current-year cumulative Net Income is a separate equity line (not merged into RE
  // until year-end close) — matches the bsBalancesForYear presentation.
  if (Math.abs(round2(cumulativeNetIncome)) >= 0.005) push("Net Income", cumulativeNetIncome, "equity");
  return { rows, nextSort: sort };
}

async function chunkedInsert(table, rows, chunk = 500) {
  for (let i = 0; i < rows.length; i += chunk) {
    const { error } = await supabase.from(table).insert(rows.slice(i, i + chunk));
    if (error) throw error;
  }
}

/**
 * PHASE 4 — Generate and STORE the monthly Balance Sheets for a version.
 * Reuses the tested GL engines from keyReportReportService:
 *   - bsBalancesForYear (opening seed = prior period-end / uploaded opening BS)
 *   - aggregateGLForBSByMonth (per-month BS deltas + monthly net income)
 *   - aggregateGLForBS (full-year fallback when GL has no usable transaction_date)
 *
 * @returns {Promise<{stored:number, months:number, years:number[]}>}
 */
async function generateMonthlyBalanceSheets(companyId, versionId, gate) {
  // Lazy require to avoid any load-order coupling.
  const { bsBalancesForYear, aggregateGLForBSByMonth, aggregateGLForBS } =
    require("./keyReportReportService");

  const startYear = gate?.glStartYear;
  const endYear = gate?.glEndYear;
  if (!startYear || !endYear) return { stored: 0, months: 0, years: [] };

  // Clear any previously generated rows (sync also does this at its start; repeat
  // here so a standalone regeneration is safe + idempotent).
  await supabase
    .from("balance_sheet_entries")
    .delete()
    .eq("version_id", versionId)
    .eq("is_generated", true);

  // Opening position = close of the year BEFORE the first GL year. bsBalancesForYear
  // reads the uploaded opening (prior period-end) BS when present, else carries
  // forward from earlier GL. Close its Net Income line into Retained Earnings.
  const running = new Map();
  try {
    const opening = await bsBalancesForYear(versionId, startYear - 1);
    if (opening?.balances?.size) {
      for (const v of opening.balances.values()) {
        if (/^net\s+income$/i.test(String(v.name).trim())) addRun(running, "Retained Earnings", v.balance, "equity");
        else addRun(running, v.name, v.balance, v.type);
      }
    }
  } catch (_e) { /* no opening → start from zero (gate already warned) */ }

  const allRows = [];
  let sort = 0;
  const monthEndCutoff = gate?.glEndDate || monthEndDate(endYear, 12);
  const yearsStored = [];

  for (let year = startYear; year <= endYear; year++) {
    let cumulativeNetIncome = 0;
    const byMonth = await aggregateGLForBSByMonth(versionId, year);

    if (byMonth && byMonth.size) {
      for (let m = 1; m <= 12; m++) {
        const asOf = monthEndDate(year, m);
        if (asOf > monthEndCutoff) break; // don't fabricate months past the last GL activity
        const mData = byMonth.get(m);
        if (mData) {
          for (const [name, acc] of mData.bsMap) addRun(running, name, acc.net, acc.type);
          cumulativeNetIncome += mData.netIncome;
        }
        const { rows, nextSort } = snapshotRows({
          versionId, companyId, year, asOfDate: asOf, running, cumulativeNetIncome, sortStart: sort,
        });
        allRows.push(...rows);
        sort = nextSort;
      }
    } else {
      // No usable transaction_date → store a single year-end snapshot from the
      // full-year GL aggregate (still authoritative; just not month-resolved).
      try {
        const agg = await aggregateGLForBS(versionId, year);
        if (agg?.bsMap) {
          for (const [name, acc] of agg.bsMap) addRun(running, name, acc.net, acc.type);
          cumulativeNetIncome += agg.netIncome || 0;
        }
      } catch (_e) { /* leave running unchanged */ }
      const asOf = monthEndDate(year, 12);
      if (asOf <= monthEndCutoff) {
        const { rows, nextSort } = snapshotRows({
          versionId, companyId, year, asOfDate: asOf, running, cumulativeNetIncome, sortStart: sort,
        });
        allRows.push(...rows);
        sort = nextSort;
      }
    }

    yearsStored.push(year);
    // Year-end close: roll the year's Net Income into Retained Earnings so the next
    // year opens with a clean Net Income line (double-entry close).
    if (Math.abs(round2(cumulativeNetIncome)) >= 0.005) addRun(running, "Retained Earnings", cumulativeNetIncome, "equity");
  }

  if (allRows.length) await chunkedInsert("balance_sheet_entries", allRows);

  const monthsStored = new Set(allRows.map((r) => r.as_of_date)).size;
  return { stored: allRows.length, months: monthsStored, years: yearsStored };
}

// ============================================================================
// PHASE 3 — Trial Balance (generated directly from the General Ledger)
//
// For every account, per fiscal year: total debits, total credits, net balance,
// opening balance and closing balance — computed from general_ledger_entries
// only (never from uploaded reports). Stored in trial_balance_entries.
//
// Sign convention (consistent with the rest of the GL engines, which use the
// signed `amount` column = debit − credit):
//   debit movement  → amount > 0
//   credit movement → amount < 0
//   total_debits  = Σ amount where amount > 0
//   total_credits = Σ −amount where amount < 0
//   net_balance   = Σ amount  ( = total_debits − total_credits )
//   opening       = BEGINNING_BALANCE running_balance (when present)
//   closing       = opening + net_balance
// ============================================================================

function glAccountName(row) {
  return (row.account_name && String(row.account_name).trim())
    || (row.account_section && String(row.account_section).trim())
    || "";
}

// COA name → account_type map (the COA is the master accounting dimension).
async function coaTypeMap(versionId) {
  const map = new Map();
  const { data } = await supabase
    .from("chart_of_accounts")
    .select("account_name, adjusted_name, base_account, account_type, metadata")
    .eq("version_id", versionId);
  for (const r of data || []) {
    if (r.metadata?.is_group) continue;
    for (const n of [r.account_name, r.adjusted_name, r.base_account]) {
      const k = String(n || "").trim().toLowerCase();
      if (k && !map.has(k)) map.set(k, r.account_type || null);
    }
  }
  return map;
}

async function fetchGlRowsForYear(companyId, versionId, year) {
  const out = [];
  let from = 0;
  const PAGE = 1000;
  for (let page = 0; page < 1000; page += 1) {
    const { data, error } = await supabase
      .from(TABLE_GL)
      .select("account_name, account_section, amount, running_balance, row_type, row_number, fiscal_year, transaction_date")
      .eq("company_id", companyId)
      .eq("version_id", versionId)
      // Include rows for `year` whose fiscal_year is NULL but whose
      // transaction_date falls in the year — mirrors fetchAllGLRows so the Trial
      // Balance covers the same rows the reports do (see Fix 1 rationale).
      .or(
        `fiscal_year.eq.${year},` +
        `and(fiscal_year.is.null,transaction_date.gte.${year}-01-01,transaction_date.lte.${year}-12-31)`,
      )
      .order("row_number", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || !data.length) break;
    out.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

/**
 * PHASE 3 — Generate and STORE the Trial Balance for a version (GL only).
 * @returns {Promise<{stored:number, years:number[]}>}
 */
async function generateTrialBalance(companyId, versionId, gate) {
  const startYear = gate?.glStartYear;
  const endYear = gate?.glEndYear;
  if (!startYear || !endYear) return { stored: 0, years: [] };

  const typeMap = await coaTypeMap(versionId);
  const rowsToInsert = [];
  const yearsStored = [];

  for (let year = startYear; year <= endYear; year += 1) {
    const glRows = await fetchGlRowsForYear(companyId, versionId, year);
    if (!glRows.length) continue;

    // name → { debits, credits, net, opening }
    const acc = new Map();
    const get = (name) => {
      if (!acc.has(name)) acc.set(name, { debits: 0, credits: 0, net: 0, opening: 0, hasOpening: false });
      return acc.get(name);
    };

    for (const r of glRows) {
      const name = glAccountName(r);
      if (!name) continue;
      const rowType = r.row_type || "TRANSACTION";
      if (rowType === "BEGINNING_BALANCE") {
        const a = get(name);
        a.opening = Number(r.running_balance) || 0;
        a.hasOpening = true;
      } else if (rowType === "TRANSACTION" || !r.row_type) {
        const amt = Number(r.amount) || 0;
        if (Math.abs(amt) < 0.005) continue;
        const a = get(name);
        a.net += amt;
        if (amt > 0) a.debits += amt;
        else a.credits += -amt;
      }
      // ACCOUNT_HEADER / TOTAL_ROW are ignored.
    }

    for (const [name, a] of acc) {
      if (Math.abs(a.debits) < 0.005 && Math.abs(a.credits) < 0.005 && !a.hasOpening) continue;
      rowsToInsert.push({
        version_id: versionId,
        company_id: companyId,
        fiscal_year: year,
        account_name: name,
        account_number: null,
        account_type: typeMap.get(name.toLowerCase()) || null,
        total_debits: round2(a.debits),
        total_credits: round2(a.credits),
        net_balance: round2(a.net),
        opening_balance: round2(a.opening),
        closing_balance: round2(a.opening + a.net),
      });
    }
    yearsStored.push(year);
  }

  // Replace prior trial balance for this version.
  await supabase.from("trial_balance_entries").delete().eq("version_id", versionId);
  if (rowsToInsert.length) await chunkedInsert("trial_balance_entries", rowsToInsert);

  return { stored: rowsToInsert.length, years: yearsStored };
}

// ============================================================================
// PHASE 5 — Reconciliation (generated ending BS vs uploaded ending BS)
//
// When an Ending Balance Sheet has been uploaded, compare it (per account)
// against the GENERATED ending balances (the authoritative monthly roll-forward
// for the final GL year). Reports missing accounts, balance differences and the
// variance amounts. NEVER overwrites generated balances.
// ============================================================================

const RECON_TOLERANCE = 0.5;

// Latest-as-of balances for a year filtered by is_generated. Returns
// Map<normName, { name, amount, type, section }>.
async function bsBalancesAtLatest(companyId, versionId, year, generated) {
  const base = () =>
    supabase
      .from(TABLE_BS)
      .select("as_of_date")
      .eq("company_id", companyId)
      .eq("version_id", versionId)
      .eq("fiscal_year", year);
  let dq = base();
  dq = generated ? dq.eq("is_generated", true) : dq.or("is_generated.is.null,is_generated.eq.false");
  const { data: dr } = await dq.order("as_of_date", { ascending: false }).limit(1);
  const asOf = dr?.[0]?.as_of_date;
  if (!asOf) return new Map();

  let rq = supabase
    .from(TABLE_BS)
    .select("account_name, account_type, section, amount, is_total")
    .eq("company_id", companyId)
    .eq("version_id", versionId)
    .eq("fiscal_year", year)
    .eq("as_of_date", asOf);
  rq = generated ? rq.eq("is_generated", true) : rq.or("is_generated.is.null,is_generated.eq.false");
  const { data } = await rq;

  const map = new Map();
  for (const e of data || []) {
    const name = String(e.account_name || "").trim();
    if (!name) continue;
    const isNI = /^net\s*(income|loss)/i.test(name);
    if (e.is_total && !isNI) continue; // skip calculated totals (keep Net Income)
    const key = name.toLowerCase();
    const type = e.account_type
      || (e.section === "assets" ? "asset" : e.section === "liabilities" ? "liability" : e.section === "equity" ? "equity" : null);
    if (!map.has(key)) map.set(key, { name, amount: 0, type, section: e.section || null });
    map.get(key).amount += Number(e.amount) || 0;
  }
  return map;
}

/**
 * PHASE 5 — Reconcile the generated ending BS against the uploaded ending BS.
 * Only runs when an ending balance sheet is present (gate.hasEndingBs).
 * @returns {Promise<{ran:boolean, stored:number, year:number|null, summary:object}>}
 */
async function generateReconciliation(companyId, versionId, gate) {
  // Always clear prior reconciliation for this version (idempotent).
  await supabase.from("bs_reconciliation_entries").delete().eq("version_id", versionId);

  const year = gate?.glEndYear;
  if (!gate?.hasEndingBs || !year) {
    return { ran: false, stored: 0, year: year || null, summary: { reason: "no_ending_balance_sheet" } };
  }

  const [generated, uploaded] = await Promise.all([
    bsBalancesAtLatest(companyId, versionId, year, true),
    bsBalancesAtLatest(companyId, versionId, year, false),
  ]);

  if (!uploaded.size) {
    return { ran: false, stored: 0, year, summary: { reason: "uploaded_ending_bs_empty" } };
  }

  const keys = new Set([...generated.keys(), ...uploaded.keys()]);
  const rows = [];
  const summary = { matched: 0, differences: 0, missingInGenerated: 0, missingInUploaded: 0, totalVariance: 0 };

  for (const key of keys) {
    const g = generated.get(key);
    const u = uploaded.get(key);
    const gen = g ? round2(g.amount) : 0;
    const upl = u ? round2(u.amount) : 0;
    const variance = round2(gen - upl);
    const name = (g || u).name;
    const type = (g || u).type || null;
    const section = (g || u).section || (type ? SECTION_BY_TYPE[type] : null);

    let status;
    if (!g) status = "missing_in_generated";
    else if (!u) status = "missing_in_uploaded";
    else status = Math.abs(variance) < RECON_TOLERANCE ? "match" : "difference";

    const needsReview = status !== "match";
    if (status === "match") summary.matched += 1;
    else if (status === "difference") summary.differences += 1;
    else if (status === "missing_in_generated") summary.missingInGenerated += 1;
    else summary.missingInUploaded += 1;
    summary.totalVariance = round2(summary.totalVariance + Math.abs(variance));

    rows.push({
      version_id: versionId,
      company_id: companyId,
      fiscal_year: year,
      account_name: name,
      account_type: type,
      section,
      generated_balance: gen,
      uploaded_balance: upl,
      variance,
      status,
      needs_review: needsReview,
    });
  }

  if (rows.length) await chunkedInsert("bs_reconciliation_entries", rows);
  summary.balanced = summary.differences === 0 && summary.missingInGenerated === 0 && summary.missingInUploaded === 0;
  return { ran: true, stored: rows.length, year, summary };
}

// ============================================================================
// PHASE 2b — Link GL rows to Chart of Accounts (populate coa_id)
//
// After COA generation, each TRANSACTION row in general_ledger_entries should
// reference its matching chart_of_accounts row via coa_id. This enables reports
// to use coa_id for fast lookups instead of string matching.
//
// Matching strategy (in order of precedence):
//   1. Exact account_name match against chart_of_accounts.account_name
//   2. Exact account_name match against chart_of_accounts.base_account
//   3. Exact account_name match against chart_of_accounts.adjusted_name
//
// Only TRANSACTION rows (or rows without a row_type) are linked.
// Non-leaf COA rows (is_group = true) are excluded.
// ============================================================================

async function linkGlToCoa(companyId, versionId) {
  // Fetch all COA leaf nodes for this version.
  const { data: coaRows, error: coaErr } = await supabase
    .from("chart_of_accounts")
    .select("id, account_name, base_account, adjusted_name, metadata")
    .eq("version_id", versionId);

  if (coaErr) {
    console.warn(`[linkGlToCoa] COA fetch error: ${coaErr.message}`);
    return { linked: 0, skipped: 0 };
  }

  if (!coaRows?.length) {
    console.log("[linkGlToCoa] No COA rows found — skipping coa_id population");
    return { linked: 0, skipped: 0 };
  }

  // Build lookup maps: normalized name → coa id (leaf nodes only).
  const norm = (s) => String(s || "").toLowerCase().trim();
  const byName = new Map();
  for (const row of coaRows) {
    if (row.metadata?.is_group) continue;
    for (const field of [row.account_name, row.base_account, row.adjusted_name]) {
      const k = norm(field);
      if (k && !byName.has(k)) byName.set(k, row.id);
    }
  }

  if (!byName.size) {
    console.log("[linkGlToCoa] No COA leaf nodes found — skipping coa_id population");
    return { linked: 0, skipped: 0 };
  }

  // Page through GL TRANSACTION rows for this version, batch-update coa_id.
  const PAGE = 500;
  let from = 0;
  let linked = 0;
  let skipped = 0;

  for (;;) {
    const { data: glRows, error: glErr } = await supabase
      .from(TABLE_GL)
      .select("id, account_name")
      .eq("company_id", companyId)
      .eq("version_id", versionId)
      .or("row_type.eq.TRANSACTION,row_type.is.null")
      .not("account_name", "is", null)
      .is("coa_id", null)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);

    if (glErr) {
      console.warn(`[linkGlToCoa] GL fetch error: ${glErr.message}`);
      break;
    }
    if (!glRows?.length) break;

    // Group by coa_id to minimise UPDATE calls.
    const byCoa = new Map(); // coaId → [glId]
    for (const row of glRows) {
      const coaId = byName.get(norm(row.account_name));
      if (coaId) {
        if (!byCoa.has(coaId)) byCoa.set(coaId, []);
        byCoa.get(coaId).push(row.id);
      } else {
        skipped++;
      }
    }

    for (const [coaId, ids] of byCoa) {
      const { error: updErr } = await supabase
        .from(TABLE_GL)
        .update({ coa_id: coaId })
        .in("id", ids);
      if (updErr) {
        console.warn(`[linkGlToCoa] Update error for coa_id=${coaId}: ${updErr.message}`);
      } else {
        linked += ids.length;
      }
    }

    if (glRows.length < PAGE) break;
    from += PAGE;
  }

  console.log(`[linkGlToCoa] versionId=${versionId}: linked=${linked} skipped=${skipped}`);
  return { linked, skipped };
}

module.exports = {
  classifyWorkflowDocuments,
  generateTrialBalance,
  generateMonthlyBalanceSheets,
  generateReconciliation,
  linkGlToCoa,
  glYearRange,
  glDateRange,
  extractedBsBounds,
  monthEndDate,
};
