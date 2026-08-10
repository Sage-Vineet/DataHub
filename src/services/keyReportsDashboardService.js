/**
 * Key Reports Dashboard Service
 *
 * Powers the Analytics page when the active connection mode is "Key Reports",
 * mirroring what reportService.js does for QuickBooks Online — same 12 KPI
 * cards, same Financial Trends chart shape, same Key Insights inputs — but
 * sourced from the selected Key Reports version's generated financial
 * statements instead of the QuickBooks API:
 *
 *   GET /key-reports/versions/:versionId/reports/financial-statements?currency=USD
 *
 * The whole payload (every fiscal year the version covers) is fetched ONCE and
 * cached in sessionStorage, then every filter — year, month, custom date range,
 * Monthly/Quarterly — is applied client-side against it. That keeps all the
 * existing filter controls instant and working without a refetch per change.
 *
 * ── Flow vs. stock ─────────────────────────────────────────────────────────
 * P&L figures (revenue, expenses, net profit) are FLOW measures: summed across
 * every month inside the selected range. Balance Sheet figures (assets,
 * liabilities, equity, cash, A/R, inventory, A/P, long-term debt) are STOCK
 * measures: read from the latest month at or before the range end — i.e. "as
 * of" the end date, which is how QuickBooks reports a Balance Sheet too.
 * Summing balances across months would be meaningless.
 *
 * ── Classification ─────────────────────────────────────────────────────────
 * Spot accounts (cash, A/R, inventory, A/P, long-term debt) are resolved from
 * the `reportTag` the Chart of Accounts pipeline already assigned at
 * classification time — never by scanning account names here. This mirrors
 * getKpiReport() in backend/src/services/keyReports/keyReportReportService.js
 * exactly, so a KPI shown here matches the backend's own figure for the same
 * version.
 */

import {
  ArrowDownToLine,
  ArrowUpToLine,
  Building2,
  CircleDollarSign,
  CreditCard,
  Landmark,
  Package,
  PiggyBank,
  RefreshCw,
  Scale,
  TrendingUp,
  Wallet,
} from "lucide-react";
import { getFinancialStatements } from "../lib/api";
import { readCachedFinancials, writeCachedFinancials } from "../lib/keyReportFinancials";

const MONTH_ABBR = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function safeNum(value) {
  const n = typeof value === "number" ? value : parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

function formatMoney(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(safeNum(value));
}

/** "YYYY-MM" for a statement period entry, or null when it carries no month. */
function monthKeyOf(entry) {
  const year = Number(entry?.year);
  const monthNumber = Number(entry?.monthNumber);
  if (!Number.isInteger(year) || !(monthNumber >= 1 && monthNumber <= 12)) return null;
  return `${year}-${String(monthNumber).padStart(2, "0")}`;
}

/** "YYYY-MM-DD" (or any ISO-ish date) → "YYYY-MM". */
function monthKeyOfDate(value) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}/.test(text) ? text.slice(0, 7) : null;
}

/**
 * Sums the accounts carrying `tag` — the stored COA classification, not a name
 * match. Mirrors sumAccountsByTag() in keyReportReportService.js.
 */
function sumAccountsByTag(accounts, tag) {
  let total = 0;
  for (const account of accounts || []) {
    if (account?.reportTag === tag) total += safeNum(account.amount);
  }
  return total;
}

/** Flattens `{ [groupLabel]: { accounts: [...] } }` into one account array. */
function groupAccounts(bucket) {
  return Object.values(bucket?.groups || {}).flatMap((group) => group?.accounts || []);
}

/**
 * Every Balance Sheet KPI for one period, from that period's `statement`.
 * Field-for-field the same derivation as the backend's getKpiReport().
 */
function balanceSheetMetrics(statement) {
  const bss = statement || {};

  const totalAssets = safeNum(bss.totalAssets);
  const totalLiabilities = safeNum(bss.liabilities?.total);
  const totalEquity = safeNum(bss.equity?.total);

  const currentAssets = safeNum(bss.assets?.currentAssets?.total);
  const currentLiabilities = safeNum(bss.liabilities?.currentLiabilities?.total);
  const longTermLiabilities = safeNum(bss.liabilities?.longTermLiabilities?.total);

  // Cash / A/R / inventory can sit under either current or other assets.
  const currentAssetAccounts = [
    ...groupAccounts(bss.assets?.currentAssets),
    ...groupAccounts(bss.assets?.otherAssets),
  ];
  const currentLiabilityAccounts = groupAccounts(bss.liabilities?.currentLiabilities);
  const longTermLiabilityAccounts = groupAccounts(bss.liabilities?.longTermLiabilities);

  return {
    totalAssets,
    totalLiabilities,
    totalEquity,
    workingCapital: currentAssets - currentLiabilities,
    cashAndBankBalance: sumAccountsByTag(currentAssetAccounts, "cash"),
    accountsReceivable: sumAccountsByTag(currentAssetAccounts, "accounts_receivable"),
    inventoryValue: sumAccountsByTag(currentAssetAccounts, "inventory"),
    accountsPayable: sumAccountsByTag(currentLiabilityAccounts, "accounts_payable"),
    // Prefer the section total; fall back to tagged accounts when the version's
    // COA has no dedicated long-term liabilities section.
    longTermDebt:
      longTermLiabilities || sumAccountsByTag(longTermLiabilityAccounts, "long_term_debt"),
  };
}

/**
 * P&L figures for one period. `expenses` is cost of sales plus operating
 * expenses — the full cost base behind the "Total operating costs" card.
 * `netProfit` uses the statement's own bottom line rather than a re-derivation,
 * so it stays consistent with the Reports page for the same version.
 */
function profitAndLossMetrics(statement) {
  const stmt = statement || {};
  return {
    revenue: safeNum(stmt.revenue?.total),
    expenses: safeNum(stmt.costOfSales?.total) + safeNum(stmt.operatingExpenses?.total),
    netProfit: safeNum(stmt.netIncome),
  };
}

function buildKpiCards(kpis = {}) {
  return [
    {
      label: "Total Revenue",
      value: formatMoney(kpis.revenue),
      rawValue: safeNum(kpis.revenue),
      desc: "Total gross income",
      color: "#8bc53d",
      icon: CircleDollarSign,
    },
    {
      label: "Total Expenses",
      value: formatMoney(kpis.expenses),
      rawValue: safeNum(kpis.expenses),
      desc: "Total operating costs",
      color: "#C62026",
      icon: CreditCard,
    },
    {
      label: "Net Profit",
      value: formatMoney(kpis.netProfit),
      rawValue: safeNum(kpis.netProfit),
      desc: "Bottom-line earnings",
      color: "#00648F",
      icon: TrendingUp,
    },
    {
      label: "Total Assets",
      value: formatMoney(kpis.totalAssets),
      rawValue: safeNum(kpis.totalAssets),
      desc: "Company's total valuation",
      color: "#8bc53d",
      icon: Building2,
    },
    {
      label: "Total Liabilities",
      value: formatMoney(kpis.totalLiabilities),
      rawValue: safeNum(kpis.totalLiabilities),
      desc: "Current total obligations",
      color: "#F68C1F",
      icon: Wallet,
    },
    {
      label: "Total Equity",
      value: formatMoney(kpis.totalEquity),
      rawValue: safeNum(kpis.totalEquity),
      desc: "Net asset value",
      color: "#00648F",
      icon: Scale,
    },
    {
      label: "Working Capital",
      value: formatMoney(kpis.workingCapital),
      rawValue: safeNum(kpis.workingCapital),
      desc: "Available operating liquidity",
      color: "#8bc53d",
      icon: RefreshCw,
    },
    {
      label: "Cash & Bank Balance",
      value: formatMoney(kpis.cashAndBankBalance),
      rawValue: safeNum(kpis.cashAndBankBalance),
      desc: "Liquid funds available",
      color: "#8bc53d",
      icon: PiggyBank,
    },
    {
      label: "Account Receivable",
      value: formatMoney(kpis.accountsReceivable),
      rawValue: safeNum(kpis.accountsReceivable),
      desc: "Unpaid client invoices",
      color: "#00A3FF",
      icon: ArrowDownToLine,
    },
    {
      label: "Inventory Value",
      value: formatMoney(kpis.inventoryValue),
      rawValue: safeNum(kpis.inventoryValue),
      desc: "Current stock valuation",
      color: "#6D6E71",
      icon: Package,
    },
    {
      label: "Account Payable",
      value: formatMoney(kpis.accountsPayable),
      rawValue: safeNum(kpis.accountsPayable),
      desc: "Outstanding vendor bills",
      color: "#EF4444",
      icon: ArrowUpToLine,
    },
    {
      label: "Long-Term Debt",
      value: formatMoney(kpis.longTermDebt),
      rawValue: safeNum(kpis.longTermDebt),
      desc: "Non-current liabilities",
      color: "#DC2626",
      icon: Landmark,
    },
  ];
}

/**
 * Fetches (or reuses the cached) financial statements for a version — the whole
 * payload, every fiscal year, so all filters can run client-side afterwards.
 */
export async function loadKeyReportFinancials(versionId, { clientId, force = false } = {}) {
  if (!versionId) return null;
  if (!force) {
    const cached = readCachedFinancials(clientId, versionId);
    if (cached) return cached;
  }
  const payload = await getFinancialStatements(versionId, { currency: "USD" });
  if (payload) writeCachedFinancials(clientId, versionId, payload);
  return payload;
}

/** Fiscal years present in a financial-statements payload, ascending. */
export function keyReportAvailableYears(financials) {
  const years = new Set();
  for (const entry of financials?.reports?.profitAndLoss?.yearly || []) {
    const year = Number(entry?.year);
    if (Number.isInteger(year)) years.add(year);
  }
  for (const entry of financials?.reports?.balanceSheet?.yearly || []) {
    const year = Number(entry?.year);
    if (Number.isInteger(year)) years.add(year);
  }
  return [...years].sort((a, b) => a - b);
}

/**
 * The 12 KPI cards for a date range.
 *
 * P&L is summed across every month in [startDate, endDate]; the Balance Sheet
 * is read as of the latest month at or before endDate (see the flow-vs-stock
 * note at the top of this file).
 */
export function buildKeyReportKpis(financials, { startDate, endDate } = {}) {
  const startKey = monthKeyOfDate(startDate);
  const endKey = monthKeyOfDate(endDate);
  const inRange = (key) =>
    Boolean(key) && (!startKey || key >= startKey) && (!endKey || key <= endKey);

  // ── P&L: sum the months inside the range ────────────────────────────────
  const plMonthly = financials?.reports?.profitAndLoss?.monthly || [];
  const totals = { revenue: 0, expenses: 0, netProfit: 0 };
  let matchedMonths = 0;
  for (const entry of plMonthly) {
    if (!inRange(monthKeyOf(entry))) continue;
    const metrics = profitAndLossMetrics(entry.statement);
    totals.revenue += metrics.revenue;
    totals.expenses += metrics.expenses;
    totals.netProfit += metrics.netProfit;
    matchedMonths += 1;
  }

  // A version whose P&L is yearly-only (no monthly breakdown) still has to show
  // figures: fall back to the yearly statements overlapping the range.
  if (!matchedMonths) {
    for (const entry of financials?.reports?.profitAndLoss?.yearly || []) {
      const year = Number(entry?.year);
      if (!Number.isInteger(year)) continue;
      if (startKey && `${year}-12` < startKey) continue;
      if (endKey && `${year}-01` > endKey) continue;
      const metrics = profitAndLossMetrics(entry.statement);
      totals.revenue += metrics.revenue;
      totals.expenses += metrics.expenses;
      totals.netProfit += metrics.netProfit;
    }
  }

  // ── Balance Sheet: latest period at or before the range end ─────────────
  const bsMonthly = financials?.reports?.balanceSheet?.monthly || [];
  let asOf = null;
  let asOfKey = "";
  for (const entry of bsMonthly) {
    const key = monthKeyOf(entry);
    if (!key) continue;
    if (endKey && key > endKey) continue;
    if (!asOfKey || key > asOfKey) {
      asOfKey = key;
      asOf = entry;
    }
  }
  if (!asOf) {
    // No monthly Balance Sheet at or before the range end — fall back to the
    // latest yearly snapshot that isn't after it.
    let bestYear = null;
    for (const entry of financials?.reports?.balanceSheet?.yearly || []) {
      const year = Number(entry?.year);
      if (!Number.isInteger(year)) continue;
      if (endKey && `${year}-01` > endKey) continue;
      if (bestYear === null || year > bestYear) {
        bestYear = year;
        asOf = entry;
      }
    }
  }

  return buildKpiCards({ ...totals, ...balanceSheetMetrics(asOf?.statement) });
}

/**
 * Financial Trends buckets in the shape the chart already consumes:
 * `{ name, fullLabel, revenue, expenses }`, ascending by period.
 */
export function buildKeyReportTrends(
  financials,
  { startDate, endDate, aggregationType = "monthly" } = {},
) {
  const startKey = monthKeyOfDate(startDate);
  const endKey = monthKeyOfDate(endDate);
  const quarterly = aggregationType === "quarterly";

  const buckets = new Map();
  for (const entry of financials?.reports?.profitAndLoss?.monthly || []) {
    const key = monthKeyOf(entry);
    if (!key) continue;
    if (startKey && key < startKey) continue;
    if (endKey && key > endKey) continue;

    const year = Number(entry.year);
    const monthNumber = Number(entry.monthNumber);
    const bucketKey = quarterly
      ? `${year}-Q${Math.ceil(monthNumber / 3)}`
      : key;

    let bucket = buckets.get(bucketKey);
    if (!bucket) {
      const name = quarterly ? `Q${Math.ceil(monthNumber / 3)}` : MONTH_ABBR[monthNumber - 1];
      bucket = {
        sortKey: quarterly ? `${year}-${Math.ceil(monthNumber / 3)}` : key,
        name,
        fullLabel: `${name} ${year}`,
        revenue: 0,
        expenses: 0,
      };
      buckets.set(bucketKey, bucket);
    }

    const metrics = profitAndLossMetrics(entry.statement);
    bucket.revenue += metrics.revenue;
    bucket.expenses += metrics.expenses;
  }

  return [...buckets.values()]
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey, undefined, { numeric: true }))
    .map(({ name, fullLabel, revenue, expenses }) => ({ name, fullLabel, revenue, expenses }));
}

/**
 * One-call load used by the Analytics page: returns the KPI cards, the trend
 * buckets and the version's fiscal years for the given filter state.
 */
export async function loadKeyReportsDashboard(versionId, options = {}) {
  const {
    clientId,
    startDate,
    endDate,
    chartStartDate,
    chartEndDate,
    aggregationType = "monthly",
    force = false,
  } = options;

  const financials = await loadKeyReportFinancials(versionId, { clientId, force });
  if (!financials) {
    return { kpis: buildKpiCards({}), trends: [], availableYears: [], financials: null };
  }

  return {
    kpis: buildKeyReportKpis(financials, { startDate, endDate }),
    trends: buildKeyReportTrends(financials, {
      startDate: chartStartDate || startDate,
      endDate: chartEndDate || endDate,
      aggregationType,
    }),
    availableYears: keyReportAvailableYears(financials),
    financials,
  };
}
