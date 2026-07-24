/**
 * Client Chart of Accounts — Workbook Import CLI
 * ================================================
 *
 * Loads a COA workbook into client_chart_of_accounts (migration 071/072 must
 * already be applied). Every account row is stored exactly as the workbook
 * has it — see clientCoaImportService.js for details.
 *
 * Usage:
 *   node scripts/importClientCoa.js "../chart_of_accounts_SEC.xlsx"                  (global master)
 *   node scripts/importClientCoa.js "../some_company_coa.xlsx" <company-uuid>        (per-company)
 */

const fs = require("fs");
const path = require("path");
const { importClientCoaWorkbook } = require("../src/services/keyReports/clientCoaImportService");

async function main() {
  const filePath = process.argv[2];
  const companyId = process.argv[3] || null;
  if (!filePath) {
    console.error("Usage: node scripts/importClientCoa.js <path-to-workbook.xlsx> [company-uuid]");
    process.exit(1);
  }
  const resolved = path.resolve(filePath);
  const fileBuffer = fs.readFileSync(resolved);
  const fileName = path.basename(resolved);

  console.log(`Importing "${fileName}" into client_chart_of_accounts (${companyId ? `company ${companyId}` : "global"})...`);
  const result = await importClientCoaWorkbook(fileBuffer, fileName, companyId);
  console.log(`Done: ${result.inserted} account rows imported from "${result.sourceFile}".`);
}

main().catch((err) => {
  console.error("Import failed:", err.message);
  process.exit(1);
});
