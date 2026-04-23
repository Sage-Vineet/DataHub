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
import { getCompanyRequest } from "../../../lib/api";
import QBDisconnectedBanner from "../../../components/common/QBDisconnectedBanner";

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL || "http://localhost:4000";
const TAX_RECONCILIATION_ENDPOINT = `${API_BASE_URL}/tax-reconciliation`;
const TAX_RECONCILIATION_STORAGE_PREFIX = "workspace-tax-reconciliation";

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

function fiscalYearLabel(year) {
  return `FY${String(year).slice(-2)}`;
}

function deriveRowValues(pl = 0, cim = 0, taxReturn = 0) {
  return {
    pl,
    cim,
    cimVariance: cim - pl,
    taxReturn,
    trVariance: taxReturn - cim,
  };
}

function buildTableSections(years) {
  return [
    {
      key: "source",
      rows: [
        {
          label: "Depreciation Expense",
          resolve: (year) =>
            deriveRowValues(
              year.pl.depreciationExpense,
              year.pl.depreciationExpense,
              year.pl.depreciationExpense,
            ),
        },
        {
          label: "Amortization Expense",
          resolve: (year) =>
            deriveRowValues(
              year.pl.amortizationExpense,
              year.pl.amortizationExpense,
              year.pl.amortizationExpense,
            ),
        },
        {
          label: "Total Interest Expense",
          resolve: (year) =>
            deriveRowValues(
              year.pl.totalInterestExpense,
              year.pl.totalInterestExpense,
              year.pl.totalInterestExpense,
            ),
        },
        {
          label: "Total Interest Income",
          resolve: (year) =>
            deriveRowValues(
              year.pl.totalInterestIncome,
              0,
              year.taxReturn.interestIncomePerTaxReturns,
            ),
        },
        {
          label: "All Other Expenses",
          resolve: (year) =>
            deriveRowValues(
              year.pl.allOtherExpenses,
              year.pl.allOtherExpenses + year.raw.otherAdjustments,
              year.pl.allOtherExpenses,
            ),
        },
        {
          label: "Net Income",
          strong: true,
          resolve: (year) =>
            deriveRowValues(
              year.pl.netIncome,
              year.cim.netIncome,
              year.taxReturn.netIncome,
            ),
        },
      ],
    },
    {
      key: "taxToBook",
      heading: "Tax to Book Reconciling Items",
      rows: [
        {
          label: "Interest Income per tax returns",
          resolve: (year) =>
            deriveRowValues(0, 0, year.taxReturn.interestIncomePerTaxReturns),
        },
        {
          label: "Sec 179 Depreciation",
          resolve: (year) =>
            deriveRowValues(0, 0, year.taxToBookItems.sec179Depreciation),
        },
        {
          label: "Charitable Donations",
          resolve: (year) =>
            deriveRowValues(0, 0, year.taxToBookItems.charitableDonations),
        },
        {
          label: "Post 1986 Depreciation",
          resolve: (year) =>
            deriveRowValues(0, 0, year.taxToBookItems.post1986Depreciation),
        },
        {
          label: "Nondeductible Meals",
          resolve: (year) =>
            deriveRowValues(0, 0, year.taxToBookItems.nondeductibleMeals),
        },
        {
          label: "Change in Accounts Receivable",
          resolve: (year) =>
            deriveRowValues(
              0,
              0,
              year.taxToBookItems.changeInAccountsReceivable,
            ),
        },
        {
          label: "Accts Receivable - Retentions",
          resolve: (year) =>
            deriveRowValues(
              0,
              0,
              year.taxToBookItems.accountsReceivableRetentions,
            ),
        },
        {
          label: "Change in AP",
          resolve: (year) =>
            deriveRowValues(0, 0, year.taxToBookItems.changeInAP),
        },
        {
          label: "Bad Debt Write offs",
          resolve: (year) =>
            deriveRowValues(0, 0, year.taxToBookItems.badDebtWriteOffs),
        },
        {
          label: "Other",
          resolve: (year) => deriveRowValues(0, 0, year.taxToBookItems.other),
        },
        {
          label: "Tax to Book Reconciliation Check",
          strong: true,
          resolve: (year) =>
            deriveRowValues(0, 0, year.taxToBookItems.reconciliationCheck),
        },
      ],
    },
    {
      key: "sde",
      heading: "Additional SDE Addbacks",
      rows: [
        {
          label: "Depreciation Expense",
          resolve: (year) =>
            deriveRowValues(
              year.additionalSdeAddbacks.depreciationExpense,
              year.additionalSdeAddbacks.depreciationExpense,
              0,
            ),
        },
        {
          label: "Amortization Expense",
          resolve: (year) =>
            deriveRowValues(
              year.additionalSdeAddbacks.amortizationExpense,
              year.additionalSdeAddbacks.amortizationExpense,
              0,
            ),
        },
        {
          label: "Interest Expense",
          resolve: (year) =>
            deriveRowValues(
              year.additionalSdeAddbacks.totalInterestExpense,
              year.additionalSdeAddbacks.totalInterestExpense,
              0,
            ),
        },
        {
          label: "Travel, Meals & Entertainment",
          resolve: (year) =>
            deriveRowValues(
              year.additionalSdeAddbacks.travelMealsEntertainment,
              year.additionalSdeAddbacks.travelMealsEntertainment,
              0,
            ),
        },
        {
          label: "Bad Debt Expense",
          resolve: (year) =>
            deriveRowValues(
              year.additionalSdeAddbacks.badDebtExpense,
              year.additionalSdeAddbacks.badDebtExpense,
              0,
            ),
        },
        {
          label: "Charitable Donations",
          resolve: (year) =>
            deriveRowValues(
              year.additionalSdeAddbacks.charitableDonations,
              year.additionalSdeAddbacks.charitableDonations,
              0,
            ),
        },
        {
          label: "Other",
          resolve: (year) =>
            deriveRowValues(
              year.additionalSdeAddbacks.other,
              year.additionalSdeAddbacks.other,
              0,
            ),
        },
        {
          label: "Seller's Discretionary Earnings",
          strong: true,
          resolve: (year) =>
            deriveRowValues(
              year.pl.netIncome,
              year.cim.sellerDiscretionaryEarnings,
              year.taxReturn.netIncome,
            ),
        },
      ],
    },
  ].map((section) => ({
    ...section,
    rows: section.rows.map((row) => ({
      ...row,
      values: years.map((year) => row.resolve(year)),
    })),
  }));
}

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

export default function WorkspaceTaxReconciliation() {
  const { clientId } = useParams();
  const currentYear = new Date().getFullYear();
  const storedState = getStoredTaxReconciliationState(clientId);

  const [company, setCompany] = useState(null);
  const [comparisonEndYear, setComparisonEndYear] = useState(
    storedState?.comparisonEndYear || currentYear,
  );
  const [accountingMethod, setAccountingMethod] = useState(
    storedState?.accountingMethod || "Accrual",
  );
  const [taxData, setTaxData] = useState(storedState?.taxData || null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(storedState?.error || "");
  const [isQBDisconnected, setIsQBDisconnected] = useState(false);
  const [syncStatus, setSyncStatus] = useState({
    status: storedState?.taxData ? "success" : "idle",
    message: storedState?.taxData
      ? "Restored saved tax reconciliation."
      : "",
  });

  const yearOptions = useMemo(
    () =>
      Array.from({ length: 6 }, (_, index) => currentYear - 4 + index).sort(
        (a, b) => b - a,
      ),
    [currentYear],
  );

  const getHeaders = useCallback(
    () => (clientId ? { "X-Client-Id": clientId } : {}),
    [clientId],
  );

  useEffect(() => {
    let active = true;

    if (!clientId) {
      setCompany(null);
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

  useEffect(() => {
    const nextState = getStoredTaxReconciliationState(clientId);
    setComparisonEndYear(nextState?.comparisonEndYear || currentYear);
    setAccountingMethod(nextState?.accountingMethod || "Accrual");
    setTaxData(nextState?.taxData || null);
    setError(nextState?.error || "");
    setIsQBDisconnected(false);
    setSyncStatus({
      status: nextState?.taxData ? "success" : "idle",
      message: nextState?.taxData
        ? "Restored saved tax reconciliation."
        : "",
    });
  }, [clientId, currentYear]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    try {
      window.sessionStorage.setItem(
        getTaxReconciliationStorageKey(clientId),
        JSON.stringify({
          comparisonEndYear,
          accountingMethod,
          taxData,
          error,
        }),
      );
    } catch {
      // Ignore storage issues
    }
  }, [clientId, comparisonEndYear, accountingMethod, taxData, error]);

  const loadTaxReconciliation = useCallback(async () => {
    setIsLoading(true);
    setError("");
    setIsQBDisconnected(false);
    setSyncStatus({
      status: "loading",
      message: "Fetching QuickBooks tax reconciliation...",
    });

    try {
      const params = new URLSearchParams({
        comparison_end_year: String(comparisonEndYear),
        accounting_method: accountingMethod,
      });
      if (clientId) params.append("clientId", clientId);

      const response = await fetch(
        `${TAX_RECONCILIATION_ENDPOINT}?${params.toString()}`,
        {
          cache: "no-store",
          headers: getHeaders(),
        },
      );
      const payload = await response.json();

      if (!response.ok) {
        const message = payload?.error || payload?.message || `HTTP ${response.status}`;
        if (response.status === 401) {
          setIsQBDisconnected(true);
        }
        throw new Error(message);
      }

      setTaxData(payload);
      setSyncStatus({
        status: "success",
        message: `Loaded ${payload?.years?.length ?? 0} fiscal year comparison(s).`,
      });
    } catch (fetchError) {
      const message =
        fetchError instanceof Error ? fetchError.message : String(fetchError);
      setError(message);
      setTaxData(null);
      setSyncStatus({
        status: "error",
        message,
      });
    } finally {
      setIsLoading(false);
    }
  }, [accountingMethod, clientId, comparisonEndYear, getHeaders]);

  useEffect(() => {
    if (storedState?.taxData) return;
    void loadTaxReconciliation();
  }, [loadTaxReconciliation, storedState?.taxData]);

  const years = taxData?.years || [];
  const sections = useMemo(() => buildTableSections(years), [years]);
  const reportTitle =
    taxData?.companyName || company?.name || "Your Company";

  return (
    <div className="space-y-6">
      {isQBDisconnected && <QBDisconnectedBanner pageName="Tax Reconciliation" />}

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
            <label className="flex min-w-[150px] flex-col gap-1.5 text-[13px] font-medium text-text-primary">
              Comparison End Year
              <select
                value={comparisonEndYear}
                onChange={(event) =>
                  setComparisonEndYear(Number(event.target.value))
                }
                className="h-11 rounded-xl border border-border bg-white px-3 text-[14px] text-text-primary outline-none transition focus:border-primary"
              >
                {yearOptions.map((year) => (
                  <option key={year} value={year}>
                    {fiscalYearLabel(year)}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex min-w-[150px] flex-col gap-1.5 text-[13px] font-medium text-text-primary">
              Accounting Method
              <select
                value={accountingMethod}
                onChange={(event) => setAccountingMethod(event.target.value)}
                className="h-11 rounded-xl border border-border bg-white px-3 text-[14px] text-text-primary outline-none transition focus:border-primary"
              >
                <option value="Accrual">Accrual</option>
                <option value="Cash">Cash</option>
              </select>
            </label>

            <button
              type="button"
              onClick={() => void loadTaxReconciliation()}
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
          {taxData?.generatedAt && (
            <span className="text-[12px] text-text-muted">
              Generated{" "}
              {new Date(taxData.generatedAt).toLocaleString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })}
            </span>
          )}
        </div>

        {error && !isQBDisconnected && (
          <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
            {error}
          </div>
        )}
      </section>

      <section className="rounded-[var(--radius-card)] border border-border bg-white shadow-[0_10px_30px_rgba(15,23,42,0.04)]">
        <div className="border-b border-border px-5 py-4">
          <h2 className="text-[16px] font-semibold text-text-primary">
            Reconciliation Matrix
          </h2>
          <p className="mt-1 text-[13px] text-text-secondary">
            Compare P&amp;L, CIM, tax return, and variance columns by fiscal
            year.
          </p>
        </div>

        <div className="overflow-x-auto p-4">
          <table className="min-w-[1120px] table-auto border-separate border-spacing-0 overflow-hidden rounded-xl border border-border bg-white text-[13px]">
            <thead>
              <tr className="bg-[#F8FBF1] text-primary">
                <th className="min-w-[280px] border-b border-r border-border px-4 py-4 text-left text-[14px] font-semibold">
                  Year Source
                </th>
                {years.map((year, index) => (
                  <th
                    key={year.fiscalYear}
                    colSpan={5}
                    className={cn(
                      "border-b border-border px-3 py-4 text-center text-[14px] font-semibold",
                      index < years.length - 1 && "border-r-2 border-r-primary/25",
                    )}
                  >
                    {fiscalYearLabel(year.fiscalYear)}
                  </th>
                ))}
              </tr>
              <tr className="bg-[#FCFDF8] text-text-secondary">
                <th className="border-b border-r border-border px-4 py-3 text-left text-[12px] font-semibold uppercase tracking-wide">
                  Source
                </th>
                {years.map((year, index) => (
                  <FragmentColumnHeader
                    key={year.fiscalYear}
                    showDivider={index < years.length - 1}
                  />
                ))}
              </tr>
            </thead>
            <tbody>
              {sections.map((section) => (
                section.heading ? (
                  <SectionBlock
                    key={section.key}
                    heading={section.heading}
                    rows={section.rows}
                  />
                ) : (
                  <RowsBlock key={section.key} rows={section.rows} />
                )
              ))}
            </tbody>
          </table>
        </div>

        {!isLoading && !years.length && !error && (
          <div className="border-t border-border px-4 py-6 text-[13px] text-text-muted">
            No tax reconciliation data was returned for this company.
          </div>
        )}
      </section>
    </div>
  );
}

function FragmentColumnHeader({ showDivider = false }) {
  return (
    <>
      <th className="border-b border-border px-3 py-3 text-center text-[12px] font-semibold uppercase tracking-wide">
        P&amp;L
      </th>
      <th className="border-b border-border px-3 py-3 text-center text-[12px] font-semibold uppercase tracking-wide">
        CIM
      </th>
      <th className="border-b border-border px-3 py-3 text-center text-[12px] font-semibold uppercase tracking-wide">
        CIM Variance
      </th>
      <th className="border-b border-border px-3 py-3 text-center text-[12px] font-semibold uppercase tracking-wide">
        Tax Return
      </th>
      <th
        className={cn(
          "border-b border-border px-3 py-3 text-center text-[12px] font-semibold uppercase tracking-wide",
          showDivider && "border-r-2 border-r-primary/25",
        )}
      >
        TR Variance
      </th>
    </>
  );
}

function SectionBlock({ heading, rows }) {
  return (
    <>
      <tr className="bg-[#EEF6E0] text-primary">
        <td
          colSpan={1 + rows[0].values.length * 5}
          className="border-b border-t border-border px-4 py-3 text-left text-[13px] font-semibold"
        >
          {heading}
        </td>
      </tr>
      <RowsBlock rows={rows} />
    </>
  );
}

function RowsBlock({ rows }) {
  return rows.map((row, rowIndex) => (
    <tr
      key={row.label}
      className={cn(
        rowIndex % 2 === 0 ? "bg-white" : "bg-[#FCFDF8]",
        row.strong && "bg-[#FAFBF7] font-semibold",
      )}
    >
      <td
        className={cn(
          "border-b border-r border-border px-4 py-3 text-left text-[13px] text-text-primary",
          row.strong && "text-text-primary",
        )}
      >
        {row.label}
      </td>
      {row.values.map((value, index) => (
        <RowValueCells
          key={`${row.label}-${index}`}
          value={value}
          strong={row.strong}
          showDivider={index < row.values.length - 1}
        />
      ))}
    </tr>
  ));
}

function RowValueCells({ value, strong = false, showDivider = false }) {
  return (
    <>
      <td
        className={cn(
          "border-b border-border px-3 py-3 text-right tabular-nums text-text-primary",
          strong && "font-semibold",
        )}
      >
        {formatAmount(value.pl)}
      </td>
      <td
        className={cn(
          "border-b border-border px-3 py-3 text-right tabular-nums text-text-primary",
          strong && "font-semibold",
        )}
      >
        {formatAmount(value.cim)}
      </td>
      <td
        className={cn(
          "border-b border-border px-3 py-3 text-right tabular-nums font-medium",
          getVarianceTextClass(value.cimVariance),
          strong && "font-semibold",
        )}
      >
        {formatAmount(value.cimVariance)}
      </td>
      <td
        className={cn(
          "border-b border-border px-3 py-3 text-right tabular-nums text-text-primary",
          strong && "font-semibold",
        )}
      >
        {formatAmount(value.taxReturn)}
      </td>
      <td
        className={cn(
          "border-b border-border px-3 py-3 text-right tabular-nums font-medium",
          getVarianceTextClass(value.trVariance),
          showDivider && "border-r-2 border-r-primary/25",
          strong && "font-semibold",
        )}
      >
        {formatAmount(value.trVariance)}
      </td>
    </>
  );
}
