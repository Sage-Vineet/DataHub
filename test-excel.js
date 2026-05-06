import { buildStyledReconciliationExcel } from "./src/lib/bank-reconciliation-excel.js";
import fs from "fs";

async function test() {
  try {
    const blob = await buildStyledReconciliationExcel({
      startDate: "2024-01-01",
      endDate: "2024-12-31",
      reportMonths: ["2024-01", "2024-02"],
      visibleBalanceAccounts: [{ accountName: "Test", accountNumber: "123" }],
      qbBankActivity: { accounts: [] },
      buildAccountBalanceDataFromQB: () => ({ rows: [], ttm: {} }),
      activityRows: [],
      activityTTM: {},
      BALANCE_EXPORT_METRICS: [{ key: "startingBalance", label: "Starting Balance" }],
      ACTIVITY_EXPORT_METRICS: [{ key: "totalDeposits", label: "Total Deposits" }],
    });
    console.log("Success! Blob size:", blob.size);
  } catch (err) {
    console.error("Error:", err);
  }
}

test();
