/**
 * General Ledger Extraction Service
 *
 * Supports:
 *  - QuickBooks Online Excel export
 *  - QuickBooks Desktop Excel export
 *  - Generic GL Excel/CSV files
 *
 * QuickBooks GL column names (all variants):
 *  Date:        "Date", "Trans Date", "Transaction Date", "Txn Date"
 *  Num:         "Num", "Ref No.", "Trans #", "Reference", "Check #"
 *  Name:        "Name", "Vendor", "Customer", "Payee"
 *  Account:     "Account", "Account Name", "GL Account"
 *  Account #:   "Account #", "Acct #", "Account Number"
 *  Debit:       "Debit", "Debits", "Dr", "Dr Amount", "Amount Dr"
 *  Credit:      "Credit", "Credits", "Cr", "Cr Amount", "Amount Cr"
 *  Amount:      "Amount", "Net Amount"
 *  Description: "Memo", "Description", "Narration", "Notes"
 *  Class:       "Class", "Job", "Department", "Location"
 *  Balance:     "Balance", "Running Balance"
 */

const XLSX = require('xlsx');
const { supabase } = require('../../db');
const ExtractionServiceBase = require('./extractionService.base');
const { extractWithPython } = require('./pythonBridge');

const DATE_ALIASES    = ['date', 'trans date', 'transaction date', 'txn date', 'posting date', 'effective date', 'value date', 'trans. date'];
const REF_ALIASES     = ['num', 'ref no', 'ref no.', 'reference', 'ref #', 'check #', 'check no', 'trans #', 'trans no', 'doc no', 'document no', 'invoice #', 'invoice no'];
const NAME_ALIASES    = ['name', 'vendor', 'vendor name', 'customer', 'payee', 'entity'];
const ACCOUNT_ALIASES = ['account', 'account name', 'gl account', 'acct', 'chart of account'];
const ACCTNUM_ALIASES = ['account #', 'acct #', 'account number', 'acct number', 'acct no', 'account no', 'acct. no', 'gl code', 'account code'];
const DEBIT_ALIASES   = ['debit', 'debits', 'dr', 'dr amount', 'amount dr', 'debit amount'];
const CREDIT_ALIASES  = ['credit', 'credits', 'cr', 'cr amount', 'amount cr', 'credit amount'];
const AMOUNT_ALIASES  = ['amount', 'net amount', 'total amount'];
const DESC_ALIASES    = ['memo', 'description', 'narration', 'notes', 'detail', 'particulars', 'remark'];
const CLASS_ALIASES   = ['class', 'job', 'department', 'dept', 'location', 'cost center', 'division'];
const TYPE_ALIASES    = ['type', 'transaction type', 'txn type', 'journal type', 'entry type'];
const BALANCE_ALIASES = ['balance', 'running balance', 'closing balance', 'ledger balance'];

function lc(v) { return String(v || '').toLowerCase().trim(); }

function parseAmount(v) {
  if (v === '' || v == null) return 0;
  const s = String(v).replace(/[$,\s]/g, '');
  if (/^\([\d.]+\)$/.test(s)) return -(parseFloat(s.slice(1, -1)) || 0);
  return parseFloat(s) || 0;
}

function parseDate(v) {
  if (!v && v !== 0) return null;
  // Excel serial date (number)
  if (typeof v === 'number') {
    const d = new Date(Math.round((v - 25569) * 86400 * 1000));
    if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
  }
  const s = String(v).trim();
  if (!s) return null;
  // Common formats: MM/DD/YYYY, MM-DD-YYYY, YYYY-MM-DD, M/D/YY
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
  return null;
}

/** Score a row as a potential header row */
function headerScore(row) {
  let score = 0;
  for (const cell of row) {
    const h = lc(cell);
    if (DATE_ALIASES.some((a) => h === a))    score += 4;
    if (DEBIT_ALIASES.some((a) => h === a))   score += 3;
    if (CREDIT_ALIASES.some((a) => h === a))  score += 3;
    if (ACCOUNT_ALIASES.some((a) => h === a)) score += 3;
    if (NAME_ALIASES.some((a) => h === a))    score += 2;
    if (DESC_ALIASES.some((a) => h === a))    score += 2;
  }
  return score;
}

function findColByAliases(headerRow, aliases) {
  for (let i = 0; i < headerRow.length; i++) {
    const h = lc(headerRow[i]);
    if (aliases.some((a) => h === a || h.includes(a))) return i;
  }
  return -1;
}

class GeneralLedgerExtractionService extends ExtractionServiceBase {
  constructor() {
    super('general_ledger', 'general_ledger_entries');
  }

  async extract({ fileName, fileBuffer }) {
    // Python primary path (handles both column-based and by-Account QBO format)
    try {
      this.logger.log(`Trying Python extraction for GL "${fileName}"`);
      const result = await extractWithPython('extract_excel.py', fileBuffer, {
        type: 'general_ledger',
        filename: fileName,
      });
      if (result.rows && result.rows.length > 0) {
        this.logger.log(`Python extracted ${result.rows.length} GL rows from "${fileName}"`);
        return { rows: result.rows, detectedYears: result.detected_years };
      }
      this.logger.warn(`Python returned 0 rows for GL "${fileName}", falling back to JS`);
    } catch (err) {
      this.logger.warn(`Python GL extraction failed for "${fileName}", falling back to JS: ${err.message}`);
    }

    return this._extractFromExcelJS(fileBuffer, fileName);
  }

  async _extractFromExcelJS(fileBuffer, fileName) {
    const workbook = XLSX.read(fileBuffer, { type: 'buffer', cellDates: false });

    // Try GL-named sheet, fall back to first
    const sheetName =
      workbook.SheetNames.find((n) => /general\s*ledger|gl\b|transaction/i.test(n)) ||
      workbook.SheetNames[0];
    const ws = workbook.Sheets[sheetName];
    const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

    if (!raw || raw.length < 2) throw new Error('No data found in GL file');

    this.logger.log(`Sheet "${sheetName}" in "${fileName}": ${raw.length} raw rows`);

    // Find the header row by best score in first 25 rows
    let headerIdx = 0;
    let bestScore = 0;
    for (let i = 0; i < Math.min(25, raw.length); i++) {
      const s = headerScore(raw[i]);
      if (s > bestScore) { bestScore = s; headerIdx = i; }
    }

    if (bestScore < 2) {
      // No recognizable header — try to use the first row and proceed with positional logic
      this.logger.warn(`No strong header row found (best score=${bestScore}). Using row 0.`);
      headerIdx = 0;
    }

    this.logger.log(`  Header row at index ${headerIdx} (score=${bestScore}): ${JSON.stringify(raw[headerIdx]).slice(0, 120)}`);

    const headerRow = raw[headerIdx];

    // Build column map
    const colMap = {
      date:       findColByAliases(headerRow, DATE_ALIASES),
      ref:        findColByAliases(headerRow, REF_ALIASES),
      name:       findColByAliases(headerRow, NAME_ALIASES),
      account:    findColByAliases(headerRow, ACCOUNT_ALIASES),
      accountNum: findColByAliases(headerRow, ACCTNUM_ALIASES),
      debit:      findColByAliases(headerRow, DEBIT_ALIASES),
      credit:     findColByAliases(headerRow, CREDIT_ALIASES),
      amount:     findColByAliases(headerRow, AMOUNT_ALIASES),
      desc:       findColByAliases(headerRow, DESC_ALIASES),
      class_:     findColByAliases(headerRow, CLASS_ALIASES),
      type:       findColByAliases(headerRow, TYPE_ALIASES),
      balance:    findColByAliases(headerRow, BALANCE_ALIASES),
    };

    this.logger.log(`  Column map: ${JSON.stringify(colMap)}`);

    // Validate we have at minimum date and account
    if (colMap.date < 0) {
      // Fallback: look for first column that looks like it has date values in data rows
      for (let c = 0; c < Math.min(5, headerRow.length); c++) {
        for (let r = headerIdx + 1; r < Math.min(headerIdx + 6, raw.length); r++) {
          if (parseDate(raw[r][c])) { colMap.date = c; break; }
        }
        if (colMap.date >= 0) break;
      }
      if (colMap.date < 0) throw new Error('Could not detect date column in GL file');
    }

    if (colMap.account < 0 && colMap.accountNum < 0) {
      // Last resort: use column named closest to "account" or use col with most text
      this.logger.warn('Could not detect account column — using first text column as fallback');
      colMap.account = 0;
    }

    const rows = [];
    let rowsDetected = 0, rowsRejected = 0;

    for (let i = headerIdx + 1; i < raw.length; i++) {
      const row = raw[i];
      if (row.every((c) => !c)) continue; // blank row

      rowsDetected++;

      const dateStr = parseDate(colMap.date >= 0 ? row[colMap.date] : null);
      if (!dateStr) { rowsRejected++; continue; }

      const fiscalYear = new Date(dateStr).getFullYear();

      const accountName = String(colMap.account >= 0 ? (row[colMap.account] || '') : '').trim();
      const accountNum  = String(colMap.accountNum >= 0 ? (row[colMap.accountNum] || '') : '').trim();

      // Skip rows that are section headers (no account + no date)
      if (!accountName && !accountNum) { rowsRejected++; continue; }

      let debit  = colMap.debit  >= 0 ? parseAmount(row[colMap.debit])  : 0;
      let credit = colMap.credit >= 0 ? parseAmount(row[colMap.credit]) : 0;

      // Single amount column: positive = debit, negative = credit
      if (colMap.debit < 0 && colMap.credit < 0 && colMap.amount >= 0) {
        const amt = parseAmount(row[colMap.amount]);
        if (amt >= 0) debit = amt;
        else credit = Math.abs(amt);
      }

      rows.push({
        transaction_date: dateStr,
        fiscal_year: fiscalYear,
        account_number: accountNum || null,
        account_name: accountName,
        description: colMap.desc >= 0 ? String(row[colMap.desc] || '').trim() || null : null,
        reference: colMap.ref >= 0 ? String(row[colMap.ref] || '').trim() || null : null,
        debit,
        credit,
        journal_type: colMap.type >= 0 ? String(row[colMap.type] || '').trim() || null : null,
        class: colMap.class_ >= 0 ? String(row[colMap.class_] || '').trim() || null : null,
        vendor_name: colMap.name >= 0 ? String(row[colMap.name] || '').trim() || null : null,
      });
    }

    this.logger.log(`  "${fileName}": Rows detected=${rowsDetected}, extracted=${rows.length}, rejected=${rowsRejected}`);
    if (!rows.length) throw new Error('No GL transaction rows extracted from file');

    const detectedYears = [...new Set(rows.map((r) => r.fiscal_year))].sort((a, b) => a - b);
    return { rows, detectedYears };
  }

  // ── Validation: only reject rows that would fail NOT NULL DB constraints ────
  async validateRows(rows) {
    let rejected = 0;
    const valid = rows.filter((row) => {
      if (!row.transaction_date) { rejected++; return false; }
      if (!row.account_name && !row.account_number) { rejected++; return false; }
      return true;
    });
    if (rejected > 0) this.logger.warn(`validateRows: rejected ${rejected} rows`);
    return valid;
  }

  transformRows(rows, metadata) {
    return rows.map((row, idx) => ({
      version_id: metadata.versionId,
      company_id: metadata.companyId,
      source_file_id: metadata.documentId,

      transaction_date: row.transaction_date,
      fiscal_year: row.fiscal_year,

      account_number: row.account_number || '',
      account_name:   row.account_name   || '',
      account_type: null,

      description:  row.description  || null,
      reference:    row.reference    || null,

      debit:  Number(row.debit)  || 0,
      credit: Number(row.credit) || 0,

      category:         null,
      sub_category:     null,
      department:       null,
      class:            row.class       || null,
      location:         null,
      journal_type:     row.journal_type || null,
      transaction_type: null,
      vendor_name:      row.vendor_name  || null,

      row_number:       idx,
      transaction_hash: this.computeRowHash({ versionId: metadata.versionId, documentId: metadata.documentId, date: row.transaction_date, acct: row.account_number || row.account_name, debit: row.debit, credit: row.credit, rowNum: idx }),
      extracted_at: new Date().toISOString(),
    }));
  }

  async insertRows(rows) {
    return this.insertRowsChunked('general_ledger_entries', rows);
  }
}

module.exports = new GeneralLedgerExtractionService();
