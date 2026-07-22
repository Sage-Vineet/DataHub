import { fetchBalanceSheet } from "../lib/quickbooks";
import {
  getManualGlBalanceSheet,
  getManualStagedBalanceSheetMonthlyDetail,
  getLatestManualUploadedReport,
  getAllManualUploadedReports,
  getLatestQMSUploadedReport,
  getAllQMSUploadedReports,
  getKeyReportVersionReport,
} from "../lib/api";
import { normalizeAccountingMethod } from "../lib/report-filters";
import {
  parseSummaryReport,
} from "../lib/report-parsers";
import { fetchQBVendorBreakdown, attachVendorsToRows } from "./qbGlVendorService";

function toAmount(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value !== "string") return 0;

  const parsed = Number(String(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeLineItems(items = [], prefix = "line") {
  if (!Array.isArray(items)) return [];

  return items
    .map((item, index) => {
      const name = String(item?.name || item?.account || "").trim();
      if (!name) return null;
      const amount = toAmount(item?.amount ?? item?.balance ?? item?.value);
      return {
        id: String(item?.id || `${prefix}-${index + 1}`),
        name,
        amount,
        type: "data",
      };
    })
    .filter(Boolean);
}

function buildSectionNode({
  id,
  name,
  items = [],
  totalLabel,
  totalAmount = 0,
}) {
  const totalRow = {
    id: `${id}-total`,
    name: totalLabel || `Total ${name}`,
    amount: totalAmount,
    type: "total",
  };

  return {
    id,
    name,
    amount: totalAmount,
    type: "header",
    children: [...items, totalRow],
  };
}

function parseFlatBalanceSheetReport(payload = {}) {
  if (!payload || typeof payload !== "object") return [];

  const assetsItems = normalizeLineItems(payload.assets, "asset");
  const liabilitiesItems = normalizeLineItems(payload.liabilities, "liability");
  const equityItems = normalizeLineItems(payload.equity, "equity");

  if (!assetsItems.length && !liabilitiesItems.length && !equityItems.length) {
    return [];
  }

  const totalAssets =
    toAmount(payload.totalAssets) ||
    assetsItems.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const totalLiabilities =
    toAmount(payload.totalLiabilities) ||
    liabilitiesItems.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const totalEquity =
    toAmount(payload.totalEquity) ||
    equityItems.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const totalLiabilitiesAndEquity = totalLiabilities + totalEquity;

  const liabilitiesSection = buildSectionNode({
    id: "liabilities",
    name: "Liabilities",
    items: liabilitiesItems,
    totalLabel: "Total Liabilities",
    totalAmount: totalLiabilities,
  });

  const equitySection = buildSectionNode({
    id: "equity",
    name: "Equity",
    items: equityItems,
    totalLabel: "Total Equity",
    totalAmount: totalEquity,
  });

  return [
    buildSectionNode({
      id: "assets",
      name: "Assets",
      items: assetsItems,
      totalLabel: "Total Assets",
      totalAmount: totalAssets,
    }),
    {
      id: "liabilities-and-equity",
      name: "Liabilities and Equity",
      amount: totalLiabilitiesAndEquity,
      type: "header",
      children: [
        liabilitiesSection,
        equitySection,
        {
          id: "liabilities-and-equity-total",
          name: "Total Liabilities and Equity",
          amount: totalLiabilitiesAndEquity,
          type: "total",
        },
      ],
    },
  ];
}

function parseUnifiedBalanceSheetRows(responsePayload = {}) {
  const primary = responsePayload?.data;
  const quickbooksFallback = responsePayload?.quickbooksSchema;

  if (primary?.Rows?.Row || primary?.data?.Rows?.Row) {
    return parseSummaryReport(primary);
  }

  if (quickbooksFallback?.Rows?.Row || quickbooksFallback?.data?.Rows?.Row) {
    return parseSummaryReport(quickbooksFallback);
  }

  return parseFlatBalanceSheetReport(primary);
}

function resolveSourceLabel(source) {
  if (source === "MANUAL_UPLOAD") return "Manual Balance Sheet";
  if (source === "MANUAL_STAGED") return "Manual Staged Balance Sheet";
  if (source === "GENERATED_FROM_GL") return "Generated from GL";
  if (source === "GENERATED_FROM_QB") return "Generated from QuickBooks";
  if (source === "live") return "QuickBooks Online";
  if (source === "cache") return "QuickBooks Cache";
  return null;
}


/**
 * Generates dynamic comparative periods based on a specific end date.
 * Plus an additional period for the previous month to calculate monthly delta.
 */
function getComparativePeriods(numYears = 4, startYear = null, endYear = null) {
  // User-selected year range: one period per year, no monthly delta.
  if (startYear && endYear) {
    const now = new Date();
    const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const periods = [];
    let idx = 1;
    for (let y = Number(startYear); y <= Number(endYear); y++) {
      const isCurrentYear = y === now.getFullYear();
      const endDate = isCurrentYear
        ? `${y}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`
        : `${y}-12-31`;
      const label = isCurrentYear
        ? `${monthNames[now.getMonth()]} ${String(y).slice(-2)}`
        : `Dec ${String(y).slice(-2)}`;
      periods.push({ year: y, key: `y${idx++}`, label, startDate: `${y}-01-01`, endDate, type: "yearly" });
    }
    return periods;
  }

  let date = new Date();

  const currentYear = date.getFullYear();
  const currentMonth = date.getMonth();
  const periods = [];

  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const targetDay = date.getDate();

  // 1. Yearly snapshots
  for (let i = numYears - 1; i >= 0; i--) {
    const year = currentYear - i;
    const isCurrentYear = i === 0;

    let startDate, endDate, label;

    if (isCurrentYear) {
      startDate = `${year}-01-01`;
      endDate = `${year}-${String(currentMonth + 1).padStart(2, "0")}-${String(targetDay).padStart(2, "0")}`;
      const capitalizedMonth = monthNames[currentMonth];
      label = `${capitalizedMonth} ${String(year).slice(-2)}`;
    } else {
      startDate = `${year}-01-01`;
      endDate = `${year}-12-31`;
      label = `Dec ${String(year).slice(-2)}`;
    }

    const index = (numYears - 1) - i + 1;
    periods.push({
      year,
      key: `y${index}`,
      label: label,
      startDate,
      endDate,
      type: 'yearly'
    });
  }


  // 2. Previous Month snapshot (for monthly delta)
  const prevMonthDate = new Date(date);
  prevMonthDate.setMonth(date.getMonth() - 1);
  const pmYear = prevMonthDate.getFullYear();
  const pmMonth = prevMonthDate.getMonth();
  const pmLastDay = new Date(pmYear, pmMonth + 1, 0).getDate();
  const pmEndDate = `${pmYear}-${String(pmMonth + 1).padStart(2, "0")}-${String(pmLastDay).padStart(2, "0")}`;
  const pmStartDate = `${pmYear}-01-01`;

  periods.push({
    key: 'pm',
    label: 'PROV_MONTH',
    startDate: pmStartDate,
    endDate: pmEndDate,
    type: 'comparison'
  });

  return periods;
}

async function fetchSinglePeriodBS(
  startDate,
  endDate,
  accountingMethod,
  sourceMode = "quickbooks",
  options = {},
) {
  const normalizedAccountingMethod = normalizeAccountingMethod(accountingMethod);
  const keyReportVersionId = options?.keyReportVersionId || null;

  try {
    if (sourceMode === "manual_upload") {
      const response = await getLatestManualUploadedReport("balance_sheet", {
        rowId: options?.manualUploadRowId,
        keyReportVersionId,
      });
      return Array.isArray(response?.data?.rows) ? response.data.rows : [];
    }

    if (sourceMode === "manual") {
      const manualFilters =
        options?.manualFilters && typeof options.manualFilters === "object"
          ? options.manualFilters
          : {};
      const response = await getManualGlBalanceSheet({
        params: { ...manualFilters, ...(keyReportVersionId ? { keyReportVersionId } : {}) },
      });

      return parseUnifiedBalanceSheetRows(response);
    }

    const payload = await fetchBalanceSheet({
      ...(startDate ? { start_date: startDate } : {}),
      ...(endDate ? { end_date: endDate } : {}),
      ...(normalizedAccountingMethod
        ? { accounting_method: normalizedAccountingMethod }
        : {}),
    });
    return parseSummaryReport(payload);
  } catch (err) {
    console.warn(
      `⚠️ Failed to fetch Balance Sheet for ${startDate} - ${endDate}:`,
      err.message,
    );
    return [];
  }
}

function convertStagedBsPayloadToRows(response) {
  if (Array.isArray(response?.hierarchicalRows) && response.hierarchicalRows.length > 0) {
    return response.hierarchicalRows;
  }

  if (!response?.sections) return [];
  const years = Array.isArray(response.years) ? response.years : [];
  const year = Number(response?.displayYear) || (years.length > 0 ? years[years.length - 1] : null);
  const sections = response.sections;
  const rows = [];

  ["Assets", "Liabilities", "Equity"].forEach((sectionKey) => {
    const section = sections[sectionKey];
    if (!section) return;
    const sectionTotal = year !== null ? (section.totalByYear?.[year] ?? 0) : 0;
    const sectionChildren = [];

    (section.categories || []).forEach((cat) => {
      const catTotal = year !== null ? (cat.totalByYear?.[year] ?? 0) : 0;
      const catChildren = (cat.accounts || []).map((acc, idx) => ({
        id: `acc-${sectionKey}-${cat.label}-${idx}`,
        name: acc.name || acc.accountName || "",
        amount: year !== null ? (acc.balancesByYear?.[year] ?? 0) : 0,
        type: "data",
      }));
      catChildren.push({
        id: `total-cat-${sectionKey}-${cat.label}`,
        name: `Total ${cat.label}`,
        amount: catTotal,
        type: "total",
      });
      sectionChildren.push({
        id: `cat-${sectionKey}-${cat.label}`,
        name: cat.label,
        amount: catTotal,
        type: "header",
        children: catChildren,
      });
    });

    sectionChildren.push({
      id: `total-section-${sectionKey}`,
      name: `Total ${section.label || sectionKey}`,
      amount: sectionTotal,
      type: "total",
    });

    rows.push({
      id: sectionKey.toLowerCase(),
      name: section.label || sectionKey,
      amount: sectionTotal,
      type: "header",
      children: sectionChildren,
    });
  });

  const liabTotal = year !== null ? (sections.Liabilities?.totalByYear?.[year] ?? 0) : 0;
  const eqTotal = year !== null ? (sections.Equity?.totalByYear?.[year] ?? 0) : 0;
  rows.push({
    id: "total-le",
    name: "Total Liabilities and Equity",
    amount: liabTotal + eqTotal,
    type: "total",
  });

  return rows;
}

// ─── Exported Services ──────────────────────────────────────────────────────

export async function getBalanceSheet(startDate, endDate, accountingMethod, options = {}) {
  const normalizedAccountingMethod = normalizeAccountingMethod(accountingMethod);
  const sourceMode = options?.sourceMode || "manual";
  const keyReportVersionId = options?.keyReportVersionId || null;

  // Key Reports: read ONLY from balance_sheet_entries — never from Manual GL staging,
  // active batches, or snapshots. keyReportVersionId always wins regardless of sourceMode.
  if (keyReportVersionId) {
    try {
      const manualFilters = options?.manualFilters || {};
      const singleYear = /^\d{4}$/.test(String(manualFilters.fiscalYear ?? "")) ? manualFilters.fiscalYear : null;
      const response = await getKeyReportVersionReport(keyReportVersionId, "balance-sheet", {
        // Summary tab = annual ("Year") view → fiscal-year columns (spec #10).
        // Only the user's explicit date pickers (fromDate/toDate) drive which
        // years render (spec #11–#13); with none set, ALL synced years show.
        year: singleYear,
        startDate: manualFilters.fromDate || null,
        endDate: manualFilters.toDate || null,
        period: "year",
      });
      const rows = response?.hierarchicalRows || response?.rows || [];
      console.log("[KeyReports][BS][Summary] Loaded", rows.length, "rows from balance_sheet_entries for version", keyReportVersionId);
      return {
        rows,
        yearCols: response?.yearCols,
        columns: response?.columns,
        source: response?.source || "key_reports_entry_tables",
        sourceLabel: "Key Reports",
        asOfDate: response?.asOfDate || null,
        noDataText: rows.length > 0 ? null : "No Balance Sheet data in Key Reports. Run Sync first.",
        reStageRequired: false,
        reStageWarning: null,
      };
    } catch (err) {
      console.warn("[KeyReports][BS][Summary] Entry table fetch failed:", err.message);
      return {
        rows: [],
        source: "key_reports_entry_tables",
        sourceLabel: "Key Reports",
        asOfDate: null,
        noDataText: "Key Reports Balance Sheet data unavailable.",
      };
    }
  }

  if (sourceMode === "quickbooks") {
    try {
      const payload = await fetchBalanceSheet({
        ...(startDate ? { start_date: startDate } : {}),
        ...(endDate ? { end_date: endDate, as_of_date: endDate } : {}),
        ...(normalizedAccountingMethod
          ? { accounting_method: normalizedAccountingMethod }
          : {}),
      });

      const rows = parseUnifiedBalanceSheetRows(payload);
      const source = payload?.source || "GENERATED_FROM_QB";
      return {
        rows,
        source,
        sourceLabel: resolveSourceLabel(source),
        asOfDate: payload?.asOfDate || payload?.data?.Header?.EndPeriod || endDate || null,
        noDataText: rows.length > 0 ? null : "No Balance Sheet Available",
      };
    } catch (error) {
      console.warn("QuickBooks Balance Sheet fetch failed:", error.message);
      return {
        rows: [],
        source: null,
        sourceLabel: null,
        asOfDate: endDate || null,
        noDataText: "No Balance Sheet Available",
      };
    }
  }

  if (sourceMode === "manual_upload" || sourceMode === "quickbooks_manual") {
    const isQMS = sourceMode === "quickbooks_manual";
    try {
      const fetchFn = isQMS ? getLatestQMSUploadedReport : getLatestManualUploadedReport;
      const response = await fetchFn("balance_sheet", {
        rowId: options?.manualUploadRowId,
        keyReportVersionId,
      });
      const rows = Array.isArray(response?.data?.rows) ? response.data.rows : [];
      const periods = response?.data?.periods || [];
      const totalIdx = periods.length > 0
        ? periods.findIndex((p) => /^total$/i.test(String(p).trim()))
        : -1;
      const getValue = (colAmounts) => {
        if (!Array.isArray(colAmounts) || colAmounts.length === 0) return 0;
        return totalIdx >= 0
          ? (colAmounts[totalIdx] || 0)
          : colAmounts.reduce((s, v) => s + (v || 0), 0);
      };
      const summaryRows = periods.length > 0 && rows.length > 0
        ? rows.map(function sumNode(node) {
          return {
            ...node,
            amount: getValue(node.colAmounts) || (node.amount || 0),
            children: node.children ? node.children.map(sumNode) : undefined,
          };
        })
        : rows;
      return {
        rows: summaryRows,
        source: isQMS ? "QUICKBOOKS_MANUAL" : "MANUAL_UPLOAD_EXCEL_PDF",
        sourceLabel: isQMS ? "QuickBooks Manual" : "Manual Upload (Excel or PDF)",
        asOfDate: response?.data?.asOfDate || endDate || null,
        noDataText: rows.length > 0 ? null : "No Balance Sheet Available",
      };
    } catch (error) {
      console.warn(`${isQMS ? "QMS" : "Manual uploaded"} Balance Sheet fetch failed:`, error.message);
      return {
        rows: [],
        source: null,
        sourceLabel: null,
        asOfDate: endDate || null,
        noDataText: "No Balance Sheet Available",
      };
    }
  }

  const manualFilters =
    options?.manualFilters && typeof options.manualFilters === "object"
      ? options.manualFilters
      : {};

  if (keyReportVersionId) {
    manualFilters.keyReportVersionId = keyReportVersionId;
  }

  try {
    // For manual staged data, fiscal year (in manualFilters) controls filtering.
    // QB date params (start_date, end_date, as_of_date, accounting_method) must NOT
    // be sent — they have no meaning for staged GL data and would pollute sub-queries.
    const response = await getManualGlBalanceSheet({
      params: { ...manualFilters },
    });

    // Prefer pre-built hierarchicalRows from the backend. If absent, reconstruct
    // from sections. Fall back to QB-format parser only for non-staged responses.
    // NOTE: backend returns source="manual_gl_staged_transactions" (not "manual_staged"),
    // so we detect staged format by structure (hierarchicalRows/sections) rather than source string.
    let rows;
    if (Array.isArray(response?.hierarchicalRows) && response.hierarchicalRows.length > 0) {
      rows = response.hierarchicalRows;
      console.log("[ManualGL][BS][UI] Using hierarchicalRows from API:", rows.length, "top-level nodes");
    } else if (response?.sections) {
      rows = convertStagedBsPayloadToRows(response);
      console.log("[ManualGL][BS][UI] Built rows from sections, count:", rows.length);
    } else {
      rows = parseUnifiedBalanceSheetRows(response);
      console.log("[ManualGL][BS][UI] Fell back to QB parser, rows:", rows.length);
    }
    const source = response?.source || null;

    console.log("[ManualGL][BS][UI] API response source:", source, "| years:", response?.years, "| audit:", response?.audit);

    if (rows.length > 0 || source) {
      return {
        rows,
        // Per-year comparative columns (present only when multiple fiscal years
        // are selected); passed through to the renderer via BalanceSheetReport.
        yearCols: Array.isArray(response?.yearCols) ? response.yearCols : undefined,
        source,
        sourceLabel: resolveSourceLabel(source),
        asOfDate: response?.asOfDate || endDate || null,
        noDataText: rows.length > 0 ? null : "No Balance Sheet Available",
        reStageRequired: response?.reStageRequired || false,
        reStageWarning: response?.reStageWarning || null,
      };
    }
  } catch (error) {
    console.warn("Manual staged Balance Sheet fetch failed:", error.message);
  }

  return {
    rows: [],
    source: "MANUAL_STAGED",
    sourceLabel: resolveSourceLabel("MANUAL_STAGED"),
    asOfDate: endDate || null,
    noDataText: "No Balance Sheet Available",
  };
}

function normalizeName(name) {
  if (!name) return "";
  let norm = String(name).toLowerCase();

  // Handle colon-delimited names (Account: Subaccount)
  if (norm.includes(":")) {
    const parts = norm.split(":");
    norm = parts[parts.length - 1];
  }

  return norm
    .replace(/^total\s+/i, "") // Remove leading "Total "
    .replace(/^account:\s*/i, "") // Remove "Account: "
    .replace(/\s*\(\d+\)$/, "") // Remove trailing account numbers like (1001)
    .replace(/[^a-z0-9]+/g, " ") // Replace non-alphanumeric with spaces
    .replace(/\s+/g, " ") // Collapse multiple spaces
    .trim();
}

const BS_SECTION_SYNONYMS = {
  "stockholders equity": "equity",
  "stockholder s equity": "equity",
  "owners equity": "equity",
  "owner s equity": "equity",
  "shareholders equity": "equity",
  "shareholder s equity": "equity",
  "members equity": "equity",
};

function normalizeKey(name) {
  const basic = normalizeName(name);
  return BS_SECTION_SYNONYMS[basic] || basic;
}

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
      const newChildren = node.children || [];
      if (newChildren.length >= merged.childrenByFile[fileIdx].length) {
        merged.childrenByFile[fileIdx] = newChildren;
      }
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

function mergePeriods(periodResults, periods) {
  // Use last period as the "current" key for monthlyChange calculation.
  // Works for both yearly (y1/y2…) and monthly (m2025_10…) period sets.
  const currentYearKey = periods[periods.length - 1]?.key || "y1";

  // Build a union tree from ALL period results so accounts omitted by QB from
  // some snapshots (zero balance) still appear with 0 in those periods.
  function mergeInto(dest, src) {
    for (const srcNode of (src || [])) {
      const norm = normalizeName(srcNode.name);
      if (!norm) continue;
      const existing = dest.find(n => normalizeName(n.name) === norm);
      if (existing) {
        if (srcNode.children?.length) {
          if (!existing.children) existing.children = [];
          mergeInto(existing.children, srcNode.children);
        }
      } else {
        dest.push({ ...srcNode, children: srcNode.children ? srcNode.children.map(c => ({ ...c })) : undefined });
      }
    }
  }

  const masterRows = [];
  for (const rows of periodResults) {
    mergeInto(masterRows, rows || []);
  }

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

  const enrich = (node) => {
    const amounts = {};
    const normName = normalizeName(node.name);

    periods.forEach((period, i) => {
      amounts[period.key] = periodMaps[i].get(normName) || 0;
    });

    const currentVal = amounts[currentYearKey] || 0;
    const prevMonthVal = amounts.pm || 0;
    amounts.monthlyChange = currentVal - prevMonthVal;

    return {
      ...node,
      amounts,
      children: Array.isArray(node.children) ? node.children.map(enrich) : undefined
    };
  };

  function restructureGAAPTree(tree) {
    function extractAllNodes(nodes, nameTargets, collected = []) {
      if (!nodes) return collected;
      for (let i = nodes.length - 1; i >= 0; i--) {
        const norm = normalizeName(nodes[i].name);
        if (nameTargets.includes(norm)) {
          collected.push(nodes.splice(i, 1)[0]);
        } else if (nodes[i].children) {
          extractAllNodes(nodes[i].children, nameTargets, collected);
        }
      }
      return collected;
    }

    // Tries each target in priority order, searching the WHOLE tree for that
    // one target before falling back to the next. This matters because
    // nameTargets mixes specific destinations ("liabilities") with broader
    // fallbacks ("liabilities and equity") for trees that lack the specific
    // one — searching all targets at once lets a shallow, broad match (e.g.
    // the top-level "Liabilities and Equity" wrapper) win over a deeper,
    // more specific match (the nested "Liabilities" section) purely because
    // it's encountered first in traversal order, silently misplacing nodes
    // (e.g. Long-Term Liabilities ending up a sibling of Liabilities instead
    // of inside it).
    function findSection(nodes, nameTargets) {
      for (const target of nameTargets) {
        const found = findSectionForTarget(nodes, target);
        if (found) return found;
      }
      return null;
    }

    function findSectionForTarget(nodes, target) {
      if (!nodes) return null;
      for (let i = 0; i < nodes.length; i++) {
        if (normalizeName(nodes[i].name) === target) {
          return nodes[i];
        }
        if (nodes[i].children) {
          const found = findSectionForTarget(nodes[i].children, target);
          if (found) return found;
        }
      }
      return null;
    }

    const moves = [
      { target: ["accounts receivable", "accounts receivable a r", "account receivable", "a r", "account receviable", "accounts receviable"], dest: ["current assets", "total current assets"], parentFallback: ["assets", "total assets"] },
      { target: ["bank accounts", "bank account", "total cash", "cash"], dest: ["current assets", "total current assets"], parentFallback: ["assets", "total assets"] },
      { target: ["other current assets", "other current asset"], dest: ["current assets", "total current assets"], parentFallback: ["assets", "total assets"] },
      { target: ["fixed assets", "fixed asset"], dest: ["assets", "total assets"] },
      { target: ["accounts payable", "accounts payable a p", "account payable", "a p"], dest: ["current liabilities", "total current liabilities"], parentFallback: ["liabilities", "total liabilities", "liabilities and equity"] },
      { target: ["credit cards", "credit card"], dest: ["current liabilities", "total current liabilities"], parentFallback: ["liabilities", "total liabilities", "liabilities and equity"] },
      { target: ["other current liabilities", "other current liability"], dest: ["current liabilities", "total current liabilities"], parentFallback: ["liabilities", "total liabilities", "liabilities and equity"] },
      { target: ["long term liabilities", "long term liability"], dest: ["liabilities", "total liabilities", "liabilities and equity"] },
      { target: ["equity", "total equity"], dest: ["liabilities and equity", "total liabilities and equity"] }
    ];

    let structureChanged = false;

    for (const move of moves) {
      const extracted = extractAllNodes(tree, move.target);
      // Reverse extracted array to preserve original relative ordering when unshifting
      extracted.reverse();
      for (const nodeToMove of extracted) {
        let destNode = findSection(tree, move.dest);
        if (destNode && destNode.children) {
          destNode.children.unshift(nodeToMove);
          structureChanged = true;
        } else {
          let parentNode = findSection(tree, move.parentFallback);
          if (parentNode && parentNode.children) {
            // Create the missing destination section
            const newSectionName = move.dest[0].split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
            const newDestNode = {
              id: "created-section-" + move.dest[0].replace(/\s+/g, '-'),
              name: newSectionName,
              type: "header",
              children: [
                nodeToMove,
                {
                  id: "total-created-" + move.dest[0].replace(/\s+/g, '-'),
                  name: "Total " + newSectionName,
                  type: "total",
                  amounts: {}
                }
              ],
              amounts: {}
            };
            parentNode.children.unshift(newDestNode);
            structureChanged = true;
          } else {
            tree.unshift(nodeToMove);
            structureChanged = true;
          }
        }
      }
    }

    if (!structureChanged) return tree;

    function recompute(node) {
      if (!node.children || node.children.length === 0) return;

      node.children.forEach(child => {
        if (child.type === 'header' || child.children) {
          recompute(child);
        }
      });

      const totalNode = node.children.find(c => c.type === 'total');

      const newAmounts = {};
      node.children.forEach(child => {
        if (child.type !== 'total') {
          Object.entries(child.amounts || {}).forEach(([key, val]) => {
            newAmounts[key] = (newAmounts[key] || 0) + val;
          });
        }
      });

      if (newAmounts[currentYearKey] !== undefined && newAmounts.pm !== undefined) {
        newAmounts.monthlyChange = (newAmounts[currentYearKey] || 0) - (newAmounts.pm || 0);
      }

      node.amounts = { ...node.amounts, ...newAmounts };
      if (totalNode) {
        totalNode.amounts = { ...totalNode.amounts, ...newAmounts };
      }
    }

    tree.forEach(recompute);
    return tree;
  }

  const enrichedRows = masterRows.map(enrich);
  return restructureGAAPTree(enrichedRows);
}

function fileYear(file) {
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

function fileLabel(file) {
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
  const y = fileYear(file);
  return y ? `Dec ${y}` : "Unknown";
}

function buildBSFromPeriodColumns(sortedFiles) {
  const allCols = [];
  const filePeriodInfo = sortedFiles.map((file) => {
    const periods = file.data?.periods || [];
    const startIdx = allCols.length;

    if (periods.length > 0) {
      periods.forEach((label, i) => allCols.push({ key: `p${startIdx + i}`, label: expandPeriodLabel(label), isCurrent: false }));
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
      const colKey = `p${startIdx}`;
      allCols.push({ key: colKey, label: fileLabel(file), isCurrent: false });
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

  if (!allCols.length) return { rows: [], columns: { yearCols: [], changeCols: [], currentMonth: "" } };
  allCols[allCols.length - 1].isCurrent = true;

  const lastKey = allCols[allCols.length - 1].key;
  const prevKey = allCols.length > 1 ? allCols[allCols.length - 2].key : null;

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
      amounts.monthlyChange = (amounts[lastKey] || 0) - (prevKey ? amounts[prevKey] || 0 : 0);
      return {
        ...node,
        amounts,
        children: node.children ? enrich(node.children) : undefined,
      };
    });

  return {
    rows: enrich(unionStructure),
    columns: {
      yearCols: allCols,
      changeCols: [],
      currentMonth: allCols[allCols.length - 1]?.label || "",
    },
  };
}

function collapseBSNodeToAnnual(node, periods) {
  const totalIdx = Array.isArray(periods)
    ? periods.findIndex((p) => /^total$/i.test(String(p).trim()))
    : -1;
  const amount =
    node.amount != null && node.amount !== 0
      ? node.amount
      : Array.isArray(node.colAmounts) && node.colAmounts.length
        ? totalIdx >= 0
          ? (node.colAmounts[totalIdx] || 0)
          : (node.colAmounts[node.colAmounts.length - 1] || 0)
        : 0;
  return {
    ...node,
    amount,
    children: node.children
      ? node.children.map((c) => collapseBSNodeToAnnual(c, periods))
      : undefined,
  };
}

async function buildBSMultiFileDetail(sourceMode = "manual_upload", options = {}) {
  const fetchFn = sourceMode === "quickbooks_manual" ? getAllQMSUploadedReports : getAllManualUploadedReports;
  const result = await fetchFn("balance_sheet");
  let files = (result?.files || []).filter((f) => f.data?.rows?.length);

  const { startYear, endYear, yearMode } = options;
  if (startYear || endYear) {
    files = files.filter((f) => {
      const y = fileYear(f);
      if (!y) return true;
      if (startYear && y < Number(startYear)) return false;
      if (endYear && y > Number(endYear)) return false;
      return true;
    });
  }

  if (!files.length) return { rows: [], columns: { yearCols: [], changeCols: [], currentMonth: "" } };

  // Sort files oldest → newest so columns read left-to-right chronologically
  const sortedFiles = [...files].sort((a, b) => {
    const ya = fileYear(a) || 9999;
    const yb = fileYear(b) || 9999;
    if (ya !== yb) return ya - yb;
    return new Date(a.updatedAt || 0) - new Date(b.updatedAt || 0);
  });

  // yearMode: one "FY YYYY" column per file — skip period expansion.
  if (!yearMode && sortedFiles.some((f) => f.data?.periods?.length > 0)) {
    return buildBSFromPeriodColumns(sortedFiles);
  }

  const filePeriods = sortedFiles.map((f, i) => {
    const year = fileYear(f);
    const rows = yearMode && f.data?.periods?.length
      ? (f.data.rows || []).map((r) => collapseBSNodeToAnnual(r, f.data.periods))
      : (f.data.rows || []);
    return {
      key: `f${i}`,
      label: year ? `FY ${year}` : fileLabel(f),
      rows,
    };
  });

  const fileKeys = filePeriods.map((p) => p.key);
  const masterKey = fileKeys[fileKeys.length - 1];
  const prevKey = fileKeys.length >= 2 ? fileKeys[fileKeys.length - 2] : null;

  const mergedRows = mergeFileNodes(
    filePeriods.map((p) => p.rows),
    fileKeys,
  );

  // Attach monthlyChange (last file vs second-to-last) on every node
  const attachChange = (nodes) =>
    nodes.map((node) => {
      const currentVal = node.amounts?.[masterKey] || 0;
      const prevVal = prevKey ? node.amounts?.[prevKey] || 0 : 0;
      return {
        ...node,
        amounts: { ...node.amounts, monthlyChange: currentVal - prevVal },
        children: node.children ? attachChange(node.children) : undefined,
      };
    });

  const rows = attachChange(mergedRows);

  const yearCols = filePeriods.map((p, i) => ({
    key: p.key,
    label: p.label,
    isCurrent: i === filePeriods.length - 1,
  }));

  const changeCols = [];
  for (let i = 1; i < filePeriods.length; i++) {
    changeCols.push({
      key: `c${i}`,
      label: `${filePeriods[i].label} CHANGE`,
      from: filePeriods[i - 1].key,
      to: filePeriods[i].key,
    });
  }

  return {
    rows,
    columns: {
      yearCols,
      changeCols,
      currentMonth: filePeriods[filePeriods.length - 1]?.label || "",
    },
  };
}

export async function getBalanceSheetDetail(
  startDate,
  endDate,
  accountingMethod,
  options = {},
) {
  const keyReportVersionId = options?.keyReportVersionId || null;

  // Key Reports: read ONLY from balance_sheet_entries — never from Manual GL staging.
  if (keyReportVersionId) {
    try {
      const manualFilters = options?.manualFilters || {};
      const singleYear = /^\d{4}$/.test(String(manualFilters.fiscalYear ?? "")) ? manualFilters.fiscalYear : null;
      const response = await getKeyReportVersionReport(keyReportVersionId, "balance-sheet", {
        // Detail tab = "Month" view → monthly columns (Jan…Dec) for the year (spec #9).
        year: singleYear,
        startDate: manualFilters.fromDate || null,
        endDate: manualFilters.toDate || null,
        period: "month",
      });
      console.log("[KeyReports][BS][Detail] Loaded from balance_sheet_entries for version", keyReportVersionId);
      return {
        rows: response?.hierarchicalRows || response?.rows || [],
        columns: response?.columns || { yearCols: [], changeCols: [], currentMonth: "" },
        source: response?.source || "key_reports_entry_tables",
        reportType: "balance_sheet_monthly_detail",
      };
    } catch (err) {
      console.warn("[KeyReports][BS][Detail] Entry table fetch failed:", err.message);
      return {
        rows: [],
        columns: { yearCols: [], changeCols: [], currentMonth: "" },
        source: "key_reports_entry_tables",
        reportType: "balance_sheet_monthly_detail",
      };
    }
  }

  if ((options?.sourceMode || "quickbooks") === "manual") {
    const baseParams = {
      ...((options?.manualFilters && typeof options.manualFilters === "object")
        ? options.manualFilters
        : {}),
    };

    // Yearly mode: one call per year, aggregate year-end (last-month) balance for each account
    if (options?.yearMode === true && options?.startYear && options?.endYear) {
      const startYr = Number(options.startYear);
      const endYr = Number(options.endYear);
      const years = [];
      for (let y = startYr; y <= endYr; y++) years.push(y);

      const yearResults = {};
      await Promise.all(years.map(async (yr) => {
        const resp = await getManualStagedBalanceSheetMonthlyDetail({ params: { ...baseParams, fiscalYear: yr } });
        yearResults[yr] = resp;
      }));

      const firstAvailable = Object.values(yearResults).find((r) => r?.sections);
      const lastYr = years[years.length - 1];
      const aggregatedSections = {};

      for (const sectionKey of ["Assets", "Liabilities", "Equity"]) {
        const templateSection = Object.values(yearResults).map((r) => r?.sections?.[sectionKey]).find(Boolean);
        if (!templateSection) continue;

        const catMap = new Map();
        const sectionMonthlyTotals = {};

        for (const yr of years) {
          const section = yearResults[yr]?.sections?.[sectionKey];
          if (!section) continue;
          const yrMonths = yearResults[yr]?.months || [];
          const lastMon = yrMonths[yrMonths.length - 1];
          sectionMonthlyTotals[yr] = lastMon != null
            ? Number(section.monthlyTotals?.[lastMon] ?? section.total ?? 0)
            : Number(section.total ?? 0);

          for (const cat of (section.categories || [])) {
            if (!catMap.has(cat.label)) catMap.set(cat.label, { label: cat.label, accMap: new Map(), monthlyTotals: {} });
            const aggCat = catMap.get(cat.label);
            aggCat.monthlyTotals[yr] = lastMon != null
              ? Number(cat.monthlyTotals?.[lastMon] ?? cat.total ?? 0)
              : Number(cat.total ?? 0);
            for (const acc of (cat.accounts || [])) {
              const accKey = `${acc.number}::${acc.name}`;
              if (!aggCat.accMap.has(accKey)) aggCat.accMap.set(accKey, { name: acc.name, number: acc.number, monthly: {}, total: 0, transactions: [] });
              const aggAcc = aggCat.accMap.get(accKey);
              aggAcc.monthly[yr] = lastMon != null
                ? Number(acc.monthly?.[lastMon] ?? acc.total ?? 0)
                : Number(acc.total ?? 0);
              // Carry transactions tagged with fiscalYear so vendor drill-down works in yearly view
              if (Array.isArray(acc.transactions) && acc.transactions.length > 0) {
                acc.transactions.forEach((tx) => aggAcc.transactions.push({ ...tx, fiscalYear: yr }));
              }
            }
          }
        }

        aggregatedSections[sectionKey] = {
          label: templateSection.label,
          monthlyTotals: sectionMonthlyTotals,
          total: sectionMonthlyTotals[lastYr] ?? 0,
          categories: Array.from(catMap.values()).map((c) => ({
            label: c.label,
            monthlyTotals: c.monthlyTotals,
            total: c.monthlyTotals[lastYr] ?? 0,
            accounts: Array.from(c.accMap.values()).map((a) => ({ ...a, total: a.monthly[lastYr] ?? 0 })),
          })),
        };
      }

      return {
        source: firstAvailable?.source || "manual_gl_staged_transactions",
        reportType: "balance_sheet_monthly_detail",
        year: null,
        months: years,
        sections: aggregatedSections,
      };
    }

    // Monthly mode (default): single call with current filters
    console.log("[DetailedReportUI][BS] Requesting monthly detail with params:", JSON.stringify(baseParams));
    const response = await getManualStagedBalanceSheetMonthlyDetail({ params: baseParams });
    console.log("[DetailedReportUI][BS] Received keys:", Object.keys(response || {}), "| source:", response?.source, "| reportType:", response?.reportType, "| months:", response?.months);
    if (!response?.sections || Object.keys(response.sections).length === 0) {
      console.warn("[DetailedReportUI][BS] WARNING: sections is empty — check fiscal year filter and staged data.");
    }
    return response;
  }

  if (options?.sourceMode === "manual_upload" || options?.sourceMode === "quickbooks_manual") {
    return buildBSMultiFileDetail(options.sourceMode, {
      startYear: options.startYear,
      endYear: options.endYear,
      yearMode: options.yearMode,
    });
  }

  // Month mode: one balance sheet snapshot per calendar month.
  if (options.monthMode && startDate && endDate) {
    const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const monthlyPeriods = [];
    const s = new Date(startDate + "T00:00:00");
    const e = new Date(endDate + "T00:00:00");
    let yr = s.getFullYear(), mo = s.getMonth();
    // A wide range (e.g. "All Dates") would otherwise fire one live QuickBooks
    // request per calendar month with no upper bound — cap to the most recent
    // MAX_MONTHLY_PERIODS months so it stays bounded and fast, keeping the
    // period closest to "now" since that's what users actually monitor.
    const MAX_MONTHLY_PERIODS = 120;
    const endMonthIndex = e.getFullYear() * 12 + e.getMonth();
    let startMonthIndex = yr * 12 + mo;
    if (endMonthIndex - startMonthIndex + 1 > MAX_MONTHLY_PERIODS) {
      console.warn(
        `[BalanceSheet] Month mode range (${startDate} to ${endDate}) spans more than ${MAX_MONTHLY_PERIODS} months — trimming to the most recent ${MAX_MONTHLY_PERIODS}.`,
      );
      startMonthIndex = endMonthIndex - MAX_MONTHLY_PERIODS + 1;
      yr = Math.floor(startMonthIndex / 12);
      mo = startMonthIndex % 12;
    }
    while (yr < e.getFullYear() || (yr === e.getFullYear() && mo <= e.getMonth())) {
      const mm = String(mo + 1).padStart(2, "0");
      const lastDay = new Date(yr, mo + 1, 0).getDate();
      monthlyPeriods.push({
        key: `m${yr}_${mm}`,
        label: `${MONTHS[mo]} ${yr}`,
        startDate: `${yr}-${mm}-01`,
        endDate: `${yr}-${mm}-${String(lastDay).padStart(2, "0")}`,
        type: "monthly",
      });
      mo++; if (mo > 11) { mo = 0; yr++; }
    }
    const [monthResults, vendorMap] = await Promise.all([
      Promise.all(monthlyPeriods.map((p) =>
        fetchSinglePeriodBS(p.startDate, p.endDate, accountingMethod, options?.sourceMode || "quickbooks", options),
      )),
      fetchQBVendorBreakdown(
        monthlyPeriods[0]?.startDate,
        monthlyPeriods[monthlyPeriods.length - 1]?.endDate,
        accountingMethod,
        monthlyPeriods,
      ).catch(() => ({})),
    ]);
    const mergedRows = mergePeriods(monthResults, monthlyPeriods);
    const colKeys = monthlyPeriods.map((p) => p.key);
    const rows = attachVendorsToRows(mergedRows, vendorMap, colKeys);
    return {
      rows,
      columns: {
        yearCols: monthlyPeriods.map((p, i) => ({
          key: p.key,
          label: p.label,
          isCurrent: i === monthlyPeriods.length - 1,
        })),
        changeCols: [],
        currentMonth: monthlyPeriods[monthlyPeriods.length - 1]?.label || "",
      },
    };
  }

  // Year mode or default: system-defined multi-year comparison.
  // When a year range is provided (Year mode), generate periods only for that range.
  const allPeriods = (options.startYear && options.endYear)
    ? getComparativePeriods(4, options.startYear, options.endYear)
    : getComparativePeriods(4, endDate, startDate);

  const yearlyPeriods = allPeriods.filter(p => p.type === 'yearly');
  const glStartDate = yearlyPeriods[0]?.startDate;
  const glEndDate = yearlyPeriods[yearlyPeriods.length - 1]?.endDate;

  // Fetch period snapshots and QB GL vendor data concurrently
  const [results, vendorMap] = await Promise.all([
    Promise.all(
      allPeriods.map((p) =>
        fetchSinglePeriodBS(
          p.startDate,
          p.endDate,
          accountingMethod,
          options?.sourceMode || "quickbooks",
          options,
        ),
      ),
    ),
    fetchQBVendorBreakdown(glStartDate, glEndDate, accountingMethod, yearlyPeriods).catch(() => ({})),
  ]);

  const mergedRows = mergePeriods(results, allPeriods);
  const yearColKeys = yearlyPeriods.map(p => p.key);
  const rows = attachVendorsToRows(mergedRows, vendorMap, yearColKeys);

  const yearCols = yearlyPeriods.map(p => ({
    key: p.key,
    label: p.label,
    isCurrent: p.key === yearlyPeriods[yearlyPeriods.length - 1].key,
  }));

  const changeCols = [];
  for (let i = 1; i < yearlyPeriods.length; i++) {
    const prev = yearlyPeriods[i - 1];
    const curr = yearlyPeriods[i];
    changeCols.push({
      key: `c${i}`,
      label: `'${String(curr.year).slice(-2)} CHANGE`,
      from: prev.key,
      to: curr.key,
    });
  }

  const currentPeriodLabel = yearlyPeriods[yearlyPeriods.length - 1].label;

  return {
    rows,
    columns: {
      yearCols,
      changeCols,
      currentMonth: currentPeriodLabel,
    },
  };
}
