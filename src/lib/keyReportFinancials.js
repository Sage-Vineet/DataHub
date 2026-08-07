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
// The prefix carries a PAYLOAD SHAPE version for the same reason the backend's
// result cache does (see FIN_STMT_PAYLOAD_VERSION in financialStatementService):
// this key is otherwise only client + version, neither of which changes when the
// payload shape changes in a new build. A browser tab holding a pre-vendor
// payload would keep rendering it for the whole session, so the vendor/customer
// rows would still be missing even against a fully fixed backend. Bump the
// suffix whenever the payload shape changes -- old keys are simply never read
// again (sessionStorage dies with the tab, so no cleanup is needed).
// v3: the Profit & Loss now renders from statement.statementBlocks. A cached v2
// payload predates that field, so a tab holding one would render an empty P&L
// for its whole session against a fully correct backend.
const FINANCIALS_STORAGE_PREFIX = "datahub-key-reports-financials-v3";

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
function hierarchySectionNode(id, name, entries, colKey, pickHierarchy, totalName, perPeriodTotal, entityIndex) {
  const children = mergeDynamicHierarchy(entries, colKey, pickHierarchy, id, entityIndex);
  children.push(totalRow(`${id}-total`, totalName, perPeriodTotal));
  return { id, name, type: "header", amounts: {}, children };
}

// ── Profit & Loss ────────────────────────────────────────────────────────────
//
// A Profit & Loss is a SEQUENCE OF BLOCKS separated by calculated rows, not one
// recursive tree:
//
//   Income                 → Total Income
//   Cost of Goods Sold     → Total Cost of Goods Sold
//   GROSS PROFIT
//   Operating Expenses     → Total Operating Expenses
//   NET OPERATING INCOME
//   Other Income           → Total Other Income
//   Other Expenses         → Total Other Expenses
//   NET OTHER INCOME
//   NET INCOME
//
// The four capitalised rows are CALCULATED STATEMENT ROWS. They are emitted as
// flat rows with no `children`, which is what makes them non-expandable in
// QBRow and stops them ever becoming a parent of an account. Each appears
// exactly once, at a fixed position.
//
// Every figure here — including the four calculated rows — is read straight off
// `statement.statementBlocks`, computed once in the backend's buildPlStatement.
// This function performs no accounting arithmetic.
//
// Blocks are described declaratively so order and labelling live in one place.
const PL_BLOCK_SEQUENCE = [
  { id: "pl-income", key: "income", fallbackLabel: "Income" },
  { id: "pl-cogs", key: "costOfSales", fallbackLabel: "Cost of Goods Sold" },
  { id: "pl-gp", calcRow: "grossProfit", label: "Gross Profit" },
  { id: "pl-opex", key: "operatingExpenses", fallbackLabel: "Operating Expenses" },
  { id: "pl-noi", calcRow: "netOperatingIncome", label: "Net Operating Income" },
  { id: "pl-oth-inc", key: "otherIncome", fallbackLabel: "Other Income" },
  { id: "pl-oth-exp", key: "otherExpenses", fallbackLabel: "Other Expenses" },
  { id: "pl-noi-other", calcRow: "netOtherIncome", label: "Net Other Income" },
  { id: "pl-ni", calcRow: "netIncome", label: "Net Income" },
];

const blocksOf = (statement) => statement?.statementBlocks || null;

// The section heading comes from the backend block's own label, which is the
// client's own document wording ("Income", "Cost of Goods Sold", "Expenses").
// Periods agree on it; the first period that carries one wins.
function blockLabel(entries, key, fallback) {
  for (const e of entries) {
    const label = blocksOf(e.statement)?.[key]?.label;
    if (label) return label;
  }
  return fallback;
}

// A block renders only when it actually has accounts. An empty Other Income /
// Other Expenses block is omitted entirely rather than printed as a heading
// with a zero total — but a block that has accounts summing to zero is kept,
// because the accounts themselves are real.
function blockHasContent(entries, key) {
  return entries.some((e) => {
    const b = blocksOf(e.statement)?.[key];
    return Boolean(b?.hierarchy?.length) || Math.abs(Number(b?.total) || 0) >= 0.005;
  });
}

function buildProfitAndLoss(entries, cols) {
  const colKey = (i) => cols[i].key;
  const per = (pick) => entries.map((e, i) => ({ colKey: colKey(i), value: pick(e.statement || {}) }));
  const entityIndex = buildEntityIndex(entries, cols);

  // A payload predating statementBlocks (an older cached response) still has to
  // render something rather than an empty statement — fall back to the previous
  // section-per-hierarchy layout for it.
  if (!entries.some((e) => blocksOf(e.statement))) {
    return buildProfitAndLossLegacy(entries, cols, colKey, per, entityIndex);
  }

  const rows = [];
  for (const spec of PL_BLOCK_SEQUENCE) {
    if (spec.calcRow) {
      // Flat, childless, non-expandable — never a container for accounts.
      rows.push(totalRow(spec.id, spec.label, per((s) => blocksOf(s)?.[spec.calcRow])));
      continue;
    }
    if (!blockHasContent(entries, spec.key)) continue;
    const label = blockLabel(entries, spec.key, spec.fallbackLabel);
    rows.push(hierarchySectionNode(
      spec.id, label, entries, colKey,
      (s) => blocksOf(s)?.[spec.key]?.hierarchy,
      `Total ${label}`,
      per((s) => blocksOf(s)?.[spec.key]?.total),
      entityIndex,
    ));
  }

  return { rows, columns: { yearCols: cols } };
}

// Pre-statementBlocks layout, kept only for cached payloads produced by an
// older backend. New responses never reach this.
function buildProfitAndLossLegacy(entries, cols, colKey, per, entityIndex) {
  const revenue = hierarchySectionNode(
    "pl-rev", "Revenue", entries, colKey,
    (s) => s.revenue?.hierarchy,
    "Total Revenue",
    per((s) => s.revenue?.total),
    entityIndex,
  );
  const costOfSales = hierarchySectionNode(
    "pl-cos", "Cost of Sales", entries, colKey,
    (s) => s.costOfSales?.hierarchy,
    "Total Cost of Sales",
    per((s) => s.costOfSales?.total),
    entityIndex,
  );
  const grossProfit = totalRow("pl-gp", "Gross Profit", per((s) => s.grossProfit));

  const operatingExpenses = hierarchySectionNode(
    "pl-opex", "Operating Expenses", entries, colKey,
    (s) => s.operatingExpenses?.hierarchy,
    "Total Operating Expenses",
    per((s) => s.operatingExpenses?.total),
    entityIndex,
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
function mergeDynamicHierarchy(entries, colKey, pickHierarchy, idPrefix, entityIndex = null) {
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
        // Counterparty sub-rows for this account, merged across every period
        // column. Only leaves carry them: a container row's amount is a rollup
        // of its children, so hanging a vendor list off it would double-count.
        const entities = entityIndex ? entityIndex(rec.name) : null;
        return {
          id,
          name: rec.name,
          amounts,
          ...(entities?.vendors?.length ? { vendors: entities.vendors } : {}),
          ...(entities?.customers?.length ? { customers: entities.customers } : {}),
        };
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

/**
 * Build a lookup that turns an account's display name into its Vendor and
 * Customer sub-rows, merged across every period column.
 *
 * The backend emits `vendorsByAccount` / `customersByAccount` per period, keyed
 * by the COA leaf display name and carrying that period's signed `amount`. This
 * pivots them into the shape the report rows already render:
 *
 *   [{ name, amounts: { [colKey]: number }, total }]
 *
 * A counterparty present in only some periods gets those columns populated and
 * the rest left absent — the renderer already falls back to 0 — so ONE row per
 * counterparty spans every year/month rather than one row per period. That is
 * what makes a single multi-year GL and several single-year GL files render
 * identically: both produce the same set of period entries.
 *
 * @param {Array} entries  period entries, in the same order as `cols`
 * @param {Array} cols     column descriptors from buildColumns
 * @returns {(accountName: string) => {vendors: Array, customers: Array}}
 */
function buildEntityIndex(entries, cols) {
  // accountName -> kind -> entityName -> { name, amounts, total }
  const index = new Map();

  const ingest = (accountMap, colKeyStr, kind) => {
    if (!accountMap || typeof accountMap !== "object") return;
    Object.entries(accountMap).forEach(([accountName, rows]) => {
      if (!Array.isArray(rows) || !rows.length) return;
      let perAccount = index.get(accountName);
      if (!perAccount) { perAccount = { vendors: new Map(), customers: new Map() }; index.set(accountName, perAccount); }
      const target = perAccount[kind];
      rows.forEach((row) => {
        const name = String(row?.name ?? "").trim();
        if (!name) return;
        // `amount` is this period's signed total for the counterparty; `total`
        // is accepted as a fallback for any caller that only sends that field.
        const value = Number(row?.amount ?? row?.total ?? 0) || 0;
        let entry = target.get(name);
        if (!entry) { entry = { name, amounts: {}, total: 0 }; target.set(name, entry); }
        entry.amounts[colKeyStr] = (entry.amounts[colKeyStr] || 0) + value;
        entry.total += value;
      });
    });
  };

  entries.forEach((entry, i) => {
    const ck = cols[i]?.key;
    if (!ck) return;
    ingest(entry?.vendorsByAccount, ck, "vendors");
    ingest(entry?.customersByAccount, ck, "customers");
  });

  const finalize = (map) =>
    Array.from(map.values())
      .map((e) => ({ ...e, total: Math.round(e.total * 100) / 100 }))
      // Drop counterparties that net to zero across the whole visible range —
      // they add rows without adding information (matches the backend's own rule).
      .filter((e) => Math.abs(e.total) >= 0.005)
      .sort((a, b) => Math.abs(b.total) - Math.abs(a.total) || a.name.localeCompare(b.name));

  const cache = new Map();
  return (accountName) => {
    if (cache.has(accountName)) return cache.get(accountName);
    const perAccount = index.get(accountName);
    const result = perAccount
      ? { vendors: finalize(perAccount.vendors), customers: finalize(perAccount.customers) }
      : { vendors: [], customers: [] };
    cache.set(accountName, result);
    return result;
  };
}

function buildBalanceSheet(entries, cols) {
  const colKey = (i) => cols[i].key;
  const per = (pick) => entries.map((e, i) => ({ colKey: colKey(i), value: pick(e.statement || {}) }));

  // The backend's hierarchy root is already self-describing (its own name
  // comes straight from chart_of_accounts level_1, e.g. "Total Assets") and
  // already carries its own rolled-up "Total …" child — used directly as the
  // top-level row(s), with no extra hardcoded "Assets"/"Liabilities" wrapper
  // or redundant appended total layered on top of it.
  // Balance Sheet accounts get the same counterparty sub-rows as P&L when the
  // period carries them — the payload shape is identical, so no separate path.
  const entityIndex = buildEntityIndex(entries, cols);
  const assetRows  = mergeDynamicHierarchy(entries, colKey, (s) => s.assets?.hierarchy, "bs-a", entityIndex);
  const liabRows   = mergeDynamicHierarchy(entries, colKey, (s) => s.liabilities?.hierarchy, "bs-l", entityIndex);
  // Same genuine, arbitrary-depth merge as assets/liabilities above — equity's
  // own document sub-headings (e.g. "Owner's Equity" > "Capital") survive as
  // real nested rows instead of collapsing into one flat account list.
  const equityRows = mergeDynamicHierarchy(entries, colKey, (s) => s.equity?.hierarchy, "bs-eq", entityIndex);
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
