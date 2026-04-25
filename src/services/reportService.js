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
      ...(token
        ? {
            Authorization: `Bearer ${token}`,
            "X-Access-Token": token,
            "X-Auth-Token": token,
            "X-Token": token,
          }
        : {}),
      ...(clientId ? { "X-Client-Id": clientId } : {}),
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

function getReportColumns(payload) {
  return payload?.Columns?.Column || payload?.data?.Columns?.Column || [];
}

function findSummaryRow(payload, rowMatchers = []) {
  const rows = flattenRows(getRows(payload)).reverse();
  const normalizedMatchers = rowMatchers.map((matcher) => normalizeLabel(matcher));

  const preferredRows = rows.filter((row) => {
    const candidates = [
      ...(row?.Summary?.ColData || []),
      ...(row?.ColData || []),
    ]
      .map((item) => parseNumeric(item?.value))
      .filter((value) => value !== null);

    return candidates.length > 1;
  });

  const fallbackRows = preferredRows.length ? preferredRows : rows;

  if (normalizedMatchers.length) {
    const matchingRow = fallbackRows.find((row) => {
      const label = normalizeLabel(getRowLabel(row));
      return normalizedMatchers.some(
        (matcher) => label === matcher || label.includes(matcher),
      );
    });

    if (matchingRow) return matchingRow;
  }

  return (
    fallbackRows.find((row) => normalizeLabel(getRowLabel(row)) === "total") ||
    fallbackRows[0] ||
    null
  );
}

function findSummaryColumnValue(payload, columnMatchers = [], rowMatchers = []) {
  const row = findSummaryRow(payload, rowMatchers);
  if (!row) return null;

  const columns = getReportColumns(payload);
  const values = row?.Summary?.ColData || row?.ColData || [];
  const normalizedMatchers = columnMatchers.map((matcher) => normalizeLabel(matcher));

  for (let index = 0; index < values.length; index += 1) {
    const title = normalizeLabel(
      columns[index]?.ColTitle ||
        columns[index]?.ColType ||
        values[index]?.id ||
        "",
    );

    if (!title) continue;

    if (normalizedMatchers.some((matcher) => title.includes(matcher))) {
      const parsed = parseNumeric(values[index]?.value);
      if (parsed !== null) return parsed;
    }
  }

  return null;
}

function formatRatio(value) {
  return Number(value || 0).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function createKpiCard({
  label,
  rawValue,
  desc,
  color,
  icon,
  formatter = formatMoney,
}) {
  return {
    label,
    value: formatter(rawValue),
    rawValue: Number(rawValue || 0),
    desc,
    color,
    icon,
  };
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
  const netOperatingIncome = pickFirstNumber(
    findValueByExactLabel(profitAndLoss, ["Net Operating Income"]),
    findValueByLabel(profitAndLoss, ["net operating income"]),
    netProfit,
  );
  const totalCostOfGoodsSold = pickFirstNumber(
    findValueByExactLabel(profitAndLoss, [
      "Total Cost of Goods Sold",
      "Cost of Goods Sold",
      "Total Cost of Sales",
    ]),
    findValueByLabel(profitAndLoss, [
      "total cost of goods sold",
      "cost of goods sold",
      "total cost of sales",
    ]),
  );
  const invoiceRevenue = invoices.reduce(
    (sum, invoice) => sum + Number(invoice.TotalAmt || 0),
    0,
  );
  const revenue = hasRevenue ? reportRevenue : invoiceRevenue;
  const safeExpenses = hasExpenses ? expenses : 0;
  const safeNetProfit = hasNetProfit ? netProfit : revenue - safeExpenses;
  const grossProfit = pickFirstNumber(
    findValueByExactLabel(profitAndLoss, ["Gross Profit"]),
    findValueByLabel(profitAndLoss, ["gross profit"]),
    revenue - totalCostOfGoodsSold,
  );

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
  const totalFixedAssets = pickFirstNumber(
    findValueByGroup(balanceSheetPayload, ["FixedAssets"]),
    findValueByExactLabel(balanceSheetPayload, [
      "Total Fixed Assets",
      "Total Fixed Asset",
      "Fixed Assets",
    ]),
    Math.max(totalAssets - currentAssets, 0),
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
  const checkingAccount = pickFirstNumber(
    findAccountBalance(combinedReports, ["checking"]),
    findValueByLabel(balanceSheetPayload, ["checking"]),
  );
  const savingsAccount = pickFirstNumber(
    findAccountBalance(combinedReports, ["savings"]),
    findValueByLabel(balanceSheetPayload, ["savings"]),
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
  const undepositedFunds = pickFirstNumber(
    findAccountBalance(combinedReports, ["undeposited funds"]),
    findValueByLabel(balanceSheetPayload, ["undeposited funds"]),
  );
  const agedPayable = findSummaryTotal(combinedReports?.agedPayableDetail, [
    "total",
    "accounts payable",
    "payable",
  ]);
  const totalLongTermLiabilities = pickFirstNumber(
    findValueByGroup(balanceSheetPayload, ["LongTermLiabilities"]),
    findAccountBalance(combinedReports, ["notes payable", "long term"]),
    findValueByExactLabel(balanceSheetPayload, [
      "Total Long-Term Liabilities",
      "Total Long Term Liabilities",
    ]),
    Math.max(totalLiabilities - currentLiabilities, 0),
  );
  const creditCardBalance = pickFirstNumber(
    findValueByGroup(balanceSheetPayload, ["CCard"]),
    findAccountBalance(combinedReports, ["credit card"]),
    findValueByExactLabel(balanceSheetPayload, [
      "Total Credit Cards",
      "Credit Cards",
    ]),
  );
  const otherCurrentLiabilities = pickFirstNumber(
    findValueByExactLabel(balanceSheetPayload, [
      "Total Other Current Liabilities",
      "Other Current Liabilities",
    ]),
    findValueByLabel(balanceSheetPayload, ["other current liabilities"]),
    Math.max(currentLiabilities - agedPayable - creditCardBalance, 0),
  );
  const accountPayable = pickFirstNumber(agedPayable, payable);
  const agedReceivablesTotal = pickFirstNumber(
    findSummaryColumnValue(
      combinedReports?.agedReceivableDetail,
      ["total"],
      ["total", "accounts receivable", "receivable"],
    ),
    receivable,
  );
  const agedReceivables1To30 = pickFirstNumber(
    findSummaryColumnValue(combinedReports?.agedReceivableDetail, [
      "1 30",
      "1-30",
      "1 through 30",
    ]),
  );
  const agedReceivables31To60 = pickFirstNumber(
    findSummaryColumnValue(combinedReports?.agedReceivableDetail, [
      "31 60",
      "31-60",
      "31 through 60",
    ]),
  );
  const agedReceivables61To90 = pickFirstNumber(
    findSummaryColumnValue(combinedReports?.agedReceivableDetail, [
      "61 90",
      "61-90",
      "61 through 90",
    ]),
  );
  const agedPayablesTotal = pickFirstNumber(
    findSummaryColumnValue(
      combinedReports?.agedPayableDetail,
      ["total"],
      ["total", "accounts payable", "payable"],
    ),
    accountPayable,
  );
  const agedPayables1To30 = pickFirstNumber(
    findSummaryColumnValue(combinedReports?.agedPayableDetail, [
      "1 30",
      "1-30",
      "1 through 30",
    ]),
  );
  const agedPayables31To60 = pickFirstNumber(
    findSummaryColumnValue(combinedReports?.agedPayableDetail, [
      "31 60",
      "31-60",
      "31 through 60",
    ]),
  );
  const workingCapital =
    currentAssets && currentLiabilities
      ? currentAssets - currentLiabilities
      : cashBank + receivable + inventoryValue - accountPayable;
  const currentRatio =
    currentLiabilities > 0 ? currentAssets / currentLiabilities : 0;
  const cashRatio = currentLiabilities > 0 ? cashBank / currentLiabilities : 0;

  const cards = [
    createKpiCard({
      label: "Total Revenue",
      rawValue: revenue,
      desc: "Top-line income",
      color: "#8bc53d",
      icon: CircleDollarSign,
    }),
    createKpiCard({
      label: "Total Expenses",
      rawValue: safeExpenses,
      desc: "Total operating costs",
      color: "#C62026",
      icon: CreditCard,
    }),
    createKpiCard({
      label: "Net Profit",
      rawValue: safeNetProfit,
      desc: "Bottom-line earnings",
      color: "#00648F",
      icon: TrendingUp,
    }),
    createKpiCard({
      label: "Net Operating Income",
      rawValue: netOperatingIncome,
      desc: "Operating income after expenses",
      color: "#00648F",
      icon: TrendingUp,
    }),
    createKpiCard({
      label: "Gross Profit",
      rawValue: grossProfit,
      desc: "Revenue minus cost of goods sold",
      color: "#8bc53d",
      icon: CircleDollarSign,
    }),
    createKpiCard({
      label: "Total Assets",
      rawValue: totalAssets,
      desc: "Overall asset position",
      color: "#8bc53d",
      icon: Building2,
    }),
    createKpiCard({
      label: "Total Current Assets",
      rawValue: currentAssets,
      desc: "Short-term assets",
      color: "#8bc53d",
      icon: Building2,
    }),
    createKpiCard({
      label: "Total Fixed Assets",
      rawValue: totalFixedAssets,
      desc: "Long-lived business assets",
      color: "#8bc53d",
      icon: Building2,
    }),
    createKpiCard({
      label: "Total Liabilities",
      rawValue: totalLiabilities,
      desc: "Overall obligations",
      color: "#F68C1F",
      icon: Wallet,
    }),
    createKpiCard({
      label: "Total Current Liabilities",
      rawValue: currentLiabilities,
      desc: "Short-term obligations",
      color: "#F68C1F",
      icon: Wallet,
    }),
    createKpiCard({
      label: "Total Long-Term Liabilities",
      rawValue: totalLongTermLiabilities,
      desc: "Long-term obligations",
      color: "#DC2626",
      icon: Landmark,
    }),
    createKpiCard({
      label: "Total Equity",
      rawValue: totalEquity,
      desc: "Net worth after liabilities",
      color: "#00648F",
      icon: Scale,
    }),
    createKpiCard({
      label: "Cash & Bank Balance",
      rawValue: cashBank,
      desc: "Liquid funds available",
      color: "#8bc53d",
      icon: PiggyBank,
    }),
    createKpiCard({
      label: "Checking Account",
      rawValue: checkingAccount,
      desc: "Checking balance",
      color: "#00648F",
      icon: PiggyBank,
    }),
    createKpiCard({
      label: "Savings Account",
      rawValue: savingsAccount,
      desc: "Savings balance",
      color: "#8bc53d",
      icon: PiggyBank,
    }),
    createKpiCard({
      label: "Accounts Receivable",
      rawValue: receivable,
      desc: "Outstanding customer balances",
      color: "#00A3FF",
      icon: ArrowDownToLine,
    }),
    createKpiCard({
      label: "Inventory Value",
      rawValue: inventoryValue,
      desc: "Inventory on hand",
      color: "#6D6E71",
      icon: Package,
    }),
    createKpiCard({
      label: "Undeposited Funds",
      rawValue: undepositedFunds,
      desc: "Funds pending deposit",
      color: "#00A3FF",
      icon: PiggyBank,
    }),
    createKpiCard({
      label: "Accounts Payable",
      rawValue: accountPayable,
      desc: "Outstanding vendor bills",
      color: "#EF4444",
      icon: ArrowUpToLine,
    }),
    createKpiCard({
      label: "Credit Card Balance",
      rawValue: creditCardBalance,
      desc: "Credit card obligations",
      color: "#EF4444",
      icon: CreditCard,
    }),
    createKpiCard({
      label: "Other Current Liabilities",
      rawValue: otherCurrentLiabilities,
      desc: "Other short-term obligations",
      color: "#F68C1F",
      icon: Wallet,
    }),
    createKpiCard({
      label: "Working Capital",
      rawValue: workingCapital,
      desc: "Current assets minus current liabilities",
      color: "#8bc53d",
      icon: RefreshCw,
    }),
    createKpiCard({
      label: "Aged Receivables (Total)",
      rawValue: agedReceivablesTotal,
      desc: "All open receivables",
      color: "#00A3FF",
      icon: ArrowDownToLine,
    }),
    createKpiCard({
      label: "Aged Receivables (1-30 days)",
      rawValue: agedReceivables1To30,
      desc: "Receivables aged 1-30 days",
      color: "#00A3FF",
      icon: ArrowDownToLine,
    }),
    createKpiCard({
      label: "Aged Receivables (31-60 days)",
      rawValue: agedReceivables31To60,
      desc: "Receivables aged 31-60 days",
      color: "#00A3FF",
      icon: ArrowDownToLine,
    }),
    createKpiCard({
      label: "Aged Receivables (61-90 days)",
      rawValue: agedReceivables61To90,
      desc: "Receivables aged 61-90 days",
      color: "#00A3FF",
      icon: ArrowDownToLine,
    }),
    createKpiCard({
      label: "Aged Payables (Total)",
      rawValue: agedPayablesTotal,
      desc: "All open payables",
      color: "#EF4444",
      icon: ArrowUpToLine,
    }),
    createKpiCard({
      label: "Aged Payables (1-30 days)",
      rawValue: agedPayables1To30,
      desc: "Payables aged 1-30 days",
      color: "#EF4444",
      icon: ArrowUpToLine,
    }),
    createKpiCard({
      label: "Aged Payables (31-60 days)",
      rawValue: agedPayables31To60,
      desc: "Payables aged 31-60 days",
      color: "#EF4444",
      icon: ArrowUpToLine,
    }),
    createKpiCard({
      label: "Current Ratio",
      rawValue: currentRatio,
      desc: "Current assets divided by current liabilities",
      color: "#00648F",
      icon: Scale,
      formatter: formatRatio,
    }),
    createKpiCard({
      label: "Cash Ratio",
      rawValue: cashRatio,
      desc: "Cash divided by current liabilities",
      color: "#00648F",
      icon: Scale,
      formatter: formatRatio,
    }),
  ];

  return cards;
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
