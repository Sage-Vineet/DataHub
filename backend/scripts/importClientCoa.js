/**
 * Client Chart of Accounts — Workbook Import CLI
 * ================================================
 *
 * Loads the client's COA workbook into client_chart_of_accounts (migration
 * 071 must already be applied). Every account row is stored exactly as the
 * workbook has it — see clientCoaImportService.js for details.
 *
 * Usage:
 *   node scripts/importClientCoa.js "../chart_of_accounts_SEC (1) (1) (1).xlsx"
 */

const fs = require("fs");
const path = require("path");
const { importClientCoaWorkbook } = require("../src/services/keyReports/clientCoaImportService");

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Usage: node scripts/importClientCoa.js <path-to-workbook.xlsx>");
    process.exit(1);
  }
  const resolved = path.resolve(filePath);
  const fileBuffer = fs.readFileSync(resolved);
  const fileName = path.basename(resolved);

  console.log(`Importing "${fileName}" into client_chart_of_accounts...`);
  const result = await importClientCoaWorkbook(fileBuffer, fileName);
  console.log(`Done: ${result.inserted} account rows imported from "${result.sourceFile}".`);
}

main().catch((err) => {
  console.error("Import failed:", err.message);
  process.exit(1);
});
