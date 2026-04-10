import ReportDetailView from "../shared/ReportDetailView";
import ReportSummaryView from "../shared/ReportSummaryView";

export default function ProfitAndLossReport({
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
        title="Profit & Loss"
        subtitle={subtitle}
        sourceLabel="QuickBooks API Pipeline"
      />
    );
  }

  return (
    <ReportSummaryView
      data={Array.isArray(data) ? data : []}
      title="Profit & Loss"
      subtitle={subtitle}
      classificationLabel="Accounting Classification"
      footerText="This report provides a granular view of the company's financial performance."
    />
  );
}
