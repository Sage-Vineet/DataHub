// ============================================================================
// Client Chart of Accounts — workbook importer (Key Reports redesign)
//
// Reads the client's own COA workbook (chart_of_accounts_SEC.xlsx) and loads
// it verbatim into client_chart_of_accounts — the master hierarchy reference
// coaMappingService searches against. Every column is stored exactly as the
// workbook has it; nothing is normalized, generated, computed, or inferred,
// with the sole exception of source_row_number/source_file_name (import
// bookkeeping, not hierarchy).
//
// The workbook has no account_type or normal_balance column at all — those
// continue to come from Gemini + chartOfAccountsService.normalBalanceFor()
// respectively when a generated account is matched to a row here (see
// coaMappingService.js).
// ============================================================================

"use strict";

const XLSX = require("xlsx");
const { supabase } = require("../../db");

const MAX_LEVELS = 15;
const TABLE = "client_chart_of_accounts";

/** Locate the real header row by content, not a fixed row index — the
 *  workbook has a variable-length title/notes preamble above it. */
function findHeaderRowIndex(rows) {
  for (let i = 0; i < rows.length; i++) {
    const cells = (rows[i] || []).map((c) => String(c || "").trim().toLowerCase());
    if (cells.includes("system id") && cells.includes("account name")) return i;
  }
  return -1;
}

/**
 * Parse the workbook into plain records ready for insertion. Pure — no I/O,
 * callable from tests/validation scripts without a database.
 *
 * Skips only rows that are not a real account: the title/subtitle/notes
 * preamble above the header, blank rows, and section-header rows (e.g.
 * "PROFIT & LOSS ACCOUNTS", "  Income") which carry no System ID. Every row
 * that has both a System ID and an Account Name is stored exactly as-is.
 *
 * @param {Buffer} fileBuffer
 * @param {string} fileName
 * @returns {Array<object>} records shaped for the client_chart_of_accounts table
 */
function parseClientCoaWorkbook(fileBuffer, fileName) {
  const workbook = XLSX.read(fileBuffer, { type: "buffer", cellDates: false });
  const sheetName = workbook.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: "" });

  const headerIdx = findHeaderRowIndex(rows);
  if (headerIdx === -1) {
    throw new Error(`Could not find the header row ("System ID" + "Account Name" columns) in "${fileName}"`);
  }

  const records = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const systemId = String(r[0] || "").trim();
    const accountName = String(r[2] || "").trim();
    if (!systemId || !accountName) continue; // preamble / blank / section-header row

    const record = {
      system_id: systemId,
      account_number: String(r[1] || "").trim() || null,
      account_name: accountName,
      account_id_name: String(r[3] || "").trim() || null,
      statement_type: String(r[4] || "").trim() || null,
      hierarchy_path: String(r[20] || "").trim() || null,
      classification_method: String(r[21] || "").trim() || null,
      adjusted_hierarchy: String(r[22] || "").trim() || null,
      adjusted_name: String(r[23] || "").trim() || null,
      source_row_number: i + 1, // 1-indexed — matches the row a human sees in Excel
      source_file_name: fileName,
    };
    for (let lvl = 1; lvl <= MAX_LEVELS; lvl++) {
      record[`level_${lvl}`] = String(r[4 + lvl] || "").trim() || null;
    }
    records.push(record);
  }
  return records;
}

/**
 * Import a client COA workbook into client_chart_of_accounts, replacing
 * whatever was there before. This table holds exactly one imported reference
 * at a time — re-running the import is how you refresh it from a newer
 * version of the same source workbook, not how you merge multiple sources.
 *
 * @param {Buffer} fileBuffer
 * @param {string} fileName
 * @returns {Promise<{inserted: number, sourceFile: string}>}
 */
async function importClientCoaWorkbook(fileBuffer, fileName) {
  const records = parseClientCoaWorkbook(fileBuffer, fileName);
  if (!records.length) throw new Error(`No account rows found in "${fileName}"`);

  const { error: delErr } = await supabase
    .from(TABLE)
    .delete()
    .not("id", "is", null);
  if (delErr) throw delErr;

  const CHUNK = 500;
  let inserted = 0;
  for (let i = 0; i < records.length; i += CHUNK) {
    const chunk = records.slice(i, i + CHUNK);
    const { error } = await supabase.from(TABLE).insert(chunk);
    if (error) throw error;
    inserted += chunk.length;
  }
  return { inserted, sourceFile: fileName };
}

module.exports = { parseClientCoaWorkbook, importClientCoaWorkbook };
