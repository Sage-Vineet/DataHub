import { memo } from "react";
import BalanceSheetSummary from "./BalanceSheetSummary";
import BalanceSheetQBSummary from "./BalanceSheetQBSummary";
import ManualBalanceSheetMonthlyDetail from "../manual/ManualBalanceSheetMonthlyDetail";

function BalanceSheetReport({
  reportType,
  data,
  detailedData,
  startDate,
  endDate,
  accountingMethod,
  sourceMode,
  clientName = "All Clients",
  entityName,
  createdOn,
  isPreview = false,
  selectedMonths = [],
}) {
  const resolvedEntityName = entityName || clientName || "Company";
  const periodText = startDate === "1970-01-01" ? "All Dates" : `${startDate || "N/A"} to ${endDate || "N/A"}`;
  const summaryRows = Array.isArray(data) ? data : (Array.isArray(data?.rows) ? data.rows : []);
  const source = data?.source || null;
  const sourceLabel = data?.sourceLabel || null;
  const noDataText = data?.noDataText || null;
  // Per-year comparative columns: only render multiple columns when the user
  // selected more than one fiscal year. Absent/single yearCols → single-column
  // (preserves the original look and keeps old snapshots rendering correctly).
  const yearCols = Array.isArray(data?.yearCols) ? data.yearCols : null;
  const summaryColumns = yearCols && yearCols.length > 1 ? { yearCols } : undefined;
  // Backend returns source="manual_gl_staged_transactions" (not "manual_staged").
  // Accept all known manual-staged source strings to be forward-compatible.
  const MANUAL_STAGED_SOURCES = ["manual_staged", "manual_gl_staged_transactions", "manual_gl_reporting_snapshot", "MANUAL_STAGED"];
  const isManualMonthlyDetail = Boolean(
    MANUAL_STAGED_SOURCES.includes(detailedData?.source) && detailedData?.reportType === "balance_sheet_monthly_detail"
  );
  const summarySubtitle = `Report Period: ${periodText} | ${clientName} | ${accountingMethod} Basis`;

  if (reportType === "Detail") {
    if (isManualMonthlyDetail) {
      return (
        <ManualBalanceSheetMonthlyDetail
          data={detailedData}
          title="Balance Sheet"
          subtitle={summarySubtitle}
          entityName={resolvedEntityName}
          selectedMonths={selectedMonths}
        />
      );
    }

    // Detail View: Multi-year EBITDA/SDE analysis
    const rows = Array.isArray(detailedData?.rows) ? detailedData.rows : (Array.isArray(detailedData) ? detailedData : []);
    const columns = detailedData?.columns || undefined;

    return (
      <BalanceSheetSummary
        data={rows}
        columns={columns}
        endDate={endDate}
        title="Balance Sheet"
        subtitle={`${clientName} | ${accountingMethod} Basis`}
        entityName={resolvedEntityName}
        createdOn={createdOn}
      />
    );
  }

  // Summary View: QuickBooks-style Summary report
  return (
    <BalanceSheetQBSummary
      data={summaryRows}
      columns={summaryColumns}
      title="Balance Sheet"
      subtitle={summarySubtitle}
      entityName={resolvedEntityName}
      source={source}
      sourceLabel={sourceLabel}
      noDataText={noDataText}
    />
  );
}

// Memoized: the report tree is expensive to render and its props are stable
// between unrelated parent state changes (loading toggles, sibling-tab prefetch,
// filter-dropdown interaction), so re-rendering it then is wasted work.
export default memo(BalanceSheetReport);
