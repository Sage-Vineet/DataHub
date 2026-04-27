"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import {
  AlertCircle,
  CheckCircle2,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import { cn } from "../../../lib/utils";
import { getCompanyRequest, getStoredToken } from "../../../lib/api";
import QBDisconnectedBanner from "../../../components/common/QBDisconnectedBanner";

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL || "http://localhost:4000";

const STORAGE_PREFIX = "workspace-tax-reconciliation-v3";

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

/**
 * MAIN_LINE_ITEMS — Page 1 of Form 1120-S.
 *
 * NOTE: "Total Interest Income" is intentionally removed from this list.
 * Interest income (Schedule K Line 4) is a pass-through item that does NOT
 * appear on Page 1 of the 1120-S — it belongs in the Tax-to-Book
 * Reconciling Items section (Schedule K rows), where it will appear
 * dynamically from the PDF extraction.
 */
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

  const selectedYears = useMemo(() => {
    const s = parseInt(startYear, 10);
    const e = parseInt(endYear, 10);
    const lo = Math.min(s, e);
    const hi = Math.max(s, e);
    return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  }, [startYear, endYear]);

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
  //
  // Uses two separate endpoints:
  //   GET /quickbooks-pl  → fast QB P&L data
  //   GET /tax-data       → slow Gemini PDF extraction
  //
  // Both are fetched in parallel per year, then merged.

  const loadData = useCallback(async () => {
    setIsLoading(true);
    setError("");
    setIsQBDisconnected(false);
    setSyncStatus({ status: "loading", message: "Fetching P&L & Tax Data…" });

    try {
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

          // QB disconnected?
          if (plRes.success === false && (plRes.error || "").includes("QB not connected")) {
            setIsQBDisconnected(true);
          }

          // ── Merge: start from P&L labels, overlay tax return values ──
          const mergedMap = new Map();

          // 1. P&L rows
          if (plRes.success && Array.isArray(plRes.data)) {
            plRes.data.forEach((item) => {
              mergedMap.set(item.label, {
                label: item.label,
                pl: Number(item.pl || 0),
                taxReturn: 0,
                isReconcilingItem: false,
              });
            });
          }

          // 2. Tax return rows (both Page 1 fixed rows and Schedule K dynamic rows)
          if (taxRes.success && Array.isArray(taxRes.data)) {
            taxRes.data.forEach((item) => {
              if (mergedMap.has(item.label)) {
                // Existing P&L row — overlay tax return value
                mergedMap.get(item.label).taxReturn = Number(item.taxReturn || 0);
              } else {
                // New row (Schedule K reconciling item or any label not in P&L)
                mergedMap.set(item.label, {
                  label: item.label,
                  pl: 0,
                  taxReturn: Number(item.taxReturn || 0),
                  isReconcilingItem: !!item.isReconcilingItem,
                });
              }
            });
          }

          // 3. Compute variance for every row
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
    } catch (err) {
      console.error("Load Error:", err);
      setError(err instanceof Error ? err.message : "Failed to load data");
      setSyncStatus({ status: "error", message: "Failed to refresh" });
    } finally {
      setIsLoading(false);
    }
  }, [selectedYears, accountingMethod, clientId, getHeaders]);

  const hasStoredData = Object.keys(storedState?.matrixData ?? {}).length > 0;
  useEffect(() => {
    if (hasStoredData) return;
    void loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Data helpers ──────────────────────────────────────────────────────

  const getTaxPayload = useCallback(
    (year) =>
      Object.values(matrixData).find(
        (p) => p != null && Number(p.taxYear) === Number(year),
      ) ?? null,
    [matrixData],
  );

  const getMainRow = useCallback(
    (year, label) => {
      const row = matrixData[year]?.data?.find((r) => r?.label === label);
      const pl = Number(row?.pl ?? 0);
      const taxReturn = Number(row?.taxReturn ?? 0);
      return { pl, taxReturn, variance: taxReturn - pl };
    },
    [matrixData],
  );

  /**
   * Collect all unique reconciling-item labels across all years,
   * sorted consistently (alphabetical, except keep well-known items first).
   */
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

  /**
   * Check = Tax Net Income − Book Net Income − Sum(reconciling items)
   * Should be 0 when fully reconciled.
   */
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

  // Right-border divider between year groups
  const yrDiv = (idx) =>
    idx < selectedYears.length - 1 ? "border-r-2 border-r-primary/25" : "";

  const hasMatrixData = Object.keys(matrixData).length > 0;
  const reportTitle = company?.name || "Your Company";

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {isQBDisconnected && <QBDisconnectedBanner pageName="Tax Reconciliation" />}

      {/* Controls */}
      <section className="rounded-[var(--radius-card)] border border-border bg-white p-5 shadow-[0_10px_30px_rgba(15,23,42,0.04)] lg:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h1 className="text-[20px] font-semibold text-text-primary">Tax Reconciliation</h1>
            <p className="mt-1 text-[14px] text-text-secondary">
              QuickBooks tax-to-book and SDE reconciliation for {reportTitle}.
            </p>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            {[
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

            <button
              type="button"
              onClick={() => void loadData()}
              disabled={isLoading}
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

      {/* ── Single unified table ── */}
      <section className="rounded-[var(--radius-card)] border border-border bg-white shadow-[0_10px_30px_rgba(15,23,42,0.04)]">
        <div className="border-b border-border px-5 py-4">
          <h2 className="text-[16px] font-semibold text-text-primary">Data Source Reconciliation</h2>
          <p className="mt-1 text-[13px] text-text-secondary">
            Compare P&amp;L, tax return, and variance columns for {startYear}–{endYear}.
          </p>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full table-fixed border-collapse text-[13px]">
            <colgroup>
              <col style={{ width: "220px" }} />
              {selectedYears.map((y) => (
                <Fragment key={y}>
                  <col style={{ width: "110px" }} />
                  <col style={{ width: "110px" }} />
                  <col style={{ width: "110px" }} />
                </Fragment>
              ))}
            </colgroup>

            <thead>
              {/* FY year headers */}
              <tr className="border-b border-border bg-[#F8FBF1] text-primary">
                <th
                  rowSpan={2}
                  className="border-r border-border px-5 py-3 text-left text-[12px] font-semibold uppercase tracking-wide align-bottom"
                >
                  Source
                </th>
                {selectedYears.map((year, idx) => (
                  <th
                    key={year}
                    colSpan={3}
                    className={cn("px-4 py-2.5 text-center text-[13px] font-bold", yrDiv(idx))}
                  >
                    FY {year}
                  </th>
                ))}
              </tr>

              {/* Column sub-headers */}
              <tr className="border-b-2 border-border bg-[#F8FBF1]/70 text-primary/80">
                {selectedYears.map((year, idx) => (
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

              {/* ── Part 1: Page 1 P&L vs Tax Return ── */}

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

                    {selectedYears.map((year, idx) => {
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

              {/* ── Part 2: Section divider ── */}

              <tr className="border-y-2 border-primary/20 bg-[#EEF6E0]">
                <td className="border-r border-border px-5 py-3 text-left text-[12px] font-bold uppercase tracking-wide text-primary">
                  Tax to Book Reconciling Items (Schedule K)
                </td>
                {selectedYears.map((year, idx) => (
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

              {/* ── Part 2 rows: ALL Schedule K items extracted dynamically ── */}

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
                    {selectedYears.map((year, idx) => {
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
                  <td colSpan={1 + selectedYears.length * 3} className="px-5 py-6 text-center text-text-muted italic">
                    No reconciling items found in tax returns.
                  </td>
                </tr>
              )}

              {/* ── Part 3: Reconciliation check row ── */}

              <tr className="border-t-2 border-primary/20 bg-[#FAFBF7]">
                <td className="border-r border-border px-5 py-3.5 text-left text-[13px] font-bold text-text-primary">
                  Tax to Book Reconciliation Check
                </td>
                {selectedYears.map((year, idx) => {
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
                {selectedYears.map((year, idx) => (
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