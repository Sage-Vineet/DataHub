import { fetchProfitAndLoss } from "../lib/quickbooks";
import {
  getManualStagedProfitLossSummary,
  getManualStagedProfitLossMonthlyDetail,
  getLatestManualUploadedReport,
  getAllManualUploadedReports,
  getLatestQMSUploadedReport,
  getAllQMSUploadedReports,
} from "../lib/api";
import { normalizeAccountingMethod } from "../lib/report-filters";
import { parseSummaryReport } from "../lib/report-parsers";
import { fetchQBVendorBreakdown, attachVendorsToRows } from "./qbGlVendorService";


/**
 * Generates periods for Profit & Loss Comparative Summary.
 * We need:
 * 1. Full Years (e.g., 2022, 2023, 2024)
 * 2. YTD for Current Year (e.g., 2025 YTD)
 * 3. YTD for Previous Year (e.g., 2024 YTD) for comparison
 */
function getPNLComparativePeriods(numYears = 4, startYear = null, endYear = null) {
  // User-selected year range: generate one full-year period per year in [startYear, endYear].
  if (startYear && endYear) {
    const periods = [];
    for (let y = Number(startYear); y <= Number(endYear); y++) {
      const now = new Date();
      const isCurrentYear = y === now.getFullYear();
      const endStr = isCurrentYear
        ? `${y}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
        : `${y}-12-31`;
      periods.push({ key: `y${y}`, label: `FY ${y}${isCurrentYear ? " YTD" : ""}`, start: `${y}-01-01`, end: endStr });
    }
    return periods;
  }

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
  options = {},
) {
  try {
    if (sourceMode === "manual_upload" || sourceMode === "quickbooks_manual") {
      const fetchFn = sourceMode === "quickbooks_manual" ? getLatestQMSUploadedReport : getLatestManualUploadedReport;
      const payload = await fetchFn("profit_and_loss", {
        rowId: options?.manualUploadRowId,
      });
      const rows = Array.isArray(payload?.data?.rows) ? payload.data.rows : [];
      const periods = payload?.data?.periods || [];
      if (periods.length > 0 && rows.length > 0) {
        const totalIdx = periods.findIndex((p) => /^total$/i.test(String(p).trim()));
        const getValue = (colAmounts) => {
          if (!Array.isArray(colAmounts) || colAmounts.length === 0) return 0;
          return totalIdx >= 0
            ? (colAmounts[totalIdx] || 0)
            : colAmounts.reduce((s, v) => s + (v || 0), 0);
        };
        const sumNode = (node) => ({
          ...node,
          amount: getValue(node.colAmounts) || (node.amount || 0),
          children: node.children ? node.children.map(sumNode) : undefined,
        });
        return rows.map(sumNode);
      }
      return rows;
    }

    if (sourceMode === "manual") {
      const params = {
        ...(startDate ? { startDate } : {}),
        ...(endDate ? { endDate } : {}),
        ...((options?.manualFilters && typeof options.manualFilters === "object")
          ? options.manualFilters
          : {}),
      };
      const payload = await getManualStagedProfitLossSummary({ params });
      return payload;
    }

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

// Maps well-known P&L section label variants to a single canonical key so that
// files using different naming conventions (e.g. "Revenue" vs "Income",
// "Cost of Sales" vs "Cost of Goods Sold") merge into the same row.
const PNL_SECTION_SYNONYMS = {
  "revenue": "income",
  "revenues": "income",
  "ordinary income": "income",
  "ordinary income expense": "income",
  "cost of sales": "cost of goods sold",
  "cost of goods sold cost of sales": "cost of goods sold",
  "other income expense": "other income",
  "other income and expense": "other income",
  "other income other expense": "other income",
  "operating expenses": "expenses",
  "expense": "expenses",
};

function normalizeKey(name) {
  const basic = normalizeName(name);
  return PNL_SECTION_SYNONYMS[basic] || basic;
}

// Account name patterns (normalized) that belong in "Other Income", not operating "Income".
const OTHER_INCOME_PATTERNS = [
  "interest income",
  "interest earned",
  "interest revenue",
  "dividend income",
  "other interest income",
];

// Top-level calculated rows that must decrease when operating Income decreases.
// "Net Income" is intentionally excluded — it stays the same once Other Income is added.
const INCOME_DEPENDENT_ROWS = new Set([
  "gross profit",
  "net ordinary income",
  "net operating income",
]);

function isOtherIncomeItem(name) {
  const n = normalizeName(name);
  return OTHER_INCOME_PATTERNS.some(p => n === p || n.includes(p));
}

/**
 * Moves accounts like "Interest Income" out of the operating "Income" section
 * into a separate "Other Income" section, adjusting Gross Profit and
 * Net Operating Income accordingly.  Safe to call on any row tree —
 * no-op if nothing matches.
 */
function reclassifyOtherIncome(rows) {
  if (!Array.isArray(rows) || !rows.length) return rows;

  const incomeIdx = rows.findIndex(r => normalizeKey(r.name) === "income");
  if (incomeIdx === -1) return rows;

  const incomeSection = rows[incomeIdx];
  const children = incomeSection.children || [];

  const toMove = children.filter(
    c => c.type !== "total" && c.type !== "header" && isOtherIncomeItem(c.name),
  );
  if (!toMove.length) return rows;

  const isMultiCol = toMove.some(item => item.amounts && typeof item.amounts === "object");

  let deltaScalar = 0;
  let deltaMap = null;

  if (isMultiCol) {
    deltaMap = {};
    for (const item of toMove) {
      if (item.amounts) {
        for (const [k, v] of Object.entries(item.amounts)) {
          deltaMap[k] = (deltaMap[k] || 0) + (Number(v) || 0);
        }
      }
    }
    deltaScalar = Object.values(deltaMap).reduce((s, v) => s + v, 0);
  } else {
    deltaScalar = toMove.reduce((s, item) => s + (Number(item.amount) || 0), 0);
  }

  if (!deltaScalar) return rows;

  function applyDelta(node, sign) {
    if (isMultiCol && deltaMap) {
      const newAmounts = {};
      const base = node.amounts || {};
      for (const k of new Set([...Object.keys(base), ...Object.keys(deltaMap)])) {
        newAmounts[k] = (Number(base[k]) || 0) + sign * (deltaMap[k] || 0);
      }
      return { ...node, amount: (Number(node.amount) || 0) + sign * deltaScalar, amounts: newAmounts };
    }
    return { ...node, amount: (Number(node.amount) || 0) + sign * deltaScalar };
  }

  const sub = node => applyDelta(node, -1);
  const add = node => applyDelta(node, +1);

  // Remove moved items from Income, adjust its total children and section total.
  const updatedIncomeChildren = children
    .filter(c => !toMove.includes(c))
    .map(c => (c.type === "total" ? sub(c) : c));
  const updatedIncomeSection = sub({ ...incomeSection, children: updatedIncomeChildren });

  // Update top-level rows.
  let newRows = rows.map((row, idx) => {
    if (idx === incomeIdx) return updatedIncomeSection;
    if (INCOME_DEPENDENT_ROWS.has(normalizeName(row.name))) return sub(row);
    return row;
  });

  const movedFields = isMultiCol && deltaMap
    ? { amount: deltaScalar, amounts: { ...deltaMap } }
    : { amount: deltaScalar };

  const otherIncomeIdx = newRows.findIndex(r => normalizeKey(r.name) === "other income");

  if (otherIncomeIdx !== -1) {
    const existing = newRows[otherIncomeIdx];
    const existingChildren = existing.children || [];
    const newChildren = [
      ...existingChildren.filter(c => c.type !== "total"),
      ...toMove,
      ...existingChildren.filter(c => c.type === "total").map(add),
    ];
    newRows[otherIncomeIdx] = add({ ...existing, children: newChildren });
  } else {
    const totalRow = { id: "oi-total", name: "Total Other Income", type: "total", ...movedFields };
    const otherIncomeSection = {
      id: "oi-section",
      name: "Other Income",
      type: "header",
      ...movedFields,
      children: [...toMove, totalRow],
    };
    const netIncomeIdx = newRows.findIndex(r => normalizeName(r.name) === "net income");
    if (netIncomeIdx !== -1) {
      newRows = [...newRows.slice(0, netIncomeIdx), otherIncomeSection, ...newRows.slice(netIncomeIdx)];
    } else {
      newRows.push(otherIncomeSection);
    }
  }

  return newRows;
}

// Union-merges tree nodes from N files into one tree.
// Every row that exists in ANY file appears in the output.
// amounts[fileKey] = value from that file (0 if not present).
function mergeFileNodes(nodeArraysByFile, fileKeys) {
  const orderedKeys = [];
  const nodeMap = new Map();

  nodeArraysByFile.forEach((nodes, fileIdx) => {
    (nodes || []).forEach((node) => {
      const normKey = normalizeKey(node.name);
      if (!normKey) return;
      if (!nodeMap.has(normKey)) {
        orderedKeys.push(normKey);
        nodeMap.set(normKey, {
          name: node.name,
          type: node.type,
          id: node.id,
          amounts: {},
          childrenByFile: nodeArraysByFile.map(() => []),
        });
      }
      const merged = nodeMap.get(normKey);
      merged.amounts[fileKeys[fileIdx]] = node.amount || 0;
      // Only update children if the new node has at least as many children as the existing entry.
      // This prevents a "Total X" row (no children) from overwriting the "X" section header's
      // children when both normalize to the same key.
      const newChildren = node.children || [];
      if (newChildren.length >= merged.childrenByFile[fileIdx].length) {
        merged.childrenByFile[fileIdx] = newChildren;
      }
      // Use the name/type from the header occurrence when possible
      if (merged.type !== "header" && node.type === "header") {
        merged.name = node.name;
        merged.type = node.type;
      }
    });
  });

  return orderedKeys.map((normKey) => {
    const merged = nodeMap.get(normKey);
    const mergedChildren = mergeFileNodes(merged.childrenByFile, fileKeys);
    return {
      id: merged.id,
      name: merged.name,
      type: merged.type,
      amounts: merged.amounts,
      children: mergedChildren.length ? mergedChildren : undefined,
    };
  });
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
  if ((options?.sourceMode || "quickbooks") === "manual") {
    // Only pass manual filters (fiscal year, batch, etc.) — QB date params not used
    const params = {
      ...((options?.manualFilters && typeof options.manualFilters === "object")
        ? options.manualFilters
        : {}),
    };
    return getManualStagedProfitLossSummary({ params });
  }

  // Summary now uses user-selected filters (QuickBooks-style Summary report)
  const rows = await fetchSinglePeriodPNL(
    startDate,
    endDate,
    accountingMethod,
    options?.sourceMode || "quickbooks",
    options,
  );
  return reclassifyOtherIncome(rows);
}

function pnlFileYear(file) {
  if (file?.data?.asOfDate) {
    const y = parseInt(file.data.asOfDate.split("-")[0], 10);
    if (y >= 2000) return y;
  }
  const m = (file?.fileName || "").match(/\b(20\d{2})\b/);
  return m ? parseInt(m[1], 10) : 0;
}

// Expand 2-digit stored labels like "Jan 25" → "Jan 2025" for already-stored DB records.
function expandPeriodLabel(label) {
  const m = String(label || "").match(/^([A-Za-z]+)\s+(\d{2})$/);
  return m ? `${m[1]} 20${m[2]}` : label;
}

function pnlFileLabel(file) {
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const dateStr = file?.data?.asOfDate || file?.data?.periodEnd;
  if (dateStr) {
    const parts = String(dateStr).split("-");
    if (parts.length >= 2) {
      const year = parseInt(parts[0], 10);
      const month = parseInt(parts[1], 10) - 1;
      if (year >= 2000 && month >= 0 && month <= 11) {
        return `${monthNames[month]} ${year}`;
      }
    }
  }
  const y = pnlFileYear(file);
  return y ? `FY ${y}` : "Unknown";
}

function buildPNLFromPeriodColumns(sortedFiles) {
  const allCols = [];
  const filePeriodInfo = sortedFiles.map((file) => {
    const periods = file.data?.periods || [];
    const startIdx = allCols.length;

    if (periods.length > 0) {
      // File has monthly columns — expand one column per period
      periods.forEach((label, i) => allCols.push({ key: `p${startIdx + i}`, label: expandPeriodLabel(label) }));
      const nameMap = new Map();
      const visit = (items) => {
        if (!Array.isArray(items)) return;
        items.forEach((item) => {
          const key = normalizeKey(item.name);
          if (key && item.colAmounts) nameMap.set(key, item.colAmounts);
          if (item.children) visit(item.children);
        });
      };
      visit(file.data.rows);
      return { startIdx, count: periods.length, nameMap, singleCol: false };
    } else {
      // File has no monthly periods — add as a single summary column
      const colKey = `p${startIdx}`;
      allCols.push({ key: colKey, label: pnlFileLabel(file) });
      const nameMap = new Map();
      const visit = (items) => {
        if (!Array.isArray(items)) return;
        items.forEach((item) => {
          const key = normalizeKey(item.name);
          if (key) nameMap.set(key, item.amount || 0);
          if (item.children) visit(item.children);
        });
      };
      visit(file.data.rows);
      return { startIdx, count: 1, nameMap, singleCol: true };
    }
  });

  if (!allCols.length) return { rows: [], columns: { yearCols: [], ytdComparison: null } };

  // Union merge for structure, then fill in period amounts
  const unionStructure = mergeFileNodes(
    sortedFiles.map((f) => f.data.rows),
    sortedFiles.map((_, i) => `_s${i}`),
  );

  const enrich = (nodes) =>
    nodes.map((node) => {
      const normKey = normalizeKey(node.name);
      const amounts = {};
      filePeriodInfo.forEach(({ startIdx, count, nameMap, singleCol }) => {
        if (singleCol) {
          amounts[`p${startIdx}`] = nameMap.get(normKey) || 0;
        } else {
          const colAmounts = nameMap.get(normKey) || [];
          for (let i = 0; i < count; i++) {
            amounts[`p${startIdx + i}`] = colAmounts[i] || 0;
          }
        }
      });
      return {
        ...node,
        amounts,
        children: node.children ? enrich(node.children) : undefined,
      };
    });

  return {
    rows: reclassifyOtherIncome(enrich(unionStructure)),
    columns: { yearCols: allCols, ytdComparison: null },
  };
}

// Collapse a node's per-period colAmounts to a single annual value so that
// files with monthly columns can appear as one "FY YYYY" column in Year mode.
function collapseNodeToAnnual(node, periods) {
  const totalIdx = Array.isArray(periods)
    ? periods.findIndex((p) => /^total$/i.test(String(p).trim()))
    : -1;
  const amount =
    node.amount != null && node.amount !== 0
      ? node.amount
      : Array.isArray(node.colAmounts) && node.colAmounts.length
        ? totalIdx >= 0
          ? (node.colAmounts[totalIdx] || 0)
          : node.colAmounts.reduce((s, v) => s + (Number(v) || 0), 0)
        : 0;
  return {
    ...node,
    amount,
    children: node.children
      ? node.children.map((c) => collapseNodeToAnnual(c, periods))
      : undefined,
  };
}

async function buildPNLMultiFileDetail(sourceMode = "manual_upload", options = {}) {
  const fetchFn = sourceMode === "quickbooks_manual" ? getAllQMSUploadedReports : getAllManualUploadedReports;
  const result = await fetchFn("profit_and_loss");
  let files = (result?.files || []).filter((f) => f.data?.rows?.length);

  // Year range filtering
  const { startYear, endYear, yearMode } = options;
  if (startYear || endYear) {
    files = files.filter((f) => {
      const y = pnlFileYear(f);
      if (!y) return true;
      if (startYear && y < Number(startYear)) return false;
      if (endYear && y > Number(endYear)) return false;
      return true;
    });
  }

  if (!files.length) return { rows: [], columns: { yearCols: [], ytdComparison: null } };

  // Sort files oldest → newest
  const sortedFiles = [...files].sort((a, b) => {
    const ya = pnlFileYear(a) || 9999;
    const yb = pnlFileYear(b) || 9999;
    if (ya !== yb) return ya - yb;
    return new Date(a.updatedAt || 0) - new Date(b.updatedAt || 0);
  });

  // yearMode: one "FY YYYY" column per file — skip period expansion.
  // Otherwise: if any file has monthly columns, expand them all.
  if (!yearMode && sortedFiles.some((f) => f.data?.periods?.length > 0)) {
    return buildPNLFromPeriodColumns(sortedFiles);
  }

  // One column per file — collapse monthly colAmounts to annual totals when yearMode.
  const filePeriods = sortedFiles.map((f, i) => {
    const year = pnlFileYear(f);
    const rows = yearMode && f.data?.periods?.length
      ? (f.data.rows || []).map((r) => collapseNodeToAnnual(r, f.data.periods))
      : (f.data.rows || []);
    return {
      key: `f${i}`,
      label: year ? `FY ${year}` : pnlFileLabel(f),
      rows,
    };
  });

  const mergedRows = mergeFileNodes(
    filePeriods.map((p) => p.rows),
    filePeriods.map((p) => p.key),
  );

  const yearCols = filePeriods.map((p) => ({ key: p.key, label: p.label }));

  return {
    rows: reclassifyOtherIncome(mergedRows),
    columns: { yearCols, ytdComparison: null },
  };
}

export async function getProfitAndLossDetail(
  _startDate,
  _endDate,
  accountingMethod,
  options = {},
) {
  if ((options?.sourceMode || "quickbooks") === "manual") {
    // Only pass manual filters — QB date params not used for staged GL data
    const params = {
      ...((options?.manualFilters && typeof options.manualFilters === "object")
        ? options.manualFilters
        : {}),
    };

    console.log("[DetailedReportUI][P&L] Requesting monthly detail with params:", JSON.stringify(params));
    const response = await getManualStagedProfitLossMonthlyDetail({ params });
    console.log("[DetailedReportUI][P&L] Received keys:", Object.keys(response || {}), "| source:", response?.source, "| reportType:", response?.reportType, "| months:", response?.months);
    if (!Array.isArray(response?.sections) || response.sections.length === 0) {
      console.warn("[DetailedReportUI][P&L] WARNING: sections is empty — check fiscal year filter and staged data.");
    }
    return response;
  }

  if (options?.sourceMode === "manual_upload" || options?.sourceMode === "quickbooks_manual") {
    return buildPNLMultiFileDetail(options.sourceMode, {
      startYear: options.startYear,
      endYear: options.endYear,
      yearMode: options.yearMode,
    });
  }

  // Detail now uses system-defined multi-year comparison (EBITDA analysis).
  // When a year range is provided (Year mode), generate periods only for that range.
  const periods = getPNLComparativePeriods(4, options.startYear || null, options.endYear || null);

  // yearCols are the non-YTD periods shown as main columns.
  const mainPeriods = periods.filter((p) => !p.key.includes("_ytd"));
  const glStartDate = mainPeriods[0]?.start;
  const glEndDate = mainPeriods[mainPeriods.length - 1]?.end;

  // Fetch period P&L snapshots and QB GL vendor data concurrently.
  const [results, vendorMap] = await Promise.all([
    Promise.all(
      periods.map((p) =>
        fetchSinglePeriodPNL(
          p.start,
          p.end,
          accountingMethod,
          options?.sourceMode || "quickbooks",
          options,
        ),
      ),
    ),
    fetchQBVendorBreakdown(glStartDate, glEndDate, accountingMethod, mainPeriods).catch(() => ({})),
  ]);

  const mergedRows = reclassifyOtherIncome(mergePNLPeriods(results, periods));
  const yearColKeys = mainPeriods.map((p) => p.key);
  const rows = attachVendorsToRows(mergedRows, vendorMap, yearColKeys);

  const yearCols = mainPeriods.map((p) => ({ key: p.key, label: p.label }));

  const currentYearKey = mainPeriods[mainPeriods.length - 1]?.key;
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

