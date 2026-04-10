const db = require("../db");
const asyncHandler = require("../utils");

const listFolderAccess = asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    "SELECT * FROM folder_access WHERE folder_id = $1 ORDER BY created_at DESC",
    [req.params.id]
  );
  res.json(rows);
});

const createFolderAccess = asyncHandler(async (req, res) => {
  const { user_id, group_id, can_read, can_write, can_download, created_by } = req.body || {};
  const resolvedCreatedBy = created_by || req.user?.id;
  if (!resolvedCreatedBy) return res.status(400).json({ error: "created_by required" });

  const { rows } = await db.query(
    `INSERT INTO folder_access (folder_id, user_id, group_id, can_read, can_write, can_download, created_by)
     VALUES ($1, $2, $3, COALESCE($4, true), COALESCE($5, false), COALESCE($6, false), $7)
     RETURNING *`,
    [req.params.id, user_id || null, group_id || null, can_read, can_write, can_download, resolvedCreatedBy]
  );
  res.status(201).json(rows[0]);
});

const updateFolderAccess = asyncHandler(async (req, res) => {
  const fields = [];
  const values = [];
  let idx = 1;
  const body = req.body || {};

  Object.keys(body).forEach((key) => {
    fields.push(`${key} = $${idx++}`);
    values.push(body[key]);
  });

  if (fields.length === 0) return res.status(400).json({ error: "No updates" });

  values.push(req.params.id);
  const { rows } = await db.query(
    `UPDATE folder_access SET ${fields.join(", ")} WHERE id = $${idx} RETURNING *`,
    values
  );
  if (!rows[0]) return res.status(404).json({ error: "Not found" });
  res.json(rows[0]);
});

const deleteFolderAccess = asyncHandler(async (req, res) => {
  const { rowCount } = await db.query("DELETE FROM folder_access WHERE id = $1", [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: "Not found" });
  res.status(204).send();
});

module.exports = { listFolderAccess, createFolderAccess, updateFolderAccess, deleteFolderAccess };
