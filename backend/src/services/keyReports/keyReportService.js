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

const { supabase } = require("../../db");
const fileReferenceService = require("../fileReferenceService");
const documentService = require("../documentService");
const { normalizeError, isConnectionError } = require("../../utils/dbErrorHandler");
const {
  listValidationResults,
  resolveMappingYear,
} = require("./keyReportValidationService");

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
    year: Number.isInteger(Number(row.year)) ? Number(row.year) : null,
    status: row.status || "linked",
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
  return (data || [])
    .map(normalizeVersion)
    // QA/perf-testing clones are never real client data — exclude them at the
    // source so no consumer (Key Reports page, EBITDA, Reports, etc.) ever
    // has to filter them out client-side.
    .filter((v) => !String(v.versionName || "").toUpperCase().includes("PERF-TEST"));
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
        year: resolveMappingYear({ fileName: document.name || null }),
        status: "linked",
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
// Single-flight guard: prevents a double-clicked "Run AI Processing" (or a
// frontend retry) from launching a second full extraction/report pipeline for
// the same version. Concurrent callers share the in-flight job's result. The
// entry is always cleared in finally, and an in-memory map naturally recovers
// after a process restart, so a crashed job never leaves a permanent lock.
const _inFlightSyncs = new Map();

async function syncVersion(versionId, userId = null, opts = {}) {
  if (_inFlightSyncs.has(versionId)) {
    console.log(`[KeyReports] Sync already in progress for version ${versionId} — reusing in-flight job`);
    return _inFlightSyncs.get(versionId);
  }
  const job = _syncVersionInner(versionId, userId, opts).finally(() => {
    _inFlightSyncs.delete(versionId);
  });
  _inFlightSyncs.set(versionId, job);
  return job;
}

async function _syncVersionInner(versionId, userId = null, opts = {}) {
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

    // Extract all linked files and persist to entry tables. Validation results
    // are written internally by the sync service (from entry table row counts).
    const keyReportSyncService = require("./keyReportSyncService");
    const result = await keyReportSyncService.generateFinancialTables(version, {
      userId,
      uploadJobId: opts.uploadJobId || null,
    });

    // key_report_versions: mark synced. resolved_batch_id/dataset_version are null
    // in the new direct-extraction architecture (no Manual GL batch is created).
    await supabase
      .from("key_report_versions")
      .update({
        status: "synced",
        last_synced_at: new Date().toISOString(),
        resolved_batch_id: null,
        resolved_dataset_version: null,
        updated_at: new Date().toISOString(),
        updated_by: userId,
      })
      .eq("id", versionId);

    await supabase
      .from("key_report_sync_logs")
      .update({
        sync_status: "success",
        sync_completed_at: new Date().toISOString(),
        metadata: {
          warnings: validation.warnings,
          years: result?.years || [],
          extractionResults: result?.extractionResults || null,
          totalRowsInserted: result?.summary?.totalRowsInserted || 0,
        },
      })
      .eq("id", logId);

    // Fetch the validation results persisted by the sync service for the response.
    const validationResults = await listValidationResults(versionId);

    return {
      success: true,
      version: await getVersion(versionId),
      warnings: validation.warnings,
      validationResults,
      result,
    };
  } catch (err) {
    const normalizedError = normalizeError(err);
    if (isConnectionError(normalizedError)) {
      normalizedError.status = 503;
      normalizedError.retryable = true;
    }

    try {
      await supabase
        .from("key_report_sync_logs")
        .update({
          sync_status: "failed",
          sync_completed_at: new Date().toISOString(),
          error_message: normalizedError.message || String(err),
        })
        .eq("id", logId);
    } catch (logUpdateError) {
      console.warn("[KeyReports][Sync] Failed to persist sync error log:", logUpdateError.message);
    }
    throw normalizedError;
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

// Returns the Key Report version pinned to a given Manual GL dataset version
// number (key_report_versions.resolved_dataset_version). Used to resolve the
// SELECTED version's linked documents — not merely the active one — so report
// consumers (Bank / Tax Reconciliation) stay isolated to the chosen version.
async function getVersionByDatasetVersion(companyId, datasetVersion) {
  if (!companyId || datasetVersion == null || datasetVersion === "") return null;
  const dv = Number(datasetVersion);
  if (!Number.isFinite(dv)) return null;
  const { data, error } = await supabase
    .from("key_report_versions")
    .select("*")
    .eq("company_id", companyId)
    .eq("resolved_dataset_version", dv)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return normalizeVersion(data);
}

// Resolves the single Key Report version a consumer should read from, given a
// company and optional selectors. Resolution order (strongest first):
//   1. An explicit Key Report versionId — the UI's chosen Version is the single
//      source of truth (must belong to this company; cross-company ids ignored).
//   2. The version pinned to the selected Manual GL dataset version, else
//   3. The company's ACTIVE version (keeps single-version setups working and
//      avoids blank screens when nothing more specific is supplied).
// Centralised here so getLinkedDocuments and getVersionReportContext share one
// resolution code path and can never diverge.
async function resolveVersionFor(companyId, { datasetVersion, versionId } = {}) {
  if (!companyId) return null;
  if (versionId) {
    const byId = await getVersion(versionId);
    // Guard against cross-company access — the version must belong to this company.
    if (byId && byId.companyId === companyId) return byId;
    console.log(
      `[KeyReports] versionId ${versionId} not found for company ${companyId}; falling back to dataset version / active.`,
    );
  }
  if (datasetVersion != null && datasetVersion !== "") {
    const pinned = await getVersionByDatasetVersion(companyId, datasetVersion);
    if (pinned) return pinned;
    console.log(
      `[KeyReports] No version pinned to dataset version ${datasetVersion} for company ${companyId}; falling back to active version.`,
    );
  }
  return getActiveVersion(companyId);
}

// Loads the Data Room documents linked to a version, grouped by report category.
// Each document is fetched at most once even if linked under several categories.
async function loadDocumentsByCategory(versionId) {
  const byCategory = {};
  for (const key of VALID_CATEGORIES) byCategory[key] = [];

  const mappings = await listMappings(versionId);
  const docCache = new Map();
  for (const mapping of mappings) {
    if (!byCategory[mapping.reportCategory]) byCategory[mapping.reportCategory] = [];
    if (!mapping.documentId) continue;
    let doc;
    if (docCache.has(mapping.documentId)) {
      doc = docCache.get(mapping.documentId);
    } else {
      doc = await documentService.getDocumentById(mapping.documentId);
      docCache.set(mapping.documentId, doc);
    }
    if (doc) byCategory[mapping.reportCategory].push(doc);
  }
  return byCategory;
}

function emptyReportContext() {
  const documents = {};
  for (const key of VALID_CATEGORIES) documents[key] = [];
  return {
    versionId: null,
    datasetVersion: null,
    flowType: null,
    resolvedBatchId: null,
    documents,
    pnlDocument: documents[REPORT_CATEGORIES.PROFIT_LOSS],
    balanceSheet: documents[REPORT_CATEGORIES.BALANCE_SHEET],
    glDocument: documents[REPORT_CATEGORIES.GENERAL_LEDGER],
    bankStatement: documents[REPORT_CATEGORIES.BANK_STATEMENT],
    taxReturn: documents[REPORT_CATEGORIES.TAX_RETURN],
  };
}

// ── CENTRALISED VERSION REPORT CONTEXT ──────────────────────────────────────
// The single resolver every report consumer should use. Given a company and an
// optional SELECTED dataset version, it resolves the one source-of-truth Key
// Report version and returns ALL of its linked documents in one object — so no
// report independently queries uploads / staging / document tables, and Bank,
// Tax and Balance-Sheet reconciliations stay isolated to the chosen version.
//
// `flowType` is DERIVED (not yet persisted, so no schema change is required): a
// version that has produced a Manual GL batch (`resolvedBatchId`) or that has a
// General Ledger document linked is treated as the "manual_gl" flow; otherwise
// "manual_upload". This lets consumers assert flow isolation without a migration.
//
// Report categories support multiple files, so each spec-named field is an
// ARRAY of documents:
//   { versionId, datasetVersion, flowType, resolvedBatchId,
//     documents: { profit_loss, balance_sheet, general_ledger, bank_statement, tax_return },
//     pnlDocument, balanceSheet, glDocument, bankStatement, taxReturn }
async function getVersionReportContext(companyId, { datasetVersion, versionId } = {}) {
  const version = await resolveVersionFor(companyId, { datasetVersion, versionId });
  if (!version) return emptyReportContext();

  const documents = await loadDocumentsByCategory(version.id);
  const glDocs = documents[REPORT_CATEGORIES.GENERAL_LEDGER] || [];
  const flowType = version.resolvedBatchId || glDocs.length ? "manual_gl" : "manual_upload";

  return {
    versionId: version.id,
    datasetVersion: version.resolvedDatasetVersion ?? null,
    flowType,
    resolvedBatchId: version.resolvedBatchId || null,
    documents,
    pnlDocument: documents[REPORT_CATEGORIES.PROFIT_LOSS] || [],
    balanceSheet: documents[REPORT_CATEGORIES.BALANCE_SHEET] || [],
    glDocument: documents[REPORT_CATEGORIES.GENERAL_LEDGER] || [],
    bankStatement: documents[REPORT_CATEGORIES.BANK_STATEMENT] || [],
    taxReturn: documents[REPORT_CATEGORIES.TAX_RETURN] || [],
  };
}

// Returns the linked documents for a SINGLE category — a thin convenience
// wrapper over the centralised getVersionReportContext so there is exactly one
// version-resolution + document-loading code path. Resolved from the SELECTED
// dataset version when supplied, otherwise the company's ACTIVE version.
async function getLinkedDocuments(companyId, reportCategory, { datasetVersion, versionId } = {}) {
  if (!companyId) return { versionId: null, documents: [] };
  const context = await getVersionReportContext(companyId, { datasetVersion, versionId });
  return {
    versionId: context.versionId,
    documents: context.documents[reportCategory] || [],
  };
}

// Convenience: resolve a full report context directly from a Key Report
// versionId (the version's own company is used). Returns an empty context when
// the version does not exist. Lets consumers pass the UI-selected Version id
// without separately knowing its company.
async function getVersionReportContextById(versionId) {
  if (!versionId) return emptyReportContext();
  const version = await getVersion(versionId);
  if (!version) return emptyReportContext();
  return getVersionReportContext(version.companyId, { versionId });
}

// Returns documents linked in the active version for a given category.
// Thin wrapper over getLinkedDocuments for callers that don't scope by version.
async function getActiveLinkedDocuments(companyId, reportCategory) {
  return getLinkedDocuments(companyId, reportCategory);
}

// ---- Extracted data viewer --------------------------------------------------

// NOTE: no `profit_loss` entry — there is no profit_loss_entries table. P&L is
// generated live from the General Ledger and is not browsable as raw extracted data.
const ENTRY_TABLE_CONFIG = {
  balance_sheet: {
    table: 'balance_sheet_entries',
    yearCol: 'fiscal_year',
    yearIsDate: false,
    searchCols: ['account_name', 'account_number', 'section'],
    selectCols: 'id,fiscal_year,as_of_date,account_name,account_number,account_type,section,amount,hierarchy_level,is_total,sort_order',
    orderCol: 'sort_order',
    orderSecondary: 'id',
  },
  general_ledger: {
    table: 'general_ledger_entries',
    yearCol: 'fiscal_year',
    yearIsDate: false,
    searchCols: ['account_name', 'account_section', 'memo', 'split_account', 'transaction_number'],
    selectCols: 'id,row_type,row_number,fiscal_year,fiscal_month,transaction_date,account_section,account_name,account_number,transaction_type,transaction_number,memo,split_account,amount,debit_amount,credit_amount,running_balance,coa_id',
    orderCol: 'row_number',
    orderSecondary: 'id',
  },
  tax_return: {
    table: 'tax_return_entries',
    yearCol: 'tax_year',
    yearIsDate: false,
    searchCols: ['field_name', 'field_label', 'schedule', 'section'],
    selectCols: 'id,tax_year,form_type,field_name,field_label,field_value,field_amount,line_number,schedule,section',
    orderCol: 'id',
    orderSecondary: null,
  },
  bank_statement: {
    table: 'bank_statement_entries',
    yearCol: 'statement_month',
    yearIsDate: true,
    searchCols: ['description', 'bank_account', 'bank_name'],
    selectCols: 'id,transaction_date,statement_date,bank_account,bank_name,description,reference,amount,transaction_type,running_balance',
    orderCol: 'transaction_date',
    orderSecondary: 'id',
  },
};

async function getExtractedData(versionId, { dataType, year, page = 1, pageSize = 50, search } = {}) {
  const config = ENTRY_TABLE_CONFIG[dataType];
  if (!config) {
    const err = new Error(`Unknown data type: ${dataType}`);
    err.status = 400;
    throw err;
  }

  const parsedPage = Math.max(1, parseInt(page, 10) || 1);
  const parsedSize = Math.min(100, Math.max(1, parseInt(pageSize, 10) || 50));
  const from = (parsedPage - 1) * parsedSize;
  const to = from + parsedSize - 1;

  let query = supabase
    .from(config.table)
    .select(config.selectCols, { count: 'exact' })
    .eq('version_id', versionId);

  if (year) {
    const parsedYear = parseInt(year, 10);
    if (Number.isInteger(parsedYear) && parsedYear > 0) {
      if (config.yearIsDate) {
        query = query
          .gte(config.yearCol, `${parsedYear}-01-01`)
          .lte(config.yearCol, `${parsedYear}-12-31`);
      } else {
        query = query.eq(config.yearCol, parsedYear);
      }
    }
  }

  if (search && search.trim()) {
    const term = search.trim();
    const orFilter = config.searchCols.map(col => `${col}.ilike.%${term}%`).join(',');
    query = query.or(orFilter);
  }

  query = query.order(config.orderCol, { ascending: true, nullsFirst: false });
  if (config.orderSecondary) {
    query = query.order(config.orderSecondary, { ascending: true });
  }
  query = query.range(from, to);

  const { data, count, error } = await query;
  if (error) throw error;

  return {
    rows: data || [],
    total: count || 0,
    page: parsedPage,
    pageSize: parsedSize,
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
  listValidationResults,
  getActiveResolvedBatch,
  getActiveLinkedDocuments,
  getVersionByDatasetVersion,
  getLinkedDocuments,
  getVersionReportContext,
  getVersionReportContextById,
  getExtractedData,
};
