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
      connectionTimeoutMillis: 2000,
      idleTimeoutMillis: 10000,
    });
    _pool.on("error", (err) => console.error("[folderService] pg pool error:", err.message));
  }
  return _pool;
}

async function pgQuery(sql, params = []) {
  const pool = getPool();
  if (!pool) throw new Error("DATABASE_URL not configured");
  const { rows } = await pool.query(sql, params);
  return rows;
}

// Each entry: [folderName, parentIdKey, idKey?]
// idKey is the key stored in idByName (defaults to folderName).
// Use unique idKey values when the same name appears under different parents
// (e.g. two "Reports" folders) to avoid key collisions.
const DEFAULT_FOLDERS = [
  // [name,                       parentIdKey,                   idKey]
  ["Finance",                   null],
  ["Compliance",                null],
  ["HR",                        null],
  ["Legal",                     null],
  ["M&A",                       null],
  ["Tax",                       null],
  ["Other",                     null],
  // Manual Upload Source tree
  ["Manual Upload Source",      null],
  ["Reports",                   "Manual Upload Source",         "MUS-Reports"],
  ["Balance Sheet",             "MUS-Reports",                  "MUS-BS"],
  ["Profit & Loss",             "MUS-Reports",                  "MUS-PL"],
  ["Cashflow",                  "MUS-Reports",                  "MUS-CF"],
  ["Bank Statement",            "Manual Upload Source",         "MUS-Bank"],
  ["Tax Return",                "Manual Upload Source",         "MUS-Tax"],
  // Quickbooks Manual Source tree (same sub-structure, unique idKeys)
  ["Quickbooks Manual Source",  null],
  ["Reports",                   "Quickbooks Manual Source",     "QMS-Reports"],
  ["Balance Sheet",             "QMS-Reports",                  "QMS-BS"],
  ["Profit & Loss",             "QMS-Reports",                  "QMS-PL"],
  ["Cashflow",                  "QMS-Reports",                  "QMS-CF"],
  ["Bank Statement",            "Quickbooks Manual Source",     "QMS-Bank"],
  ["Tax Return",                "Quickbooks Manual Source",     "QMS-Tax"],
];

// Expected folder count — used to decide whether cleanup is needed
const EXPECTED_FOLDER_COUNT = DEFAULT_FOLDERS.length;

// Per-company mutex: prevents concurrent ensure calls from creating duplicates
const _ensureInProgress = new Map();

async function resolveCreatorId(companyId, preferredUserId) {
  // Supabase-first (reads are reliable); Postgres is often unreachable locally
  try {
    if (preferredUserId) {
      const { data } = await supabase.from("users").select("id").eq("id", preferredUserId).maybeSingle();
      if (data?.id) return data.id;
    }
    const { data: admin } = await supabase.from("users").select("id").in("role", ["admin", "broker"]).limit(1).maybeSingle();
    if (admin?.id) return admin.id;
    const { data: cu } = await supabase.from("users").select("id").eq("company_id", companyId).limit(1).maybeSingle();
    if (cu?.id) return cu.id;
    const { data: any } = await supabase.from("users").select("id").limit(1).maybeSingle();
    if (any?.id) return any.id;
  } catch { /* fall through */ }

  // Postgres fallback (used in production where direct DB is reachable)
  const candidates = [
    preferredUserId
      ? () => pgQuery("SELECT id FROM users WHERE id=$1 LIMIT 1", [preferredUserId])
      : null,
    () => pgQuery("SELECT id FROM users WHERE role IN ('admin','broker') LIMIT 1"),
    () => pgQuery("SELECT id FROM users WHERE company_id=$1 LIMIT 1", [companyId]),
    () => pgQuery("SELECT id FROM users LIMIT 1"),
  ].filter(Boolean);

  for (const fn of candidates) {
    try {
      const rows = await fn();
      if (rows[0]?.id) return rows[0].id;
    } catch { /* try next */ }
  }
  return null;
}

async function ensureCompanyDefaultFolders(companyId, preferredCreatedBy = null) {
  if (!companyId) return [];

  // Coalesce concurrent calls for the same company to prevent duplicate inserts
  if (_ensureInProgress.has(companyId)) {
    return _ensureInProgress.get(companyId);
  }

  const promise = _doEnsureCompanyDefaultFolders(companyId, preferredCreatedBy).finally(() => {
    _ensureInProgress.delete(companyId);
  });
  _ensureInProgress.set(companyId, promise);
  return promise;
}

async function _sbFolderExists(companyId, name, parentId) {
  const q = supabase.from("folders").select("id").eq("company_id", companyId).ilike("name", name).limit(1);
  const { data } = parentId === null
    ? await q.is("parent_id", null).maybeSingle()
    : await q.eq("parent_id", parentId).maybeSingle();
  return data?.id ? [{ id: data.id }] : [];
}

async function _doEnsureCompanyDefaultFolders(companyId, preferredCreatedBy) {
  const creatorId = await resolveCreatorId(companyId, preferredCreatedBy);
  if (!creatorId) {
    console.error(`[folders] No creator found for company ${companyId}`);
    return [];
  }

  console.log(`[folders] Ensuring default folders for ${companyId} (creator: ${creatorId})`);

  const idByName = {};

  for (const [name, parentKey, idKey] of DEFAULT_FOLDERS) {
    const key = idKey || name;
    const parentId = parentKey ? (idByName[parentKey] || null) : null;
    try {
      // 1. Check if folder already exists — Supabase first, Postgres fallback
      let existing;
      try {
        existing = await _sbFolderExists(companyId, name, parentId);
      } catch {
        existing = parentId === null
          ? await pgQuery("SELECT id FROM folders WHERE company_id=$1 AND lower(name)=lower($2) AND parent_id IS NULL LIMIT 1", [companyId, name])
          : await pgQuery("SELECT id FROM folders WHERE company_id=$1 AND lower(name)=lower($2) AND parent_id=$3 LIMIT 1", [companyId, name, parentId]);
      }

      if (existing.length > 0) {
        idByName[key] = existing[0].id;
        continue;
      }

      // 2. Insert — Supabase first, Postgres fallback
      let insertedId = null;
      const { data: sbCreated, error: sbErr } = await supabase.from("folders")
        .insert({ company_id: companyId, parent_id: parentId, name, color: null, created_by: creatorId })
        .select("id").single();

      if (!sbErr && sbCreated?.id) {
        insertedId = sbCreated.id;
      } else {
        const rows = await pgQuery(
          "INSERT INTO folders (company_id, parent_id, name, color, created_by) VALUES ($1,$2,$3,NULL,$4) RETURNING id",
          [companyId, parentId, name, creatorId],
        );
        insertedId = rows[0]?.id || null;
      }

      if (insertedId) {
        idByName[key] = insertedId;
        console.log(`[folders]   ✓ "${name}"`);
      }
    } catch (err) {
      // On duplicate key, re-fetch the winner
      if (err.message.includes("duplicate key value") || err.message.includes("unique constraint")) {
        const winner = await _sbFolderExists(companyId, name, parentId).catch(() => []);
        if (winner.length > 0) idByName[key] = winner[0].id;
      } else {
        console.error(`[folders]   ✗ "${name}":`, err.message);
      }
    }
  }

  // Return all folders for this company
  const { data } = await supabase.from("folders").select("*").eq("company_id", companyId).order("created_at", { ascending: true });
  return data || [];
}

async function cleanupDuplicateFolders(companyId) {
  // Legacy cleanup function; unique indexes handle duplicates now,
  // but keeping interface intact.
  return 0;
}

async function listFoldersByCompany(companyId) {
  const { data, error } = await supabase
    .from("folders")
    .select("*")
    .eq("company_id", companyId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data || [];
}

async function getFolderById(id) {
  if (!id) return null;
  const { data, error } = await supabase
    .from("folders")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function fetchFolderRows(companyId) {
  // Try direct Postgres first (bypasses Supabase quota)
  try {
    return await pgQuery(
      "SELECT * FROM folders WHERE company_id=$1 ORDER BY created_at ASC",
      [companyId],
    );
  } catch {
    const { data } = await supabase
      .from("folders")
      .select("*")
      .eq("company_id", companyId)
      .order("created_at", { ascending: true });
    return data || [];
  }
}

function buildTree(rows) {
  const byId = new Map();
  for (const row of rows) byId.set(row.id, { ...row, children: [] });

  const roots = [];
  for (const node of byId.values()) {
    if (node.parent_id && byId.has(node.parent_id)) {
      byId.get(node.parent_id).children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

async function getFolderTree(companyId) {
  let rows = await fetchFolderRows(companyId);

  // Self-heal: create any missing default folders whenever the count is below expected
  if (rows.length < EXPECTED_FOLDER_COUNT) {
    console.log(
      `[folders] Company ${companyId} has ${rows.length}/${EXPECTED_FOLDER_COUNT} folders — ensuring defaults`,
    );
    await ensureCompanyDefaultFolders(companyId).catch((err) =>
      console.error("[folders] self-heal failed:", err.message),
    );
    rows = await fetchFolderRows(companyId);
  }

  return buildTree(rows);
}

async function ensureRootUploadFolder(companyId, preferredCreatedBy) {
  try {
    const rows = await pgQuery("SELECT * FROM folders WHERE company_id=$1 AND parent_id IS NULL AND lower(name)='general uploads' LIMIT 1", [companyId]);
    if (rows[0]) return rows[0];
    const creatorId = await resolveCreatorId(companyId, preferredCreatedBy);
    if (!creatorId) return null;
    const created = await pgQuery(
      "INSERT INTO folders (company_id, parent_id, name, color, created_by) VALUES ($1,NULL,'General Uploads',NULL,$2) RETURNING *",
      [companyId, creatorId],
    );
    return created[0] || null;
  } catch {
    const { data: existing } = await supabase.from("folders").select("*").eq("company_id", companyId).is("parent_id", null).ilike("name", "General Uploads").maybeSingle();
    if (existing) return existing;
    const creatorId = await resolveCreatorId(companyId, preferredCreatedBy);
    if (!creatorId) return null;
    const { data, error } = await supabase.from("folders")
      .insert({ company_id: companyId, parent_id: null, name: "General Uploads", color: null, created_by: creatorId })
      .select("*").single();
    if (error) console.error("[folders] ensureRootUploadFolder:", error.message);
    return data || null;
  }
}

async function createFolder(companyId, folderData) {
  try {
    const rows = await pgQuery(
      "INSERT INTO folders (company_id, parent_id, name, color, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *",
      [companyId, folderData.parent_id || null, folderData.name, folderData.color || null, folderData.created_by],
    );
    return rows[0];
  } catch {
    const { data, error } = await supabase.from("folders")
      .insert({ company_id: companyId, parent_id: folderData.parent_id || null, name: folderData.name, color: folderData.color || null, created_by: folderData.created_by })
      .select("*").single();
    if (error) throw error;
    return data;
  }
}

async function updateFolder(id, folderData) {
  const updates = {};
  if (folderData.name !== undefined) updates.name = folderData.name;
  if (folderData.color !== undefined) updates.color = folderData.color;
  try {
    const keys = Object.keys(updates);
    if (!keys.length) throw new Error("Nothing to update");
    const set = keys.map((k, i) => `"${k}"=$${i + 1}`).join(", ");
    const rows = await pgQuery(`UPDATE folders SET ${set} WHERE id=$${keys.length + 1} RETURNING *`, [...keys.map((k) => updates[k]), id]);
    return rows[0];
  } catch {
    const { data, error } = await supabase.from("folders").update(updates).eq("id", id).select("*").single();
    if (error) throw error;
    return data;
  }
}

/**
 * Archives a folder (soft delete)
 */
async function archiveFolder(id) {
  const { data, error } = await supabase
    .from("folders")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

/**
 * Unarchives a folder
 */
async function unarchiveFolder(id) {
  const { data, error } = await supabase
    .from("folders")
    .update({ archived_at: null })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

/**
 * Deletes a folder
 */
async function deleteFolder(id) {
  // File-link protection: refuse to delete a folder whose subtree contains a
  // document linked to a module (e.g. Key Reports). Throws FileLinkedError (409).
  const { assertFolderDeletable } = require("./fileReferenceService");
  await assertFolderDeletable(id);

  try {
    await pgQuery("DELETE FROM folders WHERE id=$1", [id]);
  } catch (err) {
    // Preserve the 409 link-protection error instead of masking it as a delete fallback.
    if (err && err.code === "FILE_LINKED") throw err;
    const { error } = await supabase.from("folders").delete().eq("id", id);
    if (error) throw error;
  }
}

async function moveFolder(id, parentId) {
  try {
    const rows = await pgQuery("UPDATE folders SET parent_id=$1 WHERE id=$2 RETURNING *", [parentId || null, id]);
    return rows[0];
  } catch {
    const { data, error } = await supabase.from("folders").update({ parent_id: parentId || null }).eq("id", id).select("*").single();
    if (error) throw error;
    return data;
  }
}

module.exports = {
  ensureCompanyDefaultFolders,
  cleanupDuplicateFolders,
  ensureRootUploadFolder,
  listFoldersByCompany,
  getFolderById,
  getFolderTree,
  createFolder,
  updateFolder,
  archiveFolder,
  unarchiveFolder,
  deleteFolder,
  moveFolder,
};
