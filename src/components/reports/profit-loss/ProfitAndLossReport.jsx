import ProfitAndLossSummary from "./ProfitAndLossSummary";
import ProfitAndLossQBSummary from "./ProfitAndLossQBSummary";
import ManualProfitLossDetail from "../manual/ManualProfitLossDetail";
import ManualProfitLossMonthlyDetail from "../manual/ManualProfitLossMonthlyDetail";

export default function ProfitAndLossReport({
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

  const summarySubtitle = sourceMode === "manual"
    ? undefined
    : `Report Period: ${periodText} | ${clientName} | ${accountingMethod} Basis`;

  if (reportType === "Detail") {
    if (isManualStagedDetail) {
      if (detailedData.reportType === "profit_loss_monthly_detail") {
        return (
          <ManualProfitLossMonthlyDetail
            data={detailedData}
            entityName={resolvedEntityName}
          />
        );
      }
      if (detailedData.reportType === "profit_loss_monthly_detail") {
        return (
          <ManualProfitLossMonthlyDetail
            data={detailedData}
            entityName={resolvedEntityName}
          />
        );
      }
      return (
        <ManualProfitLossDetail
          data={detailedData}
          title="Profit & Loss Detail"
          entityName={resolvedEntityName}
        />
      );
    }

    return (
      <ProfitAndLossSummary
        data={detailedData}
        title="Profit & Loss"
        subtitle={summarySubtitle}
        entityName={resolvedEntityName}
      />
    );
  }

  // Summary View
  if (isManualStagedSummary) {
    const hierarchicalRows = Array.isArray(data?.hierarchicalRows) ? data.hierarchicalRows : [];
    return (
      <ProfitAndLossQBSummary
        data={hierarchicalRows}
        title="Profit & Loss"
        entityName={resolvedEntityName}
      />
    );
  }

  return (
    <ProfitAndLossQBSummary
      data={Array.isArray(data) ? data : []}
      title="Profit & Loss"
      subtitle={summarySubtitle}
      entityName={resolvedEntityName}
    />
  );
}
