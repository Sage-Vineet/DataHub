import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import Header from "../../../components/Header";
import {
  ChevronDown,
  FileCheck,
  Download,
  FileText,
  RefreshCw,
} from "lucide-react";
import { cn } from "../../../lib/utils";
import { getCompanyRequest } from "../../../lib/api";
import {
  getBalanceSheet,
  getBalanceSheetDetail,
} from "../../../services/balanceSheetService";
import {
  getProfitAndLoss,
  getProfitAndLossDetail,
} from "../../../services/profitAndLossService";
import {
  getCashflow,
  getCashflowDetail,
} from "../../../services/cashflowService";
import BalanceSheetReport from "../../../components/reports/balance-sheet/BalanceSheetReport";
import ProfitAndLossReport from "../../../components/reports/profit-loss/ProfitAndLossReport";
import CashflowReport from "../../../components/reports/cashflow/CashflowReport";
import { refreshQuickbooksToken } from "../../../services/authService";
import {
  normalizeAccountingMethod,
  sanitizeDateRange,
} from "../../../lib/report-filters";
import {
  exportToExcel,
  exportToPDF,
  flattenDetailData,
  flattenRawReportData,
  flattenSummaryData,
} from "../../../lib/export-utils";

function formatDateForInput(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export default function WorkspaceReports() {
  const { clientId } = useParams();
  const today = new Date();
  const todayString = formatDateForInput(today);
  const REPORT_TABS = useMemo(
    () => [
      { key: "Balance Sheet", label: "Balance Sheet" },
      { key: "Profit & Loss", label: "Profit & Loss" },
      { key: "Cashflow", label: "Cash Flow" },
    ],
    [],
  );

  const [selectedTab, setSelectedTab] = useState("Balance Sheet");
  const [viewMode, setViewMode] = useState("generator");
  const [reportType, setReportType] = useState("Summary");
  const [dateRange, setDateRange] = useState("This Month");
  const [customRange, setCustomRange] = useState({
    start: `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-01`,
    end: todayString,
  });
  const [accountingMethod, setAccountingMethod] = useState("Accrual");
  const [reportsData, setReportsData] = useState({
    "Balance Sheet": { summary: [], detail: { groups: [] } },
    "Profit & Loss": { summary: [], detail: { groups: [] } },
    Cashflow: { summary: [], detail: { groups: [] } },
  });
  const [appliedStartDate, setAppliedStartDate] = useState("");
  const [appliedEndDate, setAppliedEndDate] = useState("");
  const [appliedReportType, setAppliedReportType] = useState("Summary");
  const [appliedAccountingMethod, setAppliedAccountingMethod] =
    useState("Accrual");
  const [isLoading, setIsLoading] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [isDownloadingPDF, setIsDownloadingPDF] = useState(false);
  const [reportFormat, setReportFormat] = useState("PDF");
  const [isSyncing, setIsSyncing] = useState(false);
  const [company, setCompany] = useState(null);

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

  const clientName = useMemo(
    () => company?.name || "All Clients",
    [company?.name],
  );
  const createdOn = useMemo(
    () =>
      new Date().toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
      }),
    [],
  );

  const handleSync = async () => {
    setIsSyncing(true);
    try {
      await refreshQuickbooksToken();
      await handleGenerateReport();
    } catch (error) {
      console.error("Sync failed:", error);
      alert("Sync failed. Please try again.");
    } finally {
      setIsSyncing(false);
    }
  };

  const getDates = () => {
    let startDate;
    let endDate;

    if (dateRange === "Custom Range") {
      startDate = customRange.start;
      endDate = customRange.end;
    } else {
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, "0");
      const day = String(now.getDate()).padStart(2, "0");
      endDate = `${year}-${month}-${day}`;

      if (dateRange === "Today") {
        startDate = `${year}-${month}-${day}`;
      } else if (dateRange === "This Month") {
        startDate = `${year}-${month}-01`;
      } else if (dateRange === "This Quarter") {
        const quarterMonth = String(
          Math.floor(now.getMonth() / 3) * 3 + 1,
        ).padStart(2, "0");
        startDate = `${year}-${quarterMonth}-01`;
      } else if (dateRange === "Previous Quarter") {
        const currentQuarterStartMonth = Math.floor(now.getMonth() / 3) * 3;
        const previousQuarterEnd = new Date(year, currentQuarterStartMonth, 0);
        const previousQuarterStart = new Date(
          previousQuarterEnd.getFullYear(),
          Math.floor(previousQuarterEnd.getMonth() / 3) * 3,
          1,
        );

        startDate = formatDateForInput(previousQuarterStart);
        endDate = formatDateForInput(previousQuarterEnd);
      } else if (dateRange === "This Year") {
        startDate = `${year}-01-01`;
      }
    }

    return { startDate, endDate };
  };

  const handleGenerateReport = async () => {
    setIsLoading(true);
    setViewMode("preview");

    try {
      const rawDates = getDates();
      const { startDate, endDate } = sanitizeDateRange(
        rawDates.startDate,
        rawDates.endDate,
      );
      const normalizedAccountingMethod =
        normalizeAccountingMethod(accountingMethod);

      setAppliedStartDate(startDate || "");
      setAppliedEndDate(endDate || "");
      setAppliedReportType(reportType);
      setAppliedAccountingMethod(accountingMethod);

      let summary = [];
      let detail = { groups: [] };

      if (selectedTab === "Balance Sheet") {
        [summary, detail] = await Promise.all([
          getBalanceSheet(startDate, endDate, normalizedAccountingMethod).catch(
            () => [],
          ),
          getBalanceSheetDetail(
            startDate,
            endDate,
            normalizedAccountingMethod,
          ).catch(() => ({ groups: [] })),
        ]);
      } else if (selectedTab === "Profit & Loss") {
        [summary, detail] = await Promise.all([
          getProfitAndLoss(
            startDate,
            endDate,
            normalizedAccountingMethod,
          ).catch(() => []),
          getProfitAndLossDetail(
            startDate,
            endDate,
            normalizedAccountingMethod,
          ).catch(() => ({ groups: [] })),
        ]);
      } else {
        [summary, detail] = await Promise.all([
          getCashflow(startDate, endDate, normalizedAccountingMethod).catch(
            () => [],
          ),
          getCashflowDetail(
            startDate,
            endDate,
            normalizedAccountingMethod,
          ).catch(() => ({ groups: [] })),
        ]);
      }

      setReportsData((previous) => ({
        ...previous,
        [selectedTab]: { summary, detail },
      }));
    } catch (error) {
      console.error("[WorkspaceReports] Generation failed:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleDownloadPDF = async () => {
    setIsDownloadingPDF(true);
    try {
      const fileName = `${selectedTab.toLowerCase()}-${appliedReportType.toLowerCase()}-report`;
      exportToPDF("report-export", fileName);
    } catch (error) {
      console.error("PDF generation failed:", error);
      alert("Error: Could not generate dynamic PDF report.");
    } finally {
      setIsDownloadingPDF(false);
    }
  };

  const generateExcel = async () => {
    setIsDownloading(true);
    try {
      const currentReport = reportsData[selectedTab];
      const dataToExport =
        appliedReportType === "Summary"
          ? currentReport.summary
          : currentReport.detail;

      const isEmpty =
        appliedReportType === "Summary"
          ? dataToExport.length === 0
          : !(dataToExport?.groups?.length > 0);

      if (isEmpty) {
        alert("No active report data found. Please generate the report first.");
        return;
      }

      const subtitle = `Report Period: ${appliedStartDate || "N/A"} to ${appliedEndDate || "N/A"} | ${appliedAccountingMethod} Basis`;
      const fileName = `${selectedTab.toLowerCase()}-${appliedReportType.toLowerCase()}`;

      if (appliedReportType === "Summary") {
        exportToExcel(
          selectedTab,
          subtitle,
          flattenSummaryData(dataToExport),
          fileName,
        );
      } else {
        exportToExcel(
          `${selectedTab} Detail`,
          subtitle,
          flattenDetailData(dataToExport),
          fileName,
        );
      }
    } catch (error) {
      console.error("Excel generation failed:", error);
      alert("Error: Could not generate complete report.");
    } finally {
      setIsDownloading(false);
    }
  };

  const currentReport = reportsData[selectedTab];
  const selectedTabLabel =
    REPORT_TABS.find((tab) => tab.key === selectedTab)?.label || selectedTab;

  return (
    <div className="page-container">
      <Header title="Reports" />

      <div className="page-content">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-[#050505] mb-4">
            Financial Reports
          </h1>
          <button
            onClick={handleSync}
            disabled={isSyncing}
            className="btn-secondary"
          >
            <RefreshCw size={16} className={isSyncing ? "animate-spin" : ""} />
            {isSyncing ? "Syncing..." : "Sync"}
          </button>
        </div>

        <div className="mb-6 flex gap-6 border-b border-border pb-px">
          {REPORT_TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => {
                setSelectedTab(tab.key);
                const existingReport = reportsData[tab.key];
                if (
                  (existingReport?.summary?.length ?? 0) > 0 ||
                  (existingReport?.detail?.groups?.length ?? 0) > 0
                ) {
                  setViewMode("preview");
                } else {
                  setViewMode("generator");
                }
              }}
              className={cn(
                "relative pb-3 text-[14px] font-medium transition-all",
                selectedTab === tab.key
                  ? "font-semibold text-text-primary after:absolute after:bottom-[-1px] after:left-0 after:h-[2px] after:w-full after:rounded-full after:bg-primary after:content-['']"
                  : "text-text-muted hover:text-text-secondary",
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="card-base card-p">
          <div className="mb-5 flex flex-col gap-1">
            <h2 className="text-[18px] font-semibold text-text-primary">
              {selectedTabLabel}
            </h2>
            <p className="text-[14px] text-text-muted">
              Generate reports about your company financial position,
              performance, and trends.
            </p>
          </div>

          <div className="mb-6 flex w-fit rounded-lg border border-border bg-bg-page p-1">
            <button
              onClick={() => setViewMode("generator")}
              className={cn(
                "rounded-md px-5 py-2 text-[14px] font-medium transition-all",
                viewMode === "generator"
                  ? "border border-border bg-bg-card text-text-primary shadow-sm"
                  : "text-text-muted hover:text-text-secondary",
              )}
            >
              Generate Report
            </button>
            <button
              onClick={() => setViewMode("preview")}
              className={cn(
                "rounded-md px-5 py-2 text-[14px] font-medium transition-all",
                viewMode === "preview"
                  ? "border border-border bg-bg-card text-text-primary shadow-sm"
                  : "text-text-muted hover:text-text-secondary",
              )}
            >
              Preview Report
            </button>
          </div>

          {viewMode === "generator" ? (
            <div className="mx-auto max-w-2xl space-y-6">
              <div className="grid grid-cols-1 gap-x-8 gap-y-5 md:grid-cols-2">
                <div className="space-y-5">
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[14px] font-medium text-text-primary">
                      Report Type
                    </label>
                    <div className="relative">
                      <select
                        value={reportType}
                        onChange={(event) => setReportType(event.target.value)}
                        className="h-10 w-full appearance-none rounded-md border border-border-input bg-bg-card pl-3 pr-10 text-[14px] text-text-primary transition-all focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                      >
                        <option value="Summary">Summary</option>
                        <option value="Detail">Detail</option>
                      </select>
                      <ChevronDown
                        size={16}
                        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-text-muted"
                      />
                    </div>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <label className="text-[14px] font-medium text-text-primary">
                      Date Range
                    </label>
                    <div className="flex flex-col gap-3">
                      <div className="relative">
                        <select
                          value={dateRange}
                          onChange={(event) => {
                            const value = event.target.value;
                            setDateRange(value);
                            if (value === "This Year") {
                              const currentYear = new Date().getFullYear();
                              setCustomRange({
                                start: `${currentYear}-01-01`,
                                end: todayString,
                              });
                            }
                          }}
                          className="h-10 w-full appearance-none rounded-md border border-border-input bg-bg-card pl-3 pr-10 text-[14px] text-text-primary transition-all focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                        >
                          <option>Today</option>
                          <option>This Month</option>
                          <option>This Quarter</option>
                          <option>Previous Quarter</option>
                          <option>This Year</option>
                          <option>Custom Range</option>
                        </select>
                        <ChevronDown
                          size={16}
                          className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-text-muted"
                        />
                      </div>

                      {dateRange === "Custom Range" ? (
                        <div className="translate-y-1 flex items-end gap-3">
                          <div className="flex flex-1 flex-col gap-1.5">
                            <span className="text-[12px] text-text-muted">
                              From
                            </span>
                            <input
                              type="date"
                              value={customRange.start}
                              onChange={(event) =>
                                setCustomRange((previous) => ({
                                  ...previous,
                                  start: event.target.value,
                                }))
                              }
                              className="h-10 rounded-md border border-border-input bg-bg-card px-3 text-[14px] text-text-primary focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                            />
                          </div>
                          <div className="flex flex-1 flex-col gap-1.5">
                            <span className="text-[12px] text-text-muted">
                              To
                            </span>
                            <input
                              type="date"
                              value={customRange.end}
                              onChange={(event) =>
                                setCustomRange((previous) => ({
                                  ...previous,
                                  end: event.target.value,
                                }))
                              }
                              className="h-10 rounded-md border border-border-input bg-bg-card px-3 text-[14px] text-text-primary focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                            />
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>

                <div className="space-y-5">
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[14px] font-medium text-text-primary">
                      Accounting Method
                    </label>
                    <div className="relative">
                      <select
                        value={accountingMethod}
                        onChange={(event) =>
                          setAccountingMethod(event.target.value)
                        }
                        className="h-10 w-full appearance-none rounded-md border border-border-input bg-bg-card pl-3 pr-10 text-[14px] text-text-primary transition-all focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                      >
                        <option>Cash</option>
                        <option>Accrual</option>
                      </select>
                      <ChevronDown
                        size={16}
                        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-text-muted"
                      />
                    </div>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <label className="text-[14px] font-medium text-text-primary">
                      Report Format
                    </label>
                    <div className="relative">
                      <select
                        value={reportFormat}
                        onChange={(event) =>
                          setReportFormat(event.target.value)
                        }
                        className="h-10 w-full appearance-none rounded-md border border-border-input bg-bg-card pl-3 pr-10 text-[14px] text-text-primary transition-all focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                      >
                        <option value="PDF">PDF</option>
                        <option value="Excel">Excel (CSV)</option>
                      </select>
                      <ChevronDown
                        size={16}
                        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-text-muted"
                      />
                    </div>
                  </div>
                </div>
              </div>

              <button
                onClick={handleGenerateReport}
                disabled={isLoading}
                className={cn(
                  "btn-primary mt-4 w-full",
                  isLoading && "cursor-wait opacity-80",
                )}
              >
                {isLoading ? (
                  <div className="flex items-center gap-2">
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                    <span>Generating...</span>
                  </div>
                ) : (
                  <>
                    <FileCheck size={16} />
                    Generate Report
                  </>
                )}
              </button>
            </div>
          ) : (
            <div className="animate-in slide-in-from-bottom-2 space-y-6 fade-in duration-300">
              {isLoading ? (
                <div className="card-base flex flex-1 flex-col items-center justify-center border border-border bg-bg-page py-12">
                  <div className="mb-4 h-12 w-12 animate-spin rounded-full border-4 border-border border-t-primary" />
                  <p className="animate-pulse text-[13px] font-medium text-text-muted">
                    Analyzing real-time financial data...
                  </p>
                </div>
              ) : (
                <>
                  <div id="report-content" className="bg-white">
                    {selectedTab === "Balance Sheet" ? (
                      <BalanceSheetReport
                        reportType={appliedReportType}
                        data={currentReport.summary}
                        detailedData={currentReport.detail}
                        startDate={appliedStartDate}
                        endDate={appliedEndDate}
                        accountingMethod={appliedAccountingMethod}
                        clientName={clientName}
                        entityName={company?.name || clientName}
                        createdOn={createdOn}
                        isPreview={true}
                      />
                    ) : selectedTab === "Profit & Loss" ? (
                      <ProfitAndLossReport
                        reportType={appliedReportType}
                        data={currentReport.summary}
                        detailedData={currentReport.detail}
                        startDate={appliedStartDate}
                        endDate={appliedEndDate}
                        accountingMethod={appliedAccountingMethod}
                        clientName={clientName}
                        entityName={company?.name || clientName}
                        createdOn={createdOn}
                        isPreview={true}
                      />
                    ) : (
                      <CashflowReport
                        reportType={appliedReportType}
                        data={currentReport.summary}
                        detailedData={currentReport.detail}
                        startDate={appliedStartDate}
                        endDate={appliedEndDate}
                        accountingMethod={appliedAccountingMethod}
                        clientName={clientName}
                        entityName={company?.name || clientName}
                        createdOn={createdOn}
                        isPreview={true}
                      />
                    )}
                  </div>

                  <div
                    id="report-export"
                    className="hidden"
                    aria-hidden="true"
                    style={{ display: "none" }}
                  >
                    {selectedTab === "Balance Sheet" ? (
                      <BalanceSheetReport
                        reportType={appliedReportType}
                        data={currentReport.summary}
                        detailedData={currentReport.detail}
                        startDate={appliedStartDate}
                        endDate={appliedEndDate}
                        accountingMethod={appliedAccountingMethod}
                        clientName={clientName}
                        entityName={company?.name || clientName}
                        createdOn={createdOn}
                        isPreview={false}
                      />
                    ) : selectedTab === "Profit & Loss" ? (
                      <ProfitAndLossReport
                        reportType={appliedReportType}
                        data={currentReport.summary}
                        detailedData={currentReport.detail}
                        startDate={appliedStartDate}
                        endDate={appliedEndDate}
                        accountingMethod={appliedAccountingMethod}
                        clientName={clientName}
                        entityName={company?.name || clientName}
                        createdOn={createdOn}
                        isPreview={false}
                      />
                    ) : (
                      <CashflowReport
                        reportType={appliedReportType}
                        data={currentReport.summary}
                        detailedData={currentReport.detail}
                        startDate={appliedStartDate}
                        endDate={appliedEndDate}
                        accountingMethod={appliedAccountingMethod}
                        clientName={clientName}
                        entityName={company?.name || clientName}
                        createdOn={createdOn}
                        isPreview={false}
                      />
                    )}
                  </div>
                </>
              )}

              <div className="mt-6 flex items-center justify-end gap-3">
                <button
                  onClick={() => setViewMode("generator")}
                  className="btn-secondary"
                >
                  Back to Generator
                </button>

                {reportFormat === "Excel" ? (
                  <button
                    onClick={generateExcel}
                    disabled={isDownloading}
                    className={cn(
                      "btn-primary min-w-[160px] shadow-md",
                      isDownloading && "cursor-wait opacity-80",
                    )}
                  >
                    {isDownloading ? (
                      <div className="flex items-center gap-2">
                        <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                        <span>Processing...</span>
                      </div>
                    ) : (
                      <>
                        <Download size={16} />
                        Download Excel
                      </>
                    )}
                  </button>
                ) : (
                  <button
                    onClick={handleDownloadPDF}
                    disabled={isDownloadingPDF}
                    className={cn(
                      "btn-primary min-w-[160px] shadow-md",
                      isDownloadingPDF && "cursor-wait opacity-80",
                    )}
                  >
                    {isDownloadingPDF ? (
                      <div className="flex items-center gap-2">
                        <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                        <span>Processing...</span>
                      </div>
                    ) : (
                      <>
                        <FileText size={16} />
                        Download PDF
                      </>
                    )}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
