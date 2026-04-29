import CashflowQBSummary from "./CashflowQBSummary";
import CashflowSummary from "./CashflowSummary";

export default function CashflowReport({
  reportType,
  data,
  detailedData,
  startDate,
  endDate,
  accountingMethod,
  clientName = "All Clients",
  entityName,
  isPreview = false,
}) {
  const resolvedEntityName = entityName || clientName || "Company";
  const periodText = startDate === "1970-01-01" ? "All Dates" : `${startDate || "N/A"} to ${endDate || "N/A"}`;

  if (reportType === "Detail") {
    const rows = Array.isArray(detailedData?.rows) ? detailedData.rows : (Array.isArray(detailedData) ? detailedData : []);
    const columns = detailedData?.columns || undefined;

    return (
      <CashflowSummary
        data={rows}
        columns={columns}
        title="Cash Flow"
        subtitle={`${clientName} | ${accountingMethod} Basis`}
        entityName={resolvedEntityName}
      />
    );
  }

  return (
    <CashflowQBSummary
      data={Array.isArray(data) ? data : []}
      title="Cash Flow"
      subtitle={`Report Period: ${periodText} | ${clientName} | ${accountingMethod} Basis`}
      entityName={resolvedEntityName}
    />
  );
}
