"use client";

import { FinancialLine } from "@/types/balance-sheet";
import { DetailedFinancialData } from "@/types/financial-details";
import ProfitAndLossSummary from "./ProfitAndLossSummary";
import ProfitAndLossDetail from "./ProfitAndLossDetail";

interface ProfitAndLossReportProps {
  reportType: "Summary" | "Detail";
  data: FinancialLine[];
  detailedData: DetailedFinancialData;
  startDate?: string;
  endDate?: string;
  accountingMethod: string;
  clientName?: string;
}

export default function ProfitAndLossReport({
  reportType,
  data,
  detailedData,
  startDate,
  endDate,
  accountingMethod,
  clientName = "All Clients",
}: ProfitAndLossReportProps) {
  const subtitle = `Report Period: ${startDate || "N/A"} to ${endDate || "N/A"} | ${clientName} | ${accountingMethod} Basis`;

  if (reportType === "Detail") {
    return (
      <ProfitAndLossDetail
        data={detailedData?.groups ? detailedData : { groups: [] }}
        title="Profit & Loss"
        subtitle={subtitle}
      />
    );
  }

  return (
    <ProfitAndLossSummary
      data={Array.isArray(data) ? data : []}
      title="Profit & Loss"
      subtitle={subtitle}
    />
  );
}

