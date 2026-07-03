/**
 * Base Extraction Service
 *
 * Abstract base class for all Key Reports extraction services.
 * Defines the common interface and utilities for document extraction.
 *
 * All document types (P&L, BS, GL, Tax, Bank) extend this class
 * and implement extract() + insertRows() to store data.
 */

const crypto = require("crypto");
const { supabase } = require("../../db");

// Bump either version to invalidate all cached extractions (e.g. after changing a
// parser or the extract() logic). The cache identity includes both.
const DEFAULT_PARSER_VERSION = "v1";
const DEFAULT_EXTRACTION_VERSION = "v1";
// Skip caching extractions larger than this many rows (avoids giant JSONB blobs
// for very large General Ledgers). Such files simply re-extract each run.
const MAX_CACHEABLE_ROWS = 50000;

function docCacheEnabled() {
  return String(process.env.KEY_REPORT_DOC_CACHE || "on").toLowerCase() !== "off";
}

class ExtractionServiceBase {
  constructor(dataType, tableName) {
    this.dataType = dataType; // 'profit_loss', 'balance_sheet', etc.
    this.tableName = tableName; // Database table name
    // Cache-identity versions — a subclass can override if it changes its parser
    // or extraction algorithm so stale cache entries are not reused.
    this.parserVersion = DEFAULT_PARSER_VERSION;
    this.extractionVersion = DEFAULT_EXTRACTION_VERSION;
    this.logger = {
      log: (msg) => console.log(`[${this.dataType}] ${msg}`),
      warn: (msg) => console.warn(`[${this.dataType}] WARNING: ${msg}`),
      error: (msg) => console.error(`[${this.dataType}] ERROR: ${msg}`),
    };
  }

  // ── Document extraction cache ───────────────────────────────────────────────
  // The expensive work is extract() (download already done by the caller, then
  // parse + Gemini/Python AI). Its output is version-agnostic raw rows, so we
  // cache it by the file's content fingerprint and reuse across re-syncs and
  // version duplication. On a hit we skip parse+AI entirely and only run the
  // cheap per-version validate/transform/insert.

  _fingerprint(fileBuffer) {
    return crypto.createHash("sha256").update(fileBuffer).digest("hex");
  }

  async _readExtractionCache(companyId, documentId, fingerprint) {
    if (!docCacheEnabled() || !companyId || !documentId) return null;
    try {
      const { data, error } = await supabase
        .from("key_report_document_processing")
        .select("extracted_data, row_count")
        .eq("company_id", companyId)
        .eq("document_id", documentId)
        .eq("document_fingerprint", fingerprint)
        .eq("data_type", this.dataType)
        .eq("parser_version", this.parserVersion)
        .eq("extraction_version", this.extractionVersion)
        .eq("processing_status", "completed")
        .maybeSingle();
      if (error || !data) return null;
      const ed = data.extracted_data;
      if (!ed || !Array.isArray(ed.rows)) return null;
      return ed;
    } catch {
      // Table not present (migration 065 not applied) or any other error → miss.
      return null;
    }
  }

  async _writeExtractionCache(companyId, documentId, fingerprint, fileName, extractedData) {
    if (!docCacheEnabled() || !companyId || !documentId) return;
    const rows = extractedData?.rows || [];
    if (rows.length > MAX_CACHEABLE_ROWS) return;
    try {
      await supabase
        .from("key_report_document_processing")
        .upsert(
          {
            company_id: companyId,
            document_id: documentId,
            data_type: this.dataType,
            document_fingerprint: fingerprint,
            parser_version: this.parserVersion,
            extraction_version: this.extractionVersion,
            file_name: fileName || null,
            processing_status: "completed",
            extracted_data: extractedData,
            row_count: rows.length,
            processing_completed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
          { onConflict: "company_id,document_id,document_fingerprint,data_type,parser_version,extraction_version" },
        );
    } catch {
      // Non-fatal — caching is an optimization, never a correctness dependency.
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

      // 2. Extract raw data from file — reuse cached extract() output when the
      //    file content is unchanged (skips download-independent parse + AI).
      const fingerprint = this._fingerprint(fileBuffer);
      let extractedData = await this._readExtractionCache(companyId, documentId, fingerprint);
      const cacheHit = Boolean(extractedData);
      if (cacheHit) {
        this.logger.log(`[${this.dataType}] "${fileName}": cache HIT — reusing ${extractedData.rows.length} extracted row(s) (skipped parse + AI)`);
      } else {
        extractedData = await this.extract({ fileName, fileBuffer });
      }

      const rawCount = extractedData?.rows?.length || 0;
      this.logger.log(`[${this.dataType}] "${fileName}": Rows detected = ${rawCount}${cacheHit ? ' (cached)' : ''}`);

      if (!extractedData || rawCount === 0) {
        this.logger.warn(`[${this.dataType}] No data extracted from "${fileName}"`);
        return { success: false, fileName, rowsExtracted: 0, error: 'No data found in file', cacheHit };
      }

      // Persist the fresh extraction so the next re-sync / duplicated version
      // reuses it. Only on a miss; version-agnostic by fingerprint.
      if (!cacheHit) {
        await this._writeExtractionCache(companyId, documentId, fingerprint, fileName, extractedData);
      }

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
      const finalCount    = await this.getRowCount(versionId);
      const detectedYears = extractedData.detectedYears || [];

      this.logger.log(
        `[${this.dataType}] "${fileName}" DONE: ` +
        `extracted=${rawCount}, validated=${validatedRows.length}, rejected=${rejectedCount}, ` +
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
   */
  filterRowsBeforeInsertion(rows) {
    if (!Array.isArray(rows)) return { filteredRows: [], skippedLog: [] };

    const filteredRows = [];
    const skippedLog = [];

    const matchesFilterPatterns = (val) => {
      if (val === null || val === undefined) return null;
      const str = String(val).trim();
      const lowerStr = str.toLowerCase();
      
      // Normalize multiple spaces to single spaces
      const normalizedStr = lowerStr.replace(/\s+/g, ' ');

      // Headers
      if (normalizedStr.startsWith('accrual basis')) {
        return 'Accrual Basis* pattern';
      }
      if (normalizedStr.startsWith('cash basis')) {
        return 'Cash Basis* pattern';
      }
      if (normalizedStr.startsWith('report generated')) {
        return 'Report Generated* pattern';
      }
      if (normalizedStr.startsWith('generated on')) {
        return 'Generated On* pattern';
      }

      // Totals
      if (normalizedStr.startsWith('total for ')) {
        return 'Total for * pattern';
      }
      
      const exactTotals = [
        'total assets',
        'total liabilities',
        'total equity',
        'total income',
        'total expenses'
      ];
      if (exactTotals.includes(normalizedStr)) {
        return `Exact total pattern: "${str}"`;
      }

      // Section Headers
      const exactSectionHeaders = [
        'assets',
        'current assets',
        'other current assets',
        'fixed assets',
        'liabilities',
        'current liabilities',
        'long-term liabilities',
        'long term liabilities',
        'equity',
        'income',
        'expenses'
      ];
      if (exactSectionHeaders.includes(normalizedStr)) {
        return `Exact section header pattern: "${str}"`;
      }

      return null;
    };

    // The fields to inspect in a row
    const fieldsToInspect = [
      'account_name',
      'distribution_account',
      'bank_account',
      'bank_name',
      'description',
      'field_name',
      'field_label'
    ];

    for (const row of rows) {
      let skipReason = null;
      let matchedValue = null;

      for (const field of fieldsToInspect) {
        if (row && row[field] !== undefined && row[field] !== null) {
          const reason = matchesFilterPatterns(row[field]);
          if (reason) {
            skipReason = reason;
            matchedValue = row[field];
            break;
          }
        }
      }

      if (skipReason) {
        skippedLog.push({
          value: matchedValue,
          reason: skipReason,
          row
        });
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
  async insertRowsChunked(tableName, rows) {
    if (!rows.length) return { success: true, rowsInserted: 0, duplicates: 0 };

    const CHUNK = 500;
    let totalAttempted = 0;

    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      totalAttempted += chunk.length;
      const { error } = await supabase.from(tableName).insert(chunk);
      if (error) {
        this.logger.error(`Insert chunk ${Math.floor(i / CHUNK) + 1} into ${tableName} failed: ${error.message}`);
        return { success: false, rowsInserted: 0, duplicates: 0, error: error.message };
      }
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

    return { success: true, rowsInserted, duplicates };
  }
}

module.exports = ExtractionServiceBase;
