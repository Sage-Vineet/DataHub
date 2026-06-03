import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { useParams } from "react-router-dom";
import {
  RefreshCw,
  TrendingUp,
  AlertCircle,
  Plus,
  Trash2,
  ChevronDown,
} from "lucide-react";
import { cn, formatCurrency } from "../../../lib/utils";
import { getCompanyRequest, getReportSources, setSelectedReportSource as apiSetSelectedReportSource, getAllManualUploadedReports, getAllQMSUploadedReports, syncQMSUploadSource, getManualStageFilterOptions, listManualGlDatasetVersions } from "../../../lib/api";
import {
  getEbitdaData,
  extractEbitdaFromManualPLRows,
} from "../../../services/ebitdaService";
import { REPORT_SOURCE_KEYS, normalizeReportSourceKey } from "../../../lib/report-source";
import { refreshQuickbooksToken } from "../../../lib/quickbooks";
import QBDisconnectedBanner from "../../../components/common/QBDisconnectedBanner";
import Modal from "../../../components/common/Modal";
import { useDataSource } from "../../../context/DataSourceContext";
import { useDatasetVersionStore } from "../../../store/useDatasetVersionStore";

function formatPercent(value) {
  if (!Number.isFinite(value)) return "-";
  return `${value.toFixed(1)}%`;
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
        No financial data was found. Please upload and stage your financial data, then generate the analysis.
      </p>
    </div>
  );
}

function EmptyStateNotification({ error, onRetry }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
      <AlertCircle size={16} className="shrink-0 text-amber-500" />
      <p className="flex-1 text-[13px] text-amber-800">{error}</p>
      <button
        onClick={onRetry}
        className="shrink-0 rounded-md border border-amber-300 bg-white px-3 py-1.5 text-[12px] font-medium text-amber-700 transition-colors hover:bg-amber-50"
      >
        Retry
      </button>
    </div>
  );
}

const EMPTY_TABLE_ROWS = [
  { label: 'Net Income', indent: false, bold: true, shade: 'bg-gray-50' },
  { label: 'Total Interest Income', indent: true, bold: false, shade: '' },
  { label: 'Total Interest Expense', indent: true, bold: false, shade: '' },
  { label: 'Total Income Tax Expense', indent: true, bold: false, shade: '' },
  { label: 'Depreciation', indent: true, bold: false, shade: '' },
  { label: 'Amortization Expense', indent: true, bold: false, shade: '' },
  { label: 'EBITDA', indent: false, bold: true, shade: 'bg-[#f8fafc]' },
  { label: 'Addbacks', indent: false, bold: true, shade: 'bg-gray-100' },
  { label: "Seller's Discretionary Earnings", indent: false, bold: true, shade: 'bg-gray-50' },
  { label: 'SDE % of Sales', indent: false, bold: false, shade: '' },
];

function EmptyEbitdaTable({ companyName }) {
  return (
    <div className="flex gap-6 items-start">
      <div className="flex-1 overflow-hidden rounded-xl border border-[#cbd5e1] bg-white shadow-lg">
        <div className="bg-[#8bc53d] py-3 text-center">
          <h2 className="text-[18px] font-bold text-white">
            Recalculated Seller&apos;s Discretionary Earnings of {companyName || 'the Business'}
          </h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[14px]">
            <thead>
              <tr className="bg-[#8bc53d] text-white">
                <th className="border-b border-[#cbd5e1] p-3 text-left font-bold min-w-[280px]"></th>
                <th className="border-b border-[#cbd5e1] p-3 text-right font-bold min-w-[120px] opacity-40">FY —</th>
              </tr>
            </thead>
            <tbody>
              {EMPTY_TABLE_ROWS.map((row) => (
                <tr
                  key={row.label}
                  className={`border-b border-[#f1f5f9] h-[46px] ${row.shade}`}
                >
                  <td className={`p-3 ${row.indent ? 'pl-8' : 'pl-3'} ${row.bold ? 'font-bold text-[#050505]' : 'text-text-primary'}`}>
                    {row.label}
                  </td>
                  <td className="p-3 text-right text-text-muted">—</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
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
/*  Helpers & Sub-components                                         */
/* ------------------------------------------------------------------ */

function FormattedNumericInput({ value, apiValue, isFromPL, linkedToPL, onChange, className, ...props }) {
  const [isFocused, setIsFocused] = useState(false);
  const showPLAsterisk = Boolean(isFromPL && linkedToPL && value === null && apiValue !== null);
  const valToFormat = value !== null ? value : apiValue;

  const getDisplayValue = () => {
    if (isFocused) {
      if (value === null) return "";
      return String(value);
    }
    const formatted = formatCurrency(valToFormat);
    return showPLAsterisk && formatted !== "-" && !formatted.startsWith("*")
      ? `*${formatted}`
      : formatted;
  };

  return (
    <input
      {...props}
      type="text"
      value={getDisplayValue()}
      onFocus={() => setIsFocused(true)}
      onBlur={() => setIsFocused(false)}
      onChange={(e) => {
        const val = e.target.value.replace(/[\*,]/g, "").trim();
        onChange(val);
      }}
      className={cn(
        "w-full bg-transparent text-right font-medium focus:outline-none focus:ring-1 focus:ring-[#8bc53d] rounded px-2 py-1 transition-all",
        (value !== null || apiValue !== null) ? "text-text-primary" : "text-gray-300",
        className
      )}
      placeholder={apiValue !== null ? formatCurrency(apiValue) : "-"}
    />
  );
}

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:4000";

export default function WorkspaceEbitda() {
  const { clientId } = useParams();
  const { activeSource, activeSourceMode } = useDataSource();

  const accountingMethod = "Accrual";

  const reportSource = activeSource ? normalizeReportSourceKey(activeSource) : REPORT_SOURCE_KEYS.QUICKBOOKS;
  const isManualGl = reportSource === REPORT_SOURCE_KEYS.MANUAL_GL;
  const isManualUpload = reportSource === REPORT_SOURCE_KEYS.MANUAL_UPLOAD;
  const isQBManual = reportSource === REPORT_SOURCE_KEYS.QUICKBOOKS_MANUAL;
  const isManualMode = isManualGl || isManualUpload || isQBManual;

  const [multiYearData, setMultiYearData] = useState(null);
  const [years, setYears] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [error, setError] = useState("");
  const [company, setCompany] = useState(null);
  const [dynamicAddbacks, setDynamicAddbacks] = useState([]);
  const [isDataInitialized, setIsDataInitialized] = useState(false);
  const [rowComments, setRowComments] = useState({});
  const [sdePerCim, setSdePerCim] = useState("");
  const [isTypeDialogOpen, setIsTypeDialogOpen] = useState(false);

  // Dataset version selection — Manual GL only.
  // Seeded from the shared store (kept in sync by WorkspaceReports) so the
  // same version is used across all reports without the user having to reselect.
  const sharedSelectedVersion = useDatasetVersionStore((s) => s.selectedVersion);
  const [glVersions, setGlVersions] = useState([]);
  const [selectedVersion, setSelectedVersion] = useState(null);

  const activeSourceRef = useRef(reportSource);
  activeSourceRef.current = reportSource;
  // Tracks the currently-selected version so an in-flight request for a
  // previous version can be discarded if the user switches mid-fetch
  // (last-write-wins guard — prevents stale-version data overwriting fresh).
  const latestVersionRef = useRef(selectedVersion);
  latestVersionRef.current = selectedVersion;
  const prevReportSourceForClearRef = useRef(reportSource);

  // Extract unique P&L accounts for addback dropdown (dynamic from API data)
  const plAccountOptions = useMemo(() => {
    if (!multiYearData) return [];
    const accountMap = new Map();
    Object.values(multiYearData).forEach((yearData) => {
      const flatRows = yearData?._debug?.flatRows;
      if (!flatRows) return;
      flatRows.forEach((row) => {
        const label = (row.label || "").trim();
        if (
          label &&
          label.toLowerCase() !== "net income" &&
          !label.toLowerCase().startsWith("total ") // skip summary totals
        ) {
          const accountId =
            row.accountId ||
            row.AccountId ||
            row.id ||
            row.Id ||
            `pl:${label.toLowerCase()}`;
          if (!accountMap.has(label)) {
            accountMap.set(label, { label, accountId: String(accountId) });
          }
        }
      });
    });
    return Array.from(accountMap.values()).sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { sensitivity: "base" })
    );
  }, [multiYearData]);

  const plAccountNames = useMemo(
    () => plAccountOptions.map((option) => option.label),
    [plAccountOptions]
  );

  const getAccountIdByLabel = useCallback(
    (label) => {
      const match = plAccountOptions.find((option) => option.label === label);
      return match?.accountId || null;
    },
    [plAccountOptions]
  );

  // Step 1: Dynamic Extraction Function
  const getValueFromPL = useCallback((year, label) => {
    const flatRows = multiYearData[year]?._debug?.flatRows;
    if (!flatRows || !label) return null;

    const searchLabel = label.toLowerCase().trim();
    // Match label dynamically using row names from API
    const match = flatRows.find(row =>
      row.label?.toLowerCase().trim() === searchLabel ||
      row.AccountName?.toLowerCase().trim() === searchLabel
    );

    return match ? (match.value || 0) : null;
  }, [multiYearData]);

  const calculateBaseEbitda = useCallback((year) => {
    const comps = multiYearData[year]?.components;
    if (!comps) return 0;
    return (comps.netIncome?.value || 0)
      - (comps.interestIncome?.value || 0)
      + (comps.interestExpense?.value || 0)
      + (comps.taxes?.value || 0)
      + (comps.depreciation?.value || 0)
      + (comps.amortization?.value || 0);
  }, [multiYearData]);

  // Load company info
  useEffect(() => {
    let active = true;
    if (!clientId) return;
    getCompanyRequest(clientId)
      .then((data) => active && setCompany(data))
      .catch(() => active && setCompany(null));
    return () => { active = false; };
  }, [clientId]);

  useEffect(() => {
    if (prevReportSourceForClearRef.current === reportSource) return;
    prevReportSourceForClearRef.current = reportSource;
    setMultiYearData(null);
    setYears([]);
    setError("");
    setIsLoading(false);
    setIsDataInitialized(false);
    // Clear version list when switching away from Manual GL
    if (!isManualGl) {
      setGlVersions([]);
      setSelectedVersion(null);
    }
  }, [reportSource, isManualGl]);

  // Load available dataset versions for Manual GL.
  // Seeds the selection from the shared store (written by WorkspaceReports)
  // so the same version is active across all reports automatically.
  useEffect(() => {
    if (!isManualGl || !clientId) return;
    let cancelled = false;
    listManualGlDatasetVersions({ clientId })
      .then((versions) => {
        if (cancelled) return;
        setGlVersions(versions);
        setSelectedVersion((prev) => {
          // Keep current selection if still valid; otherwise prefer the shared
          // store value (Reports' selection), then fall back to latest/active.
          const available = versions.map((v) => String(v.value));
          if (prev && available.includes(String(prev))) return prev;
          const fromStore = sharedSelectedVersion && available.includes(String(sharedSelectedVersion))
            ? sharedSelectedVersion : null;
          const active = versions.find((v) => v.isActive) || versions[0];
          return fromStore ?? (active ? String(active.value) : null);
        });
      })
      .catch(() => { if (!cancelled) setGlVersions([]); });
    return () => { cancelled = true; };
  }, [isManualGl, clientId, sharedSelectedVersion]);

  // Cache key includes version so switching versions always fetches fresh data
  // and never serves a cached result from a different version.
  const ebitdaCacheKey = clientId && reportSource
    ? `ebitda_data_${clientId}_${reportSource}${isManualGl && selectedVersion ? `_v${selectedVersion}` : ""}`
    : null;

  const handleGenerate = useCallback(async (skipCache = false) => {
    const requestSource = reportSource;
    const requestVersion = selectedVersion;
    if (!skipCache && ebitdaCacheKey) {
      try {
        const cached = sessionStorage.getItem(ebitdaCacheKey);
        if (cached) {
          const { multiYearData: cachedData, years: cachedYears } = JSON.parse(cached);
          if (cachedData && cachedYears?.length) {
            setMultiYearData(cachedData);
            setYears(cachedYears);
            setError("");
            return;
          }
        }
      } catch { /* ignore corrupt cache */ }
    }

    setIsLoading(true);
    setError("");
    try {
      const currentYear = new Date().getFullYear();

      if (isManualGl) {
        // Staged GL: discover available fiscal years for the selected version,
        // then fetch EBITDA per year — version-scoped so different versions
        // produce independent, isolated EBITDA calculations.
        const versionParam = selectedVersion ? { datasetVersion: String(selectedVersion) } : {};
        const filterOpts = await getManualStageFilterOptions({ clientId, params: versionParam });
        const yearStrings = filterOpts?.options?.fiscalYear || [];
        const availableYears = yearStrings
          .map((y) => parseInt(y, 10))
          .filter((y) => Number.isInteger(y) && y > 0)
          .sort((a, b) => b - a);

        if (!availableYears.length) {
          throw new Error("No staged GL data found. Please upload and stage your GL files first.");
        }

        const results = {};
        await Promise.all(
          availableYears.map(async (year) => {
            try {
              results[year] = await getEbitdaData(
                `${year}-01-01`, `${year}-12-31`,
                accountingMethod, "manual",
                selectedVersion,
              );
            } catch {
              results[year] = null;
            }
          })
        );
        // Discard if the source OR the selected version changed while this
        // request was in flight — otherwise a slow old-version response would
        // overwrite the newer version's data (stale-data-until-refresh bug).
        if (activeSourceRef.current !== requestSource || latestVersionRef.current !== requestVersion) return;
        setYears(availableYears);
        setMultiYearData(results);
        if (ebitdaCacheKey) {
          try { sessionStorage.setItem(ebitdaCacheKey, JSON.stringify({ multiYearData: results, years: availableYears })); } catch { /* quota exceeded */ }
        }
      } else if (isManualUpload) {
        // Fetch ALL uploaded P&L files so every year is represented
        const result = await getAllManualUploadedReports("profit_and_loss", { clientId });
        const files = (result?.files || []).filter((f) => f.data?.rows?.length);

        if (!files.length) {
          throw new Error("No P&L reports found. Please upload your Profit & Loss files via the Connections page.");
        }

        // Detect the fiscal year a file belongs to
        const detectFileYear = (file) => {
          const data = file.data || {};
          const dateSrc = data.asOfDate || data.periodEnd || data.periodStart;
          if (dateSrc) {
            const parsed = parseInt(String(dateSrc).split("-")[0], 10);
            if (parsed >= 2000 && parsed <= currentYear + 1) return parsed;
          }
          const yearInName = (file.fileName || "").match(/\b(20\d{2})\b/);
          if (yearInName) return parseInt(yearInName[1], 10);
          return currentYear;
        };

        // For multi-period files (monthly columns), use the "Total" column if
        // present, otherwise sum all months → amount for EBITDA calculations.
        const buildSumColAmounts = (periods) => {
          const totalIdx = (periods || []).findIndex((p) => /^total$/i.test(String(p).trim()));
          const getVal = (colAmounts) => {
            if (!Array.isArray(colAmounts) || colAmounts.length === 0) return 0;
            return totalIdx >= 0
              ? (colAmounts[totalIdx] || 0)
              : colAmounts.reduce((s, v) => s + (v || 0), 0);
          };
          const sumColAmounts = (node) => ({
            ...node,
            amount: getVal(node.colAmounts) || (node.amount || 0),
            children: node.children ? node.children.map(sumColAmounts) : undefined,
          });
          return sumColAmounts;
        };

        // One EBITDA entry per year; if two files share a year keep the newest
        const yearFileMap = new Map();
        for (const file of files) {
          const yr = detectFileYear(file);
          const existing = yearFileMap.get(yr);
          if (!existing || new Date(file.updatedAt || 0) > new Date(existing.updatedAt || 0)) {
            yearFileMap.set(yr, file);
          }
        }

        const newData = {};
        for (const [yr, file] of yearFileMap) {
          const hasPeriods = (file.data?.periods?.length || 0) > 0;
          const sumColAmounts = buildSumColAmounts(file.data?.periods || []);
          const rows = hasPeriods
            ? (file.data.rows || []).map(sumColAmounts)
            : (file.data.rows || []);
          newData[yr] = extractEbitdaFromManualPLRows(rows, file.data?.asOfDate || null);
        }

        // Sort years newest → oldest to match QuickBooks column order
        const newYears = Array.from(yearFileMap.keys()).sort((a, b) => b - a);
        if (activeSourceRef.current !== requestSource) return;
        setYears(newYears);
        setMultiYearData(newData);
        if (ebitdaCacheKey) {
          try { sessionStorage.setItem(ebitdaCacheKey, JSON.stringify({ multiYearData: newData, years: newYears })); } catch { /* quota exceeded */ }
        }
      } else if (isQBManual) {
        // QuickBooks Manual: read all synced P&L files from qb_synced_reports
        const result = await getAllQMSUploadedReports("profit_and_loss", { clientId });
        const files = (result?.files || []).filter((f) => f.data?.rows?.length);

        if (!files.length) {
          throw new Error("No P&L reports found. Please sync your Quickbooks Manual Source folder first.");
        }

        const detectFileYear = (file) => {
          const data = file.data || {};
          const dateSrc = data.asOfDate || data.periodEnd || data.periodStart;
          if (dateSrc) {
            const parsed = parseInt(String(dateSrc).split("-")[0], 10);
            if (parsed >= 2000 && parsed <= currentYear + 1) return parsed;
          }
          const yearInName = (file.fileName || "").match(/\b(20\d{2})\b/);
          if (yearInName) return parseInt(yearInName[1], 10);
          return currentYear;
        };

        const buildSumColAmounts = (periods) => {
          const totalIdx = (periods || []).findIndex((p) => /^total$/i.test(String(p).trim()));
          const getVal = (colAmounts) => {
            if (!Array.isArray(colAmounts) || colAmounts.length === 0) return 0;
            return totalIdx >= 0
              ? (colAmounts[totalIdx] || 0)
              : colAmounts.reduce((s, v) => s + (v || 0), 0);
          };
          const sumColAmounts = (node) => ({
            ...node,
            amount: getVal(node.colAmounts) || (node.amount || 0),
            children: node.children ? node.children.map(sumColAmounts) : undefined,
          });
          return sumColAmounts;
        };

        const yearFileMap = new Map();
        for (const file of files) {
          const yr = detectFileYear(file);
          const existing = yearFileMap.get(yr);
          if (!existing || new Date(file.updatedAt || 0) > new Date(existing.updatedAt || 0)) {
            yearFileMap.set(yr, file);
          }
        }

        const newData = {};
        for (const [yr, file] of yearFileMap) {
          const hasPeriods = (file.data?.periods?.length || 0) > 0;
          const sumColAmounts = buildSumColAmounts(file.data?.periods || []);
          const rows = hasPeriods
            ? (file.data.rows || []).map(sumColAmounts)
            : (file.data.rows || []);
          newData[yr] = extractEbitdaFromManualPLRows(rows, file.data?.asOfDate || null);
        }

        const newYears = Array.from(yearFileMap.keys()).sort((a, b) => b - a);
        if (activeSourceRef.current !== requestSource) return;
        setYears(newYears);
        setMultiYearData(newData);
        if (ebitdaCacheKey) {
          try { sessionStorage.setItem(ebitdaCacheKey, JSON.stringify({ multiYearData: newData, years: newYears })); } catch { /* quota exceeded */ }
        }
      } else {
        // QuickBooks: fetch per-year
        const todayStr = new Date().toISOString().split("T")[0];
        const yearList = [currentYear, currentYear - 1, currentYear - 2, currentYear - 3];
        setYears(yearList);

        const results = {};
        await Promise.all(
          yearList.map(async (year) => {
            const sy = `${year}-01-01`;
            const ey = year === currentYear ? todayStr : `${year}-12-31`;
            try {
              results[year] = await getEbitdaData(sy, ey, accountingMethod);
            } catch {
              results[year] = null;
            }
          })
        );
        if (activeSourceRef.current !== requestSource) return;
        setMultiYearData(results);
        if (ebitdaCacheKey) {
          try { sessionStorage.setItem(ebitdaCacheKey, JSON.stringify({ multiYearData: results, years: yearList })); } catch { /* quota exceeded */ }
        }
      }
    } catch (err) {
      if (activeSourceRef.current !== requestSource) return;
      setError(err?.message || "Failed to fetch EBITDA data. Please try again.");
      setMultiYearData(null);
    } finally {
      if (activeSourceRef.current === requestSource) setIsLoading(false);
    }
  }, [isManualGl, isManualUpload, isQBManual, clientId, ebitdaCacheKey, accountingMethod, selectedVersion]);

  useEffect(() => {
    handleGenerate(isManualUpload || isQBManual);
  }, [handleGenerate]);

  // When the selected Manual GL version changes, discard any cached result and
  // re-generate so EBITDA always reflects the chosen version's transactions.
  const prevVersionRef = useRef(selectedVersion);
  useEffect(() => {
    if (!isManualGl) return;
    if (prevVersionRef.current === selectedVersion) return;
    prevVersionRef.current = selectedVersion;
    if (!selectedVersion) return;
    // Bust the old cache entry so handleGenerate doesn't serve stale data.
    if (ebitdaCacheKey) {
      try { sessionStorage.removeItem(ebitdaCacheKey); } catch { /* ignore */ }
    }
    setMultiYearData(null);
    setYears([]);
    setIsDataInitialized(false);
    setError("");
  }, [isManualGl, selectedVersion, ebitdaCacheKey]);

  // Handle Dynamic Addbacks Initialization and Persistence
  useEffect(() => {
    if (!multiYearData || isDataInitialized) return;

    const storageKey = `ebitda_addbacks_${clientId}`;
    const saved = localStorage.getItem(storageKey);

    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        const savedAddbacks = Array.isArray(parsed) ? parsed : (parsed.addbacks || []);

        // Step 6: Multi-Year Handling - Store per-year apiValue
        const initialized = savedAddbacks.map(ab => {
          const inferredType = ab.type || (ab.linkedToPL ? "PL" : "RECAST");
          const isFromPL = inferredType === "PL";
          const normalizedLabel = (ab.label || "").trim();
          const vals = {};
          Object.keys(multiYearData).forEach(year => {
            const apiVal = isFromPL ? getValueFromPL(year, normalizedLabel) : null;
            const existing = ab.values?.[year] || {};
            vals[year] = {
              apiValue: apiVal,
              userValue: existing.userValue !== undefined ? existing.userValue : (existing.apiValue !== undefined ? null : null)
            };
            // If it was old format (just number), migrate it to userValue
            if (typeof existing === 'number') {
              vals[year].userValue = existing;
            }
          });
          const latestYear = years[0] || Object.keys(multiYearData)[0];
          const latestVals = vals[latestYear] || { apiValue: null, userValue: null };
          return {
            ...ab,
            type: inferredType,
            label: normalizedLabel,
            isFromPL,
            accountId: ab.accountId || (isFromPL ? getAccountIdByLabel(normalizedLabel) : null),
            linkedToPL: isFromPL,
            value: latestVals.userValue !== null ? latestVals.userValue : latestVals.apiValue,
            values: vals,
          };
        });

        setDynamicAddbacks(initialized);
        if (parsed.sdePerCim) setSdePerCim(parsed.sdePerCim);
        if (parsed.rowComments) setRowComments(parsed.rowComments);
        setIsDataInitialized(true);
        return;
      } catch (e) {
        console.error("Failed to parse saved addbacks", e);
      }
    }

    // Step 1: Core Requirement - DO NOT introduce any static/default values in code
    // Starting with empty addbacks or previously saved ones only.
    setDynamicAddbacks([]);
    setIsDataInitialized(true);
  }, [multiYearData, clientId, isDataInitialized, getValueFromPL, years, getAccountIdByLabel]);

  // Persistent saving
  useEffect(() => {
    if (isDataInitialized && clientId) {
      localStorage.setItem(`ebitda_addbacks_${clientId}`, JSON.stringify({
        addbacks: dynamicAddbacks,
        sdePerCim: sdePerCim,
        rowComments: rowComments
      }));
    }
  }, [dynamicAddbacks, sdePerCim, rowComments, clientId, isDataInitialized]);

  const handleAddAddback = ({ type, accountLabel = "" } = {}) => {
    const newId = `custom_${Date.now()}`;
    const newVals = {};
    const isPL = type === "PL";
    const label = isPL ? accountLabel : "";

    years.forEach(year => {
      const apiVal = isPL && label ? getValueFromPL(year, label) : null;
      newVals[year] = {
        apiValue: apiVal,
        userValue: null
      };
    });

    const latestYear = years[0];
    const latestVals = newVals[latestYear] || { apiValue: null, userValue: null };

    setDynamicAddbacks([...dynamicAddbacks, {
      id: newId,
      type: isPL ? "PL" : "RECAST",
      label,
      value: latestVals.userValue !== null ? latestVals.userValue : latestVals.apiValue,
      isFromPL: isPL,
      accountId: isPL && label ? getAccountIdByLabel(label) : null,
      values: newVals,
      isUserAdded: true,
      linkedToPL: isPL
    }]);
  };

  const updateAddbackValue = (id, year, value) => {
    setDynamicAddbacks(prev => prev.map(ab => {
      if (ab.id === id) {
        const normalizedInput = typeof value === "string" ? value.replace(/[\*,]/g, "").trim() : value;
        const numericValue = normalizedInput === "" ? null : Number(normalizedInput);
        const latestYear = years[0];
        const nextValues = {
          ...ab.values,
          [year]: {
            ...ab.values[year],
            userValue: numericValue
          }
        };
        const latestVals = nextValues[latestYear] || { apiValue: null, userValue: null };
        return {
          ...ab,
          value: latestVals.userValue !== null ? latestVals.userValue : latestVals.apiValue,
          values: nextValues
        };
      }
      return ab;
    }));
  };

  const updateAddbackLabel = (id, label) => {
    setDynamicAddbacks(prev => prev.map(ab => {
      if (ab.id === id) {
        const newValues = { ...ab.values };
        const apiMatch = getValueFromPL(years[0], label);
        const isLinked = apiMatch !== null;
        years.forEach(year => {
          newValues[year] = {
            ...newValues[year],
            apiValue: getValueFromPL(year, label)
          };
        });
        const latestYear = years[0];
        const latestVals = newValues[latestYear] || { apiValue: null, userValue: null };
        return {
          ...ab,
          label,
          type: isLinked ? "PL" : "RECAST",
          isFromPL: isLinked,
          accountId: isLinked ? getAccountIdByLabel(label) : null,
          value: latestVals.userValue !== null ? latestVals.userValue : latestVals.apiValue,
          values: newValues,
          linkedToPL: isLinked,
        };
      }
      return ab;
    }));
  };

  const handleAccountSelection = (id, selectedValue) => {
    setDynamicAddbacks(prev => prev.map(ab => {
      if (ab.id === id) {
        const newValues = { ...ab.values };
        years.forEach(year => {
          newValues[year] = {
            ...newValues[year],
            apiValue: getValueFromPL(year, selectedValue),
            userValue: null
          };
        });
        const latestYear = years[0];
        const latestVals = newValues[latestYear] || { apiValue: null, userValue: null };
        return {
          ...ab,
          type: "PL",
          label: selectedValue,
          isFromPL: true,
          accountId: getAccountIdByLabel(selectedValue),
          value: latestVals.userValue !== null ? latestVals.userValue : latestVals.apiValue,
          linkedToPL: true,
          values: newValues,
        };
      }
      return ab;
    }));
  };

  const deleteAddback = (id) => {
    setDynamicAddbacks(prev => prev.filter(ab => ab.id !== id));
  };

  const updateRowComment = (key, value) => {
    setRowComments(prev => ({
      ...prev,
      [key]: value
    }));
  };


  const handleSync = async () => {
    setIsSyncing(true);
    if (ebitdaCacheKey) {
      try { sessionStorage.removeItem(ebitdaCacheKey); } catch { /* ignore */ }
    }
    try {
      if (isQBManual) {
        // Re-sync all QMS files so the latest parser fixes apply, then re-fetch EBITDA.
        await syncQMSUploadSource({ clientId });
      } else if (!isManualMode) {
        await refreshQuickbooksToken();
      }
      await handleGenerate(true);
    } catch {
      setError("Sync failed. Please try again.");
    } finally {
      setIsSyncing(false);
    }
  };


  return (
    <div className="page-container">
      <div className="page-content">
        {/* Header */}
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-[#050505]">
              EBITDA Analysis
            </h1>
            <p className="mt-1 text-[13px] text-text-muted">
              {isManualGl
                ? `Powered by staged GL data${company?.name ? ` — ${company.name}` : ""}`
                : isManualUpload
                  ? `Powered by your uploaded Profit & Loss file${company?.name ? ` — ${company.name}` : ""}`
                  : isQBManual
                    ? `Powered by your QuickBooks Manual P&L reports${company?.name ? ` — ${company.name}` : ""}`
                    : `Dynamic earnings analysis powered by your Profit & Loss data${company?.name ? ` — ${company.name}` : ""}`}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {/* Version selector — Manual GL only */}
            {isManualGl && glVersions.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <label className="text-[12px] font-medium uppercase tracking-wider text-text-muted">
                  Version
                </label>
                <div className="relative">
                  <select
                    value={selectedVersion ? String(selectedVersion) : ""}
                    onChange={(e) => setSelectedVersion(e.target.value || null)}
                    className="h-9 w-full min-w-[160px] appearance-none rounded-md border border-border-input bg-bg-card pl-3 pr-9 text-[13px] text-text-primary transition-all focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                  >
                    {glVersions.map((v) => (
                      <option key={String(v.value)} value={String(v.value)}>
                        {v.label || `Version ${v.value}`}{v.isActive ? " (active)" : ""}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={14} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
                </div>
              </div>
            )}
            <button
              onClick={handleSync}
              disabled={isSyncing || isLoading}
              className="btn-secondary"
            >
              <RefreshCw
                size={16}
                className={isSyncing ? "animate-spin" : ""}
              />
              {isSyncing ? "Refreshing..." : "Refresh"}
            </button>
          </div>
        </div>

        <QBDisconnectedBanner pageName="EBITDA Analysis" />

        {/* Content */}
        {isLoading ? (
          <LoadingState />
        ) : error && !multiYearData ? (
          <div className="flex flex-col gap-4">
            <EmptyStateNotification error={error} onRetry={handleGenerate} />
            <EmptyEbitdaTable companyName={company?.name} />
          </div>
        ) : multiYearData ? (
          <div className="animate-in slide-in-from-bottom-2 fade-in duration-300">
            {/*
              Unified Data + Comments Table
              ─────────────────────────────
              Both data columns and comment inputs live in the SAME <tr>.
              The browser's table-layout engine guarantees every cell in a row
              shares the same height — no hardcoded pixel heights, no JS sync.
              This works identically for QB, Xero, manual upload, cached data,
              and any future connection mode.
            */}
            <div className="overflow-hidden rounded-xl border border-[#cbd5e1] bg-white shadow-lg">
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-[14px]">
                  <thead>
                    {/* ── Dual panel titles ───────────────────────────── */}
                    <tr>
                      <th
                        colSpan={1 + years.length}
                        className="bg-[#8bc53d] py-3 text-center"
                      >
                        <span className="text-[18px] font-bold text-white">
                          Recalculated Seller&apos;s Discretionary Earnings of {company?.name || "the Business"}
                        </span>
                      </th>
                      <th
                        className="bg-[#8bc53d] py-3 text-center min-w-[280px]"
                        style={{ borderLeft: "3px solid rgba(255,255,255,0.35)" }}
                      >
                        <span className="text-[18px] font-bold text-white">Comments</span>
                      </th>
                    </tr>
                    {/* ── Year label sub-headers ──────────────────────── */}
                    <tr className="bg-[#8bc53d] text-white">
                      <th className="border-b border-[#cbd5e1] p-3 text-left font-bold min-w-[280px]"></th>
                      {years.map(year => (
                        <th key={year} className="border-b border-[#cbd5e1] p-3 text-right font-bold min-w-[120px]">
                          FY {year}
                        </th>
                      ))}
                      <th
                        className="border-b border-[#cbd5e1] p-3 min-w-[280px]"
                        style={{ borderLeft: "3px solid rgba(255,255,255,0.35)" }}
                      ></th>
                    </tr>
                  </thead>

                  <tbody>
                    {/* ── Net Income ──────────────────────────────────── */}
                    <tr className="border-b border-[#cbd5e1] bg-gray-50">
                      <td className="p-3 font-bold text-[#050505]">Net Income</td>
                      {years.map(year => (
                        <td key={year} className="p-3 text-right font-bold text-[#050505]">
                          {formatCurrency(multiYearData[year]?.components?.netIncome?.value)}
                        </td>
                      ))}
                      <td className="p-1 bg-gray-50" style={{ borderLeft: "2px solid #cbd5e1" }}>
                        <input
                          value={rowComments['netIncome'] || ""}
                          onChange={(e) => updateRowComment('netIncome', e.target.value)}
                          placeholder="Net income remarks..."
                          className="w-full bg-transparent border-none focus:ring-0 text-[13px] px-3 placeholder:italic text-slate-600"
                        />
                      </td>
                    </tr>

                    {/* ── EBITDA Adjustments ──────────────────────────── */}
                    {[
                      { key: 'interestIncome', label: 'Total Interest Income' },
                      { key: 'interestExpense', label: 'Total Interest Expense' },
                      { key: 'taxes', label: 'Total Income Tax Expense' },
                      { key: 'depreciation', label: 'Depreciation' },
                      { key: 'amortization', label: 'Amortization Expense' },
                    ].map(row => (
                      <tr key={row.key} className="border-b border-[#f1f5f9] hover:bg-slate-50 transition-colors">
                        <td className="p-3 pl-8 text-text-primary">{row.label}</td>
                        {years.map(year => (
                          <td key={year} className="p-3 text-right text-text-primary">
                            {formatCurrency(multiYearData[year]?.components?.[row.key]?.value)}
                          </td>
                        ))}
                        <td className="p-1" style={{ borderLeft: "2px solid #f1f5f9" }}>
                          <input
                            value={rowComments[row.key] || ""}
                            onChange={(e) => updateRowComment(row.key, e.target.value)}
                            placeholder={`${row.label} remarks...`}
                            className="w-full bg-transparent border-none focus:ring-0 text-[13px] px-3 placeholder:italic text-slate-600"
                          />
                        </td>
                      </tr>
                    ))}

                    {/* ── EBITDA Total ─────────────────────────────────── */}
                    <tr className="bg-[#f8fafc] border-y border-[#cbd5e1]">
                      <td className="p-3 pl-4 font-bold text-[#050505]">EBITDA</td>
                      {years.map(year => {
                        const ebitdaVal = calculateBaseEbitda(year);
                        return (
                          <td key={year} className="p-3 text-right font-bold text-[#050505]">
                            {formatCurrency(ebitdaVal)}
                          </td>
                        );
                      })}
                      <td className="p-1 bg-[#f8fafc]" style={{ borderLeft: "2px solid #cbd5e1" }}>
                        <input
                          value={rowComments['ebitda'] || ""}
                          onChange={(e) => updateRowComment('ebitda', e.target.value)}
                          placeholder="EBITDA remarks..."
                          className="w-full bg-transparent border-none font-bold focus:ring-0 text-[13px] px-3 placeholder:italic placeholder:font-normal text-slate-800"
                        />
                      </td>
                    </tr>

                    {/* ── Addbacks Section Header ──────────────────────── */}
                    <tr className="bg-gray-100">
                      <td colSpan={1 + years.length} className="p-0">
                        <div className="px-4 py-3">
                          <div className="flex items-center justify-between font-bold text-[#050505]">
                            <span>Addbacks</span>
                            <button
                              onClick={() => setIsTypeDialogOpen(true)}
                              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[#8bc53d] text-white text-[11px] font-bold hover:bg-[#78ab34] transition-colors"
                            >
                              <Plus size={12} strokeWidth={3} />
                              ADD ROW
                            </button>
                          </div>
                          <p className="mt-1 text-[11px] text-slate-500">
                            * Values marked with an asterisk (*) are automatically fetched from the Profit &amp; Loss statement. Values without (*) are manually added.
                          </p>
                        </div>
                      </td>
                      {/* Comment cell for the Addbacks header — intentionally blank */}
                      <td className="bg-gray-100" style={{ borderLeft: "2px solid #cbd5e1" }}></td>
                    </tr>

                    {/* ── Dynamic Addback Rows ─────────────────────────── */}
                    {dynamicAddbacks.map((row) => (
                      <tr key={row.id} className="group border-b border-[#f1f5f9] hover:bg-slate-50 transition-colors">
                        <td className="p-3 pl-6 text-text-primary">
                          <div className="flex items-center gap-2">
                            {row.type === "PL" ? (
                              <div className="relative flex-1">
                                <select
                                  value={row.label}
                                  onChange={(e) => handleAccountSelection(row.id, e.target.value)}
                                  className="appearance-none w-full bg-transparent border-b border-transparent hover:border-gray-300 focus:border-[#8bc53d] focus:outline-none transition-all py-0.5 pr-5 text-[13px] cursor-pointer"
                                >
                                  <option value="" disabled>Select account...</option>
                                  {plAccountNames.map(name => (
                                    <option key={name} value={name}>{name}</option>
                                  ))}
                                </select>
                                <ChevronDown size={11} className="pointer-events-none absolute right-0 top-1/2 -translate-y-1/2 text-slate-400" />
                              </div>
                            ) : (
                              <input
                                value={row.label}
                                onChange={(e) => updateAddbackLabel(row.id, e.target.value)}
                                className="flex-1 bg-transparent border-b border-transparent hover:border-gray-300 focus:border-[#8bc53d] focus:outline-none transition-all py-0.5 text-[13px]"
                                placeholder="Enter label…"
                              />
                            )}
                            <button
                              onClick={() => deleteAddback(row.id)}
                              className="opacity-0 group-hover:opacity-100 p-1 text-red-500 hover:bg-red-50 rounded transition-all flex-shrink-0"
                              title="Delete Row"
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </td>
                        {years.map((year) => {
                          const { apiValue, userValue } = row.values[year] || { apiValue: null, userValue: null };
                          const valToFormat = userValue !== null ? userValue : apiValue;
                          const formattedValue = formatCurrency(valToFormat);
                          const showPLAsterisk = Boolean(
                            row.isFromPL &&
                            row.linkedToPL &&
                            userValue === null &&
                            apiValue !== null
                          );
                          const displayValue =
                            showPLAsterisk && formattedValue !== "-" && !formattedValue.startsWith("*")
                              ? `*${formattedValue}`
                              : formattedValue;

                          return (
                            <td key={year} className="p-1.5 text-right">
                              <FormattedNumericInput
                                value={userValue}
                                apiValue={apiValue}
                                isFromPL={row.isFromPL}
                                linkedToPL={row.linkedToPL}
                                onChange={(val) => updateAddbackValue(row.id, year, val)}
                                title={showPLAsterisk ? "This value is sourced from Profit & Loss" : undefined}
                              />
                            </td>
                          );
                        })}
                        <td className="p-1" style={{ borderLeft: "2px solid #f1f5f9" }}>
                          <input
                            value={rowComments[row.id] || ""}
                            onChange={(e) => updateRowComment(row.id, e.target.value)}
                            placeholder={`${row.label || "Addback"} remarks...`}
                            className="w-full bg-transparent border-none focus:ring-0 text-[13px] px-3 placeholder:italic text-slate-600"
                          />
                        </td>
                      </tr>
                    ))}

                    {/* ── Seller's Discretionary Earnings ─────────────── */}
                    <tr className="border-t-2 border-[#8bc53d] bg-[#f8fafc]">
                      <td className="p-4 font-bold text-[#050505] text-[15px]">Seller's Discretionary Earnings</td>
                      {years.map(year => {
                        const baseEbitda = calculateBaseEbitda(year);
                        const addbacksSum = dynamicAddbacks.reduce((sum, ab) => {
                          const { apiValue, userValue } = ab.values[year] || { apiValue: null, userValue: null };
                          const val = userValue !== null ? userValue : (apiValue || 0);
                          return sum + val;
                        }, 0);
                        const finalSde = baseEbitda + addbacksSum;
                        return (
                          <td key={year} className="p-4 text-right font-bold text-[#8bc53d] text-[16px]">
                            {formatCurrency(finalSde)}
                          </td>
                        );
                      })}
                      <td className="p-2 bg-[#f8fafc]" style={{ borderLeft: "2px solid #8bc53d" }}>
                        <textarea
                          value={rowComments['totalSde'] || ""}
                          onChange={(e) => updateRowComment('totalSde', e.target.value)}
                          placeholder="Story of Seller's Discretionary Earnings..."
                          className="w-full bg-transparent border-none focus:ring-0 text-[12px] px-2 leading-tight resize-none overflow-hidden placeholder:italic font-semibold text-slate-800"
                          rows={2}
                        />
                      </td>
                    </tr>

                    {/* ── SDE % of Sales ───────────────────────────────── */}
                    <tr className="border-b border-[#cbd5e1] bg-white">
                      <td className="p-3 font-bold text-[#050505]">SDE % of Sales</td>
                      {years.map(year => {
                        const baseEbitda = calculateBaseEbitda(year);
                        const addbacksSum = dynamicAddbacks.reduce((sum, ab) => {
                          const { apiValue, userValue } = ab.values[year] || { apiValue: null, userValue: null };
                          const val = userValue !== null ? userValue : (apiValue || 0);
                          return sum + val;
                        }, 0);
                        const finalSde = baseEbitda + addbacksSum;
                        const revenue = multiYearData[year]?.revenue || 0;
                        const sdePct = revenue > 0 ? (finalSde / revenue) * 100 : 0;
                        return (
                          <td key={year} className="p-3 text-right font-bold text-text-primary">
                            {formatPercent(sdePct)}
                          </td>
                        );
                      })}
                      <td className="p-1 bg-white" style={{ borderLeft: "2px solid #cbd5e1" }}>
                        <input
                          value={rowComments['sdePercent'] || ""}
                          onChange={(e) => updateRowComment('sdePercent', e.target.value)}
                          placeholder="Margin analysis..."
                          className="w-full bg-transparent border-none focus:ring-0 text-[13px] px-3 placeholder:italic text-slate-600"
                        />
                      </td>
                    </tr>

                  </tbody>
                </table>
              </div>
            </div>

            {/* Summary Analysis Box */}
            <div className="flex justify-start mt-8 pb-12">
              <div className="rounded-xl border border-[#cbd5e1] p-0 overflow-hidden bg-white shadow-lg max-w-md w-full">
                <div className="border-b border-[#cbd5e1] bg-[#8bc53d] p-3 px-4 font-bold text-white text-[15px]">
                  Summary Analysis
                </div>
                <div className="p-8 space-y-6">
                  <div className="flex justify-between items-center bg-gray-50 border border-gray-100 rounded-lg p-3">
                    <span className="font-bold text-slate-800">SDE Per CIM</span>
                    <FormattedNumericInput
                      value={sdePerCim || null}
                      apiValue={null}
                      onChange={(val) => setSdePerCim(val)}
                      placeholder="Enter value..."
                      className="w-32 bg-white border border-gray-200"
                    />
                  </div>

                  {(() => {
                    const latestYear = years[0];
                    const baseEbitda = calculateBaseEbitda(latestYear);
                    const addbacksSum = dynamicAddbacks.reduce((sum, ab) => {
                      const { apiValue, userValue } = ab.values[latestYear] || { apiValue: null, userValue: null };
                      const val = userValue !== null ? userValue : (apiValue || 0);
                      return sum + val;
                    }, 0);
                    const currentSde = baseEbitda + addbacksSum;
                    const cimVal = Number(sdePerCim) || 0;
                    const diff = currentSde - cimVal;
                    const pctDiff = cimVal !== 0 ? (diff / cimVal) * 100 : 0;

                    return (
                      <>
                        <div className="flex justify-between items-center border-b border-gray-100 pb-3">
                          <span className="font-bold text-slate-800">$ Difference</span>
                          <span className={cn("font-mono font-bold text-[15px]", diff < 0 ? "text-red-500" : "text-green-600")}>
                            {cimVal ? formatCurrency(diff) : "-"}
                          </span>
                        </div>
                        <div className="flex justify-between items-center">
                          <span className="font-bold text-slate-800">% Difference</span>
                          <span className={cn("font-mono font-bold text-[15px]", pctDiff < 0 ? "text-red-500" : "text-green-600")}>
                            {cimVal ? formatPercent(pctDiff) : "-"}
                          </span>
                        </div>
                      </>
                    );
                  })()}
                </div>
              </div>
            </div>
          </div>
        ) : (
          <EmptyState />
        )}

        <Modal
          isOpen={isTypeDialogOpen}
          onClose={() => setIsTypeDialogOpen(false)}
          title="Select Addback Type"
          size="sm"
        >
          <div className="space-y-2">
            <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-border px-4 py-3 text-[13px] font-semibold text-text-primary hover:bg-bg-page transition-colors">
              <input
                type="radio"
                name="addback-type"
                className="h-4 w-4 accent-[#8bc53d]"
                disabled={plAccountNames.length === 0}
                onChange={() => {
                  handleAddAddback({ type: "PL" });
                  setIsTypeDialogOpen(false);
                }}
              />
              Profit &amp; Loss
            </label>
            <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-border px-4 py-3 text-[13px] font-semibold text-text-primary hover:bg-bg-page transition-colors">
              <input
                type="radio"
                name="addback-type"
                className="h-4 w-4 accent-[#8bc53d]"
                onChange={() => {
                  handleAddAddback({ type: "RECAST" });
                  setIsTypeDialogOpen(false);
                }}
              />
              Recast Addback
            </label>
            {plAccountNames.length === 0 && (
              <p className="text-[12px] text-text-muted">
                Profit &amp; Loss accounts are unavailable for the selected range.
              </p>
            )}
          </div>
        </Modal>
      </div>
    </div>
  );
}


