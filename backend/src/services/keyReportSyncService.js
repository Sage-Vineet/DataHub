const keyReportService = require("./keyReportService");
const { orchestrateManualGlUpload } = require("./manualGlUploadOrchestrationService");
const { processDocumentMapping } = require("./manualReportUploadService");
const {
  createUploadJob,
  finalizeUploadLifecycle,
} = require("./datasetVersionService");
const {
  generateReportingSnapshotsForBatch,
} = require("./manualGlReportingSnapshotService");
const { generateChartOfAccounts } = require("./chartOfAccountsService");

const { REPORT_CATEGORIES } = keyReportService;

function uploadIdsFor(grouped, category) {
  return (grouped[category] || []).map((m) => m.uploadId).filter(Boolean);
}

async function generateFinancialTables(version, opts = {}) {
  const { userId = null } = opts;
  const companyId = version.companyId;

  // ── Document-driven Extraction ─────────────────────────────────────────────
  // We ensure all linked documents (P&L, BS, Bank Statements, Tax Returns) are
  // extracted into structured data in qb_synced_reports. This allows the 
  // Reports, Bank Recon, and Tax Recon pages to render data immediately.
  const allMappings = await keyReportService.listMappings(version.id);
  const extractionMappings = allMappings.filter(m => m.reportCategory !== REPORT_CATEGORIES.GENERAL_LEDGER);

  if (extractionMappings.length > 0) {
    console.log(`[KeyReportSync] Extracting ${extractionMappings.length} document(s) for Version ${version.id}`);
    const results = await Promise.allSettled(
      extractionMappings.map(m => processDocumentMapping(companyId, m.documentId, m.reportCategory))
    );

    // Log failures as warnings; we don't want to block the whole sync if one PDF fails.
    results.forEach((res, i) => {
      if (res.status === "rejected") {
        console.warn(`[KeyReportSync] Extraction failed for ${extractionMappings[i].reportCategory} (${extractionMappings[i].documentId}):`, res.reason);
      }
    });
  }

  const grouped = await keyReportService.getMappingsByCategory(version.id);
  const glUploadIds = uploadIdsFor(grouped, REPORT_CATEGORIES.GENERAL_LEDGER);
  const bsUploadIds = uploadIdsFor(grouped, REPORT_CATEGORIES.BALANCE_SHEET);

  // If no GL is provided, we clear the Manual GL staging pointer.
  if (!glUploadIds.length) {
    return {
      batchId: null,
      datasetVersion: null,
      summary: {
        generated: false,
        extractedDocs: extractionMappings.length,
        message: extractionMappings.length > 0
          ? `Version synced. Extracted ${extractionMappings.length} linked document(s). Note: No General Ledger files were linked.`
          : "Version synced. Note: No supported documents were linked."
      },
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
    keyReportVersionId: version.id, // Strict isolation — bypasses global dedupe
  });

  if (result?.success === false) {
    throw new Error(result?.message || "Financial table generation failed during staging.");
  }

  const batchId = result?.activeBatchId || result?.batchId || null;
  const datasetVersion = result?.activeDatasetVersion || result?.versionNumber || null;

  // ── Chart of Accounts ──────────────────────────────────────────────────────
  // Build the version's COA hierarchy from the staged GL/BS data. COA reads the
  // staged transactions directly (independent of snapshots), so it runs for both
  // the freshly-staged and the reused-dataset paths. Non-fatal: a COA failure
  // surfaces as a warning rather than failing the whole sync.
  let coaSummary = null;
  if (batchId) {
    try {
      coaSummary = await generateChartOfAccounts(companyId, version.id, batchId);
    } catch (coaErr) {
      console.warn(`[KeyReportSync] Chart of Accounts generation failed for Version ${version.id}:`, coaErr.message);
      coaSummary = { error: coaErr.message };
    }
  }

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
          chartOfAccounts: coaSummary,
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
          chartOfAccounts: coaSummary,
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
      chartOfAccounts: coaSummary,
    },
  };
}

module.exports = { generateFinancialTables };
