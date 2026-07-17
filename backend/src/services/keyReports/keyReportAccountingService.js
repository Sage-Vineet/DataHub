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

// Earliest/latest GL transaction date (month granularity for the roll-forward).
// Also the sole source of first/last GL year now (migration 069 removed
// fiscal_year — every row, including historical dateless ones, has a real
// transaction_date after the migration's sentinel-date backfill, so there is
// no more separate fiscal_year-bounds source to reconcile against).
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

// Profit & Loss has no entry table (generated entirely from the GL, per
// migration 056) — its presence is a LINKED-DOCUMENT check, not an
// extracted-data check, so this reads key_report_file_mappings directly
// rather than joining against GL/BS bounds logic above.
async function profitLossMappingCount(versionId) {
  const { count } = await supabase
    .from("key_report_file_mappings")
    .select("id", { count: "exact", head: true })
    .eq("version_id", versionId)
    .eq("report_category", "profit_loss");
  return count || 0;
}

const BALANCE_SHEET_MODE_LABEL = Object.freeze({
  forward: "Opening Balance Sheet",
  reverse: "Ending Balance Sheet",
  dual: "Opening + Ending Balance Sheet",
});

/**
 * PHASE 1 — Validate available documents.
 *
 * Determines which accounting documents are usable and whether the accounting
 * workflow may proceed. Pure read; never throws on missing data.
 *
 * Validation order (client requirement):
 *   if (!gl)                        stop — MISSING_GENERAL_LEDGER
 *   if (!openingBS && !endingBS)    stop — MISSING_BALANCE_SHEET
 *   if (!profitLoss)                stop — MISSING_PROFIT_LOSS
 *   continue
 *
 *   - General Ledger REQUIRED. Absent ⇒ canGenerate = false (halt downstream).
 *   - EITHER a Starting Balance Sheet OR an Ending Balance Sheet is REQUIRED
 *     (or both). Absent both ⇒ canGenerate = false — without at least one of
 *     them there is no known balance at any point in time to roll from.
 *   - At least one Profit & Loss file REQUIRED (linked-document check, not an
 *     extracted-data check — P&L has no entry table; see profitLossMappingCount).
 *
 *   `balanceSheetMode` tells the caller which engine(s) to run — also the
 *   "Generation mode" surfaced in the validation-passed message and in sync
 *   logs (BALANCE_SHEET_MODE_LABEL):
 *       - 'forward' — Starting BS only. generateMonthlyBalanceSheets (unchanged).
 *       - 'reverse' — Ending BS only. generateMonthlyBalanceSheetsReverse:
 *         reconstructs monthly balances backward from the Ending BS.
 *       - 'dual'    — both present. Forward remains authoritative/persisted;
 *         the reverse engine + comparison are a follow-up (not yet wired into
 *         the sync orchestration — see docs/KEY_REPORTS plan).
 *
 * Balance Sheet role detection deliberately does NOT assume "Opening BS =
 * earliest GL year − 1" — different accounting systems export differently.
 * It is derived from the statement's own as_of_date/fiscal_year relative to
 * the GL's actual date range (see priorYearClosing/firstYearOpening below),
 * never from fiscal-year-label pattern matching.
 *
 * Starting Balance Sheet — two equally valid forms are accepted and
 * normalized to the SAME opening-balance object (see openingBs.fiscal_year,
 * consumed by generateMonthlyBalanceSheets):
 *   (a) "prior_year_closing"  — a closing snapshot for any year before the
 *       GL's first fiscal year (e.g. a 2022 Closing Balance Sheet for a GL
 *       that starts in 2023). This is the historical/default expectation.
 *   (b) "first_year_opening"  — a snapshot dated at/before the GL's very
 *       first transaction but filed under the GL's OWN first fiscal year
 *       (e.g. an "Opening Balance Sheet as of 1/1/2023" for that same 2023
 *       GL). Many clients only have this form, not a separate prior-year
 *       report — both represent the exact same point in time (the instant
 *       before the GL's first transaction), just labeled differently.
 *
 * @returns {Promise<{
 *   hasGL: boolean,
 *   glRowCount: number,
 *   glStartYear: number|null,
 *   glEndYear: number|null,
 *   glStartDate: string|null,
 *   glEndDate: string|null,
 *   openingBs: {as_of_date: string, fiscal_year: number}|null,
 *   openingBsMode: 'prior_year_closing'|'first_year_opening'|null,
 *   endingBs: {as_of_date: string, fiscal_year: number}|null,
 *   hasOpeningBs: boolean,
 *   hasEndingBs: boolean,
 *   hasProfitLoss: boolean,
 *   balanceSheetMode: 'forward'|'reverse'|'dual'|null,
 *   canGenerate: boolean,
 *   rows: Array<object>,   // validation rows (key_report_validation_results shape)
 * }>}
 */
async function classifyWorkflowDocuments(companyId, versionId) {
  const rows = [];
  if (!companyId || !versionId) {
    return {
      hasGL: false, glRowCount: 0, glStartYear: null, glEndYear: null,
      glStartDate: null, glEndDate: null, openingBs: null, openingBsMode: null, endingBs: null,
      hasOpeningBs: false, hasEndingBs: false, hasProfitLoss: false, balanceSheetMode: null, canGenerate: false, rows,
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
      message: "General Ledger is required.",
      metadata: { gate: "gl_required", code: "MISSING_GENERAL_LEDGER", canGenerate: false },
    });
    return {
      hasGL: false, glRowCount: 0, glStartYear: null, glEndYear: null,
      glStartDate: null, glEndDate: null, openingBs: null, openingBsMode: null, endingBs: null,
      hasOpeningBs: false, hasEndingBs: false, hasProfitLoss: false, balanceSheetMode: null, canGenerate: false, rows,
      haltReason: "general_ledger_required",
      haltMessage: "Sync completed, but the accounting workflow was halted: General Ledger is required. Link a General Ledger file and re-sync.",
    };
  }

  const [{ minDate, maxDate }, { earliest, latest }, plMappingCount] =
    await Promise.all([
      glDateRange(companyId, versionId),
      extractedBsBounds(companyId, versionId),
      profitLossMappingCount(versionId),
    ]);
  const hasProfitLoss = plMappingCount > 0;

  // First/last GL year, derived purely from transaction_date (migration 069 —
  // fiscal_year no longer exists; every row is guaranteed a real date, so
  // there's no separate bounds source to reconcile anymore).
  const yearOfIsoDate = (d) => {
    const y = d ? parseInt(String(d).slice(0, 4), 10) : NaN;
    return Number.isInteger(y) && y >= 1990 && y <= 2100 ? y : null;
  };
  const minYear = yearOfIsoDate(minDate);
  const maxYear = yearOfIsoDate(maxDate);

  const glStartDate = minDate || (minYear ? `${minYear}-01-01` : null);
  const glEndDate = maxDate || (maxYear ? `${maxYear}-12-31` : null);

  // See the two accepted forms documented above. Both are detected here and
  // normalized into the same `openingBs` object — the fiscal year it actually
  // carries (minYear-or-earlier vs. minYear itself) is what
  // generateMonthlyBalanceSheets uses to seed the roll-forward, so no
  // generation logic needs to know which form the client uploaded.
  const priorYearClosing = Boolean(earliest && minYear && Number(earliest.fiscal_year) < minYear);
  const firstYearOpening = Boolean(
    earliest && minYear && Number(earliest.fiscal_year) === minYear &&
      glStartDate && earliest.as_of_date && earliest.as_of_date <= glStartDate,
  );
  const hasOpeningBs = priorYearClosing || firstYearOpening;
  const openingBsMode = priorYearClosing ? "prior_year_closing" : firstYearOpening ? "first_year_opening" : null;

  // Ending BS = an extracted snapshot for (or after) the last GL year — the one
  // reconciliation compares the generated ending balances against.
  const hasEndingBs = Boolean(
    latest && maxYear && Number(latest.fiscal_year) >= maxYear,
  );

  // A Balance Sheet is required for the roll-forward/back — EITHER a Starting
  // BS (forward engine, unchanged) OR an Ending BS (reverse engine) satisfies
  // this; only having neither halts the workflow.
  if (!hasOpeningBs && !hasEndingBs) {
    const priorYear = minYear ? minYear - 1 : null;
    rows.push({
      dataType: "balance_sheet",
      year: minYear || null,
      status: "error",
      severity: "error",
      message:
        "At least one Balance Sheet (Opening or Ending) is required. " +
        `Upload either a Starting Balance Sheet (the previous fiscal year's Closing Balance Sheet${priorYear ? ` — e.g., ${priorYear}` : ''}, ` +
        `or the Opening Balance Sheet for the first General Ledger fiscal year${minYear ? ` — e.g., ${minYear}` : ''}) ` +
        `or an Ending Balance Sheet${maxYear ? ` (e.g., as of the end of ${maxYear})` : ''}, which will be used to reconstruct historical balances. ` +
        "Then re-sync.",
      metadata: { gate: "balance_sheet_required", code: "MISSING_BALANCE_SHEET", canGenerate: false, glStartDate, glEndDate },
    });
    return {
      hasGL: true,
      glRowCount: glCount,
      glStartYear: minYear,
      glEndYear: maxYear,
      glStartDate,
      glEndDate,
      openingBs: null,
      openingBsMode: null,
      endingBs: null,
      hasOpeningBs: false,
      hasEndingBs: false,
      hasProfitLoss,
      balanceSheetMode: null,
      canGenerate: false,
      rows,
      haltReason: "balance_sheet_required",
      haltMessage: "Sync completed, but the accounting workflow was halted: at least one Balance Sheet (Opening or Ending) is required. Link one and re-sync.",
    };
  }

  // balanceSheetMode tells the sync orchestrator which engine(s) to run —
  // computed once here so no downstream code re-derives this decision.
  const balanceSheetMode = hasOpeningBs && hasEndingBs ? "dual" : hasOpeningBs ? "forward" : "reverse";

  if (!hasProfitLoss) {
    rows.push({
      dataType: "profit_loss",
      year: null,
      status: "error",
      severity: "error",
      message: "At least one Profit & Loss statement is required.",
      metadata: { gate: "profit_loss_required", code: "MISSING_PROFIT_LOSS", canGenerate: false },
    });
    return {
      hasGL: true,
      glRowCount: glCount,
      glStartYear: minYear,
      glEndYear: maxYear,
      glStartDate,
      glEndDate,
      openingBs: hasOpeningBs ? earliest : null,
      openingBsMode,
      endingBs: hasEndingBs ? latest : null,
      hasOpeningBs,
      hasEndingBs,
      hasProfitLoss: false,
      balanceSheetMode,
      canGenerate: false,
      rows,
      haltReason: "profit_loss_required",
      haltMessage: "Sync completed, but the accounting workflow was halted: at least one Profit & Loss statement is required. Link one and re-sync.",
    };
  }

  rows.push({
    dataType: "validation_summary",
    year: null,
    status: "success",
    severity: "success",
    message: `Validation passed. Generation mode: ${BALANCE_SHEET_MODE_LABEL[balanceSheetMode]}.`,
    metadata: { gate: "validation_passed", balanceSheetMode, canGenerate: true },
  });

  return {
    hasGL: true,
    glRowCount: glCount,
    glStartYear: minYear,
    glEndYear: maxYear,
    glStartDate,
    glEndDate,
    openingBs: hasOpeningBs ? earliest : null,
    openingBsMode,
    endingBs: hasEndingBs ? latest : null,
    hasOpeningBs,
    hasEndingBs,
    hasProfitLoss,
    balanceSheetMode,
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
    // No blind default: an unrecognized/"unknown" type (never classified by
    // Gemini or matched to an existing chart_of_accounts row) must not be
    // silently binned into "equity" — it stays unsectioned instead.
    const section = SECTION_BY_TYPE[type] || null;
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

// Validates the fundamental accounting equation — Assets = Liabilities +
// Equity — for one month's just-built snapshot rows (before they're pushed
// into allRows). Shared by BOTH the forward and reverse engines so this
// invariant is checked identically regardless of generation direction.
// Returns null when balanced (within BALANCE_TOLERANCE); otherwise a record
// describing exactly what didn't balance, for the caller to surface as a
// validation row — the month is still stored (removing it would break the
// carry-forward chain for every later month), but the imbalance is never
// silently invisible.
function assertMonthBalances(rows, year, asOfDate) {
  let assets = 0;
  let liabilitiesAndEquity = 0;
  const accounts = [];
  const unclassifiedAccounts = [];
  for (const r of rows) {
    if (r.account_type === "asset") {
      assets += r.amount;
      accounts.push({ accountName: r.account_name, accountType: r.account_type, amount: r.amount });
    } else if (r.account_type === "liability" || r.account_type === "equity") {
      liabilitiesAndEquity += r.amount;
      accounts.push({ accountName: r.account_name, accountType: r.account_type, amount: r.amount });
    } else {
      // A BS-line account with no resolved type sits outside the equation
      // entirely (never guessed into a section) — very often the actual
      // root cause of an apparent imbalance, so called out separately.
      unclassifiedAccounts.push(r.account_name);
    }
  }
  const imbalance = round2(assets - liabilitiesAndEquity);
  if (Math.abs(imbalance) <= BALANCE_TOLERANCE) return null;
  return {
    year, asOfDate, imbalance,
    assets: round2(assets),
    liabilitiesAndEquity: round2(liabilitiesAndEquity),
    accounts,
    unclassifiedAccounts,
  };
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
 * @returns {Promise<{stored:number, months:number, years:number[], failedMonths:Array<object>}>}
 *   failedMonths — one entry per month where Assets != Liabilities+Equity
 *   (see assertMonthBalances); the month is still stored, never silently.
 */
async function generateMonthlyBalanceSheets(companyId, versionId, gate) {
  // Lazy require to avoid any load-order coupling.
  const { bsBalancesForYear, aggregateGLForBSByMonth, aggregateGLForBS } =
    require("./keyReportReportService");

  const startYear = gate?.glStartYear;
  const endYear = gate?.glEndYear;
  if (!startYear || !endYear) return { stored: 0, months: 0, years: [], failedMonths: [] };

  // Clear any previously generated rows (sync also does this at its start; repeat
  // here so a standalone regeneration is safe + idempotent).
  await supabase
    .from("balance_sheet_entries")
    .delete()
    .eq("version_id", versionId)
    .eq("is_generated", true);

  // Opening position: seed from whichever fiscal year the uploaded Starting
  // Balance Sheet actually resolved to during validation (gate.openingBs) —
  // either the prior year's closing (startYear - 1, the historical default)
  // or the GL's own first fiscal year's opening snapshot (startYear itself,
  // when the client only has an "Opening Balance Sheet as of 1/1/<startYear>").
  // Both are the exact same point in time (instant before the GL's first
  // transaction), so reusing whichever year the gate already validated —
  // instead of re-deriving one here — makes the two forms behave identically
  // without any change to bsBalancesForYear or the GL engines themselves.
  const openingYear = gate?.openingBs?.fiscal_year ?? (startYear - 1);
  const running = new Map();
  try {
    const opening = await bsBalancesForYear(versionId, openingYear);
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
  const failedMonths = [];

  // Cash-Flow gap fix: when the opening seed came from the GL's OWN first
  // fiscal year ("first_year_opening" — e.g. an "Opening Balance Sheet as of
  // 1/1/<startYear>"), nothing is ever stored under fiscal_year = startYear-1.
  // getCashflowReport/generateMonthlyCf look up Beginning Cash via
  // bsBalancesForYear(versionId, year-1) unconditionally, so without this they
  // would silently see zero Beginning Cash for the first year. Persisting the
  // just-loaded opening position as a synthetic startYear-1 Dec-31 snapshot
  // makes it discoverable by that same existing lookup — zero changes needed
  // to Cash Flow code. A real uploaded BS is never overwritten by this: this
  // synthetic row is is_generated=true, so bsBalancesForYear's own
  // extracted-rows-first check (hasExtractedRows) always prefers a genuine
  // upload if one exists.
  if (openingYear === startYear && running.size) {
    const { rows: seedRows, nextSort } = snapshotRows({
      versionId, companyId, year: startYear - 1, asOfDate: `${startYear - 1}-12-31`,
      running, cumulativeNetIncome: 0, sortStart: sort,
    });
    allRows.push(...seedRows);
    sort = nextSort;
  }

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
        const failure = assertMonthBalances(rows, year, asOf);
        if (failure) failedMonths.push(failure);
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
        const failure = assertMonthBalances(rows, year, asOf);
        if (failure) failedMonths.push(failure);
      }
    }

    yearsStored.push(year);
    // Year-end close: roll the year's Net Income into Retained Earnings so the next
    // year opens with a clean Net Income line (double-entry close).
    if (Math.abs(round2(cumulativeNetIncome)) >= 0.005) addRun(running, "Retained Earnings", cumulativeNetIncome, "equity");
  }

  if (allRows.length) await chunkedInsert("balance_sheet_entries", allRows);

  const monthsStored = new Set(allRows.map((r) => r.as_of_date)).size;
  return { stored: allRows.length, months: monthsStored, years: yearsStored, failedMonths };
}

// ============================================================================
// PHASE 4 (reverse) — Reverse Balance Sheet Engine
//
// For clients who only have an ENDING Balance Sheet (no Starting BS at all),
// reconstruct every monthly snapshot BACKWARD instead of forward:
//
//   Ending Balance
//     − December GL activity  = November-end Balance   (store November)
//     − November GL activity  = October-end Balance     (store October)
//     … repeated back to the first GL month.
//
// Reuses the exact same building blocks as the forward engine above —
// aggregateGLForBSByMonth (per-month deltas), aggregateGLForBS (no-date-data
// fallback), addRun/snapshotRows/monthEndDate/chunkedInsert — just walked in
// the opposite direction (subtract instead of add, latest month first). No
// GL aggregation logic is duplicated; only the traversal direction differs.
//
// Retained Earnings needs no special "unclose" step going backward: it only
// ever changes via the explicit year-end close (never via GL deltas), so
// subtracting a year's months never has to touch it — by the time the walk
// reaches a new (earlier) year's December, `running`'s RE already correctly
// reflects every year before that one, and cumulativeNetIncome is simply
// reset to that year's own full-year total (computed from the same byMonth
// map already being iterated) so it renders as a separate line exactly like
// the forward engine presents an as-yet-unclosed year.
// ============================================================================

/**
 * PHASE 4 (reverse) — Generate monthly Balance Sheets backward from an
 * uploaded Ending Balance Sheet. Mirrors generateMonthlyBalanceSheets's
 * contract exactly (same balance_sheet_entries shape, is_generated=true) so
 * every downstream consumer (Trial Balance is independent; P&L, Cash Flow,
 * financialStatementService, generateReconciliation) needs no changes.
 *
 * @param {object} opts
 * @param {boolean} [opts.persist=true]  When false, computed rows are
 *   returned instead of written — used by the (future) dual-validation shadow
 *   run so the forward engine's persisted rows are never overwritten.
 * @returns {Promise<{stored:number, months:number, years:number[], failedMonths:Array<object>, rows?:object[], warning?:string}>}
 */
async function generateMonthlyBalanceSheetsReverse(companyId, versionId, gate, opts = {}) {
  const { persist = true } = opts;
  // Lazy require to avoid any load-order coupling (same pattern as the forward engine).
  const { aggregateGLForBSByMonth, aggregateGLForBS } = require("./keyReportReportService");

  const startYear = gate?.glStartYear;
  const endYear = gate?.glEndYear;
  if (!startYear || !endYear) return { stored: 0, months: 0, years: [], failedMonths: [] };

  // Guard: the uploaded Ending BS must actually correspond to the GL's last
  // active month. A mid-year Ending BS (e.g. dated June while GL activity
  // continues through December) would make every subsequent month's
  // reconstruction silently wrong — refuse rather than guess (per the
  // "never silently ignore differences" requirement); a future pass can add
  // forward-fill from the Ending BS's own date to the true GL end.
  const endingAsOf = gate?.endingBs?.as_of_date || null;
  const glEndMonth = String(gate?.glEndDate || "").slice(0, 7);
  const endingMonth = String(endingAsOf || "").slice(0, 7);
  if (!endingAsOf || endingMonth !== glEndMonth) {
    return {
      stored: 0, months: 0, years: [], failedMonths: [],
      warning: "ending_bs_date_mismatch",
    };
  }

  if (persist) {
    await supabase
      .from("balance_sheet_entries")
      .delete()
      .eq("version_id", versionId)
      .eq("is_generated", true);
  }

  // Seed = the uploaded (non-generated) Ending BS for endYear — reuses the
  // existing Phase 5 helper below, which already picks the single latest
  // as_of_date snapshot for a year.
  const endingMap = await bsBalancesAtLatest(companyId, versionId, endYear, false);
  if (!endingMap.size) return { stored: 0, months: 0, years: [], failedMonths: [] };

  const running = new Map();
  let cumulativeNetIncome = 0;
  for (const [, v] of endingMap) {
    if (/^net\s*(income|loss)/i.test(String(v.name).trim())) { cumulativeNetIncome += v.amount; continue; }
    addRun(running, v.name, v.amount, v.type);
  }

  const allRows = [];
  let sort = 0;
  const yearsStored = [];
  const failedMonths = [];
  // Upper bound only — mirrors the forward engine's monthEndCutoff exactly,
  // so a month after the GL's last real activity is never fabricated (this
  // matters for endYear when the Ending BS's date equals the last GL month,
  // which the guard above already enforces).
  const monthEndCutoff = gate?.glEndDate || monthEndDate(endYear, 12);

  for (let year = endYear; year >= startYear; year--) {
    const byMonth = await aggregateGLForBSByMonth(versionId, year);

    // This year's FULL net income total — used as the starting NI line for
    // its own snapshots. For endYear, the uploaded Ending BS already gave us
    // this value (ground truth); for every earlier year it's computed from
    // the same byMonth map about to be walked (no extra query).
    let yearFullNetIncome;
    if (year === endYear) {
      yearFullNetIncome = cumulativeNetIncome;
    } else if (byMonth && byMonth.size) {
      yearFullNetIncome = 0;
      for (const mData of byMonth.values()) yearFullNetIncome += mData.netIncome;
      cumulativeNetIncome = yearFullNetIncome;
    } else {
      let agg = null;
      try { agg = await aggregateGLForBS(versionId, year); } catch (_e) { /* leave running unchanged */ }
      yearFullNetIncome = agg?.netIncome || 0;
      cumulativeNetIncome = yearFullNetIncome;
    }

    // "Un-close" — the exact inverse of the forward engine's year-end close.
    // Forward closes year Y's NI into RE only AFTER Y's own months (so the
    // updated RE becomes the base seen throughout year Y+1). Walking
    // backward, `running`'s RE was seeded at the value used throughout
    // endYear (= base carried from endYear-1's close). So BEFORE processing
    // any year *other than* endYear, RE must first be rolled back by THAT
    // year's own NI — not the year just finished — to reach the base that
    // was actually in effect during its months. Applying this at the top
    // (not bottom) of the loop, keyed off the CURRENT year, achieves exactly
    // that: it fires once per year-boundary crossing, using the year now
    // being entered.
    if (year !== endYear && Math.abs(round2(yearFullNetIncome)) >= 0.005) {
      addRun(running, "Retained Earnings", -yearFullNetIncome, "equity");
    }

    if (byMonth && byMonth.size) {
      // Walk every month 12→1 (not just months with activity) so this engine
      // produces the same one-snapshot-per-month granularity as the forward
      // engine — a month with no GL rows simply carries the balance through
      // unchanged, exactly like the forward loop's `if (mData) {...}` no-op.
      for (let m = 12; m >= 1; m--) {
        const asOf = monthEndDate(year, m);
        if (asOf > monthEndCutoff) continue; // never fabricate past the last real GL activity
        // `running` + `cumulativeNetIncome` right now represent END of month m
        // — snapshot BEFORE subtracting.
        const { rows, nextSort } = snapshotRows({
          versionId, companyId, year, asOfDate: asOf, running, cumulativeNetIncome, sortStart: sort,
        });
        allRows.push(...rows);
        sort = nextSort;
        const failure = assertMonthBalances(rows, year, asOf);
        if (failure) failedMonths.push(failure);

        // Undo month m's GL activity (if any) to step back to END of the PRIOR month.
        const mData = byMonth.get(m);
        if (mData) {
          for (const [name, acc] of mData.bsMap) addRun(running, name, -acc.net, acc.type);
          cumulativeNetIncome -= mData.netIncome;
        }
      }
    } else {
      // No usable transaction_date this year — mirror the forward engine's
      // fallback, just subtracting instead of adding.
      let agg = null;
      try { agg = await aggregateGLForBS(versionId, year); } catch (_e) { /* leave running unchanged */ }
      const asOf = monthEndDate(year, 12);
      if (asOf <= monthEndCutoff) {
        const { rows, nextSort } = snapshotRows({
          versionId, companyId, year, asOfDate: asOf, running, cumulativeNetIncome, sortStart: sort,
        });
        allRows.push(...rows);
        sort = nextSort;
        const failure = assertMonthBalances(rows, year, asOf);
        if (failure) failedMonths.push(failure);
      }
      if (agg?.bsMap) for (const [name, acc] of agg.bsMap) addRun(running, name, -acc.net, acc.type);
    }

    cumulativeNetIncome = 0;
    yearsStored.unshift(year);
  }

  // `running` now represents the reconstructed position immediately BEFORE
  // the GL's first transaction — persist it as a synthetic prior-year
  // snapshot so bsBalancesForYear(versionId, startYear-1) finds it exactly
  // like an uploaded Starting BS would (same Cash-Flow-gap technique as the
  // forward engine above — fixes Beginning Cash for year 1 with zero changes
  // to Cash Flow code).
  {
    const { rows: seedRows, nextSort } = snapshotRows({
      versionId, companyId, year: startYear - 1, asOfDate: `${startYear - 1}-12-31`,
      running, cumulativeNetIncome: 0, sortStart: sort,
    });
    allRows.push(...seedRows);
    sort = nextSort;
  }

  if (persist && allRows.length) await chunkedInsert("balance_sheet_entries", allRows);

  const monthsStored = new Set(allRows.map((r) => r.as_of_date)).size;
  return persist
    ? { stored: allRows.length, months: monthsStored, years: yearsStored, failedMonths }
    : { stored: 0, months: monthsStored, years: yearsStored, failedMonths, rows: allRows };
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
      .select("account_name, account_section, amount, running_balance, row_type, row_number, transaction_date")
      .eq("company_id", companyId)
      .eq("version_id", versionId)
      // fiscal_year no longer exists (migration 069) — a plain transaction_date
      // range is sufficient now that BEGINNING_BALANCE/TOTAL_ROW rows carry a
      // sentinel date and pre-existing dateless rows were backfilled.
      .gte("transaction_date", `${year}-01-01`)
      .lte("transaction_date", `${year}-12-31`)
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

// Shared imbalance tolerance for every "does this actually balance" check in
// this module (Trial Balance debit=credit, Monthly BS A=L+E, BS reconciliation
// variance) — one constant so every check agrees on what counts as noise vs.
// a real problem.
const BALANCE_TOLERANCE = 0.5;

/**
 * PHASE 3 — Generate and STORE the Trial Balance for a version (GL only).
 *
 * Validates the fundamental accounting invariant — ΔAssets = ΔLiabilities +
 * ΔEquity + Net Income — for each fiscal year, after building the rows,
 * before they are trusted by anything downstream.
 *
 * IMPORTANT: this is NOT a literal "sum of positive amounts = sum of negative
 * amounts" check. `general_ledger_entries.amount` uses NATURAL-BALANCE sign
 * convention (every account's own natural increase is stored as positive —
 * confirmed elsewhere in this codebase, e.g. aggregateGLForBS's comments), not
 * traditional debit-positive/credit-negative journal signs. A naive global
 * positive-vs-negative sum was tried and verified LIVE against a real,
 * already-reconciled company: it reported a multi-million-dollar "imbalance"
 * on every fiscal year of genuinely correct data (e.g. a Revenue account's
 * entire activity landing on the "debit" side simply because revenue
 * increases are stored positive) — that check would have false-positive
 * halted every real client's sync. The economically correct invariant for
 * this sign convention is the accounting equation itself, computed from the
 * SAME per-account `net_balance`/`account_type` this function already builds
 * — no new query, no new sign assumption.
 *
 * @returns {Promise<{stored:number, years:number[], imbalancedYears:Array<{
 *   year:number, assetMovement:number, liabilitiesPlusEquityMovement:number,
 *   netIncome:number, imbalance:number,
 *   topAccounts:Array<{accountName:string, accountType:string, netBalance:number}>,
 *   unclassifiedAccounts:string[],
 * }>}>}
 */
async function generateTrialBalance(companyId, versionId, gate) {
  const startYear = gate?.glStartYear;
  const endYear = gate?.glEndYear;
  if (!startYear || !endYear) return { stored: 0, years: [], imbalancedYears: [] };

  const typeMap = await coaTypeMap(versionId);
  const rowsToInsert = [];
  const yearsStored = [];
  const imbalancedYears = [];

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

    const yearRows = [];
    for (const [name, a] of acc) {
      if (Math.abs(a.debits) < 0.005 && Math.abs(a.credits) < 0.005 && !a.hasOpening) continue;
      yearRows.push({
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
    rowsToInsert.push(...yearRows);
    yearsStored.push(year);

    // Accounting-equation check (see doc comment above for why this replaces
    // a naive debit/credit sum): ΔAssets = ΔLiabilities + ΔEquity + Net Income,
    // using each account's own natural-balance net_balance movement for the year.
    let assetMovement = 0;
    let liabilitiesPlusEquityMovement = 0;
    let netIncome = 0;
    const unclassifiedAccounts = [];
    for (const r of yearRows) {
      const t = r.account_type;
      if (t === "asset") assetMovement += r.net_balance;
      else if (t === "liability" || t === "equity") liabilitiesPlusEquityMovement += r.net_balance;
      else if (t === "income" || t === "revenue") netIncome += r.net_balance;
      else if (t === "expense" || t === "cogs") netIncome -= r.net_balance;
      else unclassifiedAccounts.push(r.account_name);
    }
    const imbalance = round2(assetMovement - liabilitiesPlusEquityMovement - netIncome);
    if (Math.abs(imbalance) > BALANCE_TOLERANCE) {
      // Not a precise "which account is wrong" (an imbalance is systemic —
      // a missing offsetting entry, a misclassified account, or a genuine
      // GL parsing bug) — surface the accounts with the largest movement
      // that year as the starting point for manual review, never a false
      // claim of exact attribution.
      const topAccounts = yearRows
        .slice()
        .sort((a, b) => Math.abs(b.net_balance) - Math.abs(a.net_balance))
        .slice(0, 10)
        .map((r) => ({ accountName: r.account_name, accountType: r.account_type, netBalance: r.net_balance }));
      imbalancedYears.push({
        year,
        assetMovement: round2(assetMovement),
        liabilitiesPlusEquityMovement: round2(liabilitiesPlusEquityMovement),
        netIncome: round2(netIncome),
        imbalance,
        topAccounts,
        unclassifiedAccounts,
      });
    }
  }

  // Replace prior trial balance for this version.
  await supabase.from("trial_balance_entries").delete().eq("version_id", versionId);
  if (rowsToInsert.length) await chunkedInsert("trial_balance_entries", rowsToInsert);

  return { stored: rowsToInsert.length, years: yearsStored, imbalancedYears };
}

// ============================================================================
// PHASE 5 — Reconciliation (generated ending BS vs uploaded ending BS)
//
// When an Ending Balance Sheet has been uploaded, compare it (per account)
// against the GENERATED ending balances (the authoritative monthly roll-forward
// for the final GL year). Reports missing accounts, balance differences and the
// variance amounts. NEVER overwrites generated balances.
// ============================================================================

const RECON_TOLERANCE = BALANCE_TOLERANCE; // alias — kept for readability at existing call sites

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
  generateMonthlyBalanceSheetsReverse,
  generateReconciliation,
  linkGlToCoa,
  glDateRange,
  extractedBsBounds,
  monthEndDate,
};
