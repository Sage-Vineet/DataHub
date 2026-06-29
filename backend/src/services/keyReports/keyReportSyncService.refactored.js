/**
 * KEY REPORTS SYNC SERVICE (REFACTORED)
 *
 * New architecture: Direct extraction pipeline (NO ManualGL delegation)
 *
 * Flow:
 *   1. Extract Tax Returns → tax_return_entries
 *   2. Extract Bank Statements → bank_statement_entries
 *   3. Extract Profit & Loss → profit_loss_entries
 *   4. Extract Balance Sheets → balance_sheet_entries
 *   5. Extract General Ledger → general_ledger_entries
 *   6. Generate Chart of Accounts (from GL + BS)
 *   7. Build Validation Results (from entry tables)
 *   8. Generate Reporting Snapshots (for performance)
 *
 * Key Changes:
 *   ✓ NO orchestrateManualGlUpload() call
 *   ✓ NO manual_gl_staged_transactions dependency
 *   ✓ Direct extraction to entry tables
 *   ✓ Strict version isolation
 *   ✓ Validation independent of snapshots
 */

const { supabase } = require('../../db');

// Extract all 5 document types
const taxReturnExtractionService = require('./taxReturnExtractionService');
const bankStatementExtractionService = require('./bankStatementExtractionService');
const profitLossExtractionService = require('./profitLossExtractionService');
const balanceSheetExtractionService = require('./balanceSheetExtractionService');
const generalLedgerExtractionService = require('./generalLedgerExtractionService');

// Chart of Accounts generation
const { generateChartOfAccounts } = require('../chartOfAccountsService');

// Validation
const {
  buildValidationResults,
  replaceValidationResults,
} = require('./keyReportValidationService');

// Reporting snapshots (performance optimization)
const { generateReportingSnapshotsForBatch } = require('../manualGlReportingSnapshotService');

const keyReportService = require('./keyReportService');

/**
 * Main sync entry point
 * Called by keyReportService.syncVersion()
 */
async function generateFinancialTables(version, opts = {}) {
  const { userId = null } = opts;
  const companyId = version.companyId;
  const versionId = version.id;

  const logger = {
    log: (msg) => console.log(`[KeyReportSync] ${msg}`),
    warn: (msg) => console.warn(`[KeyReportSync] WARNING: ${msg}`),
    error: (msg) => console.error(`[KeyReportSync] ERROR: ${msg}`),
  };

  try {
    logger.log(`Starting sync for version ${versionId}`);

    // Load all mappings grouped by category
    const allMappings = await keyReportService.listMappings(versionId);
    const mappingsByCategory = groupMappingsByCategory(allMappings);

    const extractionResults = {
      tax_return: { success: 0, failed: 0, rowsExtracted: 0 },
      bank_statement: { success: 0, failed: 0, rowsExtracted: 0 },
      profit_loss: { success: 0, failed: 0, rowsExtracted: 0 },
      balance_sheet: { success: 0, failed: 0, rowsExtracted: 0 },
      general_ledger: { success: 0, failed: 0, rowsExtracted: 0 },
    };

    const allDetectedYears = new Set();
    const extractionErrors = [];

    // Step 1: Extract Tax Returns
    logger.log('Step 1/6: Extracting tax returns...');
    const taxMappings = mappingsByCategory.tax_return || [];
    for (const mapping of taxMappings) {
      const result = await extractDocument(
        companyId,
        versionId,
        mapping,
        taxReturnExtractionService,
        logger
      );
      updateStats(extractionResults.tax_return, result);
      if (result.detectedYears) result.detectedYears.forEach((y) => allDetectedYears.add(y));
      if (!result.success) extractionErrors.push(result);
    }

    // Step 2: Extract Bank Statements
    logger.log('Step 2/6: Extracting bank statements...');
    const bankMappings = mappingsByCategory.bank_statement || [];
    for (const mapping of bankMappings) {
      const result = await extractDocument(
        companyId,
        versionId,
        mapping,
        bankStatementExtractionService,
        logger
      );
      updateStats(extractionResults.bank_statement, result);
      if (result.detectedYears) result.detectedYears.forEach((y) => allDetectedYears.add(y));
      if (!result.success) extractionErrors.push(result);
    }

    // Step 3: Extract Profit & Loss
    logger.log('Step 3/6: Extracting profit & loss...');
    const plMappings = mappingsByCategory.profit_loss || [];
    for (const mapping of plMappings) {
      const result = await extractDocument(
        companyId,
        versionId,
        mapping,
        profitLossExtractionService,
        logger
      );
      updateStats(extractionResults.profit_loss, result);
      if (result.detectedYears) result.detectedYears.forEach((y) => allDetectedYears.add(y));
      if (!result.success) extractionErrors.push(result);
    }

    // Step 4: Extract Balance Sheets
    logger.log('Step 4/6: Extracting balance sheets...');
    const bsMappings = mappingsByCategory.balance_sheet || [];
    for (const mapping of bsMappings) {
      const result = await extractDocument(
        companyId,
        versionId,
        mapping,
        balanceSheetExtractionService,
        logger
      );
      updateStats(extractionResults.balance_sheet, result);
      if (result.detectedYears) result.detectedYears.forEach((y) => allDetectedYears.add(y));
      if (!result.success) extractionErrors.push(result);
    }

    // Step 5: Extract General Ledger
    logger.log('Step 5/6: Extracting general ledger...');
    const glMappings = mappingsByCategory.general_ledger || [];
    for (const mapping of glMappings) {
      const result = await extractDocument(
        companyId,
        versionId,
        mapping,
        generalLedgerExtractionService,
        logger
      );
      updateStats(extractionResults.general_ledger, result);
      if (result.detectedYears) result.detectedYears.forEach((y) => allDetectedYears.add(y));
      if (!result.success) extractionErrors.push(result);
    }

    const years = Array.from(allDetectedYears).sort((a, b) => a - b);
    logger.log(`Detected ${years.length} years: [${years.join(', ')}]`);

    // Step 6: Generate Chart of Accounts
    logger.log('Step 6/6: Generating chart of accounts...');
    try {
      await generateChartOfAccounts(companyId, versionId, null);
      logger.log('✓ Chart of accounts generated');
    } catch (coaErr) {
      logger.warn(`Chart of Accounts generation failed: ${coaErr.message}`);
      extractionErrors.push({
        type: 'chart_of_accounts',
        error: coaErr.message,
      });
    }

    // Step 7: Build Validation Results
    logger.log('Building validation results...');
    const validationRows = await buildValidationResultsFromEntryTables(
      companyId,
      versionId,
      mappingsByCategory,
      years
    );
    await replaceValidationResults(versionId, companyId, validationRows);
    logger.log(`✓ ${validationRows.length} validation results stored`);

    // Step 8: Generate Reporting Snapshots (optional, for performance)
    logger.log('Generating reporting snapshots (optional)...');
    // NOTE: This would use entry tables instead of staging tables
    // For now, this step is deferred to Phase 4 when we refactor snapshot generation

    logger.log('✓ Sync complete');

    return {
      success: true,
      versionId,
      years,
      extractionResults,
      errors: extractionErrors.length > 0 ? extractionErrors : null,
      message: extractionErrors.length > 0
        ? `Sync completed with ${extractionErrors.length} error(s)`
        : 'Sync completed successfully',
    };
  } catch (error) {
    logger.error(`Sync failed: ${error.message}`);
    throw error;
  }
}

/**
 * Extract a single document using the appropriate extraction service
 */
async function extractDocument(
  companyId,
  versionId,
  mapping,
  extractionService,
  logger
) {
  try {
    // Load document and file buffer
    const { data: document, error: docErr } = await supabase
      .from('documents')
      .select('id, name, upload_id, file_url')
      .eq('id', mapping.documentId)
      .maybeSingle();

    if (docErr || !document) {
      throw new Error('Document not found');
    }

    // Load file from upload
    const { data: upload, error: uploadErr } = await supabase
      .from('uploads')
      .select('id, data')
      .eq('id', document.upload_id)
      .maybeSingle();

    if (uploadErr || !upload) {
      throw new Error('Upload not found');
    }

    // Convert to buffer
    const fileBuffer = Buffer.from(upload.data, 'base64');

    // Extract and store
    const result = await extractionService.extractAndStore({
      companyId,
      versionId,
      documentId: document.id,
      fileName: document.name,
      fileBuffer,
      uploadId: document.upload_id,
    });

    return result;
  } catch (error) {
    logger.warn(`Extraction failed for ${mapping.fileName}: ${error.message}`);
    return {
      success: false,
      fileName: mapping.fileName,
      rowsExtracted: 0,
      error: error.message,
    };
  }
}

/**
 * Build validation results from entry tables (NOT from snapshots)
 */
async function buildValidationResultsFromEntryTables(
  companyId,
  versionId,
  mappingsByCategory,
  detectedYears
) {
  const rows = [];

  // For each data type, count rows per year
  const dataTypes = [
    { key: 'tax_return', table: 'tax_return_entries', yearCol: 'tax_year' },
    { key: 'bank_statement', table: 'bank_statement_entries', yearCol: null },
    { key: 'profit_loss', table: 'profit_loss_entries', yearCol: 'fiscal_year' },
    { key: 'balance_sheet', table: 'balance_sheet_entries', yearCol: 'fiscal_year' },
    { key: 'general_ledger', table: 'general_ledger_entries', yearCol: 'fiscal_year' },
  ];

  for (const dataType of dataTypes) {
    const label = {
      tax_return: 'Tax Return Data',
      bank_statement: 'Bank Statement Data',
      profit_loss: 'Profit & Loss Data',
      balance_sheet: 'Balance Sheet Data',
      general_ledger: 'General Ledger Data',
    }[dataType.key];

    for (const year of detectedYears) {
      // Count rows for this data type + year
      let query = supabase
        .from(dataType.table)
        .select('id', { count: 'exact' })
        .eq('version_id', versionId);

      if (dataType.yearCol) {
        query = query.eq(dataType.yearCol, year);
      }

      const { count, error } = await query;

      const hasData = !error && count > 0;
      const status = hasData ? 'success' : 'warning';
      const message = hasData
        ? `${label} loaded successfully (${count} rows)`
        : `No ${label} identified for ${year}`;

      rows.push({
        dataType: dataType.key,
        year,
        status,
        severity: status,
        message,
        metadata: { rowCount: count || 0 },
      });
    }
  }

  // Chart of Accounts (not year-filtered)
  const { count: coaCount } = await supabase
    .from('chart_of_accounts')
    .select('id', { count: 'exact' })
    .eq('version_id', versionId);

  rows.push({
    dataType: 'chart_of_accounts',
    year: null,
    status: coaCount > 0 ? 'success' : 'warning',
    severity: coaCount > 0 ? 'success' : 'warning',
    message: coaCount > 0
      ? 'Chart of Accounts generated successfully'
      : 'Chart of Accounts not generated',
    metadata: { accountCount: coaCount || 0 },
  });

  return rows;
}

/**
 * Utility: Group mappings by report category
 */
function groupMappingsByCategory(allMappings) {
  const grouped = {};
  allMappings.forEach((mapping) => {
    if (!grouped[mapping.reportCategory]) {
      grouped[mapping.reportCategory] = [];
    }
    grouped[mapping.reportCategory].push(mapping);
  });
  return grouped;
}

/**
 * Utility: Update extraction statistics
 */
function updateStats(stats, result) {
  if (result.success) {
    stats.success += 1;
    stats.rowsExtracted += result.rowsExtracted || 0;
  } else {
    stats.failed += 1;
  }
}

module.exports = { generateFinancialTables };
