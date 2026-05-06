const { supabase } = require("../db");

const DEFAULT_FOLDER_STRUCTURE = [
  {
    name: "Datahub Reports Download",
    children: [
      { name: "Invoices" },
      {
        name: "Reports",
        children: [
          { name: "Balance sheet" },
          { name: "Profit & loss" },
          { name: "Cashflow" },
        ],
      },
      { name: "EBITDA" },
      { name: "Bank Reconciliation" },
      { name: "Tax Reconciliation" },
    ],
  },
];

function createHttpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeFolderName(name) {
  return String(name || "").trim().toLowerCase();
}

function normalizeParentId(parentId) {
  return parentId ? String(parentId) : "__root__";
}

function collectProtectedPaths(nodes, parentPath = "") {
  const paths = [];

  for (const node of nodes || []) {
    const path = parentPath ? `${parentPath}/${node.name}` : node.name;
    paths.push(path);

    if (Array.isArray(node.children) && node.children.length > 0) {
      paths.push(...collectProtectedPaths(node.children, path));
    }
  }

  return paths;
}

const PROTECTED_FOLDER_PATHS = collectProtectedPaths(DEFAULT_FOLDER_STRUCTURE);
const PROTECTED_FOLDER_PATH_SET = new Set(
  PROTECTED_FOLDER_PATHS.map((path) => path.toLowerCase()),
);
const PROTECTED_FOLDER_ORDER = new Map(
  PROTECTED_FOLDER_PATHS.map((path, index) => [path.toLowerCase(), index]),
);

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

function buildFolderPathMap(rows) {
  const rowById = new Map((rows || []).map((row) => [String(row.id), row]));
  const pathById = new Map();

  function resolvePath(row) {
    if (!row?.id) return "";

    const rowId = String(row.id);
    if (pathById.has(rowId)) {
      return pathById.get(rowId);
    }

    const parent = row.parent_id ? rowById.get(String(row.parent_id)) : null;
    const parentPath = parent ? resolvePath(parent) : "";
    const path = parentPath ? `${parentPath}/${row.name}` : row.name;
    pathById.set(rowId, path);
    return path;
  }

  for (const row of rows || []) {
    resolvePath(row);
  }

  return pathById;
}

function annotateFolderRows(rows) {
  const pathById = buildFolderPathMap(rows);

  return (rows || []).map((row) => {
    const path = pathById.get(String(row.id)) || row.name;
    const normalizedPath = path.toLowerCase();
    const isProtected = PROTECTED_FOLDER_PATH_SET.has(normalizedPath);
    const sortOrder = PROTECTED_FOLDER_ORDER.has(normalizedPath)
      ? PROTECTED_FOLDER_ORDER.get(normalizedPath)
      : null;

    return {
      ...row,
      path,
      sort_order: sortOrder,
      is_protected: isProtected,
      is_structure_locked: isProtected,
      can_create_children: !isProtected,
      can_rename: !isProtected,
      can_delete: !isProtected,
      can_move: !isProtected,
    };
  });
}

function sortFoldersForDisplay(rows) {
  return [...(rows || [])].sort((a, b) => {
    const aHasOrder = Number.isInteger(a.sort_order);
    const bHasOrder = Number.isInteger(b.sort_order);

    if (aHasOrder && bHasOrder && a.sort_order !== b.sort_order) {
      return a.sort_order - b.sort_order;
    }
    if (aHasOrder !== bHasOrder) {
      return aHasOrder ? -1 : 1;
    }

    return String(a.name || "").localeCompare(String(b.name || ""));
  });
}

async function fetchFolderRows(companyId) {
  const { data, error } = await supabase
    .from("folders")
    .select("*")
    .eq("company_id", companyId)
    .order("created_at", { ascending: true });

  if (error) throw error;
  return data || [];
}

function replaceFolderParentInRows(rows, fromFolderId, toFolderId) {
  for (const row of rows) {
    if (String(row.parent_id || "") === String(fromFolderId || "")) {
      row.parent_id = toFolderId;
    }
  }
}

function removeFolderFromRows(rows, folderId) {
  const index = rows.findIndex((row) => String(row.id) === String(folderId));
  if (index >= 0) {
    rows.splice(index, 1);
  }
}

async function mergeFolderIntoCanonicalFolder(canonical, duplicate, rows) {
  if (!canonical?.id || !duplicate?.id || canonical.id === duplicate.id) {
    return canonical;
  }

  const duplicateId = duplicate.id;
  const canonicalId = canonical.id;

  const { error: moveDocumentsError } = await supabase
    .from("documents")
    .update({ folder_id: canonicalId })
    .eq("folder_id", duplicateId);
  if (moveDocumentsError) throw moveDocumentsError;

  const { error: moveAccessError } = await supabase
    .from("folder_access")
    .update({ folder_id: canonicalId })
    .eq("folder_id", duplicateId);
  if (moveAccessError) throw moveAccessError;

  const { error: moveChildrenError } = await supabase
    .from("folders")
    .update({ parent_id: canonicalId })
    .eq("parent_id", duplicateId);
  if (moveChildrenError) throw moveChildrenError;

  const { error: deleteError } = await supabase
    .from("folders")
    .delete()
    .eq("id", duplicateId);
  if (deleteError) throw deleteError;

  replaceFolderParentInRows(rows, duplicateId, canonicalId);
  removeFolderFromRows(rows, duplicateId);
  return canonical;
}

async function ensureFolderNodes(companyId, parentId, nodes, creatorId, rows) {
  for (const node of nodes || []) {
    const matches = rows.filter(
      (row) =>
        normalizeParentId(row.parent_id) === normalizeParentId(parentId) &&
        normalizeFolderName(row.name) === normalizeFolderName(node.name),
    );

    let current = matches[0] || null;

    if (matches.length > 1 && current) {
      for (const duplicate of matches.slice(1)) {
        current = await mergeFolderIntoCanonicalFolder(current, duplicate, rows);
      }
    }

    if (!current) {
      if (!creatorId) {
        continue;
      }

      const { data: created, error: insertError } = await supabase
        .from("folders")
        .insert({
          company_id: companyId,
          parent_id: parentId || null,
          name: node.name,
          color: null,
          created_by: creatorId,
        })
        .select("*")
        .single();

      if (insertError) {
        console.error("Error creating default folder:", insertError.message);
        continue;
      }

      current = created;
      rows.push(created);
    }

    if (Array.isArray(node.children) && node.children.length > 0) {
      await ensureFolderNodes(companyId, current.id, node.children, creatorId, rows);
    }
  }
}

async function ensureCompanyDefaultFolders(companyId, preferredCreatedBy) {
  if (!companyId) return [];

  const existingRows = await fetchFolderRows(companyId);
  const creatorId = await resolveFolderCreatorId(companyId, preferredCreatedBy);
  const workingRows = [...existingRows];
  await ensureFolderNodes(
    companyId,
    null,
    DEFAULT_FOLDER_STRUCTURE,
    creatorId,
    workingRows,
  );

  const finalRows = await fetchFolderRows(companyId);
  return sortFoldersForDisplay(annotateFolderRows(finalRows));
}

async function ensureRootUploadFolder(companyId, preferredCreatedBy) {
  const existingRows = await ensureCompanyDefaultFolders(
    companyId,
    preferredCreatedBy,
  );
  const existing = existingRows.find(
    (row) =>
      !row.parent_id && normalizeFolderName(row.name) === "general uploads",
  );

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
      created_by: creatorId,
    })
    .select("*")
    .single();

  if (insertError) {
    console.error("Error creating root upload folder:", insertError.message);
    return null;
  }

  return annotateFolderRows([created])[0] || null;
}

function findFolderById(rows, id) {
  return (rows || []).find((row) => String(row.id) === String(id)) || null;
}

async function getFolderContext(id) {
  const { data: folder, error } = await supabase
    .from("folders")
    .select("id, company_id")
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  if (!folder) return null;

  const rows = await ensureCompanyDefaultFolders(folder.company_id, null);
  const current = findFolderById(rows, id);

  return current ? { folder: current, rows } : null;
}

function assertFolderExists(folder, message = "Folder not found") {
  if (!folder) {
    throw createHttpError(404, message);
  }
}

function assertFolderUnlocked(folder) {
  if (folder?.is_structure_locked) {
    throw createHttpError(
      403,
      "This default folder structure is locked and cannot be modified.",
    );
  }
}

function assertCanCreateChildFolders(parentFolder) {
  if (parentFolder?.can_create_children === false) {
    throw createHttpError(
      403,
      "You cannot add subfolders inside the locked default folder structure.",
    );
  }
}

function assertCanMoveIntoFolder(targetFolder) {
  if (targetFolder?.can_create_children === false) {
    throw createHttpError(
      403,
      "You cannot move folders into the locked default folder structure.",
    );
  }
}

function assertNotMovingIntoOwnDescendant(folder, targetFolder) {
  if (!folder?.path || !targetFolder?.path) return;
  if (targetFolder.path === folder.path) {
    throw createHttpError(400, "A folder cannot be moved into itself.");
  }
  if (targetFolder.path.startsWith(`${folder.path}/`)) {
    throw createHttpError(
      400,
      "A folder cannot be moved into one of its descendants.",
    );
  }
}

async function listFoldersByCompany(companyId) {
  return ensureCompanyDefaultFolders(companyId, null);
}

async function getFolderTree(companyId) {
  const rows = await ensureCompanyDefaultFolders(companyId, null);

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
    nodes.sort((a, b) => {
      const aHasOrder = Number.isInteger(a.sort_order);
      const bHasOrder = Number.isInteger(b.sort_order);

      if (aHasOrder && bHasOrder && a.sort_order !== b.sort_order) {
        return a.sort_order - b.sort_order;
      }
      if (aHasOrder !== bHasOrder) {
        return aHasOrder ? -1 : 1;
      }
      return String(a.name || "").localeCompare(String(b.name || ""));
    });

    for (const node of nodes) {
      sortTree(node.children);
    }
  };

  sortTree(roots);
  return roots;
}

async function createFolder(companyId, folderData) {
  const rows = await ensureCompanyDefaultFolders(
    companyId,
    folderData.created_by || null,
  );

  const parentFolder = folderData.parent_id
    ? findFolderById(rows, folderData.parent_id)
    : null;

  if (folderData.parent_id) {
    assertFolderExists(parentFolder, "Parent folder not found");
    assertCanCreateChildFolders(parentFolder);
  }

  const { data, error } = await supabase
    .from("folders")
    .insert({
      company_id: companyId,
      parent_id: folderData.parent_id || null,
      name: folderData.name,
      color: folderData.color || null,
      created_by: folderData.created_by,
    })
    .select("*")
    .single();

  if (error) throw error;
  return annotateFolderRows([data])[0];
}

async function updateFolder(id, folderData) {
  const context = await getFolderContext(id);
  assertFolderExists(context?.folder);
  assertFolderUnlocked(context.folder);

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
  return annotateFolderRows([data])[0];
}

async function deleteFolder(id) {
  const context = await getFolderContext(id);
  assertFolderExists(context?.folder);
  assertFolderUnlocked(context.folder);

  const { error } = await supabase.from("folders").delete().eq("id", id);
  if (error) throw error;
}

async function moveFolder(id, parentId) {
  const context = await getFolderContext(id);
  assertFolderExists(context?.folder);
  assertFolderUnlocked(context.folder);

  const targetFolder = parentId ? findFolderById(context.rows, parentId) : null;

  if (parentId) {
    assertFolderExists(targetFolder, "Destination folder not found");
    assertCanMoveIntoFolder(targetFolder);
    assertNotMovingIntoOwnDescendant(context.folder, targetFolder);
  }

  const { data, error } = await supabase
    .from("folders")
    .update({ parent_id: parentId || null })
    .eq("id", id)
    .select("*")
    .single();

  if (error) throw error;
  return annotateFolderRows([data])[0];
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
  moveFolder,
};
