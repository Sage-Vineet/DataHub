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
  const explicit = toText(preferredBatchId);

  if (explicit && allowExplicitBatch) {
    const requestedBatch = await getUploadBatchById(companyId, explicit);
    if (
      requestedBatch?.id &&
      toText(requestedBatch.source_type, MANUAL_GL_SOURCE_TYPE) === MANUAL_GL_SOURCE_TYPE
    ) {
      return requestedBatch.id;
    }

    console.warn(
      `[ManualGL][ActiveBatch] Ignoring historical batch override "${explicit}" ` +
      `for company ${companyId}: batch not found or not manual GL.`,
    );
  } else if (explicit && !allowExplicitBatch) {
    console.info(
      `[ManualGL][ActiveBatch] Ignoring requested batch "${explicit}" for company ${companyId}; ` +
      "active batch mode enforced.",
    );
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
    .order("created_at", { ascending: false })
    .limit(Math.max(limit * 2, limit));

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

  let { data, error } = await supabase
    .from(TABLE_BATCHES)
    .select("*")
    .eq("company_id", companyId)
    .eq("is_active", true)
    .eq("upload_checksum", contentHash)
    .order("updated_at", { ascending: false })
    .limit(50);

  if (error && isMissingColumnError(error, "upload_checksum")) {
    return null;
  }

  if (error && error.code !== "PGRST116") {
    throw new Error(formatSupabaseFailure("Failed to load active checksum batch", error));
  }

  const rows = Array.isArray(data) ? data : (data ? [data] : []);
  const matched = rows.find((row) => isManualBatchSource(row?.source_type));
  return mapBatchRow(matched || rows[0] || null);
}

async function computeUploadChecksum(companyId, batchId) {
  if (!companyId || !batchId) {
    throw new Error("Both companyId and batchId are required to compute upload checksum.");
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

  return {
    checksum,
    rowCount,
  };
}

async function setUploadChecksum(batchId, checksum, rowCount = null) {
  const contentHash = toText(checksum);
  if (!batchId || !contentHash) return null;

  const patch = {
    upload_checksum: contentHash,
  };

  if (Number.isInteger(Number(rowCount)) && Number(rowCount) >= 0) {
    patch.metadata = {
      checksumRowCount: Number(rowCount),
    };
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
  patchUploadBatch,
  activateUploadBatch,
  findActiveBatchByChecksum,
  computeUploadChecksum,
  setUploadChecksum,
};

