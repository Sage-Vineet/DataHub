const { supabase } = require("../db");

const DEFAULT_FOLDER_STRUCTURE = [
  { name: "Finance" },
  { name: "Compliance" },
  { name: "HR" },
  { name: "Legal" },
  { name: "M&A" },
  { name: "Tax" },
  { name: "Other" },
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

async function ensureCompanyDefaultFolders(companyId, preferredCreatedBy) {
  if (!companyId) return [];

  const { data: existingRows, error: findError } = await supabase
    .from("folders")
    .select("*")
    .eq("company_id", companyId)
    .order("created_at", { ascending: true });

  if (findError) return [];
  if (existingRows && existingRows.length > 0) return existingRows;

  const creatorId = await resolveFolderCreatorId(companyId, preferredCreatedBy);
  if (!creatorId) return [];

  for (const folder of DEFAULT_FOLDER_STRUCTURE) {
    const { data: parent, error: insertError } = await supabase
      .from("folders")
      .insert({
        company_id: companyId,
        parent_id: null,
        name: folder.name,
        color: null,
        created_by: creatorId
      })
      .select("*")
      .single();

    if (insertError) {
      console.error("❌ Error creating folder:", insertError.message);
      continue;
    }

    if (parent && Array.isArray(folder.children)) {
      const children = folder.children.map(childName => ({
        company_id: companyId,
        parent_id: parent.id,
        name: childName,
        color: null,
        created_by: creatorId
      }));
      await supabase.from("folders").insert(children);
    }
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
    .order("created_at", { ascending: false });

  if (error) throw error;
  return data || [];
}

/**
 * Gets a tree structure of folders for a company
 * @param {string} companyId - Company ID
 * @returns {Promise<Array>}
 */
async function getFolderTree(companyId) {
  const rows = await listFoldersByCompany(companyId);
  
  const byId = new Map();
  for (const row of rows) {
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

  const sortTree = (nodes) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name));
    for (const node of nodes) sortTree(node.children);
  };

  sortTree(roots);
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
