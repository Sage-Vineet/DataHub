/**
 * datasetVersionService.js
 *
 * Core service for snapshot-based dataset versioning.
 * Manages upload jobs, dataset versions, and atomic snapshot activation.
 *
 * Architecture:
 *   upload_jobs   → tracks the lifecycle of each GL upload attempt
 *   dataset_versions → immutable snapshots; only the active one feeds reports
 *   validation_errors → per-upload structured validation failures
 *
 * Key invariants:
 *   1. At most ONE dataset_version per company has is_active = true
 *   2. Reports ONLY read rows tagged with the active dataset_version_id
 *   3. Failed uploads NEVER deactivate the previous active version
 *   4. Activation uses the Supabase RPC function for transactional atomicity
 */

const { supabase } = require("../db");

const TABLES = {
    uploadJobs: "upload_jobs",
    datasetVersions: "dataset_versions",
    validationErrors: "validation_errors",
};

const MANUAL_GL_SOURCE_TYPE = "manual_gl_upload";
const FINALIZED_DATASET_STATUSES = new Set(["finalized", "completed"]);

function isMissingColumnError(error, columnName = "") {
    if (!error) return false;
    const message = String(error.message || "").toLowerCase();
    if (!message.includes("column")) return false;
    if (!columnName) return true;
    return message.includes(String(columnName).toLowerCase());
}

function normalizeText(value, fallback = "") {
    const text = String(value || "").trim();
    return text || fallback;
}

function normalizeDatasetHash(value) {
    return normalizeText(value).toLowerCase() || null;
}

function normalizeFiscalYears(value = []) {
    return Array.from(
        new Set(
            (Array.isArray(value) ? value : [])
                .map((item) => Number(item))
                .filter((item) => Number.isInteger(item) && item > 0),
        ),
    ).sort((a, b) => a - b);
}

function isManualGlDatasetVersion(row = {}) {
    const sourceType = normalizeText(row?.source_type, "").toLowerCase();
    if (sourceType) {
        return sourceType === MANUAL_GL_SOURCE_TYPE;
    }

    const uploadSource = normalizeText(row?.upload_source, "").toLowerCase();
    if (!uploadSource) {
        return true;
    }
    if (uploadSource.includes("quickbooks")) {
        return false;
    }
    if (uploadSource.includes("manual")) {
        return true;
    }

    return true;
}

// ─── Upload Job Status Constants ──────────────────────────────────────────────

const UPLOAD_JOB_STATUS = {
    QUEUED: "queued",   // created but metadata not yet written — worker must not claim this
    PENDING: "pending",
    PARSING: "parsing",
    VALIDATING: "validating",
    STAGING: "staging",
    FINALIZING: "finalizing",
    COMPLETED: "completed",
    FAILED: "failed",
    CANCELLED: "cancelled",
};

// ─── Dataset Version Status Constants ─────────────────────────────────────────

const DATASET_VERSION_STATUS = {
    STAGING: "staging",
    VALIDATING: "validating",
    FINALIZED: "finalized",
    FAILED: "failed",
    ROLLED_BACK: "rolled_back",
};

// ─── Upload Jobs ──────────────────────────────────────────────────────────────

/**
 * Create a new upload job to track an upload lifecycle.
 */
async function createUploadJob(companyId, uploadSource = "", createdBy = null) {
    if (!companyId) throw new Error("companyId is required to create an upload job.");

    const payload = {
        company_id: companyId,
        status: UPLOAD_JOB_STATUS.QUEUED,
        upload_source: uploadSource || null,
        created_by: createdBy || null,
        progress: { stage: "pending", pct: 0 },
    };

    const { data, error } = await supabase
        .from(TABLES.uploadJobs)
        .insert(payload)
        .select()
        .single();

    if (error) throw new Error(`Failed to create upload job: ${error.message}`);
    return data;
}

/**
 * Update an upload job's status and optional progress/error.
 */
async function updateUploadJob(jobId, updates = {}) {
    if (!jobId) throw new Error("jobId is required.");

    const patch = { updated_at: new Date().toISOString() };

    if (updates.status) patch.status = updates.status;
    if (updates.error) patch.error_message = updates.error;
    if (updates.progress) patch.progress = updates.progress;
    if (updates.metadata && typeof updates.metadata === "object" && Object.keys(updates.metadata).length > 0) {
        patch.metadata = updates.metadata;
    }

    const { data, error } = await supabase
        .from(TABLES.uploadJobs)
        .update(patch)
        .eq("id", jobId)
        .select()
        .single();

    if (error) throw new Error(`Failed to update upload job ${jobId}: ${error.message}`);
    return data;
}

/**
 * Get a single upload job by ID.
 */
async function getUploadJob(jobId) {
    if (!jobId) return null;

    const { data, error } = await supabase
        .from(TABLES.uploadJobs)
        .select("*")
        .eq("id", jobId)
        .single();

    if (error && error.code !== "PGRST116") {
        throw new Error(`Failed to fetch upload job: ${error.message}`);
    }
    return data || null;
}

/**
 * List upload jobs for a company, most recent first.
 */
async function listUploadJobs(companyId, limit = 20) {
    if (!companyId) throw new Error("companyId is required.");

    const { data, error } = await supabase
        .from(TABLES.uploadJobs)
        .select("*")
        .eq("company_id", companyId)
        .order("created_at", { ascending: false })
        .limit(limit);

    if (error) throw new Error(`Failed to list upload jobs: ${error.message}`);
    return data || [];
}

// ─── Dataset Versions ─────────────────────────────────────────────────────────

/**
 * Create a new dataset version for a company.
 * Auto-increments version_number using the RPC function.
 */
async function createDatasetVersion(companyId, uploadJobId = null, uploadSource = "", options = {}) {
    if (!companyId) throw new Error("companyId is required to create a dataset version.");

    // Get next version number via RPC
    const { data: nextVersion, error: rpcError } = await supabase
        .rpc("next_dataset_version_number", { p_company_id: companyId });

    if (rpcError) {
        // Fallback: query max version manually
        console.warn("[DatasetVersion] RPC fallback for next version number:", rpcError.message);
        const { data: maxRow } = await supabase
            .from(TABLES.datasetVersions)
            .select("version_number")
            .eq("company_id", companyId)
            .order("version_number", { ascending: false })
            .limit(1)
            .single();

        var versionNumber = (maxRow?.version_number || 0) + 1;
    } else {
        var versionNumber = nextVersion || 1;
    }

    const datasetHash = normalizeDatasetHash(options.datasetHash || options.contentHash || "");
    const fiscalYears = normalizeFiscalYears(options.fiscalYears || []);
    const rowCount = Number.isInteger(Number(options.rowCount)) && Number(options.rowCount) >= 0
        ? Number(options.rowCount)
        : null;
    const sourceType = normalizeText(options.sourceType || MANUAL_GL_SOURCE_TYPE, MANUAL_GL_SOURCE_TYPE);
    const metadataPatch = {
        ...(options.metadata && typeof options.metadata === "object" ? options.metadata : {}),
    };

    if (datasetHash) {
        metadataPatch.datasetHash = datasetHash;
        metadataPatch.contentHash = datasetHash;
    }
    if (fiscalYears.length > 0) {
        metadataPatch.fiscalYears = fiscalYears;
    }
    if (rowCount !== null) {
        metadataPatch.rowCount = rowCount;
    }

    const payload = {
        company_id: companyId,
        version_number: versionNumber,
        is_active: false,
        status: DATASET_VERSION_STATUS.STAGING,
        upload_job_id: uploadJobId || null,
        upload_source: uploadSource || null,
        source_type: sourceType,
        ...(datasetHash ? { dataset_hash: datasetHash, content_hash: datasetHash } : {}),
        ...(fiscalYears.length > 0 ? { fiscal_years: fiscalYears } : {}),
        ...(rowCount !== null ? { row_count: rowCount } : {}),
        metadata: Object.keys(metadataPatch).length > 0 ? metadataPatch : {},
    };

    let { data, error } = await supabase
        .from(TABLES.datasetVersions)
        .insert(payload)
        .select()
        .single();

    if (error && isMissingColumnError(error)) {
        const legacyPayload = {
            company_id: companyId,
            version_number: versionNumber,
            is_active: false,
            status: DATASET_VERSION_STATUS.STAGING,
            upload_job_id: uploadJobId || null,
            upload_source: uploadSource || null,
            metadata: Object.keys(metadataPatch).length > 0 ? metadataPatch : {},
        };

        ({ data, error } = await supabase
            .from(TABLES.datasetVersions)
            .insert(legacyPayload)
            .select()
            .single());
    }

    if (error) throw new Error(`Failed to create dataset version: ${error.message}`);

    console.log(`[DatasetVersion] Created v${versionNumber} for company ${companyId} (id=${data.id})`);
    return data;
}

/**
 * Find an existing Manual GL dataset version by hash.
 * Prefers finalized versions, but can optionally return any non-failed version
 * when includeNonFailed is true so callers can handle race conditions safely.
 */
async function findExistingDatasetVersionByHash(
    companyId,
    datasetHash,
    options = {},
) {
    if (!companyId || !datasetHash) return null;

    const normalizedHash = normalizeDatasetHash(datasetHash);
    if (!normalizedHash) return null;

    const includeNonFailed = options.includeNonFailed === true;
    const sourceType = normalizeText(options.sourceType || MANUAL_GL_SOURCE_TYPE, MANUAL_GL_SOURCE_TYPE);
    const statusFilter = includeNonFailed
        ? null
        : Array.isArray(options.statuses) && options.statuses.length > 0
            ? options.statuses
            : Array.from(FINALIZED_DATASET_STATUSES);

    const lookupViaRpc = async () => {
        const { data, error } = await supabase.rpc("find_manual_gl_dataset_version_by_hash", {
            p_company_id: companyId,
            p_dataset_hash: normalizedHash,
        });

        if (error) {
            return { data: null, error };
        }

        const rows = Array.isArray(data) ? data : (data ? [data] : []);
        return { data: rows.find((row) => isManualGlDatasetVersion(row)) || rows[0] || null, error: null };
    };

    const rpcResult = await lookupViaRpc();
    if (!rpcResult.error) {
        return rpcResult.data || null;
    }

    if (!isMissingColumnError(rpcResult.error, "find_manual_gl_dataset_version_by_hash")) {
        // Fall through to table lookups; the RPC may simply be missing in older deployments.
    }

    for (const column of ["dataset_hash", "content_hash"]) {
        let query = supabase
            .from(TABLES.datasetVersions)
            .select("*")
            .eq("company_id", companyId)
            .eq(column, normalizedHash);

        if (sourceType) {
            query = query.eq("source_type", sourceType);
        }

        if (includeNonFailed) {
            query = query.neq("status", "failed");
        } else if (statusFilter && statusFilter.length > 0) {
            query = query.in("status", statusFilter);
        }

        query = query
            .order("finalized_at", { ascending: false })
            .order("created_at", { ascending: false })
            .limit(20);

        const { data, error } = await query;

        if (error && isMissingColumnError(error, column)) {
            continue;
        }

        if (error && isMissingColumnError(error, "source_type")) {
            let fallbackQuery = supabase
                .from(TABLES.datasetVersions)
                .select("*")
                .eq("company_id", companyId)
                .eq(column, normalizedHash);

            if (includeNonFailed) {
                fallbackQuery = fallbackQuery.neq("status", "failed");
            } else if (statusFilter && statusFilter.length > 0) {
                fallbackQuery = fallbackQuery.in("status", statusFilter);
            }

            const { data: fallbackData, error: fallbackError } = await fallbackQuery
                .order("finalized_at", { ascending: false })
                .order("created_at", { ascending: false })
                .limit(20);

            if (fallbackError) {
                if (isMissingColumnError(fallbackError, column)) continue;
                throw new Error(`Failed to query dataset version by hash: ${fallbackError.message}`);
            }

            const fallbackRows = Array.isArray(fallbackData) ? fallbackData : (fallbackData ? [fallbackData] : []);
            const fallbackMatch = fallbackRows.find((row) => isManualGlDatasetVersion(row)) || fallbackRows[0] || null;
            if (fallbackMatch) return fallbackMatch;
            continue;
        }

        if (error && error.code !== "PGRST116") {
            throw new Error(`Failed to query dataset version by hash: ${error.message}`);
        }

        const rows = Array.isArray(data) ? data : (data ? [data] : []);
        const matched = rows.find((row) => isManualGlDatasetVersion(row)) || rows[0] || null;
        if (matched) return matched;
    }

    return null;
}

/**
 * Update a dataset version's status and optional metadata.
 */
async function updateDatasetVersion(versionId, updates = {}) {
    if (!versionId) throw new Error("versionId is required.");

    const patch = {};
    if (updates.status) patch.status = updates.status;
    if (updates.batchId) patch.batch_id = updates.batchId;
    if (updates.metadata && typeof updates.metadata === "object" && Object.keys(updates.metadata).length > 0) {
        patch.metadata = updates.metadata;
    }
    if (updates.finalizedAt) patch.finalized_at = updates.finalizedAt;
    if (updates.rolledBackAt) patch.rolled_back_at = updates.rolledBackAt;

    if (Object.keys(patch).length === 0) return null;

    const { data, error } = await supabase
        .from(TABLES.datasetVersions)
        .update(patch)
        .eq("id", versionId)
        .select()
        .single();

    if (error) throw new Error(`Failed to update dataset version ${versionId}: ${error.message}`);
    return data;
}

/**
 * Atomically activate a dataset version using the Supabase RPC function.
 * This deactivates all other versions for the company and activates the target.
 */
async function activateDatasetVersion(companyId, versionId) {
    if (!companyId || !versionId) {
        throw new Error("Both companyId and versionId are required for activation.");
    }

    // Try RPC first (atomic, transactional)
    const { data: rpcResult, error: rpcError } = await supabase
        .rpc("activate_dataset_version", {
            p_company_id: companyId,
            p_version_id: versionId,
        });

    if (rpcError) {
        // Fallback: sequential updates with guard
        console.warn("[DatasetVersion] RPC activation fallback:", rpcError.message);
        return await _fallbackActivation(companyId, versionId);
    }

    const activated = Array.isArray(rpcResult) ? rpcResult[0] : rpcResult;
    console.log(
        `[DatasetVersion] Activated v${activated?.version_number} for company ${companyId}`
    );
    return activated;
}

/**
 * Fallback activation when RPC is not available.
 * Performs sequential updates with a verification guard.
 */
async function _fallbackActivation(companyId, versionId) {
    // Step 1: Deactivate all active versions for this company
    const { error: deactivateError } = await supabase
        .from(TABLES.datasetVersions)
        .update({ is_active: false })
        .eq("company_id", companyId)
        .eq("is_active", true);

    if (deactivateError) {
        throw new Error(`Failed to deactivate versions: ${deactivateError.message}`);
    }

    // Step 2: Activate the target version
    const { data: activated, error: activateError } = await supabase
        .from(TABLES.datasetVersions)
        .update({
            is_active: true,
            status: DATASET_VERSION_STATUS.FINALIZED,
            finalized_at: new Date().toISOString(),
        })
        .eq("id", versionId)
        .eq("company_id", companyId)
        .select()
        .single();

    if (activateError) {
        throw new Error(`Failed to activate version ${versionId}: ${activateError.message}`);
    }

    // Step 3: Verify exactly one active version
    const { count } = await supabase
        .from(TABLES.datasetVersions)
        .select("id", { count: "exact", head: true })
        .eq("company_id", companyId)
        .eq("is_active", true);

    if (count !== 1) {
        console.error(
            `[DatasetVersion] INVARIANT VIOLATION: ${count} active versions for company ${companyId}. Forcing correction.`
        );
        // Force-clear everything except the target
        await supabase
            .from(TABLES.datasetVersions)
            .update({ is_active: false })
            .eq("company_id", companyId)
            .neq("id", versionId);
    }

    console.log(
        `[DatasetVersion] Activated v${activated.version_number} for company ${companyId} (fallback)`
    );
    return activated;
}

/**
 * Get the currently active dataset version for a company.
 * Returns null if no active version exists (e.g., first upload not yet done).
 */
async function getActiveDatasetVersion(companyId) {
    if (!companyId) return null;

    const { data, error } = await supabase
        .from(TABLES.datasetVersions)
        .select("*")
        .eq("company_id", companyId)
        .eq("is_active", true)
        .limit(1)
        .maybeSingle();

    if (error) {
        console.warn("[DatasetVersion] Error fetching active version:", error.message);
        return null;
    }
    return data || null;
}

/**
 * Get a dataset version by ID.
 */
async function getDatasetVersion(versionId) {
    if (!versionId) return null;

    const { data, error } = await supabase
        .from(TABLES.datasetVersions)
        .select("*")
        .eq("id", versionId)
        .single();

    if (error && error.code !== "PGRST116") {
        throw new Error(`Failed to fetch dataset version: ${error.message}`);
    }
    return data || null;
}

/**
 * List all dataset versions for a company, most recent first.
 */
async function listDatasetVersions(companyId, limit = 50, options = {}) {
    if (!companyId) throw new Error("companyId is required.");

    const normalizedLimit = Math.min(Math.max(Number(limit || 50) || 50, 1), 200);
    const sourceType = normalizeText(options.sourceType || "", "").toLowerCase();
    const statuses = Array.isArray(options.statuses)
        ? Array.from(
            new Set(
                options.statuses
                    .map((status) => normalizeText(status, "").toLowerCase())
                    .filter(Boolean),
            ),
        )
        : [];
    const includeSourceTypeNull = options.includeSourceTypeNull !== false;

    const buildQuery = (applySourceFilter = true) => {
        let query = supabase
            .from(TABLES.datasetVersions)
            .select("*")
            .eq("company_id", companyId);

        if (applySourceFilter && sourceType) {
            if (includeSourceTypeNull) {
                query = query.or(`source_type.eq.${sourceType},source_type.is.null`);
            } else {
                query = query.eq("source_type", sourceType);
            }
        }

        if (statuses.length > 0) {
            query = query.in("status", statuses);
        }

        return query
            .order("version_number", { ascending: false })
            .order("created_at", { ascending: false })
            .limit(normalizedLimit);
    };

    let { data, error } = await buildQuery(true);

    if (error && sourceType && isMissingColumnError(error, "source_type")) {
        ({ data, error } = await buildQuery(false));
    }

    if (error) throw new Error(`Failed to list dataset versions: ${error.message}`);

    let rows = Array.isArray(data) ? data : (data ? [data] : []);
    if (sourceType === MANUAL_GL_SOURCE_TYPE) {
        rows = rows.filter((row) => isManualGlDatasetVersion(row));
    }

    return rows;
}

/**
 * Mark a dataset version as failed. Does NOT touch the active version.
 */
async function failDatasetVersion(versionId, errorMessage = "") {
    if (!versionId) return null;

    const { data, error } = await supabase
        .from(TABLES.datasetVersions)
        .update({
            status: DATASET_VERSION_STATUS.FAILED,
            metadata: { error: errorMessage || "Unknown failure" },
        })
        .eq("id", versionId)
        .select()
        .single();

    if (error) {
        console.error(`[DatasetVersion] Failed to mark version as failed: ${error.message}`);
        return null;
    }

    console.log(`[DatasetVersion] Marked version ${versionId} as FAILED`);
    return data;
}

/**
 * Rollback: re-activate a previous version.
 * The currently active version is deactivated, and the target version is re-activated.
 */
async function rollbackToVersion(companyId, targetVersionId) {
    if (!companyId || !targetVersionId) {
        throw new Error("Both companyId and targetVersionId are required for rollback.");
    }

    // Verify the target version exists and belongs to this company
    const target = await getDatasetVersion(targetVersionId);
    if (!target || target.company_id !== companyId) {
        throw new Error(`Version ${targetVersionId} not found for company ${companyId}.`);
    }

    if (target.status === DATASET_VERSION_STATUS.FAILED) {
        throw new Error("Cannot rollback to a failed version.");
    }

    // Activate the target (deactivates current)
    const activated = await activateDatasetVersion(companyId, targetVersionId);

    console.log(
        `[DatasetVersion] Rolled back company ${companyId} to version v${activated.version_number}`
    );
    return activated;
}

// ─── Validation Errors ────────────────────────────────────────────────────────

/**
 * Insert one or more validation errors.
 */
async function insertValidationErrors(companyId, errors = [], uploadJobId = null, datasetVersionId = null) {
    if (!companyId || !errors.length) return [];

    const rows = errors.map((err) => ({
        company_id: companyId,
        upload_job_id: uploadJobId || null,
        dataset_version_id: datasetVersionId || null,
        error_type: err.type || "validation",
        error_message: err.message || "Unknown error",
        row_number: err.rowNumber || null,
        column_name: err.column || null,
        raw_value: err.rawValue ? String(err.rawValue).slice(0, 500) : null,
    }));

    const { data, error } = await supabase
        .from(TABLES.validationErrors)
        .insert(rows)
        .select();

    if (error) {
        console.error(`[DatasetVersion] Failed to insert validation errors: ${error.message}`);
        return [];
    }
    return data || [];
}

/**
 * Get validation errors for a specific upload job or dataset version.
 */
async function getValidationErrors({ uploadJobId, datasetVersionId, companyId, limit = 100 } = {}) {
    let query = supabase
        .from(TABLES.validationErrors)
        .select("*")
        .order("created_at", { ascending: true })
        .limit(limit);

    if (companyId) query = query.eq("company_id", companyId);
    if (uploadJobId) query = query.eq("upload_job_id", uploadJobId);
    if (datasetVersionId) query = query.eq("dataset_version_id", datasetVersionId);

    const { data, error } = await query;
    if (error) throw new Error(`Failed to fetch validation errors: ${error.message}`);
    return data || [];
}

// ─── Orchestration Helpers ────────────────────────────────────────────────────

/**
 * Start a full upload job + dataset version lifecycle.
 * Returns { job, version } ready for the caller to proceed with parsing/staging.
 *
 * Usage in stageMultiYearGlUpload:
 *   const { job, version } = await startUploadLifecycle(companyId, "file.xlsx", userId);
 *   // ... parse, validate, insert rows with version.id as dataset_version_id ...
 *   await finalizeUploadLifecycle(job.id, version.id, companyId);
 */
async function startUploadLifecycle(companyId, uploadSource = "", createdBy = null) {
    const job = await createUploadJob(companyId, uploadSource, createdBy);
    const version = await createDatasetVersion(companyId, job.id, uploadSource);

    console.log(
        `[DatasetVersion] Started upload lifecycle: job=${job.id}, version=v${version.version_number}`
    );
    return { job, version };
}

/**
 * Successfully finalize an upload lifecycle.
 * Marks the version as finalized → activates it → marks the job as completed.
 */
async function finalizeUploadLifecycle(jobId, versionId, companyId, batchId = null) {
    // Link batch to version if provided
    if (batchId) {
        await updateDatasetVersion(versionId, { batchId });
    }

    // Activate the new snapshot (atomic swap)
    const activated = await activateDatasetVersion(companyId, versionId);

    // Back-link the batch row to the now-known integer version number so that
    // snapshot lookups by dataset_version integer (getSnapshotForDatasetVersion)
    // can find the correct row after activation.
    if (batchId && activated?.version_number) {
        const { error: batchLinkError } = await supabase
            .from("manual_gl_batches")
            .update({
                dataset_version_id: versionId,
                dataset_version: activated.version_number,
            })
            .eq("id", batchId)
            .eq("company_id", companyId);

        if (batchLinkError) {
            console.warn(
                `[DatasetVersion] Failed to back-link batch ${batchId} to version v${activated.version_number}: ${batchLinkError.message}`
            );
        } else {
            console.log(
                `[DatasetVersion] Back-linked batch ${batchId} to version v${activated.version_number}`
            );
        }
    }

    // Mark job as completed
    await updateUploadJob(jobId, {
        status: UPLOAD_JOB_STATUS.COMPLETED,
        progress: { stage: "completed", pct: 100 },
    });

    console.log(
        `[DatasetVersion] Finalized lifecycle: job=${jobId}, version=v${activated.version_number}, active=true`
    );
    return activated;
}

/**
 * Fail an upload lifecycle.
 * Marks both the version and job as failed. Does NOT touch the active version.
 */
async function failUploadLifecycle(jobId, versionId, errorMessage = "") {
    if (versionId) {
        await failDatasetVersion(versionId, errorMessage);
    }

    if (jobId) {
        await updateUploadJob(jobId, {
            status: UPLOAD_JOB_STATUS.FAILED,
            error: errorMessage,
            progress: { stage: "failed", pct: 0 },
        });
    }

    console.log(
        `[DatasetVersion] Failed lifecycle: job=${jobId}, version=${versionId}, error=${errorMessage}`
    );
}

// ─── Backward Compatibility ───────────────────────────────────────────────────

/**
 * For companies that have staged data but no dataset versions yet (pre-migration data):
 * Creates a "legacy" version pointing to existing batches and marks it active.
 * This ensures reports continue working after the migration.
 *
 * Should be called lazily the first time a report is requested for a company
 * that has staged data but no active dataset version.
 */
async function ensureLegacyDatasetVersion(companyId) {
    // Check if any version already exists
    const existing = await getActiveDatasetVersion(companyId);
    if (existing) return existing;

    // Check if any staged data exists at all
    const { count, error: countError } = await supabase
        .from("manual_gl_staged_transactions")
        .select("id", { count: "exact", head: true })
        .eq("company_id", companyId);

    if (countError || !count || count === 0) return null;

    // Create a legacy version
    const version = await createDatasetVersion(companyId, null, "legacy_migration");

    // Mark as finalized and active
    const activated = await activateDatasetVersion(companyId, version.id);

    console.log(
        `[DatasetVersion] Created legacy version v${activated.version_number} for company ${companyId} ` +
        `(covering ${count} pre-existing staged transactions)`
    );

    return activated;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    // Constants
    UPLOAD_JOB_STATUS,
    DATASET_VERSION_STATUS,

    // Upload jobs
    createUploadJob,
    updateUploadJob,
    getUploadJob,
    listUploadJobs,

    // Dataset versions
    createDatasetVersion,
    updateDatasetVersion,
    activateDatasetVersion,
    getActiveDatasetVersion,
    getDatasetVersion,
    listDatasetVersions,
    findExistingDatasetVersionByHash,
    failDatasetVersion,
    rollbackToVersion,

    // Validation errors
    insertValidationErrors,
    getValidationErrors,

    // Orchestration
    startUploadLifecycle,
    finalizeUploadLifecycle,
    failUploadLifecycle,

    // Backward compatibility
    ensureLegacyDatasetVersion,
};
