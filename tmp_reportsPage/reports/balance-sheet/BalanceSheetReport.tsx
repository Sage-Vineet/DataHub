"use client";

import { FinancialLine } from "@/types/balance-sheet";
import { DetailedFinancialData } from "@/types/financial-details";
import BalanceSheetSummary from "./BalanceSheetSummary";
import BalanceSheetDetail from "./BalanceSheetDetail";

interface BalanceSheetReportProps {
  reportType: "Summary" | "Detail";
  data: FinancialLine[];
  detailedData: DetailedFinancialData;
  startDate?: string;
  endDate?: string;
  accountingMethod: string;
  clientName?: string;
}

export default function BalanceSheetReport({
  reportType,
  data,
  detailedData,
  startDate,
  endDate,
  accountingMethod,
  clientName = "All Clients",
}: BalanceSheetReportProps) {
  const subtitle = `Report Period: ${startDate || "N/A"} to ${endDate || "N/A"} | ${clientName} | ${accountingMethod} Basis`;

  if (reportType === "Detail") {
    return (
      <BalanceSheetDetail
        data={detailedData?.groups ? detailedData : { groups: [] }}
        title="Balance Sheet"
        subtitle={subtitle}
      />
    );
  }

  return <BalanceSheetSummary data={Array.isArray(data) ? data : []} title="Balance Sheet" subtitle={subtitle} />;
}

