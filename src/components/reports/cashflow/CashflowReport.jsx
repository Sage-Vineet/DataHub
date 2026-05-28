import CashflowQBSummary from "./CashflowQBSummary";
import CashflowSummary from "./CashflowSummary";
import ManualCashflowMonthlyDetail from "./ManualCashflowMonthlyDetail";

const MANUAL_STAGED_SOURCES = ["MANUAL_STAGED", "manual_staged", "manual_gl_staged_transactions", "manual_gl_reporting_snapshot"];

export default function CashflowReport({
  reportType,
  data,
  detailedData,
  startDate,
  endDate,
  accountingMethod,
  sourceMode,
  clientName = "All Clients",
  entityName,
  isPreview = false,
}) {
  const resolvedEntityName = entityName || clientName || "Company";
  const periodText = startDate === "1970-01-01" ? "All Dates" : `${startDate || "N/A"} to ${endDate || "N/A"}`;
  const summarySubtitle = sourceMode === "manual"
    ? undefined
    : `Report Period: ${periodText} | ${clientName} | ${accountingMethod} Basis`;

  if (reportType === "Detail") {
    // Manual staged monthly detail
    const isManualMonthlyDetail = MANUAL_STAGED_SOURCES.includes(detailedData?.source) &&
      detailedData?.reportType === "cash_flow_monthly_detail";

    if (isManualMonthlyDetail) {
      return (
        <ManualCashflowMonthlyDetail
          data={detailedData}
          title="Cash Flow Statement"
          entityName={resolvedEntityName}
        />
      );
    }

    // QB comparative detail
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

  // Summary mode
  // Manual staged summary — uses hierarchicalRows + yearCols
  const isManualStagedSummary = MANUAL_STAGED_SOURCES.includes(data?.source) && Array.isArray(data?.hierarchicalRows);
  if (isManualStagedSummary) {
    const yearCols = Array.isArray(data.yearCols) ? data.yearCols : [];
    const columns = yearCols.length > 0 ? { yearCols } : undefined;
    return (
      <CashflowSummary
        data={data.hierarchicalRows}
        columns={columns}
        title="Cash Flow Statement"
        subtitle={summarySubtitle}
        entityName={resolvedEntityName}
      />
    );
  }

  return (
    <CashflowQBSummary
      data={Array.isArray(data) ? data : []}
      title="Cash Flow"
      subtitle={summarySubtitle}
      entityName={resolvedEntityName}
    />
  );
}
