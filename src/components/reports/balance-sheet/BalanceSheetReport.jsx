import BalanceSheetSummary from "./BalanceSheetSummary";
import BalanceSheetDetail from "./BalanceSheetDetail";

function deriveReportPeriodFromPayload(rawPayload) {
  if (!rawPayload) return { start: "", end: "" };

  const candidates = [
    rawPayload?.generalLedger,
    rawPayload?.GeneralLedger,
    rawPayload?.balanceSheet,
    rawPayload?.BalanceSheet,
    rawPayload,
  ];

  for (const report of candidates) {
    const start = report?.Header?.StartPeriod;
    const end = report?.Header?.EndPeriod;
    if (start || end) return { start: String(start || ""), end: String(end || "") };
  }

  return { start: "", end: "" };
}

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
  const derivedPeriod =
    reportType === "Detail"
      ? deriveReportPeriodFromPayload(detailedData?.rawPayload)
      : { start: "", end: "" };

  const subtitleStart = startDate || derivedPeriod.start || "N/A";
  const subtitleEnd = endDate || derivedPeriod.end || "N/A";

  const subtitle = `Report Period: ${subtitleStart} to ${subtitleEnd} | ${clientName} | ${accountingMethod} Basis`;
  const resolvedEntityName = entityName || clientName || "Company";

  if (reportType === "Detail") {
    return (
      <BalanceSheetDetail
        data={detailedData?.groups ? detailedData : { groups: [] }}
        title="Balance Sheet"
        subtitle={subtitle}
        entityName={resolvedEntityName}
        isPreview={isPreview}
      />
    );
  }

  return (
    <BalanceSheetSummary
      data={Array.isArray(data) ? data : []}
      title="Balance Sheet"
      subtitle={subtitle}
      entityName={resolvedEntityName}
      createdOn={createdOn}
    />
  );
}
