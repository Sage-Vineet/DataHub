import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { useParams } from "react-router-dom";
import {
  ChevronDown,
  RefreshCw,
  TrendingUp,
  TrendingDown,
  DollarSign,
  Percent,
  AlertCircle,
  ArrowUpRight,
  ArrowDownRight,
  Calculator,
  Info,
  FileCheck,
  BarChart3,
  CalendarDays,
} from "lucide-react";
import { cn } from "../../../lib/utils";
import { getCompanyRequest } from "../../../lib/api";
import {
  getEbitdaData,
  getEbitdaMonthlyTrend,
} from "../../../services/ebitdaService";
import { refreshQuickbooksToken } from "../../../lib/quickbooks";
import {
  normalizeAccountingMethod,
  sanitizeDateRange,
} from "../../../lib/report-filters";
import QBDisconnectedBanner from "../../../components/common/QBDisconnectedBanner";

/* ------------------------------------------------------------------ */
/*  Utilities                                                         */
/* ------------------------------------------------------------------ */

function formatDateForInput(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatCurrency(amount) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(Number(amount || 0));
}

function formatCurrencyDetailed(amount) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(amount || 0));
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return "N/A";
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}%`;
}

/* ------------------------------------------------------------------ */
/*  Trend Chart (pure CSS/SVG – no library dependency)                */
/* ------------------------------------------------------------------ */

function TrendChart({ data, isLoading }) {
  if (isLoading) {
    return (
      <div className="flex h-[320px] items-center justify-center rounded-xl border border-border bg-white shadow-sm">
        <div className="flex flex-col items-center gap-3">
          <div className="h-10 w-10 animate-spin rounded-full border-4 border-border border-t-primary" />
          <p className="text-[13px] font-medium text-text-muted">Analyzing 12-month performance…</p>
        </div>
      </div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <div className="flex h-[320px] items-center justify-center rounded-xl border border-dashed border-border bg-white p-8">
        <div className="text-center">
          <BarChart3 size={40} className="mx-auto mb-3 text-border" />
          <p className="text-[14px] font-medium text-text-muted">
            No trend data available for this company
          </p>
          <p className="text-[12px] text-text-muted/70">
            Ensure QuickBooks has historical P&L data
          </p>
        </div>
      </div>
    );
  }

  const values = data.map((d) => d.ebitda);
  const maxEbitda = Math.max(...values, 0);
  const minEbitda = Math.min(...values, 0);
  const absMax = Math.max(Math.abs(maxEbitda), Math.abs(minEbitda), 1000);
  
  // Padding for visual clarity
  const yLimit = absMax * 1.25;
  
  const chartHeight = 220;
  const chartWidth = 700;
  const margin = { top: 20, right: 20, bottom: 40, left: 70 };
  
  const getY = (val) => {
    return chartHeight / 2 - (val / yLimit) * (chartHeight / 2);
  };

  const zeroY = getY(0);
  const barSpacing = chartWidth / data.length;
  const barWidth = Math.min(32, barSpacing * 0.7);

  // Generate Y-axis grid marks
  const gridMarks = [yLimit * 0.8, yLimit * 0.4, 0, -yLimit * 0.4, -yLimit * 0.8];

  return (
    <div className="rounded-2xl border border-border bg-white p-6 shadow-sm">
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
            <BarChart3 size={16} className="text-primary" />
          </div>
          <div>
            <h3 className="text-[14px] font-bold text-text-primary">
              Monthly EBITDA Trend
            </h3>
            <p className="text-[11px] text-text-muted">Trailing 12-month earnings analysis</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5">
            <div className="h-2 w-2 rounded-full bg-primary" />
            <span className="text-[11px] font-medium text-text-muted">Positive</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="h-2 w-2 rounded-full bg-red-500" />
            <span className="text-[11px] font-medium text-text-muted">Negative</span>
          </div>
        </div>
      </div>

      <div className="relative">
        {/* Y-axis labels and grid lines */}
        <div className="absolute left-0 top-0 h-full w-[60px] pr-2">
          {gridMarks.map((mark, i) => (
            <div
              key={i}
              className="absolute w-full border-t border-dashed border-gray-100 transition-all"
              style={{ top: getY(mark) + margin.top, right: -640 }}
            >
              <span className="absolute -left-16 -top-2.5 w-14 text-right text-[10px] font-bold text-text-muted">
                {mark >= 1000 ? `${(mark / 1000).toFixed(0)}k` : mark <= -1000 ? `${(mark / 1000).toFixed(0)}k` : mark.toFixed(0)}
              </span>
            </div>
          ))}
        </div>

        {/* Plot Area */}
        <div className="ml-[70px] overflow-x-auto scrollbar-hide">
          <svg
            width={chartWidth}
            height={chartHeight + margin.top + margin.bottom}
            className="overflow-visible"
          >
            {/* Zero Baseline */}
            <line
              x1="0"
              y1={zeroY + margin.top}
              x2={chartWidth}
              y2={zeroY + margin.top}
              stroke="#cbd5e1"
              strokeWidth="2"
              strokeDasharray="4 2"
            />

            {data.map((item, index) => {
              const xPos = index * barSpacing + barSpacing / 2;
              const yPos = getY(item.ebitda) + margin.top;
              const barHeight = Math.abs(zeroY + margin.top - yPos);
              const isPositive = item.ebitda >= 0;
              const tooltipId = `tooltip-${index}`;

              return (
                <g key={index} className="group cursor-pointer">
                  {/* Invisible hover area */}
                  <rect
                    x={xPos - barSpacing / 2}
                    y={margin.top}
                    width={barSpacing}
                    height={chartHeight}
                    fill="transparent"
                  />

                  {/* Bar */}
                  <rect
                    x={xPos - barWidth / 2}
                    y={isPositive ? yPos : zeroY + margin.top}
                    width={barWidth}
                    height={Math.max(barHeight, 2)}
                    rx={4}
                    className={cn(
                      "transition-all duration-300 group-hover:filter group-hover:brightness-95",
                      isPositive
                        ? "fill-primary"
                        : "fill-red-500",
                    )}
                  />

                  {/* X-axis Label (Month) */}
                  <text
                    x={xPos}
                    y={chartHeight + margin.top + 25}
                    textAnchor="middle"
                    className="fill-text-muted text-[10px] font-bold"
                  >
                    {item.month.split(" ")[0]}
                  </text>

                  {/* Tooltip on hover */}
                  <foreignObject
                    x={xPos - 60}
                    y={yPos - 55}
                    width="120"
                    height="50"
                    className="pointer-events-none opacity-0 transition-opacity duration-200 group-hover:opacity-100"
                  >
                    <div className="rounded-lg border border-border bg-white p-2 shadow-xl ring-1 ring-black/5">
                      <p className="text-center text-[11px] font-extrabold text-text-primary">
                        {formatCurrency(item.ebitda)}
                      </p>
                      <p className="text-center text-[9px] font-bold uppercase tracking-wider text-text-muted">
                        {item.month}
                      </p>
                    </div>
                  </foreignObject>
                </g>
              );
            })}
          </svg>
        </div>
      </div>
      <div className="mt-4 flex items-center justify-center gap-8 border-t border-border pt-4">
        <div className="flex flex-col items-center">
            <span className="text-[10px] uppercase tracking-wider text-text-muted">Time Period</span>
            <span className="text-[12px] font-bold text-text-primary">Monthly</span>
        </div>
        <div className="flex flex-col items-center">
            <span className="text-[10px] uppercase tracking-wider text-text-muted">Y-Axis</span>
            <span className="text-[12px] font-bold text-text-primary">EBITDA Value ($)</span>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Period Comparison Card                                             */
/* ------------------------------------------------------------------ */

function ComparisonCard({ current, previous, label }) {
  if (!previous) return null;

  const diff = current - previous;
  const percentChange =
    previous !== 0 ? ((current - previous) / Math.abs(previous)) * 100 : 0;
  const isPositive = diff >= 0;

  return (
    <div className="rounded-xl border border-border bg-white p-5">
      <div className="mb-3 flex items-center gap-2">
        <CalendarDays size={16} className="text-text-muted" />
        <h3 className="text-[12px] font-bold uppercase tracking-wider text-text-muted">
          {label}
        </h3>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div>
          <p className="text-[11px] text-text-muted">Current Period</p>
          <p className="mt-1 text-lg font-bold text-text-primary">
            {formatCurrency(current)}
          </p>
        </div>
        <div>
          <p className="text-[11px] text-text-muted">Previous Period</p>
          <p className="mt-1 text-lg font-bold text-text-primary">
            {formatCurrency(previous)}
          </p>
        </div>
        <div>
          <p className="text-[11px] text-text-muted">Growth</p>
          <div className="mt-1 flex items-center gap-1.5">
            <span
              className={cn(
                "text-lg font-bold",
                isPositive ? "text-green-600" : "text-red-500",
              )}
            >
              {formatCurrency(diff)}
            </span>
            <span
              className={cn(
                "flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[11px] font-bold",
                isPositive
                  ? "bg-green-100 text-green-700"
                  : "bg-red-100 text-red-600",
              )}
            >
              {isPositive ? (
                <ArrowUpRight size={11} />
              ) : (
                <ArrowDownRight size={11} />
              )}
              {formatPercent(percentChange)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Sub-components                                                    */
/* ------------------------------------------------------------------ */

function EbitdaHeroCard({ ebitda, isPositive, reportPeriod, previousEbitda }) {
  const diff =
    previousEbitda !== null && previousEbitda !== undefined
      ? ebitda - previousEbitda
      : null;
  const pctChange =
    diff !== null && previousEbitda !== 0
      ? ((ebitda - previousEbitda) / Math.abs(previousEbitda)) * 100
      : null;

  return (
    <div className="relative overflow-hidden rounded-2xl border border-border bg-white p-8 shadow-sm">
      <div className="relative">
        <div className="mb-1 flex items-center gap-2">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gray-100">
            <TrendingUp size={20} className="text-gray-500" />
          </div>
          <div>
            <p className="text-[12px] font-semibold uppercase tracking-wider text-text-muted">
              EBITDA
            </p>
            <p className="text-[11px] text-text-muted">
              Earnings Before Interest, Taxes, Depreciation & Amortization
            </p>
          </div>
        </div>

        <div className="mt-5 flex items-end gap-3">
          <h2 className="text-4xl font-extrabold tracking-tight text-text-primary">
            {formatCurrency(ebitda)}
          </h2>
          <div
            className={cn(
              "mb-1 flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-bold",
              isPositive
                ? "bg-green-100 text-green-700"
                : "bg-red-100 text-red-600",
            )}
          >
            {isPositive ? (
              <ArrowUpRight size={13} />
            ) : (
              <ArrowDownRight size={13} />
            )}
            {isPositive ? "Positive" : "Negative"}
          </div>
          {pctChange !== null && Number.isFinite(pctChange) && (
            <div
              className={cn(
                "mb-1 flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-bold",
                pctChange >= 0
                  ? "bg-blue-100 text-blue-700"
                  : "bg-orange-100 text-orange-600",
              )}
            >
              {pctChange >= 0 ? (
                <TrendingUp size={13} />
              ) : (
                <TrendingDown size={13} />
              )}
              {formatPercent(pctChange)} vs prev
            </div>
          )}
        </div>

        {reportPeriod?.startDate && (
          <p className="mt-3 text-[12px] font-medium text-text-muted">
            {reportPeriod.startDate} — {reportPeriod.endDate} ·{" "}
            {reportPeriod.reportBasis} Basis
          </p>
        )}
      </div>
    </div>
  );
}

function ComponentCard({ icon: Icon, label, value, color, matchedAccounts }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetails = matchedAccounts && matchedAccounts.length > 0;
  const hasNonZero = value !== 0;

  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-xl border border-border bg-white p-5 transition-all duration-200 hover:shadow-md",
        hasDetails && "cursor-pointer",
        !hasNonZero && "opacity-60",
      )}
      onClick={() => hasDetails && setExpanded(!expanded)}
    >
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div
            className="flex h-10 w-10 items-center justify-center rounded-lg"
            style={{ backgroundColor: `${color}15` }}
          >
            <Icon size={18} style={{ color }} />
          </div>
          <div>
            <p className="text-[12px] font-medium uppercase tracking-wide text-text-muted">
              {label}
            </p>
            <p className="mt-0.5 text-xl font-bold text-text-primary">
              {formatCurrencyDetailed(value)}
            </p>
          </div>
        </div>

        {hasDetails && (
          <ChevronDown
            size={16}
            className={cn(
              "mt-1 text-text-muted transition-transform",
              expanded && "rotate-180",
            )}
          />
        )}
      </div>

      {!hasNonZero && (
        <p className="mt-2 text-[11px] italic text-text-muted">
          No matching accounts found in this period
        </p>
      )}

      {/* Matched accounts detail */}
      {expanded && hasDetails && (
        <div className="mt-4 space-y-2 border-t border-border pt-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
            Matched Accounts ({matchedAccounts.length})
          </p>
          {matchedAccounts.map((account, index) => (
            <div
              key={`${account.label}-${index}`}
              className="flex items-center justify-between rounded-lg bg-bg-page px-3 py-2"
            >
              <span className="text-[13px] font-medium text-text-primary">
                {account.label || "Account"}
              </span>
              <span className="text-[13px] font-semibold text-text-primary">
                {formatCurrencyDetailed(account.value)}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Bottom accent line */}
      <div
        className="absolute bottom-0 left-0 h-[3px] w-full opacity-0 transition-opacity group-hover:opacity-100"
        style={{ backgroundColor: color }}
      />
    </div>
  );
}

function FormulaBar({ components }) {
  const items = [
    { key: "netIncome", symbol: "", color: "#2d6a0f" },
    { key: "interest", symbol: "+", color: "#F68C1F" },
    { key: "taxes", symbol: "+", color: "#C62026" },
    { key: "depreciation", symbol: "+", color: "#742982" },
    { key: "amortization", symbol: "+", color: "#00B0F0" },
  ];

  return (
    <div className="rounded-xl border border-border bg-gradient-to-r from-slate-50 to-white p-5">
      <div className="mb-3 flex items-center gap-2">
        <Calculator size={16} className="text-text-muted" />
        <p className="text-[12px] font-bold uppercase tracking-wider text-text-muted">
          EBITDA Formula Breakdown
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {items.map((item) => {
          const comp = components[item.key];
          return (
            <div key={item.key} className="flex items-center gap-2">
              {item.symbol && (
                <span className="text-lg font-bold text-text-muted">
                  {item.symbol}
                </span>
              )}
              <div
                className="rounded-lg border px-3 py-1.5"
                style={{
                  borderColor: `${item.color}30`,
                  backgroundColor: `${item.color}08`,
                }}
              >
                <span
                  className="text-[11px] font-medium"
                  style={{ color: item.color }}
                >
                  {comp?.label}
                </span>
                <span className="ml-2 text-[13px] font-bold text-text-primary">
                  {formatCurrency(comp?.value || 0)}
                </span>
              </div>
            </div>
          );
        })}
        <span className="text-lg font-bold text-text-muted">=</span>
        <div className="rounded-lg border border-primary/30 bg-primary/5 px-4 py-1.5">
          <span className="text-[11px] font-medium text-primary">EBITDA</span>
          <span className="ml-2 text-[14px] font-extrabold text-primary-dark">
            {formatCurrency(
              (components.netIncome?.value || 0) +
                (components.interest?.value || 0) +
                (components.taxes?.value || 0) +
                (components.depreciation?.value || 0) +
                (components.amortization?.value || 0),
            )}
          </span>
        </div>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-border bg-bg-page/50 py-16">
      <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10">
        <TrendingUp size={28} className="text-primary" />
      </div>
      <h3 className="text-[16px] font-semibold text-text-primary">
        Generate EBITDA Analysis
      </h3>
      <p className="mt-1.5 max-w-sm text-center text-[13px] text-text-muted">
        Select a date range and accounting method, then click{" "}
        <strong>Generate</strong> to calculate EBITDA from your Profit & Loss
        data.
      </p>
    </div>
  );
}

function ErrorState({ error, onRetry }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-red-200 bg-red-50/50 py-12">
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-red-100">
        <AlertCircle size={22} className="text-red-500" />
      </div>
      <h3 className="text-[15px] font-semibold text-red-900">
        Unable to Load EBITDA Data
      </h3>
      <p className="mt-1 max-w-sm text-center text-[13px] text-red-600">
        {error}
      </p>
      <button
        onClick={onRetry}
        className="mt-4 rounded-lg bg-red-600 px-4 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-red-700"
      >
        Try Again
      </button>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-border bg-bg-page/50 py-16">
      <div className="mb-4 h-12 w-12 animate-spin rounded-full border-4 border-border border-t-primary" />
      <p className="animate-pulse text-[13px] font-medium text-text-muted">
        Analyzing financial data & computing EBITDA…
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Previous period date calculator                                   */
/* ------------------------------------------------------------------ */

function getPreviousPeriodDates(startDate, endDate) {
  if (!startDate || !endDate) return null;
  const start = new Date(startDate);
  const end = new Date(endDate);
  const diffMs = end.getTime() - start.getTime();
  const prevEnd = new Date(start.getTime() - 1);
  const prevStart = new Date(prevEnd.getTime() - diffMs);
  return {
    startDate: formatDateForInput(prevStart),
    endDate: formatDateForInput(prevEnd),
  };
}

/* ------------------------------------------------------------------ */
/*  Main Component                                                    */
/* ------------------------------------------------------------------ */

export default function WorkspaceEbitda() {
  const { clientId } = useParams();
  const today = new Date();
  const todayString = formatDateForInput(today);

  // Filter state
  const [dateRange, setDateRange] = useState("This Year");
  const [customRange, setCustomRange] = useState({
    start: `${today.getFullYear()}-01-01`,
    end: todayString,
  });
  const [accountingMethod, setAccountingMethod] = useState("Accrual");

  // Data state
  const [ebitdaResult, setEbitdaResult] = useState(null);
  const [previousEbitda, setPreviousEbitda] = useState(null);
  const [trendData, setTrendData] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isTrendLoading, setIsTrendLoading] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [error, setError] = useState("");
  const [company, setCompany] = useState(null);
  const [showTrend, setShowTrend] = useState(false);

  // Load company info
  useEffect(() => {
    let active = true;
    if (!clientId) return;
    getCompanyRequest(clientId)
      .then((data) => active && setCompany(data))
      .catch(() => active && setCompany(null));
    return () => {
      active = false;
    };
  }, [clientId]);

  const getDates = useCallback(() => {
    if (dateRange === "Custom Range") {
      return { startDate: customRange.start, endDate: customRange.end };
    }

    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    const endDate = `${year}-${month}-${day}`;

    let startDate;
    if (dateRange === "Today") {
      startDate = endDate;
    } else if (dateRange === "This Month") {
      startDate = `${year}-${month}-01`;
    } else if (dateRange === "This Quarter") {
      const quarterMonth = String(
        Math.floor(now.getMonth() / 3) * 3 + 1,
      ).padStart(2, "0");
      startDate = `${year}-${quarterMonth}-01`;
    } else if (dateRange === "Previous Quarter") {
      const currentQuarterStartMonth = Math.floor(now.getMonth() / 3) * 3;
      const previousQuarterEnd = new Date(year, currentQuarterStartMonth, 0);
      const previousQuarterStart = new Date(
        previousQuarterEnd.getFullYear(),
        Math.floor(previousQuarterEnd.getMonth() / 3) * 3,
        1,
      );
      startDate = formatDateForInput(previousQuarterStart);
      return { startDate, endDate: formatDateForInput(previousQuarterEnd) };
    } else {
      // This Year (default)
      startDate = `${year}-01-01`;
    }

    return { startDate, endDate };
  }, [dateRange, customRange]);

  const handleGenerate = useCallback(async () => {
    setIsLoading(true);
    setError("");
    try {
      const rawDates = getDates();
      const { startDate, endDate } = sanitizeDateRange(
        rawDates.startDate,
        rawDates.endDate,
      );
      const method = normalizeAccountingMethod(accountingMethod);

      // Fetch current period
      const result = await getEbitdaData(startDate, endDate, method);
      setEbitdaResult(result);

      // Fetch previous period for comparison
      try {
        const prevDates = getPreviousPeriodDates(startDate, endDate);
        if (prevDates) {
          const prevResult = await getEbitdaData(
            prevDates.startDate,
            prevDates.endDate,
            method,
          );
          setPreviousEbitda(prevResult.ebitda);
        }
      } catch {
        setPreviousEbitda(null);
      }
    } catch (err) {
      console.error("[WorkspaceEbitda] Generation failed:", err);
      setError(
        err?.message || "Failed to fetch EBITDA data. Please try again.",
      );
      setEbitdaResult(null);
    } finally {
      setIsLoading(false);
    }
  }, [getDates, accountingMethod]);

  const handleLoadTrend = useCallback(async () => {
    if (trendData.length > 0) {
      setShowTrend(!showTrend);
      return;
    }
    setIsTrendLoading(true);
    setShowTrend(true);
    try {
      const method = normalizeAccountingMethod(accountingMethod);
      const trend = await getEbitdaMonthlyTrend(method);
      setTrendData(trend);
    } catch (err) {
      console.error("[WorkspaceEbitda] Trend loading failed:", err);
    } finally {
      setIsTrendLoading(false);
    }
  }, [accountingMethod, trendData.length, showTrend]);

  const handleSync = async () => {
    setIsSyncing(true);
    try {
      await refreshQuickbooksToken();
      await handleGenerate();
    } catch (err) {
      console.error("Sync failed:", err);
      setError("Sync failed. Please try again.");
    } finally {
      setIsSyncing(false);
    }
  };

  const isPositive = (ebitdaResult?.ebitda || 0) >= 0;
  const components = ebitdaResult?.components || {};

  /* ---------------------------------------------------------------- */
  /*  Component cards config                                          */
  /* ---------------------------------------------------------------- */
  const componentCards = [
    {
      icon: DollarSign,
      color: "#2d6a0f",
      label: components.netIncome?.label || "Net Income",
      value: components.netIncome?.value || 0,
      matchedAccounts: components.netIncome?.matchedAccounts || [],
    },
    {
      icon: Percent,
      color: "#F68C1F",
      label: components.interest?.label || "Interest Expense",
      value: components.interest?.value || 0,
      matchedAccounts: components.interest?.matchedAccounts || [],
    },
    {
      icon: DollarSign,
      color: "#C62026",
      label: components.taxes?.label || "Tax Expense",
      value: components.taxes?.value || 0,
      matchedAccounts: components.taxes?.matchedAccounts || [],
    },
    {
      icon: TrendingUp,
      color: "#742982",
      label: components.depreciation?.label || "Depreciation",
      value: components.depreciation?.value || 0,
      matchedAccounts: components.depreciation?.matchedAccounts || [],
    },
    {
      icon: TrendingUp,
      color: "#00B0F0",
      label: components.amortization?.label || "Amortization",
      value: components.amortization?.value || 0,
      matchedAccounts: components.amortization?.matchedAccounts || [],
    },
  ];

  return (
    <div className="page-container">
      <div className="page-content">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-[#050505]">
              EBITDA Analysis
            </h1>
            <p className="mt-1 text-[13px] text-text-muted">
              Dynamic earnings analysis powered by your Profit & Loss data
              {company?.name ? ` — ${company.name}` : ""}
            </p>
          </div>
          <button
            onClick={handleSync}
            disabled={isSyncing}
            className="btn-secondary"
          >
            <RefreshCw
              size={16}
              className={isSyncing ? "animate-spin" : ""}
            />
            {isSyncing ? "Syncing..." : "Sync"}
          </button>
        </div>

        <QBDisconnectedBanner pageName="EBITDA Analysis" />

        {/* Filters */}
        <div className="mb-6 rounded-xl border border-border bg-white p-5">
          <div className="flex flex-wrap items-end gap-4">
            {/* Date Range */}
            <div className="flex min-w-[180px] flex-col gap-1.5">
              <label className="text-[13px] font-medium text-text-primary">
                Date Range
              </label>
              <div className="relative">
                <select
                  value={dateRange}
                  onChange={(e) => {
                    const value = e.target.value;
                    setDateRange(value);
                    if (value === "This Year") {
                      setCustomRange({
                        start: `${new Date().getFullYear()}-01-01`,
                        end: todayString,
                      });
                    }
                  }}
                  className="h-10 w-full appearance-none rounded-md border border-border bg-bg-card pl-3 pr-10 text-[14px] text-text-primary transition-all focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  <option>Today</option>
                  <option>This Month</option>
                  <option>This Quarter</option>
                  <option>Previous Quarter</option>
                  <option>This Year</option>
                  <option>Custom Range</option>
                </select>
                <ChevronDown
                  size={16}
                  className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-text-muted"
                />
              </div>
            </div>

            {/* Custom date pickers */}
            {dateRange === "Custom Range" && (
              <>
                <div className="flex flex-col gap-1.5">
                  <label className="text-[12px] text-text-muted">From</label>
                  <input
                    type="date"
                    value={customRange.start}
                    onChange={(e) =>
                      setCustomRange((prev) => ({
                        ...prev,
                        start: e.target.value,
                      }))
                    }
                    className="h-10 rounded-md border border-border bg-bg-card px-3 text-[14px] text-text-primary focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-[12px] text-text-muted">To</label>
                  <input
                    type="date"
                    value={customRange.end}
                    onChange={(e) =>
                      setCustomRange((prev) => ({
                        ...prev,
                        end: e.target.value,
                      }))
                    }
                    className="h-10 rounded-md border border-border bg-bg-card px-3 text-[14px] text-text-primary focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
              </>
            )}

            {/* Accounting Method */}
            <div className="flex min-w-[160px] flex-col gap-1.5">
              <label className="text-[13px] font-medium text-text-primary">
                Accounting Method
              </label>
              <div className="relative">
                <select
                  value={accountingMethod}
                  onChange={(e) => setAccountingMethod(e.target.value)}
                  className="h-10 w-full appearance-none rounded-md border border-border bg-bg-card pl-3 pr-10 text-[14px] text-text-primary transition-all focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  <option>Cash</option>
                  <option>Accrual</option>
                </select>
                <ChevronDown
                  size={16}
                  className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-text-muted"
                />
              </div>
            </div>

            {/* Generate button */}
            <button
              onClick={handleGenerate}
              disabled={isLoading}
              className={cn(
                "btn-primary h-10 px-6",
                isLoading && "cursor-wait opacity-80",
              )}
            >
              {isLoading ? (
                <div className="flex items-center gap-2">
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                  <span>Calculating…</span>
                </div>
              ) : (
                <>
                  <FileCheck size={16} />
                  Generate
                </>
              )}
            </button>
          </div>
        </div>

        {/* Content */}
        {isLoading ? (
          <LoadingState />
        ) : error ? (
          <ErrorState error={error} onRetry={handleGenerate} />
        ) : ebitdaResult ? (
          <div className="space-y-6 animate-in slide-in-from-bottom-2 fade-in duration-300">
            {/* Hero EBITDA card */}
            <EbitdaHeroCard
              ebitda={ebitdaResult.ebitda}
              isPositive={isPositive}
              reportPeriod={ebitdaResult.reportPeriod}
              previousEbitda={previousEbitda}
            />

            {/* Period comparison */}
            {previousEbitda !== null && (
              <ComparisonCard
                current={ebitdaResult.ebitda}
                previous={previousEbitda}
                label="Period-over-Period Comparison"
              />
            )}

            {/* Formula breakdown */}
            <FormulaBar components={components} />

            {/* Component cards grid */}
            <div>
              <div className="mb-3 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Info size={14} className="text-text-muted" />
                  <p className="text-[12px] font-semibold uppercase tracking-wider text-text-muted">
                    Component Breakdown · Click to view matched accounts
                  </p>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
                {componentCards.map((card) => (
                  <ComponentCard
                    key={card.label}
                    icon={card.icon}
                    label={card.label}
                    value={card.value}
                    color={card.color}
                    matchedAccounts={card.matchedAccounts}
                  />
                ))}
              </div>
            </div>

            {/* Trend chart toggle */}
            <div>
              <button
                onClick={handleLoadTrend}
                className="btn-secondary mb-3"
                disabled={isTrendLoading}
              >
                <BarChart3 size={16} />
                {showTrend ? "Hide" : "Show"} Monthly Trend
                {isTrendLoading && (
                  <div className="ml-1 h-4 w-4 animate-spin rounded-full border-2 border-border border-t-primary" />
                )}
              </button>
              {showTrend && (
                <TrendChart data={trendData} isLoading={isTrendLoading} />
              )}
            </div>

          </div>
        ) : (
          <EmptyState />
        )}
      </div>
    </div>
  );
}
