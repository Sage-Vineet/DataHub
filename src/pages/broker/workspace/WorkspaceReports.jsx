import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import Header from "../../../components/Header";
import {
  ChevronDown,
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
import QBDisconnectedBanner from "../../../components/common/QBDisconnectedBanner";
import { refreshQuickbooksToken } from "../../../services/authService";
import {
  normalizeAccountingMethod,
  sanitizeDateRange,
} from "../../../lib/report-filters";
import {
  getDateRange,
} from "../../../lib/report-date-resolver";
import {
  exportToExcel,
  exportToPDF,
  flattenSummaryData,
  flattenMultiYearData,
} from "../../../lib/export-utils";

function formatDateForInput(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const DATE_RANGE_OPTIONS = [
  "All Dates",
  "Custom dates",
  "Today",
  "This week",
  "This week to date",
  "This fiscal week",
  "This month",
  "This month to date",
  "This quarter",
  "This quarter to date",
  "This fiscal quarter",
  "This fiscal quarter to date",
  "This year",
  "This year to date",
  "This year to last month",
  "This fiscal year",
  "This fiscal year to date",
  "This fiscal year to last month",
  "Last 6 months",
  "Yesterday",
  "Recent",
  "Last week",
  "Last week to date",
  "Last week to today",
  "Last month",
  "Last month to date",
  "Last month to today",
  "Last quarter",
  "Last quarter to date",
  "Last quarter to today",
  "Last fiscal quarter",
  "Last fiscal quarter to date",
  "Last year",
  "Last year to date",
  "Last year to today",
  "Last fiscal year",
  "Last fiscal year to date",
  "Last 7 days",
  "Last 30 days",
  "Last 90 days",
  "Last 12 months",
  "Since 30 days ago",
];

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

    const now = new Date();
    const todayStr = formatDateForInput(now);

    const getStartOfWeek = (d) => {
      const day = d.getDay();
      const diff = d.getDate() - day;
      return new Date(d.setDate(diff));
    };

    const getStartOfQuarter = (d) => {
      const q = Math.floor(d.getMonth() / 3);
      return new Date(d.getFullYear(), q * 3, 1);
    };

    const getEndOfQuarter = (d) => {
      const q = Math.floor(d.getMonth() / 3);
      return new Date(d.getFullYear(), (q + 1) * 3, 0);
    };

    switch (dateRange) {
      case "All Dates":
        startDate = "1970-01-01";
        endDate = todayStr;
        break;
      case "Custom dates":
        startDate = customRange.start;
        endDate = customRange.end;
        break;
      case "Today":
        startDate = todayStr;
        endDate = todayStr;
        break;
      case "Yesterday": {
        const yesterday = new Date(now);
        yesterday.setDate(now.getDate() - 1);
        startDate = formatDateForInput(yesterday);
        endDate = formatDateForInput(yesterday);
        break;
      }
      case "This week": {
        const weekStart = getStartOfWeek(new Date(now));
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekStart.getDate() + 6);
        startDate = formatDateForInput(weekStart);
        endDate = formatDateForInput(weekEnd);
        break;
      }
      case "This week to date":
      case "This fiscal week":
        startDate = formatDateForInput(getStartOfWeek(new Date(now)));
        endDate = todayStr;
        break;
      case "This month": {
        startDate = `${todayStr.slice(0, 7)}-01`;
        const lastDayOfMonth = new Date(
          now.getFullYear(),
          now.getMonth() + 1,
          0,
        );
        endDate = formatDateForInput(lastDayOfMonth);
        break;
      }
      case "This month to date":
        startDate = `${todayStr.slice(0, 7)}-01`;
        endDate = todayStr;
        break;
      case "This quarter":
        startDate = formatDateForInput(getStartOfQuarter(new Date(now)));
        endDate = formatDateForInput(getEndOfQuarter(new Date(now)));
        break;
      case "This quarter to date":
      case "This fiscal quarter":
      case "This fiscal quarter to date":
        startDate = formatDateForInput(getStartOfQuarter(new Date(now)));
        endDate = todayStr;
        break;
      case "This year":
        startDate = `${now.getFullYear()}-01-01`;
        endDate = `${now.getFullYear()}-12-31`;
        break;
      case "This year to date":
      case "This fiscal year":
      case "This fiscal year to date":
        startDate = `${now.getFullYear()}-01-01`;
        endDate = todayStr;
        break;
      case "This year to last month":
      case "This fiscal year to last month": {
        startDate = `${now.getFullYear()}-01-01`;
        const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
        endDate = formatDateForInput(lastMonthEnd);
        break;
      }
      case "Last week": {
        const lastWeekStart = getStartOfWeek(new Date(now));
        lastWeekStart.setDate(lastWeekStart.getDate() - 7);
        const lastWeekEnd = new Date(lastWeekStart);
        lastWeekEnd.setDate(lastWeekStart.getDate() + 6);
        startDate = formatDateForInput(lastWeekStart);
        endDate = formatDateForInput(lastWeekEnd);
        break;
      }
      case "Last week to date":
      case "Last week to today": {
        const lwStart = getStartOfWeek(new Date(now));
        lwStart.setDate(lwStart.getDate() - 7);
        startDate = formatDateForInput(lwStart);
        endDate = todayStr;
        break;
      }
      case "Last month": {
        const lmStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const lmEnd = new Date(now.getFullYear(), now.getMonth(), 0);
        startDate = formatDateForInput(lmStart);
        endDate = formatDateForInput(lmEnd);
        break;
      }
      case "Last month to date":
      case "Last month to today": {
        const lmStart2 = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        startDate = formatDateForInput(lmStart2);
        endDate = todayStr;
        break;
      }
      case "Last quarter": {
        const lqEnd = new Date(
          now.getFullYear(),
          Math.floor(now.getMonth() / 3) * 3,
          0,
        );
        const lqStart = getStartOfQuarter(lqEnd);
        startDate = formatDateForInput(lqStart);
        endDate = formatDateForInput(lqEnd);
        break;
      }
      case "Last quarter to date":
      case "Last quarter to today":
      case "Last fiscal quarter":
      case "Last fiscal quarter to date": {
        const lqStart2 = getStartOfQuarter(
          new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3 - 1, 1),
        );
        startDate = formatDateForInput(lqStart2);
        endDate = todayStr;
        break;
      }
      case "Last year":
        startDate = `${now.getFullYear() - 1}-01-01`;
        endDate = `${now.getFullYear() - 1}-12-31`;
        break;
      case "Last year to date":
      case "Last year to today":
      case "Last fiscal year":
      case "Last fiscal year to date":
        startDate = `${now.getFullYear() - 1}-01-01`;
        endDate = todayStr;
        break;
      case "Last 6 months": {
        const last6Start = new Date(
          now.getFullYear(),
          now.getMonth() - 6,
          now.getDate(),
        );
        startDate = formatDateForInput(last6Start);
        endDate = todayStr;
        break;
      }
      case "Last 7 days": {
        const last7Start = new Date(now);
        last7Start.setDate(now.getDate() - 7);
        startDate = formatDateForInput(last7Start);
        endDate = todayStr;
        break;
      }
      case "Last 30 days":
      case "Since 30 days ago": {
        const last30Start = new Date(now);
        last30Start.setDate(now.getDate() - 30);
        startDate = formatDateForInput(last30Start);
        endDate = todayStr;
        break;
      }
      case "Last 90 days": {
        const last90Start = new Date(now);
        last90Start.setDate(now.getDate() - 90);
        startDate = formatDateForInput(last90Start);
        endDate = todayStr;
        break;
      }
      case "Last 12 months": {
        const last12Start = new Date(
          now.getFullYear() - 1,
          now.getMonth(),
          now.getDate(),
        );
        startDate = formatDateForInput(last12Start);
        endDate = todayStr;
        break;
      }
      case "Recent": {
        const recentStart = new Date(now);
        recentStart.setDate(now.getDate() - 4);
        startDate = formatDateForInput(recentStart);
        endDate = todayStr;
        break;
      }
      default:
        startDate = `${now.getFullYear()}-01-01`;
        endDate = todayStr;
    }

    return { startDate, endDate };
  };

  const handleGenerateReport = async () => {
    setIsLoading(true);

    try {
      const rawDates = getDates();
      const { startDate: userStart, endDate: userEnd } = sanitizeDateRange(
        rawDates.startDate,
        rawDates.endDate,
      );
      const normalizedAccountingMethod =
        normalizeAccountingMethod(accountingMethod);

      const dateConfig = getDateRange({
        reportType: selectedTab,
        viewType: reportType,
        filters: { startDate: userStart, endDate: userEnd },
      });


      setAppliedStartDate(dateConfig.startDate || "");
      setAppliedEndDate(dateConfig.endDate || "");
      setAppliedReportType(reportType);
      setAppliedAccountingMethod(accountingMethod);

      const { startDate: resolvedStart, endDate: resolvedEnd } = dateConfig;

      let summary = [];
      let detail = { groups: [] };

      if (selectedTab === "Balance Sheet") {
        if (reportType === "Summary") {
          summary = await getBalanceSheet(
            resolvedStart,
            resolvedEnd,
            normalizedAccountingMethod,
          ).catch(() => ({ rows: [], columns: {} }));
        } else {
          detail = await getBalanceSheetDetail(
            resolvedStart,
            resolvedEnd,
            normalizedAccountingMethod,
          ).catch(() => ({ groups: [] }));
        }
      } else if (selectedTab === "Profit & Loss") {
        if (reportType === "Summary") {
          summary = await getProfitAndLoss(
            resolvedStart,
            resolvedEnd,
            normalizedAccountingMethod,
          ).catch(() => []);
        } else {
          detail = await getProfitAndLossDetail(
            resolvedStart,
            resolvedEnd,
            normalizedAccountingMethod,
          ).catch(() => []);
        }
      } else {
        if (reportType === "Summary") {
          summary = await getCashflow(
            resolvedStart,
            resolvedEnd,
            normalizedAccountingMethod,
          ).catch(() => []);
        } else {
          detail = await getCashflowDetail(
            resolvedStart,
            resolvedEnd,
            normalizedAccountingMethod,
          ).catch(() => ({ rows: [], columns: {} }));
        }
      }

      setReportsData((previous) => ({
        ...previous,
        [selectedTab]: {
          ...previous[selectedTab],
          ...(reportType === "Summary" ? { summary } : { detail }),
        },
      }));

      console.log(
        `✅ [Reports] ${selectedTab} / ${reportType} generated successfully`,
      );
    } catch (error) {
      console.error("[WorkspaceReports] Generation failed:", error);
    } finally {
      setIsLoading(false);
    }
  };

  // Auto-generate report when dependencies change
  useEffect(() => {
    if (clientId) {
      handleGenerateReport();
    }
  }, [
    clientId,
    selectedTab,
    reportType,
    dateRange,
    accountingMethod,
    customRange.start,
    customRange.end,
  ]);

  const handleDownloadPDF = async () => {
    setIsDownloadingPDF(true);
    try {
      const fileName = `${selectedTab.toLowerCase()}-${appliedReportType.toLowerCase()}-report`;
      // Use 'report-content' which is the ID of the container we want to capture
      await exportToPDF("report-content", fileName);
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
      const summaryData = currentReport.summary?.rows || currentReport.summary || [];
      const detailData = currentReport.detail || { rows: [], columns: {} };
      
      const dataToExport = appliedReportType === "Summary" ? summaryData : detailData;

      const isEmpty =
        appliedReportType === "Summary"
          ? !summaryData || summaryData.length === 0
          : !detailData.rows || detailData.rows.length === 0;

      if (isEmpty) {
        alert("No active report data found to export.");
        return;
      }

      const subtitle = `Report Period: ${appliedStartDate || "N/A"} to ${appliedEndDate || "N/A"} | ${appliedAccountingMethod} Basis`;
      const fileName = `${selectedTab.toLowerCase()}-${appliedReportType.toLowerCase()}-export`;

      if (appliedReportType === "Summary") {
        exportToExcel(
          selectedTab,
          subtitle,
          flattenSummaryData(summaryData),
          fileName,
        );
      } else {
        exportToExcel(
          `${selectedTab} Detail`,
          subtitle,
          flattenMultiYearData(detailData.rows, detailData.columns),
          fileName,
        );
      }
    } catch (error) {
      console.error("Excel generation failed:", error);
      alert("Error: Could not generate Excel report.");
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

        <QBDisconnectedBanner pageName="Reports" />

        <div className="mb-6 flex gap-6 border-b border-border pb-px">
          {REPORT_TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setSelectedTab(tab.key)}
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

        <div className="card-base card-p min-h-[800px] flex flex-col">
          {/* QuickBooks-style Top Control Bar */}
          <div className="mb-8 flex flex-wrap items-center gap-6 border-b border-border-light pb-6">
            <div className="flex flex-col gap-1.5">
              <label className="text-[12px] font-medium uppercase tracking-wider text-text-muted">
                Report View
              </label>
              <div className="flex rounded-lg border border-border bg-bg-page p-1">
                <button
                  onClick={() => setReportType("Summary")}
                  className={cn(
                    "rounded-md px-4 py-1.5 text-[13px] font-medium transition-all",
                    reportType === "Summary"
                      ? "bg-bg-card text-text-primary shadow-sm ring-1 ring-border/50"
                      : "text-text-muted hover:text-text-secondary",
                  )}
                >
                  Summary
                </button>
                <button
                  onClick={() => setReportType("Detail")}
                  className={cn(
                    "rounded-md px-4 py-1.5 text-[13px] font-medium transition-all",
                    reportType === "Detail"
                      ? "bg-bg-card text-text-primary shadow-sm ring-1 ring-border/50"
                      : "text-text-muted hover:text-text-secondary",
                  )}
                >
                  Detailed
                </button>
              </div>
            </div>

            {reportType === "Summary" && (
              <>
                <div className="flex flex-col gap-1.5">
                  <label className="text-[12px] font-medium uppercase tracking-wider text-text-muted">
                    Date Range
                  </label>
                  <div className="relative min-w-[160px]">
                    <select
                      value={dateRange}
                      onChange={(event) => setDateRange(event.target.value)}
                      className="h-9 w-full appearance-none rounded-md border border-border-input bg-bg-card pl-3 pr-9 text-[13px] text-text-primary transition-all focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                    >
                      {DATE_RANGE_OPTIONS.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                    <ChevronDown
                      size={14}
                      className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted"
                    />
                  </div>
                </div>

                {dateRange === "Custom dates" && (
                  <div className="flex items-center gap-3">
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[12px] font-medium uppercase tracking-wider text-text-muted">
                        From
                      </label>
                      <input
                        type="date"
                        max={todayString}
                        value={customRange.start}
                        onChange={(event) =>
                          setCustomRange((p) => ({ ...p, start: event.target.value }))
                        }
                        className="h-9 rounded-md border border-border-input bg-bg-card px-3 text-[13px] text-text-primary focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[12px] font-medium uppercase tracking-wider text-text-muted">
                        To
                      </label>
                      <input
                        type="date"
                        max={todayString}
                        value={customRange.end}
                        onChange={(event) =>
                          setCustomRange((p) => ({ ...p, end: event.target.value }))
                        }
                        className="h-9 rounded-md border border-border-input bg-bg-card px-3 text-[13px] text-text-primary focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                    </div>
                  </div>
                )}
              </>
            )}

            <div className="flex flex-col gap-1.5">
              <label className="text-[12px] font-medium uppercase tracking-wider text-text-muted">
                Accounting Method
              </label>
              <div className="relative min-w-[120px]">
                <select
                  value={accountingMethod}
                  onChange={(event) => setAccountingMethod(event.target.value)}
                  className="h-9 w-full appearance-none rounded-md border border-border-input bg-bg-card pl-3 pr-9 text-[13px] text-text-primary transition-all focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  <option>Cash</option>
                  <option>Accrual</option>
                </select>
                <ChevronDown
                  size={14}
                  className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted"
                />
              </div>
            </div>

            <div className="ml-auto flex items-end gap-3 self-end">
              <div className="flex flex-col gap-1.5">
                <label className="text-[12px] font-medium uppercase tracking-wider text-text-muted">
                  Format
                </label>
                <div className="relative min-w-[100px]">
                  <select
                    value={reportFormat}
                    onChange={(event) => setReportFormat(event.target.value)}
                    className="h-9 w-full appearance-none rounded-md border border-border-input bg-bg-card pl-3 pr-9 text-[13px] text-text-primary transition-all focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                  >
                    <option value="PDF">PDF</option>
                    <option value="Excel">Excel</option>
                  </select>
                  <ChevronDown
                    size={14}
                    className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted"
                  />
                </div>
              </div>

              {reportFormat === "Excel" ? (
                <button
                  onClick={generateExcel}
                  disabled={isDownloading || isLoading}
                  className="btn-primary h-9 px-4 shadow-sm"
                >
                  {isDownloading ? (
                    <RefreshCw size={16} className="animate-spin" />
                  ) : (
                    <Download size={16} />
                  )}
                  <span>Export</span>
                </button>
              ) : (
                <button
                  onClick={handleDownloadPDF}
                  disabled={isDownloadingPDF || isLoading}
                  className="btn-primary h-9 px-4 shadow-sm"
                >
                  {isDownloadingPDF ? (
                    <RefreshCw size={16} className="animate-spin" />
                  ) : (
                    <FileText size={16} />
                  )}
                  <span>Export</span>
                </button>
              )}
            </div>
          </div>

          <div className="flex-1 animate-in fade-in slide-in-from-bottom-2 duration-500">
            {isLoading ? (
              <div className="flex flex-1 flex-col items-center justify-center py-20">
                <div className="mb-6 h-12 w-12 animate-spin rounded-full border-4 border-border border-t-primary" />
                <p className="animate-pulse text-[14px] font-medium text-text-muted">
                  Fetching latest financial records from QuickBooks...
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
          </div>
        </div>
      </div>
    </div>
  );
}
