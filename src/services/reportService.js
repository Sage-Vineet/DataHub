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

const API_BASE_URL = (
  import.meta.env.VITE_API_BASE_URL || "http://localhost:4000"
).replace(/\/$/, "");

async function request(path) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    credentials: "include",
    cache: "no-store",
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.message || payload?.error || `Request failed: ${response.status}`);
  }

  return payload;
}

function buildQuery(params = {}) {
  const search = new URLSearchParams(
    Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== ""),
  );
  return search.toString() ? `?${search.toString()}` : "";
}

function toNumber(value) {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return 0;
  return Number(value.replace(/,/g, "").replace(/[^\d.-]/g, "")) || 0;
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
  const candidates = [
    ...(row?.Summary?.ColData || []),
    ...(row?.ColData || []),
  ]
    .map((item) => toNumber(item?.value))
    .filter((value) => !Number.isNaN(value));

  return candidates.length ? candidates[candidates.length - 1] : 0;
}

function findValueByLabel(payload, matchers = []) {
  const rows = flattenRows(getRows(payload));
  const normalizedMatchers = matchers.map((matcher) => matcher.toLowerCase());

  for (const row of rows) {
    const label =
      row?.Header?.ColData?.[0]?.value ||
      row?.Summary?.ColData?.[0]?.value ||
      row?.ColData?.[0]?.value ||
      "";
    const value =
      row?.Summary?.ColData?.[1]?.value ||
      row?.ColData?.[1]?.value ||
      row?.ColData?.[0]?.value;
    const lowerLabel = String(label).toLowerCase();

    if (normalizedMatchers.some((matcher) => lowerLabel.includes(matcher))) {
      return toNumber(value);
    }
  }

  return 0;
}

function findValueByExactLabel(payload, labels = []) {
  const targets = labels.map(normalizeLabel);
  const rows = flattenRows(getRows(payload)).reverse();

  for (const row of rows) {
    const label = normalizeLabel(getRowLabel(row));
    if (targets.includes(label)) {
      return getRowNumericValue(row);
    }
  }

  return 0;
}

function findValueByGroup(payload, groups = []) {
  const targets = groups.map((group) => String(group || "").toLowerCase());
  const rows = flattenRows(getRows(payload)).reverse();

  for (const row of rows) {
    const group = String(row?.group || "").toLowerCase();
    if (targets.includes(group)) {
      return getRowNumericValue(row);
    }
  }

  return 0;
}

function findSummaryTotal(payload, matchers = []) {
  const rows = flattenRows(getRows(payload)).reverse();
  const normalizedMatchers = matchers.map((matcher) => matcher.toLowerCase());

  for (const row of rows) {
    const label =
      row?.Summary?.ColData?.[0]?.value ||
      row?.Header?.ColData?.[0]?.value ||
      row?.ColData?.[0]?.value ||
      "";
    const candidates = [
      ...(row?.Summary?.ColData || []),
      ...(row?.ColData || []),
    ]
      .map((item) => toNumber(item?.value))
      .filter((value) => value !== 0);

    if (candidates.length === 0) continue;

    if (
      normalizedMatchers.length === 0 ||
      normalizedMatchers.some((matcher) => String(label).toLowerCase().includes(matcher))
    ) {
      return candidates[candidates.length - 1];
    }
  }

  return 0;
}

function extractProfitAndLossTotals(payload) {
  const revenue = findValueByLabel(payload, ["total income", "income"]);
  const expenses = findValueByLabel(payload, ["total expenses", "expenses"]);
  const netProfit =
    findValueByLabel(payload, ["net income", "net profit"]) || (revenue - expenses);

  return { revenue, expenses, netProfit };
}

async function fetchCombinedReports(params = {}) {
  return request(`/all-reports${buildQuery(params)}`);
}

const MAX_CHART_REQUESTS = 12;

function getAccountListRows(payload) {
  return payload?.accountList?.Rows?.Row || [];
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
      bucketEnd = new Date(bucketStart.getFullYear(), bucketStart.getMonth() + 1, 0);
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

  const invoices = invoicesPayload?.QueryResponse?.Invoice || [];
  const { revenue: reportRevenue, expenses, netProfit } =
    extractProfitAndLossTotals(profitAndLoss || {});
  const revenue =
    reportRevenue ||
    invoices.reduce((sum, invoice) => sum + Number(invoice.TotalAmt || 0), 0);
  const totalAssets =
    findValueByGroup(balanceSheet, ["TotalAssets"]) ||
    findValueByExactLabel(balanceSheet, ["TOTAL ASSETS", "Total Assets"]);
  const totalLiabilities =
    findValueByGroup(balanceSheet, ["Liabilities"]) ||
    findValueByExactLabel(balanceSheet, ["Total Liabilities"]);
  const totalEquity =
    findValueByGroup(balanceSheet, ["Equity"]) ||
    findValueByExactLabel(balanceSheet, ["Total Equity"]);
  const currentAssets =
    findValueByGroup(balanceSheet, ["CurrentAssets"]) ||
    findValueByExactLabel(balanceSheet, ["Total Current Assets"]);
  const currentLiabilities =
    findValueByGroup(balanceSheet, ["CurrentLiabilities"]) ||
    findValueByExactLabel(balanceSheet, ["Total Current Liabilities"]);
  const payable =
    findValueByGroup(balanceSheet, ["AP"]) ||
    findAccountBalance(combinedReports, ["accounts payable"]) ||
    findValueByExactLabel(balanceSheet, ["Total Accounts Payable"]);
  const cashBank =
    findValueByGroup(balanceSheet, ["BankAccounts"]) ||
    findAccountBalance(combinedReports, ["checking", "savings", "bank"]) ||
    findValueByExactLabel(balanceSheet, ["Total Bank Accounts"]);
  const receivable = findSummaryTotal(combinedReports?.agedReceivableDetail, [
    "total",
    "accounts receivable",
    "receivable",
  ]) ||
    findValueByGroup(balanceSheet, ["AR"]) ||
    findAccountBalance(combinedReports, ["accounts receivable"]) ||
    findValueByExactLabel(balanceSheet, ["Total Accounts Receivable"]) ||
    invoices.reduce((sum, invoice) => sum + Number(invoice.Balance || 0), 0);
  const inventoryValue =
    findAccountBalance(combinedReports, ["inventory"]) ||
    findValueByLabel(balanceSheet, ["inventory asset", "inventory"]);
  const agedPayable = findSummaryTotal(combinedReports?.agedPayableDetail, [
    "total",
    "accounts payable",
    "payable",
  ]);
  const longTermDebt =
    findValueByGroup(balanceSheet, ["LongTermLiabilities"]) ||
    findAccountBalance(combinedReports, ["notes payable", "long term"]) ||
    findValueByExactLabel(balanceSheet, ["Total Long-Term Liabilities"]);
  const accountPayable = agedPayable || payable;
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

export async function fetchFinancialTrends(start, end, aggregationType = "monthly") {
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
