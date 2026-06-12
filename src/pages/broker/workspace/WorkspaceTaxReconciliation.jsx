import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import { cn, formatNumber } from "../../../lib/utils";
import {
  getCompanyRequest,
  getStoredToken,
  getManualStagedProfitLossSummary,
  getManualStageFilterOptions,
  listManualGlDatasetVersions,
  getActiveKeyReportMappings,
} from "../../../lib/api";
import { useDataSource } from "../../../context/DataSourceContext";
import { useDatasetVersionStore } from "../../../store/useDatasetVersionStore";

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL || "http://localhost:4000";

const STORAGE_PREFIX = "workspace-tax-reconciliation-v5";

// ── Session-storage helpers ────────────────────────────────────────────────

function getStorageKey(clientId) {
  return `${STORAGE_PREFIX}:${clientId || "default"}`;
}

function getStoredState(clientId) {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(getStorageKey(clientId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

// ── Manual P&L extraction helpers ─────────────────────────────────────────

function flattenPLRows(rows, depth = 0) {
  const result = [];
  for (const row of (rows || [])) {
    const label = String(row.name || "").trim();
    if (!label) continue;
    const value = typeof row.amount === "number" ? row.amount : 0;
    result.push({ label, value, depth, type: String(row.type || "data") });
    if (Array.isArray(row.children) && row.children.length) {
      result.push(...flattenPLRows(row.children, depth + 1));
    }
  }
  return result;
}

function findByPatterns(flat, patterns, preferTotal = true) {
  const lc = (s) => s.toLowerCase().trim();
  const matches = flat.filter((row) => {
    const lbl = lc(row.label);
    return patterns.some((p) => lbl.includes(lc(p)) || lc(p).includes(lbl));
  });
  if (!matches.length) return 0;
  if (preferTotal) {
    const totals = matches.filter((r) => r.type === "total");
    if (totals.length) return totals[totals.length - 1].value;
  }
  return matches[matches.length - 1].value;
}

function extractTaxRowsFromManualPL(rows) {
  const flat = flattenPLRows(rows);

  const totalRevenue = findByPatterns(flat, ["total income", "total revenue", "net revenue", "total sales"]);
  const totalCogs = findByPatterns(flat, ["total cost of goods sold", "cost of goods sold", "cost of sales", "total cogs"]);
  const grossProfit = findByPatterns(flat, ["gross profit", "gross margin"]);
  const officerWages = findByPatterns(flat, ["officer compensation", "officer wages", "officer salary", "officer pay", "s-corp officer"], false);
  const depreciation = findByPatterns(flat, ["depreciation expense", "depreciation & amortization", "depreciation"], false);
  const amortization = findByPatterns(flat, ["amortization expense", "amortization"], false);
  const interestExpense = findByPatterns(flat, ["total interest expense", "interest expense", "loan interest"], false);
  const otherIncome = findByPatterns(flat, ["total other income", "other income", "other revenue"]);
  const netIncome = findByPatterns(flat, ["net income", "net loss", "net earnings", "net profit"]);

  // All Other Expenses = Total Expenses minus the specific items we already identified
  const totalExpenses = findByPatterns(flat, ["total expenses", "total operating expenses", "total expense"]);
  const knownExpenses = officerWages + depreciation + amortization + interestExpense;
  const allOtherExpenses = totalExpenses > 0 ? Math.max(0, totalExpenses - knownExpenses) : 0;

  return [
    { label: "Total Revenue", pl: totalRevenue },
    { label: "Total Cost of Goods Sold", pl: totalCogs },
    { label: "Gross Profit", pl: grossProfit },
    { label: "Officer Wages", pl: officerWages },
    { label: "Depreciation Expense", pl: depreciation },
    { label: "Amortization Expense", pl: amortization },
    { label: "Total Interest Expense", pl: interestExpense },
    { label: "All Other Expenses", pl: allOtherExpenses },
    { label: "All Other Income", pl: otherIncome },
    { label: "Net Income", pl: netIncome },
  ];
}

// ── Formatting ─────────────────────────────────────────────────────────────

function formatAmount(value) {
  if (value == null || value === "") return "-";
  const numericValue = Number(value);
  if (isNaN(numericValue) || numericValue === 0) return "-";
  return formatNumber(numericValue, 0);
}

function getVarianceClass(value) {
  const n = Number(value || 0);
  if (!n) return "text-text-primary";
  return n < 0 ? "text-red-600" : "text-green-600";
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

const MAIN_LINE_ITEMS = [
  { label: "Total Revenue", isHighlight: false },
  { label: "Total Cost of Goods Sold", isHighlight: false },
  { label: "Gross Profit", isHighlight: true },
  { label: "Officer Wages", isHighlight: false },
  { label: "Depreciation Expense", isHighlight: false },
  { label: "Amortization Expense", isHighlight: false },
  { label: "Total Interest Expense", isHighlight: false },
  { label: "All Other Expenses", isHighlight: false },
  { label: "All Other Income", isHighlight: false },
  { label: "Net Income", isHighlight: true },
];

// ── Main component ─────────────────────────────────────────────────────────

export default function WorkspaceTaxReconciliation() {
  const { clientId } = useParams();
  const navigate = useNavigate();
  const { activeSource, activeSourceMode } = useDataSource();
  const storedState = useMemo(() => getStoredState(clientId), [clientId]);

  const currentYear = new Date().getFullYear();
  const YEAR_OPTIONS = Array.from({ length: 6 }, (_, i) => currentYear - i);

  const [company, setCompany] = useState(null);
  const [startYear, setStartYear] = useState(storedState?.startYear ?? String(currentYear - 2));
  const [endYear, setEndYear] = useState(storedState?.endYear ?? String(currentYear));
  const [accountingMethod, setAccountingMethod] = useState(storedState?.accountingMethod ?? "Cash");
  const [matrixData, setMatrixData] = useState(storedState?.matrixData ?? {});
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(storedState?.error ?? "");
  const [warnings, setWarnings] = useState(storedState?.warnings ?? []);
  const [isQBDisconnected, setIsQBDisconnected] = useState(false);
  const [syncStatus, setSyncStatus] = useState(() => ({
    status: Object.keys(storedState?.matrixData ?? {}).length > 0 ? "success" : "idle",
    message: Object.keys(storedState?.matrixData ?? {}).length > 0 ? "Restored saved data." : "",
  }));
  // Key Reports tax return gate: 'idle' | 'loading' | 'ok' | 'missing'
  const [krTaxGate, setKrTaxGate] = useState({ status: "idle" });

  // Dataset version selection — Manual GL only.
  // Seeded from the shared store so the same version selected in Reports is
  // used here automatically; user can override locally with the dropdown.
  const sharedSelectedVersion = useDatasetVersionStore((s) => s.selectedVersion);
  const [glVersions, setGlVersions] = useState([]);
  const [selectedVersion, setSelectedVersion] = useState(null);
  // Tracks the live selection so an in-flight load for a previous version can
  // be discarded if the user switches mid-fetch (last-write-wins guard).
  const latestVersionRef = useRef(selectedVersion);
  latestVersionRef.current = selectedVersion;

  // Manual GL (staged General Ledger) sources its P&L from the platform's GL
  // reports — not from a separately uploaded P&L document. It's handled by its
  // own branch (checked before isManualMode) so the uploaded-file path is unchanged.
  const isManualGL = activeSourceMode === 'manual';
  const isManualMode = activeSourceMode === 'manual_upload' || activeSourceMode === 'manual';
  const isQBManual = activeSourceMode === 'quickbooks_manual';

  const selectedYears = useMemo(() => {
    const s = parseInt(startYear, 10);
    const e = parseInt(endYear, 10);
    const lo = Math.min(s, e);
    const hi = Math.max(s, e);
    return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  }, [startYear, endYear]);

  // activeYears: for manual / QMS mode derive from matrixData keys; for QB use selectedYears
  const activeYears = useMemo(() => {
    if (isManualMode || isQBManual) {
      const keys = Object.keys(matrixData).map(Number).filter(Boolean).sort();
      return keys.length > 0 ? keys : [];
    }
    return selectedYears;
  }, [isManualMode, isQBManual, matrixData, selectedYears]);

  const getHeaders = useCallback(() => {
    const token = getStoredToken();
    return {
      ...(token ? {
        Authorization: `Bearer ${token}`,
        "X-Access-Token": token,
        "X-Auth-Token": token,
        "X-Token": token,
      } : {}),
      ...(clientId ? { "X-Client-Id": clientId } : {}),
    };
  }, [clientId]);

  // ── Company ───────────────────────────────────────────────────────────

  useEffect(() => {
    let active = true;
    if (!clientId) { setCompany(null); return () => { active = false; }; }
    getCompanyRequest(clientId)
      .then((p) => { if (active) setCompany(p); })
      .catch(() => { if (active) setCompany(null); });
    return () => { active = false; };
  }, [clientId]);

  // ── Restore on clientId change ────────────────────────────────────────

  useEffect(() => {
    const next = getStoredState(clientId);
    if (!next) return;
    setStartYear(next.startYear ?? String(currentYear - 2));
    setEndYear(next.endYear ?? String(currentYear));
    setAccountingMethod(next.accountingMethod ?? "Cash");
    setMatrixData(next.matrixData ?? {});
    setError(next.error ?? "");
    setWarnings(next.warnings ?? []);
    setIsQBDisconnected(false);
    setSyncStatus({
      status: Object.keys(next.matrixData ?? {}).length > 0 ? "success" : "idle",
      message: Object.keys(next.matrixData ?? {}).length > 0 ? "Restored saved data." : "",
    });
  }, [clientId, currentYear]);

  // ── Manual GL version loading ─────────────────────────────────────────

  useEffect(() => {
    if (!isManualGL || !clientId) return;
    let cancelled = false;
    listManualGlDatasetVersions({ clientId })
      .then((versions) => {
        if (cancelled) return;
        setGlVersions(versions);
        setSelectedVersion((prev) => {
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
  }, [isManualGL, clientId, sharedSelectedVersion]);

  // ── Persist ───────────────────────────────────────────────────────────

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.sessionStorage.setItem(
        getStorageKey(clientId),
        JSON.stringify({ startYear, endYear, accountingMethod, matrixData, error, warnings }),
      );
    } catch { /* ignore */ }
  }, [clientId, startYear, endYear, accountingMethod, matrixData, error, warnings]);

  // ── Loader ────────────────────────────────────────────────────────────

  const loadData = useCallback(async (forceRefresh = false) => {
    const requestVersion = selectedVersion;
    setIsLoading(true);
    setError("");
    setIsQBDisconnected(false);
    setSyncStatus({ status: "loading", message: isManualMode ? "Fetching P&L data…" : "Fetching P&L & Tax Data…" });

    try {
      if (isManualGL) {
        // ── Manual GL: P&L sourced from the platform's staged-GL reports ──
        // (no separate P&L upload). Tax returns still come from the DataRoom.
        const headers = getHeaders();
        const allWarnings = [];
        const forceParam = forceRefresh ? "&force=1" : "";

        setSyncStatus({ status: "loading", message: "Reading manual GL P&L…" });

        // Tax returns (uploaded) + available GL fiscal years for the selected
        // version, in parallel. Passing datasetVersion scopes both the year
        // list and every subsequent P&L fetch to that version's transactions.
        const versionParam = selectedVersion ? { datasetVersion: String(selectedVersion) } : {};
        const [taxRes, filterRes] = await Promise.all([
          fetch(`${API_BASE_URL}/manual-report-uploads/tax-data?clientId=${clientId || ""}${forceParam}`, { headers })
            .then((r) => r.json()).catch(() => ({ success: false })),
          getManualStageFilterOptions({ clientId, params: versionParam }).catch(() => ({})),
        ]);

        const taxYears = (taxRes.success && taxRes.years) ? taxRes.years : {};
        if (taxRes.warning) allWarnings.push(taxRes.warning);
        if (Array.isArray(taxRes.warnings)) allWarnings.push(...taxRes.warnings);

        const glYears = Array.isArray(filterRes?.options?.fiscalYear)
          ? filterRes.options.fiscalYear.map(Number).filter(Boolean)
          : [];

        // Fetch the GL P&L summary per year — version-scoped so each version
        // produces independent, isolated tax reconciliation line items.
        const plYears = {};
        await Promise.all(glYears.map(async (year) => {
          try {
            const payload = await getManualStagedProfitLossSummary({
              clientId,
              params: { fiscalYear: [String(year)], ...versionParam },
            });
            const rows = Array.isArray(payload?.hierarchicalRows) ? payload.hierarchicalRows : [];
            if (rows.length) {
              plYears[year] = { year, data: extractTaxRowsFromManualPL(rows) };
            }
          } catch {
            /* skip this year on failure */
          }
        }));

        const allYears = [...new Set([
          ...Object.keys(plYears).map(Number),
          ...Object.keys(taxYears).map(Number),
        ])].sort();

        if (!allYears.length) {
          throw new Error("No manual GL P&L or tax return data found. Upload a GL via Manual GL Upload and tax returns to the data room.");
        }

        const results = {};
        for (const year of allYears) {
          const mergedMap = new Map();

          MAIN_LINE_ITEMS.forEach((item) => {
            mergedMap.set(item.label, { label: item.label, pl: 0, taxReturn: 0, isReconcilingItem: false });
          });

          // Overlay P&L (from manual GL) for matching year
          (plYears[year]?.data || []).forEach((item) => {
            if (mergedMap.has(item.label)) {
              mergedMap.get(item.label).pl = Number(item.pl || 0);
            } else {
              mergedMap.set(item.label, { label: item.label, pl: Number(item.pl || 0), taxReturn: 0, isReconcilingItem: false });
            }
          });

          // Overlay tax return data for matching year
          (taxYears[year]?.data || []).forEach((item) => {
            if (mergedMap.has(item.label)) {
              const row = mergedMap.get(item.label);
              row.taxReturn = Number(item.taxReturn || 0);
              if (item.isReconcilingItem) row.isReconcilingItem = true;
            } else {
              mergedMap.set(item.label, {
                label: item.label,
                pl: 0,
                taxReturn: Number(item.taxReturn || 0),
                isReconcilingItem: !!item.isReconcilingItem,
              });
            }
          });

          results[year] = {
            success: true,
            taxYear: year,
            data: Array.from(mergedMap.values()).map((row) => ({
              ...row,
              variance: (row.taxReturn || 0) - (row.pl || 0),
            })),
            warnings: [],
          };
        }

        // Discard if the user switched versions while this load was in flight,
        // so a slow previous-version response can't overwrite fresh data.
        if (latestVersionRef.current !== requestVersion) return;
        const loadedYears = Object.keys(results).map(Number).sort();
        setMatrixData(results);
        setWarnings(allWarnings);
        setSyncStatus({
          status: "success",
          message: `Loaded ${loadedYears.length} year(s) from manual GL: FY ${loadedYears.join(", FY ")}.`,
        });
      } else if (isManualMode) {
        // ── Manual Upload: P&L + Tax Returns both from DataRoom via Gemini ─
        const headers = getHeaders();
        const allWarnings = [];

        setSyncStatus({ status: "loading", message: "Reading financial PDFs from DataRoom…" });

        // 1. Fetch P&L years and Tax Return years in parallel
        const forceParam = forceRefresh ? "&force=1" : "";
        const [plRes, taxRes] = await Promise.all([
          fetch(`${API_BASE_URL}/manual-report-uploads/pl-for-tax?clientId=${clientId || ""}${forceParam}`, { headers })
            .then((r) => r.json()).catch(() => ({ success: false })),
          fetch(`${API_BASE_URL}/manual-report-uploads/tax-data?clientId=${clientId || ""}${forceParam}`, { headers })
            .then((r) => r.json()).catch(() => ({ success: false })),
        ]);

        // plYears: { 2023: { year, data: [{label, pl}] }, ... }
        const plYears = (plRes.success && plRes.years) ? plRes.years : {};
        // taxYears: { 2022: { year, data: [{label, taxReturn, isReconcilingItem}] }, ... }
        const taxYears = (taxRes.success && taxRes.years) ? taxRes.years : {};

        if (plRes.warning) allWarnings.push(plRes.warning);
        if (Array.isArray(plRes.warnings)) allWarnings.push(...plRes.warnings);
        if (taxRes.warning) allWarnings.push(taxRes.warning);
        if (Array.isArray(taxRes.warnings)) allWarnings.push(...taxRes.warnings);

        // 2. Build columns for ALL unique years from BOTH sources
        const allYears = [...new Set([
          ...Object.keys(plYears).map(Number),
          ...Object.keys(taxYears).map(Number),
        ])].sort();

        if (!allYears.length) {
          throw new Error("No P&L or tax return data found. Please sync your files via the Connections page.");
        }

        const results = {};
        for (const year of allYears) {
          const mergedMap = new Map();

          // Seed with main line items (all zeroed)
          MAIN_LINE_ITEMS.forEach((item) => {
            mergedMap.set(item.label, { label: item.label, pl: 0, taxReturn: 0, isReconcilingItem: false });
          });

          // Overlay P&L for matching year
          (plYears[year]?.data || []).forEach((item) => {
            if (mergedMap.has(item.label)) {
              mergedMap.get(item.label).pl = Number(item.pl || 0);
            } else {
              mergedMap.set(item.label, { label: item.label, pl: Number(item.pl || 0), taxReturn: 0, isReconcilingItem: false });
            }
          });

          // Overlay tax return data for matching year
          (taxYears[year]?.data || []).forEach((item) => {
            if (mergedMap.has(item.label)) {
              const row = mergedMap.get(item.label);
              row.taxReturn = Number(item.taxReturn || 0);
              if (item.isReconcilingItem) row.isReconcilingItem = true;
            } else {
              mergedMap.set(item.label, {
                label: item.label,
                pl: 0,
                taxReturn: Number(item.taxReturn || 0),
                isReconcilingItem: !!item.isReconcilingItem,
              });
            }
          });

          results[year] = {
            success: true,
            taxYear: year,
            data: Array.from(mergedMap.values()).map((row) => ({
              ...row,
              variance: (row.taxReturn || 0) - (row.pl || 0),
            })),
            warnings: [],
          };
        }

        const loadedYears = Object.keys(results).map(Number).sort();
        setMatrixData(results);
        setWarnings(allWarnings);
        setSyncStatus({
          status: "success",
          message: `Loaded ${loadedYears.length} year(s): FY ${loadedYears.join(", FY ")}.`,
        });
      } else if (isQBManual) {
        // ── QuickBooks Manual: P&L from synced qb_synced_reports + tax from DataRoom ─
        const headers = getHeaders();
        const allWarnings = [];

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

        if (taxRes.warning) allWarnings.push(taxRes.warning);
        if (Array.isArray(taxRes.warnings)) allWarnings.push(...taxRes.warnings);

        // Detect fiscal year from file date metadata or filename
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

        // One file per year — keep newest when duplicates
        const yearFileMap = new Map();
        for (const file of files) {
          const yr = detectFileYear(file);
          const existing = yearFileMap.get(yr);
          if (!existing || new Date(file.updatedAt || 0) > new Date(existing.updatedAt || 0)) {
            yearFileMap.set(yr, file);
          }
        }

        const taxYears = (taxRes.success && taxRes.years) ? taxRes.years : {};

        const results = {};
        for (const [yr, file] of yearFileMap) {
          const plData = extractTaxRowsFromManualPL(file.data.rows || []);
          const mergedMap = new Map();

          MAIN_LINE_ITEMS.forEach((item) => {
            mergedMap.set(item.label, { label: item.label, pl: 0, taxReturn: 0, isReconcilingItem: false });
          });

          plData.forEach((item) => {
            if (mergedMap.has(item.label)) {
              mergedMap.get(item.label).pl = Number(item.pl || 0);
            } else {
              mergedMap.set(item.label, { label: item.label, pl: Number(item.pl || 0), taxReturn: 0, isReconcilingItem: false });
            }
          });

          (taxYears[yr]?.data || []).forEach((item) => {
            if (mergedMap.has(item.label)) {
              const row = mergedMap.get(item.label);
              row.taxReturn = Number(item.taxReturn || 0);
              if (item.isReconcilingItem) row.isReconcilingItem = true;
            } else {
              mergedMap.set(item.label, { label: item.label, pl: 0, taxReturn: Number(item.taxReturn || 0), isReconcilingItem: !!item.isReconcilingItem });
            }
          });

          results[yr] = {
            success: true,
            taxYear: yr,
            data: Array.from(mergedMap.values()).map((row) => ({ ...row, variance: (row.taxReturn || 0) - (row.pl || 0) })),
            warnings: [],
          };
        }

        const loadedYears = Object.keys(results).map(Number).sort();
        setMatrixData(results);
        setWarnings(allWarnings);
        setSyncStatus({ status: "success", message: `Loaded ${loadedYears.length} year(s): FY ${loadedYears.join(", FY ")}.` });
      } else {
        // ── QuickBooks mode: existing multi-year fetch ────────────────────
        const allWarnings = new Set();
        const results = {};

        await Promise.all(
          selectedYears.map(async (year) => {
            const plUrl = `${API_BASE_URL}/quickbooks-pl?start_date=${year}-01-01&end_date=${year}-12-31&accounting_method=${accountingMethod}&clientId=${clientId || ""}`;
            const taxUrl = `${API_BASE_URL}/tax-data?start_date=${year}-01-01&clientId=${clientId || ""}`;

            const headers = getHeaders();

            const [plRes, taxRes] = await Promise.all([
              fetch(plUrl, { headers }).then((r) => r.json()).catch(() => ({ success: false })),
              fetch(taxUrl, { headers }).then((r) => r.json()).catch(() => ({ success: false })),
            ]);

            if (plRes.success === false && (plRes.error || "").includes("QB not connected")) {
              setIsQBDisconnected(true);
            }

            const mergedMap = new Map();

            if (plRes.success && Array.isArray(plRes.data)) {
              plRes.data.forEach((item) => {
                mergedMap.set(item.label, { label: item.label, pl: Number(item.pl || 0), taxReturn: 0, isReconcilingItem: false });
              });
            }

            if (taxRes.success && Array.isArray(taxRes.data)) {
              taxRes.data.forEach((item) => {
                if (mergedMap.has(item.label)) {
                  mergedMap.get(item.label).taxReturn = Number(item.taxReturn || 0);
                } else {
                  mergedMap.set(item.label, {
                    label: item.label,
                    pl: 0,
                    taxReturn: Number(item.taxReturn || 0),
                    isReconcilingItem: !!item.isReconcilingItem,
                  });
                }
              });
            }

            const finalData = Array.from(mergedMap.values()).map((row) => ({
              ...row,
              variance: (row.taxReturn || 0) - (row.pl || 0),
            }));

            results[year] = {
              success: true,
              taxYear: taxRes.success ? taxRes.year : year,
              data: finalData,
              warnings: [
                ...(plRes.warnings || []),
                ...(taxRes.warning ? [taxRes.warning] : []),
                ...(taxRes.warnings || []),
              ],
            };

            (results[year].warnings || []).forEach((w) => allWarnings.add(w));
          })
        );

        setMatrixData(results);
        setWarnings(Array.from(allWarnings));
        setSyncStatus({ status: "success", message: `Refreshed ${selectedYears.length} year(s).` });
      }
    } catch (err) {
      console.error("Load Error:", err);
      setError(err instanceof Error ? err.message : "Failed to load data");
      setSyncStatus({ status: "error", message: "Failed to refresh" });
    } finally {
      setIsLoading(false);
    }
  }, [selectedYears, accountingMethod, clientId, getHeaders, isManualGL, isManualMode, isQBManual, currentYear, selectedVersion]);

  // Key Reports tax return gate — validates that a tax return is linked before
  // loading any reconciliation data. Fails open on API error to avoid blocking.
  useEffect(() => {
    if (!activeSource || !clientId) return;
    let cancelled = false;
    setKrTaxGate({ status: "loading" });
    getActiveKeyReportMappings()
      .then((mappings) => {
        if (cancelled) return;
        const hasTaxReturn = (mappings?.tax_return?.length || 0) > 0;
        setKrTaxGate({ status: hasTaxReturn ? "ok" : "missing" });
        if (!hasTaxReturn) {
          // Clear any cached data when gate transitions to missing
          setMatrixData({});
          setError("");
          setWarnings([]);
          setSyncStatus({ status: "idle", message: "" });
        }
      })
      .catch(() => {
        if (!cancelled) setKrTaxGate({ status: "ok" }); // fail open
      });
    return () => { cancelled = true; };
  }, [activeSource, clientId]);

  // Auto-load on first visit. In Manual GL mode, wait until the version is
  // resolved before loading — and include selectedVersion in the deps so this
  // re-fires once the version becomes available (without it, the effect ran
  // once with a null version and never again, leaving an empty screen even
  // though an active version with data existed).
  useEffect(() => {
    if (!activeSource) return;
    if (isManualGL && !selectedVersion) return;
    if (Object.keys(matrixData).length > 0) return;
    if (krTaxGate.status !== "ok") return; // gate: wait for Key Reports validation
    void loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSource, isManualGL, selectedVersion, krTaxGate.status]);

  // Re-generate when the selected version changes so Tax Reconciliation always
  // reflects the chosen version's transactions with no cross-version leakage.
  const prevTaxVersionRef = useRef(selectedVersion);
  useEffect(() => {
    if (!isManualGL) return;
    if (prevTaxVersionRef.current === selectedVersion) return;
    prevTaxVersionRef.current = selectedVersion;
    if (!selectedVersion) return;
    if (krTaxGate.status !== "ok") return; // gate: don't reload if tax return is missing
    try { window.sessionStorage.removeItem(getStorageKey(clientId)); } catch { /* ignore */ }
    setMatrixData({});
    setError("");
    setWarnings([]);
    setSyncStatus({ status: "idle", message: "" });
    void loadData(true);
  }, [isManualGL, selectedVersion, clientId, loadData, krTaxGate.status]);

  // ── Data helpers ──────────────────────────────────────────────────────

  const getMainRow = useCallback(
    (year, label) => {
      const row = matrixData[year]?.data?.find((r) => r?.label === label);
      const pl = Number(row?.pl ?? 0);
      const taxReturn = Number(row?.taxReturn ?? 0);
      return { pl, taxReturn, variance: taxReturn - pl };
    },
    [matrixData],
  );

  const dynamicReconcilingItems = useMemo(() => {
    const labels = new Set();
    Object.values(matrixData).forEach((yearData) => {
      yearData?.data?.forEach((row) => {
        if (row.isReconcilingItem) labels.add(row.label);
      });
    });
    return Array.from(labels).sort((a, b) => a.localeCompare(b));
  }, [matrixData]);

  const getReconValue = useCallback(
    (year, label) => {
      const row = matrixData[year]?.data?.find((r) => r?.label === label);
      return Number(row?.taxReturn ?? 0);
    },
    [matrixData],
  );

  const getReconCheck = useCallback(
    (year) => {
      const { pl: plNet, taxReturn: taxNet } = getMainRow(year, "Net Income");
      const itemsSum = dynamicReconcilingItems.reduce(
        (acc, lbl) => acc + getReconValue(year, lbl),
        0,
      );
      return taxNet - plNet - itemsSum;
    },
    [getMainRow, getReconValue, dynamicReconcilingItems],
  );

  const yrDiv = (idx) =>
    idx < activeYears.length - 1 ? "border-r-2 border-r-primary/25" : "";

  const hasMatrixData = Object.keys(matrixData).length > 0;
  const reportTitle = company?.name || "Your Company";

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Key Reports tax return gate — shown when no tax return is linked */}
      {krTaxGate.status === "missing" && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4">
          <div className="flex items-start gap-3">
            <AlertCircle size={18} className="mt-0.5 shrink-0 text-amber-600" />
            <div>
              <p className="text-sm font-semibold text-amber-800">
                Tax Return required in Key Reports
              </p>
              <p className="mt-1 text-sm text-amber-700">
                To load Tax Reconciliation data, link a Tax Return document in the Key Reports
                Tax Returns category for this client.
              </p>
              <button
                onClick={() => navigate(`/broker/client/${clientId}/dataroom/key-reports`)}
                className="mt-2 text-sm font-semibold text-amber-800 underline hover:text-amber-900"
              >
                Go to Key Reports →
              </button>
            </div>
          </div>
        </div>
      )}

      {isManualMode && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-wrap items-center gap-3">
              {syncStatus?.message && <SyncStatus sync={syncStatus} />}
              {/* Version selector — Manual GL only */}
              {isManualGL && glVersions.length > 0 && (
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
            </div>
            <button
              type="button"
              onClick={() => {
                if (krTaxGate.status !== "ok") return;
                try { window.sessionStorage.removeItem(getStorageKey(clientId)); } catch { /* ignore */ }
                setMatrixData({});
                void loadData(true);
              }}
              disabled={isLoading || krTaxGate.status !== "ok"}
              className="inline-flex h-9 items-center justify-center gap-2 rounded-xl bg-primary px-4 text-[13px] font-semibold text-white transition hover:bg-primary-dark disabled:cursor-not-allowed disabled:opacity-70"
            >
              <RefreshCw size={14} className={cn(isLoading && "animate-spin")} />
              {isLoading ? "Syncing…" : "Sync"}
            </button>
          </div>
          {warnings.length > 0 && !error && (
            <div className="space-y-1 rounded-xl border border-yellow-200 bg-yellow-50 px-4 py-3 text-[13px] text-yellow-800">
              {warnings.map((w, i) => (
                <div key={i} className="flex items-start gap-2">
                  <AlertCircle size={15} className="mt-0.5 shrink-0 text-yellow-600" />
                  <span>{w}</span>
                </div>
              ))}
            </div>
          )}
          {error && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
              {error}
            </div>
          )}
        </div>
      )}

      {/* ── Controls ────────────────────────────────────────────────────── */}
      {!isManualMode && (
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
              {/* Year + method filters — hidden in QMS mode */}
              {!isQBManual && [
                { label: "Start Year", value: startYear, set: setStartYear },
                { label: "End Year", value: endYear, set: setEndYear },
              ].map(({ label, value, set }) => (
                <label
                  key={label}
                  className="flex min-w-[120px] flex-col gap-1.5 text-[13px] font-medium text-text-primary"
                >
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

              {!isQBManual && (
                <label className="flex min-w-[140px] flex-col gap-1.5 text-[13px] font-medium text-text-primary">
                  Accounting Method
                  <select
                    value={accountingMethod}
                    onChange={(e) => setAccountingMethod(e.target.value)}
                    className="h-11 rounded-xl border border-border bg-white px-3 text-[14px] text-text-primary outline-none transition focus:border-primary"
                  >
                    <option value="Accrual">Accrual</option>
                    <option value="Cash">Cash</option>
                  </select>
                </label>
              )}

              <button
                type="button"
                onClick={() => {
                  if (krTaxGate.status !== "ok") return;
                  try { window.sessionStorage.removeItem(getStorageKey(clientId)); } catch { /* ignore */ }
                  setMatrixData({});
                  void loadData(true);
                }}
                disabled={isLoading || krTaxGate.status !== "ok"}
                className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-primary px-4 text-[14px] font-semibold text-white transition hover:bg-primary-dark disabled:cursor-not-allowed disabled:opacity-70"
              >
                <RefreshCw size={16} className={cn(isLoading && "animate-spin")} />
                Refresh
              </button>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <SyncStatus sync={syncStatus} />
          </div>

          {warnings.length > 0 && !error && (
            <div className="mt-4 space-y-1 rounded-xl border border-yellow-200 bg-yellow-50 px-4 py-3 text-[13px] text-yellow-800">
              {warnings.map((w, i) => (
                <div key={i} className="flex items-start gap-2">
                  <AlertCircle size={15} className="mt-0.5 shrink-0 text-yellow-600" />
                  <span>{w}</span>
                </div>
              ))}
            </div>
          )}

          {error && !isQBDisconnected && (
            <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
              {error}
            </div>
          )}
        </section>
      )}

      {/* ── Single unified table ── */}
      <section className="rounded-[var(--radius-card)] border border-border bg-white shadow-[0_10px_30px_rgba(15,23,42,0.04)]">
        <div className="border-b border-border px-5 py-4">
          <h2 className="text-[16px] font-semibold text-text-primary">Tax Reconciliation</h2>
          <p className="mt-1 text-[13px] text-text-secondary">
            {isManualMode
              ? activeYears.length > 0
                ? `Showing FY ${activeYears[0]} from uploaded P&L.`
                : "Awaiting data load."
              : `Compare P&L, tax return, and variance columns for ${startYear}–${endYear}.`}
          </p>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full table-fixed border-collapse text-[13px]">
            <colgroup>
              <col style={{ width: "220px" }} />
              {activeYears.map((y) => (
                <Fragment key={y}>
                  <col style={{ width: "110px" }} />
                  <col style={{ width: "110px" }} />
                  <col style={{ width: "110px" }} />
                </Fragment>
              ))}
            </colgroup>

            <thead>
              <tr className="border-b border-border bg-[#F8FBF1] text-primary">
                <th
                  rowSpan={2}
                  className="border-r border-border px-5 py-3 text-left text-[12px] font-semibold uppercase tracking-wide align-bottom"
                >
                  Source
                </th>
                {activeYears.map((year, idx) => (
                  <th
                    key={year}
                    colSpan={3}
                    className={cn("px-4 py-2.5 text-center text-[13px] font-bold", yrDiv(idx))}
                  >
                    FY {year}
                  </th>
                ))}
              </tr>

              <tr className="border-b-2 border-border bg-[#F8FBF1]/70 text-primary/80">
                {activeYears.map((year, idx) => (
                  <Fragment key={year}>
                    <th className="px-4 py-2 text-right text-[11px] font-semibold uppercase tracking-wide">
                      P&amp;L
                    </th>
                    <th className="px-4 py-2 text-right text-[11px] font-semibold uppercase tracking-wide">
                      Tax Return
                    </th>
                    <th className={cn("px-4 py-2 text-right text-[11px] font-semibold uppercase tracking-wide", yrDiv(idx))}>
                      TR Variance
                    </th>
                  </Fragment>
                ))}
              </tr>
            </thead>

            <tbody>
              {/* ── Part 1: Main line items ── */}
              {MAIN_LINE_ITEMS.map((item, rowIdx) => {
                const hl = item.isHighlight;
                return (
                  <tr
                    key={item.label}
                    className={cn(
                      "border-b border-[#f1f5f9] transition-colors hover:bg-slate-50",
                      hl ? "bg-[#FAFBF7]" : rowIdx % 2 === 0 ? "bg-white" : "bg-[#FCFDF8]",
                    )}
                  >
                    <td className={cn(
                      "border-r border-border px-5 py-3 text-left text-[13px]",
                      hl ? "font-semibold text-text-primary" : "font-medium text-text-secondary",
                    )}>
                      {item.label}
                    </td>

                    {activeYears.map((year, idx) => {
                      const { pl, taxReturn, variance } = getMainRow(year, item.label);
                      return (
                        <Fragment key={year}>
                          <td className={cn("px-4 py-3 text-right tabular-nums", hl ? "font-semibold text-text-primary" : "text-text-secondary")}>
                            {formatAmount(pl)}
                          </td>
                          <td className={cn("px-4 py-3 text-right tabular-nums", hl ? "font-semibold" : "font-medium", taxReturn !== 0 ? "bg-primary/5 text-primary" : "text-text-secondary")}>
                            {formatAmount(taxReturn)}
                          </td>
                          <td className={cn("px-4 py-3 text-right tabular-nums", yrDiv(idx), hl ? "font-semibold" : "font-medium", getVarianceClass(variance))}>
                            {formatAmount(variance)}
                          </td>
                        </Fragment>
                      );
                    })}
                  </tr>
                );
              })}

              {/* ── Part 2: Schedule K header ── */}
              <tr className="border-y-2 border-primary/20 bg-[#EEF6E0]">
                <td className="border-r border-border px-5 py-3 text-left text-[12px] font-bold uppercase tracking-wide text-primary">
                  Tax to Book Reconciling Items (Schedule K)
                </td>
                {activeYears.map((year, idx) => (
                  <Fragment key={year}>
                    <td className="px-4 py-2 text-right text-[11px] font-semibold uppercase tracking-wide text-primary/50">
                      P&amp;L
                    </td>
                    <td className="px-4 py-2 text-right text-[11px] font-semibold uppercase tracking-wide text-primary/70">
                      Tax Return
                    </td>
                    <td className={cn("px-4 py-2", yrDiv(idx))} />
                  </Fragment>
                ))}
              </tr>

              {/* ── Part 2 rows ── */}
              {dynamicReconcilingItems.length > 0 ? (
                dynamicReconcilingItems.map((label, rowIdx) => (
                  <tr
                    key={label}
                    className={cn(
                      "border-b border-[#f1f5f9] transition-colors hover:bg-slate-50",
                      rowIdx % 2 === 0 ? "bg-white" : "bg-[#FCFDF8]",
                    )}
                  >
                    <td className="border-r border-border px-5 py-3 text-left text-[13px] font-medium text-text-secondary">
                      {label}
                    </td>
                    {activeYears.map((year, idx) => {
                      const val = getReconValue(year, label);
                      return (
                        <Fragment key={year}>
                          <td className="px-4 py-3 text-right text-text-muted">—</td>
                          <td className={cn("px-4 py-3 text-right tabular-nums font-medium", val !== 0 ? "bg-primary/5 text-primary" : "text-text-secondary")}>
                            {formatAmount(val)}
                          </td>
                          <td className={cn("px-4 py-3 text-right text-text-muted", yrDiv(idx))}>—</td>
                        </Fragment>
                      );
                    })}
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={1 + activeYears.length * 3} className="px-5 py-6 text-center text-text-muted italic">
                    No reconciling items found in tax returns.
                  </td>
                </tr>
              )}

              {/* ── Part 3: Reconciliation check ── */}
              <tr className="border-t-2 border-primary/20 bg-[#FAFBF7]">
                <td className="border-r border-border px-5 py-3.5 text-left text-[13px] font-bold text-text-primary">
                  Tax to Book Reconciliation Check
                </td>
                {activeYears.map((year, idx) => {
                  const check = getReconCheck(year);
                  return (
                    <Fragment key={year}>
                      <td className="px-4 py-3.5" />
                      <td className={cn("px-4 py-3.5 text-right tabular-nums font-bold", getVarianceClass(check))}>
                        {formatAmount(check)}
                      </td>
                      <td className={cn("px-4 py-3.5", yrDiv(idx))} />
                    </Fragment>
                  );
                })}
              </tr>

              {/* ── Part 3: Unreconciled % ── */}
              <tr className="bg-[#FCFDF8]">
                <td className="border-r border-border px-5 py-3 text-left text-[13px] font-semibold text-text-secondary">
                  Unreconciled % of SDE
                </td>
                {activeYears.map((year, idx) => (
                  <Fragment key={year}>
                    <td className="px-4 py-3" />
                    <td className="px-4 py-3 text-right tabular-nums font-semibold text-text-primary">
                      0.0%
                    </td>
                    <td className={cn("px-4 py-3", yrDiv(idx))} />
                  </Fragment>
                ))}
              </tr>
            </tbody>
          </table>
        </div>

        {!isLoading && !hasMatrixData && !error && (
          <div className="border-t border-border px-5 py-6 text-[13px] text-text-muted">
            No data returned. Click <strong>Refresh</strong> to load.
          </div>
        )}
      </section>
    </div>
  );
}
