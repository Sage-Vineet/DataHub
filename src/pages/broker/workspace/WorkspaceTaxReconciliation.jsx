import {
  Fragment,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Info,
  LoaderCircle,
  RefreshCw,
  Plus,
  Trash2,
  Check,
  X,
  Download,
} from "lucide-react";
import * as XLSX from "xlsx";
import { jsPDF } from "jspdf";
import { cn } from "../../../lib/utils";
import {
  getCompanyRequest,
  getStoredToken,
  getManualStagedProfitLossSummary,
  getManualStageFilterOptions,
  getTaxReconciliationOverrides,
  saveTaxReconciliationOverrides,
  getKeyReportVersionReport,
} from "../../../lib/api";
import { useDataSource } from "../../../context/DataSourceContext";

import {
  useKeyReportContextStore,
  selectKeyReportContext,
  maskKeyReportContext,
} from "../../../store/useKeyReportContextStore";
import { useShallow } from "zustand/react/shallow";
import KeyReportVersionSelector from "../../../components/key-reports/KeyReportVersionSelector";

import {
  buildReconciliation,
  canonicalScheduleKLabel,
  collectFootingFailures,
} from "../../../lib/taxReconciliation";
import {
  collectBsPeriods,
  normalizeTaxYears,
  toEngineOverrides,
  unionFiscalYears,
} from "../../../lib/taxReconciliationSources";

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL || "http://localhost:4000";

// v6: the cached payload's SHAPE changed. It now stores the raw per-year P&L row
// trees, the tax years and the Balance Sheet periods instead of ten pre-searched
// numbers per year, because the reconciliation is recomputed from the real
// statement on every render (see lib/taxReconciliation.js). A v5 payload cannot
// be reinterpreted, so the prefix bump retires it rather than half-reading it.
const STORAGE_PREFIX = "workspace-tax-reconciliation-v6";

// ── Session-storage helpers ────────────────────────────────────────────────

// Slot key for the cached source data, isolated by (company, connection mode,
// version). The figures are entirely source-dependent, so a company-only key let
// one mode's data restore under another mode.
function getStorageKey(clientId, source, version) {
  return `${STORAGE_PREFIX}:${clientId || "default"}:${source || "default"}:${version || "default"}`;
}

function getStoredState(clientId, source, version) {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(getStorageKey(clientId, source, version));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

const EMPTY_SOURCE_DATA = Object.freeze({ plRowsByYear: {}, taxYears: {}, bsPeriods: [] });

// ── Formatting ─────────────────────────────────────────────────────────────

/**
 * A reconciliation figure.
 *
 * A genuine, fully-reconciled 0 renders as "0.00", NOT as a dash. The old
 * formatter returned "-" for zero, which made the single most important outcome
 * on the page — a reconciliation that actually foots — indistinguishable from a
 * row that has no data at all.
 */
function formatAmount(value, { blankWhenNull = true, zeroAsZero = false, decimals = 0 } = {}) {
  if (value === null || value === undefined || value === "") return blankWhenNull ? "—" : "";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  if (n === 0 && !zeroAsZero) return "-";
  const abs = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(Math.abs(n));
  return n < 0 ? `(${abs})` : abs;
}

/** A reconciliation check / difference — always shows its real value, including 0.00. */
const formatCheck = (value) =>
  formatAmount(value, { zeroAsZero: true, decimals: 2 });

function getVarianceClass(value) {
  const n = Number(value || 0);
  if (!n) return "text-text-primary";
  return n < 0 ? "text-red-600" : "text-green-600";
}

function getCheckClass(value, reconciled) {
  if (value === null || value === undefined) return "text-text-muted";
  if (reconciled) return "text-emerald-700";
  return "text-red-600";
}

// ── SyncStatus badge ───────────────────────────────────────────────────────

function SyncStatus({ sync }) {
  if (!sync?.message) return null;
  return (
    <div
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[12px] font-medium",
        sync.status === "loading" && "border-primary/20 bg-primary/5 text-primary",
        sync.status === "error" && "border-red-200 bg-red-50 text-red-700",
        sync.status === "success" && "border-emerald-200 bg-emerald-50 text-emerald-700",
        sync.status === "idle" && "border-border bg-white text-text-secondary",
      )}
    >
      {sync.status === "loading" ? (
        <LoaderCircle size={14} className="animate-spin" />
      ) : sync.status === "error" ? (
        <AlertCircle size={14} />
      ) : (
        <CheckCircle2 size={14} />
      )}
      {sync.message}
    </div>
  );
}

// ── Constants ──────────────────────────────────────────────────────────────

// Complete Form 1065 / 1120-S Schedule K — Partners'/Shareholders' Distributive
// Share Items, grouped by section, offered in the "Add Schedule K Item" picker.
// Every label is passed through canonicalScheduleKLabel before it becomes a row,
// so adding "Other credits" here and the return stating "Other Credits" can
// never produce two rows for one line.
const SCHEDULE_K_SECTIONS = [
  {
    section: "Income (Loss)",
    items: [
      "Ordinary Business Income (Loss)",
      "Net Rental Real Estate Income (Loss)",
      "Other Gross Rental Income (Loss)",
      "Expenses from Other Rental Activities",
      "Other Net Rental Income (Loss)",
      "Guaranteed Payments – Services",
      "Guaranteed Payments – Capital",
      "Guaranteed Payments – Total",
      "Interest Income",
      "Ordinary Dividends",
      "Qualified Dividends",
      "Dividend Equivalents",
      "Royalties",
      "Net Short-Term Capital Gain (Loss)",
      "Net Long-Term Capital Gain (Loss)",
      "Collectibles (28%) Gain (Loss)",
      "Unrecaptured Section 1250 Gain",
      "Net Section 1231 Gain (Loss)",
      "Other Income (Loss)",
    ],
  },
  {
    section: "Deductions",
    items: [
      "Section 179 Deduction",
      "Contributions (Charitable)",
      "Investment Interest Expense",
      "Section 59(e)(2) Expenditures",
      "Other Deductions",
    ],
  },
  {
    section: "Self-Employment",
    items: [
      "Net Earnings (Loss) from Self-Employment",
      "Gross Farming or Fishing Income",
      "Gross Nonfarm Income",
    ],
  },
  {
    section: "Credits",
    items: [
      "Low-Income Housing Credit (Section 42(j)(5))",
      "Low-Income Housing Credit (Other)",
      "Qualified Rehabilitation Expenditures (Rental Real Estate)",
      "Other Rental Real Estate Credits",
      "Other Rental Credits",
      "Other Credits",
    ],
  },
  {
    section: "AMT Items",
    items: [
      "Post-1986 Depreciation Adjustment",
      "Adjusted Gain or Loss",
      "Depletion (Other than Oil and Gas)",
      "Oil, Gas & Geothermal Properties – Gross Income",
      "Oil, Gas & Geothermal Properties – Deductions",
      "Other AMT Items",
    ],
  },
  {
    section: "Other Information",
    items: [
      "Tax-Exempt Interest Income",
      "Other Tax-Exempt Income",
      "Nondeductible Expenses",
      "Distributions of Cash and Marketable Securities",
      "Distributions of Other Property",
      "Investment Income",
      "Investment Expenses",
      "Other Items and Amounts",
      "Total Foreign Taxes Paid or Accrued",
    ],
  },
];

const SCHEDULE_K_ITEMS = SCHEDULE_K_SECTIONS.flatMap((s) => s.items);

// The nine visual blocks the client's workbook uses (Part 13). Rendered in this
// order, each as its own banded block inside the one scrolling grid.
const SECTIONS = [
  { id: 1, key: "financial", title: "Financial Statement Reconciliation" },
  { id: 2, key: "m1", title: "M1 Adjustments" },
  { id: 3, key: "reportedM1", title: "Reported M1 Book Net Income" },
  { id: 4, key: "m1Variance", title: "M1 Variance Check" },
  { id: 5, key: "cashAccrual", title: "Cash / Accrual Adjustments" },
  { id: 6, key: "other", title: "Other Adjustments" },
  { id: 7, key: "reconCheck", title: "Tax to Book Reconciliation Check" },
  { id: 8, key: "sde", title: "Unreconciled % of SDE" },
  { id: 9, key: "scheduleK", title: "Schedule K / Tax-to-Book Reconciliation Items" },
];

// ── Main component ─────────────────────────────────────────────────────────

export default function WorkspaceTaxReconciliation() {
  const { clientId } = useParams();
  const navigate = useNavigate();
  const { activeSource, activeSourceMode } = useDataSource();

  const currentYear = new Date().getFullYear();
  const YEAR_OPTIONS = Array.from({ length: 6 }, (_, i) => currentYear - i);

  const [company, setCompany] = useState(null);
  const [startYear, setStartYear] = useState(String(currentYear - 2));
  const [endYear, setEndYear] = useState(String(currentYear));
  const [accountingMethod, setAccountingMethod] = useState("Cash");
  const [sourceData, setSourceData] = useState(EMPTY_SOURCE_DATA);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [taxExportOpen, setTaxExportOpen] = useState(false);
  const [taxIsExporting, setTaxIsExporting] = useState(false);
  const [warnings, setWarnings] = useState([]);
  const [isQBDisconnected, setIsQBDisconnected] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [syncStatus, setSyncStatus] = useState({ status: "idle", message: "" });
  // Key Reports tax return gate: 'idle' | 'loading' | 'ok' | 'missing'
  const [krTaxGate, setKrTaxGate] = useState({ status: "idle" });

  // Key Reports drives this page ONLY when the active data source is
  // "key_reports". For the 4 connection modes the KR context is masked inactive
  // so the Connections-page selection is authoritative.
  const krSelected = activeSourceMode === "key_reports";
  const rawKr = useKeyReportContextStore(useShallow(selectKeyReportContext));
  const kr = useMemo(() => maskKeyReportContext(rawKr, krSelected), [rawKr, krSelected]);
  const effectiveSourceMode = kr.krActive
    ? (kr.flowType === "manual_gl" ? "manual" : "manual_upload")
    : activeSourceMode;

  // User-edited overrides: { [year]: { [label]: { taxReturn, pl, userAdded?, deleted? } } }
  const [reconcilingOverrides, setReconcilingOverrides] = useState({});
  const [editingCell, setEditingCell] = useState(null);
  const [editingValue, setEditingValue] = useState("");
  const [showAddRowDropdown, setShowAddRowDropdown] = useState(false);
  const [addRowSearch, setAddRowSearch] = useState("");
  const addRowRef = useRef(null);

  const isManualGL = effectiveSourceMode === "manual";
  const isManualMode = effectiveSourceMode === "manual_upload" || effectiveSourceMode === "manual";
  const isQBManual = !kr.krActive && activeSourceMode === "quickbooks_manual";

  const taxSlotVersion = kr.krActive ? String(kr.selectedVersionId || "default") : "default";
  const useManualLayout = isManualMode || krSelected;

  const selectedYears = useMemo(() => {
    const s = parseInt(startYear, 10);
    const e = parseInt(endYear, 10);
    const lo = Math.min(s, e);
    const hi = Math.max(s, e);
    return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  }, [startYear, endYear]);

  // Every fiscal year present in ANY loaded source. A year with a P&L but no
  // return (or the reverse) still gets a column — the missing side is marked
  // unavailable rather than the year being dropped.
  const availableYears = useMemo(
    () => unionFiscalYears(sourceData.plRowsByYear, sourceData.taxYears),
    [sourceData],
  );

  const activeYears = useMemo(() => {
    if (isManualMode || isQBManual || krSelected) {
      if (!availableYears.length) return [];
      if (krSelected) {
        const a = parseInt(startYear, 10) || availableYears[0];
        const b = parseInt(endYear, 10) || availableYears[availableYears.length - 1];
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        return availableYears.filter((y) => y >= lo && y <= hi);
      }
      return availableYears;
    }
    return selectedYears;
  }, [isManualMode, isQBManual, krSelected, availableYears, startYear, endYear, selectedYears]);

  useEffect(() => {
    if (!krSelected) return;
    if (!availableYears.length) return;
    setStartYear(String(availableYears[0]));
    setEndYear(String(availableYears[availableYears.length - 1]));
  }, [krSelected, availableYears]);

  const getHeaders = useCallback(() => {
    const token = getStoredToken();
    return {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(clientId ? { "X-Client-Id": clientId } : {}),
    };
  }, [clientId]);

  // ── The reconciliation ────────────────────────────────────────────────
  //
  // Every displayed number comes from here. It is a pure recomputation from the
  // loaded sources plus the user's overrides, so a saved override, a mode switch
  // and a refresh can never leave a stale figure on screen.
  const reconciliation = useMemo(
    () => buildReconciliation({
      fiscalYears: activeYears,
      plRowsByYear: sourceData.plRowsByYear,
      taxYears: sourceData.taxYears,
      bsPeriods: sourceData.bsPeriods,
      accountingMethod,
      overridesByYear: toEngineOverrides(reconcilingOverrides),
    }),
    [activeYears, sourceData, accountingMethod, reconcilingOverrides],
  );

  const yearOf = useCallback((year) => reconciliation.byYear[year] || null, [reconciliation]);

  const footingFailures = useMemo(() => collectFootingFailures(reconciliation), [reconciliation]);

  // Every reason the page cannot fully reconcile, de-duplicated across years.
  const blockers = useMemo(() => {
    const seen = new Map();
    for (const year of reconciliation.years) {
      for (const message of reconciliation.byYear[year]?.blockers || []) {
        if (!seen.has(message)) seen.set(message, []);
        seen.get(message).push(year);
      }
    }
    return [...seen.entries()].map(([message, years]) => ({ message, years }));
  }, [reconciliation]);

  // ── Company ───────────────────────────────────────────────────────────

  useEffect(() => {
    let active = true;
    if (!clientId) { setCompany(null); return () => { active = false; }; }
    getCompanyRequest(clientId)
      .then((p) => { if (active) setCompany(p); })
      .catch(() => { if (active) setCompany(null); });
    return () => { active = false; };
  }, [clientId]);

  // ── Restore on slot change ────────────────────────────────────────────

  useEffect(() => {
    const next = getStoredState(clientId, activeSource, taxSlotVersion);
    if (!next) {
      setSourceData(EMPTY_SOURCE_DATA);
      setError("");
      setWarnings([]);
      setIsQBDisconnected(false);
      setSyncStatus({ status: "idle", message: "" });
      return;
    }
    setStartYear(next.startYear ?? String(currentYear - 2));
    setEndYear(next.endYear ?? String(currentYear));
    setAccountingMethod(next.accountingMethod ?? "Cash");
    setSourceData(next.sourceData ?? EMPTY_SOURCE_DATA);
    setError(next.error ?? "");
    setWarnings(next.warnings ?? []);
    setIsQBDisconnected(false);
    const hasData = Object.keys(next.sourceData?.plRowsByYear ?? {}).length > 0
      || Object.keys(next.sourceData?.taxYears ?? {}).length > 0;
    setSyncStatus({
      status: hasData ? "success" : "idle",
      message: hasData ? "Restored saved data." : "",
    });
  }, [clientId, currentYear, activeSource, taxSlotVersion]);

  const selectedVersion = kr.resolvedDatasetVersion;
  const latestVersionRef = useRef(selectedVersion);
  latestVersionRef.current = selectedVersion;

  // ── Persist ───────────────────────────────────────────────────────────

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.sessionStorage.setItem(
        getStorageKey(clientId, activeSource, taxSlotVersion),
        JSON.stringify({ startYear, endYear, accountingMethod, sourceData, error, warnings }),
      );
    } catch { /* quota — the data reloads on demand */ }
  }, [clientId, startYear, endYear, accountingMethod, sourceData, error, warnings, activeSource, taxSlotVersion]);

  // ── Balance Sheet periods ─────────────────────────────────────────────
  //
  // Only Key Reports exposes a version-scoped Balance Sheet. The request is
  // deliberately made with NO year filter so every period the version holds is
  // returned: a fiscal year's cash/accrual section needs the PRIOR year's
  // closing Balance Sheet as its beginning balance, so a year-filtered fetch
  // could never resolve the earliest year's beginning period.
  const loadBsPeriods = useCallback(async () => {
    if (!kr.krActive || !kr.selectedVersionId) {
      return { periods: [], warning: null };
    }
    try {
      const response = await getKeyReportVersionReport(kr.selectedVersionId, "balance-sheet", {});
      const periods = collectBsPeriods(response);
      if (!periods.length) {
        return {
          periods: [],
          warning:
            "No Balance Sheet periods were returned for this Key Reports Version, so the " +
            "Cash/Accrual Adjustments section cannot be calculated. Link a Balance Sheet in " +
            "Key Reports and sync.",
        };
      }
      return { periods, warning: null };
    } catch (err) {
      return {
        periods: [],
        warning: `The Balance Sheet could not be read (${err?.message || "request failed"}), so Cash/Accrual Adjustments are unavailable.`,
      };
    }
  }, [kr.krActive, kr.selectedVersionId]);

  // ── Loader ────────────────────────────────────────────────────────────

  const loadData = useCallback(async (forceRefresh = false) => {
    const requestVersion = selectedVersion;
    setIsLoading(true);
    setError("");
    setIsQBDisconnected(false);
    setSyncStatus({ status: "loading", message: isManualMode ? "Fetching P&L data…" : "Fetching P&L & Tax Data…" });

    try {
      const krVersionParam = kr.krActive && kr.selectedVersionId
        ? `&keyReportVersionId=${encodeURIComponent(String(kr.selectedVersionId))}`
        : "";
      const taxVersionParam = selectedVersion
        ? `&datasetVersion=${encodeURIComponent(String(selectedVersion))}`
        : "";
      const forceParam = forceRefresh ? "&force=1" : "";
      const headers = getHeaders();
      const allWarnings = [];

      let plRowsByYear = {};
      let taxYears = {};
      let bsPeriods = [];

      if (isManualGL) {
        setSyncStatus({ status: "loading", message: "Reading manual GL P&L…" });

        const versionParam = selectedVersion ? { datasetVersion: String(selectedVersion) } : {};
        const [taxRes, filterRes, bs] = await Promise.all([
          fetch(`${API_BASE_URL}/manual-report-uploads/tax-data?clientId=${clientId || ""}${forceParam}${taxVersionParam}${krVersionParam}`, { headers })
            .then((r) => r.json()).catch(() => ({ success: false })),
          getManualStageFilterOptions({ clientId, params: versionParam }).catch(() => ({})),
          loadBsPeriods(),
        ]);

        taxYears = normalizeTaxYears(taxRes);
        if (taxRes.warning) allWarnings.push(taxRes.warning);
        if (Array.isArray(taxRes.warnings)) allWarnings.push(...taxRes.warnings);
        bsPeriods = bs.periods;
        if (bs.warning) allWarnings.push(bs.warning);

        const glYears = Array.isArray(filterRes?.options?.fiscalYear)
          ? filterRes.options.fiscalYear.map(Number).filter(Boolean)
          : [];

        await Promise.all(glYears.map(async (year) => {
          try {
            const payload = await getManualStagedProfitLossSummary({
              clientId,
              params: { fiscalYear: [String(year)], ...versionParam },
            });
            const rows = Array.isArray(payload?.hierarchicalRows) ? payload.hierarchicalRows : [];
            if (rows.length) plRowsByYear[year] = rows;
          } catch {
            /* this year's P&L is unreadable — it is reported as missing, not faked */
          }
        }));

        if (latestVersionRef.current !== requestVersion) return;
      } else if (isManualMode) {
        setSyncStatus({ status: "loading", message: "Reading financial documents…" });

        if (kr.krActive && kr.selectedVersionId) {
          // Discover every fiscal year in this version's books, then fetch each
          // year's own P&L. Driving off the version's real years — not the
          // Start/End Year dropdown — stops a year outside that window from
          // being silently dropped.
          const [discovery, taxResRaw, bs] = await Promise.all([
            getKeyReportVersionReport(kr.selectedVersionId, "profit-loss", { period: "year" })
              .catch(() => null),
            fetch(`${API_BASE_URL}/manual-report-uploads/tax-data?clientId=${clientId || ""}${forceParam}${krVersionParam}`, { headers })
              .then((r) => r.json()).catch(() => ({ success: false })),
            loadBsPeriods(),
          ]);

          taxYears = normalizeTaxYears(taxResRaw);
          if (taxResRaw?.warning) allWarnings.push(taxResRaw.warning);
          if (Array.isArray(taxResRaw?.warnings)) allWarnings.push(...taxResRaw.warnings);
          bsPeriods = bs.periods;
          if (bs.warning) allWarnings.push(bs.warning);

          const versionYears = Array.isArray(discovery?.years)
            ? discovery.years.map(Number).filter(Boolean)
            : [];
          const plFetchYears = unionFiscalYears(
            Object.fromEntries(versionYears.map((y) => [y, true])),
            taxYears,
            Object.fromEntries(selectedYears.map((y) => [y, true])),
          );

          const entries = await Promise.all(plFetchYears.map(async (y) => {
            try {
              const resp = await getKeyReportVersionReport(
                kr.selectedVersionId, "profit-loss", { year: String(y), period: "year" },
              );
              const rows = resp?.hierarchicalRows || resp?.rows || [];
              return rows.length ? [y, rows] : null;
            } catch {
              return null;
            }
          }));
          plRowsByYear = Object.fromEntries(entries.filter(Boolean));
        } else {
          const [plRes, taxResRaw] = await Promise.all([
            fetch(`${API_BASE_URL}/manual-report-uploads/pl-for-tax?clientId=${clientId || ""}${forceParam}${krVersionParam}`, { headers })
              .then((r) => r.json()).catch(() => ({ success: false })),
            fetch(`${API_BASE_URL}/manual-report-uploads/tax-data?clientId=${clientId || ""}${forceParam}${krVersionParam}`, { headers })
              .then((r) => r.json()).catch(() => ({ success: false })),
          ]);
          taxYears = normalizeTaxYears(taxResRaw);
          if (plRes.warning) allWarnings.push(plRes.warning);
          if (Array.isArray(plRes.warnings)) allWarnings.push(...plRes.warnings);
          if (taxResRaw?.warning) allWarnings.push(taxResRaw.warning);
          if (Array.isArray(taxResRaw?.warnings)) allWarnings.push(...taxResRaw.warnings);

          // pl-for-tax returns pre-summarised label/value pairs per year. Those
          // are wrapped as a single flat section so the engine can still classify
          // them; a document-tree P&L (every other mode) keeps its real hierarchy.
          for (const [key, entry] of Object.entries(plRes.success && plRes.years ? plRes.years : {})) {
            const year = Number(entry?.year ?? key);
            const rows = Array.isArray(entry?.rows) ? entry.rows
              : Array.isArray(entry?.hierarchicalRows) ? entry.hierarchicalRows
                : null;
            if (rows?.length) { plRowsByYear[year] = rows; continue; }
            if (Array.isArray(entry?.data)) plRowsByYear[year] = summarisedPlToRows(entry.data);
          }

          allWarnings.push(
            "Cash/Accrual Adjustments require a Balance Sheet, which Manual Upload mode does not " +
            "provide. Switch to a Key Reports Version with a linked Balance Sheet to calculate them.",
          );
        }
      } else if (isQBManual) {
        setSyncStatus({ status: "loading", message: "Reading synced P&L reports…" });

        const [plRes, taxRes] = await Promise.all([
          fetch(`${API_BASE_URL}/manual-report-uploads/qms-reports/profit_and_loss/all?clientId=${clientId || ""}`, { headers })
            .then((r) => r.json()).catch(() => ({ success: false })),
          fetch(`${API_BASE_URL}/manual-report-uploads/tax-data?clientId=${clientId || ""}`, { headers })
            .then((r) => r.json()).catch(() => ({ success: false })),
        ]);

        const files = (plRes?.files || []).filter((f) => f.data?.rows?.length);
        if (!files.length) {
          throw new Error("No synced P&L reports found. Please sync your files on the Connections page first.");
        }
        taxYears = normalizeTaxYears(taxRes);
        if (taxRes.warning) allWarnings.push(taxRes.warning);
        if (Array.isArray(taxRes.warnings)) allWarnings.push(...taxRes.warnings);

        const detectFileYear = (file) => {
          const d = file.data || {};
          const dateSrc = d.asOfDate || d.periodEnd || d.periodStart;
          if (dateSrc) {
            const y = parseInt(String(dateSrc).split("-")[0], 10);
            if (y >= 2000 && y <= currentYear + 1) return y;
          }
          const m = (file.fileName || "").match(/\b(20\d{2})\b/);
          return m ? parseInt(m[1], 10) : currentYear;
        };

        const yearFileMap = new Map();
        for (const file of files) {
          const yr = detectFileYear(file);
          const existing = yearFileMap.get(yr);
          if (!existing || new Date(file.updatedAt || 0) > new Date(existing.updatedAt || 0)) {
            yearFileMap.set(yr, file);
          }
        }
        for (const [yr, file] of yearFileMap) plRowsByYear[yr] = file.data.rows || [];

        allWarnings.push(
          "Cash/Accrual Adjustments require a Balance Sheet, which QuickBooks Manual mode does not " +
          "provide. Switch to a Key Reports Version with a linked Balance Sheet to calculate them.",
        );
      } else {
        // ── QuickBooks Online ─────────────────────────────────────────────
        const qbWarnings = new Set();
        await Promise.all(selectedYears.map(async (year) => {
          const plUrl = `${API_BASE_URL}/quickbooks-pl?start_date=${year}-01-01&end_date=${year}-12-31&accounting_method=${accountingMethod}&clientId=${clientId || ""}`;
          const taxUrl = `${API_BASE_URL}/tax-data?start_date=${year}-01-01&clientId=${clientId || ""}`;
          const [plRes, taxRes] = await Promise.all([
            fetch(plUrl, { headers }).then((r) => r.json()).catch(() => ({ success: false })),
            fetch(taxUrl, { headers }).then((r) => r.json()).catch(() => ({ success: false })),
          ]);
          if (plRes.success === false && (plRes.error || "").includes("QB not connected")) {
            setIsQBDisconnected(true);
          }
          if (Array.isArray(plRes.rows) && plRes.rows.length) plRowsByYear[year] = plRes.rows;
          else if (Array.isArray(plRes.data)) plRowsByYear[year] = summarisedPlToRows(plRes.data);

          if (taxRes.success && Array.isArray(taxRes.data)) {
            taxYears[year] = {
              year,
              fileName: taxRes.fileName || null,
              status: taxRes.status || null,
              scheduleM1: taxRes.scheduleM1 ?? null,
              data: taxRes.data,
            };
          }
          (plRes.warnings || []).forEach((w) => qbWarnings.add(w));
          if (taxRes.warning) qbWarnings.add(taxRes.warning);
          (taxRes.warnings || []).forEach((w) => qbWarnings.add(w));
        }));
        allWarnings.push(...qbWarnings);
        allWarnings.push(
          "Cash/Accrual Adjustments require a Balance Sheet, which is not fetched in QuickBooks " +
          "Online mode. Switch to a Key Reports Version with a linked Balance Sheet to calculate them.",
        );
      }

      const loadedYears = unionFiscalYears(plRowsByYear, taxYears);
      if (!loadedYears.length) {
        throw new Error(
          isManualMode
            ? "No P&L or tax return data found. Please sync your files via the Connections page."
            : "No P&L or tax return data found for the selected years.",
        );
      }

      setSourceData({ plRowsByYear, taxYears, bsPeriods });
      setWarnings([...new Set(allWarnings)]);
      setSyncStatus({
        status: "success",
        message:
          `Loaded ${loadedYears.length} year(s): FY ${loadedYears.join(", FY ")}` +
          (bsPeriods.length ? ` · ${bsPeriods.length} Balance Sheet period(s).` : "."),
      });
    } catch (err) {
      console.error("Load Error:", err);
      setError(err instanceof Error ? err.message : "Failed to load data");
      setSyncStatus({ status: "error", message: "Failed to refresh" });
    } finally {
      setIsLoading(false);
    }
  }, [
    selectedYears, accountingMethod, clientId, getHeaders, isManualGL, isManualMode,
    isQBManual, currentYear, selectedVersion, kr.krActive, kr.selectedVersionId, loadBsPeriods,
  ]);

  // Key Reports tax return gate
  useEffect(() => {
    if (!clientId) return;
    if (!krSelected) { setKrTaxGate({ status: "ok" }); return; }
    if (kr.loadingDetail) { setKrTaxGate({ status: "loading" }); return; }
    setKrTaxGate({ status: kr.availability.tax ? "ok" : "missing" });
  }, [clientId, krSelected, kr.loadingDetail, kr.availability.tax]);

  const hasSourceData = availableYears.length > 0;

  const autoLoadedSlotRef = useRef(null);
  useEffect(() => {
    if (!activeSource) return;
    if (isManualGL && !selectedVersion) return;
    const slot = `${activeSource}:${taxSlotVersion}`;
    if (autoLoadedSlotRef.current === slot) return;
    if (hasSourceData) return;
    autoLoadedSlotRef.current = slot;
    void loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSource, isManualGL, selectedVersion, taxSlotVersion, hasSourceData]);

  const prevTaxVersionRef = useRef(selectedVersion);
  useEffect(() => {
    if (!isManualGL) return;
    if (prevTaxVersionRef.current === selectedVersion) return;
    prevTaxVersionRef.current = selectedVersion;
    if (!selectedVersion) return;
    try { window.sessionStorage.removeItem(getStorageKey(clientId, activeSource, taxSlotVersion)); } catch { /* ignore */ }
    setSourceData(EMPTY_SOURCE_DATA);
    setError("");
    setWarnings([]);
    setSyncStatus({ status: "idle", message: "" });
    void loadData(true);
  }, [isManualGL, selectedVersion, clientId, loadData, activeSource, taxSlotVersion]);

  // ── Overrides ─────────────────────────────────────────────────────────

  useEffect(() => {
    if (!clientId) return;
    let cancelled = false;
    getTaxReconciliationOverrides({ clientId })
      .then((res) => { if (!cancelled) setReconcilingOverrides(res?.overrides || {}); })
      .catch(() => { /* non-fatal — start with empty overrides */ });
    return () => { cancelled = true; };
  }, [clientId]);

  useEffect(() => {
    if (!showAddRowDropdown) return;
    function onOutsideClick(e) {
      if (addRowRef.current && !addRowRef.current.contains(e.target)) {
        setShowAddRowDropdown(false);
        setAddRowSearch("");
      }
    }
    document.addEventListener("mousedown", onOutsideClick);
    return () => document.removeEventListener("mousedown", onOutsideClick);
  }, [showAddRowDropdown]);

  const saveTimeoutRef = useRef(null);
  const persistOverrides = useCallback((next) => {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => {
      saveTaxReconciliationOverrides({ clientId, overrides: next }).catch(() => {});
    }, 600);
  }, [clientId]);

  const startEdit = useCallback((year, label, currentValue) => {
    setEditingCell({ year, label });
    setEditingValue(currentValue == null || currentValue === 0 ? "" : String(currentValue));
  }, []);

  const commitEdit = useCallback((year, label) => {
    const raw = String(editingValue).replace(/[,\s$]/g, "");
    const numVal = raw === "" || raw === "-" ? 0 : parseFloat(raw);
    const finalVal = Number.isFinite(numVal) ? numVal : 0;

    setReconcilingOverrides((prev) => {
      const yearKey = String(year);
      const existing = prev[yearKey]?.[label];
      const next = {
        ...prev,
        [yearKey]: {
          ...(prev[yearKey] || {}),
          [label]: { taxReturn: finalVal, pl: 0, ...(existing?.userAdded ? { userAdded: true } : {}) },
        },
      };
      persistOverrides(next);
      return next;
    });
    setEditingCell(null);
    setEditingValue("");
  }, [editingValue, persistOverrides]);

  const cancelEdit = useCallback(() => {
    setEditingCell(null);
    setEditingValue("");
  }, []);

  // A manually added Schedule K row. The label is canonicalised first so a typed
  // "other credits" cannot become a second row beside an extracted "Other Credits".
  const addReconRow = useCallback((rawLabel) => {
    const label = canonicalScheduleKLabel(rawLabel);
    if (!label) return;
    setReconcilingOverrides((prev) => {
      const next = { ...prev };
      activeYears.forEach((yr) => {
        const yearKey = String(yr);
        const existing = next[yearKey]?.[label];
        if (existing && !existing.deleted) return;
        next[yearKey] = { ...(next[yearKey] || {}), [label]: { taxReturn: 0, pl: 0, userAdded: true } };
      });
      persistOverrides(next);
      return next;
    });
    setShowAddRowDropdown(false);
    setAddRowSearch("");
  }, [activeYears, persistOverrides]);

  // Restores a previously deleted extracted row by dropping the override, so the
  // engine falls back to the value the tax return actually states.
  const restoreAiRow = useCallback((label) => {
    setReconcilingOverrides((prev) => {
      const next = { ...prev };
      Object.keys(next).forEach((yr) => {
        if (next[yr]?.[label] !== undefined) {
          next[yr] = { ...next[yr] };
          delete next[yr][label];
        }
      });
      persistOverrides(next);
      return next;
    });
    setShowAddRowDropdown(false);
    setAddRowSearch("");
  }, [persistOverrides]);

  const deleteReconRow = useCallback((label) => {
    setReconcilingOverrides((prev) => {
      const isUserAdded = Object.values(prev).some((yr) => yr?.[label]?.userAdded);
      const next = { ...prev };
      if (isUserAdded) {
        Object.keys(next).forEach((yr) => {
          if (next[yr]?.[label] !== undefined) {
            next[yr] = { ...next[yr] };
            delete next[yr][label];
          }
        });
      } else {
        activeYears.forEach((yr) => {
          const yearKey = String(yr);
          next[yearKey] = { ...next[yearKey], [label]: { ...(next[yearKey]?.[label] || {}), deleted: true } };
        });
      }
      persistOverrides(next);
      return next;
    });
  }, [activeYears, persistOverrides]);

  // ── Derived row sets across years ─────────────────────────────────────

  // Union of a per-year section's row labels, so a line present in one year and
  // absent in another still gets a row (with a blank cell for the year that has
  // no such line, rather than the whole row vanishing).
  const unionRows = useCallback((pick) => {
    const labels = [];
    const seen = new Set();
    for (const year of activeYears) {
      for (const item of pick(yearOf(year)) || []) {
        const label = item.category || item.label;
        if (!label || seen.has(label)) continue;
        seen.add(label);
        labels.push(label);
      }
    }
    return labels;
  }, [activeYears, yearOf]);

  const m1Rows = useMemo(() => unionRows((y) => y?.m1?.items), [unionRows]);
  const m1InfoRows = useMemo(() => unionRows((y) => y?.m1?.informationalItems), [unionRows]);
  const scheduleKRows = useMemo(() => unionRows((y) => y?.scheduleK?.items), [unionRows]);

  const scheduleKLabelsFromReturns = useMemo(() => {
    const labels = new Set();
    for (const entry of Object.values(sourceData.taxYears || {})) {
      for (const row of entry?.data || []) {
        if (row?.isReconcilingItem) labels.add(canonicalScheduleKLabel(row.label));
      }
    }
    return [...labels].sort((a, b) => a.localeCompare(b));
  }, [sourceData.taxYears]);

  const reportTitle = company?.name || "Your Company";

  // ── Exports ───────────────────────────────────────────────────────────

  const exportRows = useCallback(() => {
    const rows = [];
    const push = (label, cells) => rows.push([label, ...cells]);
    const perYear = (fn) => activeYears.flatMap((yr) => fn(yearOf(yr)));

    const header1 = ["Source"];
    const header2 = [""];
    for (const yr of activeYears) {
      header1.push(`FY ${yr}`, "", "");
      header2.push("P&L", "Tax Return", "TR Variance");
    }
    rows.push(header1, header2);

    push(`SECTION 1 — ${SECTIONS[0].title}`, perYear(() => ["", "", ""]));
    for (const item of yearOf(activeYears[0])?.statementRows || []) {
      push(item.label, perYear((y) => {
        const row = y?.statementRows?.find((r) => r.key === item.key);
        return [row?.pl ?? "", row?.taxReturn ?? "", row?.variance ?? ""];
      }));
    }
    push("Net Income (derived from the components above)",
      perYear((y) => [y?.financial?.derivedNetIncome ?? "", "", ""]));
    push("Net Income difference (source − derived)",
      perYear((y) => [y?.financial?.netIncomeDiagnosis?.difference ?? "", "", ""]));

    push(`SECTION 2 — ${SECTIONS[1].title}`, perYear(() => ["", "", ""]));
    for (const label of m1Rows) {
      push(label, perYear((y) => {
        const item = y?.m1?.items?.find((i) => i.category === label);
        return [item?.pl ?? "", item?.taxReturn ?? "", item?.adjustment ?? ""];
      }));
    }
    push("Total M1 Adjustments", perYear((y) => ["", "", y?.m1?.total ?? ""]));

    push(`SECTION 3 — ${SECTIONS[2].title}`, perYear((y) => ["", y?.reportedM1BookNetIncome ?? "", ""]));
    push(`SECTION 4 — ${SECTIONS[3].title}`,
      perYear((y) => ["", y?.m1VarianceCheck?.variance ?? "", y?.m1VarianceCheck?.residual ?? ""]));

    push(`SECTION 5 — ${SECTIONS[4].title}`, perYear(() => ["", "", ""]));
    for (const item of yearOf(activeYears[0])?.cashAccrual?.items || []) {
      push(item.label, perYear((y) => {
        const row = y?.cashAccrual?.items?.find((i) => i.label === item.label);
        return [row?.beginningBalance ?? "", row?.endingBalance ?? "", row?.adjustment ?? ""];
      }));
    }
    push("Total Cash/Accrual Adjustments", perYear((y) => ["", "", y?.cashAccrual?.total ?? ""]));

    push(`SECTION 6 — ${SECTIONS[5].title}`, perYear(() => ["", "", ""]));
    for (const item of yearOf(activeYears[0])?.other?.items || []) {
      push(item.label, perYear((y) => {
        const row = y?.other?.items?.find((i) => i.label === item.label);
        return [row?.pl ?? "", row?.taxReturn ?? "", row?.adjustment ?? ""];
      }));
    }
    push("Total Other Adjustments", perYear((y) => ["", "", y?.other?.total ?? ""]));

    push(`SECTION 7 — ${SECTIONS[6].title}`, perYear(() => ["", "", ""]));
    push("Calculated Reconciled Income", perYear((y) => ["", y?.calculatedReconciledIncome ?? "", ""]));
    push("Expected Reconciled Income", perYear((y) => ["", y?.expectedReconciledIncome ?? "", ""]));
    push("Unreconciled Difference", perYear((y) => ["", y?.unreconciled ?? "", ""]));

    push(`SECTION 8 — ${SECTIONS[7].title}`, perYear(() => ["", "", ""]));
    push("SDE", perYear((y) => [y?.sde ?? "", "", ""]));
    push("Unreconciled % of SDE", perYear((y) => [y?.sdePct?.display ?? "n/a", "", ""]));

    push(`SECTION 9 — ${SECTIONS[8].title}`, perYear(() => ["", "", ""]));
    for (const label of scheduleKRows) {
      push(label, perYear((y) => {
        const item = y?.scheduleK?.items?.find((i) => i.label === label);
        return ["", item?.taxReturn ?? "", ""];
      }));
    }

    return rows;
  }, [activeYears, yearOf, m1Rows, scheduleKRows]);

  const exportTaxReconToExcel = () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb, XLSX.utils.aoa_to_sheet(exportRows()), "Tax Reconciliation",
    );

    // A second sheet carrying the audit trail: every footing check and every
    // reason the report does not reconcile. Exporting the numbers without them
    // would reproduce the "numbers that don't foot with no explanation" problem
    // in a file the client can circulate.
    const audit = [["Fiscal Year", "Check", "Actual", "Expected", "Difference", "Status", "Detail"]];
    for (const year of reconciliation.years) {
      for (const check of reconciliation.byYear[year]?.footing || []) {
        audit.push([year, check.label, check.actual, check.expected, check.difference,
          check.ok ? "OK" : "FAILED", check.detail || ""]);
      }
    }
    if (blockers.length) {
      audit.push([], ["Unresolved items preventing a complete reconciliation"]);
      for (const b of blockers) audit.push([b.years.join(", "), b.message]);
    }
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(audit), "Validation");

    XLSX.writeFile(wb, "Tax Reconciliation.xlsx");
  };

  const exportTaxReconToPdf = () => {
    const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
    const PAGE_W = 841.89;
    const PAGE_H = 595.28;
    const MARGIN = 30;
    const usableW = PAGE_W - MARGIN * 2;
    const LABEL_COL = 190;
    const colCount = Math.max(1, activeYears.length * 3);
    const colW = (usableW - LABEL_COL) / colCount;
    const ROW_H = 15;
    const FS = 7;
    let y = MARGIN;

    const rows = exportRows();
    const fmt = (v) => {
      if (v === "" || v === null || v === undefined) return "";
      const n = Number(v);
      if (!Number.isFinite(n)) return String(v);
      return n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    };

    doc.setFontSize(13);
    doc.setFont("helvetica", "bold");
    doc.text(`Tax Reconciliation — ${reportTitle}`, MARGIN, y + 11);
    y += 26;

    rows.forEach((row, idx) => {
      if (y + ROW_H > PAGE_H - MARGIN) { doc.addPage(); y = MARGIN; }
      const isSection = String(row[0]).startsWith("SECTION");
      const isHeader = idx < 2;
      doc.setFont("helvetica", isSection || isHeader || /^Total |^Unreconciled|^Calculated|^Expected/.test(String(row[0])) ? "bold" : "normal");
      doc.setFontSize(FS);
      if (isSection) {
        doc.setFillColor(238, 246, 224);
        doc.rect(MARGIN, y, usableW, ROW_H, "F");
      }
      doc.setTextColor(0, 0, 0);
      doc.text(String(row[0]).slice(0, 46), MARGIN + 3, y + ROW_H - 4);
      for (let c = 1; c < row.length; c += 1) {
        const x = MARGIN + LABEL_COL + c * colW - 3;
        const text = fmt(row[c]);
        if (text) doc.text(text, x, y + ROW_H - 4, { align: "right" });
      }
      doc.setDrawColor(215, 215, 215);
      doc.line(MARGIN, y + ROW_H, MARGIN + usableW, y + ROW_H);
      y += ROW_H;
    });

    if (footingFailures.length || blockers.length) {
      doc.addPage();
      y = MARGIN;
      doc.setFont("helvetica", "bold");
      doc.setFontSize(11);
      doc.text("Validation — unresolved items", MARGIN, y + 10);
      y += 24;
      doc.setFontSize(FS + 1);
      for (const f of footingFailures) {
        doc.setFont("helvetica", "normal");
        doc.text(`FY ${f.fiscalYear}: ${f.label} — difference ${f.difference}`.slice(0, 150), MARGIN, y);
        y += 13;
        if (y > PAGE_H - MARGIN) { doc.addPage(); y = MARGIN; }
      }
      for (const b of blockers) {
        doc.setFont("helvetica", "normal");
        doc.text(`FY ${b.years.join(", ")}: ${b.message}`.slice(0, 150), MARGIN, y);
        y += 13;
        if (y > PAGE_H - MARGIN) { doc.addPage(); y = MARGIN; }
      }
    }

    doc.save("Tax Reconciliation.pdf");
  };

  const handleTaxExport = (kind) => {
    setTaxExportOpen(false);
    setTaxIsExporting(true);
    try {
      if (kind === "excel") exportTaxReconToExcel();
      else exportTaxReconToPdf();
    } catch (err) {
      console.error("[TaxRecon] Export failed:", err);
      alert(err?.message || "Export failed. Please try again.");
    } finally {
      setTaxIsExporting(false);
    }
  };

  const TaxExportDropdown = (
    <div className="relative">
      <button
        type="button"
        onClick={() => setTaxExportOpen((v) => !v)}
        disabled={taxIsExporting}
        className="inline-flex h-9 items-center justify-center gap-2 rounded-xl border border-border bg-bg-card px-3 text-[13px] font-medium text-text-primary transition hover:bg-bg-page disabled:cursor-not-allowed disabled:opacity-70"
      >
        <Download size={14} className={taxIsExporting ? "animate-pulse" : ""} />
        {taxIsExporting ? "Exporting…" : "Export"}
        <ChevronDown size={12} />
      </button>
      {taxExportOpen && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setTaxExportOpen(false)} />
          <div className="absolute right-0 z-20 mt-1 w-48 overflow-hidden rounded-md border border-border bg-bg-card shadow-lg">
            <button
              type="button"
              onClick={() => handleTaxExport("excel")}
              className="block w-full px-3 py-2 text-left text-[13px] text-text-primary transition-colors hover:bg-bg-page"
            >
              Export to Excel (.xlsx)
            </button>
            <button
              type="button"
              onClick={() => handleTaxExport("pdf")}
              className="block w-full px-3 py-2 text-left text-[13px] text-text-primary transition-colors hover:bg-bg-page"
            >
              Export to PDF (.pdf)
            </button>
          </div>
        </>
      )}
    </div>
  );

  // ── Grid context ──────────────────────────────────────────────────────
  //
  // SectionRow / DataRow / Cell are declared at MODULE scope (below) and read
  // what they need from here. Declaring them inside the component would give each
  // render a new component identity, so React would unmount and remount the
  // inline editor's <input> on every keystroke — losing the caret. They take the
  // grid's year list and edit state through this context instead.
  const gridContext = useMemo(() => ({
    activeYears,
    yearOf,
    editingValue,
    setEditingValue,
    cancelEdit,
  }), [activeYears, yearOf, editingValue, cancelEdit]);

  const editableCell = (year, label, value, { hint, isOverride } = {}) => ({
    value,
    text: formatCheck(value),
    tone: value ? "bg-primary/5 text-primary" : "text-text-secondary",
    editable: true,
    underline: isOverride,
    hint: hint || "Click to enter a value. Manual entries are saved and survive refresh and sync.",
    isEditing: editingCell?.year === year && editingCell?.label === label,
    onEdit: {
      start: () => startEdit(year, label, value),
      commit: () => commitEdit(year, label),
    },
  });

  const blank = BLANK_CELL;
  const yrDiv = (idx) => yearDivider(idx, activeYears.length);

  // ── Frozen header / horizontal scroll sync ────────────────────────────
  //
  // The header is a separate table in a sibling element so it can be sticky to
  // the PAGE (see the comment at the grid below). That costs one thing: the two
  // tables no longer share a layout box, so their columns must be kept identical
  // by construction — the same colgroup widths, the same minWidth, and
  // `table-layout: fixed` on both so the colgroup is authoritative rather than
  // content-dependent (content-based sizing would let the two tables disagree).
  const gridMinWidth = LABEL_COL_WIDTH + activeYears.length * VALUE_COL_WIDTH * 3;

  const headerScrollRef = useRef(null);
  const bodyScrollRef = useRef(null);

  // Mirror the body's horizontal scroll onto the header. Written directly to the
  // DOM rather than through state: this fires on every scroll frame, and routing
  // it through a re-render would drop frames and visibly lag the header behind
  // the columns it labels.
  const syncHeaderScroll = useCallback(() => {
    const header = headerScrollRef.current;
    const body = bodyScrollRef.current;
    if (!header || !body) return;
    if (header.scrollLeft !== body.scrollLeft) header.scrollLeft = body.scrollLeft;
  }, []);

  // Re-sync when the column set changes: a year added or removed re-lays out both
  // tables, and the browser may clamp the body's scrollLeft without firing a
  // scroll event, which would leave the header offset from the body.
  useEffect(() => {
    syncHeaderScroll();
  }, [activeYears, syncHeaderScroll]);

  // ── Render ────────────────────────────────────────────────────────────

  const firstYear = activeYears[0];
  const firstYearData = firstYear != null ? yearOf(firstYear) : null;

  return (
    <div className="space-y-6">

      {krTaxGate.status === "missing" && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4">
          <div className="flex items-start gap-3">
            <AlertCircle size={18} className="mt-0.5 shrink-0 text-amber-600" />
            <div>
              <p className="text-sm font-semibold text-amber-800">Tax Return missing in Key Reports</p>
              <p className="mt-1 text-sm text-amber-700">
                A <strong>Tax Return</strong> is not linked in the selected Key Reports Version.
                The Tax Return and TR Variance columns show no data, and the reconciliation cannot
                be completed, until a return is linked.
              </p>
              <button
                onClick={() => navigate(`/broker/client/${clientId}/dataroom/key-reports`)}
                className="mt-2 text-sm font-semibold text-amber-800 underline hover:text-amber-900"
              >
                Link Tax Return in Key Reports →
              </button>
            </div>
          </div>
        </div>
      )}

      {useManualLayout && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-wrap items-center gap-3">
              {syncStatus?.message && <SyncStatus sync={syncStatus} />}
              {krSelected && <KeyReportVersionSelector clientId={clientId} variant="filter" />}
              {krSelected && availableYears.length > 0 && [
                { label: "Start Year", value: startYear, set: setStartYear },
                { label: "End Year", value: endYear, set: setEndYear },
              ].map(({ label, value, set }) => (
                <label key={label} className="flex items-center gap-2 text-[13px] font-medium text-text-primary">
                  {label}
                  <select
                    value={value}
                    onChange={(e) => set(e.target.value)}
                    className="h-9 rounded-xl border border-border bg-white px-3 text-[13px] text-text-primary outline-none transition focus:border-primary"
                  >
                    {availableYears.map((y) => <option key={y} value={String(y)}>{y}</option>)}
                  </select>
                </label>
              ))}
              {/* The basis the RETURN was filed on drives the cash/accrual sign
                  convention, so it belongs beside the data in every mode. */}
              <label className="flex items-center gap-2 text-[13px] font-medium text-text-primary">
                Return Basis
                <select
                  value={accountingMethod}
                  onChange={(e) => setAccountingMethod(e.target.value)}
                  className="h-9 rounded-xl border border-border bg-white px-3 text-[13px] text-text-primary outline-none transition focus:border-primary"
                >
                  <option value="Cash">Cash</option>
                  <option value="Accrual">Accrual</option>
                </select>
              </label>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  try { window.sessionStorage.removeItem(getStorageKey(clientId, activeSource, taxSlotVersion)); } catch { /* ignore */ }
                  setSourceData(EMPTY_SOURCE_DATA);
                  void loadData(true);
                }}
                disabled={isLoading}
                className="inline-flex h-9 items-center justify-center gap-2 rounded-xl bg-primary px-4 text-[13px] font-semibold text-white transition hover:bg-primary-dark disabled:cursor-not-allowed disabled:opacity-70"
              >
                <RefreshCw size={14} className={cn(isLoading && "animate-spin")} />
                {isLoading ? "Syncing…" : "Sync"}
              </button>
              {TaxExportDropdown}
            </div>
          </div>
          {warnings.length > 0 && !error && <WarningList warnings={warnings} />}
          {error && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
              {error}
            </div>
          )}
        </div>
      )}

      {!useManualLayout && (
        <section className="rounded-[var(--radius-card)] border border-border bg-white p-5 shadow-[0_10px_30px_rgba(15,23,42,0.04)] lg:p-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h1 className="text-[20px] font-semibold text-text-primary">Tax Reconciliation</h1>
              <p className="mt-1 text-[14px] text-text-secondary">
                {isQBManual
                  ? `QuickBooks Manual tax-to-book reconciliation for ${reportTitle}.`
                  : `QuickBooks tax-to-book and SDE reconciliation for ${reportTitle}.`}
              </p>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              {!isQBManual && [
                { label: "Start Year", value: startYear, set: setStartYear },
                { label: "End Year", value: endYear, set: setEndYear },
              ].map(({ label, value, set }) => (
                <label key={label} className="flex min-w-[120px] flex-col gap-1.5 text-[13px] font-medium text-text-primary">
                  {label}
                  <select
                    value={value}
                    onChange={(e) => set(e.target.value)}
                    className="h-11 rounded-xl border border-border bg-white px-3 text-[14px] text-text-primary outline-none transition focus:border-primary"
                  >
                    {YEAR_OPTIONS.map((y) => <option key={y} value={y}>{y}</option>)}
                  </select>
                </label>
              ))}

              <label className="flex min-w-[140px] flex-col gap-1.5 text-[13px] font-medium text-text-primary">
                Return Basis
                <select
                  value={accountingMethod}
                  onChange={(e) => setAccountingMethod(e.target.value)}
                  className="h-11 rounded-xl border border-border bg-white px-3 text-[14px] text-text-primary outline-none transition focus:border-primary"
                >
                  <option value="Accrual">Accrual</option>
                  <option value="Cash">Cash</option>
                </select>
              </label>

              <button
                type="button"
                onClick={() => {
                  try { window.sessionStorage.removeItem(getStorageKey(clientId, activeSource, taxSlotVersion)); } catch { /* ignore */ }
                  setSourceData(EMPTY_SOURCE_DATA);
                  void loadData(true);
                }}
                disabled={isLoading}
                className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-primary px-4 text-[14px] font-semibold text-white transition hover:bg-primary-dark disabled:cursor-not-allowed disabled:opacity-70"
              >
                <RefreshCw size={16} className={cn(isLoading && "animate-spin")} />
                Refresh
              </button>
              {TaxExportDropdown}
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <SyncStatus sync={syncStatus} />
          </div>

          {warnings.length > 0 && !error && <div className="mt-4"><WarningList warnings={warnings} /></div>}
          {error && !isQBDisconnected && (
            <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
              {error}
            </div>
          )}
        </section>
      )}

      {/* ── Validation summary ─────────────────────────────────────────── */}
      {(footingFailures.length > 0 || blockers.length > 0) && activeYears.length > 0 && (
        <section className="rounded-[var(--radius-card)] border border-amber-200 bg-amber-50/70 px-5 py-4">
          <div className="flex items-start gap-3">
            <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-600" />
            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-semibold text-amber-900">
                This reconciliation does not fully foot. The actual differences are shown below — nothing has been rounded away or forced to zero.
              </p>
              <ul className="mt-2 space-y-1 text-[13px] text-amber-800">
                {blockers.map((b) => (
                  <li key={b.message} className="flex gap-2">
                    <span className="shrink-0 font-semibold">FY {b.years.join(", ")}:</span>
                    <span>{b.message}</span>
                  </li>
                ))}
                {footingFailures.map((f, i) => (
                  <li key={`${f.fiscalYear}-${f.label}-${i}`} className="flex gap-2">
                    <span className="shrink-0 font-semibold">FY {f.fiscalYear}:</span>
                    <span>
                      {f.label} — off by <strong>{formatCheck(f.difference)}</strong>
                      {f.detail ? ` (${f.detail})` : ""}
                    </span>
                  </li>
                ))}
              </ul>
              <button
                onClick={() => setShowDiagnostics((v) => !v)}
                className="mt-2 text-[13px] font-semibold text-amber-900 underline hover:text-amber-950"
              >
                {showDiagnostics ? "Hide" : "Show"} per-component diagnosis
              </button>
              {showDiagnostics && (
                <div className="mt-3 space-y-3">
                  {activeYears.map((year) => {
                    const y = yearOf(year);
                    const dx = y?.financial?.netIncomeDiagnosis;
                    if (!dx || dx.status === "agrees") return null;
                    return (
                      <div key={year} className="rounded-lg border border-amber-200 bg-white/70 px-3 py-2">
                        <p className="text-[13px] font-semibold text-amber-900">FY {year} — Net Income</p>
                        <p className="mt-0.5 text-[12px] text-amber-800">{dx.message}</p>
                        {dx.candidates.length > 0 && (
                          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[12px] text-amber-800">
                            {dx.candidates.map((c, i) => <li key={i}>{c.detail}</li>)}
                          </ul>
                        )}
                      </div>
                    );
                  })}
                  {activeYears.map((year) => {
                    const unmapped = yearOf(year)?.financial?.unclassified || [];
                    if (!unmapped.length) return null;
                    return (
                      <div key={`u-${year}`} className="rounded-lg border border-amber-200 bg-white/70 px-3 py-2">
                        <p className="text-[13px] font-semibold text-amber-900">
                          FY {year} — unclassified P&amp;L accounts (excluded from every total)
                        </p>
                        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[12px] text-amber-800">
                          {unmapped.map((r, i) => (
                            <li key={i}>{r.name} ({formatCheck(r.amount)}) — {r.reason}</li>
                          ))}
                        </ul>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </section>
      )}

      {/* ── The reconciliation grid ─────────────────────────────────────── */}
      <section className="rounded-[var(--radius-card)] border border-border bg-white shadow-[0_10px_30px_rgba(15,23,42,0.04)]">
        <div className="border-b border-border px-5 py-4">
          <h2 className="text-[16px] font-semibold text-text-primary">Tax Reconciliation</h2>
          <p className="mt-1 text-[13px] text-text-secondary">
            {activeYears.length > 0
              ? `FY ${activeYears[0]}${activeYears.length > 1 ? `–FY ${activeYears[activeYears.length - 1]}` : ""} · ` +
                `TR Variance = Tax Return − P&L · adjustments are signed to move book income toward tax income.`
              : "Awaiting data load."}
          </p>
        </div>

        {/*
          FROZEN HEADER, ONE SCROLLBAR.
          ──────────────────────────────────────────────────────────────────────
          The two header rows live in their OWN table, in an element that is a
          SIBLING of the scrolling body rather than a child of it. That is what
          makes both requirements possible at once:

            • The header element is `sticky top-0`. Because none of its ancestors
              is a scroll container, its sticky context is the layout's <main>
              (`overflow-y-auto` in ClientWorkspaceLayout) — the page scrollbar
              the user already has. So the header freezes on page scroll.

            • The body element keeps `overflow-x-auto` for the year columns and
              has NO height cap, so it never grows a vertical scrollbar of its own.

          Why the header cannot simply be a sticky <thead> inside the body: CSS
          forces `overflow-y` to compute to `auto` whenever `overflow-x` is `auto`,
          so the body is unavoidably a scroll container on BOTH axes, and a
          `top: 0` inside it would resolve against the body's own scrollport —
          which never scrolls vertically — instead of the page's. Capping the
          body's height was the only way to give a sticky <thead> something to
          stick to, and that is exactly the second scrollbar the client rejected.

          The two tables stay in column lock-step through `table-layout: fixed`
          plus an identical <colgroup> and minWidth, and horizontal scrolling is
          mirrored onto the header by syncHeaderScroll below.
        */}
        {activeYears.length > 0 && (
          <div
            ref={headerScrollRef}
            className="sticky top-0 z-30 overflow-hidden bg-[#F8FBF1]"
          >
            <table
              aria-label="Tax Reconciliation column headers"
              className="w-full border-collapse text-[13px]"
              style={{ tableLayout: "fixed", minWidth: gridMinWidth }}
            >
              <colgroup>
                <col style={{ width: `${LABEL_COL_WIDTH}px` }} />
                {activeYears.map((y) => (
                  <Fragment key={y}>
                    <col style={{ width: `${VALUE_COL_WIDTH}px` }} />
                    <col style={{ width: `${VALUE_COL_WIDTH}px` }} />
                    <col style={{ width: `${VALUE_COL_WIDTH}px` }} />
                  </Fragment>
                ))}
              </colgroup>
              <thead>
                <tr className="bg-[#F8FBF1] text-primary">
                  {/* Frozen label column — sticky to the LEFT edge, the axis this
                      grid actually scrolls on. */}
                  <th
                    rowSpan={2}
                    scope="col"
                    className="sticky left-0 z-40 border-b border-r border-border bg-[#F8FBF1] px-4 py-3 text-left align-bottom text-[12px] font-semibold uppercase tracking-wide"
                  >
                    Source
                  </th>
                  {activeYears.map((year, idx) => {
                    const y = yearOf(year);
                    return (
                      <th
                        key={year}
                        colSpan={3}
                        scope="colgroup"
                        className={cn(
                          "border-b border-border bg-[#F8FBF1] px-4 py-2.5 text-center text-[13px] font-bold",
                          yrDiv(idx),
                        )}
                      >
                        FY {year}
                        {!y?.taxReturn?.available && (
                          <span
                            className="ml-1.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-800"
                            title={y?.taxReturn?.reason || "No tax return available for this year."}
                          >
                            no return
                          </span>
                        )}
                      </th>
                    );
                  })}
                </tr>
                <tr className="bg-[#F8FBF1]/95 text-primary/80">
                  {activeYears.map((year, idx) => (
                    <Fragment key={year}>
                      <th scope="col" className="border-b-2 border-border bg-[#F4F9E9] px-4 py-2 text-right text-[11px] font-semibold uppercase tracking-wide">P&amp;L</th>
                      <th scope="col" className="border-b-2 border-border bg-[#F4F9E9] px-4 py-2 text-right text-[11px] font-semibold uppercase tracking-wide">Tax Return</th>
                      <th scope="col" className={cn("border-b-2 border-border bg-[#F4F9E9] px-4 py-2 text-right text-[11px] font-semibold uppercase tracking-wide", yrDiv(idx))}>TR Variance</th>
                    </Fragment>
                  ))}
                </tr>
              </thead>
            </table>
          </div>
        )}

        <div
          id="tax-recon-table"
          ref={bodyScrollRef}
          onScroll={syncHeaderScroll}
          className="relative overflow-x-auto"
        >
          <GridContext.Provider value={gridContext}>
          {/* The column headers for this grid live in the frozen header table
              above, so this table is labelled explicitly rather than relying on a
              <thead> of its own. Row labels remain real <th scope="row"> cells. */}
          <table
            aria-label={
              activeYears.length
                ? `Tax Reconciliation values, FY ${activeYears[0]} to FY ${activeYears[activeYears.length - 1]}`
                : "Tax Reconciliation values"
            }
            className="w-full border-collapse text-[13px]"
            style={{ tableLayout: "fixed", minWidth: gridMinWidth }}
          >
            <colgroup>
              <col style={{ width: `${LABEL_COL_WIDTH}px` }} />
              {activeYears.map((y) => (
                <Fragment key={y}>
                  <col style={{ width: `${VALUE_COL_WIDTH}px` }} />
                  <col style={{ width: `${VALUE_COL_WIDTH}px` }} />
                  <col style={{ width: `${VALUE_COL_WIDTH}px` }} />
                </Fragment>
              ))}
            </colgroup>

            {activeYears.length === 0 ? (
              <tbody>
                <tr>
                  <td colSpan={1 + activeYears.length * 3} className="px-5 py-10 text-center text-[13px] text-text-muted">
                    {isLoading ? "Loading…" : "No data returned. Click Sync to load."}
                  </td>
                </tr>
              </tbody>
            ) : (
              <tbody>
                {/* ══ SECTION 1 — Financial Statement Reconciliation ══ */}
                <SectionRow section={SECTIONS[0]} note="Derived from the uploaded P&L by account classification — every account lands in exactly one line." />
                {(firstYearData?.statementRows || []).map((template) => (
                  <DataRow
                    key={template.key}
                    label={template.label}
                    bold={template.subtotal}
                    tint={template.subtotal ? "bg-[#FAFBF7]" : undefined}
                    cells={(year, y) => {
                      const row = y?.statementRows?.find((r) => r.key === template.key);
                      if (!row) return [blank, blank, blank];
                      return [
                        { value: row.pl, tone: "text-text-secondary" },
                        row.taxReturn == null
                          ? { text: "—", tone: "text-text-muted", hint: y?.taxReturn?.reason || undefined }
                          : { value: row.taxReturn, tone: row.taxReturn ? "bg-primary/5 text-primary" : "text-text-secondary" },
                        row.variance == null ? blank : { value: row.variance, tone: getVarianceClass(row.variance) },
                      ];
                    }}
                  />
                ))}
                {/* Net Income validation (Part 3) — the derived figure and the
                    actual difference, side by side with the source figure above. */}
                <DataRow
                  label="Net Income — derived from the components above"
                  indent={1}
                  title="Gross Profit − officer wages − depreciation − amortization − interest expense + interest income − other expenses + other income."
                  cells={(year, y) => [
                    { value: y?.financial?.derivedNetIncome, text: formatCheck(y?.financial?.derivedNetIncome), tone: "text-text-secondary" },
                    blank,
                    blank,
                  ]}
                />
                <DataRow
                  label="Net Income check (P&L stated − derived)"
                  indent={1}
                  bold
                  title="A non-zero value means the P&L's own Net Income line does not agree with its own components. The real difference is shown; it is never forced to zero."
                  cells={(year, y) => {
                    const dx = y?.financial?.netIncomeDiagnosis;
                    const agrees = dx?.status === "agrees" || dx?.status === "no_source_figure";
                    return [
                      {
                        value: dx?.difference,
                        text: formatCheck(dx?.difference ?? 0),
                        tone: getCheckClass(dx?.difference ?? 0, agrees),
                        hint: dx?.message,
                      },
                      blank,
                      blank,
                    ];
                  }}
                />

                {/* ══ SECTION 2 — M1 Adjustments ══ */}
                <SectionRow
                  section={SECTIONS[1]}
                  note="Signed to move book income toward tax income. Values are editable and saved."
                />
                {m1Rows.length === 0 ? (
                  <EmptyRow span={1 + activeYears.length * 3}>
                    No M1 adjustments were found on the linked tax return(s).
                  </EmptyRow>
                ) : m1Rows.map((label) => (
                  <DataRow
                    key={label}
                    label={label}
                    indent={1}
                    onDelete={() => deleteReconRow(label)}
                    cells={(year, y) => {
                      const item = y?.m1?.items?.find((i) => i.category === label);
                      if (!item) return [blank, blank, blank];
                      return [
                        item.pl == null ? blank : { value: item.pl, tone: "text-text-secondary" },
                        editableCell(year, label, item.taxReturn, {
                          isOverride: item.isOverride,
                          hint:
                            `${item.reason}\nSource: ${item.sourceLabels.join(" + ")}` +
                            `${item.m1Line ? ` (${item.m1Line})` : ""}` +
                            `${item.sourceDocument ? `\nDocument: ${item.sourceDocument}` : ""}` +
                            `\nFiscal year: ${item.fiscalYear}`,
                        }),
                        { value: item.adjustment, tone: getVarianceClass(item.adjustment) },
                      ];
                    }}
                  />
                ))}
                <DataRow
                  label="Total M1 Adjustments"
                  bold
                  tint="bg-[#FAFBF7]"
                  cells={(year, y) => [blank, blank, { value: y?.m1?.total, text: formatCheck(y?.m1?.total ?? 0), tone: getVarianceClass(y?.m1?.total) }]}
                />
                {m1InfoRows.length > 0 && (
                  <>
                    <DataRow
                      label="Disclosed with no income effect (not added)"
                      indent={1}
                      title="Tax-return lines that are AMT disclosures, equity movements, credits, or restatements of an amount already adjusted above. They are shown for completeness and deliberately excluded from the total — including them would double-adjust the reconciliation."
                      cells={() => [blank, blank, blank]}
                    />
                    {m1InfoRows.map((label) => (
                      <DataRow
                        key={`info-${label}`}
                        label={label}
                        indent={2}
                        cells={(year, y) => {
                          const item = y?.m1?.informationalItems?.find((i) => i.category === label);
                          if (!item) return [blank, blank, blank];
                          return [
                            blank,
                            { value: item.taxReturn, tone: "text-text-muted", hint: item.note || item.reason },
                            { text: "no effect", tone: "text-text-muted text-[11px]", hint: item.note || item.reason },
                          ];
                        }}
                      />
                    ))}
                  </>
                )}

                {/* ══ SECTION 3 — Reported M1 Book Net Income ══ */}
                <SectionRow section={SECTIONS[2]} note="Schedule M-1 line 1 — “Net income (loss) per books”, as filed." />
                <DataRow
                  label="Reported M1 Book Net Income"
                  bold
                  cells={(year, y) => [
                    blank,
                    y?.reportedM1BookNetIncome == null
                      ? { text: "not on return", tone: "text-amber-700 text-[11px]", hint: y?.m1VarianceCheck?.reason }
                      : { value: y.reportedM1BookNetIncome, text: formatCheck(y.reportedM1BookNetIncome), tone: "bg-primary/5 text-primary" },
                    blank,
                  ]}
                />

                {/* ══ SECTION 4 — M1 Variance Check ══ */}
                <SectionRow section={SECTIONS[3]} note="Book Net Income vs the return's reported book income — the gap Sections 5 and 6 must explain." />
                <DataRow
                  label="Book Net Income (per P&L)"
                  cells={(year, y) => [{ value: y?.bookNetIncome, text: formatCheck(y?.bookNetIncome ?? 0), tone: "text-text-secondary" }, blank, blank]}
                />
                <DataRow
                  label="Variance to Reported M1 Book Net Income"
                  bold
                  cells={(year, y) => {
                    const v = y?.m1VarianceCheck;
                    if (!v?.available) return [blank, { text: "n/a", tone: "text-text-muted", hint: v?.reason }, blank];
                    return [
                      blank,
                      { value: v.variance, text: formatCheck(v.variance), tone: getCheckClass(v.variance, Math.abs(v.variance) < 0.01) },
                      blank,
                    ];
                  }}
                />
                <DataRow
                  label="Residual after Cash/Accrual + Other"
                  indent={1}
                  bold
                  title="Book Net Income + Cash/Accrual + Other − Reported M1 Book Net Income. Zero means the book-basis gap is fully explained."
                  cells={(year, y) => {
                    const v = y?.m1VarianceCheck;
                    if (!v?.available) return [blank, { text: "n/a", tone: "text-text-muted", hint: v?.reason }, blank];
                    return [
                      blank,
                      { value: v.residual, text: formatCheck(v.residual), tone: getCheckClass(v.residual, Math.abs(v.residual) < 0.01) },
                      blank,
                    ];
                  }}
                />

                {/* ══ SECTION 5 — Cash / Accrual Adjustments ══ */}
                <SectionRow
                  section={SECTIONS[4]}
                  note={
                    `Beginning = prior fiscal period Balance Sheet · Ending = current fiscal period · Change = Ending − Beginning. ` +
                    `Columns show Beginning, Ending, Adjustment.`
                  }
                />
                {(firstYearData?.cashAccrual?.items || []).map((template) => (
                  <DataRow
                    key={template.label}
                    label={template.label}
                    indent={1}
                    cells={(year, y) => {
                      const row = y?.cashAccrual?.items?.find((i) => i.label === template.label);
                      if (!row) return [blank, blank, blank];
                      if (!row.available) {
                        return [
                          { text: "—", tone: "text-text-muted", hint: row.reason },
                          { text: "—", tone: "text-text-muted", hint: row.reason },
                          { text: "unavailable", tone: "text-amber-700 text-[11px]", hint: row.reason },
                        ];
                      }
                      return [
                        { value: row.beginningBalance, tone: "text-text-secondary", hint: `As of ${row.beginningAsOfDate}` },
                        { value: row.endingBalance, tone: "text-text-secondary", hint: `As of ${row.endingAsOfDate}` },
                        editableCell(year, template.label, row.adjustment, {
                          isOverride: row.isOverride,
                          hint: `${row.reason}\nChange: ${formatCheck(row.change)}`,
                        }),
                      ];
                    }}
                  />
                ))}
                <DataRow
                  label="Total Cash/Accrual Adjustments"
                  bold
                  tint="bg-[#FAFBF7]"
                  cells={(year, y) => [
                    blank,
                    y?.cashAccrual?.complete
                      ? blank
                      : { text: "incomplete", tone: "text-amber-700 text-[11px]", hint: y?.cashAccrual?.reason },
                    { value: y?.cashAccrual?.total, text: formatCheck(y?.cashAccrual?.total ?? 0), tone: getVarianceClass(y?.cashAccrual?.total) },
                  ]}
                />

                {/* ══ SECTION 6 — Other Adjustments ══ */}
                <SectionRow
                  section={SECTIONS[5]}
                  note="Genuine residuals only. Nothing is ever computed into “Other” to make the report balance."
                />
                {(firstYearData?.other?.items || []).map((template) => (
                  <DataRow
                    key={template.label}
                    label={template.label}
                    indent={1}
                    cells={(year, y) => {
                      const row = y?.other?.items?.find((i) => i.label === template.label);
                      if (!row) return [blank, blank, blank];
                      return [
                        row.pl == null ? blank : { value: row.pl, tone: "text-text-secondary" },
                        row.taxReturn == null ? blank : { value: row.taxReturn, tone: "text-text-secondary" },
                        row.adjustment == null
                          ? { text: "unavailable", tone: "text-amber-700 text-[11px]", hint: row.reason }
                          : editableCell(year, template.label, row.adjustment, {
                            isOverride: row.isOverride,
                            hint: row.reason,
                          }),
                      ];
                    }}
                  />
                ))}
                <DataRow
                  label="Total Other Adjustments"
                  bold
                  tint="bg-[#FAFBF7]"
                  cells={(year, y) => [blank, blank, { value: y?.other?.total, text: formatCheck(y?.other?.total ?? 0), tone: getVarianceClass(y?.other?.total) }]}
                />

                {/* ══ SECTION 7 — Tax to Book Reconciliation Check ══ */}
                <SectionRow
                  section={SECTIONS[6]}
                  note="Book Net Income + M1 + Cash/Accrual + Other = Calculated. Calculated − Expected = Unreconciled Difference."
                />
                <DataRow
                  label="Calculated Reconciled Income"
                  cells={(year, y) => [blank, { value: y?.calculatedReconciledIncome, text: formatCheck(y?.calculatedReconciledIncome ?? 0), tone: "text-text-secondary" }, blank]}
                />
                <DataRow
                  label="Expected Reconciled Income (per tax return)"
                  cells={(year, y) => [
                    blank,
                    y?.expectedReconciledIncome == null
                      ? { text: "not on return", tone: "text-amber-700 text-[11px]", hint: y?.m1VarianceCheck?.reason || y?.taxReturn?.reason }
                      : { value: y.expectedReconciledIncome, text: formatCheck(y.expectedReconciledIncome), tone: "bg-primary/5 text-primary" },
                    blank,
                  ]}
                />
                <DataRow
                  label="Unreconciled Difference"
                  bold
                  tint="bg-[#FAFBF7]"
                  title="The actual signed residual. It is never rounded away, forced to zero, or absorbed into another section."
                  cells={(year, y) => [
                    blank,
                    y?.unreconciled == null
                      ? { text: "n/a", tone: "text-text-muted", hint: "The tax return does not state a reconciled income figure, so no difference can be computed." }
                      : {
                        value: y.unreconciled,
                        text: formatCheck(y.unreconciled),
                        tone: getCheckClass(y.unreconciled, y.reconciled),
                        hint: y.reconciled ? "Fully reconciled." : "Unexplained difference — see the validation panel above.",
                      },
                    y?.reconciled
                      ? { text: "reconciled", tone: "text-emerald-700 text-[11px] font-semibold" }
                      : blank,
                  ]}
                />

                {/* ══ SECTION 8 — Unreconciled % of SDE ══ */}
                <SectionRow
                  section={SECTIONS[7]}
                  note="ABS(Unreconciled Difference) ÷ SDE × 100. SDE = Net Income + officer wages + depreciation + amortization + interest expense − interest income."
                />
                <DataRow
                  label="SDE"
                  cells={(year, y) => [{ value: y?.sde, text: formatCheck(y?.sde ?? 0), tone: "text-text-secondary" }, blank, blank]}
                />
                <DataRow
                  label="Unreconciled % of SDE"
                  bold
                  tint="bg-[#FAFBF7]"
                  cells={(year, y) => {
                    const p = y?.sdePct;
                    return [
                      {
                        text: p?.display ?? "n/a",
                        tone: p?.status === "ok"
                          ? (y?.reconciled ? "text-emerald-700" : "text-text-primary")
                          : "text-amber-700",
                        hint: p?.reason || undefined,
                      },
                      blank,
                      blank,
                    ];
                  }}
                />

                {/* ══ SECTION 9 — Schedule K ══ */}
                <SectionRow
                  section={SECTIONS[8]}
                  note="Every item keeps its source document and tax year. Manual entries survive refresh, sync and recalculation."
                />
                {scheduleKRows.length === 0 ? (
                  <EmptyRow span={1 + activeYears.length * 3}>
                    No Schedule K items found. Add items with the button below.
                  </EmptyRow>
                ) : scheduleKRows.map((label) => (
                  <DataRow
                    key={`sk-${label}`}
                    label={label}
                    indent={1}
                    onDelete={() => deleteReconRow(label)}
                    cells={(year, y) => {
                      const item = y?.scheduleK?.items?.find((i) => i.label === label);
                      if (!item) return [blank, blank, blank];
                      return [
                        blank,
                        editableCell(year, label, item.taxReturn, {
                          isOverride: item.isOverride,
                          hint:
                            `Source: ${item.sourceLabels.join(" + ")}` +
                            `${item.sourceDocument ? `\nDocument: ${item.sourceDocument}` : ""}` +
                            `\nTax year: ${item.taxYear ?? "unknown"}` +
                            `${item.userAdded ? "\nManually added — preserved on refresh." : ""}` +
                            `${item.note ? `\n${item.note}` : ""}`,
                        }),
                        item.userAdded
                          ? { text: "manual", tone: "text-primary/60 text-[11px]" }
                          : blank,
                      ];
                    }}
                  />
                ))}

                <tr className="border-b border-[#f1f5f9] bg-[#F8FBF1]">
                  <th scope="row" className={cn(LABEL_CELL_TINT, "bg-[#F8FBF1] px-4 py-2 text-left")}>
                    <div className="relative inline-block" ref={addRowRef}>
                      <button
                        onClick={() => { setShowAddRowDropdown((v) => !v); setAddRowSearch(""); }}
                        className="flex items-center gap-1.5 rounded-md border border-primary/30 bg-white px-3 py-1.5 text-[12px] font-medium text-primary transition-colors hover:border-primary/50 hover:bg-primary/5"
                      >
                        <Plus size={13} />
                        Add Schedule K Item
                      </button>

                      {showAddRowDropdown && (
                        <div className="absolute left-0 top-full z-50 mt-1 w-72 rounded-lg border border-border bg-white shadow-lg">
                          <div className="border-b border-border p-2">
                            <input
                              autoFocus
                              type="text"
                              placeholder="Search or type custom label…"
                              value={addRowSearch}
                              onChange={(e) => setAddRowSearch(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" && addRowSearch.trim()) addReconRow(addRowSearch.trim());
                                if (e.key === "Escape") { setShowAddRowDropdown(false); setAddRowSearch(""); }
                              }}
                              className="w-full rounded border border-border px-2 py-1.5 text-[12px] outline-none focus:ring-1 focus:ring-primary"
                            />
                          </div>
                          <ul className="max-h-60 overflow-y-auto py-1">
                            <AddRowOptions
                              search={addRowSearch}
                              fromReturns={scheduleKLabelsFromReturns}
                              alreadyShown={scheduleKRows}
                              onAdd={addReconRow}
                              onRestore={restoreAiRow}
                            />
                          </ul>
                        </div>
                      )}
                    </div>
                  </th>
                  <td colSpan={activeYears.length * 3} className="bg-[#F8FBF1] px-4 py-2" />
                </tr>
              </tbody>
            )}
          </table>
          </GridContext.Provider>
        </div>

        {!isLoading && !hasSourceData && !error && (
          <div className="border-t border-border px-5 py-6 text-[13px] text-text-muted">
            No data returned. Click <strong>{useManualLayout ? "Sync" : "Refresh"}</strong> to load.
          </div>
        )}
      </section>
    </div>
  );
}

// ── Grid primitives ────────────────────────────────────────────────────────
//
// Frozen panes, spreadsheet-style: ONE scroll container (the div wrapping the
// table), with both header rows sticky to its top and the label column sticky to
// its left. Deliberately not a second nested scroller (Part 14) — the card header
// and the page chrome stay in place because the grid itself is the only thing
// that scrolls.
const LABEL_CELL = "sticky left-0 z-20 border-r border-border bg-white";
const LABEL_CELL_TINT = "sticky left-0 z-20 border-r border-border";

// Column widths. Shared by the frozen header table and the body table — they are
// separate tables (so the header can be sticky to the page) and `table-layout:
// fixed` makes these the single source of truth for both, which is what keeps
// their columns aligned.
const LABEL_COL_WIDTH = 260;
const VALUE_COL_WIDTH = 110;

/** Divider between fiscal-year column groups. */
const yearDivider = (idx, count) => (idx < count - 1 ? "border-r-2 border-r-primary/25" : "");

/** A cell descriptor meaning "no data for this row/year" — an em dash, not zero. */
const BLANK_CELL = Object.freeze({ text: "—", tone: "text-text-muted" });

const GridContext = createContext({
  activeYears: [],
  yearOf: () => null,
  editingValue: "",
  setEditingValue: () => {},
  cancelEdit: () => {},
});

/** A section banner spanning the whole grid. */
function SectionRow({ section, note }) {
  const { activeYears } = useContext(GridContext);
  return (
    <tr className="border-y-2 border-primary/20 bg-[#EEF6E0]">
      <th scope="colgroup" className={cn(LABEL_CELL_TINT, "bg-[#EEF6E0] px-4 py-2.5 text-left align-middle")}>
        <span className="text-[11px] font-bold uppercase tracking-wide text-primary">
          Section {section.id} · {section.title}
        </span>
      </th>
      <td colSpan={Math.max(1, activeYears.length * 3)} className="bg-[#EEF6E0] px-4 py-2.5 text-left">
        {note && <span className="text-[11px] font-medium text-primary/70">{note}</span>}
      </td>
    </tr>
  );
}

/**
 * A data row. `cells(year, yearData)` returns this row's three cell descriptors
 * for one fiscal year: [P&L, Tax Return, TR Variance / Adjustment].
 */
function DataRow({ label, cells, bold = false, tint = null, title = null, indent = 0, onDelete = null }) {
  const { activeYears, yearOf } = useContext(GridContext);
  return (
    <tr className={cn("group border-b border-[#f1f5f9] transition-colors hover:bg-slate-50/70", tint)}>
      <th
        scope="row"
        className={cn(
          tint ? LABEL_CELL_TINT : LABEL_CELL,
          tint,
          "px-4 py-2.5 text-left align-middle",
          bold ? "font-semibold text-text-primary" : "font-medium text-text-secondary",
        )}
        style={{ paddingLeft: 16 + indent * 14 }}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-[13px]" title={title || undefined}>
            {label}
            {title && <Info size={11} className="ml-1 inline-block align-[-1px] text-text-muted" />}
          </span>
          {onDelete && (
            <button
              onClick={onDelete}
              title="Remove this row"
              className="invisible shrink-0 rounded p-0.5 text-text-muted opacity-60 hover:text-red-500 hover:opacity-100 group-hover:visible"
            >
              <Trash2 size={13} />
            </button>
          )}
        </div>
      </th>
      {activeYears.map((year, idx) => {
        const [a, b, c] = cells(year, yearOf(year)) || [];
        return (
          <Fragment key={year}>
            <Cell descriptor={a} bold={bold} />
            <Cell descriptor={b} bold={bold} />
            <Cell descriptor={c} bold={bold} className={yearDivider(idx, activeYears.length)} />
          </Fragment>
        );
      })}
    </tr>
  );
}

/** One numeric cell. A missing descriptor renders an em dash — "no data", not zero. */
function Cell({ descriptor, bold, className }) {
  const { editingValue, setEditingValue, cancelEdit } = useContext(GridContext);

  if (!descriptor) {
    return <td className={cn("px-4 py-2.5 text-right text-text-muted", className)}>—</td>;
  }
  const { value, text, tone, editable, onEdit, isEditing, hint, underline } = descriptor;

  if (isEditing) {
    return (
      <td className={cn("bg-white p-1", className)}>
        <div className="flex items-center gap-0.5">
          <input
            autoFocus
            type="text"
            value={editingValue}
            onChange={(e) => setEditingValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onEdit?.commit();
              if (e.key === "Escape") cancelEdit();
            }}
            onBlur={() => onEdit?.commit()}
            className="w-full min-w-0 rounded border border-primary/50 bg-white px-2 py-1 text-right text-[13px] font-medium text-primary outline-none focus:ring-1 focus:ring-primary"
          />
          <button onMouseDown={(e) => { e.preventDefault(); onEdit?.commit(); }} className="rounded p-0.5 text-primary hover:bg-primary/10"><Check size={12} /></button>
          <button onMouseDown={(e) => { e.preventDefault(); cancelEdit(); }} className="rounded p-0.5 text-text-muted hover:bg-slate-100"><X size={12} /></button>
        </div>
      </td>
    );
  }

  return (
    <td
      className={cn(
        "px-4 py-2.5 text-right tabular-nums",
        bold ? "font-semibold" : "font-medium",
        tone,
        editable && "cursor-pointer hover:ring-1 hover:ring-inset hover:ring-primary/30",
        className,
      )}
      onClick={editable ? onEdit?.start : undefined}
      title={hint || undefined}
    >
      <span className={cn(underline && "underline decoration-dotted decoration-primary/50")}>
        {text !== undefined ? text : formatAmount(value)}
      </span>
    </td>
  );
}

// ── Small presentational helpers ───────────────────────────────────────────

function WarningList({ warnings }) {
  return (
    <div className="space-y-1 rounded-xl border border-yellow-200 bg-yellow-50 px-4 py-3 text-[13px] text-yellow-800">
      {warnings.map((w, i) => (
        <div key={i} className="flex items-start gap-2">
          <AlertCircle size={15} className="mt-0.5 shrink-0 text-yellow-600" />
          <span>{w}</span>
        </div>
      ))}
    </div>
  );
}

function EmptyRow({ span, children }) {
  return (
    <tr>
      <td colSpan={span} className="px-5 py-3 text-center text-[13px] italic text-text-muted">
        {children}
      </td>
    </tr>
  );
}

/**
 * "Add Schedule K Item" options, in two groups: lines the linked returns
 * actually state (restoring one drops its override so the extracted value comes
 * back), and the standard Schedule K catalogue. Every label is compared after
 * canonicalisation so a catalogue entry and an extracted line that mean the same
 * thing are never offered twice.
 */
function AddRowOptions({ search, fromReturns, alreadyShown, onAdd, onRestore }) {
  const query = search.trim().toLowerCase();
  const shown = new Set(alreadyShown.map((l) => canonicalScheduleKLabel(l)));
  const matches = (label) => !query || label.toLowerCase().includes(query);

  const returnOptions = fromReturns.filter((l) => !shown.has(canonicalScheduleKLabel(l)) && matches(l));
  const returnSet = new Set(returnOptions.map((l) => canonicalScheduleKLabel(l)));

  const catalogue = SCHEDULE_K_SECTIONS
    .map((sec) => ({
      ...sec,
      visible: sec.items.filter((item) => {
        const canon = canonicalScheduleKLabel(item);
        return !shown.has(canon) && !returnSet.has(canon) && matches(item);
      }),
    }))
    .filter((sec) => sec.visible.length > 0);

  const custom = search.trim();
  const showCustom = custom
    && !shown.has(canonicalScheduleKLabel(custom))
    && !fromReturns.some((s) => s.toLowerCase() === custom.toLowerCase())
    && !SCHEDULE_K_ITEMS.some((s) => s.toLowerCase() === custom.toLowerCase());

  if (!showCustom && !returnOptions.length && !catalogue.length) {
    return (
      <li className="px-3 py-3 text-center text-[12px] italic text-text-muted">
        {query ? "No matching Schedule K items." : "All Schedule K items are already in the table."}
      </li>
    );
  }

  return (
    <>
      {showCustom && (
        <li>
          <button
            onMouseDown={() => onAdd(custom)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-primary hover:bg-primary/5"
          >
            <Plus size={12} className="shrink-0" />
            Add &ldquo;{custom}&rdquo;
          </button>
        </li>
      )}
      {returnOptions.length > 0 && (
        <li>
          <div className="px-3 pb-0.5 pt-2.5 text-[10px] font-semibold uppercase tracking-wider text-primary/60">
            From Your Tax Return
          </div>
          <ul>
            {returnOptions.map((item) => (
              <li key={item}>
                <button
                  onMouseDown={() => onRestore(item)}
                  className="w-full px-4 py-1.5 text-left text-[12px] text-text-primary hover:bg-primary/5"
                >
                  {item}
                </button>
              </li>
            ))}
          </ul>
        </li>
      )}
      {catalogue.map((sec) => (
        <li key={sec.section}>
          <div className="px-3 pb-0.5 pt-2.5 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
            {sec.section}
          </div>
          <ul>
            {sec.visible.map((item) => (
              <li key={item}>
                <button
                  onMouseDown={() => onAdd(item)}
                  className="w-full px-4 py-1.5 text-left text-[12px] text-text-primary hover:bg-primary/5"
                >
                  {item}
                </button>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </>
  );
}

/**
 * Wrap a pre-summarised `[{ label, pl }]` P&L (the shape
 * `/manual-report-uploads/pl-for-tax` and the QuickBooks `/quickbooks-pl`
 * endpoint return) into the minimal row tree the engine classifies.
 *
 * Each label is placed under the section its own name implies, because these
 * endpoints have already collapsed the document's real hierarchy and there is no
 * ancestry left to read. This is strictly a LAST-RESORT adapter for those two
 * legacy shapes — every other mode passes the document's genuine tree straight
 * through, and the engine's footing checks will surface anything this cannot
 * place rather than silently absorbing it.
 */
function summarisedPlToRows(data) {
  const bySection = { Income: [], "Cost of Sales": [], "Operating Expenses": [], "Other Income": [] };
  const totals = [];

  for (const row of data || []) {
    const label = String(row?.label || "").trim();
    if (!label) continue;
    const amount = Number(row?.pl ?? row?.amount ?? 0) || 0;
    const lc = label.toLowerCase();

    if (/^gross (profit|margin)$/.test(lc) || /^net (income|loss)$/.test(lc)) {
      totals.push({ name: label, type: "total", amount });
      continue;
    }
    // A "Total …" line from these endpoints is a rollup of items we are about to
    // list individually; keeping it as a leaf would double the section.
    if (/^total (revenue|income|cost of goods sold|cost of sales|expenses?)$/.test(lc)) continue;

    if (/cost of (goods|sales)/.test(lc)) bySection["Cost of Sales"].push({ name: label, type: "data", amount });
    else if (/interest income|other income|other revenue/.test(lc)) bySection["Other Income"].push({ name: label, type: "data", amount });
    else if (/revenue|sales|^income$/.test(lc)) bySection.Income.push({ name: label, type: "data", amount });
    else bySection["Operating Expenses"].push({ name: label, type: "data", amount });
  }

  const rows = Object.entries(bySection)
    .filter(([, children]) => children.length > 0)
    .map(([name, children]) => ({ name, type: "header", amount: 0, children }));
  return [...rows, ...totals];
}
