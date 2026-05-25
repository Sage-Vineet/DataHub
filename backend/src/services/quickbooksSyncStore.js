const { supabase } = require("../db");

const DEFAULT_SYNC_SOURCE = "quickbooks";

function nowIso() {
  return new Date().toISOString();
}

function sanitizeReportParams(params) {
  if (!params || typeof params !== "object") return {};

  const cleaned = {};
  const keys = Object.keys(params).sort();
  for (const key of keys) {
    const value = params[key];
    if (value === undefined || value === null || value === "") continue;
    if (key === "clientId" || key === "minorversion") continue;
    cleaned[key] = String(value);
  }

  return cleaned;
}

function serializeJsonFilterValue(value) {
  if (!value || typeof value !== "object") return null;
  try {
    return JSON.stringify(value);
  } catch (_error) {
    return null;
  }
}

function isRunningSyncJobConflict(error) {
  const code = String(error?.code || "");
  const details = String(error?.details || "");
  const message = String(error?.message || "");
  return (
    code === "23505" &&
    (details.includes("uq_sync_jobs_company_running") ||
      message.includes("uq_sync_jobs_company_running"))
  );
}

function isUsablePayload(data) {
  if (!data || typeof data !== "object") return false;
  return Object.keys(data).length > 0;
}

async function upsertReportSnapshotRecord({
  companyId,
  datasetVersion,
  reportType,
  reportParams = {},
  syncSource = DEFAULT_SYNC_SOURCE,
  syncJobId = null,
  status = "staged",
  generatedAt = nowIso(),
  finalizedAt = null,
  metadata = {},
}) {
  if (!companyId || !datasetVersion || !reportType) return null;

  const params = sanitizeReportParams(reportParams);
  const payload = {
    company_id: companyId,
    dataset_version: datasetVersion,
    report_type: reportType,
    report_params: params,
    sync_source: syncSource,
    sync_job_id: syncJobId,
    status,
    generated_at: generatedAt,
    finalized_at: finalizedAt,
    metadata: metadata && typeof metadata === "object" ? metadata : {},
    updated_at: nowIso(),
  };

  const { data, error } = await supabase
    .from("report_snapshots")
    .upsert(payload, {
      onConflict: "company_id,dataset_version,report_type,report_params",
    })
    .select("id")
    .maybeSingle();

  if (error) {
    console.warn("[SyncStore] Failed to upsert report_snapshot row:", error.message);
    return null;
  }

  return data || null;
}

async function getSyncMetadata(companyId, syncSource = DEFAULT_SYNC_SOURCE) {
  if (!companyId) return null;

  const { data, error } = await supabase
    .from("sync_metadata")
    .select("*")
    .eq("company_id", companyId)
    .eq("sync_source", syncSource)
    .maybeSingle();

  if (error && error.code !== "PGRST116") {
    console.warn("[SyncStore] Failed to fetch sync metadata:", error.message);
    return null;
  }

  return data || null;
}

async function updateSyncMetadata(companyId, patch = {}, syncSource = DEFAULT_SYNC_SOURCE) {
  if (!companyId) return null;
  const current = await getSyncMetadata(companyId, syncSource);

  const payload = {
    company_id: companyId,
    sync_source: syncSource,
    sync_status:
      patch.syncStatus !== undefined
        ? patch.syncStatus
        : current?.sync_status || "idle",
    sync_progress:
      typeof patch.syncProgress === "number"
        ? patch.syncProgress
        : Number(current?.sync_progress || 0),
    current_job_id:
      patch.currentJobId !== undefined
        ? patch.currentJobId
        : current?.current_job_id || null,
    current_dataset_version:
      patch.currentDatasetVersion !== undefined
        ? patch.currentDatasetVersion
        : current?.current_dataset_version || null,
    last_successful_sync:
      patch.lastSuccessfulSync !== undefined
        ? patch.lastSuccessfulSync
        : current?.last_successful_sync || null,
    last_attempted_sync:
      patch.lastAttemptedSync !== undefined
        ? patch.lastAttemptedSync
        : current?.last_attempted_sync || null,
    last_error:
      patch.lastError !== undefined ? patch.lastError : current?.last_error || null,
    updated_at: nowIso(),
    metadata:
      patch.metadata !== undefined
        ? patch.metadata && typeof patch.metadata === "object"
          ? patch.metadata
          : {}
        : current?.metadata && typeof current.metadata === "object"
          ? current.metadata
          : {},
  };

  const { data, error } = await supabase
    .from("sync_metadata")
    .upsert(payload, { onConflict: "company_id,sync_source" })
    .select("*")
    .maybeSingle();

  if (error) {
    console.warn("[SyncStore] Failed to update sync metadata:", error.message);
    return null;
  }

  return data || null;
}

async function createDatasetVersion({
  companyId,
  syncSource = DEFAULT_SYNC_SOURCE,
  source = DEFAULT_SYNC_SOURCE,
  status = "staging",
  isActive = false,
  metadata = {},
  syncJobId = null,
}) {
  if (!companyId) throw new Error("createDatasetVersion: companyId is required");

  const now = nowIso();
  const { data, error } = await supabase
    .from("dataset_versions")
    .insert({
      company_id: companyId,
      sync_source: syncSource,
      source,
      status,
      is_active: Boolean(isActive),
      sync_job_id: syncJobId,
      metadata: metadata && typeof metadata === "object" ? metadata : {},
      created_at: now,
      updated_at: now,
    })
    .select("*")
    .single();

  if (error) {
    throw new Error(`createDatasetVersion failed: ${error.message}`);
  }

  return data;
}

async function updateDatasetVersion(datasetVersion, patch = {}) {
  if (!datasetVersion) return null;

  const payload = {
    updated_at: nowIso(),
  };

  if (patch.status !== undefined) payload.status = patch.status;
  if (patch.isActive !== undefined) payload.is_active = Boolean(patch.isActive);
  if (patch.finalizedAt !== undefined) payload.finalized_at = patch.finalizedAt;
  if (patch.finalizedBy !== undefined) payload.finalized_by = patch.finalizedBy;
  if (patch.syncJobId !== undefined) payload.sync_job_id = patch.syncJobId;
  if (patch.metadata !== undefined) {
    payload.metadata = patch.metadata && typeof patch.metadata === "object" ? patch.metadata : {};
  }

  const { data, error } = await supabase
    .from("dataset_versions")
    .update(payload)
    .eq("id", datasetVersion)
    .select("*")
    .maybeSingle();

  if (error) {
    throw new Error(`updateDatasetVersion failed: ${error.message}`);
  }

  return data || null;
}

async function getLatestFinalizedDataset(companyId, syncSource = DEFAULT_SYNC_SOURCE) {
  if (!companyId) return null;

  const { data, error } = await supabase
    .from("finalized_datasets")
    .select("*")
    .eq("company_id", companyId)
    .eq("sync_source", syncSource)
    .eq("is_active", true)
    .order("finalized_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error && error.code !== "PGRST116") {
    console.warn("[SyncStore] Failed to get active finalized dataset:", error.message);
  }

  if (data?.dataset_version) {
    return data;
  }

  const fallback = await getSyncMetadata(companyId, syncSource);
  if (fallback?.current_dataset_version) {
    return {
      company_id: companyId,
      sync_source: syncSource,
      dataset_version: fallback.current_dataset_version,
      finalized_at: fallback.last_successful_sync,
      is_active: true,
    };
  }

  return null;
}

async function ensureWorkingDatasetVersion(companyId, syncSource = DEFAULT_SYNC_SOURCE) {
  const active = await getLatestFinalizedDataset(companyId, syncSource);
  if (active?.dataset_version) {
    return active.dataset_version;
  }

  const now = nowIso();
  const dataset = await createDatasetVersion({
    companyId,
    syncSource,
    source: syncSource,
    status: "finalized",
    isActive: true,
    metadata: { createdBy: "auto_legacy" },
  });

  await supabase.from("finalized_datasets").upsert(
    {
      company_id: companyId,
      dataset_version: dataset.id,
      is_active: true,
      finalized_at: now,
      sync_source: syncSource,
      metadata: { createdBy: "auto_legacy" },
      created_at: now,
      updated_at: now,
    },
    { onConflict: "company_id,dataset_version" },
  );

  await updateSyncMetadata(
    companyId,
    {
      syncStatus: "idle",
      syncProgress: 100,
      currentDatasetVersion: dataset.id,
      lastSuccessfulSync: now,
      lastAttemptedSync: now,
      metadata: { createdBy: "auto_legacy" },
    },
    syncSource,
  );

  return dataset.id;
}

async function upsertSyncedReport({
  companyId,
  reportType,
  reportParams = {},
  data,
  source = DEFAULT_SYNC_SOURCE,
  syncSource = DEFAULT_SYNC_SOURCE,
  datasetVersion = null,
  syncJobId = null,
  syncStatus = "staged",
  syncError = null,
  syncProgress = 0,
  periodStart = null,
  periodEnd = null,
  fiscalYear = null,
  isActive = false,
  finalizedAt = null,
  finalizedBy = null,
}) {
  if (!companyId || !reportType) {
    throw new Error("upsertSyncedReport: companyId and reportType are required.");
  }

  if (!isUsablePayload(data)) {
    console.warn(
      `[SyncStore] Refusing to store empty payload for ${reportType} (company=${companyId})`,
    );
    return null;
  }

  const params = sanitizeReportParams(reportParams);
  const now = nowIso();
  const resolvedDatasetVersion = datasetVersion || (await ensureWorkingDatasetVersion(companyId, syncSource));

  const payload = {
    company_id: companyId,
    report_type: reportType,
    report_params: params,
    data,
    source,
    sync_source: syncSource,
    dataset_version: resolvedDatasetVersion,
    sync_job_id: syncJobId,
    sync_status: syncStatus,
    sync_error: syncError,
    sync_progress: Number.isFinite(Number(syncProgress)) ? Number(syncProgress) : 0,
    period_start: periodStart,
    period_end: periodEnd,
    fiscal_year: fiscalYear,
    is_active: Boolean(isActive),
    finalized_at: finalizedAt,
    finalized_by: finalizedBy,
    last_synced_at: now,
    updated_at: now,
  };

  const { data: row, error } = await supabase
    .from("qb_synced_reports")
    .upsert(payload, {
      onConflict: "company_id,report_type,report_params,dataset_version",
    })
    .select("id, company_id, report_type, dataset_version, last_synced_at")
    .maybeSingle();

  if (error) {
    throw new Error(`upsertSyncedReport failed for ${reportType}: ${error.message}`);
  }

  await upsertReportSnapshotRecord({
    companyId,
    datasetVersion: resolvedDatasetVersion,
    reportType,
    reportParams: params,
    syncSource,
    syncJobId,
    status: syncStatus === "finalized" ? "finalized" : syncStatus === "failed" ? "failed" : "staged",
    generatedAt: now,
    finalizedAt,
    metadata: {
      periodStart,
      periodEnd,
      fiscalYear,
      source,
    },
  });

  return row || null;
}

async function getCachedReport({
  companyId,
  reportType,
  reportParams = null,
  datasetVersion = null,
  syncSource = DEFAULT_SYNC_SOURCE,
  includeInactive = false,
  periodStart = null,
  periodEnd = null,
  skipUnconstrained = false,
}) {
  if (!companyId || !reportType) return null;

  const params = reportParams ? sanitizeReportParams(reportParams) : null;
  const paramsFilterValue = serializeJsonFilterValue(params);

  console.log(
    `[SyncStore] getCachedReport — reportType=${reportType}` +
    ` requested_accounting_method=${params?.accounting_method || "(none)"}` +
    ` start_date=${params?.start_date || "(none)"} end_date=${params?.end_date || "(none)"}`
  );

  // When explicit date filters are present, never return a report with different
  // date params — doing so silently serves wrong-period financial data.
  const hasDateFilter = Boolean(params && (params.start_date || params.end_date));

  // tryRead supports two match modes:
  //   "exact"   — report_params = serialized JSON  (strict equality)
  //   "partial" — report_params @> requested JSON  (JSONB contains, superset match)
  //
  // "partial" is needed because sync tasks store accounting_method alongside dates,
  // so a query without accounting_method won't match an exact-equality lookup even
  // when start_date and end_date are identical.
  const tryRead = async ({ useParams, matchMode = "exact", onlyActive, useDatasetVersion }) => {
    let query = supabase
      .from("qb_synced_reports")
      .select("*")
      .eq("company_id", companyId)
      .eq("report_type", reportType)
      .eq("sync_source", syncSource);

    if (onlyActive) query = query.eq("is_active", true);
    if (useDatasetVersion && datasetVersion) query = query.eq("dataset_version", datasetVersion);

    if (useParams && params && Object.keys(params).length > 0) {
      if (matchMode === "partial") {
        // @> operator: stored record must contain all requested key-value pairs.
        // Use .filter() with 'cs' to guarantee PostgREST sends the @> JSONB operator.
        query = query.filter("report_params", "cs", paramsFilterValue);
      } else if (paramsFilterValue) {
        query = query.eq("report_params", paramsFilterValue);
      }
    }

    if (usePeriod === "exact" && hasPeriod) {
      query = query
        .eq("period_start", periodStart)
        .eq("period_end", periodEnd)
        .order("is_active", { ascending: false })
        .order("last_synced_at", { ascending: false })
        .order("updated_at", { ascending: false });
    } else {
      query = query
        .order("is_active", { ascending: false })
        .order("last_synced_at", { ascending: false })
        .order("updated_at", { ascending: false });
    }

    query = query.limit(1);

    const { data, error } = await query.maybeSingle();
    console.log(
      `[SyncStore] getCachedReport step {useParams:${useParams} mode:${matchMode} active:${onlyActive} dsv:${useDatasetVersion}}` +
      ` → ${data ? "HIT params=" + JSON.stringify(data.report_params) : "MISS"}` +
      (error ? ` ERR:${error.message}` : "")
    );
    if (error && error.code !== "PGRST116") {
      console.warn(`[SyncStore] getCachedReport query failed for ${reportType}:`, error.message);
      return null;
    }
    return data || null;
  };

  const searchPlan = hasDateFilter
    ? [
      // Exact match first (params stored identically to what was requested)
      { useParams: true, matchMode: "exact", onlyActive: !includeInactive, useDatasetVersion: Boolean(datasetVersion) },
      // Partial match: stored params are a superset (e.g. has accounting_method, we didn't request it)
      { useParams: true, matchMode: "partial", onlyActive: !includeInactive, useDatasetVersion: Boolean(datasetVersion) },
      // Same two steps but allow inactive snapshots
      { useParams: true, matchMode: "exact", onlyActive: false, useDatasetVersion: Boolean(datasetVersion) },
      { useParams: true, matchMode: "partial", onlyActive: false, useDatasetVersion: Boolean(datasetVersion) },
    ]
    : [
      { useParams: true, matchMode: "exact", onlyActive: !includeInactive, useDatasetVersion: Boolean(datasetVersion) },
      { useParams: false, matchMode: "exact", onlyActive: !includeInactive, useDatasetVersion: Boolean(datasetVersion) },
      { useParams: true, matchMode: "exact", onlyActive: false, useDatasetVersion: Boolean(datasetVersion) },
      { useParams: false, matchMode: "exact", onlyActive: false, useDatasetVersion: Boolean(datasetVersion) },
    ];

  for (const step of searchPlan) {
    const hit = await tryRead(step);
    if (hit) return hit;
  }

  // Period-coverage fallback (date-filtered queries only):
  // When no exact-period snapshot exists (e.g. requested Jan 1–31 but only a
  // yearly Jan 1–Dec 31 was synced, or monthly ranges are off by one day due
  // to a prior timezone bug), look for any snapshot whose stored period_start/
  // period_end CONTAINS the requested range.  Only meaningful when both dates
  // are present and the JSONB param search exhausted all options above.
  if (hasDateFilter && params.start_date && params.end_date) {
    const tryCoverage = async (onlyActive) => {
      let q = supabase
        .from("qb_synced_reports")
        .select("*")
        .eq("company_id", companyId)
        .eq("report_type", reportType)
        .eq("sync_source", syncSource)
        .lte("period_start", params.start_date)  // stored period starts on/before requested start
        .gte("period_end", params.end_date)       // stored period ends on/after requested end
        .order("is_active", { ascending: false })
        .order("period_start", { ascending: false })
        .order("last_synced_at", { ascending: false })
        .limit(1);

      if (onlyActive) q = q.eq("is_active", true);
      if (datasetVersion) q = q.eq("dataset_version", datasetVersion);

      // Never return an Accrual snapshot for a Cash request (or vice versa).
      if (params.accounting_method) {
        q = q.filter("report_params->>accounting_method", "eq", params.accounting_method);
      }

      const { data, error } = await q.maybeSingle();
      console.log(
        `[SyncStore] getCachedReport period-coverage fallback (onlyActive=${onlyActive}) for ${reportType}` +
        ` → ${data ? `HIT period=${data.period_start} to ${data.period_end} params=${JSON.stringify(data.report_params)}` : "MISS"}` +
        (error ? ` ERR:${error.message}` : "")
      );
      if (error && error.code !== "PGRST116") return null;
      return data || null;
    };

    const coverageHit = (await tryCoverage(!includeInactive)) || (await tryCoverage(false));
    if (coverageHit) return coverageHit;
  }

  // Legacy fallback: match reports that predate sync_source tracking.
  // Skipped when date filters are present — returning a different-period report
  // would silently serve wrong-period financial data to the caller.
  if (!hasDateFilter) {
    let legacyQuery = supabase
      .from("qb_synced_reports")
      .select("*")
      .eq("company_id", companyId)
      .eq("report_type", reportType)
      .order("last_synced_at", { ascending: false })
      .order("updated_at", { ascending: false })
      .limit(1);

    // Never serve an Accrual snapshot for a Cash request (or vice versa).
    if (params && params.accounting_method) {
      legacyQuery = legacyQuery.filter(
        "report_params->>accounting_method", "eq", params.accounting_method
      );
    }

    const { data: legacyHit, error: legacyError } = await legacyQuery.maybeSingle();

    if (legacyError && legacyError.code !== "PGRST116") {
      console.warn(`[SyncStore] Legacy fallback failed for ${reportType}:`, legacyError.message);
      return null;
    }

    return legacyHit || null;
  }

  return null;
}

async function listReportsForDataset(companyId, datasetVersion, syncSource = DEFAULT_SYNC_SOURCE) {
  if (!companyId || !datasetVersion) return [];

  const { data, error } = await supabase
    .from("qb_synced_reports")
    .select("id, report_type, report_params, dataset_version, last_synced_at, sync_status, sync_error, sync_progress")
    .eq("company_id", companyId)
    .eq("dataset_version", datasetVersion)
    .eq("sync_source", syncSource)
    .order("report_type", { ascending: true });

  if (error) {
    console.warn("[SyncStore] Failed to list dataset reports:", error.message);
    return [];
  }

  return data || [];
}

async function getAllCachedReports(companyId, options = {}) {
  if (!companyId) return [];

  const onlyActive = options.onlyActive !== false;
  const syncSource = options.syncSource || DEFAULT_SYNC_SOURCE;

  let query = supabase
    .from("qb_synced_reports")
    .select("id, company_id, report_type, report_params, dataset_version, last_synced_at, source, sync_source, is_active, sync_status")
    .eq("company_id", companyId)
    .eq("sync_source", syncSource)
    .order("is_active", { ascending: false })
    .order("last_synced_at", { ascending: false });

  if (onlyActive) query = query.eq("is_active", true);

  const { data, error } = await query;
  if (error) {
    console.warn("[SyncStore] Failed to list cached reports:", error.message);
    return [];
  }

  return data || [];
}

async function createSyncJob({
  companyId,
  syncSource = DEFAULT_SYNC_SOURCE,
  requestedBy = null,
  datasetVersion = null,
  payload = {},
  status = "queued",
}) {
  if (!companyId) throw new Error("createSyncJob: companyId is required");

  const now = nowIso();
  const { data, error } = await supabase
    .from("sync_jobs")
    .insert({
      company_id: companyId,
      sync_source: syncSource,
      status,
      requested_by: requestedBy,
      dataset_version: datasetVersion,
      payload: payload && typeof payload === "object" ? payload : {},
      started_at: status === "running" ? now : null,
      progress: status === "completed" ? 100 : 0,
      created_at: now,
      updated_at: now,
    })
    .select("*")
    .single();

  if (error) {
    if (isRunningSyncJobConflict(error)) {
      const existing = await getRunningSyncJob(companyId, syncSource);
      if (existing) {
        return { ...existing, alreadyRunning: true };
      }
    }
    throw new Error(`createSyncJob failed: ${error.message}`);
  }

  return data;
}

async function getRunningSyncJob(companyId, syncSource = DEFAULT_SYNC_SOURCE) {
  if (!companyId) return null;

  const { data, error } = await supabase
    .from("sync_jobs")
    .select("*")
    .eq("company_id", companyId)
    .eq("sync_source", syncSource)
    .in("status", ["queued", "running"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error && error.code !== "PGRST116") {
    console.warn("[SyncStore] Failed to check running sync job:", error.message);
    return null;
  }

  return data || null;
}

async function updateSyncJob(syncJobId, patch = {}) {
  if (!syncJobId) return null;

  const payload = {
    updated_at: nowIso(),
  };

  if (patch.status !== undefined) payload.status = patch.status;
  if (patch.progress !== undefined) payload.progress = patch.progress;
  if (patch.error !== undefined) payload.error = patch.error;
  if (patch.startedAt !== undefined) payload.started_at = patch.startedAt;
  if (patch.completedAt !== undefined) payload.completed_at = patch.completedAt;
  if (patch.datasetVersion !== undefined) payload.dataset_version = patch.datasetVersion;
  if (patch.payload !== undefined) payload.payload = patch.payload;

  const { data, error } = await supabase
    .from("sync_jobs")
    .update(payload)
    .eq("id", syncJobId)
    .select("*")
    .maybeSingle();

  if (error) {
    throw new Error(`updateSyncJob failed: ${error.message}`);
  }

  return data || null;
}

async function appendSyncLog({
  syncJobId,
  companyId,
  datasetVersion = null,
  level = "info",
  message,
  context = {},
}) {
  if (!syncJobId || !companyId || !message) return null;

  const { data, error } = await supabase
    .from("sync_logs")
    .insert({
      sync_job_id: syncJobId,
      company_id: companyId,
      dataset_version: datasetVersion,
      level,
      message,
      context: context && typeof context === "object" ? context : {},
      created_at: nowIso(),
    })
    .select("id")
    .maybeSingle();

  if (error) {
    console.warn("[SyncStore] Failed to append sync log:", error.message);
    return null;
  }

  return data || null;
}

async function setActiveDataset({
  companyId,
  datasetVersion,
  finalizedBy = null,
  syncSource = DEFAULT_SYNC_SOURCE,
  syncJobId = null,
  metadata = {},
}) {
  if (!companyId || !datasetVersion) {
    throw new Error("setActiveDataset: companyId and datasetVersion are required.");
  }

  const now = nowIso();

  await supabase
    .from("qb_synced_reports")
    .update({ is_active: false, updated_at: now })
    .eq("company_id", companyId)
    .eq("sync_source", syncSource)
    .eq("is_active", true);

  const { error: activateRowsError } = await supabase
    .from("qb_synced_reports")
    .update({
      is_active: true,
      finalized_at: now,
      finalized_by: finalizedBy,
      sync_status: "finalized",
      sync_progress: 100,
      sync_error: null,
      updated_at: now,
    })
    .eq("company_id", companyId)
    .eq("dataset_version", datasetVersion)
    .eq("sync_source", syncSource);

  if (activateRowsError) {
    throw new Error(`setActiveDataset failed to activate rows: ${activateRowsError.message}`);
  }

  await supabase
    .from("finalized_datasets")
    .update({ is_active: false, updated_at: now })
    .eq("company_id", companyId)
    .eq("sync_source", syncSource)
    .eq("is_active", true);

  const { error: finalizedError } = await supabase
    .from("finalized_datasets")
    .upsert(
      {
        company_id: companyId,
        dataset_version: datasetVersion,
        is_active: true,
        finalized_at: now,
        finalized_by: finalizedBy,
        sync_source: syncSource,
        sync_job_id: syncJobId,
        metadata: metadata && typeof metadata === "object" ? metadata : {},
        updated_at: now,
      },
      { onConflict: "company_id,dataset_version" },
    );

  if (finalizedError) {
    throw new Error(`setActiveDataset failed to upsert finalized_datasets: ${finalizedError.message}`);
  }

  const { error: snapshotFinalizeError } = await supabase
    .from("report_snapshots")
    .update({
      status: "finalized",
      finalized_at: now,
      updated_at: now,
    })
    .eq("company_id", companyId)
    .eq("dataset_version", datasetVersion)
    .eq("sync_source", syncSource);

  if (snapshotFinalizeError) {
    console.warn(
      "[SyncStore] Failed to mark report_snapshots finalized:",
      snapshotFinalizeError.message,
    );
  }

  await updateDatasetVersion(datasetVersion, {
    status: "finalized",
    isActive: true,
    finalizedAt: now,
    finalizedBy,
    syncJobId,
    metadata,
  });

  return {
    datasetVersion,
    finalizedAt: now,
  };
}

async function markDatasetFailed({
  companyId,
  datasetVersion,
  errorMessage,
  syncSource = DEFAULT_SYNC_SOURCE,
  syncJobId = null,
}) {
  if (!companyId || !datasetVersion) return null;

  const now = nowIso();
  await supabase
    .from("qb_synced_reports")
    .update({
      sync_status: "failed",
      sync_error: errorMessage || null,
      sync_progress: 100,
      updated_at: now,
    })
    .eq("company_id", companyId)
    .eq("dataset_version", datasetVersion)
    .eq("sync_source", syncSource);

  const { error: snapshotFailedError } = await supabase
    .from("report_snapshots")
    .update({
      status: "failed",
      updated_at: now,
      metadata: {
        error: errorMessage || null,
        failedAt: now,
      },
    })
    .eq("company_id", companyId)
    .eq("dataset_version", datasetVersion)
    .eq("sync_source", syncSource);

  if (snapshotFailedError) {
    console.warn(
      "[SyncStore] Failed to mark report_snapshots failed:",
      snapshotFailedError.message,
    );
  }

  return updateDatasetVersion(datasetVersion, {
    status: "failed",
    isActive: false,
    syncJobId,
    metadata: {
      error: errorMessage || null,
      failedAt: now,
    },
  });
}

async function deleteAllCachedReports(companyId, options = {}) {
  if (!companyId) return false;

  const syncSource = options.syncSource || DEFAULT_SYNC_SOURCE;
  const { error } = await supabase
    .from("qb_synced_reports")
    .delete()
    .eq("company_id", companyId)
    .eq("sync_source", syncSource);

  if (error) {
    console.warn("[SyncStore] Failed to delete cached reports:", error.message);
    return false;
  }

  return true;
}

module.exports = {
  DEFAULT_SYNC_SOURCE,
  sanitizeReportParams,
  upsertSyncedReport,
  getCachedReport,
  getAllCachedReports,
  deleteAllCachedReports,
  getSyncMetadata,
  updateSyncMetadata,
  createDatasetVersion,
  updateDatasetVersion,
  getLatestFinalizedDataset,
  ensureWorkingDatasetVersion,
  listReportsForDataset,
  createSyncJob,
  getRunningSyncJob,
  updateSyncJob,
  appendSyncLog,
  setActiveDataset,
  markDatasetFailed,
};
