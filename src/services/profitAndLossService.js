import { fetchProfitAndLoss } from "../lib/quickbooks";
import { normalizeAccountingMethod } from "../lib/report-filters";
import { parseDetailReport, parseSummaryReport } from "../lib/report-parsers";

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

function buildQuery(params = {}) {
  const search = new URLSearchParams(
    Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== ""),
  );
  return search.toString() ? `?${search.toString()}` : "";
}

async function request(path) {
  const clientId = resolveClientIdFromLocation();

  const response = await fetch(`${API_BASE_URL}${path}`, {
    credentials: "include",
    cache: "no-store",
    headers: {
      ...(clientId ? { "X-Client-Id": clientId } : {}),
    },
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.message || payload?.error || `Request failed: ${response.status}`);
  }

  return payload;
}

/**
 * Generates periods for Profit & Loss Comparative Summary.
 * We need:
 * 1. Full Years (e.g., 2022, 2023, 2024)
 * 2. YTD for Current Year (e.g., 2025 YTD)
 * 3. YTD for Previous Year (e.g., 2024 YTD) for comparison
 */
function getPNLComparativePeriods(endDateString) {
  const endDate = endDateString ? new Date(endDateString) : new Date();
  const year = isNaN(endDate.getTime())
    ? new Date().getFullYear()
    : endDate.getFullYear();
  const month = isNaN(endDate.getTime())
    ? new Date().getMonth()
    : endDate.getMonth();
  const day = isNaN(endDate.getTime()) ? new Date().getDate() : endDate.getDate();

  // We'll target 2022, 2023, 2024 as full years,
  // 2025 as YTD (assuming current year is 2025)
  // But let's make it relative to the endDate.

  const currentYear = year;
  const periods = [
    {
      key: "y22",
      label: `FY 2022`,
      start: `2022-01-01`,
      end: `2022-12-31`,
    },
    {
      key: "y23",
      label: `FY 2023`,
      start: `2023-01-01`,
      end: `2023-12-31`,
    },
    {
      key: "y24",
      label: `FY 2024`,
      start: `2024-01-01`,
      end: `2024-12-31`,
    },
    {
      key: "y25",
      label: `FY ${currentYear} YTD`,
      start: `${currentYear}-01-01`,
      end: endDateString,
    },
    {
      key: "y24_ytd",
      label: `FY ${currentYear - 1} YTD`,
      start: `${currentYear - 1}-01-01`,
      end: `${currentYear - 1}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    },
  ];

  return periods;
}

async function fetchSinglePeriodPNL(startDate, endDate, accountingMethod) {
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
  // Use y25 (Current YTD) or the most recent available as the base structure
  const masterIndex = periods.findIndex((p) => p.key === "y25");
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

export async function getProfitAndLoss(startDate, endDate, accountingMethod) {
  // If we are looking for a simple summary (single period), we can still support it,
  // but the ProfitAndLossSummary component now expects a comparative structure.

  const periods = getPNLComparativePeriods(endDate);

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

  const ytdComparison = {
    currentKey: "y25",
    prevKey: "y24_ytd",
    currentLabel: periods.find((p) => p.key === "y25")?.label,
    prevLabel: periods.find((p) => p.key === "y24_ytd")?.label,
  };

  return {
    rows,
    columns: {
      yearCols,
      ytdComparison,
    },
  };
}

export async function getProfitAndLossDetail(
  startDate,
  endDate,
  accountingMethod,
) {
  const payload = await request(
    `/profit-and-loss-detail${buildQuery({
      ...(startDate ? { start_date: startDate } : {}),
      ...(endDate ? { end_date: endDate } : {}),
      ...(accountingMethod
        ? { accounting_method: normalizeAccountingMethod(accountingMethod) }
        : {}),
    })}`,
  );

  return {
    ...parseDetailReport(payload),
    rawPayload: payload,
  };
}

