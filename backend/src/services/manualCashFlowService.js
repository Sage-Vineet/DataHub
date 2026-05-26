"use strict";

const { supabase } = require("../db");

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
function findAmt(nodes, patterns) {
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

// Accrued Revenue (unbilled / contract assets — treated as Other Current Asset)
const ACCRUED_REVENUE_PATTERNS = [
  /^(total )?accrued revenue$/i,
  /accrued revenue/i,
  /unbilled (revenue|receivables?)/i,
];

// American Express / credit-card liability account (treated as Other Current Liability)
const AMERICAN_EXPRESS_PATTERNS = [
  /^american express$/i,
  /american express/i,
  /\bamex\b/i,
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
 * Build the complete cash flow statement using only exact values from the
 * uploaded Balance Sheet and P&L. No AI inference, no estimation.
 *
 * Sign rules (per spec):
 *   Operating assets  (AR, Inventory, OCA) — balance is negated  (cash tied up)
 *   Operating liabilities (AP, Accrued, OCL) — balance is positive (cash deferred)
 *   OCA includes AccruedRevenue + OtherCurrentAssets
 *   OCL includes AmericanExpress + OtherCurrentLiabilities
 *   Investing outflows (Fixed Assets, Security Deposits) — negated
 *   Financing loans / equity — positive; Dividends — negated
 *
 * All section totals are calculated programmatically — never text-predicted.
 */
function buildCashFlow({ bsPrevRows, bsCurrRows, plRows, year }) {
  const hasPrev = Array.isArray(bsPrevRows) && bsPrevRows.length > 0;

  // ── OPERATING ACTIVITIES ────────────────────────────────────────────────────

  // Source: P&L only
  const netIncome    = r2(findAmt(plRows, NET_INCOME_PATTERNS));
  const depreciation = r2(findAmt(plRows, DEPRECIATION_PATTERNS));

  // Amortization — only when it is a separate line (not already folded into D&A)
  const daNode = flatten(plRows).find((n) => DEPRECIATION_PATTERNS[0].test(String(n.name || "")));
  const amortization = /amortization/i.test(String(daNode?.name || ""))
    ? 0
    : r2(findAmt(plRows, AMORTIZATION_PATTERNS));

  // Working-capital adjustments — always read from CURRENT Balance Sheet directly.
  // No year-over-year delta; the ending balance represents the period's net change.
  const currAR         = r2(findAmt(bsCurrRows, AR_PATTERNS));
  const currInv        = r2(findAmt(bsCurrRows, INV_PATTERNS));
  const currAP         = r2(findAmt(bsCurrRows, AP_PATTERNS));
  const currAccr       = r2(findAmt(bsCurrRows, ACCR_PATTERNS));
  const currOCA        = r2(findAmt(bsCurrRows, OTHER_CA_PATTERNS));
  const currAccruedRev = r2(findAmt(bsCurrRows, ACCRUED_REVENUE_PATTERNS));
  const currOCL        = r2(findAmt(bsCurrRows, OTHER_CL_PATTERNS));
  const currAmEx       = r2(findAmt(bsCurrRows, AMERICAN_EXPRESS_PATTERNS));

  // Apply sign convention — values stored with sign already applied
  const changeAR   = r2(-currAR);                         // -(AccountsReceivable)
  const changeInv  = r2(-currInv);                        // -(Inventory)
  const changeAP   = r2(currAP);                          // +(AccountsPayable)
  const changeAccr = r2(currAccr);                        // +(AccruedExpenses)
  const changeOCA  = r2(-(currOCA + currAccruedRev));     // -(AccruedRevenue + OtherCurrentAssets)
  const changeOCL  = r2(currOCL + currAmEx);              // +(AmericanExpress + OtherCurrentLiabilities)

  // Programmatic total — never AI-generated
  const totalOperating = r2(
    netIncome + depreciation + amortization +
    changeAR + changeInv + changeAP + changeAccr + changeOCA + changeOCL
  );

  // ── INVESTING ACTIVITIES ────────────────────────────────────────────────────
  // Only include lines where a value is actually present in the BS.

  const currFixed = r2(findAmt(bsCurrRows, FIXED_PATTERNS));
  const currDep   = r2(findAmt(bsCurrRows, DEPOSITS_PATTERNS));

  // Spending on assets = cash outflow (negative)
  const purchaseOfFixed  = currFixed !== 0 ? r2(-currFixed) : 0;
  // Security deposits paid = cash outflow (negative)
  const securityDeposits = currDep   !== 0 ? r2(-currDep)   : 0;

  const investingActivities = [];
  if (purchaseOfFixed  !== 0) investingActivities.push({ label: "Purchase of Fixed Assets", value: purchaseOfFixed  });
  if (securityDeposits !== 0) investingActivities.push({ label: "Security Deposits",         value: securityDeposits });

  // Programmatic total
  const totalInvesting = r2(investingActivities.reduce((s, x) => s + x.value, 0));

  // ── FINANCING ACTIVITIES ────────────────────────────────────────────────────
  // Loans: current balance of all debt accounts (positive = outstanding = received)
  const currLOC   = r2(findAmt(bsCurrRows, LINE_OF_CREDIT_PATTERNS));
  const currLTD   = r2(findAmt(bsCurrRows, LONG_DEBT_PATTERNS));
  // Notes payable: fallback only when neither LOC nor LTD is present
  const currNotes = (currLOC === 0 && currLTD === 0)
    ? r2(findAmt(bsCurrRows, NOTES_PAYABLE_PATTERNS))
    : 0;
  const loansTotal    = r2(currLOC + currLTD + currNotes);

  const currEquity    = r2(findAmt(bsCurrRows, EQUITY_PAID_IN_PATTERNS));
  const equityContrib = currEquity;

  // Dividends / distributions — from P&L, stored as negative (cash outflow)
  const dividends = r2(findAmt(plRows, DIVIDENDS_PATTERNS));

  const financingActivities = [];
  if (loansTotal    !== 0) financingActivities.push({ label: "Loans",               value: loansTotal          });
  if (equityContrib !== 0) financingActivities.push({ label: "Equity Contribution", value: equityContrib       });
  if (dividends     !== 0) financingActivities.push({ label: "Dividends",           value: r2(-dividends)      });

  // Programmatic total
  const totalFinancing = r2(financingActivities.reduce((s, x) => s + x.value, 0));

  // ── FINAL TOTALS (programmatic) ───────────────────────────────────────────────
  const netCashChange = r2(totalOperating + totalInvesting + totalFinancing);
  const beginningCash = r2(hasPrev ? findAmt(bsPrevRows, CASH_PATTERNS) : 0);
  const endingCash    = r2(beginningCash + netCashChange);

  // ── MANDATORY VALIDATION ────────────────────────────────────────────────────
  // Compare computed ending cash against current BS bank balance.
  // If difference > 0.01 the statement does not reconcile.
  const bsEndingCash  = r2(findAmt(bsCurrRows, CASH_PATTERNS));
  const cashDiff      = bsEndingCash !== 0 ? Math.abs(endingCash - bsEndingCash) : 0;
  const cashValidated = bsEndingCash === 0 || cashDiff <= 0.01;

  if (!cashValidated) {
    console.error(
      `[ManualCashFlow] VALIDATION FAILED year=${year}: ` +
      `computed endingCash=${endingCash} vs BS bankTotal=${bsEndingCash} ` +
      `diff=${cashDiff.toFixed(2)} | ` +
      `Operating=${totalOperating} Investing=${totalInvesting} Financing=${totalFinancing}`
    );
  }

  console.log("[ManualCashFlow] buildCashFlow", {
    year, hasPrev,
    operating: { netIncome, depreciation, amortization, changeAR, changeInv, changeAP, changeAccr, changeOCA, changeOCL },
    investing:  { purchaseOfFixed, securityDeposits },
    financing:  { loansTotal, equityContrib, dividends },
    totals:     { totalOperating, totalInvesting, totalFinancing, netCashChange },
    cash:       { beginningCash, bsEndingCash, endingCash, cashValidated },
  });

  return {
    year: Number(year),
    reportType: "cashflow",
    accountingMethod: "Accrual",
    data: {
      operatingActivities: [
        { label: "Net Income",                          value: netIncome    },
        { label: "Depreciation",                        value: depreciation },
        { label: "Amortization",                        value: amortization },
        { label: "Change in Accounts Receivable",       value: changeAR     },
        { label: "Change in Inventory",                 value: changeInv    },
        { label: "Change in Accounts Payable",          value: changeAP     },
        { label: "Change in Accrued Expenses",          value: changeAccr   },
        { label: "Change in Other Current Assets",      value: changeOCA    },
        { label: "Change in Other Current Liabilities", value: changeOCL    },
      ],
      totalOperating,
      investingActivities,
      totalInvesting,
      financingActivities,
      totalFinancing,
      netCashChange,
      beginningCash,
      endingCash,
      cashValidated,
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
      period:       String(row.report_params?.period || ""),
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
  const pl     = plByYear[periodYear];

  const bsCurrAsOf  = bsCurr?.data?.manual_report_upload?.report?.asOfDate  || bsCurr?.report_params?.fileName || "?";
  const bsPrevAsOf  = bsPrev?.data?.manual_report_upload?.report?.asOfDate  || bsPrev?.report_params?.fileName || "none";
  const plPeriodEnd = pl?.data?.manual_report_upload?.report?.periodEnd     || pl?.data?.manual_report_upload?.report?.asOfDate || pl?.report_params?.fileName || "?";

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
  if (!pl)     missingInputs.push(`Profit & Loss ${periodYear}`);

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
    bsPrevYear:  bsPrev ? periodYear - 1 : null,
    bsCurrYear:  periodYear,
    plYear:      periodYear,
    bsPrevFile:  bsPrev?.report_params?.fileName || null,
    bsCurrFile:  bsCurr.report_params?.fileName  || null,
    plFile:      pl.report_params?.fileName      || null,
    hasPreviousBS: Boolean(bsPrev),
  };

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
    buildSection(d.operatingActivities,  d.totalOperating  ?? d.netOperating,  "Operating Activities"),
    buildSection(d.investingActivities,   d.totalInvesting  ?? d.netInvesting,  "Investing Activities"),
    buildSection(d.financingActivities,   d.totalFinancing  ?? d.netFinancing,  "Financing Activities"),
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


/**
 * Called at the end of Sync All.
 * Reads all uploaded BS + P&L rows from DB, groups by year, runs the programmatic
 * buildCashFlow for each complete year pair, and persists the results.
 * No AI / Gemini calls — all values come directly from the uploaded reports.
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
  const failed    = [];

  const years = Object.keys(plByYear).map(Number).filter((y) => bsByYear[y]).sort();

  for (const year of years) {
    const currentBS  = bsByYear[year];
    const currentPL  = plByYear[year];
    const previousBS = bsByYear[year - 1] || null;

    console.log("[ManualCashFlow] Generating CF (programmatic)", {
      year,
      currentBSFound:  !!currentBS,
      currentPLFound:  !!currentPL,
      previousBSFound: !!previousBS,
    });

    try {
      const bsCurrRows = extractRows(currentBS);
      const bsPrevRows = previousBS ? extractRows(previousBS) : [];
      const plRows     = extractRows(currentPL);

      if (plRows.length === 0)     throw new Error(`No P&L rows extracted for year ${year}`);
      if (bsCurrRows.length === 0) throw new Error(`No BS rows extracted for year ${year}`);

      const cfResult = buildCashFlow({ bsPrevRows, bsCurrRows, plRows, year });

      const inputs = {
        bsPrevYear:    previousBS ? year - 1 : null,
        bsCurrYear:    year,
        plYear:        year,
        bsPrevFile:    previousBS?.report_params?.fileName || null,
        bsCurrFile:    currentBS.report_params?.fileName  || null,
        plFile:        currentPL.report_params?.fileName  || null,
        hasPreviousBS: Boolean(previousBS),
        generatedBy:   "programmatic",
      };

      await upsertGeneratedCashFlow(companyId, year, cfResult, inputs);
      generated.push({ year, success: true });
    } catch (err) {
      console.error(`[ManualCashFlow] Cash flow generation failed for year=${year}:`, err.message);
      failed.push({ year, reason: err.message });
    }
  }

  return { generated, failed };
}

module.exports = {
  generateCashFlow,
  generateAndSaveCashFlowsForAllYears,
  getCachedCashFlow,
  listAvailablePeriods,
  generatedCfToRows,
};
