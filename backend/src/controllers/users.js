const bcrypt = require("bcryptjs");
const db = require("../db");
const asyncHandler = require("../utils");

const userSelect = `
  SELECT
    u.id,
    u.name,
    u.email,
    u.phone,
    u.role,
    u.company_id,
    c.name AS company_name,
    u.status,
    u.created_at,
    u.updated_at
  FROM users u
  LEFT JOIN companies c ON c.id = u.company_id
`;

const listUsers = asyncHandler(async (req, res) => {
  const rows = await db.query(
    `${userSelect}
     ORDER BY u.created_at DESC`
  );
  res.json(rows);
});

const createUser = asyncHandler(async (req, res) => {
  const { name, email, phone, password, role, company_id, status } = req.body || {};
  if (!name || !email || !password || !role) {
    return res.status(400).json({ error: "name, email, password, role required" });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  await db.query(
    `INSERT INTO users (name, email, phone, password_hash, role, company_id, status)
     VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, 'active'))`,
    [name, email, phone || null, passwordHash, role, company_id || null, status || null]
  );

  // Get the created user
  const created = await db.query(
    `${userSelect}
     WHERE u.id = last_insert_rowid()`
  );

  res.status(201).json(created[0]);
});

const getUser = asyncHandler(async (req, res) => {
  const rows = await db.query(
    `${userSelect}
     WHERE u.id = ?`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "Not found" });
  res.json(rows[0]);
});

const updateUser = asyncHandler(async (req, res) => {
  const { name, email, phone, password, role, company_id, status } = req.body || {};
  const fields = [];
  const values = [];

  if (name !== undefined) { fields.push(`name = ?`); values.push(name); }
  if (email !== undefined) { fields.push(`email = ?`); values.push(email); }
  if (phone !== undefined) { fields.push(`phone = ?`); values.push(phone); }
  if (role !== undefined) { fields.push(`role = ?`); values.push(role); }
  if (company_id !== undefined) { fields.push(`company_id = ?`); values.push(company_id); }
  if (status !== undefined) { fields.push(`status = ?`); values.push(status); }
  if (password !== undefined) {
    const passwordHash = await bcrypt.hash(password, 10);
    fields.push(`password_hash = ?`);
    values.push(passwordHash);
  }

  if (fields.length === 0) return res.status(400).json({ error: "No updates" });

  values.push(new Date().toISOString());
  values.push(req.params.id);

  const result = await db.query(
    `UPDATE users SET ${fields.join(", ")}, updated_at = ? WHERE id = ?`,
    values
  );

  if (result.length === 0) return res.status(404).json({ error: "Not found" });

  const updated = await db.query(
    `${userSelect}
     WHERE u.id = ?`,
    [req.params.id]
  );

  res.json(updated[0]);
});

const deleteUser = asyncHandler(async (req, res) => {
  const result = await db.query("SELECT id FROM users WHERE id = ?", [req.params.id]);
  if (result.length === 0) return res.status(404).json({ error: "Not found" });

  await db.query("DELETE FROM users WHERE id = ?", [req.params.id]);
  res.status(204).send();
});

module.exports = { listUsers, createUser, getUser, updateUser, deleteUser };
