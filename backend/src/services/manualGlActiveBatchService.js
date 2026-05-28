const crypto = require("crypto");
const { supabase } = require("../db");

const MANUAL_GL_SOURCE_TYPE = "manual_gl_upload";
const TABLE_BATCHES = "manual_gl_batches";
const TABLE_TRANSACTIONS = "manual_gl_staged_transactions";
const REPORT_BATCH_MODE = Object.freeze({
  ACTIVE: "active",
  HISTORICAL: "historical",
});
const MANUAL_GL_SOURCE_ALIASES = new Set([
  MANUAL_GL_SOURCE_TYPE,
  "manual_gl",
]);

function toText(value, fallback = "") {
  const text = String(value || "").trim();
  return text || fallback;
}

function normalizeSessionStatus(status) {
  return toText(status).toLowerCase();
}

function isStagedSessionStatus(status) {
  const normalized = normalizeSessionStatus(status);
  return normalized === "staged" || normalized === "active";
}

function normalizeSupabaseErrorMessage(error) {
  const message = toText(error?.message);
  if (!message) return "Unknown Supabase error.";

  const compact = message.replace(/\s+/g, " ").trim();
  const lower = compact.toLowerCase();
  const isHtmlPayload =
    lower.includes("<!doctype html") ||
    lower.includes("<html") ||
    lower.includes("<head>") ||
    lower.includes("<body>");

  if (isHtmlPayload) {
    const cfCode =
      compact.match(/error code\s*([0-9]{3})/i)?.[1] ||
      compact.match(/\b(52[0-9])\b/)?.[1] ||
      "";

    if (cfCode) {
      return `Supabase upstream unavailable (Cloudflare ${cfCode}).`;
    }
    return "Supabase returned an unexpected HTML error response.";
  }

  if (compact.length > 500) {
    return `${compact.slice(0, 500)}...`;
  }

  return compact;
}

function formatSupabaseFailure(prefix, error) {
  const safeMessage = normalizeSupabaseErrorMessage(error);
  const status = Number(error?.status || 0);
  const statusText = Number.isInteger(status) && status > 0 ? ` (status ${status})` : "";
  return `${prefix}: ${safeMessage}${statusText}`;
}

function isMissingColumnError(error, columnName = "") {
  if (!error) return false;
  const message = String(error.message || "").toLowerCase();
  if (!message.includes("column")) return false;
  if (!columnName) return true;
  return message.includes(String(columnName).toLowerCase());
}

function normalizeBatchStatus(batch = {}) {
  return toText(batch.batch_status || batch.status || "", "processing").toLowerCase();
}

function isManualBatchSource(sourceType) {
  const normalized = toText(sourceType).toLowerCase();
  return !normalized || MANUAL_GL_SOURCE_ALIASES.has(normalized);
}

function mapBatchRow(row) {
  if (!row) return null;
  const datasetVersion = Number(row.dataset_version);
  return {
    ...row,
    source_type: toText(row.source_type, MANUAL_GL_SOURCE_TYPE),
    batch_status: normalizeBatchStatus(row),
    is_active: Boolean(row.is_active),
    is_archived: Boolean(row.is_archived),
    dataset_version: Number.isInteger(datasetVersion) && datasetVersion > 0 ? datasetVersion : null,
  };
}

function buildCanonicalTransactionFingerprint(row = {}) {
  return [
    String(row.fiscal_year || ""),
    String(row.txn_date || ""),
    String(row.account_number || ""),
    String(row.account_name || ""),
    Number(row.debit || 0).toFixed(2),
    Number(row.credit || 0).toFixed(2),
    Number(row.net_amount || 0).toFixed(2),
    String(row.class || ""),
    String(row.department || ""),
    String(row.location || ""),
    String(row.transaction_type || ""),
    String(row.journal_type || ""),
    String(row.reference || ""),
    String(row.description || ""),
  ].join("|").toLowerCase();
}

function shouldAllowExplicitBatch(options = {}) {
  if (!options || typeof options !== "object") return false;
  if (toText(options.versionId || options.uploadSessionId || "")) return true;
  const datasetVersion = Number(
    options.datasetVersion || options.dataset_version || options.versionNumber || options.version_number || 0,
  );
  if (Number.isInteger(datasetVersion) && datasetVersion > 0) return true;
  if (options.allowExplicitBatch === true) return true;
  const mode = toText(options.mode || options.versionMode || "").toLowerCase();
  if (mode === REPORT_BATCH_MODE.HISTORICAL) return true;
  if (options.includeArchived === true) return true;
  return false;
}

async function getActiveUploadBatch(companyId) {
  if (!companyId) return null;

  let { data, error } = await supabase
    .from(TABLE_BATCHES)
    .select("*")
    .eq("company_id", companyId)
    .eq("is_active", true)
    .order("updated_at", { ascending: false })
    .limit(50);

  if (error && isMissingColumnError(error, "is_active")) {
    // Backward-compatible fallback for deployments that have not yet run migration 026.
    ({ data, error } = await supabase
      .from(TABLE_BATCHES)
      .select("*")
      .eq("company_id", companyId)
      .eq("status", "staged")
      .order("created_at", { ascending: false })
      .limit(50));
  }

  if (error && error.code !== "PGRST116") {
    throw new Error(formatSupabaseFailure("Failed to load active upload batch", error));
  }

  const rows = Array.isArray(data) ? data : (data ? [data] : []);
  const mapped = rows.map(mapBatchRow).filter(Boolean);
  const matched = mapped.find((row) => isManualBatchSource(row?.source_type));
  return matched || mapped[0] || null;
}

async function getUploadBatchById(companyId, batchId) {
  if (!companyId || !batchId) return null;

  const { data, error } = await supabase
    .from(TABLE_BATCHES)
    .select("*")
    .eq("id", batchId)
    .eq("company_id", companyId)
    .maybeSingle();

  if (error && error.code !== "PGRST116") {
    throw new Error(formatSupabaseFailure("Failed to load upload batch", error));
  }

  return mapBatchRow(data || null);
}

async function resolveReportBatchId(companyId, preferredBatchId = "", options = {}) {
  if (!companyId) return "";
  const allowExplicitBatch = shouldAllowExplicitBatch(options);
  const explicit = toText(preferredBatchId || options.versionId || options.uploadSessionId || "");
  const datasetVersion = Number(
    options.datasetVersion || options.dataset_version || options.versionNumber || options.version_number || 0,
  );
  const hasDatasetVersion = Number.isInteger(datasetVersion) && datasetVersion > 0;

  if (explicit && allowExplicitBatch) {
    // 1. Try resolving as a direct manual_gl_batches.id
    let requestedBatch = await getUploadBatchById(companyId, explicit);
    if (requestedBatch?.id && isManualBatchSource(requestedBatch.source_type)) {
      return requestedBatch.id;
    }

    // 2. Try resolving as a manual_gl_upload_sessions.id (versionId)
    const { data: sessionData } = await supabase
      .from("manual_gl_upload_sessions")
      .select("staging_batch_id")
      .eq("company_id", companyId)
      .eq("id", explicit)
      .maybeSingle();

    if (sessionData?.staging_batch_id) {
      requestedBatch = await getUploadBatchById(companyId, sessionData.staging_batch_id);
      if (requestedBatch?.id) return requestedBatch.id;
    }

    console.warn(
      `[ManualGL][ActiveBatch] Ignoring historical batch/version override "${explicit}" ` +
      `for company ${companyId}: not found or not manual GL.`,
    );
  } else if (explicit && !allowExplicitBatch) {
    console.info(
      `[ManualGL][ActiveBatch] Ignoring requested batch "${explicit}" for company ${companyId}; ` +
      "active batch mode enforced.",
    );
  }

  if (hasDatasetVersion) {
    let { data, error } = await supabase
      .from(TABLE_BATCHES)
      .select("id, source_type, dataset_version, created_at")
      .eq("company_id", companyId)
      .eq("dataset_version", datasetVersion)
      .order("created_at", { ascending: false })
      .limit(50);

    if (error && isMissingColumnError(error, "source_type")) {
      ({ data, error } = await supabase
        .from(TABLE_BATCHES)
        .select("id, dataset_version, created_at")
        .eq("company_id", companyId)
        .eq("dataset_version", datasetVersion)
        .order("created_at", { ascending: false })
        .limit(50));
    }

    if (error && isMissingColumnError(error, "dataset_version")) {
      console.warn(
        `[ManualGL][ActiveBatch] dataset_version column missing; cannot resolve dataset version ` +
        `${datasetVersion} for company ${companyId}.`,
      );
    } else if (error && error.code !== "PGRST116") {
      throw new Error(formatSupabaseFailure("Failed to resolve report batch by dataset version", error));
    } else {
      const rows = Array.isArray(data) ? data : (data ? [data] : []);
      const matched = rows.find((row) => isManualBatchSource(row?.source_type));
      const resolved = matched || rows[0] || null;
      if (resolved?.id) {
        console.log(
          `[ManualGL][ActiveBatch] Resolved dataset_version=${datasetVersion} to batch=${resolved.id} ` +
          `for company=${companyId}`,
        );
        return resolved.id;
      }
      console.warn(
        `[ManualGL][ActiveBatch] No batch found for dataset_version=${datasetVersion} company=${companyId}.`,
      );
    }
  }

  const active = await getActiveUploadBatch(companyId);
  if (active?.id) return active.id;

  let { data, error } = await supabase
    .from(TABLE_BATCHES)
    .select("id, source_type")
    .eq("company_id", companyId)
    .order("created_at", { ascending: false })
    .limit(50);

  if (error && isMissingColumnError(error, "source_type")) {
    ({ data, error } = await supabase
      .from(TABLE_BATCHES)
      .select("id")
      .eq("company_id", companyId)
      .order("created_at", { ascending: false })
      .limit(50));
  }

  if (error && error.code !== "PGRST116") {
    throw new Error(formatSupabaseFailure("Failed to resolve latest upload batch", error));
  }

  const rows = Array.isArray(data) ? data : (data ? [data] : []);
  const matched = rows.find((row) => isManualBatchSource(row?.source_type));
  return matched?.id || rows[0]?.id || "";
}

async function listUploadBatches(companyId, limit = 100) {
  if (!companyId) return [];

  let { data, error } = await supabase
    .from(TABLE_BATCHES)
    .select("*")
    .eq("company_id", companyId)
    .in("status", ["staged", "active"])
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error && isMissingColumnError(error, "source_type")) {
    ({ data, error } = await supabase
      .from(TABLE_BATCHES)
      .select("*")
      .eq("company_id", companyId)
      .order("created_at", { ascending: false })
      .limit(Math.max(limit * 2, limit)));
  }

  if (error) {
    throw new Error(formatSupabaseFailure("Failed to list upload batches", error));
  }

  const rows = Array.isArray(data) ? data : [];
  const filtered = rows.filter((row) => isManualBatchSource(row?.source_type));
  return filtered.slice(0, limit).map(mapBatchRow);
}

/**
 * Lists dataset versions specifically for Manual GL reporting.
 * Ensures that if multiple versions point to the same batch (rare), 
 * we only show unique entries.
 */
async function listManualGlDatasetVersions(companyId, limit = 50) {
  if (!companyId) return [];

  const fetchLimit = Math.max(limit * 10, limit);
  const { data, error } = await supabase
    .from("manual_gl_upload_sessions")
    .select(`
      id,
      version_no,
      fiscal_year,
      is_active,
      status,
      created_at,
      data_hash,
      staging_batch_id
    `)
    .eq("company_id", companyId)
    .order("created_at", { ascending: false })
    .limit(fetchLimit);

  if (error) {
    console.error("[ManualGL][ActiveBatch] Failed to list dataset versions:", error.message);
    return [];
  }

  const stagedRows = (Array.isArray(data) ? data : []).filter((row) =>
    isStagedSessionStatus(row?.status),
  );

  const batchIds = Array.from(
    new Set(
      stagedRows
        .map((row) => toText(row?.staging_batch_id))
        .filter(Boolean),
    ),
  );

  const batchMap = new Map();
  if (batchIds.length > 0) {
    const { data: batchRows, error: batchError } = await supabase
      .from(TABLE_BATCHES)
      .select("id, dataset_version, is_active, batch_status, status, created_at, source_type")
      .in("id", batchIds);

    if (batchError) {
      console.warn("[ManualGL][ActiveBatch] Failed to hydrate batch metadata for versions:", batchError.message);
    } else {
      (Array.isArray(batchRows) ? batchRows : [])
        .filter((row) => isManualBatchSource(row?.source_type))
        .forEach((row) => {
          batchMap.set(row.id, mapBatchRow(row));
        });
    }
  }

  const grouped = new Map();
  stagedRows.forEach((row) => {
    const key = toText(row?.staging_batch_id || row?.id);
    if (!key) return;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  });

  const versions = Array.from(grouped.entries())
    .map(([groupKey, rows]) => {
      const sortedRows = rows
        .slice()
        .sort((left, right) => new Date(right?.created_at || 0) - new Date(left?.created_at || 0));
      const representative = sortedRows[0] || null;
      if (!representative) return null;

      const batchId = toText(representative.staging_batch_id || "");
      const batch = batchId ? batchMap.get(batchId) : null;
      const fiscalYears = Array.from(
        new Set(
          sortedRows
            .map((item) => Number(item?.fiscal_year || 0))
            .filter((year) => Number.isInteger(year) && year > 0),
        ),
      ).sort((a, b) => b - a);

      const versionNumberFromBatch = Number(batch?.dataset_version || 0);
      const versionNumberFromSession = Number(representative?.version_no || 0);
      const versionNumber =
        Number.isInteger(versionNumberFromBatch) && versionNumberFromBatch > 0
          ? versionNumberFromBatch
          : Number.isInteger(versionNumberFromSession) && versionNumberFromSession > 0
            ? versionNumberFromSession
            : null;

      const createdAt = batch?.created_at || representative?.created_at || null;
      const isActive = Boolean(batch?.is_active) || sortedRows.some((item) => item?.is_active === true);
      const status = batch?.batch_status || batch?.status || representative?.status || "staged";

      return {
        id: batchId || groupKey,
        version_number: versionNumber,
        version_no: representative?.version_no || null,
        fiscal_year: fiscalYears[0] || null,
        fiscal_years: fiscalYears,
        is_active: isActive,
        status,
        created_at: createdAt,
        data_hash: representative?.data_hash || null,
        batch_id: batchId || null,
        upload_session_id: representative?.id || null,
        versionNumber,
        fiscalYear: fiscalYears[0] || null,
        fiscalYears,
        isActive,
        createdAt,
        dataHash: representative?.data_hash || null,
        batchId: batchId || null,
        uploadSessionId: representative?.id || null,
      };
    })
    .filter(Boolean)
    .sort((left, right) => new Date(right?.created_at || 0) - new Date(left?.created_at || 0))
    .slice(0, limit);

  console.log(
    `[ManualGL][ActiveBatch] listManualGlDatasetVersions company=${companyId} ` +
    `rows=${stagedRows.length} versions=${versions.length}`,
  );

  return versions;
}

async function patchUploadBatch(batchId, patch = {}) {
  if (!batchId) return null;

  const payload = {
    ...patch,
    updated_at: new Date().toISOString(),
  };

  let { data, error } = await supabase
    .from(TABLE_BATCHES)
    .update(payload)
    .eq("id", batchId)
    .select("*")
    .maybeSingle();

  if (error && isMissingColumnError(error)) {
    const legacyPayload = {
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.batch_name !== undefined ? { batch_name: patch.batch_name } : {}),
      ...(patch.metadata && typeof patch.metadata === "object" ? { metadata: patch.metadata } : {}),
      updated_at: payload.updated_at,
    };

    ({ data, error } = await supabase
      .from(TABLE_BATCHES)
      .update(legacyPayload)
      .eq("id", batchId)
      .select("*")
      .maybeSingle());
  }

  if (error) {
    throw new Error(formatSupabaseFailure(`Failed to update upload batch ${batchId}`, error));
  }

  return mapBatchRow(data || null);
}

async function activateUploadBatch(companyId, batchId, activatedBy = null) {
  if (!companyId || !batchId) {
    throw new Error("Both companyId and batchId are required to activate upload batch.");
  }

  const now = new Date().toISOString();

  // Preferred path: transactional RPC activation.
  const { data: rpcResult, error: rpcError } = await supabase
    .rpc("activate_manual_gl_batch", {
      p_company_id: companyId,
      p_batch_id: batchId,
      p_activated_by: activatedBy || null,
    });

  if (!rpcError) {
    const activated = Array.isArray(rpcResult) ? rpcResult[0] : rpcResult;
    return mapBatchRow(activated || null);
  }

  // Fallback path for environments where migration 026 RPC does not exist yet.
  console.warn(
    "[ManualGL][ActiveBatch] RPC activation fallback:",
    normalizeSupabaseErrorMessage(rpcError),
  );

  const { error: deactivateError } = await supabase
    .from(TABLE_BATCHES)
    .update({
      is_active: false,
      is_archived: true,
      batch_status: "inactive",
      deactivated_at: now,
      deactivated_by: activatedBy || null,
      updated_at: now,
    })
    .eq("company_id", companyId)
    .eq("is_active", true)
    .neq("id", batchId);

  if (deactivateError && !isMissingColumnError(deactivateError, "is_active")) {
    throw new Error(formatSupabaseFailure("Failed to deactivate active upload batch", deactivateError));
  }

  const activated = await patchUploadBatch(batchId, {
    is_active: true,
    is_archived: false,
    batch_status: "active",
    status: "staged",
    activated_at: now,
    activated_by: activatedBy || null,
    processing_completed_at: now,
  });

  return activated;
}

async function findActiveBatchByChecksum(companyId, checksum) {
  const contentHash = toText(checksum);
  if (!companyId || !contentHash) return null;

  // Check dataset_hash first (migration 035/036 column, populated by SQL RPC).
  // Fall back to upload_checksum (legacy Node.js SHA256 hash).
  for (const column of ["dataset_hash", "upload_checksum"]) {
    let { data, error } = await supabase
      .from(TABLE_BATCHES)
      .select("*")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .eq(column, contentHash)
      .order("updated_at", { ascending: false })
      .limit(50);

    if (error && isMissingColumnError(error, column)) {
      continue; // Column not yet migrated — try next
    }
    if (error && error.code !== "PGRST116") {
      throw new Error(formatSupabaseFailure("Failed to load active checksum batch", error));
    }

    const rows = Array.isArray(data) ? data : (data ? [data] : []);
    const matched = rows.find((row) => isManualBatchSource(row?.source_type));
    const hit = matched || rows[0] || null;
    if (hit) return mapBatchRow(hit);
  }

  return null;
}

/**
 * Compute a stable dataset hash via a single SQL RPC call (migration 036).
 *
 * The SQL function compute_batch_dataset_hash() runs entirely inside Postgres,
 * eliminating the previous pattern of 100+ sequential paginated round-trips
 * that caused statement timeouts, DB overload, and Supabase unhealthy states
 * on uploads with 100k+ rows.
 *
 * Falls back to the legacy batch_id column if upload_batch_id is missing.
 * Falls back to the Node.js pagination approach if the RPC function does not
 * exist yet (schema not migrated) so old deployments keep working.
 */
async function computeUploadChecksum(companyId, batchId) {
  if (!companyId || !batchId) {
    throw new Error("Both companyId and batchId are required to compute upload checksum.");
  }

  // Fast path: single SQL aggregate (migration 036 required)
  const { data: rpcData, error: rpcError } = await supabase.rpc(
    "compute_batch_dataset_hash",
    { p_company_id: companyId, p_batch_id: batchId },
  );

  if (!rpcError) {
    const row = Array.isArray(rpcData) ? rpcData[0] : rpcData;
    if (row) {
      const checksum = String(row.dataset_hash || "").trim() || null;
      const rowCount = Number(row.row_count || 0);
      console.log(`[ManualGL][Checksum] SQL RPC: rows=${rowCount} checksum=${checksum ? checksum.slice(0, 12) + "..." : "null"}`);
      return { checksum, rowCount };
    }
  }

  // If RPC returned an error for upload_batch_id column, try legacy batch_id column
  if (rpcError && isMissingColumnError(rpcError, "upload_batch_id")) {
    const { data: legacyData, error: legacyError } = await supabase.rpc(
      "compute_batch_dataset_hash_legacy",
      { p_company_id: companyId, p_batch_id: batchId },
    );
    if (!legacyError) {
      const row = Array.isArray(legacyData) ? legacyData[0] : legacyData;
      if (row) {
        return { checksum: String(row.dataset_hash || "").trim() || null, rowCount: Number(row.row_count || 0) };
      }
    }
  }

  // Slow fallback: RPC function not deployed yet (pre-migration 036 schema).
  // Uses paginated reads — acceptable for small datasets, but logs a warning.
  if (rpcError) {
    const isRpcMissing = String(rpcError.message || "").toLowerCase().includes("could not find the function");
    if (isRpcMissing) {
      console.warn("[ManualGL][Checksum] SQL RPC not available — falling back to paginated checksum. Run migration 036.");
    } else {
      console.warn("[ManualGL][Checksum] SQL RPC failed, falling back to paginated:", rpcError.message);
    }
  }

  const digest = crypto.createHash("sha256");
  const pageSize = 1000;
  let offset = 0;
  let rowCount = 0;
  let batchColumn = "upload_batch_id";

  while (true) {
    const { data, error } = await supabase
      .from(TABLE_TRANSACTIONS)
      .select("fiscal_year, txn_date, account_number, account_name, debit, credit, net_amount, class, department, location, transaction_type, journal_type, reference, description")
      .eq("company_id", companyId)
      .eq(batchColumn, batchId)
      .order("id", { ascending: true })
      .range(offset, offset + pageSize - 1);

    if (error && batchColumn === "upload_batch_id" && isMissingColumnError(error, "upload_batch_id")) {
      batchColumn = "batch_id";
      continue;
    }

    if (error) {
      throw new Error(formatSupabaseFailure("Failed to compute checksum", error));
    }

    const rows = Array.isArray(data) ? data : [];
    if (!rows.length) break;

    rows.forEach((row) => {
      const fingerprint = buildCanonicalTransactionFingerprint(row);
      if (!fingerprint) return;
      digest.update(fingerprint);
      digest.update("|");
      rowCount += 1;
    });

    if (rows.length < pageSize) break;
    offset += rows.length;
  }

  digest.update(`#rows:${rowCount}`);
  const checksum = digest.digest("hex");

  return { checksum, rowCount };
}

async function setUploadChecksum(batchId, checksum, rowCount = null) {
  const contentHash = toText(checksum);
  if (!batchId || !contentHash) return null;

  // Store in both columns:
  //   upload_checksum — legacy field, still used by older dedup queries
  //   dataset_hash    — new field (migration 035), indexed for fast dedup lookup
  const patch = {
    upload_checksum: contentHash,
    dataset_hash:    contentHash,
  };

  if (Number.isInteger(Number(rowCount)) && Number(rowCount) >= 0) {
    patch.row_count = Number(rowCount);
    patch.metadata  = { checksumRowCount: Number(rowCount) };
  }

  // Merge metadata without dropping existing keys.
  const { data: current, error: currentError } = await supabase
    .from(TABLE_BATCHES)
    .select("metadata")
    .eq("id", batchId)
    .maybeSingle();

  if (!currentError) {
    patch.metadata = {
      ...(current?.metadata && typeof current.metadata === "object" ? current.metadata : {}),
      ...(patch.metadata || {}),
      uploadChecksum: contentHash,
    };
  }

  return patchUploadBatch(batchId, patch);
}

module.exports = {
  MANUAL_GL_SOURCE_TYPE,
  REPORT_BATCH_MODE,
  getActiveUploadBatch,
  getUploadBatchById,
  resolveReportBatchId,
  listUploadBatches,
  listManualGlDatasetVersions,
  patchUploadBatch,
  activateUploadBatch,
  findActiveBatchByChecksum,
  computeUploadChecksum,
  setUploadChecksum,
};

