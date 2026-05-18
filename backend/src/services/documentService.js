const { supabase } = require("../db");
const { Pool } = require("pg");

let _pool = null;
function getPool() {
  if (!process.env.DATABASE_URL) return null;
  if (!_pool) {
    _pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 5,
    });
    _pool.on("error", (err) => console.error("[documentService] pg pool error:", err.message));
  }
  return _pool;
}

async function pgQuery(sql, params = []) {
  const pool = getPool();
  if (!pool) throw new Error("DATABASE_URL not configured");
  const { rows } = await pool.query(sql, params);
  return rows;
}

/**
 * Lists all documents in a folder
 * @param {string} folderId
 * @param {Object} options
 * @param {boolean} [options.includeArchived] - Include archived documents
 */
async function listDocumentsByFolder(folderId, options = {}) {
  let query = supabase
    .from("documents")
    .select("*")
    .eq("folder_id", folderId)
    .order("uploaded_at", { ascending: false });

  if (!options.includeArchived) {
    query = query.is("archived_at", null);
  }

  const { data, error } = await query;
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
      .select("*")
      .eq("folder_id", folderId)
      .order("uploaded_at", { ascending: false });
    if (error) throw error;
    return data || [];
  }
}

async function createDocument(docData) {
  try {
    const rows = await pgQuery(
      `INSERT INTO documents (company_id, folder_id, name, file_url, upload_id, size, ext, status, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [
        docData.company_id,
        docData.folder_id,
        docData.name,
        docData.file_url,
        docData.upload_id || null,
        docData.size,
        docData.ext,
        docData.status,
        docData.uploaded_by,
      ],
    );
    return rows[0];
  } catch {
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
        uploaded_by: docData.uploaded_by,
      })
      .select("*")
      .single();
    if (error) throw error;
    return data;
  }
}

async function deleteDocument(id) {
  let uploadId = null;

  try {
    const rows = await pgQuery(
      "SELECT upload_id FROM documents WHERE id = $1 LIMIT 1",
      [id],
    );
    if (!rows[0]) return;
    uploadId = rows[0].upload_id;
    await pgQuery("DELETE FROM documents WHERE id = $1", [id]);
  } catch {
    const { data: document, error: findError } = await supabase
      .from("documents")
      .select("upload_id")
      .eq("id", id)
      .maybeSingle();
    if (findError) throw findError;
    if (!document) return;
    uploadId = document.upload_id;
    await supabase.from("documents").delete().eq("id", id);
  }

  // Clean up orphaned upload
  if (uploadId) {
    try {
      const linked = await pgQuery(
        "SELECT id FROM documents WHERE upload_id = $1 LIMIT 1",
        [uploadId],
      );
      if (!linked.length) {
        await pgQuery("DELETE FROM uploads WHERE id = $1", [uploadId]);
      }
    } catch {
      const { data: linked } = await supabase
        .from("documents")
        .select("id")
        .eq("upload_id", uploadId)
        .limit(1)
        .maybeSingle();
      if (!linked) {
        await supabase.from("uploads").delete().eq("id", uploadId);
      }
    }
  }
}

/**
 * Archives a document (soft delete)
 */
async function archiveDocument(id) {
  const { data, error } = await supabase
    .from("documents")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

/**
 * Unarchives a document
 */
async function unarchiveDocument(id) {
  const { data, error } = await supabase
    .from("documents")
    .update({ archived_at: null })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

/**
 * Validates if an upload exists
 */
async function validateUpload(uploadId) {
  try {
    const rows = await pgQuery(
      "SELECT id FROM uploads WHERE id = $1 LIMIT 1",
      [uploadId],
    );
    return rows.length > 0;
  } catch {
    const { data, error } = await supabase
      .from("uploads")
      .select("id")
      .eq("id", uploadId)
      .maybeSingle();
    if (error) throw error;
    return !!data;
  }
}

async function recordDocumentActivity(documentId, userId, activityType) {
  try {
    const rows = await pgQuery(
      "INSERT INTO document_activity (document_id, user_id, activity_type) VALUES ($1, $2, $3) RETURNING *",
      [documentId, userId, activityType],
    );
    return rows[0];
  } catch {
    const { data, error } = await supabase
      .from("document_activity")
      .insert({ document_id: documentId, user_id: userId, activity_type: activityType })
      .select("*")
      .single();
    if (error) throw error;
    return data;
  }
}

async function getDocumentActivity(documentId) {
  try {
    const rows = await pgQuery(
      `SELECT da.id, da.activity_type, da.created_at,
              u.id AS user_id, u.name AS user_name, u.email AS user_email, u.role AS user_role
       FROM document_activity da
       LEFT JOIN users u ON da.user_id = u.id
       WHERE da.document_id = $1
       ORDER BY da.created_at DESC`,
      [documentId],
    );
    return rows.map((r) => ({
      id: r.id,
      activity_type: r.activity_type,
      created_at: r.created_at,
      users: r.user_id
        ? { id: r.user_id, name: r.user_name, email: r.user_email, role: r.user_role }
        : null,
    }));
  } catch {
    const { data, error } = await supabase
      .from("document_activity")
      .select("id, activity_type, created_at, users ( id, name, email, role )")
      .eq("document_id", documentId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data || [];
  }
}

module.exports = {
  listDocumentsByFolder,
  createDocument,
  archiveDocument,
  unarchiveDocument,
  deleteDocument,
  validateUpload,
  recordDocumentActivity,
  getDocumentActivity,
};
