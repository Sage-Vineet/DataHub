const db = require("../db");
const asyncHandler = require("../utils");

const DEFAULT_FOLDER_STRUCTURE = [
  { name: "Finance", children: ["Q3 Reports"] },
  { name: "Legal", children: ["Contracts"] },
  { name: "HR & People" },
  { name: "Tax" },
  { name: "M&A" },
  { name: "Compliance" },
];

const createDefaultFolders = async (companyId, createdBy) => {
  for (const folder of DEFAULT_FOLDER_STRUCTURE) {
    const { rows: parentRows } = await db.query(
      "INSERT INTO folders (company_id, parent_id, name, color, created_by) VALUES (?, ?, ?, ?, ?) RETURNING *",
      [companyId, null, folder.name, null, createdBy]
    );

    const parent = parentRows[0];
    if (folder.children && folder.children.length) {
      for (const childName of folder.children) {
        await db.query(
          "INSERT INTO folders (company_id, parent_id, name, color, created_by) VALUES (?, ?, ?, ?, ?) RETURNING *",
          [companyId, parent.id, childName, null, createdBy]
        );
      }
    }
  }
};

const listCompanies = asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT
       c.*,
       COUNT(r.id) AS request_count,
       COUNT(CASE WHEN r.status = 'pending' THEN 1 END) AS pending_request_count,
       COUNT(CASE WHEN r.status = 'completed' THEN 1 END) AS completed_request_count
     FROM companies c
     LEFT JOIN requests r ON r.company_id = c.id
     GROUP BY c.id
     ORDER BY c.created_at DESC`
  );
  res.json(rows);
});

const createCompany = asyncHandler(async (req, res) => {
  const {
    name,
    industry,
    status,
    since,
    logo,
    contact_name,
    contact_email,
    contact_phone,
  } = req.body || {};

  if (!name || !industry || !contact_name || !contact_email || !contact_phone) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const { rows } = await db.query(
    `INSERT INTO companies (name, industry, status, since, logo, contact_name, contact_email, contact_phone)
     VALUES (?, ?, CAST(COALESCE(?, 'active') AS company_status), ?, ?, ?, ?, ?)
     RETURNING *`,
    [name, industry, status || null, since || null, logo || null, contact_name, contact_email, contact_phone]
  );

  const inserted = rows[0];
  const createdBy = req.user?.id;
  if (inserted && createdBy) {
    await createDefaultFolders(inserted.id, createdBy);
  }

  res.status(201).json(inserted);
});

const getCompany = asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT
       c.*,
       COUNT(r.id) AS request_count,
       COUNT(CASE WHEN r.status = 'pending' THEN 1 END) AS pending_request_count,
       COUNT(CASE WHEN r.status = 'completed' THEN 1 END) AS completed_request_count
     FROM companies c
     LEFT JOIN requests r ON r.company_id = c.id
     WHERE c.id = ?
     GROUP BY c.id`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "Not found" });
  res.json(rows[0]);
});

const updateCompany = asyncHandler(async (req, res) => {
  const fields = [];
  const values = [];
  let idx = 1;
  const body = req.body || {};

  Object.keys(body).forEach((key) => {
    if (key === 'status') {
      fields.push(`${key} = CAST(? AS company_status)`);
    } else {
      fields.push(`${key} = ?`);
    }
    values.push(body[key]);
  });

  if (fields.length === 0) return res.status(400).json({ error: "No updates" });

  values.push(new Date().toISOString());
  values.push(req.params.id);

  await db.query(
    `UPDATE companies SET ${fields.join(", ")}, updated_at = ? WHERE id = ?`,
    values
  );

  // Get updated company
  const { rows } = await db.query("SELECT * FROM companies WHERE id = ?", [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "Not found" });
  res.json(rows[0]);
});

module.exports = { listCompanies, createCompany, getCompany, updateCompany };
