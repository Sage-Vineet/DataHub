/**
 * Tax Return Extraction Service
 *
 * Uses parseTaxReturnWithGemini() — a dedicated Gemini prompt that returns
 * { fields: [...], detectedYears: [...] } with IRS form field data.
 *
 * The old parsePdfWithGemini('tax_return') call was incorrect because
 * parsePdfWithGemini only supports balance_sheet/profit_and_loss/cash_flow
 * and returns a {rows} tree, not {fields} for tax data.
 */

const { supabase } = require('../../db');
const ExtractionServiceBase = require('./extractionService.base');
const { parseTaxReturnWithGemini } = require('../geminiFinancialParser');

class TaxReturnExtractionService extends ExtractionServiceBase {
  constructor() {
    super('tax_return', 'tax_return_entries');
    // v2-gemini-direct: PDFs now go straight to Gemini (the Python text/OCR
    // primary path was removed for tax returns). Bump so any extraction cached
    // under the old Python-first flow is discarded and re-run through Gemini.
    this.parserVersion = 'v2-gemini-direct';
  }

  async extract({ fileName, fileBuffer }) {
    // Tax return PDFs are read DIRECTLY by Gemini — the Python text/OCR path is
    // intentionally not used for this document type (IRS forms are field-based,
    // not tabular, and the Gemini prompt is purpose-built for them).
    return this._extractWithGemini(fileBuffer, fileName);
  }

  async _extractWithGemini(fileBuffer, fileName) {
    this.logger.log(`Parsing tax return "${fileName}" via Gemini`);

    const { fields, detectedYears } = await parseTaxReturnWithGemini(fileBuffer, fileName);

    if (!fields || fields.length === 0) {
      throw new Error('Gemini returned no tax fields from this file');
    }

    this.logger.log(`Gemini extracted ${fields.length} fields, years: [${detectedYears.join(', ')}]`);

    return { rows: fields, detectedYears };
  }

  // ── Validation: only reject rows that violate NOT NULL constraints ───────────
  async validateRows(rows) {
    let rejected = 0;
    const valid = rows.filter((row) => {
      if (!row.field_name?.trim()) { rejected++; return false; }
      const year = Number(row.tax_year);
      if (!Number.isInteger(year) || year < 1900 || year > 2100) { rejected++; return false; }
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

      tax_year:    Number(row.tax_year),
      form_type:   row.form_type   || null,

      field_name:  String(row.field_name).trim(),
      field_label: row.field_label ? String(row.field_label).trim() : null,
      field_value: row.field_value != null ? String(row.field_value) : null,
      field_amount: row.field_amount != null ? (parseFloat(row.field_amount) || null) : null,

      line_number: row.line_number ? String(row.line_number) : null,
      schedule:    row.schedule    ? String(row.schedule)    : null,
      section:     row.section     ? String(row.section)     : null,

      extracted_at: new Date().toISOString(),
    }));
  }

  async insertRows(rows) {
    if (!rows.length) return { success: true };
    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      const { error } = await supabase.from('tax_return_entries').insert(chunk);
      if (error) {
        this.logger.error(`Insert chunk failed: ${error.message}`);
        return { success: false, error: error.message };
      }
    }
    this.logger.log(`Inserted ${rows.length} rows into tax_return_entries`);
    return { success: true };
  }
}

module.exports = new TaxReturnExtractionService();
