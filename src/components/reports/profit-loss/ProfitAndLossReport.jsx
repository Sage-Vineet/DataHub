import ProfitAndLossSummary from "./ProfitAndLossSummary";
import ProfitAndLossDetail from "./ProfitAndLossDetail";



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
    return (
      <ProfitAndLossDetail
        data={detailedData?.groups ? detailedData : { groups: [] }}
        title="Profit & Loss"
        subtitle={subtitle}
        entityName={resolvedEntityName}
        isPreview={isPreview}
      />
    );
  }

  return (
    <ProfitAndLossSummary
      data={Array.isArray(data) ? data : []}
      title="Profit & Loss"
      subtitle={subtitle}
      entityName={resolvedEntityName}
      createdOn={createdOn}
    />
  );
}
