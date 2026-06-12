// Key Reports sync — generate backend financial tables from a version's linked
// files by feeding them through the proven Manual GL staging pipeline.
//
// Contract: generateFinancialTables(version, opts) resolves to
//   { batchId, datasetVersion, summary } | null
// where batchId is the immutable Manual GL upload batch (with version-scoped
// reporting snapshots) that reports read from for this Key Report version.
//
// Design notes:
// - We pass the linked documents' upload_ids straight into the orchestrator;
//   it loads the binaries from the uploads table internally.
// - The Manual GL pipeline is GL+BS driven (P&L is derived from GL classified
//   against the Balance Sheet). P&L / Bank Statement / Tax Return mappings are
//   retained as official-source references for future CIM/QoE workflows but do
//   not feed GL staging in this phase.
// - Sync is idempotent: re-syncing identical files reuses the existing dataset
//   version (the orchestrator dedupes by content checksum). It never deletes
//   other versions (per the version-isolation invariant).

const keyReportService = require("./keyReportService");
const { orchestrateManualGlUpload } = require("./manualGlUploadOrchestrationService");
const {
  createUploadJob,
  finalizeUploadLifecycle,
} = require("./datasetVersionService");
const {
  generateReportingSnapshotsForBatch,
} = require("./manualGlReportingSnapshotService");

const { REPORT_CATEGORIES } = keyReportService;

function uploadIdsFor(grouped, category) {
  return (grouped[category] || []).map((m) => m.uploadId).filter(Boolean);
}

async function generateFinancialTables(version, opts = {}) {
  const { userId = null } = opts;
  const companyId = version.companyId;
  const grouped = await keyReportService.getMappingsByCategory(version.id);

  const glUploadIds = uploadIdsFor(grouped, REPORT_CATEGORIES.GENERAL_LEDGER);
  const bsUploadIds = uploadIdsFor(grouped, REPORT_CATEGORIES.BALANCE_SHEET);

  // No GL files → nothing to generate (warnings-only phase; do not block).
  if (!glUploadIds.length) {
    return {
      batchId: version.resolvedBatchId || null,
      datasetVersion: version.resolvedDatasetVersion || null,
      summary: { generated: false, reason: "No General Ledger files linked." },
    };
  }

  // Map linked BS files to the orchestrator's starting/ending slots.
  // 0 → none; 1 → ending; 2+ → first=starting, last=ending.
  let startingBalanceSheetUploadId = "";
  let endingBalanceSheetUploadId = "";
  if (bsUploadIds.length === 1) {
    endingBalanceSheetUploadId = bsUploadIds[0];
  } else if (bsUploadIds.length >= 2) {
    startingBalanceSheetUploadId = bsUploadIds[0];
    endingBalanceSheetUploadId = bsUploadIds[bsUploadIds.length - 1];
  }

  const job = await createUploadJob(
    companyId,
    `Key Report ${version.versionName || `V${version.versionNumber}`}`,
    userId
  );

  const result = await orchestrateManualGlUpload({
    companyId,
    glUploadIds,
    startingBalanceSheetUploadId,
    endingBalanceSheetUploadId,
    mapping: {}, // GL column mapping auto-detected per file
    uploadedBy: userId,
    batchName: `Key Report ${version.versionName || `V${version.versionNumber}`}`,
    uploadJobId: job.id,
  });

  if (result?.success === false && !result?.alreadyStaged) {
    throw new Error(result?.message || "Financial table generation failed during staging.");
  }

  const batchId = result?.activeBatchId || result?.batchId || null;
  const datasetVersion = result?.activeDatasetVersion || result?.versionNumber || null;

  // Finalize lifecycle + generate version-scoped reporting snapshots (synchronously,
  // so the Key Report version's resolved_batch_id is accurate when sync returns).
  if (!result?.alreadyStaged && batchId) {
    await finalizeUploadLifecycle(job.id, result?.datasetVersionId || null, companyId, batchId);
    try {
      const snap = await generateReportingSnapshotsForBatch(companyId, batchId, {
        datasetVersionId: result?.datasetVersionId || null,
      });
      return {
        batchId,
        datasetVersion,
        summary: {
          generated: true,
          insertedTransactions: result?.insertedTransactions || 0,
          snapshotCount: snap?.snapshotCount || 0,
          years: snap?.years || [],
          glFiles: glUploadIds.length,
          bsFiles: bsUploadIds.length,
        },
      };
    } catch (snapErr) {
      // Snapshots are the fast path; staging still succeeded. Surface as a warning
      // via summary rather than failing the whole sync.
      return {
        batchId,
        datasetVersion,
        summary: {
          generated: true,
          snapshotWarning: snapErr.message,
          glFiles: glUploadIds.length,
          bsFiles: bsUploadIds.length,
        },
      };
    }
  }

  // Reused an existing identical dataset version.
  return {
    batchId,
    datasetVersion,
    summary: {
      generated: true,
      reused: Boolean(result?.alreadyStaged),
      glFiles: glUploadIds.length,
      bsFiles: bsUploadIds.length,
    },
  };
}

module.exports = { generateFinancialTables };
