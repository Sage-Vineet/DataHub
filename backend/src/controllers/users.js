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

function rowsOf(result) {
  if (!result) return [];
  return Array.isArray(result) ? result : result.rows || [];
}

function normalizeCompanyIds(companyId, companyIds) {
  const ids = Array.isArray(companyIds) ? companyIds : [];
  return Array.from(new Set([companyId, ...ids].filter(Boolean).map(String)));
}

async function attachAssignedCompanies(users) {
  if (!users.length) return users;

  const userIds = users.map((user) => user.id).filter(Boolean);
  if (!userIds.length) return users;

  const placeholders = userIds.map(() => "?").join(",");
  const assignments = rowsOf(await db.query(
    `SELECT uc.user_id, c.id, c.name, c.industry, c.status, c.contact_email
     FROM user_companies uc
     JOIN companies c ON c.id = uc.company_id
     WHERE uc.user_id IN (${placeholders})
     ORDER BY c.name ASC`,
    userIds
  ));

  const byUserId = assignments.reduce((map, company) => {
    if (!map[company.user_id]) map[company.user_id] = [];
    map[company.user_id].push({
      id: company.id,
      name: company.name,
      industry: company.industry,
      status: company.status,
      contact_email: company.contact_email,
    });
    return map;
  }, {});

  return users.map((user) => {
    const assignedCompanies = byUserId[user.id] || [];
    const hasPrimary = user.company_id && assignedCompanies.some((company) => String(company.id) === String(user.company_id));
    const normalizedCompanies = hasPrimary || !user.company_id
      ? assignedCompanies
      : [{ id: user.company_id, name: user.company_name }, ...assignedCompanies];
    const normalizedEmail = String(user.email || "").trim().toLowerCase();
    const isSeller = normalizedCompanies.some((company) => (
      String(company.contact_email || "").trim().toLowerCase() === normalizedEmail
    ));
    const effectiveRole = user.role === "buyer"
      ? (isSeller ? "client" : "user")
      : user.role;

    return {
      ...user,
      effective_role: effectiveRole,
      company_ids: normalizedCompanies.map((company) => company.id).filter(Boolean),
      assigned_companies: normalizedCompanies,
    };
  });
}

async function syncUserCompanies(userId, companyIds) {
  await db.query("DELETE FROM user_companies WHERE user_id = ?", [userId]);
  for (const companyId of companyIds) {
    await db.query(
      "INSERT INTO user_companies (user_id, company_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
      [userId, companyId]
    );
  }
}

async function getUserById(id) {
  const users = rowsOf(await db.query(`${userSelect} WHERE u.id = ?`, [id]));
  const enriched = await attachAssignedCompanies(users);
  return enriched[0] || null;
}

async function getUserByEmail(email) {
  const users = rowsOf(await db.query(`${userSelect} WHERE u.email = ?`, [email]));
  const enriched = await attachAssignedCompanies(users);
  return enriched[0] || null;
}

async function resolveReplacementUserId(preferredUserId, userToDelete) {
  if (preferredUserId && String(preferredUserId) !== String(userToDelete?.id)) {
    return preferredUserId;
  }

  const candidateParams = [];
  const companyFilters = [];
  const companyIds = Array.from(new Set([
    userToDelete?.company_id,
    ...(userToDelete?.company_ids || []),
  ].filter(Boolean).map(String)));

  if (companyIds.length) {
    const placeholders = companyIds.map(() => "?").join(",");
    companyFilters.push(`
      u.company_id IN (${placeholders})
      OR EXISTS (
        SELECT 1
        FROM user_companies uc
        WHERE uc.user_id = u.id
          AND uc.company_id IN (${placeholders})
      )
    `);
    candidateParams.push(...companyIds, ...companyIds);
  }

  const companyScopedCandidates = rowsOf(await db.query(
    `SELECT u.id
     FROM users u
     WHERE u.id != ?
       AND u.role IN ('broker', 'admin')
       ${companyFilters.length ? `AND (${companyFilters.join(" OR ")})` : ""}
     ORDER BY CASE WHEN u.role = 'admin' THEN 0 ELSE 1 END, u.created_at ASC
     LIMIT 1`,
    [userToDelete?.id, ...candidateParams],
  ));
  if (companyScopedCandidates[0]?.id) return companyScopedCandidates[0].id;

  const globalCandidates = rowsOf(await db.query(
    `SELECT id
     FROM users
     WHERE id != ?
       AND role IN ('broker', 'admin')
     ORDER BY CASE WHEN role = 'admin' THEN 0 ELSE 1 END, created_at ASC
     LIMIT 1`,
    [userToDelete?.id],
  ));
  return globalCandidates[0]?.id || null;
}

async function reassignRestrictedUserReferences(userId, replacementUserId) {
  const statements = [
    ["UPDATE requests SET created_by = ? WHERE created_by = ?", [replacementUserId, userId]],
    ["UPDATE folders SET created_by = ? WHERE created_by = ?", [replacementUserId, userId]],
    ["UPDATE documents SET uploaded_by = ? WHERE uploaded_by = ?", [replacementUserId, userId]],
    ["UPDATE request_narratives SET updated_by = ? WHERE updated_by = ?", [replacementUserId, userId]],
    ["UPDATE request_reminders SET sent_by = ? WHERE sent_by = ?", [replacementUserId, userId]],
    ["UPDATE folder_access SET created_by = ? WHERE created_by = ?", [replacementUserId, userId]],
    ["UPDATE reminders SET created_by = ? WHERE created_by = ?", [replacementUserId, userId]],
    ["UPDATE activity_log SET created_by = ? WHERE created_by = ?", [replacementUserId, userId]],
  ];

  for (const [sql, params] of statements) {
    await db.query(sql, params);
  }
}

const listUsers = asyncHandler(async (req, res) => {
  const users = rowsOf(await db.query(
    `${userSelect}
     ORDER BY u.created_at DESC`
  ));
  res.json(await attachAssignedCompanies(users));
});

const createUser = asyncHandler(async (req, res) => {
  const { name, email, phone, password, role, company_id, company_ids, status } = req.body || {};
  if (!name || !email || !password || !role) {
    return res.status(400).json({ error: "name, email, password, role required" });
  }

  const assignedCompanyIds = normalizeCompanyIds(company_id, company_ids);
  const primaryCompanyId = company_id || assignedCompanyIds[0] || null;
  const passwordHash = await bcrypt.hash(password, 10);
  await db.query(
    `INSERT INTO users (name, email, phone, password_hash, role, company_id, status)
     VALUES (?, ?, ?, ?, CAST(? AS user_role), ?, CAST(COALESCE(?, 'active') AS user_status))`,
    [name, email, phone || null, passwordHash, role, primaryCompanyId, status || null]
  );

  const created = await getUserByEmail(email);
  if (!created) return res.status(500).json({ error: "Unable to create user" });

  await syncUserCompanies(created.id, assignedCompanyIds);
  res.status(201).json(await getUserById(created.id));
});

const getUser = asyncHandler(async (req, res) => {
  const user = await getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: "Not found" });
  res.json(user);
});

const updateUser = asyncHandler(async (req, res) => {
  const { name, email, phone, password, role, company_id, company_ids, status } = req.body || {};
  const fields = [];
  const values = [];
  const hasCompanyAssignments = company_id !== undefined || company_ids !== undefined;
  const assignedCompanyIds = hasCompanyAssignments ? normalizeCompanyIds(company_id, company_ids) : null;

  if (name !== undefined) { fields.push(`name = ?`); values.push(name); }
  if (email !== undefined) { fields.push(`email = ?`); values.push(email); }
  if (phone !== undefined) { fields.push(`phone = ?`); values.push(phone); }
  if (role !== undefined) { fields.push(`role = CAST(? AS user_role)`); values.push(role); }
  if (hasCompanyAssignments) { fields.push(`company_id = ?`); values.push(company_id || assignedCompanyIds[0] || null); }
  if (status !== undefined) { fields.push(`status = CAST(? AS user_status)`); values.push(status); }
  if (password !== undefined) {
    const passwordHash = await bcrypt.hash(password, 10);
    fields.push(`password_hash = ?`);
    values.push(passwordHash);
  }

  if (fields.length === 0 && !hasCompanyAssignments) return res.status(400).json({ error: "No updates" });

  if (fields.length > 0) {
    values.push(new Date().toISOString());
    values.push(req.params.id);

    const result = await db.query(
      `UPDATE users SET ${fields.join(", ")}, updated_at = ? WHERE id = ?`,
      values
    );

    if (!result || result.rowCount === 0) return res.status(404).json({ error: "Not found" });
  }

  if (hasCompanyAssignments) {
    await syncUserCompanies(req.params.id, assignedCompanyIds);
  }

  const updated = await getUserById(req.params.id);
  if (!updated) return res.status(404).json({ error: "Not found" });
  res.json(updated);
});

const deleteUser = asyncHandler(async (req, res) => {
  const user = await getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: "Not found" });

  const replacementUserId = await resolveReplacementUserId(req.user?.id, user);
  if (!replacementUserId) {
    return res.status(400).json({ error: "Unable to delete user because no replacement owner is available for their records." });
  }

  await reassignRestrictedUserReferences(user.id, replacementUserId);
  await db.query("DELETE FROM users WHERE id = ?", [req.params.id]);
  res.status(204).send();
});

module.exports = { listUsers, createUser, getUser, updateUser, deleteUser };
