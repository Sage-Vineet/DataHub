import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
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
  listManualGlDatasetVersions,
  getTaxReconciliationOverrides,
  saveTaxReconciliationOverrides,
  getFinancialStatements,
} from "../../../lib/api";
import { readCachedFinancials, writeCachedFinancials } from "../../../lib/keyReportFinancials";
import { useDataSource } from "../../../context/DataSourceContext";

import {
  useKeyReportContextStore,
  selectKeyReportContext,
  maskKeyReportContext,
} from "../../../store/useKeyReportContextStore";
import { useShallow } from "zustand/react/shallow";
import KeyReportVersionSelector from "../../../components/key-reports/KeyReportVersionSelector";

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

// Build the flat P&L rows (name / amount / type) that extractTaxRowsFromManualPL
// consumes, from a Key Reports financial-statements response for one fiscal year.
// This lets the Tax Reconciliation P&L come from the SAME working source the
// Reports page uses (generateFinancialStatements) instead of the profit-loss
// report endpoint — which currently errors on some versions and left the P&L
// column blank. Section totals are typed "total" (so findByPatterns prefers
// them); individual accounts are typed "data" so the Officer Wages / Depreciation
// / Amortization / Interest line matches still work.
function financialsToPLRows(response, year) {
  const yr = String(year);
  const entry = (response?.reports?.profitAndLoss?.yearly || []).find((e) => String(e?.year) === yr);
  const st = entry?.statement;
  if (!st) return [];
  const rows = [];
  const num = (v) => Number(v) || 0;
  rows.push({ name: "Total Revenue", amount: num(st.revenue?.total), type: "total" });
  rows.push({ name: "Total Cost of Goods Sold", amount: num(st.costOfSales?.total), type: "total" });
  rows.push({ name: "Gross Profit", amount: num(st.grossProfit), type: "total" });
  for (const g of Object.values(st.operatingExpenses?.groups || {})) {
    for (const a of (g.accounts || [])) rows.push({ name: a.name, amount: num(a.amount), type: "data" });
  }
  for (const a of (st.costOfSales?.accounts || [])) rows.push({ name: a.name, amount: num(a.amount), type: "data" });
  rows.push({ name: "Total Expenses", amount: num(st.operatingExpenses?.total), type: "total" });
  for (const a of (st.revenue?.accounts || [])) rows.push({ name: a.name, amount: num(a.amount), type: "data" });
  rows.push({ name: "Net Income", amount: num(st.netIncome), type: "total" });
  return rows;
}

// ── Formatting ─────────────────────────────────────────────────────────────

function formatAmount(value) {
  if (value == null || value === "") return "-";
  const numericValue = Number(value);
  if (isNaN(numericValue) || numericValue === 0) return "-";
  const abs = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(Math.abs(numericValue));
  return numericValue < 0 ? `(${abs})` : abs;
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

// Complete Form 1065 Schedule K — Partners' Distributive Share Items list,
// grouped by section. Each section has a header label and the corresponding items.
// Items already in the table are filtered out at render time; deleted items can be re-added.
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

// Flat list derived from sections (used for any code that needs a plain array)
const SCHEDULE_K_ITEMS = SCHEDULE_K_SECTIONS.flatMap((s) => s.items);

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
  const [taxExportOpen, setTaxExportOpen] = useState(false);
  const [taxIsExporting, setTaxIsExporting] = useState(false);
  const [warnings, setWarnings] = useState(storedState?.warnings ?? []);
  const [isQBDisconnected, setIsQBDisconnected] = useState(false);
  const [syncStatus, setSyncStatus] = useState(() => ({
    status: Object.keys(storedState?.matrixData ?? {}).length > 0 ? "success" : "idle",
    message: Object.keys(storedState?.matrixData ?? {}).length > 0 ? "Restored saved data." : "",
  }));
  // Key Reports tax return gate: 'idle' | 'loading' | 'ok' | 'missing'
  const [krTaxGate, setKrTaxGate] = useState({ status: "idle" });

  // Dataset version selection removed — consolidated into Key Reports.

  // Key Reports drives this page ONLY when the active data source is
  // "key_reports" (activated from the Key Reports page). For the 4 connection
  // modes the KR context is masked inactive so the Connections-page selection
  // is authoritative. activeSourceMode resolves to "key_reports" in that mode.
  const krSelected = activeSourceMode === 'key_reports';
  const rawKr = useKeyReportContextStore(useShallow(selectKeyReportContext));
  const kr = useMemo(() => maskKeyReportContext(rawKr, krSelected), [rawKr, krSelected]);
  const effectiveSourceMode = kr.krActive
    ? (kr.flowType === 'manual_gl' ? 'manual' : 'manual_upload')
    : activeSourceMode;

  // User-edited Schedule K overrides: { [year]: { [label]: { taxReturn, pl, userAdded? } } }
  const [reconcilingOverrides, setReconcilingOverrides] = useState({});
  // Inline edit state: { year, label } or null
  const [editingCell, setEditingCell] = useState(null);
  const [editingValue, setEditingValue] = useState("");
  // Add-row dropdown state
  const [showAddRowDropdown, setShowAddRowDropdown] = useState(false);
  const [addRowSearch, setAddRowSearch] = useState("");
  const addRowRef = useRef(null);

  // Manual GL (staged General Ledger) sources its P&L from the platform's GL
  // reports — not from a separately uploaded P&L document. It's handled by its
  // own branch (checked before isManualMode) so the uploaded-file path is unchanged.
  const isManualGL = effectiveSourceMode === 'manual';
  const isManualMode = effectiveSourceMode === 'manual_upload' || effectiveSourceMode === 'manual';
  // A Key Reports Version is never the QuickBooks-Manual flow.
  const isQBManual = !kr.krActive && activeSourceMode === 'quickbooks_manual';

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

  // Manual GL internal version selection removed — consolidated into Key Reports.
  const selectedVersion = kr.resolvedDatasetVersion;
  const latestVersionRef = useRef(selectedVersion);
  latestVersionRef.current = selectedVersion;

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
      // Key Reports scoping (highest priority): resolve the tax return from the
      // SELECTED Key Report Version's linked documents.
      const krVersionParam = kr.krActive && kr.selectedVersionId
        ? `&keyReportVersionId=${encodeURIComponent(String(kr.selectedVersionId))}`
        : "";
      const taxVersionParam = selectedVersion
        ? `&datasetVersion=${encodeURIComponent(String(selectedVersion))}`
        : "";

      if (isManualGL) {
        // ...
        const headers = getHeaders();
        const allWarnings = [];
        const forceParam = forceRefresh ? "&force=1" : "";

        setSyncStatus({ status: "loading", message: "Reading manual GL P&L…" });

        // Tax returns (uploaded) + available GL fiscal years for the selected
        // version, in parallel. Passing datasetVersion scopes both the year
        // list and every subsequent P&L fetch to that version's transactions.
        const versionParam = selectedVersion ? { datasetVersion: String(selectedVersion) } : {};
        // Scope the tax return document resolution to the SELECTED version's Key
        // Reports mapping so it never mixes another version's (or staging's) returns.
        const [taxRes, filterRes] = await Promise.all([
          fetch(`${API_BASE_URL}/manual-report-uploads/tax-data?clientId=${clientId || ""}${forceParam}${taxVersionParam}${krVersionParam}`, { headers })
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

        // 1. Resolve P&L (per year) + Tax Return years.
        const forceParam = forceRefresh ? "&force=1" : "";

        // The P&L source depends on the mode:
        //  • Key Reports mode → the P&L is GL-derived and lives in the selected
        //    Version's entry tables (the same endpoint the Reports page uses).
        //    The manual-upload P&L folder is NOT used, because a KR version's
        //    books come from its linked GL / P&L documents.
        //  • Manual Upload connection mode → the uploaded P&L files (pl-for-tax).
        // The Tax Return side always comes from the KR-version-aware tax-data
        // endpoint (it resolves the linked Tax Return document server-side).
        let plYears = {};
        let taxRes;
        if (kr.krActive && kr.selectedVersionId) {
          // P&L comes from the version's generated financial statements — the same
          // reliable source the Reports page uses (reusing its sessionStorage
          // cache). The previous profit-loss report endpoint errored on some
          // versions, which left this whole P&L column blank.
          const [fsResp, taxResRaw] = await Promise.all([
            (async () => {
              let resp = readCachedFinancials(clientId, kr.selectedVersionId);
              if (!resp) {
                resp = await getFinancialStatements(kr.selectedVersionId, { currency: "USD" }).catch(() => null);
                if (resp) writeCachedFinancials(clientId, kr.selectedVersionId, resp);
              }
              return resp;
            })(),
            fetch(`${API_BASE_URL}/manual-report-uploads/tax-data?clientId=${clientId || ""}${forceParam}${krVersionParam}`, { headers })
              .then((r) => r.json()).catch(() => ({ success: false })),
          ]);
          // Derive P&L years from what the financial statements ACTUALLY contain
          // (every GL/BS year the version produced), not the selectedYears window
          // — that window defaults to the last three calendar years and silently
          // dropped earlier years (e.g. FY2023) that have a full P&L.
          const fsYears = (fsResp?.reports?.profitAndLoss?.yearly || [])
            .map((e) => Number(e?.year))
            .filter((y) => Number.isInteger(y) && y >= 1990 && y <= 2100);
          const plEntries = fsYears.map((y) => {
            const data = extractTaxRowsFromManualPL(financialsToPLRows(fsResp, y));
            // Skip years with no P&L so empty years don't create blank columns.
            return data.some((d) => Number(d.pl) !== 0) ? [y, { year: y, data }] : null;
          });
          plYears = Object.fromEntries(plEntries.filter(Boolean));
          taxRes = taxResRaw;
        } else {
          const [plRes, taxResRaw] = await Promise.all([
            fetch(`${API_BASE_URL}/manual-report-uploads/pl-for-tax?clientId=${clientId || ""}${forceParam}${krVersionParam}`, { headers })
              .then((r) => r.json()).catch(() => ({ success: false })),
            fetch(`${API_BASE_URL}/manual-report-uploads/tax-data?clientId=${clientId || ""}${forceParam}${krVersionParam}`, { headers })
              .then((r) => r.json()).catch(() => ({ success: false })),
          ]);
          // plYears: { 2023: { year, data: [{label, pl}] }, ... }
          plYears = (plRes.success && plRes.years) ? plRes.years : {};
          if (plRes.warning) allWarnings.push(plRes.warning);
          if (Array.isArray(plRes.warnings)) allWarnings.push(...plRes.warnings);
          taxRes = taxResRaw;
        }

        // taxYears: { 2022: { year, data: [{label, taxReturn, isReconcilingItem}] }, ... }
        const taxYears = (taxRes.success && taxRes.years) ? taxRes.years : {};

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
  }, [selectedYears, accountingMethod, clientId, getHeaders, isManualGL, isManualMode, isQBManual, currentYear, selectedVersion, kr.krActive, kr.selectedVersionId]);

  // Key Reports tax return gate — the "Tax Return missing in Key Reports" banner
  // and its "link in Key Reports" prompt ONLY apply when Key Reports is the active
  // data source. In the 4 connection modes (QuickBooks Online / Manual GL / Manual
  // Upload / QB Manual) tax reconciliation is driven by that connection, not by a
  // Key Report Version, so the gate is always "ok" and the KR banner is hidden.
  useEffect(() => {
    if (!clientId) return;
    if (!krSelected) {
      // Not in Key Reports mode → never show the KR-linking banner.
      setKrTaxGate({ status: "ok" });
      return;
    }
    // Key Reports mode: the gate reflects whether THIS Version has a Tax Return
    // linked (auto-detected). Tax Reconciliation requires GL/P&L + a Tax Return.
    if (kr.loadingDetail) {
      setKrTaxGate({ status: "loading" });
      return;
    }
    const ok = kr.availability.tax;
    setKrTaxGate({ status: ok ? "ok" : "missing" });
  }, [clientId, krSelected, kr.loadingDetail, kr.availability.tax]);

  // Auto-load on first visit. In Manual GL mode, wait until the version is
  // resolved before loading — and include selectedVersion in the deps so this
  // re-fires once the version becomes available (without it, the effect ran
  // once with a null version and never again, leaving an empty screen even
  // though an active version with data existed).
  useEffect(() => {
    if (!activeSource) return;
    if (isManualGL && !selectedVersion) return;
    if (Object.keys(matrixData).length > 0) return;
    // Removed strict krTaxGate.status !== "ok" check to allow P&L-only loading
    void loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSource, isManualGL, selectedVersion]);

  // Re-generate when the selected version changes so Tax Reconciliation always
  // reflects the chosen version's transactions with no cross-version leakage.
  const prevTaxVersionRef = useRef(selectedVersion);
  useEffect(() => {
    if (!isManualGL) return;
    if (prevTaxVersionRef.current === selectedVersion) return;
    prevTaxVersionRef.current = selectedVersion;
    if (!selectedVersion) return;
    // Removed strict krTaxGate.status !== "ok" check to allow P&L-only re-loading on version change
    try { window.sessionStorage.removeItem(getStorageKey(clientId)); } catch { /* ignore */ }
    setMatrixData({});
    setError("");
    setWarnings([]);
    setSyncStatus({ status: "idle", message: "" });
    void loadData(true);
  }, [isManualGL, selectedVersion, clientId, loadData]);

  // ── Overrides: load from DB whenever clientId changes ────────────────

  useEffect(() => {
    if (!clientId) return;
    let cancelled = false;
    getTaxReconciliationOverrides({ clientId })
      .then((res) => {
        if (!cancelled) setReconcilingOverrides(res?.overrides || {});
      })
      .catch(() => { /* non-fatal — start with empty overrides */ });
    return () => { cancelled = true; };
  }, [clientId]);

  // Close add-row dropdown on outside click
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

  // Debounced save to DB
  const saveTimeoutRef = useRef(null);
  const persistOverrides = useCallback((next) => {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => {
      saveTaxReconciliationOverrides({ clientId, overrides: next }).catch(() => {});
    }, 600);
  }, [clientId]);

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

  // All visible reconciling item labels = AI-extracted + user-added overrides,
  // minus any rows the user has explicitly deleted.
  const dynamicReconcilingItems = useMemo(() => {
    const labels = new Set();
    Object.values(matrixData).forEach((yearData) => {
      yearData?.data?.forEach((row) => {
        if (row.isReconcilingItem) labels.add(row.label);
      });
    });
    // Include labels added via user overrides (userAdded flag)
    Object.values(reconcilingOverrides).forEach((yearOvr) => {
      Object.entries(yearOvr || {}).forEach(([lbl, ovr]) => {
        if (ovr?.userAdded) labels.add(lbl);
      });
    });
    // Exclude labels deleted in ALL years (deleted flag present in every year that has data)
    return Array.from(labels)
      .filter((lbl) => {
        // A label is hidden only if EVERY year that has any data for it marks it deleted
        const yearsWithData = Object.keys(reconcilingOverrides).filter(
          (yr) => reconcilingOverrides[yr]?.[lbl] !== undefined,
        );
        if (!yearsWithData.length) return true; // no override → not deleted
        return yearsWithData.some((yr) => !reconcilingOverrides[yr][lbl]?.deleted);
      })
      .sort((a, b) => a.localeCompare(b));
  }, [matrixData, reconcilingOverrides]);

  // All Schedule K labels the AI found in the actual tax return documents (across all years),
  // including deleted ones — used to drive the "From Your Tax Return" section of the add-row dropdown.
  const aiExtractedScheduleKLabels = useMemo(() => {
    const labels = new Set();
    Object.values(matrixData).forEach((yearData) => {
      yearData?.data?.forEach((row) => {
        if (row.isReconcilingItem) labels.add(row.label);
      });
    });
    return Array.from(labels).sort((a, b) => a.localeCompare(b));
  }, [matrixData]);

  // Effective Tax Return value: deleted → 0, override wins over AI-extracted value
  const getReconValue = useCallback(
    (year, label) => {
      const ovr = reconcilingOverrides[String(year)]?.[label];
      if (ovr?.deleted) return 0;
      if (ovr !== undefined) return Number(ovr.taxReturn ?? 0);
      const row = matrixData[year]?.data?.find((r) => r?.label === label);
      return Number(row?.taxReturn ?? 0);
    },
    [matrixData, reconcilingOverrides],
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

  // ── Override edit handlers ────────────────────────────────────────────

  const startEdit = useCallback((year, label) => {
    setEditingCell({ year, label });
    const current = getReconValue(year, label);
    setEditingValue(current !== 0 ? String(current) : "");
  }, [getReconValue]);

  const commitEdit = useCallback((year, label) => {
    const raw = String(editingValue).replace(/[,\s]/g, "");
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

  const addReconRow = useCallback((label) => {
    setReconcilingOverrides((prev) => {
      const next = { ...prev };
      activeYears.forEach((yr) => {
        const yearKey = String(yr);
        const existing = next[yearKey]?.[label];
        // Only skip if there's already a live (non-deleted) override
        if (existing && !existing.deleted) return;
        next[yearKey] = { ...(next[yearKey] || {}), [label]: { taxReturn: 0, pl: 0, userAdded: true } };
      });
      persistOverrides(next);
      return next;
    });
    setShowAddRowDropdown(false);
    setAddRowSearch("");
  }, [activeYears, persistOverrides]);

  // Restores a previously deleted AI-extracted row by removing the deleted override entirely,
  // so getReconValue falls back to the original value from matrixData.
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
        // User-added rows: remove entirely so the label leaves the visible Set
        Object.keys(next).forEach((yr) => {
          if (next[yr]?.[label] !== undefined) {
            next[yr] = { ...next[yr] };
            delete next[yr][label];
          }
        });
      } else {
        // AI-extracted rows: mark deleted so they disappear but can be re-added from the dropdown
        activeYears.forEach((yr) => {
          const yearKey = String(yr);
          next[yearKey] = { ...next[yearKey], [label]: { ...(next[yearKey]?.[label] || {}), deleted: true } };
        });
      }
      persistOverrides(next);
      return next;
    });
  }, [activeYears, persistOverrides]);

  const yrDiv = (idx) =>
    idx < activeYears.length - 1 ? "border-r-2 border-r-primary/25" : "";

  const hasMatrixData = Object.keys(matrixData).length > 0;
  const reportTitle = company?.name || "Your Company";

  const exportTaxReconToExcel = () => {
    const wb = XLSX.utils.book_new();
    const fmtN = (v) => (v == null ? "" : Number(v) || 0);

    const getReconVal = (yr, label) => {
      const ovr = reconcilingOverrides[String(yr)]?.[label];
      if (ovr?.deleted) return 0;
      if (ovr !== undefined) return Number(ovr.taxReturn ?? 0);
      const d = matrixData[yr]?.data?.find((r) => r?.label === label);
      return Number(d?.taxReturn ?? 0);
    };

    const headerRow1 = ["Source"];
    const headerRow2 = [""];
    for (const yr of activeYears) {
      headerRow1.push(`FY ${yr}`, "", "");
      headerRow2.push("P&L", "Tax Return", "TR Variance");
    }

    const allRows = [headerRow1, headerRow2];

    for (const { label } of MAIN_LINE_ITEMS) {
      const row = [label];
      for (const yr of activeYears) {
        const d = matrixData[yr]?.data?.find((r) => r?.label === label);
        const pl = Number(d?.pl ?? 0);
        const taxReturn = Number(d?.taxReturn ?? 0);
        row.push(fmtN(pl), fmtN(taxReturn), fmtN(taxReturn - pl));
      }
      allRows.push(row);
    }

    const secRow = ["TAX TO BOOK RECONCILING ITEMS"];
    for (let i = 0; i < activeYears.length * 3; i++) secRow.push("");
    allRows.push(secRow);

    for (const label of dynamicReconcilingItems) {
      const row = [label];
      for (const yr of activeYears) {
        const taxReturn = getReconVal(yr, label);
        row.push("", fmtN(taxReturn), fmtN(taxReturn));
      }
      allRows.push(row);
    }

    const reconCheckRow = ["Reconciliation Check"];
    const unreconPctRow = ["Unreconciled %"];
    for (const yr of activeYears) {
      const nd = matrixData[yr]?.data?.find((r) => r?.label === "Net Income");
      const plNet = Number(nd?.pl ?? 0);
      const taxNet = Number(nd?.taxReturn ?? 0);
      const itemsSum = dynamicReconcilingItems.reduce((acc, lbl) => acc + getReconVal(yr, lbl), 0);
      const check = taxNet - plNet - itemsSum;
      reconCheckRow.push(fmtN(check), "", "");
      const pct = plNet !== 0 ? ((check / plNet) * 100).toFixed(1) + "%" : "0.0%";
      unreconPctRow.push(pct, "", "");
    }
    allRows.push(reconCheckRow);
    allRows.push(unreconPctRow);

    const ws = XLSX.utils.aoa_to_sheet(allRows);
    XLSX.utils.book_append_sheet(wb, ws, "Tax Reconciliation");
    XLSX.writeFile(wb, "Tax Reconciliation.xlsx");
  };

  const exportTaxReconToPdf = () => {
    const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
    const PAGE_W = 841.89;
    const PAGE_H = 595.28;
    const MARGIN = 30;
    const usableW = PAGE_W - MARGIN * 2;
    const LABEL_COL = 180;
    const yearGroupW = (usableW - LABEL_COL) / (activeYears.length || 1);
    const subColW = yearGroupW / 3;
    const ROW_H = 18;
    const FS = 8;
    let y = MARGIN;

    const fmtN = (v) => {
      const n = Number(v);
      if (v == null || v === "" || isNaN(n)) return "-";
      return n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    };

    const getReconVal = (yr, label) => {
      const ovr = reconcilingOverrides[String(yr)]?.[label];
      if (ovr?.deleted) return 0;
      if (ovr !== undefined) return Number(ovr.taxReturn ?? 0);
      const d = matrixData[yr]?.data?.find((r) => r?.label === label);
      return Number(d?.taxReturn ?? 0);
    };

    const checkPage = () => {
      if (y + ROW_H > PAGE_H - MARGIN) { doc.addPage(); y = MARGIN; }
    };

    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(0, 0, 0);
    doc.text("Tax Reconciliation", MARGIN, y + 12);
    y += 28;

    // Year group header row
    doc.setFontSize(FS + 1);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(0, 0, 0);
    doc.text("Source", MARGIN + 4, y + ROW_H - 5);
    activeYears.forEach((yr, i) => {
      const x = MARGIN + LABEL_COL + i * yearGroupW;
      doc.text(`FY ${yr}`, x + yearGroupW / 2, y + ROW_H - 5, { align: "center" });
    });
    doc.setDrawColor(0, 0, 0);
    doc.line(MARGIN, y + ROW_H, MARGIN + usableW, y + ROW_H);
    y += ROW_H;

    // Sub-column headers
    doc.setFontSize(FS);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(0, 0, 0);
    activeYears.forEach((_, i) => {
      ["P&L", "Tax Return", "TR Variance"].forEach((sl, j) => {
        const rx = MARGIN + LABEL_COL + i * yearGroupW + (j + 1) * subColW - 4;
        doc.text(sl, rx, y + ROW_H - 5, { align: "right" });
      });
    });
    doc.setDrawColor(0, 0, 0);
    doc.line(MARGIN, y + ROW_H, MARGIN + usableW, y + ROW_H);
    y += ROW_H;

    const drawRow = (label, bold, getCols) => {
      checkPage();
      doc.setFont("helvetica", bold ? "bold" : "normal");
      doc.setFontSize(FS);
      doc.setTextColor(0, 0, 0);
      doc.text(label, MARGIN + 4, y + ROW_H - 5);
      activeYears.forEach((yr, i) => {
        const [v0, v1, v2] = getCols(yr);
        const bx = MARGIN + LABEL_COL + i * yearGroupW;
        if (v0 !== "") doc.text(fmtN(v0), bx + subColW - 4, y + ROW_H - 5, { align: "right" });
        if (v1 !== "") doc.text(fmtN(v1), bx + subColW * 2 - 4, y + ROW_H - 5, { align: "right" });
        if (v2 !== "") doc.text(fmtN(v2), bx + subColW * 3 - 4, y + ROW_H - 5, { align: "right" });
      });
      doc.setDrawColor(180, 180, 180);
      doc.line(MARGIN, y + ROW_H, MARGIN + usableW, y + ROW_H);
      y += ROW_H;
    };

    for (const { label, isHighlight } of MAIN_LINE_ITEMS) {
      drawRow(label, isHighlight, (yr) => {
        const d = matrixData[yr]?.data?.find((r) => r?.label === label);
        const pl = Number(d?.pl ?? 0);
        const tr = Number(d?.taxReturn ?? 0);
        return [pl, tr, tr - pl];
      });
    }

    checkPage();
    doc.setFont("helvetica", "bold");
    doc.setFontSize(FS);
    doc.setTextColor(0, 0, 0);
    doc.text("TAX TO BOOK RECONCILING ITEMS", MARGIN + 4, y + ROW_H - 5);
    doc.setDrawColor(0, 0, 0);
    doc.line(MARGIN, y + ROW_H, MARGIN + usableW, y + ROW_H);
    y += ROW_H;

    for (const label of dynamicReconcilingItems) {
      drawRow(label, false, (yr) => {
        const tr = getReconVal(yr, label);
        return ["", tr, tr];
      });
    }

    drawRow("Reconciliation Check", true, (yr) => {
      const nd = matrixData[yr]?.data?.find((r) => r?.label === "Net Income");
      const plNet = Number(nd?.pl ?? 0);
      const taxNet = Number(nd?.taxReturn ?? 0);
      const itemsSum = dynamicReconcilingItems.reduce((acc, lbl) => acc + getReconVal(yr, lbl), 0);
      return [taxNet - plNet - itemsSum, "", ""];
    });

    checkPage();
    doc.setFont("helvetica", "bold");
    doc.setFontSize(FS);
    doc.setTextColor(0, 0, 0);
    doc.text("Unreconciled %", MARGIN + 4, y + ROW_H - 5);
    activeYears.forEach((yr, i) => {
      const nd = matrixData[yr]?.data?.find((r) => r?.label === "Net Income");
      const plNet = Number(nd?.pl ?? 0);
      const taxNet = Number(nd?.taxReturn ?? 0);
      const itemsSum = dynamicReconcilingItems.reduce((acc, lbl) => acc + getReconVal(yr, lbl), 0);
      const check = taxNet - plNet - itemsSum;
      const pct = plNet !== 0 ? ((check / plNet) * 100).toFixed(1) + "%" : "0.0%";
      const bx = MARGIN + LABEL_COL + i * yearGroupW;
      doc.text(pct, bx + subColW - 4, y + ROW_H - 5, { align: "right" });
    });
    y += ROW_H;

    doc.save("Tax Reconciliation.pdf");
  };

  const handleTaxExport = (kind) => {
    setTaxExportOpen(false);
    setTaxIsExporting(true);
    try {
      if (kind === "excel") {
        exportTaxReconToExcel();
      } else {
        exportTaxReconToPdf();
      }
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
                Tax Return missing in Key Reports
              </p>
              <p className="mt-1 text-sm text-amber-700">
                A <strong>Tax Return</strong> is not linked in the selected Key Reports Version.
                The "Tax Return" and "Variance" columns below will show no data until a return is linked.
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

      {isManualMode && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-wrap items-center gap-3">
              {syncStatus?.message && <SyncStatus sync={syncStatus} />}
              {/* Key Reports Version selector — only when Key Reports is the active source */}
              {krSelected && <KeyReportVersionSelector clientId={clientId} variant="filter" />}
            </div>
            <button
              type="button"
              onClick={() => {
                try { window.sessionStorage.removeItem(getStorageKey(clientId)); } catch { /* ignore */ }
                setMatrixData({});
                void loadData();
              }}
              disabled={isLoading}
              className="inline-flex h-9 items-center justify-center gap-2 rounded-xl bg-primary px-4 text-[13px] font-semibold text-white transition hover:bg-primary-dark disabled:cursor-not-allowed disabled:opacity-70"
            >
              <RefreshCw size={14} className={cn(isLoading && "animate-spin")} />
              {isLoading ? "Syncing…" : "Sync"}
            </button>
            {TaxExportDropdown}
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
                  try { window.sessionStorage.removeItem(getStorageKey(clientId)); } catch { /* ignore */ }
                  setMatrixData({});
                  void loadData();
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

        <div id="tax-recon-table" className="overflow-x-auto">
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

              {/* ── Part 2 rows (editable) ── */}
              {dynamicReconcilingItems.length > 0 ? (
                dynamicReconcilingItems.map((label, rowIdx) => {
                  return (
                    <tr
                      key={label}
                      className={cn(
                        "group border-b border-[#f1f5f9] transition-colors hover:bg-slate-50",
                        rowIdx % 2 === 0 ? "bg-white" : "bg-[#FCFDF8]",
                      )}
                    >
                      {/* Label cell with delete button (all rows) */}
                      <td className="border-r border-border px-5 py-2.5 text-left text-[13px] font-medium text-text-secondary">
                        <div className="flex items-center justify-between gap-2">
                          <span>{label}</span>
                          <button
                            onClick={() => deleteReconRow(label)}
                            title="Remove this row"
                            className="invisible shrink-0 rounded p-0.5 text-text-muted opacity-60 hover:text-red-500 hover:opacity-100 group-hover:visible"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </td>

                      {activeYears.map((year, idx) => {
                        const val = getReconValue(year, label);
                        const isEditing = editingCell?.year === year && editingCell?.label === label;
                        const hasOverride = reconcilingOverrides[String(year)]?.[label] !== undefined;
                        return (
                          <Fragment key={year}>
                            <td className="px-4 py-2.5 text-right text-text-muted">—</td>

                            {/* Editable Tax Return cell */}
                            <td
                              className={cn(
                                "px-2 py-1.5 text-right tabular-nums font-medium",
                                val !== 0 ? "bg-primary/5 text-primary" : "text-text-secondary",
                                isEditing ? "bg-white p-0" : "cursor-pointer hover:ring-1 hover:ring-primary/30",
                              )}
                              onClick={() => !isEditing && startEdit(year, label)}
                            >
                              {isEditing ? (
                                <div className="flex items-center gap-0.5">
                                  <input
                                    autoFocus
                                    type="text"
                                    value={editingValue}
                                    onChange={(e) => setEditingValue(e.target.value)}
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter") commitEdit(year, label);
                                      if (e.key === "Escape") cancelEdit();
                                    }}
                                    onBlur={() => commitEdit(year, label)}
                                    className="w-24 rounded border border-primary/50 bg-white px-2 py-1 text-right text-[13px] font-medium text-primary outline-none focus:ring-1 focus:ring-primary"
                                  />
                                  <button onMouseDown={(e) => { e.preventDefault(); commitEdit(year, label); }} className="rounded p-0.5 text-primary hover:bg-primary/10"><Check size={12} /></button>
                                  <button onMouseDown={(e) => { e.preventDefault(); cancelEdit(); }} className="rounded p-0.5 text-text-muted hover:bg-slate-100"><X size={12} /></button>
                                </div>
                              ) : (
                                <span className={cn("flex items-center justify-end gap-1", hasOverride && "underline decoration-dotted decoration-primary/40")}>
                                  {formatAmount(val)}
                                </span>
                              )}
                            </td>

                            <td className={cn("px-4 py-2.5 text-right text-text-muted", yrDiv(idx))}>—</td>
                          </Fragment>
                        );
                      })}
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={1 + activeYears.length * 3} className="px-5 py-4 text-center text-[13px] text-text-muted italic">
                    No reconciling items found. Add items using the button below.
                  </td>
                </tr>
              )}

              {/* ── Add Row row ── */}
              <tr className="border-b border-[#f1f5f9] bg-[#F8FBF1]">
                <td className="border-r border-border px-4 py-2" colSpan={1 + activeYears.length * 3}>
                  <div className="relative inline-block" ref={addRowRef}>
                    <button
                      onClick={() => { setShowAddRowDropdown((v) => !v); setAddRowSearch(""); }}
                      className="flex items-center gap-1.5 rounded-md border border-primary/30 bg-white px-3 py-1.5 text-[12px] font-medium text-primary hover:bg-primary/5 hover:border-primary/50 transition-colors"
                    >
                      <Plus size={13} />
                      Add Schedule K Item
                    </button>

                    {showAddRowDropdown && (
                      <div className="absolute left-0 top-full z-30 mt-1 w-72 rounded-lg border border-border bg-white shadow-lg">
                        <div className="p-2 border-b border-border">
                          <input
                            autoFocus
                            type="text"
                            placeholder="Search or type custom label…"
                            value={addRowSearch}
                            onChange={(e) => setAddRowSearch(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && addRowSearch.trim()) {
                                addReconRow(addRowSearch.trim());
                              }
                              if (e.key === "Escape") { setShowAddRowDropdown(false); setAddRowSearch(""); }
                            }}
                            className="w-full rounded border border-border px-2 py-1.5 text-[12px] outline-none focus:ring-1 focus:ring-primary"
                          />
                        </div>
                        <ul className="max-h-60 overflow-y-auto py-1">
                          {/* Custom typed label — only when it's not already in AI list, static list, or table */}
                          {addRowSearch.trim() &&
                            !aiExtractedScheduleKLabels.some(
                              (s) => s.toLowerCase() === addRowSearch.trim().toLowerCase()
                            ) &&
                            !SCHEDULE_K_ITEMS.some(
                              (s) => s.toLowerCase() === addRowSearch.trim().toLowerCase()
                            ) &&
                            !dynamicReconcilingItems.includes(addRowSearch.trim()) && (
                            <li>
                              <button
                                onMouseDown={() => addReconRow(addRowSearch.trim())}
                                className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-primary hover:bg-primary/5"
                              >
                                <Plus size={12} className="shrink-0" />
                                Add &ldquo;{addRowSearch.trim()}&rdquo;
                              </button>
                            </li>
                          )}
                          {/* Dynamically built from the actual AI-extracted tax return data + static supplement */}
                          {(() => {
                            const searchLower = addRowSearch.trim().toLowerCase();

                            // Section 1: items the AI found in this company's tax return document
                            const fromTaxReturn = aiExtractedScheduleKLabels.filter(
                              (item) =>
                                !dynamicReconcilingItems.includes(item) &&
                                (!searchLower || item.toLowerCase().includes(searchLower)),
                            );

                            // Section 2: standard Schedule K items NOT found by AI and not already in table
                            const staticSections = SCHEDULE_K_SECTIONS.map((sec) => ({
                              ...sec,
                              visible: sec.items.filter(
                                (item) =>
                                  !aiExtractedScheduleKLabels.includes(item) &&
                                  !dynamicReconcilingItems.includes(item) &&
                                  (!searchLower || item.toLowerCase().includes(searchLower)),
                              ),
                            })).filter((sec) => sec.visible.length > 0);

                            const hasAny = fromTaxReturn.length > 0 || staticSections.length > 0;

                            if (!hasAny) {
                              return (
                                <li className="px-3 py-3 text-center text-[12px] text-text-muted italic">
                                  {searchLower
                                    ? "No matching Schedule K items."
                                    : "All Schedule K items are already in the table."}
                                </li>
                              );
                            }

                            return (
                              <>
                                {fromTaxReturn.length > 0 && (
                                  <li>
                                    <div className="px-3 pt-2.5 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary/60">
                                      From Your Tax Return
                                    </div>
                                    <ul>
                                      {fromTaxReturn.map((item) => (
                                        <li key={item}>
                                          <button
                                            onMouseDown={() => restoreAiRow(item)}
                                            className="w-full px-4 py-1.5 text-left text-[12px] text-text-primary hover:bg-primary/5"
                                          >
                                            {item}
                                          </button>
                                        </li>
                                      ))}
                                    </ul>
                                  </li>
                                )}
                                {staticSections.length > 0 && (
                                  <>
                                    {fromTaxReturn.length > 0 && (
                                      <li>
                                        <div className="mx-3 my-1 border-t border-border" />
                                      </li>
                                    )}
                                    {staticSections.map((sec) => (
                                      <li key={sec.section}>
                                        <div className="px-3 pt-2.5 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                                          {sec.section}
                                        </div>
                                        <ul>
                                          {sec.visible.map((item) => (
                                            <li key={item}>
                                              <button
                                                onMouseDown={() => addReconRow(item)}
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
                                )}
                              </>
                            );
                          })()}
                        </ul>
                      </div>
                    )}
                  </div>
                </td>
              </tr>

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
