const { supabase } = require("../db");
const { Pool } = require("pg");
const { buildSslOptions } = require("../db/pgPool");

let _pool = null;
function getPool() {
  if (!process.env.DATABASE_URL) return null;
  if (!_pool) {
    _pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: buildSslOptions(process.env.DATABASE_URL),
      max: 5,
      connectionTimeoutMillis: 8000,  // increased from 2s — Supabase can be slow on cold start
      idleTimeoutMillis: 10000,
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

function roleLabel(role) {
  if (!role) return null;
  if (role === "broker" || role === "admin") return "Broker";
  if (role === "client") return "Client";
  if (role === "user") return "Buyer";
  if (role === "provider") return "Provider";
  return null;
}

function formatUploaderDisplay(user) {
  if (!user) return null;
  const name = user.name || user.email || "User";
  const label = roleLabel(user.role);
  return label ? `${name} (${label})` : name;
}

function isMissingColumnError(error, columnName) {
  const text = [
    error?.message,
    error?.details,
    error?.hint,
    error?.code,
  ].filter(Boolean).join(" ");
  return new RegExp(`(${columnName}.*does not exist|Could not find.*${columnName}|schema cache.*${columnName})`, "i").test(text);
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
  const docs = data || [];

  const uploaderIds = [...new Set(docs.map((d) => d.uploaded_by).filter(Boolean))];
  if (uploaderIds.length) {
    const { data: users } = await supabase
      .from("users")
      .select("id, name, email, role")
      .in("id", uploaderIds);
    const displayById = new Map((users || []).map((u) => [u.id, formatUploaderDisplay(u)]));
    return docs.map((d) => ({ ...d, uploaded_by_name: displayById.get(d.uploaded_by) || null }));
  }
  return docs;
}

async function getDocumentById(id) {
  if (!id) return null;
  const { data, error } = await supabase
    .from("documents")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

/**
 * Creates a new document
 */
async function createDocument(docData) {
  try {
    const rows = await pgQuery(
      `INSERT INTO documents (company_id, folder_id, name, file_url, upload_id, size, ext, status, color, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [
        docData.company_id,
        docData.folder_id,
        docData.name,
        docData.file_url,
        docData.upload_id || null,
        docData.size,
        docData.ext,
        docData.status,
        docData.color || null,
        docData.uploaded_by,
      ],
    );
    return rows[0];
  } catch {
    const payload = {
      company_id: docData.company_id,
      folder_id: docData.folder_id,
      name: docData.name,
      file_url: docData.file_url,
      upload_id: docData.upload_id || null,
      size: docData.size,
      ext: docData.ext,
      status: docData.status,
      color: docData.color || null,
      uploaded_by: docData.uploaded_by,
    };
    let { data, error } = await supabase
      .from("documents")
      .insert(payload)
      .select("*")
      .single();
    if (error && isMissingColumnError(error, "color")) {
      delete payload.color;
      const retry = await supabase
        .from("documents")
        .insert(payload)
        .select("*")
        .single();
      data = retry.data;
      error = retry.error;
    }
    if (error) throw error;
    return data;
  }
}

async function deleteDocument(id) {
  // File-link protection: refuse to delete a document that is linked to a
  // module (e.g. Key Reports). Throws FileLinkedError (409) — unlink first.
  const { assertDocumentDeletable } = require("./fileReferenceService");
  await assertDocumentDeletable(id);

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

async function updateDocument(id, docData = {}) {
  const updates = {};
  if (docData.name !== undefined) updates.name = String(docData.name || "").trim();
  if (docData.color !== undefined) updates.color = docData.color || null;

  const keys = Object.keys(updates);
  if (!keys.length) return getDocumentById(id);

  try {
    const set = keys.map((key, index) => `"${key}"=$${index + 1}`).join(", ");
    const rows = await pgQuery(
      `UPDATE documents SET ${set} WHERE id=$${keys.length + 1} RETURNING *`,
      [...keys.map((key) => updates[key]), id],
    );
    return rows[0] || null;
  } catch {
    let { data, error } = await supabase
      .from("documents")
      .update(updates)
      .eq("id", id)
      .select("*")
      .single();
    if (error && isMissingColumnError(error, "color")) {
      const retryUpdates = { ...updates };
      delete retryUpdates.color;

      if (Object.keys(retryUpdates).length) {
        const retry = await supabase
          .from("documents")
          .update(retryUpdates)
          .eq("id", id)
          .select("*")
          .single();
        data = retry.data;
        error = retry.error;
      } else {
        data = await getDocumentById(id);
        error = null;
      }

      if (!error && data) {
        return {
          ...data,
          color: updates.color || data.color || null,
          color_persistence_pending: true,
        };
      }
    }
    if (error) throw error;
    return data;
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

// document_activity is written/read exclusively through the Supabase REST
// client. This project's direct Postgres host (DATABASE_URL) resolves to an
// IPv6-only address that this deployment cannot route to, so pg-based access
// here would only add a guaranteed-to-fail connection attempt before falling
// back to Supabase — going straight to Supabase is both simpler and faster.
// The document_activity table/columns are managed by
// sql/migrations/038_document_activity.sql and 088_fix_document_activity_type_column.sql.
async function recordDocumentActivity(documentId, userId, activityType) {
  const { data, error } = await supabase
    .from("document_activity")
    .insert({ document_id: documentId, user_id: userId, activity_type: activityType })
    .select("id, document_id, user_id, activity_type, created_at")
    .single();
  if (error) {
    console.error("[documentService] Failed to record document activity:", error.message, error.details || '');
    throw new Error(`Could not record document activity: ${error.message}`);
  }
  return data;
}

async function getDocumentActivity(documentId) {
  const { data: activityRows, error: activityError } = await supabase
    .from("document_activity")
    .select("id, activity_type, created_at, user_id")
    .eq("document_id", documentId)
    .order("created_at", { ascending: false });
  if (activityError) {
    console.error("[documentService] Failed to fetch document activity:", activityError.message);
    throw activityError;
  }
  if (!activityRows || activityRows.length === 0) return [];

  const userIds = [...new Set(activityRows.map((r) => r.user_id).filter(Boolean))];
  let userMap = {};
  if (userIds.length > 0) {
    const { data: userData } = await supabase
      .from("users")
      .select("id, name, email, role")
      .in("id", userIds);
    (userData || []).forEach((u) => { userMap[u.id] = u; });
  }

  return activityRows.map((r) => ({
    id: r.id,
    activity_type: r.activity_type,
    created_at: r.created_at,
    users: r.user_id ? (userMap[r.user_id] || { id: r.user_id, name: 'Unknown', email: '', role: '' }) : null,
  }));
}

module.exports = {
  listDocumentsByFolder,
  getDocumentById,
  createDocument,
  updateDocument,
  archiveDocument,
  unarchiveDocument,
  deleteDocument,
  validateUpload,
  recordDocumentActivity,
  getDocumentActivity,
};
