/**
 * Manual Upload (Excel/PDF) Dashboard Service
 *
 * Delegates all row-parsing and KPI extraction to the backend endpoint
 * GET /manual-report-uploads/manual-upload-dashboard.
 *
 * The backend returns:
 *   {
 *     years:    ["All Files", "2025", "2024", ...],
 *     reports:  { "2025": { year, balanceSheet, profitLoss, kpis, warnings? }, ... },
 *     allFiles: { year: "All Files", kpis, warnings? },
 *     trends:   [{ year, revenue, expenses, netProfit }, ...],  // asc by year
 *   }
 *
 * This service transforms that into the shape WorkspaceDashboardDatahub expects:
 *   - kpis[]         → array of KPI card objects with icons
 *   - trends[]       → chart data [{ name, fullLabel, revenue, expenses }]
 *   - availableYears → number[]
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
import { getManualUploadDashboard } from "../lib/api";
import { formatNumber } from "../lib/utils";

function formatMoney(value) {
  return formatNumber(value, 2);
}

function buildKpiCards(kpis = {}) {
  return [
    {
      label: "Total Revenue",
      value: formatMoney(kpis.totalRevenue),
      rawValue: Number(kpis.totalRevenue || 0),
      desc: "Total gross income",
      color: "#8bc53d",
      icon: CircleDollarSign,
    },
    {
      label: "Total Expenses",
      value: formatMoney(kpis.totalExpenses),
      rawValue: Number(kpis.totalExpenses || 0),
      desc: "Total operating costs",
      color: "#C62026",
      icon: CreditCard,
    },
    {
      label: "Net Profit",
      value: formatMoney(kpis.netProfit),
      rawValue: Number(kpis.netProfit || 0),
      desc: "Bottom-line earnings",
      color: "#00648F",
      icon: TrendingUp,
    },
    {
      label: "Total Assets",
      value: formatMoney(kpis.totalAssets),
      rawValue: Number(kpis.totalAssets || 0),
      desc: "Company's total valuation",
      color: "#8bc53d",
      icon: Building2,
    },
    {
      label: "Total Liabilities",
      value: formatMoney(kpis.totalLiabilities),
      rawValue: Number(kpis.totalLiabilities || 0),
      desc: "Current total obligations",
      color: "#F68C1F",
      icon: Wallet,
    },
    {
      label: "Total Equity",
      value: formatMoney(kpis.totalEquity),
      rawValue: Number(kpis.totalEquity || 0),
      desc: "Net asset value",
      color: "#00648F",
      icon: Scale,
    },
    {
      label: "Working Capital",
      value: formatMoney(kpis.workingCapital),
      rawValue: Number(kpis.workingCapital || 0),
      desc: "Available operating liquidity",
      color: "#8bc53d",
      icon: RefreshCw,
    },
    {
      label: "Cash & Bank Balance",
      value: formatMoney(kpis.cashAndBankBalance),
      rawValue: Number(kpis.cashAndBankBalance || 0),
      desc: "Liquid funds available",
      color: "#8bc53d",
      icon: PiggyBank,
    },
    {
      label: "Account Receivable",
      value: formatMoney(kpis.accountsReceivable),
      rawValue: Number(kpis.accountsReceivable || 0),
      desc: "Unpaid client invoices",
      color: "#00A3FF",
      icon: ArrowDownToLine,
    },
    {
      label: "Inventory Value",
      value: formatMoney(kpis.inventoryValue),
      rawValue: Number(kpis.inventoryValue || 0),
      desc: "Current stock valuation",
      color: "#6D6E71",
      icon: Package,
    },
    {
      label: "Account Payable",
      value: formatMoney(kpis.accountsPayable),
      rawValue: Number(kpis.accountsPayable || 0),
      desc: "Outstanding vendor bills",
      color: "#EF4444",
      icon: ArrowUpToLine,
    },
    {
      label: "Long-Term Debt",
      value: formatMoney(kpis.longTermDebt),
      rawValue: Number(kpis.longTermDebt || 0),
      desc: "Non-current liabilities",
      color: "#DC2626",
      icon: Landmark,
    },
  ];
}

/**
 * Full Manual Upload dashboard load.
 *
 * @param {"all"|number|string} selectedYear  "all" or a fiscal year string/number
 * @param {{ clientId?: string }} options
 * @returns {{ kpis, hasBs, hasPl, trends, availableYears, warnings? }}
 */
export async function loadManualUploadDashboard(selectedYear = "all", options = {}) {
  const payload = await getManualUploadDashboard(options);

  const availableYears = (payload.years || [])
    .filter((y) => y !== "All Files")
    .map(Number)
    .filter((y) => !isNaN(y))
    .sort((a, b) => a - b);

  const yearKey = String(selectedYear === "all" ? "All Files" : selectedYear);
  const entry =
    yearKey === "All Files"
      ? payload.allFiles
      : (payload.reports || {})[yearKey];

  const kpisRaw = entry?.kpis || {};
  const warnings = entry?.warnings || [];
  const hasBs = yearKey === "All Files"
    ? availableYears.some((y) => payload.reports?.[String(y)]?.balanceSheet != null)
    : (payload.reports?.[yearKey]?.balanceSheet != null);
  const hasPl = yearKey === "All Files"
    ? availableYears.some((y) => payload.reports?.[String(y)]?.profitLoss != null)
    : (payload.reports?.[yearKey]?.profitLoss != null);

  const kpis = buildKpiCards(kpisRaw);

  const trends = (payload.trends || []).map((t) => ({
    name: String(t.year),
    fullLabel: `FY ${t.year}`,
    revenue: Number(t.revenue || 0),
    expenses: Number(t.expenses || 0),
  }));

  return {
    kpis,
    hasBs,
    hasPl,
    trends,
    availableYears,
    warnings: warnings.length > 0 ? warnings : undefined,
    _raw: payload,
  };
}
