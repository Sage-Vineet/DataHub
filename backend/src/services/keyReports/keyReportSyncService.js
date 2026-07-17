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
const progressStore = require('./keyReportProgressStore');

const taxReturnExtractionService = require('./taxReturnExtractionService');
const bankStatementExtractionService = require('./bankStatementExtractionService');
const balanceSheetExtractionService = require('./balanceSheetExtractionService');
const generalLedgerExtractionService = require('./generalLedgerExtractionService');
const clientCoaExtractionService = require('./clientCoaExtractionService');
// NOT registered in serviceByCategory/extractionOrder below — deliberately kept
// out of the generic persisting extraction dispatcher. Used only for the
// ephemeral, validation-only P&L reconciliation step (Step 7b): parsed in
// memory, compared against the GL-derived Net Income, then discarded. Never
// written to a table (see migration 056 — client requirement).
const profitLossExtractionService = require('./profitLossExtractionService');
// Reused only for the P&L validation report's "AI classification" column
// (Step 7b) — same recognition-only call already used by COA generation,
// never repurposed to build hierarchy here.
const { classifyAccountsWithAI } = require('./geminiCoaClassifier');

function normName(accountName) {
  return String(accountName || '').trim().toLowerCase();
}

// Subtotal/section-total labels that profitLossExtractionService's own is_total
// regex (only matches labels containing the literal word "total") does not
// catch, so without this exclusion they would appear as phantom "accounts"
// when diffed against the GL's per-account map (found during the root-cause
// investigation's diagnostic tooling — same fix applied here).
const KNOWN_SUBTOTAL_LABELS = new Set([
  'gross profit',
  'net operating income',
  'net other income',
  'net income',
]);

// Root Cause 6: attribute a Net-Income mismatch to the specific account(s)
// responsible instead of reporting only the aggregate difference. Reuses the
// exact methodology validated in the manual root-cause investigation:
// per-account GL amounts (aggregateGLByAccount) vs. per-account uploaded P&L
// amounts (the same validRows already parsed for this file in Step 7b),
// matched by normalized account name.
async function accountLevelReconciliationDiff(versionId, year, validRows) {
  const { accounts: glAccounts } = await keyReportReportService.aggregateGLByAccount(versionId, year);

  const uploadedByName = new Map();
  for (const row of validRows) {
    if (row.fiscal_year !== year) continue;
    if (row.is_total || row.is_header) continue;
    const key = normName(row.account_name);
    if (!key || KNOWN_SUBTOTAL_LABELS.has(key)) continue;
    uploadedByName.set(key, {
      accountName: row.account_name,
      amount: (uploadedByName.get(key)?.amount || 0) + (Number(row.amount) || 0),
    });
  }

  const glByName = new Map();
  for (const [name, acc] of glAccounts) {
    if (acc.type !== 'revenue' && acc.type !== 'expense' && acc.type !== 'unknown') continue;
    const key = normName(name);
    glByName.set(key, { accountName: name, amount: acc.net });
  }

  const allKeys = new Set([...uploadedByName.keys(), ...glByName.keys()]);
  const diffs = [];
  for (const key of allKeys) {
    const uploaded = uploadedByName.get(key);
    const gl = glByName.get(key);
    const uploadedAmount = uploaded?.amount || 0;
    const glAmount = gl?.amount || 0;
    const diff = Math.round((uploadedAmount - glAmount) * 100) / 100;
    if (Math.abs(diff) < 1.0) continue;
    diffs.push({
      accountName: uploaded?.accountName || gl?.accountName || key,
      uploadedAmount,
      glAmount,
      diff,
    });
  }

  diffs.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  return diffs; // full set — caller decides how many to surface, never silently drops the rest
}

const { generateChartOfAccounts, validateChartOfAccounts, ensureCoaComplete } = require('../chartOfAccountsService');
const { replaceValidationResults } = require('./keyReportValidationService');
const { classifyWorkflowDocuments, generateTrialBalance, generateMonthlyBalanceSheets, generateMonthlyBalanceSheetsReverse, generateReconciliation, linkGlToCoa } = require('./keyReportAccountingService');
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

  // Publish real, phase-by-phase progress to the in-memory store so the frontend
  // progress bar tracks the actual pipeline position (from "=== Sync started ==="
  // to "=== Sync complete ===") instead of a time-based guess. Stage keys mirror
  // the frontend STAGES (GenerateProgressPanel.jsx). Never throws — a progress
  // publish failure must not affect the sync itself.
  const reportProgress = (stageKey, stageLabel, pct, message) => {
    try {
      progressStore.updateProgress(versionId, { stageKey, stageLabel, pct, message });
    } catch (_e) { /* progress is best-effort */ }
  };

  logger.log('=== Sync started ===');
  reportProgress('preparing', 'Preparing Data', 5, 'Validating linked files…');

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
  // profit_loss is a valid link category (users may still attach a P&L file),
  // but it is deliberately excluded from extractionOrder below — flag it
  // explicitly here instead of letting it silently vanish from the run.
  if ((mappingsByCategory.profit_loss || []).length) {
    logger.log(
      `  profit_loss: ${mappingsByCategory.profit_loss.length} file(s) linked but NOT extracted — ` +
      `by design, per client requirement (see migration 056): P&L is generated entirely from the ` +
      `General Ledger, there is no profit_loss_entries table.`,
    );
  } else {
    logger.log('  profit_loss: no file linked (not required — P&L is generated from the General Ledger)');
  }

  const extractionResults = {
    tax_return: { success: 0, failed: 0, rowsExtracted: 0 },
    bank_statement: { success: 0, failed: 0, rowsExtracted: 0 },
    chart_of_accounts: { success: 0, failed: 0, rowsExtracted: 0 },
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
    chart_of_accounts: clientCoaExtractionService,
    balance_sheet: balanceSheetExtractionService,
    general_ledger: generalLedgerExtractionService,
  };
  // chart_of_accounts runs first: it's the highest-priority hierarchy source
  // (see coaMappingService.createCoaMapper), so later phases that read
  // client_chart_of_accounts always see this run's own upload already in place.
  const extractionOrder = ['chart_of_accounts', 'tax_return', 'bank_statement', 'balance_sheet', 'general_ledger'];

  const extractionTasks = [];
  for (const category of extractionOrder) {
    const service = serviceByCategory[category];
    const mappings = mappingsByCategory[category] || [];
    logger.log(`  ${category}: ${mappings.length} file(s) to process`);
    for (const mapping of mappings) extractionTasks.push({ category, mapping, service });
  }

  logger.log(`--- Extraction: ${extractionTasks.length} document(s), concurrency ${EXTRACTION_CONCURRENCY} ---`);
  const docStats = { total: extractionTasks.length, cached: 0, processed: 0, failed: 0 };

  // Extraction (download + parse + Gemini AI) is the dominant cost. Advance the
  // bar across a dedicated band as each document completes so the longest phase
  // shows genuine, per-document movement instead of a frozen stall.
  reportProgress('reading_gl', 'Reading GL', 12, 'Loading linked documents…');
  const AI_BAND_START = 15;
  const AI_BAND_END = 45;
  const extractionTotal = extractionTasks.length || 1;
  let extractionDone = 0;

  const extractionOutcomes = await mapWithConcurrency(
    extractionTasks,
    EXTRACTION_CONCURRENCY,
    async ({ category, mapping, service }) => {
      const result = await extractDocument(companyId, versionId, mapping, service, logger);
      extractionDone += 1;
      reportProgress(
        'ai_processing',
        'Processing AI',
        Math.round(AI_BAND_START + (AI_BAND_END - AI_BAND_START) * (extractionDone / extractionTotal)),
        `Extracting financial data… (${extractionDone}/${extractionTotal} document${extractionTotal === 1 ? '' : 's'})`,
      );
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
  // Validation order: GL required → at least one Balance Sheet (Opening OR
  // Ending) required → at least one Profit & Loss required → continue. With
  // any of these missing the accounting workflow is halted — Chart of
  // Accounts and all generated reports are skipped and a validation error is
  // surfaced instead.
  logger.log('--- Phase 1: Document validation gate ---');
  const gate = await classifyWorkflowDocuments(companyId, versionId);
  const GENERATION_MODE_LOG_LABEL = { forward: 'Forward', reverse: 'Backward', dual: 'Dual Verification' };
  logger.log(
    `  GL=${gate.hasGL ? `yes (${gate.glRowCount} rows, FY ${gate.glStartYear}–${gate.glEndYear})` : 'NO'}, ` +
    `OpeningBS=${gate.hasOpeningBs ? `yes (${gate.openingBsMode}, FY${gate.openingBs?.fiscal_year})` : 'no'}, ` +
    `EndingBS=${gate.hasEndingBs ? 'yes' : 'no'}, ` +
    `ProfitLoss=${gate.hasProfitLoss ? 'yes' : 'no'}, ` +
    `canGenerate=${gate.canGenerate}`,
  );
  if (gate.canGenerate) {
    logger.log(`  ✓ Validation passed. Generation mode: ${GENERATION_MODE_LOG_LABEL[gate.balanceSheetMode] || gate.balanceSheetMode} (${gate.balanceSheetMode}).`);
  }
  mark('document_gate');

  if (!gate.canGenerate) {
    const haltReason = gate.haltReason || 'general_ledger_required';
    const haltMessage = gate.haltMessage ||
      'Sync completed, but the accounting workflow was halted: required accounting data was not found. Re-sync after linking the missing file.';
    logger.warn(`  ✗ Accounting workflow halted: ${haltReason}.`);
    try { progressStore.failProgress(versionId, haltMessage, 'preparing'); } catch (_e) { /* best-effort */ }
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

  // Step 5b: Parse uploaded Profit & Loss — ephemeral, never persisted (no
  // profit_loss_entries table, per client requirement — migration 056). Parsed
  // once here so both COA generation (Step 6, a shallow Income-Statement-only
  // grouping hint) and the later reconciliation/validation steps reuse the
  // same parse instead of re-reading the file three times. Parse failures are
  // non-fatal here — they surface as an explicit validation row later.
  logger.log('--- Step 5b: Parse uploaded Profit & Loss (ephemeral) ---');
  const plMappings = mappingsByCategory.profit_loss || [];
  const plParsedByFile = []; // [{ fileName, validRows, error }]
  for (const mapping of plMappings) {
    const fileName = mapping.fileName || mapping.documentId;
    try {
      const { data: document, error: docErr } = await supabase
        .from('documents')
        .select('id, name, upload_id, file_url')
        .eq('id', mapping.documentId)
        .maybeSingle();
      if (docErr || !document) throw new Error('Document not found');

      const buffer = await loadDocumentBuffer(document);
      if (!buffer?.length) throw new Error('No file data found for document');

      const { rows: plRows } = await profitLossExtractionService.extract({ fileName, fileBuffer: buffer });
      const validRows = await profitLossExtractionService.validateRows(plRows);
      plParsedByFile.push({ fileName, validRows, error: null });
    } catch (err) {
      logger.warn(`  ${fileName}: Profit & Loss parsing failed — ${err.message}`);
      plParsedByFile.push({ fileName, validRows: [], error: err.message });
    }
  }
  // Account rows only (no totals/headers) — this is what feeds hierarchy
  // grouping and the GL-vs-P&L comparison; Net Income totals are read
  // separately from validRows further below.
  const plAccountRows = plParsedByFile.flatMap((f) => f.validRows.filter((r) => !r.is_total && !r.is_header));
  if (plMappings.length) {
    logger.log(`  Parsed ${plMappings.length} P&L file(s): ${plAccountRows.length} account row(s) available for hierarchy grouping + validation.`);
  } else {
    logger.log('  No Profit & Loss file linked.');
  }

  // Step 6: Chart of Accounts. Hierarchy source priority: uploaded Chart of
  // Accounts (company-scoped, then global reference) → this version's own
  // uploaded Balance Sheet section → this version's own uploaded Profit & Loss
  // section (Revenue/COGS/Operating Expenses — a shallow Income-Statement-only
  // grouping hint, never used for Balance Sheet accounts, never inventing
  // deeper hierarchy) → AI selection among existing categories → needs_mapping.
  logger.log('--- Step 6: Chart of Accounts ---');
  reportProgress('coa', 'Generating Chart of Accounts', 55, 'Classifying accounts and building hierarchy…');
  let coaSummary = null;
  try {
    coaSummary = await generateChartOfAccounts(companyId, versionId, null, { plRows: plAccountRows });
    logger.log(`  ✓ Chart of Accounts: ${coaSummary.leafCount || 0} accounts classified (${coaSummary.inserted || 0} new, ${coaSummary.updated || 0} updated, ${coaSummary.deleted || 0} removed)`);
    if (coaSummary.sourceCounts) {
      const sc = coaSummary.sourceCounts;
      logger.log(
        `    ${sc.coaReference} matched from uploaded Chart of Accounts, ` +
        `${sc.bsSection} matched from uploaded Balance Sheet section, ` +
        `${sc.plSection} matched from uploaded Profit & Loss section, ` +
        `${sc.aiCategory} AI-placed into an existing category, ` +
        `${sc.needsMapping} needs_mapping`,
      );
    }
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
  reportProgress('financial_reports', 'Generating Financial Reports', 70, 'Building Trial Balance and Balance Sheets…');
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
  // gate.balanceSheetMode picks the engine: 'forward' (Starting BS — opening
  // + monthly GL activity, unchanged), 'reverse' (Ending BS only — reconstruct
  // backward from the ending balance, new), or 'dual' (both present — forward
  // remains authoritative/persisted for now; the reverse engine + comparison
  // for 'dual' is a follow-up, not yet wired in here). Either engine STORES
  // the same balance_sheet_entries shape (is_generated=true) — these generated
  // month-end snapshots are the authoritative Balance Sheet records; uploaded
  // balance sheets are the opening/ending seed + reconciliation input only.
  logger.log(`--- Phase 4: Monthly Balance Sheets (${GENERATION_MODE_LOG_LABEL[gate.balanceSheetMode] || gate.balanceSheetMode} generation) ---`);
  let monthlyBsSummary = null;
  try {
    monthlyBsSummary = gate.balanceSheetMode === 'reverse'
      ? await generateMonthlyBalanceSheetsReverse(companyId, versionId, gate)
      : await generateMonthlyBalanceSheets(companyId, versionId, gate);
    if (monthlyBsSummary.warning) {
      logger.warn(`  ⚠ Monthly Balance Sheets: ${monthlyBsSummary.warning} — no rows generated. ` +
        `The uploaded Ending Balance Sheet's date does not match the General Ledger's last active month; ` +
        `reconstructing historical balances from it would be unreliable, so generation was skipped rather than guessed.`);
    } else {
      logger.log(`  ✓ Monthly Balance Sheets: ${monthlyBsSummary.stored} row(s) across ${monthlyBsSummary.months} month-end snapshot(s) for FY [${monthlyBsSummary.years.join(', ')}]`);
    }
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
  reportProgress('snapshots', 'Creating Snapshots', 88, 'Persisting P&L and Cash Flow snapshots…');
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
  reportProgress('validation', 'Validation', 96, 'Running data quality checks…');
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

  // Step 7b: Profit & Loss reconciliation — validation-only, never persisted,
  // never a hierarchy source beyond the shallow Priority-3 grouping applied in
  // Step 6. The General Ledger remains the sole transactional source of truth
  // (client requirement, migration 056); reuses the Step 5b parse to cross-check
  // each file's own stated Net Income against the GL-derived Net Income
  // (aggregateGLForBS) — nothing is written to any table.
  if (plMappings.length) {
    logger.log(`--- Step 7b: Profit & Loss reconciliation (${plMappings.length} file(s), validation-only) ---`);
    for (const { fileName, validRows, error } of plParsedByFile) {
      if (error) {
        validationRows.push({
          dataType: 'profit_loss_reconciliation', year: null, status: 'error', severity: 'error',
          message: `Uploaded Profit & Loss "${fileName}" could not be parsed: ${error}`,
          metadata: { fileName, error },
        });
        continue;
      }

      // Read the document's OWN explicitly labeled "Net Income" total line(s) —
      // no section/account-type classification is performed, so this never
      // touches hierarchy or account grouping. A monthly-column P&L emits one
      // "Net Income" total row per month (all sharing the same fiscal_year, no
      // separate period field survives extraction) rather than one annual row,
      // so sum every occurrence for a year to get the annual total.
      const uploadedNetIncomeByYear = new Map();
      for (const row of validRows) {
        if (row.is_total && /\bnet income\b/i.test(row.account_name)) {
          const prev = uploadedNetIncomeByYear.get(row.fiscal_year) || 0;
          uploadedNetIncomeByYear.set(row.fiscal_year, prev + (Number(row.amount) || 0));
        }
      }

      if (!uploadedNetIncomeByYear.size) {
        logger.warn(`  ${fileName}: parsed ${validRows.length} row(s) but found no "Net Income" total line — reconciliation skipped for this file.`);
        validationRows.push({
          dataType: 'profit_loss_reconciliation', year: null, status: 'warning', severity: 'warning',
          message: `Uploaded Profit & Loss "${fileName}" parsed but no Net Income total line was found — reconciliation skipped.`,
          metadata: { fileName, rowsParsed: validRows.length },
        });
        continue;
      }

      for (const [year, uploadedNI] of uploadedNetIncomeByYear) {
        const { netIncome: glNetIncome } = await keyReportReportService.aggregateGLForBS(versionId, year);
        const diff = Math.round((uploadedNI - glNetIncome) * 100) / 100;
        const matches = Math.abs(diff) < 1.0;

        // Root Cause 6: don't just report the total difference — attribute it
        // to the specific account(s) responsible, the same way the manual
        // root-cause investigation did, so a future mismatch is immediately
        // explainable from the reconciliation screen instead of requiring a
        // fresh manual investigation each time.
        let accountsResponsible = [];
        let accountsResponsibleTotal = 0;
        if (!matches) {
          try {
            const allDiffs = await accountLevelReconciliationDiff(versionId, year, validRows);
            accountsResponsibleTotal = allDiffs.length;
            accountsResponsible = allDiffs.slice(0, 15); // top contributors — enough to explain without flooding the UI; total kept in metadata, never silently hidden
          } catch (diffErr) {
            logger.warn(`  ${fileName} FY${year}: account-level diff attribution failed: ${diffErr.message}`);
          }
        }

        logger.log(`  ${fileName} FY${year}: uploaded Net Income=${uploadedNI}, GL-derived=${glNetIncome.toFixed(2)}, diff=${diff} → ${matches ? 'MATCH' : 'MISMATCH'}`);
        if (accountsResponsible.length) {
          logger.log(`    Accounts responsible (${accountsResponsibleTotal} total, showing top ${accountsResponsible.length}): ` +
            accountsResponsible.map((a) => `"${a.accountName}" (${a.diff >= 0 ? '+' : ''}${a.diff.toFixed(2)})`).join(', '));
        }
        validationRows.push({
          dataType: 'profit_loss_reconciliation', year, status: matches ? 'success' : 'warning', severity: matches ? 'success' : 'warning',
          message: matches
            ? `Uploaded Profit & Loss Net Income for ${year} matches the GL-derived Net Income (${uploadedNI.toLocaleString()}).`
            : `Uploaded Profit & Loss Net Income for ${year} (${uploadedNI.toLocaleString()}) differs from the GL-derived Net Income (${glNetIncome.toLocaleString()}) by ${Math.abs(diff).toLocaleString()}.` +
              (accountsResponsible.length
                ? ` Accounts responsible: ${accountsResponsible.map((a) => `${a.accountName} (${a.diff >= 0 ? '+' : ''}${a.diff.toFixed(2)})`).join(', ')}` +
                  (accountsResponsibleTotal > accountsResponsible.length ? ` (+${accountsResponsibleTotal - accountsResponsible.length} more)` : '') + '.'
                : ''),
          metadata: { fileName, uploadedNetIncome: uploadedNI, glDerivedNetIncome: glNetIncome, diff, accountsResponsible, accountsResponsibleTotal },
        });
      }
    }
  } else {
    logger.log('  Step 7b: no Profit & Loss file linked — reconciliation skipped (not required).');
  }

  // Step 7c: GL-vs-uploaded-P&L account validation report. Compares the AI's
  // OWN account_type (recognition-only, same call already used by COA
  // generation) against the section the uploaded P&L places an account under
  // — purely to flag disagreements for review. Never writes hierarchy, never
  // overrides a chart_of_accounts row: client_chart_of_accounts and uploaded
  // Balance Sheet section remain the only hierarchy sources.
  if (plAccountRows.length) {
    const plByNormName = new Map();
    for (const row of plAccountRows) {
      const key = normName(row.account_name);
      if (!plByNormName.has(key)) plByNormName.set(key, { rawName: row.account_name, section: row.section || null });
      else if (!plByNormName.get(key).section && row.section) plByNormName.get(key).section = row.section;
    }

    const { data: coaLeaves } = await supabase
      .from('chart_of_accounts')
      .select('account_name, account_type, classification_method, metadata')
      .eq('version_id', versionId);
    const glByNormName = new Map();
    for (const row of (coaLeaves || [])) {
      if (row.metadata?.is_group) continue;
      glByNormName.set(normName(row.account_name), { rawName: row.account_name, accountType: row.account_type });
    }

    const plNames = [...plByNormName.keys()];
    const glNames = [...glByNormName.keys()];
    const accountsOnlyInPL = plNames.filter((n) => !glByNormName.has(n));
    const accountsOnlyInGL = glNames.filter((n) => !plByNormName.has(n));
    const compared = plNames.filter((n) => glByNormName.has(n));

    const sample = (arr, n = 15) => arr.slice(0, n);
    logger.log(
      `--- Step 7c: GL-vs-P&L account validation --- GL=${glNames.length}, P&L=${plNames.length}, ` +
      `compared=${compared.length}, onlyInGL=${accountsOnlyInGL.length}, onlyInPL=${accountsOnlyInPL.length}`,
    );

    const disagreements = [];
    if (compared.length) {
      const aiInput = compared.map((key) => ({
        key, accountName: plByNormName.get(key).rawName, accountNumber: null, bsSection: null,
      }));
      const aiResults = await classifyAccountsWithAI(aiInput, { companyId });

      // "revenue" and "income" are synonyms in this system's type vocabulary
      // (see chartOfAccountsService.js normalBalanceFor, which treats both as
      // credit-normal) — matched as a set here so that isn't flagged as a
      // false disagreement.
      const REVENUE_TYPES = new Set(['revenue', 'income']);
      const matchesSection = (section, accountType) => {
        if (section === 'revenue') return REVENUE_TYPES.has(accountType);
        if (section === 'cost_of_sales' || section === 'operating_expenses') return accountType === 'expense';
        return null; // no expectation for this section
      };

      for (const key of compared) {
        const plEntry = plByNormName.get(key);
        const aiEntry = aiResults.get(key);
        const matches = matchesSection(plEntry.section, aiEntry?.accountType);
        if (matches === null || !aiEntry?.accountType) continue; // nothing to compare
        if (!matches) {
          disagreements.push({
            accountName: plEntry.rawName, plSection: plEntry.section,
            aiClassification: aiEntry.accountType, finalAccountType: glByNormName.get(key).accountType,
          });
        }
      }
      if (disagreements.length) {
        logger.warn(
          `  ${disagreements.length} account(s) disagree between AI classification and uploaded P&L section: ` +
          disagreements.map((d) => `"${d.accountName}" (AI=${d.aiClassification}, P&L section=${d.plSection})`).join('; '),
        );
      } else {
        logger.log(`  ✓ All ${compared.length} compared account(s) agree between AI classification and uploaded P&L section.`);
      }
    }

    validationRows.push({
      dataType: 'profit_loss_account_validation',
      year: null,
      status: disagreements.length ? 'warning' : 'success',
      severity: disagreements.length ? 'warning' : 'success',
      message: disagreements.length
        ? `${disagreements.length} account(s) disagree between AI classification and the uploaded Profit & Loss section (validation only — hierarchy unchanged).`
        : `Uploaded Profit & Loss accounts agree with AI classification (${compared.length} compared).`,
      metadata: {
        accountsOnlyInGL: { count: accountsOnlyInGL.length, sample: sample(accountsOnlyInGL) },
        accountsOnlyInPL: { count: accountsOnlyInPL.length, sample: sample(accountsOnlyInPL) },
        compared: compared.length,
        agreements: compared.length - disagreements.length,
        disagreements: sample(disagreements, 20),
      },
    });
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
