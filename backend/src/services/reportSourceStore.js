const { supabase } = require("../db");

const REPORT_SOURCE_KEYS = {
  QUICKBOOKS: "quickbooks_online",
  MANUAL_GL: "manual_gl_upload",
  MANUAL_UPLOAD: "manual_upload_excel_pdf",
};

const REPORT_SOURCE_LABELS = {
  [REPORT_SOURCE_KEYS.QUICKBOOKS]: "QuickBooks Online",
  [REPORT_SOURCE_KEYS.MANUAL_GL]: "Manual GL Upload",
  [REPORT_SOURCE_KEYS.MANUAL_UPLOAD]: "Manual Upload (Excel or PDF)",
};

const VALID_SOURCE_KEYS = Object.values(REPORT_SOURCE_KEYS);

function normalizeSourceKey(value) {
  return VALID_SOURCE_KEYS.includes(value)
    ? value
    : REPORT_SOURCE_KEYS.QUICKBOOKS;
}

function getDefaultRows(companyId) {
  return [
    {
      company_id: companyId,
      source_key: REPORT_SOURCE_KEYS.QUICKBOOKS,
      source_label: REPORT_SOURCE_LABELS[REPORT_SOURCE_KEYS.QUICKBOOKS],
      is_selected: true,
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

async function ensureReportSourceRecords(companyId) {
  if (!companyId) {
    throw new Error("companyId is required");
  }

  const { data: existingRows, error: existingError } = await supabase
    .from("report_source_records")
    .select("source_key")
    .eq("company_id", companyId);

  if (existingError) {
    throw new Error(
      `Failed to ensure report source records: ${existingError.message}`,
    );
  }

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
    return;
  }

  const { error } = await supabase
    .from("report_source_records")
    .insert(missingRows);

  if (error && error.code !== "23505") {
    throw new Error(`Failed to ensure report source records: ${error.message}`);
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
    .select("last_synced_at, updated_at")
    .eq("company_id", companyId)
    .eq("source", "quickbooks")
    .order("last_synced_at", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return {
    isConnected: Boolean(connection?.is_connected !== false && connection?.realm_id),
    isAvailable: Boolean(
      (connection?.is_connected !== false && connection?.realm_id) || cachedReport
    ),
    lastConnectedAt: connection?.connected_at || null,
    lastSyncedAt:
      cachedReport?.last_synced_at || connection?.last_synced || null,
    metadata: {
      realmId: connection?.realm_id || null,
      companyName: connection?.company_name || null,
      environment: connection?.environment || null,
      cacheUpdatedAt: cachedReport?.updated_at || null,
    },
  };
}

async function getManualGlSnapshot(companyId) {
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

  return {
    isConnected: false,
    isAvailable: Boolean(manualReport),
    lastConnectedAt: null,
    lastSyncedAt:
      manualReport?.last_synced_at || manualReport?.updated_at || null,
    metadata: {
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

async function updateReportSourceRecord(companyId, sourceKey, updates = {}) {
  if (!companyId) {
    throw new Error("companyId is required");
  }

  const normalizedSourceKey = normalizeSourceKey(sourceKey);
  await ensureReportSourceRecords(companyId);

  const { data: current, error: currentError } = await supabase
    .from("report_source_records")
    .select("*")
    .eq("company_id", companyId)
    .eq("source_key", normalizedSourceKey)
    .maybeSingle();

  if (currentError) {
    throw new Error(`Failed to load report source record: ${currentError.message}`);
  }

  const payload = {
    company_id: companyId,
    source_key: normalizedSourceKey,
    source_label:
      REPORT_SOURCE_LABELS[normalizedSourceKey] || current?.source_label || normalizedSourceKey,
    is_selected:
      typeof updates.isSelected === "boolean"
        ? updates.isSelected
        : Boolean(current?.is_selected),
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

  const [quickbooksSnapshot, manualSnapshot, manualUploadSnapshot] = await Promise.all([
    getQuickBooksSnapshot(companyId),
    getManualGlSnapshot(companyId),
    getManualUploadSnapshot(companyId),
  ]);

  await Promise.all([
    updateReportSourceRecord(companyId, REPORT_SOURCE_KEYS.QUICKBOOKS, quickbooksSnapshot),
    updateReportSourceRecord(companyId, REPORT_SOURCE_KEYS.MANUAL_GL, manualSnapshot),
    updateReportSourceRecord(companyId, REPORT_SOURCE_KEYS.MANUAL_UPLOAD, manualUploadSnapshot),
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

  await setSelectedReportSource(companyId, REPORT_SOURCE_KEYS.QUICKBOOKS);
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
