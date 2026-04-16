import { fetchBalanceSheet } from "../lib/quickbooks";
import { normalizeAccountingMethod } from "../lib/report-filters";
import {
  parseBalanceSheetDetailFromAllReports,
  parseDetailReport,
  parseSummaryReport,
} from "../lib/report-parsers";

const API_BASE_URL = (
  import.meta.env.VITE_API_BASE_URL || "http://localhost:4000"
).replace(/\/$/, "");

function resolveClientIdFromLocation() {
  if (typeof window === "undefined") return null;
  const hash = window.location.hash || "";
  const pathname = window.location.pathname || "";
  const hashMatch = hash.match(/\/client\/([^/?#]+)/);
  const pathMatch = pathname.match(/\/client\/([^/?#]+)/);
  const match = hashMatch || pathMatch;
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Generates dynamic comparative periods based on a specific end date.
 * Plus an additional period for the previous month to calculate monthly delta.
 */
function getComparativePeriods(numYears = 5, baseDateString) {
  const baseDate = baseDateString ? new Date(baseDateString) : new Date();
  const date = isNaN(baseDate.getTime()) ? new Date() : baseDate;
  
  const currentYear = date.getFullYear();
  const currentMonth = date.getMonth();
  const periods = [];

  const monthNames = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const monthLabel = monthNames[currentMonth];

  // 1. Yearly snapshots
  for (let i = numYears - 1; i >= 0; i--) {
    const year = currentYear - i;
    const lastDay = new Date(year, currentMonth + 1, 0).getDate();
    const endDate = `${year}-${String(currentMonth + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
    
    const index = (numYears - 1) - i + 1;
    periods.push({
      year,
      key: `y${index}`,
      label: `${monthLabel}-${String(year).slice(-2)}`,
      endDate,
      type: 'yearly'
    });
  }

  // 2. Previous Month snapshot (for monthly delta)
  // Calculate relative month
  const prevMonthDate = new Date(date);
  prevMonthDate.setMonth(date.getMonth() - 1);
  const pmYear = prevMonthDate.getFullYear();
  const pmMonth = prevMonthDate.getMonth();
  const pmLastDay = new Date(pmYear, pmMonth + 1, 0).getDate();
  const pmEndDate = `${pmYear}-${String(pmMonth + 1).padStart(2, "0")}-${String(pmLastDay).padStart(2, "0")}`;

  periods.push({
    key: 'pm',
    label: 'PROV_MONTH',
    endDate: pmEndDate,
    type: 'comparison'
  });

  return periods;
}

async function fetchSinglePeriodBS(endDate, accountingMethod) {
  try {
    const payload = await fetchBalanceSheet({
      end_date: endDate,
      ...(accountingMethod
        ? { accounting_method: normalizeAccountingMethod(accountingMethod) }
        : {}),
    });
    return parseSummaryReport(payload);
  } catch (err) {
    console.warn(`⚠️ Failed to fetch Balance Sheet for ${endDate}:`, err.message);
    return [];
  }
}

function normalizeName(name) {
  if (!name) return "";
  return String(name)
    .toLowerCase()
    .replace(/^total\s+/i, "") // Remove leading "Total "
    .replace(/[^a-z0-9]+/g, " ") // Replace non-alphanumeric with spaces
    .replace(/\s+/g, " ") // Collapse multiple spaces
    .trim();
}

function mergePeriods(periodResults, periods) {
  // Use y5 (Current Year) as the base structure
  const masterIndex = periods.findIndex(p => p.key === "y5");
  const masterRows = periodResults[masterIndex] || [];
  
  if (masterRows.length === 0) return [];

  // Create lookup maps for all periods for fast retrieval
  const periodMaps = periodResults.map(rows => {
    const map = new Map();
    const visit = (items) => {
      if (!Array.isArray(items)) return;
      items.forEach(item => {
        const key = normalizeName(item.name);
        if (key) map.set(key, item.amount || 0);
        if (item.children) visit(item.children);
      });
    };
    visit(rows);
    return map;
  });

  const pmIndex = periods.findIndex(p => p.key === "pm");

  const enrich = (node) => {
    const amounts = {};
    const normName = normalizeName(node.name);

    periods.forEach((period, i) => {
      // Look up based on normalized name
      amounts[period.key] = periodMaps[i].get(normName) || 0;
    });

    const currentVal = amounts.y5 || 0;
    const prevMonthVal = amounts.pm || 0;
    amounts.monthlyChange = currentVal - prevMonthVal;

    return {
      ...node,
      amounts,
      children: Array.isArray(node.children) ? node.children.map(enrich) : undefined
    };
  };

  return masterRows.map(enrich);
}

// ─── Exported Services ──────────────────────────────────────────────────────

export async function getBalanceSheet(startDate, endDate, accountingMethod) {
  const allPeriods = getComparativePeriods(5, endDate);

  const results = await Promise.all(
    allPeriods.map(p => fetchSinglePeriodBS(p.endDate, accountingMethod))
  );

  const rows = mergePeriods(results, allPeriods);

  const yearCols = allPeriods
    .filter(p => p.type === 'yearly')
    .map(p => ({
      key: p.key,
      label: p.label,
      isCurrent: p.key === "y5"
    }));

  const changeCols = [];
  const yearlyPeriods = allPeriods.filter(p => p.type === 'yearly');
  for (let i = 1; i < yearlyPeriods.length; i++) {
    const prev = yearlyPeriods[i - 1];
    const curr = yearlyPeriods[i];
    changeCols.push({
      key: `c${i}`,
      label: `'${String(curr.year).slice(-2)} CHANGE`,
      from: prev.key,
      to: curr.key
    });
  }

  const currentPeriodLabel = yearlyPeriods[yearlyPeriods.length - 1].label;

  return {
    rows,
    columns: {
      yearCols,
      changeCols,
      currentMonth: currentPeriodLabel
    }
  };
}

export async function getBalanceSheetDetail(startDate, endDate, accountingMethod) {
  const clientId = resolveClientIdFromLocation();
  const search = new URLSearchParams({
    ...(startDate ? { start_date: startDate } : {}),
    ...(endDate ? { end_date: endDate } : {}),
    ...(accountingMethod ? { accounting_method: normalizeAccountingMethod(accountingMethod) } : {}),
  }).toString();

  const response = await fetch(`${API_BASE_URL}/all-reports${search ? `?${search}` : ""}`, {
    credentials: "include",
    headers: { ...(clientId ? { "X-Client-Id": clientId } : {}) },
  });

  const payload = await response.json();
  return {
    ...parseBalanceSheetDetailFromAllReports(payload, endDate),
    rawPayload: payload,
  };
}
