const { supabase } = require("../db");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");

let profilePool = null;

function getProfilePool() {
  if (!process.env.DATABASE_URL) return null;
  if (!profilePool) {
    profilePool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return profilePool;
}

// Base select — safe columns PostgREST always knows about.
const userSelect = `
  id,
  name,
  email,
  phone,
  role,
  company_id,
  status,
  created_at,
  updated_at,
  companies:company_id ( name )
`;

// Extended select with profile columns. Falls back to userSelect if the
// columns haven't been created yet (migration not yet run).
const userSelectWithProfile =
  userSelect.trimEnd() + `,\n  date_of_birth,\n  occupation,\n  address,\n  broker_company\n`;

async function selectUserRow(buildQuery) {
  let result = await buildQuery(userSelectWithProfile);
  if (result.error) result = await buildQuery(userSelect);
  return result;
}

async function getSqlProfileByEmail(email) {
  const normalizedEmail = String(email || "").trim();
  const pool = normalizedEmail ? getProfilePool() : null;
  if (!pool) return {};

  try {
    const { rows } = await pool.query(
      `
        select date_of_birth, occupation, address, broker_company
        from users
        where lower(email) = lower($1)
        limit 1
      `,
      [normalizedEmail]
    );
    return rows[0] || {};
  } catch (err) {
    console.warn("Profile SQL fallback read failed:", err.message);
    return {};
  }
}

async function mergeSqlProfile(user) {
  if (!user?.email) return user;
  if (
    user.date_of_birth !== undefined &&
    user.occupation !== undefined &&
    user.address !== undefined &&
    user.broker_company !== undefined
  ) {
    return user;
  }

  const profile = await getSqlProfileByEmail(user.email);
  return {
    ...user,
    date_of_birth: user.date_of_birth ?? profile.date_of_birth ?? null,
    occupation: user.occupation ?? profile.occupation ?? null,
    address: user.address ?? profile.address ?? null,
    broker_company: user.broker_company ?? profile.broker_company ?? null,
  };
}

async function updateSqlProfileByEmail(email, profileUpdates) {
  const normalizedEmail = String(email || "").trim();
  const pool = normalizedEmail ? getProfilePool() : null;
  const entries = Object.entries(profileUpdates).filter(([, value]) => value !== undefined);
  if (!pool || entries.length === 0) return false;

  const assignments = entries.map(([field], index) => `${field} = $${index + 2}`);
  const values = entries.map(([, value]) => value);

  const { rowCount } = await pool.query(
    `
      update users
      set ${assignments.join(", ")}, updated_at = now()
      where lower(email) = lower($1)
    `,
    [normalizedEmail, ...values]
  );

  return rowCount > 0;
}

/**
 * Flattens the user object to include company_name from the companies relation
 * @param {Object} user - User object from Supabase
 * @returns {Object} Flattened user object
 */
function flattenUser(user) {
  if (!user) return null;
  const flattened = {
    ...user,
    company_name: user.companies?.name || null
  };
  delete flattened.companies;
  return flattened;
}

/**
 * Attaches assigned companies and calculates effective role for users.
 * Supports both single user object and array of users.
 * @param {Object|Array} users - User or users to enrich
 * @returns {Promise<Object|Array>} Enriched user(s)
 */
async function attachAssignedCompanies(users) {
  const isSingle = !Array.isArray(users);
  const userList = isSingle ? [users] : users;
  
  if (!userList || !userList.length) return users;

  const userIds = userList.map((user) => user.id).filter(Boolean);
  if (!userIds.length) return users;

  const { data: assignments, error } = await supabase
    .from("user_companies")
    .select(`
      user_id,
      company_id,
      companies:company_id (
        id, name, industry, status, contact_email
      )
    `)
    .in("user_id", userIds);

  if (error) {
    console.error("❌ Error fetching assigned companies:", error.message);
    return users;
  }

  const byUserId = (assignments || []).reduce((map, uc) => {
    if (!uc.companies) return map;
    if (!map[uc.user_id]) map[uc.user_id] = [];
    map[uc.user_id].push(uc.companies);
    return map;
  }, {});

  const historicalBrokerCompaniesByUserId = await getHistoricalBrokerCompaniesByUserId(userList);
  for (const [userId, companies] of Object.entries(historicalBrokerCompaniesByUserId)) {
    if (!byUserId[userId]) byUserId[userId] = [];
    byUserId[userId].push(...companies);
  }

  const enriched = userList.map((user) => {
    const assignedCompanies = dedupeCompanies(byUserId[user.id] || []);
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

  return isSingle ? enriched[0] : enriched;
}

function dedupeCompanies(companies) {
  const byId = new Map();
  for (const company of companies || []) {
    if (!company?.id) continue;
    const existing = byId.get(String(company.id)) || {};
    byId.set(String(company.id), { ...existing, ...company });
  }
  return Array.from(byId.values());
}

async function getHistoricalBrokerCompaniesByUserId(userList) {
  const brokerIds = userList
    .filter((user) => String(user?.role || "").toLowerCase() === "broker")
    .map((user) => user.id)
    .filter(Boolean);

  if (!brokerIds.length) return {};

  const [folderRows, requestRows, documentRows, activityRows, reminderRows] = await Promise.all([
    getCompanyActorRows("folders", "created_by", brokerIds),
    getCompanyActorRows("requests", "created_by", brokerIds),
    getCompanyActorRows("documents", "uploaded_by", brokerIds),
    getCompanyActorRows("activity_log", "created_by", brokerIds),
    getCompanyActorRows("reminders", "created_by", brokerIds),
  ]);

  const companyIdsByUserId = {};
  for (const row of [...folderRows, ...requestRows, ...documentRows, ...activityRows, ...reminderRows]) {
    const userId = row.created_by || row.uploaded_by;
    if (!userId || !row.company_id) continue;
    if (!companyIdsByUserId[userId]) companyIdsByUserId[userId] = new Set();
    companyIdsByUserId[userId].add(String(row.company_id));
  }

  const allCompanyIds = Array.from(new Set(
    Object.values(companyIdsByUserId).flatMap((set) => Array.from(set)),
  ));
  if (!allCompanyIds.length) return {};

  const { data: companies, error } = await supabase
    .from("companies")
    .select("id, name, industry, status, contact_email, project_name")
    .in("id", allCompanyIds);

  if (error) {
    console.error("❌ Error fetching historical broker companies:", error.message);
    return {};
  }

  const companyById = new Map((companies || []).map((company) => [String(company.id), company]));
  return Object.fromEntries(
    Object.entries(companyIdsByUserId).map(([userId, companyIds]) => [
      userId,
      Array.from(companyIds).map((companyId) => companyById.get(companyId)).filter(Boolean),
    ]),
  );
}

async function getCompanyActorRows(table, actorColumn, brokerIds) {
  const { data, error } = await supabase
    .from(table)
    .select(`company_id, ${actorColumn}`)
    .in(actorColumn, brokerIds)
    .limit(1000);

  if (error) {
    console.error(`❌ Error fetching ${table} broker company links:`, error.message);
    return [];
  }
  return data || [];
}

/**
 * Normalizes company IDs into a unique array of strings
 * @param {string} companyId - Primary company ID
 * @param {Array} companyIds - Additional company IDs
 * @returns {Array<string>} Unique company IDs
 */
function normalizeCompanyIds(companyId, companyIds) {
  const ids = Array.isArray(companyIds) ? companyIds : [];
  return Array.from(new Set([companyId, ...ids].filter(Boolean).map(String)));
}

/**
 * Extracts all unique company IDs associated with a user
 * @param {Object} user - User object
 * @returns {Array<string>} Unique company IDs
 */
function getUserCompanyIds(user) {
  const ids = [
    ...(user?.company_ids || []),
    ...((user?.assigned_companies || []).map((c) => c.id)),
    user?.company_id,
    user?.companyId
  ];
  return Array.from(new Set(ids.filter(Boolean).map(String)));
}

function normalizeOptionalText(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = String(value).trim();
  return trimmed || null;
}

function normalizePhone(value) {
  const normalized = normalizeOptionalText(value);
  if (!normalized) return normalized;

  const digits = normalized.replace(/\D/g, "");
  const validShape = /^\+?[0-9][0-9\s().-]{6,19}$/.test(normalized);
  if (!validShape || digits.length < 7 || digits.length > 15) {
    const err = new Error("Please enter a valid phone number.");
    err.status = 400;
    throw err;
  }
  return normalized;
}

function normalizeDateOfBirth(value) {
  const normalized = normalizeOptionalText(value);
  if (!normalized) return normalized;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    const err = new Error("Please enter a valid date of birth.");
    err.status = 400;
    throw err;
  }

  const date = new Date(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== normalized) {
    const err = new Error("Please enter a valid date of birth.");
    err.status = 400;
    throw err;
  }

  const today = new Date();
  const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  if (date > todayUtc) {
    const err = new Error("Date of birth cannot be in the future.");
    err.status = 400;
    throw err;
  }

  return normalized;
}

async function passwordMatches(candidate, storedPassword) {
  if (!storedPassword) return false;
  if (candidate === storedPassword) return true;
  if (/^\$2[aby]\$/.test(storedPassword)) {
    try {
      return await bcrypt.compare(candidate, storedPassword);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Checks if a user has access to a specific company
 * @param {Object} user - Authenticated user
 * @param {string} companyId - Company ID to check
 * @returns {boolean}
 */
function canAccessCompany(user, companyId) {
  const role = String(user?.role || "").toLowerCase();
  if (role === "admin") return true;
  return getUserCompanyIds(user).includes(String(companyId));
}

function isAdmin(user) {
  return String(user?.role || "").toLowerCase() === "admin";
}

function isBroker(user) {
  return ["broker", "admin"].includes(String(user?.role || "").toLowerCase());
}

/**
 * Syncs user company assignments in the join table
 * @param {string} userId - User ID
 * @param {Array<string>} companyIds - Array of company IDs
 */
async function syncUserCompanies(userId, companyIds) {
  if (!userId) return;

  // Delete existing
  await supabase.from("user_companies").delete().eq("user_id", userId);
  
  if (companyIds && companyIds.length > 0) {
    const records = companyIds.map(cid => ({ user_id: userId, company_id: cid }));
    await supabase.from("user_companies").upsert(records, { onConflict: "user_id,company_id" });
  }
}

/**
 * Gets a user by ID with enriched company data
 * @param {string} id - User ID
 * @returns {Promise<Object|null>} Enriched user object
 */
async function getUserById(id) {
  if (!id) return null;
  const { data, error } = await selectUserRow((sel) =>
    supabase.from("users").select(sel).eq("id", id).maybeSingle()
  );
  if (error || !data) return null;
  return await attachAssignedCompanies(await mergeSqlProfile(flattenUser(data)));
}

/**
 * Gets a user by email with enriched company data
 * @param {string} email - User email
 * @returns {Promise<Object|null>} Enriched user object
 */
async function getUserByEmail(email) {
  if (!email) return null;
  const { data, error } = await selectUserRow((sel) =>
    supabase.from("users").select(sel).eq("email", email).maybeSingle()
  );
  if (error || !data) return null;
  return await attachAssignedCompanies(await mergeSqlProfile(flattenUser(data)));
}

/**
 * Resolves a replacement user ID for records belonging to a user about to be deleted.
 * @param {string} preferredUserId - The user ID to prefer (usually the requester)
 * @param {Object} userToDelete - The user object being deleted
 * @returns {Promise<string|null>}
 */
async function resolveReplacementUserId(preferredUserId, userToDelete) {
  if (preferredUserId && String(preferredUserId) !== String(userToDelete?.id)) {
    return preferredUserId;
  }

  const companyIds = Array.from(new Set([
    userToDelete?.company_id,
    ...(userToDelete?.company_ids || []),
  ].filter(Boolean).map(String)));

  if (companyIds.length > 0) {
    const { data: candidates, error } = await supabase
      .from("users")
      .select("id, role")
      .neq("id", userToDelete.id)
      .in("role", ["broker", "admin"])
      .or(`company_id.in.(${companyIds.join(",")})`)
      .order("created_at", { ascending: true });

    if (!error && candidates && candidates.length > 0) {
      const sorted = candidates.sort((a, b) => (a.role === "admin" ? -1 : 1));
      return sorted[0].id;
    }
  }

  const { data: globalCandidates, error: globalError } = await supabase
    .from("users")
    .select("id, role")
    .neq("id", userToDelete.id)
    .in("role", ["broker", "admin"])
    .order("created_at", { ascending: true });

  if (!globalError && globalCandidates && globalCandidates.length > 0) {
    const sorted = globalCandidates.sort((a, b) => (a.role === "admin" ? -1 : 1));
    return sorted[0].id;
  }

  return null;
}

/**
 * Reassigns all restricted user references from one user to another.
 * @param {string} userId - Original user ID
 * @param {string} replacementUserId - New user ID
 */
async function reassignUserRecords(userId, replacementUserId) {
  const tables = [
    { name: "requests", column: "created_by" },
    { name: "folders", column: "created_by" },
    { name: "documents", column: "uploaded_by" },
    { name: "request_narratives", column: "updated_by" },
    { name: "request_reminders", column: "sent_by" },
    { name: "folder_access", column: "created_by" },
    { name: "reminders", column: "created_by" },
    { name: "activity_log", column: "created_by" },
  ];

  for (const { name, column } of tables) {
    await supabase.from(name).update({ [column]: replacementUserId }).eq(column, userId);
  }
}

/**
 * Lists all users with enriched company data
 * @returns {Promise<Array>}
 */
async function listAllUsers(viewer = null) {
  let result = await supabase.from("users").select(userSelectWithProfile).order("created_at", { ascending: false });
  if (result.error) result = await supabase.from("users").select(userSelect).order("created_at", { ascending: false });
  const { data, error } = result;
  if (error) throw error;
  const flattened = await Promise.all((data || []).map((user) => mergeSqlProfile(flattenUser(user))));
  const enriched = await attachAssignedCompanies(flattened);

  if (!viewer || isAdmin(viewer)) return enriched;

  const viewerCompanyIds = new Set(getUserCompanyIds(viewer).map(String));
  if (isBroker(viewer)) {
    return enriched.filter((user) => {
      if (String(user.id) === String(viewer.id)) return true;
      if (isAdmin(user)) return false;
      return getUserCompanyIds(user).some((companyId) => viewerCompanyIds.has(String(companyId)));
    });
  }

  return enriched.filter((user) => String(user.id) === String(viewer.id));
}

/**
 * Creates a new user with company assignments
 * @param {Object} userData - User data
 * @returns {Promise<Object>} Created user
 */
async function createUser(userData) {
  const { name, email, phone, password, role, company_id, company_ids, status, created_by } = userData;
  const assignedCompanyIds = normalizeCompanyIds(company_id, company_ids);

  if (created_by && !isAdmin(created_by)) {
    const creatorCompanyIds = new Set(getUserCompanyIds(created_by).map(String));
    const invalidCompanyId = assignedCompanyIds.find((id) => !creatorCompanyIds.has(String(id)));
    if (invalidCompanyId) {
      const err = new Error("Cannot assign users to a company outside this broker account.");
      err.status = 403;
      throw err;
    }
  }

  const primaryCompanyId = company_id || assignedCompanyIds[0] || null;
  const passwordHash = password; // Plain text storage for debugging
  const resolvedStatus = status || "active";

  const { data: created, error } = await supabase
    .from("users")
    .insert({
      name,
      email,
      phone: phone || null,
      password_hash: passwordHash,
      role,
      company_id: primaryCompanyId,
      status: resolvedStatus
    })
    .select("id")
    .single();

  if (error) throw error;

  await syncUserCompanies(created.id, assignedCompanyIds);
  return await getUserById(created.id);
}

/**
 * Updates an existing user
 * @param {string} id - User ID
 * @param {Object} userData - Update data
 * @returns {Promise<Object>} Updated user
 */
async function updateUser(id, userData) {
  const {
    name, email, phone,
    date_of_birth, occupation, address, broker_company,
    password, current_password,
    role, company_id, company_ids, status,
  } = userData;

  const hasCompanyAssignments = company_id !== undefined || company_ids !== undefined;
  const assignedCompanyIds = hasCompanyAssignments ? normalizeCompanyIds(company_id, company_ids) : null;
  const now = new Date().toISOString();
  const normalizedPhone = phone !== undefined ? normalizePhone(phone) : undefined;
  const normalizedDob = date_of_birth !== undefined ? normalizeDateOfBirth(date_of_birth) : undefined;
  const normalizedOccupation = occupation !== undefined ? normalizeOptionalText(occupation) : undefined;
  const normalizedAddress = address !== undefined ? normalizeOptionalText(address) : undefined;
  const normalizedBrokerCompany = broker_company !== undefined ? normalizeOptionalText(broker_company) : undefined;

  // ── Core updates (always-safe columns) ──────────────────────────────────
  const coreUpdates = {};
  if (name !== undefined) coreUpdates.name = name;
  if (email !== undefined) coreUpdates.email = email;
  if (phone !== undefined) coreUpdates.phone = normalizedPhone;
  if (role !== undefined) coreUpdates.role = role;
  if (status !== undefined) coreUpdates.status = status;
  if (hasCompanyAssignments) coreUpdates.company_id = company_id || assignedCompanyIds[0] || null;

  if (password !== undefined) {
    const nextPassword = String(password || "");
    if (!nextPassword) {
      const err = new Error("Please enter a new password.");
      err.status = 400;
      throw err;
    }
    if (nextPassword.length < 6) {
      const err = new Error("New password must be at least 6 characters.");
      err.status = 400;
      throw err;
    }
    if (current_password !== undefined) {
      const currentPassword = String(current_password || "");
      if (!currentPassword) {
        const err = new Error("Please enter your current password.");
        err.status = 400;
        throw err;
      }

      const { data: authData } = await supabase
        .from("users").select("email, password_hash").eq("id", id).single();

      const storedHash = authData?.password_hash ?? "";
      const matchesDb = await passwordMatches(currentPassword, storedHash);

      if (!matchesDb) {
        const err = new Error("Current password is incorrect.");
        err.status = 400;
        throw err;
      }
    }
    coreUpdates.password_hash = await bcrypt.hash(nextPassword, 10);
  }

  if (Object.keys(coreUpdates).length > 0) {
    coreUpdates.updated_at = now;
    const { error } = await supabase.from("users").update(coreUpdates).eq("id", id);
    if (error) throw error;
  }

  // ── Profile updates via Supabase JS client ──────────────────────────────────
  const profileUpdates = {};
  if (date_of_birth   !== undefined) profileUpdates.date_of_birth   = normalizedDob;
  if (occupation      !== undefined) profileUpdates.occupation      = normalizedOccupation;
  if (address         !== undefined) profileUpdates.address         = normalizedAddress;
  if (broker_company  !== undefined) profileUpdates.broker_company  = normalizedBrokerCompany;

  if (Object.keys(profileUpdates).length > 0) {
    const { error: profileErr } = await supabase
      .from("users").update({ ...profileUpdates, updated_at: now }).eq("id", id);
    if (profileErr) {
      const isColumnMissing = profileErr.code === "42703" || profileErr.message?.toLowerCase().includes("column");
      if (isColumnMissing) {
        const { data: userIdentity, error: identityErr } = await supabase
          .from("users").select("email").eq("id", id).maybeSingle();
        if (identityErr || !userIdentity?.email) throw profileErr;

        const updated = await updateSqlProfileByEmail(userIdentity.email, profileUpdates);
        if (!updated) {
          const err = new Error("Profile fields could not be saved for this broker account.");
          err.status = 500;
          throw err;
        }
      } else {
        throw profileErr;
      }
    }
  }

  if (hasCompanyAssignments) {
    await syncUserCompanies(id, assignedCompanyIds);
  }

  return await getUserById(id);
}

module.exports = {
  supabase,
  userSelect,
  flattenUser,
  attachAssignedCompanies,
  normalizeCompanyIds,
  getUserCompanyIds,
  canAccessCompany,
  isAdmin,
  isBroker,
  syncUserCompanies,
  getUserById,
  getUserByEmail,
  listAllUsers,
  createUser,
  updateUser,
  resolveReplacementUserId,
  reassignUserRecords
};
