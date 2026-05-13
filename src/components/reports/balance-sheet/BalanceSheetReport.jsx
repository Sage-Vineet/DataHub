import BalanceSheetSummary from "./BalanceSheetSummary";
import BalanceSheetQBSummary from "./BalanceSheetQBSummary";
import ManualBalanceSheetMonthlyDetail from "../manual/ManualBalanceSheetMonthlyDetail";

export default function BalanceSheetReport({
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
  const summaryRows = Array.isArray(data) ? data : (Array.isArray(data?.rows) ? data.rows : []);
  const source = data?.source || null;
  const sourceLabel = data?.sourceLabel || null;
  const noDataText = data?.noDataText || null;
  const isManualMonthlyDetail = Boolean(
    detailedData?.source === "manual_staged" && detailedData?.reportType === "balance_sheet_monthly_detail"
  );
  const summarySubtitle = sourceMode === "manual"
    ? undefined
    : `Report Period: ${periodText} | ${clientName} | ${accountingMethod} Basis`;

  if (reportType === "Detail") {
    if (isManualMonthlyDetail) {
      return (
        <ManualBalanceSheetMonthlyDetail
          data={detailedData}
          title="Balance Sheet"
          entityName={resolvedEntityName}
        />
      );
    }

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
      data={summaryRows}
      title="Balance Sheet"
      subtitle={summarySubtitle}
      entityName={resolvedEntityName}
      source={source}
      sourceLabel={sourceLabel}
      noDataText={noDataText}
    />
  );
}
