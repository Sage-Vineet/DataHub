// File-reference registry + deletion protection for Data Room documents.
//
// A row in `file_references` marks a document as "in use" by some module
// (currently 'key_reports'). The document_id FK is ON DELETE RESTRICT, so a
// linked document cannot be hard-deleted at the DB layer. These helpers add a
// friendly application-layer guard (409) BEFORE the DB constraint would fire,
// and power the "★ Linked to Key Reports" indicator in the file explorer.

const { supabase } = require("../db");

const LINKED_MODULE_KEY_REPORTS = "key_reports";

class FileLinkedError extends Error {
  constructor(message, references = []) {
    super(message);
    this.name = "FileLinkedError";
    this.code = "FILE_LINKED";
    this.status = 409;
    this.references = references;
  }
}

function normalizeRef(row) {
  return {
    id: row.id,
    companyId: row.company_id,
    documentId: row.document_id,
    linkedModule: row.linked_module,
    linkedEntityId: row.linked_entity_id,
    metadata: row.metadata || {},
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

async function getReferencesForDocument(documentId) {
  if (!documentId) return [];
  const { data, error } = await supabase
    .from("file_references")
    .select("*")
    .eq("document_id", documentId);
  if (error) throw error;
  return (data || []).map(normalizeRef);
}

// Returns { [documentId]: count } for the supplied ids (for badges / bulk checks).
async function getReferenceCountsForDocuments(documentIds = []) {
  const ids = [...new Set((documentIds || []).filter(Boolean))];
  if (!ids.length) return {};
  const { data, error } = await supabase
    .from("file_references")
    .select("document_id")
    .in("document_id", ids);
  if (error) throw error;
  const counts = {};
  for (const row of data || []) {
    counts[row.document_id] = (counts[row.document_id] || 0) + 1;
  }
  return counts;
}

async function linkDocument({
  companyId,
  documentId,
  linkedModule = LINKED_MODULE_KEY_REPORTS,
  linkedEntityId = null,
  createdBy = null,
  metadata = {},
}) {
  if (!companyId || !documentId) {
    throw new Error("companyId and documentId are required to link a file.");
  }
  // Idempotent: unique (document_id, linked_module, linked_entity_id).
  const { data, error } = await supabase
    .from("file_references")
    .upsert(
      {
        company_id: companyId,
        document_id: documentId,
        linked_module: linkedModule,
        linked_entity_id: linkedEntityId,
        created_by: createdBy,
        metadata: metadata || {},
      },
      { onConflict: "document_id,linked_module,linked_entity_id" }
    )
    .select("*")
    .single();
  if (error) throw error;
  return normalizeRef(data);
}

async function unlinkDocument({
  documentId,
  linkedModule = LINKED_MODULE_KEY_REPORTS,
  linkedEntityId = null,
}) {
  if (!documentId) return false;
  let query = supabase
    .from("file_references")
    .delete()
    .eq("document_id", documentId)
    .eq("linked_module", linkedModule);
  query = linkedEntityId
    ? query.eq("linked_entity_id", linkedEntityId)
    : query.is("linked_entity_id", null);
  const { error } = await query;
  if (error) throw error;
  return true;
}

// Remove every reference belonging to a module entity (e.g. a deleted version).
async function unlinkByEntity({ linkedModule = LINKED_MODULE_KEY_REPORTS, linkedEntityId }) {
  if (!linkedEntityId) return false;
  const { error } = await supabase
    .from("file_references")
    .delete()
    .eq("linked_module", linkedModule)
    .eq("linked_entity_id", linkedEntityId);
  if (error) throw error;
  return true;
}

// Throws FileLinkedError(409) if the document is referenced by any module.
async function assertDocumentDeletable(documentId) {
  const refs = await getReferencesForDocument(documentId);
  if (refs.length) {
    throw new FileLinkedError(
      "This file is linked to Key Reports. Unlink it from Key Reports before deleting.",
      refs
    );
  }
}

// Collect a folder + all descendant folder ids (subtree).
async function collectFolderSubtree(folderId) {
  const ids = [folderId];
  let frontier = [folderId];
  // Bounded breadth-first walk; folder trees here are shallow.
  for (let depth = 0; depth < 50 && frontier.length; depth += 1) {
    const { data, error } = await supabase
      .from("folders")
      .select("id")
      .in("parent_id", frontier);
    if (error) throw error;
    const next = (data || []).map((r) => r.id).filter((id) => !ids.includes(id));
    if (!next.length) break;
    ids.push(...next);
    frontier = next;
  }
  return ids;
}

// Throws FileLinkedError(409) if any document inside the folder subtree is linked.
async function assertFolderDeletable(folderId) {
  if (!folderId) return;
  const folderIds = await collectFolderSubtree(folderId);
  const { data: docs, error } = await supabase
    .from("documents")
    .select("id")
    .in("folder_id", folderIds);
  if (error) throw error;
  const docIds = (docs || []).map((d) => d.id);
  if (!docIds.length) return;
  const counts = await getReferenceCountsForDocuments(docIds);
  const linkedIds = Object.keys(counts);
  if (linkedIds.length) {
    const refs = [];
    for (const id of linkedIds) {
      refs.push(...(await getReferencesForDocument(id)));
    }
    throw new FileLinkedError(
      "This folder contains files linked to Key Reports. Unlink them from Key Reports before deleting.",
      refs
    );
  }
}

module.exports = {
  LINKED_MODULE_KEY_REPORTS,
  FileLinkedError,
  getReferencesForDocument,
  getReferenceCountsForDocuments,
  linkDocument,
  unlinkDocument,
  unlinkByEntity,
  assertDocumentDeletable,
  assertFolderDeletable,
};
