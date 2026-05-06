const { supabase } = require("../db");
const bcrypt = require("bcryptjs");

/**
 * Standard user select fields for Supabase queries
 */
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

  const enriched = userList.map((user) => {
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

  return isSingle ? enriched[0] : enriched;
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

/**
 * Checks if a user has access to a specific company
 * @param {Object} user - Authenticated user
 * @param {string} companyId - Company ID to check
 * @returns {boolean}
 */
function canAccessCompany(user, companyId) {
  const role = String(user?.role || "").toLowerCase();
  if (["broker", "admin"].includes(role)) return true;
  return getUserCompanyIds(user).includes(String(companyId));
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

  const { data, error } = await supabase
    .from("users")
    .select(userSelect)
    .eq("id", id)
    .maybeSingle();

  if (error || !data) return null;
  
  return await attachAssignedCompanies(flattenUser(data));
}

/**
 * Gets a user by email with enriched company data
 * @param {string} email - User email
 * @returns {Promise<Object|null>} Enriched user object
 */
async function getUserByEmail(email) {
  if (!email) return null;

  const { data, error } = await supabase
    .from("users")
    .select(userSelect)
    .eq("email", email)
    .maybeSingle();

  if (error || !data) return null;
  
  return await attachAssignedCompanies(flattenUser(data));
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
async function listAllUsers() {
  const { data, error } = await supabase
    .from("users")
    .select(userSelect)
    .order("created_at", { ascending: false });

  if (error) throw error;
  
  const flattened = (data || []).map(flattenUser);
  return await attachAssignedCompanies(flattened);
}

/**
 * Creates a new user with company assignments
 * @param {Object} userData - User data
 * @returns {Promise<Object>} Created user
 */
async function createUser(userData) {
  const { name, email, phone, password, role, company_id, company_ids, status } = userData;
  const assignedCompanyIds = normalizeCompanyIds(company_id, company_ids);
  const primaryCompanyId = company_id || assignedCompanyIds[0] || null;
  const passwordHash = await bcrypt.hash(password, 10);
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
  const { name, email, phone, password, role, company_id, company_ids, status } = userData;
  const updates = {};
  const hasCompanyAssignments = company_id !== undefined || company_ids !== undefined;
  const assignedCompanyIds = hasCompanyAssignments ? normalizeCompanyIds(company_id, company_ids) : null;

  if (name !== undefined) updates.name = name;
  if (email !== undefined) updates.email = email;
  if (phone !== undefined) updates.phone = phone;
  if (role !== undefined) updates.role = role;
  if (hasCompanyAssignments) updates.company_id = company_id || assignedCompanyIds[0] || null;
  if (status !== undefined) updates.status = status;
  if (password !== undefined) {
    updates.password_hash = await bcrypt.hash(password, 10);
  }

  if (Object.keys(updates).length > 0) {
    updates.updated_at = new Date().toISOString();
    const { error } = await supabase.from("users").update(updates).eq("id", id);
    if (error) throw error;
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
  syncUserCompanies,
  getUserById,
  getUserByEmail,
  listAllUsers,
  createUser,
  updateUser,
  resolveReplacementUserId,
  reassignUserRecords
};
