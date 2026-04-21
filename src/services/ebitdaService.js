import { fetchProfitAndLoss } from "../lib/quickbooks";
import { normalizeAccountingMethod } from "../lib/report-filters";

/**
 * EBITDA Service
 *
 * Extracts EBITDA components dynamically from the QuickBooks Profit & Loss
 * API response. Uses the proven parseSummaryReport approach to flatten the
 * deeply nested QB Rows→Row→ColData tree, then pattern-matches account names.
 *
 * EBITDA = Net Income + Interest + Taxes + Depreciation + Amortization
 */

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function toNumber(value) {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return 0;
  const trimmed = value.trim();
  if (!trimmed) return 0;
  const negativeByParens = trimmed.includes("(") && trimmed.includes(")");
  const numeric = parseFloat(trimmed.replace(/[^0-9.-]/g, ""));
  if (!Number.isFinite(numeric)) return 0;
  return negativeByParens ? -Math.abs(numeric) : numeric;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value?.Row) return asArray(value.Row);
  if (value === undefined || value === null) return [];
  return [value];
}

/**
 * Extract the top-level Rows.Row array from any payload shape.
 * The `/profit-and-loss-statement` backend returns the raw QB object,
 * while the `/profit-and-loss` route wraps it in `{ success, data }`.
 */
function extractRows(payload) {
  return asArray(
    payload?.Rows?.Row ||
      payload?.data?.Rows?.Row ||
      payload?.data?.data?.Rows?.Row ||
      payload?.data?.data?.data?.Rows?.Row ||
      [],
  );
}

function extractHeader(payload) {
  return (
    payload?.Header ||
      payload?.data?.Header ||
      payload?.data?.data?.Header ||
      {}
  );
}

function getRowLabel(row, fallback = "") {
  return (
    row?.Header?.ColData?.[0]?.value ||
      row?.Summary?.ColData?.[0]?.value ||
      row?.ColData?.[0]?.value ||
      fallback
  );
}

function findLastNumericValue(columns) {
  const list = Array.isArray(columns) ? columns : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const raw = list[i]?.value;
    if (raw === undefined || raw === null || raw === "") continue;
    const parsed = toNumber(String(raw));
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

function getChildRows(row) {
  if (!row) return [];
  return asArray(row.Rows?.Row || row.Rows || row.Row || []);
}

/* ------------------------------------------------------------------ */
/*  Deep flattener – walks every node and collects ALL leaf labels     */
/*  This is the key fix: we collect every single leaf row so no        */
/*  account is missed regardless of nesting depth.                     */
/* ------------------------------------------------------------------ */

/**
 * Recursively flattens the entire QB row tree into a simple array of
 * { label, value, depth, parentLabel } objects. This ensures we catch
 * every account regardless of how deeply QB nests it.
 */
function flattenAllRows(rows, depth = 0, parentLabel = "") {
  const results = [];

  for (const row of asArray(rows)) {
    const label = getRowLabel(row, "").trim();
    const children = getChildRows(row);

    // Leaf data row — has ColData but no children
    if (row?.ColData && Array.isArray(row.ColData) && children.length === 0) {
      results.push({
        label,
        value: findLastNumericValue(row.ColData),
        depth,
        parentLabel,
        source: "data",
      });
    }

    // Section with Summary — record the summary total
    if (row?.Summary?.ColData) {
      const summaryLabel =
        row.Summary.ColData[0]?.value || label || "Unknown Section";
      results.push({
        label: summaryLabel.trim(),
        value: findLastNumericValue(row.Summary.ColData),
        depth,
        parentLabel,
        source: "summary",
      });
    }

    // Section header row with value (no Summary)
    if (
      row?.Header?.ColData &&
      !row?.Summary &&
      children.length === 0 &&
      !row?.ColData
    ) {
      const headerCols = row.Header.ColData;
      if (headerCols.length > 1) {
        results.push({
          label: (headerCols[0]?.value || "").trim(),
          value: findLastNumericValue(headerCols),
          depth,
          parentLabel,
          source: "header",
        });
      }
    }

    // Recurse into children
    if (children.length > 0) {
      results.push(
        ...flattenAllRows(children, depth + 1, label || parentLabel),
      );
    }
  }

  return results;
}

/* ------------------------------------------------------------------ */
/*  Pattern matching – case-insensitive, partial, handles QB variants  */
/* ------------------------------------------------------------------ */

const INTEREST_PATTERNS = [
  "interest",
  "interest expense",
  "interest paid",
  "interest on loan",
  "loan interest",
  "mortgage interest",
  "finance charges",
  "interest and bank charges",
  "finance fee",
  "interest expense debt",
];

const INTEREST_EXCLUDE = [
  "interest income",
  "interest earned",
  "interest revenue",
  "dividend income",
];

const TAX_PATTERNS = [
  "tax",
  "taxes",
  "income tax",
  "tax expense",
  "income taxes",
  "provision for income tax",
  "provision for taxes",
  "federal tax",
  "state tax",
  "tax provision",
  "corporate tax",
  "franchise tax",
];

const TAX_EXCLUDE = [
  "sales tax",
  "tax payable",
  "tax liability",
  "payroll tax",
  "tax refund",
  "property tax",
  "excise tax",
  "employment tax",
];

const DEPRECIATION_PATTERNS = [
  "depreciation",
  "depreciation expense",
  "depreciation and amortization",
  "depreciation & amortization",
  "deprec",
];

const DEPRECIATION_EXCLUDE = [
  "accumulated depreciation",
];

const AMORTIZATION_PATTERNS = [
  "amortization",
  "amortization expense",
  "amortisation",
  "amortisation expense",
  "amort",
];

const NET_INCOME_PATTERNS = [
  "net income",
  "net income (loss)",
  "net profit",
  "net profit (loss)",
  "net earnings",
  "net operating income",
];

const ADJUSTMENT_PATTERNS = [
  "officer compensation",
  "owner salary",
  "management fee",
  "non recurring",
  "one time",
  "legal fee",
  "professional fee",
  "charitable contribution",
  "auto expense",
  "travel and entertainment",
  "meals and entertainment",
  "miscellaneous",
  "other expense",
  "non operating",
];

const ADJ_EXCLUDE = [
  "operating",
  "payroll",
];

const REVENUE_PATTERNS = [
  "total income",
  "total revenue",
  "gross profit",
];

const OPEX_PATTERNS = [
  "total expenses",
  "total operating expenses",
];

function normalize(label) {
  return String(label || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function matchesPatterns(label, patterns, excludePatterns = []) {
  const norm = normalize(label);
  if (!norm) return false;

  const words = norm.split(" ");

  // Check exclusions first
  for (const exclude of excludePatterns) {
    if (norm === exclude || norm.includes(exclude)) return false;
  }

  // Check includes
  for (const pattern of patterns) {
    const normPattern = normalize(pattern);
    // 1. Exact match
    if (norm === normPattern) return true;
    // 2. Label contains the full multi-word pattern (e.g. "total interest expense" contains "interest expense")
    if (normPattern.includes(" ") && norm.includes(normPattern)) return true;
    // 3. Label contains the pattern as a whole word (e.g. "Bank Interest" contains word "interest")
    if (words.includes(normPattern)) return true;
    // 4. Pattern contains the label (handles short labels only if long enough)
    if (normPattern.includes(norm) && norm.length >= 4) return true;
  }

  return false;
}

/* ------------------------------------------------------------------ */
/*  Component extraction from flattened rows                          */
/* ------------------------------------------------------------------ */

/**
 * Extract matched accounts for a component.
 * Prefers leaf "data" rows over "summary" totals to avoid double-counting.
 * If both a parent summary and its children match, keeps only the children.
 */
function extractComponent(flatRows, patterns, excludePatterns = []) {
  const matched = [];

  for (const row of flatRows) {
    if (matchesPatterns(row.label, patterns, excludePatterns)) {
      matched.push(row);
    }
  }

  if (matched.length === 0) return { items: [], total: 0 };

  // De-duplicate: if we have data rows AND a summary row for the same section,
  // prefer the summary (it's the accurate total from QB).
  const summaryRows = matched.filter((r) => r.source === "summary");
  const dataRows = matched.filter((r) => r.source === "data");

  if (summaryRows.length === 1 && dataRows.length > 0) {
    const isParentOfAny = dataRows.some(
      (d) => normalize(d.parentLabel) === normalize(summaryRows[0].label),
    );
    if (isParentOfAny) {
      return {
        items: dataRows.map((r) => ({ label: r.label, value: r.value })),
        total: summaryRows[0].value,
      };
    }
  }

  const seen = new Set();
  const uniqueItems = [];
  for (const row of matched) {
    const key = `${normalize(row.label)}:${row.value}:${row.parentLabel}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueItems.push({ label: row.label, value: row.value });
    }
  }

  return {
    items: uniqueItems,
    total: uniqueItems.reduce((sum, i) => sum + i.value, 0),
  };
}

/**
 * Find Net Income — the bottom-line of the P&L.
 * QB always renders it as the very last row.
 */
function findNetIncome(rows, flatRows) {
  // Try pattern match on flattened rows (from end)
  for (let i = flatRows.length - 1; i >= 0; i--) {
    if (matchesPatterns(flatRows[i].label, NET_INCOME_PATTERNS)) {
      return {
        label: flatRows[i].label,
        value: flatRows[i].value,
      };
    }
  }

  // Fallback: grab the very last top-level row's summary
  const topRows = asArray(rows);
  for (let i = topRows.length - 1; i >= 0; i--) {
    const row = topRows[i];
    if (row?.Summary?.ColData) {
      return {
        label: (row.Summary.ColData[0]?.value || "Net Income").trim(),
        value: findLastNumericValue(row.Summary.ColData),
      };
    }
    if (row?.ColData) {
      const lbl = normalize(row.ColData[0]?.value || "");
      if (lbl.includes("net")) {
        return {
          label: (row.ColData[0]?.value || "Net Income").trim(),
          value: findLastNumericValue(row.ColData),
        };
      }
    }
  }

  return { label: "Net Income", value: 0 };
}

/* ------------------------------------------------------------------ */
/*  Monthly EBITDA for trend chart (last 12 months)                   */
/* ------------------------------------------------------------------ */

/**
 * Fetches P&L for each of the last 12 months and computes EBITDA per month.
 */
export async function getEbitdaMonthlyTrend(accountingMethod) {
  const today = new Date();
  const months = [];

  for (let i = 11; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const year = d.getFullYear();
    const month = d.getMonth();
    const startDate = `${year}-${String(month + 1).padStart(2, "0")}-01`;
    const lastDay = new Date(year, month + 1, 0).getDate();
    const endDate = `${year}-${String(month + 1).padStart(2, "0")}-${String(
      lastDay,
    ).padStart(2, "0")}`;
    const label = d.toLocaleDateString("en-US", {
      month: "short",
      year: "numeric",
    });
    months.push({ startDate, endDate, label });
  }

  const results = [];

  for (const m of months) {
    try {
      const result = await getEbitdaData(
        m.startDate,
        m.endDate,
        accountingMethod,
      );
      results.push({
        month: m.label,
        startDate: m.startDate,
        endDate: m.endDate,
        ebitda: result.ebitda,
        adjustedEbitda: result.adjustedEbitda || result.ebitda,
        revenue: result.revenue || 0,
        opex: result.opex || 0,
        netIncome: result.components.netIncome.value,
        interest: result.components.interest.value,
        taxes: result.components.taxes.value,
        depreciation: result.components.depreciation.value,
        amortization: result.components.amortization.value,
        adjustments: result.components.adjustments.value,
      });
    } catch {
      results.push({
        month: m.label,
        startDate: m.startDate,
        endDate: m.endDate,
        ebitda: 0,
        adjustedEbitda: 0,
        revenue: 0,
        opex: 0,
        netIncome: 0,
        interest: 0,
        taxes: 0,
        depreciation: 0,
        amortization: 0,
        adjustments: 0,
        error: true,
      });
    }
  }

  return results;
}

/* ------------------------------------------------------------------ */
/*  Public API                                                        */
/* ------------------------------------------------------------------ */

/**
 * Fetches the P&L report from the existing API and extracts EBITDA components.
 *
 * @param {string} startDate  – YYYY-MM-DD
 * @param {string} endDate    – YYYY-MM-DD
 * @param {string} accountingMethod – "Cash" | "Accrual"
 * @returns {Promise<Object>} EBITDA breakdown
 */
export async function getEbitdaData(startDate, endDate, accountingMethod) {
  try {
    const payload = await fetchProfitAndLoss({
      ...(startDate ? { start_date: startDate } : {}),
      ...(endDate ? { end_date: endDate } : {}),
      ...(accountingMethod
        ? { accounting_method: normalizeAccountingMethod(accountingMethod) }
        : {}),
    });

    const rows = extractRows(payload);
    const header = extractHeader(payload);

    // Flatten the entire tree so we can search every leaf node
    const flatRows = flattenAllRows(rows);

    const reportPeriod = {
      startDate: header.StartPeriod || startDate || "",
      endDate: header.EndPeriod || endDate || "",
      reportBasis: header.ReportBasis || accountingMethod || "Accrual",
      currency: header.Currency || "USD",
      time: header.Time || "",
    };

    // Extract each component
    const netIncomeMatch = findNetIncome(rows, flatRows);
    const interest = extractComponent(
      flatRows,
      INTEREST_PATTERNS,
      INTEREST_EXCLUDE,
    );
    const taxes = extractComponent(flatRows, TAX_PATTERNS, TAX_EXCLUDE);
    const depreciation = extractComponent(
      flatRows,
      DEPRECIATION_PATTERNS,
      DEPRECIATION_EXCLUDE,
    );
    const amortization = extractComponent(flatRows, AMORTIZATION_PATTERNS);

    // New: Adjustments (Add-backs)
    const adjustments = extractComponent(
      flatRows,
      ADJUSTMENT_PATTERNS,
      ADJ_EXCLUDE,
    );

    // New: Revenue & OpEx for breakdown
    const revenue = extractComponent(flatRows, REVENUE_PATTERNS);
    const opex = extractComponent(flatRows, OPEX_PATTERNS);

    // To prevent double-counting (e.g. a row matched by both depreciation and amortization)
    // we track the unique row signatures added to the final EBITDA sum.
    const addBackRows = [
      ...interest.items,
      ...taxes.items,
      ...depreciation.items,
      ...amortization.items,
    ];

    const uniqueAddBackKeys = new Set();
    let uniqueAddBackTotal = 0;

    addBackRows.forEach((row) => {
      const key = `${normalize(row.label)}:${row.value}`;
      if (!uniqueAddBackKeys.has(key)) {
        uniqueAddBackKeys.add(key);
        uniqueAddBackTotal += row.value;
      }
    });

    // EBITDA = Net Income + Unique Add-Backs
    const ebitda = netIncomeMatch.value + uniqueAddBackTotal;

    // Adjusted EBITDA = EBITDA + Adjustments
    const adjustedEbitda = ebitda + adjustments.total;

    return {
      ebitda,
      adjustedEbitda,
      revenue: revenue.total,
      opex: opex.total,
      components: {
        netIncome: {
          label: netIncomeMatch.label || "Net Income",
          value: netIncomeMatch.value,
          matchedAccounts: [netIncomeMatch],
        },
        interest: {
          label: "Interest Expense",
          value: interest.total,
          matchedAccounts: interest.items,
        },
        taxes: {
          label: "Tax Expense",
          value: taxes.total,
          matchedAccounts: taxes.items,
        },
        depreciation: {
          label: "Depreciation",
          value: depreciation.total,
          matchedAccounts: depreciation.items,
        },
        amortization: {
          label: "Amortization",
          value: amortization.total,
          matchedAccounts: amortization.items,
        },
        adjustments: {
          label: "Add-backs & Adjustments",
          value: adjustments.total,
          matchedAccounts: adjustments.items,
        },
      },
      reportPeriod,
      hasData: rows.length > 0,
      _debug: {
        totalFlatRows: flatRows.length,
        topLevelRows: rows.length,
        uniqueAddBackTotal,
      },
    };
  } catch (error) {
    console.error("[EBITDA Service] Fatal error:", error);
    throw error;
  }
}
