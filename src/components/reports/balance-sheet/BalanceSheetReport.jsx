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
  const resolvedEntityName = entityName || clientName || "Company";
  const periodText = startDate === "1970-01-01" ? "All Dates" : `${startDate || "N/A"} to ${endDate || "N/A"}`;

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
        subtitle={`${clientName} | ${accountingMethod} Basis`}
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
      subtitle={`Report Period: ${periodText} | ${clientName} | ${accountingMethod} Basis`}
      entityName={resolvedEntityName}
    />
  );
}
