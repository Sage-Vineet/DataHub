const reportCache = require("./reportCache");
const {
  stageMultiYearGlUpload,
  validateBatchBalanceSheet,
} = require("./manualGlMultiYearService");
const {
  activateUploadBatch,
  computeUploadChecksum,
  findActiveBatchByChecksum,
  getUploadBatchById,
  patchUploadBatch,
  setUploadChecksum,
} = require("./manualGlActiveBatchService");
const {
  REPORT_SOURCE_KEYS,
  updateReportSourceRecord,
} = require("./reportSourceStore");
const {
  replaceActiveUploadSessions,
} = require("./manualGlUploadSessionService");

function mergeObject(base, patch) {
  return {
    ...(base && typeof base === "object" ? base : {}),
    ...(patch && typeof patch === "object" ? patch : {}),
  };
}

async function withTiming(label, fn) {
  const start = Date.now();
  try {
    const result = await fn();
    console.log(`[ManualGL][Perf] ${label}=${Date.now() - start}ms`);
    return result;
  } catch (error) {
    console.log(`[ManualGL][Perf] ${label}=ERROR after ${Date.now() - start}ms: ${error.message}`);
    throw error;
  }
}

function buildUploadSessionActivationPlan(batchMetadata = {}, stagedResult = {}) {
  const candidates = Array.isArray(stagedResult?.uploadSessionVersionPlan)
    ? stagedResult.uploadSessionVersionPlan
    : Array.isArray(batchMetadata?.uploadSessionVersionPlan)
      ? batchMetadata.uploadSessionVersionPlan
      : [];

  return candidates
    .map((item) => ({
      fiscalYear: Number(item?.fiscalYear || item?.fiscal_year || 0),
      versionNo: Number(item?.versionNo || item?.version_no || 0),
      fileHash: item?.fileHash || item?.file_hash || null,
      dataHash: item?.dataHash || item?.data_hash || null,
      rowCount: Number(item?.rowCount || item?.row_count || 0),
      sourceUploadIds: Array.isArray(item?.sourceUploadIds)
        ? item.sourceUploadIds
        : Array.isArray(item?.source_upload_ids)
          ? item.source_upload_ids
          : [],
      metadata: item?.metadata && typeof item.metadata === "object" ? item.metadata : {},
    }))
    .filter((item) => Number.isInteger(item.fiscalYear) && item.fiscalYear > 0)
    .filter((item) => Number.isInteger(item.versionNo) && item.versionNo > 0)
    .filter((item) => String(item.dataHash || "").trim());
}

function isUpstreamOutageError(error) {
  const message = String(error?.message || "").toLowerCase();
  return (
    message.includes("cloudflare 52") ||
    message.includes("web server is down") ||
    message.includes("supabase upstream unavailable") ||
    message.includes("<!doctype html") ||
    message.includes("<html")
  );
}

async function patchBatchWithMergedMetadata(companyId, batchId, patch = {}, metadataPatch = {}) {
  let currentMetadata = {};
  try {
    const current = await getUploadBatchById(companyId, batchId);
    currentMetadata = current?.metadata || {};
  } catch (error) {
    // Best-effort fallback: during transient DB outages we still attempt to patch
    // using only the incoming metadata patch, instead of failing early on read.
    console.warn("[ManualGL][Orchestrator] Batch metadata prefetch failed:", error.message);
  }

  const nextMetadata = mergeObject(currentMetadata, metadataPatch);
  return patchUploadBatch(batchId, {
    ...patch,
    metadata: nextMetadata,
  });
}

const {
  updateUploadJob,
  UPLOAD_JOB_STATUS,
} = require("./datasetVersionService");

async function orchestrateManualGlUpload({
  companyId,
  glUploadIds = [],
  startingBalanceSheetUploadId = "",
  endingBalanceSheetUploadId = "",
  mapping = {},
  fiscalYearStartMonth = null,
  fiscalYearStartDay = null,
  uploadedBy = null,
  batchName = "",
  uploadJobId = null,
  datasetVersionId = null,
}) {
  if (!companyId) {
    throw new Error("companyId is required for Manual GL orchestration.");
  }

  const trackProgress = async (stage, pct, metadata = {}) => {
    if (uploadJobId) {
      await updateUploadJob(uploadJobId, {
        status: UPLOAD_JOB_STATUS.STAGING,
        progress: { stage, pct },
        metadata: metadata,
      }).catch(err => console.warn("[ManualGL][Orchestrator] Failed to update job progress:", err.message));
    }
  };

  const orchestrationStartedAt = new Date().toISOString();
  const perfStart = Date.now();

  const staged = await withTiming("stage", () => stageMultiYearGlUpload({
    companyId,
    glUploadIds,
    startingBalanceSheetUploadId,
    endingBalanceSheetUploadId,
    mapping,
    fiscalYearStartMonth,
    fiscalYearStartDay,
    uploadedBy,
    batchName,
    useDatasetLifecycle: !datasetVersionId,
    datasetVersionId: datasetVersionId,
    deferLifecycleFinalization: true,
    uploadJobId,
  }));

  if (staged?.alreadyStaged || staged?.blockedAsDuplicate) {
    const reusedBatchId = staged?.activeBatchId || staged?.batchId || null;
    const reusedVersionNumber = Number(staged?.versionNumber || staged?.activeDatasetVersion || 0) || null;
    console.log(
      `[ManualGL][Orchestrator] Existing dataset detected. Reusing dataset version V${reusedVersionNumber || "?"}. ` +
      "Skipping staging and report generation.",
    );
    await trackProgress("duplicate_detected", 100, {
      activeBatchId: reusedBatchId,
      versionNumber: reusedVersionNumber,
      alreadyStaged: true,
    });

    const now = new Date().toISOString();
    updateReportSourceRecord(companyId, REPORT_SOURCE_KEYS.MANUAL_GL, {
      isAvailable: true,
      isConnected: false,
      lastSyncedAt: now,
      metadata: {
        latestBatchId: reusedBatchId,
        latestBatchStatus: "active",
        latestDatasetVersion: reusedVersionNumber,
        uploadChecksum: staged?.datasetHash || null,
        snapshotCount: 0,
        snapshotYears: Array.isArray(staged?.fiscalYears) ? staged.fiscalYears : [],
        alreadyStaged: true,
        reportsReady: true,
      },
    }).catch((error) => {
      console.warn("[ManualGL][Orchestrator] Failed to update report source record:", error.message);
    });

    reportCache.invalidateCompany(companyId);
    return {
      ...staged,
      alreadyStaged: true,
      blockedAsDuplicate: true,
      reportsReady: true,
      activeBatchId: reusedBatchId,
      batchId: reusedBatchId,
      activeDatasetVersion: reusedVersionNumber,
      versionNumber: reusedVersionNumber,
      snapshotsGenerated: 0,
      activated: false,
    };
  }

  if (!staged?.success || !staged?.batchId) {
    return staged;
  }

  const batchId = staged.batchId;
  await trackProgress("checksumming", 20);

  try {
    const checksumInfo = await withTiming("checksum", () => computeUploadChecksum(companyId, batchId));
    const uploadChecksum = checksumInfo?.checksum || null;
    const checksumRowCount = Number(checksumInfo?.rowCount || 0);

    if (uploadChecksum) {
      await withTiming("setChecksum", () => setUploadChecksum(batchId, uploadChecksum, checksumRowCount));
    }

    await trackProgress("duplicate_check", 30);
    const duplicateActiveBatch = uploadChecksum
      ? await withTiming("dupCheck", () => findActiveBatchByChecksum(companyId, uploadChecksum))
      : null;

    if (duplicateActiveBatch?.id && duplicateActiveBatch.id !== batchId) {
      const now = new Date().toISOString();
      await patchBatchWithMergedMetadata(
        companyId,
        batchId,
        {
          batch_status: "duplicate",
          status: "staged",
          is_active: false,
          is_archived: true,
          processing_completed_at: now,
        },
        {
          duplicateOfBatchId: duplicateActiveBatch.id,
          noChangesDetected: true,
          uploadChecksum,
          orchestrationStartedAt,
          orchestrationCompletedAt: now,
        },
      );

      reportCache.invalidateCompany(companyId);
      await trackProgress("duplicate_detected", 100, { activeBatchId: duplicateActiveBatch.id });

      return {
        ...staged,
        noChangesDetected: true,
        message: "No changes detected. Current dataset already active.",
        duplicateOfBatchId: duplicateActiveBatch.id,
        activeBatchId: duplicateActiveBatch.id,
        activeDatasetVersion: duplicateActiveBatch.dataset_version || null,
        uploadChecksum,
        snapshotsGenerated: 0,
        activated: false,
      };
    }

    // Snapshot generation is deferred to after lifecycle finalization (in the worker)
    // so that staging always completes successfully regardless of snapshot duration.
    const snapshotResult = { snapshotCount: 0, years: [], datasetVersion: null, generatedAt: null };

    await trackProgress("validating", 50);
    let validation = staged.validation || null;
    if (!validation) {
      try {
        const validationPayload = await withTiming("bsValidation", () => validateBatchBalanceSheet(companyId, batchId));
        validation = validationPayload?.validation || null;
      } catch (validationError) {
        console.warn("[ManualGL][Orchestrator] Validation check failed:", validationError.message);
      }
    }

    await trackProgress("activating", 90);
    const activated = await withTiming("activate", () => activateUploadBatch(companyId, batchId, uploadedBy || null));
    const uploadSessionPlan = buildUploadSessionActivationPlan(activated?.metadata || {}, staged);
    if (uploadSessionPlan.length > 0) {
      await withTiming("replaceSessions", () => replaceActiveUploadSessions({
        companyId,
        batchId,
        uploadedBy: uploadedBy || null,
        sessions: uploadSessionPlan,
      }));
    }

    const now = new Date().toISOString();
    await trackProgress("finalizing", 95);
    await patchBatchWithMergedMetadata(
      companyId,
      batchId,
      {
        batch_status: "active",
        status: "staged",
        is_active: true,
        is_archived: false,
        processing_completed_at: now,
        activated_at: now,
        activated_by: uploadedBy || null,
      },
      {
        uploadChecksum,
        checksumRowCount,
        snapshotCount: snapshotResult.snapshotCount,
        snapshotYears: snapshotResult.years,
        datasetVersion: activated?.dataset_version || snapshotResult.datasetVersion || null,
        activeSnapshotGeneratedAt: snapshotResult.generatedAt,
        activeUploadSessionFiscalYears: uploadSessionPlan.map((item) => item.fiscalYear),
        orchestrationStartedAt,
        orchestrationCompletedAt: now,
        activatedByOrchestrator: true,
      },
    );

    console.log(`[ManualGL][Perf] orchestration_total=${Date.now() - perfStart}ms batchId=${batchId}`);
    reportCache.invalidateCompany(companyId);

    updateReportSourceRecord(companyId, REPORT_SOURCE_KEYS.MANUAL_GL, {
      isAvailable: true,
      isConnected: false,
      lastSyncedAt: now,
      metadata: {
        latestBatchId: batchId,
        latestBatchStatus: "active",
        latestDatasetVersion: activated?.dataset_version || snapshotResult.datasetVersion || null,
        uploadChecksum,
        snapshotCount: snapshotResult.snapshotCount,
        snapshotYears: snapshotResult.years,
      },
    }).catch((error) => {
      console.warn("[ManualGL][Orchestrator] Failed to update report source record:", error.message);
    });

    await trackProgress("completed", 100);

    return {
      ...staged,
      activeBatchId: activated?.id || batchId,
      activeDatasetVersion: activated?.dataset_version || snapshotResult.datasetVersion || null,
      uploadChecksum,
      snapshotsGenerated: snapshotResult.snapshotCount,
      snapshotYears: snapshotResult.years,
      activated: true,
      validation: validation || staged.validation || null,
    };
  } catch (error) {
    const now = new Date().toISOString();

    if (isUpstreamOutageError(error)) {
      console.warn(
        "[ManualGL][Orchestrator] Upstream unavailable after staging; returning recoverable response.",
      );
      return {
        ...staged,
        success: true,
        activated: false,
        pendingActivation: true,
        retryable: true,
        partialFailure: true,
        message:
          "Upload staged successfully, but activation could not complete because the data service is temporarily unavailable. Please retry activation.",
        orchestrationError: error.message,
      };
    }

    try {
      await patchBatchWithMergedMetadata(
        companyId,
        batchId,
        {
          batch_status: "failed",
          status: "failed",
          is_active: false,
          is_archived: true,
          processing_completed_at: now,
        },
        {
          orchestrationError: error.message,
          orchestrationCompletedAt: now,
          orchestrationStartedAt,
        },
      );
    } catch (patchError) {
      console.warn("[ManualGL][Orchestrator] Failed to mark batch as failed:", patchError.message);
    }

    throw error;
  }
}

module.exports = {
  orchestrateManualGlUpload,
};

