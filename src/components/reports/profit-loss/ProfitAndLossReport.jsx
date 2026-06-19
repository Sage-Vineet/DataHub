import { memo } from "react";
import ProfitAndLossSummary from "./ProfitAndLossSummary";
import ProfitAndLossQBSummary from "./ProfitAndLossQBSummary";
import ManualProfitLossDetail from "../manual/ManualProfitLossDetail";
import ManualProfitLossMonthlyDetail from "../manual/ManualProfitLossMonthlyDetail";

function ProfitAndLossReport({
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

  const MANUAL_STAGED_SOURCES = [
    "manual_staged",
    "manual_gl_staged_transactions",
    "manual_gl_reporting_snapshot",
    "MANUAL_STAGED",
  ];

  const isManualStagedSummary = Boolean(
    data && typeof data === "object" && !Array.isArray(data) &&
    MANUAL_STAGED_SOURCES.includes(data.source)
  );

  const isManualStagedDetail = Boolean(
    detailedData && typeof detailedData === "object" && !Array.isArray(detailedData) &&
    MANUAL_STAGED_SOURCES.includes(detailedData.source)
  );

  const summarySubtitle = null;

  if (reportType === "Detail") {
    if (isManualStagedDetail) {
      if (detailedData.reportType === "profit_loss_monthly_detail") {
        return (
          <ManualProfitLossMonthlyDetail
            data={detailedData}
            entityName={resolvedEntityName}
            subtitle={summarySubtitle}
            selectedMonths={selectedMonths}
            isPreview={isPreview}
          />
        );
      }
      return (
        <ManualProfitLossDetail
          data={detailedData}
          title="Profit & Loss Detail"
          entityName={resolvedEntityName}
          subtitle={summarySubtitle}
          isPreview={isPreview}
        />
      );
    }

    // manual_upload / quickbooks_manual monthly view
    if (sourceMode === "manual_upload" || sourceMode === "quickbooks_manual") {
      return (
        <ProfitAndLossQBSummary
          data={Array.isArray(detailedData?.rows) ? detailedData.rows : []}
          columns={detailedData?.columns}
          title="Profit & Loss"
          subtitle={summarySubtitle}
          entityName={resolvedEntityName}
          isPreview={isPreview}
        />
      );
    }

    return (
      <ProfitAndLossSummary
        data={detailedData}
        title="Profit & Loss"
        subtitle={summarySubtitle}
        entityName={resolvedEntityName}
        isPreview={isPreview}
      />
    );
  }

  // Summary View
  if (isManualStagedSummary) {
    const hierarchicalRows = Array.isArray(data?.hierarchicalRows) ? data.hierarchicalRows : [];
    const yearCols = Array.isArray(data?.yearCols) ? data.yearCols : null;
    const summaryColumns = yearCols && yearCols.length > 1 ? { yearCols } : undefined;
    return (
      <ProfitAndLossQBSummary
        data={hierarchicalRows}
        columns={summaryColumns}
        title="Profit & Loss"
        subtitle={summarySubtitle}
        entityName={resolvedEntityName}
        isPreview={isPreview}
      />
    );
  }

  return (
    <ProfitAndLossQBSummary
      data={Array.isArray(data) ? data : []}
      title="Profit & Loss"
      subtitle={summarySubtitle}
      entityName={resolvedEntityName}
      isPreview={isPreview}
    />
  );
}

// Memoized: see BalanceSheetReport — avoids re-rendering the report tree on
// unrelated parent state changes (loading toggles, sibling-tab prefetch).
export default memo(ProfitAndLossReport);
