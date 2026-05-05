const { supabase } = require("../db");
const asyncHandler = require("../utils");

const listFolderAccess = asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from("folder_access")
    .select("*")
    .eq("folder_id", req.params.id)
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

const createFolderAccess = asyncHandler(async (req, res) => {
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
  const { error } = await supabase.from("folder_access").delete().eq("id", req.params.id);
  if (error) return res.status(404).json({ error: "Not found" });
  res.status(204).send();
});

module.exports = { listFolderAccess, createFolderAccess, updateFolderAccess, deleteFolderAccess };

