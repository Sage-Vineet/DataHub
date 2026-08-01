/**
 * Base Extraction Service
 *
 * Abstract base class for all Key Reports extraction services.
 * Defines the common interface and utilities for document extraction.
 *
 * All document types (P&L, BS, GL, Tax, Bank) extend this class
 * and implement extract() + insertRows() to store data.
 */

const { supabase } = require("../../db");

class ExtractionServiceBase {
  constructor(dataType, tableName) {
    this.dataType = dataType; // 'profit_loss', 'balance_sheet', etc.
    this.tableName = tableName; // Database table name
    this.logger = {
      log: (msg) => console.log(`[${this.dataType}] ${msg}`),
      warn: (msg) => console.warn(`[${this.dataType}] WARNING: ${msg}`),
      error: (msg) => console.error(`[${this.dataType}] ERROR: ${msg}`),
    };
  }

  // Subclasses that can tell a genuinely bad extraction from a good one (e.g.
  // a Balance Sheet/P&L with real leaf rows but not ONE of them carrying a
  // hierarchy) override this. CONFIRMED BUG this closes: the write-time retry
  // safeguard in _extractFromExcelWithFallback only protects a single
  // extraction attempt — if BOTH retries hit the same transient failure (e.g.
  // resource contention from a concurrent sync) and still produced a flat
  // result, that bad result got written to cache and every later sync using
  // the SAME parser_version silently reused it forever, since a cache HIT
  // was never re-validated. Checking suspicion again on READ closes that gap
  // regardless of why the bad result was ever produced in the first place.
  _isExtractionSuspicious(_rows) {
    return false;
  }

  /**
   * "Hierarchy Extraction Validation" — a structural sanity check on the raw
   * rows just returned by extract() (Python or JS, cache hit or fresh),
   * before any hierarchy assembly happens downstream. Every check here uses
   * fields the extractor itself already sets from real document structure
   * (node_type / is_header / is_section_header / parent_path) — never a
   * keyword or account-name guess.
   *
   * "Leaf Used As Parent" is the specific regression tripwire for the bug
   * fixed this pass (see extract_excel.py / balanceSheetExtractionService.js
   * / profitLossExtractionService.js): a row whose parent_path contains the
   * account_name of another row that is itself a real leaf (has its own
   * posted amount, not a header/group) — this must always be 0 after the fix.
   * Only runs for data types that actually carry a hierarchy (rows have a
   * `parent_path` key at all) — a structural gate, not a hardcoded data-type
   * name list.
   */
  _logHierarchyExtractionValidation(rows, fileName) {
    if (!Array.isArray(rows) || !rows.length) return;
    if (!Object.prototype.hasOwnProperty.call(rows[0], "parent_path")) return;

    const isHeaderRow = (r) => Boolean(r.is_section_header) || Boolean(r.is_header) ||
      r.node_type === "hierarchy_section" || r.node_type === "hierarchy_group";

    const leafNames = new Set();
    const headerNames = new Set();
    let headerCount = 0;
    let leafCount = 0;
    let parentLinks = 0;
    let totalDepth = 0;
    let maxDepth = 0;
    for (const r of rows) {
      if (isHeaderRow(r)) { headerCount += 1; if (r.account_name) headerNames.add(r.account_name); }
      else { leafCount += 1; if (r.account_name) leafNames.add(r.account_name); }
      const path = Array.isArray(r.parent_path) ? r.parent_path.filter(Boolean) : [];
      if (path.length) {
        parentLinks += 1;
        totalDepth += path.length;
        if (path.length > maxDepth) maxDepth = path.length;
      }
    }

    let leafUsedAsParent = 0;
    let headerUsedAsParent = 0;
    let brokenPaths = 0;
    let circularPaths = 0;
    for (const r of rows) {
      const path = Array.isArray(r.parent_path) ? r.parent_path : [];
      if (path.some((label) => !label || !String(label).trim())) brokenPaths += 1;
      if (r.account_name && path.includes(r.account_name)) circularPaths += 1;
      for (const label of path) {
        if (!label) continue;
        if (label === r.account_name) continue; // already counted as circular above
        if (leafNames.has(label)) { leafUsedAsParent += 1; break; }
      }
      for (const label of path) {
        if (label && headerNames.has(label)) { headerUsedAsParent += 1; break; }
      }
    }

    const avgDepth = parentLinks ? totalDepth / parentLinks : 0;
    const valid = leafUsedAsParent === 0 && brokenPaths === 0 && circularPaths === 0;

    this.logger.log(
      `\n==============================\n` +
      `Hierarchy Extraction Validation${fileName ? ` (${fileName})` : ""}\n` +
      `==============================\n` +
      `Rows Parsed        : ${rows.length}\n` +
      `Header Nodes        : ${headerCount}\n` +
      `Leaf Nodes          : ${leafCount}\n` +
      `Parent Links        : ${parentLinks}\n` +
      `Leaf Used As Parent : ${leafUsedAsParent}\n` +
      `Header Used As Parent : ${headerUsedAsParent}\n` +
      `Average Depth       : ${avgDepth.toFixed(2)}\n` +
      `Maximum Depth       : ${maxDepth}\n` +
      `Broken Paths        : ${brokenPaths}\n` +
      `Circular Paths      : ${circularPaths}\n` +
      `Hierarchy Valid     : ${valid ? "YES" : "NO"}\n` +
      `==============================`,
    );
    if (!valid) {
      this.logger.error(
        `HIERARCHY EXTRACTION DEFECT: leafUsedAsParent=${leafUsedAsParent}, brokenPaths=${brokenPaths}, ` +
        `circularPaths=${circularPaths} in "${fileName}" — a real posted account is acting as another ` +
        `account's structural parent, or a parent_path entry is empty/self-referential. This should be ` +
        `impossible after the ancestor-stack fix; investigate this specific file.`,
      );
    }
  }

  /**
   * Main extraction pipeline
   * Called by keyReportSyncService for each linked document
   */
  async extractAndStore({
    companyId,
    versionId,
    documentId,
    fileName,
    fileBuffer,
    uploadId,
  }) {
    try {
      this.logger.log(`[${this.dataType}] Starting extraction: "${fileName}"`);

      // 1. Delete any existing rows for this version+document (idempotent re-sync)
      await this.deleteExistingRows(versionId, documentId);

      // 2. Extract raw data from file — always fresh. No cache: every sync
      //    re-parses and re-runs AI on the current file content, so a
      //    re-uploaded/changed document is guaranteed to be reflected and a
      //    repeat sync of the same document is guaranteed to be independent.
      const extractedData = await this.extract({ fileName, fileBuffer });
      const cacheHit = false;

      const rawCount = extractedData?.rows?.length || 0;
      this.logger.log(`[${this.dataType}] "${fileName}": Rows detected = ${rawCount}`);

      if (!extractedData || rawCount === 0) {
        this.logger.warn(`[${this.dataType}] No data extracted from "${fileName}"`);
        return { success: false, fileName, rowsExtracted: 0, error: 'No data found in file', cacheHit };
      }

      this._logHierarchyExtractionValidation(extractedData.rows, fileName);

      // 3. Validate (lenient — only rejects rows that would violate NOT NULL constraints)
      const validatedRows = await this.validateRows(extractedData.rows);
      const rejectedCount = rawCount - validatedRows.length;
      this.logger.log(`[${this.dataType}] "${fileName}": Rows extracted = ${validatedRows.length}, rejected = ${rejectedCount}`);

      if (!validatedRows || validatedRows.length === 0) {
        this.logger.warn(`[${this.dataType}] All ${rawCount} rows rejected for "${fileName}"`);
        return { success: false, fileName, rowsExtracted: 0, error: 'All rows failed validation' };
      }

      // 4. Transform (add version_id, company_id, hashes, etc.)
      const transformedRows = this.transformRows(validatedRows, {
        companyId,
        versionId,
        documentId,
        uploadId,
        fileName,
      });

      // Filter rows matching disallowed patterns before database insertion
      const { filteredRows, skippedLog } = this.filterRowsBeforeInsertion(transformedRows);

      if (skippedLog.length > 0) {
        skippedLog.forEach(({ value, reason }) => {
          this.logger.log(`Skipped row value: "${value}" | Reason: ${reason}`);
        });
      }

      // 5. Insert into database
      const insertResult = await this.insertRows(filteredRows);
      if (!insertResult.success) {
        throw new Error(insertResult.error || 'Insert failed');
      }

      const rowsInserted  = insertResult.rowsInserted  ?? filteredRows.length;
      const duplicates    = insertResult.duplicates     ?? 0;
      const insertRejected = insertResult.rejected      ?? 0;
      const finalCount    = await this.getRowCount(versionId);
      const detectedYears = extractedData.detectedYears || [];

      this.logger.log(
        `[${this.dataType}] "${fileName}" DONE: ` +
        `extracted=${rawCount}, validated=${validatedRows.length}, rejected=${rejectedCount}${insertRejected ? ` (+${insertRejected} rejected on insert — see warnings above)` : ''}, ` +
        `inserted=${rowsInserted}, duplicates=${duplicates}, ` +
        `years=[${detectedYears.join(',')}], tableTotal=${finalCount}`
      );

      // 6. Update mapping status
      await this.updateMappingStatus(versionId, documentId, {
        status: 'extracted',
        extractedRows: rowsInserted,
        extractedAt: new Date().toISOString(),
      });

      return {
        success: true,
        fileName,
        rowsExtracted: rowsInserted,
        rowsDetected: rawCount,
        rowsRejected: rejectedCount,
        rowsInserted,
        duplicates,
        detectedYears,
        cacheHit,
        error: null,
      };
    } catch (error) {
      this.logger.error(`[${this.dataType}] "${fileName}": ${error.message}`);

      await this.updateMappingStatus(versionId, documentId, {
        status: 'extraction_error',
        extractionError: error.message,
      }).catch(() => {});

      return {
        success: false,
        fileName,
        rowsExtracted: 0,
        error: error.message,
      };
    }
  }

  /**
   * IMPLEMENT IN SUBCLASS
   * Extract data from file buffer based on file type
   *
   * Returns: { rows: [...], detectedYears: [...] }
   */
  async extract({ fileName, fileBuffer }) {
    throw new Error('extract() must be implemented by subclass');
  }

  /**
   * IMPLEMENT IN SUBCLASS
   * Validate extracted rows for required fields and types
   *
   * Returns: validated rows or empty array if all invalid
   */
  async validateRows(rows) {
    throw new Error('validateRows() must be implemented by subclass');
  }

  /**
   * IMPLEMENT IN SUBCLASS
   * Transform rows: add metadata, compute row hashes, normalize values
   *
   * Returns: rows ready for INSERT
   */
  transformRows(rows, metadata) {
    throw new Error('transformRows() must be implemented by subclass');
  }

  /**
   * IMPLEMENT IN SUBCLASS
   * Insert rows into the appropriate table
   *
   * Returns: { success: true/false, error?: string }
   */
  async insertRows(rows) {
    throw new Error('insertRows() must be implemented by subclass');
  }

  /**
   * Utility: Compute hash of row data (for dedup)
   */
  computeRowHash(rowData) {
    const crypto = require('crypto');
    const json = JSON.stringify(rowData, Object.keys(rowData).sort());
    return crypto.createHash('md5').update(json).digest('hex');
  }

  /**
   * Utility: Update file mapping status
   */
  async updateMappingStatus(versionId, documentId, updates) {
    const { error } = await supabase
      .from('key_report_file_mappings')
      .update({
        extraction_status: updates.status,
        extracted_rows: updates.extractedRows || null,
        extraction_error: updates.extractionError || null,
        last_extracted_at: updates.extractedAt || null,
      })
      .eq('version_id', versionId)
      .eq('document_id', documentId);

    if (error) {
      this.logger.warn(`Could not update mapping status: ${error.message}`);
    }
  }

  /**
   * Utility: Detect fiscal years from data
   */
  detectYears(rows, yearField) {
    if (!Array.isArray(rows)) return [];

    const years = new Set();
    rows.forEach((row) => {
      if (row[yearField]) {
        const year = Number(row[yearField]);
        if (Number.isInteger(year) && year >= 1900 && year <= 9999) {
          years.add(year);
        }
      }
    });

    return Array.from(years).sort((a, b) => a - b);
  }

  /**
   * Utility: Delete existing rows for version+document before reinsertion
   */
  async deleteExistingRows(versionId, documentId) {
    const { error } = await supabase
      .from(this.tableName)
      .delete()
      .eq('version_id', versionId)
      .eq('source_file_id', documentId);

    if (error) {
      this.logger.warn(
        `Could not delete existing rows: ${error.message}`
      );
    }
  }

  /**
   * Utility: Get row count for version
   */
  async getRowCount(versionId) {
    const { count, error } = await supabase
      .from(this.tableName)
      .select('id', { count: 'exact', head: true })
      .eq('version_id', versionId);

    if (error) return 0;
    return count || 0;
  }

  /**
   * Filter layer before database insertion
   * Checks row string fields against patterns and returns filtered rows
   *
   * `hierarchy_level === 0` (set by balanceSheetExtractionService.js /
   * profitLossExtractionService.js for a structural heading row — a
   * recognized section header OR an unrecognized intermediate grouping
   * label, e.g. "Bank Accounts") is checked FIRST and is the general,
   * non-hardcoded signal: the extractor itself determined this row is a
   * heading from the document's own indentation/structure, not from a fixed
   * keyword list here. The keyword-pattern checks below remain as a safety
   * net for any row that predates this field or comes from an extractor that
   * doesn't set it (hierarchy_level is undefined for every other data type —
   * tax return, bank statement, GL — so this never changes their behavior).
   */
  // Shared classification core — matches a row's inspected text fields
  // against the same structural patterns filterRowsBeforeInsertion has always
  // used, but returns a `{ rowType, reason }` classification instead of a
  // bare yes/no. `rowType` is one of 'heading' | 'subtotal' | 'total' |
  // 'metadata' | null (null = no structural signal at all — a real
  // account/transaction row). Kept as ONE shared method so every subclass
  // (including one that persists every row, e.g. BalanceSheetExtractionService)
  // agrees on what counts as which — no duplicated pattern list to drift.
  _classifyStructuralRow(row) {
    // A real posted transaction (row_type === 'TRANSACTION', the GL's own
    // column — unrelated to balance_sheet_entries.row_type) is never a report
    // heading/total no matter what its account_name says. CONFIRMED BUG this
    // exemption fixes: a real client chart-of-accounts leaf can be named
    // exactly the same as a common report section label (e.g. a GL account
    // literally named "Fixed Assets") — without this check, the one real
    // transaction ever posted to such an account gets misclassified as a
    // heading, while its offsetting leg survives, leaving a permanently
    // one-sided, undetectable gap in the ledger. Checked first — this
    // exemption must win over every other signal below.
    if (row && row.row_type === 'TRANSACTION') return { rowType: null, reason: null, matchedValue: null };

    // Metadata banners (report-generation timestamps/basis labels) are often
    // extracted with hierarchy_level=0 (no real indentation of their own) —
    // check these text patterns BEFORE the hierarchy_level=0 fallback below,
    // so a report footer like "Accrual Basis <date>" is labeled 'metadata',
    // not lumped in with real structural 'heading' rows. Both are equally
    // excluded from COA generation either way — this only affects the label.
    const fieldsToInspect = [
      'account_name', 'distribution_account', 'bank_account', 'bank_name',
      'description', 'field_name', 'field_label',
    ];
    for (const field of fieldsToInspect) {
      const val = row && row[field];
      if (val === undefined || val === null) continue;
      const normalizedStr = String(val).trim().toLowerCase().replace(/\s+/g, ' ');

      if (normalizedStr.startsWith('accrual basis')) return { rowType: 'metadata', reason: 'Accrual Basis* pattern', matchedValue: val };
      if (normalizedStr.startsWith('cash basis')) return { rowType: 'metadata', reason: 'Cash Basis* pattern', matchedValue: val };
      if (normalizedStr.startsWith('report generated')) return { rowType: 'metadata', reason: 'Report Generated* pattern', matchedValue: val };
      if (normalizedStr.startsWith('generated on')) return { rowType: 'metadata', reason: 'Generated On* pattern', matchedValue: val };
    }

    if (row && row.hierarchy_level === 0) {
      return { rowType: 'heading', reason: 'Structural heading row (hierarchy_level=0)', matchedValue: row.account_name ?? null };
    }

    for (const field of fieldsToInspect) {
      const val = row && row[field];
      if (val === undefined || val === null) continue;
      const normalizedStr = String(val).trim().toLowerCase().replace(/\s+/g, ' ');

      if (normalizedStr.startsWith('total for ')) return { rowType: 'subtotal', reason: 'Total for * pattern', matchedValue: val };

      const exactTotals = ['total assets', 'total liabilities', 'total equity', 'total income', 'total expenses'];
      if (exactTotals.includes(normalizedStr)) return { rowType: 'total', reason: `Exact total pattern: "${val}"`, matchedValue: val };

      const exactSectionHeaders = [
        'assets', 'current assets', 'other current assets', 'fixed assets',
        'liabilities', 'current liabilities', 'long-term liabilities', 'long term liabilities',
        'equity', 'income', 'expenses',
      ];
      if (exactSectionHeaders.includes(normalizedStr)) return { rowType: 'heading', reason: `Exact section header pattern: "${val}"`, matchedValue: val };
    }

    return { rowType: null, reason: null, matchedValue: null };
  }

  /**
   * Filter layer before database insertion — DROPS any row
   * _classifyStructuralRow flags as non-account (heading/subtotal/total/
   * metadata). This is the default for every data type EXCEPT Balance Sheet,
   * which overrides this method (see balanceSheetExtractionService.js) to
   * persist every row with its classification instead of dropping any.
   */
  filterRowsBeforeInsertion(rows) {
    if (!Array.isArray(rows)) return { filteredRows: [], skippedLog: [] };

    const filteredRows = [];
    const skippedLog = [];

    for (const row of rows) {
      const { rowType, reason, matchedValue } = this._classifyStructuralRow(row);
      if (rowType) {
        skippedLog.push({ value: matchedValue, reason, row });
      } else {
        filteredRows.push(row);
      }
    }

    return { filteredRows, skippedLog };
  }

  /**
   * Utility: Chunked insert with inserted/duplicate count reporting.
   * Each subclass's insertRows() delegates here to avoid duplicating this logic.
   *
   * @param {string} tableName  - Target table
   * @param {object[]} rows     - Fully transformed rows ready for INSERT
   * @returns {{ success: boolean, rowsInserted: number, duplicates: number, error?: string }}
   */
  /**
   * Insert one chunk, isolating any row(s) the database rejects (e.g. a
   * numeric field overflow from one garbled source cell) instead of losing
   * the WHOLE chunk's otherwise-valid rows to a single bad one. Binary-splits
   * on failure — only recurses into the half that still fails — so isolating
   * one bad row out of up to 500 costs O(log n) extra round trips, not O(n).
   */
  async _insertChunkIsolating(tableName, rows) {
    if (!rows.length) return { inserted: 0, rejected: [] };
    const { error } = await supabase.from(tableName).insert(rows);
    if (!error) return { inserted: rows.length, rejected: [] };

    if (rows.length === 1) {
      this.logger.error(`Rejected row in ${tableName}: ${error.message} — ${JSON.stringify(rows[0]).slice(0, 300)}`);
      return { inserted: 0, rejected: [{ row: rows[0], error: error.message }] };
    }

    const mid = Math.floor(rows.length / 2);
    const left  = await this._insertChunkIsolating(tableName, rows.slice(0, mid));
    const right = await this._insertChunkIsolating(tableName, rows.slice(mid));
    return { inserted: left.inserted + right.inserted, rejected: [...left.rejected, ...right.rejected] };
  }

  async insertRowsChunked(tableName, rows) {
    if (!rows.length) return { success: true, rowsInserted: 0, duplicates: 0, rejected: 0 };

    const CHUNK = 500;
    let totalAttempted = 0;
    const rejectedRows = [];

    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      const { error } = await supabase.from(tableName).insert(chunk);
      if (!error) {
        totalAttempted += chunk.length;
        continue;
      }
      // Confirmed live: a single garbled cell (e.g. a value that overflows a
      // numeric(15,2) column) fails the ENTIRE chunk's insert, silently
      // discarding up to 500 otherwise-valid rows along with it. Isolate the
      // actual bad row(s) instead of giving up on the whole chunk/file.
      this.logger.warn(`Insert chunk ${Math.floor(i / CHUNK) + 1} into ${tableName} failed (${error.message}) — isolating the bad row(s) so the rest of the chunk still inserts...`);
      const result = await this._insertChunkIsolating(tableName, chunk);
      totalAttempted += result.inserted;
      rejectedRows.push(...result.rejected);
    }

    if (rejectedRows.length) {
      this.logger.warn(`${tableName}: ${rejectedRows.length} row(s) rejected during insert (see individual errors above) — every other row in the file was still inserted.`);
    }

    // Count what actually landed — catches any silent duplicates from partial unique-index overlap
    const versionId    = rows[0].version_id;
    const documentId   = rows[0].source_file_id;
    const { count: finalCount } = await supabase
      .from(tableName)
      .select('id', { count: 'exact', head: true })
      .eq('version_id', versionId)
      .eq('source_file_id', documentId);

    const rowsInserted = finalCount || totalAttempted;
    const duplicates   = Math.max(0, totalAttempted - rowsInserted);

    if (duplicates > 0) {
      this.logger.warn(`${duplicates} duplicate row(s) skipped in ${tableName} — check hash uniqueness`);
    }

    return { success: true, rowsInserted, duplicates, rejected: rejectedRows.length };
  }
}

module.exports = ExtractionServiceBase;
