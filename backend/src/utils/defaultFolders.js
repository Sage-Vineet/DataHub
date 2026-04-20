const db = require("../db");

const DEFAULT_FOLDER_STRUCTURE = [
  { name: "Finance", children: ["Q3 Reports"] },
  { name: "Legal", children: ["Contracts"] },
  { name: "HR & People" },
  { name: "Tax" },
  { name: "M&A" },
  { name: "Compliance" },
];

function rowsOf(result) {
  if (!result) return [];
  return Array.isArray(result) ? result : result.rows || [];
}

async function userExists(userId) {
  if (!userId) return false;
  const rows = rowsOf(await db.query("SELECT id FROM users WHERE id = ? LIMIT 1", [userId]));
  return !!rows[0];
}

async function resolveFolderCreatorId(companyId, preferredCreatedBy) {
  if (await userExists(preferredCreatedBy)) return preferredCreatedBy;

  const companyUser = rowsOf(await db.query(
    `SELECT id
     FROM users
     WHERE company_id = ?
     ORDER BY created_at ASC
     LIMIT 1`,
    [companyId],
  ))[0];
  if (companyUser?.id) return companyUser.id;

  const assignedUser = rowsOf(await db.query(
    `SELECT uc.user_id AS id
     FROM user_companies uc
     WHERE uc.company_id = ?
     ORDER BY uc.created_at ASC
     LIMIT 1`,
    [companyId],
  ))[0];
  if (assignedUser?.id) return assignedUser.id;

  const brokerUser = rowsOf(await db.query(
    `SELECT id
     FROM users
     WHERE role IN ('admin', 'broker')
     ORDER BY created_at ASC
     LIMIT 1`,
  ))[0];
  return brokerUser?.id || null;
}

async function ensureCompanyDefaultFolders(companyId, preferredCreatedBy) {
  if (!companyId) return [];

  const existingRows = rowsOf(await db.query(
    "SELECT * FROM folders WHERE company_id = ? ORDER BY created_at ASC",
    [companyId],
  ));
  if (existingRows.length > 0) return existingRows;

  const creatorId = await resolveFolderCreatorId(companyId, preferredCreatedBy);
  if (!creatorId) return [];

  for (const folder of DEFAULT_FOLDER_STRUCTURE) {
    const parentRows = rowsOf(await db.query(
      "INSERT INTO folders (company_id, parent_id, name, color, created_by) VALUES (?, ?, ?, ?, ?) RETURNING *",
      [companyId, null, folder.name, null, creatorId],
    ));
    const parent = parentRows[0];

    if (parent && Array.isArray(folder.children)) {
      for (const childName of folder.children) {
        await db.query(
          "INSERT INTO folders (company_id, parent_id, name, color, created_by) VALUES (?, ?, ?, ?, ?)",
          [companyId, parent.id, childName, null, creatorId],
        );
      }
    }
  }

  return rowsOf(await db.query(
    "SELECT * FROM folders WHERE company_id = ? ORDER BY created_at ASC",
    [companyId],
  ));
}

async function ensureRootUploadFolder(companyId, preferredCreatedBy) {
  const existing = rowsOf(await db.query(
    `SELECT *
     FROM folders
     WHERE company_id = ? AND parent_id IS NULL AND lower(name) = lower(?)
     LIMIT 1`,
    [companyId, "General Uploads"],
  ))[0];
  if (existing) return existing;

  const creatorId = await resolveFolderCreatorId(companyId, preferredCreatedBy);
  if (!creatorId) return null;

  const created = rowsOf(await db.query(
    "INSERT INTO folders (company_id, parent_id, name, color, created_by) VALUES (?, ?, ?, ?, ?) RETURNING *",
    [companyId, null, "General Uploads", null, creatorId],
  ))[0];
  return created || null;
}

module.exports = {
  ensureCompanyDefaultFolders,
  ensureRootUploadFolder,
  resolveFolderCreatorId,
};
