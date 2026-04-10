"use client";

import { FinancialLine } from "@/types/balance-sheet";
import { DetailedFinancialData } from "@/types/financial-details";
import CashflowSummary from "./CashflowSummary";
import CashflowDetail from "./CashflowDetail";

interface CashflowReportProps {
  reportType: "Summary" | "Detail";
  data: FinancialLine[];
  detailedData: DetailedFinancialData;
  startDate?: string;
  endDate?: string;
  accountingMethod: string;
  clientName?: string;
}

export default function CashflowReport({
  reportType,
  data,
  detailedData,
  startDate,
  endDate,
  accountingMethod,
  clientName = "All Clients",
}: CashflowReportProps) {
  const subtitle = `Report Period: ${startDate || "N/A"} to ${endDate || "N/A"} | ${clientName} | ${accountingMethod} Basis`;

  if (reportType === "Detail") {
    return (
      <CashflowDetail
        data={detailedData?.groups ? detailedData : { groups: [] }}
        title="Cash Flow"
        subtitle={subtitle}
      />
    );
  }

  return (
    <CashflowSummary
      data={Array.isArray(data) ? data : []}
      title="Cash Flow"
      subtitle={subtitle}
    />
  );
}

