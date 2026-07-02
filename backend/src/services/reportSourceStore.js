const { supabase, isCircuitBreakerOpen, recordSupabaseError, resetSupabaseErrors } = require("../db");
const { withRetry, validateSupabaseResponse, normalizeError } = require("../utils/dbErrorHandler");

const REPORT_SOURCE_KEYS = {
  QUICKBOOKS: "quickbooks_online",
  MANUAL_GL: "manual_gl_upload",
  MANUAL_UPLOAD: "manual_upload_excel_pdf",
  QUICKBOOKS_MANUAL: "quickbooks_manual",
  KEY_REPORTS: "key_reports",
};

const REPORT_SOURCE_LABELS = {
  [REPORT_SOURCE_KEYS.QUICKBOOKS]: "QuickBooks Online",
  [REPORT_SOURCE_KEYS.MANUAL_GL]: "Manual GL Upload",
  [REPORT_SOURCE_KEYS.MANUAL_UPLOAD]: "Manual Upload (Excel or PDF)",
  [REPORT_SOURCE_KEYS.QUICKBOOKS_MANUAL]: "QuickBooks Manual",
  [REPORT_SOURCE_KEYS.KEY_REPORTS]: "Key Reports",
};

const VALID_SOURCE_KEYS = Object.values(REPORT_SOURCE_KEYS);

const SOURCE_KEY_ALIASES = new Map([
  ["quickbooks_online", REPORT_SOURCE_KEYS.QUICKBOOKS],
  ["quickbooks", REPORT_SOURCE_KEYS.QUICKBOOKS],
  ["manual_gl_upload", REPORT_SOURCE_KEYS.MANUAL_GL],
  ["manual_gl", REPORT_SOURCE_KEYS.MANUAL_GL],
  ["manual", REPORT_SOURCE_KEYS.MANUAL_GL],
  ["manual_upload_excel_pdf", REPORT_SOURCE_KEYS.MANUAL_UPLOAD],
  ["manual_upload", REPORT_SOURCE_KEYS.MANUAL_UPLOAD],
  ["manual_report_upload", REPORT_SOURCE_KEYS.MANUAL_UPLOAD],
  ["quickbooks_manual", REPORT_SOURCE_KEYS.QUICKBOOKS_MANUAL],
  ["qb_manual", REPORT_SOURCE_KEYS.QUICKBOOKS_MANUAL],
  ["key_reports", REPORT_SOURCE_KEYS.KEY_REPORTS],
  ["keyreports", REPORT_SOURCE_KEYS.KEY_REPORTS],
  ["key_report", REPORT_SOURCE_KEYS.KEY_REPORTS],
]);

function normalizeSourceKey(value) {
  // Key Reports is the default data source when none is specified/recognized.
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return REPORT_SOURCE_KEYS.KEY_REPORTS;
  return SOURCE_KEY_ALIASES.get(normalized) || REPORT_SOURCE_KEYS.KEY_REPORTS;
}

function getDefaultRows(companyId) {
  return [
    {
      company_id: companyId,
      // Key Reports is the default selection for a brand-new company. QuickBooks
      // is no longer selected by default; when no row is selected the resolver
      // falls back to Key Reports (see syncReportSourceRecords / getDataSourceState).
      source_key: REPORT_SOURCE_KEYS.QUICKBOOKS,
      source_label: REPORT_SOURCE_LABELS[REPORT_SOURCE_KEYS.QUICKBOOKS],
      is_selected: false,
      is_available: false,
      is_connected: false,
      metadata: {},
    },
    {
      company_id: companyId,
      source_key: REPORT_SOURCE_KEYS.MANUAL_GL,
      source_label: REPORT_SOURCE_LABELS[REPORT_SOURCE_KEYS.MANUAL_GL],
      is_selected: false,
      is_available: false,
      is_connected: false,
      metadata: {},
    },
    {
      company_id: companyId,
      source_key: REPORT_SOURCE_KEYS.MANUAL_UPLOAD,
      source_label: REPORT_SOURCE_LABELS[REPORT_SOURCE_KEYS.MANUAL_UPLOAD],
      is_selected: false,
      is_available: false,
      is_connected: false,
      metadata: {},
    },
    {
      company_id: companyId,
      source_key: REPORT_SOURCE_KEYS.QUICKBOOKS_MANUAL,
      source_label: REPORT_SOURCE_LABELS[REPORT_SOURCE_KEYS.QUICKBOOKS_MANUAL],
      is_selected: false,
      is_available: false,
      is_connected: false,
      metadata: {},
    },
    {
      company_id: companyId,
      source_key: REPORT_SOURCE_KEYS.KEY_REPORTS,
      source_label: REPORT_SOURCE_LABELS[REPORT_SOURCE_KEYS.KEY_REPORTS],
      is_selected: false,
      is_available: false,
      is_connected: false,
      metadata: {},
    },
  ];
}

function mapRow(row) {
  if (!row) return null;

  return {
    id: row.id,
    companyId: row.company_id,
    sourceKey: row.source_key,
    sourceLabel: row.source_label,
    isSelected: Boolean(row.is_selected),
    isAvailable: Boolean(row.is_available),
    isConnected: Boolean(row.is_connected),
    lastConnectedAt: row.last_connected_at || null,
    lastSyncedAt: row.last_synced_at || null,
    metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : {},
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function sortRowsByRecency(rows = []) {
  return [...rows].sort((left, right) => {
    const leftTime = new Date(left.updated_at || left.created_at || 0).getTime();
    const rightTime = new Date(right.updated_at || right.created_at || 0).getTime();
    return rightTime - leftTime;
  });
}

async function dedupeReportSourceRecords(companyId) {
  // Check circuit breaker
  if (isCircuitBreakerOpen()) {
    console.warn("[dedupeReportSourceRecords] Circuit breaker open, skipping dedup");
    return;
  }

  try {
    const result = await withRetry(
      async () => {
        const { data: rawRows, error } = await supabase
          .from("report_source_records")
          .select("id, source_key, updated_at, created_at")
          .eq("company_id", companyId);

        if (error) {
          recordSupabaseError();
          throw new Error(error.message || "Failed to fetch report source records");
        }

        resetSupabaseErrors();
        return rawRows;
      },
      {
        maxAttempts: 3,
        exponentialBackoff: true,
        operationName: "dedupeReportSourceRecords",
      },
    );

    const rows = Array.isArray(result) ? result : [];
    if (rows.length <= 2) return;

    const bySourceKey = rows.reduce((accumulator, row) => {
      const key = String(row.source_key || "");
      if (!accumulator.has(key)) accumulator.set(key, []);
      accumulator.get(key).push(row);
      return accumulator;
    }, new Map());

    const duplicateIds = [];
    bySourceKey.forEach((entries) => {
      if (!entries || entries.length <= 1) return;
      const sorted = sortRowsByRecency(entries);
      sorted.slice(1).forEach((row) => {
        if (row?.id) duplicateIds.push(row.id);
      });
    });

    if (!duplicateIds.length) return;

    await withRetry(
      async () => {
        const { error: deleteError } = await supabase
          .from("report_source_records")
          .delete()
          .in("id", duplicateIds);

        if (deleteError) {
          recordSupabaseError();
          throw new Error(deleteError.message || "Failed to delete duplicate records");
        }

        resetSupabaseErrors();
      },
      {
        maxAttempts: 3,
        exponentialBackoff: true,
        operationName: "dedupeReportSourceRecords delete",
      },
    );
  } catch (error) {
    recordSupabaseError();
    // Log but don't throw - dedup is not critical
    console.warn(
      "[dedupeReportSourceRecords] Non-critical dedupe operation failed:",
      error.message,
    );
  }
}

async function ensureReportSourceRecords(companyId) {
  if (!companyId) {
    throw new Error("companyId is required");
  }

  // Check circuit breaker first
  if (isCircuitBreakerOpen()) {
    console.warn("[ensureReportSourceRecords] Circuit breaker open, returning defaults");
    return getDefaultRows(companyId);
  }

  try {
    await dedupeReportSourceRecords(companyId);

    const existingRows = await withRetry(
      async () => {
        const { data, error } = await supabase
          .from("report_source_records")
          .select("source_key")
          .eq("company_id", companyId);

        if (error) {
          recordSupabaseError();
          throw new Error(error.message || "Failed to fetch existing records");
        }

        resetSupabaseErrors();
        return data;
      },
      {
        maxAttempts: 3,
        exponentialBackoff: true,
        operationName: "ensureReportSourceRecords fetch",
      },
    );

    const existingKeys = new Set(
      Array.isArray(existingRows)
        ? existingRows.map((row) => String(row.source_key || ""))
        : [],
    );

    const missingRows = getDefaultRows(companyId)
      .filter((row) => !existingKeys.has(row.source_key))
      .map((row) => ({
        ...row,
        updated_at: new Date().toISOString(),
      }));

    if (missingRows.length === 0) {
      return existingRows;
    }

    await withRetry(
      async () => {
        const { error } = await supabase
          .from("report_source_records")
          .insert(missingRows);

        // Ignore duplicate key errors (23505)
        if (error && error.code !== "23505") {
          recordSupabaseError();
          throw new Error(error.message || "Failed to insert records");
        }

        resetSupabaseErrors();
      },
      {
        maxAttempts: 3,
        exponentialBackoff: true,
        operationName: "ensureReportSourceRecords insert",
      },
    );

    return [...(existingRows || []), ...missingRows];
  } catch (error) {
    recordSupabaseError();
    throw normalizeError(error);
  }
}

async function getQuickBooksSnapshot(companyId) {
  const { data: connection } = await supabase
    .from("quickbooks_connections")
    .select("realm_id, company_name, environment, is_connected, connected_at, last_synced")
    .eq("company_id", companyId)
    .maybeSingle();

  const { data: cachedReport } = await supabase
    .from("qb_synced_reports")
    .select("last_synced_at, updated_at, dataset_version")
    .eq("company_id", companyId)
    .eq("sync_source", "quickbooks")
    .eq("is_active", true)
    .order("last_synced_at", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: syncMeta } = await supabase
    .from("sync_metadata")
    .select("sync_status, sync_progress, current_job_id, current_dataset_version, last_successful_sync, last_attempted_sync, last_error")
    .eq("company_id", companyId)
    .eq("sync_source", "quickbooks")
    .maybeSingle();

  return {
    isConnected: Boolean(connection?.is_connected !== false && connection?.realm_id),
    isAvailable: Boolean(
      (connection?.is_connected !== false && connection?.realm_id) || cachedReport
    ),
    lastConnectedAt: connection?.connected_at || null,
    lastSyncedAt:
      syncMeta?.last_successful_sync ||
      cachedReport?.last_synced_at ||
      connection?.last_synced ||
      null,
    metadata: {
      realmId: connection?.realm_id || null,
      companyName: connection?.company_name || null,
      environment: connection?.environment || null,
      cacheUpdatedAt: cachedReport?.updated_at || null,
      activeDatasetVersion:
        syncMeta?.current_dataset_version || cachedReport?.dataset_version || null,
      syncStatus: syncMeta?.sync_status || "idle",
      syncProgress: syncMeta?.sync_progress || 0,
      syncJobId: syncMeta?.current_job_id || null,
      lastAttemptedSync: syncMeta?.last_attempted_sync || null,
      lastSyncError: syncMeta?.last_error || null,
    },
  };
}

async function getManualGlSnapshot(companyId) {
  let latestBatch = null;
  let batchQueryError = null;
  try {
    let { data, error } = await supabase
      .from("manual_gl_batches")
      .select("id, batch_name, status, batch_status, is_active, metadata, created_at, updated_at, activated_at")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("activated_at", { ascending: false })
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error && error.code === "PGRST116") {
      ({ data, error } = await supabase
        .from("manual_gl_batches")
        .select("id, batch_name, status, batch_status, is_active, metadata, created_at, updated_at, activated_at")
        .eq("company_id", companyId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle());
    }

    latestBatch = data || null;
    batchQueryError = error || null;
  } catch (error) {
    batchQueryError = error;
  }

  if (batchQueryError && batchQueryError.code === "42703") {
    try {
      const { data, error } = await supabase
        .from("manual_gl_batches")
        .select("id, batch_name, status, metadata, created_at, updated_at")
        .eq("company_id", companyId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
      latestBatch = data || null;
      batchQueryError = error || null;
    } catch (legacyError) {
      batchQueryError = legacyError;
    }
  }

  if (batchQueryError && batchQueryError.code !== "PGRST116") {
    console.warn("[ReportSourceStore] Failed to load manual_gl_batches snapshot:", batchQueryError.message);
  }

  const { data: manualReport } = await supabase
    .from("qb_synced_reports")
    .select("report_type, report_params, updated_at, last_synced_at, status")
    .eq("company_id", companyId)
    .eq("source", "manual_gl")
    .in("report_type", [
      "balance_sheet",
      "profit_and_loss",
      "cash_flow",
      "manual_gl_generated_report",
    ])
    .order("updated_at", { ascending: false })
    .order("last_synced_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const manualMetadata =
    latestBatch?.metadata && typeof latestBatch.metadata === "object"
      ? latestBatch.metadata
      : {};
  const lastSyncedAt =
    latestBatch?.updated_at ||
    latestBatch?.created_at ||
    manualReport?.last_synced_at ||
    manualReport?.updated_at ||
    null;

  return {
    isConnected: false,
    isAvailable: Boolean(latestBatch || manualReport),
    lastConnectedAt: null,
    lastSyncedAt,
    metadata: {
      latestBatchId: latestBatch?.id || null,
      latestBatchName: latestBatch?.batch_name || null,
      latestBatchStatus: latestBatch?.batch_status || latestBatch?.status || null,
      latestBatchIsActive: latestBatch?.is_active === true,
      latestBatchCreatedAt: latestBatch?.created_at || null,
      latestBatchActivatedAt: latestBatch?.activated_at || null,
      sourceSwitchVersion: manualMetadata.sourceSwitchVersion || null,
      uploadSessionId: manualMetadata.uploadSessionId || null,
      insertedTransactions:
        Number(manualMetadata.insertedTransactions || 0) || null,
      yearsDetected: Array.isArray(manualMetadata.yearsDetected)
        ? manualMetadata.yearsDetected
        : null,
      latestReportType: manualReport?.report_type || null,
      latestUploadId:
        manualReport?.report_params?.manualUploadId ||
        manualReport?.report_params?.uploadId ||
        null,
      status: manualReport?.status || null,
    },
  };
}

async function getManualUploadSnapshot(companyId) {
  const { data: manualUploadReport } = await supabase
    .from("qb_synced_reports")
    .select("report_type, report_params, updated_at, last_synced_at, status")
    .eq("company_id", companyId)
    .eq("source", "manual_report_upload")
    .in("report_type", ["balance_sheet", "profit_and_loss", "cash_flow"])
    .order("updated_at", { ascending: false })
    .order("last_synced_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return {
    isConnected: false,
    isAvailable: Boolean(manualUploadReport),
    lastConnectedAt: null,
    lastSyncedAt:
      manualUploadReport?.last_synced_at || manualUploadReport?.updated_at || null,
    metadata: {
      latestReportType: manualUploadReport?.report_type || null,
      selectedFolderId: manualUploadReport?.report_params?.folderId || null,
      selectedFolderName: manualUploadReport?.report_params?.folderName || null,
      status: manualUploadReport?.status || null,
    },
  };
}

async function getQMSSnapshot(companyId) {
  const { data: qmsReport } = await supabase
    .from("qb_synced_reports")
    .select("report_type, report_params, updated_at, last_synced_at, status")
    .eq("company_id", companyId)
    .eq("source", "quickbooks_manual_upload")
    .in("report_type", ["balance_sheet", "profit_and_loss", "cash_flow"])
    .order("updated_at", { ascending: false })
    .order("last_synced_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return {
    isConnected: false,
    isAvailable: Boolean(qmsReport),
    lastConnectedAt: null,
    lastSyncedAt: qmsReport?.last_synced_at || qmsReport?.updated_at || null,
    metadata: {
      latestReportType: qmsReport?.report_type || null,
      selectedFolderId: qmsReport?.report_params?.folderId || null,
      selectedFolderName: qmsReport?.report_params?.folderName || null,
      status: qmsReport?.status || null,
    },
  };
}

async function updateReportSourceRecord(companyId, sourceKey, updates = {}) {
  if (!companyId) {
    throw new Error("companyId is required");
  }

  const normalizedSourceKey = normalizeSourceKey(sourceKey);
  await ensureReportSourceRecords(companyId);

  const { data: currentRows, error: currentError } = await supabase
    .from("report_source_records")
    .select("*")
    .eq("company_id", companyId)
    .eq("source_key", normalizedSourceKey)
    .order("updated_at", { ascending: false })
    .limit(1);

  if (currentError) {
    throw new Error(`Failed to load report source record: ${currentError.message}`);
  }
  const current = Array.isArray(currentRows) && currentRows.length
    ? currentRows[0]
    : null;

  const payload = {
    company_id: companyId,
    source_key: normalizedSourceKey,
    source_label:
      REPORT_SOURCE_LABELS[normalizedSourceKey] || current?.source_label || normalizedSourceKey,
    is_available:
      typeof updates.isAvailable === "boolean"
        ? updates.isAvailable
        : Boolean(current?.is_available),
    is_connected:
      typeof updates.isConnected === "boolean"
        ? updates.isConnected
        : Boolean(current?.is_connected),
    last_connected_at:
      updates.lastConnectedAt !== undefined
        ? updates.lastConnectedAt
        : current?.last_connected_at || null,
    last_synced_at:
      updates.lastSyncedAt !== undefined
        ? updates.lastSyncedAt
        : current?.last_synced_at || null,
    metadata: {
      ...(current?.metadata && typeof current.metadata === "object" ? current.metadata : {}),
      ...(updates.metadata && typeof updates.metadata === "object" ? updates.metadata : {}),
    },
    updated_at: new Date().toISOString(),
  };

  if (typeof updates.isSelected === "boolean") {
    payload.is_selected = updates.isSelected;
  }

  const { data, error } = await supabase
    .from("report_source_records")
    .upsert(payload, { onConflict: "company_id,source_key" })
    .select("*")
    .single();

  if (error) {
    throw new Error(`Failed to update report source record: ${error.message}`);
  }

  return mapRow(data);
}

async function syncReportSourceRecords(companyId) {
  if (!companyId) {
    throw new Error("companyId is required");
  }

  await ensureReportSourceRecords(companyId);

  const [quickbooksSnapshot, manualSnapshot, manualUploadSnapshot, qmsSnapshot] = await Promise.all([
    getQuickBooksSnapshot(companyId),
    getManualGlSnapshot(companyId),
    getManualUploadSnapshot(companyId),
    getQMSSnapshot(companyId),
  ]);

  await Promise.all([
    updateReportSourceRecord(companyId, REPORT_SOURCE_KEYS.QUICKBOOKS, quickbooksSnapshot),
    updateReportSourceRecord(companyId, REPORT_SOURCE_KEYS.MANUAL_GL, manualSnapshot),
    updateReportSourceRecord(companyId, REPORT_SOURCE_KEYS.MANUAL_UPLOAD, manualUploadSnapshot),
    updateReportSourceRecord(companyId, REPORT_SOURCE_KEYS.QUICKBOOKS_MANUAL, qmsSnapshot),
  ]);

  const { data, error } = await supabase
    .from("report_source_records")
    .select("*")
    .eq("company_id", companyId)
    .order("source_label", { ascending: true });

  if (error) {
    throw new Error(`Failed to load report source records: ${error.message}`);
  }

  const rows = Array.isArray(data) ? data.map(mapRow) : [];
  if (rows.some((row) => row.isSelected)) {
    return rows;
  }

  // No source selected yet → default to Key Reports.
  await setSelectedReportSource(companyId, REPORT_SOURCE_KEYS.KEY_REPORTS);
  return syncReportSourceRecords(companyId);
}

async function setSelectedReportSource(companyId, sourceKey) {
  if (!companyId) {
    throw new Error("companyId is required");
  }

  const normalizedSourceKey = normalizeSourceKey(sourceKey);
  await ensureReportSourceRecords(companyId);

  const now = new Date().toISOString();

  const { error: clearError } = await supabase
    .from("report_source_records")
    .update({ is_selected: false, updated_at: now })
    .eq("company_id", companyId);

  if (clearError) {
    throw new Error(`Failed to clear selected source: ${clearError.message}`);
  }

  const { error: selectError } = await supabase
    .from("report_source_records")
    .update({ is_selected: true, updated_at: now })
    .eq("company_id", companyId)
    .eq("source_key", normalizedSourceKey);

  if (selectError) {
    throw new Error(`Failed to select report source: ${selectError.message}`);
  }

  // Guard against legacy datasets where no rows match the selected source.
  await updateReportSourceRecord(companyId, normalizedSourceKey, {
    isSelected: true,
  });

  return syncReportSourceRecords(companyId);
}

module.exports = {
  REPORT_SOURCE_KEYS,
  REPORT_SOURCE_LABELS,
  ensureReportSourceRecords,
  syncReportSourceRecords,
  updateReportSourceRecord,
  setSelectedReportSource,
};
