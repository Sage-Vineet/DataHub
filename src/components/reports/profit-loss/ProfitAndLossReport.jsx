import ProfitAndLossSummary from "./ProfitAndLossSummary";
import ProfitAndLossQBSummary from "./ProfitAndLossQBSummary";

export default function ProfitAndLossReport({
  reportType,
  data,
  detailedData,
  startDate,
  endDate,
  accountingMethod,
  clientName = "All Clients",
  entityName,
  createdOn,
  isPreview = false,
}) {
  const subtitle = `Report Period: ${startDate || "N/A"} to ${endDate || "N/A"} | ${clientName} | ${accountingMethod} Basis`;
  const resolvedEntityName = entityName || clientName || "Company";

  if (reportType === "Detail") {
    // Detail View: Multi-year EBITDA/SDE analysis
    return (
      <ProfitAndLossSummary
        data={detailedData}
        title="Profit & Loss"
        subtitle={subtitle}
        entityName={resolvedEntityName}
        createdOn={createdOn}
      />
    );
  }

  // Summary View: QuickBooks-style Summary report
  return (
    <ProfitAndLossQBSummary
      data={data || []}
      title="Profit & Loss"
      subtitle={subtitle}
      entityName={resolvedEntityName}
    />
  );
}
