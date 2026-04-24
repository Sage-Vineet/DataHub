const db = require("../db");
const bcrypt = require("bcryptjs");
const asyncHandler = require("../utils");
const { ensureCompanyDefaultFolders } = require("../utils/defaultFolders");
const CLIENT_STATIC_PASSWORD = process.env.CLIENT_STATIC_PASSWORD || "123456";

function rowsOf(result) {
  if (!result) return [];
  return Array.isArray(result) ? result : result.rows || [];
}

function enumAssignment(column, typeName) {
  return db.isPostgres ? `${column} = ?::${typeName}` : `${column} = ?`;
}

async function syncCompanyClientRepresentative(company, previousCompany = null) {
  if (!company?.id || !company.contact_email || !company.contact_name) return;

  const normalizedEmail = String(company.contact_email).trim().toLowerCase();
  if (!normalizedEmail) return;

  const previousNormalizedEmail = String(previousCompany?.contact_email || "").trim().toLowerCase();

  let existingUser = null;

  if (
    previousCompany?.id
    && previousNormalizedEmail
    && previousNormalizedEmail !== normalizedEmail
  ) {
    const previousContactUsers = rowsOf(await db.query(
      `SELECT id, role
       FROM users
       WHERE company_id = ?
         AND role = 'buyer'
         AND lower(email) = ?
       LIMIT 1`,
      [previousCompany.id, previousNormalizedEmail],
    ));

    existingUser = previousContactUsers[0] || null;
  }

  if (!existingUser) {
    const existingUsers = rowsOf(await db.query(
      `SELECT id, role
       FROM users
       WHERE lower(email) = ?
       LIMIT 1`,
      [normalizedEmail],
    ));

    existingUser = existingUsers[0] || null;
  }

  if (existingUser && existingUser.role !== "buyer") {
    return existingUser.id;
  }

  if (existingUser) {
    await db.query(
      `UPDATE users
       SET name = ?, email = ?, phone = ?, company_id = ?, status = 'active', updated_at = ?
       WHERE id = ?`,
      [
        company.contact_name,
        normalizedEmail,
        company.contact_phone || null,
        company.id,
        new Date().toISOString(),
        existingUser.id,
      ],
    );

    await db.query(
      "INSERT INTO user_companies (user_id, company_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
      [existingUser.id, company.id],
    );
    return;
  }

  const passwordHash = await bcrypt.hash(CLIENT_STATIC_PASSWORD, 10);
  const inserted = rowsOf(await db.query(
    `INSERT INTO users (name, email, phone, password_hash, role, company_id, status)
     VALUES (?, ?, ?, ?, ${db.isPostgres ? "'buyer'::user_role" : "'buyer'"}, ?, ${db.isPostgres ? "'active'::user_status" : "'active'"})
     RETURNING id`,
    [
      company.contact_name,
      normalizedEmail,
      company.contact_phone || null,
      passwordHash,
      company.id,
    ],
  ));

  const createdUserId = inserted[0]?.id;
  if (createdUserId) {
    await db.query(
      "INSERT INTO user_companies (user_id, company_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
      [createdUserId, company.id],
    );
  }

  return createdUserId || null;
}

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
     VALUES (?, ?, ${db.isPostgres ? "?::company_status" : "?"}, ?, ?, ?, ?, ?)
     RETURNING *`,
    [name, industry, status || "active", since || null, logo || null, contact_name, contact_email, contact_phone]
  );

  const inserted = rows[0];
  const clientRepresentativeId = inserted ? await syncCompanyClientRepresentative(inserted) : null;
  if (inserted) {
    await ensureCompanyDefaultFolders(inserted.id, req.user?.id || clientRepresentativeId || null);
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
  const body = req.body || {};

  const currentRows = rowsOf(await db.query("SELECT * FROM companies WHERE id = ?", [req.params.id]));
  const existingCompany = currentRows[0];
  if (!existingCompany) return res.status(404).json({ error: "Not found" });

  Object.keys(body).forEach((key) => {
    if (key === "status") {
      fields.push(enumAssignment(key, "company_status"));
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
  const clientRepresentativeId = await syncCompanyClientRepresentative(rows[0], existingCompany);
  await ensureCompanyDefaultFolders(rows[0].id, req.user?.id || clientRepresentativeId || null);
  res.json(rows[0]);
});

module.exports = { listCompanies, createCompany, getCompany, updateCompany };
