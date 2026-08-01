import { fetchDashboardKPIs } from "./reportService";
import { loadManualUploadDashboard } from "./manualUploadDashboardService";
import { loadQMSDashboard } from "./qmsManualDashboardService";
import { getCashflow } from "./cashflowService";
import { getBalanceSheet } from "./balanceSheetService";
import { getProfitAndLoss } from "./profitAndLossService";
import {
  extractEbitdaFromManualPLRows,
  getEbitdaData,
} from "./ebitdaService";
import {
  calculateAdjustmentTotalsByYear,
  filterAdjustmentsByApprovalStatus,
  getAdjustmentYearValue,
  loadAdjustmentWorkspaceData,
} from "./ebitdaAdjustmentService";
import {
  getAllManualUploadedReports,
  getAllQMSUploadedReports,
  getKeyReportVersion,
  getKeyReportVersions,
  getCimBankReconciliationRequest,
  getCimProfitLossForTaxRequest,
  getCimTaxReconciliationRequest,
  getManualStageFilterOptions,
  getManualStagedProfitLossSummary,
  getKeyReportVersionReport,
  getReportSources,
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

const REPORT_CATEGORY_LABELS = {
  profit_loss: "Profit & Loss",
  balance_sheet: "Balance Sheet",
  general_ledger: "General Ledger",
  bank_statement: "Bank Statement",
  tax_return: "Tax Return",
};

const SOURCE_LABELS = {
  [REPORT_SOURCE_KEYS.QUICKBOOKS]: "QuickBooks Online",
  [REPORT_SOURCE_KEYS.MANUAL_GL]: "Manual GL Upload",
  [REPORT_SOURCE_KEYS.MANUAL_UPLOAD]: "Manual Upload",
  [REPORT_SOURCE_KEYS.QUICKBOOKS_MANUAL]: "QuickBooks Manual",
};

const CIM_AUTOFILL_CACHE_TTL_MS = 2 * 60 * 1000;
const cimAutofillSnapshotCache = new Map();
const cimDashboardRequestCache = new Map();

function getCimAutofillCacheKey({ clientId, sourceKey, selectedDatasetVersion, selectedReportVersionId, dateRange }) {
  return [
    clientId || "",
    sourceKey || "",
    selectedDatasetVersion || "",
    selectedReportVersionId || "",
    dateRange?.startDate || "",
    dateRange?.endDate || "",
    dateRange?.periodType || "calendar",
  ].join("|");
}

async function loadCimDashboardOnce(sourceKey, clientId) {
  const key = `${sourceKey}|${clientId || ""}`;
  const cached = cimDashboardRequestCache.get(key);
  if (cached && Date.now() - cached.cachedAt < CIM_AUTOFILL_CACHE_TTL_MS) {
    return cached.request;
  }
  if (!cached || Date.now() - cached.cachedAt >= CIM_AUTOFILL_CACHE_TTL_MS) {
    const request = sourceKey === REPORT_SOURCE_KEYS.MANUAL_UPLOAD
      ? loadManualUploadDashboard("all", { clientId })
      : loadQMSDashboard("all", { clientId });
    cimDashboardRequestCache.set(key, { cachedAt: Date.now(), request });
    request.catch(() => cimDashboardRequestCache.delete(key));
  }
  return cimDashboardRequestCache.get(key).request;
}

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

function mapRawDashboardKpis(kpis = {}) {
  return {
    totalRevenue: toNumber(kpis.totalRevenue, 0),
    totalExpenses: toNumber(kpis.totalExpenses, 0),
    netProfit: toNumber(kpis.netProfit, 0),
    totalAssets: toNumber(kpis.totalAssets, 0),
    totalLiabilities: toNumber(kpis.totalLiabilities, 0),
    totalEquity: toNumber(kpis.totalEquity, 0),
    workingCapital: toNumber(kpis.workingCapital, 0),
    cashAndBankBalance: toNumber(kpis.cashAndBankBalance, 0),
    accountReceivable: toNumber(kpis.accountsReceivable, 0),
    inventoryValue: toNumber(kpis.inventoryValue, 0),
    accountPayable: toNumber(kpis.accountsPayable, 0),
    longTermDebt: toNumber(kpis.longTermDebt, 0),
  };
}

function getFinancialTolerance(...values) {
  const scale = Math.max(0, ...values.map((value) => Math.abs(toNumber(value, 0))));
  return Math.max(5, scale * 0.005);
}

function makeComparisonCheck({ id, year, label, actual, expected, sources }) {
  const actualValue = toNumber(actual, 0);
  const expectedValue = toNumber(expected, 0);
  const difference = actualValue - expectedValue;
  const tolerance = getFinancialTolerance(actualValue, expectedValue);
  return {
    id: `${year}:${id}`,
    year,
    label,
    status: Math.abs(difference) <= tolerance ? "verified" : "discrepancy",
    actual: actualValue,
    expected: expectedValue,
    difference,
    tolerance,
    sources,
  };
}

function flattenMappingLedger(mappingsByCategory = {}) {
  return Object.entries(mappingsByCategory).flatMap(([category, mappings]) =>
    (Array.isArray(mappings) ? mappings : []).map((mapping) => ({
      category,
      categoryLabel: REPORT_CATEGORY_LABELS[category] || category,
      fileName: mapping.fileName || "Linked report",
      documentId: mapping.documentId || null,
    })),
  );
}

async function loadCimSourceLedger({ clientId, sourceKey, selectedDatasetVersion, selectedReportVersionId }) {
  const sourceLabel = SOURCE_LABELS[sourceKey] || "Financial reports";
  if (sourceKey === REPORT_SOURCE_KEYS.QUICKBOOKS && !selectedReportVersionId) {
    return {
      sourceKey,
      sourceLabel,
      status: "verified",
      verified: true,
      versionId: null,
      versionName: "Live accounting connection",
      lastSyncedAt: null,
      documents: [{ category: "live_accounting", categoryLabel: sourceLabel, fileName: sourceLabel }],
      issues: [],
    };
  }

  if (!selectedReportVersionId) {
    if (sourceKey === REPORT_SOURCE_KEYS.MANUAL_GL) {
      try {
        const versions = await listManualGlDatasetVersions({ clientId });
        const selectedVersionKey = String(selectedDatasetVersion || "").trim();
        const version = selectedVersionKey
          ? versions.find((item) => String(item.value ?? item.dataset_version ?? item.version_number ?? "") === selectedVersionKey)
          : versions.find((item) => item.isActive || item.is_active) || versions[0] || null;
        return {
          sourceKey,
          sourceLabel,
          status: version ? "verified" : "unverified",
          verified: Boolean(version),
          versionId: null,
          versionName: version?.label || (selectedVersionKey ? `Version ${selectedVersionKey}` : "Current Manual GL source"),
          datasetVersion: version?.value ?? version?.dataset_version ?? selectedDatasetVersion ?? null,
          lastSyncedAt: version?.createdAt || version?.created_at || null,
          documents: [{ category: "manual_gl", categoryLabel: sourceLabel, fileName: version?.label || sourceLabel }],
          issues: version ? [] : ["No Manual GL dataset version is available for this company."],
        };
      } catch (error) {
        return {
          sourceKey,
          sourceLabel,
          status: selectedDatasetVersion ? "verified" : "unverified",
          verified: Boolean(selectedDatasetVersion),
          versionId: null,
          versionName: selectedDatasetVersion ? `Version ${selectedDatasetVersion}` : "Manual GL source",
          datasetVersion: selectedDatasetVersion || null,
          lastSyncedAt: null,
          documents: [{ category: "manual_gl", categoryLabel: sourceLabel, fileName: sourceLabel }],
          issues: selectedDatasetVersion ? [] : [error?.message || "Manual GL source validation failed."],
        };
      }
    }

    if (sourceKey === REPORT_SOURCE_KEYS.MANUAL_UPLOAD || sourceKey === REPORT_SOURCE_KEYS.QUICKBOOKS_MANUAL) {
      return {
        sourceKey,
        sourceLabel,
        status: "verified",
        verified: true,
        versionId: null,
        versionName: "Current connected source",
        datasetVersion: null,
        lastSyncedAt: null,
        documents: [{ category: "connected_source", categoryLabel: sourceLabel, fileName: sourceLabel }],
        issues: [],
      };
    }
  }

  try {
    const response = await getKeyReportVersions();
    const versions = response?.versions || [];
    const requestedReportVersionId = String(selectedReportVersionId || "").trim();
    const requestedDatasetVersion = String(selectedDatasetVersion || "").trim();
    const version = (
      requestedReportVersionId
        ? versions.find((item) => String(item.id) === requestedReportVersionId)
        : requestedDatasetVersion
        ? versions.find((item) => String(item.resolvedDatasetVersion ?? "") === requestedDatasetVersion)
        : null
    ) || versions.find((item) => item.isActive) || versions[0] || null;

    if (!version?.id) {
      return {
        sourceKey,
        sourceLabel,
        status: "unverified",
        verified: false,
        versionId: null,
        versionName: "No Key Reports version",
        lastSyncedAt: null,
        documents: [],
        issues: ["No active Key Reports version is available for this financial source."],
      };
    }

    const detail = await getKeyReportVersion(version.id);
    const mappings = detail?.mappingsByCategory || {};
    const documents = flattenMappingLedger(mappings);
    const hasProfitAndLoss = Boolean(mappings.profit_loss?.length);
    const hasBalanceSheet = Boolean(mappings.balance_sheet?.length);
    const hasGeneralLedger = Boolean(mappings.general_ledger?.length);
    const hasCoreReports = sourceKey === REPORT_SOURCE_KEYS.MANUAL_GL
      ? hasGeneralLedger || (hasProfitAndLoss && hasBalanceSheet)
      : hasProfitAndLoss && hasBalanceSheet;
    const synced = version.status === "synced" && Boolean(version.lastSyncedAt);
    const issues = [];
    if (!synced) issues.push("The selected Key Reports version has not completed a successful sync.");
    if (!hasCoreReports) {
      issues.push(sourceKey === REPORT_SOURCE_KEYS.MANUAL_GL
        ? "Link a General Ledger or both Profit & Loss and Balance Sheet reports."
        : "Link both Profit & Loss and Balance Sheet reports.");
    }

    return {
      sourceKey,
      sourceLabel: SOURCE_LABELS[version.resolvedBatchId ? REPORT_SOURCE_KEYS.MANUAL_GL : REPORT_SOURCE_KEYS.MANUAL_UPLOAD] || sourceLabel,
      status: synced && hasCoreReports ? "verified" : "unverified",
      verified: synced && hasCoreReports,
      versionId: version.id,
      versionName: version.versionName || `Version ${version.versionNumber || ""}`.trim(),
      datasetVersion: version.resolvedDatasetVersion ?? selectedDatasetVersion ?? null,
      lastSyncedAt: version.lastSyncedAt || null,
      documents,
      issues,
    };
  } catch (error) {
    return {
      sourceKey,
      sourceLabel,
      status: "unverified",
      verified: false,
      versionId: null,
      versionName: "Source ledger unavailable",
      lastSyncedAt: null,
      documents: [],
      issues: [error?.message || "Key Reports source validation failed."],
    };
  }
}

function getFiscalYearRange(year, periodType = "calendar") {
  if (periodType === "fiscal") {
    return {
      start: `${Number(year) - 1}-04-01`,
      end: `${year}-03-31`,
    };
  }
  return {
    start: `${year}-01-01`,
    end: `${year}-12-31`,
  };
}

function isDateInput(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function normalizeDateRange(dateRange) {
  const startDate = String(dateRange?.startDate || "").trim();
  const endDate = String(dateRange?.endDate || "").trim();
  if (!isDateInput(startDate) || !isDateInput(endDate)) return null;
  if (new Date(startDate) > new Date(endDate)) return null;
  const periodType = dateRange?.periodType === "fiscal" ? "fiscal" : "calendar";
  const end = new Date(`${endDate}T00:00:00`);
  const endYear = end.getFullYear();
  const annualFiscalYear = periodType === "fiscal"
    ? (end.getMonth() > 2 ? endYear + 1 : endYear)
    : endYear;
  const annualRange = getFiscalYearRange(annualFiscalYear, periodType);
  const trailingStart = new Date(end);
  trailingStart.setFullYear(trailingStart.getFullYear() - 1);
  trailingStart.setDate(trailingStart.getDate() + 1);

  return {
    companyStartDate: isDateInput(dateRange?.companyStartDate) ? String(dateRange.companyStartDate) : "",
    startDate,
    endDate,
    periodType,
    fiscalYear: annualFiscalYear,
    annualStartDate: annualRange.start,
    annualEndDate: annualRange.end,
    trailingStartDate: [
      trailingStart.getFullYear(),
      String(trailingStart.getMonth() + 1).padStart(2, "0"),
      String(trailingStart.getDate()).padStart(2, "0"),
    ].join("-"),
  };
}

function getFiscalYearFromDate(value, periodType = "calendar") {
  if (!isDateInput(value)) return 0;
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return 0;
  return periodType === "fiscal" && date.getMonth() > 2
    ? date.getFullYear() + 1
    : date.getFullYear();
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

const TAX_RECONCILIATION_LINE_ITEM_LABELS = [
  "Total Revenue",
  "Total Cost of Goods Sold",
  "Gross Profit",
  "Officer Wages",
  "Depreciation Expense",
  "Amortization Expense",
  "Total Interest Expense",
  "All Other Expenses",
  "All Other Income",
  "Net Income",
];

function normalizeTaxLineItemKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function getCanonicalTaxLineItemLabel(value) {
  const key = normalizeTaxLineItemKey(value);
  if (!key) return "";
  const aliases = [
    ["Total Revenue", ["total revenue", "total income", "net revenue", "total sales", "gross receipts"]],
    ["Total Cost of Goods Sold", ["total cost of goods sold", "cost of goods sold", "cost of sales", "total cogs", "cogs"]],
    ["Gross Profit", ["gross profit", "gross margin"]],
    ["Officer Wages", ["officer wages", "officer compensation", "officer salary", "officer pay", "guaranteed payments", "s corp officer"]],
    ["Depreciation Expense", ["depreciation expense", "depreciation and amortization", "depreciation"]],
    ["Amortization Expense", ["amortization expense", "amortization"]],
    ["Total Interest Expense", ["total interest expense", "interest expense", "loan interest"]],
    ["All Other Expenses", ["all other expenses", "total other expenses", "other expenses", "total expenses"]],
    ["All Other Income", ["all other income", "total other income", "other income", "other revenue"]],
    ["Net Income", ["net income", "net loss", "net earnings", "net profit"]],
  ];
  return aliases.find(([, patterns]) =>
    patterns.some((pattern) => key.includes(normalizeTaxLineItemKey(pattern)) || normalizeTaxLineItemKey(pattern).includes(key)),
  )?.[0] || value;
}

function flattenTaxProfitLossRows(rows = [], depth = 0) {
  return (rows || []).flatMap((row) => {
    const label = String(row.name || row.label || row.account || "").trim();
    const amount = row.amount ?? row.value ?? row.total ?? row.pl ?? 0;
    const current = label
      ? [{
        label,
        value: toNumber(amount, 0),
        depth,
        type: String(row.type || row.rowType || "data").toLowerCase(),
      }]
      : [];
    const children = Array.isArray(row.children) ? flattenTaxProfitLossRows(row.children, depth + 1) : [];
    return [...current, ...children];
  });
}

function findTaxProfitLossAmount(flatRows, patterns, preferTotal = true) {
  const normalizedPatterns = patterns.map(normalizeTaxLineItemKey);
  const matches = flatRows.filter((row) => {
    const key = normalizeTaxLineItemKey(row.label);
    return normalizedPatterns.some((pattern) => key.includes(pattern) || pattern.includes(key));
  });
  if (!matches.length) return 0;
  if (preferTotal) {
    const totals = matches.filter((row) => row.type === "total");
    if (totals.length) return totals[totals.length - 1].value;
  }
  return matches[matches.length - 1].value;
}

function extractTaxRowsFromProfitLossRows(rows = []) {
  const flatRows = flattenTaxProfitLossRows(rows);
  const officerWages = findTaxProfitLossAmount(flatRows, ["officer compensation", "officer wages", "officer salary", "officer pay", "s-corp officer"], false);
  const depreciation = findTaxProfitLossAmount(flatRows, ["depreciation expense", "depreciation & amortization", "depreciation"], false);
  const amortization = findTaxProfitLossAmount(flatRows, ["amortization expense", "amortization"], false);
  const interestExpense = findTaxProfitLossAmount(flatRows, ["total interest expense", "interest expense", "loan interest"], false);
  const totalExpenses = findTaxProfitLossAmount(flatRows, ["total expenses", "total operating expenses", "total expense"]);
  const allOtherExpenses = totalExpenses > 0
    ? Math.max(0, totalExpenses - officerWages - depreciation - amortization - interestExpense)
    : 0;

  return [
    { label: "Total Revenue", pl: findTaxProfitLossAmount(flatRows, ["total income", "total revenue", "net revenue", "total sales"]) },
    { label: "Total Cost of Goods Sold", pl: findTaxProfitLossAmount(flatRows, ["total cost of goods sold", "cost of goods sold", "cost of sales", "total cogs"]) },
    { label: "Gross Profit", pl: findTaxProfitLossAmount(flatRows, ["gross profit", "gross margin"]) },
    { label: "Officer Wages", pl: officerWages },
    { label: "Depreciation Expense", pl: depreciation },
    { label: "Amortization Expense", pl: amortization },
    { label: "Total Interest Expense", pl: interestExpense },
    { label: "All Other Expenses", pl: allOtherExpenses },
    { label: "All Other Income", pl: findTaxProfitLossAmount(flatRows, ["total other income", "other income", "other revenue"]) },
    { label: "Net Income", pl: findTaxProfitLossAmount(flatRows, ["net income", "net loss", "net earnings", "net profit"]) },
  ];
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

const BANK_BALANCE_MATCH_STOP_WORDS = new Set([
  "bank",
  "banks",
  "banking",
  "financial",
  "corp",
  "inc",
  "llc",
  "ltd",
  "national",
  "savings",
  "credit",
  "union",
  "trust",
  "services",
  "group",
  "company",
]);

function hasNumericValue(value) {
  return value !== null && value !== undefined && value !== "";
}

function toNullableNumber(value) {
  if (!hasNumericValue(value)) return null;
  const numeric = toNumber(value, null);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeBankBalanceName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getLastFourDigits(value) {
  const match = String(value || "").match(/\b(\d{4})\b/);
  return match ? match[1] : "";
}

function getBankBalanceWords(value, { significantOnly = false } = {}) {
  const words = normalizeBankBalanceName(value)
    .split(" ")
    .filter((word) => word.length > 2 && !/^\d+$/.test(word));
  return significantOnly
    ? words.filter((word) => !BANK_BALANCE_MATCH_STOP_WORDS.has(word))
    : words;
}

function normalizeBalanceSheetBankAccounts(data = {}) {
  const payload = data?.balanceSheetBankAccounts || data?.bsBankBalances || {};
  const accounts = Array.isArray(payload?.bankAccounts)
    ? payload.bankAccounts
    : Array.isArray(payload)
    ? payload
    : Array.isArray(data?.bankAccounts)
    ? data.bankAccounts
    : [];
  const sourceYear = payload?.year || data?.year || null;

  return accounts.map((account) => {
    const name = account?.name || account?.accountName || account?.bankName || "";
    const amount = toNullableNumber(account?.amount ?? account?.balance ?? account?.endingBalance);
    const rawMonthAmounts = account?.monthAmounts && typeof account.monthAmounts === "object"
      ? account.monthAmounts
      : null;
    const monthAmounts = rawMonthAmounts
      ? Object.fromEntries(Object.entries(rawMonthAmounts)
        .map(([monthKey, value]) => [monthKey, toNullableNumber(value)])
        .filter(([, value]) => value !== null))
      : null;
    return {
      name,
      normalizedName: normalizeBankBalanceName(name),
      accountNumber: getLastFourDigits(account?.accountNumber || account?.account_number || name),
      amount,
      year: account?.year || sourceYear,
      monthAmounts,
    };
  }).filter((account) => account.name || account.accountNumber);
}

function findBalanceSheetBankMatch(queryName, balanceSheetAccounts = []) {
  if (!queryName || !balanceSheetAccounts.length) return null;
  const queryNumber = getLastFourDigits(queryName);
  const queryNameNormalized = normalizeBankBalanceName(queryName);
  const namedAccounts = balanceSheetAccounts.filter((account) => account.normalizedName);
  if (queryNumber) {
    const numberMatches = balanceSheetAccounts.filter((account) => account.accountNumber === queryNumber);
    if (numberMatches.length === 1) return numberMatches[0];
    if (numberMatches.length > 1) {
      const exactNameMatch = numberMatches.filter((account) => account.normalizedName).find((account) =>
        account.normalizedName === queryNameNormalized ||
        queryNameNormalized.includes(account.normalizedName) ||
        account.normalizedName.includes(queryNameNormalized));
      if (exactNameMatch) return exactNameMatch;
    }
  }

  const exact = namedAccounts.find((account) => account.normalizedName === queryNameNormalized);
  if (exact) return exact;
  const contains = namedAccounts.find((account) =>
    account.normalizedName.includes(queryNameNormalized) ||
    queryNameNormalized.includes(account.normalizedName));
  if (contains) return contains;

  const significantWords = getBankBalanceWords(queryName, { significantOnly: true });
  const allWords = getBankBalanceWords(queryName);
  for (const significantOnly of [true, false]) {
    const queryWords = significantOnly ? significantWords : allWords;
    if (!queryWords.length) continue;
    let bestScore = 0;
    let bestMatch = null;
    namedAccounts.forEach((account) => {
      const accountWords = getBankBalanceWords(account.name, { significantOnly });
      const overlap = queryWords.filter((word) => accountWords.includes(word)).length;
      const score = overlap / Math.max(queryWords.length, accountWords.length, 1);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = account;
      }
    });
    if (bestMatch && bestScore > (significantOnly ? 0 : 0.3)) return bestMatch;
  }
  return null;
}

function resolveBalanceSheetBookBalance({ bankName, accountName, month, balanceSheetAccounts }) {
  const match = findBalanceSheetBankMatch([bankName, accountName].filter(Boolean).join(" "), balanceSheetAccounts) ||
    findBalanceSheetBankMatch(bankName, balanceSheetAccounts) ||
    findBalanceSheetBankMatch(accountName, balanceSheetAccounts);
  if (!match) return { amount: null, source: "" };

  const monthKey = String(month || "");
  if (match.monthAmounts && monthKey && match.monthAmounts[monthKey] !== undefined) {
    return { amount: match.monthAmounts[monthKey], source: match.name };
  }

  const yearEndMonth = match.year ? `${match.year}-12` : "";
  if (match.amount !== null && (!monthKey || !yearEndMonth || monthKey === yearEndMonth)) {
    return { amount: match.amount, source: match.name };
  }

  return { amount: null, source: match.name };
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

async function getAvailableYears({ clientId, sourceKey, selectedDatasetVersion, keyReportVersionId }) {
  const normalizedSource = normalizeReportSourceKey(sourceKey) || REPORT_SOURCE_KEYS.QUICKBOOKS;
  if (keyReportVersionId) return [];

  if (normalizedSource === REPORT_SOURCE_KEYS.MANUAL_UPLOAD) {
    const dashboard = await loadCimDashboardOnce(normalizedSource, clientId);
    return sortYearsDescending(dashboard.availableYears || []);
  }

  if (normalizedSource === REPORT_SOURCE_KEYS.QUICKBOOKS_MANUAL) {
    const dashboard = await loadCimDashboardOnce(normalizedSource, clientId);
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

async function loadKpisForYear({ clientId, sourceKey, sourceMode, year, datasetVersion, periodType }) {
  if (sourceKey === REPORT_SOURCE_KEYS.MANUAL_UPLOAD) {
    return mapKpisToMetrics((await loadManualUploadDashboard(year, { clientId })).kpis || []);
  }
  if (sourceKey === REPORT_SOURCE_KEYS.QUICKBOOKS_MANUAL) {
    return mapKpisToMetrics((await loadQMSDashboard(year, { clientId })).kpis || []);
  }

  const range = getFiscalYearRange(year, periodType);
  return mapKpisToMetrics(await fetchDashboardKPIs(range.start, range.end, {
    sourceMode,
    datasetVersion,
  }));
}

async function loadKpisByYear({ clientId, sourceKey, sourceMode, years, datasetVersion, periodType, keyReportVersionId }) {
  if (keyReportVersionId) {
    const entries = {};
    await Promise.all(years.map(async (year) => {
      entries[year] = await loadKeyReportMetricsForYear({
        year,
        periodType,
        keyReportVersionId,
        sourceMode,
      });
    }));
    return entries;
  }

  if (sourceKey === REPORT_SOURCE_KEYS.MANUAL_UPLOAD || sourceKey === REPORT_SOURCE_KEYS.QUICKBOOKS_MANUAL) {
    const dashboard = await loadCimDashboardOnce(sourceKey, clientId);
    const reports = dashboard?._raw?.reports || {};
    return Object.fromEntries(years.map((year) => [
      year,
      mapRawDashboardKpis(reports[String(year)]?.kpis || {}),
    ]));
  }

  const entries = {};
  await Promise.all(years.map(async (year) => {
    try {
      entries[year] = await loadKpisForYear({
        clientId,
        sourceKey,
        sourceMode,
        year,
        datasetVersion,
        periodType,
      });
    } catch {
      entries[year] = {};
    }
  }));
  return entries;
}

async function loadKpisForDateRange({
  clientId,
  sourceKey,
  sourceMode,
  startDate,
  endDate,
  fiscalYear,
  datasetVersion,
  keyReportVersionId,
}) {
  if (keyReportVersionId) {
    return loadKeyReportMetricsForYear({
      year: fiscalYear,
      periodType: "calendar",
      keyReportVersionId,
      sourceMode,
      startDate,
      endDate,
    });
  }

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

async function loadUploadedEbitdaByYear({ clientId, getReports, keyReportVersionId }) {
  const result = await getReports("profit_and_loss", { clientId, keyReportVersionId }).catch(() => null);
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

function loadCachedEbitdaWorkspaceData({ clientId, sourceKey, datasetVersion }) {
  if (typeof window === "undefined" || !clientId || !sourceKey) return {};
  const versionSuffix = sourceKey === REPORT_SOURCE_KEYS.MANUAL_GL && datasetVersion
    ? `_v${datasetVersion}`
    : "";
  try {
    const raw = window.sessionStorage.getItem(`ebitda_data_${clientId}_${sourceKey}${versionSuffix}`);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed?.multiYearData && typeof parsed.multiYearData === "object"
      ? parsed.multiYearData
      : {};
  } catch {
    return {};
  }
}

async function loadEbitdaByYear({ clientId, sourceKey, sourceMode, years, datasetVersion, periodType, keyReportVersionId }) {
  if (keyReportVersionId) {
    const entries = {};
    await Promise.all(years.map(async (year) => {
      const range = getFiscalYearRange(year, periodType);
      try {
        const payload = await getProfitAndLoss(range.start, range.end, "Accrual", {
          sourceMode,
          keyReportVersionId,
          manualFilters: { fiscalYear: String(year), fromDate: range.start, toDate: range.end },
        });
        entries[year] = extractEbitdaFromManualPLRows(payload?.hierarchicalRows || payload?.rows || []);
      } catch {
        entries[year] = null;
      }
    }));
    return entries;
  }

  const cachedEntries = loadCachedEbitdaWorkspaceData({
    clientId,
    sourceKey,
    datasetVersion,
  });
  const missingYears = years.filter((year) => !cachedEntries[year] && !cachedEntries[String(year)]);
  if (missingYears.length === 0) {
    return Object.fromEntries(years.map((year) => [year, cachedEntries[year] || cachedEntries[String(year)]]));
  }

  if (sourceKey === REPORT_SOURCE_KEYS.MANUAL_UPLOAD) {
    return {
      ...cachedEntries,
      ...await loadUploadedEbitdaByYear({ clientId, getReports: getAllManualUploadedReports }),
    };
  }
  if (sourceKey === REPORT_SOURCE_KEYS.QUICKBOOKS_MANUAL) {
    return {
      ...cachedEntries,
      ...await loadUploadedEbitdaByYear({ clientId, getReports: getAllQMSUploadedReports }),
    };
  }

  const ebitdaSourceMode = sourceKey === REPORT_SOURCE_KEYS.MANUAL_GL ? "manual" : "quickbooks";
  const entries = {};
  await Promise.all(
    missingYears.map(async (year) => {
      const range = getFiscalYearRange(year, periodType);
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
  return { ...cachedEntries, ...entries };
}

async function loadEbitdaForDateRange({
  clientId,
  sourceKey,
  sourceMode,
  startDate,
  endDate,
  fiscalYear,
  datasetVersion,
  keyReportVersionId,
}) {
  if (keyReportVersionId) {
    const payload = await getProfitAndLoss(startDate, endDate, "Accrual", {
      sourceMode,
      keyReportVersionId,
      manualFilters: { fiscalYear: String(fiscalYear), fromDate: startDate, toDate: endDate },
    });
    return extractEbitdaFromManualPLRows(payload?.hierarchicalRows || payload?.rows || []);
  }

  if (sourceKey === REPORT_SOURCE_KEYS.MANUAL_UPLOAD || sourceKey === REPORT_SOURCE_KEYS.QUICKBOOKS_MANUAL) {
    const uploaded = await loadUploadedEbitdaByYear({
      clientId,
      keyReportVersionId,
      getReports: sourceKey === REPORT_SOURCE_KEYS.MANUAL_UPLOAD
        ? getAllManualUploadedReports
        : getAllQMSUploadedReports,
    });
    return uploaded[fiscalYear] || null;
  }

  const ebitdaSourceMode = sourceKey === REPORT_SOURCE_KEYS.MANUAL_GL ? "manual" : "quickbooks";
  return getEbitdaData(startDate, endDate, "Accrual", ebitdaSourceMode || sourceMode, datasetVersion);
}

function getAdjustmentLabel(adjustment = {}) {
  const explicitLabel = adjustment.name || adjustment.label || adjustment.typeLabel ||
    adjustment.linkedAccountName || adjustment.accountName;
  if (explicitLabel) return String(explicitLabel).trim();
  return String(adjustment.typeKey || adjustment.type || "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase())
    .trim();
}

function buildAdjustmentItemsByYear(adjustments = [], years = []) {
  const approvedAdjustments = filterAdjustmentsByApprovalStatus(adjustments, "approved");
  return Object.fromEntries((years || []).map((year) => [String(year), approvedAdjustments
    .map((adjustment, index) => ({
      id: adjustment.id || `${year}-adjustment-${index + 1}`,
      label: getAdjustmentLabel(adjustment),
      amount: getAdjustmentYearValue(adjustment, year),
      nature: String(adjustment.nature || adjustment.description || "").trim(),
      commentary: String(
        adjustment.supportingExplanation || adjustment.overrideReason || adjustment.internalNotes || "",
      ).trim(),
    }))
    .filter((adjustment) => adjustment.label && Math.abs(toNumber(adjustment.amount, 0)) > 0.0001)]));
}

function getLocalAdjustmentTotals(clientId, years) {
  if (typeof window === "undefined") return { totals: {}, count: 0, itemsByYear: {} };
  try {
    const raw = window.localStorage.getItem(`ebitda_addbacks_${clientId}`);
    const parsed = raw ? JSON.parse(raw) : null;
    const addbacks = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.addbacks) ? parsed.addbacks : [];
    const totals = {};
    const latestYear = Math.max(...years.map(Number).filter(Number.isFinite));
    const itemsByYear = buildAdjustmentItemsByYear(addbacks, years);
    const count = itemsByYear[String(latestYear)]?.length || 0;

    years.forEach((year) => {
      totals[String(year)] = (itemsByYear[String(year)] || [])
        .reduce((sum, adjustment) => sum + toNumber(adjustment.amount, 0), 0);
    });

    return { totals, count, itemsByYear };
  } catch {
    return { totals: {}, count: 0, itemsByYear: {} };
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
      const itemsByYear = buildAdjustmentItemsByYear(adjustments || [], years);
      const latestYear = Math.max(...years.map(Number).filter(Number.isFinite));
      const count = itemsByYear[String(latestYear)]?.length || 0;
      return { totals, count, itemsByYear };
    } catch {
      return { totals: {}, count: 0, itemsByYear: {} };
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

function getRowAmount(row, year = null) {
  if (row?.amount !== undefined) return row.amount === null || row.amount === "" ? null : toNumber(row.amount, 0);
  if (row?.value !== undefined) return row.value === null || row.value === "" ? null : toNumber(row.value, 0);
  if (row?.amounts && typeof row.amounts === "object") {
    const yearKeys = year ? [String(year), `y${year}`, `FY${year}`, `FY ${year}`] : [];
    const matchingKey = yearKeys.find((key) => Object.prototype.hasOwnProperty.call(row.amounts, key));
    if (matchingKey) {
      const value = row.amounts[matchingKey];
      return value === null || value === "" ? null : toNumber(value, 0);
    }
    const amountValues = Object.values(row.amounts);
    if (amountValues.length === 1) {
      return amountValues[0] === null || amountValues[0] === "" ? null : toNumber(amountValues[0], 0);
    }
  }
  if (Array.isArray(row?.colAmounts) && row.colAmounts.length) {
    const value = row.colAmounts[row.colAmounts.length - 1];
    return value === null || value === "" ? null : toNumber(value, 0);
  }
  const colData = row?.Summary?.ColData || row?.ColData || [];
  for (let index = colData.length - 1; index >= 0; index -= 1) {
    if (colData[index]?.value !== undefined && colData[index].value !== "") {
      return toNumber(colData[index].value, 0);
    }
  }
  return null;
}

function findCashflowAmount(rows, matchers = [], year = null) {
  const normalizedMatchers = matchers.map((matcher) => String(matcher).toLowerCase());
  const flat = flattenRows(rows);
  const match = flat.find((row) => {
    const name = getRowName(row).toLowerCase();
    return normalizedMatchers.some((matcher) => name.includes(matcher));
  });
  return match ? toNumber(getRowAmount(match, year), 0) : 0;
}

function normalizeCashflowReportRows(rows = [], year = null) {
  const output = [];
  const workingCapitalRows = new Map();

  const walk = (items, depth = 0, parentKey = "root", inheritedSection = "") => {
    let activeSection = inheritedSection;
    (Array.isArray(items) ? items : []).forEach((row, index) => {
      if (!row || typeof row !== "object") return;
      const label = getRowName(row).trim();
      const normalizedLabel = label.toLowerCase();
      if (/operating activit/.test(normalizedLabel) && !normalizedLabel.startsWith("net ")) activeSection = "operating";
      if (/investing activit/.test(normalizedLabel) && !normalizedLabel.startsWith("net ")) activeSection = "investing";
      if (/financing activit/.test(normalizedLabel) && !normalizedLabel.startsWith("net ")) activeSection = "financing";
      const rowKey = `${parentKey}:${label.toLowerCase().replace(/[^a-z0-9]+/g, "-") || index}`;
      const amount = getRowAmount(row, year);
      const isWorkingCapitalMovement = activeSection === "operating" && /^changes? in\b/i.test(label) &&
        !/^net changes? in cash\b/i.test(label);

      if (label && isWorkingCapitalMovement) {
        const childRows = [
          ...(Array.isArray(row.children) ? row.children : []),
          ...(Array.isArray(row.Rows?.Row) ? row.Rows.Row : []),
        ];
        const childAmounts = flattenRows(childRows)
          .map((child) => getRowAmount(child, year))
          .filter((childAmount) => childAmount !== null);
        const childTotal = childAmounts.reduce((sum, childAmount) => sum + Number(childAmount || 0), 0);
        const consolidatedAmount = childAmounts.length && (amount === null || (!amount && childTotal))
          ? childTotal
          : amount;
        const consolidationKey = `${parentKey}:net-working-capital`;
        const existingIndex = workingCapitalRows.get(consolidationKey);
        if (existingIndex === undefined) {
          workingCapitalRows.set(consolidationKey, output.length);
          output.push({
            key: consolidationKey,
            label: "Net changes in working capital",
            type: "data",
            depth,
            amount: consolidatedAmount,
          });
        } else if (consolidatedAmount !== null) {
          const existing = output[existingIndex];
          existing.amount = Number(existing.amount || 0) + Number(consolidatedAmount || 0);
        }
      } else if (label) {
        output.push({
          key: rowKey,
          label,
          type: row.type || (/^(total\b|net cash\b|net (increase|decrease)\b|ending cash\b)/i.test(label) ? "total" : "data"),
          depth,
          amount,
        });
      }

      if (!isWorkingCapitalMovement) {
        if (Array.isArray(row.children)) walk(row.children, depth + 1, rowKey, activeSection);
        if (Array.isArray(row.Rows?.Row)) walk(row.Rows.Row, depth + 1, rowKey, activeSection);
      }
    });
  };

  walk(rows);
  return output;
}

function extractCashflowMetrics(rows = [], year = null) {
  const hasData = flattenRows(rows).length > 0;
  const cashFromOperations = findCashflowAmount(rows, [
    "cash from operations",
    "net cash from operating",
    "net cash provided by operating",
  ], year);
  const cashFromInvesting = findCashflowAmount(rows, [
    "cash from investing",
    "net cash from investing",
    "capital expenditures",
  ], year);
  const cashFromFinancing = findCashflowAmount(rows, [
    "cash from financing",
    "net cash from financing",
  ], year);
  const netChangeInCash = findCashflowAmount(rows, [
    "net change in cash",
    "net increase",
    "net decrease",
  ], year);
  const capitalExpenditures = Math.abs(findCashflowAmount(rows, [
    "capital expenditures",
    "capex",
    "purchase of fixed assets",
    "purchases of fixed assets",
    "purchase of property",
    "purchases of property",
    "property plant and equipment",
    "payments to acquire property",
  ], year));
  const changeInWorkingCapital = findCashflowAmount(rows, [
    "changes in working capital",
    "change in working capital",
    "working capital changes",
  ], year);
  const otherNonCashItems = findCashflowAmount(rows, [
    "other non-cash",
    "other noncash",
    "non-cash adjustments",
  ], year);
  const acquisitionsDispositions = findCashflowAmount(rows, [
    "acquisitions",
    "business acquisitions",
    "purchase of business",
    "proceeds from disposition",
    "proceeds from sale of business",
  ], year);
  const netBorrowingsRepayments = findCashflowAmount(rows, [
    "net borrowings",
    "borrowings repayments",
    "proceeds from debt",
    "repayment of debt",
    "repayments of debt",
  ], year);
  const dividendsDistributions = findCashflowAmount(rows, [
    "dividends",
    "distributions",
    "owner distributions",
  ], year);

  return {
    hasData,
    cashFromOperations,
    cashFromInvesting,
    cashFromFinancing,
    netChangeInCash,
    capitalExpenditures,
    changeInWorkingCapital,
    otherNonCashItems,
    acquisitionsDispositions,
    netBorrowingsRepayments,
    dividendsDistributions,
    freeCashFlow: cashFromOperations - capitalExpenditures,
    cashflowReportRows: normalizeCashflowReportRows(rows, year),
  };
}

function normalizeFinancialRowName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getFinancialRowAmount(row, year) {
  if (row?.amounts && typeof row.amounts === "object") {
    const direct = row.amounts[year] ?? row.amounts[String(year)];
    if (direct !== undefined) return toNumber(direct, 0);
    const values = Object.values(row.amounts);
    if (values.length === 1) return toNumber(values[0], 0);
  }
  return getRowAmount(row);
}

function extractGroupedBalanceSheetMetrics(rows = [], year) {
  const flat = flattenRows(rows).map((row) => ({
    row,
    name: normalizeFinancialRowName(getRowName(row)),
    amount: getFinancialRowAmount(row, year),
    hasChildren: Array.isArray(row?.children) && row.children.length > 0,
  }));
  const leaves = flat.filter((item) => !item.hasChildren && item.row?.type !== "total");
  const sumMatches = (matchers) => leaves.reduce((sum, item) => (
    matchers.some((matcher) => matcher.test(item.name)) ? sum + item.amount : sum
  ), 0);
  const exactTotal = (matchers) => {
    const match = flat.find((item) => matchers.some((matcher) => matcher.test(item.name)));
    return match ? match.amount : 0;
  };

  const prepaidOtherCurrent = sumMatches([
    /prepaid/, /other current asset/, /short term asset/, /deferred cost/, /deposit current/,
  ]);
  const ppeNet = sumMatches([
    /property plant/, /fixed asset/, /equipment/, /leasehold improvement/, /furniture/, /vehicle/,
  ]);
  const intangiblesGoodwill = sumMatches([
    /goodwill/, /intangible/, /capitalized software/, /customer relationship/, /trade name/,
  ]);
  const accruedLiabilities = sumMatches([
    /accrued/, /payroll liabilit/, /wages payable/, /sales tax payable/, /other current liabilit/,
  ]);
  const deferredRevenue = sumMatches([/deferred revenue/, /unearned revenue/, /customer deposit/]);
  const currentDebt = sumMatches([
    /current portion.*debt/, /short term debt/, /line of credit/, /credit card/, /current.*loan/,
  ]);
  const cashAndBankBalance = sumMatches([/cash/, /bank account/, /checking/, /savings/]);
  const accountReceivable = sumMatches([/accounts? receivable/, /trade receivable/]);
  const inventoryValue = sumMatches([/inventory/, /stock in trade/]);
  const accountPayable = sumMatches([/accounts? payable/, /trade payable/]);
  const longTermDebt = sumMatches([/long term debt/, /non current.*loan/, /term loan/]);
  const currentAssetsExact = exactTotal([/^total current assets?$/, /^current assets?$/]);
  const currentLiabilitiesExact = exactTotal([/^total current liabilities?$/, /^current liabilities?$/]);

  return {
    cashAndBankBalance,
    accountReceivable,
    inventoryValue,
    accountPayable,
    longTermDebt,
    prepaidOtherCurrent,
    ppeNet,
    intangiblesGoodwill,
    accruedLiabilities,
    deferredRevenue,
    currentDebt,
    currentAssetsExact,
    currentLiabilitiesExact,
    workingCapital: currentAssetsExact - currentLiabilitiesExact,
    totalAssets: exactTotal([/^total assets?$/]),
    totalLiabilitiesExact: exactTotal([/^total liabilities$/]),
    totalEquity: exactTotal([/^total equity$/, /^shareholders equity$/, /^stockholders equity$/]),
    totalLiabilitiesEquity: exactTotal([
      /^total liabilities and equity$/,
      /^total liabilities and shareholders equity$/,
      /^total liabilities and stockholders equity$/,
    ]),
  };
}

async function loadKeyReportMetricsForYear({
  year,
  periodType,
  keyReportVersionId,
  sourceMode,
  startDate,
  endDate,
}) {
  const range = startDate && endDate
    ? { start: startDate, end: endDate }
    : getFiscalYearRange(year, periodType);
  try {
    const [profitLoss, balanceSheet] = await Promise.all([
      getProfitAndLoss(range.start, range.end, "Accrual", {
        sourceMode,
        keyReportVersionId,
        manualFilters: { fiscalYear: String(year), fromDate: range.start, toDate: range.end },
      }),
      getBalanceSheet(range.start, range.end, "Accrual", {
        sourceMode,
        keyReportVersionId,
        manualFilters: { fiscalYear: String(year), fromDate: range.start, toDate: range.end },
      }),
    ]);
    const profitLossRows = profitLoss?.hierarchicalRows || profitLoss?.rows || [];
    const ebitda = extractEbitdaFromManualPLRows(profitLossRows, range.end);
    const balance = extractGroupedBalanceSheetMetrics(balanceSheet?.rows || [], year);
    const netProfit = toNumber(ebitda?.components?.netIncome?.value, 0);
    const totalRevenue = toNumber(ebitda?.revenue, 0);
    return {
      totalRevenue,
      totalExpenses: totalRevenue - netProfit,
      netProfit,
      costOfGoodsSold: toNumber(ebitda?.costOfGoodsSold, 0),
      grossProfit: toNumber(ebitda?.grossProfit, 0),
      ...balance,
      totalLiabilities: balance.totalLiabilitiesExact,
      currentAssetsApprox: balance.currentAssetsExact,
      currentLiabilitiesApprox: balance.currentLiabilitiesExact,
    };
  } catch {
    return {};
  }
}

async function loadBalanceSheetByYear({ sourceKey, sourceMode, years, datasetVersion, periodType, keyReportVersionId }) {
  if (!keyReportVersionId && (sourceKey === REPORT_SOURCE_KEYS.MANUAL_UPLOAD || sourceKey === REPORT_SOURCE_KEYS.QUICKBOOKS_MANUAL)) {
    return {};
  }

  const entries = {};
  await Promise.all(years.map(async (year) => {
    const range = getFiscalYearRange(year, periodType);
    try {
      const payload = await getBalanceSheet(range.start, range.end, "Accrual", {
        sourceMode,
        keyReportVersionId,
        manualFilters: {
          fiscalYear: [String(year)],
          ...(datasetVersion ? { datasetVersion: String(datasetVersion) } : {}),
        },
      });
      entries[year] = extractGroupedBalanceSheetMetrics(payload?.rows || [], year);
    } catch {
      entries[year] = {};
    }
  }));
  return entries;
}

async function loadCashflowMetricsForYear({ sourceMode, year, datasetVersion, periodType, keyReportVersionId }) {
  const range = getFiscalYearRange(year, periodType);
  const manualFilters = {
    fiscalYear: [String(year)],
    fromDate: range.start,
    toDate: range.end,
    ...(datasetVersion ? { datasetVersion: String(datasetVersion) } : {}),
  };

  try {
    const payload = await getCashflow(range.start, range.end, "Accrual", {
      sourceMode,
      manualFilters,
      year,
      keyReportVersionId,
    });
    const rows = Array.isArray(payload)
      ? payload
      : payload?.rows || payload?.data?.rows || payload?.hierarchicalRows || [];

    return extractCashflowMetrics(rows, year);
  } catch {
    return {};
  }
}

async function loadCashflowMetricsForDateRange({ sourceMode, startDate, endDate, fiscalYear, datasetVersion, keyReportVersionId }) {
  const manualFilters = {
    ...(startDate ? { startDate } : {}),
    ...(endDate ? { endDate } : {}),
    ...(startDate ? { fromDate: startDate } : {}),
    ...(endDate ? { toDate: endDate } : {}),
    ...(fiscalYear ? { fiscalYear: [String(fiscalYear)] } : {}),
    ...(datasetVersion ? { datasetVersion: String(datasetVersion) } : {}),
  };

  try {
    const payload = await getCashflow(startDate, endDate, "Accrual", {
      sourceMode,
      manualFilters,
      year: fiscalYear,
      keyReportVersionId,
    });
    const rows = Array.isArray(payload)
      ? payload
      : payload?.rows || payload?.data?.rows || payload?.hierarchicalRows || [];

    return extractCashflowMetrics(rows, fiscalYear);
  } catch {
    return {};
  }
}

async function loadUploadedCashflowByYear({ clientId, getReports, keyReportVersionId }) {
  const result = await getReports("cash_flow", { clientId, keyReportVersionId }).catch(() => null);
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
    entries[year] = extractCashflowMetrics(normalizeUploadedProfitLossRows(file), year);
  });
  return entries;
}

async function loadCashflowByYear({ clientId, sourceMode, years, datasetVersion, periodType, keyReportVersionId }) {
  if (!keyReportVersionId && sourceMode === "quickbooks_manual") {
    return loadUploadedCashflowByYear({ clientId, getReports: getAllQMSUploadedReports, keyReportVersionId });
  }

  const entries = {};
  await Promise.all(
    years.map(async (year) => {
      entries[year] = await loadCashflowMetricsForYear({
        sourceMode,
        year,
        datasetVersion,
        periodType,
        keyReportVersionId,
      });
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
  keyReportVersionId,
}) {
  if (!keyReportVersionId && (sourceKey === REPORT_SOURCE_KEYS.MANUAL_UPLOAD || sourceKey === REPORT_SOURCE_KEYS.QUICKBOOKS_MANUAL)) {
    const uploaded = await loadUploadedCashflowByYear({
      clientId,
      keyReportVersionId,
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
    keyReportVersionId,
  });
}

function enrichYearMetric({
  year,
  metrics,
  ebitdaData,
  adjustmentTotal = 0,
  adjustmentCount = 0,
  cashflow = {},
  balanceSheet = {},
}) {
  const revenue = toNumber(metrics.totalRevenue, 0) || toNumber(ebitdaData?.revenue, 0);
  const hasReportedEbitda = Object.prototype.hasOwnProperty.call(ebitdaData || {}, "ebitda");
  const baseEbitda = hasReportedEbitda
    ? toNumber(ebitdaData?.ebitda, 0)
    : toNumber(ebitdaData?.adjustedEbitda, 0);
  const fallbackAdjusted = toNumber(ebitdaData?.adjustedEbitda, baseEbitda);
  const hasAdjustmentTotal = Math.abs(toNumber(adjustmentTotal, 0)) > 0.0001;
  const adjustedEbitda = hasAdjustmentTotal ? baseEbitda + adjustmentTotal : fallbackAdjusted;
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
  const reportedOperatingExpenses = Math.abs(toNumber(ebitdaData?.opex, 0));
  const hasOperatingExpensesData = Boolean(
    ebitdaData?.hasOperatingExpensesData ||
    reportedOperatingExpenses ||
    (hasGrossProfitData && ebitdaData?.hasData),
  );
  const operatingExpenses = reportedOperatingExpenses || (
    hasGrossProfitData && ebitdaData?.hasData
      ? Math.abs(grossProfit - baseEbitda)
      : 0
  );
  const depreciation = toNumber(ebitdaData?.components?.depreciation?.value, 0);
  const amortization = toNumber(ebitdaData?.components?.amortization?.value, 0);
  const interestExpense = toNumber(ebitdaData?.components?.interestExpense?.value, 0);
  const interestIncome = toNumber(ebitdaData?.components?.interestIncome?.value, 0);
  const taxes = toNumber(ebitdaData?.components?.taxes?.value, 0);
  const netProfit = toNumber(metrics.netProfit, 0) || toNumber(ebitdaData?.components?.netIncome?.value, 0);
  const da = depreciation + amortization;
  const hasAdjustedEbitdaData = Boolean(ebitdaData?.hasData);
  const hasDepreciationAmortizationData = Boolean(
    ebitdaData?.hasDepreciationAmortizationData ||
    ebitdaData?.components?.depreciation?.matchedAccounts?.length ||
    ebitdaData?.components?.amortization?.matchedAccounts?.length,
  );
  const ebit = adjustedEbitda - da;
  const preTaxIncome = netProfit + taxes;
  const cash = toNumber(metrics.cashAndBankBalance, 0);
  const totalDebt = toNumber(metrics.totalDebt, 0) || toNumber(metrics.longTermDebt, 0);
  const netDebt = toNumber(metrics.netDebt, 0) || (totalDebt ? totalDebt - cash : 0);

  return {
    year,
    ...metrics,
    ...balanceSheet,
    totalRevenue: revenue,
    netProfit,
    ebitda: baseEbitda,
    adjustedEbitda,
    addbacksTotal: adjustedEbitda - baseEbitda,
    addbacksCount: adjustmentCount,
    ebitdaMargin: revenue > 0 ? (adjustedEbitda / revenue) * 100 : 0,
    reportedEbitdaMargin: revenue > 0 ? (baseEbitda / revenue) * 100 : 0,
    costOfGoodsSold,
    grossProfit,
    hasGrossProfitData,
    grossMargin: revenue > 0 && hasGrossProfitData ? (grossProfit / revenue) * 100 : 0,
    operatingExpenses,
    hasOperatingExpensesData,
    sgaExpenses: operatingExpenses,
    depreciationAmortization: da,
    hasDepreciationAmortizationData,
    hasAdjustedEbitdaData,
    ebit,
    hasAdjustedEbitData: hasAdjustedEbitdaData && hasDepreciationAmortizationData,
    taxes,
    interestExpense,
    interestIncome,
    preTaxIncome,
    totalDebt,
    netDebt,
    netDebtEbitdaRatio: adjustedEbitda ? netDebt / adjustedEbitda : 0,
    longTermDebtEbitdaRatio: baseEbitda ? toNumber(metrics.longTermDebt, 0) / baseEbitda : 0,
    longTermDebtAdjustedEbitdaRatio: adjustedEbitda
      ? toNumber(metrics.longTermDebt, 0) / adjustedEbitda
      : 0,
    effectiveTaxRate: preTaxIncome > 0 ? (taxes / preTaxIncome) * 100 : 0,
    currentAssetsApprox:
      toNumber(balanceSheet.currentAssetsExact, 0) ||
      (
        toNumber(metrics.cashAndBankBalance, 0) +
        toNumber(metrics.accountReceivable, 0) +
        toNumber(metrics.inventoryValue, 0) +
        toNumber(balanceSheet.prepaidOtherCurrent, 0)
      ),
    currentLiabilitiesApprox:
      toNumber(balanceSheet.currentLiabilitiesExact, 0) ||
      (
        toNumber(metrics.accountPayable, 0) +
        toNumber(balanceSheet.accruedLiabilities, 0) +
        toNumber(balanceSheet.deferredRevenue, 0) +
        toNumber(balanceSheet.currentDebt, 0)
      ),
    ...cashflow,
  };
}

export function buildCimFinancialValidation({
  sourceLedger,
  years = [],
  metricsByYear = {},
  ebitdaByYear = {},
  cashflowByYear = {},
  adjustments = { totals: {} },
  enrichedByYear = {},
} = {}) {
  const checks = [];
  const calculations = [];

  years.forEach((year) => {
    const metrics = metricsByYear[year] || {};
    const ebitdaData = ebitdaByYear[year] || null;
    const cashflow = cashflowByYear[year] || {};
    const enriched = enrichedByYear[year] || {};
    const adjustmentTotal = toNumber(
      adjustments?.totals?.[year] ?? adjustments?.totals?.[String(year)],
      0,
    );
    const extractedAdjustment = toNumber(ebitdaData?.adjustedEbitda, 0) - toNumber(ebitdaData?.ebitda, 0);
    const bridgeAdjustment = Math.abs(adjustmentTotal) > 0.0001 ? adjustmentTotal : extractedAdjustment;

    if (ebitdaData?.hasData && Object.prototype.hasOwnProperty.call(metrics, "totalRevenue")) {
      checks.push(makeComparisonCheck({
        id: "revenue-cross-check",
        year,
        label: "Revenue agrees between Analytics and the P&L / EBITDA report",
        actual: metrics.totalRevenue,
        expected: ebitdaData.revenue,
        sources: ["Analytics", "Profit & Loss"],
      }));
    }

    const reportNetIncome = ebitdaData?.components?.netIncome?.value;
    if (ebitdaData?.hasData && Object.prototype.hasOwnProperty.call(metrics, "netProfit")) {
      checks.push(makeComparisonCheck({
        id: "net-income-cross-check",
        year,
        label: "Net income agrees between Analytics and the P&L / EBITDA report",
        actual: metrics.netProfit,
        expected: reportNetIncome,
        sources: ["Analytics", "Profit & Loss"],
      }));
    }

    if (
      Math.abs(toNumber(metrics.totalAssets, 0)) > 0.0001 &&
      (Math.abs(toNumber(metrics.totalLiabilities, 0)) > 0.0001 ||
        Math.abs(toNumber(metrics.totalEquity, 0)) > 0.0001)
    ) {
      checks.push(makeComparisonCheck({
        id: "balance-sheet-equation",
        year,
        label: "Balance sheet balances: Assets = Liabilities + Equity",
        actual: metrics.totalAssets,
        expected: toNumber(metrics.totalLiabilities, 0) + toNumber(metrics.totalEquity, 0),
        sources: ["Balance Sheet"],
      }));
    }

    if (ebitdaData?.hasGrossProfitData) {
      checks.push(makeComparisonCheck({
        id: "gross-profit-formula",
        year,
        label: "Gross profit reconciles to Revenue - COGS",
        actual: ebitdaData.grossProfit,
        expected: toNumber(enriched.totalRevenue, 0) - toNumber(ebitdaData.costOfGoodsSold, 0),
        sources: ["Profit & Loss"],
      }));
    }

    if (ebitdaData?.hasData) {
      checks.push(makeComparisonCheck({
        id: "adjusted-ebitda-bridge",
        year,
        label: "Adjusted EBITDA reconciles to EBITDA plus approved adjustments",
        actual: enriched.adjustedEbitda,
        expected: toNumber(enriched.ebitda, 0) + bridgeAdjustment,
        sources: ["EBITDA calculation", "Approved adjustments"],
      }));
    }

    if (cashflow.hasData) {
      checks.push(makeComparisonCheck({
        id: "free-cash-flow-formula",
        year,
        label: "Free cash flow reconciles to CFO - Capex",
        actual: enriched.freeCashFlow,
        expected: toNumber(cashflow.cashFromOperations, 0) - toNumber(cashflow.capitalExpenditures, 0),
        sources: ["Cash Flow Statement"],
      }));
    }

    const addCalculation = (metric, formula, inputs, value) => {
      if (!Number.isFinite(Number(value))) return;
      calculations.push({ year, metric, formula, inputs, value: Number(value) });
    };
    if (ebitdaData?.hasGrossProfitData && enriched.totalRevenue) {
      addCalculation("Gross margin", "Gross profit / Revenue", ["Gross profit", "Revenue"], enriched.grossMargin);
    }
    if (ebitdaData?.hasData && enriched.totalRevenue) {
      addCalculation("Adjusted EBITDA margin", "Adjusted EBITDA / Revenue", ["Adjusted EBITDA", "Revenue"], enriched.ebitdaMargin);
    }
    if (cashflow.hasData) {
      addCalculation("Free cash flow", "Cash from operations - Capex", ["Cash from operations", "Capex"], enriched.freeCashFlow);
      addCalculation("FCF conversion", "Free cash flow / Adjusted EBITDA", ["Free cash flow", "Adjusted EBITDA"],
        enriched.adjustedEbitda ? (toNumber(enriched.freeCashFlow, 0) / toNumber(enriched.adjustedEbitda, 0)) * 100 : 0);
    }
    if (Object.prototype.hasOwnProperty.call(metrics, "longTermDebt")) {
      addCalculation("Net debt", "Debt - Cash", ["Debt", "Cash"], enriched.netDebt);
      addCalculation("Long-term debt / EBITDA", "Long-term debt / Adjusted EBITDA", ["Long-term debt", "Adjusted EBITDA"],
        enriched.longTermDebtAdjustedEbitdaRatio);
    }
  });

  const discrepancies = checks.filter((check) => check.status === "discrepancy");
  const sourceIssues = (sourceLedger?.issues || []).map((message, index) => ({
    id: `source:${index}`,
    year: null,
    label: message,
    status: "source_warning",
    sources: [sourceLedger?.sourceLabel || "Financial source"],
  }));
  const issues = [...sourceIssues, ...discrepancies];

  return {
    validatedAt: new Date().toISOString(),
    status: !sourceLedger?.verified || issues.length > 0 ? "review" : "verified",
    sourceVerified: Boolean(sourceLedger?.verified),
    sourceLedger,
    checks,
    calculations,
    issues,
    summary: {
      verifiedChecks: checks.length - discrepancies.length,
      discrepancies: discrepancies.length,
      sourceWarnings: sourceIssues.length,
      calculatedMetrics: calculations.length,
      documentCount: sourceLedger?.documents?.length || 0,
    },
  };
}

function normalizeBankReconciliationSnapshot(payload = {}, endDate = "") {
  const data = payload?.found && payload?.data ? payload.data : payload;
  const endMonth = String(endDate || "").slice(0, 7);
  const accountRows = [];
  const balanceSheetAccounts = normalizeBalanceSheetBankAccounts(data);
  const normalizeRowStatus = (status, variance) => {
    if (/review|open|variance|unreconciled|needs/i.test(String(status || ""))) return "Review";
    if (variance !== null && Math.abs(variance) > 0.01) return "Review";
    return "Reconciled";
  };

  if (Array.isArray(data?.accounts)) {
    data.accounts.forEach((account) => {
      const monthlyData = (account.monthlyData || [])
        .filter((row) => !endMonth || String(row.month || row.monthKey || "") <= endMonth)
        .sort((a, b) => String(a.month || a.monthKey || "").localeCompare(String(b.month || b.monthKey || "")));
      const latest = monthlyData[monthlyData.length - 1];
      if (!latest) return;
      const bankBalance = toNumber(latest.endingBalance, 0);
      const name = account.accountName || account.bankName || "Bank account";
      const bankName = account.bankName || account.accountName || "Bank";
      const explicitBookBalance = toNullableNumber(latest.perBalanceSheet ?? latest.bookBalance ?? latest.glBalance);
      const balanceSheetMatch = explicitBookBalance === null
        ? resolveBalanceSheetBookBalance({
          bankName,
          accountName: name,
          month: latest.month || latest.monthKey || endMonth,
          balanceSheetAccounts,
        })
        : { amount: explicitBookBalance, source: "Balance Sheet / GL" };
      const bookBalance = explicitBookBalance ?? balanceSheetMatch.amount;
      const variance = toNullableNumber(latest.variance) ?? (bookBalance !== null ? bankBalance - bookBalance : null);
      accountRows.push({
        name,
        bankName,
        month: latest.month || latest.monthKey || endMonth,
        date: latest.statementEndDate || latest.endDate || endDate,
        bankBalance,
        bookBalance,
        variance,
        status: normalizeRowStatus(latest.status, variance),
        bookSource: balanceSheetMatch.source || "",
      });
    });
  }

  (data?.banks || []).forEach((bank) => {
    (bank.accounts || []).forEach((account) => {
      const months = (account.months || [])
        .filter((row) => !endMonth || String(row.monthKey || row.month || "") <= endMonth)
        .sort((a, b) => String(a.monthKey || a.month || "").localeCompare(String(b.monthKey || b.month || "")));
      const latest = months[months.length - 1];
      if (!latest) return;
      const month = latest.monthKey || latest.month || endMonth;
      const name = account.accountName || account.account_name || bank.account_name || bank.bankName || bank.bank_name || "Bank account";
      const bankName = bank.bankName || bank.bank_name || account.bankName || account.bank_name || name || "Bank";
      const bankBalance = toNumber(latest.endingBalance, 0);
      const explicitBookBalance = toNullableNumber(latest.perBalanceSheet ?? latest.bookBalance ?? latest.glBalance);
      const balanceSheetMatch = explicitBookBalance === null
        ? resolveBalanceSheetBookBalance({ bankName, accountName: name, month, balanceSheetAccounts })
        : { amount: explicitBookBalance, source: "Balance Sheet / GL" };
      const bookBalance = explicitBookBalance ?? balanceSheetMatch.amount;
      const variance = toNullableNumber(latest.variance) ?? (bookBalance !== null ? bankBalance - bookBalance : null);
      accountRows.push({
        name,
        bankName,
        month,
        date: latest.statementEndDate || latest.statement_end_date || endDate,
        bankBalance,
        bookBalance,
        variance,
        status: normalizeRowStatus(latest.status || account.status, variance),
        bookSource: balanceSheetMatch.source || "",
      });
    });
  });

  const latestMonth = accountRows.map((row) => row.month).filter(Boolean).sort().pop() || endMonth;
  const latestRows = accountRows;
  const bankBalance = latestRows.reduce((sum, row) => sum + row.bankBalance, 0);
  const rowsWithBookBalance = latestRows.filter((row) => row.bookBalance !== null);
  const rowsWithVariance = latestRows.filter((row) => row.variance !== null);
  const statedBookBalance = rowsWithBookBalance.reduce((sum, row) => sum + row.bookBalance, 0);
  const bookBalance = rowsWithBookBalance.length ? statedBookBalance : null;
  const variance = rowsWithVariance.length
    ? rowsWithVariance.reduce((sum, row) => sum + row.variance, 0)
    : (bookBalance !== null ? bankBalance - bookBalance : null);
  const byBank = new Map();
  latestRows.forEach((row) => {
    const bankName = row.bankName || "Bank";
    const existing = byBank.get(bankName) || {
      bankName,
      accountCount: 0,
      bankBalance: 0,
      bookBalance: 0,
      bookBalanceCount: 0,
      variance: 0,
      varianceCount: 0,
      itemCount: 0,
      status: "Reconciled",
      accounts: [],
    };
    const rowBookBalance = row.bookBalance !== null ? toNumber(row.bookBalance, 0) : null;
    const rowVariance = row.variance !== null
      ? toNumber(row.variance, 0)
      : (rowBookBalance !== null ? row.bankBalance - rowBookBalance : null);
    const rowStatus = normalizeRowStatus(row.status, rowVariance);
    existing.accountCount += 1;
    existing.bankBalance += toNumber(row.bankBalance, 0);
    if (rowBookBalance !== null) {
      existing.bookBalance += rowBookBalance;
      existing.bookBalanceCount += 1;
    }
    if (rowVariance !== null) {
      existing.variance += rowVariance;
      existing.varianceCount += 1;
      existing.itemCount += Math.abs(rowVariance) > 0.01 ? 1 : 0;
    }
    existing.status = existing.status === "Review" || rowStatus === "Review"
      ? "Review"
      : "Reconciled";
    existing.accounts.push({ ...row, bookBalance: rowBookBalance, variance: rowVariance, status: rowStatus });
    byBank.set(bankName, existing);
  });
  const bankSummaries = Array.from(byBank.values())
    .map((bank) => ({
      ...bank,
      hasBookBalance: bank.bookBalanceCount > 0,
      hasVariance: bank.varianceCount > 0 || bank.bookBalanceCount > 0,
      bookBalance: bank.bookBalanceCount > 0 ? bank.bookBalance : null,
      variance: bank.varianceCount > 0
        ? bank.variance
        : (bank.bookBalanceCount > 0 ? bank.bankBalance - bank.bookBalance : null),
    }))
    .sort((a, b) =>
      Math.abs(toNumber(b.variance, 0)) - Math.abs(toNumber(a.variance, 0)) ||
      b.bankBalance - a.bankBalance ||
      a.bankName.localeCompare(b.bankName));

  return {
    hasData: latestRows.length > 0,
    date: latestRows.map((row) => row.date).filter(Boolean).sort().pop() || endDate,
    bankName: Array.from(new Set(latestRows.map((row) => row.bankName).filter(Boolean))).join(", "),
    frequency: Array.isArray(data?.months) && data.months.length > 1 ? "Monthly" : "Periodic",
    month: latestMonth,
    bankBalance,
    bookBalance,
    variance,
    hasBookBalance: rowsWithBookBalance.length > 0,
    hasVariance: variance !== null,
    itemCount: rowsWithVariance.length
      ? rowsWithVariance.filter((row) => Math.abs(row.variance) > 0.01).length
      : latestRows.filter((row) => row.bookBalance !== null && Math.abs(row.bankBalance - row.bookBalance) > 0.01).length,
    accounts: latestRows,
    banks: bankSummaries,
    bankCount: bankSummaries.length,
    balanceSheetMatchCount: rowsWithBookBalance.length,
  };
}

function getTaxReconciliationYearsPayload(payload = {}) {
  if (payload?.years && typeof payload.years === "object") return payload.years;
  if (payload?.year || payload?.taxYear) {
    const year = payload.year || payload.taxYear;
    return { [year]: { data: payload.data || payload.rows || [] } };
  }
  return {};
}

function getTaxReconciliationRowsFromPayload(value = {}) {
  if (Array.isArray(value)) return value;
  return value.data || value.rows || value.lineItems || [];
}

function mergeTaxReconciliationRows(plRows = [], taxRows = []) {
  const merged = new Map(TAX_RECONCILIATION_LINE_ITEM_LABELS.map((label) => [
    label,
    { label, pl: 0, taxReturn: 0, variance: 0, hasPl: false, hasTaxReturn: false },
  ]));

  const ensureRow = (label) => {
    const canonical = getCanonicalTaxLineItemLabel(label);
    if (!canonical) return null;
    if (!merged.has(canonical)) {
      merged.set(canonical, { label: canonical, pl: 0, taxReturn: 0, variance: 0, hasPl: false, hasTaxReturn: false });
    }
    return merged.get(canonical);
  };

  const applyPlRow = (row) => {
    const target = ensureRow(row.label || row.name || row.account);
    if (!target) return;
    const rawValue = row.pl ?? row.book ?? row.bookAmount ?? row.amount ?? row.value;
    const value = toNumber(rawValue, Number.NaN);
    if (!Number.isFinite(value)) return;
    target.pl = value;
    target.hasPl = true;
  };

  const applyTaxRow = (row) => {
    const target = ensureRow(row.label || row.name || row.account);
    if (!target) return;
    if (row.pl !== undefined || row.book !== undefined || row.bookAmount !== undefined) applyPlRow(row);
    const rawValue = row.taxReturn ?? row.tax_return ?? row.returnAmount ?? row.amount ?? row.value;
    const value = toNumber(rawValue, Number.NaN);
    if (!Number.isFinite(value)) return;
    target.taxReturn = value;
    target.hasTaxReturn = true;
  };

  plRows.forEach(applyPlRow);
  taxRows.forEach(applyTaxRow);

  return Array.from(merged.values()).map((row) => ({
    ...row,
    amount: row.hasTaxReturn ? row.taxReturn : row.hasPl ? row.pl : 0,
    variance: row.taxReturn - row.pl,
  }));
}

export function normalizeTaxReconciliationSnapshot(taxPayload = {}, plPayload = {}) {
  const taxYearsPayload = getTaxReconciliationYearsPayload(taxPayload);
  const plYearsPayload = getTaxReconciliationYearsPayload(plPayload);
  const periods = Array.from(new Set([
    ...Object.keys(taxYearsPayload),
    ...Object.keys(plYearsPayload),
  ].map(Number).filter(Boolean))).sort((a, b) => a - b);
  const rowsByYear = {};
  periods.forEach((year) => {
    const taxRows = getTaxReconciliationRowsFromPayload(taxYearsPayload[year] || taxYearsPayload[String(year)] || {});
    const plRows = getTaxReconciliationRowsFromPayload(plYearsPayload[year] || plYearsPayload[String(year)] || {});
    rowsByYear[year] = mergeTaxReconciliationRows(plRows, taxRows);
  });
  return {
    hasData: periods.some((year) =>
      rowsByYear[year]?.some((row) => row.hasTaxReturn || row.hasPl || Math.abs(toNumber(row.amount, 0)) > 0.0001),
    ),
    periods,
    rowsByYear,
  };
}

async function loadCimTaxReconciliationProfitLossPayload({
  clientId,
  sourceKey,
  datasetVersion,
  keyReportVersionId,
  years = [],
} = {}) {
  const cleanYears = sortYearsDescending(years).reverse();

  if (keyReportVersionId) {
    const entries = await Promise.all(cleanYears.map(async (year) => {
      try {
        const response = await getKeyReportVersionReport(
          keyReportVersionId,
          "profit-loss",
          { year: String(year), period: "year" },
        );
        const rows = response?.hierarchicalRows || response?.rows || [];
        const data = extractTaxRowsFromProfitLossRows(rows);
        return data.some((row) => Math.abs(toNumber(row.pl, 0)) > 0.0001)
          ? [year, { year, data }]
          : null;
      } catch {
        return null;
      }
    }));
    return { success: true, years: Object.fromEntries(entries.filter(Boolean)) };
  }

  if (sourceKey === REPORT_SOURCE_KEYS.MANUAL_GL) {
    const versionParam = datasetVersion ? { datasetVersion } : {};
    const entries = await Promise.all(cleanYears.map(async (year) => {
      try {
        const response = await getManualStagedProfitLossSummary({
          clientId,
          params: {
            fiscalYear: [String(year)],
            ...versionParam,
          },
        });
        const rows = response?.hierarchicalRows || response?.rows || [];
        const data = extractTaxRowsFromProfitLossRows(rows);
        return data.some((row) => Math.abs(toNumber(row.pl, 0)) > 0.0001)
          ? [year, { year, data }]
          : null;
      } catch {
        return null;
      }
    }));
    return { success: true, years: Object.fromEntries(entries.filter(Boolean)) };
  }

  if (sourceKey === REPORT_SOURCE_KEYS.MANUAL_UPLOAD) {
    return getCimProfitLossForTaxRequest({
      clientId,
      datasetVersion,
      keyReportVersionId,
    }).catch(() => null);
  }

  if (sourceKey === REPORT_SOURCE_KEYS.QUICKBOOKS_MANUAL) {
    const dashboard = await loadCimDashboardOnce(sourceKey, clientId).catch(() => null);
    const reports = dashboard?._raw?.reports || {};
    const yearsPayload = Object.fromEntries(cleanYears.map((year) => {
      const rows = reports[String(year)]?.profitAndLoss?.rows ||
        reports[String(year)]?.profit_loss?.rows ||
        reports[String(year)]?.rows ||
        [];
      return [year, { year, data: extractTaxRowsFromProfitLossRows(rows) }];
    }).filter(([, value]) => value.data.some((row) => Math.abs(toNumber(row.pl, 0)) > 0.0001)));
    return { success: true, years: yearsPayload };
  }

  return { success: true, years: {} };
}

// Fixed priority tier for auto-selecting a financial data source when the
// broker hasn't already picked one via the "Auto-fill Financials" modal
// (used by the custom-template upload flow). Key Reports is ranked first
// since it's the platform-wide default source (see reportSourceStore.js);
// Manual GL / QuickBooks / Manual Upload follow in descending order of how
// complete/authoritative their data tends to be for CIM financial mapping.
const FINANCIAL_SOURCE_PRIORITY = [
  REPORT_SOURCE_KEYS.KEY_REPORTS,
  REPORT_SOURCE_KEYS.MANUAL_GL,
  REPORT_SOURCE_KEYS.QUICKBOOKS,
  REPORT_SOURCE_KEYS.MANUAL_UPLOAD,
  REPORT_SOURCE_KEYS.QUICKBOOKS_MANUAL,
];

export async function selectBestFinancialSource({ clientId } = {}) {
  if (!clientId) return null;

  const [reportVersionsResult, reportSourcesResult] = await Promise.all([
    getKeyReportVersions().catch(() => null),
    getReportSources({ clientId }).catch(() => null),
  ]);

  const reportVersions = reportVersionsResult?.versions || [];
  const sources = Array.isArray(reportSourcesResult?.sources) ? reportSourcesResult.sources : [];
  const sourceByKey = new Map(
    sources.map((source) => [normalizeReportSourceKey(source.sourceKey), source]),
  );

  const isAvailable = (key) => {
    if (key === REPORT_SOURCE_KEYS.KEY_REPORTS) return reportVersions.length > 0;
    return Boolean(sourceByKey.get(key)?.isAvailable);
  };

  const sourceKey = FINANCIAL_SOURCE_PRIORITY.find(isAvailable) || null;
  if (!sourceKey) return null;

  if (sourceKey === REPORT_SOURCE_KEYS.KEY_REPORTS) {
    const activeVersion = reportVersions.find((version) => version.isActive) || reportVersions[0];
    return { sourceKey, reportVersionId: activeVersion?.id || "", datasetVersion: "" };
  }

  return { sourceKey, reportVersionId: "", datasetVersion: "" };
}

export async function loadCimFinancialAutofillSnapshot({
  clientId,
  sourceKey,
  selectedDatasetVersion = "",
  selectedReportVersionId = "",
  dateRange = null,
  onProgress,
} = {}) {
  const reportProgress = (progress, message) => {
    if (typeof onProgress === "function") onProgress({ progress, message });
  };

  const normalizedSource = normalizeReportSourceKey(sourceKey) || REPORT_SOURCE_KEYS.QUICKBOOKS;
  const cacheKey = getCimAutofillCacheKey({
    clientId,
    sourceKey: normalizedSource,
    selectedDatasetVersion,
    selectedReportVersionId,
    dateRange,
  });
  const cached = cimAutofillSnapshotCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < CIM_AUTOFILL_CACHE_TTL_MS) {
    reportProgress(92, "Using recently validated report data");
    reportProgress(95, "Preparing verified values for the CIM");
    return cached.snapshot;
  }

  reportProgress(8, "Checking the selected financial source");
  const sourceMode = getReportSourceMode(normalizedSource);
  const datasetVersion = normalizedSource === REPORT_SOURCE_KEYS.MANUAL_GL
    ? await getManualGlDatasetVersion(clientId, selectedDatasetVersion)
    : "";
  const selectedRange = normalizeDateRange(dateRange);
  const selectedFiscalYear = selectedRange?.fiscalYear || 0;
  const periodType = selectedRange?.periodType || "calendar";
  const selectedStartYear = getFiscalYearFromDate(selectedRange?.startDate, periodType);
  const sourceLedgerPromise = loadCimSourceLedger({
    clientId,
    sourceKey: normalizedSource,
    selectedDatasetVersion: datasetVersion || selectedDatasetVersion,
    selectedReportVersionId,
  });
  reportProgress(16, "Finding available fiscal periods");
  const availableYears = await getAvailableYears({
    clientId,
    sourceKey: normalizedSource,
    selectedDatasetVersion: datasetVersion,
    keyReportVersionId: selectedReportVersionId,
  });
  const selectedCandidateYears = selectedFiscalYear
    ? Array.from(
      { length: Math.max(1, selectedFiscalYear - selectedStartYear + 1) },
      (_, index) => selectedStartYear + index,
    ).slice(0, 5)
    : sortYearsDescending(availableYears).slice(0, 5).reverse();
  const availableYearSet = new Set(availableYears.map(Number));
  const years = sortYearsDescending(
    selectedCandidateYears.filter((year) => availableYearSet.size === 0 || availableYearSet.has(Number(year))),
  );
  if (selectedFiscalYear && !years.includes(selectedFiscalYear)) years.unshift(selectedFiscalYear);

  const ebitdaPromise = loadEbitdaByYear({
    clientId,
    sourceKey: normalizedSource,
    sourceMode,
    years,
    datasetVersion,
    periodType,
    keyReportVersionId: selectedReportVersionId,
  });
  const adjustmentsPromise = loadAdjustmentTotals({
    clientId,
    sourceKey: normalizedSource,
    years,
    datasetVersion,
    periodType,
    keyReportVersionId: selectedReportVersionId,
  });
  const balanceSheetPromise = loadBalanceSheetByYear({
    sourceKey: normalizedSource,
    sourceMode,
    years,
    datasetVersion,
    periodType,
    keyReportVersionId: selectedReportVersionId,
  });
  const cashflowPromise = loadCashflowByYear({
    clientId,
    sourceMode,
    years,
    datasetVersion,
    periodType,
    keyReportVersionId: selectedReportVersionId,
  });

  reportProgress(24, "Reading income statements and balance sheets");
  const metricsByYear = await loadKpisByYear({
    clientId,
    sourceKey: normalizedSource,
    sourceMode,
    years,
    datasetVersion,
    periodType,
    keyReportVersionId: selectedReportVersionId,
  });
  reportProgress(42, "Cross-checking reported financial figures");

  const usableYears = years.filter((year) => isMeaningfulMetricSet(metricsByYear[year]));
  const selectedYears = selectedFiscalYear
    ? sortYearsDescending([
      ...(usableYears.length ? usableYears : years),
      selectedStartYear,
      selectedFiscalYear,
    ])
    : (usableYears.length ? usableYears : years);
  const ebitdaByYear = await ebitdaPromise;
  reportProgress(58, "Reconciling EBITDA and approved adjustments");
  let trailingEbitda = null;
  try {
    trailingEbitda = await loadEbitdaForDateRange({
      clientId,
      sourceKey: normalizedSource,
      sourceMode,
      startDate: selectedRange.trailingStartDate,
      endDate: selectedRange.endDate,
      fiscalYear: selectedFiscalYear,
      datasetVersion,
      keyReportVersionId: selectedReportVersionId,
    });
  } catch {
    trailingEbitda = null;
  }
  const adjustments = await adjustmentsPromise;
  reportProgress(68, "Processing cash flow and capital expenditure data");
  const cashflowByYear = await cashflowPromise;
  const balanceSheetByYear = await balanceSheetPromise;
  reportProgress(80, "Calculating margins, cash conversion, and leverage");
  let trailingCashflow = {};
  let trailingKpis = {};
  try {
    [trailingCashflow, trailingKpis] = await Promise.all([
      loadCashflowForDateRange({
        clientId,
        sourceKey: normalizedSource,
        sourceMode,
        startDate: selectedRange.trailingStartDate,
        endDate: selectedRange.endDate,
        fiscalYear: selectedFiscalYear,
        datasetVersion,
        keyReportVersionId: selectedReportVersionId,
      }),
      loadKpisForDateRange({
        clientId,
        sourceKey: normalizedSource,
        sourceMode,
        startDate: selectedRange.trailingStartDate,
        endDate: selectedRange.endDate,
        fiscalYear: selectedFiscalYear,
        datasetVersion,
        keyReportVersionId: selectedReportVersionId,
      }),
    ]);
  } catch {
    trailingCashflow = {};
    trailingKpis = {};
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
      balanceSheet: balanceSheetByYear[year] || {},
    });
  });

  const latestAnnualMetrics = enrichedByYear[selectedFiscalYear] || {};
  const trailingMetrics = enrichYearMetric({
    year: selectedFiscalYear,
    metrics: { ...latestAnnualMetrics, ...trailingKpis },
    ebitdaData: trailingEbitda || ebitdaByYear[selectedFiscalYear],
    adjustmentTotal: selectedRange.trailingStartDate === selectedRange.annualStartDate && selectedRange.endDate === selectedRange.annualEndDate
      ? toNumber(adjustments.totals?.[selectedFiscalYear] ?? adjustments.totals?.[String(selectedFiscalYear)], 0)
      : 0,
    adjustmentCount: adjustments.count || 0,
    cashflow: trailingCashflow,
    balanceSheet: balanceSheetByYear[selectedFiscalYear] || {},
  });

  const sortedAscending = sortYearsDescending(selectedYears).reverse();
  const latestYear = selectedFiscalYear || sortedAscending[sortedAscending.length - 1] || new Date().getFullYear();
  const sourceLedger = await sourceLedgerPromise;
  const [bankPayload, taxPayload, taxProfitLossPayload] = await Promise.all([
    getCimBankReconciliationRequest({
      clientId,
      sourceKey: normalizedSource,
      datasetVersion,
      keyReportVersionId: selectedReportVersionId,
      fiscalYear: selectedFiscalYear,
    }).catch(() => null),
    normalizedSource === REPORT_SOURCE_KEYS.QUICKBOOKS
      ? Promise.all(sortedAscending.map((year) => getCimTaxReconciliationRequest({
        clientId,
        sourceKey: normalizedSource,
        datasetVersion,
        keyReportVersionId: selectedReportVersionId,
        year,
      }).catch(() => null))).then((responses) => ({
        years: Object.fromEntries(responses
          .filter((response) => response?.year)
          .map((response) => [response.year, { data: response.data || [] }])),
      }))
      : getCimTaxReconciliationRequest({
        clientId,
        sourceKey: normalizedSource,
        datasetVersion,
        keyReportVersionId: selectedReportVersionId,
      }).catch(() => null),
    loadCimTaxReconciliationProfitLossPayload({
      clientId,
      sourceKey: normalizedSource,
      datasetVersion,
      keyReportVersionId: selectedReportVersionId,
      years: sortedAscending,
    }).catch(() => null),
  ]);
  reportProgress(90, "Validating accounting consistency and source support");
  const validation = buildCimFinancialValidation({
    sourceLedger,
    years: sortedAscending,
    metricsByYear,
    ebitdaByYear,
    cashflowByYear,
    adjustments,
    enrichedByYear,
  });
  reportProgress(95, "Preparing verified values for the CIM");

  const snapshot = {
    sourceKey: normalizedSource,
    sourceMode,
    datasetVersion,
    years: sortedAscending,
    availableYears: sortYearsDescending(availableYears).reverse(),
    latestYear,
    currentPeriod: selectedRange
      ? {
        startDate: selectedRange.startDate,
        endDate: selectedRange.endDate,
        companyStartDate: selectedRange.companyStartDate,
        startFiscalYear: selectedStartYear,
        fiscalYear: selectedFiscalYear,
        periodType,
        annualStartDate: selectedRange.annualStartDate,
        annualEndDate: selectedRange.annualEndDate,
        trailingStartDate: selectedRange.trailingStartDate,
        months: getInclusiveMonthSpan(selectedRange.startDate, selectedRange.endDate),
      }
      : null,
    metricsByYear: enrichedByYear,
    trailingMetrics,
    adjustments,
    bankReconciliation: normalizeBankReconciliationSnapshot(bankPayload || {}, selectedRange?.endDate),
    taxReconciliation: normalizeTaxReconciliationSnapshot(taxPayload || {}, taxProfitLossPayload || {}),
    validation,
  };
  cimAutofillSnapshotCache.set(cacheKey, { cachedAt: Date.now(), snapshot });
  return snapshot;
}
