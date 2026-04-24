const db = require("../db");
const asyncHandler = require("../utils");
const { buildUploadContentUrl } = require("../utils/uploadStorage");
const { ensureCompanyDefaultFolders, ensureRootUploadFolder } = require("../utils/defaultFolders");

const listFolders = asyncHandler(async (req, res) => {
  await ensureCompanyDefaultFolders(req.params.id, req.user?.id || null);
  const { rows } = await db.query(
    "SELECT * FROM folders WHERE company_id = $1 ORDER BY created_at DESC",
    [req.params.id]
  );
  res.json(rows);
});

const listFolderTree = asyncHandler(async (req, res) => {
  await ensureCompanyDefaultFolders(req.params.id, req.user?.id || null);
  const { rows } = await db.query(
    "SELECT * FROM folders WHERE company_id = $1 ORDER BY created_at ASC",
    [req.params.id]
  );

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
  res.json(roots);
});

const createFolder = asyncHandler(async (req, res) => {
  const { parent_id, name, color, created_by } = req.body || {};
  if (!name || !created_by) return res.status(400).json({ error: "name and created_by required" });

  const { rows } = await db.query(
    "INSERT INTO folders (company_id, parent_id, name, color, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *",
    [req.params.id, parent_id || null, name, color || null, created_by]
  );
  res.status(201).json(rows[0]);
});

const updateFolder = asyncHandler(async (req, res) => {
  const { name, color } = req.body || {};
  const fields = [];
  const values = [];
  let idx = 1;

  if (name !== undefined) { fields.push(`name = $${idx++}`); values.push(name); }
  if (color !== undefined) { fields.push(`color = $${idx++}`); values.push(color); }

  if (fields.length === 0) return res.status(400).json({ error: "No updates" });

  values.push(req.params.id);
  const { rows } = await db.query(
    `UPDATE folders SET ${fields.join(", ")} WHERE id = $${idx} RETURNING *`,
    values
  );
  if (!rows[0]) return res.status(404).json({ error: "Not found" });
  res.json(rows[0]);
});

const deleteFolder = asyncHandler(async (req, res) => {
  const { rowCount } = await db.query("DELETE FROM folders WHERE id = $1", [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: "Not found" });
  res.status(204).send();
});

const moveFolder = asyncHandler(async (req, res) => {
  const { parent_id } = req.body || {};
  const { rows } = await db.query(
    "UPDATE folders SET parent_id = $1 WHERE id = $2 RETURNING *",
    [parent_id || null, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "Not found" });
  res.json(rows[0]);
});

const listFolderDocuments = asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    "SELECT * FROM documents WHERE folder_id = $1 ORDER BY uploaded_at DESC",
    [req.params.id]
  );
  res.json(rows);
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
    const uploadLookup = await db.query(
      "SELECT id FROM uploads WHERE id = $1",
      [resolvedUploadId]
    );
    if (!uploadLookup.rows?.[0]) {
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

  const { rows } = await db.query(
    `INSERT INTO documents (company_id, folder_id, name, file_url, upload_id, size, ext, status, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, ${db.isPostgres ? "$8::document_status" : "$8"}, $9)
     RETURNING *`,
    [company_id, targetFolderId, name, resolvedFileUrl, resolvedUploadId, size, ext, status, uploaded_by]
  );
  res.status(201).json({
    ...rows[0],
    folder_name: targetFolderId === req.params.id ? null : "General Uploads",
  });
});

const deleteDocument = asyncHandler(async (req, res) => {
  const existing = await db.query("SELECT upload_id FROM documents WHERE id = $1", [req.params.id]);
  const document = existing.rows?.[0];
  if (!document) return res.status(404).json({ error: "Not found" });

  await db.query("DELETE FROM documents WHERE id = $1", [req.params.id]);

  if (document.upload_id) {
    const linked = await db.query("SELECT id FROM documents WHERE upload_id = $1 LIMIT 1", [document.upload_id]);
    if (!linked.rows?.[0]) {
      await db.query("DELETE FROM uploads WHERE id = $1", [document.upload_id]);
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
