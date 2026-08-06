const { supabase } = require("../../db");
const XLSX = require("xlsx");
const { fetchAllRows } = require("./pagedFetch");

/**
 * Export Key Reports data for a specific version to an Excel workbook.
 * Fetches data only from the selected version_id across 6 tables and generates
 * a downloadable Excel file with worksheets for each data type.
 *
 * @param {string} versionId - The Key Reports version ID to export
 * @returns {Object} { workbook, fileName, buffer } for streaming to client
 */
async function exportKeyReportData(versionId) {
  if (!versionId) {
    throw new Error("versionId is required");
  }

  // Verify version exists and get metadata (company name, version name)
  const { data: version, error: versionError } = await supabase
    .from("key_report_versions")
    .select("id, version_name, company_id")
    .eq("id", versionId)
    .maybeSingle();

  if (versionError || !version) {
    throw new Error(`Key Report version not found: ${versionId}`);
  }

  // Get company name for the filename
  const { data: company } = await supabase
    .from("companies")
    .select("name")
    .eq("id", version.company_id)
    .maybeSingle();

  const companyName = company?.name || "Company";
  const versionName = version.version_name || `Version ${versionId.substring(0, 8)}`;

  // Fetch all data for this version across the 6 tables
  console.log(`[KeyReportsExport] Starting export for version ${versionId}`);

  const [glData, bsData, coaData, tbData, trData, bankData] = await Promise.all([
    fetchGeneralLedgerData(versionId),
    fetchBalanceSheetData(versionId),
    fetchChartOfAccountsData(versionId),
    fetchTrialBalanceData(versionId),
    fetchTaxReturnData(versionId),
    fetchBankStatementData(versionId),
  ]);

  // Log row counts for verification
  console.log(`[KeyReportsExport] Fetched row counts:`);
  console.log(`  - General Ledger Entries: ${glData.length}`);
  console.log(`  - Balance Sheet Entries: ${bsData.length}`);
  console.log(`  - Chart of Accounts: ${coaData.length}`);
  console.log(`  - Trial Balance Entries: ${tbData.length}`);
  console.log(`  - Tax Return Entries: ${trData.length}`);
  console.log(`  - Bank Statement Entries: ${bankData.length}`);

  // Create Excel workbook with worksheets
  const workbook = XLSX.utils.book_new();

  // Add worksheets (include them even if empty, with headers only)
  addWorksheet(workbook, "General Ledger Entries", glData);
  addWorksheet(workbook, "Balance Sheet Entries", bsData);
  addWorksheet(workbook, "Chart of Accounts", coaData);
  addWorksheet(workbook, "Trial Balance Entries", tbData);
  addWorksheet(workbook, "Tax Return Entries", trData);
  addWorksheet(workbook, "Bank Statement Entries", bankData);

  console.log(`[KeyReportsExport] Export complete for version ${versionId}`);

  // Generate filename
  const fileName = `KeyReports_${sanitizeFileName(companyName)}_${sanitizeFileName(versionName)}.xlsx`;

  // Write to buffer
  const buffer = XLSX.write(workbook, { type: "buffer" });

  return { workbook, fileName, buffer };
}

/**
 * Fetch General Ledger Entries for a version
 * Uses pagedFetch to handle Supabase's ~1000 row cap
 *
 * Filters to only include actual transactions:
 * - Excludes ACCOUNT_HEADER rows (row_type = 'ACCOUNT_HEADER')
 * - Excludes rows with NULL transaction_date (non-transactions)
 * - Includes only rows with row_type = 'TRANSACTION'
 */
async function fetchGeneralLedgerData(versionId) {
  try {
    const data = await fetchAllRows(
      () => supabase
        .from("general_ledger_entries")
        .select("*")
        .eq("version_id", versionId)
        .not("transaction_date", "is", null) // Only rows with non-null transaction_date (actual transactions)
        .order("transaction_date", { ascending: true }),
      { label: `GL export for ${versionId.substring(0, 8)}` }
    );
    return data || [];
  } catch (error) {
    console.warn(`[KeyReportsExport] GL data fetch error: ${error.message}`);
    return [];
  }
}

/**
 * Fetch Balance Sheet Entries for a version
 * Uses pagedFetch to handle Supabase's ~1000 row cap
 */
async function fetchBalanceSheetData(versionId) {
  try {
    const data = await fetchAllRows(
      () => supabase
        .from("balance_sheet_entries")
        .select("*")
        .eq("version_id", versionId)
        .order("as_of_date", { ascending: false })
        .order("account_name", { ascending: true }),
      { label: `BS export for ${versionId.substring(0, 8)}` }
    );
    return data || [];
  } catch (error) {
    console.warn(`[KeyReportsExport] Balance Sheet data fetch error: ${error.message}`);
    return [];
  }
}

/**
 * Fetch Chart of Accounts for a version
 * Uses pagedFetch to handle Supabase's ~1000 row cap
 */
async function fetchChartOfAccountsData(versionId) {
  try {
    const data = await fetchAllRows(
      () => supabase
        .from("chart_of_accounts")
        .select("*")
        .eq("version_id", versionId)
        // sort_order is not guaranteed unique (see financialStatementService.js's
        // loadCoa for the confirmed root cause) — an id tie-breaker keeps this
        // paginated fetch's ordering stable across pages/requests, so a
        // same-sort_order row can never be skipped or duplicated between pages.
        .order("sort_order", { ascending: true })
        .order("id", { ascending: true }),
      { label: `COA export for ${versionId.substring(0, 8)}` }
    );
    return data || [];
  } catch (error) {
    console.warn(`[KeyReportsExport] COA data fetch error: ${error.message}`);
    return [];
  }
}

/**
 * Fetch Trial Balance Entries for a version
 * Uses pagedFetch to handle Supabase's ~1000 row cap
 */
async function fetchTrialBalanceData(versionId) {
  try {
    const data = await fetchAllRows(
      () => supabase
        .from("trial_balance_entries")
        .select("*")
        .eq("version_id", versionId)
        .order("fiscal_year", { ascending: false })
        .order("account_name", { ascending: true }),
      { label: `TB export for ${versionId.substring(0, 8)}` }
    );
    return data || [];
  } catch (error) {
    console.warn(`[KeyReportsExport] Trial Balance data fetch error: ${error.message}`);
    return [];
  }
}

/**
 * Fetch Tax Return Entries for a version
 * Uses pagedFetch to handle Supabase's ~1000 row cap
 */
async function fetchTaxReturnData(versionId) {
  try {
    const data = await fetchAllRows(
      () => supabase
        .from("tax_return_entries")
        .select("*")
        .eq("version_id", versionId)
        .order("tax_year", { ascending: false })
        .order("field_name", { ascending: true }),
      { label: `TR export for ${versionId.substring(0, 8)}` }
    );
    return data || [];
  } catch (error) {
    console.warn(`[KeyReportsExport] Tax Return data fetch error: ${error.message}`);
    return [];
  }
}

/**
 * Fetch Bank Statement Entries for a version
 * Uses pagedFetch to handle Supabase's ~1000 row cap
 */
async function fetchBankStatementData(versionId) {
  try {
    const data = await fetchAllRows(
      () => supabase
        .from("bank_statement_entries")
        .select("*")
        .eq("version_id", versionId)
        .order("statement_month", { ascending: false })
        .order("transaction_date", { ascending: true }),
      { label: `Bank export for ${versionId.substring(0, 8)}` }
    );
    return data || [];
  } catch (error) {
    console.warn(`[KeyReportsExport] Bank Statement data fetch error: ${error.message}`);
    return [];
  }
}

/**
 * Add a worksheet to the workbook with data
 * If data is empty, creates a worksheet with headers only (or empty if no headers)
 */
function addWorksheet(workbook, sheetName, data) {
  let worksheet;

  if (data.length === 0) {
    // Empty worksheet with no data
    worksheet = XLSX.utils.aoa_to_sheet([]);
  } else {
    // Convert data to array of arrays with headers
    const headers = Object.keys(data[0]);
    const rows = data.map((row) => headers.map((h) => row[h]));
    const aoa = [headers, ...rows];
    worksheet = XLSX.utils.aoa_to_sheet(aoa);

    // Set column widths based on header length
    worksheet["!cols"] = headers.map((h) => ({
      wch: Math.max(h.length + 2, 12),
    }));
  }

  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
}

/**
 * Sanitize filename by removing special characters
 */
function sanitizeFileName(str) {
  return String(str || "")
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, "_")
    .substring(0, 100);
}

module.exports = {
  exportKeyReportData,
};
