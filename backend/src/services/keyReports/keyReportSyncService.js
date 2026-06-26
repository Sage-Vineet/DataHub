/**
 * KEY REPORTS SYNC SERVICE
 *
 * Direct extraction pipeline: NO ManualGL delegation.
 *
 * Flow:
 *   1. Extract Tax Returns       → tax_return_entries
 *   2. Extract Bank Statements   → bank_statement_entries
 *   3. Extract Profit & Loss     → profit_loss_entries
 *   4. Extract Balance Sheets    → balance_sheet_entries
 *   5. Extract General Ledger    → general_ledger_entries
 *   6. Generate Chart of Accounts (from entry tables)
 *   7. Build & persist Validation Results (from entry table row counts)
 */

const { supabase } = require('../../db');

const taxReturnExtractionService = require('./taxReturnExtractionService');
const bankStatementExtractionService = require('./bankStatementExtractionService');
const profitLossExtractionService = require('./profitLossExtractionService');
const balanceSheetExtractionService = require('./balanceSheetExtractionService');
const generalLedgerExtractionService = require('./generalLedgerExtractionService');

const { generateChartOfAccounts, validateChartOfAccounts } = require('../chartOfAccountsService');
const { replaceValidationResults } = require('./keyReportValidationService');
const keyReportService = require('./keyReportService');

function normalizeUploadBinary(data) {
  if (!data) return Buffer.alloc(0);
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.from(data);
  if (typeof data === 'object' && data.type === 'Buffer' && Array.isArray(data.data)) {
    return Buffer.from(data.data);
  }
  if (typeof data === 'string') {
    const value = data.trim();
    if (/^\\x[0-9a-f]+$/i.test(value)) return Buffer.from(value.slice(2), 'hex');
    if (/^0x[0-9a-f]+$/i.test(value)) return Buffer.from(value.slice(2), 'hex');
    return Buffer.from(value, 'base64');
  }
  return Buffer.from(String(data));
}

async function loadDocumentBuffer(document) {
  let buffer = null;

  if (document.upload_id) {
    const { data: up } = await supabase
      .from('uploads')
      .select('data')
      .eq('id', document.upload_id)
      .maybeSingle();
    if (up?.data) buffer = normalizeUploadBinary(up.data);
  }

  if (!buffer?.length && document.file_url) {
    const m = String(document.file_url).match(/\/uploads\/([0-9a-f-]{36})\/content/i);
    if (m) {
      const { data: up } = await supabase
        .from('uploads')
        .select('data')
        .eq('id', m[1])
        .maybeSingle();
      if (up?.data) buffer = normalizeUploadBinary(up.data);
    }
  }

  return buffer;
}

async function extractDocument(companyId, versionId, mapping, extractionService, logger) {
  const label = `[${mapping.reportCategory}] "${mapping.fileName || mapping.documentId}"`;
  try {
    const { data: document, error: docErr } = await supabase
      .from('documents')
      .select('id, name, upload_id, file_url')
      .eq('id', mapping.documentId)
      .maybeSingle();

    if (docErr || !document) throw new Error('Document not found');

    logger.log(`  Loading file buffer for ${label}`);
    const buffer = await loadDocumentBuffer(document);

    if (!buffer?.length) throw new Error('No file data found for document');

    logger.log(`  Calling extractAndStore for ${label} (${buffer.length} bytes)`);
    const result = await extractionService.extractAndStore({
      companyId,
      versionId,
      documentId: document.id,
      fileName: document.name,
      fileBuffer: buffer,
      uploadId: document.upload_id,
    });

    if (result.success) {
      logger.log(`  ✓ ${label}: ${result.rowsExtracted} rows extracted`);
    } else {
      logger.warn(`  ✗ ${label}: ${result.error}`);
    }

    return result;
  } catch (error) {
    logger.warn(`  ✗ ${label}: ${error.message}`);
    return {
      success: false,
      fileName: mapping.fileName,
      rowsExtracted: 0,
      error: error.message,
    };
  }
}

function updateStats(stats, result) {
  if (result.success) {
    stats.success += 1;
    stats.rowsExtracted += result.rowsExtracted || 0;
  } else {
    stats.failed += 1;
  }
}

function groupMappingsByCategory(allMappings) {
  const grouped = {};
  allMappings.forEach((mapping) => {
    if (!grouped[mapping.reportCategory]) grouped[mapping.reportCategory] = [];
    grouped[mapping.reportCategory].push(mapping);
  });
  return grouped;
}

/**
 * Fetch distinct fiscal years actually present in an entry table for this version.
 * For bank_statement_entries, `yearCol` is 'statement_month' (a date) — year is
 * extracted from the first 4 chars of the ISO string.
 */
async function getDistinctYearsFromTable(table, versionId, yearCol, isDateCol) {
  const { data, error } = await supabase
    .from(table)
    .select(yearCol)
    .eq('version_id', versionId)
    .limit(10000);   // dedup in JS; 10k rows covers any realistic Key Reports dataset

  if (error || !data) return new Set();

  const years = new Set();
  for (const row of data) {
    const raw = row[yearCol];
    if (raw == null) continue;
    const year = isDateCol
      ? parseInt(String(raw).slice(0, 4), 10)   // '2024-01-01' → 2024
      : Number(raw);
    if (year >= 1990 && year <= 2100) years.add(year);
  }
  return years;
}

/**
 * Build validation result rows from what is actually in the entry tables.
 *
 * Key design decisions:
 *  - Each data type is validated INDEPENDENTLY — years detected by Tax Return
 *    do NOT generate success/warning rows for P&L or Bank Statement.
 *  - Bank statement year is derived from statement_month (a date column).
 *  - If a data type has no data AND no mapped files → "no files linked" warning.
 *  - If a data type has no data BUT has mapped files → "no data extracted" warning.
 *  - One success row per year where data actually exists — no phantom years.
 */
async function buildValidationResultsFromEntryTables(versionId, mappingsByCategory, detectedYears = [], logger = null) {
  const rows = [];

  const syncYears = Array.from(
    new Set(
      (Array.isArray(detectedYears) ? detectedYears : [])
        .map((year) => Number(year))
        .filter((year) => Number.isInteger(year) && year > 0)
    ),
  ).sort((a, b) => a - b);

  const dataTypes = [
    { key: 'tax_return', table: 'tax_return_entries', yearCol: 'tax_year', isDateCol: false },
    { key: 'bank_statement', table: 'bank_statement_entries', yearCol: 'statement_month', isDateCol: true },
    { key: 'profit_loss', table: 'profit_loss_entries', yearCol: 'fiscal_year', isDateCol: false },
    { key: 'balance_sheet', table: 'balance_sheet_entries', yearCol: 'fiscal_year', isDateCol: false },
    { key: 'general_ledger', table: 'general_ledger_entries', yearCol: 'fiscal_year', isDateCol: false },
  ];

  const labels = {
    tax_return: 'Tax Return Data',
    bank_statement: 'Bank Statement Data',
    profit_loss: 'Profit & Loss Data',
    balance_sheet: 'Balance Sheet Data',
    general_ledger: 'General Ledger Data',
  };

  for (const dt of dataTypes) {
    const label = labels[dt.key];
    const hasMappings = (mappingsByCategory[dt.key] || []).length > 0;

    // Query years actually present in this table for this version
    const yearsWithData = await getDistinctYearsFromTable(dt.table, versionId, dt.yearCol, dt.isDateCol);
    const yearsToValidate = Array.from(new Set([...syncYears, ...yearsWithData])).sort((a, b) => a - b);

    if (logger) {
      logger.log(
        `  ${label}: tableYears=[${Array.from(yearsWithData).sort((a, b) => a - b).join(', ')}], ` +
        `syncYears=[${syncYears.join(', ')}], validating=[${yearsToValidate.join(', ')}]`
      );
    }

    if (yearsToValidate.length > 0) {
      // Emit one validation row per year in the detected set so the dashboard
      // never has to infer missing years as "Queued".
      for (const year of yearsToValidate) {
        let countQuery = supabase
          .from(dt.table)
          .select('id', { count: 'exact', head: true })
          .eq('version_id', versionId);

        if (dt.isDateCol) {
          // Filter bank_statement_entries by statement_month year range
          countQuery = countQuery
            .gte(dt.yearCol, `${year}-01-01`)
            .lte(dt.yearCol, `${year}-12-31`);
        } else {
          countQuery = countQuery.eq(dt.yearCol, year);
        }

        const { count } = await countQuery;
        const rowCount = count || 0;
        const hasData = rowCount > 0;

        rows.push({
          dataType: dt.key,
          year,
          status: hasData ? 'success' : 'warning',
          severity: hasData ? 'success' : 'warning',
          message: hasData
            ? `${label} loaded successfully (${rowCount} rows${year ? ` for ${year}` : ''})`
            : hasMappings
              ? `No ${label} data extracted for ${year}.`
              : `No ${label} files linked.`,
          metadata: { rowCount, detectedYears: yearsToValidate },
        });

        if (logger) {
          logger.log(
            `    ${label} ${year}: ${hasData ? 'success' : 'warning'} ` +
            `(${rowCount} rows${hasData ? '' : hasMappings ? ', mapped file(s) present' : ', no linked files'})`
          );
        }
      }
    } else {      // No data — emit a single warning row (no year dimension since we have none)
      rows.push({
        dataType: dt.key,
        year: null,
        status: 'warning',
        severity: 'warning',
        message: hasMappings
          ? `No ${label} extracted from linked file(s)`
          : `No ${label} files linked`,
        metadata: { rowCount: 0 },
      });
    }
  }

  // Chart of Accounts validation rows are appended by the caller via
  // chartOfAccountsService.validateChartOfAccounts (richer spec checks).
  return rows;
}

async function generateFinancialTables(version, opts = {}) {
  const { } = opts; // opts reserved for future use (e.g. userId, uploadJobId)
  const companyId = version.companyId;
  const versionId = version.id;

  const logger = {
    log: (msg) => console.log(`[KeyReportSync v${version.versionNumber || versionId}] ${msg}`),
    warn: (msg) => console.warn(`[KeyReportSync v${version.versionNumber || versionId}] WARNING: ${msg}`),
    error: (msg) => console.error(`[KeyReportSync v${version.versionNumber || versionId}] ERROR: ${msg}`),
  };

  logger.log('=== Sync started ===');

  const allMappings = await keyReportService.listMappings(versionId);
  const mappingsByCategory = groupMappingsByCategory(allMappings);

  logger.log(`Files discovered: ${allMappings.length} total`);
  for (const [cat, items] of Object.entries(mappingsByCategory)) {
    if (items.length) logger.log(`  ${cat}: ${items.length} file(s) → ${items.map((m) => m.fileName || m.documentId).join(', ')}`);
  }

  const extractionResults = {
    tax_return: { success: 0, failed: 0, rowsExtracted: 0 },
    bank_statement: { success: 0, failed: 0, rowsExtracted: 0 },
    profit_loss: { success: 0, failed: 0, rowsExtracted: 0 },
    balance_sheet: { success: 0, failed: 0, rowsExtracted: 0 },
    general_ledger: { success: 0, failed: 0, rowsExtracted: 0 },
  };

  const allDetectedYears = new Set();
  const extractionErrors = [];

  // Step 1: Tax Returns
  logger.log('--- Step 1/5: Tax Returns ---');
  const taxMappings = mappingsByCategory.tax_return || [];
  logger.log(`  ${taxMappings.length} file(s) to process`);
  for (const mapping of taxMappings) {
    const result = await extractDocument(companyId, versionId, mapping, taxReturnExtractionService, logger);
    updateStats(extractionResults.tax_return, result);
    if (result.detectedYears) result.detectedYears.forEach((y) => allDetectedYears.add(y));
    if (!result.success) extractionErrors.push({ step: 'tax_return', ...result });
  }
  logger.log(`  Tax Return result: ${extractionResults.tax_return.success} succeeded, ${extractionResults.tax_return.failed} failed, ${extractionResults.tax_return.rowsExtracted} rows inserted`);

  // Step 2: Bank Statements
  logger.log('--- Step 2/5: Bank Statements ---');
  const bankMappings = mappingsByCategory.bank_statement || [];
  logger.log(`  ${bankMappings.length} file(s) to process`);
  for (const mapping of bankMappings) {
    const result = await extractDocument(companyId, versionId, mapping, bankStatementExtractionService, logger);
    updateStats(extractionResults.bank_statement, result);
    if (result.detectedYears) result.detectedYears.forEach((y) => allDetectedYears.add(y));
    if (!result.success) extractionErrors.push({ step: 'bank_statement', ...result });
  }
  logger.log(`  Bank Statement result: ${extractionResults.bank_statement.success} succeeded, ${extractionResults.bank_statement.failed} failed, ${extractionResults.bank_statement.rowsExtracted} rows inserted`);

  // Step 3: Profit & Loss
  logger.log('--- Step 3/5: Profit & Loss ---');
  const plMappings = mappingsByCategory.profit_loss || [];
  logger.log(`  ${plMappings.length} file(s) to process`);
  for (const mapping of plMappings) {
    const result = await extractDocument(companyId, versionId, mapping, profitLossExtractionService, logger);
    updateStats(extractionResults.profit_loss, result);
    if (result.detectedYears) result.detectedYears.forEach((y) => allDetectedYears.add(y));
    if (!result.success) extractionErrors.push({ step: 'profit_loss', ...result });
  }
  logger.log(`  P&L result: ${extractionResults.profit_loss.success} succeeded, ${extractionResults.profit_loss.failed} failed, ${extractionResults.profit_loss.rowsExtracted} rows inserted`);

  // Step 4: Balance Sheets
  logger.log('--- Step 4/5: Balance Sheets ---');
  const bsMappings = mappingsByCategory.balance_sheet || [];
  logger.log(`  ${bsMappings.length} file(s) to process`);
  for (const mapping of bsMappings) {
    const result = await extractDocument(companyId, versionId, mapping, balanceSheetExtractionService, logger);
    updateStats(extractionResults.balance_sheet, result);
    if (result.detectedYears) result.detectedYears.forEach((y) => allDetectedYears.add(y));
    if (!result.success) extractionErrors.push({ step: 'balance_sheet', ...result });
  }
  logger.log(`  Balance Sheet result: ${extractionResults.balance_sheet.success} succeeded, ${extractionResults.balance_sheet.failed} failed, ${extractionResults.balance_sheet.rowsExtracted} rows inserted`);

  // Step 5: General Ledger
  logger.log('--- Step 5/5: General Ledger ---');
  const glMappings = mappingsByCategory.general_ledger || [];
  logger.log(`  ${glMappings.length} file(s) to process`);
  for (const mapping of glMappings) {
    const result = await extractDocument(companyId, versionId, mapping, generalLedgerExtractionService, logger);
    updateStats(extractionResults.general_ledger, result);
    if (result.detectedYears) result.detectedYears.forEach((y) => allDetectedYears.add(y));
    if (!result.success) extractionErrors.push({ step: 'general_ledger', ...result });
  }
  logger.log(`  GL result: ${extractionResults.general_ledger.success} succeeded, ${extractionResults.general_ledger.failed} failed, ${extractionResults.general_ledger.rowsExtracted} rows inserted`);

  const years = Array.from(allDetectedYears).sort((a, b) => a - b);
  logger.log(`Detected fiscal years: [${years.join(', ')}]`);

  const totalRows = Object.values(extractionResults).reduce((sum, s) => sum + s.rowsExtracted, 0);
  logger.log(`Total rows inserted across all entry tables: ${totalRows}`);

  // Step 6: Chart of Accounts (from general_ledger_entries + balance_sheet_entries)
  logger.log('--- Step 6: Chart of Accounts ---');
  let coaSummary = null;
  try {
    coaSummary = await generateChartOfAccounts(companyId, versionId, null);
    logger.log(`  ✓ Chart of Accounts: ${coaSummary.leafCount || 0} accounts classified (${coaSummary.inserted || 0} new, ${coaSummary.updated || 0} updated, ${coaSummary.deleted || 0} removed)`);
  } catch (coaErr) {
    logger.warn(`  Chart of Accounts generation failed: ${coaErr.message}`);
    coaSummary = { error: coaErr.message, accountCount: 0 };
  }

  // Step 7: Validation Results (from entry table row counts + COA spec checks)
  logger.log('--- Step 7: Validation Results ---');
  logger.log(`  Building validation rows for years=[${years.join(', ')}]`);
  const validationRows = await buildValidationResultsFromEntryTables(versionId, mappingsByCategory, years, logger);

  // Chart of Accounts validation (null type / invalid rows / duplicates / unmapped
  // GL / multi-category). Non-fatal: a validation failure must not fail the sync.
  let coaValidation = null;
  try {
    coaValidation = await validateChartOfAccounts(companyId, versionId);
    validationRows.push(...coaValidation.rows);
    const r = coaValidation.reports;
    logger.log(
      `  ✓ COA validation: status=${coaValidation.summary.status} ` +
      `nullType=${r.nullType.length} invalid=${r.invalidRows.length} ` +
      `duplicates=${r.duplicates.length} unmappedGL=${r.unmapped.length} multiCategory=${r.multiCategory.length}`,
    );
  } catch (vErr) {
    logger.warn(`  COA validation failed: ${vErr.message}`);
  }

  await replaceValidationResults(versionId, companyId, validationRows);
  logger.log(`  ✓ ${validationRows.length} validation rows stored`);

  logger.log('=== Sync complete ===');

  const message = extractionErrors.length > 0
    ? `Sync completed with ${extractionErrors.length} extraction error(s). ${totalRows} rows inserted.`
    : `Sync completed successfully. ${totalRows} rows inserted.`;

  return {
    success: true,
    batchId: null,
    datasetVersion: null,
    years,
    extractionResults,
    coaSummary,
    errors: extractionErrors.length > 0 ? extractionErrors : null,
    summary: {
      generated: true,
      years,
      totalRowsInserted: totalRows,
      extractionResults,
      chartOfAccounts: coaSummary,
      chartOfAccountsValidation: coaValidation ? coaValidation.summary : null,
      message,
    },
    message,
  };
}

module.exports = { generateFinancialTables };
