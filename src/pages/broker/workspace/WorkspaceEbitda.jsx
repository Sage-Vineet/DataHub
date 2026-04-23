import { useEffect, useState, useCallback } from "react";
import { useParams } from "react-router-dom";
import {
  RefreshCw,
  TrendingUp,
  AlertCircle,
  Plus,
  Trash2,
} from "lucide-react";
import { cn, formatCurrency } from "../../../lib/utils";
import { getCompanyRequest } from "../../../lib/api";
import {
  getEbitdaData,
} from "../../../services/ebitdaService";
import { refreshQuickbooksToken } from "../../../lib/quickbooks";
import QBDisconnectedBanner from "../../../components/common/QBDisconnectedBanner";

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
        No financial data was found for the current workspace.
        Please ensure your QuickBooks connection is active.
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
/*  Main Component                                                    */
/* ------------------------------------------------------------------ */

export default function WorkspaceEbitda() {
  const { clientId } = useParams();

  const accountingMethod = "Accrual";

  // Data state
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
    return () => {
      active = false;
    };
  }, [clientId]);



  const handleGenerate = useCallback(async () => {
    setIsLoading(true);
    setError("");
    try {
      const currentYear = new Date().getFullYear();
      const todayStr = new Date().toISOString().split('T')[0];
      const yearList = [currentYear, currentYear - 1, currentYear - 2, currentYear - 3];
      setYears(yearList);

      const results = {};

      // Fetch data for each year in parallel
      await Promise.all(
        yearList.map(async (year) => {
          const sy = `${year}-01-01`;
          // Current year uses today; previous years use full year (Dec 31)
          const ey = year === currentYear ? todayStr : `${year}-12-31`;

          console.log(`[EBITDA] Fetching data for ${year}: Range ${sy} to ${ey}`);

          try {
            const data = await getEbitdaData(sy, ey, accountingMethod);
            console.log(`[EBITDA] Received data for ${year}:`, data);

            if (!data || !data.hasData) {
              console.warn(`[EBITDA] Year ${year} has no data or returned null`);
            }

            results[year] = data;
          } catch (err) {
            console.error(`[EBITDA] Failed to fetch data for ${year}:`, err);
            results[year] = null;
          }
        })
      );

      setMultiYearData(results);
    } catch (err) {
      console.error("[WorkspaceEbitda] Generation failed:", err);
      setError(err?.message || "Failed to fetch EBITDA data. Please try again.");
      setMultiYearData(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
    handleGenerate();
  }, [handleGenerate]);

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
          const vals = {};
          Object.keys(multiYearData).forEach(year => {
            const apiVal = getValueFromPL(year, ab.label);
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
          return { ...ab, values: vals };
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
  }, [multiYearData, clientId, isDataInitialized, getValueFromPL]);

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

  const handleAddAddback = () => {
    const newId = `custom_${Date.now()}`;
    const newVals = {};

    // Step 5: Dynamic Row Creation
    years.forEach(year => {
      newVals[year] = {
        apiValue: null,
        userValue: null
      };
    });

    setDynamicAddbacks([...dynamicAddbacks, {
      id: newId,
      label: "New Addback",
      values: newVals,
      isUserAdded: true
    }]);
  };

  const updateAddbackValue = (id, year, value) => {
    setDynamicAddbacks(prev => prev.map(ab => {
      if (ab.id === id) {
        return {
          ...ab,
          values: {
            ...ab.values,
            [year]: {
              ...ab.values[year],
              userValue: value === "" ? null : Number(value)
            }
          }
        };
      }
      return ab;
    }));
  };

  const updateAddbackLabel = (id, label) => {
    setDynamicAddbacks(prev => prev.map(ab => {
      if (ab.id === id) {
        // Step 5: Try to match this label in API when label changes
        const newValues = { ...ab.values };
        years.forEach(year => {
          newValues[year] = {
            ...newValues[year],
            apiValue: getValueFromPL(year, label)
          };
        });
        return { ...ab, label, values: newValues };
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


        {/* Content */}
        {isLoading ? (
          <LoadingState />
        ) : error ? (
          <ErrorState error={error} onRetry={handleGenerate} />
        ) : multiYearData ? (
          <div className="animate-in slide-in-from-bottom-2 fade-in duration-300">
            {/* Side-by-Side Layout Wrapper */}
            <div className="flex gap-6 items-start">
              {/* Left: Financial Report Table */}
              <div className="flex-1 overflow-hidden rounded-xl border border-[#cbd5e1] bg-white shadow-lg">
                <div className="bg-[#8bc53d] py-3 text-center">
                  <h2 className="text-[18px] font-bold text-white">
                    Recalculated Seller's Discretionary Earnings of {company?.name || "the Business"}
                  </h2>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-[14px]">
                    <thead>
                      <tr className="bg-[#8bc53d] text-white">
                        <th className="border-b border-[#cbd5e1] p-3 text-left font-bold min-w-[280px]"></th>
                        {years.map(year => (
                          <th key={year} className="border-b border-[#cbd5e1] p-3 text-right font-bold min-w-[120px]">
                            FY {year}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {/* Net Income Section */}
                      <tr className="border-b border-[#cbd5e1] bg-gray-50 h-[46px]">
                        <td className="p-3 font-bold text-[#050505]">Net Income</td>
                        {years.map(year => (
                          <td key={year} className="p-3 text-right font-bold text-[#050505]">
                            {formatCurrency(multiYearData[year]?.components?.netIncome?.value)}
                          </td>
                        ))}
                      </tr>

                      {/* EBITDA Adjustments removed */}
                      {[
                        { key: 'interestIncome', label: 'Total Interest Income' },
                        { key: 'interestExpense', label: 'Total Interest Expense' },
                        { key: 'taxes', label: 'Total Income Tax Expense' },
                        { key: 'depreciation', label: 'Depreciation' },
                        { key: 'amortization', label: 'Amortization Expense' }
                      ].map(row => (
                        <tr key={row.key} className="border-b border-[#f1f5f9] hover:bg-slate-50 transition-colors h-[45px]">
                          <td className="p-3 pl-8 text-text-primary">{row.label}</td>
                          {years.map(year => (
                            <td key={year} className="p-3 text-right text-text-primary">
                              {formatCurrency(multiYearData[year]?.components?.[row.key]?.value)}
                            </td>
                          ))}
                        </tr>
                      ))}

                      {/* Calculated EBITDA row */}
                      <tr className="bg-[#f8fafc] border-y border-[#cbd5e1] h-[45px]">
                        <td className="p-3 pl-4 font-bold text-[#050505]">EBITDA</td>
                        {years.map(year => {
                          const ebitdaVal = calculateBaseEbitda(year);
                          return (
                            <td key={year} className="p-3 text-right font-bold text-[#050505]">
                              {formatCurrency(ebitdaVal)}
                            </td>
                          );
                        })}
                      </tr>

                      {/* Owner Addbacks Section */}
                      <tr className="bg-white h-[45px]">
                        <td colSpan={years.length + 1} className="p-3 px-4 flex items-center justify-between font-bold text-[#050505] bg-gray-100">
                          <span>Addbacks</span>
                          <button
                            onClick={handleAddAddback}
                            className="flex items-center gap-1.5 px-3 py-1 rounded-md bg-[#8bc53d] text-white text-[11px] font-bold hover:bg-[#78ab34] transition-colors"
                          >
                            <Plus size={12} strokeWidth={3} />
                            ADD ROW
                          </button>
                        </td>
                      </tr>
                      {dynamicAddbacks.map((row) => (
                        <tr key={row.id} className="group border-b border-[#f1f5f9] hover:bg-slate-50 transition-colors h-[45px]">
                          <td className="p-3 pl-8 text-text-primary">
                            <div className="flex items-center gap-2">
                              <input
                                value={row.label}
                                onChange={(e) => updateAddbackLabel(row.id, e.target.value)}
                                className="w-full bg-transparent border-b border-transparent hover:border-gray-300 focus:border-[#8bc53d] focus:outline-none transition-all py-0.5"
                                placeholder="Enter label..."
                              />
                              <button
                                onClick={() => deleteAddback(row.id)}
                                className="opacity-0 group-hover:opacity-100 p-1 text-red-500 hover:bg-red-50 rounded transition-all"
                                title="Delete Row"
                              >
                                <Trash2 size={14} />
                              </button>
                            </div>
                          </td>
                          {years.map((year) => {
                            const { apiValue, userValue } = row.values[year] || { apiValue: null, userValue: null };

                            // Step 3: Display Logic - valueToShow = userValue !== null ? userValue : apiValue
                            const val = userValue !== null ? userValue : apiValue;
                            const isEdited = userValue !== null;
                            const displayVal = val !== null ? formatCurrency(val) : "-";

                            return (
                              <td key={year} className={cn("p-1.5 text-right", isEdited && "bg-green-50")}>
                                <input
                                  type="text"
                                  value={userValue !== null ? userValue : (apiValue !== null ? apiValue : "")}
                                  onChange={(e) => updateAddbackValue(row.id, year, e.target.value)}
                                  className={cn(
                                    "w-full bg-transparent text-right font-medium focus:outline-none focus:ring-1 focus:ring-[#8bc53d] rounded px-2 py-1",
                                    isEdited ? "text-[#8bc53d]" : (apiValue !== null ? "text-text-primary" : "text-gray-300")
                                  )}
                                  placeholder={apiValue !== null ? apiValue : "-"}
                                />
                              </td>
                            );
                          })}
                        </tr>
                      ))}

                      {/* Final Totals */}
                      <tr className="border-t-2 border-[#8bc53d] bg-[#f8fafc] h-[58px]">
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
                      </tr>
                      <tr className="border-b border-[#cbd5e1] bg-white h-[45px]">
                        <td className="p-3 font-bold text-[#050505]">SDE % of Sales</td>
                        {years.map(year => {
                          const data = multiYearData[year];
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
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Right: Comments Panel */}
              <div className="w-[380px] overflow-hidden rounded-xl border border-[#cbd5e1] bg-white shadow-lg flex flex-col">
                <div className="bg-[#8bc53d] py-3 text-center border-b border-[#cbd5e1]">
                  <h2 className="text-[18px] font-bold text-white">Comments</h2>
                </div>

                <div className="flex-1 flex flex-col space-y-0">
                  {/* Net Income Comment */}
                  <div className="h-[46px] border-b border-[#cbd5e1] bg-gray-50 p-1 flex items-center">
                    <input
                      value={rowComments['netIncome'] || ""}
                      onChange={(e) => updateRowComment('netIncome', e.target.value)}
                      placeholder="Net income remarks..."
                      className="w-full bg-transparent border-none focus:ring-0 text-[13px] px-3 placeholder:italic text-slate-600"
                    />
                  </div>

                  {/* EBITDA Adj Comments */}
                  {[
                    { key: 'interestIncome', label: 'Total Interest Income' },
                    { key: 'interestExpense', label: 'Total Interest Expense' },
                    { key: 'taxes', label: 'Total Income Tax Expense' },
                    { key: 'depreciation', label: 'Depreciation' },
                    { key: 'amortization', label: 'Amortization Expense' }
                  ].map(row => (
                    <div key={row.key} className="h-[45px] border-b border-[#f1f5f9] p-1 flex items-center hover:bg-slate-50 transition-colors">
                      <input
                        value={rowComments[row.key] || ""}
                        onChange={(e) => updateRowComment(row.key, e.target.value)}
                        placeholder={`${row.label} remarks...`}
                        className="w-full bg-transparent border-none focus:ring-0 text-[13px] px-3 placeholder:italic text-slate-600"
                      />
                    </div>
                  ))}

                  {/* EBITDA Row Comment */}
                  <div className="h-[45px] border-y border-[#cbd5e1] bg-[#f8fafc] p-1 flex items-center">
                    <input
                      value={rowComments['ebitda'] || ""}
                      onChange={(e) => updateRowComment('ebitda', e.target.value)}
                      placeholder="EBITDA remarks..."
                      className="w-full bg-transparent border-none font-bold focus:ring-0 text-[13px] px-3 placeholder:italic placeholder:font-normal text-slate-800"
                    />
                  </div>

                  {/* Owner Addbacks Section spacer */}
                  <div className="h-[45px] bg-gray-100 border-b border-[#cbd5e1]" />

                  {/* Dynamic Addback Comments */}
                  {dynamicAddbacks.map((row) => (
                    <div key={row.id} className="h-[45px] border-b border-[#f1f5f9] p-1 flex items-center hover:bg-slate-50 transition-colors">
                      <input
                        value={rowComments[row.id] || ""}
                        onChange={(e) => updateRowComment(row.id, e.target.value)}
                        placeholder={`${row.label} remarks...`}
                        className="w-full bg-transparent border-none focus:ring-0 text-[13px] px-3 placeholder:italic text-slate-600"
                      />
                    </div>
                  ))}

                  {/* Story of SDE Totals Comments */}
                  <div className="h-[58px] border-t-2 border-[#8bc53d] bg-[#f8fafc] p-2 flex items-center">
                    <textarea
                      value={rowComments['totalSde'] || ""}
                      onChange={(e) => updateRowComment('totalSde', e.target.value)}
                      placeholder="Story of Seller's Discretionary Earnings..."
                      className="w-full bg-transparent border-none focus:ring-0 text-[12px] px-2 leading-tight resize-none placeholder:italic font-semibold text-slate-800"
                      rows={2}
                    />
                  </div>
                  <div className="h-[45px] border-b border-[#cbd5e1] bg-white p-1 flex items-center">
                    <input
                      value={rowComments['sdePercent'] || ""}
                      onChange={(e) => updateRowComment('sdePercent', e.target.value)}
                      placeholder="Margin analysis..."
                      className="w-full bg-transparent border-none focus:ring-0 text-[13px] px-3 placeholder:italic text-slate-600"
                    />
                  </div>
                </div>
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
                    <input
                      type="number"
                      value={sdePerCim}
                      onChange={(e) => setSdePerCim(e.target.value)}
                      placeholder="Enter value..."
                      className="w-32 bg-white border border-gray-200 rounded px-2 py-1 text-right font-mono focus:ring-1 focus:ring-[#8bc53d] outline-none"
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
      </div>
    </div>
  );
}
