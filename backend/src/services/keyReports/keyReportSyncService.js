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
// In-memory progress tracker — the sync logger feeds it each phase marker so the
// UI progress bar reflects the real pipeline instead of a fake timer. No DB.
const keyReportProgress = require('./keyReportProgress');

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

// Reason codes for a P&L reconciliation difference — never just "Difference
// exists", always explain why, using ONLY data already available to this
// function (no speculative distinction invented without a way to verify it):
//   missing_in_gl        — uploaded has this account, no GL account matches it at all this year.
//   classification_mismatch — a GL account DOES match by name, but COA typed it
//                           as a Balance Sheet type (asset/liability/equity),
//                           not revenue/expense — a P&L account misclassified.
//   unknown_account       — GL has it, but COA never resolved a type for it
//                           (needs_review/needs_mapping territory).
//   sign_issue            — both sides have it, same magnitude, opposite sign
//                           (a common QBO/Xero export/sign-convention quirk).
//   missing_in_uploaded   — GL has real revenue/expense activity, the client's
//                           own uploaded P&L has no line for it.
//   amount_difference     — default: both sides classified consistently, a
//                           genuine dollar variance.
// "Missing COA"/"Manual Mapping" (also named in the spec) are intentionally
// NOT emitted as distinct reasons here — this function has no reliable way to
// tell "no COA row exists" apart from "COA row exists but unresolved" (both
// surface as classifyAccountFromLookup returning 'unknown'), and fabricating
// that distinction without a live COA join would be exactly the kind of
// speculative code path this pass is avoiding.
// `hasGlAny` = a GL account with this name exists at all this year, regardless
// of its resolved type. `hasGlReportable` = that account's type is one that
// contributes a P&L amount (revenue/expense/unknown) — a Balance-Sheet-typed
// match (asset/liability/equity) is a real GL account, just the WRONG type,
// which is exactly classification_mismatch, not "missing". Checking
// classification first is what makes that distinction actually fire.
function classifyReconciliationReason(uploadedAmount, hasUploaded, glAmount, hasGlAny, hasGlReportable, glType) {
  if (glType && glType !== 'revenue' && glType !== 'expense' && glType !== 'unknown') return 'classification_mismatch';
  if (hasUploaded && !hasGlAny) return 'missing_in_gl';
  if (glType === 'unknown') return 'unknown_account';
  if (!hasUploaded && hasGlReportable) return 'missing_in_uploaded';
  const sameMagnitude = Math.abs(Math.abs(uploadedAmount) - Math.abs(glAmount)) < 1.0;
  if (sameMagnitude && uploadedAmount !== 0 && Math.sign(uploadedAmount) !== Math.sign(glAmount)) return 'sign_issue';
  return 'amount_difference';
}

// Root Cause 6: attribute a Net-Income mismatch to the specific account(s)
// responsible instead of reporting only the aggregate difference. Reuses the
// exact methodology validated in the manual root-cause investigation:
// per-account GL amounts (aggregateGLByAccount) vs. per-account uploaded P&L
// amounts (the same validRows already parsed for this file in Step 7b),
// matched by normalized account name. Each diff also carries a `reason` (see
// classifyReconciliationReason) — never just a raw dollar difference.
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

  // Unfiltered — every GL account for the year regardless of resolved type,
  // so a P&L account that COA misclassified as a Balance Sheet type is still
  // findable (needed for the classification_mismatch reason).
  // aggregateGLByAccount's Map is keyed by coa_id (not name) — acc.name holds
  // the account's real/canonical name for this name-based reconciliation view.
  const glAllByName = new Map();
  for (const acc of glAccounts.values()) {
    glAllByName.set(normName(acc.name), { accountName: acc.name, amount: acc.net, type: acc.type });
  }
  // Revenue/expense/unknown only — same filter as before, used for the
  // reportable amount (a Balance-Sheet-typed account never contributes a P&L amount).
  const glByName = new Map();
  for (const [key, acc] of glAllByName) {
    if (acc.type === 'revenue' || acc.type === 'expense' || acc.type === 'unknown') glByName.set(key, acc);
  }

  const allKeys = new Set([...uploadedByName.keys(), ...glAllByName.keys()]);
  const diffs = [];
  for (const key of allKeys) {
    const uploaded = uploadedByName.get(key);
    const glReportable = glByName.get(key);
    const glAny = glAllByName.get(key);
    const uploadedAmount = uploaded?.amount || 0;
    const glAmount = glReportable?.amount || 0;
    const diff = Math.round((uploadedAmount - glAmount) * 100) / 100;
    const reason = classifyReconciliationReason(uploadedAmount, Boolean(uploaded), glAmount, Boolean(glAny), Boolean(glReportable), glAny?.type || null);
    // A classification_mismatch/missing_in_gl is worth surfacing even at $0
    // apparent "diff" (the reportable glAmount is 0 precisely because the
    // account was excluded from the P&L side) — only skip when it's a
    // genuine, immaterial amount_difference.
    if (Math.abs(diff) < 1.0 && reason === 'amount_difference') continue;
    diffs.push({
      accountName: uploaded?.accountName || glAny?.accountName || key,
      uploadedAmount,
      glAmount,
      diff,
      reason,
    });
  }

  diffs.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  return diffs; // full set — caller decides how many to surface, never silently drops the rest
}

function percentageDifference(variance, uploadedAmount, generatedAmount) {
  if (uploadedAmount !== 0) return Math.round((variance / uploadedAmount) * 10000) / 10000 * 100;
  if (generatedAmount !== 0) return 100;
  return null;
}

// The uploaded document's OWN stated subtotal lines — read directly rather
// than re-summed from individual rows, so a footnote/rounding adjustment in
// the client's own P&L is respected instead of silently overridden.
const PL_SUBTOTAL_PATTERNS = {
  revenue: /^total income$|^total revenue$/i,
  cogs: /^total cost of (goods sold|sales)$/i,
  grossProfit: /^gross profit$/i,
  operatingExpenses: /^total expenses$/i,
  netIncome: /^net income$/i,
};

function uploadedSubtotalsByYear(validRows) {
  const byYear = new Map();
  for (const row of validRows) {
    if (!row.is_total) continue;
    const name = String(row.account_name || '').trim();
    for (const [key, pattern] of Object.entries(PL_SUBTOTAL_PATTERNS)) {
      if (!pattern.test(name)) continue;
      if (!byYear.has(row.fiscal_year)) byYear.set(row.fiscal_year, {});
      const y = byYear.get(row.fiscal_year);
      y[key] = (y[key] || 0) + (Number(row.amount) || 0);
    }
  }
  return byYear;
}

// GL-calculated subtotals for the same 5 lines, using the account's RAW COA
// type (coaTypeMap — asset/liability/equity/income/cogs/expense) rather than
// aggregateGLByAccount's coarser revenue/expense/unknown, since only the raw
// type distinguishes COGS from Operating Expenses.
//
// Other Income / Other Expense are deliberately NOT broken out as separate
// subtotals here: chart_of_accounts today collapses other_income→income and
// other_expense→expense at the account_type level (a known, previously
// documented gap — see chartOfAccountsService.js typeFromPlSection), so this
// codebase cannot yet reliably tell "Other Income" apart from "Revenue" or
// "Other Expense" apart from "Operating Expenses". Faking that distinction
// without the underlying data would be exactly the kind of speculative code
// this reconciliation layer exists to avoid.
async function calculatedSubtotalsForYear(versionId, year) {
  const [{ accounts }, typeMap] = await Promise.all([
    keyReportReportService.aggregateGLByAccount(versionId, year),
    coaTypeMap(versionId),
  ]);
  let revenue = 0;
  let cogs = 0;
  let operatingExpenses = 0;
  for (const acc of accounts.values()) {
    const rawType = String(typeMap.get(normName(acc.name)) || '').toLowerCase();
    if (rawType === 'cogs') cogs += acc.net;
    else if (/expense/.test(rawType)) operatingExpenses += acc.net;
    else if (/income|revenue/.test(rawType)) revenue += acc.net;
    // Anything else (asset/liability/equity/unclassified) contributes to no
    // named P&L subtotal — an unclassified account still shows up as its own
    // missing_in_gl/unknown_account row from accountLevelReconciliationDiff.
  }
  const grossProfit = revenue - cogs;
  const netIncome = grossProfit - operatingExpenses;
  return { revenue, cogs, grossProfit, operatingExpenses, netIncome };
}

const SUBTOTAL_LABEL = {
  revenue: 'Total Revenue', cogs: 'Total Cost of Goods Sold', grossProfit: 'Gross Profit',
  operatingExpenses: 'Total Operating Expenses', netIncome: 'Net Income',
};

/**
 * PROFIT & LOSS RECONCILIATION (mandatory reconciliation layer) — generates
 * the P&L entirely from the General Ledger and compares it against the
 * uploaded Profit & Loss, account-by-account AND at the subtotal level
 * (Revenue/COGS/Gross Profit/Operating Expenses/Net Income). Runs BEFORE
 * Monthly Balance Sheet / Monthly P&L / Cash Flow generation in the
 * redesigned pipeline. Persists every row to pl_reconciliation_entries —
 * previously this comparison only produced a transient validation-row
 * summary with no durable per-account audit trail.
 *
 * Reuses accountLevelReconciliationDiff unchanged for the per-account numbers
 * and reason codes (already verified this session) — this function only adds
 * persistence and the subtotal rollups.
 *
 * @returns {Promise<{
 *   summaryByYear: Map<number, {matched:number, differences:number, missingFromGl:number, missingFromPl:number, totalVariance:number}>,
 *   fileResults: Array<{fileName:string, year:number, uploadedNetIncome:number, glNetIncome:number,
 *     diff:number, matches:boolean, topDiffs:Array, totalDiffs:number}>,
 * }>}
 */
async function persistProfitLossReconciliation(companyId, versionId, plParsedByFile) {
  await supabase.from('pl_reconciliation_entries').delete().eq('version_id', versionId);

  const summaryByYear = new Map();
  const fileResults = [];
  const rows = [];

  for (const { fileName, validRows, error } of plParsedByFile) {
    if (error || !validRows?.length) continue;

    const uploadedSubtotals = uploadedSubtotalsByYear(validRows);
    const years = [...new Set(validRows.map((r) => r.fiscal_year))].filter((y) => Number.isInteger(y) && y > 0);

    for (const year of years) {
      if (!summaryByYear.has(year)) {
        summaryByYear.set(year, { matched: 0, differences: 0, missingFromGl: 0, missingFromPl: 0, totalVariance: 0 });
      }
      const summary = summaryByYear.get(year);
      const typeMap = await coaTypeMap(versionId);

      const diffs = await accountLevelReconciliationDiff(versionId, year, validRows);
      for (const d of diffs) {
        let status;
        if (d.reason === 'missing_in_gl') status = 'MISSING_FROM_GL';
        else if (d.reason === 'missing_in_uploaded') status = 'MISSING_FROM_PL';
        else status = Math.abs(d.diff) < 1.0 ? 'MATCHED' : 'DIFFERENCE';

        if (status === 'MATCHED') summary.matched += 1;
        else if (status === 'MISSING_FROM_GL') summary.missingFromGl += 1;
        else if (status === 'MISSING_FROM_PL') summary.missingFromPl += 1;
        else summary.differences += 1;
        summary.totalVariance = Math.round((summary.totalVariance + Math.abs(d.diff)) * 100) / 100;

        // accountLevelReconciliationDiff's own `diff` is (uploaded - generated)
        // — its established, already-verified convention for log/message text.
        // The PERSISTED variance column instead matches bs_reconciliation_
        // entries' convention (generated - uploaded), so the two reconciliation
        // tables agree on sign — only the stored column is flipped here, the
        // log-facing `d.diff` used elsewhere (fileResults/topDiffs) is untouched.
        const persistedVariance = -d.diff;
        rows.push({
          version_id: versionId,
          company_id: companyId,
          fiscal_year: year,
          account_name: d.accountName,
          account_type: typeMap.get(normName(d.accountName)) || null,
          section: null,
          generated_amount: d.glAmount,
          uploaded_amount: d.uploadedAmount,
          variance: persistedVariance,
          percentage_difference: percentageDifference(persistedVariance, d.uploadedAmount, d.glAmount),
          reason: d.reason,
          status,
          needs_review: status !== 'MATCHED',
          is_subtotal: false,
        });
      }

      // Subtotal rollup rows — uploaded side from the document's own stated
      // totals (when present), GL side always computed (never absent).
      const uploaded = uploadedSubtotals.get(year) || {};
      const calculated = await calculatedSubtotalsForYear(versionId, year);
      for (const key of Object.keys(SUBTOTAL_LABEL)) {
        const hasUploaded = uploaded[key] !== undefined;
        const upl = hasUploaded ? Math.round(uploaded[key] * 100) / 100 : 0;
        const calc = Math.round(calculated[key] * 100) / 100;
        const variance = Math.round((calc - upl) * 100) / 100;
        const status = !hasUploaded ? 'MISSING_FROM_PL' : Math.abs(variance) < 1.0 ? 'MATCHED' : 'DIFFERENCE';
        rows.push({
          version_id: versionId,
          company_id: companyId,
          fiscal_year: year,
          account_name: SUBTOTAL_LABEL[key],
          account_type: null,
          section: null,
          generated_amount: calc,
          uploaded_amount: upl,
          variance,
          percentage_difference: percentageDifference(variance, upl, calc),
          reason: hasUploaded ? 'amount_difference' : 'missing_in_uploaded',
          status,
          needs_review: status !== 'MATCHED',
          is_subtotal: true,
        });
      }

      const uploadedNetIncome = uploaded.netIncome !== undefined ? Math.round(uploaded.netIncome * 100) / 100 : null;
      const glNetIncome = Math.round(calculated.netIncome * 100) / 100;
      if (uploadedNetIncome !== null) {
        const niDiff = Math.round((uploadedNetIncome - glNetIncome) * 100) / 100;
        fileResults.push({
          fileName, year, uploadedNetIncome, glNetIncome, diff: niDiff,
          matches: Math.abs(niDiff) < 1.0,
          topDiffs: diffs.slice(0, 15),
          totalDiffs: diffs.length,
        });
      }
    }
  }

  if (rows.length) await chunkedInsertGeneric('pl_reconciliation_entries', rows);
  return { summaryByYear, fileResults };
}

async function chunkedInsertGeneric(table, rows, chunk = 500) {
  for (let i = 0; i < rows.length; i += chunk) {
    const { error } = await supabase.from(table).insert(rows.slice(i, i + chunk));
    if (error) throw error;
  }
}

const { generateChartOfAccounts, validateChartOfAccounts, ensureCoaComplete, printCoaValidationBlock } = require('../chartOfAccountsService');
const { replaceValidationResults } = require('./keyReportValidationService');
const { classifyWorkflowDocuments, generateTrialBalance, generateMonthlyBalanceSheets, generateMonthlyBalanceSheetsReverse, generateReconciliation, linkGlToCoa, linkBsToCoa, coaTypeMap } = require('./keyReportAccountingService');
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
    log: (msg) => {
      console.log(`[KeyReportSync v${version.versionNumber || versionId}] ${msg}`);
      // Drive the UI progress bar off the real phase markers in these log lines
      // (from "=== Sync started ===" to "=== Sync complete ==="). In-memory only.
      keyReportProgress.onSyncLog(versionId, msg);
    },
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
  // Balance Sheet Coverage — replaces the old binary "OpeningBS=yes/no,
  // EndingBS=yes/no" summary with the actual per-document years the
  // opening/ending decision was derived from (see
  // keyReportAccountingService.buildBsCoverage), never upload order/file
  // name/an "opening"/"ending" label.
  if (gate.bsCoverage) {
    const bc = gate.bsCoverage;
    logger.log(
      "Balance Sheet Coverage\n\n" +
      `GL Range: ${bc.glRange || "n/a"}\n\n` +
      (bc.documents.length
        ? bc.documents.map((d) => `${d.label}\nYears: ${d.years}`).join("\n\n") + "\n\n"
        : "No Balance Sheet documents uploaded.\n\n") +
      "Coverage\n" +
      `Opening Coverage : ${bc.hasOpeningBs ? "YES" : "NO"}\n` +
      `Ending Coverage : ${bc.hasEndingBs ? "YES" : "NO"}\n\n` +
      `Coverage Years\n${bc.coverageYears.length ? bc.coverageYears.join("\n") : "(none)"}`,
    );
  }
  if (gate.canGenerate) {
    logger.log(`  ✓ Validation passed. Generation mode: ${GENERATION_MODE_LOG_LABEL[gate.balanceSheetMode] || gate.balanceSheetMode} (${gate.balanceSheetMode}).`);
  }
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
  // The ONLY correct "was a COA uploaded" signal: a chart_of_accounts document
  // actually linked to THIS version's own file mappings — never whether
  // client_chart_of_accounts happens to have rows (company-scoped, not
  // version-scoped; a stale prior-version upload must never leak into a
  // version that never linked a COA at all).
  const hasLinkedCoaDocument = (mappingsByCategory.chart_of_accounts || []).length > 0;
  logger.log(`  Uploaded COA linked to this version: ${hasLinkedCoaDocument ? 'YES' : 'NO'}`);
  let coaSummary = null;
  try {
    coaSummary = await generateChartOfAccounts(companyId, versionId, null, {
      plRows: plAccountRows,
      hasLinkedCoaDocument,
      // Threaded through so buildDocHierarchyLookups' deepest-wins tie-break
      // can prefer the Ending Balance Sheet when it and the Opening Balance
      // Sheet give the same account equal real depth (never re-derived here
      // — this is the SAME gate the sync already validated against).
      endingFiscalYear: gate?.endingBs?.fiscal_year ?? null,
    });
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
    const completionResult = await ensureCoaComplete(companyId, versionId, plAccountRows, hasLinkedCoaDocument, gate?.endingBs?.fiscal_year ?? null);
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

  // Link uploaded/extracted balance_sheet_entries rows to their COA leaf too —
  // mirrors linkGlToCoa exactly, run once COA generation/completion is final so
  // both entry tables carry coa_id before any report reads them.
  try {
    const bsLinkResult = await linkBsToCoa(companyId, versionId);
    logger.log(`  ✓ BS → COA: linked=${bsLinkResult.linked} skipped=${bsLinkResult.skipped}`);
  } catch (bsLinkErr) {
    logger.warn(`  BS → COA link failed: ${bsLinkErr.message}`);
  }
  mark('coa_linking');

  try {
    await printCoaValidationBlock(companyId, versionId, plAccountRows);
  } catch (validationBlockErr) {
    logger.warn(`  COA Validation block failed: ${validationBlockErr.message}`);
  }

  // ── PHASE 2d: AI Hierarchy Recommendation Engine (advisory-only) ────────────
  // Runs strictly AFTER the deterministic COA above is fully generated and
  // validated. Never classifies, never moves an account, never writes to
  // chart_of_accounts — it only reads the now-authoritative hierarchy and
  // stores OPTIONAL roll-up suggestions for a human to review. A failure
  // here is never fatal to the sync (Trial Balance/reports must still be
  // generated even if the advisory pass errors).
  logger.log('--- Phase 2d: AI Hierarchy Recommendation Engine ---');
  try {
    const { generateRecommendations } = require('./aiHierarchyRecommendationService');
    await generateRecommendations(companyId, versionId);
  } catch (recoErr) {
    logger.warn(`  AI Hierarchy Recommendation Engine failed: ${recoErr.message}`);
  }
  mark('ai_hierarchy_recommendations');

  // ── PHASE 3: Trial Balance (generated directly from the General Ledger) ─────
  logger.log('--- Phase 3: Trial Balance ---');
  let trialBalanceSummary = null;
  try {
    trialBalanceSummary = await generateTrialBalance(companyId, versionId, gate);
    logger.log(`  ✓ Trial Balance: ${trialBalanceSummary.stored} account-year row(s) for FY [${trialBalanceSummary.years.join(', ')}]`);
  } catch (tbErr) {
    logger.warn(`  Trial Balance generation failed: ${tbErr.message}`);
    trialBalanceSummary = { error: tbErr.message, stored: 0, years: [], imbalancedYears: [] };
  }
  mark('trial_balance');

  // Accounting-equation invariant: ΔAssets = ΔLiabilities + ΔEquity + Net
  // Income for the year (see generateTrialBalance's doc comment for why this
  // — not a literal debit/credit sum — is the correct check for this
  // natural-balance sign convention). A real imbalance almost always means a
  // GL parsing bug or a misclassified account — never propagate a broken
  // Trial Balance into Monthly Balance Sheets/P&L/Cash Flow silently; stop
  // the pipeline here, the same way a missing-document gate halt does.
  if (trialBalanceSummary.imbalancedYears?.length) {
    for (const iy of trialBalanceSummary.imbalancedYears) {
      logger.warn(
        `  ✗ Trial Balance FY${iy.year} does not balance: ΔAssets=${iy.assetMovement} ΔLiabilities+Equity=${iy.liabilitiesPlusEquityMovement} ` +
        `NetIncome=${iy.netIncome} imbalance=${iy.imbalance} — top accounts by movement: ${iy.topAccounts.map((a) => a.accountName).join(', ')}` +
        (iy.unclassifiedAccounts.length ? ` — unclassified (excluded from equation): ${iy.unclassifiedAccounts.join(', ')}` : ''),
      );
    }
    const haltRows = await buildValidationResultsFromEntryTables(versionId, mappingsByCategory, years, logger);
    haltRows.push(...trialBalanceSummary.imbalancedYears.map((iy) => ({
      dataType: 'trial_balance',
      year: iy.year,
      status: 'error',
      severity: 'error',
      message:
        `Trial Balance for ${iy.year} does not balance — the change in Assets (${iy.assetMovement.toLocaleString()}) does not equal ` +
        `the change in Liabilities + Equity plus Net Income (${(iy.liabilitiesPlusEquityMovement + iy.netIncome).toLocaleString()}), ` +
        `a difference of ${Math.abs(iy.imbalance).toLocaleString()}. ` +
        `This usually indicates a General Ledger parsing issue (a missing offsetting entry, a sign error, a skipped row, or a misclassified account). ` +
        `Accounts with the largest movement that year: ${iy.topAccounts.map((a) => a.accountName).join(', ')}.` +
        (iy.unclassifiedAccounts.length ? ` Unclassified accounts excluded from this equation: ${iy.unclassifiedAccounts.join(', ')}.` : ''),
      metadata: { gate: 'trial_balance_imbalance', code: 'TRIAL_BALANCE_IMBALANCE', ...iy },
    })));
    await replaceValidationResults(versionId, companyId, haltRows);
    logger.log(`  ✓ ${haltRows.length} validation rows stored (workflow halted — Trial Balance imbalance)`);
    return {
      success: true,
      halted: true,
      batchId: null,
      datasetVersion: null,
      years,
      extractionResults,
      coaSummary,
      errors: extractionErrors.length > 0 ? extractionErrors : null,
      summary: {
        generated: false,
        halted: true,
        haltReason: 'trial_balance_imbalance',
        years,
        totalRowsInserted: totalRows,
        extractionResults,
        documents: gate,
        documentProcessing: docStats,
        timings,
        message: `Sync halted: Trial Balance does not balance for FY [${trialBalanceSummary.imbalancedYears.map((iy) => iy.year).join(', ')}]. Review the accounts listed and re-sync.`,
      },
      message: `Sync halted: Trial Balance does not balance for FY [${trialBalanceSummary.imbalancedYears.map((iy) => iy.year).join(', ')}]. Review the accounts listed and re-sync.`,
    };
  }

  // ── RECONCILIATION LAYER (mandatory — runs BEFORE Monthly Balance Sheet /
  // Monthly P&L / Cash Flow generation) ───────────────────────────────────────
  // "Opening Balance Sheet + General Ledger movements = Expected Closing
  // Balance Sheet" (BS Reconciliation) and "P&L generated entirely from the
  // General Ledger vs. uploaded P&L" (P&L Reconciliation) both run live off
  // GL data — neither depends on Monthly Balance Sheet/P&L having been
  // generated yet. Always runs, always reports (per-account + subtotal-level
  // for P&L), never blocks Monthly BS/P&L generation by itself — only a Trial
  // Balance imbalance (already handled above) halts the pipeline. A real
  // reconciliation difference is expected and normal (timing/rounding, an
  // account not yet mapped) and is reported, not hidden — matching how
  // QuickBooks/Xero/NetSuite always render statements alongside open
  // reconciling items.
  logger.log('--- Reconciliation Layer: Balance Sheet Reconciliation ---');
  let reconciliationSummary = null;
  try {
    const recon = await generateReconciliation(companyId, versionId, gate);
    reconciliationSummary = recon;
    if (recon.ran) {
      const s = recon.summary;
      logger.log(`  ✓ BS Reconciliation (FY ${recon.year}): ${recon.stored} row(s) — ${s.matched} matched, ${s.differences} differ, ${s.missingFromBs} missing-from-BS, ${s.missingFromGl} missing-from-GL, ${s.excluded} excluded`);
    } else {
      logger.log(`  – BS Reconciliation skipped (${recon.summary?.reason || 'no ending balance sheet'})`);
    }
  } catch (recErr) {
    logger.warn(`  BS Reconciliation failed: ${recErr.message}`);
    reconciliationSummary = { ran: false, error: recErr.message };
  }
  mark('bs_reconciliation');

  logger.log('--- Reconciliation Layer: Profit & Loss Reconciliation ---');
  let plReconciliation = { summaryByYear: new Map(), fileResults: [] };
  if (plMappings.length) {
    try {
      plReconciliation = await persistProfitLossReconciliation(companyId, versionId, plParsedByFile);
      for (const [year, s] of plReconciliation.summaryByYear) {
        logger.log(`  ✓ P&L Reconciliation FY${year}: ${s.matched} matched, ${s.differences} differ, ${s.missingFromPl} missing-from-P&L, ${s.missingFromGl} missing-from-GL, total variance=${s.totalVariance}`);
      }
    } catch (plReconErr) {
      logger.warn(`  P&L Reconciliation failed: ${plReconErr.message}`);
    }
  } else {
    logger.log('  – P&L Reconciliation skipped (no Profit & Loss file linked)');
  }
  mark('pl_reconciliation');

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

  // Monthly Balance Sheet A=L+E check (Phase 4, both engines) — the month is
  // always stored (removing it would break later months' carry-forward), but
  // an imbalance must never be silently invisible: surface every failed month
  // as its own error-severity validation row, with the exact imbalance amount
  // and the accounts involved.
  if (monthlyBsSummary?.failedMonths?.length) {
    logger.warn(`  ✗ Monthly Balance Sheet: ${monthlyBsSummary.failedMonths.length} month(s) failed to balance (Assets != Liabilities+Equity)`);
    for (const fm of monthlyBsSummary.failedMonths) {
      logger.warn(`    ${fm.asOfDate}: assets=${fm.assets} liabilities+equity=${fm.liabilitiesAndEquity} imbalance=${fm.imbalance}`);
      validationRows.push({
        dataType: 'monthly_balance_sheet',
        year: fm.year,
        status: 'error',
        severity: 'error',
        message:
          `Balance Sheet for ${fm.asOfDate} does not balance — Assets (${fm.assets.toLocaleString()}) do not equal ` +
          `Liabilities + Equity (${fm.liabilitiesAndEquity.toLocaleString()}), a difference of ${Math.abs(fm.imbalance).toLocaleString()}.` +
          (fm.unclassifiedAccounts.length ? ` Unclassified accounts excluded from this equation: ${fm.unclassifiedAccounts.join(', ')}.` : ''),
        metadata: { gate: 'monthly_bs_imbalance', code: 'MONTHLY_BS_IMBALANCE', ...fm },
      });
    }
  }

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

  // Step 7b: Balance Sheet reconciliation validation row — formats the result
  // already computed (and persisted to bs_reconciliation_entries) earlier in
  // the Reconciliation Layer, mirroring the Profit & Loss reconciliation
  // block below (same dataType-key-becomes-section-title convention the
  // frontend already uses for "profit_loss_reconciliation" — see
  // KeyReportSyncDashboard.jsx's EXTRA_ROW_LABEL fallback — so this needs no
  // frontend change to render its own "Balance Sheet Reconciliation" section).
  // No recomputation here — generateReconciliation already ran once, earlier
  // in the Reconciliation Layer, before Monthly BS/P&L/Cash Flow were generated.
  if (reconciliationSummary?.ran) {
    logger.log('--- Step 7b: Balance Sheet reconciliation validation row ---');
    const s = reconciliationSummary.summary;
    const matches = s.balanced;
    const accountsResponsible = matches ? [] : (reconciliationSummary.topDiffs || []);
    logger.log(
      `  BS Reconciliation FY${reconciliationSummary.year}: ${matches ? 'MATCH' : 'MISMATCH'} ` +
      `(${s.matched} matched, ${s.differences} differ, ${s.missingFromGl} missing-from-GL, ${s.missingFromBs} missing-from-BS, total variance=${s.totalVariance})`,
    );
    if (accountsResponsible.length) {
      logger.log(`    Accounts responsible (${reconciliationSummary.diffCount} total, showing top ${accountsResponsible.length}): ` +
        accountsResponsible.map((a) => `"${a.account_name}" (${a.variance >= 0 ? '+' : ''}${a.variance.toFixed(2)})`).join(', '));
    }
    validationRows.push({
      dataType: 'balance_sheet_reconciliation',
      year: reconciliationSummary.year,
      status: matches ? 'success' : 'warning',
      severity: matches ? 'success' : 'warning',
      message: matches
        ? `Uploaded Balance Sheet for ${reconciliationSummary.year} matches the GL-derived Balance Sheet (${s.matched} account(s) matched).`
        : `Uploaded Balance Sheet for ${reconciliationSummary.year} differs from the GL-derived Balance Sheet — ${s.differences} account(s) differ, ` +
          `${s.missingFromGl} missing from GL, ${s.missingFromBs} missing from the uploaded Balance Sheet, total variance ${s.totalVariance.toLocaleString()}.` +
          (accountsResponsible.length
            ? ` Accounts responsible: ${accountsResponsible.map((a) => `${a.account_name} (${a.variance >= 0 ? '+' : ''}${a.variance.toFixed(2)})`).join(', ')}` +
              (reconciliationSummary.diffCount > accountsResponsible.length ? ` (+${reconciliationSummary.diffCount - accountsResponsible.length} more)` : '') + '.'
            : ''),
      metadata: {
        year: reconciliationSummary.year,
        matched: s.matched,
        differences: s.differences,
        missingFromGl: s.missingFromGl,
        missingFromBs: s.missingFromBs,
        excluded: s.excluded,
        totalVariance: s.totalVariance,
        accountsResponsible,
        accountsResponsibleTotal: reconciliationSummary.diffCount,
      },
    });
  } else {
    logger.log(`  Step 7b: Balance Sheet reconciliation skipped (${reconciliationSummary?.summary?.reason || 'no ending balance sheet'}) — no validation row added.`);
  }

  // Step 7c: Profit & Loss reconciliation validation rows — formats the
  // results already computed (and persisted to pl_reconciliation_entries)
  // earlier in the Reconciliation Layer, before Monthly BS/P&L/Cash Flow were
  // generated. No recomputation here — accountLevelReconciliationDiff and
  // aggregateGLForBS already ran once, inside persistProfitLossReconciliation.
  if (plMappings.length) {
    logger.log(`--- Step 7c: Profit & Loss reconciliation validation rows (${plMappings.length} file(s)) ---`);
    const REASON_LABEL = {
      missing_in_gl: 'missing in GL',
      missing_in_uploaded: 'missing in uploaded P&L',
      classification_mismatch: 'wrong classification',
      unknown_account: 'unknown account',
      sign_issue: 'sign issue',
      amount_difference: 'amount difference',
    };
    for (const { fileName, error } of plParsedByFile) {
      if (error) {
        validationRows.push({
          dataType: 'profit_loss_reconciliation', year: null, status: 'error', severity: 'error',
          message: `Uploaded Profit & Loss "${fileName}" could not be parsed: ${error}`,
          metadata: { fileName, error },
        });
      }
    }
    if (!plReconciliation.fileResults.length) {
      logger.warn('  No file produced a comparable "Net Income" total line — reconciliation skipped.');
    }
    for (const fr of plReconciliation.fileResults) {
      const accountsResponsible = fr.matches ? [] : fr.topDiffs;
      logger.log(`  ${fr.fileName} FY${fr.year}: uploaded Net Income=${fr.uploadedNetIncome}, GL-derived=${fr.glNetIncome.toFixed(2)}, diff=${fr.diff} → ${fr.matches ? 'MATCH' : 'MISMATCH'}`);
      if (accountsResponsible.length) {
        logger.log(`    Accounts responsible (${fr.totalDiffs} total, showing top ${accountsResponsible.length}): ` +
          accountsResponsible.map((a) => `"${a.accountName}" (${a.diff >= 0 ? '+' : ''}${a.diff.toFixed(2)}, ${REASON_LABEL[a.reason] || a.reason})`).join(', '));
      }
      validationRows.push({
        dataType: 'profit_loss_reconciliation', year: fr.year, status: fr.matches ? 'success' : 'warning', severity: fr.matches ? 'success' : 'warning',
        message: fr.matches
          ? `Uploaded Profit & Loss Net Income for ${fr.year} matches the GL-derived Net Income (${fr.uploadedNetIncome.toLocaleString()}).`
          : `Uploaded Profit & Loss Net Income for ${fr.year} (${fr.uploadedNetIncome.toLocaleString()}) differs from the GL-derived Net Income (${fr.glNetIncome.toLocaleString()}) by ${Math.abs(fr.diff).toLocaleString()}.` +
            (accountsResponsible.length
              ? ` Accounts responsible: ${accountsResponsible.map((a) => `${a.accountName} (${a.diff >= 0 ? '+' : ''}${a.diff.toFixed(2)} — ${REASON_LABEL[a.reason] || a.reason})`).join(', ')}` +
                (fr.totalDiffs > accountsResponsible.length ? ` (+${fr.totalDiffs - accountsResponsible.length} more)` : '') + '.'
              : ''),
        metadata: { fileName: fr.fileName, uploadedNetIncome: fr.uploadedNetIncome, glDerivedNetIncome: fr.glNetIncome, diff: fr.diff, accountsResponsible, accountsResponsibleTotal: fr.totalDiffs },
      });
    }
  } else {
    logger.log('  Step 7c: no Profit & Loss file linked — reconciliation skipped (not required).');
  }

  // Step 7d: GL-vs-uploaded-P&L account validation report. Compares the AI's
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

module.exports = { generateFinancialTables, accountLevelReconciliationDiff, persistProfitLossReconciliation };
