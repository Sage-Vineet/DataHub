// Origins Counseling & Wellness REAL-FILE fixture harness.
//
// Runs the ACTUAL production pipeline end-to-end against the real uploaded
// .xlsx files (no DB, no company row, no version needed):
//
//   extraction -> document trees -> GL year-aware classification ->
//   document matching -> canonical COA tree -> levels/hierarchy_path/parent
//
// Nothing in here is referenced by production code; it exists so the algorithm
// can be verified against a real, known-difficult client export.
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const fs = require("fs");
const path = require("path");

const ROOT = process.env.ORIGINS_FIXTURE_DIR || "d:/Company/DataHub 2/DataHub";
const bsSvc = require("../src/services/keyReports/balanceSheetExtractionService");
const plSvc = require("../src/services/keyReports/profitLossExtractionService");
const glSvc = require("../src/services/keyReports/generalLedgerExtractionService");
const { buildBalanceSheetTreeFromData, buildProfitLossTreeFromData } = require("../src/services/keyReports/referenceTreeBuilder");
const coa = require("../src/services/chartOfAccountsService");

const FILES = {
  bs:      "Origins Counseling & Wellness, PLLC_Balance Sheet.xlsx",
  bs13mo:  "Origins Counseling & Wellness, PLLC_Balance Sheet Last 13mo.xlsx",
  bs4yr:   "Origins Counseling & Wellness, PLLC_Balance Sheet Last 4yrs.xlsx",
  pl:      "Origins Counseling & Wellness, PLLC_Profit and Loss.xlsx",
  gl:      "Origins Counseling & Wellness, PLLC_General Ledger.xlsx",
};

function read(name) { return fs.readFileSync(path.join(ROOT, name)); }
function exists() { return Object.values(FILES).every((f) => fs.existsSync(path.join(ROOT, f))); }

async function buildFixture() {
  // ── Balance Sheet: all three uploaded documents, reference-year first ──────
  const bsDocs = [
    { key: "bs",     id: "bs-current" },
    { key: "bs13mo", id: "bs-13mo" },
    { key: "bs4yr",  id: "bs-4yr" },
  ];
  let bsRows = [];
  for (const d of bsDocs) {
    const res = await bsSvc._extractFromExcel(read(FILES[d.key]), FILES[d.key]);
    const rows = (res?.rows || []).map((r) => ({ ...r, source_file_id: d.id }));
    bsRows = bsRows.concat(rows);
  }
  const plRes = await plSvc._extractFromExcel(read(FILES.pl), FILES.pl);
  const plRows = plRes?.rows || [];

  const balanceSheetTree = buildBalanceSheetTreeFromData({ reportName: "Balance Sheet", rows: bsRows });
  const profitLossTree   = buildProfitLossTreeFromData({ reportName: "Profit and Loss", rows: plRows });

  // ── General Ledger ────────────────────────────────────────────────────────
  const glRes = await glSvc._extractFromExcelJS(read(FILES.gl), FILES.gl);
  const glRaw = glRes?.rows || [];
  // Only POSTING rows, exactly as the GL read path does -- the by-account GL
  // format also emits per-account heading and "Total for <account>" subtotal
  // rows, and treating those as accounts invents COA leaves named
  // "Total for Checking - 1183".
  const glRows = glRaw
    .filter((r) => !r.row_type || String(r.row_type).toUpperCase() === "TRANSACTION")
    .map((r, i) => ({
      account_name:  r.account_name ?? r.accountName ?? null,
      split_account: r.split_account ?? null,
      account_section: r.account_section ?? null,
      transaction_date: r.transaction_date ?? null,
      account_number: r.account_number ?? null,
      source_file_id: "gl-1",
      row_type: r.row_type ?? null,
      _i: i,
    }));

  const refYear = 2026;
  const glBucketByKey = coa.splitAccountsAtRetainedEarningsByYear(glRows, profitLossTree);
  // Mirrors keyReportSyncService exactly: the COA model consumes POSTING rows
  // only, while the reference TREES above deliberately consume every row
  // (the total rows are what carry the bracketing hierarchy).
  const bsRowsForModel = bsRows.filter((r) => !r.row_type || r.row_type === "account");
  const plRowsForModel = plRows.filter((r) => !r.is_total && !r.is_header);
  const { leaves } = coa.buildCoaModel(
    glRows, bsRowsForModel, plRowsForModel, new Map(), new Map(), glBucketByKey, refYear,
    { balanceSheetTree, profitLossTree },
  );
  const resolved = await coa.buildLeafHierarchies(leaves);
  return { balanceSheetTree, profitLossTree, glRows, glBucketByKey, leaves, resolved };
}

module.exports = { FILES, exists, buildFixture, ROOT };
