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
  isPreview = false,
}) {
  const resolvedEntityName = entityName || clientName || "Company";
  const periodText = startDate === "1970-01-01" ? "All Dates" : `${startDate || "N/A"} to ${endDate || "N/A"}`;
  const isManualStagedSummary = Boolean(data && typeof data === "object" && data.source === "manual_staged");
  const isManualStagedDetail = Boolean(detailedData && typeof detailedData === "object" && detailedData.source === "manual_staged");
  const isManualMonthlyDetail = isManualStagedDetail && detailedData?.reportType === "profit_loss_monthly_detail";
  const summarySubtitle = sourceMode === "manual"
    ? undefined
    : `Report Period: ${periodText} | ${clientName} | ${accountingMethod} Basis`;

  if (reportType === "Detail") {
    if (isManualMonthlyDetail) {
      return (
        <ManualProfitLossMonthlyDetail
          data={detailedData}
          title="Profit and Loss"
          entityName={resolvedEntityName}
        />
      );
    }

    if (isManualStagedDetail) {
      return (
        <ManualProfitLossDetail
          data={detailedData}
          title="Profit & Loss Detail"
          subtitle={undefined}
          entityName={resolvedEntityName}
        />
      );
    }

    // Detail View: Multi-year EBITDA/SDE analysis
    return (
      <ProfitAndLossSummary
        data={detailedData}
        title="Profit & Loss"
        subtitle={`${clientName} | ${accountingMethod} Basis`}
        entityName={resolvedEntityName}
        createdOn={createdOn}
      />
    );
  }

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

  // Summary View: QuickBooks-style Summary report
  return (
    <ProfitAndLossQBSummary
      data={data || []}
      title="Profit & Loss"
      subtitle={summarySubtitle}
      entityName={resolvedEntityName}
    />
  );
}
