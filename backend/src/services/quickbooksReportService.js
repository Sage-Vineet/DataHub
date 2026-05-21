const axios = require("axios");
const tokenManager = require("../tokenManager");
const { getQBConfig, loadQBConfig } = require("../qbconfig");
const { supabase } = require("../db");
const {
  REPORT_SOURCE_KEYS,
  updateReportSourceRecord,
} = require("./reportSourceStore");
const {
  DEFAULT_SYNC_SOURCE,
  sanitizeReportParams,
  upsertSyncedReport,
  getCachedReport,
  getAllCachedReports,
  getSyncMetadata,
  updateSyncMetadata,
  createDatasetVersion,
  getLatestFinalizedDataset,
  listReportsForDataset,
  createSyncJob,
  getRunningSyncJob,
  updateSyncJob,
  appendSyncLog,
  setActiveDataset,
  markDatasetFailed,
  updateDatasetVersion,
} = require("./quickbooksSyncStore");

const REPORT_TYPES = {
  PROFIT_AND_LOSS: "profit_and_loss",
  PROFIT_AND_LOSS_DETAIL: "profit_and_loss_detail",
  BALANCE_SHEET: "balance_sheet",
  BALANCE_SHEET_DETAIL: "balance_sheet_detail",
  CASH_FLOW: "cash_flow",
  GENERAL_LEDGER: "general_ledger",
  TRIAL_BALANCE: "trial_balance",
  ACCOUNT_LIST: "account_list",
  AGED_RECEIVABLE_DETAIL: "aged_receivable_detail",
  AGED_PAYABLE_DETAIL: "aged_payable_detail",
  CASH_SALES: "cash_sales",
  INVOICES: "invoices",
  CUSTOMERS: "customers",
  ACCOUNTS: "accounts",
  TRANSACTIONS: "transactions",
  CASHFLOW_ENGINE: "cashflow_engine",
};

const DEFAULT_MINOR_VERSION = 75;

function nowIso() {
  return new Date().toISOString();
}

function toIsoDate(date) {
  if (!date) return null;
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function compactObject(input = {}) {
  const output = {};
  for (const [key, value] of Object.entries(input || {})) {
    if (value === undefined || value === null || value === "") continue;
    output[key] = value;
  }
  return output;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function formatQuickBooksTimestamp(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function escapeQueryLiteral(value) {
  return String(value || "").replace(/'/g, "''");
}

function buildYearlyRanges({ yearsBack = 4, endDate = null } = {}) {
  const end = toIsoDate(endDate) || toIsoDate(new Date());
  const endYear = Number(String(end).slice(0, 4));
  const back = Math.max(1, Math.min(10, Number(yearsBack) || 4));

  const ranges = [];
  for (let offset = back - 1; offset >= 0; offset -= 1) {
    const year = endYear - offset;
    ranges.push({
      fiscalYear: year,
      start: `${year}-01-01`,
      end: year === endYear ? end : `${year}-12-31`,
    });
  }

  return ranges;
}

function buildMonthlyRanges({ monthsBack = 18, endDate = null } = {}) {
  const end = endDate ? new Date(endDate) : new Date();
  if (Number.isNaN(end.getTime())) return [];

  const safeMonthsBack = Math.max(1, Math.min(36, Number(monthsBack) || 18));
  const ranges = [];

  for (let i = safeMonthsBack - 1; i >= 0; i -= 1) {
    const monthStart = new Date(end.getFullYear(), end.getMonth() - i, 1);
    const monthEnd = new Date(end.getFullYear(), end.getMonth() - i + 1, 0);
    ranges.push({
      fiscalYear: monthStart.getFullYear(),
      start: toIsoDate(monthStart),
      end: toIsoDate(monthEnd),
    });
  }

  return ranges;
}

function buildSyncTasks(options = {}) {
  const yearly = buildYearlyRanges(options);
  const monthly = buildMonthlyRanges(options);
  const incremental = options.incremental !== false;
  const lastSuccessfulSync = formatQuickBooksTimestamp(options.lastSuccessfulSync);

  const baseTasks = [
    {
      type: REPORT_TYPES.BALANCE_SHEET,
      mode: "report",
      qbName: "BalanceSheet",
      params: {},
    },
    {
      type: REPORT_TYPES.PROFIT_AND_LOSS,
      mode: "report",
      qbName: "ProfitAndLoss",
      params: {},
    },
    {
      type: REPORT_TYPES.CASH_FLOW,
      mode: "report",
      qbName: "CashFlow",
      params: {},
    },
    {
      type: REPORT_TYPES.ACCOUNT_LIST,
      mode: "report",
      qbName: "AccountList",
      params: {},
    },
    {
      type: REPORT_TYPES.AGED_PAYABLE_DETAIL,
      mode: "report",
      qbName: "AgedPayableDetail",
      params: {},
    },
    {
      type: REPORT_TYPES.AGED_RECEIVABLE_DETAIL,
      mode: "report",
      qbName: "AgedReceivableDetail",
      params: {},
    },
    {
      type: REPORT_TYPES.TRIAL_BALANCE,
      mode: "report",
      qbName: "TrialBalance",
      params: {},
    },
    {
      type: REPORT_TYPES.CASH_SALES,
      mode: "report",
      qbName: "CashSales",
      params: {},
    },
    {
      type: REPORT_TYPES.INVOICES,
      mode: "query",
      queryEntity: "Invoice",
      incremental,
      pageSize: 1000,
      params: {
        startposition: "1",
        maxresults: "1000",
        ...(lastSuccessfulSync ? { last_successful_sync: lastSuccessfulSync } : {}),
      },
    },
    {
      type: REPORT_TYPES.CUSTOMERS,
      mode: "query",
      queryEntity: "Customer",
      incremental,
      pageSize: 1000,
      params: {
        startposition: "1",
        maxresults: "1000",
        ...(lastSuccessfulSync ? { last_successful_sync: lastSuccessfulSync } : {}),
      },
    },
    {
      type: REPORT_TYPES.ACCOUNTS,
      mode: "query",
      queryEntity: "Account",
      incremental: false,
      pageSize: 1000,
      params: { startposition: "1", maxresults: "1000" },
    },
  ];

  const yearlyTasks = yearly.flatMap((range) => {
    const periodParams = {
      start_date: range.start,
      end_date: range.end,
      accounting_method: options.accountingMethod || "Accrual",
    };

    return [
      {
        type: REPORT_TYPES.PROFIT_AND_LOSS,
        mode: "report",
        qbName: "ProfitAndLoss",
        params: periodParams,
        periodStart: range.start,
        periodEnd: range.end,
        fiscalYear: range.fiscalYear,
      },
      {
        type: REPORT_TYPES.PROFIT_AND_LOSS_DETAIL,
        mode: "report",
        qbName: "ProfitAndLossDetail",
        params: periodParams,
        periodStart: range.start,
        periodEnd: range.end,
        fiscalYear: range.fiscalYear,
      },
      {
        type: REPORT_TYPES.BALANCE_SHEET,
        mode: "report",
        qbName: "BalanceSheet",
        params: {
          ...periodParams,
          as_of_date: range.end,
        },
        periodStart: range.start,
        periodEnd: range.end,
        fiscalYear: range.fiscalYear,
      },
      {
        type: REPORT_TYPES.BALANCE_SHEET_DETAIL,
        mode: "report",
        qbName: "BalanceSheet",
        params: {
          ...periodParams,
          summarize_column_by: "Total",
          as_of_date: range.end,
        },
        periodStart: range.start,
        periodEnd: range.end,
        fiscalYear: range.fiscalYear,
      },
      {
        type: REPORT_TYPES.CASH_FLOW,
        mode: "report",
        qbName: "CashFlow",
        params: periodParams,
        periodStart: range.start,
        periodEnd: range.end,
        fiscalYear: range.fiscalYear,
      },
      {
        type: REPORT_TYPES.GENERAL_LEDGER,
        mode: "report",
        qbName: "GeneralLedger",
        params: periodParams,
        periodStart: range.start,
        periodEnd: range.end,
        fiscalYear: range.fiscalYear,
      },
    ];
  });

  const monthlyTrendTasks = monthly.map((range) => ({
    type: REPORT_TYPES.PROFIT_AND_LOSS,
    mode: "report",
    qbName: "ProfitAndLoss",
    params: {
      start_date: range.start,
      end_date: range.end,
      accounting_method: options.accountingMethod || "Accrual",
    },
    periodStart: range.start,
    periodEnd: range.end,
    fiscalYear: range.fiscalYear,
  }));

  return [...baseTasks, ...yearlyTasks, ...monthlyTrendTasks];
}

async function fetchWithTokenRetry(clientId, url, params = {}) {
  const qb = getQBConfig(clientId);

  const request = async (token) =>
    axios.get(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      params: {
        ...params,
        minorversion: DEFAULT_MINOR_VERSION,
      },
    });

  try {
    return await request(qb.accessToken);
  } catch (error) {
    if (error.response?.status === 401) {
      const newToken = await tokenManager.refreshAccessToken(clientId);
      return request(newToken);
    }
    throw error;
  }
}

async function fetchQueryWithRetry(clientId, queryString) {
  const qb = getQBConfig(clientId);
  const url = `${qb.baseUrl}/v3/company/${qb.realmId}/query`;

  const request = async (token) =>
    axios.get(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      params: {
        query: queryString,
        minorversion: DEFAULT_MINOR_VERSION,
      },
    });

  try {
    return await request(qb.accessToken);
  } catch (error) {
    if (error.response?.status === 401) {
      const newToken = await tokenManager.refreshAccessToken(clientId);
      return request(newToken);
    }
    throw error;
  }
}

function buildPagedQuery({
  entity,
  startPosition = 1,
  maxResults = 1000,
  lastSuccessfulSync = null,
  incremental = false,
}) {
  if (!entity) throw new Error("buildPagedQuery requires an entity");

  const safeEntity = String(entity).trim();
  const safeStartPosition = Math.max(1, Number(startPosition) || 1);
  const safeMaxResults = Math.max(1, Math.min(1000, Number(maxResults) || 1000));
  const syncTimestamp = formatQuickBooksTimestamp(lastSuccessfulSync);
  const shouldFilterByUpdatedAt =
    incremental === true &&
    Boolean(syncTimestamp) &&
    (safeEntity === "Invoice" || safeEntity === "Customer");

  const filterClause = shouldFilterByUpdatedAt
    ? ` WHERE MetaData.LastUpdatedTime > '${escapeQueryLiteral(syncTimestamp)}'`
    : "";

  return `SELECT * FROM ${safeEntity}${filterClause} STARTPOSITION ${safeStartPosition} MAXRESULTS ${safeMaxResults}`;
}

async function fetchPaginatedQueryWithRetry(clientId, task) {
  const entity = task.queryEntity;
  if (!entity) {
    throw new Error(`Query sync task is missing queryEntity (${task.type}).`);
  }

  const pageSize = Math.max(1, Math.min(1000, Number(task.pageSize) || 1000));
  const maxPages = Math.max(1, Math.min(100, Number(task.maxPages) || 40));
  const incremental = task.incremental === true;
  const lastSuccessfulSync = task?.params?.last_successful_sync || null;

  const allRows = [];
  let startPosition = 1;
  let pageCount = 0;

  while (pageCount < maxPages) {
    const query = buildPagedQuery({
      entity,
      startPosition,
      maxResults: pageSize,
      lastSuccessfulSync,
      incremental,
    });

    const response = await fetchQueryWithRetry(clientId, query);
    const rows = asArray(response?.data?.QueryResponse?.[entity]);

    if (rows.length > 0) {
      allRows.push(...rows);
    }

    pageCount += 1;

    if (rows.length < pageSize) {
      break;
    }

    startPosition += pageSize;
  }

  return {
    QueryResponse: {
      [entity]: allRows,
      startPosition: 1,
      maxResults: allRows.length,
      totalCount: allRows.length,
    },
    metaData: {
      paginated: true,
      pageCount,
      pageSize,
      incremental,
      lastSuccessfulSync: formatQuickBooksTimestamp(lastSuccessfulSync),
    },
  };
}

async function fetchLiveTask(clientId, task) {
  const qb = getQBConfig(clientId);
  if (!qb || !qb.accessToken || !qb.realmId) {
    throw new Error("QuickBooks connection unavailable for live sync.");
  }

  if (task.mode === "report") {
    const url = `${qb.baseUrl}/v3/company/${qb.realmId}/reports/${task.qbName}`;
    const response = await fetchWithTokenRetry(clientId, url, compactObject(task.params || {}));
    return response.data;
  }

  if (task.mode === "query") {
    if (task.queryEntity) {
      return fetchPaginatedQueryWithRetry(clientId, task);
    }
    const response = await fetchQueryWithRetry(clientId, task.query);
    return response.data;
  }

  throw new Error(`Unsupported sync task mode: ${task.mode}`);
}

async function updateConnectionStatus(companyId, patch = {}) {
  if (!companyId) return;

  const now = nowIso();
  const payload = {
    company_id: companyId,
    source: DEFAULT_SYNC_SOURCE,
    is_connected: patch.isConnected === true,
    disconnected_at: patch.disconnectedAt || null,
    disconnected_reason: patch.disconnectedReason || null,
    last_checked_at: now,
    metadata: patch.metadata && typeof patch.metadata === "object" ? patch.metadata : {},
    updated_at: now,
  };

  await supabase
    .from("connection_status")
    .upsert(payload, { onConflict: "company_id,source" });
}

function buildSnapshotResult(row, disconnected = false) {
  if (!row) return null;

  return {
    data: row.data,
    source: "cached_snapshot",
    lastSyncedAt: row.last_synced_at || row.finalized_at || null,
    datasetVersion: row.dataset_version || null,
    reportParams: row.report_params || {},
    disconnected,
    syncStatus: row.sync_status || null,
  };
}

async function serveCachedReport(clientId, reportType, queryParams = {}, options = {}) {
  const syncSource = options.syncSource || DEFAULT_SYNC_SOURCE;
  const activeDataset = await getLatestFinalizedDataset(clientId, syncSource);

  const cached = await getCachedReport({
    companyId: clientId,
    reportType,
    reportParams: sanitizeReportParams(queryParams),
    datasetVersion: activeDataset?.dataset_version || null,
    syncSource,
    includeInactive: false,
  });

  if (cached) {
    return buildSnapshotResult(cached, options.disconnected === true);
  }

  const fallback = await getCachedReport({
    companyId: clientId,
    reportType,
    reportParams: sanitizeReportParams(queryParams),
    syncSource,
    includeInactive: true,
  });

  return fallback ? buildSnapshotResult(fallback, options.disconnected === true) : null;
}

async function fetchAndCacheReport(clientId, reportType, _qbReportName, queryParams = {}) {
  const cached = await serveCachedReport(clientId, reportType, queryParams, {
    disconnected: false,
  });

  if (!cached) {
    throw new Error(
      `No finalized snapshot available for ${reportType}. Run /api/quickbooks/sync first.`,
    );
  }

  return cached;
}

async function fetchAndCacheQuery(clientId, reportType, _queryString, queryParams = {}) {
  const cached = await serveCachedReport(clientId, reportType, queryParams, {
    disconnected: false,
  });

  if (!cached) {
    throw new Error(
      `No finalized snapshot available for ${reportType}. Run /api/quickbooks/sync first.`,
    );
  }

  return cached;
}

async function syncAllReports(clientId, options = {}) {
  if (!clientId) {
    throw new Error("syncAllReports: clientId is required");
  }

  const running = await getRunningSyncJob(clientId, DEFAULT_SYNC_SOURCE);
  if (running) {
    return {
      companyId: clientId,
      syncJobId: running.id,
      status: running.status,
      alreadyRunning: true,
      hasErrors: false,
      message: "A QuickBooks sync job is already running for this company.",
    };
  }

  await loadQBConfig(clientId);
  const qb = getQBConfig(clientId);

  if (!qb || !qb.accessToken || !qb.realmId) {
    await updateConnectionStatus(clientId, {
      isConnected: false,
      disconnectedAt: nowIso(),
      disconnectedReason: "missing_tokens",
      metadata: { reason: "missing_tokens" },
    });

    await updateSyncMetadata(clientId, {
      syncStatus: "failed",
      syncProgress: 100,
      currentJobId: null,
      currentDatasetVersion: null,
      lastAttemptedSync: nowIso(),
      lastError: "QuickBooks connection is missing or disconnected.",
      metadata: { reason: "missing_tokens" },
    });

    throw new Error("QuickBooks connection is missing or disconnected.");
  }

  const previousSyncMetadata = await getSyncMetadata(clientId, DEFAULT_SYNC_SOURCE);
  const previousSuccessfulSync = previousSyncMetadata?.last_successful_sync || null;
  const incrementalSync = options.incremental !== false;
  const requestedBy = options.requestedBy || null;
  const syncRequestedAt = nowIso();

  const syncJob = await createSyncJob({
    companyId: clientId,
    syncSource: DEFAULT_SYNC_SOURCE,
    requestedBy,
    status: "running",
    payload: {
      accountingMethod: options.accountingMethod || "Accrual",
      yearsBack: options.yearsBack || 4,
      monthsBack: options.monthsBack || 18,
      incremental: incrementalSync,
      previousSuccessfulSync,
      requestedAt: syncRequestedAt,
    },
  });
  if (syncJob?.alreadyRunning) {
    return {
      companyId: clientId,
      syncJobId: syncJob.id,
      status: syncJob.status || "running",
      alreadyRunning: true,
      hasErrors: false,
      message: "A QuickBooks sync job is already running for this company.",
    };
  }

  const dataset = await createDatasetVersion({
    companyId: clientId,
    syncSource: DEFAULT_SYNC_SOURCE,
    source: DEFAULT_SYNC_SOURCE,
    status: "staging",
    isActive: false,
    syncJobId: syncJob.id,
    metadata: {
      requestedBy,
      requestedAt: syncRequestedAt,
      qbRealmId: qb.realmId,
      incremental: incrementalSync,
      previousSuccessfulSync,
    },
  });

  await updateSyncJob(syncJob.id, {
    datasetVersion: dataset.id,
    startedAt: syncRequestedAt,
    status: "running",
    progress: 0,
  });

  await updateSyncMetadata(clientId, {
    syncStatus: "running",
    syncProgress: 0,
    currentJobId: syncJob.id,
    currentDatasetVersion: dataset.id,
    lastAttemptedSync: syncRequestedAt,
    lastError: null,
    metadata: {
      datasetVersion: dataset.id,
      requestedBy,
    },
  });

  await appendSyncLog({
    syncJobId: syncJob.id,
    companyId: clientId,
    datasetVersion: dataset.id,
    level: "info",
    message: "QuickBooks sync started.",
    context: {
      yearsBack: options.yearsBack || 4,
      monthsBack: options.monthsBack || 18,
      incremental: incrementalSync,
      previousSuccessfulSync,
    },
  });

  const tasks = buildSyncTasks({
    ...options,
    incremental: incrementalSync,
    lastSuccessfulSync: previousSuccessfulSync,
  });
  const totalTasks = tasks.length;
  const results = {};
  const errors = [];

  for (let index = 0; index < tasks.length; index += 1) {
    const task = tasks[index];
    const progress = Math.round((((index + 1) / totalTasks) * 100 + Number.EPSILON) * 100) / 100;

    try {
      const payload = await fetchLiveTask(clientId, task);
      const savedReport = await upsertSyncedReport({
        companyId: clientId,
        reportType: task.type,
        reportParams: sanitizeReportParams(task.params || {}),
        data: payload,
        source: DEFAULT_SYNC_SOURCE,
        syncSource: DEFAULT_SYNC_SOURCE,
        datasetVersion: dataset.id,
        syncJobId: syncJob.id,
        syncStatus: "staged",
        syncProgress: progress,
        periodStart: task.periodStart || null,
        periodEnd: task.periodEnd || null,
        fiscalYear: task.fiscalYear || null,
        isActive: false,
      });

      if (!savedReport) {
        throw new Error(`No storable payload returned for ${task.type}.`);
      }

      results[`${task.type}:${JSON.stringify(sanitizeReportParams(task.params || {}))}`] = {
        success: true,
        reportType: task.type,
        params: sanitizeReportParams(task.params || {}),
      };

      await appendSyncLog({
        syncJobId: syncJob.id,
        companyId: clientId,
        datasetVersion: dataset.id,
        level: "info",
        message: `Synced ${task.type}`,
        context: {
          reportType: task.type,
          params: sanitizeReportParams(task.params || {}),
          progress,
        },
      });
    } catch (error) {
      const errorMessage = error.response?.data?.Fault?.Error?.[0]?.Message || error.message;

      errors.push({
        reportType: task.type,
        params: sanitizeReportParams(task.params || {}),
        error: errorMessage,
      });

      results[`${task.type}:${JSON.stringify(sanitizeReportParams(task.params || {}))}`] = {
        success: false,
        reportType: task.type,
        params: sanitizeReportParams(task.params || {}),
        error: errorMessage,
      };

      await appendSyncLog({
        syncJobId: syncJob.id,
        companyId: clientId,
        datasetVersion: dataset.id,
        level: "error",
        message: `Failed syncing ${task.type}`,
        context: {
          reportType: task.type,
          params: sanitizeReportParams(task.params || {}),
          error: errorMessage,
        },
      });
    }

    await updateSyncJob(syncJob.id, {
      status: "running",
      progress,
    });

    await updateSyncMetadata(clientId, {
      syncStatus: "running",
      syncProgress: progress,
      currentJobId: syncJob.id,
      currentDatasetVersion: dataset.id,
      lastAttemptedSync: syncRequestedAt,
      lastError: null,
      metadata: {
        totalTasks,
        completedTasks: index + 1,
      },
    });
  }

  const finishedAt = nowIso();
  const hasErrors = errors.length > 0;

  if (hasErrors) {
    const errorSummary = `${errors.length} sync task(s) failed.`;

    await markDatasetFailed({
      companyId: clientId,
      datasetVersion: dataset.id,
      syncSource: DEFAULT_SYNC_SOURCE,
      syncJobId: syncJob.id,
      errorMessage: errorSummary,
    });

    await updateSyncJob(syncJob.id, {
      status: "failed",
      progress: 100,
      completedAt: finishedAt,
      error: errorSummary,
    });

    const activeBefore = await getLatestFinalizedDataset(clientId, DEFAULT_SYNC_SOURCE);

    await updateSyncMetadata(clientId, {
      syncStatus: "failed",
      syncProgress: 100,
      currentJobId: null,
      currentDatasetVersion: activeBefore?.dataset_version || null,
      lastAttemptedSync: finishedAt,
      lastError: errorSummary,
      metadata: {
        failedDatasetVersion: dataset.id,
        errors,
      },
    });

    await updateConnectionStatus(clientId, {
      isConnected: true,
      disconnectedAt: null,
      disconnectedReason: null,
      metadata: {
        lastSyncJobId: syncJob.id,
        lastSyncResult: "failed",
      },
    });

    await appendSyncLog({
      syncJobId: syncJob.id,
      companyId: clientId,
      datasetVersion: dataset.id,
      level: "error",
      message: "QuickBooks sync failed; active snapshot not switched.",
      context: { errorSummary, errors },
    });

    return {
      companyId: clientId,
      syncJobId: syncJob.id,
      datasetVersion: dataset.id,
      syncedAt: finishedAt,
      results,
      errors,
      hasErrors: true,
      message: "Sync completed with failures. Existing finalized snapshot remains active.",
    };
  }

  const stagedReports = await listReportsForDataset(clientId, dataset.id, DEFAULT_SYNC_SOURCE);
  const stagedReportTypes = new Set((stagedReports || []).map((entry) => entry.report_type));
  const requiredReportTypes = [
    REPORT_TYPES.BALANCE_SHEET,
    REPORT_TYPES.PROFIT_AND_LOSS,
    REPORT_TYPES.CASH_FLOW,
  ];
  const missingRequiredReports = requiredReportTypes.filter(
    (reportType) => !stagedReportTypes.has(reportType),
  );

  if (missingRequiredReports.length > 0) {
    const finalizationError = `Finalization blocked. Missing required staged reports: ${missingRequiredReports.join(", ")}`;

    await markDatasetFailed({
      companyId: clientId,
      datasetVersion: dataset.id,
      syncSource: DEFAULT_SYNC_SOURCE,
      syncJobId: syncJob.id,
      errorMessage: finalizationError,
    });
    await updateSyncJob(syncJob.id, {
      status: "failed",
      progress: 100,
      completedAt: finishedAt,
      error: finalizationError,
    });
    const activeBefore = await getLatestFinalizedDataset(clientId, DEFAULT_SYNC_SOURCE);
    await updateSyncMetadata(clientId, {
      syncStatus: "failed",
      syncProgress: 100,
      currentJobId: null,
      currentDatasetVersion: activeBefore?.dataset_version || null,
      lastAttemptedSync: finishedAt,
      lastError: finalizationError,
      metadata: {
        failedDatasetVersion: dataset.id,
        missingRequiredReports,
      },
    });
    await appendSyncLog({
      syncJobId: syncJob.id,
      companyId: clientId,
      datasetVersion: dataset.id,
      level: "error",
      message: "QuickBooks sync finalization blocked due to missing staged reports.",
      context: {
        missingRequiredReports,
      },
    });

    return {
      companyId: clientId,
      syncJobId: syncJob.id,
      datasetVersion: dataset.id,
      syncedAt: finishedAt,
      results,
      errors: [
        {
          reportType: "finalization",
          error: finalizationError,
        },
      ],
      hasErrors: true,
      message: "Sync staged data failed finalization checks. Existing finalized snapshot remains active.",
    };
  }

  try {
    await setActiveDataset({
      companyId: clientId,
      datasetVersion: dataset.id,
      finalizedBy: requestedBy,
      syncSource: DEFAULT_SYNC_SOURCE,
      syncJobId: syncJob.id,
      metadata: {
        totalTasks,
        successfulTasks: totalTasks,
      },
    });

    await updateDatasetVersion(dataset.id, {
      status: "finalized",
      isActive: true,
      finalizedAt: finishedAt,
      finalizedBy: requestedBy,
      syncJobId: syncJob.id,
      metadata: {
        totalTasks,
        successfulTasks: totalTasks,
        finalizedAt: finishedAt,
      },
    });
  } catch (finalizeError) {
    const finalizationError = `Dataset finalization failed: ${finalizeError.message}`;
    await markDatasetFailed({
      companyId: clientId,
      datasetVersion: dataset.id,
      syncSource: DEFAULT_SYNC_SOURCE,
      syncJobId: syncJob.id,
      errorMessage: finalizationError,
    });
    await updateSyncJob(syncJob.id, {
      status: "failed",
      progress: 100,
      completedAt: finishedAt,
      error: finalizationError,
    });
    const activeBefore = await getLatestFinalizedDataset(clientId, DEFAULT_SYNC_SOURCE);
    await updateSyncMetadata(clientId, {
      syncStatus: "failed",
      syncProgress: 100,
      currentJobId: null,
      currentDatasetVersion: activeBefore?.dataset_version || null,
      lastAttemptedSync: finishedAt,
      lastError: finalizationError,
      metadata: {
        failedDatasetVersion: dataset.id,
      },
    });
    await appendSyncLog({
      syncJobId: syncJob.id,
      companyId: clientId,
      datasetVersion: dataset.id,
      level: "error",
      message: "QuickBooks dataset finalization failed; old snapshot kept active.",
      context: {
        error: finalizationError,
      },
    });

    return {
      companyId: clientId,
      syncJobId: syncJob.id,
      datasetVersion: dataset.id,
      syncedAt: finishedAt,
      results,
      errors: [
        {
          reportType: "finalization",
          error: finalizationError,
        },
      ],
      hasErrors: true,
      message: "Sync completed but finalization failed. Existing finalized snapshot remains active.",
    };
  }

  await updateSyncJob(syncJob.id, {
    status: "completed",
    progress: 100,
    completedAt: finishedAt,
    error: null,
  });

  await updateSyncMetadata(clientId, {
    syncStatus: "idle",
    syncProgress: 100,
    currentJobId: null,
    currentDatasetVersion: dataset.id,
    lastSuccessfulSync: finishedAt,
    lastAttemptedSync: finishedAt,
    lastError: null,
    metadata: {
      totalTasks,
      successfulTasks: totalTasks,
      lastSyncJobId: syncJob.id,
    },
  });

  await updateConnectionStatus(clientId, {
    isConnected: true,
    disconnectedAt: null,
    disconnectedReason: null,
    metadata: {
      lastSyncJobId: syncJob.id,
      activeDatasetVersion: dataset.id,
      lastSuccessfulSync: finishedAt,
    },
  });

  await updateReportSourceRecord(clientId, REPORT_SOURCE_KEYS.QUICKBOOKS, {
    isAvailable: true,
    isConnected: true,
    lastSyncedAt: finishedAt,
    metadata: {
      activeDatasetVersion: dataset.id,
      syncJobId: syncJob.id,
      totalReports: totalTasks,
      lastSyncResult: "success",
    },
  }).catch((syncError) => {
    console.warn("[ReportService] Failed to update QuickBooks source metadata:", syncError.message);
  });

  await supabase
    .from("quickbooks_connections")
    .update({ last_synced: finishedAt, updated_at: finishedAt })
    .eq("company_id", clientId);

  await appendSyncLog({
    syncJobId: syncJob.id,
    companyId: clientId,
    datasetVersion: dataset.id,
    level: "info",
    message: "QuickBooks sync finalized successfully.",
    context: {
      finalizedAt: finishedAt,
      datasetVersion: dataset.id,
      totalTasks,
    },
  });

  return {
    companyId: clientId,
    syncJobId: syncJob.id,
    datasetVersion: dataset.id,
    syncedAt: finishedAt,
    results,
    errors: [],
    hasErrors: false,
    message: "All reports synced and finalized successfully.",
  };
}

async function getSyncStatus(clientId) {
  const syncMetadata = await getSyncMetadata(clientId, DEFAULT_SYNC_SOURCE);
  const activeDataset = await getLatestFinalizedDataset(clientId, DEFAULT_SYNC_SOURCE);
  const datasetVersion =
    activeDataset?.dataset_version || syncMetadata?.current_dataset_version || null;

  const reports = datasetVersion
    ? await listReportsForDataset(clientId, datasetVersion, DEFAULT_SYNC_SOURCE)
    : [];

  const runningJob = await getRunningSyncJob(clientId, DEFAULT_SYNC_SOURCE);

  return {
    companyId: clientId,
    source: "cached_snapshot",
    syncStatus: syncMetadata?.sync_status || (runningJob ? "running" : "idle"),
    syncProgress:
      typeof syncMetadata?.sync_progress === "number"
        ? syncMetadata.sync_progress
        : runningJob?.progress || 0,
    syncJobId: runningJob?.id || syncMetadata?.current_job_id || null,
    datasetVersion,
    lastSuccessfulSync: syncMetadata?.last_successful_sync || activeDataset?.finalized_at || null,
    lastAttemptedSync: syncMetadata?.last_attempted_sync || null,
    lastError: syncMetadata?.last_error || null,
    totalCachedReports: reports.length,
    reports: reports.map((row) => ({
      reportType: row.report_type,
      reportParams: row.report_params || {},
      lastSyncedAt: row.last_synced_at || null,
      syncStatus: row.sync_status || "finalized",
      syncError: row.sync_error || null,
      syncProgress: row.sync_progress || 100,
      datasetVersion: row.dataset_version || datasetVersion,
      source: "cached_snapshot",
    })),
    lastSyncedAt: syncMetadata?.last_successful_sync || activeDataset?.finalized_at || null,
  };
}

module.exports = {
  REPORT_TYPES,
  fetchAndCacheReport,
  fetchAndCacheQuery,
  serveCachedReport,
  syncAllReports,
  getSyncStatus,
};
