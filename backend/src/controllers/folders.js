const { supabase } = require("../db");
const asyncHandler = require("../utils");
const { buildUploadContentUrl } = require("../utils/uploadStorage");
const { ensureCompanyDefaultFolders, ensureRootUploadFolder } = require("../utils/defaultFolders");

const listFolders = asyncHandler(async (req, res) => {
  await ensureCompanyDefaultFolders(req.params.id, req.user?.id || null);
  const { data, error } = await supabase
    .from("folders")
    .select("*")
    .eq("company_id", req.params.id)
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

const listFolderTree = asyncHandler(async (req, res) => {
  await ensureCompanyDefaultFolders(req.params.id, req.user?.id || null);
  const { data: rows, error } = await supabase
    .from("folders")
    .select("*")
    .eq("company_id", req.params.id)
    .order("created_at", { ascending: true });

  if (error) return res.status(500).json({ error: error.message });

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

  const sortTree = (nodes) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name));
    for (const node of nodes) sortTree(node.children);
  };

  sortTree(roots);
  res.json(roots);
});

const createFolder = asyncHandler(async (req, res) => {
  const { parent_id, name, color, created_by } = req.body || {};
  if (!name || !created_by) return res.status(400).json({ error: "name and created_by required" });

  const { data, error } = await supabase
    .from("folders")
    .insert({
      company_id: req.params.id,
      parent_id: parent_id || null,
      name,
      color: color || null,
      created_by
    })
    .select("*")
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

const updateFolder = asyncHandler(async (req, res) => {
  const { name, color } = req.body || {};
  const updates = {};
  if (name !== undefined) updates.name = name;
  if (color !== undefined) updates.color = color;

  if (Object.keys(updates).length === 0) return res.status(400).json({ error: "No updates" });

  const { data, error } = await supabase
    .from("folders")
    .update(updates)
    .eq("id", req.params.id)
    .select("*")
    .single();

  if (error) return res.status(404).json({ error: "Not found" });
  res.json(data);
});

const deleteFolder = asyncHandler(async (req, res) => {
  const { error } = await supabase.from("folders").delete().eq("id", req.params.id);
  if (error) return res.status(404).json({ error: "Not found" });
  res.status(204).send();
});

const moveFolder = asyncHandler(async (req, res) => {
  const { parent_id } = req.body || {};
  const { data, error } = await supabase
    .from("folders")
    .update({ parent_id: parent_id || null })
    .eq("id", req.params.id)
    .select("*")
    .single();

  if (error) return res.status(404).json({ error: "Not found" });
  res.json(data);
});

const listFolderDocuments = asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from("documents")
    .select("*")
    .eq("folder_id", req.params.id)
    .order("uploaded_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

const addFolderDocument = asyncHandler(async (req, res) => {
  const {
    name,
    file_url,
    upload_id,
    size,
    ext,
    status,
    uploaded_by,
    company_id,
  } = req.body || {};

  if (!name || !size || !ext || !status || !uploaded_by || !company_id) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  let resolvedUploadId = upload_id || null;
  let resolvedFileUrl = file_url || null;

  if (resolvedUploadId) {
    const { data: uploadLookup } = await supabase
      .from("uploads")
      .select("id")
      .eq("id", resolvedUploadId)
      .maybeSingle();

    if (!uploadLookup) {
      return res.status(400).json({ error: "upload_id is invalid" });
    }
    resolvedFileUrl = resolvedFileUrl || buildUploadContentUrl(req, resolvedUploadId);
  }

  if (!resolvedFileUrl) {
    return res.status(400).json({ error: "file_url or upload_id required" });
  }

  let targetFolderId = req.params.id;
  if (targetFolderId === "root") {
    const uploadFolder = await ensureRootUploadFolder(company_id, uploaded_by || req.user?.id || null);
    if (!uploadFolder?.id) {
      return res.status(400).json({ error: "Unable to resolve a destination folder for root uploads" });
    }
    targetFolderId = uploadFolder.id;
  }

  const { data, error } = await supabase
    .from("documents")
    .insert({
      company_id,
      folder_id: targetFolderId,
      name,
      file_url: resolvedFileUrl,
      upload_id: resolvedUploadId,
      size,
      ext,
      status,
      uploaded_by
    })
    .select("*")
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({
    ...data,
    folder_name: targetFolderId === req.params.id ? null : "General Uploads",
  });
});

const deleteDocument = asyncHandler(async (req, res) => {
  const { data: document, error: findError } = await supabase
    .from("documents")
    .select("upload_id")
    .eq("id", req.params.id)
    .maybeSingle();

  if (findError || !document) return res.status(404).json({ error: "Not found" });

  await supabase.from("documents").delete().eq("id", req.params.id);

  if (document.upload_id) {
    const { data: linked } = await supabase
      .from("documents")
      .select("id")
      .eq("upload_id", document.upload_id)
      .limit(1)
      .maybeSingle();

    if (!linked) {
      await supabase.from("uploads").delete().eq("id", document.upload_id);
    }
  }

  res.status(204).send();
});

module.exports = {
  listFolders,
  createFolder,
  updateFolder,
  deleteFolder,
  moveFolder,
  listFolderDocuments,
  addFolderDocument,
  deleteDocument,
  listFolderTree,
};

