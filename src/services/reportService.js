import {
  ArrowDownToLine,
  ArrowUpToLine,
  Building2,
  CircleDollarSign,
  CreditCard,
  Landmark,
  Package,
  PiggyBank,
  TrendingUp,
  RefreshCw,
  Scale,
  Wallet,
} from "lucide-react";
import {
  fetchBalanceSheet,
  fetchProfitAndLoss,
  fetchQuickbooksInvoices,
} from "../lib/quickbooks";
import {
  getManualGlBalanceSheet,
  getManualStagedProfitLossSummary,
  getStoredToken,
} from "../lib/api";

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

async function request(path) {
  const clientId = resolveClientIdFromLocation();
  const token = getStoredToken();

  const response = await fetch(`${API_BASE_URL}${path}`, {
    credentials: "include",
    cache: "no-store",
    headers: {
      ...(clientId ? { "X-Client-Id": clientId } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });

  if (response.status === 403) {
    return null;
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      payload?.message ||
      payload?.error ||
      `Request failed: ${response.status}`,
    );
  }

  return payload;
}

function buildQuery(params = {}) {
  const search = new URLSearchParams(
    Object.entries(params).filter(
      ([, value]) => value !== undefined && value !== null && value !== "",
    ),
  );
  return search.toString() ? `?${search.toString()}` : "";
}

function parseNumeric(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  const negativeByParens = trimmed.includes("(") && trimmed.includes(")");
  const numeric = Number(trimmed.replace(/[^0-9.-]/g, ""));
  if (!Number.isFinite(numeric)) return null;

  return negativeByParens ? -Math.abs(numeric) : numeric;
}

function toNumber(value) {
  return parseNumeric(value) ?? 0;
}

function formatMoney(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(value || 0));
}

function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseInputDate(value, fallback) {
  if (!value || typeof value !== "string") {
    return new Date(fallback);
  }

  const [year, month, day] = value.split("-").map((part) => Number(part));
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  ) {
    return new Date(fallback);
  }

  return new Date(year, month - 1, day);
}

function flattenRows(rows = []) {
  return rows.flatMap((row) => [
    row,
    ...(row?.Rows?.Row ? flattenRows(row.Rows.Row) : []),
  ]);
}

function unwrapReportPayload(payload) {
  let current = payload;

  for (let depth = 0; depth < 6; depth += 1) {
    if (!current || typeof current !== "object") break;

    if (current?.Rows?.Row) return current;

    const d = current?.data;
    if (d && typeof d === "object") {
      current = d;
      continue;
    }
    // Handle double-serialized JSON stored as a string in the DB
    if (d && typeof d === "string") {
      try {
        const parsed = JSON.parse(d);
        if (parsed && typeof parsed === "object") { current = parsed; continue; }
      } catch { /* not valid JSON */ }
    }

    break;
  }

  return payload;
}

function getRows(payload) {
  const report = unwrapReportPayload(payload);
  return (
    report?.Rows?.Row ||
    payload?.Rows?.Row ||
    payload?.data?.Rows?.Row ||
    payload?.data?.data?.Rows?.Row ||
    payload?.data?.data?.data?.Rows?.Row ||
    []
  );
}

function normalizeLabel(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function getRowLabel(row) {
  return (
    row?.Summary?.ColData?.[0]?.value ||
    row?.Header?.ColData?.[0]?.value ||
    row?.ColData?.[0]?.value ||
    ""
  );
}

function getRowNumericValue(row) {
  const candidates = [...(row?.Summary?.ColData || []), ...(row?.ColData || [])]
    .map((item) => parseNumeric(item?.value))
    .filter((value) => value !== null);

  return candidates.length ? candidates[candidates.length - 1] : null;
}

function findValueByLabel(payload, matchers = []) {
  const rows = flattenRows(getRows(payload)).reverse();
  const normalizedMatchers = matchers.map((matcher) => normalizeLabel(matcher));

  for (const row of rows) {
    const label = normalizeLabel(getRowLabel(row));
    const value = getRowNumericValue(row);
    if (value === null) continue;

    if (normalizedMatchers.some((matcher) => label.includes(matcher))) {
      return value;
    }
  }

  return null;
}

function findValueByExactLabel(payload, labels = []) {
  const targets = labels.map(normalizeLabel);
  const rows = flattenRows(getRows(payload)).reverse();

  for (const row of rows) {
    const label = normalizeLabel(getRowLabel(row));
    if (!targets.includes(label)) continue;

    const value = getRowNumericValue(row);
    if (value !== null) return value;
  }

  return null;
}

function findValueByGroup(payload, groups = []) {
  const targets = groups.map((group) => String(group || "").toLowerCase());
  const rows = flattenRows(getRows(payload)).reverse();

  for (const row of rows) {
    const group = String(row?.group || "").toLowerCase();
    if (!targets.includes(group)) continue;

    const value = getRowNumericValue(row);
    if (value !== null) return value;
  }

  return null;
}

function findSummaryTotal(payload, matchers = []) {
  const rows = flattenRows(getRows(payload)).reverse();
  const normalizedMatchers = matchers.map((matcher) => normalizeLabel(matcher));

  for (const row of rows) {
    const label = normalizeLabel(getRowLabel(row));
    const candidates = [
      ...(row?.Summary?.ColData || []),
      ...(row?.ColData || []),
    ]
      .map((item) => parseNumeric(item?.value))
      .filter((value) => value !== null);

    if (candidates.length === 0) continue;

    if (
      normalizedMatchers.length === 0 ||
      normalizedMatchers.some((matcher) =>
        label.includes(matcher),
      )
    ) {
      return candidates[candidates.length - 1];
    }
  }

  return null;
}

// Returns true when QuickBooks signals that no report data exists for the
// requested period (Header.Option contains {Name:"NoReportData",Value:"true"}).
// This happens for future months and should NOT be treated as revenue=0.
function hasNoReportData(payload) {
  if (!payload || typeof payload !== "object") return false;
  let current = payload;
  for (let depth = 0; depth < 6; depth += 1) {
    if (!current || typeof current !== "object") break;
    const header = current.Header;
    if (header && typeof header === "object") {
      const opts = Array.isArray(header.Option)
        ? header.Option
        : header.Option
          ? [header.Option]
          : [];
      if (opts.some(
        (o) => String(o?.Name || "").trim() === "NoReportData" &&
               String(o?.Value || "").trim().toLowerCase() === "true",
      )) return true;
    }
    const d = current.data;
    if (d && typeof d === "object") { current = d; } else break;
  }
  return false;
}

function extractProfitAndLossTotals(payload) {
  const revenue =
    findValueByExactLabel(payload, [
      "Total Income",
      "Total Revenue",
      "Total Income and Other Income",
      "Total Gross Profit",
    ]) ??
    findValueByGroup(payload, ["Income", "GrossProfit", "OtherIncome"]) ??
    findValueByLabel(payload, [
      "total income",
      "total revenue",
      "income and other income",
      "gross profit",
    ]);
  const expenses =
    findValueByExactLabel(payload, ["Total Expenses", "Total Operating Expenses"]) ??
    findValueByGroup(payload, ["Expenses", "OtherExpenses"]) ??
    findValueByLabel(payload, ["total expenses", "total operating expenses"]);
  const netProfit =
    findValueByExactLabel(payload, [
      "Net Income",
      "Net Profit",
      "Net Operating Income",
      "Net Earnings",
    ]) ??
    findValueByGroup(payload, ["NetIncome"]) ??
    findValueByLabel(payload, ["net income", "net profit", "net operating income", "net earnings"]);

  const safeRevenue = revenue ?? 0;
  const safeExpenses = expenses ?? 0;
  const safeNetProfit =
    netProfit ?? (safeRevenue !== 0 || safeExpenses !== 0 ? safeRevenue - safeExpenses : 0);

  return {
    revenue: safeRevenue,
    expenses: safeExpenses,
    netProfit: safeNetProfit,
    hasRevenue: revenue !== null,
    hasExpenses: expenses !== null,
    hasNetProfit: netProfit !== null,
  };
}

async function fetchCombinedReports(params = {}) {
  return request(`/all-reports${buildQuery(params)}`);
}

const MAX_CHART_REQUESTS = 12;
const TREND_FETCH_CONCURRENCY = 4;

async function mapWithConcurrency(items, mapper, concurrency = 4) {
  const list = Array.isArray(items) ? items : [];
  const safeConcurrency = Math.max(1, Math.min(concurrency, list.length || 1));
  const results = new Array(list.length);
  let cursor = 0;

  const worker = async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= list.length) return;
      results[index] = await mapper(list[index], index);
    }
  };

  await Promise.all(
    Array.from({ length: safeConcurrency }, () => worker()),
  );

  return results;
}

function getAccountListRows(payload) {
  const report = unwrapReportPayload(payload);
  return (
    report?.accountList?.Rows?.Row ||
    report?.AccountList?.Rows?.Row ||
    payload?.accountList?.Rows?.Row ||
    payload?.AccountList?.Rows?.Row ||
    payload?.data?.accountList?.Rows?.Row ||
    payload?.data?.AccountList?.Rows?.Row ||
    payload?.data?.data?.accountList?.Rows?.Row ||
    payload?.data?.data?.AccountList?.Rows?.Row ||
    []
  );
}

function findAccountBalance(payload, matchers = []) {
  const targets = matchers.map((matcher) => normalizeLabel(matcher));

  for (const row of getAccountListRows(payload)) {
    const label = normalizeLabel(row?.ColData?.[0]?.value);
    const detailType = normalizeLabel(row?.ColData?.[2]?.value);

    if (
      targets.some(
        (target) => label.includes(target) || detailType.includes(target),
      )
    ) {
      return Math.abs(toNumber(row?.ColData?.[4]?.value));
    }
  }

  return null;
}

function pickFirstNumber(...values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return 0;
}

function findManualLineValue(payload = {}, label = "") {
  const target = normalizeLabel(label);
  const lines = Array.isArray(payload?.lines) ? payload.lines : [];
  const line = lines.find((item) => normalizeLabel(item?.label) === target);
  return toNumber(line?.consolidated);
}

function extractManualProfitAndLossTotals(payload = {}) {
  const revenue = findManualLineValue(payload, "Revenue");
  const cogs = findManualLineValue(payload, "COGS");
  const operatingExpenses = findManualLineValue(payload, "Operating Expenses");
  const otherExpenses = findManualLineValue(payload, "Other Expenses");
  const netProfit = findManualLineValue(payload, "Net Profit");

  return {
    revenue,
    expenses: roundMoney(cogs + operatingExpenses + otherExpenses),
    netProfit,
  };
}

function getLatestManualYear(payload = {}) {
  const years = Array.isArray(payload?.years)
    ? payload.years.map((year) => Number(year)).filter((year) => Number.isInteger(year))
    : [];
  if (years.length === 0) return null;
  return Math.max(...years);
}

function findManualSectionTotal(payload = {}, sectionKey = "", year = null) {
  if (!year) return 0;
  const section = payload?.sections?.[sectionKey];
  return toNumber(section?.totalByYear?.[year]);
}

function findManualAmountByMatchers(payload = {}, sectionKey = "", year = null, matchers = []) {
  if (!year) return 0;
  const section = payload?.sections?.[sectionKey];
  if (!section || !Array.isArray(section.categories)) return 0;

  const targets = matchers.map((matcher) => normalizeLabel(matcher));

  let total = 0;
  section.categories.forEach((category) => {
    const categoryLabel = normalizeLabel(category?.label);
    const categoryMatch = targets.some((target) => categoryLabel.includes(target));

    if (categoryMatch) {
      total += toNumber(category?.totalByYear?.[year]);
      return;
    }

    const accounts = Array.isArray(category?.accounts) ? category.accounts : [];
    accounts.forEach((account) => {
      const accountName = normalizeLabel(account?.name);
      const accountNumber = normalizeLabel(account?.number);
      if (
        targets.some(
          (target) => accountName.includes(target) || accountNumber.includes(target),
        )
      ) {
        total += toNumber(account?.balancesByYear?.[year]);
      }
    });
  });

  return roundMoney(total);
}

function roundMoney(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function buildDashboardCards({
  revenue = 0,
  expenses = 0,
  netProfit = 0,
  totalAssets = 0,
  totalLiabilities = 0,
  totalEquity = 0,
  workingCapital = 0,
  cashBank = 0,
  receivable = 0,
  inventoryValue = 0,
  accountPayable = 0,
  longTermDebt = 0,
}) {
  const cards = [
    {
      label: "Total Revenue",
      value: formatMoney(revenue),
      rawValue: revenue,
      desc: "Total gross income",
      color: "#8bc53d",
      icon: CircleDollarSign,
    },
    {
      label: "Total Expenses",
      value: formatMoney(expenses),
      rawValue: expenses,
      desc: "Total operating costs",
      color: "#C62026",
      icon: CreditCard,
    },
    {
      label: "Net Profit",
      value: formatMoney(netProfit),
      rawValue: netProfit,
      desc: "Bottom-line earnings",
      color: "#00648F",
      icon: TrendingUp,
    },
    {
      label: "Total Assets",
      value: formatMoney(totalAssets),
      rawValue: totalAssets,
      desc: "Company's total valuation",
      color: "#8bc53d",
      icon: Building2,
    },
    {
      label: "Total Liabilities",
      value: formatMoney(totalLiabilities),
      rawValue: totalLiabilities,
      desc: "Current total obligations",
      color: "#F68C1F",
      icon: Wallet,
    },
    {
      label: "Total Equity",
      value: formatMoney(totalEquity),
      rawValue: totalEquity,
      desc: "Net asset value",
      color: "#00648F",
      icon: Scale,
    },
    {
      label: "Working Capital",
      value: formatMoney(workingCapital),
      rawValue: workingCapital,
      desc: "Available operating liquidity",
      color: "#8bc53d",
      icon: RefreshCw,
    },
    {
      label: "Cash & Bank Balance",
      value: formatMoney(cashBank),
      rawValue: cashBank,
      desc: "Liquid funds available",
      color: "#8bc53d",
      icon: PiggyBank,
    },
    {
      label: "Account Receivable",
      value: formatMoney(receivable),
      rawValue: receivable,
      desc: "Unpaid client invoices",
      color: "#00A3FF",
      icon: ArrowDownToLine,
    },
    {
      label: "Inventory Value",
      value: formatMoney(inventoryValue),
      rawValue: inventoryValue,
      desc: "Current stock valuation",
      color: "#6D6E71",
      icon: Package,
    },
    {
      label: "Account Payable",
      value: formatMoney(accountPayable),
      rawValue: accountPayable,
      desc: "Outstanding vendor bills",
      color: "#EF4444",
      icon: ArrowUpToLine,
    },
    {
      label: "Long-Term Debt",
      value: formatMoney(longTermDebt),
      rawValue: longTermDebt,
      desc: "Non-current liabilities",
      color: "#DC2626",
      icon: Landmark,
    },
  ];

  return cards.map((card) => ({
    ...card,
    rawValue: Number(card.rawValue || 0),
  }));
}

function buildTrendBuckets(start, end, aggregationType) {
  const currentYear = new Date().getFullYear();
  const startDate = parseInputDate(start, new Date(currentYear, 0, 1));
  const endDate = parseInputDate(end, new Date(currentYear, 11, 31));
  const isFullYearRange =
    startDate.getFullYear() === endDate.getFullYear() &&
    startDate.getMonth() === 0 &&
    startDate.getDate() === 1 &&
    endDate.getMonth() === 11 &&
    endDate.getDate() === 31;
  const buckets = [];
  const cursor = new Date(startDate.getFullYear(), startDate.getMonth(), 1);

  if (aggregationType === "monthly" && isFullYearRange) {
    for (let monthIndex = 0; monthIndex < 12; monthIndex += 1) {
      const bucketStart = new Date(startDate.getFullYear(), monthIndex, 1);
      const bucketEnd = new Date(startDate.getFullYear(), monthIndex + 1, 0);
      const shortName = bucketStart.toLocaleDateString("en-US", {
        month: "short",
      });

      buckets.push({
        name: shortName,
        shortName,
        fullLabel: bucketStart.toLocaleDateString("en-US", {
          month: "short",
          year: "numeric",
        }),
        start: formatLocalDate(bucketStart),
        end: formatLocalDate(bucketEnd),
      });
    }

    return buckets;
  }

  while (cursor <= endDate) {
    const bucketStart = new Date(cursor);
    let bucketEnd;
    let name;

    if (aggregationType === "quarterly") {
      const quarter = Math.floor(bucketStart.getMonth() / 3) + 1;
      bucketEnd = new Date(bucketStart.getFullYear(), quarter * 3, 0);
      name = `Q${quarter} ${bucketStart.getFullYear()}`;
      cursor.setMonth(cursor.getMonth() + 3);
    } else {
      bucketEnd = new Date(
        bucketStart.getFullYear(),
        bucketStart.getMonth() + 1,
        0,
      );
      name = bucketStart.toLocaleDateString("en-US", { month: "short" });
      cursor.setMonth(cursor.getMonth() + 1);
    }

    if (bucketEnd > endDate) bucketEnd.setTime(endDate.getTime());

    buckets.push({
      name,
      shortName:
        aggregationType === "quarterly"
          ? name
          : bucketStart.toLocaleDateString("en-US", { month: "short" }),
      fullLabel:
        aggregationType === "quarterly"
          ? name
          : bucketStart.toLocaleDateString("en-US", {
            month: "short",
            year: "numeric",
          }),
      start: formatLocalDate(bucketStart),
      end: formatLocalDate(bucketEnd),
    });
  }

  return buckets;
}

export async function fetchDashboardKPIs(start, end, options = {}) {
  const sourceMode = options?.sourceMode === "manual" ? "manual" : "quickbooks";
  const params =
    start || end
      ? {
        ...(start ? { start_date: start } : {}),
        ...(end ? { end_date: end } : {}),
      }
      : {};

  if (sourceMode === "manual") {
    const manualParams =
      start || end
        ? {
          ...(start ? { startDate: start } : {}),
          ...(end ? { endDate: end } : {}),
          ...(options?.datasetVersion ? { datasetVersion: String(options.datasetVersion) } : {}),
        }
        : {
          ...(options?.datasetVersion ? { datasetVersion: String(options.datasetVersion) } : {}),
        };

    const [profitAndLossPayload, balanceSheetPayload] = await Promise.all([
      getManualStagedProfitLossSummary({ params: manualParams }).catch(() => null),
      getManualGlBalanceSheet({ params: manualParams }).catch(() => null),
    ]);

    const pnlTotals = extractManualProfitAndLossTotals(profitAndLossPayload || {});
    const latestYear = getLatestManualYear(balanceSheetPayload || {});
    const manualBalanceSchema =
      balanceSheetPayload?.quickbooksSchema ||
      balanceSheetPayload?.data ||
      balanceSheetPayload ||
      {};

    const totalAssets = pickFirstNumber(
      findManualSectionTotal(balanceSheetPayload, "Assets", latestYear),
      findValueByGroup(manualBalanceSchema, ["TotalAssets"]),
      findValueByExactLabel(manualBalanceSchema, ["Total Assets", "TOTAL ASSETS"]),
    );
    const totalLiabilities = pickFirstNumber(
      findManualSectionTotal(balanceSheetPayload, "Liabilities", latestYear),
      findValueByGroup(manualBalanceSchema, ["Liabilities"]),
      findValueByExactLabel(manualBalanceSchema, ["Total Liabilities"]),
    );
    const totalEquity = pickFirstNumber(
      findManualSectionTotal(balanceSheetPayload, "Equity", latestYear),
      findValueByGroup(manualBalanceSchema, ["Equity"]),
      findValueByExactLabel(manualBalanceSchema, ["Total Equity"]),
    );
    const currentAssets = pickFirstNumber(
      findManualAmountByMatchers(balanceSheetPayload, "Assets", latestYear, [
        "current asset",
      ]),
      findValueByGroup(manualBalanceSchema, ["CurrentAssets"]),
      findValueByExactLabel(manualBalanceSchema, ["Total Current Assets"]),
    );
    const currentLiabilities = pickFirstNumber(
      findManualAmountByMatchers(
        balanceSheetPayload,
        "Liabilities",
        latestYear,
        ["current liabilit"],
      ),
      findValueByGroup(manualBalanceSchema, ["CurrentLiabilities"]),
      findValueByExactLabel(manualBalanceSchema, ["Total Current Liabilities"]),
    );
    const cashBank = pickFirstNumber(
      findManualAmountByMatchers(balanceSheetPayload, "Assets", latestYear, [
        "cash",
        "bank",
        "checking",
        "savings",
      ]),
      findValueByGroup(manualBalanceSchema, ["BankAccounts"]),
      findValueByExactLabel(manualBalanceSchema, [
        "Total Bank Accounts",
        "Total Cash and cash equivalents",
        "Total Cash and Cash Equivalents",
      ]),
    );
    const receivable = pickFirstNumber(
      findManualAmountByMatchers(balanceSheetPayload, "Assets", latestYear, [
        "receivable",
        "a/r",
      ]),
      findValueByGroup(manualBalanceSchema, ["AR"]),
      findValueByExactLabel(manualBalanceSchema, [
        "Total Accounts Receivable",
        "Total Accounts Receivable (A/R)",
      ]),
    );
    const inventoryValue = pickFirstNumber(
      findManualAmountByMatchers(balanceSheetPayload, "Assets", latestYear, [
        "inventory",
      ]),
      findValueByLabel(manualBalanceSchema, ["inventory asset", "inventory"]),
    );
    const accountPayable = pickFirstNumber(
      findManualAmountByMatchers(
        balanceSheetPayload,
        "Liabilities",
        latestYear,
        ["payable", "a/p"],
      ),
      findValueByGroup(manualBalanceSchema, ["AP"]),
      findValueByExactLabel(manualBalanceSchema, [
        "Total Accounts Payable",
        "Total Accounts Payable (A/P)",
      ]),
    );
    const longTermDebt = pickFirstNumber(
      findManualAmountByMatchers(
        balanceSheetPayload,
        "Liabilities",
        latestYear,
        ["long term", "long-term", "note payable", "loan"],
      ),
      findValueByGroup(manualBalanceSchema, ["LongTermLiabilities"]),
      findValueByExactLabel(manualBalanceSchema, [
        "Total Long-Term Liabilities",
        "Total Long Term Liabilities",
      ]),
    );

    const workingCapital =
      currentAssets !== 0 || currentLiabilities !== 0
        ? currentAssets - currentLiabilities
        : totalAssets - totalLiabilities;

    return buildDashboardCards({
      revenue: pnlTotals.revenue,
      expenses: pnlTotals.expenses,
      netProfit: pnlTotals.netProfit,
      totalAssets,
      totalLiabilities,
      totalEquity,
      workingCapital,
      cashBank,
      receivable,
      inventoryValue,
      accountPayable,
      longTermDebt,
    });
  }

  const [profitAndLoss, balanceSheet, combinedReports, invoicesPayload] =
    await Promise.all([
      fetchProfitAndLoss(params).catch(() => null),
      fetchBalanceSheet(params).catch(() => null),
      fetchCombinedReports(params).catch(() => null),
      fetchQuickbooksInvoices().catch(() => null),
    ]);

  const invoices =
    invoicesPayload?.QueryResponse?.Invoice ||
    invoicesPayload?.data?.QueryResponse?.Invoice ||
    [];
  const balanceSheetPayload =
    balanceSheet ||
    combinedReports?.balanceSheet ||
    combinedReports?.BalanceSheet ||
    null;

  const {
    revenue: reportRevenue,
    expenses,
    netProfit,
    hasRevenue,
    hasExpenses,
    hasNetProfit,
  } = extractProfitAndLossTotals(profitAndLoss || {});
  const invoiceRevenue = invoices.reduce(
    (sum, invoice) => sum + Number(invoice.TotalAmt || 0),
    0,
  );
  const revenue = hasRevenue ? reportRevenue : invoiceRevenue;
  const safeExpenses = hasExpenses ? expenses : 0;
  const safeNetProfit = hasNetProfit ? netProfit : revenue - safeExpenses;

  const totalAssets = pickFirstNumber(
    findValueByGroup(balanceSheetPayload, ["TotalAssets"]),
    findValueByExactLabel(balanceSheetPayload, ["TOTAL ASSETS", "Total Assets"]),
  );
  const totalLiabilities = pickFirstNumber(
    findValueByGroup(balanceSheetPayload, ["Liabilities"]),
    findValueByExactLabel(balanceSheetPayload, ["Total Liabilities"]),
  );
  const totalEquity = pickFirstNumber(
    findValueByGroup(balanceSheetPayload, ["Equity"]),
    findValueByExactLabel(balanceSheetPayload, ["Total Equity"]),
  );
  const currentAssets = pickFirstNumber(
    findValueByGroup(balanceSheetPayload, ["CurrentAssets"]),
    findValueByExactLabel(balanceSheetPayload, ["Total Current Assets"]),
  );
  const currentLiabilities = pickFirstNumber(
    findValueByGroup(balanceSheetPayload, ["CurrentLiabilities"]),
    findValueByExactLabel(balanceSheetPayload, ["Total Current Liabilities"]),
  );
  const payable = pickFirstNumber(
    findValueByGroup(balanceSheetPayload, ["AP"]),
    findAccountBalance(combinedReports, ["accounts payable"]),
    findValueByExactLabel(balanceSheetPayload, [
      "Total Accounts Payable",
      "Total Accounts Payable (A/P)",
    ]),
  );
  const cashBank = pickFirstNumber(
    findValueByGroup(balanceSheetPayload, ["BankAccounts"]),
    findAccountBalance(combinedReports, ["checking", "savings", "bank", "cash"]),
    findValueByExactLabel(balanceSheetPayload, [
      "Total Bank Accounts",
      "Total Cash and cash equivalents",
      "Total Cash and Cash Equivalents",
    ]),
  );
  const receivable = pickFirstNumber(
    findSummaryTotal(combinedReports?.agedReceivableDetail, [
      "total",
      "accounts receivable",
      "receivable",
    ]),
    findValueByGroup(balanceSheetPayload, ["AR"]),
    findAccountBalance(combinedReports, ["accounts receivable"]),
    findValueByExactLabel(balanceSheetPayload, [
      "Total Accounts Receivable",
      "Total Accounts Receivable (A/R)",
    ]),
    invoices.reduce((sum, invoice) => sum + Number(invoice.Balance || 0), 0),
  );
  const inventoryValue = pickFirstNumber(
    findAccountBalance(combinedReports, ["inventory"]),
    findValueByLabel(balanceSheetPayload, ["inventory asset", "inventory"]),
  );
  const agedPayable = findSummaryTotal(combinedReports?.agedPayableDetail, [
    "total",
    "accounts payable",
    "payable",
  ]);
  const longTermDebt = pickFirstNumber(
    findValueByGroup(balanceSheetPayload, ["LongTermLiabilities"]),
    findAccountBalance(combinedReports, ["notes payable", "long term"]),
    findValueByExactLabel(balanceSheetPayload, [
      "Total Long-Term Liabilities",
      "Total Long Term Liabilities",
    ]),
  );
  const accountPayable = pickFirstNumber(agedPayable, payable);
  const workingCapital =
    currentAssets && currentLiabilities
      ? currentAssets - currentLiabilities
      : cashBank + receivable + inventoryValue - accountPayable;

  return buildDashboardCards({
    revenue,
    expenses: safeExpenses,
    netProfit: safeNetProfit,
    totalAssets,
    totalLiabilities,
    totalEquity,
    workingCapital,
    cashBank,
    receivable,
    inventoryValue,
    accountPayable,
    longTermDebt,
  });
}

// ── Manual upload KPI helpers ──────────────────────────────────────────────

function flattenManualRows(rows = []) {
  const out = [];
  function walk(items) {
    for (const item of items) {
      if (item && typeof item === "object") {
        out.push(item);
        if (Array.isArray(item.children)) walk(item.children);
      }
    }
  }
  walk(rows);
  return out;
}

function findManualAmount(flat, namePhrases) {
  const lc = (s) => String(s || "").toLowerCase().trim();

  // 1. Exact match on type:total rows
  for (const phrase of namePhrases) {
    const r = flat.find((f) => f.type === "total" && lc(f.name) === lc(phrase));
    if (r !== undefined) return parseFloat(r.amount) || 0;
  }

  // 2. Includes match on type:total rows — guard against over-matching.
  // e.g. "total assets" must NOT match "total current assets".
  for (const phrase of namePhrases) {
    const lcPhrase = lc(phrase);
    const r = flat.find((f) => {
      if (f.type !== "total") return false;
      const name = lc(f.name);
      if (!name.includes(lcPhrase)) return false;
      // The remainder after stripping the search phrase must contain no word chars
      const extra = name.replace(lcPhrase, "").trim();
      return !extra || !/\w/.test(extra);
    });
    if (r !== undefined) return parseFloat(r.amount) || 0;
  }

  // 3. Search type:header nodes — Gemini sets computed amounts on section headers.
  // Strip "total " prefix from phrase to match the section header name.
  for (const phrase of namePhrases) {
    const sectionName = lc(phrase).replace(/^total\s+/, "");
    const r = flat.find(
      (f) => f.type === "header" && lc(f.name) === sectionName && f.amount,
    );
    if (r !== undefined) return parseFloat(r.amount) || 0;
  }

  // 4. Fuzzy fallback: any row type, includes match
  for (const phrase of namePhrases) {
    const r = flat.find((f) => lc(f.name).includes(lc(phrase)));
    if (r !== undefined) return parseFloat(r.amount) || 0;
  }

  return 0;
}

export async function fetchDashboardKPIsFromManualUpload() {
  const [bsRes, plRes] = await Promise.all([
    request("/manual-report-uploads/reports/balance_sheet/latest").catch(() => null),
    request("/manual-report-uploads/reports/profit_and_loss/latest").catch(() => null),
  ]);

  const bsFlat = flattenManualRows(bsRes?.data?.rows || []);
  const plFlat = flattenManualRows(plRes?.data?.rows || []);

  // P&L values
  const revenue = findManualAmount(plFlat, ["total income", "total revenue", "total sales"]);
  const rawExpenses = findManualAmount(plFlat, ["total expenses", "total expense", "total operating expenses"]);
  const expenses = Math.abs(rawExpenses);
  const netProfitRaw = findManualAmount(plFlat, ["net income", "net profit", "net loss"]);
  const netProfit = netProfitRaw !== 0 ? netProfitRaw : revenue - expenses;

  // Balance sheet values
  const totalAssets = findManualAmount(bsFlat, [
    "total assets",
  ]);
  const totalLiabilities = findManualAmount(bsFlat, [
    "total liabilities",
  ]);
  const totalEquity = findManualAmount(bsFlat, [
    "total equity",
    "total stockholders equity",
    "total stockholders' equity",
    "total shareholders equity",
    "total shareholders' equity",
  ]);
  const currentAssets = findManualAmount(bsFlat, [
    "total current assets",
    "current assets",
  ]);
  const currentLiabilities = findManualAmount(bsFlat, [
    "total current liabilities",
    "current liabilities",
  ]);
  const cashBank = findManualAmount(bsFlat, [
    "total bank accounts",
    "total cash and cash equivalents",
    "total cash and bank",
    "total cash",
    "bank accounts",
    "cash and cash equivalents",
  ]);
  const receivable = findManualAmount(bsFlat, [
    "total accounts receivable",
    "total accounts receivable (a/r)",
    "accounts receivable (a/r)",
    "accounts receivable",
  ]);
  const inventoryValue = findManualAmount(bsFlat, [
    "total inventory",
    "inventory asset",
    "inventory",
  ]);
  const accountPayable = findManualAmount(bsFlat, [
    "total accounts payable",
    "total accounts payable (a/p)",
    "accounts payable (a/p)",
    "accounts payable",
  ]);
  const longTermDebt = findManualAmount(bsFlat, [
    "total long-term liabilities",
    "total long term liabilities",
    "long-term liabilities",
    "long term liabilities",
    "notes payable",
    "long-term debt",
  ]);
  const workingCapital =
    currentAssets && currentLiabilities
      ? currentAssets - currentLiabilities
      : cashBank + receivable + inventoryValue - accountPayable;

  const cards = [
    { label: "Total Revenue",       value: formatMoney(revenue),          rawValue: revenue,          desc: "Total gross income",             color: "#8bc53d", icon: CircleDollarSign },
    { label: "Total Expenses",      value: formatMoney(expenses),         rawValue: expenses,         desc: "Total operating costs",          color: "#C62026", icon: CreditCard },
    { label: "Net Profit",          value: formatMoney(netProfit),        rawValue: netProfit,        desc: "Bottom-line earnings",           color: "#00648F", icon: TrendingUp },
    { label: "Total Assets",        value: formatMoney(totalAssets),      rawValue: totalAssets,      desc: "Company's total valuation",      color: "#8bc53d", icon: Building2 },
    { label: "Total Liabilities",   value: formatMoney(totalLiabilities), rawValue: totalLiabilities, desc: "Current total obligations",      color: "#F68C1F", icon: Wallet },
    { label: "Total Equity",        value: formatMoney(totalEquity),      rawValue: totalEquity,      desc: "Net asset value",                color: "#00648F", icon: Scale },
    { label: "Working Capital",     value: formatMoney(workingCapital),   rawValue: workingCapital,   desc: "Available operating liquidity",  color: "#8bc53d", icon: RefreshCw },
    { label: "Cash & Bank Balance", value: formatMoney(cashBank),         rawValue: cashBank,         desc: "Liquid funds available",         color: "#8bc53d", icon: PiggyBank },
    { label: "Account Receivable",  value: formatMoney(receivable),       rawValue: receivable,       desc: "Unpaid client invoices",         color: "#00A3FF", icon: ArrowDownToLine },
    { label: "Inventory Value",     value: formatMoney(inventoryValue),   rawValue: inventoryValue,   desc: "Current stock valuation",        color: "#6D6E71", icon: Package },
    { label: "Account Payable",     value: formatMoney(accountPayable),   rawValue: accountPayable,   desc: "Outstanding vendor bills",       color: "#EF4444", icon: ArrowUpToLine },
    { label: "Long-Term Debt",      value: formatMoney(longTermDebt),     rawValue: longTermDebt,     desc: "Non-current liabilities",        color: "#DC2626", icon: Landmark },
  ];

  return cards.map((card) => ({ ...card, rawValue: Number(card.rawValue || 0) }));
}

function extractMultiColumnTrends(payload, buckets) {
  const qbReport = unwrapReportPayload(payload);

  // Identify period columns: money columns whose title is NOT "total"
  const allCols = qbReport?.Columns?.Column || payload?.Columns?.Column || [];
  const periodCols = allCols
    .filter((c) => c.ColType === "Money")
    .filter((c) => !/^total$/i.test((c.ColTitle || "").trim()));
  const nCols = periodCols.length;

  if (nCols === 0) {
    // Single-column (Total) fallback — extract aggregate and assign to first bucket
    const totals = extractProfitAndLossTotals(payload);
    return buckets.map((bucket, idx) => ({
      name: bucket.shortName ?? bucket.name,
      fullLabel: bucket.fullLabel ?? bucket.name,
      revenue: idx === 0 ? totals.revenue : 0,
      expenses: idx === 0 ? totals.expenses : 0,
    }));
  }

  const revenues = new Array(nCols).fill(0);
  const expenses = new Array(nCols).fill(0);

  // Walk top-level report rows to find Income / Expenses section summaries
  for (const row of getRows(qbReport)) {
    const group = (row?.group || "").toLowerCase();
    const label = normalizeLabel(getRowLabel(row));
    // ColData layout: [label, period_1, period_2, ..., period_N, Total]
    const colData = row?.Summary?.ColData || row?.ColData || [];
    const vals = colData.slice(1, nCols + 1).map((d) => parseNumeric(d?.value) ?? 0);

    if (
      group === "income" || group === "grossprofit" ||
      label === "total income" || label === "total revenue" ||
      (label.startsWith("total") && label.includes("income"))
    ) {
      for (let i = 0; i < nCols; i++) revenues[i] = vals[i] ?? 0;
    }

    if (
      group === "expenses" || group === "otherexpenses" ||
      label === "total expenses" || label === "total operating expenses" ||
      (label.startsWith("total") && label.includes("expense"))
    ) {
      for (let i = 0; i < nCols; i++) expenses[i] += vals[i] ?? 0;
    }
  }

  return buckets.map((bucket, idx) => ({
    name: bucket.shortName ?? bucket.name,
    fullLabel: bucket.fullLabel ?? bucket.name,
    revenue: revenues[idx] ?? 0,
    expenses: expenses[idx] ?? 0,
  }));
}

export async function fetchFinancialTrends(
  start,
  end,
  aggregationType = "monthly",
  options = {},
) {
  const sourceMode = options?.sourceMode === "manual" ? "manual" : "quickbooks";
  const buckets = buildTrendBuckets(start, end, aggregationType).slice(
    -MAX_CHART_REQUESTS,
  );

  if (sourceMode === "manual") {
    return mapWithConcurrency(
      buckets,
      async (bucket) => {
        const manualReport = await getManualStagedProfitLossSummary({
          params: {
            startDate: bucket.start,
            endDate: bucket.end,
          },
        }).catch(() => null);
        const manualTotals = extractManualProfitAndLossTotals(manualReport || {});
        return {
          name: bucket.shortName || bucket.name,
          fullLabel: bucket.name,
          revenue: manualTotals.revenue,
          expenses: manualTotals.expenses,
        };
      },
      1,
    );
  }

  const rawResults = await mapWithConcurrency(
    buckets,
    async (bucket) => {
      const report = await fetchProfitAndLoss(
        { start_date: bucket.start, end_date: bucket.end },
        { signal: AbortSignal.timeout(15000) },
      ).catch(() => null);
      // QB returns NoReportData=true for future / empty periods.
      // These must be omitted — they carry no financial data, not zero data.
      if (hasNoReportData(report)) return null;
      const totals = extractProfitAndLossTotals(report || {});
      return {
        name: bucket.shortName ?? bucket.name,
        fullLabel: bucket.fullLabel ?? bucket.name,
        revenue: totals.revenue,
        expenses: totals.expenses,
      };
    },
    1,
  );
  return rawResults.filter(Boolean);
}
