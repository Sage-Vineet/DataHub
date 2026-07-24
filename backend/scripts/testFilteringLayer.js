/**
 * Unit Test for Document Ingestion Filtering Layer
 * Run with: node backend/scripts/testFilteringLayer.js
 */

const ExtractionServiceBase = require('../src/services/keyReports/extractionService.base');

// Instantiate a test extraction service
const service = new ExtractionServiceBase('test_service', 'test_entries');

const testCases = [
  // Disallowed Headers
  { value: 'Accrual Basis Saturday, April 04, 2026 01:39 PM GMTZ', field: 'account_name', shouldFilter: true, reason: 'Accrual Basis* pattern' },
  { value: 'Accrual Basis Saturday, April 04, 2026 01:40 PM GMTZ', field: 'description', shouldFilter: true, reason: 'Accrual Basis* pattern' },
  { value: 'Cash Basis Friday, May 01, 2026', field: 'field_name', shouldFilter: true, reason: 'Cash Basis* pattern' },
  { value: 'Report Generated: 2026-06-25', field: 'field_label', shouldFilter: true, reason: 'Report Generated* pattern' },
  { value: 'Generated On: Monday, Jan 12, 2026', field: 'memo', shouldFilter: false }, // not in fieldsToInspect
  { value: 'Generated On: Monday, Jan 12, 2026', field: 'description', shouldFilter: true, reason: 'Generated On* pattern' },

  // Disallowed Totals
  { value: 'Total for Bank Accounts', field: 'account_name', shouldFilter: true, reason: 'Total for * pattern' },
  { value: 'Total for Current Assets', field: 'account_name', shouldFilter: true, reason: 'Total for * pattern' },
  { value: 'Total for Sales', field: 'account_name', shouldFilter: true, reason: 'Total for * pattern' },
  { value: 'Total for Payroll Expenses', field: 'account_name', shouldFilter: true, reason: 'Total for * pattern' },
  { value: 'Total Assets', field: 'account_name', shouldFilter: true, reason: 'Exact total pattern: "Total Assets"' },
  { value: 'Total Liabilities', field: 'account_name', shouldFilter: true, reason: 'Exact total pattern: "Total Liabilities"' },
  { value: 'Total Equity', field: 'account_name', shouldFilter: true, reason: 'Exact total pattern: "Total Equity"' },
  { value: 'Total Income', field: 'account_name', shouldFilter: true, reason: 'Exact total pattern: "Total Income"' },
  { value: 'Total Expenses', field: 'account_name', shouldFilter: true, reason: 'Exact total pattern: "Total Expenses"' },

  // Disallowed Section Headers
  { value: 'Assets', field: 'account_name', shouldFilter: true, reason: 'Exact section header pattern: "Assets"' },
  { value: 'Current Assets', field: 'account_name', shouldFilter: true, reason: 'Exact section header pattern: "Current Assets"' },
  { value: 'Other Current Assets', field: 'account_name', shouldFilter: true, reason: 'Exact section header pattern: "Other Current Assets"' },
  { value: 'Fixed Assets', field: 'account_name', shouldFilter: true, reason: 'Exact section header pattern: "Fixed Assets"' },
  { value: 'Liabilities', field: 'account_name', shouldFilter: true, reason: 'Exact section header pattern: "Liabilities"' },
  { value: 'Current Liabilities', field: 'account_name', shouldFilter: true, reason: 'Exact section header pattern: "Current Liabilities"' },
  { value: 'Long-Term Liabilities', field: 'account_name', shouldFilter: true, reason: 'Exact section header pattern: "Long-Term Liabilities"' },
  { value: 'Long Term Liabilities', field: 'account_name', shouldFilter: true, reason: 'Exact section header pattern: "Long Term Liabilities"' },
  { value: 'Equity', field: 'account_name', shouldFilter: true, reason: 'Exact section header pattern: "Equity"' },
  { value: 'Income', field: 'account_name', shouldFilter: true, reason: 'Exact section header pattern: "Income"' },
  { value: 'Expenses', field: 'account_name', shouldFilter: true, reason: 'Exact section header pattern: "Expenses"' },

  // Real Accounts to Preserve
  { value: 'Provident Bank Business Checking', field: 'account_name', shouldFilter: false },
  { value: 'Inventory', field: 'account_name', shouldFilter: false },
  { value: 'Sales', field: 'account_name', shouldFilter: false },
  { value: 'Payroll Expenses', field: 'account_name', shouldFilter: false },
  { value: 'Retained Earnings', field: 'account_name', shouldFilter: false },
  { value: 'Loan Payable - PPP Loan', field: 'account_name', shouldFilter: false },
  { value: 'Sales', field: 'account_name', shouldFilter: false },
  { value: 'Provident Bank Business Checking', field: 'bank_account', shouldFilter: false }
];

console.log('Running unit tests for document extraction filtering layer...\n');

let passCount = 0;
let failCount = 0;

for (let i = 0; i < testCases.length; i++) {
  const tc = testCases[i];
  // Construct row with single tested field
  const row = { [tc.field]: tc.value };
  
  const { filteredRows, skippedLog } = service.filterRowsBeforeInsertion([row]);
  
  const isFiltered = filteredRows.length === 0;
  const logged = skippedLog.length > 0 ? skippedLog[0] : null;

  if (tc.shouldFilter) {
    if (isFiltered && logged && logged.value === tc.value && logged.reason.includes(tc.reason)) {
      console.log(`[PASS] Filtered out "${tc.value}" in field "${tc.field}". Reason: ${logged.reason}`);
      passCount++;
    } else {
      console.error(`[FAIL] Expected to filter out "${tc.value}" in field "${tc.field}" with reason "${tc.reason}". Result: isFiltered=${isFiltered}, log=${JSON.stringify(logged)}`);
      failCount++;
    }
  } else {
    if (!isFiltered) {
      console.log(`[PASS] Preserved "${tc.value}" in field "${tc.field}".`);
      passCount++;
    } else {
      console.error(`[FAIL] Expected to preserve "${tc.value}" in field "${tc.field}". Result: Filtered out, log=${JSON.stringify(logged)}`);
      failCount++;
    }
  }
}

console.log(`\nTest results: ${passCount} passed, ${failCount} failed.`);

if (failCount > 0) {
  process.exit(1);
} else {
  console.log('\nAll unit tests passed successfully!');
  process.exit(0);
}
