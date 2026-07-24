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
// Vendor/customer are detected as separate column groups so the GL row can
// carry a typed entity_type; a bare "Name"/"Payee"/"Entity" header is ambiguous
// (QB GL exports commonly use it for either) and falls back to NAME_ALIASES.
const VENDOR_ALIASES   = ['vendor', 'vendor name', 'payee'];
const CUSTOMER_ALIASES = ['customer', 'customer name'];
const NAME_ALIASES    = ['name', 'entity'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
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

// BEGINNING_BALANCE/TOTAL_ROW rows have no real calendar date of their own —
// they need a sentinel transaction_date so they (a) join into
// key_report_date_dimension and (b) fall inside a year's date-range filter,
// now that fiscal_year no longer exists to tag them directly (migration 069).
// Looks ahead for the next parseable transaction date rather than only
// trusting whatever year was last seen — more accurate than the old
// currentFiscalYear-carryover for a BEGINNING_BALANCE at the very top of a
// file, before any transaction has been processed yet.
function findNextTransactionYear(raw, fromIndex, dateColIdx) {
  if (dateColIdx < 0) return null;
  for (let r = fromIndex; r < raw.length; r++) {
    const d = parseDate(raw[r][dateColIdx]);
    if (d) return parseInt(d.slice(0, 4), 10);
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
      vendor:     findColByAliases(headerRow, VENDOR_ALIASES),
      customer:   findColByAliases(headerRow, CUSTOMER_ALIASES),
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
    let currentYear = null; // in-memory only — feeds detectedYears, never persisted to the DB (date_dimension refactor, migration 069)

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
        // Prefer the upcoming transaction's year (a beginning balance precedes
        // its section's transactions) over the last-seen year, which could
        // still be a prior account's year or null at the top of the file.
        const rowYear = findNextTransactionYear(raw, i + 1, colMap.date) ?? currentYear;
        rows.push({
          row_type: 'BEGINNING_BALANCE', row_number: excelRowNum,
          account_name: firstCell, account_section: currentAccountSection,
          description: firstCell, running_balance: bal,
          year: rowYear, transaction_date: rowYear ? `${rowYear}-01-01` : null, raw_row_json: rawRowJson,
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
        // A total row follows its section's transactions, so the last-seen
        // year is the right one; only look ahead if the section had none.
        const rowYear = currentYear ?? findNextTransactionYear(raw, i + 1, colMap.date);
        rows.push({
          row_type: 'TOTAL_ROW', row_number: excelRowNum,
          account_name: firstCell, account_section: currentAccountSection,
          description: firstCell, running_balance: bal,
          year: rowYear, transaction_date: rowYear ? `${rowYear}-12-31` : null, raw_row_json: rawRowJson,
        });
        continue;
      }

      // ── TRANSACTION ──────────────────────────────────────────────────────────
      if (dateStr) {
        const year = new Date(dateStr).getUTCFullYear();
        currentYear = year;

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

        // Vendor/customer: prefer an explicitly-labeled column; a bare "Name"/
        // "Entity" header is ambiguous (QB GL uses it for either), so it falls
        // back into the vendor bucket (the more common case on expense-heavy
        // GL exports) rather than being silently discarded.
        const vendorVal   = colMap.vendor   >= 0 ? isToStr(row[colMap.vendor])   || null : null;
        const customerVal = colMap.customer >= 0 ? isToStr(row[colMap.customer]) || null : null;
        const genericNameVal = colMap.name  >= 0 ? isToStr(row[colMap.name])     || null : null;

        rows.push({
          row_type:             'TRANSACTION',
          row_number:           excelRowNum,
          transaction_date:     dateStr,
          year,
          account_section:      currentAccountSection,
          account_name:         accountName,
          account_number:       accountNum || null,
          distribution_account: distAcct,
          transaction_num:      colMap.ref    >= 0 ? isToStr(row[colMap.ref])    || null : null,
          transaction_name:     colMap.name   >= 0 ? isToStr(row[colMap.name])   || null : null,
          vendor:               vendorVal || genericNameVal || null,
          customer:             customerVal || null,
          entity_type:          vendorVal ? 'vendor' : (customerVal ? 'customer' : (genericNameVal ? 'vendor' : null)),
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

    // In-memory only, for the sync validation dashboard's "years detected"
    // summary — not persisted (date_dimension refactor, migration 069).
    const detectedYears = [...new Set(
      rows.filter((r) => r.row_type === 'TRANSACTION' && r.year).map((r) => r.year)
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

      return {
        version_id:     metadata.versionId,
        company_id:     metadata.companyId,
        source_file_id: metadata.documentId,

        // ── Row classification ────────────────────────────────────────────────
        row_type:   row.row_type || 'TRANSACTION',
        row_number: row.row_number != null ? Number(row.row_number) : null,

        // ── Date (null for non-transaction rows) ──────────────────────────────
        // fiscal_year/fiscal_month no longer persisted here (migration 069 —
        // date_dimension refactor). Year/month/quarter/month_name now come
        // exclusively from the date_id → key_report_date_dimension join,
        // populated below in _attachDateDimension. transaction_date remains
        // the column every filter/range query uses directly.
        transaction_date: transDate,

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

        // ── Entity dimension (vendor/customer/entity_type) ────────────────────
        // vendor/customer come from the JS extraction path's dedicated column
        // detection; transaction_name/name is the generic fallback the Python
        // path (and older cached extractions) may still emit.
        vendor:      row.vendor   || row.transaction_name || row.name || null,
        customer:    row.customer || null,
        entity_type: row.entity_type || (row.vendor || row.transaction_name || row.name ? 'vendor' : (row.customer ? 'customer' : null)),
        amount:             row.amount        != null ? Number(row.amount)        : null,
        debit_amount:       row.debit         != null ? Number(row.debit)         : (row.debit_amount != null ? Number(row.debit_amount) : 0),
        credit_amount:      row.credit        != null ? Number(row.credit)        : (row.credit_amount != null ? Number(row.credit_amount) : 0),
        running_balance:    row.running_balance != null ? Number(row.running_balance) : null,
        raw_row_json:       row.raw_row_json  || null,

        extracted_at: new Date().toISOString(),
      };
    });
  }

  // Resolve each row's transaction_date against date_dimension, upserting any
  // missing dates first. Degrades gracefully (rows keep date_id = null) if
  // migration 067 has not been applied yet — same pattern as the other
  // optional-migration caches in this pipeline (key_report_document_processing).
  async _attachDateDimension(rows) {
    const dates = [...new Set(rows.map((r) => r.transaction_date).filter(Boolean))];
    if (!dates.length) return rows;
    try {
      const seedRows = dates.map((d) => {
        const [y, m] = d.split('-').map(Number);
        return {
          date: d,
          year: y,
          month: m,
          quarter: Math.floor((m - 1) / 3) + 1,
          month_name: MONTH_NAMES[m - 1],
        };
      });
      const { error: upsertErr } = await supabase
        .from('key_report_date_dimension')
        .upsert(seedRows, { onConflict: 'date', ignoreDuplicates: true });
      if (upsertErr) {
        this.logger.warn(`key_report_date_dimension upsert skipped (non-fatal): ${upsertErr.message}`);
        return rows;
      }
      const { data: dimRows, error: selectErr } = await supabase
        .from('key_report_date_dimension')
        .select('id, date')
        .in('date', dates);
      if (selectErr || !dimRows) {
        this.logger.warn(`date_dimension lookup skipped (non-fatal): ${selectErr?.message}`);
        return rows;
      }
      const idByDate = new Map(dimRows.map((r) => [r.date, r.id]));
      return rows.map((r) => ({
        ...r,
        date_id: r.transaction_date ? idByDate.get(r.transaction_date) || null : null,
      }));
    } catch (err) {
      this.logger.warn(`date_dimension attach skipped (non-fatal): ${err.message}`);
      return rows;
    }
  }

  async insertRows(rows) {
    const withDates = await this._attachDateDimension(rows);
    return this.insertRowsChunked('general_ledger_entries', withDates);
  }
}

module.exports = new GeneralLedgerExtractionService();
