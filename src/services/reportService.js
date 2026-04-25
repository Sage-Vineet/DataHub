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
import { getStoredToken } from "../lib/api";

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

function getRows(payload) {
  return payload?.Rows?.Row || payload?.data?.Rows?.Row || [];
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

function extractProfitAndLossTotals(payload) {
  const revenue =
    findValueByExactLabel(payload, [
      "Total Income",
      "Total Revenue",
      "Total Income and Other Income",
    ]) ??
    findValueByLabel(payload, [
      "total income",
      "total revenue",
      "income and other income",
    ]);
  const expenses =
    findValueByExactLabel(payload, ["Total Expenses"]) ??
    findValueByLabel(payload, ["total expenses"]);
  const netProfit =
    findValueByExactLabel(payload, [
      "Net Income",
      "Net Profit",
      "Net Operating Income",
    ]) ??
    findValueByLabel(payload, ["net income", "net profit", "net operating income"]);

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

function getAccountListRows(payload) {
  return payload?.accountList?.Rows?.Row || payload?.AccountList?.Rows?.Row || [];
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

export async function fetchDashboardKPIs(start, end) {
  const params =
    start || end
      ? {
        ...(start ? { start_date: start } : {}),
        ...(end ? { end_date: end } : {}),
      }
      : {};

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
      value: formatMoney(safeExpenses),
      rawValue: safeExpenses,
      desc: "Total operating costs",
      color: "#C62026",
      icon: CreditCard,
    },
    {
      label: "Net Profit",
      value: formatMoney(safeNetProfit),
      rawValue: safeNetProfit,
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

export async function fetchFinancialTrends(
  start,
  end,
  aggregationType = "monthly",
) {
  const buckets = buildTrendBuckets(start, end, aggregationType).slice(
    -MAX_CHART_REQUESTS,
  );

  const results = [];
  for (const bucket of buckets) {
    const report = await fetchProfitAndLoss({
      start_date: bucket.start,
      end_date: bucket.end,
    }).catch(() => null);
    const totals = extractProfitAndLossTotals(report || {});
    results.push({
      name: bucket.shortName || bucket.name,
      fullLabel: bucket.name,
      revenue: totals.revenue,
      expenses: totals.expenses,
    });
  }

  return results;
}