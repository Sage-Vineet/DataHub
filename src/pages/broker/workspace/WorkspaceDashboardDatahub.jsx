import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useParams } from "react-router-dom";
import Link from "../../../components/compat/NextLink";
import Header from "../../../components/Header";
import QBDisconnectedBanner from "../../../components/common/QBDisconnectedBanner";
import { useAuth } from "../../../context/AuthContext";
import { cn } from "../../../lib/utils";
import {
  FileText,
  TrendingUp,
  PieChart,
  Search,
  ChevronDown,
  CheckCircle2,
  Clock,
  AlertCircle,
  BarChart3,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  CircleDollarSign,
  CreditCard,
  Building2,
  Wallet,
  Scale,
  PiggyBank,
  ArrowDownToLine,
  Package,
  ArrowUpToLine,
  Landmark,
  Settings2,
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "../../../components/charts/RechartsCompat";
import {
  fetchDashboardKPIs,
  fetchFinancialTrends,
} from "../../../services/reportService";
import { fetchInvoices } from "../../../services/invoiceService";
import { getProfitAndLoss } from "../../../services/profitAndLossService";
import { refreshQuickbooksToken } from "../../../services/authService";
import { getStoredToken } from "../../../lib/api";
import { exportToCSV } from "../../../lib/exportCSV";

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL || "http://localhost:4000";
const DASHBOARD_STATE_PAGE_KEY = "datahub-dashboard";
const DASHBOARD_STATE_ENDPOINT = `${API_BASE_URL}/workspace-page-state/${DASHBOARD_STATE_PAGE_KEY}`;
const DASHBOARD_STORAGE_PREFIX = "workspace-datahub-dashboard";

const KPI_ICON_BY_LABEL = {
  "Total Revenue": CircleDollarSign,
  "Total Expenses": CreditCard,
  "Net Profit": TrendingUp,
  "Net Operating Income": TrendingUp,
  "Gross Profit": CircleDollarSign,
  "Total Assets": Building2,
  "Total Current Assets": Building2,
  "Total Fixed Assets": Building2,
  "Total Liabilities": Wallet,
  "Total Current Liabilities": Wallet,
  "Total Long-Term Liabilities": Landmark,
  "Total Equity": Scale,
  "Working Capital": RefreshCw,
  "Cash & Bank Balance": PiggyBank,
  "Checking Account": PiggyBank,
  "Savings Account": PiggyBank,
  "Undeposited Funds": PiggyBank,
  "Accounts Receivable": ArrowDownToLine,
  "Account Receivable": ArrowDownToLine,
  "Aged Receivables (Total)": ArrowDownToLine,
  "Aged Receivables (1-30 days)": ArrowDownToLine,
  "Aged Receivables (31-60 days)": ArrowDownToLine,
  "Aged Receivables (61-90 days)": ArrowDownToLine,
  "Inventory Value": Package,
  "Accounts Payable": ArrowUpToLine,
  "Account Payable": ArrowUpToLine,
  "Aged Payables (Total)": ArrowUpToLine,
  "Aged Payables (1-30 days)": ArrowUpToLine,
  "Aged Payables (31-60 days)": ArrowUpToLine,
  "Credit Card Balance": CreditCard,
  "Other Current Liabilities": Wallet,
  "Current Ratio": Scale,
  "Cash Ratio": Scale,
  "Long-Term Debt": Landmark,
};

const AGGREGATION_TYPES = [
  { label: "Monthly", value: "monthly", icon: CalendarDays },
  { label: "Quarterly", value: "quarterly", icon: BarChart3 },
];

const MONTHS = [
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

const generateYearOptions = () => {
  const currentYear = new Date().getFullYear();
  const years = [];
  for (let i = currentYear - 5; i <= currentYear + 1; i += 1) {
    years.push(i);
  }
  return years;
};

// ── Session-storage helpers ────────────────────────────────────────────────

function getDashboardStorageKey(clientId, userId) {
  return `${DASHBOARD_STORAGE_PREFIX}:${clientId || "default"}:${userId || "default"}`;
}

function getStoredDashboardState(clientId, userId) {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(
      getDashboardStorageKey(clientId, userId),
    );
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function saveStoredDashboardState(clientId, userId, state) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      getDashboardStorageKey(clientId, userId),
      JSON.stringify(state),
    );
  } catch {
    // Ignore quota / serialisation errors
  }
}

// ── Icon strip / hydrate (icons can't survive JSON serialisation) ──────────

function stripDashboardStatsIcons(stats = []) {
  return stats.map((stat) => {
    const nextStat = { ...stat };
    delete nextStat.icon;
    return nextStat;
  });
}

function hydrateDashboardStats(stats = []) {
  return stats.map((stat) => ({
    ...stat,
    icon: KPI_ICON_BY_LABEL[stat.label] || BarChart3,
  }));
}

// ── Date utilities ─────────────────────────────────────────────────────────

function formatDateForInput(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function syncFilterStateFromRange(start, end, setYear, setMonth) {
  if (!start || !end) return;
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime()))
    return;
  setYear(startDate.getFullYear());
  if (
    startDate.getFullYear() === endDate.getFullYear() &&
    startDate.getMonth() === endDate.getMonth()
  ) {
    setMonth(String(startDate.getMonth() + 1));
    return;
  }
  setMonth("");
}

function deriveFilterStateFromRange(start, end, fallbackYear) {
  if (!start || !end) return { year: fallbackYear, month: "" };
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return { year: fallbackYear, month: "" };
  }
  return {
    year: startDate.getFullYear(),
    month:
      startDate.getFullYear() === endDate.getFullYear() &&
      startDate.getMonth() === endDate.getMonth()
        ? String(startDate.getMonth() + 1)
        : "",
  };
}

// ── Component ──────────────────────────────────────────────────────────────

export default function WorkspaceDashboardDatahub() {
  const { clientId } = useParams();
  const { user } = useAuth();

  const [isLoading, setIsLoading] = useState(true);
  const [isClient, setIsClient] = useState(false);
  const [dynamicStats, setDynamicStats] = useState([]);
  const [selectedKpiLabels, setSelectedKpiLabels] = useState([]);
  const [isKpiSelectorOpen, setIsKpiSelectorOpen] = useState(false);
  const [invoicesData, setInvoicesData] = useState([]);
  const [chartDataState, setChartDataState] = useState([]);
  const [isChartLoading, setIsChartLoading] = useState(false);
  const [monthlyInsights, setMonthlyInsights] = useState([]);
  const [searchTerm, setSearchTerm] = useState("");

  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());
  const [selectedMonth, setSelectedMonth] = useState("");
  const [filterType, setFilterType] = useState("yearMonth");

  const [chartStartDate, setChartStartDate] = useState("");
  const [chartEndDate, setChartEndDate] = useState("");
  const [chartSelectedYear, setChartSelectedYear] = useState(
    new Date().getFullYear(),
  );
  const [chartSelectedMonth, setChartSelectedMonth] = useState("");
  const [aggregationType, setAggregationType] = useState("monthly");
  const [isSyncing, setIsSyncing] = useState(false);

  // Tracks the last chart request so we never fire the same one twice
  const lastChartRequestKeyRef = useRef("");
  const kpiSelectorRef = useRef(null);
  // True once the mount effect has run — prevents the auto-save effect from
  // firing before state is properly initialised
  const hasRestoredRef = useRef(false);

  const visibleDynamicStats = useMemo(() => {
    if (!selectedKpiLabels.length) return dynamicStats;
    return dynamicStats.filter((stat) =>
      selectedKpiLabels.includes(stat.label),
    );
  }, [dynamicStats, selectedKpiLabels]);

  // ── Date-range calculator ──────────────────────────────────────────────

  const calculateDateRangeFromYearMonth = useCallback((year, month) => {
    if (month) {
      const monthNum = parseInt(month, 10);
      const start = new Date(year, monthNum - 1, 1);
      const end = new Date(year, monthNum, 0);
      return {
        startDate: formatDateForInput(start),
        endDate: formatDateForInput(end),
      };
    }
    const start = new Date(year, 0, 1);
    const end = new Date(year, 11, 31);
    return {
      startDate: formatDateForInput(start),
      endDate: formatDateForInput(end),
    };
  }, []);

  const getClientHeaders = useCallback(
    (includeJson = false) => {
      const token = getStoredToken();

      return {
        ...(token
          ? {
              Authorization: `Bearer ${token}`,
              "X-Access-Token": token,
              "X-Auth-Token": token,
              "X-Token": token,
            }
          : {}),
        ...(clientId ? { "X-Client-Id": clientId } : {}),
        ...(includeJson ? { "Content-Type": "application/json" } : {}),
      };
    },
    [clientId],
  );

  // ── Snapshot builders ──────────────────────────────────────────────────

  // Everything we need to fully restore the page — stored in sessionStorage
  const buildSessionSnapshot = useCallback(
    (overrides = {}) => ({
      startDate: overrides.startDate ?? startDate,
      endDate: overrides.endDate ?? endDate,
      selectedYear: overrides.selectedYear ?? selectedYear,
      selectedMonth: overrides.selectedMonth ?? selectedMonth,
      filterType: overrides.filterType ?? filterType,
      chartStartDate: overrides.chartStartDate ?? chartStartDate,
      chartEndDate: overrides.chartEndDate ?? chartEndDate,
      chartSelectedYear: overrides.chartSelectedYear ?? chartSelectedYear,
      chartSelectedMonth: overrides.chartSelectedMonth ?? chartSelectedMonth,
      aggregationType: overrides.aggregationType ?? aggregationType,
      searchTerm: overrides.searchTerm ?? searchTerm,
      selectedKpiLabels: overrides.selectedKpiLabels ?? selectedKpiLabels,
      dynamicStats: stripDashboardStatsIcons(
        overrides.dynamicStats ?? dynamicStats,
      ),
      invoicesData: overrides.invoicesData ?? invoicesData,
      chartDataState: overrides.chartDataState ?? chartDataState,
      monthlyInsights: overrides.monthlyInsights ?? monthlyInsights,
    }),
    [
      aggregationType,
      chartDataState,
      chartEndDate,
      chartSelectedMonth,
      chartSelectedYear,
      chartStartDate,
      dynamicStats,
      endDate,
      filterType,
      invoicesData,
      monthlyInsights,
      searchTerm,
      selectedKpiLabels,
      selectedMonth,
      selectedYear,
      startDate,
    ],
  );

  // Subset stored on the server (no UI-only fields like selectedYear/Month)
  const buildRemoteSnapshot = useCallback(
    (overrides = {}) => ({
      startDate: overrides.startDate ?? startDate,
      endDate: overrides.endDate ?? endDate,
      filterType: overrides.filterType ?? filterType,
      chartStartDate: overrides.chartStartDate ?? chartStartDate,
      chartEndDate: overrides.chartEndDate ?? chartEndDate,
      aggregationType: overrides.aggregationType ?? aggregationType,
      selectedKpiLabels: overrides.selectedKpiLabels ?? selectedKpiLabels,
      dynamicStats: stripDashboardStatsIcons(
        overrides.dynamicStats ?? dynamicStats,
      ),
      invoicesData: overrides.invoicesData ?? invoicesData,
      chartDataState: overrides.chartDataState ?? chartDataState,
      monthlyInsights: overrides.monthlyInsights ?? monthlyInsights,
    }),
    [
      aggregationType,
      chartDataState,
      chartEndDate,
      chartStartDate,
      dynamicStats,
      endDate,
      filterType,
      invoicesData,
      monthlyInsights,
      selectedKpiLabels,
      startDate,
    ],
  );

  // ── Snapshot restore ───────────────────────────────────────────────────

  /**
   * Applies a saved snapshot to all state setters.
   * Returns true if the snapshot had usable data (non-empty stats/chart).
   */
  const applyDashboardSnapshot = useCallback((snapshot) => {
    if (!snapshot || typeof snapshot !== "object") return false;

    // Only restore if there is actual data — otherwise fall through to fresh fetch
    const hasData =
      Array.isArray(snapshot.dynamicStats) && snapshot.dynamicStats.length > 0;
    const hydratedStats = hydrateDashboardStats(snapshot.dynamicStats || []);
    const restoredKpiLabels =
      Array.isArray(snapshot.selectedKpiLabels) &&
      snapshot.selectedKpiLabels.length > 0
        ? snapshot.selectedKpiLabels
        : hydratedStats.map((stat) => stat.label);

    const nowYear = new Date().getFullYear();
    const globalFilter = deriveFilterStateFromRange(
      snapshot.startDate,
      snapshot.endDate,
      snapshot.selectedYear || nowYear,
    );
    const chartFilter = deriveFilterStateFromRange(
      snapshot.chartStartDate,
      snapshot.chartEndDate,
      snapshot.chartSelectedYear || nowYear,
    );

    setStartDate(snapshot.startDate || "");
    setEndDate(snapshot.endDate || "");
    setSelectedYear(snapshot.selectedYear || globalFilter.year);
    setSelectedMonth(
      snapshot.selectedMonth !== undefined
        ? snapshot.selectedMonth
        : globalFilter.month,
    );
    setFilterType(snapshot.filterType || "yearMonth");
    setChartStartDate(snapshot.chartStartDate || "");
    setChartEndDate(snapshot.chartEndDate || "");
    setChartSelectedYear(snapshot.chartSelectedYear || chartFilter.year);
    setChartSelectedMonth(
      snapshot.chartSelectedMonth !== undefined
        ? snapshot.chartSelectedMonth
        : chartFilter.month,
    );
    setAggregationType(snapshot.aggregationType || "monthly");
    setDynamicStats(hydratedStats);
    setSelectedKpiLabels(restoredKpiLabels);
    setInvoicesData(snapshot.invoicesData || []);
    setChartDataState(snapshot.chartDataState || []);
    setMonthlyInsights(snapshot.monthlyInsights || []);
    setSearchTerm(snapshot.searchTerm || "");

    // Mark the chart request key so loadChartData won't re-fire for same params
    lastChartRequestKeyRef.current =
      snapshot.chartStartDate && snapshot.chartEndDate
        ? `${snapshot.chartStartDate}|${snapshot.chartEndDate}|${snapshot.aggregationType || "monthly"}`
        : "";

    return hasData;
  }, []);

  // ── Remote snapshot persistence ────────────────────────────────────────

  const fetchRemoteDashboardSnapshot = useCallback(async () => {
    const token = getStoredToken();
    if (!clientId || !user?.id || !token) return null;
    try {
      const response = await fetch(
        `${DASHBOARD_STATE_ENDPOINT}?clientId=${encodeURIComponent(clientId)}`,
        { cache: "no-store", headers: getClientHeaders() },
      );
      if (response.status === 401) return null;
      const payload = await response.json().catch(() => null);
      if (!response.ok)
        throw new Error(payload?.error || `HTTP ${response.status}`);
      return payload?.state || null;
    } catch (error) {
      console.error("Failed to load saved dashboard state:", error);
      return null;
    }
  }, [clientId, getClientHeaders, user?.id]);

  const replaceRemoteDashboardSnapshot = useCallback(
    async (overrides = {}) => {
      const token = getStoredToken();
      if (!clientId || !user?.id || !token) return;
      try {
        const response = await fetch(
          `${DASHBOARD_STATE_ENDPOINT}?clientId=${encodeURIComponent(clientId)}`,
          {
            method: "PUT",
            cache: "no-store",
            headers: getClientHeaders(true),
            body: JSON.stringify({ state: buildRemoteSnapshot(overrides) }),
          },
        );
        if (response.status === 401) return;
      } catch (error) {
        console.error("Failed to save dashboard state:", error);
      }
    },
    [buildRemoteSnapshot, clientId, getClientHeaders, user?.id],
  );

  // ── Data fetchers ──────────────────────────────────────────────────────

  const loadChartData = useCallback(async (start, end, aggType = "monthly") => {
    const requestKey = `${start}|${end}|${aggType}`;
    if (lastChartRequestKeyRef.current === requestKey) return;
    lastChartRequestKeyRef.current = requestKey;

    setIsChartLoading(true);
    try {
      const data = await fetchFinancialTrends(start, end, aggType);
      setChartDataState(data);
    } catch (err) {
      console.error("Failed to load chart data:", err);
      setChartDataState([]);
      lastChartRequestKeyRef.current = "";
    } finally {
      setIsChartLoading(false);
    }
  }, []);

  const loadKpiData = useCallback(async (start, end) => {
    setIsLoading(true);
    try {
      const [kpiData, invsData] = await Promise.all([
        fetchDashboardKPIs(start, end),
        fetchInvoices(),
      ]);

      const invs = Array.isArray(invsData?.QueryResponse?.Invoice)
        ? invsData.QueryResponse.Invoice
        : Array.isArray(invsData?.data?.QueryResponse?.Invoice)
          ? invsData.data.QueryResponse.Invoice
          : Array.isArray(invsData)
            ? invsData
            : [];

      setInvoicesData(invs);
      setDynamicStats(kpiData);
      setSelectedKpiLabels((current) =>
        current.length ? current : kpiData.map((kpi) => kpi.label),
      );

      const totalRevenue =
        kpiData.find((k) => k.label === "Total Revenue")?.rawValue || 0;
      const totalExpenses =
        kpiData.find((k) => k.label === "Total Expenses")?.rawValue || 0;
      const accountsPayable =
        kpiData.find((k) => k.label === "Accounts Payable")?.rawValue || 0;
      const cashBank =
        kpiData.find((k) => k.label === "Cash & Bank Balance")?.rawValue || 0;

      const margin =
        totalRevenue > 0
          ? ((totalRevenue - totalExpenses) / totalRevenue) * 100
          : 0;
      const formatCurrency = (num) =>
        "$" + num.toLocaleString("en-US", { maximumFractionDigits: 0 });

      setMonthlyInsights([
        {
          label: "Operating Margin",
          value: `${margin.toFixed(1)}%`,
          color: "#8bc53d",
          desc:
            margin > 20
              ? "Healthy profit range"
              : margin > 10
                ? "Moderate margin"
                : "Monitor expenses",
        },
        {
          label: "Accounts Payable",
          value: formatCurrency(accountsPayable),
          color: "#F68C1F",
          desc: "Current liabilities to vendors",
        },
        {
          label: "Cash on Hand",
          value: formatCurrency(cashBank),
          color: "#00648F",
          desc: "Liquid bank balance available",
        },
      ]);
    } catch (err) {
      console.error("Failed to load dashboard KPI data:", err);
      const reportFallback = await getProfitAndLoss().catch(() => null);
      if (reportFallback) {
        setMonthlyInsights((current) =>
          current.length
            ? current
            : [
                {
                  label: "Profit & Loss",
                  value: "Connected",
                  color: "#8bc53d",
                  desc: "Profit and loss report is available",
                },
              ],
        );
      }
    } finally {
      setIsLoading(false);
    }
  }, []);

  // ── Manual sync (explicit user action — always re-fetches) ─────────────

  const handleSync = useCallback(async () => {
    setIsSyncing(true);
    try {
      await refreshQuickbooksToken();
      await loadKpiData(startDate, endDate);
      lastChartRequestKeyRef.current = "";
      await loadChartData(chartStartDate, chartEndDate, aggregationType);
    } catch (err) {
      console.error("Sync failed:", err);
    } finally {
      setIsSyncing(false);
    }
  }, [
    aggregationType,
    chartEndDate,
    chartStartDate,
    endDate,
    loadChartData,
    loadKpiData,
    startDate,
  ]);

  // ── Mount effect: restore → fallback to fresh fetch ───────────────────
  //
  // Priority:
  //   1. sessionStorage  (same tab, fast)
  //   2. remote server   (cross-tab / cross-session, requires clientId)
  //   3. fresh API fetch (first ever visit or cache miss)
  //
  // After restoration, NO further API calls are made until the user
  // explicitly presses Apply / arrows / Sync.

  useEffect(() => {
    setIsClient(true);

    const currentYear = new Date().getFullYear();
    const currentMonth = (new Date().getMonth() + 1).toString();

    const bootstrap = async () => {
      // 1. Try sessionStorage first (instant, no network)
      const sessionSnap = getStoredDashboardState(clientId, user?.id);
      if (sessionSnap) {
        const restored = applyDashboardSnapshot(sessionSnap);
        if (restored) {
          hasRestoredRef.current = true;
          setIsLoading(false);
          setIsChartLoading(false);
          return; // ← skip all API calls
        }
      }

      // 2. Try remote snapshot (cross-session persistence)
      const remoteSnap = await fetchRemoteDashboardSnapshot();
      if (remoteSnap) {
        const restored = applyDashboardSnapshot(remoteSnap);
        if (restored) {
          // Mirror remote snapshot into sessionStorage so subsequent navigations
          // are instant and don't need the network round-trip
          saveStoredDashboardState(clientId, user?.id, {
            ...remoteSnap,
            selectedYear: remoteSnap.selectedYear ?? currentYear,
            selectedMonth: remoteSnap.selectedMonth ?? "",
            chartSelectedYear: remoteSnap.chartSelectedYear ?? currentYear,
            chartSelectedMonth: remoteSnap.chartSelectedMonth ?? "",
            searchTerm: remoteSnap.searchTerm ?? "",
            selectedKpiLabels: remoteSnap.selectedKpiLabels ?? [],
          });
          hasRestoredRef.current = true;
          setIsLoading(false);
          setIsChartLoading(false);
          return; // ← skip all API calls
        }
      }

      // 3. No cached data found — do a fresh fetch
      setSelectedYear(currentYear);
      setSelectedMonth(currentMonth);
      const { startDate: kpiStart, endDate: kpiEnd } =
        calculateDateRangeFromYearMonth(currentYear, currentMonth);
      setStartDate(kpiStart);
      setEndDate(kpiEnd);

      setChartSelectedYear(currentYear);
      setChartSelectedMonth("");
      const { startDate: chartStart, endDate: chartEnd } =
        calculateDateRangeFromYearMonth(currentYear);
      setChartStartDate(chartStart);
      setChartEndDate(chartEnd);

      await loadKpiData(kpiStart, kpiEnd);
      await loadChartData(chartStart, chartEnd, "monthly");

      hasRestoredRef.current = true;
    };

    bootstrap();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, user?.id]); // Re-run only when the client or signed-in user changes

  // ── Auto-save: persist state to sessionStorage after every meaningful change
  //
  // Only runs after the mount restoration is complete (hasRestoredRef = true)
  // so we never overwrite a valid cache with an empty initial state.

  useEffect(() => {
    if (!hasRestoredRef.current) return;

    const snapshot = buildSessionSnapshot();
    saveStoredDashboardState(clientId, user?.id, snapshot);
  }, [
    // Only the data fields that represent actual page state worth persisting
    dynamicStats,
    selectedKpiLabels,
    invoicesData,
    chartDataState,
    monthlyInsights,
    startDate,
    endDate,
    selectedYear,
    selectedMonth,
    filterType,
    chartStartDate,
    chartEndDate,
    chartSelectedYear,
    chartSelectedMonth,
    aggregationType,
    searchTerm,
    clientId,
    user?.id,
    buildSessionSnapshot,
  ]);

  useEffect(() => {
    if (!dynamicStats.length) return;

    const availableLabels = dynamicStats.map((stat) => stat.label);
    setSelectedKpiLabels((current) => {
      if (!current.length) return availableLabels;
      const matching = current.filter((label) =>
        availableLabels.includes(label),
      );
      return matching.length ? matching : availableLabels;
    });
  }, [dynamicStats]);

  useEffect(() => {
    if (!hasRestoredRef.current) return;

    const timeoutId = window.setTimeout(() => {
      void replaceRemoteDashboardSnapshot();
    }, 400);

    return () => window.clearTimeout(timeoutId);
  }, [
    dynamicStats,
    selectedKpiLabels,
    invoicesData,
    chartDataState,
    monthlyInsights,
    startDate,
    endDate,
    filterType,
    chartStartDate,
    chartEndDate,
    aggregationType,
    replaceRemoteDashboardSnapshot,
  ]);

  useEffect(() => {
    if (!isKpiSelectorOpen) return undefined;

    const handlePointerDown = (event) => {
      if (!kpiSelectorRef.current?.contains(event.target)) {
        setIsKpiSelectorOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
    };
  }, [isKpiSelectorOpen]);

  // ── Filter / date-change handlers ──────────────────────────────────────

  const applyGlobalDateRange = (newStart, newEnd, source) => {
    if (newStart && newEnd && newStart > newEnd) return;
    setStartDate(newStart);
    setEndDate(newEnd);
    setFilterType(source);
    loadKpiData(newStart, newEnd);
  };

  const handleYearMonthChange = () => {
    const { startDate: newStart, endDate: newEnd } =
      calculateDateRangeFromYearMonth(selectedYear, selectedMonth);
    applyGlobalDateRange(newStart, newEnd, "yearMonth");
  };

  const handleCustomDateChange = () => {
    if (startDate && endDate) {
      syncFilterStateFromRange(
        startDate,
        endDate,
        setSelectedYear,
        setSelectedMonth,
      );
      applyGlobalDateRange(startDate, endDate, "custom");
    }
  };

  const handlePreviousYear = () => {
    const newYear = selectedYear - 1;
    setSelectedYear(newYear);
    if (filterType === "yearMonth") {
      const { startDate: newStart, endDate: newEnd } =
        calculateDateRangeFromYearMonth(newYear, selectedMonth || undefined);
      applyGlobalDateRange(newStart, newEnd, "yearMonth");
    }
  };

  const handleNextYear = () => {
    const newYear = selectedYear + 1;
    setSelectedYear(newYear);
    if (filterType === "yearMonth") {
      const { startDate: newStart, endDate: newEnd } =
        calculateDateRangeFromYearMonth(newYear, selectedMonth || undefined);
      applyGlobalDateRange(newStart, newEnd, "yearMonth");
    }
  };

  const handlePreviousMonth = () => {
    if (selectedMonth) {
      let newMonth = parseInt(selectedMonth, 10) - 1;
      let newYear = selectedYear;
      if (newMonth < 1) {
        newMonth = 12;
        newYear = selectedYear - 1;
      }
      setSelectedYear(newYear);
      setSelectedMonth(newMonth.toString());
      const { startDate: newStart, endDate: newEnd } =
        calculateDateRangeFromYearMonth(newYear, newMonth.toString());
      applyGlobalDateRange(newStart, newEnd, "yearMonth");
    }
  };

  const handleNextMonth = () => {
    if (selectedMonth) {
      let newMonth = parseInt(selectedMonth, 10) + 1;
      let newYear = selectedYear;
      if (newMonth > 12) {
        newMonth = 1;
        newYear = selectedYear + 1;
      }
      setSelectedYear(newYear);
      setSelectedMonth(newMonth.toString());
      const { startDate: newStart, endDate: newEnd } =
        calculateDateRangeFromYearMonth(newYear, newMonth.toString());
      applyGlobalDateRange(newStart, newEnd, "yearMonth");
    }
  };

  const handleChartPreviousYear = () => {
    const newYear = chartSelectedYear - 1;
    setChartSelectedYear(newYear);
    const { startDate: newStart, endDate: newEnd } =
      calculateDateRangeFromYearMonth(newYear, chartSelectedMonth || undefined);
    setChartStartDate(newStart);
    setChartEndDate(newEnd);
    lastChartRequestKeyRef.current = "";
    loadChartData(newStart, newEnd, aggregationType);
  };

  const handleChartNextYear = () => {
    const newYear = chartSelectedYear + 1;
    setChartSelectedYear(newYear);
    const { startDate: newStart, endDate: newEnd } =
      calculateDateRangeFromYearMonth(newYear, chartSelectedMonth || undefined);
    setChartStartDate(newStart);
    setChartEndDate(newEnd);
    lastChartRequestKeyRef.current = "";
    loadChartData(newStart, newEnd, aggregationType);
  };

  const handleChartPreviousMonth = () => {
    if (chartSelectedMonth) {
      let newMonth = parseInt(chartSelectedMonth, 10) - 1;
      let newYear = chartSelectedYear;
      if (newMonth < 1) {
        newMonth = 12;
        newYear = chartSelectedYear - 1;
      }
      setChartSelectedYear(newYear);
      setChartSelectedMonth(newMonth.toString());
      const { startDate: newStart, endDate: newEnd } =
        calculateDateRangeFromYearMonth(newYear, newMonth.toString());
      setChartStartDate(newStart);
      setChartEndDate(newEnd);
      lastChartRequestKeyRef.current = "";
      loadChartData(newStart, newEnd, aggregationType);
    }
  };

  const handleChartNextMonth = () => {
    if (chartSelectedMonth) {
      let newMonth = parseInt(chartSelectedMonth, 10) + 1;
      let newYear = chartSelectedYear;
      if (newMonth > 12) {
        newMonth = 1;
        newYear = chartSelectedYear + 1;
      }
      setChartSelectedYear(newYear);
      setChartSelectedMonth(newMonth.toString());
      const { startDate: newStart, endDate: newEnd } =
        calculateDateRangeFromYearMonth(newYear, newMonth.toString());
      setChartStartDate(newStart);
      setChartEndDate(newEnd);
      lastChartRequestKeyRef.current = "";
      loadChartData(newStart, newEnd, aggregationType);
    }
  };

  const handleChartApply = () => {
    const { startDate: newStart, endDate: newEnd } =
      calculateDateRangeFromYearMonth(
        chartSelectedYear,
        chartSelectedMonth || undefined,
      );
    setChartStartDate(newStart);
    setChartEndDate(newEnd);
    lastChartRequestKeyRef.current = "";
    loadChartData(newStart, newEnd, aggregationType);
  };

  const handleAggregationChange = (type) => {
    setAggregationType(type);
    const { startDate: newStart, endDate: newEnd } =
      calculateDateRangeFromYearMonth(
        chartSelectedYear,
        chartSelectedMonth || undefined,
      );
    setChartStartDate(newStart);
    setChartEndDate(newEnd);
    lastChartRequestKeyRef.current = "";
    loadChartData(newStart, newEnd, type);
  };

  const handleExportTrendsCSV = () => {
    const headers =
      aggregationType === "monthly"
        ? ["Month", "Revenue", "Expenses"]
        : ["Quarter", "Revenue", "Expenses"];
    exportToCSV(
      chartDataState,
      headers,
      `financial_trends_${aggregationType}`,
      (item) => [
        item.name,
        Number(item.revenue || 0).toFixed(2),
        Number(item.expenses || 0).toFixed(2),
      ],
    );
  };

  // ── Render ─────────────────────────────────────────────────────────────

  const handleToggleKpiCard = (label) => {
    setSelectedKpiLabels((current) => {
      if (current.includes(label)) {
        return current.length > 1
          ? current.filter((item) => item !== label)
          : current;
      }

      const orderedLabels = dynamicStats.map((stat) => stat.label);
      return orderedLabels.filter((item) => [...current, label].includes(item));
    });
  };

  const handleShowAllKpis = () => {
    setSelectedKpiLabels(dynamicStats.map((stat) => stat.label));
  };

  return (
    <>
      <Header title="Dashboard" />
      <div className="px-6 pt-6">
        <QBDisconnectedBanner pageName="DataHub Dashboard" />
      </div>
      <div className="flex-1 p-6 space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div className="flex items-center gap-3">
            <h1 className="text-[24px] font-bold text-text-primary">
              Dashboard
            </h1>
            <button
              onClick={handleSync}
              disabled={isSyncing}
              className="btn-secondary py-1.5 px-3"
              title="Sync data"
            >
              <RefreshCw
                size={16}
                className={isSyncing ? "animate-spin" : ""}
              />
            </button>
          </div>

          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex items-center gap-2 bg-bg-page rounded-lg border border-border p-2">
              <button
                onClick={handlePreviousYear}
                className="p-1.5 hover:bg-bg-page/80 rounded-md transition-colors"
                title="Previous Year"
              >
                <ChevronLeft size={16} className="text-text-secondary" />
              </button>
              <select
                value={selectedYear}
                onChange={(e) => setSelectedYear(parseInt(e.target.value, 10))}
                className="px-3 py-1.5 text-[13px] font-medium bg-transparent border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary"
              >
                {generateYearOptions().map((year) => (
                  <option key={year} value={year}>
                    {year}
                  </option>
                ))}
              </select>
              <button
                onClick={handleNextYear}
                className="p-1.5 hover:bg-bg-page/80 rounded-md transition-colors"
                title="Next Year"
              >
                <ChevronRight size={16} className="text-text-secondary" />
              </button>
              <div className="w-px h-6 bg-border mx-1" />
              <button
                onClick={handlePreviousMonth}
                className="p-1.5 hover:bg-bg-page/80 rounded-md transition-colors"
                title="Previous Month"
                disabled={!selectedMonth}
              >
                <ChevronLeft
                  size={16}
                  className={cn(!selectedMonth && "opacity-30")}
                />
              </button>
              <select
                value={selectedMonth}
                onChange={(e) => setSelectedMonth(e.target.value)}
                className="px-3 py-1.5 text-[13px] font-medium bg-transparent border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary"
              >
                <option value="">Full Year</option>
                {MONTHS.map((month) => (
                  <option key={month.value} value={month.value}>
                    {month.label}
                  </option>
                ))}
              </select>
              <button
                onClick={handleNextMonth}
                className="p-1.5 hover:bg-bg-page/80 rounded-md transition-colors"
                title="Next Month"
                disabled={!selectedMonth}
              >
                <ChevronRight
                  size={16}
                  className={cn(!selectedMonth && "opacity-30")}
                />
              </button>
              <button
                onClick={handleYearMonthChange}
                className="ml-2 px-3 py-1.5 text-[13px] font-medium bg-primary text-white rounded-md hover:bg-primary/90 transition-colors"
              >
                Apply
              </button>
            </div>

            <div className="text-text-muted text-[13px]">or</div>

            <div className="flex items-center gap-2">
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="input-base py-1.5 text-[13px]"
              />
              <span className="text-text-muted">to</span>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="input-base py-1.5 text-[13px]"
              />
              <button
                onClick={handleCustomDateChange}
                className="btn-secondary py-1.5 px-3 text-[13px]"
              >
                Apply
              </button>
            </div>

            <div className="relative" ref={kpiSelectorRef}>
              <button
                type="button"
                onClick={() => setIsKpiSelectorOpen((current) => !current)}
                className="inline-flex items-center gap-2 rounded-lg border border-border bg-white px-3 py-2 text-[13px] font-medium text-text-primary transition-colors hover:bg-bg-page"
              >
                <Settings2 size={15} className="text-text-secondary" />
                Customize KPI Cards
              </button>

              {isKpiSelectorOpen && (
                <div className="absolute right-0 top-full z-20 mt-2 w-[320px] rounded-xl border border-border bg-white p-4 shadow-[0_14px_40px_rgba(15,23,42,0.12)]">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="text-[14px] font-semibold text-text-primary">
                        Show KPI Cards
                      </h3>
                      <p className="mt-1 text-[12px] text-text-muted">
                        Pick which KPI cards appear on your dashboard.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={handleShowAllKpis}
                      className="text-[12px] font-medium text-primary transition-colors hover:text-primary/80"
                    >
                      Select all
                    </button>
                  </div>

                  <div className="mt-4 max-h-[280px] space-y-2 overflow-y-auto pr-1">
                    {dynamicStats.map((stat) => {
                      const isChecked = selectedKpiLabels.includes(stat.label);
                      return (
                        <label
                          key={stat.label}
                          className="flex cursor-pointer items-start gap-3 rounded-lg border border-border px-3 py-2 transition-colors hover:bg-bg-page"
                        >
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => handleToggleKpiCard(stat.label)}
                            className="mt-0.5 h-4 w-4 rounded border-border text-primary focus:ring-primary"
                          />
                          <span className="min-w-0">
                            <span className="block text-[13px] font-medium text-text-primary">
                              {stat.label}
                            </span>
                            <span className="block text-[12px] font-semibold text-primary">
                              {stat.value}
                            </span>
                            <span className="block text-[12px] text-text-muted">
                              {stat.desc}
                            </span>
                          </span>
                        </label>
                      );
                    })}
                  </div>

                  <p className="mt-3 text-[12px] text-text-muted">
                    These choices are saved for {user?.name || "your account"}.
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ── KPI cards ── */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {visibleDynamicStats.map((stat, i) => {
            const Icon = stat.icon;
            return (
              <div
                key={i}
                className={cn(
                  "card-base card-p transition-opacity duration-300",
                  isLoading ? "opacity-0" : "opacity-100",
                )}
                style={{ transitionDelay: `${i * 50}ms` }}
              >
                <div className="flex items-center justify-between mb-3">
                  <span className="text-[14px] font-medium text-text-secondary">
                    {stat.label}
                  </span>
                  <Icon
                    size={18}
                    style={{ color: stat.color }}
                    strokeWidth={2}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <p className="text-[24px] font-bold text-text-primary leading-none tracking-tight">
                    {isLoading ? (
                      <span className="skeleton inline-block h-8 w-24 rounded-md" />
                    ) : (
                      stat.value
                    )}
                  </p>
                  <p className="text-[12px] text-text-muted mt-1">
                    {stat.desc}
                  </p>
                </div>
              </div>
            );
          })}
        </div>

        {!visibleDynamicStats.length && !isLoading && (
          <div className="rounded-xl border border-dashed border-border bg-white px-4 py-5 text-[13px] text-text-muted">
            No KPI cards are selected right now. Use `Customize KPI Cards` to
            choose what this user sees on the dashboard.
          </div>
        )}

        <div className="grid grid-cols-12 gap-4">
          {/* ── Financial Trends chart ── */}
          <div className="col-span-12 lg:col-span-8 card-base card-p flex flex-col">
            <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
              <h3 className="text-[18px] font-semibold text-text-primary">
                Financial Trends
              </h3>

              <div className="flex items-center gap-2 flex-wrap">
                <div className="flex items-center gap-1.5 bg-bg-page rounded-lg border border-border p-1.5">
                  <button
                    onClick={handleChartPreviousYear}
                    className="p-1 hover:bg-bg-page/80 rounded-md transition-colors"
                    title="Previous Year"
                  >
                    <ChevronLeft size={14} className="text-text-secondary" />
                  </button>
                  <select
                    value={chartSelectedYear}
                    onChange={(e) =>
                      setChartSelectedYear(parseInt(e.target.value, 10))
                    }
                    className="px-2 py-1 text-[12px] font-medium bg-transparent border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary"
                  >
                    {generateYearOptions().map((year) => (
                      <option key={year} value={year}>
                        {year}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={handleChartNextYear}
                    className="p-1 hover:bg-bg-page/80 rounded-md transition-colors"
                    title="Next Year"
                  >
                    <ChevronRight size={14} className="text-text-secondary" />
                  </button>
                  <div className="w-px h-5 bg-border mx-0.5" />
                  <button
                    onClick={handleChartPreviousMonth}
                    className="p-1 hover:bg-bg-page/80 rounded-md transition-colors"
                    title="Previous Month"
                    disabled={!chartSelectedMonth}
                  >
                    <ChevronLeft
                      size={14}
                      className={cn(
                        "text-text-secondary",
                        !chartSelectedMonth && "opacity-30",
                      )}
                    />
                  </button>
                  <select
                    value={chartSelectedMonth}
                    onChange={(e) => setChartSelectedMonth(e.target.value)}
                    className="px-2 py-1 text-[12px] font-medium bg-transparent border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary"
                  >
                    <option value="">Full Year</option>
                    {MONTHS.map((month) => (
                      <option key={month.value} value={month.value}>
                        {month.label}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={handleChartNextMonth}
                    className="p-1 hover:bg-bg-page/80 rounded-md transition-colors"
                    title="Next Month"
                    disabled={!chartSelectedMonth}
                  >
                    <ChevronRight
                      size={14}
                      className={cn(
                        "text-text-secondary",
                        !chartSelectedMonth && "opacity-30",
                      )}
                    />
                  </button>
                  <button
                    onClick={handleChartApply}
                    className="ml-1 px-2 py-1 text-[12px] font-medium bg-primary text-white rounded-md hover:bg-primary/90 transition-colors"
                  >
                    Apply
                  </button>
                </div>

                <div className="flex items-center gap-1 bg-bg-page rounded-lg border border-border p-1">
                  {AGGREGATION_TYPES.map((type) => {
                    const Icon = type.icon;
                    return (
                      <button
                        key={type.value}
                        onClick={() => handleAggregationChange(type.value)}
                        className={cn(
                          "flex items-center gap-2 px-3 py-1.5 text-[13px] font-medium rounded-md transition-colors",
                          aggregationType === type.value
                            ? "bg-primary text-white"
                            : "text-text-secondary hover:text-text-primary hover:bg-bg-page/80",
                        )}
                      >
                        <Icon size={14} />
                        {type.label}
                      </button>
                    );
                  })}
                </div>

                <button
                  onClick={handleExportTrendsCSV}
                  className="btn-secondary h-auto py-1.5 text-[13px]"
                >
                  Export CSV
                </button>
              </div>
            </div>

            <div className="h-[300px] w-full mt-auto">
              {isClient && !isChartLoading && chartDataState.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={chartDataState}
                    margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
                  >
                    <CartesianGrid
                      strokeDasharray="3 3"
                      vertical={false}
                      stroke="var(--color-border-light)"
                    />
                    <XAxis
                      dataKey="name"
                      axisLine={false}
                      tickLine={false}
                      tick={{
                        fill: "var(--color-text-muted)",
                        fontSize: 12,
                        fontWeight: 500,
                      }}
                      dy={10}
                      angle={
                        aggregationType === "monthly" &&
                        chartDataState.length > 6
                          ? -45
                          : 0
                      }
                      textAnchor={
                        aggregationType === "monthly" &&
                        chartDataState.length > 6
                          ? "end"
                          : "middle"
                      }
                      height={
                        aggregationType === "monthly" &&
                        chartDataState.length > 6
                          ? 60
                          : 30
                      }
                    />
                    <YAxis
                      axisLine={false}
                      tickLine={false}
                      tick={{
                        fill: "var(--color-text-muted)",
                        fontSize: 12,
                        fontWeight: 500,
                      }}
                      tickFormatter={(value) =>
                        `$${(value / 1000).toFixed(0)}k`
                      }
                    />
                    <Tooltip
                      cursor={{ fill: "var(--color-bg-page)", radius: 4 }}
                      contentStyle={{
                        borderRadius: "8px",
                        border: "1px solid var(--color-border)",
                        boxShadow: "var(--shadow-card)",
                        fontSize: "13px",
                        padding: "10px 14px",
                      }}
                      formatter={(value) => {
                        const num = typeof value === "number" ? value : 0;
                        return [`$${num.toLocaleString()}`, undefined];
                      }}
                    />
                    <Legend
                      verticalAlign="top"
                      align="right"
                      iconType="circle"
                      wrapperStyle={{
                        paddingBottom: "16px",
                        fontSize: "12px",
                        fontWeight: 500,
                      }}
                    />
                    <Bar
                      name="Revenue"
                      dataKey="revenue"
                      fill="var(--color-primary)"
                      radius={[4, 4, 0, 0]}
                      barSize={aggregationType === "quarterly" ? 40 : 24}
                    />
                    <Bar
                      name="Expenses"
                      dataKey="expenses"
                      fill="var(--color-negative)"
                      fillOpacity={0.7}
                      radius={[4, 4, 0, 0]}
                      barSize={aggregationType === "quarterly" ? 40 : 24}
                    />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-full w-full flex items-center justify-center p-8">
                  <div className="w-full h-full bg-bg-page/50 rounded-lg flex items-center justify-center border border-dashed border-border">
                    <TrendingUp
                      className="text-text-muted animate-pulse"
                      size={32}
                    />
                    <span className="ml-2 text-text-muted">
                      {isChartLoading
                        ? "Loading chart data..."
                        : "No data available"}
                    </span>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* ── Key Insights ── */}
          <div className="col-span-12 lg:col-span-4 card-base card-p flex flex-col">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-[18px] font-semibold text-text-primary">
                Key Insights
              </h3>
              <PieChart size={18} className="text-primary" />
            </div>
            <div className="flex-1 space-y-3">
              {monthlyInsights.map((item, i) => (
                <div
                  key={i}
                  className="p-4 rounded-lg bg-bg-page/50 hover:bg-bg-page transition-all"
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[12px] font-medium text-text-muted">
                      {item.label}
                    </span>
                    <div
                      className="w-2 h-2 rounded-full"
                      style={{ backgroundColor: item.color }}
                    />
                  </div>
                  <p className="text-[20px] font-bold text-text-primary mb-0.5">
                    {item.value}
                  </p>
                  <p className="text-[12px] text-text-muted">{item.desc}</p>
                </div>
              ))}
            </div>
            <button className="btn-secondary w-full mt-5 py-2.5">
              Comprehensive Audit Info
            </button>
          </div>

          {/* ── Recent Invoices ── */}
          <div className="col-span-12 card-base card-p">
            <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
              <h3 className="text-[18px] font-semibold text-text-primary">
                Recent Invoices
              </h3>
              <div className="flex items-center gap-3">
                <div className="relative w-[280px]">
                  <div className="absolute inset-y-0 left-3 flex items-center pointer-events-none">
                    <Search size={16} className="text-text-muted" />
                  </div>
                  <input
                    type="text"
                    placeholder="Search invoices..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="input-base pl-10 h-10"
                  />
                </div>
                <Link href="/invoices">
                  <button className="btn-primary">
                    View All
                    <ChevronDown size={16} />
                  </button>
                </Link>
              </div>
            </div>

            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b border-border bg-bg-page/50">
                    <th className="py-3 px-6 text-[14px] font-medium text-text-muted">
                      Invoice & Date
                    </th>
                    <th className="py-3 px-4 text-[14px] font-medium text-text-muted">
                      Client
                    </th>
                    <th className="py-3 px-4 text-[14px] font-medium text-text-muted">
                      Due Date
                    </th>
                    <th className="py-3 px-4 text-[14px] font-medium text-text-muted text-right">
                      Amount
                    </th>
                    <th className="py-3 px-4 text-[14px] font-medium text-text-muted text-right">
                      Balance
                    </th>
                    <th className="py-3 px-4 text-[14px] font-medium text-text-muted text-center w-[100px]">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {isLoading
                    ? Array.from({ length: 5 }).map((_, i) => (
                        <tr key={i}>
                          <td colSpan={6} className="py-4 px-4">
                            <div className="skeleton h-8 w-full rounded-md" />
                          </td>
                        </tr>
                      ))
                    : invoicesData
                        .filter((inv) => {
                          const s = searchTerm.toLowerCase();
                          return (
                            (inv.DocNumber || inv.id || "")
                              .toLowerCase()
                              .includes(s) ||
                            (inv.CustomerRef?.name || inv.customer || "")
                              .toLowerCase()
                              .includes(s)
                          );
                        })
                        .slice(0, 5)
                        .map((inv, i) => {
                          const amount = inv.TotalAmt || inv.amount || 0;
                          const balance = inv.Balance || inv.balance || 0;

                          let status = "open";
                          if (balance === 0) status = "paid";
                          else if (
                            inv.DueDate &&
                            new Date(inv.DueDate) < new Date()
                          )
                            status = "overdue";

                          const STATUS_CFG = {
                            paid: {
                              label: "Paid",
                              icon: CheckCircle2,
                              color: "bg-[#8bc53d] text-white",
                            },
                            open: {
                              label: "Open",
                              icon: Clock,
                              color: "bg-[#00648F] text-white",
                            },
                            overdue: {
                              label: "Overdue",
                              icon: AlertCircle,
                              color: "bg-[#C62026] text-white",
                            },
                            draft: {
                              label: "Draft",
                              icon: FileText,
                              color: "bg-[#6D6E71] text-white",
                            },
                          };
                          const config = STATUS_CFG[status] || STATUS_CFG.open;

                          return (
                            <tr
                              key={inv.id || i}
                              className="group hover:bg-bg-page/50 transition-colors"
                            >
                              <td className="py-3 px-6">
                                <div className="flex flex-col">
                                  <span className="text-[14px] font-medium text-text-primary">
                                    #
                                    {inv.DocNumber ||
                                      inv.id ||
                                      `INV-00${i + 1}`}
                                  </span>
                                  <span className="text-[12px] text-text-muted">
                                    {new Date(
                                      inv.MetaData?.CreateTime ||
                                        inv.date ||
                                        Date.now(),
                                    ).toLocaleDateString("en-US", {
                                      month: "short",
                                      day: "numeric",
                                      year: "numeric",
                                    })}
                                  </span>
                                </div>
                              </td>
                              <td className="py-3 px-4 text-[14px] text-text-secondary">
                                {inv.CustomerRef?.name ||
                                  inv.customer ||
                                  "Unknown Client"}
                              </td>
                              <td className="py-3 px-4 text-[14px] text-text-secondary">
                                {inv.DueDate || inv.dueDate || "N/A"}
                              </td>
                              <td className="py-3 px-4 text-right text-[14px] font-semibold text-text-primary tabular-nums">
                                $
                                {Number(amount).toLocaleString("en-US", {
                                  minimumFractionDigits: 2,
                                })}
                              </td>
                              <td className="py-3 px-4 text-right text-[14px] font-medium text-text-primary tabular-nums">
                                $
                                {Number(balance).toLocaleString("en-US", {
                                  minimumFractionDigits: 2,
                                })}
                              </td>
                              <td className="py-3 px-4 text-center">
                                <div
                                  className={cn(
                                    "inline-flex items-center justify-center px-4 py-1.5 rounded-full text-[12px] font-bold capitalize min-w-[80px]",
                                    config.color,
                                  )}
                                >
                                  {config.label}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
