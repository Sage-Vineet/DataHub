const { supabase } = require("../db");

const DEFAULT_FOLDER_STRUCTURE = [
  { name: "Finance" },
  { name: "Compliance" },
  { name: "HR" },
  { name: "Legal" },
  { name: "M&A" },
  { name: "Tax" },
  { name: "Other" },
  {
    name: "Manual Upload Source",
    children: [
      {
        name: "Reports",
        children: [
          { name: "Balance Sheet" },
          { name: "Profit & Loss" },
          { name: "Cashflow" },
        ],
      },
      { name: "Bank Statement" },
      { name: "Tax Return" },
    ],
  },
];

async function userExists(userId) {
  if (!userId) return false;
  const { data, error } = await supabase
    .from("users")
    .select("id")
    .eq("id", userId)
    .maybeSingle();
  return !!data && !error;
}

async function resolveFolderCreatorId(companyId, preferredCreatedBy) {
  if (await userExists(preferredCreatedBy)) return preferredCreatedBy;

  const { data: companyUser } = await supabase
    .from("users")
    .select("id")
    .eq("company_id", companyId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (companyUser?.id) return companyUser.id;

  const { data: assignedUser } = await supabase
    .from("user_companies")
    .select("user_id")
    .eq("company_id", companyId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (assignedUser?.user_id) return assignedUser.user_id;

  const { data: brokerUser } = await supabase
    .from("users")
    .select("id")
    .in("role", ["admin", "broker"])
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  return brokerUser?.id || null;
}

// Idempotent: find-or-create a single folder, then recurse into children.
async function ensureFolderNode(companyId, folderDef, parentId, creatorId) {
  // Look for an existing folder with the same name under the same parent
  let query = supabase
    .from("folders")
    .select("id")
    .eq("company_id", companyId)
    .ilike("name", folderDef.name);

  if (parentId === null) {
    query = query.is("parent_id", null);
  } else {
    query = query.eq("parent_id", parentId);
  }

  const { data: existing } = await query.maybeSingle();

  let folderId = existing?.id || null;

  if (!folderId) {
    const { data: created, error } = await supabase
      .from("folders")
      .insert({
        company_id: companyId,
        parent_id: parentId,
        name: folderDef.name,
        color: null,
        created_by: creatorId,
      })
      .select("id")
      .single();

    if (error) {
      console.error("❌ Error creating folder:", folderDef.name, error.message);
      return;
    }
    folderId = created?.id || null;
  }

  if (folderId && Array.isArray(folderDef.children)) {
    for (const child of folderDef.children) {
      await ensureFolderNode(companyId, child, folderId, creatorId);
    }
  }
}

// Legacy folder names that should be removed if they exist
const LEGACY_FOLDER_NAMES = ["Datahub Reports Documents"];

// Legacy Manual Upload Source child folders to remove
const LEGACY_MANUAL_CHILD_NAMES = ["Invoices", "EBITDA"];

// Legacy Manual Upload Source child folders to rename: [oldName, newName]
const MANUAL_FOLDER_RENAMES = [
  ["Bank Reconciliation", "Bank Statement"],
  ["Tax Reconciliation", "Tax Return"],
];

async function removeLegacyFolders(companyId) {
  for (const name of LEGACY_FOLDER_NAMES) {
    const { data: found } = await supabase
      .from("folders")
      .select("id")
      .eq("company_id", companyId)
      .is("parent_id", null)
      .ilike("name", name);

    if (found?.length) {
      const ids = found.map((f) => f.id);
      await supabase.from("folders").delete().in("id", ids);
    }
  }
}

// Migrates existing companies' Manual Upload Source children:
// - deletes Invoices and EBITDA folders
// - renames Bank Reconciliation → Bank Statement, Tax Reconciliation → Tax Return
async function migrateManualUploadSourceFolders(companyId) {
  const { data: sourceFolder } = await supabase
    .from("folders")
    .select("id")
    .eq("company_id", companyId)
    .is("parent_id", null)
    .ilike("name", "Manual Upload Source")
    .maybeSingle();

  if (!sourceFolder) return;

  // Remove legacy children
  for (const name of LEGACY_MANUAL_CHILD_NAMES) {
    const { data: found } = await supabase
      .from("folders")
      .select("id")
      .eq("company_id", companyId)
      .eq("parent_id", sourceFolder.id)
      .ilike("name", name);
    if (found?.length) {
      const ids = found.map((f) => f.id);
      await supabase.from("folders").delete().in("id", ids);
    }
  }

  // Rename legacy children
  for (const [oldName, newName] of MANUAL_FOLDER_RENAMES) {
    const { data: found } = await supabase
      .from("folders")
      .select("id")
      .eq("company_id", companyId)
      .eq("parent_id", sourceFolder.id)
      .ilike("name", oldName)
      .maybeSingle();
    if (found?.id) {
      await supabase.from("folders").update({ name: newName }).eq("id", found.id);
    }
  }
}

async function ensureCompanyDefaultFolders(companyId, preferredCreatedBy) {
  if (!companyId) return [];

  const creatorId = await resolveFolderCreatorId(companyId, preferredCreatedBy);
  if (!creatorId) return [];

  // Remove any legacy root folder names
  await removeLegacyFolders(companyId);

  // Migrate Manual Upload Source children (rename/remove outdated folders)
  await migrateManualUploadSourceFolders(companyId);

  // Always run through the full structure — ensureFolderNode is idempotent
  // so existing folders are left untouched and only missing ones are created.
  for (const folder of DEFAULT_FOLDER_STRUCTURE) {
    await ensureFolderNode(companyId, folder, null, creatorId);
  }

  const { data: finalFolders } = await supabase
    .from("folders")
    .select("*")
    .eq("company_id", companyId)
    .order("created_at", { ascending: true });

  return finalFolders || [];
}

async function ensureRootUploadFolder(companyId, preferredCreatedBy) {
  const { data: existing, error: findError } = await supabase
    .from("folders")
    .select("*")
    .eq("company_id", companyId)
    .is("parent_id", null)
    .ilike("name", "General Uploads")
    .maybeSingle();

  if (existing) return existing;

  const creatorId = await resolveFolderCreatorId(companyId, preferredCreatedBy);
  if (!creatorId) return null;

  const { data: created, error: insertError } = await supabase
    .from("folders")
    .insert({
      company_id: companyId,
      parent_id: null,
      name: "General Uploads",
      color: null,
      created_by: creatorId
    })
    .select("*")
    .single();

  if (insertError) console.error("❌ Error creating root upload folder:", insertError.message);
  return created || null;
}

/**
 * Lists all folders for a company
 * @param {string} companyId - Company ID
 * @returns {Promise<Array>}
 */
async function listFoldersByCompany(companyId) {
  const { data, error } = await supabase
    .from("folders")
    .select("*")
    .eq("company_id", companyId)
    .order("created_at", { ascending: true });

  if (error) throw error;
  return data || [];
}

/**
 * Gets a tree structure of folders for a company
 * @param {string} companyId - Company ID
 * @returns {Promise<Array>}
 */
async function getFolderTree(companyId) {
  const { data: rows, error } = await supabase
    .from("folders")
    .select("*")
    .eq("company_id", companyId)
    .order("created_at", { ascending: true });

  if (error) throw error;

  const byId = new Map();
  for (const row of (rows || [])) {
    byId.set(row.id, { ...row, children: [] });
  }

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

/**
 * Creates a new folder
 * @param {string} companyId - Company ID
 * @param {Object} folderData - Folder data
 * @returns {Promise<Object>}
 */
async function createFolder(companyId, folderData) {
  const { data, error } = await supabase
    .from("folders")
    .insert({
      company_id: companyId,
      parent_id: folderData.parent_id || null,
      name: folderData.name,
      color: folderData.color || null,
      created_by: folderData.created_by
    })
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

/**
 * Updates a folder
 */
async function updateFolder(id, folderData) {
  const updates = {};
  if (folderData.name !== undefined) updates.name = folderData.name;
  if (folderData.color !== undefined) updates.color = folderData.color;

  const { data, error } = await supabase
    .from("folders")
    .update(updates)
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
  const { error } = await supabase.from("folders").delete().eq("id", id);
  if (error) throw error;
}

/**
 * Moves a folder to a new parent
 */
async function moveFolder(id, parentId) {
  const { data, error } = await supabase
    .from("folders")
    .update({ parent_id: parentId || null })
    .eq("id", id)
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

module.exports = {
  ensureCompanyDefaultFolders,
  ensureRootUploadFolder,
  resolveFolderCreatorId,
  listFoldersByCompany,
  getFolderTree,
  createFolder,
  updateFolder,
  deleteFolder,
  moveFolder
};
