import BalanceSheetSummary from "./BalanceSheetSummary";
import BalanceSheetQBSummary from "./BalanceSheetQBSummary";

export default function BalanceSheetReport({
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
    const rows = Array.isArray(detailedData?.rows) ? detailedData.rows : (Array.isArray(detailedData) ? detailedData : []);
    const columns = detailedData?.columns || undefined;

    return (
      <BalanceSheetSummary
        data={rows}
        columns={columns}
        endDate={endDate}
        title="Balance Sheet"
        subtitle={subtitle}
        entityName={resolvedEntityName}
        createdOn={createdOn}
      />
    );
  }

  // Summary View: QuickBooks-style Summary report
  return (
    <BalanceSheetQBSummary
      data={data || []}
      title="Balance Sheet"
      subtitle={subtitle}
      entityName={resolvedEntityName}
    />
  );
}
