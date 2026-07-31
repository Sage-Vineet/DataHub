// ============================================================================
// Bank Reconciliation — Activity Review engine (Key Reports mode)
//
// Populates every *derivable* Activity Review adjustment row directly from the
// selected Key Report version's generated financial statements (the same
// payload GET /key-reports/versions/:id/reports/financial-statements returns) —
// no hardcoded account names, IDs, row positions, report structure, period
// type, or currency. Everything is discovered from the statements.
//
// It computes, per reporting period (keyed "YYYY-MM"):
//   Deposits side (reconciles Sales/Financials → cash Deposits)
//     • changeInAR                 (current-asset rule)
//     • changeInARRetentions       (current-asset rule)
//     • fixedAssetDisposals        (investing inflow)
//   Withdrawals side (reconciles Expenses/Financials → cash Withdrawals)
//     • changeInCurrentLiabilities (current-liability rule)
//     • changeInLTLiabilities      (liability rule)
//     • depreciationExpense        (P&L, non-cash add-back)
//     • amortizationExpense        (P&L, non-cash add-back)
//     • badDebtExpense             (P&L, non-cash add-back)
//     • fixedAssetPurchases        (investing outflow)
//
// SIGN CONVENTION — every value is the CASH EFFECT of that item (Step 6 of the
// product spec / GAAP-IFRS indirect method), so the frontend can simply SUM
// them into the Unreconciled Variance and have it trend to zero:
//   Current ASSET      increase → NEGATIVE (cash outflow), decrease → POSITIVE
//   Current LIABILITY  increase → POSITIVE (cash inflow),   decrease → NEGATIVE
//   Long-term LIAB.    increase → POSITIVE,                  decrease → NEGATIVE
//   Non-cash expenses  (depr/amort/bad debt) → POSITIVE add-backs
//   Fixed-asset purchase → NEGATIVE (outflow), disposal → POSITIVE (inflow)
//
// CLASSIFICATION — this engine consumes the classification the Chart of
// Accounts pipeline ALREADY produced (account_type, metadata.report_tag,
// current/non-current KPI split). Where the stored tags are coarser than a row
// needs (report_tag lumps "depreciation_amortization"; there is no tag for bad
// debt, AR retentions, or accumulated depreciation), it refines that split with
// ONE isolated, bounded keyword pass over a label that is ALREADY on the row —
// exactly the accepted pattern the statement builder uses for its KPI
// current/non-current split (resolveKpiCurrentNonCurrent). It never invents a
// classification, never rescans the whole COA, and never writes anything back,
// so it cannot affect any other report.
// ============================================================================

const { supabase } = require("../../db");
const { generateFinancialStatements } = require("./financialStatementService");

const safeNum = (v) => {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (v) => Math.round((safeNum(v) + Number.EPSILON) * 100) / 100;

// ─── Isolated compute-time classification refiners ──────────────────────────
// Each operates only on a name/tag ALREADY copied onto the leaf by the COA
// classifier. Bounded, documented, side-effect-free.

const RETENTION_RE   = /retention|retainage|holdback|retain(?:ed|age)?\s+receivab/i;
const ACCUM_DEP_RE   = /accumulated\s+(?:depreciation|amortization|depletion)|accum\.?\s*(?:dep|amort)/i;
const AMORT_RE       = /amorti[sz]/i;
const BAD_DEBT_RE    = /bad\s*debt|doubtful|uncollectib|allowance\s+for\s+(?:doubtful|credit)|write.?off.*receivab/i;

const leafName = (leaf) => String(leaf?.adjustedName || leaf?.name || "");

// A receivable held back on a contract (construction retainage etc.). Must be a
// receivable first (tag) so a payable "retention payable" never matches here.
function isArRetention(leaf) {
  return leaf?.reportTag === "accounts_receivable" && RETENTION_RE.test(leafName(leaf));
}
function isAccountsReceivable(leaf) {
  // Plain AR excludes the retention portion — that gets its own row.
  return leaf?.reportTag === "accounts_receivable" && !RETENTION_RE.test(leafName(leaf));
}
// Accumulated depreciation/amortization is a contra-asset: exclude it from the
// GROSS fixed-asset roll so purchases/disposals reflect cost movement only, not
// the monthly depreciation charge.
function isAccumulatedDepreciation(leaf) {
  return ACCUM_DEP_RE.test(leafName(leaf));
}
// Split the coarse "depreciation_amortization" P&L tag into its two rows.
// Returns "amortization" | "depreciation" | null.
function depAmortKind(leaf) {
  const tagged = leaf?.reportTag === "depreciation_amortization";
  const name = leafName(leaf);
  if (!tagged && !/depreciat|amorti[sz]|depletion/i.test(name)) return null;
  return AMORT_RE.test(name) ? "amortization" : "depreciation";
}
function isBadDebt(leaf) {
  return BAD_DEBT_RE.test(leafName(leaf));
}

// ─── Balance-sheet leaf extraction ──────────────────────────────────────────
// Flatten the {groups:{[name]:{accounts:[leaf]}}} KPI buckets the statement
// builder attaches to every monthly Balance Sheet entry.
function bucketLeaves(bucket) {
  const out = [];
  const groups = bucket?.groups || {};
  for (const g of Object.values(groups)) {
    for (const acc of g?.accounts || []) out.push(acc);
  }
  return out;
}

function bsSnapshot(entry) {
  const st = entry?.statement || {};
  const currentAssets = bucketLeaves(st.assets?.currentAssets);
  const fixedAssets   = bucketLeaves(st.assets?.fixedAssets);
  const currentLiab   = bucketLeaves(st.liabilities?.currentLiabilities);
  const longTermLiab  = bucketLeaves(st.liabilities?.longTermLiabilities);

  const sum = (arr) => safeNum(arr.reduce((s, a) => s + safeNum(a.amount), 0));

  return {
    ar:            sum(currentAssets.filter(isAccountsReceivable)),
    arRetention:   sum(currentAssets.filter(isArRetention)),
    // TOTAL current assets (every current-asset leaf, cash/bank + AR + inventory +
    // prepaids + other). Drives the informational "Change in Current Assets" row —
    // the literal period-over-period movement in Balance Sheet current assets.
    currentAssetsTotal: sum(currentAssets),
    currentLiab:   sum(currentLiab),
    longTermLiab:  sum(longTermLiab),
    // Gross fixed-asset cost only (contra accumulated depreciation removed).
    grossFixed:    sum(fixedAssets.filter((l) => !isAccumulatedDepreciation(l))),
  };
}

// ─── P&L monthly non-cash expense extraction ────────────────────────────────
function plSnapshot(entry) {
  const groups = entry?.statement?.operatingExpenses?.groups || {};
  let depreciation = 0;
  let amortization = 0;
  let badDebt = 0;
  for (const g of Object.values(groups)) {
    for (const acc of g?.accounts || []) {
      const kind = depAmortKind(acc);
      if (kind === "amortization") amortization += safeNum(acc.amount);
      else if (kind === "depreciation") depreciation += safeNum(acc.amount);
      // Bad debt is an independent classification — an account is not both.
      else if (isBadDebt(acc)) badDebt += safeNum(acc.amount);
    }
  }
  return { depreciation: safeNum(depreciation), amortization: safeNum(amortization), badDebt: safeNum(badDebt) };
}

const monthKeyOf = (entry) => {
  const year = Number(entry?.year);
  const monthNum = Number(entry?.monthNumber);
  if (!Number.isInteger(year) || !(monthNum >= 1 && monthNum <= 12)) return null;
  return `${year}-${String(monthNum).padStart(2, "0")}`;
};

const sortByPeriod = (entries) =>
  [...entries].sort((a, b) => (Number(a.year) - Number(b.year)) || (Number(a.monthNumber) - Number(b.monthNumber)));

/**
 * Compute the per-month Activity Review adjustments from a financial-statements
 * payload. Pure, deterministic, no I/O. Returns an object keyed by "YYYY-MM";
 * each value carries every derivable adjustment as its signed cash effect.
 *
 * Balance-sheet items are period-over-period (current − immediately-preceding
 * month across the FULL monthly series, so the first month of any reconciliation
 * window still has a real opening balance). P&L items are that month's figure.
 * Months with no prior period contribute 0 for the balance-sheet deltas.
 */
function computeMonthlyActivityReview(fs) {
  const bsMonthly = sortByPeriod(fs?.reports?.balanceSheet?.monthly || []);
  const plMonthly = fs?.reports?.profitAndLoss?.monthly || [];

  const plByKey = {};
  for (const e of plMonthly) {
    const key = monthKeyOf(e);
    if (key) plByKey[key] = plSnapshot(e);
  }

  const result = {};
  let prev = null;
  for (const entry of bsMonthly) {
    const key = monthKeyOf(entry);
    if (!key) continue;
    const cur = bsSnapshot(entry);

    // Period-over-period deltas (0 when there is no prior period).
    const dAR       = prev ? safeNum(cur.ar - prev.ar) : 0;
    const dARRet    = prev ? safeNum(cur.arRetention - prev.arRetention) : 0;
    // Raw movement in total current assets (current − previous). Informational —
    // NOT a cash-effect (it includes cash, which IS the deposits/withdrawals), so
    // it is displayed but never summed into the Unreconciled Variance.
    const dCurrentAssets = prev ? safeNum(cur.currentAssetsTotal - prev.currentAssetsTotal) : 0;
    const dCurLiab  = prev ? safeNum(cur.currentLiab - prev.currentLiab) : 0;
    const dLTLiab   = prev ? safeNum(cur.longTermLiab - prev.longTermLiab) : 0;
    const dGross    = prev ? safeNum(cur.grossFixed - prev.grossFixed) : 0;

    const pl = plByKey[key] || { depreciation: 0, amortization: 0, badDebt: 0 };

    result[key] = {
      // Deposits side — cash effects.
      changeInAR:                 round2(-dAR),                       // asset ↑ → negative
      changeInARRetentions:       round2(-dARRet),                    // asset ↑ → negative
      changeInCurrentAssets:      round2(dCurrentAssets),             // raw BS delta (informational)
      fixedAssetDisposals:        round2(dGross < 0 ? -dGross : 0),   // cost ↓ → inflow (+)
      // Withdrawals side — cash effects.
      changeInCurrentLiabilities: round2(dCurLiab),                   // liab ↑ → positive
      changeInLTLiabilities:      round2(dLTLiab),                    // liab ↑ → positive
      depreciationExpense:        round2(pl.depreciation),            // non-cash add-back (+)
      amortizationExpense:        round2(pl.amortization),            // non-cash add-back (+)
      badDebtExpense:             round2(pl.badDebt),                 // non-cash add-back (+)
      fixedAssetPurchases:        round2(dGross > 0 ? -dGross : 0),   // cost ↑ → outflow (−)
    };
    prev = cur;
  }

  return result;
}

// ─── Cached wrapper (mirrors getMonthlyPlFinancials) ────────────────────────
const ACTIVITY_REVIEW_CACHE_TYPE = "kr_activity_review_v1";

/**
 * Cached per-version Activity Review adjustments. Keyed on version +
 * last_synced_at + Chart-of-Accounts updated_at (COA reclassification does NOT
 * bump last_synced_at), identical to getMonthlyPlFinancials so a regenerate /
 * manual COA edit / reset invalidates this too. Never throws — returns {} on any
 * failure so the Bank Reconciliation page degrades to blank rows, never crashes.
 */
async function getMonthlyActivityReview(versionId) {
  if (!versionId) return {};

  let companyId = null;
  let syncedAt = null;
  let coaUpdatedAt = null;
  try {
    const [{ data: ver }, { data: coaRow }] = await Promise.all([
      supabase.from("key_report_versions").select("company_id, last_synced_at").eq("id", versionId).maybeSingle(),
      supabase.from("chart_of_accounts").select("updated_at").eq("version_id", versionId)
        .order("updated_at", { ascending: false }).limit(1).maybeSingle(),
    ]);
    companyId = ver?.company_id || null;
    syncedAt = ver?.last_synced_at || null;
    coaUpdatedAt = coaRow?.updated_at || null;
  } catch {
    // Metadata read failed — fall through and compute without caching.
  }

  if (companyId) {
    try {
      const { data: rows } = await supabase
        .from("qb_synced_reports")
        .select("data")
        .eq("company_id", companyId)
        .eq("report_type", ACTIVITY_REVIEW_CACHE_TYPE)
        .order("updated_at", { ascending: false });
      const hit = (rows || []).find(
        (r) => r?.data?.versionId === versionId && r?.data?.syncedAt === syncedAt &&
          r?.data?.coaUpdatedAt === coaUpdatedAt && r?.data?.activityReview,
      );
      if (hit) return hit.data.activityReview;
    } catch {
      // Cache read failed → fall through to compute.
    }
  }

  let result = {};
  try {
    const fs = await generateFinancialStatements(versionId, {});
    result = computeMonthlyActivityReview(fs);
  } catch (e) {
    console.warn(`[ActivityReview] compute failed for version ${versionId} (non-fatal): ${e.message}`);
    return {};
  }

  if (companyId) {
    try {
      const { data: existingRows } = await supabase
        .from("qb_synced_reports")
        .select("id, data")
        .eq("company_id", companyId)
        .eq("report_type", ACTIVITY_REVIEW_CACHE_TYPE);
      const existing = (existingRows || []).find((r) => r?.data?.versionId === versionId);
      const payload = { versionId, syncedAt, coaUpdatedAt, activityReview: result };
      const now = new Date().toISOString();
      if (existing?.id) {
        await supabase.from("qb_synced_reports")
          .update({ data: payload, status: "synced", updated_at: now }).eq("id", existing.id);
      } else {
        await supabase.from("qb_synced_reports").insert({
          company_id: companyId,
          report_type: ACTIVITY_REVIEW_CACHE_TYPE,
          source: "manual_report_upload",
          data: payload,
          status: "synced",
          updated_at: now,
        });
      }
    } catch {
      // Cache write is best-effort — never block the response.
    }
  }

  return result;
}

module.exports = {
  computeMonthlyActivityReview,
  getMonthlyActivityReview,
  ACTIVITY_REVIEW_CACHE_TYPE,
};
