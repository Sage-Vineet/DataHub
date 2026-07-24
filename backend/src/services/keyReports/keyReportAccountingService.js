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

// ============================================================================
// Balance Sheet Coverage (replaces the old single earliest/latest-row model)
//
// The prior design asked "is THIS ONE row (the globally earliest/latest
// balance_sheet_entries row) an Opening BS, or an Ending BS?" — an either/or
// question that breaks the moment more than one Balance Sheet is uploaded, or
// a single comparative Balance Sheet spans multiple years: a document
// covering 2022-2025 IS the Opening BS for a 2023-2026 GL, but the old code
// only ever looked at ONE globally-extreme row, so a second, later-dated
// document (e.g. a 2026-only Ending BS) could hide that first document's
// 2022 coverage from ever being seen at all.
//
// The new model asks a different question entirely: build every uploaded
// Balance Sheet document's own YEAR COVERAGE (never its upload order, file
// name, or an "opening"/"ending" label), then ask whether the UNION of all
// of them reaches back far enough to seed the GL's start, and/or forward
// enough to reconcile against the GL's end.
async function buildBsCoverage(companyId, versionId) {
  const { data, error } = await supabase
    .from(TABLE_BS)
    .select("source_file_id, as_of_date, fiscal_year")
    .eq("company_id", companyId)
    .eq("version_id", versionId)
    .or("is_generated.eq.false,is_generated.is.null");
  if (error || !data?.length) return { documents: [], coverageYears: [] };

  const bySource = new Map();
  for (const row of data) {
    const key = row.source_file_id || "__unlinked__";
    if (!bySource.has(key)) bySource.set(key, []);
    bySource.get(key).push(row);
  }

  const documents = [];
  for (const [documentId, rows] of bySource) {
    const years = Array.from(new Set(rows.map((r) => Number(r.fiscal_year)).filter(Number.isInteger))).sort((a, b) => a - b);
    if (!years.length) continue;
    const latestRow = rows.slice().sort((a, b) => String(a.as_of_date || "").localeCompare(String(b.as_of_date || ""))).pop();
    documents.push({
      documentId,
      years,
      earliestYear: years[0],
      latestYear: years[years.length - 1],
      statementDate: latestRow?.as_of_date || null,
      isComparative: years.length > 1,
    });
  }
  documents.sort((a, b) => a.earliestYear - b.earliestYear);

  const coverageYears = Array.from(new Set(documents.flatMap((d) => d.years))).sort((a, b) => a - b);
  return { documents, coverageYears };
}

// The actual snapshot row(s) for one fiscal year — used once the coverage
// analysis below has decided WHICH year to seed the opening/ending balance
// from, to read its real as_of_date (needed by the roll-forward/back engines
// and by the first_year_opening vs. prior_year_closing distinction).
async function findBsSnapshotForYear(companyId, versionId, year) {
  if (year == null) return null;
  const { data } = await supabase
    .from(TABLE_BS)
    .select("as_of_date, fiscal_year")
    .eq("company_id", companyId).eq("version_id", versionId)
    .eq("fiscal_year", year)
    .or("is_generated.eq.false,is_generated.is.null")
    .order("as_of_date", { ascending: false })
    .limit(1);
  return data?.[0] || null;
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

  const [{ minDate, maxDate }, bsCoverage, plMappingCount] =
    await Promise.all([
      glDateRange(companyId, versionId),
      buildBsCoverage(companyId, versionId),
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

  // ── Opening / Ending Coverage ──────────────────────────────────────────────
  // Never "is THIS document an Opening BS or an Ending BS" — a document can be
  // both (a single 2022-2026 file), or coverage can come from the UNION of
  // several documents (one 2022-2025 file + a separate 2026 file). Evaluated
  // purely from bsCoverage.coverageYears (every uploaded Balance Sheet's own
  // fiscal years) relative to the GL's own start/end — never upload order,
  // file name, or an "opening"/"ending" label.
  //
  // Opening Coverage: some document's earliestYear reaches back to (or before)
  // the GL's start year. To actually SEED the roll-forward we need one real
  // year to open from, preferred in this order:
  //   1. The closest year strictly BEFORE glStartYear that was uploaded (a
  //      genuine prior-year CLOSING balance — e.g. FY2022 closing seeds a
  //      2023 GL). Preferred over glStartYear itself even when a comparative
  //      document also carries a glStartYear column, since that column is
  //      almost always ALSO a closing balance (as of 12/31/glStartYear), which
  //      would double-count glStartYear's own GL activity if used as its
  //      opening seed.
  //   2. glStartYear itself, but ONLY confirmed via its actual as_of_date
  //      being at/before the GL's first transaction (first_year_opening) —
  //      an actual "Opening Balance Sheet as of 1/1/<glStartYear>", not a
  //      same-year closing snapshot.
  const strictlyPriorYears = minYear != null ? bsCoverage.coverageYears.filter((y) => y < minYear) : [];
  let openingFiscalYear = null;
  let openingBsMode = null;
  if (strictlyPriorYears.length) {
    openingFiscalYear = Math.max(...strictlyPriorYears);
    openingBsMode = "prior_year_closing";
  } else if (minYear != null && bsCoverage.coverageYears.includes(minYear)) {
    const candidate = await findBsSnapshotForYear(companyId, versionId, minYear);
    if (candidate?.as_of_date && glStartDate && candidate.as_of_date <= glStartDate) {
      openingFiscalYear = minYear;
      openingBsMode = "first_year_opening";
    }
  }
  // hasOpeningBs MUST mean exactly "openingFiscalYear/openingBs (below) is a
  // real, usable beginning-of-period balance" — never broader than that.
  //
  // CONFIRMED BUG (previously fixed here): this used to also accept any
  // document whose earliestYear <= glStartYear, even when neither of the two
  // checks above actually resolved a year to seed from — e.g. a SINGLE
  // Balance Sheet dated 12/31/<glStartYear> (a genuine CLOSING balance for
  // the GL's first year, uploaded as the only "opening-ish" document). That
  // document's own year equals glStartYear, so the broad rule counted it as
  // opening coverage, while the stricter as_of_date check above correctly
  // left openingFiscalYear/openingBs null (it's not really an opening
  // snapshot). Downstream, generateMonthlyBalanceSheets trusted hasOpeningBs
  // to mean "safe to run the forward engine" and then guessed a fallback
  // year, producing "Closing<glStartYear> + GL<glStartYear> = wrong
  // Closing<glStartYear>" — the exact double-count this function exists to
  // prevent. Requiring hasOpeningBs === (openingFiscalYear != null) makes
  // that state impossible: with no genuine opening year, hasOpeningBs is
  // false, balanceSheetMode correctly falls to 'reverse' (below), and
  // generateMonthlyBalanceSheetsReverse reconstructs every year — including
  // glStartYear — backward from the Ending Balance Sheet instead.
  const hasOpeningBs = openingFiscalYear != null;

  // Ending Coverage: some document's years include glEndYear itself, or
  // reaches at/beyond it (a comparative document whose latest column is
  // glEndYear or later, or an explicit future-year snapshot).
  const endingCandidateYears = maxYear != null ? bsCoverage.coverageYears.filter((y) => y >= maxYear) : [];
  const endingFiscalYear = endingCandidateYears.length
    ? (endingCandidateYears.includes(maxYear) ? maxYear : Math.min(...endingCandidateYears))
    : null;
  const hasEndingBs = endingFiscalYear != null ||
    bsCoverage.documents.some((d) => maxYear != null && d.latestYear >= maxYear);

  const [openingBs, endingBs] = await Promise.all([
    openingFiscalYear != null ? findBsSnapshotForYear(companyId, versionId, openingFiscalYear) : Promise.resolve(null),
    endingFiscalYear != null ? findBsSnapshotForYear(companyId, versionId, endingFiscalYear) : Promise.resolve(null),
  ]);

  // Human-readable coverage summary — replaces the old "OpeningBS=yes/no,
  // EndingBS=yes/no" line with the actual per-document years the decision was
  // based on (see keyReportSyncService's log call site).
  const coverageSummary = {
    glRange: minYear != null && maxYear != null ? `${minYear}-${maxYear}` : null,
    documents: bsCoverage.documents.map((d, i) => ({
      label: `Document ${i + 1}`,
      years: d.isComparative ? `${d.earliestYear}-${d.latestYear}` : String(d.earliestYear),
      isComparative: d.isComparative,
    })),
    hasOpeningBs,
    hasEndingBs,
    coverageYears: bsCoverage.coverageYears,
  };

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
      bsCoverage: coverageSummary,
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
      openingBs,
      openingBsMode,
      endingBs,
      hasOpeningBs,
      hasEndingBs,
      hasProfitLoss: false,
      balanceSheetMode,
      bsCoverage: coverageSummary,
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
    openingBs,
    openingBsMode,
    endingBs,
    hasOpeningBs,
    hasEndingBs,
    hasProfitLoss,
    balanceSheetMode,
    bsCoverage: coverageSummary,
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

// A running/snapshot map key is a real chart_of_accounts.id exactly when it
// looks like a uuid — every other key is a synthetic control-account label
// ("Retained Earnings" fallback, "unlinked:<name>") that has no COA leaf.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Natural-sign accumulation, keyed by coa_id (falls back to a synthetic string
// key only for control accounts with no matching COA leaf — see
// findControlAccountCoaId). GL aggregation (aggregateGLForBS/ByMonth) already
// resolved coa_id and account_type from chart_of_accounts before this point;
// this map never re-derives either from a name.
function addRun(map, key, delta, type, name) {
  const k = key == null ? "" : String(key);
  if (!k) return;
  if (!map.has(k)) map.set(k, { name: name || k, balance: 0, type: type || "unknown" });
  const e = map.get(k);
  e.balance += Number(delta) || 0;
  if (type && (e.type === "unknown" || !e.type)) e.type = type;
}

// Find a COA leaf for a structural control account (Retained Earnings, Net
// Income) by name+type. This is NOT per-transaction account classification —
// it identifies one well-known closing/rollup account, once per version, so
// its GL-sourced movements (if any) and its synthetic closing-entry movements
// land under the SAME coa_id instead of splitting into two rows.
function findControlAccountCoaId(coaById, namePattern, accountType) {
  for (const [id, row] of coaById) {
    if (row.accountType === accountType && namePattern.test(String(row.accountName || ""))) return id;
  }
  return null;
}

// Build the per-account balance_sheet_entries rows for one month-end snapshot
// from the running natural-sign balances + the current-year cumulative Net Income.
function snapshotRows({ versionId, companyId, year, asOfDate, running, cumulativeNetIncome, sortStart, netIncomeCoaId }) {
  const rows = [];
  let sort = sortStart;
  const push = (key, name, amount, type) => {
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
      coa_id: key && UUID_RE.test(String(key)) ? key : null,
      sort_order: sort++,
      is_total: false,
      is_generated: true,
    });
  };
  for (const [key, v] of running) push(key, v.name, v.balance, v.type);
  // Current-year cumulative Net Income is a separate equity line (not merged into RE
  // until year-end close) — matches the bsBalancesForYear presentation. Usually has
  // no coa_id of its own (it's a calculated rollup, not a posted ledger account)
  // unless the COA happens to carry an explicit "Net Income" leaf.
  if (Math.abs(round2(cumulativeNetIncome)) >= 0.005) push(netIncomeCoaId || null, "Net Income", cumulativeNetIncome, "equity");
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

  const coaById = await loadCoaByIdMap(versionId);
  const reCoaId = findControlAccountCoaId(coaById, /retained\s*earnings/i, "equity") || "Retained Earnings";
  const niCoaId = findControlAccountCoaId(coaById, /net\s*(income|loss)/i, "equity");
  // Opening balances come from bsBalancesForYear, which is still name-keyed
  // (extracted balance_sheet_entries rows aren't coa_id-linked at read time
  // yet — a Report Rendering concern, not this engine's). This lookup is the
  // one legitimate bridge from that name-keyed world into this coa_id-keyed
  // engine, built once per run from the COA itself (not per-account guessing).
  const nameToCoaId = new Map();
  for (const [id, row] of coaById) {
    const k = String(row.accountName || "").trim().toLowerCase();
    if (k && !nameToCoaId.has(k)) nameToCoaId.set(k, id);
  }

  // Opening position: seed EXCLUSIVELY from gate.openingBs — the year the
  // validation gate itself already confirmed is a genuine beginning-of-period
  // balance (either a real prior-year closing, or a confirmed
  // before-the-GL's-first-transaction opening snapshot; see
  // classifyWorkflowDocuments's openingFiscalYear derivation). Never guess a
  // fallback year here.
  //
  // CONFIRMED BUG (fixed by removing the fallback below, not by adding
  // another branch): this used to silently default to `startYear - 1` via
  // `gate?.openingBs?.fiscal_year ?? (startYear - 1)` whenever gate.openingBs
  // was null. That default is wrong whenever a Balance Sheet dated
  // 12/31/<startYear> exists but ISN'T a genuine opening (a normal case:
  // clients upload a closing balance for the GL's first year, not a
  // 1/1/<startYear> opening snapshot) — classifyWorkflowDocuments correctly
  // leaves gate.openingBs null in that case, but this function still went
  // looking for `startYear - 1` data. If a generated/extracted snapshot for
  // that guessed year happened to exist, its balances got used as the
  // opening seed for `startYear` while THIS SAME YEAR's own GL activity was
  // then replayed on top — "Closing<startYear> + GL<startYear> = wrong
  // Closing<startYear>", exactly the reported symptom. Trusting only
  // gate.openingBs (which classifyWorkflowDocuments/hasOpeningBs guarantee is
  // consistent — see its own doc comment) makes that impossible: with no
  // genuine opening year, this function is only ever reached in 'forward' or
  // 'dual' mode when hasOpeningBs is true, so gate.openingBs is always
  // populated; standalone calls (e.g. a manual regenerate) that lack a real
  // gate.openingBs correctly start from zero instead of guessing.
  const openingYear = gate?.openingBs?.fiscal_year ?? null;
  const running = new Map();
  if (openingYear == null) {
    console.warn(`[generateMonthlyBalanceSheets] versionId=${versionId}: no opening balance snapshot from the validation gate — starting FY${startYear} from zero.`);
  } else {
    try {
      const opening = await bsBalancesForYear(versionId, openingYear);
      if (opening?.balances?.size) {
        for (const v of opening.balances.values()) {
          if (/^net\s+income$/i.test(String(v.name).trim())) {
            addRun(running, reCoaId, v.balance, "equity", "Retained Earnings");
          } else {
            const key = nameToCoaId.get(String(v.name).trim().toLowerCase()) || `unlinked:${v.name}`;
            addRun(running, key, v.balance, v.type, v.name);
          }
        }
      }
    } catch (_e) { /* no opening → start from zero (gate already warned) */ }
  }

  // NOTE: the reverse engine (generateMonthlyBalanceSheetsReverse) needs an
  // analogous fix for an account missing from the uploaded Ending BS, because
  // walking BACKWARD subtracts that account's GL delta against a seed that
  // never included it, producing a negative balance. This forward engine does
  // not share that symptom: an account with no opening-seed row simply starts
  // at zero and accumulates its real GL activity normally via the per-month
  // loop below (addRun auto-initializes a missing key) — there is nothing to
  // fix here.

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
          for (const [key, acc] of mData.bsMap) addRun(running, key, acc.net, acc.type, acc.name);
          cumulativeNetIncome += mData.netIncome;
        }
        const { rows, nextSort } = snapshotRows({
          versionId, companyId, year, asOfDate: asOf, running, cumulativeNetIncome, sortStart: sort, netIncomeCoaId: niCoaId,
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
          for (const [key, acc] of agg.bsMap) addRun(running, key, acc.net, acc.type, acc.name);
          cumulativeNetIncome += agg.netIncome || 0;
        }
      } catch (_e) { /* leave running unchanged */ }
      const asOf = monthEndDate(year, 12);
      if (asOf <= monthEndCutoff) {
        const { rows, nextSort } = snapshotRows({
          versionId, companyId, year, asOfDate: asOf, running, cumulativeNetIncome, sortStart: sort, netIncomeCoaId: niCoaId,
        });
        allRows.push(...rows);
        sort = nextSort;
        const failure = assertMonthBalances(rows, year, asOf);
        if (failure) failedMonths.push(failure);
      }
    }

    yearsStored.push(year);
    // Year-end close: roll the year's Net Income into Retained Earnings so the next
    // year opens with a clean Net Income line (double-entry close). See the reverse
    // engine's header comment above generateMonthlyBalanceSheetsReverse for a
    // confirmed production case where Retained Earnings ALSO carries real,
    // client-posted GL rows of its own (a separate closing event, e.g. rolling
    // Distributions into Retained Earnings) — that does not double this step;
    // the two are additive, not duplicates.
    if (Math.abs(round2(cumulativeNetIncome)) >= 0.005) addRun(running, reCoaId, cumulativeNetIncome, "equity", "Retained Earnings");
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
// Retained Earnings needs an explicit "unclose" step going backward (the
// exact inverse of the forward engine's year-end close): it is closed via
// this synthetic step ONLY, never via GL deltas that represent Net Income
// itself — Net Income has no GL leaf of its own in verified production data.
//
// CONFIRMED (production data, Davis Signs Utah LLC, 2026-07-21): the resolved
// Retained Earnings COA leaf can ALSO carry real, client-posted GL rows of
// its own (e.g. a QuickBooks-generated entry explicitly memoed "To roll
// distributions to retained earnings", dated the 1st of each fiscal year).
// These are a SEPARATE closing event (rolling Distributions into Retained
// Earnings) from this engine's Net-Income close/unclose — attempting to skip
// this synthetic step whenever such real postings exist (tried and reverted)
// is WRONG: it breaks years that were previously correct (verified against
// the uploaded FY2023 and FY2026 Balance Sheets) without fixing the
// remaining imbalance. The two closing events are additive, not duplicates
// of each other; the real FY2025 discrepancy has a different root cause,
// still under investigation — see the "$12,800 FY2025" notes in this file's
// git history / project memory before attempting another fix here.
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

  const coaById = await loadCoaByIdMap(versionId);
  const reCoaId = findControlAccountCoaId(coaById, /retained\s*earnings/i, "equity") || "Retained Earnings";
  const niCoaId = findControlAccountCoaId(coaById, /net\s*(income|loss)/i, "equity");
  // Bridge from bsBalancesAtLatest's still-name-keyed result into this
  // coa_id-keyed engine — see the forward engine's identical comment.
  const nameToCoaId = new Map();
  for (const [id, row] of coaById) {
    const k = String(row.accountName || "").trim().toLowerCase();
    if (k && !nameToCoaId.has(k)) nameToCoaId.set(k, id);
  }

  // Seed = the uploaded (non-generated) Ending BS for endYear — reuses the
  // existing Phase 5 helper below, which already picks the single latest
  // as_of_date snapshot for a year.
  const { balances: endingMap } = await bsBalancesAtLatest(companyId, versionId, endYear, false);
  if (!endingMap.size) return { stored: 0, months: 0, years: [], failedMonths: [] };

  const running = new Map();
  let cumulativeNetIncome = 0;
  for (const [, v] of endingMap) {
    if (/^net\s*(income|loss)/i.test(String(v.name).trim())) { cumulativeNetIncome += v.amount; continue; }
    const key = nameToCoaId.get(String(v.name).trim().toLowerCase()) || `unlinked:${v.name}`;
    addRun(running, key, v.amount, v.type, v.name);
  }

  // A real, GL-linked account can have genuine transaction activity but no
  // leaf row of its own anywhere in the uploaded Ending BS document (its only
  // trace there is a section header, e.g. "Fixed Assets" — never a postable
  // line; see sectionHeaderNameToType in chartOfAccountsService.js for the
  // classification-side counterpart of this same gap). CONFIRMED bug this
  // fixes: such an account is silently absent from every snapshot after its
  // first GL activity (never seeded) and goes NEGATIVE in every snapshot
  // before it, once the month-walk below undoes its GL delta against a seed
  // that never included it in the first place.
  //
  // MUST be scoped to accounts that were NEVER a real leaf row in ANY
  // uploaded Balance Sheet (any year, not just endYear) — CONFIRMED case
  // this guard prevents: a "(deleted)" QuickBooks account (e.g. "Capital
  // Contributions (deleted)") is a real leaf in an EARLIER uploaded BS (2023)
  // but correctly absent from the current Ending BS because QuickBooks
  // merged/closed it into a surviving account by the time of the later
  // snapshot — its lifetime GL total is NOT a gap to fill, it's already
  // reflected in whatever absorbed it. Seeding it independently here would
  // double-count that balance (confirmed live: introduced a NEW, uniform
  // +$47,709.57 imbalance across every month before this guard was added).
  // "Fixed Assets" is different in kind: it has NO leaf row in ANY uploaded
  // BS, at any point in time — only ever a section header.
  const { data: everBsLeafRows } = await supabase
    .from("balance_sheet_entries")
    .select("account_name")
    .eq("version_id", versionId)
    .eq("is_generated", false)
    .not("account_name", "is", null);
  const everBsLeafNames = new Set((everBsLeafRows || []).map((r) => String(r.account_name).trim().toLowerCase()));

  const seededCoaIds = new Set(running.keys());
  const lifetimeBalances = new Map(); // coaId -> { net, type, name }
  for (let y = startYear; y <= endYear; y += 1) {
    const agg = await aggregateGLForBS(versionId, y);
    if (!agg?.bsMap) continue;
    for (const [key, acc] of agg.bsMap) {
      if (!lifetimeBalances.has(key)) lifetimeBalances.set(key, { net: 0, type: acc.type, name: acc.name });
      lifetimeBalances.get(key).net += acc.net;
    }
  }
  // "(deleted)" is QuickBooks' own naming convention for an account the
  // client has since merged/deactivated — a generic, cross-company signal
  // (not a hardcoded account name), same kind of structural marker as the
  // canonical section-header vocabulary reused elsewhere in this codebase.
  // CONFIRMED case this excludes: "Member 2 Draws (deleted)" has real GL
  // activity but was NEVER a leaf in any uploaded BS at all (deleted before
  // the earliest upload), so the everBsLeafNames guard above doesn't catch
  // it — without this, its lifetime balance gets seeded as if still live,
  // double-counting whatever surviving account absorbed it (confirmed live:
  // a uniform +$45.86 imbalance across every month before this guard).
  const DELETED_ACCOUNT_RE = /\(deleted\)\s*$/i;
  for (const [key, acc] of lifetimeBalances) {
    if (seededCoaIds.has(key)) continue;
    if (!["asset", "liability", "equity"].includes(acc.type)) continue;
    if (Math.abs(round2(acc.net)) < 0.005) continue;
    if (everBsLeafNames.has(String(acc.name).trim().toLowerCase())) continue;
    if (DELETED_ACCOUNT_RE.test(String(acc.name).trim())) continue;
    addRun(running, key, acc.net, acc.type, acc.name);
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
      addRun(running, reCoaId, -yearFullNetIncome, "equity", "Retained Earnings");
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
          versionId, companyId, year, asOfDate: asOf, running, cumulativeNetIncome, sortStart: sort, netIncomeCoaId: niCoaId,
        });
        allRows.push(...rows);
        sort = nextSort;
        const failure = assertMonthBalances(rows, year, asOf);
        if (failure) failedMonths.push(failure);

        // Undo month m's GL activity (if any) to step back to END of the PRIOR month.
        const mData = byMonth.get(m);
        if (mData) {
          for (const [key, acc] of mData.bsMap) addRun(running, key, -acc.net, acc.type, acc.name);
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
          versionId, companyId, year, asOfDate: asOf, running, cumulativeNetIncome, sortStart: sort, netIncomeCoaId: niCoaId,
        });
        allRows.push(...rows);
        sort = nextSort;
        const failure = assertMonthBalances(rows, year, asOf);
        if (failure) failedMonths.push(failure);
      }
      if (agg?.bsMap) for (const [key, acc] of agg.bsMap) addRun(running, key, -acc.net, acc.type, acc.name);
    }
    // CONFIRMED BUG this fixes: for every year EXCEPT endYear, cumulativeNetIncome
    // is set to that year's OWN full-year netIncome (computed as the sum of the
    // exact same byMonth data this loop then walks down month by month) — so it
    // is mathematically guaranteed to reach exactly 0 by the time all 12 months
    // are undone. endYear is different: its cumulativeNetIncome is SEEDED from
    // the uploaded Ending BS's own stated "Net Income" line (ground truth from
    // the document, per bsBalancesAtLatest) — an EXTERNAL figure, not derived
    // from this year's own byMonth sum. When the GL's own month-by-month
    // aggregation for that partial year doesn't exactly agree with the
    // document's stated Net Income (confirmed live: a $168,198.55 gap for one
    // real company), the walk leaves a real, non-zero leftover in
    // cumulativeNetIncome here — which an unconditional reset to 0 then
    // silently discarded, permanently breaking Assets = Liabilities + Equity
    // for every single earlier month this engine ever generates (the loss
    // compounds forward through every prior year since nothing later restores
    // it). Retained Earnings is the conventional place a P&L-vs-balance-sheet
    // reconciling difference belongs — fold it in instead of dropping it, and
    // log it loudly so a real GL/document mismatch is never invisible.
    if (Math.abs(round2(cumulativeNetIncome)) >= 0.005) {
      console.warn(
        `[generateMonthlyBalanceSheetsReverse] versionId=${versionId}: ${year}'s GL-derived Net Income does not fully ` +
        `offset its seeded value — a $${Math.abs(cumulativeNetIncome).toFixed(2)} residual was folded into Retained ` +
        `Earnings rather than silently dropped. This usually means the uploaded Ending Balance Sheet's stated Net ` +
        `Income for ${year} disagrees with what the General Ledger's own account classification computes for the ` +
        `same period.`,
      );
      addRun(running, reCoaId, cumulativeNetIncome, "equity", "Retained Earnings");
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

// COA id → {accountName, accountNumber, accountType} — the primary lookup for
// coa_id-based aggregation (generateTrialBalance). Every GL row that carries a
// real coa_id (see linkGlToCoa) resolves its account identity and type
// directly from here instead of a name lookup, so accounts that share a
// canonical COA entry under differently-spelled GL names are correctly
// grouped as one account rather than split across several trial-balance rows.
async function loadCoaByIdMap(versionId) {
  const map = new Map();
  const { data } = await supabase
    .from("chart_of_accounts")
    .select("id, account_name, account_number, account_type, parent_account_id, cf_category, metadata")
    .eq("version_id", versionId);
  for (const r of data || []) {
    if (r.metadata?.is_group) continue;
    map.set(r.id, {
      accountName: r.account_name,
      accountNumber: r.account_number || null,
      accountType: r.account_type || null,
      parentAccountId: r.parent_account_id || null,
      cfCategory: r.cf_category || null,
    });
  }
  return map;
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
      .select("account_name, account_section, amount, running_balance, row_type, row_number, transaction_date, coa_id")
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

  // coa_id is the primary grouping key (reliable now that linkGlToCoa uses
  // keyset pagination — see its own doc comment); the name-based typeMap is
  // only a fallback for a GL row that somehow still has no coa_id (logged,
  // never silently merged into the wrong account).
  const [typeMap, coaById] = await Promise.all([coaTypeMap(versionId), loadCoaByIdMap(versionId)]);
  const rowsToInsert = [];
  const yearsStored = [];
  const imbalancedYears = [];
  let fallbackToNameCount = 0;

  for (let year = startYear; year <= endYear; year += 1) {
    const glRows = await fetchGlRowsForYear(companyId, versionId, year);
    if (!glRows.length) continue;

    // groupKey (coa_id, or "name::"+name as a fallback) → { debits, credits, net, opening }
    const acc = new Map();
    const get = (key, displayName, accountType, accountNumber) => {
      if (!acc.has(key)) acc.set(key, { debits: 0, credits: 0, net: 0, opening: 0, hasOpening: false, accountName: displayName, accountType, accountNumber });
      return acc.get(key);
    };

    for (const r of glRows) {
      const name = glAccountName(r);
      if (!name) continue;
      const coa = r.coa_id ? coaById.get(r.coa_id) : null;
      if (!coa) fallbackToNameCount++;
      const key = r.coa_id || `name::${name.toLowerCase()}`;
      const displayName = coa?.accountName || name;
      const accountType = coa?.accountType || typeMap.get(name.toLowerCase()) || null;
      const accountNumber = coa?.accountNumber || null;

      const rowType = r.row_type || "TRANSACTION";
      if (rowType === "BEGINNING_BALANCE") {
        const a = get(key, displayName, accountType, accountNumber);
        a.opening = Number(r.running_balance) || 0;
        a.hasOpening = true;
      } else if (rowType === "TRANSACTION" || !r.row_type) {
        const amt = Number(r.amount) || 0;
        if (Math.abs(amt) < 0.005) continue;
        const a = get(key, displayName, accountType, accountNumber);
        a.net += amt;
        if (amt > 0) a.debits += amt;
        else a.credits += -amt;
      }
      // ACCOUNT_HEADER / TOTAL_ROW are ignored.
    }

    const yearRows = [];
    for (const a of acc.values()) {
      if (Math.abs(a.debits) < 0.005 && Math.abs(a.credits) < 0.005 && !a.hasOpening) continue;
      yearRows.push({
        version_id: versionId,
        company_id: companyId,
        fiscal_year: year,
        account_name: a.accountName,
        account_number: a.accountNumber,
        account_type: a.accountType,
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

  if (fallbackToNameCount) {
    console.warn(`[generateTrialBalance] versionId=${versionId}: ${fallbackToNameCount} GL row(s) had no coa_id — grouped by name as a fallback (run linkGlToCoa again if this is unexpectedly high).`);
  }

  // Replace prior trial balance for this version.
  await supabase.from("trial_balance_entries").delete().eq("version_id", versionId);
  if (rowsToInsert.length) await chunkedInsert("trial_balance_entries", rowsToInsert);

  return { stored: rowsToInsert.length, years: yearsStored, imbalancedYears };
}

// ============================================================================
// BALANCE SHEET RECONCILIATION (mandatory reconciliation layer)
//
// Runs BEFORE Monthly Balance Sheet generation (Phase 4) — moved earlier in
// the redesigned pipeline so a reconciliation problem is visible before any
// monthly report is generated, not discovered afterward. When an Ending
// Balance Sheet has been uploaded, compares it (per account) against the
// CALCULATED ending balances — Opening Balance Sheet + cumulative General
// Ledger movements, computed live via bsBalancesForYear, independent of
// whether Phase 4 has run yet. Reports missing accounts, balance differences,
// and variance amounts (raw + percentage). NEVER overwrites generated
// balances or the original extracted data.
// ============================================================================

// Latest-as-of balances for a year filtered by is_generated.
// Returns { balances: Map<normName, {name, amount, type, section}>, excluded: Array<{name, amount}> }
// — `excluded` holds subtotal/header rows (e.g. "Total Assets") that are
// deliberately not compared account-by-account; the caller surfaces these
// with an EXCLUDED reconciliation status instead of silently dropping them.
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
  if (!asOf) return { balances: new Map(), excluded: [] };

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
  const excluded = [];
  for (const e of data || []) {
    const name = String(e.account_name || "").trim();
    if (!name) continue;
    const isNI = /^net\s*(income|loss)/i.test(name);
    if (e.is_total && !isNI) {
      excluded.push({ name, amount: Number(e.amount) || 0 });
      continue; // skip calculated totals (keep Net Income) — surfaced via `excluded`, not silently dropped
    }
    const key = name.toLowerCase();
    const type = e.account_type
      || (e.section === "assets" ? "asset" : e.section === "liabilities" ? "liability" : e.section === "equity" ? "equity" : null);
    if (!map.has(key)) map.set(key, { name, amount: 0, type, section: e.section || null });
    map.get(key).amount += Number(e.amount) || 0;
  }
  return { balances: map, excluded };
}

function percentageDifference(variance, uploadedAmount, calculatedAmount) {
  if (uploadedAmount !== 0) return Math.round((variance / uploadedAmount) * 10000) / 10000 * 100;
  if (calculatedAmount !== 0) return 100;
  return null;
}

/**
 * BALANCE SHEET RECONCILIATION — "Opening Balance Sheet + General Ledger
 * movements = Expected Closing Balance Sheet", compared account-by-account
 * against the uploaded Ending Balance Sheet. Runs BEFORE Monthly Balance
 * Sheet generation (Phase 4) in the redesigned pipeline — reuses
 * bsBalancesForYear (keyReportReportService.js), which already computes this
 * exact "opening + cumulative GL movements" chain purely from GL/extracted-BS
 * data with no dependency on a Phase-4-persisted snapshot (it only PREFERS
 * one when it already exists — at this point in the pipeline none does yet,
 * so it correctly falls back to live GL computation). Only runs when an
 * ending balance sheet is present (gate.hasEndingBs).
 *
 * @returns {Promise<{ran:boolean, stored:number, year:number|null, summary:object}>}
 */
async function generateReconciliation(companyId, versionId, gate) {
  // Lazy require to avoid any load-order coupling (same pattern as the BS engines above).
  const { bsBalancesForYear } = require("./keyReportReportService");

  // Always clear prior reconciliation for this version (idempotent).
  await supabase.from("bs_reconciliation_entries").delete().eq("version_id", versionId);

  const year = gate?.glEndYear;
  if (!gate?.hasEndingBs || !year) {
    return { ran: false, stored: 0, year: year || null, summary: { reason: "no_ending_balance_sheet" } };
  }

  const [calculated, { balances: uploaded, excluded: uploadedExcluded }] = await Promise.all([
    bsBalancesForYear(versionId, year),
    bsBalancesAtLatest(companyId, versionId, year, false),
  ]);

  if (!uploaded.size) {
    return { ran: false, stored: 0, year, summary: { reason: "uploaded_ending_bs_empty" } };
  }

  // bsBalancesForYear keys its balances Map by raw account name (natural
  // sign, opening + cumulative GL movements) — normalize to the same
  // lowercase-trimmed key convention used everywhere else in this file.
  const calcByKey = new Map();
  for (const [name, v] of calculated?.balances || []) {
    calcByKey.set(String(name).trim().toLowerCase(), { name: v.name, amount: v.balance, type: v.type });
  }

  const keys = new Set([...calcByKey.keys(), ...uploaded.keys()]);
  const rows = [];
  const summary = { matched: 0, differences: 0, missingFromGl: 0, missingFromBs: 0, excluded: 0, totalVariance: 0 };

  for (const key of keys) {
    const c = calcByKey.get(key);
    const u = uploaded.get(key);
    const calc = c ? round2(c.amount) : 0;
    const upl = u ? round2(u.amount) : 0;
    const variance = round2(calc - upl);
    const name = (c || u).name;
    const type = (c || u).type || null;
    const section = (u && u.section) || (type ? SECTION_BY_TYPE[type] : null);

    let status;
    if (!c) status = "MISSING_FROM_GL";
    else if (!u) status = "MISSING_FROM_BS";
    else status = Math.abs(variance) < BALANCE_TOLERANCE ? "MATCHED" : "DIFFERENCE";

    const needsReview = status !== "MATCHED";
    if (status === "MATCHED") summary.matched += 1;
    else if (status === "DIFFERENCE") summary.differences += 1;
    else if (status === "MISSING_FROM_GL") summary.missingFromGl += 1;
    else summary.missingFromBs += 1;
    summary.totalVariance = round2(summary.totalVariance + Math.abs(variance));

    rows.push({
      version_id: versionId,
      company_id: companyId,
      fiscal_year: year,
      account_name: name,
      account_type: type,
      section,
      generated_balance: calc,
      uploaded_balance: upl,
      variance,
      percentage_difference: percentageDifference(variance, upl, calc),
      status,
      needs_review: needsReview,
    });
  }

  // Subtotal/header rows from the uploaded document (e.g. "Total Assets") are
  // deliberately not compared account-by-account — surfaced as EXCLUDED
  // instead of silently vanishing (per "never silently disappear").
  for (const ex of uploadedExcluded) {
    rows.push({
      version_id: versionId,
      company_id: companyId,
      fiscal_year: year,
      account_name: ex.name,
      account_type: null,
      section: null,
      generated_balance: 0,
      uploaded_balance: round2(ex.amount),
      variance: 0,
      percentage_difference: null,
      status: "EXCLUDED",
      needs_review: false,
    });
    summary.excluded += 1;
  }

  if (rows.length) await chunkedInsert("bs_reconciliation_entries", rows);
  summary.balanced = summary.differences === 0 && summary.missingFromGl === 0 && summary.missingFromBs === 0;

  // Top differing accounts (by absolute variance), for the validation-row
  // message — same "accounts responsible" convention as the P&L reconciliation
  // block (persistProfitLossReconciliation's fileResults.topDiffs).
  const topDiffs = rows
    .filter((r) => r.status === "DIFFERENCE")
    .sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance))
    .slice(0, 15);
  const diffCount = rows.filter((r) => r.status === "DIFFERENCE").length;

  return { ran: true, stored: rows.length, year, summary, topDiffs, diffCount };
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

// Batch link UPDATEs (linkGlToCoa/linkBsToCoa below) run over potentially
// thousands of rows via a Supabase/PostgREST connection that already has its
// own timeout/circuit-breaker (see db.js). A single batch occasionally aborts
// transiently (AbortError, "fetch failed") with no fault of the data itself —
// confirmed live. Previously that batch's rows were just left unlinked
// (warned, not retried). Retry with backoff before giving up so a transient
// network hiccup doesn't silently leave real rows unlinked.
function isTransientLinkError(err) {
  const msg = String(err?.message || err || "");
  return msg.includes("AbortError") || msg.includes("aborted") || msg.includes("fetch failed") || msg.includes("ETIMEDOUT") || msg.includes("ECONNRESET");
}

async function updateBatchWithRetry(table, patch, ids, label, attempts = 3) {
  let lastErr = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const { error } = await supabase.from(table).update(patch).in("id", ids);
    if (!error) return true;
    lastErr = error;
    if (!isTransientLinkError(error) || attempt === attempts) break;
    console.warn(`${label}: attempt ${attempt}/${attempts} failed (${error.message}) — retrying...`);
    await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
  }
  console.warn(`${label}: ${lastErr.message}${attempts > 1 ? ` (gave up after ${attempts} attempt(s))` : ""}`);
  return false;
}

// Resolve a `split_account` string (the OTHER side of a journal entry, e.g.
// "80950 Operational Expense: Background Check") to a COA leaf id using the
// same normalized-name map as the primary account_name match, with two
// fallbacks for QuickBooks-style "Parent:Child" split labels:
//   1. exact match on the full string
//   2. exact match on the last colon-segment ("Background Check")
//   3. suffix match against every known COA leaf name — needed because the
//      child segment after the colon often omits the parent's leading
//      account-number prefix (e.g. "Background Check" vs the COA leaf
//      "80950 Background Check").
// Resolved ONCE here at link time and persisted to split_coa_id; report code
// never re-derives this from text.
function resolveSplitAccountCoaId(splitName, byName, norm) {
  if (!splitName) return null;
  const full = byName.get(norm(splitName));
  if (full) return full;
  const lastSegment = splitName.split(":").pop().trim();
  if (!lastSegment) return null;
  const lastSegmentNorm = norm(lastSegment);
  const exact = byName.get(lastSegmentNorm);
  if (exact) return exact;
  for (const [key, id] of byName) {
    if (key.endsWith(lastSegmentNorm)) return id;
  }
  return null;
}

async function linkGlToCoa(companyId, versionId) {
  // Fetch all COA leaf nodes for this version.
  const { data: coaRows, error: coaErr } = await supabase
    .from("chart_of_accounts")
    .select("id, account_name, base_account, adjusted_name, metadata")
    .eq("version_id", versionId);

  if (coaErr) {
    console.warn(`[linkGlToCoa] COA fetch error: ${coaErr.message}`);
    return { linked: 0, skipped: 0, splitLinked: 0, splitSkipped: 0 };
  }

  if (!coaRows?.length) {
    console.log("[linkGlToCoa] No COA rows found — skipping coa_id population");
    return { linked: 0, skipped: 0, splitLinked: 0, splitSkipped: 0 };
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
    return { linked: 0, skipped: 0, splitLinked: 0, splitSkipped: 0 };
  }

  // Page through GL TRANSACTION rows for this version, batch-update coa_id
  // AND split_coa_id in the same pass.
  //
  // Keyset pagination (id > lastSeenId), NOT .range()/OFFSET: the query filters
  // on rows still missing one of the two link columns, and every page's UPDATE
  // removes rows from that exact filtered result set. An OFFSET-based .range()
  // counts POSITION within a set that keeps shrinking underneath it — each
  // successful page of matches permanently shifts every later OFFSET past rows
  // that were never actually fetched, silently skipping most of the table
  // (confirmed live: one real version linked only ~4% of its GL before this
  // fix). Anchoring on the last row id actually seen has no such drift — a row
  // is only ever skipped because it was fetched and found unmatched, never
  // because of accounting arithmetic on a moving result set.
  const PAGE = 500;
  let lastId = 0;
  let linked = 0;
  let skipped = 0;
  let splitLinked = 0;
  let splitSkipped = 0;

  for (;;) {
    const { data: glRows, error: glErr } = await supabase
      .from(TABLE_GL)
      .select("id, account_name, split_account, coa_id, split_coa_id")
      .eq("company_id", companyId)
      .eq("version_id", versionId)
      .or("row_type.eq.TRANSACTION,row_type.is.null")
      .or("coa_id.is.null,split_coa_id.is.null")
      .gt("id", lastId)
      .order("id", { ascending: true })
      .limit(PAGE);

    if (glErr) {
      console.warn(`[linkGlToCoa] GL fetch error: ${glErr.message}`);
      break;
    }
    if (!glRows?.length) break;
    lastId = glRows[glRows.length - 1].id;

    // Group by target value to minimise UPDATE calls. A row may need both
    // columns updated (two independent FKs) — it can appear in both maps.
    const byCoa = new Map();      // coaId → [glId]      (account_name side)
    const bySplitCoa = new Map(); // splitCoaId → [glId]  (split_account side)

    for (const row of glRows) {
      if (row.coa_id == null && row.account_name) {
        const coaId = byName.get(norm(row.account_name));
        if (coaId) {
          if (!byCoa.has(coaId)) byCoa.set(coaId, []);
          byCoa.get(coaId).push(row.id);
        } else {
          skipped++;
        }
      }
      if (row.split_coa_id == null && row.split_account) {
        const splitCoaId = resolveSplitAccountCoaId(String(row.split_account).trim(), byName, norm);
        if (splitCoaId) {
          if (!bySplitCoa.has(splitCoaId)) bySplitCoa.set(splitCoaId, []);
          bySplitCoa.get(splitCoaId).push(row.id);
        } else {
          splitSkipped++;
        }
      }
    }

    for (const [coaId, ids] of byCoa) {
      const ok = await updateBatchWithRetry(TABLE_GL, { coa_id: coaId }, ids, `[linkGlToCoa] Update error for coa_id=${coaId}`);
      if (ok) linked += ids.length;
    }

    for (const [splitCoaId, ids] of bySplitCoa) {
      const ok = await updateBatchWithRetry(TABLE_GL, { split_coa_id: splitCoaId }, ids, `[linkGlToCoa] Update error for split_coa_id=${splitCoaId}`);
      if (ok) splitLinked += ids.length;
    }

    if (glRows.length < PAGE) break;
  }

  console.log(`[linkGlToCoa] versionId=${versionId}: linked=${linked} skipped=${skipped} splitLinked=${splitLinked} splitSkipped=${splitSkipped}`);
  return { linked, skipped, splitLinked, splitSkipped };
}

// Mirrors linkGlToCoa exactly, for balance_sheet_entries.coa_id — populates
// the link for UPLOADED/EXTRACTED rows (is_generated=false/null). Generated
// Monthly BS rows (Phase 4 engines below) get coa_id written directly at
// creation time since they're already keyed by coa_id internally — this
// function only needs to backfill rows that came from extraction.
async function linkBsToCoa(companyId, versionId) {
  const { data: coaRows, error: coaErr } = await supabase
    .from("chart_of_accounts")
    .select("id, account_name, base_account, adjusted_name, metadata")
    .eq("version_id", versionId);

  if (coaErr) {
    console.warn(`[linkBsToCoa] COA fetch error: ${coaErr.message}`);
    return { linked: 0, skipped: 0 };
  }
  if (!coaRows?.length) {
    console.log("[linkBsToCoa] No COA rows found — skipping coa_id population");
    return { linked: 0, skipped: 0 };
  }

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
    console.log("[linkBsToCoa] No COA leaf nodes found — skipping coa_id population");
    return { linked: 0, skipped: 0 };
  }

  const PAGE = 500;
  let lastId = 0;
  let linked = 0;
  let skipped = 0;

  for (;;) {
    const { data: bsRows, error: bsErr } = await supabase
      .from(TABLE_BS)
      .select("id, account_name")
      .eq("company_id", companyId)
      .eq("version_id", versionId)
      .not("account_name", "is", null)
      .is("coa_id", null)
      .gt("id", lastId)
      .order("id", { ascending: true })
      .limit(PAGE);

    if (bsErr) {
      console.warn(`[linkBsToCoa] BS fetch error: ${bsErr.message}`);
      break;
    }
    if (!bsRows?.length) break;
    lastId = bsRows[bsRows.length - 1].id;

    const byCoa = new Map();
    for (const row of bsRows) {
      const coaId = byName.get(norm(row.account_name));
      if (coaId) {
        if (!byCoa.has(coaId)) byCoa.set(coaId, []);
        byCoa.get(coaId).push(row.id);
      } else {
        skipped++;
      }
    }

    for (const [coaId, ids] of byCoa) {
      const ok = await updateBatchWithRetry(TABLE_BS, { coa_id: coaId }, ids, `[linkBsToCoa] Update error for coa_id=${coaId}`);
      if (ok) linked += ids.length;
    }

    if (bsRows.length < PAGE) break;
  }

  console.log(`[linkBsToCoa] versionId=${versionId}: linked=${linked} skipped=${skipped}`);
  return { linked, skipped };
}

module.exports = {
  classifyWorkflowDocuments,
  generateTrialBalance,
  generateMonthlyBalanceSheets,
  generateMonthlyBalanceSheetsReverse,
  generateReconciliation,
  linkGlToCoa,
  linkBsToCoa,
  loadCoaByIdMap,
  glDateRange,
  buildBsCoverage,
  monthEndDate,
  coaTypeMap,
};
