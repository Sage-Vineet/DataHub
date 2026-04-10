const db = require("../db");
const asyncHandler = require("../utils");

const listGroups = asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    "SELECT * FROM buyer_groups WHERE company_id = $1 ORDER BY created_at DESC",
    [req.params.id]
  );
  if (!rows.length) return res.json([]);

  const groupIds = rows.map((g) => g.id);
  const placeholders = groupIds.map((_, idx) => `$${idx + 1}`).join(',');
  const memberRows = await db.query(
    `SELECT group_id, user_id FROM buyer_group_members WHERE group_id IN (${placeholders})`,
    groupIds
  );
  const memberMap = {};
  memberRows.rows.forEach((row) => {
    if (!memberMap[row.group_id]) memberMap[row.group_id] = [];
    memberMap[row.group_id].push(row.user_id);
  });

  const enriched = rows.map((group) => ({
    ...group,
    member_ids: memberMap[group.id] || [],
    member_count: (memberMap[group.id] || []).length,
  }));

  res.json(enriched);
});

const createGroup = asyncHandler(async (req, res) => {
  const { name, description } = req.body || {};
  if (!name) return res.status(400).json({ error: "name required" });

  const { rows } = await db.query(
    "INSERT INTO buyer_groups (company_id, name, description) VALUES ($1, $2, $3) RETURNING *",
    [req.params.id, name, description || null]
  );
  res.status(201).json({ ...rows[0], member_ids: [], member_count: 0 });
});

const updateGroup = asyncHandler(async (req, res) => {
  const { name, description } = req.body || {};
  if (!name) return res.status(400).json({ error: "name required" });

  const { rows } = await db.query(
    "UPDATE buyer_groups SET name = $1, description = $2 WHERE id = $3 RETURNING *",
    [name, description || null, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "Not found" });
  res.json(rows[0]);
});

const deleteGroup = asyncHandler(async (req, res) => {
  const { rowCount } = await db.query("DELETE FROM buyer_groups WHERE id = $1", [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: "Not found" });
  res.status(204).send();
});

const addMember = asyncHandler(async (req, res) => {
  const { user_id } = req.body || {};
  if (!user_id) return res.status(400).json({ error: "user_id required" });

  const { rows } = await db.query(
    "INSERT INTO buyer_group_members (group_id, user_id) VALUES ($1, $2) RETURNING *",
    [req.params.id, user_id]
  );
  res.status(201).json(rows[0]);
});

const listGroupMembers = asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    "SELECT user_id, created_at FROM buyer_group_members WHERE group_id = $1 ORDER BY created_at DESC",
    [req.params.id]
  );
  res.json(rows);
});

const removeMember = asyncHandler(async (req, res) => {
  const { rowCount } = await db.query(
    "DELETE FROM buyer_group_members WHERE group_id = $1 AND user_id = $2",
    [req.params.id, req.params.userId]
  );
  if (!rowCount) return res.status(404).json({ error: "Not found" });
  res.status(204).send();
});

module.exports = { listGroups, createGroup, updateGroup, deleteGroup, addMember, listGroupMembers, removeMember };
