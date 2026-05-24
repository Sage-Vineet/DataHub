"use strict";

const { supabase } = require("../db");
const { GoogleGenerativeAI } = require("@google/generative-ai");

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
 * Build the complete cash flow statement.
 * bsPrevRows is optional — when absent, all balance-sheet delta lines are 0.
 */
function buildCashFlow({ bsPrevRows, bsCurrRows, plRows, year }) {
  const hasPrev = Array.isArray(bsPrevRows) && bsPrevRows.length > 0;

  // ── Operating Activities ────────────────────────────────────────────────────

  const netIncome    = r2(findAmt(plRows, NET_INCOME_PATTERNS));
  const depreciation = r2(findAmt(plRows, DEPRECIATION_PATTERNS));

  // Amortization — only count when separate from D&A node
  const daNode = flatten(plRows).find((n) => DEPRECIATION_PATTERNS[0].test(String(n.name || "")));
  const amortization = /amortization/i.test(String(daNode?.name || ""))
    ? 0
    : r2(findAmt(plRows, AMORTIZATION_PATTERNS));

  // Working capital deltas — always read from both BSes.
  // When hasPrev=false all delta lines are forced to 0 (no baseline to compare against).
  const currAR   = findAmt(bsCurrRows, AR_PATTERNS);
  const prevAR   = hasPrev ? findAmt(bsPrevRows, AR_PATTERNS)        : 0;
  const currInv  = findAmt(bsCurrRows, INV_PATTERNS);
  const prevInv  = hasPrev ? findAmt(bsPrevRows, INV_PATTERNS)       : 0;
  const currAP   = findAmt(bsCurrRows, AP_PATTERNS);
  const prevAP   = hasPrev ? findAmt(bsPrevRows, AP_PATTERNS)        : 0;
  const currAccr = findAmt(bsCurrRows, ACCR_PATTERNS);
  const prevAccr = hasPrev ? findAmt(bsPrevRows, ACCR_PATTERNS)      : 0;
  const currOCA  = findAmt(bsCurrRows, OTHER_CA_PATTERNS);
  const prevOCA  = hasPrev ? findAmt(bsPrevRows, OTHER_CA_PATTERNS)  : 0;
  const currOCL  = findAmt(bsCurrRows, OTHER_CL_PATTERNS);
  const prevOCL  = hasPrev ? findAmt(bsPrevRows, OTHER_CL_PATTERNS)  : 0;

  // Operating indirect-method sign convention:
  //   AR  increase → cash used      → negative
  //   INV increase → cash used      → negative
  //   AP  increase → cash received  → positive
  //   ACCR increase → cash deferred → positive
  //   OCA increase → cash used      → negative
  //   OCL increase → cash deferred  → positive
  const changeAR   = hasPrev ? r2(-(currAR   - prevAR))   : 0;
  const changeInv  = hasPrev ? r2(-(currInv  - prevInv))  : 0;
  const changeAP   = hasPrev ? r2(+(currAP   - prevAP))   : 0;
  const changeAccr = hasPrev ? r2(+(currAccr - prevAccr)) : 0;
  const changeOCA  = hasPrev ? r2(-(currOCA  - prevOCA))  : 0;
  const changeOCL  = hasPrev ? r2(+(currOCL  - prevOCL))  : 0;

  const totalOperating = r2(
    netIncome + depreciation + amortization +
    changeAR + changeInv + changeAP + changeAccr + changeOCA + changeOCL
  );

  // ── Investing Activities ────────────────────────────────────────────────────
  // Raw year-over-year delta for each balance-sheet investing line.
  // PurchaseOfFixedAssets = currFixed - prevFixed (positive = net purchase = cash out)
  // SecurityDeposits      = -(currDep  - prevDep) (increase in deposits = cash out)
  // Investments           = currInvt  - prevInvt  (positive = net purchase = cash out)
  const currFixed = findAmt(bsCurrRows, FIXED_PATTERNS);
  const prevFixed = hasPrev ? findAmt(bsPrevRows, FIXED_PATTERNS)          : 0;
  const currDep   = findAmt(bsCurrRows, DEPOSITS_PATTERNS);
  const prevDep   = hasPrev ? findAmt(bsPrevRows, DEPOSITS_PATTERNS)       : 0;
  const currInvt  = findAmt(bsCurrRows, INVESTMENTS_PATTERNS);
  const prevInvt  = hasPrev ? findAmt(bsPrevRows, INVESTMENTS_PATTERNS)    : 0;

  const purchaseOfFixed  = hasPrev ? r2(currFixed - prevFixed)    : 0;
  const securityDeposits = hasPrev ? r2(-(currDep  - prevDep))    : 0;
  const investments      = hasPrev ? r2(currInvt   - prevInvt)    : 0;

  const totalInvesting = r2(purchaseOfFixed + securityDeposits + investments);

  // ── Financing Activities ────────────────────────────────────────────────────
  const currLOC   = findAmt(bsCurrRows, LINE_OF_CREDIT_PATTERNS);
  const prevLOC   = hasPrev ? findAmt(bsPrevRows, LINE_OF_CREDIT_PATTERNS)  : 0;
  const currLTD   = findAmt(bsCurrRows, LONG_DEBT_PATTERNS);
  const prevLTD   = hasPrev ? findAmt(bsPrevRows, LONG_DEBT_PATTERNS)       : 0;
  // Notes payable: fallback when neither LOC nor LTD is present
  const currNotes = (currLOC === 0 && currLTD === 0) ? findAmt(bsCurrRows, NOTES_PAYABLE_PATTERNS) : 0;
  const prevNotes = (hasPrev && prevLOC === 0 && prevLTD === 0) ? findAmt(bsPrevRows, NOTES_PAYABLE_PATTERNS) : 0;

  const totalDebtPrev = prevLOC + prevLTD + prevNotes;
  const totalDebtCurr = currLOC + currLTD + currNotes;
  const debtDelta     = hasPrev ? r2(totalDebtCurr - totalDebtPrev) : 0;

  // Loans split by direction; loanRepayment stored as a positive magnitude.
  const loansReceived = debtDelta > 0 ? debtDelta : 0;
  const loanRepayment = debtDelta < 0 ? r2(Math.abs(debtDelta)) : 0; // positive magnitude

  // Equity: raw delta (can be negative if equity decreased)
  const currEquity    = findAmt(bsCurrRows, EQUITY_PAID_IN_PATTERNS);
  const prevEquity    = hasPrev ? findAmt(bsPrevRows, EQUITY_PAID_IN_PATTERNS) : 0;
  const equityContrib = hasPrev ? r2(currEquity - prevEquity) : 0;

  // Dividends / distributions: taken from the P&L (positive outflow amount)
  const dividends = r2(findAmt(plRows, DIVIDENDS_PATTERNS));

  // Total: LoansReceived − LoanRepayment + EquityContribution − Dividends
  const totalFinancing = r2(loansReceived - loanRepayment + equityContrib - dividends);

  // ── Cash reconciliation ───────────────────────────────────────────────────
  // BeginningCash = PreviousYearBS.BankAccounts (0 when no previous BS)
  const beginningCash = r2(hasPrev ? findAmt(bsPrevRows, CASH_PATTERNS) : 0);
  const netCashChange = r2(totalOperating + totalInvesting + totalFinancing);
  // EndingCash derived arithmetically so the statement is always self-consistent.
  const bsEndingCash  = r2(findAmt(bsCurrRows, CASH_PATTERNS));
  const endingCash    = r2(beginningCash + netCashChange);
  const cashValidated = bsEndingCash !== 0 && Math.abs(endingCash - bsEndingCash) <= 1;

  if (!cashValidated && bsEndingCash !== 0) {
    console.error(`[ManualCashFlow] Cash mismatch year=${year}: computed endingCash=${endingCash} vs BS cash=${bsEndingCash} (diff=${Math.abs(endingCash - bsEndingCash).toFixed(2)})`);
  }

  // ── Diagnostics ──────────────────────────────────────────────────────────
  console.log("[ManualCashFlow] buildCashFlow", {
    year,
    hasPrev,
    workingCapitalChanges: {
      AR:   { curr: currAR,   prev: prevAR,   change: changeAR   },
      INV:  { curr: currInv,  prev: prevInv,  change: changeInv  },
      AP:   { curr: currAP,   prev: prevAP,   change: changeAP   },
      ACCR: { curr: currAccr, prev: prevAccr, change: changeAccr },
      OCA:  { curr: currOCA,  prev: prevOCA,  change: changeOCA  },
      OCL:  { curr: currOCL,  prev: prevOCL,  change: changeOCL  },
    },
    plValues:       { netIncome, depreciation, amortization },
    investing:      { purchaseOfFixed, securityDeposits, investments },
    financing:      { loansReceived, loanRepayment, equityContrib, dividends },
    totals:         { totalOperating, totalInvesting, totalFinancing, netCashChange },
    cash:           { beginningCash, bsEndingCash, endingCash, cashValidated },
  });

  return {
    year: Number(year),
    reportType: "cashflow",
    accountingMethod: "Accrual",
    data: {
      operatingActivities: [
        { label: "Net Income",                        value: netIncome    },
        { label: "Depreciation",                      value: depreciation },
        { label: "Amortization",                      value: amortization },
        { label: "Change in Accounts Receivable",     value: changeAR     },
        { label: "Change in Inventory",               value: changeInv    },
        { label: "Change in Accounts Payable",        value: changeAP     },
        { label: "Change in Accrued Expenses",        value: changeAccr   },
        { label: "Change in Other Current Assets",    value: changeOCA    },
        { label: "Change in Other Current Liabilities", value: changeOCL  },
      ],
      totalOperating,
      investingActivities: [
        { label: "Purchase of Fixed Assets", value: purchaseOfFixed  },
        { label: "Security Deposits",        value: securityDeposits },
        { label: "Investments",              value: investments      },
      ],
      totalInvesting,
      financingActivities: [
        { label: "Loans Received",      value: loansReceived    },
        { label: "Loan Repayment",      value: -loanRepayment   }, // stored as negative (cash outflow)
        { label: "Equity Contribution", value: equityContrib    },
        { label: "Dividends",           value: -dividends       }, // stored as negative (cash outflow)
      ],
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

// ── Gemini Cash Flow Generation (Indirect Method) ─────────────────────────────

const GEMINI_CF_MODELS = ["gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-2.0-flash"];
const GEMINI_CF_SLEEP  = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function serializeFinancialRows(nodes, indent = 0) {
  const lines = [];
  for (const node of (nodes || [])) {
    const pad  = "  ".repeat(indent);
    const sign = typeof node.amount === "number" && node.amount < 0 ? "-" : "";
    const abs  = typeof node.amount === "number" ? Math.abs(node.amount).toFixed(2) : null;
    const amt  = abs !== null ? `  $${sign}${abs}` : "";
    lines.push(`${pad}${node.name}${amt}`);
    if (Array.isArray(node.children) && node.children.length > 0) {
      lines.push(...serializeFinancialRows(node.children, indent + 1));
    }
  }
  return lines;
}

function buildCashFlowGeminiPrompt(plRows, bsCurrRows, bsPrevRows, year) {
  const pl     = serializeFinancialRows(plRows).join("\n")     || "Not available";
  const bsCurr = serializeFinancialRows(bsCurrRows).join("\n") || "Not available";
  const bsPrev = (bsPrevRows || []).length > 0
    ? serializeFinancialRows(bsPrevRows).join("\n")
    : "No previous year data available";

  return `You are an accounting engine.

Your job:
1. Read the entire Balance Sheet and Profit & Loss.
2. Understand each account SEMANTICALLY — never rely on exact labels.
3. Normalize account names to standard categories using the table below.
4. Generate a Cash Flow Statement using the INDIRECT METHOD.

=== Current Year (${year}) Profit & Loss ===
${pl}

=== Current Year (${year}) Balance Sheet ===
${bsCurr}

=== Previous Year (${year - 1}) Balance Sheet ===
${bsPrev}

════════════════════════════════════════════════════════
STEP 1 — NORMALIZE ACCOUNT NAMES
════════════════════════════════════════════════════════
Map every account you find to its standard category below.
Use accounting meaning and context — not exact string matching.

AccountsReceivable (ASSET):
  Accounts Receivable, Accounts Receivable (A/R), Trade Receivables, Receivables,
  Customer Receivables, Outstanding Receipts, Debtors, Trade Debtors

AccountsPayable (LIABILITY):
  Accounts Payable, Accounts Payable (A/P), Trade Payables, Payables,
  Creditors, Trade Creditors

Inventory (ASSET):
  Inventory, Stock, Finished Goods, Raw Material, Inventory Assets

AccruedExpenses (LIABILITY):
  Accrued Expenses, Outstanding Expenses, Accrued Liabilities, Expenses Payable

OtherCurrentAssets (ASSET):
  Accrued Revenue, Prepaid Expenses, Advance Payments, Deposits (asset side),
  Current Assets Other

OtherCurrentLiabilities (LIABILITY):
  American Express, Credit Card, Short Term Borrowings, Current Liabilities Other

Loans (LIABILITY — detail lines, one per account):
  Loans, Borrowings, Long Term Debt, Notes Payable, Bank Loan,
  Director Loan, Partner Loan — any named borrowing in Liabilities section

Cash (ASSET):
  Bank Accounts, Cash, Checking Account, Savings Account, any named bank account,
  Cash in Hand, Petty Cash

SecurityDeposits (ASSET):
  Security Deposit, Rental Deposit, Deposits Paid

FixedAssets (ASSET):
  Property Plant & Equipment, Fixed Assets, Equipment, Furniture,
  Leasehold Improvements, Vehicles, net PP&E

EquityContribution (EQUITY — STRICT RULE):
  INCLUDE ONLY: Capital Contribution, Owner Contribution, Paid-In Capital,
                Additional Paid-In Capital
  EXCLUDE (NOT cash movements):
    • Any account with "Equity" in name but not "Contribution"
      (e.g. "[Name] - Equity", "Owner Equity", ownership % entries like "55%", "45%")
    • Opening Balance Equity
    • Retained Earnings
    • Net Income in equity section

Dividends (from P&L):
  Owner Draws, Owner's Draw, Distributions, Dividends Paid

NetIncome (from P&L):
  Net Income, Net Profit, Net Earnings, Net Income (Loss), Profit for the Year

Depreciation (from P&L):
  Depreciation, Depreciation & Amortization, Depreciation Expense

Amortization (from P&L):
  Amortization, Amortization Expense (only if separate from Depreciation)

════════════════════════════════════════════════════════
STEP 2 — COMPUTE CASH FLOW (INDIRECT METHOD)
════════════════════════════════════════════════════════
Use (Current − Previous) for all BS deltas.
If no previous year data: all deltas = 0; BeginningCash = 0.

SIGN RULES:
  Asset account change    → cash impact = -(Current − Previous)
    [asset increase = cash used = negative]
  Liability account change → cash impact = +(Current − Previous)
    [liability increase = cash received = positive]

── Operating Activities ──
NetIncome      = P&L NetIncome
Depreciation   = P&L Depreciation (add back, positive)
Amortization   = P&L Amortization (add back, positive; 0 if already included in Depreciation)
ARChange       = -(CurrentBS.AccountsReceivable - PreviousBS.AccountsReceivable)
InventoryChange= -(CurrentBS.Inventory - PreviousBS.Inventory)
APChange       = +(CurrentBS.AccountsPayable - PreviousBS.AccountsPayable)
AccruedChange  = +(CurrentBS.AccruedExpenses - PreviousBS.AccruedExpenses)
OCAChange      = -(CurrentBS.OtherCurrentAssets - PreviousBS.OtherCurrentAssets)
OCLChange      = +(CurrentBS.OtherCurrentLiabilities - PreviousBS.OtherCurrentLiabilities)

totalOperating = NetIncome + Depreciation + Amortization
               + ARChange + InventoryChange + APChange + AccruedChange + OCAChange + OCLChange

── Investing Activities ──
FixedAssetsChange     = -(CurrentBS.FixedAssets - PreviousBS.FixedAssets)
SecurityDepositChange = -(CurrentBS.SecurityDeposits - PreviousBS.SecurityDeposits)

totalInvesting = FixedAssetsChange + SecurityDepositChange

── Financing Activities — LOANS (one line per account, never aggregated) ──
For EACH individual loan account found in the BS Liabilities section:
  LoanChange = CurrentBalance - PreviousBalance
  Label it: "Loans - [Exact Account Name as it appears in the BS]"

── Financing Activities — EQUITY ──
EquityContribution = sum of INCLUDED equity accounts only (see normalization rules above).
                     If no qualifying accounts: 0.
Dividends          = P&L owner draws/distributions (use as negative outflow).

totalFinancing = sum(all loan lines) + EquityContribution - Dividends

── Cash ──
NetIncrease  = totalOperating + totalInvesting + totalFinancing
BeginningCash = PreviousBS.Cash  (0 if no previous year)
EndingCash    = BeginningCash + NetIncrease

════════════════════════════════════════════════════════
STEP 3 — VALIDATE
════════════════════════════════════════════════════════
Check: BeginningCash + NetIncrease ≈ CurrentBS.Cash
If difference > 1: attempt reclassification of ambiguous accounts and recalculate.

════════════════════════════════════════════════════════
STEP 4 — RETURN JSON ONLY
════════════════════════════════════════════════════════
Never return explanation, markdown, or code fences.
Include ALL line items even if value is 0.
Use standard English label names (not account codes).

{
  "year": ${year},
  "reportType": "cashflow",
  "period": { "start": "${year}-01-01", "end": "${year}-12-31" },
  "operatingActivities": [
    { "label": "Net Income",                        "value": 0 },
    { "label": "Depreciation",                      "value": 0 },
    { "label": "Amortization",                      "value": 0 },
    { "label": "Change in Accounts Receivable",     "value": 0 },
    { "label": "Change in Inventory",               "value": 0 },
    { "label": "Change in Accounts Payable",        "value": 0 },
    { "label": "Change in Accrued Expenses",        "value": 0 },
    { "label": "Change in Other Current Assets",    "value": 0 },
    { "label": "Change in Other Current Liabilities","value": 0 }
  ],
  "totalOperating": 0,
  "investingActivities": [
    { "label": "Purchase of Fixed Assets", "value": 0 },
    { "label": "Security Deposits",        "value": 0 }
  ],
  "totalInvesting": 0,
  "financingActivities": [
    { "label": "Loans - [Account Name 1]", "value": 0 },
    { "label": "Loans - [Account Name 2]", "value": 0 },
    { "label": "Equity Contribution",      "value": 0 },
    { "label": "Dividends",                "value": 0 }
  ],
  "totalFinancing": 0,
  "netIncrease": 0,
  "beginningCash": 0,
  "endingCash": 0
}`;
}

async function callGeminiForCashFlow(prompt) {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not set");
  let lastError = null;
  for (const modelName of GEMINI_CF_MODELS) {
    let retries = 2;
    while (retries > 0) {
      try {
        const genAI  = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const model  = genAI.getGenerativeModel({ model: modelName });
        const result = await model.generateContent(prompt);
        return result.response.text();
      } catch (err) {
        lastError = err;
        const msg       = String(err?.message || err);
        const isQuota   = msg.includes("429") || msg.toLowerCase().includes("quota");
        const isNotFound = msg.includes("404") || msg.toLowerCase().includes("not found");
        console.warn(`[ManualCashFlow] Gemini model ${modelName} error: ${msg}`);
        if (isNotFound) break;
        if (isQuota && retries > 1) { await GEMINI_CF_SLEEP(3000); retries--; }
        else break;
      }
    }
  }
  throw new Error(`Gemini CF generation failed: ${lastError?.message || "unknown"}`);
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

  // Trust Gemini's explicit section totals; fall back to array sum.
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
  const endingCash    = r2(beginningCash + netCashChange);

  // ── Validate against Gemini's reported values ──────────────────────────────
  // Accept both field name variants: netIncrease (new) and netIncreaseInCash (legacy).
  const geminiNetRaw = raw.netIncrease ?? raw.netIncreaseInCash ?? null;
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

  return {
    year: Number(raw.year || year),
    reportType: "cashflow",
    accountingMethod: "Accrual",
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
      cashValidated: true,
      generatedBy: "gemini",
    },
  };
}

async function generateCashFlowWithGemini(currentPL, currentBS, previousBS, year) {
  const plRows     = extractRows(currentPL);
  const bsCurrRows = extractRows(currentBS);
  const bsPrevRows = previousBS ? extractRows(previousBS) : [];

  if (plRows.length === 0)     throw new Error(`No P&L rows for year ${year}`);
  if (bsCurrRows.length === 0) throw new Error(`No BS rows for year ${year}`);

  const prompt       = buildCashFlowGeminiPrompt(plRows, bsCurrRows, bsPrevRows, year);
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
  const failed    = [];

  const years = Object.keys(plByYear).map(Number).filter((y) => bsByYear[y]).sort();

  for (const year of years) {
    const currentBS  = bsByYear[year];
    const currentPL  = plByYear[year];
    const previousBS = bsByYear[year - 1] || null;

    console.log("[ManualCashFlow] Generating CF via Gemini", {
      year,
      currentBSFound:  !!currentBS,
      currentPLFound:  !!currentPL,
      previousBSFound: !!previousBS,
    });

    try {
      const cfResult = await generateCashFlowWithGemini(currentPL, currentBS, previousBS, year);
      console.log("[ManualCashFlow] Generated Cash Flow", cfResult);

      const inputs = {
        bsPrevYear:    previousBS ? year - 1 : null,
        bsCurrYear:    year,
        plYear:        year,
        bsPrevFile:    previousBS?.report_params?.fileName || null,
        bsCurrFile:    currentBS.report_params?.fileName  || null,
        plFile:        currentPL.report_params?.fileName  || null,
        hasPreviousBS: Boolean(previousBS),
        generatedBy:   "gemini",
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
};
