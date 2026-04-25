"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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
const PL_ENDPOINT = `${API_BASE_URL}/tax-profit-and-loss`;
const EXTRACT_ENDPOINT = `${API_BASE_URL}/extract`;
const TAX_RECONCILIATION_STORAGE_PREFIX = "workspace-tax-reconciliation";
const DEFAULT_START_DATE = "2023-01-01";
const DEFAULT_END_DATE = "2023-12-31";
const DEFAULT_ACCOUNTING_METHOD = "Cash";

// ── Session-storage helpers ────────────────────────────────────────────────

function getTaxReconciliationStorageKey(clientId) {
  return `${TAX_RECONCILIATION_STORAGE_PREFIX}:${clientId || "default"}`;
}

function getStoredTaxReconciliationState(clientId) {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(
      getTaxReconciliationStorageKey(clientId),
    );
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

// ── Formatting ─────────────────────────────────────────────────────────────

function formatAmount(value) {
  if (value == null || Number(value) === 0) return "-";
  const numericValue = Number(value);
  const abs = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(Math.abs(numericValue));
  return numericValue < 0 ? `(${abs})` : abs;
}

function getVarianceTextClass(value) {
  const numericValue = Number(value || 0);
  if (!numericValue) return "text-text-muted";
  return numericValue < 0 ? "text-red-600" : "text-green-600";
}

// ── Parse QB P&L response → P&L column ────────────────────────────────────
//
// The QB ProfitAndLoss report uses the same nested Row/ColData structure
// as the BalanceSheet. We walk all rows recursively and match on the
// account label in ColData[0].value.

function extractQBValue(rows, labelHint) {
  if (!Array.isArray(rows)) return null;
  for (const row of rows) {
    // Summary rows carry the rolled-up total we usually want
    const summaryVal = row?.Summary?.ColData;
    if (summaryVal) {
      const label = summaryVal[0]?.value?.toLowerCase() || "";
      if (label.includes(labelHint.toLowerCase())) {
        const v = parseFloat(summaryVal[1]?.value);
        return isNaN(v) ? null : v;
      }
    }
    // Data rows
    const colData = row?.ColData;
    if (colData) {
      const label = colData[0]?.value?.toLowerCase() || "";
      if (label.includes(labelHint.toLowerCase())) {
        const v = parseFloat(colData[1]?.value);
        return isNaN(v) ? null : v;
      }
    }
    // Recurse into nested Rows
    const nested = row?.Rows?.Row;
    if (nested) {
      const found = extractQBValue(nested, labelHint);
      if (found !== null) return found;
    }
  }
  return null;
}

function parseQBPLResponse(payload) {
  try {
    const rows = payload?.data?.Rows?.Row || [];

    return {
      totalRevenue:
        extractQBValue(rows, "total income") ??
        extractQBValue(rows, "total revenue"),
      totalCostOfGoodsSold:
        extractQBValue(rows, "total cost of goods sold") ??
        extractQBValue(rows, "total cogs"),
      grossProfit: extractQBValue(rows, "gross profit"),
      officerWages:
        extractQBValue(rows, "officer") ??
        extractQBValue(rows, "officer wages"),
      depreciationExpense: extractQBValue(rows, "depreciation"),
      amortizationExpense: extractQBValue(rows, "amortization"),
      totalInterestExpense: extractQBValue(rows, "interest expense"),
      totalInterestIncome: extractQBValue(rows, "interest income"),
      allOtherExpenses:
        extractQBValue(rows, "other expenses") ??
        extractQBValue(rows, "all other"),
      netIncome: extractQBValue(rows, "net income"),
    };
  } catch (err) {
    console.error("QB P&L parse error:", err);
    return null;
  }
}

// ── Parse /extract markdown response → Tax Return column ──────────────────
//
// Response shape (markdown bullet list):
//   "* **Total Revenue**: $2,570,511\n* **Net Income**: $353,311\n..."
//
// Strategy: find each known label with a regex, strip $ and commas.

function parseBulletValue(text, label) {
  // Matches:  * **Label**: $1,234,567  or  * **Label**: 1234
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `\\*\\*${escaped}\\*\\*[^\\$\\d]*(\\$?[\\d,]+(?:\\.\\d+)?)`,
    "i",
  );
  const match = text.match(re);
  if (!match) return null;
  const v = parseFloat(match[1].replace(/[$,]/g, ""));
  return isNaN(v) ? null : v;
}

function parseExtractResponse(rawPayload) {
  try {
    const text = typeof rawPayload?.data === "string" ? rawPayload.data : "";
    if (!text) return null;

    return {
      totalRevenue: parseBulletValue(text, "Total Revenue"),
      totalCostOfGoodsSold: parseBulletValue(text, "Total Cost of Goods Sold"),
      grossProfit: parseBulletValue(text, "Gross Profit"),
      officerWages: parseBulletValue(text, "Officer Wages"),
      depreciationExpense: parseBulletValue(text, "Depreciation Expense"),
      amortizationExpense: parseBulletValue(text, "Amortization Expense"),
      totalInterestExpense: parseBulletValue(text, "Total Interest Expense"),
      totalInterestIncome: parseBulletValue(text, "Total Interest Income"),
      allOtherExpenses: parseBulletValue(text, "All Other Expenses"),
      netIncome: parseBulletValue(text, "Net Income"),
    };
  } catch (err) {
    console.error("Extract parse error:", err);
    return null;
  }
}

// ── Table builder ──────────────────────────────────────────────────────────

function deriveRowValues(pl = 0, taxReturn = 0) {
  return { pl, taxReturn, trVariance: taxReturn - pl };
}

// plData and taxReturnData are both flat objects with the same keys
function buildTableRows(plData, taxReturnData) {
  const pl = plData || {};
  const tr = taxReturnData || {};

  const rows = [
    { label: "Total Revenue", key: "totalRevenue" },
    { label: "Total Cost of Goods Sold", key: "totalCostOfGoodsSold" },
    { label: "Gross Profit", key: "grossProfit", strong: true },
    { label: "Officer Wages", key: "officerWages" },
    { label: "Depreciation Expense", key: "depreciationExpense" },
    { label: "Amortization Expense", key: "amortizationExpense" },
    { label: "Total Interest Expense", key: "totalInterestExpense" },
    { label: "Total Interest Income", key: "totalInterestIncome" },
    { label: "All Other Expenses", key: "allOtherExpenses" },
    { label: "Net Income", key: "netIncome", strong: true },
  ];

  return rows.map((r) => ({
    ...r,
    values: [deriveRowValues(pl[r.key] ?? 0, tr[r.key] ?? 0)],
  }));
}

// ── SyncStatus badge ───────────────────────────────────────────────────────

function SyncStatus({ sync }) {
  if (!sync?.message) return null;
  return (
    <div
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[12px] font-medium",
        sync.status === "loading" &&
        "border-primary/20 bg-primary/5 text-primary",
        sync.status === "error" && "border-red-200 bg-red-50 text-red-700",
        sync.status === "success" &&
        "border-emerald-200 bg-emerald-50 text-emerald-700",
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

// ── Main component ─────────────────────────────────────────────────────────

export default function WorkspaceTaxReconciliation() {
  const { clientId } = useParams();
  const storedState = getStoredTaxReconciliationState(clientId);

  const [company, setCompany] = useState(null);
  const [startDate, setStartDate] = useState(
    storedState?.startDate || DEFAULT_START_DATE,
  );
  const [endDate, setEndDate] = useState(
    storedState?.endDate || DEFAULT_END_DATE,
  );
  const [accountingMethod, setAccountingMethod] = useState(
    storedState?.accountingMethod || DEFAULT_ACCOUNTING_METHOD,
  );
  const [plData, setPlData] = useState(storedState?.plData || null);
  const [extractData, setExtractData] = useState(
    storedState?.extractData || null,
  );
  const [extractError, setExtractError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(storedState?.error || "");
  const [isQBDisconnected, setIsQBDisconnected] = useState(false);
  const [syncStatus, setSyncStatus] = useState({
    status: storedState?.plData ? "success" : "idle",
    message: storedState?.plData ? "Restored saved data." : "",
  });

  const getHeaders = useCallback(() => {
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
    };
  }, [clientId]);

  // ── Company name ─────────────────────────────────────────────────────

  useEffect(() => {
    let active = true;
    if (!clientId) {
      setCompany(null);
      return () => {
        active = false;
      };
    }
    getCompanyRequest(clientId)
      .then((p) => {
        if (active) setCompany(p);
      })
      .catch(() => {
        if (active) setCompany(null);
      });
    return () => {
      active = false;
    };
  }, [clientId]);

  // ── Restore state when clientId changes ──────────────────────────────

  useEffect(() => {
    const next = getStoredTaxReconciliationState(clientId);
    setStartDate(next?.startDate || DEFAULT_START_DATE);
    setEndDate(next?.endDate || DEFAULT_END_DATE);
    setAccountingMethod(next?.accountingMethod || DEFAULT_ACCOUNTING_METHOD);
    setPlData(next?.plData || null);
    setExtractData(next?.extractData || null);
    setExtractError("");
    setError(next?.error || "");
    setIsQBDisconnected(false);
    setSyncStatus({
      status: next?.plData ? "success" : "idle",
      message: next?.plData ? "Restored saved data." : "",
    });
  }, [clientId]);

  // ── Persist to sessionStorage ────────────────────────────────────────

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.sessionStorage.setItem(
        getTaxReconciliationStorageKey(clientId),
        JSON.stringify({
          startDate,
          endDate,
          accountingMethod,
          plData,
          extractData,
          error,
        }),
      );
    } catch {
      /* ignore */
    }
  }, [
    clientId,
    startDate,
    endDate,
    accountingMethod,
    plData,
    extractData,
    error,
  ]);

  // ── Main loader ───────────────────────────────────────────────────────

  const loadData = useCallback(async () => {
    setIsLoading(true);
    setError("");
    setIsQBDisconnected(false);
    setSyncStatus({ status: "loading", message: "Fetching data..." });

    try {
      const params = new URLSearchParams({
        start_date: startDate,
        end_date: endDate,
        accounting_method: accountingMethod,
      });
      if (clientId) params.append("clientId", clientId);

      const [plResp, extractResp] = await Promise.all([
        fetch(`${PL_ENDPOINT}?${params.toString()}`, {
          cache: "no-store",
          headers: getHeaders(),
        }),
        fetch(EXTRACT_ENDPOINT, {
          cache: "no-store",
          headers: getHeaders(),
        }),
      ]);

      // ── P&L (left column) ─────────────────────────────────────────
      const plPayload = await plResp.json();
      if (!plResp.ok) {
        const msg =
          plPayload?.error || plPayload?.message || `HTTP ${plResp.status}`;
        if (plResp.status === 401) setIsQBDisconnected(true);
        throw new Error(msg);
      }
      const parsedPL = parseQBPLResponse(plPayload);
      setPlData(parsedPL);

      // ── /extract (right column) ───────────────────────────────────
      if (extractResp.ok) {
        const extractPayload = await extractResp.json();
        const parsed = parseExtractResponse(extractPayload);
        setExtractData(parsed);
        setExtractError("");
      } else {
        const extractPayload = await extractResp.json().catch(() => null);
        const extractMsg =
          extractPayload?.error ||
          extractPayload?.message ||
          `HTTP ${extractResp.status}`;
        console.warn(
          `/extract ${extractResp.status} — Tax Return column will show dashes.`,
        );
        setExtractData(null);
        setExtractError(extractMsg);
      }

      setSyncStatus({
        status: "success",
        message: "Data loaded successfully.",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setPlData(null);
      setSyncStatus({ status: "error", message: msg });
    } finally {
      setIsLoading(false);
    }
  }, [startDate, endDate, accountingMethod, clientId, getHeaders]);

  // Auto-load on first visit
  useEffect(() => {
    if (storedState?.plData) return;
    void loadData();
  }, [loadData, storedState?.plData]);

  const rows = useMemo(
    () => buildTableRows(plData, extractData),
    [plData, extractData],
  );
  const reportTitle = plData ? company?.name || "Your Company" : "Your Company";

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {isQBDisconnected && (
        <QBDisconnectedBanner pageName="Tax Reconciliation" />
      )}

      {/* Controls */}
      <section className="rounded-[var(--radius-card)] border border-border bg-white p-5 shadow-[0_10px_30px_rgba(15,23,42,0.04)] lg:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h1 className="text-[20px] font-semibold text-text-primary">
              Tax Reconciliation
            </h1>
            <p className="mt-1 text-[14px] text-text-secondary">
              QuickBooks tax-to-book and SDE reconciliation for {reportTitle}.
            </p>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <label className="flex min-w-[140px] flex-col gap-1.5 text-[13px] font-medium text-text-primary">
              Start Date
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="h-11 rounded-xl border border-border bg-white px-3 text-[14px] text-text-primary outline-none transition focus:border-primary"
              />
            </label>

            <label className="flex min-w-[140px] flex-col gap-1.5 text-[13px] font-medium text-text-primary">
              End Date
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="h-11 rounded-xl border border-border bg-white px-3 text-[14px] text-text-primary outline-none transition focus:border-primary"
              />
            </label>

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
              <RefreshCw
                size={16}
                className={cn(isLoading && "animate-spin")}
              />
              Refresh
            </button>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <SyncStatus sync={syncStatus} />
          {extractData && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-medium text-emerald-700">
              <CheckCircle2 size={11} />
              Tax Return values from extract API
            </span>
          )}
        </div>

        {extractError && (
          <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800">
            Tax Return column unavailable: {extractError}
          </div>
        )}
        {error && !isQBDisconnected && (
          <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
            {error}
          </div>
        )}
      </section>

      {/* Reconciliation matrix */}
      <section className="rounded-[var(--radius-card)] border border-border bg-white shadow-[0_10px_30px_rgba(15,23,42,0.04)]">
        <div className="border-b border-border px-5 py-4">
          <h2 className="text-[16px] font-semibold text-text-primary">
            Reconciliation Matrix
          </h2>
          <p className="mt-1 text-[13px] text-text-secondary">
            Compare P&amp;L, tax return, and variance columns.
          </p>
        </div>

        <div className="overflow-x-auto p-4">
          <table className="min-w-[600px] table-auto border-separate border-spacing-0 overflow-hidden rounded-xl border border-border bg-white text-[13px]">
            <thead>
              <tr className="bg-[#FCFDF8] text-text-secondary">
                <th className="min-w-[280px] border-b border-r border-border px-4 py-3 text-left text-[12px] font-semibold uppercase tracking-wide">
                  Line Item
                </th>
                <th className="border-b border-border px-3 py-3 text-center text-[12px] font-semibold uppercase tracking-wide">
                  P&amp;L
                </th>
                <th className="border-b border-border px-3 py-3 text-center text-[12px] font-semibold uppercase tracking-wide">
                  Tax Return
                </th>
                <th className="border-b border-border px-3 py-3 text-center text-[12px] font-semibold uppercase tracking-wide">
                  TR Variance
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => {
                const v = row.values[0];
                return (
                  <tr
                    key={row.label}
                    className={cn(
                      rowIndex % 2 === 0 ? "bg-white" : "bg-[#FCFDF8]",
                      row.strong && "bg-[#FAFBF7] font-semibold",
                    )}
                  >
                    <td className="border-b border-r border-border px-4 py-3 text-left text-[13px] text-text-primary">
                      {row.label}
                    </td>
                    <td className="border-b border-border px-3 py-3 text-right tabular-nums text-text-primary">
                      {formatAmount(v.pl)}
                    </td>
                    <td className="border-b border-border px-3 py-3 text-right tabular-nums text-text-primary">
                      {formatAmount(v.taxReturn)}
                    </td>
                    <td
                      className={cn(
                        "border-b border-border px-3 py-3 text-right tabular-nums font-medium",
                        getVarianceTextClass(v.trVariance),
                      )}
                    >
                      {formatAmount(v.trVariance)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {!isLoading && !plData && !error && (
          <div className="border-t border-border px-4 py-6 text-[13px] text-text-muted">
            No P&amp;L data was returned for this company.
          </div>
        )}
      </section>
    </div>
  );
}
