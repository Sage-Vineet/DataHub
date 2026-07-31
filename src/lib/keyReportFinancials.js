// Transform the Key Reports "financial-statements" API response
// (GET /key-reports/versions/:id/reports/financial-statements) into the
// hierarchical { rows, columns:{ yearCols } } shape consumed by the existing
// report renderers (ProfitAndLossQBSummary / BalanceSheetQBSummary /
// CashflowSummary). Each node is { id, name, type?, amounts:{colKey}, children? }
// where type is "header" (section) or "total" (bold subtotal); leaf accounts
// omit type. Column values are read from node.amounts[col.key].
//
// This lets the Reports page render Key Reports data through the SAME UI it uses
// for manual-upload detail views — no component/UI changes required.

const MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// ── Response cache (survives client-side navigation) ──────────────────────────
// The financial-statements payload is large and slow to fetch, so we cache it in
// sessionStorage per client + version. Returning to the Reports page re-uses it
// instead of re-hitting the network. Invalidated (clearCachedFinancials) when a
// version is re-generated so freshly synced data is never masked by a stale copy.
const FINANCIALS_STORAGE_PREFIX = "datahub-key-reports-financials";

function financialsKey(clientId, versionId) {
  return `${FINANCIALS_STORAGE_PREFIX}:${clientId || "default"}:${versionId}`;
}

export function readCachedFinancials(clientId, versionId) {
  if (!versionId || typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(financialsKey(clientId, versionId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function writeCachedFinancials(clientId, versionId, data) {
  if (!versionId || typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(financialsKey(clientId, versionId), JSON.stringify(data));
  } catch {
    /* quota / serialisation — non-fatal */
  }
}

export function clearCachedFinancials(clientId, versionId) {
  if (!versionId || typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(financialsKey(clientId, versionId));
  } catch {
    /* non-fatal */
  }
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

// Map a report tab to its key in response.reports.
function tabToTypeKey(tab) {
  if (tab === "Balance Sheet") return "balanceSheet";
  if (tab === "Profit & Loss") return "profitAndLoss";
  return "cashFlow";
}

// Build one column descriptor per period entry. Month labels use the
// "MMM YYYY" form (e.g. "Jan 2023") so the page's existing month-range filter
// (which parses that format) keeps working; year labels use "FY YYYY".
function buildColumns(entries, period) {
  return entries.map((e) =>
    period === "Year"
      ? { key: `y${e.year}`, label: e.periodLabel || `FY ${e.year}` }
      : {
          key: `m${e.year}_${pad2(e.monthNumber)}`,
          label: `${MONTHS_SHORT[(Number(e.monthNumber) || 1) - 1]} ${e.year}`,
        },
  );
}

function totalRow(id, name, perPeriodValue) {
  const amounts = {};
  perPeriodValue.forEach(({ colKey, value }) => {
    amounts[colKey] = Number(value) || 0;
  });
  return { id, name, type: "total", amounts };
}

// A section header wrapping the backend's genuine, arbitrary-depth hierarchy
// (see mergeDynamicHierarchy below) with a trailing subtotal row. Used for
// every Profit & Loss section (Revenue / Cost of Sales / Operating Expenses)
// so a document's own real sub-category depth survives instead of collapsing
// to a flat list or a single grouping level.
function hierarchySectionNode(id, name, entries, colKey, pickHierarchy, totalName, perPeriodTotal) {
  const children = mergeDynamicHierarchy(entries, colKey, pickHierarchy, id);
  children.push(totalRow(`${id}-total`, totalName, perPeriodTotal));
  return { id, name, type: "header", amounts: {}, children };
}

function buildProfitAndLoss(entries, cols) {
  const colKey = (i) => cols[i].key;
  const per = (pick) => entries.map((e, i) => ({ colKey: colKey(i), value: pick(e.statement || {}) }));

  const revenue = hierarchySectionNode(
    "pl-rev", "Revenue", entries, colKey,
    (s) => s.revenue?.hierarchy,
    "Total Revenue",
    per((s) => s.revenue?.total),
  );
  const costOfSales = hierarchySectionNode(
    "pl-cos", "Cost of Sales", entries, colKey,
    (s) => s.costOfSales?.hierarchy,
    "Total Cost of Sales",
    per((s) => s.costOfSales?.total),
  );
  const grossProfit = totalRow("pl-gp", "Gross Profit", per((s) => s.grossProfit));

  const operatingExpenses = hierarchySectionNode(
    "pl-opex", "Operating Expenses", entries, colKey,
    (s) => s.operatingExpenses?.hierarchy,
    "Total Operating Expenses",
    per((s) => s.operatingExpenses?.total),
  );

  const operatingIncome = totalRow("pl-oi", "Operating Income", per((s) => s.operatingIncome));
  const pretaxIncome = totalRow("pl-pti", "Pretax Income", per((s) => s.pretaxIncome));
  const netIncome = totalRow("pl-ni", "Net Income", per((s) => s.netIncome));

  return {
    rows: [revenue, costOfSales, grossProfit, operatingExpenses, operatingIncome, pretaxIncome, netIncome],
    columns: { yearCols: cols },
  };
}

// Merge the backend's genuine, arbitrary-depth hierarchy
// (financialStatementService.js's buildDynamicHierarchy — built directly
// from chart_of_accounts level_1..level_15; no fixed bucket names, no depth
// cap, consecutive duplicate labels already collapsed server-side) across
// every period, into the { id, name, type, amounts, children } shape QBRow
// recurses through. This is the ONLY hierarchy construction on the frontend,
// shared by every Balance Sheet section (assets/liabilities/equity) and every
// Profit & Loss section (revenue/cost of sales/operating expenses): it just
// merges whatever tree the backend already built by name at each depth — it
// never invents, renames, or reclassifies a node. Containers are matched by
// name; leaves are matched by systemId (falling back to name).
function mergeDynamicHierarchy(entries, colKey, pickHierarchy, idPrefix) {
  function mergeLevel(perPeriodNodes, parentId) {
    const order = [];
    const byKey = new Map(); // matchKey -> { isLeaf, name, occurrences: [{colKey, node}] }
    perPeriodNodes.forEach(({ colKey: ck, nodes }) => {
      (nodes || []).forEach((node) => {
        const isLeaf = node.type === "leaf";
        const matchKey = isLeaf ? (node.systemId || node.name) : node.name;
        if (!byKey.has(matchKey)) { order.push(matchKey); byKey.set(matchKey, { isLeaf, name: node.name, occurrences: [] }); }
        byKey.get(matchKey).occurrences.push({ colKey: ck, node });
      });
    });
    return order.map((matchKey) => {
      const rec = byKey.get(matchKey);
      const id = `${parentId}/${matchKey}`;
      if (rec.isLeaf) {
        const amounts = {};
        rec.occurrences.forEach(({ colKey: ck, node }) => { amounts[ck] = Number(node.amount) || 0; });
        return { id, name: rec.name, amounts };
      }
      const childPerPeriod = rec.occurrences.map(({ colKey: ck, node }) => ({ colKey: ck, nodes: node.children || [] }));
      const children = mergeLevel(childPerPeriod, id);
      const totalAmounts = {};
      rec.occurrences.forEach(({ colKey: ck, node }) => { totalAmounts[ck] = Number(node.amount) || 0; });
      // Avoid "Total Total Assets" when the container's own COA name already
      // reads as a total (e.g. the root anchor "Total Assets"/"Total
      // Liabilities and Equity") — use its own name verbatim instead of
      // prefixing another "Total " onto it.
      const totalLabel = /^total\b/i.test(rec.name) ? rec.name : `Total ${rec.name}`;
      children.push({ id: `${id}-total`, name: totalLabel, type: "total", amounts: totalAmounts });
      return { id, name: rec.name, type: "header", amounts: {}, children };
    });
  }
  const perPeriodRoot = entries.map((e, i) => ({ colKey: colKey(i), nodes: pickHierarchy(e.statement || {}) || [] }));
  return mergeLevel(perPeriodRoot, idPrefix);
}

function buildBalanceSheet(entries, cols) {
  const colKey = (i) => cols[i].key;
  const per = (pick) => entries.map((e, i) => ({ colKey: colKey(i), value: pick(e.statement || {}) }));

  // The backend's hierarchy root is already self-describing (its own name
  // comes straight from chart_of_accounts level_1, e.g. "Total Assets") and
  // already carries its own rolled-up "Total …" child — used directly as the
  // top-level row(s), with no extra hardcoded "Assets"/"Liabilities" wrapper
  // or redundant appended total layered on top of it.
  const assetRows  = mergeDynamicHierarchy(entries, colKey, (s) => s.assets?.hierarchy, "bs-a");
  const liabRows   = mergeDynamicHierarchy(entries, colKey, (s) => s.liabilities?.hierarchy, "bs-l");
  // Same genuine, arbitrary-depth merge as assets/liabilities above — equity's
  // own document sub-headings (e.g. "Owner's Equity" > "Capital") survive as
  // real nested rows instead of collapsing into one flat account list.
  const equityRows = mergeDynamicHierarchy(entries, colKey, (s) => s.equity?.hierarchy, "bs-eq");
  const tle = totalRow("bs-tle", "Total Liabilities and Equity", per((s) => s.totalLiabilitiesAndEquity));

  return { rows: [...assetRows, ...liabRows, ...equityRows, tle], columns: { yearCols: cols } };
}

// Cash-flow activity section. Monthly items are plain {name, amount}; yearly
// items may already include an isTotal "Net Cash from …" row (with nested
// zero-children). Map items straight through and only synthesize a subtotal
// when the period data didn't provide one.
function activityNode(idPrefix, title, perPeriod) {
  const order = [];
  const map = new Map();
  let hasTotalItem = false;
  perPeriod.forEach(({ colKey, section }) => {
    (section?.items || []).forEach((it) => {
      if (it.isTotal) hasTotalItem = true;
      const key = it.name;
      if (!map.has(key)) {
        order.push(key);
        map.set(key, { name: it.name, isTotal: Boolean(it.isTotal), amounts: {} });
      }
      map.get(key).amounts[colKey] = Number(it.amount) || 0;
    });
  });
  const children = order.map((k, idx) => {
    const rec = map.get(k);
    return {
      id: `${idPrefix}-${idx}`,
      name: rec.name,
      ...(rec.isTotal ? { type: "total" } : {}),
      amounts: rec.amounts,
    };
  });
  if (!hasTotalItem) {
    const amounts = {};
    perPeriod.forEach(({ colKey, section }) => {
      amounts[colKey] = Number(section?.total) || 0;
    });
    children.push({ id: `${idPrefix}-total`, name: `Net Cash from ${title}`, type: "total", amounts });
  }
  return { id: idPrefix, name: title, type: "header", amounts: {}, children };
}

function buildCashFlow(entries, cols) {
  const colKey = (i) => cols[i].key;
  const sectionPer = (pick) => entries.map((e, i) => ({ colKey: colKey(i), section: pick(e.statement || {}) }));
  const scalarRow = (id, name, pick) => ({
    id,
    name,
    type: "total",
    amounts: Object.fromEntries(entries.map((e, i) => [colKey(i), Number(pick(e.statement || {})) || 0])),
  });

  return {
    rows: [
      activityNode("cf-op", "Operating Activities", sectionPer((s) => s.operatingActivities)),
      activityNode("cf-inv", "Investing Activities", sectionPer((s) => s.investingActivities)),
      activityNode("cf-fin", "Financing Activities", sectionPer((s) => s.financingActivities)),
      totalRow("cf-net", "Net Cash Increase", entries.map((e, i) => ({ colKey: colKey(i), value: e.statement?.netCashIncrease }))),
      scalarRow("cf-open", "Opening Cash", (s) => s.openingCash),
      scalarRow("cf-end", "Ending Cash", (s) => s.endingCash),
    ],
    columns: { yearCols: cols },
  };
}

// Fill every year in [yearStart, yearEnd] with its real entry, or an empty
// placeholder ({ statement: {} }, which every builder above already renders as
// all-zero amounts via its existing `|| {}`/`|| 0` guards) when the version has
// no data for that year. An open bound defaults to the data's own min/max so a
// partial filter (only From or only To set) never fabricates an unbounded range.
// This makes a selected-but-dataless year appear with empty values instead of
// silently vanishing from the report.
function fillYearGaps(entries, yearStart, yearEnd) {
  const years = entries.map((e) => Number(e.year)).filter(Number.isInteger);
  const start = yearStart != null && yearStart !== "" ? Number(yearStart) : (years.length ? Math.min(...years) : null);
  const end = yearEnd != null && yearEnd !== "" ? Number(yearEnd) : (years.length ? Math.max(...years) : null);
  if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) return entries;
  const byYear = new Map(entries.map((e) => [Number(e.year), e]));
  const filled = [];
  for (let y = start; y <= end; y += 1) {
    filled.push(byYear.get(y) || { year: y, periodLabel: `FY ${y}`, statement: {} });
  }
  return filled;
}

// Same gap-filling as fillYearGaps, at month granularity — every "YYYY-MM" in
// [monthStart, monthEnd] gets its real entry or an empty placeholder.
function fillMonthGaps(entries, monthStart, monthEnd) {
  const existingYm = entries.map((e) => `${e.year}-${pad2(e.monthNumber)}`);
  const startYM = monthStart ? String(monthStart).slice(0, 7) : (existingYm.length ? existingYm.reduce((a, b) => (a < b ? a : b)) : null);
  const endYM = monthEnd ? String(monthEnd).slice(0, 7) : (existingYm.length ? existingYm.reduce((a, b) => (a > b ? a : b)) : null);
  if (!startYM || !endYM || endYM < startYM) return entries;
  const byYm = new Map(entries.map((e) => [`${e.year}-${pad2(e.monthNumber)}`, e]));
  const filled = [];
  let [y, m] = startYM.split("-").map(Number);
  const [endY, endM] = endYM.split("-").map(Number);
  while (y < endY || (y === endY && m <= endM)) {
    const ym = `${y}-${pad2(m)}`;
    filled.push(byYm.get(ym) || { year: y, monthNumber: m, statement: {} });
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return filled;
}

/**
 * Convert a financial-statements response into a detail payload for one tab.
 *
 * @param {object} response  Raw API response ({ reports: { profitAndLoss, balanceSheet, cashFlow } }).
 * @param {object} opts
 * @param {string} opts.tab       "Balance Sheet" | "Profit & Loss" | "Cashflow".
 * @param {string} opts.period    "Month" | "Year".
 * @param {string|number} [opts.yearStart]  Year mode: inclusive lower bound.
 * @param {string|number} [opts.yearEnd]    Year mode: inclusive upper bound.
 * @param {string} [opts.monthStart]  Month mode: inclusive "Date From" (YYYY-MM[-DD]).
 * @param {string} [opts.monthEnd]    Month mode: inclusive "Date To" (YYYY-MM[-DD]).
 * @returns {{ rows: Array, columns: { yearCols: Array } }}
 */
export function transformKeyReportFinancials(response, { tab, period, yearStart, yearEnd, monthStart, monthEnd } = {}) {
  const reports = response?.reports || {};
  const bucket = reports[tabToTypeKey(tab)] || {};
  let entries = period === "Year" ? bucket.yearly || [] : bucket.monthly || [];

  // Fill (not just filter) the selected range: a year/month the user's From/To
  // covers but the version has no data for still appears as its own column,
  // with empty/zero amounts, rather than silently disappearing from the report.
  entries = period === "Year"
    ? fillYearGaps(entries, yearStart, yearEnd)
    : fillMonthGaps(entries, monthStart, monthEnd);

  const cols = buildColumns(entries, period);
  if (tab === "Balance Sheet") return buildBalanceSheet(entries, cols);
  if (tab === "Profit & Loss") return buildProfitAndLoss(entries, cols);
  return buildCashFlow(entries, cols);
}
