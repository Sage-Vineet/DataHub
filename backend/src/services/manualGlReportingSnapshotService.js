const { supabase } = require("../db");
const {
  getStageFilterOptions,
  getProfitLossSummaryFromStage,
  getProfitLossDetailFromStage,
  getProfitLossMonthlyDetailFromStage,
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

  const { data, error } = await supabase
    .from(TABLE_SNAPSHOTS)
    .select("dataset_version")
    .eq("company_id", companyId)
    .not("dataset_version", "is", null)
    .order("dataset_version", { ascending: false })
    .limit(Math.max(limit * 20, limit));

  if (error) {
    throw new Error(`Failed to list reporting snapshot dataset versions: ${error.message}`);
  }

  console.log(
    `[ManualGL][Versions][Snapshots][Rows] company=${companyId} rowCount=${Array.isArray(data) ? data.length : 0} ` +
    `rows=${JSON.stringify(Array.isArray(data) ? data.slice(0, 200) : [])}`,
  );

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

  return versions;
}

async function generateReportingSnapshotsForBatch(companyId, batchId) {
  if (!companyId || !batchId) {
    throw new Error("companyId and batchId are required for snapshot generation.");
  }

  const now = new Date().toISOString();
  const { data: batchRow } = await supabase
    .from("manual_gl_batches")
    .select("dataset_version")
    .eq("id", batchId)
    .eq("company_id", companyId)
    .maybeSingle();
  const datasetVersion = Number(batchRow?.dataset_version);
  const resolvedDatasetVersion =
    Number.isInteger(datasetVersion) && datasetVersion > 0 ? datasetVersion : null;

  const filterPayload = await getStageFilterOptions(companyId, {
    batchId,
    includeArchived: true,
    versionMode: "historical",
  });
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
      generatedAt: now,
    },
    fiscalYear: null,
  });
  snapshotCount += 1;

  const targets = years.length ? [null, ...years] : [null];

  for (const year of targets) {
    const filters = year
      ? {
        batchId,
        includeArchived: true,
        versionMode: "historical",
        fiscalYear: [String(year)],
        fiscalYears: [year],
      }
      : {
        batchId,
        includeArchived: true,
        versionMode: "historical",
      };

    // Build all report payloads for this fiscal slice.
    // Use retry logic for each report calculation to handle transient DB timeouts.
    const [
      profitLossSummary,
      profitLossDetail,
      profitLossMonthlyDetail,
      balanceSheetSummary,
      balanceSheetMonthlyDetail,
      cashflowSummary,
      cashflowMonthlyDetail,
    ] = await Promise.all([
      retrySupabaseOperation(() => getProfitLossSummaryFromStage(companyId, filters)),
      retrySupabaseOperation(() => getProfitLossDetailFromStage(companyId, filters)),
      retrySupabaseOperation(() => getProfitLossMonthlyDetailFromStage(companyId, filters)),
      retrySupabaseOperation(() => getBalanceSheetSummaryFromStage(companyId, filters)),
      retrySupabaseOperation(() => getBalanceSheetMonthlyDetailFromStage(companyId, filters)),
      retrySupabaseOperation(() => getCashflowSummaryFromStage(companyId, filters)),
      retrySupabaseOperation(() => getCashflowMonthlyDetailFromStage(companyId, filters)),
    ]);

    // Upsert snapshots. We process these sequentially instead of in massive
    // Promise.all blocks to avoid exhausting the DB connection pool during
    // high-volume orchestration.
    const snapshotTasks = [
      { type: SNAPSHOT_REPORT_TYPES.PROFIT_LOSS_SUMMARY, payload: profitLossSummary },
      { type: SNAPSHOT_REPORT_TYPES.PROFIT_LOSS_DETAIL, payload: profitLossDetail },
      { type: SNAPSHOT_REPORT_TYPES.PROFIT_LOSS_MONTHLY_DETAIL, payload: profitLossMonthlyDetail },
      { type: SNAPSHOT_REPORT_TYPES.BALANCE_SHEET_SUMMARY, payload: balanceSheetSummary },
      { type: SNAPSHOT_REPORT_TYPES.BALANCE_SHEET_MONTHLY_DETAIL, payload: balanceSheetMonthlyDetail },
      { type: SNAPSHOT_REPORT_TYPES.CASHFLOW_SUMMARY, payload: cashflowSummary },
      { type: SNAPSHOT_REPORT_TYPES.CASHFLOW_MONTHLY_DETAIL, payload: cashflowMonthlyDetail },
    ];

    for (const task of snapshotTasks) {
      await upsertReportingSnapshot({
        companyId,
        batchId,
        datasetVersion: resolvedDatasetVersion,
        reportType: task.type,
        snapshotPayload: task.payload,
        fiscalYear: year,
      });
    }

    snapshotCount += 7;
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

