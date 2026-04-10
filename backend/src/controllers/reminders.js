const db = require("../db");
const asyncHandler = require("../utils");

const listReminders = asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    "SELECT * FROM reminders WHERE company_id = $1 ORDER BY due_date ASC",
    [req.params.id]
  );
  res.json(rows);
});

const createReminder = asyncHandler(async (req, res) => {
  const { title, due_date, status, created_by } = req.body || {};
  if (!title || !due_date || !created_by) return res.status(400).json({ error: "Missing required fields" });

  const { rows } = await db.query(
    "INSERT INTO reminders (company_id, title, due_date, status, created_by) VALUES ($1, $2, $3, COALESCE($4, 'active'), $5) RETURNING *",
    [req.params.id, title, due_date, status || null, created_by]
  );
  res.status(201).json(rows[0]);
});

const updateReminder = asyncHandler(async (req, res) => {
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
    `UPDATE reminders SET ${fields.join(", ")} WHERE id = $${idx} RETURNING *`,
    values
  );
  if (!rows[0]) return res.status(404).json({ error: "Not found" });
  res.json(rows[0]);
});

const deleteReminder = asyncHandler(async (req, res) => {
  const { rowCount } = await db.query("DELETE FROM reminders WHERE id = $1", [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: "Not found" });
  res.status(204).send();
});

module.exports = { listReminders, createReminder, updateReminder, deleteReminder };
