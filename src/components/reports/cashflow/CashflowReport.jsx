import ReportDetailView from "../shared/ReportDetailView";
import ReportSummaryView from "../shared/ReportSummaryView";

export default function CashflowReport({
  reportType,
  data,
  detailedData,
  startDate,
  endDate,
  accountingMethod,
  clientName = "All Clients",
}) {
  const subtitle = `Report Period: ${startDate || "N/A"} to ${endDate || "N/A"} | ${clientName} | ${accountingMethod} Basis`;

  if (reportType === "Detail") {
    return (
      <ReportDetailView
        data={detailedData?.groups ? detailedData : { groups: [] }}
        title="Cash Flow"
        subtitle={subtitle}
        sourceLabel="QuickBooks Cash Flow Engine"
      />
    );
  }

  return (
    <ReportSummaryView
      data={Array.isArray(data) ? data : []}
      title="Cash Flow"
      subtitle={subtitle}
      classificationLabel="Cash Flow Classification"
      footerText="This report provides a structured view of operating, investing, and financing cash movement."
    />
  );
}
