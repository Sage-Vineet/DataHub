import CashflowQBSummary from "./CashflowQBSummary";

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
    return (
      <CashflowDetail
        data={detailedData}
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
