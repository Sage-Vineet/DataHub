const { supabase } = require("../db");

/**
 * Lists all documents in a folder
 */
async function listDocumentsByFolder(folderId) {
  const { data, error } = await supabase
    .from("documents")
    .select("*")
    .eq("folder_id", folderId)
    .order("uploaded_at", { ascending: false });

  if (error) throw error;
  return data || [];
}

/**
 * Creates a new document
 */
async function createDocument(docData) {
  const { data, error } = await supabase
    .from("documents")
    .insert({
      company_id: docData.company_id,
      folder_id: docData.folder_id,
      name: docData.name,
      file_url: docData.file_url,
      upload_id: docData.upload_id || null,
      size: docData.size,
      ext: docData.ext,
      status: docData.status,
      uploaded_by: docData.uploaded_by
    })
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

/**
 * Deletes a document and its associated upload if no other documents reference it
 */
async function deleteDocument(id) {
  const { data: document, error: findError } = await supabase
    .from("documents")
    .select("upload_id")
    .eq("id", id)
    .maybeSingle();

  if (findError) throw findError;
  if (!document) return;

  await supabase.from("documents").delete().eq("id", id);

  if (document.upload_id) {
    const { data: linked } = await supabase
      .from("documents")
      .select("id")
      .eq("upload_id", document.upload_id)
      .limit(1)
      .maybeSingle();

    if (!linked) {
      await supabase.from("uploads").delete().eq("id", document.upload_id);
    }
  }
}

/**
 * Validates if an upload exists
 */
async function validateUpload(uploadId) {
  const { data, error } = await supabase
    .from("uploads")
    .select("id")
    .eq("id", uploadId)
    .maybeSingle();

  if (error) throw error;
  return !!data;
}

/**
 * Records a document activity (view or download)
 */
async function recordDocumentActivity(documentId, userId, activityType) {
  const { data, error } = await supabase
    .from("document_activity")
    .insert({
      document_id: documentId,
      user_id: userId,
      activity_type: activityType
    })
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

/**
 * Gets the activity log for a document
 */
async function getDocumentActivity(documentId) {
  const { data, error } = await supabase
    .from("document_activity")
    .select(`
      id,
      activity_type,
      created_at,
      users ( id, name, email, role )
    `)
    .eq("document_id", documentId)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return data || [];
}

module.exports = {
  listDocumentsByFolder,
  createDocument,
  deleteDocument,
  validateUpload,
  recordDocumentActivity,
  getDocumentActivity
};
