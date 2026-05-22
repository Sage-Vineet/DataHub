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

  let { data, error } = await runUpsert(payload);
  if (error && isMissingColumnError(error, "dataset_version")) {
    const { dataset_version, ...legacyPayload } = payload;
    ({ data, error } = await runUpsert(legacyPayload));
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
    const [
      profitLossSummary,
      profitLossDetail,
      profitLossMonthlyDetail,
      balanceSheetSummary,
      balanceSheetMonthlyDetail,
      cashflowSummary,
      cashflowMonthlyDetail,
    ] = await Promise.all([
      getProfitLossSummaryFromStage(companyId, filters),
      getProfitLossDetailFromStage(companyId, filters),
      getProfitLossMonthlyDetailFromStage(companyId, filters),
      getBalanceSheetSummaryFromStage(companyId, filters),
      getBalanceSheetMonthlyDetailFromStage(companyId, filters),
      getCashflowSummaryFromStage(companyId, filters),
      getCashflowMonthlyDetailFromStage(companyId, filters),
    ]);

    await Promise.all([
      upsertReportingSnapshot({
        companyId,
        batchId,
        datasetVersion: resolvedDatasetVersion,
        reportType: SNAPSHOT_REPORT_TYPES.PROFIT_LOSS_SUMMARY,
        snapshotPayload: profitLossSummary,
        fiscalYear: year,
      }),
      upsertReportingSnapshot({
        companyId,
        batchId,
        datasetVersion: resolvedDatasetVersion,
        reportType: SNAPSHOT_REPORT_TYPES.PROFIT_LOSS_DETAIL,
        snapshotPayload: profitLossDetail,
        fiscalYear: year,
      }),
      upsertReportingSnapshot({
        companyId,
        batchId,
        datasetVersion: resolvedDatasetVersion,
        reportType: SNAPSHOT_REPORT_TYPES.PROFIT_LOSS_MONTHLY_DETAIL,
        snapshotPayload: profitLossMonthlyDetail,
        fiscalYear: year,
      }),
      upsertReportingSnapshot({
        companyId,
        batchId,
        datasetVersion: resolvedDatasetVersion,
        reportType: SNAPSHOT_REPORT_TYPES.BALANCE_SHEET_SUMMARY,
        snapshotPayload: balanceSheetSummary,
        fiscalYear: year,
      }),
      upsertReportingSnapshot({
        companyId,
        batchId,
        datasetVersion: resolvedDatasetVersion,
        reportType: SNAPSHOT_REPORT_TYPES.BALANCE_SHEET_MONTHLY_DETAIL,
        snapshotPayload: balanceSheetMonthlyDetail,
        fiscalYear: year,
      }),
      upsertReportingSnapshot({
        companyId,
        batchId,
        datasetVersion: resolvedDatasetVersion,
        reportType: SNAPSHOT_REPORT_TYPES.CASHFLOW_SUMMARY,
        snapshotPayload: cashflowSummary,
        fiscalYear: year,
      }),
      upsertReportingSnapshot({
        companyId,
        batchId,
        datasetVersion: resolvedDatasetVersion,
        reportType: SNAPSHOT_REPORT_TYPES.CASHFLOW_MONTHLY_DETAIL,
        snapshotPayload: cashflowMonthlyDetail,
        fiscalYear: year,
      }),
    ]);

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
  getSnapshotForActiveBatch,
  generateReportingSnapshotsForBatch,
};

