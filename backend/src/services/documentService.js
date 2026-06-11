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

// Tracks the one-time init promise so every caller can await the same work.
let _activityTableReady = null;

// Ensure the document_activity table exists using separate statements so any
// PostgreSQL client version can execute them.  Uses TEXT instead of a custom
// ENUM to avoid type-cast problems with both pg and Supabase REST.
async function _initActivityTable() {
  const pool = getPool();
  if (!pool) {
    console.log("[documentService] No DATABASE_URL — skipping activity table init; ensure table exists in Supabase.");
    return;
  }

  // Each statement is run separately — the pg client can struggle with multi-statement batches.
  const statements = [
    // ENUM type (no-op if already exists).
    `DO $$ BEGIN
       CREATE TYPE document_activity_type AS ENUM ('view', 'download');
     EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
    // Table — use TEXT for activity_type so it works regardless of whether
    // the ENUM type was created from schema.sql or is absent.
    `CREATE TABLE IF NOT EXISTS document_activity (
       id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
       document_id   uuid        NOT NULL REFERENCES documents(id)  ON DELETE CASCADE,
       user_id       uuid        NOT NULL REFERENCES users(id)       ON DELETE CASCADE,
       activity_type text        NOT NULL CHECK (activity_type IN ('view','download')),
       created_at    timestamptz NOT NULL DEFAULT now()
     )`,
    `CREATE INDEX IF NOT EXISTS idx_document_activity_document ON document_activity(document_id)`,
    `CREATE INDEX IF NOT EXISTS idx_document_activity_user     ON document_activity(user_id)`,
  ];

  let ok = true;
  for (const sql of statements) {
    try {
      await pool.query(sql);
    } catch (err) {
      if (!/already exists|duplicate/i.test(err.message)) {
        console.warn("[documentService] activity table init stmt failed:", err.message);
        ok = false;
      }
    }
  }
  if (ok) console.log("[documentService] document_activity table ready");
}

function ensureActivityTable() {
  if (!_activityTableReady) {
    _activityTableReady = _initActivityTable().catch((err) => {
      console.error("[documentService] ensureActivityTable error:", err.message);
      _activityTableReady = null; // allow retry on next request
    });
  }
  return _activityTableReady;
}

// Note: ensureActivityTable() is called lazily inside recordDocumentActivity()
// and getDocumentActivity() — no eager init needed at module load.

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
  // Best-effort table init — if it fails we still try the insert so the error
  // message is descriptive rather than "table does not exist".
  await ensureActivityTable().catch(() => { });

  const pool = getPool();
  if (pool) {
    // Try with explicit ENUM cast first (table created from schema.sql uses
    // document_activity_type ENUM). If the column is TEXT (our newer init),
    // the cast is a no-op. If the ENUM type doesn't exist yet this throws and
    // we fall through to the plain-text attempt.
    try {
      const { rows } = await pool.query(
        `INSERT INTO document_activity (document_id, user_id, activity_type)
         VALUES ($1, $2, $3::document_activity_type) RETURNING *`,
        [documentId, userId, activityType],
      );
      return rows[0];
    } catch (enumErr) {
      // ENUM cast failed — try without cast (TEXT column or unknown type).
      try {
        const { rows } = await pool.query(
          `INSERT INTO document_activity (document_id, user_id, activity_type)
           VALUES ($1, $2, $3) RETURNING *`,
          [documentId, userId, activityType],
        );
        return rows[0];
      } catch (pgErr) {
        console.warn("[documentService] pg insert activity failed:", pgErr.message, "— falling back to Supabase");
      }
    }
  }

  // Supabase REST fallback (bypasses the pg driver entirely).
  const { data, error } = await supabase
    .from("document_activity")
    .insert({ document_id: documentId, user_id: userId, activity_type: activityType })
    .select("id, document_id, user_id, activity_type, created_at")
    .single();
  if (error) {
    console.error("[documentService] Supabase insert activity failed:", error.message, error.details || '');
    throw new Error(`Could not record document activity: ${error.message}`);
  }
  return data;
}

async function getDocumentActivity(documentId) {
  await ensureActivityTable();

  const pool = getPool();
  if (pool) {
    try {
      const { rows } = await pool.query(
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
    } catch (pgErr) {
      console.warn("[documentService] pg fetch activity failed, falling back to Supabase:", pgErr.message);
    }
  }

  // Supabase fallback: two separate queries to avoid FK-join syntax issues.
  const { data: activityRows, error: activityError } = await supabase
    .from("document_activity")
    .select("id, activity_type, created_at, user_id")
    .eq("document_id", documentId)
    .order("created_at", { ascending: false });
  if (activityError) {
    console.error("[documentService] Supabase fetch activity failed:", activityError.message);
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
  archiveDocument,
  unarchiveDocument,
  deleteDocument,
  validateUpload,
  recordDocumentActivity,
  getDocumentActivity,
};
