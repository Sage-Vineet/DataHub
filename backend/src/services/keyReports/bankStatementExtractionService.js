/**
 * Bank Statement Extraction Service
 *
 * Handles TWO types of output from bankStatementExtractor.js:
 *
 *  A) Transaction-level (Excel files):
 *     Each statement has a `transactions` array → emit one row per transaction.
 *
 *  B) Summary-level (PDF files via Gemini):
 *     Each statement has deposits/withdrawals/ending_balance but NO transactions.
 *     → Emit TWO rows per statement:
 *         • One "Deposits" row  (amount = +deposits)
 *         • One "Withdrawals" row (amount = -withdrawals)
 *
 * This ensures bank_statement_entries is populated regardless of file type.
 */

const { supabase } = require('../../db');
const ExtractionServiceBase = require('./extractionService.base');
const {
  extractBankStatementsFromPdfBase64,
  extractBankStatementsFromExcelBuffer,
  extractBankStatementsFromExcelViaGemini,
} = require('../bankStatementExtractor');
// NOTE: pythonBridge is deliberately NOT imported here. Bank statements are read
// by Gemini; `extract_excel.py` is no longer part of this document type's path.

function isoDateToMonthStart(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

function parseAmount(v) {
  if (v == null || v === '') return 0;
  const s = String(v).replace(/[$,\s]/g, '');
  if (/^\([\d.]+\)$/.test(s)) return -(parseFloat(s.slice(1, -1)) || 0);
  return parseFloat(s) || 0;
}

/** Convert raw statement objects → bank_statement_entries rows */
function statementsToRows(statements) {
  const rows = [];

  for (const stmt of statements) {
    const statementDate = stmt.period_end || stmt.period_start || null;
    const statementMonth = isoDateToMonthStart(statementDate);

    if (!statementDate || !statementMonth) {
      console.warn(`[BankExtractor] Skipping statement with no date: bank="${stmt.bank_name}"`);
      continue;
    }

    const bankAccount = (stmt.bank_name || stmt.account_name || 'Unknown').trim();

    // Case A: Transaction-level data (Excel)
    if (Array.isArray(stmt.transactions) && stmt.transactions.length > 0) {
      for (const txn of stmt.transactions) {
        const txnDate = txn.date || statementDate;
        if (!txnDate) continue;

        rows.push({
          statement_date:  statementDate,
          statement_month: statementMonth,
          bank_account:    bankAccount,
          bank_name:       (stmt.bank_name_clean || stmt.bank_name || '').trim() || null,
          account_type:    null,
          transaction_date: txnDate,
          description:     txn.description?.trim() || null,
          reference:       txn.reference?.trim()   || null,
          amount:          parseAmount(txn.amount),
          transaction_type: txn.type || null,
          running_balance: txn.balance != null ? parseAmount(txn.balance) : null,
          statement_year:  new Date(statementDate).getFullYear(),
        });
      }
      continue;
    }

    // Case B: Summary-level data (Gemini PDF) — no transactions array
    // Emit deposits and withdrawals as two synthetic rows
    const deposits    = parseAmount(stmt.deposits);
    const withdrawals = parseAmount(stmt.withdrawals);
    const fees        = parseAmount(stmt.fees || 0);
    const endingBal   = parseAmount(stmt.ending_balance);
    const stmtYear    = new Date(statementDate).getFullYear();

    if (deposits !== 0) {
      rows.push({
        statement_date:   statementDate,
        statement_month:  statementMonth,
        bank_account:     bankAccount,
        bank_name:        (stmt.bank_name_clean || stmt.bank_name || '').trim() || null,
        account_type:     null,
        transaction_date: statementDate,
        description:      `Total deposits for period ending ${statementDate}`,
        reference:        null,
        amount:           deposits,
        transaction_type: 'Deposit',
        running_balance:  endingBal,
        statement_year:   stmtYear,
      });
    }

    if (withdrawals !== 0 || fees !== 0) {
      rows.push({
        statement_date:   statementDate,
        statement_month:  statementMonth,
        bank_account:     bankAccount,
        bank_name:        (stmt.bank_name_clean || stmt.bank_name || '').trim() || null,
        account_type:     null,
        transaction_date: statementDate,
        description:      `Total withdrawals${fees ? ' & fees' : ''} for period ending ${statementDate}`,
        reference:        null,
        amount:           -(withdrawals + fees),
        transaction_type: 'Withdrawal',
        running_balance:  endingBal,
        statement_year:   stmtYear,
      });
    }

    // If both deposits and withdrawals are 0 but we have ending balance, emit one summary row
    if (deposits === 0 && withdrawals === 0) {
      rows.push({
        statement_date:   statementDate,
        statement_month:  statementMonth,
        bank_account:     bankAccount,
        bank_name:        (stmt.bank_name_clean || stmt.bank_name || '').trim() || null,
        account_type:     null,
        transaction_date: statementDate,
        description:      `Statement summary for period ending ${statementDate}`,
        reference:        null,
        amount:           endingBal,
        transaction_type: 'Summary',
        running_balance:  endingBal,
        statement_year:   stmtYear,
      });
    }
  }

  return rows;
}

class BankStatementExtractionService extends ExtractionServiceBase {
  constructor() {
    super('bank_statement', 'bank_statement_entries');
    // v2-pdf-gemini-direct: bank statement PDFs now go straight to Gemini (the
    // Python text/OCR primary path was removed for the PDF branch; Excel/CSV is
    // unchanged). Bump so any PDF extraction cached under the old Python-first
    // flow is discarded and re-run through Gemini.
    this.parserVersion = 'v2-pdf-gemini-direct';
  }

  async extract({ fileName, fileBuffer }) {
    const ext = (fileName || '').toLowerCase().split('.').pop();
    this.logger.log(`Processing bank statement "${fileName}" (type=${ext})`);

    if (['xlsx', 'xls', 'csv'].includes(ext)) {
      return this._extractFromExcel(fileBuffer, fileName);
    }
    if (ext === 'pdf') {
      return this._extractFromPdf(fileBuffer, fileName);
    }
    throw new Error(`Unsupported bank statement file type: .${ext}`);
  }

  // ── Excel: Python primary, legacy extractor fallback ───────────────────────
  /**
   * Reads a bank statement spreadsheet.
   *
   * GEMINI IS THE READER. Bank statements — like tax returns — are interpreted
   * by the Gemini API, not by the Python extractor or the header-matching JS
   * parser. Both of those were rule-based: `extract_excel.py` and
   * `detectColumnMap()` recognise a fixed vocabulary of column headings, so any
   * layout nobody anticipated (merged headers, a preamble block above the
   * table, signed single-amount columns, several accounts stacked in one sheet)
   * was silently mis-parsed or dropped. Gemini reads the sheet as a document
   * and applies the same prompt, balance self-correction and account-number
   * verification as the PDF path, so a statement yields identical structured
   * output whether it arrives as PDF or XLSX.
   *
   * The deterministic parser is retained ONLY as a last resort for when Gemini
   * is unreachable or unconfigured — losing an upload entirely because a
   * third-party API had a bad minute would be worse than a degraded parse. It
   * never runs while Gemini is working, and it logs loudly when it does.
   */
  async _extractFromExcel(fileBuffer, fileName) {
    let geminiError = null;

    try {
      const statements = await extractBankStatementsFromExcelViaGemini(fileBuffer, fileName);

      if (statements && statements.length > 0) {
        const rows = statementsToRows(statements);
        this.logger.log(
          `Gemini read ${statements.length} statement(s) → ${rows.length} rows from "${fileName}"`
        );
        if (rows.length > 0) {
          const detectedYears = [
            ...new Set(rows.map((r) => r.statement_year).filter(Boolean)),
          ].sort((a, b) => a - b);
          return { rows, detectedYears };
        }
        this.logger.warn(`Gemini returned statements with no parseable dates for "${fileName}"`);
      } else {
        this.logger.warn(`Gemini found no bank statements in "${fileName}"`);
      }
    } catch (err) {
      geminiError = err;
      this.logger.warn(`Gemini extraction failed for "${fileName}": ${err.message}`);
    }

    // ── Last-resort deterministic fallback ────────────────────────────────
    this.logger.warn(
      `Falling back to the rule-based Excel parser for "${fileName}" — ` +
        `Gemini did not return usable data${geminiError ? ` (${geminiError.message})` : ''}. ` +
        'Column-heading matching is far less tolerant of unusual layouts; ' +
        'check GEMINI_API_KEY and the extraction logs.'
    );

    const statements = await extractBankStatementsFromExcelBuffer(fileBuffer, fileName);
    if (!statements || statements.length === 0) {
      throw new Error(
        geminiError
          ? `Could not read bank statements from "${fileName}" (Gemini: ${geminiError.message})`
          : `No bank statements found in "${fileName}"`
      );
    }

    const rows = statementsToRows(statements);
    this.logger.log(`Fallback parser produced ${rows.length} rows from "${fileName}"`);
    if (rows.length === 0) throw new Error('Bank statements had no parseable date data');

    const detectedYears = [...new Set(rows.map((r) => r.statement_year).filter(Boolean))].sort((a, b) => a - b);
    return { rows, detectedYears };
  }

  // ── PDF: read DIRECTLY by Gemini ────────────────────────────────────────────
  // Bank statement PDFs are intentionally NOT routed through the Python
  // text/OCR path — they go straight to Gemini, which handles the wide variety
  // of bank layouts (multi-column, scanned, summary-only) far more reliably.
  // (Excel/CSV bank files still use the Python-primary path in _extractFromExcel.)
  async _extractFromPdf(fileBuffer, fileName) {
    this.logger.log(`Parsing bank statement PDF "${fileName}" directly via Gemini`);
    const statements = await extractBankStatementsFromPdfBase64(fileBuffer.toString('base64'), fileName);
    this.logger.log(`Gemini PDF parser returned ${statements.length} statement(s)`);
    if (!statements || statements.length === 0) throw new Error('No bank statements found in PDF');

    const rows = statementsToRows(statements);
    this.logger.log(`Converted ${statements.length} statement(s) → ${rows.length} rows`);
    if (rows.length === 0) throw new Error('Bank statements had no parseable date data');

    const detectedYears = [...new Set(rows.map((r) => r.statement_year).filter(Boolean))].sort((a, b) => a - b);
    return { rows, detectedYears };
  }

  // ── Validation: only reject rows with missing NOT NULL fields ───────────────
  async validateRows(rows) {
    let rejected = 0;
    const valid = rows.filter((row) => {
      if (!row.transaction_date) { rejected++; return false; }
      if (!row.statement_date)   { rejected++; return false; }
      if (!row.statement_month)  { rejected++; return false; }
      if (!row.bank_account)     { rejected++; return false; }
      return true;
    });
    if (rejected > 0) this.logger.warn(`validateRows: rejected ${rejected} rows`);
    return valid;
  }

  transformRows(rows, metadata) {
    return rows.map((row) => ({
      version_id:   metadata.versionId,
      company_id:   metadata.companyId,
      source_file_id: metadata.documentId,

      statement_date:  row.statement_date,
      statement_month: row.statement_month,

      bank_account: row.bank_account.trim(),
      bank_name:    row.bank_name    || null,
      account_type: row.account_type || null,

      transaction_date: row.transaction_date,
      description:      row.description || null,
      reference:        row.reference   || null,

      amount:           Number(row.amount) || 0,
      transaction_type: row.transaction_type || null,
      running_balance:  row.running_balance != null ? Number(row.running_balance) : null,

      extracted_at: new Date().toISOString(),
    }));
  }

  async insertRows(rows) {
    if (!rows.length) return { success: true };
    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      const { error } = await supabase.from('bank_statement_entries').insert(chunk);
      if (error) {
        this.logger.error(`Insert chunk failed: ${error.message}`);
        return { success: false, error: error.message };
      }
    }
    this.logger.log(`Inserted ${rows.length} rows into bank_statement_entries`);
    return { success: true };
  }
}

module.exports = new BankStatementExtractionService();
