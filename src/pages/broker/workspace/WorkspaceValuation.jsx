import React, { useState, useEffect } from "react";
import { useParams } from "react-router-dom";
import { getStoredToken } from "../../../lib/api";
import { DollarSign, TrendingUp, Briefcase, Activity, AlertCircle } from "lucide-react";

// In-memory cache to preserve valuation data across tab switches
const valuationCache = {};

export default function WorkspaceValuation() {
  const { clientId } = useParams();
  const [data, setData] = useState(valuationCache[clientId] || null);
  const [loading, setLoading] = useState(!valuationCache[clientId]);
  const [error, setError] = useState(null);

  useEffect(() => {
    async function loadValuation() {
      try {
        setLoading(true);
        const token = getStoredToken();
        const response = await fetch(
          `${import.meta.env.VITE_API_BASE_URL || "http://localhost:4000"}/valuation`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
              "X-Client-Id": clientId,
            },
            body: JSON.stringify({}),
          }
        );

        const result = await response.json();
        if (!response.ok || !result.success) {
          throw new Error(result.error || "Failed to fetch valuation data");
        }
        
        // Save to cache so it persists when returning to this tab
        valuationCache[clientId] = result.data;
        setData(result.data);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }

    if (clientId && !valuationCache[clientId]) {
      loadValuation();
    }
  }, [clientId]);

  const formatCurrency = (val) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(val || 0);

  if (loading) {
    return (
      <div className="flex h-[400px] items-center justify-center text-sm font-medium text-text-secondary">
        <div className="flex flex-col items-center gap-3">
          <TrendingUp className="animate-pulse text-primary" size={32} />
          <span>Calculating Valuation Models...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-text-primary">
          Business Valuation
        </h1>
        <p className="mt-1 text-sm text-text-secondary">
          Real-time enterprise and equity valuation estimates based on live QuickBooks data.
        </p>
      </div>

      {error ? (
        <div className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-red-700">
          <AlertCircle size={20} className="mt-0.5 shrink-0" />
          <p className="text-sm font-medium">{error}</p>
        </div>
      ) : data ? (
        <>
          {/* Quick Metrics */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <div className="rounded-xl border border-border bg-white p-5 shadow-sm">
              <div className="mb-2 flex items-center gap-3 text-text-secondary">
                <Activity size={18} />
                <span className="text-sm font-medium">Trailing EBITDA</span>
              </div>
              <p className="text-2xl font-bold text-text-primary">
                {formatCurrency(data.ebitda)}
              </p>
            </div>
            <div className="rounded-xl border border-border bg-white p-5 shadow-sm">
              <div className="mb-2 flex items-center gap-3 text-text-secondary">
                <Briefcase size={18} />
                <span className="text-sm font-medium">Total Debt</span>
              </div>
              <p className="text-2xl font-bold text-text-primary">
                {formatCurrency(data.debt)}
              </p>
            </div>
            <div className="rounded-xl border border-border bg-white p-5 shadow-sm">
              <div className="mb-2 flex items-center gap-3 text-text-secondary">
                <DollarSign size={18} />
                <span className="text-sm font-medium">Cash & Equivalents</span>
              </div>
              <p className="text-2xl font-bold text-text-primary">
                {formatCurrency(data.cash)}
              </p>
            </div>
          </div>

          {/* Valuation Methods */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <div className="flex flex-col justify-between rounded-xl border border-border bg-white p-6 shadow-sm">
              <div>
                <h3 className="mb-1 text-lg font-bold text-text-primary">
                  EBITDA Multiple Method
                </h3>
                <p className="mb-6 text-sm text-text-secondary">
                  Assumes an {data.assumptions?.ebitdaMultiple ? data.assumptions.ebitdaMultiple.toFixed(1) : "8.0"}x industry multiple on trailing EBITDA.
                </p>
                <div className="space-y-4">
                  <div className="flex items-center justify-between border-b border-border/50 pb-3">
                    <span className="text-sm font-medium text-text-secondary">
                      Enterprise Value
                    </span>
                    <span className="text-sm font-semibold text-text-primary">
                      {formatCurrency(data.ebitdaValuation.enterpriseValue)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between border-b border-border/50 pb-3">
                    <span className="text-sm font-medium text-text-secondary">
                      Adjustments (+ Cash, - Debt)
                    </span>
                    <span className="text-sm font-semibold text-text-primary">
                      {formatCurrency(data.cash - data.debt)}
                    </span>
                  </div>
                </div>
              </div>
              <div className="mt-6 flex items-end justify-between">
                <span className="text-sm font-bold text-text-primary">
                  Implied Equity Value
                </span>
                <span className="text-2xl font-bold text-primary">
                  {formatCurrency(data.ebitdaValuation.equityValue)}
                </span>
              </div>
            </div>

            <div className="flex flex-col justify-between rounded-xl border border-border bg-white p-6 shadow-sm">
              <div>
                <h3 className="mb-1 text-lg font-bold text-text-primary">
                  Discounted Cash Flow (DCF)
                </h3>
                <p className="mb-6 text-sm text-text-secondary">
                  Projected cash flows over 3 years discounted at a {(data.assumptions?.discountRate * 100).toFixed(0) || "10"}% WACC.
                </p>
              </div>
              <div className="mt-auto flex items-end justify-between">
                <span className="text-sm font-bold text-text-primary">
                  Present Value (PV)
                </span>
                <span className="text-2xl font-bold text-primary">
                  {formatCurrency(data.dcfValue)}
                </span>
              </div>
            </div>
          </div>

          {/* Final Estimate */}
          <div className="relative mt-6 overflow-hidden rounded-2xl bg-gradient-to-br from-primary to-primary-dark p-8 shadow-lg">
            <div className="absolute right-0 top-0 p-8 text-white opacity-10">
              <TrendingUp size={120} />
            </div>
            <div className="relative z-10">
              <h2 className="mb-2 text-lg font-semibold text-white/90">
                Blended Valuation Estimate
              </h2>
              <p className="mb-6 max-w-lg text-sm text-white/70">
                This blended estimate averages the EBITDA Multiple, DCF, and
                Industry Benchmark ({data.assumptions?.benchmarkMultiple ? data.assumptions.benchmarkMultiple.toFixed(1) : "7.0"}x) methodologies to provide a balanced fair market value.
              </p>
              <div className="flex items-baseline gap-2">
                <span className="text-5xl font-black tracking-tight text-white">
                  {formatCurrency(data.finalEstimate)}
                </span>
                <span className="text-sm font-medium text-white/70">USD</span>
              </div>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
