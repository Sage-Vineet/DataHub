// Key Reports — the official, user-curated source of truth for financial data.
//
// A company has one or more KEY REPORT VERSIONS. Each version maps report
// categories (P&L, Balance Sheet, GL, Bank Statements, Tax Returns) to one or
// more Data Room documents that the USER explicitly selects (never auto-detected).
// Exactly one version per company can be ACTIVE (the official source). Activating
// a version is decoupled from the Manual GL "latest upload" auto-activation, so
// uploading a new file never silently changes the official report source.
//
// Linking a document also registers a file_reference so the file is protected
// from deletion while it is in use (see fileReferenceService).

const { supabase } = require("../db");
const fileReferenceService = require("./fileReferenceService");
const documentService = require("./documentService");

// Extensible by design — categories are plain strings, no DB enum.
const REPORT_CATEGORIES = {
  PROFIT_LOSS: "profit_loss",
  BALANCE_SHEET: "balance_sheet",
  GENERAL_LEDGER: "general_ledger",
  BANK_STATEMENT: "bank_statement",
  TAX_RETURN: "tax_return",
};
const VALID_CATEGORIES = new Set(Object.values(REPORT_CATEGORIES));

function normalizeVersion(row) {
  if (!row) return null;
  return {
    id: row.id,
    companyId: row.company_id,
    versionNumber: row.version_number,
    versionName: row.version_name,
    status: row.status,
    isActive: Boolean(row.is_active),
    resolvedBatchId: row.resolved_batch_id || null,
    resolvedDatasetVersion: row.resolved_dataset_version || null,
    lastSyncedAt: row.last_synced_at || null,
    metadata: row.metadata || {},
    createdBy: row.created_by || null,
    updatedBy: row.updated_by || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeMapping(row) {
  if (!row) return null;
  return {
    id: row.id,
    versionId: row.version_id,
    companyId: row.company_id,
    reportCategory: row.report_category,
    documentId: row.document_id || null,
    uploadId: row.upload_id || null,
    fileName: row.file_name || null,
    linkedBy: row.linked_by || null,
    metadata: row.metadata || {},
    createdAt: row.created_at,
  };
}

// ---- Versions --------------------------------------------------------------

async function listVersions(companyId) {
  if (!companyId) return [];
  const { data, error } = await supabase
    .from("key_report_versions")
    .select("*")
    .eq("company_id", companyId)
    .order("version_number", { ascending: false });
  if (error) throw error;
  return (data || []).map(normalizeVersion);
}

async function getVersion(versionId) {
  if (!versionId) return null;
  const { data, error } = await supabase
    .from("key_report_versions")
    .select("*")
    .eq("id", versionId)
    .maybeSingle();
  if (error) throw error;
  return normalizeVersion(data);
}

async function getActiveVersion(companyId) {
  if (!companyId) return null;
  const { data, error } = await supabase
    .from("key_report_versions")
    .select("*")
    .eq("company_id", companyId)
    .eq("is_active", true)
    .maybeSingle();
  if (error) throw error;
  return normalizeVersion(data);
}

async function nextVersionNumber(companyId) {
  const { data, error } = await supabase
    .from("key_report_versions")
    .select("version_number")
    .eq("company_id", companyId)
    .order("version_number", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data?.version_number || 0) + 1;
}

// Create a new version. If copyFromVersionId is supplied (or a prior version
// exists), its file mappings are copied as a starting point — the user can edit
// before syncing. The new version is NOT auto-activated (must be synced first).
async function createVersion(companyId, { versionName, copyFromVersionId } = {}, userId = null) {
  if (!companyId) throw new Error("companyId is required.");
  const versionNumber = await nextVersionNumber(companyId);

  const { data, error } = await supabase
    .from("key_report_versions")
    .insert({
      company_id: companyId,
      version_number: versionNumber,
      version_name: versionName || `Version ${versionNumber}`,
      status: "draft",
      is_active: false,
      created_by: userId,
      updated_by: userId,
    })
    .select("*")
    .single();
  if (error) throw error;
  const version = normalizeVersion(data);

  // Seed mappings from a prior version (explicit, or the most recent other one).
  let sourceVersionId = copyFromVersionId || null;
  if (!sourceVersionId) {
    const others = (await listVersions(companyId)).filter((v) => v.id !== version.id);
    if (others.length) sourceVersionId = others[0].id; // newest-first
  }
  if (sourceVersionId) {
    const priorMappings = await listMappings(sourceVersionId);
    for (const m of priorMappings) {
      await addMapping(
        version.id,
        { reportCategory: m.reportCategory, documentId: m.documentId },
        userId
      );
    }
  }

  return getVersion(version.id);
}

async function updateVersion(versionId, { versionName, status } = {}, userId = null) {
  const patch = { updated_at: new Date().toISOString(), updated_by: userId };
  if (versionName !== undefined) patch.version_name = versionName;
  if (status !== undefined) patch.status = status;
  const { data, error } = await supabase
    .from("key_report_versions")
    .update(patch)
    .eq("id", versionId)
    .select("*")
    .single();
  if (error) throw error;
  return normalizeVersion(data);
}

async function duplicateVersion(versionId, { versionName } = {}, userId = null) {
  const source = await getVersion(versionId);
  if (!source) throw new Error("Source version not found.");
  return createVersion(
    source.companyId,
    { versionName: versionName || `${source.versionName} (copy)`, copyFromVersionId: versionId },
    userId
  );
}

// Make a version the single official/active version for its company.
async function switchActiveVersion(companyId, versionId, userId = null) {
  if (!companyId || !versionId) throw new Error("companyId and versionId required.");
  // Deactivate all, then activate the target (partial-unique index allows only one).
  const { error: deErr } = await supabase
    .from("key_report_versions")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("company_id", companyId)
    .eq("is_active", true);
  if (deErr) throw deErr;

  const { data, error } = await supabase
    .from("key_report_versions")
    .update({ is_active: true, updated_at: new Date().toISOString(), updated_by: userId })
    .eq("id", versionId)
    .eq("company_id", companyId)
    .select("*")
    .single();
  if (error) throw error;
  return normalizeVersion(data);
}

async function deleteVersion(versionId) {
  // Remove file-reference links owned by this version, then the version
  // (mappings + sync logs cascade via FK).
  await fileReferenceService.unlinkByEntity({ linkedEntityId: versionId });
  const { error } = await supabase.from("key_report_versions").delete().eq("id", versionId);
  if (error) throw error;
  return true;
}

// ---- Mappings --------------------------------------------------------------

async function listMappings(versionId) {
  if (!versionId) return [];
  const { data, error } = await supabase
    .from("key_report_file_mappings")
    .select("*")
    .eq("version_id", versionId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data || []).map(normalizeMapping);
}

// Mappings grouped by category, for the UI.
async function getMappingsByCategory(versionId) {
  const mappings = await listMappings(versionId);
  const grouped = {};
  for (const key of VALID_CATEGORIES) grouped[key] = [];
  for (const m of mappings) {
    if (!grouped[m.reportCategory]) grouped[m.reportCategory] = [];
    grouped[m.reportCategory].push(m);
  }
  return grouped;
}

// Link a Data Room document to a category in this version. Registers a
// file_reference so the document is protected from deletion. Idempotent.
async function addMapping(versionId, { reportCategory, documentId }, userId = null) {
  if (!versionId) throw new Error("versionId is required.");
  if (!VALID_CATEGORIES.has(reportCategory)) {
    const err = new Error(`Invalid report category: ${reportCategory}`);
    err.status = 400;
    throw err;
  }
  if (!documentId) throw new Error("documentId is required.");

  const version = await getVersion(versionId);
  if (!version) throw new Error("Version not found.");

  const document = await documentService.getDocumentById(documentId);
  if (!document) {
    const err = new Error("Document not found in the Data Room.");
    err.status = 404;
    throw err;
  }

  const { data, error } = await supabase
    .from("key_report_file_mappings")
    .upsert(
      {
        version_id: versionId,
        company_id: version.companyId,
        report_category: reportCategory,
        document_id: documentId,
        upload_id: document.upload_id || null,
        file_name: document.name || null,
        linked_by: userId,
      },
      { onConflict: "version_id,report_category,document_id" }
    )
    .select("*")
    .single();
  if (error) throw error;

  // Protect the linked file from deletion.
  await fileReferenceService.linkDocument({
    companyId: version.companyId,
    documentId,
    linkedEntityId: versionId,
    createdBy: userId,
    metadata: { reportCategory },
  });

  return normalizeMapping(data);
}

// Unlink one mapping. The file_reference is removed only if no OTHER mapping in
// the same version still references the same document.
async function removeMapping(mappingId) {
  const { data: row, error: findErr } = await supabase
    .from("key_report_file_mappings")
    .select("*")
    .eq("id", mappingId)
    .maybeSingle();
  if (findErr) throw findErr;
  if (!row) return false;

  const { error } = await supabase
    .from("key_report_file_mappings")
    .delete()
    .eq("id", mappingId);
  if (error) throw error;

  if (row.document_id) {
    const { data: remaining } = await supabase
      .from("key_report_file_mappings")
      .select("id")
      .eq("version_id", row.version_id)
      .eq("document_id", row.document_id)
      .limit(1);
    if (!remaining || !remaining.length) {
      await fileReferenceService.unlinkDocument({
        documentId: row.document_id,
        linkedEntityId: row.version_id,
      });
    }
  }
  return true;
}

// ---- Sync ------------------------------------------------------------------

// Validate that all linked documents still exist. Returns warnings only
// (current phase does not block on missing categories).
async function validateVersion(versionId) {
  const grouped = await getMappingsByCategory(versionId);
  const warnings = [];
  const missingFiles = [];

  for (const key of VALID_CATEGORIES) {
    const items = grouped[key] || [];
    if (!items.length) {
      warnings.push({ type: "category_empty", category: key });
      continue;
    }
    for (const m of items) {
      if (!m.documentId) continue;
      const doc = await documentService.getDocumentById(m.documentId);
      if (!doc) {
        missingFiles.push({ mappingId: m.id, category: key, fileName: m.fileName });
        warnings.push({ type: "file_missing", category: key, fileName: m.fileName });
      }
    }
  }
  return { warnings, missingFiles };
}

// Sync: persist mappings (already persisted), validate, generate backend
// financial tables, and update sync status. Idempotent + re-syncable.
// Table generation is delegated to keyReportSyncService (Step 5).
async function syncVersion(versionId, userId = null) {
  const version = await getVersion(versionId);
  if (!version) throw new Error("Version not found.");

  const { data: logRow, error: logErr } = await supabase
    .from("key_report_sync_logs")
    .insert({
      version_id: versionId,
      company_id: version.companyId,
      sync_status: "started",
      created_by: userId,
    })
    .select("*")
    .single();
  if (logErr) throw logErr;
  const logId = logRow.id;

  try {
    const validation = await validateVersion(versionId);

    // Generate backend financial tables from the linked files (Step 5).
    const keyReportSyncService = require("./keyReportSyncService");
    const result = await keyReportSyncService.generateFinancialTables(version, { userId });

    await supabase
      .from("key_report_versions")
      .update({
        status: "synced",
        last_synced_at: new Date().toISOString(),
        resolved_batch_id: result?.batchId || version.resolvedBatchId || null,
        resolved_dataset_version: result?.datasetVersion ?? version.resolvedDatasetVersion ?? null,
        updated_at: new Date().toISOString(),
        updated_by: userId,
      })
      .eq("id", versionId);

    await supabase
      .from("key_report_sync_logs")
      .update({
        sync_status: "success",
        sync_completed_at: new Date().toISOString(),
        metadata: { warnings: validation.warnings, result: result?.summary || null },
      })
      .eq("id", logId);

    return {
      success: true,
      version: await getVersion(versionId),
      warnings: validation.warnings,
      result,
    };
  } catch (err) {
    await supabase
      .from("key_report_sync_logs")
      .update({
        sync_status: "failed",
        sync_completed_at: new Date().toISOString(),
        error_message: err.message || String(err),
      })
      .eq("id", logId);
    throw err;
  }
}

async function listSyncLogs(versionId, limit = 20) {
  if (!versionId) return [];
  const { data, error } = await supabase
    .from("key_report_sync_logs")
    .select("*")
    .eq("version_id", versionId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

// ---- Source-of-truth pointer (consumed by report read path, Step 6) --------

// Returns the Manual GL batch id pinned by the company's ACTIVE Key Report
// version, or null if no active version / not yet synced. Reports prefer this
// over the auto-activated "latest upload" batch.
async function getActiveResolvedBatch(companyId) {
  const active = await getActiveVersion(companyId);
  if (!active || !active.resolvedBatchId) return null;
  return {
    versionId: active.id,
    batchId: active.resolvedBatchId,
    datasetVersion: active.resolvedDatasetVersion || null,
  };
}

module.exports = {
  REPORT_CATEGORIES,
  VALID_CATEGORIES,
  listVersions,
  getVersion,
  getActiveVersion,
  createVersion,
  updateVersion,
  duplicateVersion,
  switchActiveVersion,
  deleteVersion,
  listMappings,
  getMappingsByCategory,
  addMapping,
  removeMapping,
  validateVersion,
  syncVersion,
  listSyncLogs,
  getActiveResolvedBatch,
};
