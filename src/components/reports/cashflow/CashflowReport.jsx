import CashflowSummary from "./CashflowSummary";
import CashflowDetail from "./CashflowDetail";



export default function CashflowReport({
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
      <CashflowDetail
        data={detailedData?.groups ? detailedData : { groups: [] }}
        title="Cash Flow"
        subtitle={subtitle}
        entityName={resolvedEntityName}
        isPreview={isPreview}
      />
    );
  }

  return (
    <CashflowSummary
      data={Array.isArray(data) ? data : []}
      title="Cash Flow"
      subtitle={subtitle}
      entityName={resolvedEntityName}
      createdOn={createdOn}
    />
  );
}
