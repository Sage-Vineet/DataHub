import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import Header from "../../../components/Header";
import QBDisconnectedBanner from "../../../components/common/QBDisconnectedBanner";
import {
  ChevronDown,
  Download,
  FileSpreadsheet,
  FileText,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import { cn } from "../../../lib/utils";
import {
  getCompanyRequest,
  getManualStageFilterOptions,
  getAllManualUploadedReports,
  getAllQMSUploadedReports,
  getManualCashFlowPeriods,
  listManualGlDatasetVersions,
  getFinancialStatements,
  getFinancialStatements,
} from "../../../lib/api";
import {
  transformKeyReportFinancials,
  writeCachedFinancials,
} from "../../../lib/keyReportFinancials";
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
import { exportReportToExcel, exportReportToPdf } from "../../../lib/reportExport";
import {
  useKeyReportContextStore,
  selectKeyReportContext,
  maskKeyReportContext,
} from "../../../store/useKeyReportContextStore";
import { useShallow } from "zustand/react/shallow";
import KeyReportVersionSelector from "../../../components/key-reports/KeyReportVersionSelector";
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



const MANUAL_DATE_RANGE_OPTIONS = [
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
    datasetVersion: "",
    // Direct date-range fields — replaces the old fiscalYear[]/fiscalMonth[] round-trip.
    fromDate: "",
    toDate: "",
    // Keep fiscalYear/fiscalMonth as supplemental multi-select filters (not used for date-range anymore).
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

  // Map fromDate/toDate → startDate/endDate for the backend.
  if (normalized.fromDate) params.startDate = normalized.fromDate;
  if (normalized.toDate) params.endDate = normalized.toDate;
  // Remove the internal field names so the backend never sees "fromDate"/"toDate".
  delete params.fromDate;
  delete params.toDate;

  return params;
}

// Profit & Loss, Balance Sheet, and Cashflow use a Month/Year period toggle
// (Granularity). "Month" → monthly columns (the detailed drill-down view),
// "Year" → annual columns (one column per fiscal year).
// Every other tab keeps its own Summary/Detailed reportType.
function resolveEffectiveReportType(selectedTab, reportType, reportPeriod = "Month") {
  if (
    selectedTab === "Profit & Loss" ||
    selectedTab === "Balance Sheet" ||
    selectedTab === "Cashflow"
  ) {
    // Both Month and Year use the Detail (multi-column) path.
    // yearMode flag in options controls column granularity (monthly vs annual).
    return "Detail";
  }
  return reportType;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function reportMonthLabel(isoMonth) {
  const [y, m] = isoMonth.split("-");
  return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m) - 1]} ${y}`;
}

const MONTH_COL_MAP = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
function colLabelToISO(label) {
  if (!label) return null;
  const upper = String(label).trim().toUpperCase();
  // Accept both 2-digit ("JAN 25") and 4-digit ("JAN 2025") year formats.
  const m = /^([A-Z]{3})\s+(\d{2}|\d{4})$/.exec(upper);
  if (!m || !MONTH_COL_MAP[m[1]]) return null;
  const year = m[2].length === 2 ? 2000 + Number(m[2]) : Number(m[2]);
  return `${year}-${String(MONTH_COL_MAP[m[1]]).padStart(2, "0")}`;
}

// Derive the Date From / Date To month pickers (YYYY-MM) from the fiscalYear[] +
// fiscalMonth[] backend filters (the source of truth). fiscalMonth is a flat
// month list applied to the selected year(s); empty means the full year.
function filtersToDateRange(fiscalYear = [], fiscalMonth = []) {
  const years = (fiscalYear || []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (years.length === 0) return { from: "", to: "" };
  const months = (fiscalMonth || []).map(Number).filter((m) => m >= 1 && m <= 12).sort((a, b) => a - b);
  const fromMonth = months.length ? months[0] : 1;
  const toMonth = months.length ? months[months.length - 1] : 12;
  const toYear = years[years.length - 1];
  const lastDay = new Date(toYear, toMonth, 0).getDate(); // last calendar day of the to-month
  return {
    from: `${years[0]}-${pad2(fromMonth)}-01`,
    to: `${toYear}-${pad2(toMonth)}-${pad2(lastDay)}`,
  };
}

// Convert the Date From / Date To month pickers back to fiscalYear[] + fiscalMonth[].
// Multi-year ranges snap to full years (fiscalMonth = []) because the
// version-isolated snapshots are keyed per fiscal year — partial months across
// different years aren't representable. Single-year ranges keep their month span.
function dateRangeToFilters(from, to) {
  const parse = (v) => {
    // Accepts YYYY-MM or YYYY-MM-DD; the day is ignored because the backend
    // filters by fiscal year + month, so a date snaps to its month/year.
    const m = String(v || "").match(/^(\d{4})-(\d{2})/);
    return m ? { year: Number(m[1]), month: Number(m[2]) } : null;
  };
  let a = parse(from);
  let b = parse(to);
  if (!a && !b) return { fiscalYear: [], fiscalMonth: [] };
  if (!a) a = b;
  if (!b) b = a;
  if (a.year > b.year || (a.year === b.year && a.month > b.month)) {
    const tmp = a; a = b; b = tmp;
  }
  const fiscalYear = [];
  for (let y = a.year; y <= b.year; y += 1) fiscalYear.push(String(y));
  const fiscalMonth = [];
  if (a.year === b.year) {
    for (let m = a.month; m <= b.month; m += 1) fiscalMonth.push(String(m));
  }
  return { fiscalYear, fiscalMonth };
}

export default function WorkspaceReports() {
  const { clientId } = useParams();
  const {
    activeSource: contextActiveSource,
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
  const [manualDateRange, setManualDateRange] = useState(
    storedState?.manualDateRange || "All Dates",
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
  // Key Reports is a selectable 5th data source, NOT an automatic override.
  // It drives this page ONLY when the active data source is "key_reports"
  // (activated from the Key Reports page). For the 4 connection modes
  // (QuickBooks / Manual GL / Manual Upload / QB Manual) the Connections-page
  // selection is authoritative and the KR context is masked inactive.
  const krSelected = useMemo(
    () => normalizeReportSourceKey(contextActiveSource) === REPORT_SOURCE_KEYS.KEY_REPORTS,
    [contextActiveSource],
  );
  const rawKr = useKeyReportContextStore(useShallow(selectKeyReportContext));
  const kr = useMemo(() => maskKeyReportContext(rawKr, krSelected), [rawKr, krSelected]);
  const krFetchVersions = useKeyReportContextStore((s) => s.fetchVersions);

  // Ensure the Key Reports store starts loading for this company as early as
  // possible (independent of whether the version selector is mounted yet), so the
  // krReady gate below can hold report generation until the KR flow is resolved.
  useEffect(() => {
    if (clientId) krFetchVersions(clientId);
  }, [clientId, krFetchVersions]);

  // Gate report generation until the Key Reports store has settled for THIS
  // company. Until then we must not fetch — otherwise the first pass fires with
  // keyReportVersionId=null and leaks to Manual GL endpoints (e.g.
  // /reports/balance-sheet/monthly-detail) before the selected Key Report Version
  // loads. When the company has no KR versions, the legacy fallback path is valid
  // and we proceed immediately.
  const krReady = useMemo(() => {
    if (!clientId) return false;
    if (!krSelected) return true; // 4 connection modes never wait on the KR store
    if (kr.loading || kr.loadingDetail) return false; // a KR fetch is in flight
    if (kr.error) return true; // KR unavailable → don't block reports (legacy path)
    if (kr.loadedCompanyId !== clientId) return false; // store not loaded for this company yet
    if (!kr.versions.length) return true; // no KR versions → legacy path is fine
    if (kr.selectedVersionId && !kr.version) return false; // selected version detail not applied yet
    return true;
  }, [
    clientId,
    krSelected,
    kr.loading,
    kr.loadingDetail,
    kr.error,
    kr.loadedCompanyId,
    kr.versions.length,
    kr.selectedVersionId,
    kr.version,
  ]);

  const selectedReportSource = useMemo(
    () =>
      kr.krActive && kr.effectiveSource
        ? kr.effectiveSource
        : normalizeReportSourceKey(
          contextActiveSource || REPORT_SOURCE_KEYS.QUICKBOOKS,
        ),
    [kr.krActive, kr.effectiveSource, contextActiveSource],
  );
  const [manualFilters, setManualFilters] = useState(
    normalizeManualFilters(storedState?.manualFilters),
  );
  const [appliedManualFilters, setAppliedManualFilters] = useState(
    normalizeManualFilters(storedState?.appliedManualFilters),
  );
  const [manualFilterOptions, setManualFilterOptions] = useState({});
  // Collapsible filter bar (reclaims vertical space for the report).
  const [filtersCollapsed, setFiltersCollapsed] = useState(false);
  // Period granularity: "Month" (monthly columns) | "Year" (annual columns).
  const [reportPeriod, setReportPeriod] = useState(storedState?.reportPeriod || "Month");
  const [reportPeriod, setReportPeriod] = useState(storedState?.reportPeriod || "Month");
  // Year range selectors — shown when reportPeriod === "Year".
  const [yearRangeStart, setYearRangeStart] = useState(null);
  const [yearRangeEnd, setYearRangeEnd] = useState(null);
  // Export (Excel / PDF) dropdown + in-flight state.
  const [exportOpen, setExportOpen] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [reportStartMonth, setReportStartMonth] = useState(null);
  const [reportEndMonth, setReportEndMonth] = useState(null);
  const [filterOptionsVersion, setFilterOptionsVersion] = useState(0);
  // Dataset versions available for the selected company (manual GL source) removed — 
  // consolidated into the unified Key Report Version selector.
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
  const [qmsFiles, setQMSFiles] = useState({
    "Balance Sheet": [],
    "Profit & Loss": [],
    "Cashflow": [],
  });
  const [selectedQMSRowId, setSelectedQMSRowId] = useState({
    "Balance Sheet": null,
    "Profit & Loss": null,
    "Cashflow": null,
  });
  const [isLoadingQMSFiles, setIsLoadingQMSFiles] = useState(false);
  // Version selector removed — single-dataset mode: each upload replaces the previous dataset.
  // Available years for the generated Cash Flow (manual_upload mode, Cashflow tab)
  const [manualCfYears, setManualCfYears] = useState([]);
  const [selectedManualCfYear, setSelectedManualCfYear] = useState(null);
  const [isLoadingCfYears, setIsLoadingCfYears] = useState(false);
  const hasRestoredSessionRef = useRef(false);
  const isFirstMountRef = useRef(true);
  const prevReportSourceForClearRef = useRef(selectedReportSource);
  // Always-fresh ref so the filter options effect doesn't capture a stale closure.
  const manualFiltersRef = useRef(manualFilters);
  manualFiltersRef.current = manualFilters;
  const debugLog = useCallback((...args) => {
    if (!MANUAL_REPORT_DEBUG) return;
    console.log(...args);
  }, []);

  // [DEBUG] Reports page mount logging
  useEffect(() => {
    debugLog("[Reports] Component Mounted", {
      clientId,
      timestamp: new Date().toISOString()
    });
  }, [clientId, debugLog]);

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
      setReportPeriod(nextState.reportPeriod || "Month");
      setReportPeriod(nextState.reportPeriod || "Month");
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
      // Clear date range, fiscal year, and stale options; filter options will
      // be re-fetched automatically via filterOptionsVersion increment.
      setManualFilterOptions({});
      // Reset datasetVersion and date range so the version-load + options effects
      // re-derive the full span of the newly staged dataset.
      setManualFilters((prev) => ({ ...prev, batchId: "", datasetVersion: "", fromDate: "", toDate: "", fiscalYear: [], fiscalMonth: [] }));
      setAppliedManualFilters((prev) => ({ ...prev, batchId: "", datasetVersion: "", fromDate: "", toDate: "", fiscalYear: [], fiscalMonth: [] }));
      setReportsData(createInitialReportsData());
      // Invalidate the tab-switch cache so reports refetch against the new batch.
      reportSignaturesRef.current = {};
      setFilterOptionsVersion((v) => v + 1);
    }
    window.addEventListener(MANUAL_GL_STAGED_EVENT, handleGlStaged);
    return () => window.removeEventListener(MANUAL_GL_STAGED_EVENT, handleGlStaged);
  }, [clientId]);

  useEffect(() => {
    if (prevReportSourceForClearRef.current === selectedReportSource) return;
    prevReportSourceForClearRef.current = selectedReportSource;
    setReportsData(createInitialReportsData());
    // Source changed → previous cache is meaningless; force a fresh fetch.
    reportSignaturesRef.current = {};
    setManualUploadFiles({ "Balance Sheet": [], "Profit & Loss": [], "Cashflow": [] });
    setQMSFiles({ "Balance Sheet": [], "Profit & Loss": [], "Cashflow": [] });
    setManualFilterOptions({});
  }, [selectedReportSource]);

  const clientName = useMemo(
    () => company?.name || "All Clients",
    [company?.name],
  );

  const selectedSourceMode = useMemo(
    () => getReportSourceMode(selectedReportSource),
    [selectedReportSource],
  );

  // In Key Reports mode all three statements (Profit & Loss, Balance Sheet,
  // Cash Flow) are produced together by the /reports/financial-statements
  // endpoint — regardless of which document categories are linked — so every
  // tab is always selectable. (The report body shows its own empty state if a
  // given period has no data.) Legacy sources keep all tabs enabled too.
  // In Key Reports mode all three statements (Profit & Loss, Balance Sheet,
  // Cash Flow) are produced together by the /reports/financial-statements
  // endpoint — regardless of which document categories are linked — so every
  // tab is always selectable. (The report body shows its own empty state if a
  // given period has no data.) Legacy sources keep all tabs enabled too.
  const reportTabAvailability = useCallback(
    () => ({ enabled: true }),
    [],
    () => ({ enabled: true }),
    [],
  );

  // If the active tab becomes unavailable for the selected Version, fall back to
  // the first available one so the user never lands on an empty/blocked report.
  useEffect(() => {
    if (!kr.krActive) return;
    if (reportTabAvailability(selectedTab).enabled) return;
    const firstEnabled = REPORT_TABS.find((t) => reportTabAvailability(t.key).enabled);
    if (firstEnabled && firstEnabled.key !== selectedTab) setSelectedTab(firstEnabled.key);
  }, [kr.krActive, selectedTab, reportTabAvailability, REPORT_TABS]);
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

  // ── Tab-switch cache ────────────────────────────────────────────────────────
  // Switching tabs (Balance Sheet / P&L / Cash Flow) used to refetch every time,
  // even when that tab's data was already loaded for the current filters. We
  // record the signature of inputs that determine a report's response per slot
  // ("<tab>|<reportType>"); the generate effect skips the network call when the
  // signature is unchanged. A ref (not state) avoids extra re-renders.
  const reportSignaturesRef = useRef({});
  // Cache the raw Key Reports financial-statements response per version so that
  // switching tabs / period (Month↔Year) doesn't refetch — the response already
  // carries P&L, Balance Sheet and Cash Flow for every period.
  const krFinancialsCacheRef = useRef({ versionId: null, data: null });
  // Cache the raw Key Reports financial-statements response per version so that
  // switching tabs / period (Month↔Year) doesn't refetch — the response already
  // carries P&L, Balance Sheet and Cash Flow for every period.
  const krFinancialsCacheRef = useRef({ versionId: null, data: null });
  const currentSignature = useMemo(
    () =>
      JSON.stringify({
        clientId,
        tab: selectedTab,
        reportType: resolveEffectiveReportType(selectedTab, reportType, reportPeriod),
        reportPeriod,
        yearRangeStart: reportPeriod === "Year" ? yearRangeStart : null,
        yearRangeEnd: reportPeriod === "Year" ? yearRangeEnd : null,
        accountingMethod,
        source: selectedSourceMode,
        manualFilters: buildManualFilterParams(appliedManualFilters),
        dateRange,
        customRange,
        manualUploadRowId: selectedManualUploadRowId[selectedTab] || null,
        qmsRowId: selectedQMSRowId[selectedTab] || null,
        manualCfYear: selectedManualCfYear || null,
        // Key Reports version is the authoritative data source — include it so the
        // cache busts and the report re-fetches as soon as the KR store finishes
        // loading, preventing stale Manual GL data from being shown permanently.
        krVersionId: kr.selectedVersionId || null,
      }),
    [
      clientId,
      selectedTab,
      reportType,
      reportPeriod,
      yearRangeStart,
      yearRangeEnd,
      accountingMethod,
      selectedSourceMode,
      appliedManualFilters,
      dateRange,
      customRange,
      selectedManualUploadRowId,
      selectedQMSRowId,
      selectedManualCfYear,
      kr.selectedVersionId,
    ],
  );
  const currentSignatureRef = useRef(currentSignature);
  currentSignatureRef.current = currentSignature;

  // Date From / Date To pickers now read directly from fromDate/toDate — no year round-trip.

  // Sync the Key Report Version selection (which acts as the single source of truth)
  // to the Manual GL filters so the P&L / Balance Sheet / Cashflow reports reflect
  // exactly the selected version's data.
  useEffect(() => {
    if (!kr.krActive || kr.flowType !== "manual_gl" || kr.resolvedDatasetVersion == null) return;
    const nextVersion = String(kr.resolvedDatasetVersion);
    const currentVersion = String(manualFilters.datasetVersion || "");

    if (nextVersion !== currentVersion) {
      const next = {
        ...manualFilters,
        datasetVersion: nextVersion,
        batchId: "",
        fiscalYear: [],
        fiscalMonth: [],
      };
      setManualFilters(next);
      setAppliedManualFilters(next);
      debugLog("[ManualGL][UI][KRVersionSync]", { nextVersion });
    }
  }, [
    kr.krActive,
    kr.flowType,
    kr.resolvedDatasetVersion,
    manualFilters.datasetVersion, // Only trigger when version in filters differs
    debugLog,
  ]);



  useEffect(() => {
    if (selectedSourceMode !== "manual" || !clientId) return;
    // New-style Key Reports versions (no resolvedBatchId) sync data into entry
    // tables — they have NO Manual GL batch. Fetching staging filter options would
    // load the wrong fiscal years into state and contaminate the KR report filters.
    // Old-style KR (resolvedBatchId set) still needs filter options for its batch.
    if (kr.krActive && !kr.version?.resolvedBatchId) {
      debugLog("[KeyReports][Report] Skipping filter-options: new-style KR (entry-tables path), versionId=", kr.selectedVersionId);
      return;
    }

    // Scope filter options (years, accounts, etc.) to the SELECTED version so the
    // dropdowns reflect only that version's data — never another version's.
    const selectedVersion = String(manualFiltersRef.current.datasetVersion || "");
    getManualStageFilterOptions({
      clientId,
      params: selectedVersion ? { datasetVersion: selectedVersion } : {},
    })
      .then((payload) => {
        const activeBatchId = String(payload?.activeBatchId || "").trim();
        const resolvedBatchId = String(payload?.resolvedBatchId || activeBatchId || "").trim();
        const options = payload?.options && typeof payload.options === "object"
          ? payload.options
          : {};
        setManualFilterOptions(options);
        debugLog("[ManualGL][UI][FilterOptions]", {
          resolvedBatchId: resolvedBatchId || null,
          activeBatchId: activeBatchId || null,
          fiscalYears: options?.fiscalYear || [],
        });
        const availableYears = Array.isArray(options.fiscalYear) ? options.fiscalYear : [];
        const currentFilters = manualFiltersRef.current;
        let nextFilters = { ...currentFilters };
        let changed = false;

        if (resolvedBatchId && currentFilters.batchId !== resolvedBatchId) {
          nextFilters.batchId = resolvedBatchId;
          nextFilters.fiscalMonth = [];
          changed = true;
        }

        // Auto-populate fromDate/toDate from the full span of available data
        // when no date range has been manually selected yet.
        if (availableYears.length > 0) {
          const sortedYears = [...availableYears].map(Number).filter(Number.isFinite).sort((a, b) => a - b);
          const spanFrom = `${sortedYears[0]}-01-01`;
          const spanTo = `${sortedYears[sortedYears.length - 1]}-12-31`;

          const hasFromDate = String(nextFilters.fromDate || "").trim();
          const hasToDate = String(nextFilters.toDate || "").trim();

          if (!hasFromDate || !hasToDate) {
            nextFilters.fromDate = hasFromDate || spanFrom;
            nextFilters.toDate = hasToDate || spanTo;
            changed = true;
            debugLog("[ManualGL][UI][FilterAutoSelectDateRange]", { fromDate: nextFilters.fromDate, toDate: nextFilters.toDate });
          }

          // Keep fiscalYear in sync with available years (still used as supplemental multi-select).
          const availableSet = new Set(availableYears.map((y) => String(y)));
          const currentSelection = (nextFilters.fiscalYear || []).map(String);
          const stillValid = currentSelection.filter((y) => availableSet.has(y));
          if (stillValid.length !== currentSelection.length) {
            nextFilters.fiscalYear = stillValid;
            changed = true;
          }
        } else if ((nextFilters.fiscalYear || []).length > 0) {
          nextFilters.fiscalYear = [];
          changed = true;
        }

        if (changed) {
          setManualFilters(nextFilters);
          setAppliedManualFilters(nextFilters);
        }
      })
      .catch((error) => {
        console.error("[WorkspaceReports] Failed to load manual filter options:", error);
        setManualFilterOptions({});
      });
    // filterOptionsVersion increments when a new GL batch is staged, forcing a re-fetch.
    // manualFilters.datasetVersion re-fetches the year list when the user switches version.
    // kr.krActive / kr.version?.resolvedBatchId: re-evaluate the new-style KR guard when KR loads.
  }, [clientId, selectedSourceMode, filterOptionsVersion, manualFilters.datasetVersion, debugLog, kr.krActive, kr.version?.resolvedBatchId]);

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
    const params = {
      clientId,
      ...(kr.krActive && kr.selectedVersionId ? { keyReportVersionId: kr.selectedVersionId } : {}),
    };
    getAllManualUploadedReports(stType, params)
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

  // Load available Cash Flow years when on Cashflow tab in manual_upload mode.
  useEffect(() => {
    if (selectedSourceMode !== "manual_upload" || selectedTab !== "Cashflow" || !clientId) return;

    setIsLoadingCfYears(true);
    getManualCashFlowPeriods({ clientId })
      .then((result) => {
        const years = (result?.periods || [])
          .map((p) => parseInt(String(p.period ?? p), 10))
          .filter(Boolean)
          .sort((a, b) => b - a); // descending so latest is first
        setManualCfYears(years);
        setSelectedManualCfYear((prev) => {
          // Keep existing selection if still valid; otherwise default to latest.
          if (prev && years.includes(parseInt(String(prev), 10))) return prev;
          return years.length ? String(years[0]) : null;
        });
      })
      .catch(() => {
        setManualCfYears([]);
        setSelectedManualCfYear(null);
      })
      .finally(() => setIsLoadingCfYears(false));
  }, [selectedSourceMode, selectedTab, clientId]);

  // Load QMS report files per tab when in quickbooks_manual source mode
  useEffect(() => {
    if (selectedSourceMode !== "quickbooks_manual" || !clientId) return;
    const statementTypeMap = {
      "Balance Sheet": "balance_sheet",
      "Profit & Loss": "profit_and_loss",
      "Cashflow": "cash_flow",
    };
    const stType = statementTypeMap[selectedTab];
    if (!stType) return;

    setIsLoadingQMSFiles(true);
    const params = {
      clientId,
      ...(kr.krActive && kr.selectedVersionId ? { keyReportVersionId: kr.selectedVersionId } : {}),
    };
    getAllQMSUploadedReports(stType, params)
      .then((result) => {
        const files = result?.files || [];
        setQMSFiles((prev) => ({ ...prev, [selectedTab]: files }));
        setSelectedQMSRowId((prev) => {
          const current = prev[selectedTab];
          const stillValid = files.some((f) => f.rowId === current);
          return stillValid ? prev : { ...prev, [selectedTab]: files[0]?.rowId || null };
        });
      })
      .catch((err) => {
        console.error("[WorkspaceReports] Failed to load QMS files:", err);
        setQMSFiles((prev) => ({ ...prev, [selectedTab]: [] }));
      })
      .finally(() => setIsLoadingQMSFiles(false));
  }, [selectedSourceMode, selectedTab, clientId]);

  useEffect(() => {
    if (!clientId || !hasRestoredSessionRef.current) return;

    saveStoredReportsState(clientId, {
      selectedTab,
      reportType,
      reportPeriod,
      reportPeriod,
      dateRange,
      customRange,
      accountingMethod,
      manualDateRange,
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
    manualDateRange,
    appliedManualFilters,
    appliedAccountingMethod,
    appliedEndDate,
    appliedReportType,
    appliedStartDate,
    clientId,
    customRange,
    dateRange,
    reportType,
    reportPeriod,
    reportPeriod,
    reportsData,
    selectedReportSource,
    selectedTab,
    manualFilters,
  ]);

  // Version selector removed — single-dataset mode has no per-version effects.

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

  // Export the currently-rendered report (#report-content) to Excel or PDF.
  const handleExport = async (kind) => {
    setExportOpen(false);
    setIsExporting(true);
    try {
      const name = `${company?.name || "Report"} - ${selectedTab}`;
      if (kind === "excel") {
        exportReportToExcel("report-content", name);
      } else {
        await exportReportToPdf("report-content", name, {
          entityName: company?.name || clientName || "Company",
          reportType: selectedTab,
          startDate: appliedStartDate,
          endDate: appliedEndDate,
          accountingMethod: appliedAccountingMethod,
        });
      }
    } catch (err) {
      console.error("[WorkspaceReports] Export failed:", err);
      alert(err?.message || "Export failed. Please try again.");
    } finally {
      setIsExporting(false);
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

  // Multi-select fiscal years. Stores a de-duped, descending-sorted array into
  // both the working and applied filters (matches the old single-select behavior
  // of applying immediately). Reads the latest filters via ref to avoid a stale
  // closure when the user toggles several years quickly.
  // Date From / Date To pickers are pure views over fiscalYear[] + fiscalMonth[]
  // (the backend source of truth). They update the DRAFT only — the report
  // refetches when Apply is clicked, matching the previous multi-select behavior.
  // Direct date-range handlers — no fiscal-year round-trip.
  const handleDateFromChange = useCallback(
    (value) => {
      setManualFilters((prev) => {
        const next = { ...prev, fromDate: value };
        setAppliedManualFilters(next);
        return next;
      });
      debugLog("[ManualGL][UI][FilterChange][DateFrom]", { from: value });
    },
    [debugLog],
  );

  const handleDateToChange = useCallback(
    (value) => {
      setManualFilters((prev) => {
        const next = { ...prev, toDate: value };
        setAppliedManualFilters(next);
        return next;
      });
      debugLog("[ManualGL][UI][FilterChange][DateTo]", { to: value });
    },
    [debugLog],
  );

  // Switch the active dataset version. Clears batch + date range + year/month so the
  // filter-options effect re-derives the full span for the newly selected version.
  const handleVersionChange = useCallback(
    (versionValue) => {
      const nextVersion = String(versionValue || "");
      const next = {
        ...manualFiltersRef.current,
        datasetVersion: nextVersion,
        batchId: "",
        fromDate: "",
        toDate: "",
        fiscalYear: [],
        fiscalMonth: [],
      };
      setManualFilters(next);
      setAppliedManualFilters(next);
      debugLog("[ManualGL][UI][FilterChange][Version]", { selectedVersion: nextVersion });
    },
    [debugLog],
  );


  // Core report fetch + state write, parameterised by tab/reportType so it can
  // serve both the foreground (actively-viewed tab) and the background prefetch
  // of sibling tabs. When background=true it skips the loading spinner and the
  // shared "applied*" header state — it only fills reportsData[tab] and records
  // the slot signature, so a later switch to that tab renders instantly with no
  // network round-trip.
  const handleGenerateReport = useCallback(async () => {
    // Capture the slot + signature at the start so we can cache the result and
    // guard against a stale write if filters change mid-flight.
    // P&L follows the Month/Year period toggle (no Summary/Detailed) —
    // see resolveEffectiveReportType.
    const effectiveReportType = resolveEffectiveReportType(selectedTab, reportType, reportPeriod);
    const slotKey = `${selectedTab}|${effectiveReportType}`;
    const signatureAtStart = currentSignatureRef.current;

    // Key Reports active with a resolved version → render the COA-driven
    // financial statements (P&L / Balance Sheet / Cash Flow) straight from the
    // /reports/financial-statements endpoint. The response is transformed into
    // the same { rows, columns } detail shape the manual-upload renderers use,
    // so the Reports UI is unchanged and the Period / Year filters keep working.
    if (kr.krActive && kr.selectedVersionId) {
      setIsLoading(true);
      try {
        // L1 in-memory cache (same mount) only. The sessionStorage L2 cache is
        // deliberately NOT read here: it is keyed by versionId with no staleness
        // signal, so after a re-generate (the numbers change but the versionId
        // does not) an L2 hit would serve the PRE-regenerate response — often the
        // empty "no data yet" payload from before the version finished generating —
        // with NO network call, leaving the report blank. The backend now has a
        // fast, staleness-aware result cache (keyed by last_synced_at + COA edit),
        // so going to the network is both correct and quick (~1.5s).
        let response =
          krFinancialsCacheRef.current.versionId === kr.selectedVersionId
            ? krFinancialsCacheRef.current.data
            : null;
        if (!response) {
          response = await getFinancialStatements(kr.selectedVersionId, {
            currency: "USD",
          });
          // Refresh the L2 cache with the fresh payload so other pages (e.g. Bank
          // Reconciliation) reuse the current numbers rather than a stale copy.
          writeCachedFinancials(clientId, kr.selectedVersionId, response);
        }
        krFinancialsCacheRef.current = {
          versionId: kr.selectedVersionId,
          data: response,
        };

        const isYearMode = reportPeriod === "Year";
        // Month mode honours the Date From / Date To pickers (stored in
        // appliedManualFilters as fromDate/toDate).
        const monthStart = !isYearMode ? appliedManualFilters?.fromDate || null : null;
        const monthEnd = !isYearMode ? appliedManualFilters?.toDate || null : null;
        const detail = transformKeyReportFinancials(response, {
          tab: selectedTab,
          period: reportPeriod,
          yearStart: isYearMode ? yearRangeStart : null,
          yearEnd: isYearMode ? yearRangeEnd : null,
          monthStart,
          monthEnd,
        });

        // Derive display dates from the resolved columns for the report header/export.
        const cols = detail.columns?.yearCols || [];
        const firstYear = cols.length ? String(cols[0].label).match(/(\d{4})/)?.[1] : null;
        const lastYear = cols.length ? String(cols[cols.length - 1].label).match(/(\d{4})/)?.[1] : null;

        setAppliedReportType("Detail");
        setAppliedAccountingMethod(accountingMethod);
        setAppliedStartDate(monthStart || (firstYear ? `${firstYear}-01-01` : ""));
        setAppliedEndDate(monthEnd || (lastYear ? `${lastYear}-12-31` : ""));

        setReportsData((previous) => ({
          ...previous,
          [selectedTab]: {
            ...previous[selectedTab],
            detail,
            summary: [],
          },
        }));

        if (currentSignatureRef.current === signatureAtStart) {
          reportSignaturesRef.current[slotKey] = signatureAtStart;
        }
      } catch (error) {
        console.error(
          "[KeyReports][Report] financial-statements fetch failed:",
          error,
        );
        setReportsData((previous) => ({
          ...previous,
          [selectedTab]: createInitialReportsData()[selectedTab],
        }));
      } finally {
        setIsLoading(false);
      }
      return;
    }

    // Key Reports is the active source but no usable Key Report Version resolved
    // yet (e.g. none created/synced, or the version detail is still loading). Do
    // NOT fall through to the QuickBooks / manual fetch path — that leaks a
    // profit-and-loss request (which 404s when there's no QuickBooks connection)
    // and paints an empty report. Gate on krSelected too so this also covers the
    // brief window before the active source resolves and krActive settles.
    if (krSelected || selectedSourceMode === "key_reports") {
      setReportsData((prev) => ({
        ...prev,
        [selectedTab]: createInitialReportsData()[selectedTab],
      }));
      reportSignaturesRef.current[slotKey] = signatureAtStart;
      setIsLoading(false);
      return;
    }

    setIsLoading(true);

    try {
      const rawDates = getDates();
      const { startDate: userStart, endDate: userEnd } = sanitizeDateRange(
        rawDates.startDate,
        rawDates.endDate,
      );
      const normalizedAccountingMethod =
        normalizeAccountingMethod(accountingMethod);

      const isYearMode = reportPeriod === "Year";

      // In manual-upload / QMS mode, resolve the fiscal year from the selected file
      // (avoids an extra API call — file list was already fetched by the files effect).
      // In Year mode we use the full year range instead of a single file.
      let resolvedStart;
      let resolvedEnd;
      if (isYearMode && (selectedSourceMode === "manual_upload" || selectedSourceMode === "quickbooks_manual")) {
        // Year mode: span the whole selected year range; the service filters files itself.
        const sy = yearRangeStart || String(new Date().getFullYear());
        const ey = yearRangeEnd || sy;
        resolvedStart = `${sy}-01-01`;
        resolvedEnd = `${ey}-12-31`;
      } else if (selectedSourceMode === "manual_upload") {
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
      } else if (selectedSourceMode === "quickbooks_manual") {
        const selectedRowId = selectedQMSRowId[selectedTab];
        const fileEntry = qmsFiles[selectedTab]?.find(
          (f) => f.rowId === selectedRowId,
        ) || qmsFiles[selectedTab]?.[0];
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

      // Single-dataset mode: reports use only the currently active staged dataset.
      // No version or batchId override is needed.
      const manualFilterParams =
        selectedSourceMode === "manual"
          ? { ...buildManualFilterParams(appliedManualFilters) }
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

      // For manual GL mode: derive display dates from fromDate/toDate.
      let effectiveStartDate = resolvedStart;
      let effectiveEndDate = resolvedEnd;
      if (selectedSourceMode === "manual") {
        const fromDate = String(appliedManualFilters?.fromDate || "").trim();
        const toDate = String(appliedManualFilters?.toDate || "").trim();
        if (fromDate) effectiveStartDate = fromDate;
        if (toDate) effectiveEndDate = toDate;
      }
      // Month mode for QB Online: use the user's FROM/TO dates directly so the
      // service generates monthly columns for exactly the selected range.
      if (!isYearMode && selectedSourceMode === "quickbooks" && userStart && userEnd) {
        effectiveStartDate = userStart;
        effectiveEndDate = userEnd;
      }
      // For manual_upload Cash Flow: period must reflect the selected CF year,
      // not the QB date-range picker (which is hidden on this tab).
      if (selectedSourceMode === "manual_upload" && selectedTab === "Cashflow" && selectedManualCfYear) {
        effectiveStartDate = `${selectedManualCfYear}-01-01`;
        effectiveEndDate = `${selectedManualCfYear}-12-31`;
      }

      setAppliedStartDate(effectiveStartDate || "");
      setAppliedEndDate(effectiveEndDate || "");
      setAppliedReportType(effectiveReportType);
      setAppliedAccountingMethod(accountingMethod);
      let summary = [];
      let detail = { groups: [] };

      // Year mode options passed through to all Detail service calls.
      const yearModeOptions = isYearMode
        ? { yearMode: true, startYear: yearRangeStart, endYear: yearRangeEnd }
        : { monthMode: true };

      const manualUploadRowId =
        selectedSourceMode === "manual_upload"
          ? selectedManualUploadRowId[selectedTab]
          : selectedSourceMode === "quickbooks_manual"
            ? selectedQMSRowId[selectedTab]
            : null;

      const commonOptions = {
        sourceMode: selectedSourceMode,
        manualFilters: manualFilterParams,
        keyReportVersionId: kr.selectedVersionId || null,
      };

      if (kr.selectedVersionId) {
        console.log(`[KeyReports][Report] Generating ${selectedTab} / ${effectiveReportType} versionId=${kr.selectedVersionId} sourceMode=${selectedSourceMode}`);
      }

      if (selectedTab === "Balance Sheet") {
        if (effectiveReportType === "Summary") {
          summary = await getBalanceSheet(
            effectiveStartDate,
            effectiveEndDate,
            normalizedAccountingMethod,
            {
              ...commonOptions,
              manualFilters: summaryFilterParams,
              manualUploadRowId,
            },
          );
        } else {
          detail = await getBalanceSheetDetail(
            effectiveStartDate,
            effectiveEndDate,
            normalizedAccountingMethod,
            {
              ...commonOptions,
              ...yearModeOptions,
            },
          );
        }
      } else if (selectedTab === "Profit & Loss") {
        if (effectiveReportType === "Summary") {
          summary = await getProfitAndLoss(
            effectiveStartDate,
            effectiveEndDate,
            normalizedAccountingMethod,
            {
              ...commonOptions,
              manualFilters: summaryFilterParams,
              manualUploadRowId,
            },
          );
        } else {
          detail = await getProfitAndLossDetail(
            effectiveStartDate,
            effectiveEndDate,
            normalizedAccountingMethod,
            {
              ...commonOptions,
              reportType: effectiveReportType,
              ...yearModeOptions,
            },
          );
        }
      } else {
        if (effectiveReportType === "Summary") {
          summary = await getCashflow(
            effectiveStartDate,
            effectiveEndDate,
            normalizedAccountingMethod,
            {
              ...commonOptions,
              manualFilters: summaryFilterParams,
              manualUploadRowId,
              year: selectedManualCfYear,
              // Always regenerate for manual_upload CF so stale cache (generated
              // before a previous-year BS was uploaded) is never served.
              force: selectedSourceMode === "manual_upload",
            },
          );
        } else {
          detail = await getCashflowDetail(
            effectiveStartDate,
            effectiveEndDate,
            normalizedAccountingMethod,
            {
              ...commonOptions,
              ...yearModeOptions,
            },
          );
        }
      }

      setReportsData((previous) => ({
        ...previous,
        [selectedTab]: {
          ...previous[selectedTab],
          ...(effectiveReportType === "Summary" ? { summary } : { detail }),
        },
      }));

      // Cache the signature on success so re-selecting this tab with identical
      // filters renders instantly without a network round-trip. Only record when
      // the signature still matches (filters didn't change while in flight).
      if (currentSignatureRef.current === signatureAtStart) {
        reportSignaturesRef.current[slotKey] = signatureAtStart;
      }

      if (selectedSourceMode === "manual" && effectiveReportType === "Summary") {
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
    reportPeriod,
    yearRangeStart,
    yearRangeEnd,
    selectedSourceMode,
    selectedTab,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    selectedManualUploadRowId[selectedTab],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    selectedQMSRowId[selectedTab],
    selectedManualCfYear,
    krSelected,
    kr.krActive,
    kr.selectedVersionId,
  ]);

  // Auto-generate report when dependencies change.
  // Debounced 80ms to prevent double-fetch when multiple state updates arrive
  // in the same tick (e.g. session restore followed by filter auto-selection).
  // handleGenerateReport is memoized with useCallback so this effect only fires
  // when the underlying filter/tab/source values actually change.
  // Auto-generate report when dependencies change.
  // Debounced 80ms to prevent double-fetch when multiple state updates arrive
  // in the same tick (e.g. session restore followed by filter auto-selection).
  // handleGenerateReport is memoized with useCallback so this effect only fires
  // when the underlying filter/tab/source values actually change.
  useEffect(() => {
    if (!clientId) return undefined;

    // Hold until the Key Reports store has settled — prevents a Manual GL first
    // pass while the selected Key Report Version is still loading.
    if (!krReady) {
      setIsLoading(true);
      return undefined;
    }

    const effectiveReportType = resolveEffectiveReportType(
      selectedTab,
      reportType,
      reportPeriod,
    );
    const slotKey = `${selectedTab}|${effectiveReportType}`;

    // Already have a result for this exact signature → render the cached data
    // immediately, skip the network fetch.
    if (reportSignaturesRef.current[slotKey] === currentSignature) {
      // Even on a cache hit, we must ensure the "applied" header states are
      // synchronized so the report metadata (type, dates, method) correctly
      // matches the rendered data.
      setAppliedReportType(effectiveReportType);
      setAppliedAccountingMethod(accountingMethod);
      // Derive display dates (matches handleGenerateReport's resolver logic)
      const rawDates = getDates();
      const { startDate: userStart, endDate: userEnd } = sanitizeDateRange(
        rawDates.startDate,
        rawDates.endDate,
      );
      let effStart = userStart;
      let effEnd = userEnd;

      if (selectedSourceMode === "manual") {
        const manualFilterParams = buildManualFilterParams(appliedManualFilters);
        const selectedYears = (appliedManualFilters?.fiscalYear?.length
          ? appliedManualFilters.fiscalYear
          : manualFilterParams?.fiscalYear || []
        )
          .map(Number)
          .filter(Number.isFinite);
        if (selectedYears.length > 0) {
          effStart = `${Math.min(...selectedYears)}-01-01`;
          effEnd = `${Math.max(...selectedYears)}-12-31`;
        }
      } else if (
        selectedSourceMode === "manual_upload" &&
        selectedTab === "Cashflow" &&
        selectedManualCfYear
      ) {
        effStart = `${selectedManualCfYear}-01-01`;
        effEnd = `${selectedManualCfYear}-12-31`;
      }
      setAppliedStartDate(effStart || "");
      setAppliedEndDate(effEnd || "");
      setIsLoading(false);
      return undefined;
    }

    // Not in cache -> set loading state IMMEDIATELY so the UI responds
    // to the filter change before the debounced fetch kicks in.
    setIsLoading(true);

    const timer = setTimeout(handleGenerateReport, 80);
    return () => clearTimeout(timer);
  }, [
    handleGenerateReport,
    clientId,
    currentSignature,
    selectedTab,
    reportType,
    reportPeriod,
    accountingMethod,
    selectedSourceMode,
    appliedManualFilters,
    getDates,
    selectedManualCfYear,
    krReady,
  ]);


  const currentReport = reportsData[selectedTab];

  // Detect empty state for manual GL: report was fetched but returned no data
  // for the selected date range. Show a clear message instead of a blank report.
  const isManualGlEmptyState = useMemo(() => {
    if (selectedSourceMode !== "manual" || isLoading) return false;
    const from = String(appliedManualFilters?.fromDate || "").trim();
    const to = String(appliedManualFilters?.toDate || "").trim();
    if (!from && !to) return false; // no filter applied yet
    const report = reportsData[selectedTab];
    const summaryEmpty =
      !report?.summary ||
      (Array.isArray(report.summary) && report.summary.length === 0) ||
      (report.summary?.rows && report.summary.rows.length === 0);
    const detailEmpty =
      !report?.detail ||
      (Array.isArray(report.detail?.groups) && report.detail.groups.length === 0);
    return summaryEmpty && detailEmpty;
  }, [selectedSourceMode, isLoading, appliedManualFilters, reportsData, selectedTab]);

  const isManualReportMode = selectedSourceMode === "manual_upload" || selectedSourceMode === "quickbooks_manual";

  // Years available in the current data source — used to populate the Year-range pickers.
  const availableYears = useMemo(() => {
    const currentYear = new Date().getFullYear();
    if (selectedSourceMode === "manual_upload") {
      const files = manualUploadFiles[selectedTab] || [];
      const years = files
        .map((f) => resolveManualUploadYear({ data: f.data, reportParams: { fileName: f.fileName } }))
        .filter(Boolean);
      const unique = [...new Set(years)].sort((a, b) => a - b);
      if (unique.length) return unique;
    }
    if (selectedSourceMode === "quickbooks_manual") {
      const files = qmsFiles[selectedTab] || [];
      const years = files
        .map((f) => resolveManualUploadYear({ data: f.data, reportParams: { fileName: f.fileName } }))
        .filter(Boolean);
      const unique = [...new Set(years)].sort((a, b) => a - b);
      if (unique.length) return unique;
    }
    if (selectedSourceMode === "manual") {
      const years = (manualFilterOptions?.fiscalYear || []).map(Number).filter(Boolean);
      const unique = [...new Set(years)].sort((a, b) => a - b);
      if (unique.length) return unique;
    }
    // QuickBooks online: last 6 calendar years.
    return Array.from({ length: 6 }, (_, i) => currentYear - 5 + i);
  }, [selectedSourceMode, selectedTab, manualUploadFiles, qmsFiles, manualFilterOptions]);

  // Auto-initialise year range when available years change (e.g. after files load).
  useEffect(() => {
    if (!availableYears.length) return;
    setYearRangeStart((prev) => {
      if (prev !== null && availableYears.includes(Number(prev))) return prev;
      return String(availableYears[0]);
    });
    setYearRangeEnd((prev) => {
      if (prev !== null && availableYears.includes(Number(prev))) return prev;
      return String(availableYears[availableYears.length - 1]);
    });
  }, [availableYears]);
  const availableReportMonths = useMemo(() => {
    if (!isManualReportMode) return [];
    const detail = currentReport?.detail;
    if (!detail) return [];
    // manual_upload / quickbooks_manual: yearCols with "MMM YYYY" labels
    const yearCols = detail?.columns?.yearCols;
    if (Array.isArray(yearCols) && yearCols.length > 0) {
      const monthly = [...new Set(yearCols.map((c) => colLabelToISO(c.label)).filter(Boolean))].sort();
      if (monthly.length > 0) return monthly;
      // Fallback: file has only yearly columns (e.g. "FY 2025") — expand each year to Jan–Dec
      // so the date pickers are always populated and functional.
      const fyMonths = [];
      yearCols.forEach((col) => {
        const label = String(col.label || "").trim().toUpperCase();
        const fyMatch = /^FY\s+(\d{4})$/.exec(label) || /^(\d{4})$/.exec(label);
        if (fyMatch) {
          const yr = fyMatch[1];
          for (let m = 1; m <= 12; m++) fyMonths.push(`${yr}-${String(m).padStart(2, "0")}`);
        }
      });
      if (fyMonths.length > 0) return [...new Set(fyMonths)].sort();
      // Last resort: derive from asOfDate stored on the report
      const asOf = detail?.asOfDate;
      if (asOf) {
        const yr = String(asOf).slice(0, 4);
        if (/^\d{4}$/.test(yr)) {
          return Array.from({ length: 12 }, (_, i) => `${yr}-${String(i + 1).padStart(2, "0")}`);
        }
      }
    }
    // Manual GL: detail.months (int array) + detail.year
    if (Array.isArray(detail?.months) && detail?.year) {
      return detail.months.map((m) => `${detail.year}-${String(m).padStart(2, "0")}`).sort();
    }
    return [];
  }, [currentReport, isManualReportMode]);
  useEffect(() => {
    if (!availableReportMonths.length) {
      setReportStartMonth(null);
      setReportEndMonth(null);
    } else {
      setReportStartMonth(availableReportMonths[0]);
      setReportEndMonth(availableReportMonths[availableReportMonths.length - 1]);
    }
  }, [availableReportMonths]);
  const filteredReportMonthNums = useMemo(() => {
    if (!availableReportMonths.length) return [];
    const start = reportStartMonth || availableReportMonths[0];
    const end = reportEndMonth || availableReportMonths[availableReportMonths.length - 1];
    return availableReportMonths
      .filter((m) => m >= start && m <= end)
      .map((m) => Number(m.split("-")[1]));
  }, [availableReportMonths, reportStartMonth, reportEndMonth]);

  // Pre-filter detailedData for manual_upload / quickbooks_manual: strip yearCols
  // and row amounts that fall outside the selected month range, so all downstream
  // components (BalanceSheetSummary, ProfitAndLossSummary, CashflowSummary) only
  // see the selected columns without needing any prop changes.
  const filteredDetailedData = useMemo(() => {
    const detail = currentReport?.detail;
    if (!isManualReportMode || !detail) return detail;
    const yearCols = detail?.columns?.yearCols;
    if (!Array.isArray(yearCols) || !availableReportMonths.length) return detail;
    const start = reportStartMonth || availableReportMonths[0];
    const end = reportEndMonth || availableReportMonths[availableReportMonths.length - 1];
    const filteredCols = yearCols.filter((col) => {
      const iso = colLabelToISO(col.label);
      if (!iso) return true; // non-month columns (e.g. "FY 2025") always shown
      return iso >= start && iso <= end;
    });
    const filteredKeys = new Set(filteredCols.map((c) => c.key));
    const filterNode = (node) => ({
      ...node,
      amounts: Object.fromEntries(
        Object.entries(node.amounts || {}).filter(([k]) => filteredKeys.has(k))
      ),
      children: node.children ? node.children.map(filterNode) : undefined,
    });
    return {
      ...detail,
      columns: { ...detail.columns, yearCols: filteredCols },
      rows: (detail.rows || []).map(filterNode),
    };
  }, [currentReport, isManualReportMode, reportStartMonth, reportEndMonth, availableReportMonths]);

  return (
    <div className="page-container">
      <Header title="Reports" />

      <div className="page-content">
        <QBDisconnectedBanner />
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-bold text-[#050505]">
              Financial Reports
            </h1>
          </div>
          <div className="flex items-center gap-2">
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
        </div>



        <div className="mb-6 flex gap-6 border-b border-border pb-px">
          {REPORT_TABS.map((tab) => {
            const avail = reportTabAvailability(tab.key);
            return (
              <button
                key={tab.key}
                onClick={() => avail.enabled && setSelectedTab(tab.key)}
                disabled={!avail.enabled}
                title={avail.enabled ? undefined : avail.reason}
                className={cn(
                  "relative pb-3 text-[14px] font-medium transition-all",
                  !avail.enabled
                    ? "cursor-not-allowed text-text-muted/40"
                    : selectedTab === tab.key
                      ? "font-semibold text-text-primary after:absolute after:bottom-[-1px] after:left-0 after:h-[2px] after:w-full after:rounded-full after:bg-primary after:content-['']"
                      : "text-text-muted hover:text-text-secondary",
                )}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        <div className="card-base p-4 flex flex-col">
          {/* Collapsible filter bar — reclaims vertical space for the report. */}
          <div className="mb-2 flex items-center gap-3">
            <button
              type="button"
              onClick={() => setFiltersCollapsed((v) => !v)}
              className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wider text-text-muted transition-colors hover:text-text-secondary"
            >
              <ChevronDown
                size={14}
                className={cn("transition-transform", filtersCollapsed && "-rotate-90")}
              />
              {filtersCollapsed ? "Show Filters" : "Hide Filters"}
            </button>
            {filtersCollapsed && (
              <span className="truncate text-[12px] text-text-muted">
                {[
                  selectedSourceMode === "quickbooks" ? accountingMethod : null,
                  selectedSourceMode === "manual" && (manualFilters.fromDate || manualFilters.toDate)
                    ? `${manualFilters.fromDate || "…"} → ${manualFilters.toDate || "…"}`
                    : null,
                ]
                  .filter(Boolean)
                  .join("  ·  ")}
              </span>
            )}
          </div>
          {/* QuickBooks-style Top Control Bar */}
          <div
            className={cn(
              "mb-3 flex flex-wrap items-end gap-4 border-b border-border-light pb-3",
              filtersCollapsed && "hidden",
            )}
          >
            {/* Report View toggle: only for tabs that do NOT use the unified
                Period (Month/Year) granularity logic. */}
            {selectedTab !== "Profit & Loss" &&
              selectedTab !== "Balance Sheet" &&
              selectedTab !== "Cashflow" && (
                <div className="flex flex-col gap-1.5">
                  <label className="text-[12px] font-medium uppercase tracking-wider text-text-muted">
                    Report View
                  </label>
                  <div className="flex rounded-lg border border-border bg-bg-page p-1">
                    <button
                      onClick={() => {
                        setReportType("Summary");
                        if (Array.isArray(manualFilters.fiscalMonth) && manualFilters.fiscalMonth.length > 0) {
                          const cleared = { ...manualFilters, fiscalMonth: [] };
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
              )}

            {/* Period granularity toggle (Month = monthly columns, Year = annual
                columns) for major financial statements. */}
            {(selectedTab === "Profit & Loss" ||
              selectedTab === "Balance Sheet" ||
              selectedTab === "Cashflow") && (
                <div className="flex flex-col gap-1.5">
                  <label className="text-[12px] font-medium uppercase tracking-wider text-text-muted">
                    Period
                  </label>
                  <div className="flex rounded-lg border border-border bg-bg-page p-1">
                    <button
                      onClick={() => setReportPeriod("Month")}
                      className={cn(
                        "rounded-md px-4 py-1.5 text-[13px] font-medium transition-all",
                        reportPeriod === "Month"
                          ? "bg-bg-card text-text-primary shadow-sm ring-1 ring-border/50"
                          : "text-text-muted hover:text-text-secondary",
                      )}
                    >
                      Month
                    </button>
                    <button
                      onClick={() => setReportPeriod("Year")}
                      className={cn(
                        "rounded-md px-4 py-1.5 text-[13px] font-medium transition-all",
                        reportPeriod === "Year"
                          ? "bg-bg-card text-text-primary shadow-sm ring-1 ring-border/50"
                          : "text-text-muted hover:text-text-secondary",
                      )}
                    >
                      Year
                    </button>
                  </div>
                </div>
              )}

            {/* Year range filter — shown when Period = Year */}
            {(selectedTab === "Profit & Loss" ||
              selectedTab === "Balance Sheet" ||
              selectedTab === "Cashflow") &&
              reportPeriod === "Year" && (
                <div className="flex items-end gap-3">
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[12px] font-medium uppercase tracking-wider text-text-muted">
                      From Year
                    </label>
                    <div className="relative min-w-[110px]">
                      <select
                        value={yearRangeStart ?? ""}
                        onChange={(e) => setYearRangeStart(e.target.value)}
                        className="h-9 w-full appearance-none rounded-md border border-border-input bg-bg-card pl-3 pr-9 text-[13px] text-text-primary transition-all focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                      >
                        {availableYears.map((y) => (
                          <option key={y} value={String(y)}>
                            {y}
                          </option>
                        ))}
                      </select>
                      <ChevronDown
                        size={14}
                        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted"
                      />
                    </div>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[12px] font-medium uppercase tracking-wider text-text-muted">
                      To Year
                    </label>
                    <div className="relative min-w-[110px]">
                      <select
                        value={yearRangeEnd ?? ""}
                        onChange={(e) => setYearRangeEnd(e.target.value)}
                        className="h-9 w-full appearance-none rounded-md border border-border-input bg-bg-card pl-3 pr-9 text-[13px] text-text-primary transition-all focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                      >
                        {availableYears
                          .filter((y) => !yearRangeStart || y >= Number(yearRangeStart))
                          .map((y) => (
                            <option key={y} value={String(y)}>
                              {y}
                            </option>
                          ))}
                      </select>
                      <ChevronDown
                        size={14}
                        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted"
                      />
                    </div>
                  </div>
                </div>
              )}

            {reportType === "Summary" && reportPeriod !== "Year" && selectedSourceMode !== "manual" && selectedSourceMode !== "manual_upload" && selectedSourceMode !== "quickbooks_manual" && (
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

            {isManualReportMode && reportPeriod === "Month" && availableReportMonths.length > 0 && !kr.krActive && (
              <>
                <div>
                  <label className="block text-[11px] font-semibold uppercase tracking-wide text-text-muted mb-1">
                    Start Month
                  </label>
                  <input
                    type="date"
                    value={reportStartMonth ? `${reportStartMonth}-01` : ""}
                    min={availableReportMonths[0] ? `${availableReportMonths[0]}-01` : undefined}
                    max={reportEndMonth ? `${reportEndMonth}-01` : undefined}
                    onChange={(e) => {
                      const val = e.target.value;
                      if (!val) return;
                      const isoMonth = val.slice(0, 7);
                      setReportStartMonth(isoMonth);
                      if (reportEndMonth && isoMonth > reportEndMonth) setReportEndMonth(isoMonth);
                    }}
                    className="h-9 w-full rounded-md border border-border-input bg-bg-card px-3 text-[13px] text-text-primary"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold uppercase tracking-wide text-text-muted mb-1">
                    End Month
                  </label>
                  <input
                    type="date"
                    value={reportEndMonth ? `${reportEndMonth}-01` : ""}
                    min={reportStartMonth ? `${reportStartMonth}-01` : undefined}
                    max={availableReportMonths[availableReportMonths.length - 1] ? `${availableReportMonths[availableReportMonths.length - 1]}-01` : undefined}
                    onChange={(e) => {
                      const val = e.target.value;
                      if (!val) return;
                      const isoMonth = val.slice(0, 7);
                      setReportEndMonth(isoMonth);
                      if (reportStartMonth && isoMonth < reportStartMonth) setReportStartMonth(isoMonth);
                    }}
                    className="h-9 w-full rounded-md border border-border-input bg-bg-card px-3 text-[13px] text-text-primary"
                  />
                </div>
              </>
            )}

            {selectedSourceMode === "quickbooks" && (
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
            )}

            {/* Dataset Version selector removed — single-dataset mode */}

            {/* File selectors for manual upload and QMS sources are hidden when a 
                Key Reports version is active, as the version's linked documents
                automatically drive the data path. */}
            {selectedSourceMode === "manual_upload" && reportType === "Summary" && !kr.krActive && (
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

            {selectedSourceMode === "manual_upload" && selectedTab === "Cashflow" && !kr.krActive && reportPeriod !== "Year" && (
              isLoadingCfYears ? (
                <div className="flex flex-col gap-1.5">
                  <label className="text-[12px] font-medium uppercase tracking-wider text-text-muted">
                    Year
                  </label>
                  <div className="h-9 min-w-[120px] flex items-center px-3 rounded-md border border-border-input bg-bg-card text-[13px] text-text-muted animate-pulse">
                    Loading…
                  </div>
                </div>
              ) : manualCfYears.length > 0 ? (
                <div className="flex flex-col gap-1.5">
                  <label className="text-[12px] font-medium uppercase tracking-wider text-text-muted">
                    Year
                  </label>
                  <div className="relative min-w-[120px]">
                    <select
                      value={selectedManualCfYear || ""}
                      onChange={(e) => setSelectedManualCfYear(e.target.value || null)}
                      className="h-9 w-full appearance-none rounded-md border border-border-input bg-bg-card pl-3 pr-9 text-[13px] text-text-primary transition-all focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                    >
                      {manualCfYears.map((year) => (
                        <option key={year} value={String(year)}>{year}</option>
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

            {selectedSourceMode === "quickbooks_manual" && reportType === "Summary" && !kr.krActive && (
              isLoadingQMSFiles ? (
                <div className="flex flex-col gap-1.5">
                  <label className="text-[12px] font-medium uppercase tracking-wider text-text-muted">
                    File
                  </label>
                  <div className="h-9 min-w-[200px] flex items-center px-3 rounded-md border border-border-input bg-bg-card text-[13px] text-text-muted animate-pulse">
                    Loading files…
                  </div>
                </div>
              ) : qmsFiles[selectedTab]?.length > 0 ? (
                <div className="flex flex-col gap-1.5">
                  <label className="text-[12px] font-medium uppercase tracking-wider text-text-muted">
                    File
                  </label>
                  <div className="relative min-w-[200px]">
                    <select
                      value={selectedQMSRowId[selectedTab] || ""}
                      onChange={(e) => {
                        setSelectedQMSRowId((prev) => ({
                          ...prev,
                          [selectedTab]: e.target.value || null,
                        }));
                      }}
                      className="h-9 w-full appearance-none rounded-md border border-border-input bg-bg-card pl-3 pr-9 text-[13px] text-text-primary transition-all focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                    >
                      {qmsFiles[selectedTab].map((f) => (
                        <option key={f.rowId} value={f.rowId}>
                          {f.fileName}
                          {f.data?.asOfDate ? ` (${f.data.asOfDate.split("-")[0]})` : ""}
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

            {krSelected && <KeyReportVersionSelector clientId={clientId} variant="filter" />}

            {selectedSourceMode === "manual" ? (
              <>
                {reportPeriod !== "Year" && (
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[12px] font-medium uppercase tracking-wider text-text-muted">
                      Date From
                    </label>
                    <input
                      type="date"
                      value={manualFilters.fromDate || ""}
                      onChange={(e) => handleDateFromChange(e.target.value)}
                      className="h-9 min-w-[150px] rounded-md border border-border-input bg-bg-card px-3 text-[13px] text-text-primary transition-all focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                  </div>
                )}

                {reportPeriod !== "Year" && (
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[12px] font-medium uppercase tracking-wider text-text-muted">
                      Date To
                    </label>
                    <input
                      type="date"
                      value={manualFilters.toDate || ""}
                      onChange={(e) => handleDateToChange(e.target.value)}
                      className="h-9 min-w-[150px] rounded-md border border-border-input bg-bg-card px-3 text-[13px] text-text-primary transition-all focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                  </div>
                )}
              </>
            ) : (
              // Date-range filters for non-manual sources. Hidden in Year mode
              // (the From Year / To Year selectors drive the range instead).
              reportPeriod !== "Year" && (
                <>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[12px] font-medium uppercase tracking-wider text-text-muted">
                      Date From
                    </label>
                    <input
                      type="date"
                      value={manualFilters.fromDate || ""}
                      onChange={(e) => handleDateFromChange(e.target.value)}
                      className="h-9 min-w-[150px] rounded-md border border-border-input bg-bg-card px-3 text-[13px] text-text-primary transition-all focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                  </div>
              // Date-range filters for non-manual sources. Hidden in Year mode
                  // (the From Year / To Year selectors drive the range instead).
                  reportPeriod !== "Year" && (
                  <>
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[12px] font-medium uppercase tracking-wider text-text-muted">
                        Date From
                      </label>
                      <input
                        type="date"
                        value={manualFilters.fromDate || ""}
                        onChange={(e) => handleDateFromChange(e.target.value)}
                        className="h-9 min-w-[150px] rounded-md border border-border-input bg-bg-card px-3 text-[13px] text-text-primary transition-all focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <label className="text-[12px] font-medium uppercase tracking-wider text-text-muted">
                        Date To
                      </label>
                      <input
                        type="date"
                        value={manualFilters.toDate || ""}
                        onChange={(e) => handleDateToChange(e.target.value)}
                        className="h-9 min-w-[150px] rounded-md border border-border-input bg-bg-card px-3 text-[13px] text-text-primary transition-all focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                    </div>
                  </>
                  )
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[12px] font-medium uppercase tracking-wider text-text-muted">
                      Date To
                    </label>
                    <input
                      type="date"
                      value={manualFilters.toDate || ""}
                      onChange={(e) => handleDateToChange(e.target.value)}
                      className="h-9 min-w-[150px] rounded-md border border-border-input bg-bg-card px-3 text-[13px] text-text-primary transition-all focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                  </div>
                </>
              )
            )}



            <div className="flex flex-col gap-1.5 justify-end">
              {/* Spacer label to align with other filters */}
              <label className="text-[12px] font-medium uppercase tracking-wider text-transparent select-none">
                Export
              </label>
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setExportOpen((v) => !v)}
                  disabled={isExporting}
                  className="h-9 btn-secondary px-4 transition-all hover:bg-bg-page active:scale-95"
                >
                  <Download size={16} className={isExporting ? "animate-pulse" : ""} />
                  <span className="text-[13px] font-medium">
                    {isExporting ? "Exporting..." : "Export"}
                  </span>
                  <ChevronDown size={14} className={cn("transition-transform duration-200", exportOpen && "rotate-180")} />
                </button>
                {exportOpen && (
                  <>
                    <div
                      className="fixed inset-0 z-10"
                      onClick={() => setExportOpen(false)}
                    />
                    <div className="absolute right-0 top-full z-20 mt-1 w-48 overflow-hidden rounded-md border border-border bg-bg-card shadow-lg ring-1 ring-black ring-opacity-5 animate-in fade-in zoom-in-95 duration-150">
                      <button
                        type="button"
                        onClick={() => {
                          handleExport("excel");
                          setExportOpen(false);
                        }}
                        className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-[13px] text-text-primary transition-colors hover:bg-bg-page"
                      >
                        <FileSpreadsheet size={16} className="text-status-success" />
                        Export to Excel (.xlsx)
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          handleExport("pdf");
                          setExportOpen(false);
                        }}
                        className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-[13px] text-text-primary transition-colors hover:bg-bg-page"
                      >
                        <FileText size={16} className="text-status-error" />
                        Export to PDF (.pdf)
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="flex-1 animate-in fade-in slide-in-from-bottom-2 duration-500">
            {/* ── COA-driven reports (Key Reports version active) ───────────────
                Key Reports uses the stored report endpoints. The outer tabs remain
                the navigation and render finalized accounting payloads directly.
            ──────────────────────────────────────────────────────────────────── */}
            {isLoading ? (
              <div className="flex flex-1 flex-col items-center justify-center py-20">
                <div className="mb-6 h-12 w-12 animate-spin rounded-full border-4 border-border border-t-primary" />
                <p className="animate-pulse text-[14px] font-medium text-text-muted">
                  Fetching latest financial records from {selectedSourceLabel}...
                </p>
              </div>
            ) : isManualGlEmptyState ? (
              <div className="flex flex-1 flex-col items-center justify-center py-24 text-center">
                <div className="mb-4 h-12 w-12 rounded-full border-2 border-border flex items-center justify-center">
                  <FileText size={22} className="text-text-muted" />
                </div>
                <p className="text-[15px] font-semibold text-text-primary mb-1">
                  No data available for the selected date range.
                </p>
                <p className="text-[13px] text-text-muted">
                  Try adjusting the Date From and Date To filters above.
                </p>
              </div>
            ) : (
              <>
                <div id="report-content">
                  {selectedTab === "Balance Sheet" ? (
                    <BalanceSheetReport
                      reportType={resolveEffectiveReportType(selectedTab, reportType, reportPeriod)}
                      isMonthly={reportPeriod === "Month"}
                      data={currentReport.summary}
                      detailedData={filteredDetailedData}
                      startDate={appliedStartDate}
                      endDate={appliedEndDate}
                      accountingMethod={appliedAccountingMethod}
                      sourceMode={selectedSourceMode}
                      clientName={clientName}
                      entityName={company?.name || clientName}
                      createdOn={createdOn}
                      isPreview={true}
                      selectedMonths={isManualReportMode ? filteredReportMonthNums : (appliedManualFilters?.fiscalMonth || [])}
                    />
                  ) : selectedTab === "Profit & Loss" ? (
                    <ProfitAndLossReport
                      reportType={resolveEffectiveReportType(selectedTab, reportType, reportPeriod)}
                      isMonthly={reportPeriod === "Month"}
                      data={currentReport.summary}
                      detailedData={filteredDetailedData}
                      startDate={appliedStartDate}
                      endDate={appliedEndDate}
                      accountingMethod={appliedAccountingMethod}
                      sourceMode={selectedSourceMode}
                      clientName={clientName}
                      entityName={company?.name || clientName}
                      createdOn={createdOn}
                      isPreview={true}
                      selectedMonths={isManualReportMode ? filteredReportMonthNums : (appliedManualFilters?.fiscalMonth || [])}
                    />
                  ) : (
                    <CashflowReport
                      reportType={resolveEffectiveReportType(selectedTab, reportType, reportPeriod)}
                      isMonthly={reportPeriod === "Month"}
                      data={currentReport.summary}
                      detailedData={filteredDetailedData}
                      startDate={appliedStartDate}
                      endDate={appliedEndDate}
                      accountingMethod={appliedAccountingMethod}
                      sourceMode={selectedSourceMode}
                      clientName={clientName}
                      entityName={company?.name || clientName}
                      createdOn={createdOn}
                      isPreview={true}
                      selectedMonths={isManualReportMode ? filteredReportMonthNums : (appliedManualFilters?.fiscalMonth || [])}
                    />
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div >

    </div >
  );
}
