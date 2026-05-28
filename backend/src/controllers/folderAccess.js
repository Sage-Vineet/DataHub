const { supabase } = require("../db");
const asyncHandler = require("../utils");
const permissionService = require("../services/permissionService");

async function getFolderCompanyId(folderId) {
  const { data, error } = await supabase
    .from("folders")
    .select("company_id")
    .eq("id", folderId)
    .maybeSingle();
  if (error) throw error;
  return data?.company_id || null;
}

async function getAccessCompanyId(accessId) {
  const { data, error } = await supabase
    .from("folder_access")
    .select("folder_id")
    .eq("id", accessId)
    .maybeSingle();
  if (error) throw error;
  if (!data?.folder_id) return null;
  return getFolderCompanyId(data.folder_id);
}

const listFolderAccess = asyncHandler(async (req, res) => {
  const companyId = await getFolderCompanyId(req.params.id);
  if (!companyId) return res.status(404).json({ error: "Not found" });
  if (!permissionService.canAccessCompany(req.user, companyId)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const { data, error } = await supabase
    .from("folder_access")
    .select("*")
    .eq("folder_id", req.params.id)
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

const createFolderAccess = asyncHandler(async (req, res) => {
  const companyId = await getFolderCompanyId(req.params.id);
  if (!companyId) return res.status(404).json({ error: "Not found" });
  if (!permissionService.canAccessCompany(req.user, companyId)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const { user_id, group_id, can_read, can_write, can_download, created_by } = req.body || {};
  const resolvedCreatedBy = created_by || req.user?.id;
  if (!resolvedCreatedBy) return res.status(400).json({ error: "created_by required" });

  const { data, error } = await supabase
    .from("folder_access")
    .insert({
      folder_id: req.params.id,
      user_id: user_id || null,
      group_id: group_id || null,
      can_read: can_read ?? true,
      can_write: can_write ?? false,
      can_download: can_download ?? false,
      created_by: resolvedCreatedBy
    })
    .select("*")
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

const updateFolderAccess = asyncHandler(async (req, res) => {
  const companyId = await getAccessCompanyId(req.params.id);
  if (!companyId) return res.status(404).json({ error: "Not found" });
  if (!permissionService.canAccessCompany(req.user, companyId)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const body = req.body || {};
  if (Object.keys(body).length === 0) return res.status(400).json({ error: "No updates" });

  const { data, error } = await supabase
    .from("folder_access")
    .update(body)
    .eq("id", req.params.id)
    .select("*")
    .single();

  if (error) return res.status(404).json({ error: "Not found" });
  res.json(data);
});

const deleteFolderAccess = asyncHandler(async (req, res) => {
  const companyId = await getAccessCompanyId(req.params.id);
  if (!companyId) return res.status(404).json({ error: "Not found" });
  if (!permissionService.canAccessCompany(req.user, companyId)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const { error } = await supabase.from("folder_access").delete().eq("id", req.params.id);
  if (error) return res.status(404).json({ error: "Not found" });
  res.status(204).send();
});

module.exports = { listFolderAccess, createFolderAccess, updateFolderAccess, deleteFolderAccess };
