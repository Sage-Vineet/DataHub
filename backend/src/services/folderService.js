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
      connectionTimeoutMillis: 8000,
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

const DEFAULT_FOLDERS = [
  ["Finance",              null],
  ["Compliance",           null],
  ["HR",                   null],
  ["Legal",                null],
  ["M&A",                  null],
  ["Tax",                  null],
  ["Other",                null],
  ["Manual Upload Source", null],
  ["Reports",              "Manual Upload Source"],
  ["Balance Sheet",        "Reports"],
  ["Profit & Loss",        "Reports"],
  ["Cashflow",             "Reports"],
  ["Bank Statement",       "Manual Upload Source"],
  ["Tax Return",           "Manual Upload Source"],
];

// Expected folder count — used to decide whether cleanup is needed
const EXPECTED_FOLDER_COUNT = DEFAULT_FOLDERS.length;

async function resolveCreatorId(companyId, preferredUserId) {
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

  const creatorId = await resolveCreatorId(companyId, preferredCreatedBy);
  if (!creatorId) {
    console.error(`[folders] No creator found for company ${companyId}`);
    return [];
  }

  console.log(`[folders] Ensuring default folders for ${companyId} (creator: ${creatorId})`);

  const idByName = {};

  for (const [name, parentKey] of DEFAULT_FOLDERS) {
    const parentId = parentKey ? (idByName[parentKey] || null) : null;
    try {
      const existing = parentId === null
        ? await pgQuery("SELECT id FROM folders WHERE company_id=$1 AND lower(name)=lower($2) AND parent_id IS NULL LIMIT 1", [companyId, name])
        : await pgQuery("SELECT id FROM folders WHERE company_id=$1 AND lower(name)=lower($2) AND parent_id=$3 LIMIT 1", [companyId, name, parentId]);

      if (existing.length > 0) {
        idByName[name] = existing[0].id;
        continue;
      }

      const created = await pgQuery(
        "INSERT INTO folders (company_id, parent_id, name, color, created_by) VALUES ($1,$2,$3,NULL,$4) RETURNING id",
        [companyId, parentId, name, creatorId],
      );
      if (created[0]?.id) {
        idByName[name] = created[0].id;
        console.log(`[folders]   ✓ "${name}"`);
      }
    } catch (err) {
      console.error(`[folders]   ✗ "${name}":`, err.message);
    }
  }

  try {
    return await pgQuery("SELECT * FROM folders WHERE company_id=$1 ORDER BY created_at ASC", [companyId]);
  } catch { return []; }
}

/**
 * Lists all folders for a company
 * @param {string} companyId - Company ID
 * @param {Object} options
 * @param {boolean} [options.includeArchived] - Include archived folders
 * @returns {Promise<Array>}
 */
async function listFoldersByCompany(companyId, options = {}) {
  let query = supabase
    .from("folders")
    .select("*")
    .eq("company_id", companyId)
    .order("created_at", { ascending: true });

  if (!options.includeArchived) {
    query = query.is("archived_at", null);
  }

  const { data, error } = await query;
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

/**
 * Gets a tree structure of folders for a company
 * @param {string} companyId - Company ID
 * @param {Object} options
 * @param {boolean} [options.includeArchived] - Include archived folders
 * @returns {Promise<Array>}
 */
async function getFolderTree(companyId, options = {}) {
  let query = supabase
    .from("folders")
    .select("*")
    .eq("company_id", companyId)
    .order("created_at", { ascending: true });

  if (!options.includeArchived) {
    query = query.is("archived_at", null);
  }

  const { data: rows, error } = await query;

  if (error) throw error;

  const byId = new Map();
  for (const row of deduped) byId.set(row.id, { ...row, children: [] });

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

async function getFolderTree(companyId, preferredCreatedBy = null) {
  let rows = await fetchFolderRows(companyId);

  if (rows.length === 0) {
    console.log(`[folders] No folders for company ${companyId} — self-healing`);
    await ensureCompanyDefaultFolders(companyId, preferredCreatedBy).catch((err) =>
      console.error("[folders] self-heal failed:", err.message),
    );
    rows = await fetchFolderRows(companyId);
  }

  // If there are more folders than expected, duplicates exist — clean them up
  if (rows.length > EXPECTED_FOLDER_COUNT) {
    console.log(`[folders] Found ${rows.length} folders (expected ${EXPECTED_FOLDER_COUNT}) — deduplicating`);
    await cleanupDuplicateFolders(companyId).catch((err) =>
      console.error("[folders] dedup failed:", err.message),
    );
    rows = await fetchFolderRows(companyId);
  }

  return buildTree(rows);
}

async function listFoldersByCompany(companyId) {
  try {
    return await pgQuery("SELECT * FROM folders WHERE company_id=$1 ORDER BY created_at ASC", [companyId]);
  } catch {
    const { data, error } = await supabase.from("folders").select("*").eq("company_id", companyId).order("created_at", { ascending: true });
    if (error) throw error;
    return data || [];
  }
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
  try {
    await pgQuery("DELETE FROM folders WHERE id=$1", [id]);
  } catch {
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
  ensureRootUploadFolder,
  cleanupDuplicateFolders,
  resolveFolderCreatorId: resolveCreatorId,
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
