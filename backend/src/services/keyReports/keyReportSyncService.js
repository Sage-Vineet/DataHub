/**
 * KEY REPORTS SYNC SERVICE
 *
 * Direct extraction pipeline: NO ManualGL delegation.
 *
 * Flow:
 *   1. Extract Tax Returns       → tax_return_entries
 *   2. Extract Bank Statements   → bank_statement_entries
 *   3. Extract Balance Sheets    → balance_sheet_entries (opening/reconcile)
 *   4. Extract General Ledger    → general_ledger_entries (source of truth)
 *   5. Generate COA once, link GL, Trial Balance, and monthly Balance Sheets
 *   6. Materialize P&L and Cash Flow render snapshots
 *   7. Build and persist validation results
 */

const { supabase } = require('../../db');
const { fetchAllRows } = require('./pagedFetch');

const taxReturnExtractionService = require('./taxReturnExtractionService');
const bankStatementExtractionService = require('./bankStatementExtractionService');
const balanceSheetExtractionService = require('./balanceSheetExtractionService');
const generalLedgerExtractionService = require('./generalLedgerExtractionService');

const { generateChartOfAccounts, validateChartOfAccounts, ensureCoaComplete } = require('../chartOfAccountsService');
const { replaceValidationResults } = require('./keyReportValidationService');
const { classifyWorkflowDocuments, generateTrialBalance, generateMonthlyBalanceSheets, generateReconciliation, linkGlToCoa } = require('./keyReportAccountingService');
const keyReportService = require('./keyReportService');
const keyReportReportService = require('./keyReportReportService');
const { performance } = require('perf_hooks');

// How many linked documents to extract concurrently. Extraction is the dominant
// cost (download + parse + Gemini/Python AI) and each document is independent
// (writes only its own version+document rows), so bounded parallelism is safe.
// Kept modest by default to respect the DB pool and Gemini rate limits.
const EXTRACTION_CONCURRENCY = Math.max(
  1,
  parseInt(process.env.KEY_REPORT_EXTRACTION_CONCURRENCY || '4', 10) || 4,
);

// Run `worker` over `items` with at most `limit` in flight. Never rejects for an
// individual item — extractDocument already returns a {success:false} result on
// error, so one failed document cannot discard the others (Step 20 requirement).
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) break;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

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
  // Must page via fetchAllRows (.range()) — a single .limit(N) is silently capped
  // at Supabase/PostgREST's server-side row ceiling (commonly 1000) regardless of
  // N, which was truncating multi-thousand-row General Ledgers and losing years.
  let data;
  try {
    let q = supabase.from(table).select(yearCol).eq('version_id', versionId);
    if (table === 'balance_sheet_entries' || table === 'profit_loss_entries') {
      q = q.or('is_generated.is.null,is_generated.eq.false');
    }
    data = await fetchAllRows(() => q);
  } catch (_e) { return new Set(); }
  if (!data) return new Set();

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
    { key: 'balance_sheet', table: 'balance_sheet_entries', yearCol: 'fiscal_year', isDateCol: false },
    // fiscal_year no longer exists on general_ledger_entries (migration 069) —
    // transaction_date is always populated, so a date-range filter works.
    { key: 'general_ledger', table: 'general_ledger_entries', yearCol: 'transaction_date', isDateCol: true },
  ];

  const labels = {
    tax_return: 'Tax Return Data',
    bank_statement: 'Bank Statement Data',
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

        if (dt.key === 'balance_sheet' || dt.key === 'profit_loss') {
          countQuery = countQuery.or('is_generated.is.null,is_generated.eq.false');
        }

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

  // High-resolution phase instrumentation. `mark(label)` records the elapsed ms
  // since the previous mark; the structured summary is logged at the end and
  // returned in summary.timings so the real bottleneck is measured, not guessed.
  const perfStart = performance.now();
  let perfLast = perfStart;
  const timings = {};
  const mark = (label) => {
    const now = performance.now();
    timings[label] = Math.round(now - perfLast);
    perfLast = now;
  };

  // Clear any previously generated (is_generated=true) balance-sheet rows so the
  // monthly roll-forward is recomputed from freshly extracted data. Extracted rows
  // (is_generated=false) are left untouched — extraction replaces them per document.
  // (There is no profit_loss_entries table — P&L is generated live from the GL.)
  try {
    const bsDel = await supabase
      .from('balance_sheet_entries').delete().eq('version_id', versionId).eq('is_generated', true);
    if (!bsDel.error) logger.log('  ✓ Cleared previously generated Balance Sheet rows');
  } catch (clearErr) {
    logger.warn(`  Could not clear generated rows (migration 054 may not be applied yet): ${clearErr.message}`);
  }

  const allMappings = await keyReportService.listMappings(versionId);
  const mappingsByCategory = groupMappingsByCategory(allMappings);

  logger.log(`Files discovered: ${allMappings.length} total`);
  for (const [cat, items] of Object.entries(mappingsByCategory)) {
    if (items.length) logger.log(`  ${cat}: ${items.length} file(s) → ${items.map((m) => m.fileName || m.documentId).join(', ')}`);
  }

  const extractionResults = {
    tax_return: { success: 0, failed: 0, rowsExtracted: 0 },
    bank_statement: { success: 0, failed: 0, rowsExtracted: 0 },
    balance_sheet: { success: 0, failed: 0, rowsExtracted: 0 },
    general_ledger: { success: 0, failed: 0, rowsExtracted: 0 },
  };

  const allDetectedYears = new Set();
  const extractionErrors = [];

  // NOTE: Profit & Loss is NOT extracted to a table. P&L is generated from the
  // General Ledger during sync and stored only as a render snapshot. A linked P&L
  // document may still be used as a temporary display-only fallback when no GL
  // exists, extracted on demand — it is never persisted as a reporting table.

  // ── Extraction (Steps 1–4) — all linked documents processed with bounded
  //    concurrency instead of sequentially. Order across categories does not
  //    matter: every extractor writes only its own table for its own
  //    version+document, and all downstream phases run AFTER extraction.
  const serviceByCategory = {
    tax_return: taxReturnExtractionService,
    bank_statement: bankStatementExtractionService,
    balance_sheet: balanceSheetExtractionService,
    general_ledger: generalLedgerExtractionService,
  };
  const extractionOrder = ['tax_return', 'bank_statement', 'balance_sheet', 'general_ledger'];

  const extractionTasks = [];
  for (const category of extractionOrder) {
    const service = serviceByCategory[category];
    const mappings = mappingsByCategory[category] || [];
    logger.log(`  ${category}: ${mappings.length} file(s) to process`);
    for (const mapping of mappings) extractionTasks.push({ category, mapping, service });
  }

  logger.log(`--- Extraction: ${extractionTasks.length} document(s), concurrency ${EXTRACTION_CONCURRENCY} ---`);
  const docStats = { total: extractionTasks.length, cached: 0, processed: 0, failed: 0 };

  const extractionOutcomes = await mapWithConcurrency(
    extractionTasks,
    EXTRACTION_CONCURRENCY,
    async ({ category, mapping, service }) => {
      const result = await extractDocument(companyId, versionId, mapping, service, logger);
      return { category, result };
    },
  );

  for (const { category, result } of extractionOutcomes) {
    updateStats(extractionResults[category], result);
    if (result.detectedYears) result.detectedYears.forEach((y) => allDetectedYears.add(y));
    if (!result.success) {
      extractionErrors.push({ step: category, ...result });
      docStats.failed += 1;
    } else if (result.cacheHit) {
      docStats.cached += 1;
    } else {
      docStats.processed += 1;
    }
  }

  for (const category of extractionOrder) {
    const s = extractionResults[category];
    logger.log(`  ${category} result: ${s.success} succeeded, ${s.failed} failed, ${s.rowsExtracted} rows inserted`);
  }
  logger.log(`  Documents: ${docStats.cached} cached (reused), ${docStats.processed} freshly processed, ${docStats.failed} failed`);
  mark('extraction');

  const years = Array.from(allDetectedYears).sort((a, b) => a - b);
  logger.log(`Detected fiscal years: [${years.join(', ')}]`);

  const totalRows = Object.values(extractionResults).reduce((sum, s) => sum + s.rowsExtracted, 0);
  logger.log(`Total rows inserted across all entry tables: ${totalRows}`);

  // ── PHASE 1: Validate available documents (the accounting gate) ────────────
  // General Ledger is the source of truth. With no GL the accounting workflow
  // is halted — Chart of Accounts and all generated reports are skipped and a
  // validation error is surfaced. Opening BS missing ⇒ warning (not a halt).
  logger.log('--- Phase 1: Document validation gate ---');
  const gate = await classifyWorkflowDocuments(companyId, versionId);
  logger.log(
    `  GL=${gate.hasGL ? `yes (${gate.glRowCount} rows, FY ${gate.glStartYear}–${gate.glEndYear})` : 'NO'}, ` +
    `OpeningBS=${gate.hasOpeningBs ? 'yes' : 'no'}, EndingBS=${gate.hasEndingBs ? 'yes' : 'no'}, ` +
    `canGenerate=${gate.canGenerate}`,
  );
  mark('document_gate');

  if (!gate.canGenerate) {
    const haltReason = gate.haltReason || 'general_ledger_required';
    const haltMessage = gate.haltMessage ||
      'Sync completed, but the accounting workflow was halted: required accounting data was not found. Re-sync after linking the missing file.';
    logger.warn(`  ✗ Accounting workflow halted: ${haltReason}.`);
    const haltRows = await buildValidationResultsFromEntryTables(versionId, mappingsByCategory, years, logger);
    haltRows.push(...gate.rows);
    await replaceValidationResults(versionId, companyId, haltRows);
    logger.log(`  ✓ ${haltRows.length} validation rows stored (workflow halted)`);
    return {
      success: true,
      halted: true,
      batchId: null,
      datasetVersion: null,
      years,
      extractionResults,
      coaSummary: null,
      errors: extractionErrors.length > 0 ? extractionErrors : null,
      summary: {
        generated: false,
        halted: true,
        haltReason,
        years,
        totalRowsInserted: totalRows,
        extractionResults,
        documents: gate,
        documentProcessing: docStats,
        timings,
        message: haltMessage,
      },
      message: haltMessage,
    };
  }

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
  mark('chart_of_accounts');

  // ── PHASE 2b: Link GL rows to Chart of Accounts (populate coa_id) ────────────
  // After COA is generated, resolve each GL transaction's account_name to a
  // chart_of_accounts id. This is the foundation for coa_id-driven report queries.
  logger.log('--- Phase 2b: Link GL → COA (populate coa_id) ---');
  try {
    const coaLinkResult = await linkGlToCoa(companyId, versionId);
    logger.log(`  ✓ GL → COA: linked=${coaLinkResult.linked} skipped=${coaLinkResult.skipped}`);
  } catch (linkErr) {
    logger.warn(`  GL → COA link failed: ${linkErr.message}`);
  }

  // ── PHASE 2c: Bulk-complete COA from GL distinct accounts ─────────────────
  // After COA generation + GL→COA linking, any GL row still missing a coa_id
  // means its account_name is absent from the COA (name mismatch, newly
  // extracted account, etc.).  This step inserts them in bulk so that all
  // subsequent report-generation phases (Trial Balance, Monthly BS, P&L) can
  // resolve every GL account via in-memory lookup without any DB writes.
  logger.log('--- Phase 2c: Complete COA from unlinked GL accounts ---');
  try {
    const completionResult = await ensureCoaComplete(companyId, versionId);
    logger.log(`  ✓ COA completion: ${completionResult.added} account(s) added, ${completionResult.skipped} already present`);
    if (completionResult.added > 0) {
      // Re-run GL→COA linking so newly added accounts get their coa_id
      logger.log('  Re-running GL→COA link for newly added accounts...');
      const relinkResult = await linkGlToCoa(companyId, versionId);
      logger.log(`  ✓ Re-link: linked=${relinkResult.linked} skipped=${relinkResult.skipped}`);
    }
  } catch (completionErr) {
    logger.warn(`  COA completion failed: ${completionErr.message}`);
  }
  mark('coa_linking');

  // ── PHASE 3: Trial Balance (generated directly from the General Ledger) ─────
  logger.log('--- Phase 3: Trial Balance ---');
  let trialBalanceSummary = null;
  try {
    trialBalanceSummary = await generateTrialBalance(companyId, versionId, gate);
    logger.log(`  ✓ Trial Balance: ${trialBalanceSummary.stored} account-year row(s) for FY [${trialBalanceSummary.years.join(', ')}]`);
  } catch (tbErr) {
    logger.warn(`  Trial Balance generation failed: ${tbErr.message}`);
    trialBalanceSummary = { error: tbErr.message, stored: 0, years: [] };
  }
  mark('trial_balance');

  // ── PHASE 4: Monthly Balance Sheet engine ──────────────────────────────────
  // Opening Balance Sheet + monthly GL activity → STORED monthly balances
  // (balance_sheet_entries, is_generated=true). These generated month-end
  // snapshots are the authoritative Balance Sheet records; uploaded balance
  // sheets are the opening seed + (ending) reconciliation input only.
  logger.log('--- Phase 4: Monthly Balance Sheets ---');
  let monthlyBsSummary = null;
  try {
    monthlyBsSummary = await generateMonthlyBalanceSheets(companyId, versionId, gate);
    logger.log(`  ✓ Monthly Balance Sheets: ${monthlyBsSummary.stored} row(s) across ${monthlyBsSummary.months} month-end snapshot(s) for FY [${monthlyBsSummary.years.join(', ')}]`);
  } catch (mbsErr) {
    logger.warn(`  Monthly Balance Sheet generation failed: ${mbsErr.message}`);
    monthlyBsSummary = { error: mbsErr.message, stored: 0, months: 0, years: [] };
  }
  mark('monthly_balance_sheets');

  // ── PHASE 5: Reconciliation (generated ending BS vs uploaded ending BS) ─────
  // Only runs when an Ending Balance Sheet was uploaded. Never overwrites the
  // generated balances — produces a separate per-account variance report.
  logger.log('--- Phase 5: Reconciliation ---');
  let reconciliationSummary = null;
  try {
    const recon = await generateReconciliation(companyId, versionId, gate);
    reconciliationSummary = recon;
    if (recon.ran) {
      const s = recon.summary;
      logger.log(`  ✓ Reconciliation (FY ${recon.year}): ${recon.stored} account(s) — ${s.matched} match, ${s.differences} differ, ${s.missingInUploaded} missing-in-uploaded, ${s.missingInGenerated} missing-in-generated`);
    } else {
      logger.log(`  – Reconciliation skipped (${recon.summary?.reason || 'no ending balance sheet'})`);
    }
  } catch (recErr) {
    logger.warn(`  Reconciliation failed: ${recErr.message}`);
    reconciliationSummary = { ran: false, error: recErr.message };
  }
  mark('reconciliation');

  // P&L and Cash Flow are generated after the authoritative monthly Balance
  // Sheets exist, then persisted as render-ready JSON. They are not accounting
  // source tables and opening a report never mutates COA or re-runs this pipeline.
  logger.log('--- Phase 6: Materialize P&L and Cash Flow snapshots ---');
  let generatedReportSummary = { profitLoss: 0, profitLossYears: [], cashFlow: 0 };
  try {
    const pl = await keyReportReportService.getProfitLossReport(versionId, {
      forceGenerate: true,
      persist: true,
      companyId,
    });
    generatedReportSummary.profitLoss = pl.persistedSnapshots || 0;
    generatedReportSummary.profitLossYears = pl.years || [];
    const cf = await keyReportReportService.getCashflowReport(versionId, {
      forceGenerate: true,
      persist: true,
      companyId,
      profitLossTreesByYear: pl.generatedTreesByYear,
    });
    generatedReportSummary.cashFlow = cf.persistedSnapshots || 0;
    logger.log(`  ✓ Generated report snapshots: P&L=${generatedReportSummary.profitLoss}, Cash Flow=${generatedReportSummary.cashFlow}`);
  } catch (reportErr) {
    generatedReportSummary.error = reportErr.message;
    logger.warn(`  Generated report snapshot persistence failed: ${reportErr.message}`);
  }
  mark('report_snapshots');

  // Step 7: Validation Results (from entry table row counts + COA spec checks)
  logger.log('--- Step 7: Validation Results ---');
  logger.log(`  Building validation rows for years=[${years.join(', ')}]`);
  const validationRows = await buildValidationResultsFromEntryTables(versionId, mappingsByCategory, years, logger);

  const plYears = generatedReportSummary.profitLossYears.length
    ? generatedReportSummary.profitLossYears
    : Array.from({ length: Math.max(0, (gate.glEndYear || 0) - (gate.glStartYear || 0) + 1) }, (_, i) => gate.glStartYear + i)
      .filter((year) => Number.isInteger(year) && year > 0);
  if (plYears.length) {
    const generated = generatedReportSummary.profitLossYears.length > 0;
    for (const year of plYears) {
      validationRows.push({
        dataType: 'profit_loss',
        year,
        status: generated ? 'success' : 'error',
        severity: generated ? 'success' : 'error',
        message: generated
          ? `Profit & Loss generated successfully from General Ledger for ${year}.`
          : `Profit & Loss generation failed for ${year}: ${generatedReportSummary.error || 'no generated rows'}`,
        metadata: {
          source: 'general_ledger_entries',
          persistedSnapshots: generatedReportSummary.profitLoss,
        },
      });
    }
  }

  // Phase 1 gate rows (e.g. opening-balance-sheet-missing warning) carry through.
  if (gate.rows.length) validationRows.push(...gate.rows);

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
  mark('validation');

  const totalMs = Math.round(performance.now() - perfStart);
  timings.total = totalMs;
  logger.log(
    `[Perf] ` +
    Object.entries(timings).map(([k, v]) => `${k}=${v}ms`).join(' ') +
    ` | docs: ${docStats.cached} cached / ${docStats.processed} processed / ${docStats.failed} failed`,
  );

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
      trialBalance: trialBalanceSummary,
      monthlyBalanceSheets: monthlyBsSummary,
      reconciliation: reconciliationSummary,
      generatedReports: generatedReportSummary,
      documents: gate,
      documentProcessing: docStats,
      timings,
      message,
    },
    message,
  };
}

module.exports = { generateFinancialTables };
