import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import Header from "../../../components/Header";
import {
  ChevronDown,
  RefreshCw,
} from "lucide-react";
import { cn } from "../../../lib/utils";
import {
  getCompanyRequest,
  getManualStageFilterOptions,
  getLatestManualUploadedReport,
  getAllManualUploadedReports,
} from "../../../lib/api";
import { MANUAL_GL_STAGED_EVENT } from "../../../lib/dataSourceEvents";
import { useDataSource } from "../../../context/DataSourceContext";
import {
  getBalanceSheet,
  getBalanceSheetDetail,
} from "../../../services/balanceSheetService";
import {
  getProfitAndLoss,
  getProfitAndLossDetail,
} from "../../../services/profitAndLossService";
import {
  getCashflow,
  getCashflowDetail,
} from "../../../services/cashflowService";
import BalanceSheetReport from "../../../components/reports/balance-sheet/BalanceSheetReport";
import ProfitAndLossReport from "../../../components/reports/profit-loss/ProfitAndLossReport";
import CashflowReport from "../../../components/reports/cashflow/CashflowReport";
import {
  normalizeAccountingMethod,
  sanitizeDateRange,
} from "../../../lib/report-filters";
import {
  getReportSourceLabel,
  getReportSourceMode,
  normalizeReportSourceKey,
  REPORT_SOURCE_KEYS,
} from "../../../lib/report-source";
import { syncQuickbooksReports } from "../../../lib/quickbooks";
import {
  getDateRange,
} from "../../../lib/report-date-resolver";

const MANUAL_REPORT_DEBUG =
  Boolean(import.meta.env.DEV) ||
  String(import.meta.env.VITE_MANUAL_GL_DEBUG || "").toLowerCase() === "true";

function formatDateForInput(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const REPORTS_STORAGE_PREFIX = "datahub-workspace-reports";

function createInitialReportsData() {
  return {
    "Balance Sheet": {
      summary: {
        rows: [],
        source: null,
        sourceLabel: null,
        noDataText: "No Balance Sheet Available",
      },
      detail: { groups: [] },
    },
    "Profit & Loss": { summary: [], detail: { groups: [] } },
    Cashflow: { summary: [], detail: { groups: [] } },
  };
}

function getReportsStorageKey(clientId) {
  return `${REPORTS_STORAGE_PREFIX}:${clientId || "default"}`;
}

function getStoredReportsState(clientId) {
  if (!clientId || typeof window === "undefined") return null;

  try {
    const raw = window.sessionStorage.getItem(getReportsStorageKey(clientId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function saveStoredReportsState(clientId, state) {
  if (!clientId || typeof window === "undefined") return;

  try {
    window.sessionStorage.setItem(
      getReportsStorageKey(clientId),
      JSON.stringify(state),
    );
  } catch {
    // Ignore quota/serialisation issues.
  }
}

const DATE_RANGE_OPTIONS = [
  "All Dates",
  "Custom dates",
  "Today",
  "This week",
  "This week to date",
  "This fiscal week",
  "This month",
  "This month to date",
  "This quarter",
  "This quarter to date",
  "This fiscal quarter",
  "This fiscal quarter to date",
  "This year",
  "This year to date",
  "This year to last month",
  "This fiscal year",
  "This fiscal year to date",
  "This fiscal year to last month",
  "Last 6 months",
  "Yesterday",
  "Recent",
  "Last week",
  "Last week to date",
  "Last week to today",
  "Last month",
  "Last month to date",
  "Last month to today",
  "Last quarter",
  "Last quarter to date",
  "Last quarter to today",
  "Last fiscal quarter",
  "Last fiscal quarter to date",
  "Last year",
  "Last year to date",
  "Last year to today",
  "Last fiscal year",
  "Last fiscal year to date",
  "Last 7 days",
  "Last 30 days",
  "Last 90 days",
  "Last 12 months",
  "Since 30 days ago",
];

function createDefaultManualFilters() {
  return {
    batchId: "",
    fiscalYear: [],
    fiscalMonth: "",
    startDate: "",
    endDate: "",
    accountName: [],
    accountNumber: [],
    accountType: [],
    category: [],
    subCategory: [],
    department: [],
    class: [],
    location: [],
    sourceFile: [],
    reportType: [],
    transactionType: [],
    journalType: [],
  };
}

const MONTH_OPTIONS = [
  { value: "1", label: "January" },
  { value: "2", label: "February" },
  { value: "3", label: "March" },
  { value: "4", label: "April" },
  { value: "5", label: "May" },
  { value: "6", label: "June" },
  { value: "7", label: "July" },
  { value: "8", label: "August" },
  { value: "9", label: "September" },
  { value: "10", label: "October" },
  { value: "11", label: "November" },
  { value: "12", label: "December" },
];

function normalizeManualFilters(input = {}) {
  const defaults = createDefaultManualFilters();
  const next = { ...defaults, ...(input && typeof input === "object" ? input : {}) };

  Object.keys(defaults).forEach((key) => {
    if (Array.isArray(defaults[key])) {
      const values = Array.isArray(next[key]) ? next[key] : [];
      next[key] = values
        .map((item) => String(item || "").trim())
        .filter(Boolean);
      return;
    }
    next[key] = String(next[key] || "").trim();
  });

  return next;
}

function buildManualFilterParams(filters) {
  const normalized = normalizeManualFilters(filters);
  const params = {};

  Object.entries(normalized).forEach(([key, value]) => {
    if (Array.isArray(value)) {
      if (value.length > 0) params[key] = value;
      return;
    }
    if (value) params[key] = value;
  });

  // QB date fallback intentionally removed: manual reports are filtered by
  // fiscalYear only; QB date ranges must not pollute staged GL sub-queries.
  return params;
}

export default function WorkspaceReports() {
  const { clientId } = useParams();
  const {
    activeSource: contextActiveSource,
    quickbooksConnected: contextQbConnected,
  } = useDataSource();
  const todayString = useMemo(() => formatDateForInput(new Date()), []);
  const defaultCustomStart = useMemo(() => `${todayString.slice(0, 7)}-01`, [todayString]);
  const storedState = getStoredReportsState(clientId);
  const REPORT_TABS = useMemo(
    () => [
      { key: "Balance Sheet", label: "Balance Sheet" },
      { key: "Profit & Loss", label: "Profit & Loss" },
      { key: "Cashflow", label: "Cash Flow" },
    ],
    [],
  );

  const [selectedTab, setSelectedTab] = useState(
    storedState?.selectedTab || "Balance Sheet",
  );
  const [reportType, setReportType] = useState(
    storedState?.reportType || "Summary",
  );
  const [dateRange, setDateRange] = useState(
    storedState?.dateRange || "This Month",
  );
  const [customRange, setCustomRange] = useState({
    start:
      storedState?.customRange?.start || defaultCustomStart,
    end: storedState?.customRange?.end || todayString,
  });
  const [accountingMethod, setAccountingMethod] = useState(
    storedState?.accountingMethod || "Accrual",
  );
  const [reportsData, setReportsData] = useState({
    ...createInitialReportsData(),
    ...(storedState?.reportsData || {}),
  });
  const [appliedStartDate, setAppliedStartDate] = useState(
    storedState?.appliedStartDate || "",
  );
  const [appliedEndDate, setAppliedEndDate] = useState(
    storedState?.appliedEndDate || "",
  );
  const [appliedReportType, setAppliedReportType] = useState(
    storedState?.appliedReportType || storedState?.reportType || "Summary",
  );
  const [appliedAccountingMethod, setAppliedAccountingMethod] =
    useState(storedState?.appliedAccountingMethod || "Accrual");
  const [isLoading, setIsLoading] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [company, setCompany] = useState(null);
  const selectedReportSource = useMemo(
    () =>
      normalizeReportSourceKey(
        contextActiveSource || REPORT_SOURCE_KEYS.QUICKBOOKS,
      ),
    [contextActiveSource],
  );
  const [manualFilters, setManualFilters] = useState(
    normalizeManualFilters(storedState?.manualFilters),
  );
  const [appliedManualFilters, setAppliedManualFilters] = useState(
    normalizeManualFilters(storedState?.appliedManualFilters),
  );
  const [manualFilterOptions, setManualFilterOptions] = useState({});
  const [filterOptionsVersion, setFilterOptionsVersion] = useState(0);
  const [manualUploadFiles, setManualUploadFiles] = useState({
    "Balance Sheet": [],
    "Profit & Loss": [],
    "Cashflow": [],
  });
  const [selectedManualUploadRowId, setSelectedManualUploadRowId] = useState({
    "Balance Sheet": null,
    "Profit & Loss": null,
    "Cashflow": null,
  });
  const [isLoadingManualFiles, setIsLoadingManualFiles] = useState(false);
  const hasRestoredSessionRef = useRef(false);
  const isFirstMountRef = useRef(true);
  // Always-fresh ref so the filter options effect doesn't capture a stale closure.
  const manualFiltersRef = useRef(manualFilters);
  manualFiltersRef.current = manualFilters;
  const debugLog = useCallback((...args) => {
    if (!MANUAL_REPORT_DEBUG) return;
    console.log(...args);
  }, []);

  useEffect(() => {
    // On the initial mount useState already hydrated from sessionStorage, so skip
    // the restore here to avoid 11 extra setState calls → extra report generation.
    // On subsequent clientId changes (navigating between clients) we do need to restore.
    if (isFirstMountRef.current) {
      isFirstMountRef.current = false;
      hasRestoredSessionRef.current = true;
      return;
    }

    const restoredState = getStoredReportsState(clientId);

    Promise.resolve().then(() => {
      const nextState = restoredState || {};
      setSelectedTab(nextState.selectedTab || "Balance Sheet");
      setReportType(nextState.reportType || "Summary");
      setDateRange(nextState.dateRange || "This Month");
      setCustomRange({
        start: nextState.customRange?.start || defaultCustomStart,
        end: nextState.customRange?.end || todayString,
      });
      setAccountingMethod(nextState.accountingMethod || "Accrual");
      setReportsData({
        ...createInitialReportsData(),
        ...(nextState.reportsData || {}),
      });
      setAppliedStartDate(nextState.appliedStartDate || "");
      setAppliedEndDate(nextState.appliedEndDate || "");
      setAppliedReportType(
        nextState.appliedReportType || nextState.reportType || "Summary",
      );
      setAppliedAccountingMethod(nextState.appliedAccountingMethod || "Accrual");
      setManualFilters(normalizeManualFilters(nextState.manualFilters));
      setAppliedManualFilters(normalizeManualFilters(nextState.appliedManualFilters));
      hasRestoredSessionRef.current = true;
    });
  }, [clientId, defaultCustomStart, todayString]);

  useEffect(() => {
    let active = true;
    if (!clientId) {
      return () => {
        active = false;
      };
    }

    getCompanyRequest(clientId)
      .then((payload) => {
        if (active) setCompany(payload);
      })
      .catch(() => {
        if (active) setCompany(null);
      });

    return () => {
      active = false;
    };
  }, [clientId]);

  // Increment filterOptionsVersion whenever a new manual GL batch is staged,
  // so the filter options effect re-runs and picks up the new fiscal years.
  useEffect(() => {
    function handleGlStaged(event) {
      const { clientId: eventClientId } = event.detail || {};
      if (eventClientId && clientId && eventClientId !== clientId) return;
      setFilterOptionsVersion((v) => v + 1);
    }
    window.addEventListener(MANUAL_GL_STAGED_EVENT, handleGlStaged);
    return () => window.removeEventListener(MANUAL_GL_STAGED_EVENT, handleGlStaged);
  }, [clientId]);

  const clientName = useMemo(
    () => company?.name || "All Clients",
    [company?.name],
  );

  const selectedSourceMode = useMemo(
    () => getReportSourceMode(selectedReportSource),
    [selectedReportSource],
  );
  const selectedSourceLabel = useMemo(
    () => getReportSourceLabel(selectedReportSource),
    [selectedReportSource],
  );
  const createdOn = useMemo(
    () =>
      new Date().toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
      }),
    [],
  );

  useEffect(() => {
    if (selectedSourceMode !== "manual" || !clientId) return;
    const optionsParams = {
      batchId: appliedManualFilters.batchId,
    };

    getManualStageFilterOptions({
      clientId,
      params: optionsParams,
    })
      .then((payload) => {
        const options = payload?.options && typeof payload.options === "object"
          ? payload.options
          : {};
        setManualFilterOptions(options);
        debugLog("[ManualGL][UI][FilterOptions]", {
          batchId: appliedManualFilters.batchId || "",
          fiscalYears: options?.fiscalYear || [],
        });
        const availableYears = Array.isArray(options.fiscalYear) ? options.fiscalYear : [];
        if (availableYears.length > 0) {
          // Read from ref to get the latest filters without adding manualFilters to deps,
          // which would re-run this effect on every user filter interaction.
          const currentYear = manualFiltersRef.current.fiscalYear?.[0];
          const yearMatch = availableYears.find((y) => String(y) === String(currentYear));
          if (!currentYear || !yearMatch) {
            const sorted = [...availableYears].map(Number).filter(Number.isFinite).sort((a, b) => b - a);
            if (sorted.length > 0) {
              const next = { ...manualFiltersRef.current, fiscalYear: [String(sorted[0])] };
              setManualFilters(next);
              setAppliedManualFilters(next);
              debugLog("[ManualGL][UI][FilterAutoSelectYear]", {
                selectedFiscalYear: String(sorted[0]),
              });
            }
          }
        }
      })
      .catch((error) => {
        console.error("[WorkspaceReports] Failed to load manual filter options:", error);
        setManualFilterOptions({});
      });
  // filterOptionsVersion increments when a new GL batch is staged, forcing a re-fetch.
  }, [appliedManualFilters.batchId, clientId, selectedSourceMode, filterOptionsVersion]);

  // Load available uploaded files per tab when in manual_upload source mode
  useEffect(() => {
    if (selectedSourceMode !== "manual_upload" || !clientId) return;
    const statementTypeMap = {
      "Balance Sheet": "balance_sheet",
      "Profit & Loss": "profit_and_loss",
      "Cashflow": "cash_flow",
    };
    const stType = statementTypeMap[selectedTab];
    if (!stType) return;

    setIsLoadingManualFiles(true);
    getAllManualUploadedReports(stType, { clientId })
      .then((result) => {
        const files = result?.files || [];
        setManualUploadFiles((prev) => ({ ...prev, [selectedTab]: files }));
        setSelectedManualUploadRowId((prev) => {
          const current = prev[selectedTab];
          const stillValid = files.some((f) => f.rowId === current);
          return stillValid ? prev : { ...prev, [selectedTab]: files[0]?.rowId || null };
        });
      })
      .catch((err) => {
        console.error("[WorkspaceReports] Failed to load uploaded files:", err);
        setManualUploadFiles((prev) => ({ ...prev, [selectedTab]: [] }));
      })
      .finally(() => setIsLoadingManualFiles(false));
  }, [selectedSourceMode, selectedTab, clientId]);

  useEffect(() => {
    if (!clientId || !hasRestoredSessionRef.current) return;

    saveStoredReportsState(clientId, {
      selectedTab,
      reportType,
      dateRange,
      customRange,
      accountingMethod,
      reportsData,
      appliedStartDate,
      appliedEndDate,
      appliedReportType,
      appliedAccountingMethod,
      selectedReportSource,
      manualFilters,
      appliedManualFilters,
      savedAt: new Date().toISOString(),
    });
  }, [
    accountingMethod,
    appliedManualFilters,
    appliedAccountingMethod,
    appliedEndDate,
    appliedReportType,
    appliedStartDate,
    clientId,
    customRange,
    dateRange,
    reportType,
    reportsData,
    selectedReportSource,
    selectedTab,
    manualFilters,
  ]);

  const handleSync = async () => {
    setIsSyncing(true);
    try {
      if (selectedSourceMode === "quickbooks") {
        await syncQuickbooksReports();
      }
      await handleGenerateReport();
    } catch (error) {
      console.error("Sync failed:", error);
      alert("Sync failed. Please try again.");
    } finally {
      setIsSyncing(false);
    }
  };

  const getDates = useCallback(() => {
    let startDate;
    let endDate;

    const now = new Date();
    const todayStr = formatDateForInput(now);

    const getStartOfWeek = (d) => {
      const day = d.getDay();
      const diff = d.getDate() - day;
      return new Date(d.setDate(diff));
    };

    const getStartOfQuarter = (d) => {
      const q = Math.floor(d.getMonth() / 3);
      return new Date(d.getFullYear(), q * 3, 1);
    };

    const getEndOfQuarter = (d) => {
      const q = Math.floor(d.getMonth() / 3);
      return new Date(d.getFullYear(), (q + 1) * 3, 0);
    };

    switch (dateRange) {
      case "All Dates":
        startDate = "1970-01-01";
        endDate = todayStr;
        break;
      case "Custom dates":
        startDate = customRange.start;
        endDate = customRange.end;
        break;
      case "Today":
        startDate = todayStr;
        endDate = todayStr;
        break;
      case "Yesterday": {
        const yesterday = new Date(now);
        yesterday.setDate(now.getDate() - 1);
        startDate = formatDateForInput(yesterday);
        endDate = formatDateForInput(yesterday);
        break;
      }
      case "This week": {
        const weekStart = getStartOfWeek(new Date(now));
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekStart.getDate() + 6);
        startDate = formatDateForInput(weekStart);
        endDate = formatDateForInput(weekEnd);
        break;
      }
      case "This week to date":
      case "This fiscal week":
        startDate = formatDateForInput(getStartOfWeek(new Date(now)));
        endDate = todayStr;
        break;
      case "This month": {
        startDate = `${todayStr.slice(0, 7)}-01`;
        const lastDayOfMonth = new Date(
          now.getFullYear(),
          now.getMonth() + 1,
          0,
        );
        endDate = formatDateForInput(lastDayOfMonth);
        break;
      }
      case "This month to date":
        startDate = `${todayStr.slice(0, 7)}-01`;
        endDate = todayStr;
        break;
      case "This quarter":
        startDate = formatDateForInput(getStartOfQuarter(new Date(now)));
        endDate = formatDateForInput(getEndOfQuarter(new Date(now)));
        break;
      case "This quarter to date":
      case "This fiscal quarter":
      case "This fiscal quarter to date":
        startDate = formatDateForInput(getStartOfQuarter(new Date(now)));
        endDate = todayStr;
        break;
      case "This year":
        startDate = `${now.getFullYear()}-01-01`;
        endDate = `${now.getFullYear()}-12-31`;
        break;
      case "This year to date":
      case "This fiscal year":
      case "This fiscal year to date":
        startDate = `${now.getFullYear()}-01-01`;
        endDate = todayStr;
        break;
      case "This year to last month":
      case "This fiscal year to last month": {
        startDate = `${now.getFullYear()}-01-01`;
        const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
        endDate = formatDateForInput(lastMonthEnd);
        break;
      }
      case "Last week": {
        const lastWeekStart = getStartOfWeek(new Date(now));
        lastWeekStart.setDate(lastWeekStart.getDate() - 7);
        const lastWeekEnd = new Date(lastWeekStart);
        lastWeekEnd.setDate(lastWeekStart.getDate() + 6);
        startDate = formatDateForInput(lastWeekStart);
        endDate = formatDateForInput(lastWeekEnd);
        break;
      }
      case "Last week to date":
      case "Last week to today": {
        const lwStart = getStartOfWeek(new Date(now));
        lwStart.setDate(lwStart.getDate() - 7);
        startDate = formatDateForInput(lwStart);
        endDate = todayStr;
        break;
      }
      case "Last month": {
        const lmStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const lmEnd = new Date(now.getFullYear(), now.getMonth(), 0);
        startDate = formatDateForInput(lmStart);
        endDate = formatDateForInput(lmEnd);
        break;
      }
      case "Last month to date":
      case "Last month to today": {
        const lmStart2 = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        startDate = formatDateForInput(lmStart2);
        endDate = todayStr;
        break;
      }
      case "Last quarter": {
        const lqEnd = new Date(
          now.getFullYear(),
          Math.floor(now.getMonth() / 3) * 3,
          0,
        );
        const lqStart = getStartOfQuarter(lqEnd);
        startDate = formatDateForInput(lqStart);
        endDate = formatDateForInput(lqEnd);
        break;
      }
      case "Last quarter to date":
      case "Last quarter to today":
      case "Last fiscal quarter":
      case "Last fiscal quarter to date": {
        const lqStart2 = getStartOfQuarter(
          new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3 - 1, 1),
        );
        startDate = formatDateForInput(lqStart2);
        endDate = todayStr;
        break;
      }
      case "Last year":
        startDate = `${now.getFullYear() - 1}-01-01`;
        endDate = `${now.getFullYear() - 1}-12-31`;
        break;
      case "Last year to date":
      case "Last year to today":
      case "Last fiscal year":
      case "Last fiscal year to date":
        startDate = `${now.getFullYear() - 1}-01-01`;
        endDate = todayStr;
        break;
      case "Last 6 months": {
        const last6Start = new Date(
          now.getFullYear(),
          now.getMonth() - 6,
          now.getDate(),
        );
        startDate = formatDateForInput(last6Start);
        endDate = todayStr;
        break;
      }
      case "Last 7 days": {
        const last7Start = new Date(now);
        last7Start.setDate(now.getDate() - 7);
        startDate = formatDateForInput(last7Start);
        endDate = todayStr;
        break;
      }
      case "Last 30 days":
      case "Since 30 days ago": {
        const last30Start = new Date(now);
        last30Start.setDate(now.getDate() - 30);
        startDate = formatDateForInput(last30Start);
        endDate = todayStr;
        break;
      }
      case "Last 90 days": {
        const last90Start = new Date(now);
        last90Start.setDate(now.getDate() - 90);
        startDate = formatDateForInput(last90Start);
        endDate = todayStr;
        break;
      }
      case "Last 12 months": {
        const last12Start = new Date(
          now.getFullYear() - 1,
          now.getMonth(),
          now.getDate(),
        );
        startDate = formatDateForInput(last12Start);
        endDate = todayStr;
        break;
      }
      case "Recent": {
        const recentStart = new Date(now);
        recentStart.setDate(now.getDate() - 4);
        startDate = formatDateForInput(recentStart);
        endDate = todayStr;
        break;
      }
      default:
        startDate = `${now.getFullYear()}-01-01`;
        endDate = todayStr;
    }

    return { startDate, endDate };
  }, [customRange.end, customRange.start, dateRange]);

  // Returns the fiscal year stored in a manual-upload report payload.
  // Checks asOfDate → periodEnd → periodStart → filename in that order.
  const resolveManualUploadYear = (payload) => {
    const d = payload?.data;
    const dateSrc = d?.asOfDate || d?.periodEnd || d?.periodStart;
    if (dateSrc) {
      const y = parseInt(String(dateSrc).split("-")[0], 10);
      if (y >= 2000 && y <= new Date().getFullYear() + 1) return y;
    }
    const fn = payload?.reportParams?.fileName || "";
    const m = fn.match(/\b(20\d{2})\b/);
    return m ? parseInt(m[1], 10) : null;
  };

  const handleGenerateReport = useCallback(async () => {
    setIsLoading(true);

    try {
      const rawDates = getDates();
      const { startDate: userStart, endDate: userEnd } = sanitizeDateRange(
        rawDates.startDate,
        rawDates.endDate,
      );
      const normalizedAccountingMethod =
        normalizeAccountingMethod(accountingMethod);

      // In manual-upload mode, resolve the fiscal year from the selected file
      // (avoids an extra API call — file list was already fetched by the files effect).
      let resolvedStart;
      let resolvedEnd;
      if (selectedSourceMode === "manual_upload") {
        const selectedRowId = selectedManualUploadRowId[selectedTab];
        const fileEntry = manualUploadFiles[selectedTab]?.find(
          (f) => f.rowId === selectedRowId,
        ) || manualUploadFiles[selectedTab]?.[0];
        const year = resolveManualUploadYear({
          data: fileEntry?.data,
          reportParams: { fileName: fileEntry?.fileName },
        });
        if (year) {
          resolvedStart = `${year}-01-01`;
          resolvedEnd = `${year}-12-31`;
        }
      }

      if (!resolvedStart || !resolvedEnd) {
        const dateConfig = getDateRange({
          reportType: selectedTab,
          viewType: reportType,
          filters: { startDate: userStart, endDate: userEnd },
        });
        resolvedStart = dateConfig.startDate;
        resolvedEnd = dateConfig.endDate;
      }

      const manualFilterParams =
        selectedSourceMode === "manual"
          ? buildManualFilterParams(appliedManualFilters)
          : null;
      // Summary reports must not receive a month filter — fiscalMonths applied at the DB layer
      // would restrict transactions to a single month, breaking multi-month aggregations.
      const summaryFilterParams = manualFilterParams
        ? { ...manualFilterParams, fiscalMonth: undefined }
        : null;
      if (selectedSourceMode === "manual") {
        debugLog("[ManualGL][UI][GenerateReport][Request]", {
          selectedTab,
          reportType,
          manualFilterParams,
        });
      }

      // For manual GL mode: derive display dates from the selected fiscal year.
      let effectiveStartDate = resolvedStart;
      let effectiveEndDate = resolvedEnd;
      if (selectedSourceMode === "manual") {
        const selectedYear =
          appliedManualFilters?.fiscalYear?.[0] ||
          manualFilterParams?.fiscalYear?.[0];
        if (selectedYear) {
          effectiveStartDate = `${selectedYear}-01-01`;
          effectiveEndDate = `${selectedYear}-12-31`;
        }
      }

      setAppliedStartDate(effectiveStartDate || "");
      setAppliedEndDate(effectiveEndDate || "");
      setAppliedReportType(reportType);
      setAppliedAccountingMethod(accountingMethod);
      let summary = [];
      let detail = { groups: [] };

      const manualUploadRowId =
        selectedSourceMode === "manual_upload"
          ? selectedManualUploadRowId[selectedTab]
          : null;

      if (selectedTab === "Balance Sheet") {
        if (reportType === "Summary") {
          summary = await getBalanceSheet(
            effectiveStartDate,
            effectiveEndDate,
            normalizedAccountingMethod,
            {
              sourceMode: selectedSourceMode,
              manualFilters: summaryFilterParams,
              manualFilters: manualFilterParams,
              manualUploadRowId,
            },
          ).catch(() => ({
            rows: [],
            source: null,
            sourceLabel: null,
            noDataText: "No Balance Sheet Available",
          }));
        } else {
          detail = await getBalanceSheetDetail(
            effectiveStartDate,
            effectiveEndDate,
            normalizedAccountingMethod,
            {
              sourceMode: selectedSourceMode,
              manualFilters: manualFilterParams,
            },
          ).catch(() => ({ groups: [] }));
        }
      } else if (selectedTab === "Profit & Loss") {
        if (reportType === "Summary") {
          summary = await getProfitAndLoss(
            effectiveStartDate,
            effectiveEndDate,
            normalizedAccountingMethod,
            {
              sourceMode: selectedSourceMode,
              manualFilters: summaryFilterParams,
              manualFilters: manualFilterParams,
              manualUploadRowId,
            },
          ).catch(() => []);
        } else {
          detail = await getProfitAndLossDetail(
            effectiveStartDate,
            effectiveEndDate,
            normalizedAccountingMethod,
            {
              sourceMode: selectedSourceMode,
              manualFilters: manualFilterParams,
            },
          ).catch(() => []);
        }
      } else {
        if (reportType === "Summary") {
          summary = await getCashflow(
            effectiveStartDate,
            effectiveEndDate,
            normalizedAccountingMethod,
            {
              sourceMode: selectedSourceMode,
              manualFilters: summaryFilterParams,
              manualFilters: manualFilterParams,
              manualUploadRowId,
            },
          ).catch(() => []);
        } else {
          detail = await getCashflowDetail(
            effectiveStartDate,
            effectiveEndDate,
            normalizedAccountingMethod,
            {
              sourceMode: selectedSourceMode,
              manualFilters: manualFilterParams,
            },
          ).catch(() => ({ rows: [], columns: {} }));
        }
      }

      setReportsData((previous) => ({
        ...previous,
        [selectedTab]: {
          ...previous[selectedTab],
          ...(reportType === "Summary" ? { summary } : { detail }),
        },
      }));

      if (selectedSourceMode === "manual" && reportType === "Summary") {
        debugLog("[ManualGL][UI][GenerateReport][SummaryResponse]", {
          tab: selectedTab,
          source: summary?.source ?? (Array.isArray(summary) ? "array" : typeof summary),
          hierarchicalRowsCount: Array.isArray(summary?.hierarchicalRows) ? summary.hierarchicalRows.length : "n/a",
          rowsCount: Array.isArray(summary) ? summary.length : "n/a",
          years: summary?.years || [],
          audit: summary?.audit || [],
          appliedFilters: manualFilterParams,
        });
      }

      console.log(
        `✅ [Reports] ${selectedTab} / ${reportType} generated successfully`,
      );
    } catch (error) {
      console.error("[WorkspaceReports] Generation failed:", error);
    } finally {
      setIsLoading(false);
    }
  }, [
    accountingMethod,
    appliedManualFilters,
    clientId,
    getDates,
    debugLog,
    reportType,
    selectedSourceMode,
    selectedTab,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    selectedManualUploadRowId[selectedTab],
  ]);

  // Auto-generate report when dependencies change.
  // Debounced 80ms to prevent double-fetch when multiple state updates arrive
  // in the same tick (e.g. session restore followed by filter auto-selection).
  // handleGenerateReport is memoized with useCallback so this effect only fires
  // when the underlying filter/tab/source values actually change.
  useEffect(() => {
    if (!clientId) return;
    const timer = setTimeout(handleGenerateReport, 80);
    return () => clearTimeout(timer);
  }, [handleGenerateReport, clientId]);


  const currentReport = reportsData[selectedTab];

  return (
    <div className="page-container">
      <Header title="Reports" />

      <div className="page-content">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-bold text-[#050505]">
              Financial Reports
            </h1>
          </div>
          {selectedSourceMode === "quickbooks" ? (
            <button
              onClick={handleSync}
              disabled={isSyncing}
              className="btn-secondary"
            >
              <RefreshCw size={16} className={isSyncing ? "animate-spin" : ""} />
              {isSyncing ? "Syncing..." : "Sync"}
            </button>
          ) : null}
        </div>

        <div className="mb-6 flex gap-6 border-b border-border pb-px">
          {REPORT_TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setSelectedTab(tab.key)}
              className={cn(
                "relative pb-3 text-[14px] font-medium transition-all",
                selectedTab === tab.key
                  ? "font-semibold text-text-primary after:absolute after:bottom-[-1px] after:left-0 after:h-[2px] after:w-full after:rounded-full after:bg-primary after:content-['']"
                  : "text-text-muted hover:text-text-secondary",
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="card-base card-p min-h-[800px] flex flex-col">
          {/* QuickBooks-style Top Control Bar */}
          <div className="mb-8 flex flex-wrap items-center gap-6 border-b border-border-light pb-6">
            <div className="flex flex-col gap-1.5">
              <label className="text-[12px] font-medium uppercase tracking-wider text-text-muted">
                Report View
              </label>
              <div className="flex rounded-lg border border-border bg-bg-page p-1">
                <button
                  onClick={() => {
                    setReportType("Summary");
                    if (manualFilters.fiscalMonth) {
                      const cleared = { ...manualFilters, fiscalMonth: "" };
                      setManualFilters(cleared);
                      setAppliedManualFilters(cleared);
                    }
                  }}
                  className={cn(
                    "rounded-md px-4 py-1.5 text-[13px] font-medium transition-all",
                    reportType === "Summary"
                      ? "bg-bg-card text-text-primary shadow-sm ring-1 ring-border/50"
                      : "text-text-muted hover:text-text-secondary",
                  )}
                >
                  Summary
                </button>
                <button
                  onClick={() => setReportType("Detail")}
                  className={cn(
                    "rounded-md px-4 py-1.5 text-[13px] font-medium transition-all",
                    reportType === "Detail"
                      ? "bg-bg-card text-text-primary shadow-sm ring-1 ring-border/50"
                      : "text-text-muted hover:text-text-secondary",
                  )}
                >
                  Detailed
                </button>
              </div>
            </div>

            {reportType === "Summary" && selectedSourceMode !== "manual" && (
              <>
                <div className="flex flex-col gap-1.5">
                  <label className="text-[12px] font-medium uppercase tracking-wider text-text-muted">
                    Date Range
                  </label>
                  <div className="relative min-w-[160px]">
                    <select
                      value={dateRange}
                      onChange={(event) => setDateRange(event.target.value)}
                      className="h-9 w-full appearance-none rounded-md border border-border-input bg-bg-card pl-3 pr-9 text-[13px] text-text-primary transition-all focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                    >
                      {DATE_RANGE_OPTIONS.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                    <ChevronDown
                      size={14}
                      className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted"
                    />
                  </div>
                </div>

                {dateRange === "Custom dates" && (
                  <div className="flex items-center gap-3">
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[12px] font-medium uppercase tracking-wider text-text-muted">
                        From
                      </label>
                      <input
                        type="date"
                        max={todayString}
                        value={customRange.start}
                        onChange={(event) =>
                          setCustomRange((p) => ({ ...p, start: event.target.value }))
                        }
                        className="h-9 rounded-md border border-border-input bg-bg-card px-3 text-[13px] text-text-primary focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[12px] font-medium uppercase tracking-wider text-text-muted">
                        To
                      </label>
                      <input
                        type="date"
                        max={todayString}
                        value={customRange.end}
                        onChange={(event) =>
                          setCustomRange((p) => ({ ...p, end: event.target.value }))
                        }
                        className="h-9 rounded-md border border-border-input bg-bg-card px-3 text-[13px] text-text-primary focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                    </div>
                  </div>
                )}
              </>
            )}

            <div className="flex flex-col gap-1.5">
              <label className="text-[12px] font-medium uppercase tracking-wider text-text-muted">
                Accounting Method
              </label>
              <div className="relative min-w-[120px]">
                <select
                  value={accountingMethod}
                  onChange={(event) => setAccountingMethod(event.target.value)}
                  className="h-9 w-full appearance-none rounded-md border border-border-input bg-bg-card pl-3 pr-9 text-[13px] text-text-primary transition-all focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  <option>Cash</option>
                  <option>Accrual</option>
                </select>
                <ChevronDown
                  size={14}
                  className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted"
                />
              </div>
            </div>

            {selectedSourceMode === "manual_upload" && reportType === "Summary" && (
              isLoadingManualFiles ? (
                <div className="flex flex-col gap-1.5">
                  <label className="text-[12px] font-medium uppercase tracking-wider text-text-muted">
                    File
                  </label>
                  <div className="h-9 min-w-[200px] flex items-center px-3 rounded-md border border-border-input bg-bg-card text-[13px] text-text-muted animate-pulse">
                    Loading files…
                  </div>
                </div>
              ) : manualUploadFiles[selectedTab]?.length > 0 ? (
                <div className="flex flex-col gap-1.5">
                  <label className="text-[12px] font-medium uppercase tracking-wider text-text-muted">
                    File
                  </label>
                  <div className="relative min-w-[200px]">
                    <select
                      value={selectedManualUploadRowId[selectedTab] || ""}
                      onChange={(e) => {
                        setSelectedManualUploadRowId((prev) => ({
                          ...prev,
                          [selectedTab]: e.target.value || null,
                        }));
                      }}
                      className="h-9 w-full appearance-none rounded-md border border-border-input bg-bg-card pl-3 pr-9 text-[13px] text-text-primary transition-all focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                    >
                      {manualUploadFiles[selectedTab].map((f) => (
                        <option key={f.rowId} value={f.rowId}>
                          {f.fileName}
                        </option>
                      ))}
                    </select>
                    <ChevronDown
                      size={14}
                      className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted"
                    />
                  </div>
                </div>
              ) : null
            )}

            {selectedSourceMode === "manual" && (
              <>

                <div className="flex flex-col gap-1.5">
                  <label className="text-[12px] font-medium uppercase tracking-wider text-text-muted">
                    Fiscal Year
                  </label>
                  <div className="relative min-w-[120px]">
                    <select
                      value={manualFilters.fiscalYear?.[0] || ""}
                      onChange={(event) => {
                        const year = event.target.value;
                        const next = {
                          ...manualFilters,
                          fiscalYear: year ? [year] : [],
                          fiscalMonth: "",
                        };
                        setManualFilters(next);
                        setAppliedManualFilters(next);
                        debugLog("[ManualGL][UI][FilterChange][FiscalYear]", {
                          selectedFiscalYear: year || null,
                        });
                      }}
                      className="h-9 w-full appearance-none rounded-md border border-border-input bg-bg-card pl-3 pr-9 text-[13px] text-text-primary transition-all focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                    >
                      <option value="">Select year…</option>
                      {(manualFilterOptions?.fiscalYear || []).map((year) => (
                        <option key={year} value={year}>
                          {year}
                        </option>
                      ))}
                    </select>
                    <ChevronDown
                      size={14}
                      className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted"
                    />
                  </div>
                </div>

                {reportType === "Detail" && (
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[12px] font-medium uppercase tracking-wider text-text-muted">
                      Month
                    </label>
                    <div className="relative min-w-[130px]">
                      <select
                        value={manualFilters.fiscalMonth || ""}
                        onChange={(event) => {
                          const month = event.target.value;
                          const next = { ...manualFilters, fiscalMonth: month };
                          setManualFilters(next);
                          setAppliedManualFilters(next);
                          debugLog("[ManualGL][UI][FilterChange][FiscalMonth]", {
                            selectedFiscalMonth: month || null,
                          });
                        }}
                        className="h-9 w-full appearance-none rounded-md border border-border-input bg-bg-card pl-3 pr-9 text-[13px] text-text-primary transition-all focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                      >
                        <option value="">All months</option>
                        {MONTH_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                      <ChevronDown
                        size={14}
                        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted"
                      />
                    </div>
                  </div>
                )}
              </>
            )}

          </div>

          <div className="flex-1 animate-in fade-in slide-in-from-bottom-2 duration-500">
            {isLoading ? (
              <div className="flex flex-1 flex-col items-center justify-center py-20">
                <div className="mb-6 h-12 w-12 animate-spin rounded-full border-4 border-border border-t-primary" />
                <p className="animate-pulse text-[14px] font-medium text-text-muted">
                  Fetching latest financial records from {selectedSourceLabel}...
                </p>
              </div>
            ) : (
              <>
                {selectedTab === "Balance Sheet" && currentReport.summary?.reStageRequired && (
                  <div className="mx-4 mb-3 rounded border border-amber-300 bg-amber-50 px-4 py-3 text-[13px] text-amber-800">
                    <strong>Data re-staging required:</strong>{" "}
                    {currentReport.summary.reStageWarning || "Re-run staging to fix Balance Sheet totals."}
                  </div>
                )}
                <div id="report-content" className="bg-white">
                  {selectedTab === "Balance Sheet" ? (
                    <BalanceSheetReport
                      reportType={appliedReportType}
                      data={currentReport.summary}
                      detailedData={currentReport.detail}
                      startDate={appliedStartDate}
                      endDate={appliedEndDate}
                      accountingMethod={appliedAccountingMethod}
                      sourceMode={selectedSourceMode}
                      clientName={clientName}
                      entityName={company?.name || clientName}
                      createdOn={createdOn}
                      isPreview={true}
                    />
                  ) : selectedTab === "Profit & Loss" ? (
                    <ProfitAndLossReport
                      reportType={appliedReportType}
                      data={currentReport.summary}
                      detailedData={currentReport.detail}
                      startDate={appliedStartDate}
                      endDate={appliedEndDate}
                      accountingMethod={appliedAccountingMethod}
                      sourceMode={selectedSourceMode}
                      clientName={clientName}
                      entityName={company?.name || clientName}
                      createdOn={createdOn}
                      isPreview={true}
                    />
                  ) : (
                    <CashflowReport
                      reportType={appliedReportType}
                      data={currentReport.summary}
                      detailedData={currentReport.detail}
                      startDate={appliedStartDate}
                      endDate={appliedEndDate}
                      accountingMethod={appliedAccountingMethod}
                      sourceMode={selectedSourceMode}
                      clientName={clientName}
                      entityName={company?.name || clientName}
                      createdOn={createdOn}
                      isPreview={true}
                    />
                  )}
                </div>

              </>
            )}
          </div>
        </div>
      </div>

    </div>
  );
}
