import { fetchProfitAndLoss } from "../lib/quickbooks";
import { getLatestManualUploadedReport, getManualGlProfitLoss } from "../lib/api";
import { normalizeAccountingMethod } from "../lib/report-filters";
import { parseSummaryReport } from "../lib/report-parsers";

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value?.Row) return asArray(value.Row);
  if (value === undefined || value === null) return [];
  return [value];
}

function toNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value !== "string") return 0;

  const trimmed = value.trim();
  if (!trimmed) return 0;

  const negativeByParens = trimmed.includes("(") && trimmed.includes(")");
  const numeric = parseFloat(trimmed.replace(/[^0-9.-]/g, ""));
  if (!Number.isFinite(numeric)) return 0;

  return negativeByParens ? -Math.abs(numeric) : numeric;
}

function getChildRows(row) {
  return asArray(row?.Rows?.Row || row?.Rows || row?.Row || []);
}

function getLabel(row, fallback = "") {
  return (
    row?.Header?.ColData?.[0]?.value ||
    row?.Summary?.ColData?.[0]?.value ||
    row?.ColData?.[0]?.value ||
    fallback
  );
}

function getMonthlyColumnDefs(payload = {}) {
  const columns = asArray(payload?.Columns?.Column || payload?.data?.Columns?.Column);
  const labels = columns
    .map((column) => column?.ColTitle || column?.ColType || column?.MetaData?.[0]?.Value || "")
    .filter(Boolean);
  const valueLabels = labels.slice(1);

  if (valueLabels.length > 1) {
    return valueLabels.map((label, index) => ({
      key: `pnl_col_${index}`,
      label,
      index: index + 1,
    }));
  }

  return [];
}

function getRowAmounts(row, columns) {
  const colData = row?.Summary?.ColData || row?.ColData || row?.Header?.ColData || [];
  const amounts = {};

  columns.forEach((column) => {
    amounts[column.key] = toNumber(colData[column.index]?.value);
  });

  return amounts;
}

function buildMonthlyTotal(amounts, columns) {
  if (!columns.length) return 0;
  const totalColumn = columns[columns.length - 1];
  const explicitTotal = amounts[totalColumn.key];
  if (String(totalColumn.label || "").toLowerCase() === "total") {
    return explicitTotal || 0;
  }

  return columns.reduce((sum, column) => sum + (amounts[column.key] || 0), 0);
}

function parseMonthlySummaryRows(rows, columns, indexOffset = 0) {
  const result = [];

  asArray(rows).forEach((row, index) => {
    const children = parseMonthlySummaryRows(getChildRows(row), columns, indexOffset + index);
    const name = getLabel(row, "Section");
    const source = row.Header ? { ColData: row.Header.ColData } : row;
    const amounts = getRowAmounts(source, columns);
    const amount = buildMonthlyTotal(amounts, columns);
    const key = String(name).replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
    const type = row.Header
      ? "header"
      : /^total\b|^net\b/i.test(name)
        ? "total"
        : "data";

    const node = {
      id: row.id || row.group || `pnl-${key}-${indexOffset + index}`,
      name,
      amount,
      amounts,
      type,
      children: children.length ? children : undefined,
    };

    if (row.Summary?.ColData) {
      const summaryName = row.Summary.ColData[0]?.value || `Total ${name}`;
      const summaryAmounts = getRowAmounts({ ColData: row.Summary.ColData }, columns);
      const lastChild = children[children.length - 1];
      if (!lastChild || lastChild.name !== summaryName) {
        node.children = [
          ...(node.children || []),
          {
            id: `total-${key}-${indexOffset + index}`,
            name: summaryName,
            amount: buildMonthlyTotal(summaryAmounts, columns),
            amounts: summaryAmounts,
            type: "total",
          },
        ];
      }
    }

    result.push(node);
  });

  return result;
}

function parseProfitAndLossMonthlyReport(payload) {
  const columns = getMonthlyColumnDefs(payload);
  const rows = asArray(payload?.Rows?.Row || payload?.data?.Rows?.Row);
  if (columns.length <= 1 || rows.length === 0) return parseSummaryReport(payload);

  return {
    rows: parseMonthlySummaryRows(rows, columns),
    columns: {
      pnlCols: columns.map(({ key, label }) => ({ key, label })),
    },
  };
}

/**
 * Generates periods for Profit & Loss Comparative Summary.
 * We need:
 * 1. Full Years (e.g., 2022, 2023, 2024)
 * 2. YTD for Current Year (e.g., 2025 YTD)
 * 3. YTD for Previous Year (e.g., 2024 YTD) for comparison
 */
function getPNLComparativePeriods(numYears = 4) {
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth();
  const currentDay = now.getDate();
  const todayStr = `${currentYear}-${String(currentMonth + 1).padStart(2, "0")}-${String(currentDay).padStart(2, "0")}`;

  const periods = [];

  // Full previous years (dynamic)
  for (let i = numYears - 1; i >= 1; i--) {
    const year = currentYear - i;
    periods.push({
      key: `y${year}`,
      label: `FY ${year}`,
      start: `${year}-01-01`,
      end: `${year}-12-31`,
    });
  }

  // Current year YTD
  const currentYearKey = `y${currentYear}`;
  periods.push({
    key: currentYearKey,
    label: `FY ${currentYear} YTD`,
    start: `${currentYear}-01-01`,
    end: todayStr,
  });

  // Previous year YTD (same period for comparison)
  const prevYear = currentYear - 1;
  const prevYtdKey = `y${prevYear}_ytd`;
  periods.push({
    key: prevYtdKey,
    label: `FY ${prevYear} YTD`,
    start: `${prevYear}-01-01`,
    end: `${prevYear}-${String(currentMonth + 1).padStart(2, "0")}-${String(currentDay).padStart(2, "0")}`,
  });

  return periods;
}

async function fetchSinglePeriodPNL(
  startDate,
  endDate,
  accountingMethod,
  sourceMode = "quickbooks",
) {
  try {
    if (sourceMode === "manual_upload") {
      const payload = await getLatestManualUploadedReport("profit_and_loss");
      return Array.isArray(payload?.data?.rows) ? payload.data.rows : [];
    }

    if (sourceMode === "manual") {
      const payload = await getManualGlProfitLoss();
      return parseSummaryReport(payload?.quickbooksSchema || payload?.data || payload);
    }

    const payload = await fetchProfitAndLoss({
      start_date: startDate,
      end_date: endDate,
      summarize_column_by: "Month",
      ...(accountingMethod
        ? { accounting_method: normalizeAccountingMethod(accountingMethod) }
        : {}),
    });
    return parseProfitAndLossMonthlyReport(payload);
  } catch (err) {
    console.warn(
      `⚠️ Failed to fetch P&L for ${startDate} - ${endDate}:`,
      err.message,
    );
    return [];
  }
}

function normalizeName(name) {
  if (!name) return "";
  return String(name)
    .toLowerCase()
    .replace(/^total\s+/i, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function mergePNLPeriods(periodResults, periods) {
  // Find the current-year YTD period (the one without _ytd suffix that's most recent)
  const currentYearKey = periods
    .filter((p) => !p.key.includes("_ytd"))
    .pop()?.key;
  const masterIndex = periods.findIndex((p) => p.key === currentYearKey);
  const masterRows = periodResults[masterIndex] || periodResults[periodResults.length - 1] || [];

  if (masterRows.length === 0) return [];

  // Create lookup maps for all periods
  const periodMaps = periodResults.map((rows) => {
    const map = new Map();
    const visit = (items) => {
      if (!Array.isArray(items)) return;
      items.forEach((item) => {
        const key = normalizeName(item.name);
        if (key) map.set(key, item.amount || 0);
        if (item.children) visit(item.children);
      });
    };
    visit(rows);
    return map;
  });

  const enrich = (node) => {
    const amounts = {};
    const normName = normalizeName(node.name);

    periods.forEach((period, i) => {
      amounts[period.key] = periodMaps[i].get(normName) || 0;
    });

    return {
      ...node,
      amounts,
      children: Array.isArray(node.children)
        ? node.children.map(enrich)
        : undefined,
    };
  };

  return masterRows.map(enrich);
}

export async function getProfitAndLoss(
  startDate,
  endDate,
  accountingMethod,
  options = {},
) {
  // Summary now uses user-selected filters (QuickBooks-style Summary report)
  const rows = await fetchSinglePeriodPNL(
    startDate,
    endDate,
    accountingMethod,
    options?.sourceMode || "quickbooks",
  );
  return rows;
}

export async function getProfitAndLossDetail(
  startDate,
  endDate,
  accountingMethod,
  options = {},
) {
  // Detail now uses system-defined multi-year comparison (EBITDA analysis)
  const periods = getPNLComparativePeriods(4);

  const results = await Promise.all(
    periods.map((p) =>
      fetchSinglePeriodPNL(
        p.start,
        p.end,
        accountingMethod,
        options?.sourceMode || "quickbooks",
      ),
    ),
  );

  const rows = mergePNLPeriods(results, periods);

  const yearCols = periods
    .filter((p) => !p.key.includes("_ytd"))
    .map((p) => ({
      key: p.key,
      label: p.label,
    }));

  const currentYearKey = periods
    .filter((p) => !p.key.includes("_ytd"))
    .pop()?.key;
  const prevYtdKey = periods.find((p) => p.key.includes("_ytd"))?.key;

  const ytdComparison = {
    currentKey: currentYearKey,
    prevKey: prevYtdKey,
    currentLabel: periods.find((p) => p.key === currentYearKey)?.label,
    prevLabel: periods.find((p) => p.key === prevYtdKey)?.label,
  };

  return {
    rows,
    columns: {
      yearCols,
      ytdComparison,
    },
  };
}
