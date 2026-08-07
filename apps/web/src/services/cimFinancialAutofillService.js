import { fetchDashboardKPIs } from "./reportService";
import { loadManualUploadDashboard } from "./manualUploadDashboardService";
import { loadQMSDashboard } from "./qmsManualDashboardService";
import { getCashflow } from "./cashflowService";
import {
  extractEbitdaFromManualPLRows,
  getEbitdaData,
} from "./ebitdaService";
import {
  calculateAdjustmentTotalsByYear,
  loadAdjustmentWorkspaceData,
} from "./ebitdaAdjustmentService";
import {
  getAllManualUploadedReports,
  getAllQMSUploadedReports,
  getManualStageFilterOptions,
  listManualGlDatasetVersions,
} from "../lib/api";
import {
  getReportSourceMode,
  normalizeReportSourceKey,
  REPORT_SOURCE_KEYS,
} from "../lib/report-source";

const KPI_LABEL_TO_KEY = {
  "Total Revenue": "totalRevenue",
  "Total Expenses": "totalExpenses",
  "Net Profit": "netProfit",
  "Total Assets": "totalAssets",
  "Total Liabilities": "totalLiabilities",
  "Total Equity": "totalEquity",
  "Working Capital": "workingCapital",
  "Cash & Bank Balance": "cashAndBankBalance",
  "Account Receivable": "accountReceivable",
  "Accounts Receivable": "accountReceivable",
  "Inventory Value": "inventoryValue",
  "Account Payable": "accountPayable",
  "Accounts Payable": "accountPayable",
  "Long-Term Debt": "longTermDebt",
  "Total Debt": "totalDebt",
  "Debt": "totalDebt",
  "Net Debt": "netDebt",
  "Cost of Goods Sold": "costOfGoodsSold",
  "COGS": "costOfGoodsSold",
  "Gross Profit": "grossProfit",
};

function toNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;
  const numeric = typeof value === "number" ? value : Number(String(value).replace(/[$,%(),]/g, ""));
  if (!Number.isFinite(numeric)) return fallback;
  return String(value).includes("(") ? -Math.abs(numeric) : numeric;
}

function isMeaningfulMetricSet(metrics = {}) {
  return [
    "totalRevenue",
    "totalExpenses",
    "netProfit",
    "totalAssets",
    "cashAndBankBalance",
    "accountReceivable",
    "workingCapital",
  ].some((key) => Math.abs(toNumber(metrics[key], 0)) > 0.0001);
}

function mapKpisToMetrics(kpis = []) {
  const metrics = {};
  (kpis || []).forEach((card) => {
    const key = KPI_LABEL_TO_KEY[card?.label];
    if (key) metrics[key] = toNumber(card.rawValue ?? card.value, 0);
  });
  return metrics;
}

function getFiscalYearRange(year) {
  return {
    start: `${year}-01-01`,
    end: `${year}-12-31`,
  };
}

function isDateInput(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function getYearFromDate(value) {
  if (!isDateInput(value)) return 0;
  const year = Number(String(value).slice(0, 4));
  return Number.isInteger(year) && year > 0 ? year : 0;
}

function normalizeDateRange(dateRange) {
  const startDate = String(dateRange?.startDate || "").trim();
  const endDate = String(dateRange?.endDate || "").trim();
  if (!isDateInput(startDate) || !isDateInput(endDate)) return null;
  if (new Date(startDate) > new Date(endDate)) return null;
  return {
    startDate,
    endDate,
    fiscalYear: getYearFromDate(endDate) || getYearFromDate(startDate),
  };
}

function getInclusiveMonthSpan(startDate, endDate) {
  if (!isDateInput(startDate) || !isDateInput(endDate)) return 12;
  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return 12;
  return Math.max(
    1,
    (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth()) + 1,
  );
}

function getDefaultCandidateYears() {
  const currentYear = new Date().getFullYear();
  return Array.from({ length: 6 }, (_, index) => currentYear - index);
}

function sortYearsDescending(years = []) {
  return Array.from(new Set(
    years
      .map((year) => Number(year))
      .filter((year) => Number.isInteger(year) && year > 0),
  )).sort((a, b) => b - a);
}

function detectReportFileYear(file) {
  const data = file?.data || {};
  const dateSource = data.asOfDate || data.periodEnd || data.periodStart;
  if (dateSource) {
    const parsed = Number(String(dateSource).slice(0, 4));
    if (Number.isInteger(parsed) && parsed >= 2000) return parsed;
  }

  const match = String(file?.fileName || "").match(/\b(20\d{2})\b/);
  return match ? Number(match[1]) : 0;
}

function normalizeUploadedProfitLossRows(file) {
  const data = file?.data || {};
  const rows = Array.isArray(data.rows) ? data.rows : [];
  const periods = Array.isArray(data.periods) ? data.periods : [];
  if (!periods.length) return rows;

  const totalIndex = periods.findIndex((period) => /^total$/i.test(String(period).trim()));
  const getValue = (colAmounts) => {
    if (!Array.isArray(colAmounts) || !colAmounts.length) return 0;
    if (totalIndex >= 0) return colAmounts[totalIndex] || 0;
    return colAmounts.reduce((sum, value) => sum + toNumber(value, 0), 0);
  };

  const sumNode = (node) => ({
    ...node,
    amount: getValue(node.colAmounts) || node.amount || 0,
    children: Array.isArray(node.children) ? node.children.map(sumNode) : undefined,
  });

  return rows.map(sumNode);
}

async function getManualGlDatasetVersion(clientId, selectedDatasetVersion) {
  if (selectedDatasetVersion) return String(selectedDatasetVersion);
  try {
    const versions = await listManualGlDatasetVersions({ clientId });
    const active = versions.find((version) => version.isActive || version.is_active) || versions[0];
    return active ? String(active.value ?? active.dataset_version ?? active.version_number) : "";
  } catch {
    return "";
  }
}

async function getAvailableYears({ clientId, sourceKey, selectedDatasetVersion }) {
  const normalizedSource = normalizeReportSourceKey(sourceKey) || REPORT_SOURCE_KEYS.QUICKBOOKS;

  if (normalizedSource === REPORT_SOURCE_KEYS.MANUAL_UPLOAD) {
    const dashboard = await loadManualUploadDashboard("all", { clientId });
    return sortYearsDescending(dashboard.availableYears || []);
  }

  if (normalizedSource === REPORT_SOURCE_KEYS.QUICKBOOKS_MANUAL) {
    const dashboard = await loadQMSDashboard("all", { clientId });
    return sortYearsDescending(dashboard.availableYears || []);
  }

  if (normalizedSource === REPORT_SOURCE_KEYS.MANUAL_GL) {
    const datasetVersion = await getManualGlDatasetVersion(clientId, selectedDatasetVersion);
    const payload = await getManualStageFilterOptions({
      clientId,
      params: datasetVersion ? { datasetVersion } : {},
    });
    return sortYearsDescending(payload?.options?.fiscalYear || []);
  }

  return getDefaultCandidateYears();
}

async function loadKpisForYear({ clientId, sourceKey, sourceMode, year, datasetVersion }) {
  if (sourceKey === REPORT_SOURCE_KEYS.MANUAL_UPLOAD) {
    return mapKpisToMetrics((await loadManualUploadDashboard(year, { clientId })).kpis || []);
  }
  if (sourceKey === REPORT_SOURCE_KEYS.QUICKBOOKS_MANUAL) {
    return mapKpisToMetrics((await loadQMSDashboard(year, { clientId })).kpis || []);
  }

  const range = getFiscalYearRange(year);
  return mapKpisToMetrics(await fetchDashboardKPIs(range.start, range.end, {
    sourceMode,
    datasetVersion,
  }));
}

async function loadKpisForDateRange({
  clientId,
  sourceKey,
  sourceMode,
  startDate,
  endDate,
  fiscalYear,
  datasetVersion,
}) {
  if (sourceKey === REPORT_SOURCE_KEYS.MANUAL_UPLOAD) {
    return mapKpisToMetrics((await loadManualUploadDashboard(fiscalYear, { clientId })).kpis || []);
  }
  if (sourceKey === REPORT_SOURCE_KEYS.QUICKBOOKS_MANUAL) {
    return mapKpisToMetrics((await loadQMSDashboard(fiscalYear, { clientId })).kpis || []);
  }

  return mapKpisToMetrics(await fetchDashboardKPIs(startDate, endDate, {
    sourceMode,
    datasetVersion,
  }));
}

async function loadUploadedEbitdaByYear({ clientId, getReports }) {
  const result = await getReports("profit_and_loss", { clientId }).catch(() => null);
  const files = (result?.files || []).filter((file) => Array.isArray(file?.data?.rows) && file.data.rows.length);
  const fileByYear = new Map();

  files.forEach((file) => {
    const year = detectReportFileYear(file);
    if (!year) return;
    const existing = fileByYear.get(year);
    if (!existing || new Date(file.updatedAt || 0) > new Date(existing.updatedAt || 0)) {
      fileByYear.set(year, file);
    }
  });

  const entries = {};
  fileByYear.forEach((file, year) => {
    entries[year] = extractEbitdaFromManualPLRows(
      normalizeUploadedProfitLossRows(file),
      file.data?.asOfDate || file.data?.periodEnd || null,
    );
  });
  return entries;
}

async function loadEbitdaByYear({ clientId, sourceKey, sourceMode, years, datasetVersion }) {
  if (sourceKey === REPORT_SOURCE_KEYS.MANUAL_UPLOAD) {
    return loadUploadedEbitdaByYear({ clientId, getReports: getAllManualUploadedReports });
  }
  if (sourceKey === REPORT_SOURCE_KEYS.QUICKBOOKS_MANUAL) {
    return loadUploadedEbitdaByYear({ clientId, getReports: getAllQMSUploadedReports });
  }

  const ebitdaSourceMode = sourceKey === REPORT_SOURCE_KEYS.MANUAL_GL ? "manual" : "quickbooks";
  const entries = {};
  await Promise.all(
    years.map(async (year) => {
      const range = getFiscalYearRange(year);
      try {
        entries[year] = await getEbitdaData(
          range.start,
          range.end,
          "Accrual",
          ebitdaSourceMode || sourceMode,
          datasetVersion,
        );
      } catch {
        entries[year] = null;
      }
    }),
  );
  return entries;
}

async function loadEbitdaForDateRange({
  clientId,
  sourceKey,
  sourceMode,
  startDate,
  endDate,
  fiscalYear,
  datasetVersion,
}) {
  if (sourceKey === REPORT_SOURCE_KEYS.MANUAL_UPLOAD || sourceKey === REPORT_SOURCE_KEYS.QUICKBOOKS_MANUAL) {
    const uploaded = await loadUploadedEbitdaByYear({
      clientId,
      getReports: sourceKey === REPORT_SOURCE_KEYS.MANUAL_UPLOAD
        ? getAllManualUploadedReports
        : getAllQMSUploadedReports,
    });
    return uploaded[fiscalYear] || null;
  }

  const ebitdaSourceMode = sourceKey === REPORT_SOURCE_KEYS.MANUAL_GL ? "manual" : "quickbooks";
  return getEbitdaData(startDate, endDate, "Accrual", ebitdaSourceMode || sourceMode, datasetVersion);
}

function getLocalAdjustmentTotals(clientId, years) {
  if (typeof window === "undefined") return { totals: {}, count: 0 };
  try {
    const raw = window.localStorage.getItem(`ebitda_addbacks_${clientId}`);
    const parsed = raw ? JSON.parse(raw) : null;
    const addbacks = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.addbacks) ? parsed.addbacks : [];
    const totals = {};
    let count = 0;

    years.forEach((year) => {
      totals[String(year)] = addbacks.reduce((sum, addback) => {
        const entry = addback?.values?.[year] || addback?.values?.[String(year)] || {};
        const value = entry.userValue ?? entry.overrideValue ?? entry.apiValue ?? entry.value ?? 0;
        const numeric = Math.abs(toNumber(value, 0));
        if (numeric > 0) count += 1;
        return sum + numeric;
      }, 0);
    });

    return { totals, count };
  } catch {
    return { totals: {}, count: 0 };
  }
}

async function loadAdjustmentTotals({ clientId, sourceKey, years, datasetVersion }) {
  if (sourceKey === REPORT_SOURCE_KEYS.MANUAL_GL && datasetVersion) {
    try {
      const { adjustments } = await loadAdjustmentWorkspaceData({
        clientId,
        versionId: String(datasetVersion),
        sourceKey,
      });
      const totals = calculateAdjustmentTotalsByYear(adjustments || [], years, "approved");
      const count = (adjustments || []).filter((adjustment) => adjustment?.status !== "deleted").length;
      return { totals, count };
    } catch {
      return { totals: {}, count: 0 };
    }
  }

  return getLocalAdjustmentTotals(clientId, years);
}

function flattenRows(rows = []) {
  const output = [];
  const walk = (items) => {
    (Array.isArray(items) ? items : []).forEach((item) => {
      if (!item || typeof item !== "object") return;
      output.push(item);
      if (Array.isArray(item.children)) walk(item.children);
      if (Array.isArray(item.Rows?.Row)) walk(item.Rows.Row);
    });
  };
  walk(rows);
  return output;
}

function getRowName(row) {
  return String(row?.name || row?.label || row?.Header?.ColData?.[0]?.value || row?.Summary?.ColData?.[0]?.value || row?.ColData?.[0]?.value || "");
}

function getRowAmount(row) {
  if (row?.amount !== undefined) return toNumber(row.amount, 0);
  if (row?.value !== undefined) return toNumber(row.value, 0);
  const colData = row?.Summary?.ColData || row?.ColData || [];
  for (let index = colData.length - 1; index >= 0; index -= 1) {
    if (colData[index]?.value !== undefined && colData[index].value !== "") {
      return toNumber(colData[index].value, 0);
    }
  }
  return 0;
}

function findCashflowAmount(rows, matchers = []) {
  const normalizedMatchers = matchers.map((matcher) => String(matcher).toLowerCase());
  const flat = flattenRows(rows);
  const match = flat.find((row) => {
    const name = getRowName(row).toLowerCase();
    return normalizedMatchers.some((matcher) => name.includes(matcher));
  });
  return match ? getRowAmount(match) : 0;
}

function extractCashflowMetrics(rows = []) {
  const cashFromOperations = findCashflowAmount(rows, [
    "cash from operations",
    "net cash from operating",
    "net cash provided by operating",
  ]);
  const cashFromInvesting = findCashflowAmount(rows, [
    "cash from investing",
    "net cash from investing",
    "capital expenditures",
  ]);
  const cashFromFinancing = findCashflowAmount(rows, [
    "cash from financing",
    "net cash from financing",
  ]);
  const netChangeInCash = findCashflowAmount(rows, [
    "net change in cash",
    "net increase",
    "net decrease",
  ]);
  const capitalExpenditures = Math.abs(findCashflowAmount(rows, [
    "capital expenditures",
    "capex",
    "purchase of fixed assets",
    "purchases of fixed assets",
    "purchase of property",
    "purchases of property",
    "property plant and equipment",
    "payments to acquire property",
  ]));

  return {
    cashFromOperations,
    cashFromInvesting,
    cashFromFinancing,
    netChangeInCash,
    capitalExpenditures,
    freeCashFlow: cashFromOperations - capitalExpenditures,
  };
}

async function loadCashflowMetricsForYear({ sourceMode, year, datasetVersion }) {
  const range = getFiscalYearRange(year);
  const manualFilters = {
    fiscalYear: [String(year)],
    ...(datasetVersion ? { datasetVersion: String(datasetVersion) } : {}),
  };

  try {
    const payload = await getCashflow(range.start, range.end, "Accrual", {
      sourceMode,
      manualFilters,
      year,
    });
    const rows = Array.isArray(payload)
      ? payload
      : payload?.rows || payload?.data?.rows || payload?.hierarchicalRows || [];

    return extractCashflowMetrics(rows);
  } catch {
    return {};
  }
}

async function loadCashflowMetricsForDateRange({ sourceMode, startDate, endDate, fiscalYear, datasetVersion }) {
  const manualFilters = {
    ...(startDate ? { startDate } : {}),
    ...(endDate ? { endDate } : {}),
    ...(fiscalYear ? { fiscalYear: [String(fiscalYear)] } : {}),
    ...(datasetVersion ? { datasetVersion: String(datasetVersion) } : {}),
  };

  try {
    const payload = await getCashflow(startDate, endDate, "Accrual", {
      sourceMode,
      manualFilters,
      year: fiscalYear,
    });
    const rows = Array.isArray(payload)
      ? payload
      : payload?.rows || payload?.data?.rows || payload?.hierarchicalRows || [];

    return extractCashflowMetrics(rows);
  } catch {
    return {};
  }
}

async function loadUploadedCashflowByYear({ clientId, getReports }) {
  const result = await getReports("cash_flow", { clientId }).catch(() => null);
  const files = (result?.files || []).filter((file) => Array.isArray(file?.data?.rows) && file.data.rows.length);
  const fileByYear = new Map();

  files.forEach((file) => {
    const year = detectReportFileYear(file);
    if (!year) return;
    const existing = fileByYear.get(year);
    if (!existing || new Date(file.updatedAt || 0) > new Date(existing.updatedAt || 0)) {
      fileByYear.set(year, file);
    }
  });

  const entries = {};
  fileByYear.forEach((file, year) => {
    entries[year] = extractCashflowMetrics(normalizeUploadedProfitLossRows(file));
  });
  return entries;
}

async function loadCashflowByYear({ clientId, sourceMode, years, datasetVersion }) {
  if (sourceMode === "quickbooks_manual") {
    return loadUploadedCashflowByYear({ clientId, getReports: getAllQMSUploadedReports });
  }

  const entries = {};
  await Promise.all(
    years.map(async (year) => {
      entries[year] = await loadCashflowMetricsForYear({ sourceMode, year, datasetVersion });
    }),
  );
  return entries;
}

async function loadCashflowForDateRange({
  clientId,
  sourceKey,
  sourceMode,
  startDate,
  endDate,
  fiscalYear,
  datasetVersion,
}) {
  if (sourceKey === REPORT_SOURCE_KEYS.MANUAL_UPLOAD || sourceKey === REPORT_SOURCE_KEYS.QUICKBOOKS_MANUAL) {
    const uploaded = await loadUploadedCashflowByYear({
      clientId,
      getReports: sourceKey === REPORT_SOURCE_KEYS.MANUAL_UPLOAD
        ? getAllManualUploadedReports
        : getAllQMSUploadedReports,
    });
    return uploaded[fiscalYear] || {};
  }

  return loadCashflowMetricsForDateRange({
    sourceMode,
    startDate,
    endDate,
    fiscalYear,
    datasetVersion,
  });
}

function enrichYearMetric({ year, metrics, ebitdaData, adjustmentTotal = 0, adjustmentCount = 0, cashflow = {} }) {
  const revenue = toNumber(metrics.totalRevenue, 0) || toNumber(ebitdaData?.revenue, 0);
  const baseEbitda = toNumber(ebitdaData?.ebitda, 0) || toNumber(ebitdaData?.adjustedEbitda, 0);
  const fallbackAdjusted = toNumber(ebitdaData?.adjustedEbitda, baseEbitda);
  const adjustedEbitda = adjustmentTotal > 0 ? baseEbitda + adjustmentTotal : fallbackAdjusted;
  const costOfGoodsSold = Math.abs(
    toNumber(metrics.costOfGoodsSold, 0) || toNumber(ebitdaData?.costOfGoodsSold, 0),
  );
  const extractedGrossProfit = toNumber(metrics.grossProfit, 0) || toNumber(ebitdaData?.grossProfit, 0);
  const hasGrossProfitData = Boolean(
    metrics.hasGrossProfitData ||
    ebitdaData?.hasGrossProfitData ||
    costOfGoodsSold ||
    extractedGrossProfit,
  );
  const grossProfit = extractedGrossProfit || (hasGrossProfitData ? revenue - costOfGoodsSold : 0);
  const depreciation = toNumber(ebitdaData?.components?.depreciation?.value, 0);
  const amortization = toNumber(ebitdaData?.components?.amortization?.value, 0);
  const interestExpense = toNumber(ebitdaData?.components?.interestExpense?.value, 0);
  const interestIncome = toNumber(ebitdaData?.components?.interestIncome?.value, 0);
  const taxes = toNumber(ebitdaData?.components?.taxes?.value, 0);
  const netProfit = toNumber(metrics.netProfit, 0) || toNumber(ebitdaData?.components?.netIncome?.value, 0);
  const da = depreciation + amortization;
  const ebit = adjustedEbitda - da;
  const preTaxIncome = netProfit + taxes;
  const cash = toNumber(metrics.cashAndBankBalance, 0);
  const totalDebt = toNumber(metrics.totalDebt, 0) || toNumber(metrics.longTermDebt, 0);
  const netDebt = toNumber(metrics.netDebt, 0) || (totalDebt ? totalDebt - cash : 0);

  return {
    year,
    ...metrics,
    totalRevenue: revenue,
    netProfit,
    ebitda: baseEbitda,
    adjustedEbitda,
    addbacksTotal: Math.max(0, adjustedEbitda - baseEbitda),
    addbacksCount: adjustmentCount,
    ebitdaMargin: revenue > 0 ? (adjustedEbitda / revenue) * 100 : 0,
    reportedEbitdaMargin: revenue > 0 ? (baseEbitda / revenue) * 100 : 0,
    costOfGoodsSold,
    grossProfit,
    grossMargin: revenue > 0 && hasGrossProfitData ? (grossProfit / revenue) * 100 : 0,
    depreciationAmortization: da,
    ebit,
    taxes,
    interestExpense,
    interestIncome,
    preTaxIncome,
    totalDebt,
    netDebt,
    netDebtEbitdaRatio: adjustedEbitda ? netDebt / adjustedEbitda : 0,
    longTermDebtEbitdaRatio: baseEbitda ? toNumber(metrics.longTermDebt, 0) / baseEbitda : 0,
    effectiveTaxRate: preTaxIncome > 0 ? (taxes / preTaxIncome) * 100 : 0,
    currentAssetsApprox:
      toNumber(metrics.cashAndBankBalance, 0) +
      toNumber(metrics.accountReceivable, 0) +
      toNumber(metrics.inventoryValue, 0),
    currentLiabilitiesApprox: toNumber(metrics.accountPayable, 0),
    ...cashflow,
  };
}

export async function loadCimFinancialAutofillSnapshot({
  clientId,
  sourceKey,
  selectedDatasetVersion = "",
  dateRange = null,
} = {}) {
  const normalizedSource = normalizeReportSourceKey(sourceKey) || REPORT_SOURCE_KEYS.QUICKBOOKS;
  const sourceMode = getReportSourceMode(normalizedSource);
  const datasetVersion = normalizedSource === REPORT_SOURCE_KEYS.MANUAL_GL
    ? await getManualGlDatasetVersion(clientId, selectedDatasetVersion)
    : "";
  const selectedRange = normalizeDateRange(dateRange);
  const selectedFiscalYear = selectedRange?.fiscalYear || 0;
  const selectedStartYear = getYearFromDate(selectedRange?.startDate);
  const isSingleFiscalYearRange = Boolean(
    selectedRange && selectedStartYear === selectedFiscalYear,
  );
  const availableYears = await getAvailableYears({
    clientId,
    sourceKey: normalizedSource,
    selectedDatasetVersion: datasetVersion,
  });
  const recentYears = (
    selectedFiscalYear
      ? sortYearsDescending([
        ...availableYears.filter((year) => Number(year) <= selectedFiscalYear),
        selectedFiscalYear,
      ])
      : sortYearsDescending(availableYears)
  ).slice(0, 6);
  const years = sortYearsDescending([
    ...recentYears,
    selectedStartYear,
    selectedFiscalYear,
  ]);

  const metricsByYear = {};
  await Promise.all(
    years.map(async (year) => {
      try {
        metricsByYear[year] = await loadKpisForYear({
          clientId,
          sourceKey: normalizedSource,
          sourceMode,
          year,
          datasetVersion,
        });
      } catch {
        metricsByYear[year] = {};
      }
    }),
  );

  if (isSingleFiscalYearRange) {
    try {
      const annualMetrics = metricsByYear[selectedFiscalYear] || {};
      const rangeMetrics = await loadKpisForDateRange({
        clientId,
        sourceKey: normalizedSource,
        sourceMode,
        startDate: selectedRange.startDate,
        endDate: selectedRange.endDate,
        fiscalYear: selectedFiscalYear,
        datasetVersion,
      });
      metricsByYear[selectedFiscalYear] = {
        ...annualMetrics,
        ...rangeMetrics,
        cashAndBankBalance:
          toNumber(rangeMetrics.cashAndBankBalance, 0) || toNumber(annualMetrics.cashAndBankBalance, 0),
        longTermDebt:
          toNumber(rangeMetrics.longTermDebt, 0) || toNumber(annualMetrics.longTermDebt, 0),
        totalDebt:
          toNumber(rangeMetrics.totalDebt, 0) || toNumber(annualMetrics.totalDebt, 0),
      };
    } catch {
      metricsByYear[selectedFiscalYear] = metricsByYear[selectedFiscalYear] || {};
    }
  }

  const usableYears = years.filter((year) => isMeaningfulMetricSet(metricsByYear[year]));
  const selectedYears = selectedFiscalYear
    ? sortYearsDescending([
      ...(usableYears.length ? usableYears : years),
      selectedStartYear,
      selectedFiscalYear,
    ])
    : (usableYears.length ? usableYears : years);
  const ebitdaByYear = await loadEbitdaByYear({
    clientId,
    sourceKey: normalizedSource,
    sourceMode,
    years: selectedYears,
    datasetVersion,
  });
  if (isSingleFiscalYearRange) {
    try {
      const rangeEbitda = await loadEbitdaForDateRange({
        clientId,
        sourceKey: normalizedSource,
        sourceMode,
        startDate: selectedRange.startDate,
        endDate: selectedRange.endDate,
        fiscalYear: selectedFiscalYear,
        datasetVersion,
      });
      if (rangeEbitda && (
        Math.abs(toNumber(rangeEbitda.ebitda, 0)) > 0.0001 ||
        Math.abs(toNumber(rangeEbitda.adjustedEbitda, 0)) > 0.0001 ||
        Math.abs(toNumber(rangeEbitda.revenue, 0)) > 0.0001
      )) {
        ebitdaByYear[selectedFiscalYear] = rangeEbitda;
      }
    } catch {
      ebitdaByYear[selectedFiscalYear] = ebitdaByYear[selectedFiscalYear] || null;
    }
  }
  const adjustments = await loadAdjustmentTotals({
    clientId,
    sourceKey: normalizedSource,
    years: selectedYears,
    datasetVersion,
  });
  const cashflowByYear = await loadCashflowByYear({
    clientId,
    sourceMode,
    years: selectedYears,
    datasetVersion,
  });
  if (isSingleFiscalYearRange) {
    try {
      const rangeCashflow = await loadCashflowForDateRange({
        clientId,
        sourceKey: normalizedSource,
        sourceMode,
        startDate: selectedRange.startDate,
        endDate: selectedRange.endDate,
        fiscalYear: selectedFiscalYear,
        datasetVersion,
      });
      if (Object.values(rangeCashflow || {}).some((value) => Math.abs(toNumber(value, 0)) > 0.0001)) {
        cashflowByYear[selectedFiscalYear] = rangeCashflow;
      }
    } catch {
      cashflowByYear[selectedFiscalYear] = cashflowByYear[selectedFiscalYear] || {};
    }
  }

  const enrichedByYear = {};
  selectedYears.forEach((year) => {
    enrichedByYear[year] = enrichYearMetric({
      year,
      metrics: metricsByYear[year] || {},
      ebitdaData: ebitdaByYear[year],
      adjustmentTotal: toNumber(adjustments.totals?.[year] ?? adjustments.totals?.[String(year)], 0),
      adjustmentCount: adjustments.count || 0,
      cashflow: cashflowByYear[year] || {},
    });
  });

  const sortedAscending = sortYearsDescending(selectedYears).reverse();
  const latestYear = selectedFiscalYear || sortedAscending[sortedAscending.length - 1] || new Date().getFullYear();

  return {
    sourceKey: normalizedSource,
    sourceMode,
    datasetVersion,
    years: sortedAscending,
    latestYear,
    currentPeriod: selectedRange
      ? {
        startDate: selectedRange.startDate,
        endDate: selectedRange.endDate,
        startFiscalYear: selectedStartYear,
        fiscalYear: selectedFiscalYear,
        months: getInclusiveMonthSpan(selectedRange.startDate, selectedRange.endDate),
      }
      : null,
    metricsByYear: enrichedByYear,
  };
}
