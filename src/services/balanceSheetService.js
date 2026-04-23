import { fetchBalanceSheet } from "../lib/quickbooks";
import { normalizeAccountingMethod } from "../lib/report-filters";
import {
  parseBalanceSheetDetailFromAllReports,
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

function getShiftedStartDate(startDateString, yearShift, monthShift) {
  if (!startDateString) return undefined;
  const [yrStr, moStr, daStr] = startDateString.split('-');
  if (!yrStr || !moStr || !daStr) return undefined;
  const d = new Date(parseInt(yrStr, 10), parseInt(moStr, 10) - 1, parseInt(daStr, 10));
  d.setFullYear(d.getFullYear() - yearShift);
  d.setMonth(d.getMonth() - monthShift);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Generates dynamic comparative periods based on a specific end date.
 * Plus an additional period for the previous month to calculate monthly delta.
 */
function getComparativePeriods(numYears = 4) {
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

async function fetchSinglePeriodBS(startDate, endDate, accountingMethod) {
  try {
    const payload = await fetchBalanceSheet({
      ...(startDate ? { start_date: startDate } : {}),
      end_date: endDate,
      ...(accountingMethod
        ? { accounting_method: normalizeAccountingMethod(accountingMethod) }
        : {}),
    });
    return parseSummaryReport(payload);
  } catch (err) {
    console.warn(`⚠️ Failed to fetch Balance Sheet for ${startDate || 'cumulative'} to ${endDate}:`, err.message);
    return [];
  }
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

function mergePeriods(periodResults, periods) {
  const yearlyPeriods = periods.filter(p => p.type === 'yearly');
  const currentYearKey = yearlyPeriods[yearlyPeriods.length - 1]?.key || "y1";
  const masterIndex = periods.findIndex(p => p.key === currentYearKey);
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

    function findSection(nodes, nameTargets) {
      if (!nodes) return null;
      for (let i = 0; i < nodes.length; i++) {
        const norm = normalizeName(nodes[i].name);
        if (nameTargets.includes(norm)) {
          return nodes[i];
        }
        if (nodes[i].children) {
          const found = findSection(nodes[i].children, nameTargets);
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

// ─── Exported Services ──────────────────────────────────────────────────────

export async function getBalanceSheet(startDate, endDate, accountingMethod) {
  const allPeriods = getComparativePeriods(4, endDate, startDate);

  const results = await Promise.all(
    allPeriods.map(p => fetchSinglePeriodBS(p.startDate, p.endDate, accountingMethod))
  );

  const rows = mergePeriods(results, allPeriods);

  const yearCols = allPeriods
    .filter(p => p.type === 'yearly')
    .map(p => ({
      key: p.key,
      label: p.label,
      isCurrent: p.key === allPeriods.filter(x => x.type === 'yearly').pop().key
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
