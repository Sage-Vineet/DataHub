import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { useParams } from "react-router-dom";
import {
  TrendingUp,
  AlertCircle,
  ChevronDown,
} from "lucide-react";
import { formatCurrency } from "../../../lib/utils";
import {
  getCompanyRequest,
  getAllManualUploadedReports,
  getAllQMSUploadedReports,
  getManualStageFilterOptions,
  listManualGlDatasetVersions,
  uploadFile,
  saveEbitdaAdjustmentsBatch,
  deleteEbitdaAdjustment,
  generateEbitdaComments,
  listEbitdaAdjustmentTypes,
} from "../../../lib/api";
import {
  getEbitdaData,
  extractEbitdaFromManualPLRows,
} from "../../../services/ebitdaService";
import {
  loadAdjustmentWorkspaceData,
  loadVendorReferenceData,
} from "../../../services/ebitdaAdjustmentService";
import { getProfitMetricConfig } from "../../../lib/profitMetric";
import { REPORT_SOURCE_KEYS, normalizeReportSourceKey } from "../../../lib/report-source";
import QBDisconnectedBanner from "../../../components/common/QBDisconnectedBanner";
import EbitdaAdjustmentsPanel from "../../../components/reports/ebitda/EbitdaAdjustmentsPanel";
import { useDataSource } from "../../../context/DataSourceContext";
import { useKeyReportContextStore, selectKeyReportContext } from "../../../store/useKeyReportContextStore";
import { useShallow } from "zustand/react/shallow";
import KeyReportVersionSelector from "../../../components/key-reports/KeyReportVersionSelector";

function toNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;
  const numeric = typeof value === "number" ? value : Number(String(value).replace(/,/g, ""));
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toAbsoluteNumber(value, fallback = 0) {
  return Math.abs(toNumber(value, fallback));
}

function hasUsableEbitdaData(multiYearData) {
  if (!multiYearData || typeof multiYearData !== "object") return false;
  return Object.values(multiYearData).some((entry) => entry && typeof entry === "object");
}

function EmptyState({ analysisLabel = "EBITDA Analysis" }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-border bg-bg-page/50 py-16">
      <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10">
        <TrendingUp size={28} className="text-primary" />
      </div>
      <h3 className="text-[16px] font-semibold text-text-primary">
        Generate {analysisLabel}
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

function buildEmptyTableRows(labels) {
  return [
    { label: 'Net Income', indent: false, bold: true, shade: 'bg-gray-50' },
    { label: 'Total Interest Income', indent: true, bold: false, shade: '' },
    { label: 'Total Interest Expense', indent: true, bold: false, shade: '' },
    { label: 'Total Income Tax Expense', indent: true, bold: false, shade: '' },
    { label: 'Depreciation', indent: true, bold: false, shade: '' },
    { label: 'Amortization Expense', indent: true, bold: false, shade: '' },
    { label: 'EBITDA', indent: false, bold: true, shade: 'bg-[#f8fafc]' },
    { label: labels?.sectionLabel || 'Addbacks', indent: false, bold: true, shade: 'bg-gray-100' },
    { label: labels?.finalRowLabel || "Seller's Discretionary Earnings", indent: false, bold: true, shade: 'bg-gray-50' },
    { label: labels?.percentRowLabel || 'SDE % of Sales', indent: false, bold: false, shade: '' },
  ];
}

function EmptyEbitdaTable({ companyName, profitMetricConfig }) {
  const rows = buildEmptyTableRows(profitMetricConfig);
  return (
    <div className="flex gap-6 items-start">
      <div className="flex-1 overflow-hidden rounded-xl border border-[#cbd5e1] bg-white shadow-lg">
        <div className="bg-[#8bc53d] py-3 text-center">
          <h2 className="text-[18px] font-bold text-white">
            {profitMetricConfig?.headerLead || "Recalculated Seller's Discretionary Earnings"} of {companyName || 'the Business'}
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
              {rows.map((row) => (
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

function LoadingState({ metricLabel = 'EBITDA' }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-border bg-bg-page/50 py-16">
      <div className="mb-4 h-12 w-12 animate-spin rounded-full border-4 border-border border-t-primary" />
      <p className="animate-pulse text-[13px] font-medium text-text-muted">
        Analyzing financial data & computing {metricLabel}…
      </p>
    </div>
  );
}


/* ------------------------------------------------------------------ */
/*  Helpers & Sub-components                                         */
/* ------------------------------------------------------------------ */

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:4000";

export default function WorkspaceEbitda() {
  const { clientId } = useParams();
  const { activeSource, activeSourceMode } = useDataSource();
  const kr = useKeyReportContextStore(useShallow(selectKeyReportContext));

  const accountingMethod = "Accrual";

  const reportSource = kr.krActive && kr.effectiveSource
    ? kr.effectiveSource
    : normalizeReportSourceKey(activeSource || REPORT_SOURCE_KEYS.QUICKBOOKS);
  const isManualGl = reportSource === REPORT_SOURCE_KEYS.MANUAL_GL;
  const isManualUpload = reportSource === REPORT_SOURCE_KEYS.MANUAL_UPLOAD;
  const isQBManual = reportSource === REPORT_SOURCE_KEYS.QUICKBOOKS_MANUAL;

  const [multiYearData, setMultiYearData] = useState(null);
  const [years, setYears] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [company, setCompany] = useState(null);
  const [dynamicAddbacks, setDynamicAddbacks] = useState([]);
  const [isDataInitialized, setIsDataInitialized] = useState(false);
  const [rowComments, setRowComments] = useState({});
  const [isGeneratingComments, setIsGeneratingComments] = useState(false);
  const [isSavingNonGlAdjustment, setIsSavingNonGlAdjustment] = useState(false);
  const [manualGlAdjustments, setManualGlAdjustments] = useState([]);
  const [manualGlAdjustmentTypes, setManualGlAdjustmentTypes] = useState([]);
  const [manualGlReferenceIndex, setManualGlReferenceIndex] = useState(null);
  const [manualGlAdjustmentError, setManualGlAdjustmentError] = useState("");
  const [isSavingAdjustment, setIsSavingAdjustment] = useState(false);
  const profitMetricConfig = useMemo(() => getProfitMetricConfig(company), [company]);
  const analysisLabel = profitMetricConfig.analysisLabel;
  const itemSingularLabel = profitMetricConfig.itemSingularLabel;
  const itemPluralLabel = profitMetricConfig.itemPluralLabel;

  // Dataset version selection removed — consolidated into Key Reports.
  const selectedVersion = kr.resolvedDatasetVersion;

  const activeSourceRef = useRef(reportSource);
  // Tracks the currently-selected version so an in-flight request for a
  // previous version can be discarded if the user switches mid-fetch
  // (last-write-wins guard — prevents stale-version data overwriting fresh).
  const latestVersionRef = useRef(selectedVersion);
  const prevReportSourceForClearRef = useRef(reportSource);
  const adjustmentLoadTokenRef = useRef(0);

  useEffect(() => {
    activeSourceRef.current = reportSource;
  }, [reportSource]);

  useEffect(() => {
    latestVersionRef.current = selectedVersion;
  }, [selectedVersion]);

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

  const getAccountIdByLabel = useCallback(
    (label) => {
      const match = plAccountOptions.find((option) => option.label === label);
      return match?.accountId || null;
    },
    [plAccountOptions]
  );

  // Step 1: Dynamic Extraction Function
  const getValueFromPL = useCallback((year, label) => {
    const flatRows = multiYearData?.[year]?._debug?.flatRows;
    if (!flatRows || !label) return null;

    const searchLabel = label.toLowerCase().trim();
    // Match label dynamically using row names from API
    const match = flatRows.find(row =>
      row.label?.toLowerCase().trim() === searchLabel ||
      row.AccountName?.toLowerCase().trim() === searchLabel
    );

    return match ? toAbsoluteNumber(match.value, 0) : null;
  }, [multiYearData]);

  const calculateBaseEbitda = useCallback((year) => {
    const cached = toNumber(multiYearData?.[year]?.ebitda, NaN);
    if (Number.isFinite(cached)) return cached;
    const comps = multiYearData?.[year]?.components;
    if (!comps) return 0;
    return toNumber(comps.netIncome?.value, 0)
      - toNumber(comps.interestIncome?.value, 0)
      + toNumber(comps.interestExpense?.value, 0)
      + toNumber(comps.taxes?.value, 0)
      + toNumber(comps.depreciation?.value, 0)
      + toNumber(comps.amortization?.value, 0);
  }, [multiYearData]);

  const adjustmentVersionId = isManualGl
    ? (selectedVersion ? String(selectedVersion) : "")
    : reportSource;

  const adjustmentScope = useMemo(() => ({
    clientId,
    versionId: adjustmentVersionId,
    sourceKey: reportSource,
  }), [adjustmentVersionId, clientId, reportSource]);

  const baseEbitdaByYear = useMemo(() => {
    return Object.fromEntries(
      (years || []).map((year) => [String(year), calculateBaseEbitda(year)]),
    );
  }, [calculateBaseEbitda, years]);

  const revenueByYear = useMemo(() => {
    return Object.fromEntries(
      (years || []).map((year) => [String(year), multiYearData?.[year]?.revenue || 0]),
    );
  }, [multiYearData, years]);

  const adjustmentAccountOptions = useMemo(() => {
    return manualGlReferenceIndex?.accountOptions?.length
      ? manualGlReferenceIndex.accountOptions
      : plAccountOptions;
  }, [manualGlReferenceIndex, plAccountOptions]);

  const adjustmentVendorOptions = useMemo(() => {
    return manualGlReferenceIndex?.vendorOptions?.length
      ? manualGlReferenceIndex.vendorOptions
      : [];
  }, [manualGlReferenceIndex]);

  const fallbackAdjustmentLookup = useCallback(
    (year, label) => getValueFromPL(year, label),
    [getValueFromPL],
  );

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
  }, [reportSource, isManualGl]);

  // Manual GL internal version loading removed — consolidated into Key Reports.

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
          if (cachedData && cachedYears?.length && hasUsableEbitdaData(cachedData)) {
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
        if (ebitdaCacheKey && hasUsableEbitdaData(results)) {
          try { sessionStorage.setItem(ebitdaCacheKey, JSON.stringify({ multiYearData: results, years: availableYears })); } catch { /* quota exceeded */ }
        }
      } else if (isManualUpload) {
        // Fetch ALL uploaded P&L files so every year is represented
        const params = {
          clientId,
          ...(kr.krActive && kr.selectedVersionId ? { keyReportVersionId: kr.selectedVersionId } : {}),
        };
        const result = await getAllManualUploadedReports("profit_and_loss", params);
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
        if (ebitdaCacheKey && hasUsableEbitdaData(newData)) {
          try { sessionStorage.setItem(ebitdaCacheKey, JSON.stringify({ multiYearData: newData, years: newYears })); } catch { /* quota exceeded */ }
        }
      } else if (isQBManual) {
        // QuickBooks Manual: read all synced P&L files from qb_synced_reports
        const params = {
          clientId,
          ...(kr.krActive && kr.selectedVersionId ? { keyReportVersionId: kr.selectedVersionId } : {}),
        };
        const result = await getAllQMSUploadedReports("profit_and_loss", params);
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
        if (ebitdaCacheKey && hasUsableEbitdaData(newData)) {
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
        if (ebitdaCacheKey && hasUsableEbitdaData(results)) {
          try { sessionStorage.setItem(ebitdaCacheKey, JSON.stringify({ multiYearData: results, years: yearList })); } catch { /* quota exceeded */ }
        }
      }
    } catch (err) {
      if (activeSourceRef.current !== requestSource) return;
      setError(err?.message || "Failed to fetch analysis data. Please try again.");
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

    // Check cache before clearing/loading to minimize UI jumps
    let inCache = false;
    if (ebitdaCacheKey) {
      try {
        const cached = sessionStorage.getItem(ebitdaCacheKey);
        if (cached) {
          const { multiYearData: cd, years: cy } = JSON.parse(cached);
          if (cd && cy?.length && hasUsableEbitdaData(cd)) inCache = true;
        }
      } catch { /* ignore */ }
    }

    if (!inCache) {
      // Clear old state and show spinner IMMEDIATELY (prevents EmptyState flicker
      // while handleGenerate is waiting to be triggered in the next tick).
      setMultiYearData(null);
      setYears([]);
      setIsLoading(true);
    }

    setIsDataInitialized(false);
    setError("");
  }, [isManualGl, selectedVersion, ebitdaCacheKey]);

  // Load adjustment types for non-ManualGL modes (QB, Manual Upload, QB Manual)
  useEffect(() => {
    if (isManualGl || !clientId) return;
    listEbitdaAdjustmentTypes({ clientId }).then((types) => {
      setManualGlAdjustmentTypes(Array.isArray(types) ? types : []);
    }).catch(() => setManualGlAdjustmentTypes([]));
  }, [isManualGl, clientId]);

  useEffect(() => {
    if (!isManualGl) {
      setManualGlAdjustments([]);
      setManualGlReferenceIndex(null);
      setManualGlAdjustmentError("");
      return;
    }

    if (!clientId || !adjustmentVersionId) {
      setManualGlAdjustments([]);
      setManualGlAdjustmentTypes([]);
      setManualGlReferenceIndex(null);
      setManualGlAdjustmentError("");
      return;
    }

    let cancelled = false;
    const loadToken = adjustmentLoadTokenRef.current + 1;
    adjustmentLoadTokenRef.current = loadToken;

    setManualGlAdjustmentError("");
    setManualGlAdjustments([]);
    setManualGlAdjustmentTypes([]);
    setManualGlReferenceIndex(null);

    loadAdjustmentWorkspaceData({
      clientId,
      versionId: adjustmentVersionId,
      sourceKey: reportSource,
    })
      .then(({ types, adjustments }) => {
        if (cancelled || adjustmentLoadTokenRef.current !== loadToken) return;
        setManualGlAdjustmentTypes(Array.isArray(types) ? types : []);
        setManualGlAdjustments(Array.isArray(adjustments) ? adjustments : []);
      })
      .catch((err) => {
        if (cancelled || adjustmentLoadTokenRef.current !== loadToken) return;
        setManualGlAdjustmentError(err?.message || `Failed to load ${itemPluralLabel.toLowerCase()}.`);
        setManualGlAdjustmentTypes([]);
        setManualGlAdjustments([]);
      });

    loadVendorReferenceData({
      clientId,
      params: selectedVersion ? { datasetVersion: String(selectedVersion) } : {},
    })
      .then((reference) => {
        if (cancelled || adjustmentLoadTokenRef.current !== loadToken) return;
        setManualGlReferenceIndex(reference || null);
      })
      .catch(() => {
        if (cancelled || adjustmentLoadTokenRef.current !== loadToken) return;
        setManualGlReferenceIndex(null);
      });

    return () => {
      cancelled = true;
    };
  }, [adjustmentVersionId, clientId, isManualGl, reportSource, selectedVersion, itemPluralLabel]);

  // Handle Dynamic Addbacks Initialization and Persistence
  useEffect(() => {
    if (isManualGl) return;
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
            const apiVal = isFromPL ? toAbsoluteNumber(getValueFromPL(year, normalizedLabel), 0) : null;
            const existing = ab.values?.[year] || {};
            const existingUserValue = existing.userValue;
            const hasExistingUserValue = existingUserValue !== null && existingUserValue !== undefined && String(existingUserValue).trim() !== "";
            vals[year] = {
              apiValue: apiVal,
              userValue: hasExistingUserValue ? toAbsoluteNumber(existingUserValue, 0) : null
            };
            // If it was old format (just number), migrate it to userValue
            if (typeof existing === 'number') {
              vals[year].userValue = toAbsoluteNumber(existing, 0);
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
            value: latestVals.userValue !== null ? toAbsoluteNumber(latestVals.userValue, 0) : toAbsoluteNumber(latestVals.apiValue, 0),
            values: vals,
          };
        });

        setDynamicAddbacks(initialized);
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
  }, [multiYearData, clientId, isDataInitialized, getValueFromPL, years, getAccountIdByLabel, isManualGl]);

  // Persistent saving
  useEffect(() => {
    if (isManualGl) return;
    if (isDataInitialized && clientId) {
      localStorage.setItem(`ebitda_addbacks_${clientId}`, JSON.stringify({
        addbacks: dynamicAddbacks,
        rowComments: rowComments
      }));
    }
  }, [dynamicAddbacks, rowComments, clientId, isDataInitialized, isManualGl]);

  const updateRowComment = (key, value) => {
    setRowComments(prev => ({
      ...prev,
      [key]: value
    }));
  };

  const handleGenerateComments = useCallback(async () => {
    if (!multiYearData || !years.length) return;
    setIsGeneratingComments(true);
    try {
      // Build per-year values for each EBITDA field
      const ebitdaData = {};
      years.forEach((yr) => {
        const comps = multiYearData[yr]?.components || {};
        const baseEbitda = calculateBaseEbitda(yr);
        const addbacksSum = dynamicAddbacks.reduce((sum, ab) => {
          const { apiValue, userValue } = ab.values?.[yr] || {};
          const val = userValue !== null && userValue !== undefined ? userValue : apiValue;
          return sum + toAbsoluteNumber(val, 0);
        }, 0);
        const finalSde = baseEbitda + addbacksSum;
        const revenue = multiYearData[yr]?.revenue || 0;
        const sdePct = revenue > 0 ? (finalSde / revenue) * 100 : 0;
        ebitdaData[yr] = {
          netIncome: comps.netIncome?.value,
          interestIncome: comps.interestIncome?.value,
          interestExpense: comps.interestExpense?.value,
          taxes: comps.taxes?.value,
          depreciation: comps.depreciation?.value,
          amortization: comps.amortization?.value,
          ebitda: baseEbitda,
          totalSde: finalSde,
          sdePercent: sdePct,
        };
      });

      const comments = await generateEbitdaComments({
        companyName: company?.name || company?.company_name || "the company",
        years,
        ebitdaData,
        adjustments: dynamicAddbacks.map((ab) => ({ label: ab.label, values: ab.values })),
        finalLabel: profitMetricConfig.finalRowLabel,
        percentLabel: profitMetricConfig.percentRowLabel,
      }, { clientId });

      if (comments && Object.keys(comments).length) {
        setRowComments((prev) => ({ ...prev, ...comments }));
      }
    } catch (err) {
      console.error("[EBITDA] Failed to generate AI comments:", err);
    } finally {
      setIsGeneratingComments(false);
    }
  }, [multiYearData, years, calculateBaseEbitda, dynamicAddbacks, company, profitMetricConfig, clientId]);

  // Reset auto-generate state when connection mode changes so fresh comments are generated
  const hasAutoGeneratedRef = useRef(false);
  useEffect(() => {
    hasAutoGeneratedRef.current = false;
    setRowComments({});
  }, [reportSource]);

  // Auto-generate AI comments on first load when no comments exist yet
  useEffect(() => {
    if (!isDataInitialized) return;
    if (!multiYearData || !years.length) return;
    if (hasAutoGeneratedRef.current) return;
    const hasExisting = Object.values(rowComments).some((v) => v && String(v).trim());
    if (hasExisting) return;
    hasAutoGeneratedRef.current = true;
    handleGenerateComments();
  }, [isDataInitialized, multiYearData, years, rowComments, handleGenerateComments]);

  const uploadAdjustmentAttachments = useCallback(async (files = []) => {
    const pendingFiles = Array.isArray(files) ? files.filter(Boolean) : [];
    if (!pendingFiles.length) return [];

    const uploaded = await Promise.all(
      pendingFiles.map(async (file) => {
        const result = await uploadFile(file, {
          fileName: file?.name || "attachment",
          prefix: "ebitda-adjustments",
        });

        return {
          uploadId: result?.id || null,
          fileName: result?.fileName || file?.name || "attachment",
          fileUrl: result?.fileUrl || result?.file_url || "",
          contentType: file?.type || result?.contentType || result?.content_type || null,
          sizeBytes: file?.size || result?.sizeBytes || result?.size_bytes || null,
          metadata: {
            source: "ebitda-adjustment",
          },
        };
      }),
    );

    return uploaded.filter((item) => item.fileUrl);
  }, []);

  const persistManualGlAdjustments = useCallback(async (nextAdjustments = []) => {
    if (!adjustmentScope.clientId) throw new Error("Missing clientId.");
    if (!adjustmentScope.versionId) throw new Error("Missing adjustment version.");

    const response = await saveEbitdaAdjustmentsBatch(
      {
        companyId: adjustmentScope.clientId,
        versionId: adjustmentScope.versionId,
        sourceKey: adjustmentScope.sourceKey,
        adjustments: nextAdjustments,
      },
      {
        clientId: adjustmentScope.clientId,
        versionId: adjustmentScope.versionId,
        sourceKey: adjustmentScope.sourceKey,
      },
    );

    const refreshedAdjustments = Array.isArray(response?.adjustments) ? response.adjustments : nextAdjustments;
    setManualGlAdjustments(refreshedAdjustments);
    if (Array.isArray(response?.types)) {
      setManualGlAdjustmentTypes(response.types);
    }
    setManualGlAdjustmentError("");
    return response;
  }, [adjustmentScope]);

  const handleManualGlSaveAdjustment = useCallback(async (draft) => {
    if (!draft) return;
    setIsSavingAdjustment(true);
    setManualGlAdjustmentError("");

    try {
      const uploadedAttachments = await uploadAdjustmentAttachments(draft.pendingFiles || []);
      const nextAdjustment = {
        ...draft,
        attachments: [
          ...(Array.isArray(draft.attachments) ? draft.attachments : []),
          ...uploadedAttachments,
        ],
      };
      delete nextAdjustment.pendingFiles;

      const nextAdjustments = manualGlAdjustments.some((item) => String(item.id) === String(nextAdjustment.id))
        ? manualGlAdjustments.map((item) => (String(item.id) === String(nextAdjustment.id) ? nextAdjustment : item))
        : [...manualGlAdjustments, nextAdjustment];

      await persistManualGlAdjustments(nextAdjustments);
    } catch (err) {
      setManualGlAdjustmentError(err?.message || `Failed to save ${itemSingularLabel.toLowerCase()}.`);
      throw err;
    } finally {
      setIsSavingAdjustment(false);
    }
  }, [itemSingularLabel, manualGlAdjustments, persistManualGlAdjustments, uploadAdjustmentAttachments]);

  const handleManualGlDeleteAdjustment = useCallback(async (adjustmentId) => {
    if (!adjustmentId) return;
    setIsSavingAdjustment(true);
    setManualGlAdjustmentError("");

    try {
      const response = await deleteEbitdaAdjustment(adjustmentId, {
        clientId: adjustmentScope.clientId,
        versionId: adjustmentScope.versionId,
        sourceKey: adjustmentScope.sourceKey,
      });
      const refreshedAdjustments = Array.isArray(response?.adjustments)
        ? response.adjustments
        : manualGlAdjustments.filter((item) => String(item.id) !== String(adjustmentId));
      setManualGlAdjustments(refreshedAdjustments);
    } catch (err) {
      setManualGlAdjustmentError(err?.message || `Failed to delete ${itemSingularLabel.toLowerCase()}.`);
      throw err;
    } finally {
      setIsSavingAdjustment(false);
    }
  }, [adjustmentScope, itemSingularLabel, manualGlAdjustments]);


  // Non-GL modes: convert dynamicAddbacks → EbitdaAdjustmentsPanel format
  const nonGlAdjustments = useMemo(() => {
    if (isManualGl) return [];
    return dynamicAddbacks.map((ab) => ({
      id: ab.id,
      name: ab.label || "",
      typeKey: ab.typeKey || "other_addback",
      linkedAccountName: ab.isFromPL ? (ab.label || "") : "",
      linkedAccountId: ab.accountId || "",
      isManual: !ab.isFromPL,
      vendorScopeMode: ab.vendorScopeMode || "entire_account",
      vendorScope: ab.vendorScope || [],
      description: ab.description || "",
      internalNotes: ab.internalNotes || "",
      analystComments: ab.analystComments || "",
      supportingExplanation: ab.supportingExplanation || "",
      attachments: ab.attachments || [],
      comments: [],
      values: Object.fromEntries(
        Object.entries(ab.values || {}).map(([yr, v]) => [
          yr,
          {
            apiValue: v.apiValue ?? null,
            overrideValue: v.userValue !== null && v.userValue !== undefined ? v.userValue : null,
            userValue: v.userValue !== null && v.userValue !== undefined ? v.userValue : null,
            value: v.userValue !== null && v.userValue !== undefined ? v.userValue : (v.apiValue ?? 0),
          },
        ])
      ),
    }));
  }, [isManualGl, dynamicAddbacks]);

  const handleNonGlSaveAdjustment = useCallback(async (draft) => {
    if (!draft) return;
    setIsSavingNonGlAdjustment(true);
    try {
      const isFromPL = !!(draft.linkedAccountName);
      const newValues = {};
      years.forEach((yr) => {
        const v = draft.values?.[String(yr)] || {};
        const override = v.overrideValue !== undefined && v.overrideValue !== null ? v.overrideValue : v.userValue;
        newValues[yr] = {
          apiValue: isFromPL ? toAbsoluteNumber(getValueFromPL(yr, draft.linkedAccountName), 0) : null,
          userValue: override !== null && override !== undefined ? toAbsoluteNumber(override, 0) : null,
        };
      });
      const latestYear = years[0];
      const latestVals = newValues[latestYear] || { apiValue: null, userValue: null };

      const newAddback = {
        id: draft.id || `custom_${Date.now()}`,
        label: draft.name || draft.linkedAccountName || "",
        typeKey: draft.typeKey || "other_addback",
        type: isFromPL ? "PL" : "RECAST",
        isFromPL,
        linkedToPL: isFromPL,
        accountId: draft.linkedAccountId || "",
        description: draft.description || "",
        internalNotes: draft.internalNotes || "",
        analystComments: draft.analystComments || "",
        supportingExplanation: draft.supportingExplanation || "",
        vendorScopeMode: draft.vendorScopeMode || "entire_account",
        vendorScope: draft.vendorScope || [],
        attachments: draft.attachments || [],
        value: latestVals.userValue !== null ? toAbsoluteNumber(latestVals.userValue, 0) : toAbsoluteNumber(latestVals.apiValue, 0),
        values: newValues,
      };

      setDynamicAddbacks((prev) => {
        const exists = prev.some((ab) => ab.id === newAddback.id);
        return exists
          ? prev.map((ab) => (ab.id === newAddback.id ? newAddback : ab))
          : [...prev, newAddback];
      });
    } finally {
      setIsSavingNonGlAdjustment(false);
    }
  }, [years, getValueFromPL]);

  const handleNonGlDeleteAdjustment = useCallback(async (adjustmentId) => {
    if (!adjustmentId) return;
    const ok = window.confirm("Delete this adjustment?");
    if (!ok) return;
    setDynamicAddbacks((prev) => prev.filter((ab) => ab.id !== adjustmentId));
  }, []);

  // handleSync removed


  return (
    <div className="page-container">
      <div className="page-content">
        {/* Header */}
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-[#050505]">
              {analysisLabel}
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
            {/* Unified Key Reports Version selector is the single source of truth */}
            <KeyReportVersionSelector clientId={clientId} variant="filter" />
            {/* Refresh button removed */}
          </div>
        </div>

        <QBDisconnectedBanner pageName={analysisLabel} />

        {/* Content */}
        {isLoading ? (
          <LoadingState metricLabel={profitMetricConfig.shortLabel} />
        ) : error && !multiYearData ? (
          <div className="flex flex-col gap-4">
            <EmptyStateNotification error={error} onRetry={handleGenerate} />
            <EmptyEbitdaTable companyName={company?.name} profitMetricConfig={profitMetricConfig} />
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
                          Recalculated {profitMetricConfig.longLabel} of {company?.name || "the Business"}
                        </span>
                      </th>
                      <th
                        className="bg-[#8bc53d] py-3 text-center min-w-[280px]"
                        style={{ borderLeft: "3px solid rgba(255,255,255,0.35)" }}
                      >
                        <div className="flex flex-col items-center gap-1.5">
                          <span className="text-[18px] font-bold text-white">Comments</span>
                          <button
                            onClick={handleGenerateComments}
                            disabled={isGeneratingComments}
                            className="flex items-center gap-1.5 rounded-md bg-white/20 hover:bg-white/30 disabled:opacity-60 disabled:cursor-not-allowed px-3 py-1 text-[11px] font-semibold text-white transition-colors border border-white/40"
                          >
                            {isGeneratingComments ? (
                              <>
                                <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none">
                                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                                </svg>
                                Generating...
                              </>
                            ) : (
                              <>Generate Comments</>
                            )}
                          </button>
                        </div>
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

                    {isManualGl ? (
                      <EbitdaAdjustmentsPanel
                        years={years}
                        adjustments={manualGlAdjustments}
                        typeOptions={manualGlAdjustmentTypes}
                        accountOptions={adjustmentAccountOptions}
                        vendorOptions={adjustmentVendorOptions}
                        referenceIndex={manualGlReferenceIndex}
                        fallbackLookup={fallbackAdjustmentLookup}
                        baseEbitdaByYear={baseEbitdaByYear}
                        revenueByYear={revenueByYear}
                        formatCurrency={formatCurrency}
                        loading={Boolean(adjustmentVersionId) && !manualGlAdjustmentError && manualGlAdjustments.length === 0 && manualGlAdjustmentTypes.length === 0}
                        error={manualGlAdjustmentError}
                        isSaving={isSavingAdjustment}
                        onSaveAdjustment={handleManualGlSaveAdjustment}
                        onDeleteAdjustment={handleManualGlDeleteAdjustment}
                        profitMetricConfig={profitMetricConfig}
                      />
                    ) : (
                      <EbitdaAdjustmentsPanel
                        years={years}
                        adjustments={nonGlAdjustments}
                        typeOptions={manualGlAdjustmentTypes}
                        accountOptions={adjustmentAccountOptions}
                        vendorOptions={adjustmentVendorOptions}
                        referenceIndex={null}
                        fallbackLookup={fallbackAdjustmentLookup}
                        baseEbitdaByYear={baseEbitdaByYear}
                        revenueByYear={revenueByYear}
                        formatCurrency={formatCurrency}
                        loading={false}
                        error=""
                        isSaving={isSavingNonGlAdjustment}
                        onSaveAdjustment={handleNonGlSaveAdjustment}
                        onDeleteAdjustment={handleNonGlDeleteAdjustment}
                        profitMetricConfig={profitMetricConfig}
                      />
                    )}

                  </tbody>
                </table>
              </div>
            </div>

            {/* Summary Analysis Box removed */}
          </div>
        ) : (
          <EmptyState analysisLabel={analysisLabel} />
        )}

      </div>
    </div>
  );
}


