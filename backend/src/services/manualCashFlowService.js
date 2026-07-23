"use strict";

const { supabase } = require("../db");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { getAllManualUploadedReports } = require("./manualReportUploadService");
const { getGeminiModels } = require("../config/geminiModels");

const CF_GENERATED_SOURCE = "manual_upload_generated";
const CF_REPORT_TYPE = "cash_flow";

// ── Numeric helpers ───────────────────────────────────────────────────────────

function r2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// ── Report tree traversal ─────────────────────────────────────────────────────

function flatten(nodes = []) {
  const out = [];
  function walk(node) {
    if (!node) return;
    out.push(node);
    if (Array.isArray(node.children)) node.children.forEach(walk);
  }
  (Array.isArray(nodes) ? nodes : []).forEach(walk);
  return out;
}

/**
 * Find the first matching node (priority-ordered patterns).
 * Prefers non-header nodes to avoid returning section totals that include
 * child totals already counted elsewhere.
 */
function _findAmt(nodes, patterns) {
  const flat = flatten(nodes);
  const preferred = flat.filter((n) => n.type !== "header");
  const pools = preferred.length ? [preferred, flat] : [flat];

  for (const pat of patterns) {
    const re = pat instanceof RegExp ? pat : new RegExp(pat, "i");
    for (const pool of pools) {
      const node = pool.find((n) => re.test(String(n.name || "")));
      if (node != null && typeof node.amount === "number") return node.amount;
    }
  }
  return 0;
}

// ── Leaf-node helpers (no double-counting) ────────────────────────────────────

/**
 * Returns only leaf nodes — nodes that have no children.
 * Parent/header rows that merely aggregate children are skipped.
 * This is the correct pool to sum: each dollar counted exactly once.
 */
function flattenLeaves(nodes = []) {
  const out = [];
  function walk(node) {
    if (!node) return;
    const kids = Array.isArray(node.children) ? node.children.filter(Boolean) : [];
    if (kids.length > 0) {
      kids.forEach(walk);
    } else if (node.type !== "header" && typeof node.amount === "number") {
      out.push(node);
    }
  }
  (Array.isArray(nodes) ? nodes : []).forEach(walk);
  return out;
}

/** Sum all leaf amounts that match any pattern. Each leaf counted at most once. */
function sumLeaves(leaves, patterns) {
  let total = 0;
  for (const leaf of leaves) {
    const name = String(leaf.name || "");
    for (const pat of patterns) {
      const re = pat instanceof RegExp ? pat : new RegExp(pat, "i");
      if (re.test(name)) { total += Number(leaf.amount) || 0; break; }
    }
  }
  return r2(total);
}

/** Returns each matching leaf individually (used for per-named-loan financing). */
function findNamedLeaves(leaves, patterns) {
  const results = [];
  const seen = new Set();
  for (const leaf of leaves) {
    const name = String(leaf.name || "");
    for (const pat of patterns) {
      const re = pat instanceof RegExp ? pat : new RegExp(pat, "i");
      if (re.test(name) && !seen.has(name)) {
        seen.add(name);
        results.push({ name: leaf.name, amount: Number(leaf.amount) || 0 });
        break;
      }
    }
  }
  return results;
}

// ── Line-item matchers ────────────────────────────────────────────────────────

const CASH_PATTERNS = [
  /^total cash( and cash equivalents)?$/i,
  /^cash and cash equivalents$/i,
  /^cash & cash equivalents$/i,
  /cash and cash equivalents/i,
  /\btotal cash\b/i,
  /^total bank accounts?$/i,
  /^bank accounts?$/i,
  /^cash$/i,
  /\bbank accounts?\b/i,
  /\bcash\b/i,
];

const AR_PATTERNS = [
  /^(total )?accounts receivable( \(a\/r\))?$/i,
  /^trade (accounts )?receivable$/i,
  /accounts receivable/i,
  /\breceivables?\b/i,
];

const INV_PATTERNS = [
  /^(total )?inventories?$/i,
  /^merchandise inventory$/i,
  /inventory/i,
];

const AP_PATTERNS = [
  /^(total )?accounts payable( \(a\/p\))?$/i,
  /^trade payables$/i,
  /accounts payable/i,
];

const ACCR_PATTERNS = [
  /^(total )?accrued (liabilities|expenses|payroll)$/i,
  /accrued (liabilities|expenses)/i,
  /\baccrued\b.*\b(payroll|salaries|wages)\b/i,
];

// Other Current Assets (prepaid, other short-term)
const OTHER_CA_PATTERNS = [
  /^(total )?other current assets?$/i,
  /^prepaid (expenses?|insurance|rent)$/i,
  /other current assets?/i,
  /prepaid expenses?/i,
];

// Other Current Liabilities (deferred revenue, customer deposits, etc.)
const OTHER_CL_PATTERNS = [
  /^(total )?other current liabilities$/i,
  /^deferred revenue$/i,
  /^customer (deposits?|advances?)$/i,
  /other current liabilities/i,
  /deferred revenue/i,
];

const FIXED_PATTERNS = [
  /^(total |net )?property,? plant( and|&) equipment,? net$/i,
  /^(net |total )?property and equipment$/i,
  /^(net |total )?fixed assets?$/i,
  /property.*equipment.*net/i,
  /\btotal fixed assets?\b/i,
  /property.*(plant|equipment)/i,
  /\bfixed assets?\b/i,
];

const DEPOSITS_PATTERNS = [
  /^(security |tenant )?deposits?$/i,
  /security deposits?/i,
  /\bdeposits?\b/i,
];

// Long-term Investments (not fixed assets, not deposits)
const INVESTMENTS_PATTERNS = [
  /^(total )?long.?term investments?$/i,
  /^(total )?investments?$/i,
  /^marketable securities$/i,
  /long.?term investments?/i,
  /\binvestments?\b/i,
];

const LINE_OF_CREDIT_PATTERNS = [
  /^(total )?line of credit$/i,
  /line of credit/i,
  /\brevolver\b/i,
];

const LONG_DEBT_PATTERNS = [
  /^(total )?long.?term (debt|notes? payable|loans? payable)$/i,
  /^(total )?long.?term liabilities$/i,
  /long.?term (debt|notes? payable|loans? payable)/i,
  /long.?term liabilities/i,
];

const NOTES_PAYABLE_PATTERNS = [
  /^(total )?notes? payable$/i,
  /^(total )?loans? payable$/i,
  /notes? payable/i,
  /loans? payable/i,
];

const EQUITY_PAID_IN_PATTERNS = [
  /^(additional )?paid.?in capital$/i,
  /^(total )?owner.?s? (equity|capital|investment)$/i,
  /^common stock$/i,
  /paid.?in capital/i,
  /owner.?s? (equity|capital|investment)/i,
  /common stock/i,
];

const DIVIDENDS_PATTERNS = [
  /^owner.?s? draws?$/i,
  /^(owner.?s? )?distributions?$/i,
  /^dividends? paid$/i,
  /owner.?s? (draws?|distributions?)/i,
  /dividends? paid/i,
  /\bdistributions?\b/i,
  /\bdraws?\b/i,
];

const NET_INCOME_PATTERNS = [
  /^net (income|profit|earnings?)$/i,
  /^net income \(loss\)$/i,
  /^net (income|profit|loss)$/i,
  /net income/i,
  /net profit/i,
];

const DEPRECIATION_PATTERNS = [
  /^depreciation( and amortization| & amortization)?$/i,
  /^depreciation$/i,
  /depreciation (and|&) amortization/i,
  /\bdepreciation\b/i,
];

const AMORTIZATION_PATTERNS = [
  /^amortization( of (intangibles?|goodwill|loan costs?))?$/i,
  /\bamortization\b/i,
];

// All debt instruments — used for per-named-loan financing (never aggregated).
// Absorbs the individual sub-arrays so they're not defined separately.
const ALL_LOAN_PATTERNS = [
  ...LINE_OF_CREDIT_PATTERNS,
  ...LONG_DEBT_PATTERNS,
  ...NOTES_PAYABLE_PATTERNS,
  /\bbank\s+loan\b/i,
  /\bcredit\s+line\b/i,
  /\bdirector.?s?\s+loan\b/i,
  /\bshareholder.?s?\s+loan\b/i,
  /\bpartner.?s?\s+loan\b/i,
  /\bvehicle\s+loan\b/i,
  /\bequipment\s+loan\b/i,
  /\bsba\s+loan\b/i,
  /\bterm\s+loan\b/i,
  /\bmortgage\b/i,
  /\bcredit\s+facility\b/i,
  /\bborrowing\b/i,
];

// ── Year extraction ───────────────────────────────────────────────────────────

function extractYear(row) {
  const report = row?.data?.manual_report_upload?.report;

  // 1. Prefer explicit date fields from the parsed report
  if (report) {
    const dateStr = report.asOfDate || report.periodEnd || report.periodStart;
    if (dateStr) {
      const m = String(dateStr).match(/\b(20\d{2})\b/);
      if (m) return parseInt(m[1], 10);
    }
  }

  // 2. Filename in report_params
  const fn = row?.report_params?.fileName || "";
  if (fn) {
    const mf = String(fn).match(/\b(20\d{2})\b/);
    if (mf) return parseInt(mf[1], 10);
  }

  // 3. Filename stored inside the data blob
  const dataFn = row?.data?.manual_report_upload?.fileName || row?.data?.manual_report_upload?.file_name || "";
  if (dataFn) {
    const mdf = String(dataFn).match(/\b(20\d{2})\b/);
    if (mdf) return parseInt(mdf[1], 10);
  }

  // 4. report_params.year (explicitly stored by some upload paths)
  if (row?.report_params?.year) {
    const y = parseInt(String(row.report_params.year), 10);
    if (y >= 2000 && y <= 2100) return y;
  }

  console.warn(`[ManualCashFlow] extractYear: could not determine year for record id=${row?.id}`);
  return null;
}

function groupByYear(rows = []) {
  const map = {};
  for (const row of rows) {
    const y = extractYear(row);
    if (!y) continue;
    if (!map[y] || new Date(row.updated_at) > new Date(map[y].updated_at)) {
      map[y] = row;
    }
  }
  return map;
}

/**
 * Robustly extract the report-row tree from a stored qb_synced_reports record.
 * Tries multiple storage paths used by the different upload routes.
 */
function extractRows(row) {
  if (!row) return [];
  const mu = row.data?.manual_report_upload;
  if (!mu) return [];

  // Primary path (syncManualUploadSource / syncManualReportFolder)
  if (Array.isArray(mu.report?.rows) && mu.report.rows.length > 0) return mu.report.rows;

  // Alternative: rows stored directly under manual_report_upload (some older paths)
  if (Array.isArray(mu.rows) && mu.rows.length > 0) return mu.rows;

  // Alternative: rows stored directly under data root
  if (Array.isArray(row.data?.rows) && row.data.rows.length > 0) return row.data.rows;

  console.warn(`[ManualCashFlow] extractRows: no rows found for record id=${row.id} (fileName=${mu.fileName || mu.report_params?.fileName || "?"})`);
  return [];
}

// ── Cash Flow generation (indirect method) ────────────────────────────────────

/**
 * GAAP indirect method cash flow statement.
 * Uses only leaf-level accounts so parent/header rows never double-count children.
 * bsPrevRows optional — when absent all balance-sheet deltas are 0.
 */
function buildCashFlow({ bsPrevRows, bsCurrRows, plRows, year }) {
  const hasPrev = Array.isArray(bsPrevRows) && bsPrevRows.length > 0;

  const plLeaves = flattenLeaves(plRows);
  const bsCLeaves = flattenLeaves(bsCurrRows);
  const bsPLeaves = hasPrev ? flattenLeaves(bsPrevRows) : [];

  // Per-account diagnostic log
  const diagnostics = [];
  function log(accountName, category, currentValue, previousValue, delta, cashFlowSection) {
    diagnostics.push({
      accountName, category,
      currentValue: r2(currentValue),
      previousValue: r2(previousValue),
      delta: r2(delta),
      cashFlowSection,
    });
  }

  // ── P&L values ──────────────────────────────────────────────────────────────
  const netIncome = sumLeaves(plLeaves, NET_INCOME_PATTERNS);
  const depreciation = sumLeaves(plLeaves, DEPRECIATION_PATTERNS);

  // Amortization: skip when already folded into the D&A line name
  const daLeaf = plLeaves.find((n) => DEPRECIATION_PATTERNS[0].test(String(n.name || "")));
  const amortization = /amortization/i.test(String(daLeaf?.name || ""))
    ? 0
    : sumLeaves(plLeaves, AMORTIZATION_PATTERNS);

  log("Net Income", "NetIncome", netIncome, 0, netIncome, "Operating");
  log("Depreciation", "Depreciation", depreciation, 0, depreciation, "Operating");
  if (amortization) log("Amortization", "Amortization", amortization, 0, amortization, "Operating");

  // ── Working capital deltas ─────────────────────────────────────────────────
  function wcd(label, category, patterns, sign) {
    if (!hasPrev) return 0;
    const curr = sumLeaves(bsCLeaves, patterns);
    const prev = sumLeaves(bsPLeaves, patterns);
    const delta = r2(sign * (curr - prev));
    log(label, category, curr, prev, delta, "Operating");
    return delta;
  }

  const changeAR = wcd("Accounts Receivable", "AccountsReceivable", AR_PATTERNS, -1);
  const changeInv = wcd("Inventory", "Inventory", INV_PATTERNS, -1);
  const changeOCA = wcd("Other Current Assets", "OtherCurrentAssets", OTHER_CA_PATTERNS, -1);
  const changeAP = wcd("Accounts Payable", "AccountsPayable", AP_PATTERNS, +1);
  const changeAccr = wcd("Accrued Expenses", "AccruedExpenses", ACCR_PATTERNS, +1);
  const changeOCL = wcd("Other Current Liabilities", "OtherCurrentLiabilities", OTHER_CL_PATTERNS, +1);

  const totalOperating = r2(
    netIncome + depreciation + amortization +
    changeAR + changeInv + changeAP + changeAccr + changeOCA + changeOCL
  );

  // ── Investing Activities ───────────────────────────────────────────────────
  const currFixed = sumLeaves(bsCLeaves, FIXED_PATTERNS);
  const prevFixed = hasPrev ? sumLeaves(bsPLeaves, FIXED_PATTERNS) : 0;
  const netFAChange = hasPrev ? r2(currFixed - prevFixed) : 0;

  let purchaseOfFixed = 0;
  let saleOfFixed = 0;

  if (hasPrev) {
    if (depreciation > 0) {
      // Under net PP&E reporting: Ending Net FA = Beginning Net FA + Capex − Depreciation
      // Therefore: Capex = (Ending − Beginning) + Depreciation
      const estimatedCapex = r2(netFAChange + depreciation);
      if (estimatedCapex > 0) {
        purchaseOfFixed = -estimatedCapex;          // cash outflow
        log("Fixed Assets (Purchase)", "FixedAssets", currFixed, prevFixed, purchaseOfFixed, "Investing");
      } else {
        // Net FA fell more than depreciation → proceeds from disposal
        saleOfFixed = r2(-estimatedCapex);          // cash inflow
        log("Fixed Assets (Sale)", "FixedAssets", currFixed, prevFixed, saleOfFixed, "Investing");
      }
    } else {
      // No depreciation available — use raw delta conservatively
      if (netFAChange > 0) {
        purchaseOfFixed = -netFAChange;
        log("Fixed Assets (Purchase, no depr)", "FixedAssets", currFixed, prevFixed, purchaseOfFixed, "Investing");
      } else if (netFAChange < 0) {
        saleOfFixed = -netFAChange;
        log("Fixed Assets (Sale, no depr)", "FixedAssets", currFixed, prevFixed, saleOfFixed, "Investing");
      }
    }
  }

  const currDep = sumLeaves(bsCLeaves, DEPOSITS_PATTERNS);
  const prevDep = hasPrev ? sumLeaves(bsPLeaves, DEPOSITS_PATTERNS) : 0;
  const securityDeposits = hasPrev ? r2(-(currDep - prevDep)) : 0;
  log("Security Deposits", "SecurityDeposits", currDep, prevDep, securityDeposits, "Investing");

  const currInvt = sumLeaves(bsCLeaves, INVESTMENTS_PATTERNS);
  const prevInvt = hasPrev ? sumLeaves(bsPLeaves, INVESTMENTS_PATTERNS) : 0;
  const investmentChange = hasPrev ? r2(-(currInvt - prevInvt)) : 0;
  log("Investments", "Investments", currInvt, prevInvt, investmentChange, "Investing");

  const totalInvesting = r2(purchaseOfFixed + saleOfFixed + securityDeposits + investmentChange);

  // ── Financing Activities ───────────────────────────────────────────────────
  const financingActivities = [];

  // Per-named-loan — every individual debt account tracked separately
  if (hasPrev) {
    const currLoans = findNamedLeaves(bsCLeaves, ALL_LOAN_PATTERNS);
    const prevLoans = findNamedLeaves(bsPLeaves, ALL_LOAN_PATTERNS);
    const prevLoanMap = new Map(prevLoans.map((l) => [l.name, l.amount]));
    const currLoanMap = new Map(currLoans.map((l) => [l.name, l.amount]));
    const allLoanNames = new Set([...currLoanMap.keys(), ...prevLoanMap.keys()]);

    for (const loanName of allLoanNames) {
      const curr = currLoanMap.get(loanName) ?? 0;
      const prev = prevLoanMap.get(loanName) ?? 0;
      const delta = r2(curr - prev);
      if (delta !== 0) {
        financingActivities.push({ label: `Loans - ${loanName}`, value: delta });
        log(`Loan: ${loanName}`, "Loans", curr, prev, delta, "Financing");
      }
    }
  }

  // Equity contribution — strict: paid-in capital and owner investment only
  const currEquity = sumLeaves(bsCLeaves, EQUITY_PAID_IN_PATTERNS);
  const prevEquity = hasPrev ? sumLeaves(bsPLeaves, EQUITY_PAID_IN_PATTERNS) : 0;
  const equityContrib = hasPrev ? r2(currEquity - prevEquity) : 0;
  if (equityContrib !== 0) log("Equity Contribution", "EquityContribution", currEquity, prevEquity, equityContrib, "Financing");
  financingActivities.push({ label: "Equity Contribution", value: equityContrib });

  // Dividends / owner draws — P&L only, never retained-earnings delta
  const dividends = sumLeaves(plLeaves, DIVIDENDS_PATTERNS);
  if (dividends !== 0) log("Dividends/Draws", "Dividends", dividends, 0, -dividends, "Financing");
  financingActivities.push({ label: "Dividends", value: -dividends });

  const totalFinancing = r2(financingActivities.reduce((s, a) => s + a.value, 0));

  // ── Cash reconciliation ───────────────────────────────────────────────────
  const beginningCash = r2(hasPrev ? sumLeaves(bsPLeaves, CASH_PATTERNS) : 0);
  const netCashChange = r2(totalOperating + totalInvesting + totalFinancing);
  const endingCash = r2(beginningCash + netCashChange);
  const bsEndingCash = r2(sumLeaves(bsCLeaves, CASH_PATTERNS));
  const reconDiff = r2(endingCash - bsEndingCash);
  const cashValidated = bsEndingCash !== 0 && Math.abs(reconDiff) <= 1;

  // Identify BS leaves not matched by any pattern (potential missing classifications)
  const allBSPatterns = [
    ...CASH_PATTERNS, ...AR_PATTERNS, ...INV_PATTERNS, ...AP_PATTERNS,
    ...ACCR_PATTERNS, ...OTHER_CA_PATTERNS, ...OTHER_CL_PATTERNS,
    ...FIXED_PATTERNS, ...DEPOSITS_PATTERNS, ...INVESTMENTS_PATTERNS,
    ...ALL_LOAN_PATTERNS, ...EQUITY_PAID_IN_PATTERNS,
  ];
  const unclassifiedAccounts = bsCLeaves
    .filter((leaf) => !allBSPatterns.some((pat) => {
      const re = pat instanceof RegExp ? pat : new RegExp(pat, "i");
      return re.test(String(leaf.name || ""));
    }))
    .map((l) => ({ name: l.name, amount: l.amount }));

  const reconciliationReport = {
    reconciliationStatus: cashValidated
      ? "RECONCILED"
      : bsEndingCash === 0 ? "NO_CASH_BALANCE" : "MISMATCH",
    reconciliationDifference: reconDiff,
    computedEndingCash: endingCash,
    balanceSheetCash: bsEndingCash,
    beginningCash,
    netCashChange,
    sectionTotals: { totalOperating, totalInvesting, totalFinancing },
    unclassifiedAccounts,
    diagnostics,
  };

  if (!cashValidated && bsEndingCash !== 0) {
    console.error(
      `[ManualCashFlow] Cash mismatch year=${year}: computed=${endingCash} vs BS=${bsEndingCash} (diff=${reconDiff})`,
      "\nUnclassified accounts:", unclassifiedAccounts,
      "\nSection totals:", reconciliationReport.sectionTotals,
    );
  } else {
    console.log("[ManualCashFlow] buildCashFlow OK", {
      year, totalOperating, totalInvesting, totalFinancing,
      netCashChange, beginningCash, endingCash, bsEndingCash, cashValidated,
    });
  }

  return {
    year: Number(year),
    reportType: "cashflow",
    accountingMethod: "Indirect",
    data: {
      operatingActivities: [
        { label: "Net Income", value: netIncome },
        { label: "Depreciation", value: depreciation },
        { label: "Amortization", value: amortization },
        { label: "Change in Accounts Receivable", value: changeAR },
        { label: "Change in Inventory", value: changeInv },
        { label: "Change in Accounts Payable", value: changeAP },
        { label: "Change in Accrued Expenses", value: changeAccr },
        { label: "Change in Other Current Assets", value: changeOCA },
        { label: "Change in Other Current Liabilities", value: changeOCL },
      ],
      totalOperating,
      investingActivities: [
        { label: "Purchase of Fixed Assets", value: purchaseOfFixed },
        { label: "Sale of Fixed Assets", value: saleOfFixed },
        { label: "Security Deposits", value: securityDeposits },
        { label: "Investments", value: investmentChange },
      ],
      totalInvesting,
      financingActivities,
      totalFinancing,
      netCashChange,
      beginningCash,
      endingCash,
      cashValidated,
      reconciliationReport,
    },
  };
}

// ── DB helpers ────────────────────────────────────────────────────────────────

async function fetchStoredCashFlow(companyId, year) {
  const { data, error } = await supabase
    .from("qb_synced_reports")
    .select("id, data, updated_at, last_synced_at, report_params")
    .eq("company_id", companyId)
    .eq("source", CF_GENERATED_SOURCE)
    .eq("report_type", CF_REPORT_TYPE)
    .filter("report_params->>period", "eq", String(year))
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Cash flow fetch failed: ${error.message}`);
  return data || null;
}

async function upsertGeneratedCashFlow(companyId, year, cfResult, inputs) {
  const now = new Date().toISOString();

  const payload = {
    company_id: companyId,
    report_type: CF_REPORT_TYPE,
    source: CF_GENERATED_SOURCE,
    report_params: { period: String(year), generated: true },
    data: {
      manual_upload_generated_cashflow: {
        period: String(year),
        generated: true,
        generatedAt: now,
        inputs,
        result: cfResult,
      },
    },
    status: "synced",
    last_synced_at: now,
    updated_at: now,
  };

  const existing = await fetchStoredCashFlow(companyId, year);

  if (existing?.id) {
    const { error } = await supabase
      .from("qb_synced_reports")
      .update(payload)
      .eq("id", existing.id);
    if (error) throw new Error(`Cash flow update failed: ${error.message}`);
  } else {
    const { error } = await supabase.from("qb_synced_reports").insert(payload);
    if (error) throw new Error(`Cash flow insert failed: ${error.message}`);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * List all years for which a Cash Flow has already been generated (by Sync All).
 * Reads directly from the persisted manual_upload_generated records.
 */
async function listAvailablePeriods(companyId) {
  if (!companyId) throw new Error("companyId is required");

  const { data, error } = await supabase
    .from("qb_synced_reports")
    .select("report_params, data, updated_at")
    .eq("company_id", companyId)
    .eq("source", CF_GENERATED_SOURCE)
    .eq("report_type", CF_REPORT_TYPE)
    .order("updated_at", { ascending: false });

  if (error) throw new Error(`Cash flow periods fetch failed: ${error.message}`);

  return (data || [])
    .map((row) => ({
      period: String(row.report_params?.period || ""),
      hasPreviousBS: row.data?.manual_upload_generated_cashflow?.inputs?.hasPreviousBS || false,
    }))
    .filter((p) => /^\d{4}$/.test(p.period));
}

/**
 * Generate (and cache) a Cash Flow statement for `year`.
 * Only requires BS(year) + PL(year).
 * BS(year-1) is used when available for delta calculations; otherwise 0.
 *
 * Returns { success, year, reportType, accountingMethod, data, generatedAt, inputs }
 *      or { success: false, message, missingInputs }
 */
async function generateCashFlow(companyId, year) {
  if (!companyId) throw new Error("companyId is required");
  const periodYear = parseInt(String(year), 10);
  if (!periodYear || periodYear < 2000 || periodYear > 2100) {
    throw new Error(`Invalid year: ${year}`);
  }

  const [bsRows, plRows] = await Promise.all([
    getAllManualUploadedReports({ companyId, statementType: "balance_sheet" }),
    getAllManualUploadedReports({ companyId, statementType: "profit_and_loss" }),
  ]);

  const bsByYear = groupByYear(bsRows);
  const plByYear = groupByYear(plRows);

  const bsCurr = bsByYear[periodYear];
  const bsPrev = bsByYear[periodYear - 1] || null; // optional
  const pl = plByYear[periodYear];

  const bsCurrAsOf = bsCurr?.data?.manual_report_upload?.report?.asOfDate || bsCurr?.report_params?.fileName || "?";
  const bsPrevAsOf = bsPrev?.data?.manual_report_upload?.report?.asOfDate || bsPrev?.report_params?.fileName || "none";
  const plPeriodEnd = pl?.data?.manual_report_upload?.report?.periodEnd || pl?.data?.manual_report_upload?.report?.asOfDate || pl?.report_params?.fileName || "?";

  console.log("[ManualCashFlow] generateCashFlow", {
    selectedYear: periodYear,
    currentBSYear: periodYear,
    previousBSYear: bsPrev ? periodYear - 1 : null,
    currentPLYear: periodYear,
    bsYearsFound: Object.keys(bsByYear).sort(),
    plYearsFound: Object.keys(plByYear).sort(),
    bsCurrId: bsCurr?.id || "MISSING",
    bsCurrAsOf,
    bsPrevId: bsPrev?.id || "none",
    bsPrevAsOf,
    plId: pl?.id || "MISSING",
    plPeriodEnd,
  });

  const missingInputs = [];
  if (!bsCurr) missingInputs.push(`Balance Sheet ${periodYear}`);
  if (!pl) missingInputs.push(`Profit & Loss ${periodYear}`);

  if (missingInputs.length > 0) {
    return {
      success: false,
      message: `Missing required files for ${periodYear} cash flow generation.`,
      missingInputs,
    };
  }

  const bsCurrRows = extractRows(bsCurr);
  const bsPrevRows = extractRows(bsPrev);
  const plDataRows = extractRows(pl);

  console.log("[ManualCashFlow] rows extracted", {
    bsCurrRows: bsCurrRows.length,
    bsPrevRows: bsPrevRows.length,
    plDataRows: plDataRows.length,
    hasPrev: bsPrevRows.length > 0,
  });

  const cfResult = buildCashFlow({
    bsPrevRows,
    bsCurrRows,
    plRows: plDataRows,
    year: periodYear,
  });

  const inputs = {
    bsPrevYear: bsPrev ? periodYear - 1 : null,
    bsCurrYear: periodYear,
    plYear: periodYear,
    bsPrevFile: bsPrev?.report_params?.fileName || null,
    bsCurrFile: bsCurr.report_params?.fileName || null,
    plFile: pl.report_params?.fileName || null,
    hasPreviousBS: Boolean(bsPrev),
  };

  // Validate reconciliation before persisting — never save a statement that mismatches BS cash
  const { cashValidated, reconciliationReport } = cfResult.data;
  if (!cashValidated && reconciliationReport?.reconciliationStatus === "MISMATCH") {
    console.warn(`[ManualCashFlow] Reconciliation failed for year=${periodYear} — statement NOT saved.`);
    return {
      success: false,
      message:
        `Cash flow reconciliation failed for ${periodYear}. ` +
        `Computed ending cash (${reconciliationReport.computedEndingCash}) does not match ` +
        `balance sheet cash (${reconciliationReport.balanceSheetCash}). ` +
        `Difference: ${reconciliationReport.reconciliationDifference}.`,
      year: periodYear,
      inputs,
      reconciliationReport,
    };
  }

  await upsertGeneratedCashFlow(companyId, periodYear, cfResult, inputs);

  return {
    success: true,
    generatedAt: new Date().toISOString(),
    inputs,
    ...cfResult,
  };
}

/**
 * Return a previously generated + cached Cash Flow for `year`, or null.
 */
async function getCachedCashFlow(companyId, year) {
  if (!companyId) throw new Error("companyId is required");
  const row = await fetchStoredCashFlow(companyId, year);
  if (!row) return null;

  const cf = row.data?.manual_upload_generated_cashflow;
  if (!cf?.result) return null;

  return {
    success: true,
    generatedAt: cf.generatedAt || row.updated_at,
    inputs: cf.inputs || null,
    ...cf.result,
  };
}

// ── Report-tree adapter ───────────────────────────────────────────────────────

/**
 * Convert the generated CF result into the hierarchical node tree the
 * frontend CashflowSummary renderer expects.
 * Handles both { data: {...} } and flat shapes.
 *
 * Node: { id, name, type: "header"|"data"|"total", amount, children? }
 */
function generatedCfToRows(cf) {
  const d = cf?.data || cf;

  function slug(label) {
    return String(label || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  function buildSection(activities, netAmount, sectionTitle) {
    const children = (activities || []).map((item) => ({
      id: slug(item.label),
      name: item.label,
      type: "data",
      amount: item.value ?? item.amount ?? 0,
    }));
    children.push({
      id: `total-${slug(sectionTitle)}`,
      name: `Net Cash from ${sectionTitle}`,
      type: "total",
      amount: netAmount || 0,
    });
    return {
      id: `section-${slug(sectionTitle)}`,
      name: `Cash Flows from ${sectionTitle}`,
      type: "header",
      amount: netAmount || 0,
      children,
    };
  }

  return [
    buildSection(d.operatingActivities, d.totalOperating ?? d.netOperating, "Operating Activities"),
    buildSection(d.investingActivities, d.totalInvesting ?? d.netInvesting, "Investing Activities"),
    buildSection(d.financingActivities, d.totalFinancing ?? d.netFinancing, "Financing Activities"),
    {
      id: "beginning-cash-balance",
      name: "Beginning Cash Balance",
      type: "data",
      amount: d.beginningCash || 0,
    },
    {
      id: "net-increase-decrease-in-cash",
      name: "Net Increase (Decrease) in Cash",
      type: "total",
      amount: d.netCashChange ?? d.netCashIncrease ?? 0,
    },
    {
      id: "ending-cash-balance",
      name: "Ending Cash Balance",
      type: "data",
      amount: d.endingCash || 0,
    },
  ];
}

// ── Gemini Cash Flow Generation (Indirect Method) ─────────────────────────────

// Dynamically selected via GEMINI_MODELS / GEMINI_MODEL env; this array is the
// default fallback order used when no override is configured.
const GEMINI_CF_MODELS = getGeminiModels(["gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-2.0-flash"]);
const GEMINI_CF_SLEEP = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function serializeFinancialRows(nodes, indent = 0) {
  const lines = [];
  for (const node of (nodes || [])) {
    const pad = "  ".repeat(indent);
    const sign = typeof node.amount === "number" && node.amount < 0 ? "-" : "";
    const abs = typeof node.amount === "number" ? Math.abs(node.amount).toFixed(2) : null;
    const amt = abs !== null ? `  $${sign}${abs}` : "";
    lines.push(`${pad}${node.name}${amt}`);
    if (Array.isArray(node.children) && node.children.length > 0) {
      lines.push(...serializeFinancialRows(node.children, indent + 1));
    }
  }
  return lines;
}

function buildCashFlowGeminiPrompt(plRows, bsCurrRows, bsPrevRows, year) {
  const pl = serializeFinancialRows(plRows).join("\n") || "Not available";
  const bsCurr = serializeFinancialRows(bsCurrRows).join("\n") || "Not available";
  const bsPrev = (bsPrevRows || []).length > 0
    ? serializeFinancialRows(bsPrevRows).join("\n")
    : "No previous year data available";

  return `You are a highly intelligent accounting engine and financial statement normalization system.

Your task is to generate an accurate CASH FLOW STATEMENT using the uploaded financial data below.

=== Current Year (${year}) Profit & Loss ===
${pl}

=== Current Year (${year}) Balance Sheet ===
${bsCurr}

=== Previous Year (${year - 1}) Balance Sheet ===
${bsPrev}

════════════════════════════════════════════════════════
PRIMARY OBJECTIVE
════════════════════════════════════════════════════════
Generate a valid INDIRECT METHOD CASH FLOW STATEMENT.

IMPORTANT:
* NEVER rely on exact account labels.
* Understand accounts SEMANTICALLY.
* Use accounting meaning/context.
* Ignore formatting differences, indentation inconsistencies, OCR spelling issues if meaning is clear.

════════════════════════════════════════════════════════
STEP 1 — NORMALIZE ALL ACCOUNTS
════════════════════════════════════════════════════════
Map every account to a standardized category using semantic understanding:

AccountsReceivable (ASSET):
  Accounts Receivable, A/R, Trade Receivables, Receivables, Debtors, Trade Debtors,
  Customer Receivables, Outstanding Invoices, Outstanding Receipts

AccountsPayable (LIABILITY):
  Accounts Payable, A/P, Trade Payables, Payables, Creditors, Trade Creditors,
  Vendor Payables, Supplier Payables

Inventory (ASSET):
  Inventory, Stock, Merchandise, Finished Goods, Raw Materials, WIP

AccruedExpenses (LIABILITY):
  Accrued Expenses, Accrued Liabilities, Outstanding Expenses, Expenses Payable

OtherCurrentAssets (ASSET):
  Prepaid Expenses, Prepaid Insurance, Prepaid Rent, Accrued Revenue,
  Advance Payments, Deposits (asset side), Other Current Assets

OtherCurrentLiabilities (LIABILITY):
  Credit Card, American Express, Short Term Borrowings, Deferred Revenue,
  Customer Deposits, Customer Advances, Other Current Liabilities

Loans (LIABILITY — one line per named account):
  Notes Payable, Loans Payable, Borrowings, Bank Loan, Director Loan,
  Partner Loan, Shareholder Loan, Long-Term Debt, Line of Credit, Revolver

Cash (ASSET):
  Bank Accounts, Cash, Checking Account, Savings Account, Cash in Hand,
  Petty Cash, Cash at Bank — any named bank account

SecurityDeposits (ASSET):
  Security Deposit, Rental Deposit, Deposits Paid

FixedAssets (ASSET):
  Property Plant & Equipment (net), Fixed Assets, Equipment, Furniture,
  Vehicles, Leasehold Improvements, Machinery, net PP&E

EquityContribution (EQUITY — STRICT RULE):
  INCLUDE ONLY: Capital Contribution, Owner Contribution, Paid-In Capital,
                Additional Paid-In Capital, Owner Investment
  EXCLUDE (not cash movements):
    • Any account with "Equity" in name but not "Contribution"
    • Opening Balance Equity, Retained Earnings, Net Income in equity section
    • Ownership % entries (e.g. "55%", "45%")

Dividends (from P&L):
  Owner Draws, Owner's Draw, Distributions, Dividends Paid

NetIncome (from P&L):
  Net Income, Net Profit, Net Earnings, Net Income (Loss), Profit for the Year

Depreciation (from P&L):
  Depreciation, Depreciation & Amortization, Depreciation Expense

Amortization (from P&L):
  Amortization, Amortization Expense — only if listed separately from Depreciation

════════════════════════════════════════════════════════
STEP 2 — REMOVE DUPLICATES & SUBTOTALS
════════════════════════════════════════════════════════
Do NOT double-count values.
Ignore subtotal rows, header rows, summary rows, and parent rows when
child detail rows already exist.
Only use LEAF-LEVEL financial rows for calculations.

════════════════════════════════════════════════════════
STEP 3 — GENERATE INDIRECT METHOD CASH FLOW
════════════════════════════════════════════════════════
Use (Current − Previous) for all BS deltas.
If no previous year data: all deltas = 0; BeginningCash = 0.

SIGN RULES:
  Asset increase    → cash outflow → NEGATIVE
  Asset decrease    → cash inflow  → POSITIVE
  Liability increase → cash inflow  → POSITIVE
  Liability decrease → cash outflow → NEGATIVE

── Operating Activities ──
NetIncome      = P&L NetIncome
Depreciation   = P&L Depreciation (add back, positive)
Amortization   = P&L Amortization (add back, positive; 0 if already in Depreciation line)
ARChange       = -(CurrentBS.AccountsReceivable - PreviousBS.AccountsReceivable)
InventoryChange= -(CurrentBS.Inventory - PreviousBS.Inventory)
APChange       = +(CurrentBS.AccountsPayable - PreviousBS.AccountsPayable)
AccruedChange  = +(CurrentBS.AccruedExpenses - PreviousBS.AccruedExpenses)
OCAChange      = -(CurrentBS.OtherCurrentAssets - PreviousBS.OtherCurrentAssets)
OCLChange      = +(CurrentBS.OtherCurrentLiabilities - PreviousBS.OtherCurrentLiabilities)
totalOperating = sum of all above

── Investing Activities ──
FixedAssetsChange     = -(CurrentBS.FixedAssets - PreviousBS.FixedAssets)
  Positive delta (net decrease) = asset sale = positive inflow
  Negative delta (net increase) = asset purchase = negative outflow
SecurityDepositChange = -(CurrentBS.SecurityDeposits - PreviousBS.SecurityDeposits)
Investments           = -(CurrentBS.Investments - PreviousBS.Investments)
totalInvesting = sum of all above

── Financing Activities — LOANS (one line per account, NEVER aggregated) ──
For EACH individual loan account found in the BS Liabilities section:
  LoanChange = CurrentBalance - PreviousBalance
  Label it: "Loans - [Exact Account Name from BS]"

── Financing Activities — EQUITY ──
EquityContribution = sum of INCLUDED equity accounts only (strict rule above); 0 if none
Dividends          = P&L owner draws/distributions (negative outflow)
totalFinancing = sum(all loan lines) + EquityContribution - Dividends

── Cash Reconciliation ──
netCashChange  = totalOperating + totalInvesting + totalFinancing
BeginningCash  = PreviousBS.Cash (0 if no previous year)
EndingCash     = BeginningCash + netCashChange

════════════════════════════════════════════════════════
STEP 4 — VALIDATE
════════════════════════════════════════════════════════
Check: BeginningCash + netCashChange ≈ CurrentBS.Cash
If difference > 1: reclassify ambiguous accounts and recalculate.
Report cashReconciled: true/false and the difference amount.

════════════════════════════════════════════════════════
STEP 5 — RETURN JSON ONLY
════════════════════════════════════════════════════════
NEVER return explanation, markdown, code fences, or commentary.
Include ALL line items even when value is 0.
Use numeric values only — never formatted currency strings.

{
  "year": ${year},
  "reportType": "cashflow",
  "accountingMethod": "Indirect",
  "operatingActivities": [
    { "label": "Net Income",                         "value": 0 },
    { "label": "Depreciation",                       "value": 0 },
    { "label": "Amortization",                       "value": 0 },
    { "label": "Change in Accounts Receivable",      "value": 0 },
    { "label": "Change in Inventory",                "value": 0 },
    { "label": "Change in Accounts Payable",         "value": 0 },
    { "label": "Change in Accrued Expenses",         "value": 0 },
    { "label": "Change in Other Current Assets",     "value": 0 },
    { "label": "Change in Other Current Liabilities","value": 0 }
  ],
  "totalOperating": 0,
  "investingActivities": [
    { "label": "Purchase of Fixed Assets", "value": 0 },
    { "label": "Sale of Fixed Assets",     "value": 0 },
    { "label": "Security Deposits",        "value": 0 },
    { "label": "Investments",              "value": 0 }
  ],
  "totalInvesting": 0,
  "financingActivities": [
    { "label": "Loans - [Account Name 1]", "value": 0 },
    { "label": "Loans - [Account Name 2]", "value": 0 },
    { "label": "Equity Contribution",      "value": 0 },
    { "label": "Dividends",                "value": 0 }
  ],
  "totalFinancing": 0,
  "beginningCash": 0,
  "netCashChange": 0,
  "endingCash": 0,
  "validation": {
    "cashReconciled": true,
    "difference": 0
  }
}`;
}

async function _callGemini(prompt, tag) {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not set");
  let lastError = null;
  for (const modelName of GEMINI_CF_MODELS) {
    let retries = 2;
    while (retries > 0) {
      try {
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ model: modelName });
        const result = await model.generateContent(prompt);
        return result.response.text();
      } catch (err) {
        lastError = err;
        const msg = String(err?.message || err);
        const isQuota = msg.includes("429") || msg.toLowerCase().includes("quota");
        const isNotFound = msg.includes("404") || msg.toLowerCase().includes("not found");
        console.warn(`[ManualCashFlow][${tag}] Gemini model ${modelName} error: ${msg}`);
        if (isNotFound) break;
        if (isQuota && retries > 1) { await GEMINI_CF_SLEEP(3000); retries--; }
        else break;
      }
    }
  }
  throw new Error(`Gemini ${tag} failed: ${lastError?.message || "unknown"}`);
}

const callGeminiForCashFlow = (prompt) => _callGemini(prompt, "CF-generation");
const callGeminiForNormalization = (prompt) => _callGemini(prompt, "account-normalization");

// ── Step-1 prompt: account normalization only (no arithmetic) ─────────────────

function buildAccountNormalizationPrompt(plRows, bsCurrRows, bsPrevRows, year) {
  const pl = serializeFinancialRows(plRows).join("\n") || "Not available";
  const bsCurr = serializeFinancialRows(bsCurrRows).join("\n") || "Not available";
  const bsPrev = (bsPrevRows || []).length > 0
    ? serializeFinancialRows(bsPrevRows).join("\n")
    : "Not available";

  return `You are an enterprise-grade financial statement normalization engine.

Your ONLY responsibility is to classify each account semantically.
NEVER calculate totals, cash flow arithmetic, or reconciliation.
NEVER infer or generate missing values.
NEVER generate summaries or explanations.

════════════════════════════════════════════════════
INPUT DATA
════════════════════════════════════════════════════

=== Profit & Loss (Year ${year}) ===
${pl}

=== Balance Sheet — Current Year (${year}) ===
${bsCurr}

=== Balance Sheet — Previous Year (${year - 1}) ===
${bsPrev}

════════════════════════════════════════════════════
RULES
════════════════════════════════════════════════════
1. Ignore subtotal, header, and parent rows — only classify LEAF-LEVEL rows.
2. Never double-count. If a parent and its children both appear, skip the parent.
3. Use semantic accounting understanding — not exact label matching.
4. Correct obvious OCR mistakes (e.g. "Acc0unts Receivab1e" → AccountsReceivable).
5. Each account entry must include: originalName, normalizedCategory, accountType, cashFlowSection, statementType, year, amount, confidence.
6. For statementType use exactly: "ProfitAndLoss", "BalanceSheet".
7. For year: use ${year} for P&L and current BS; use ${year - 1} for previous BS.
8. For Loans in the BS: classify each named borrowing separately with its exact original name.

════════════════════════════════════════════════════
STANDARDIZED CATEGORIES
════════════════════════════════════════════════════

ASSETS:       Cash, AccountsReceivable, Inventory, FixedAssets, SecurityDeposits, Investments, OtherCurrentAssets
LIABILITIES:  AccountsPayable, AccruedExpenses, OtherCurrentLiabilities, Loans, LongTermDebt, NotesPayable
EQUITY:       EquityContribution, RetainedEarnings, OwnerDraw, Dividends
P&L:          Revenue, CostOfGoodsSold, OperatingExpense, Depreciation, Amortization, InterestExpense, TaxExpense, NetIncome

Equity STRICT RULE — EquityContribution ONLY for:
  Paid-In Capital, Capital Contribution, Owner Contribution, Owner Investment, Additional Paid-In Capital
  NEVER classify these as EquityContribution: Retained Earnings, Opening Balance Equity, Owner Equity %, Net Income in equity section

════════════════════════════════════════════════════
SEMANTIC MAPPING EXAMPLES
════════════════════════════════════════════════════
AccountsReceivable: Trade Debtors, Debtors, Customer Receivables, Outstanding Invoices, Receivables
AccountsPayable:    Trade Creditors, Creditors, Vendor Payables, Supplier Payables
Cash:               Bank Account, Checking, Savings, Cash at Bank, Petty Cash, any named bank account
Loans:              Director Loan, Bank Loan, Shareholder Loan, Revolver, Line of Credit, Notes Payable
FixedAssets:        PPE (net), Equipment, Machinery, Vehicles, Furniture, Leasehold Improvements

════════════════════════════════════════════════════
RETURN JSON ONLY — no markdown, no explanation
════════════════════════════════════════════════════

{
  "accounts": [
    {
      "originalName": "Trade Debtors",
      "normalizedCategory": "AccountsReceivable",
      "accountType": "Asset",
      "cashFlowSection": "Operating",
      "statementType": "BalanceSheet",
      "year": ${year},
      "amount": 0,
      "confidence": 0.98
    }
  ]
}`;
}

// ── Step-2: compute CF deterministically from normalized accounts ──────────────

function buildCashFlowFromNormalized(accounts, year) {
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new Error("No normalized accounts to compute cash flow from");
  }

  const prevYear = year - 1;
  const LOAN_CATS = new Set(["Loans", "LongTermDebt", "NotesPayable"]);
  const MIN_CONFIDENCE = 0.5;

  const pl = accounts.filter((a) => a.statementType === "ProfitAndLoss" && (a.confidence ?? 1) >= MIN_CONFIDENCE);
  const bsCurr = accounts.filter((a) => a.statementType === "BalanceSheet" && Number(a.year) === year && (a.confidence ?? 1) >= MIN_CONFIDENCE);
  const bsPrev = accounts.filter((a) => a.statementType === "BalanceSheet" && Number(a.year) === prevYear && (a.confidence ?? 1) >= MIN_CONFIDENCE);
  const hasPrev = bsPrev.length > 0;

  function sumCat(arr, category) {
    return r2(arr.filter((a) => a.normalizedCategory === category).reduce((s, a) => s + (Number(a.amount) || 0), 0));
  }

  // ── P&L values ──
  const netIncome = sumCat(pl, "NetIncome");
  const depreciation = sumCat(pl, "Depreciation");
  const amortization = sumCat(pl, "Amortization");
  const dividends = r2(sumCat(pl, "OwnerDraw") + sumCat(pl, "Dividends"));

  // ── Operating deltas ──
  function wcd(category, sign) {
    if (!hasPrev) return 0;
    return r2(sign * (sumCat(bsCurr, category) - sumCat(bsPrev, category)));
  }

  const changeAR = wcd("AccountsReceivable", -1);
  const changeInv = wcd("Inventory", -1);
  const changeOCA = wcd("OtherCurrentAssets", -1);
  const changeAP = wcd("AccountsPayable", +1);
  const changeAccr = wcd("AccruedExpenses", +1);
  const changeOCL = wcd("OtherCurrentLiabilities", +1);

  const totalOperating = r2(netIncome + depreciation + amortization + changeAR + changeInv + changeAP + changeAccr + changeOCA + changeOCL);

  // ── Investing ──
  const fixedDelta = hasPrev ? r2(-(sumCat(bsCurr, "FixedAssets") - sumCat(bsPrev, "FixedAssets"))) : 0;
  const purchaseOfFixed = fixedDelta < 0 ? fixedDelta : 0;
  const saleOfFixed = fixedDelta > 0 ? fixedDelta : 0;
  const changeDeposits = hasPrev ? r2(-(sumCat(bsCurr, "SecurityDeposits") - sumCat(bsPrev, "SecurityDeposits"))) : 0;
  const changeInvestments = hasPrev ? r2(-(sumCat(bsCurr, "Investments") - sumCat(bsPrev, "Investments"))) : 0;
  const totalInvesting = r2(purchaseOfFixed + saleOfFixed + changeDeposits + changeInvestments);

  // ── Financing — per-named-loan ──
  const financingActivities = [];
  if (hasPrev) {
    const loanNames = [...new Set(
      [...bsCurr, ...bsPrev].filter((a) => LOAN_CATS.has(a.normalizedCategory)).map((a) => a.originalName)
    )];
    for (const loanName of loanNames) {
      const getBalance = (arr) => arr.filter((a) => a.originalName === loanName && LOAN_CATS.has(a.normalizedCategory)).reduce((s, a) => s + (Number(a.amount) || 0), 0);
      const loanChange = r2(getBalance(bsCurr) - getBalance(bsPrev));
      if (loanChange !== 0) financingActivities.push({ label: `Loans - ${loanName}`, value: loanChange });
    }
  }

  const equityContrib = hasPrev ? r2(sumCat(bsCurr, "EquityContribution") - sumCat(bsPrev, "EquityContribution")) : 0;
  financingActivities.push({ label: "Equity Contribution", value: equityContrib });
  financingActivities.push({ label: "Dividends", value: -dividends });
  const totalFinancing = r2(financingActivities.reduce((s, a) => s + a.value, 0));

  // ── Cash reconciliation ──
  const beginningCash = hasPrev ? r2(sumCat(bsPrev, "Cash")) : 0;
  const netCashChange = r2(totalOperating + totalInvesting + totalFinancing);
  const endingCash = r2(beginningCash + netCashChange);
  const bsEndingCash = r2(sumCat(bsCurr, "Cash"));
  const cashValidated = bsEndingCash !== 0 && Math.abs(endingCash - bsEndingCash) <= 1;

  if (!cashValidated && bsEndingCash !== 0) {
    console.warn(`[ManualCashFlow][normalized] Cash mismatch year=${year}: computed=${endingCash} vs BS=${bsEndingCash} (diff=${Math.abs(endingCash - bsEndingCash).toFixed(2)})`);
  }

  return {
    year: Number(year),
    reportType: "cashflow",
    accountingMethod: "Indirect",
    data: {
      operatingActivities: [
        { label: "Net Income", value: netIncome },
        { label: "Depreciation", value: depreciation },
        { label: "Amortization", value: amortization },
        { label: "Change in Accounts Receivable", value: changeAR },
        { label: "Change in Inventory", value: changeInv },
        { label: "Change in Accounts Payable", value: changeAP },
        { label: "Change in Accrued Expenses", value: changeAccr },
        { label: "Change in Other Current Assets", value: changeOCA },
        { label: "Change in Other Current Liabilities", value: changeOCL },
      ],
      totalOperating,
      investingActivities: [
        { label: "Purchase of Fixed Assets", value: purchaseOfFixed },
        { label: "Sale of Fixed Assets", value: saleOfFixed },
        { label: "Security Deposits", value: changeDeposits },
        { label: "Investments", value: changeInvestments },
      ],
      totalInvesting,
      financingActivities,
      totalFinancing,
      netCashChange,
      beginningCash,
      endingCash,
      cashValidated,
      generatedBy: "gemini_normalized",
    },
  };
}

function parseGeminiJsonText(text = "") {
  const cleaned = text.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  return JSON.parse(cleaned);
}

function normalizeCfFromGemini(raw, year) {
  if (!raw || typeof raw !== "object") throw new Error("Gemini returned non-object");

  const normalize = (arr) =>
    (Array.isArray(arr) ? arr : []).map((item) => ({
      label: String(item.label || item.name || ""),
      value: r2(item.value ?? item.amount ?? 0),
    }));

  const operatingActivities = normalize(raw.operatingActivities);
  const investingActivities = normalize(raw.investingActivities);
  const financingActivities = normalize(raw.financingActivities);

  // Guard against "Adjustments to Reconcile Net Income" subtotal rows that would
  // double-count individual WC items if accidentally included.
  const isAdjSubtotal = (item) => /adjustments?\s+to\s+reconcile/i.test(item.label);
  const operatingForSum = operatingActivities.filter((x) => !isAdjSubtotal(x));

  const totalOperating = r2(raw.totalOperating ?? operatingForSum.reduce((s, x) => s + x.value, 0));
  const totalInvesting = r2(raw.totalInvesting ?? investingActivities.reduce((s, x) => s + x.value, 0));
  const totalFinancing = r2(raw.totalFinancing ?? financingActivities.reduce((s, x) => s + x.value, 0));

  // Always recompute net cash from the three section totals for self-consistency.
  const netCashChange = r2(totalOperating + totalInvesting + totalFinancing);
  const beginningCash = r2(raw.beginningCash ?? 0);
  const endingCash = r2(beginningCash + netCashChange);

  // ── Validate against Gemini's reported values ────────────────────────────
  // Accept all field name variants: netCashChange (new), netIncrease, netIncreaseInCash (legacy).
  const geminiNetRaw = raw.netCashChange ?? raw.netIncrease ?? raw.netIncreaseInCash ?? null;
  if (geminiNetRaw != null) {
    const geminiNet = r2(geminiNetRaw);
    if (Math.abs(netCashChange - geminiNet) > 1) {
      throw new Error(
        `Cash flow reconciliation failed for year ${year}: ` +
        `computed net=${netCashChange} vs Gemini net=${geminiNet} ` +
        `(Operating=${totalOperating}, Investing=${totalInvesting}, Financing=${totalFinancing})`
      );
    }
  }
  if (raw.endingCash != null) {
    const geminiEnding = r2(raw.endingCash);
    if (Math.abs(endingCash - geminiEnding) > 1) {
      throw new Error(
        `Cash flow reconciliation failed for year ${year}: ` +
        `computed endingCash=${endingCash} vs Gemini endingCash=${geminiEnding}`
      );
    }
  }

  const cashReconciled = raw.validation?.cashReconciled ?? (Math.abs((raw.validation?.difference ?? 0)) <= 1);

  return {
    year: Number(raw.year || year),
    reportType: "cashflow",
    accountingMethod: raw.accountingMethod || "Indirect",
    data: {
      operatingActivities,
      totalOperating,
      investingActivities,
      totalInvesting,
      financingActivities,
      totalFinancing,
      netCashChange,
      beginningCash,
      endingCash,
      cashValidated: cashReconciled,
      generatedBy: "gemini",
    },
  };
}

async function generateCashFlowWithGemini(currentPL, currentBS, previousBS, year) {
  const plRows = extractRows(currentPL);
  const bsCurrRows = extractRows(currentBS);
  const bsPrevRows = previousBS ? extractRows(previousBS) : [];

  if (plRows.length === 0) throw new Error(`No P&L rows for year ${year}`);
  if (bsCurrRows.length === 0) throw new Error(`No BS rows for year ${year}`);

  // Step 1: normalize accounts with Gemini (classify only, no arithmetic)
  try {
    const normPrompt = buildAccountNormalizationPrompt(plRows, bsCurrRows, bsPrevRows, year);
    const normText = await callGeminiForNormalization(normPrompt);
    const normRaw = parseGeminiJsonText(normText);
    const accounts = Array.isArray(normRaw?.accounts) ? normRaw.accounts : null;
    if (accounts && accounts.length > 0) {
      return buildCashFlowFromNormalized(accounts, year);
    }
  } catch (e) {
    console.warn(`[ManualCashFlow] Two-step normalization failed: ${e.message}. Falling back to direct CF generation.`);
  }

  // Fallback: single-step Gemini CF generation
  const prompt = buildCashFlowGeminiPrompt(plRows, bsCurrRows, bsPrevRows, year);
  const responseText = await callGeminiForCashFlow(prompt);

  let raw;
  try {
    raw = parseGeminiJsonText(responseText);
  } catch (e) {
    throw new Error(`Gemini response JSON parse failed: ${e.message} — raw: ${responseText.slice(0, 300)}`);
  }

  return normalizeCfFromGemini(raw, year);
}

/**
 * Called at the end of Sync All.
 * Reads all uploaded BS + P&L rows from DB, groups by year, calls Gemini for each
 * complete year pair, and persists the results as manual_upload_generated records.
 */
async function generateAndSaveCashFlowsForAllYears(companyId, now = new Date().toISOString()) {
  if (!companyId) throw new Error("companyId is required");

  // Direct DB queries — avoids circular dep with manualReportUploadService
  const [{ data: bsRecs, error: bsErr }, { data: plRecs, error: plErr }] = await Promise.all([
    supabase.from("qb_synced_reports")
      .select("id, report_params, data, updated_at")
      .eq("company_id", companyId).eq("source", "manual_report_upload").eq("report_type", "balance_sheet")
      .order("updated_at", { ascending: false }),
    supabase.from("qb_synced_reports")
      .select("id, report_params, data, updated_at")
      .eq("company_id", companyId).eq("source", "manual_report_upload").eq("report_type", "profit_and_loss")
      .order("updated_at", { ascending: false }),
  ]);

  if (bsErr) throw new Error(`BS fetch failed: ${bsErr.message}`);
  if (plErr) throw new Error(`PL fetch failed: ${plErr.message}`);

  const bsByYear = groupByYear(bsRecs || []);
  const plByYear = groupByYear(plRecs || []);

  // Wipe existing generated CFs — Sync All always produces a clean slate
  await supabase.from("qb_synced_reports").delete()
    .eq("company_id", companyId)
    .eq("source", CF_GENERATED_SOURCE)
    .eq("report_type", CF_REPORT_TYPE);

  const generated = [];
  const failed = [];

  const years = Object.keys(plByYear).map(Number).filter((y) => bsByYear[y]).sort();

  for (const year of years) {
    const currentBS = bsByYear[year];
    const currentPL = plByYear[year];
    const previousBS = bsByYear[year - 1] || null;

    console.log("[ManualCashFlow] Generating CF via Gemini", {
      year,
      currentBSFound: !!currentBS,
      currentPLFound: !!currentPL,
      previousBSFound: !!previousBS,
    });

    try {
      const cfResult = await generateCashFlowWithGemini(currentPL, currentBS, previousBS, year);
      console.log("[ManualCashFlow] Generated Cash Flow", cfResult);

      const inputs = {
        bsPrevYear: previousBS ? year - 1 : null,
        bsCurrYear: year,
        plYear: year,
        bsPrevFile: previousBS?.report_params?.fileName || null,
        bsCurrFile: currentBS.report_params?.fileName || null,
        plFile: currentPL.report_params?.fileName || null,
        hasPreviousBS: Boolean(previousBS),
        generatedBy: "gemini",
      };

      await upsertGeneratedCashFlow(companyId, year, cfResult, inputs);
      generated.push({ year, success: true });
    } catch (err) {
      console.error(`[ManualCashFlow] Gemini generation failed for year=${year}:`, err.message);
      failed.push({ year, reason: err.message });
    }
  }

  return { generated, failed };
}

module.exports = {
  generateCashFlow,
  generateCashFlowWithGemini,
  generateAndSaveCashFlowsForAllYears,
  getCachedCashFlow,
  listAvailablePeriods,
  generatedCfToRows,
  // Exposed for the Key Reports report engine (keyReportReportService) so it can
  // build a version-isolated Cash Flow (indirect method) from the entry tables
  // WITHOUT touching Manual GL staging, batches, or qb_synced_reports.
  buildCashFlow,
};
