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
  const subtitle = `Report Period: ${startDate || "N/A"} to ${endDate || "N/A"} | ${clientName} | ${accountingMethod} Basis`;
  const resolvedEntityName = entityName || clientName || "Company";

  if (reportType === "Detail") {
    const rows = Array.isArray(detailedData?.rows) ? detailedData.rows : (Array.isArray(detailedData) ? detailedData : []);
    const columns = detailedData?.columns || undefined;

    return (
      <CashflowSummary
        data={rows}
        columns={columns}
        title="Cash Flow"
        subtitle="System-defined Multi-Year Comparison"
        entityName={resolvedEntityName}
      />
    );
  }

  return (
    <CashflowQBSummary
      data={Array.isArray(data) ? data : []}
      title="Cash Flow"
      subtitle={subtitle}
      entityName={resolvedEntityName}
    />
  );
}
