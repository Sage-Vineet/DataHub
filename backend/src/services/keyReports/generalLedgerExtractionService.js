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

  // GL transaction dates are calendar dates, not instants in time. Parse their
  // components directly so converting to UTC cannot move local midnight to the
  // preceding day (for example, 2025-03-31 becoming 2025-03-30).
  let match = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  let year;
  let month;
  let day;
  if (match) {
    [, year, month, day] = match.map(Number);
  } else {
    match = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/);
    if (match) {
      month = Number(match[1]);
      day = Number(match[2]);
      year = Number(match[3]);
      if (year < 100) year += year >= 70 ? 1900 : 2000;
    }
  }

  if (year != null) {
    const valid = new Date(Date.UTC(year, month - 1, day));
    if (
      valid.getUTCFullYear() === year &&
      valid.getUTCMonth() === month - 1 &&
      valid.getUTCDate() === day
    ) {
      return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
    return null;
  }

  // Last-resort support for textual Excel dates. Use local calendar components;
  // toISOString() would apply a timezone conversion and can change the date.
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
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
    // v1 cached rows may contain transaction dates shifted back by one day by
    // the former timezone-sensitive JS parser. Force a fresh extraction so a
    // re-sync cannot delete rows and then reinsert the stale shifted dates.
    this.parserVersion = 'v2-date-only';
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
    const SPLIT_ALIASES_JS = ['split', 'split account', 'account split', 'contra account', 'offset account'];

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
      split:      findColByAliases(headerRow, SPLIT_ALIASES_JS),
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
    let currentAccountSection = null;
    let currentFiscalYear = null;

    // colMap.balance and colMap.split may be -1 if not found — that is fine
    const isToStr = (v) => String(v || '').trim();

    for (let i = headerIdx + 1; i < raw.length; i++) {
      const row = raw[i];
      if (row.every((c) => !c && c !== 0)) continue; // blank row

      // 1-based Excel row number (headerIdx is 0-based; add 2 for 1-indexed + skip header)
      const excelRowNum = headerIdx + 2 + (i - headerIdx - 1);
      const rawRowJson  = JSON.stringify(row.map((v) => String(v ?? '')));
      const firstCell   = isToStr(row[0]);
      const firstLc     = firstCell.toLowerCase();
      const dateStr     = parseDate(colMap.date >= 0 ? row[colMap.date] : null);

      // ── BEGINNING BALANCE ────────────────────────────────────────────────────
      if (firstLc.includes('beginning balance')) {
        let bal = null;
        for (let c = row.length - 1; c >= 0; c--) {
          const v = parseAmount(row[c]);
          if (v !== null && v !== 0) { bal = v; break; }
        }
        rows.push({
          row_type: 'BEGINNING_BALANCE', row_number: excelRowNum,
          account_name: firstCell, account_section: currentAccountSection,
          description: firstCell, running_balance: bal,
          fiscal_year: currentFiscalYear, transaction_date: null, raw_row_json: rawRowJson,
        });
        continue;
      }

      // ── TOTAL ROW ────────────────────────────────────────────────────────────
      if (firstLc.startsWith('total')) {
        let bal = null;
        for (let c = row.length - 1; c >= 0; c--) {
          const v = parseAmount(row[c]);
          if (v !== null && v !== 0) { bal = v; break; }
        }
        rows.push({
          row_type: 'TOTAL_ROW', row_number: excelRowNum,
          account_name: firstCell, account_section: currentAccountSection,
          description: firstCell, running_balance: bal,
          fiscal_year: currentFiscalYear, transaction_date: null, raw_row_json: rawRowJson,
        });
        continue;
      }

      // ── TRANSACTION ──────────────────────────────────────────────────────────
      if (dateStr) {
        const fiscalYear = new Date(dateStr).getFullYear();
        currentFiscalYear = fiscalYear;

        const accountName = isToStr(colMap.account    >= 0 ? row[colMap.account]    : null);
        const accountNum  = isToStr(colMap.accountNum >= 0 ? row[colMap.accountNum] : null);
        const distAcct    = accountName || currentAccountSection || '';

        let rawAmount = colMap.amount >= 0 ? parseAmount(row[colMap.amount]) : null;
        let debit     = colMap.debit  >= 0 ? parseAmount(row[colMap.debit])  || 0 : 0;
        let credit    = colMap.credit >= 0 ? parseAmount(row[colMap.credit]) || 0 : 0;

        if (colMap.debit < 0 && colMap.credit < 0 && rawAmount !== null) {
          debit  = rawAmount >= 0 ? rawAmount : 0;
          credit = rawAmount <  0 ? Math.abs(rawAmount) : 0;
        } else if (rawAmount === null) {
          rawAmount = debit - credit || null;
        }

        rows.push({
          row_type:             'TRANSACTION',
          row_number:           excelRowNum,
          transaction_date:     dateStr,
          fiscal_year:          fiscalYear,
          account_section:      currentAccountSection,
          account_name:         accountName,
          account_number:       accountNum || null,
          distribution_account: distAcct,
          transaction_num:      colMap.ref    >= 0 ? isToStr(row[colMap.ref])    || null : null,
          transaction_name:     colMap.name   >= 0 ? isToStr(row[colMap.name])   || null : null,
          memo_description:     colMap.desc   >= 0 ? isToStr(row[colMap.desc])   || null : null,
          split_account:        colMap.split  >= 0 ? isToStr(row[colMap.split])  || null : null,
          amount:               rawAmount,
          running_balance:      colMap.balance >= 0 ? parseAmount(row[colMap.balance]) : null,
          description:          colMap.desc   >= 0 ? isToStr(row[colMap.desc])   || null : null,
          reference:            colMap.ref    >= 0 ? isToStr(row[colMap.ref])    || null : null,
          debit,
          credit,
          journal_type:         colMap.type   >= 0 ? isToStr(row[colMap.type])   || null : null,
          class:                colMap.class_ >= 0 ? isToStr(row[colMap.class_]) || null : null,
          raw_row_json:         rawRowJson,
        });
        continue;
      }

      // ── ACCOUNT HEADER ───────────────────────────────────────────────────────
      // Account headers (e.g., "Business Checking", "Business Money Market") are
      // used ONLY to set the currentAccountSection for subsequent transactions.
      // They are NOT saved to the database—only the section name is retained for
      // context. This prevents hundreds of non-transaction rows from cluttering
      // the general_ledger_entries table.
      if (firstCell) {
        currentAccountSection = firstCell;
        // DO NOT PUSH ACCOUNT_HEADER to rows — it's not a transaction.
        // The currentAccountSection will be used as account_section for
        // subsequent transaction rows.
      }
    }

    this.logger.log(`  "${fileName}": extracted=${rows.length} rows (all types)`);
    if (!rows.length) throw new Error('No GL rows extracted from file');

    const detectedYears = [...new Set(
      rows.filter((r) => r.row_type === 'TRANSACTION' && r.fiscal_year).map((r) => r.fiscal_year)
    )].sort((a, b) => a - b);
    return { rows, detectedYears };
  }

  // ── Validation ───────────────────────────────────────────────────────────────
  // Accept all row types. Only reject rows that carry no identifiable content at all.
  async validateRows(rows) {
    let rejected = 0;
    const valid = rows.filter((row) => {
      const rowType = row.row_type || 'TRANSACTION';
      // TRANSACTION rows must have a date
      if (rowType === 'TRANSACTION' && !row.transaction_date) { rejected++; return false; }
      // Every row must have at least one content field
      const acctName = row.distribution_account || row.account_name || '';
      if (!row.account_section && !acctName && !row.memo_description && !row.memo) {
        rejected++;
        return false;
      }
      return true;
    });
    if (rejected > 0) this.logger.warn(`validateRows: rejected ${rejected} rows`);
    return valid;
  }

  transformRows(rows, metadata) {
    return rows.map((row) => {
      const transDate = row.transaction_date || null;
      const fiscalMonth = transDate
        ? parseInt(String(transDate).slice(5, 7), 10) || null
        : null;
      // Guarantee fiscal_year is populated whenever a transaction_date exists.
      // Keep the extractor's fiscal_year if present; otherwise derive it from the
      // date's year. A NULL fiscal_year on a dated row is the root cause of the
      // final fiscal year being dropped from the generated Trial Balance /
      // Balance Sheet — the year-enumeration bounds ignore NULL fiscal_year rows.
      const fiscalYear = row.fiscal_year != null
        ? Number(row.fiscal_year)
        : (transDate ? (parseInt(String(transDate).slice(0, 4), 10) || null) : null);

      return {
        version_id:     metadata.versionId,
        company_id:     metadata.companyId,
        source_file_id: metadata.documentId,

        // ── Row classification ────────────────────────────────────────────────
        row_type:   row.row_type || 'TRANSACTION',
        row_number: row.row_number != null ? Number(row.row_number) : null,

        // ── Date / year / month (null for non-transaction rows) ───────────────
        transaction_date: transDate,
        fiscal_year:      fiscalYear,
        fiscal_month:     fiscalMonth,

        // ── Account identity ──────────────────────────────────────────────────
        account_section: row.account_section || null,
        // New canonical column: account_name replaces distribution_account.
        // distribution_account (from extraction) takes priority over the legacy
        // account_name field that the Python extractor also emits.
        account_name:    row.distribution_account || row.account_name || null,
        account_number:  row.account_number || null,

        // ── Raw GL columns ────────────────────────────────────────────────────
        transaction_type:   row.transaction_type || null,
        transaction_number: row.transaction_num  || row.transaction_number || row.reference || null,
        memo:               row.memo_description || row.memo || row.description || null,
        split_account:      row.split_account    || null,
        amount:             row.amount        != null ? Number(row.amount)        : null,
        debit_amount:       row.debit         != null ? Number(row.debit)         : (row.debit_amount != null ? Number(row.debit_amount) : 0),
        credit_amount:      row.credit        != null ? Number(row.credit)        : (row.credit_amount != null ? Number(row.credit_amount) : 0),
        running_balance:    row.running_balance != null ? Number(row.running_balance) : null,
        raw_row_json:       row.raw_row_json  || null,

        extracted_at: new Date().toISOString(),
      };
    });
  }

  async insertRows(rows) {
    return this.insertRowsChunked('general_ledger_entries', rows);
  }
}

module.exports = new GeneralLedgerExtractionService();
