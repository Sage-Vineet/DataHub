const { supabase } = require("../db");
const {
  queryStagedTransactions,
  getStageFilterOptions,
  getProfitLossSummaryFromStage,
  getProfitLossDetailFromStage,
  getProfitLossMonthlyDetailFromStage,
  getProfitLossVendorDetailFromStage,
  getVendorAnalysisFromStage,
  getBalanceSheetSummaryFromStage,
  getBalanceSheetMonthlyDetailFromStage,
  getCashflowSummaryFromStage,
  getCashflowMonthlyDetailFromStage,
  retrySupabaseOperation,
} = require("./manualGlMultiYearService");
const { getActiveUploadBatch } = require("./manualGlActiveBatchService");

const TABLE_SNAPSHOTS = "reporting_snapshots";
const ALL_YEARS_FISCAL = -1;

const SNAPSHOT_REPORT_TYPES = Object.freeze({
  FILTER_OPTIONS: "filter_options",
  PROFIT_LOSS_SUMMARY: "profit_loss_summary",
  PROFIT_LOSS_DETAIL: "profit_loss_detail",
  PROFIT_LOSS_MONTHLY_DETAIL: "profit_loss_monthly_detail",
  PROFIT_LOSS_DETAIL_VENDOR: "profit_loss_detail_vendor",
  VENDOR_ANALYSIS: "vendor_analysis",
  BALANCE_SHEET_SUMMARY: "balance_sheet_summary",
  BALANCE_SHEET_MONTHLY_DETAIL: "balance_sheet_monthly_detail",
  CASHFLOW_SUMMARY: "cashflow_summary",
  CASHFLOW_MONTHLY_DETAIL: "cashflow_monthly_detail",
});

function isMissingColumnError(error, columnName = "") {
  if (!error) return false;
  const message = String(error.message || "").toLowerCase();
  if (!message.includes("column")) return false;
  if (!columnName) return true;
  return message.includes(String(columnName).toLowerCase());
}

function normalizeFiscalYear(fiscalYear) {
  const year = Number(fiscalYear);
  if (!Number.isInteger(year) || year <= 0) {
    return ALL_YEARS_FISCAL;
  }
  return year;
}

function mapSnapshotRow(row) {
  if (!row) return null;
  const year = Number(row.fiscal_year);
  return {
    ...row,
    fiscal_year: Number.isInteger(year) && year > 0 ? year : null,
  };
}

function parseYears(options = {}) {
  const values = Array.isArray(options.fiscalYear) ? options.fiscalYear : [];
  return values
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0)
    .sort((a, b) => a - b);
}

async function upsertReportingSnapshot({
  companyId,
  batchId,
  datasetVersion = null,
  reportType,
  snapshotPayload,
  fiscalYear = null,
}) {
  if (!companyId || !batchId || !reportType) {
    throw new Error("companyId, batchId, and reportType are required for reporting snapshot upsert.");
  }

  const now = new Date().toISOString();
  const normalizedFiscalYear = normalizeFiscalYear(fiscalYear);

  const payload = {
    company_id: companyId,
    upload_batch_id: batchId,
    report_type: reportType,
    fiscal_year: normalizedFiscalYear,
    snapshot_payload: snapshotPayload && typeof snapshotPayload === "object"
      ? snapshotPayload
      : { value: snapshotPayload },
    generated_at: now,
    updated_at: now,
  };
  const parsedDatasetVersion = Number(datasetVersion);
  if (Number.isInteger(parsedDatasetVersion) && parsedDatasetVersion > 0) {
    payload.dataset_version = parsedDatasetVersion;
  }

  const existing = await getSnapshotForBatch({
    companyId,
    batchId,
    reportType,
    fiscalYear: normalizedFiscalYear,
  });

  if (existing?.id) {
    const existingDv = Number(existing.dataset_version || 0);
    const needsVersionTag =
      Number.isInteger(parsedDatasetVersion) && parsedDatasetVersion > 0 &&
      existingDv !== parsedDatasetVersion;

    if (!needsVersionTag) {
      return existing;
    }

    // The snapshot exists but was written before dataset_version was populated
    // (or was written with the wrong version number).  Back-fill it so that
    // getSnapshotForDatasetVersion can find it via the integer version column.
    const { data: tagged, error: tagError } = await supabase
      .from(TABLE_SNAPSHOTS)
      .update({ dataset_version: parsedDatasetVersion, updated_at: now })
      .eq("id", existing.id)
      .select("*")
      .maybeSingle();

    if (!tagError && tagged) {
      return mapSnapshotRow(tagged);
    }
    // Fall through to upsert if the back-fill update fails.
  }

  const runUpsert = async (rowPayload) =>
    supabase
      .from(TABLE_SNAPSHOTS)
      .upsert(rowPayload, {
        onConflict: "upload_batch_id,report_type,fiscal_year",
        ignoreDuplicates: false,
      })
      .select("*")
      .maybeSingle();

  let { data, error } = await retrySupabaseOperation(() => runUpsert(payload));
  if (error && isMissingColumnError(error, "dataset_version")) {
    const { dataset_version, ...legacyPayload } = payload;
    const legacyResult = await retrySupabaseOperation(() => runUpsert(legacyPayload));
    data = legacyResult.data;
    error = legacyResult.error;
  }

  if (error) {
    throw new Error(`Failed to upsert reporting snapshot (${reportType}): ${error.message}`);
  }

  return mapSnapshotRow(data || null);
}

async function getSnapshotForBatch({ companyId, batchId, reportType, fiscalYear = null }) {
  if (!companyId || !batchId || !reportType) return null;

  const normalizedFiscalYear = normalizeFiscalYear(fiscalYear);

  const { data, error } = await supabase
    .from(TABLE_SNAPSHOTS)
    .select("*")
    .eq("company_id", companyId)
    .eq("upload_batch_id", batchId)
    .eq("report_type", reportType)
    .eq("fiscal_year", normalizedFiscalYear)
    .order("generated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error && error.code !== "PGRST116") {
    throw new Error(`Failed to fetch reporting snapshot (${reportType}): ${error.message}`);
  }

  return mapSnapshotRow(data || null);
}

async function getSnapshotForDatasetVersion({
  companyId,
  datasetVersion,
  reportType,
  fiscalYear = null,
}) {
  if (!companyId || !reportType) return null;
  const parsedDatasetVersion = Number(datasetVersion);
  if (!Number.isInteger(parsedDatasetVersion) || parsedDatasetVersion <= 0) return null;

  const normalizedFiscalYear = normalizeFiscalYear(fiscalYear);

  const { data, error } = await supabase
    .from(TABLE_SNAPSHOTS)
    .select("*")
    .eq("company_id", companyId)
    .eq("dataset_version", parsedDatasetVersion)
    .eq("report_type", reportType)
    .eq("fiscal_year", normalizedFiscalYear)
    .order("generated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error && error.code !== "PGRST116") {
    throw new Error(
      `Failed to fetch reporting snapshot (${reportType}) for dataset_version=${parsedDatasetVersion}: ${error.message}`,
    );
  }

  return mapSnapshotRow(data || null);
}

async function getSnapshotForActiveBatch({ companyId, reportType, fiscalYear = null }) {
  if (!companyId || !reportType) return { snapshot: null, activeBatchId: null };

  const activeBatch = await getActiveUploadBatch(companyId);
  if (!activeBatch?.id) {
    return { snapshot: null, activeBatchId: null };
  }

  const snapshot = await getSnapshotForBatch({
    companyId,
    batchId: activeBatch.id,
    reportType,
    fiscalYear,
  });

  return {
    snapshot,
    activeBatchId: activeBatch.id,
  };
}

async function listReportingSnapshotDatasetVersions(companyId, limit = 50) {
  if (!companyId) return [];

  // Follow the SQL requirement:
  // SELECT DISTINCT dataset_version FROM reporting_snapshots
  // WHERE company_id = $1 AND dataset_version IS NOT NULL
  // ORDER BY dataset_version DESC;
  const { data, error } = await supabase
    .from(TABLE_SNAPSHOTS)
    .select("dataset_version")
    .eq("company_id", companyId)
    .not("dataset_version", "is", null)
    .order("dataset_version", { ascending: false });

  if (error) {
    throw new Error(`Failed to list reporting snapshot dataset versions: ${error.message}`);
  }

  // Deduplicate in JS since Supabase JS doesn't support DISTINCT natively.
  const seen = new Set();
  const versions = [];
  for (const row of Array.isArray(data) ? data : []) {
    const parsed = Number(row?.dataset_version);
    if (!Number.isInteger(parsed) || parsed <= 0) continue;
    if (seen.has(parsed)) continue;
    seen.add(parsed);
    versions.push(parsed);
    if (versions.length >= limit) break;
  }

  console.log(
    `[ManualGL][Versions][Snapshots] company=${companyId} uniqueCount=${versions.length} versions=[${versions.join(", ")}]`,
  );

  return versions;
}

async function generateReportingSnapshotsForBatch(companyId, batchId, options = {}) {
  if (!companyId || !batchId) {
    throw new Error("companyId and batchId are required for snapshot generation.");
  }

  const now = new Date().toISOString();
  let datasetVersionId = options.datasetVersionId || null;

  // Multi-version isolation: clear ONLY this batch's snapshots before
  // regenerating them.  Other versions' snapshots MUST be preserved so that
  // selecting a previously-staged version still returns its own cached reports.
  // (Scoping by upload_batch_id is what keeps versions from clobbering one
  // another — a company-wide delete here would wipe every other version.)
  const { error: snapDeleteError } = await supabase
    .from(TABLE_SNAPSHOTS)
    .delete()
    .eq("company_id", companyId)
    .eq("upload_batch_id", batchId);
  if (snapDeleteError) {
    console.warn(
      `[ManualGL][Snapshots] Failed to clear snapshots for batch=${batchId}: ${snapDeleteError.message}`,
    );
  } else {
    console.log(`[ManualGL][Snapshots] Cleared previous snapshots for batch=${batchId} (other versions preserved)`);
  }

  const { data: batchRow } = await supabase
    .from("manual_gl_batches")
    .select("dataset_version_id, dataset_version")
    .eq("id", batchId)
    .eq("company_id", companyId)
    .maybeSingle();

  if (!datasetVersionId) {
    datasetVersionId = batchRow?.dataset_version_id || null;
  }
  let datasetVersionNo = Number(batchRow?.dataset_version);

  // If the batch row doesn't have the integer version yet (written before activation
  // back-fills it), look it up directly from dataset_versions using the UUID.
  if ((!Number.isInteger(datasetVersionNo) || datasetVersionNo <= 0) && datasetVersionId) {
    const { data: versionRow } = await supabase
      .from("dataset_versions")
      .select("version_number")
      .eq("id", datasetVersionId)
      .maybeSingle();
    if (versionRow?.version_number) {
      datasetVersionNo = Number(versionRow.version_number);
      console.log(
        `[ManualGL][Snapshots] Resolved version_number=${datasetVersionNo} from dataset_versions for id=${datasetVersionId}`,
      );
    }
  }

  const resolvedDatasetVersion = Number.isInteger(datasetVersionNo) && datasetVersionNo > 0 ? datasetVersionNo : null;

  console.log(
    `[ManualGL][Snapshots] Starting generation for company=${companyId} batchId=${batchId} ` +
    `datasetVersion=${resolvedDatasetVersion} datasetVersionId=${datasetVersionId}`,
  );

  const sharedFilters = {
    batchId,
    datasetVersionId,
    includeArchived: true,
    versionMode: "historical",
  };

  const filterPayload = await getStageFilterOptions(companyId, sharedFilters);
  const years = parseYears(filterPayload?.options || {});

  let snapshotCount = 0;

  await upsertReportingSnapshot({
    companyId,
    batchId,
    datasetVersion: resolvedDatasetVersion,
    reportType: SNAPSHOT_REPORT_TYPES.FILTER_OPTIONS,
    snapshotPayload: {
      ...filterPayload,
      activeBatchId: batchId,
      datasetVersion: resolvedDatasetVersion,
      datasetVersionId: datasetVersionId,
      generatedAt: now,
    },
    fiscalYear: null,
  });
  snapshotCount += 1;

  // Process each fiscal year slice independently.
  //
  // PREVIOUS APPROACH (memory spike): loaded ALL batch transactions into Node.js
  // memory in a single queryStagedTransactions() call, then filtered in-memory.
  // For 100k+ row uploads this could exhaust the Node.js heap.
  //
  // NEW APPROACH (chunked per year): each fiscal year gets its own scoped query.
  // Memory usage is bounded to one year of data at a time. Years are processed
  // sequentially to keep connection count low; reports within a year are parallel.
  //
  // The "all years" slice (year=null) still runs first as a cross-year summary.
  const targets = years.length ? [null, ...years] : [null];

  for (const year of targets) {
    const yearFilters = {
      ...sharedFilters,
      ...(year ? { fiscalYear: [String(year)], fiscalYears: [year] } : {}),
    };

    const preloadStart = Date.now();
    // Each year's transactions are loaded once and reused across all 8 report builders.
    // This avoids 8 separate DB reads per year while keeping memory bounded per slice.
    const { rows: _preloadedRows } = await queryStagedTransactions(companyId, yearFilters);
    const filters = { ...yearFilters, _preloadedRows };

    console.log(
      `[ManualGL][Snapshots][Perf] year=${year ?? "ALL"} preloadedRows=${_preloadedRows.length} in ${Date.now() - preloadStart}ms`,
    );

    const yearStart = Date.now();

    // All report builders work from _preloadedRows — no additional DB queries.
    const [
      profitLossSummary,
      profitLossDetail,
      profitLossMonthlyDetail,
      balanceSheetSummary,
      balanceSheetMonthlyDetail,
      cashflowSummary,
      cashflowMonthlyDetail,
      profitLossVendorDetail,
      vendorAnalysis,
    ] = await Promise.all([
      getProfitLossSummaryFromStage(companyId, filters),
      getProfitLossDetailFromStage(companyId, filters),
      getProfitLossMonthlyDetailFromStage(companyId, filters),
      getBalanceSheetSummaryFromStage(companyId, filters),
      getBalanceSheetMonthlyDetailFromStage(companyId, filters),
      getCashflowSummaryFromStage(companyId, filters),
      getCashflowMonthlyDetailFromStage(companyId, filters),
      getProfitLossVendorDetailFromStage(companyId, filters),
      getVendorAnalysisFromStage(companyId, filters),
    ]);

    console.log(`[ManualGL][Snapshots][Perf] year=${year ?? "ALL"} reports=${Date.now() - yearStart}ms`);

    // Release the in-memory rows before moving to the next year.
    // The GC will reclaim this memory before the next year's preload.
    filters._preloadedRows = null;

    const snapshotTasks = [
      { type: SNAPSHOT_REPORT_TYPES.PROFIT_LOSS_SUMMARY, payload: profitLossSummary },
      { type: SNAPSHOT_REPORT_TYPES.PROFIT_LOSS_DETAIL, payload: profitLossDetail },
      { type: SNAPSHOT_REPORT_TYPES.PROFIT_LOSS_MONTHLY_DETAIL, payload: profitLossMonthlyDetail },
      { type: SNAPSHOT_REPORT_TYPES.BALANCE_SHEET_SUMMARY, payload: balanceSheetSummary },
      { type: SNAPSHOT_REPORT_TYPES.BALANCE_SHEET_MONTHLY_DETAIL, payload: balanceSheetMonthlyDetail },
      { type: SNAPSHOT_REPORT_TYPES.CASHFLOW_SUMMARY, payload: cashflowSummary },
      { type: SNAPSHOT_REPORT_TYPES.CASHFLOW_MONTHLY_DETAIL, payload: cashflowMonthlyDetail },
      { type: SNAPSHOT_REPORT_TYPES.PROFIT_LOSS_DETAIL_VENDOR, payload: profitLossVendorDetail },
      { type: SNAPSHOT_REPORT_TYPES.VENDOR_ANALYSIS, payload: vendorAnalysis },
    ];

    await Promise.all(
      snapshotTasks.map((task) =>
        upsertReportingSnapshot({
          companyId,
          batchId,
          datasetVersion: resolvedDatasetVersion,
          reportType: task.type,
          snapshotPayload: task.payload,
          fiscalYear: year,
        }),
      ),
    );

    snapshotCount += snapshotTasks.length;
  }

  return {
    batchId,
    datasetVersion: resolvedDatasetVersion,
    years,
    snapshotCount,
    generatedAt: now,
  };
}

module.exports = {
  ALL_YEARS_FISCAL,
  SNAPSHOT_REPORT_TYPES,
  upsertReportingSnapshot,
  getSnapshotForBatch,
  getSnapshotForDatasetVersion,
  getSnapshotForActiveBatch,
  listReportingSnapshotDatasetVersions,
  generateReportingSnapshotsForBatch,
};

