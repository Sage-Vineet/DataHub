import { fetchProfitAndLoss } from "../lib/quickbooks";
import { normalizeAccountingMethod } from "../lib/report-filters";
import { parseSummaryReport } from "../lib/report-parsers";


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
) {
  try {
    const payload = await fetchProfitAndLoss({
      start_date: startDate,
      end_date: endDate,
      ...(accountingMethod
        ? { accounting_method: normalizeAccountingMethod(accountingMethod) }
        : {}),
    });
    return parseSummaryReport(payload);
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
) {
  // Summary now uses user-selected filters (QuickBooks-style Summary report)
  const rows = await fetchSinglePeriodPNL(
    startDate,
    endDate,
    accountingMethod,
  );
  return rows;
}

export async function getProfitAndLossDetail(
  startDate,
  endDate,
  accountingMethod,
) {
  // Detail now uses system-defined multi-year comparison (EBITDA analysis)
  const periods = getPNLComparativePeriods(4);

  const results = await Promise.all(
    periods.map((p) => fetchSinglePeriodPNL(p.start, p.end, accountingMethod)),
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

