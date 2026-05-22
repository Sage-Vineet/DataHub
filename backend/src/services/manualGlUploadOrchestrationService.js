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
  generateReportingSnapshotsForBatch,
} = require("./manualGlReportingSnapshotService");
const {
  REPORT_SOURCE_KEYS,
  updateReportSourceRecord,
} = require("./reportSourceStore");

function mergeObject(base, patch) {
  return {
    ...(base && typeof base === "object" ? base : {}),
    ...(patch && typeof patch === "object" ? patch : {}),
  };
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
}) {
  if (!companyId) {
    throw new Error("companyId is required for Manual GL orchestration.");
  }

  const orchestrationStartedAt = new Date().toISOString();

  const staged = await stageMultiYearGlUpload({
    companyId,
    glUploadIds,
    startingBalanceSheetUploadId,
    endingBalanceSheetUploadId,
    mapping,
    fiscalYearStartMonth,
    fiscalYearStartDay,
    uploadedBy,
    batchName,
    useDatasetLifecycle: false,
    deferLifecycleFinalization: true,
  });

  if (!staged?.success || !staged?.batchId) {
    return staged;
  }

  const batchId = staged.batchId;

  try {
    const checksumInfo = await computeUploadChecksum(companyId, batchId);
    const uploadChecksum = checksumInfo?.checksum || null;
    const checksumRowCount = Number(checksumInfo?.rowCount || 0);

    if (uploadChecksum) {
      await setUploadChecksum(batchId, uploadChecksum, checksumRowCount);
    }

    const duplicateActiveBatch = uploadChecksum
      ? await findActiveBatchByChecksum(companyId, uploadChecksum)
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

    const snapshotResult = await generateReportingSnapshotsForBatch(companyId, batchId);

    let validation = staged.validation || null;
    if (!validation) {
      try {
        const validationPayload = await validateBatchBalanceSheet(companyId, batchId);
        validation = validationPayload?.validation || null;
      } catch (validationError) {
        console.warn("[ManualGL][Orchestrator] Validation check failed:", validationError.message);
      }
    }

    const activated = await activateUploadBatch(companyId, batchId, uploadedBy || null);

    const now = new Date().toISOString();
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
        orchestrationStartedAt,
        orchestrationCompletedAt: now,
        activatedByOrchestrator: true,
      },
    );

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

