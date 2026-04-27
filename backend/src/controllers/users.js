const bcrypt = require("bcryptjs");
const { supabase } = require("../db");
const asyncHandler = require("../utils");

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

function flattenUser(user) {
  if (!user) return null;
  const flattened = {
    ...user,
    company_name: user.companies?.name
  };
  delete flattened.companies;
  return flattened;
}

function normalizeCompanyIds(companyId, companyIds) {
  const ids = Array.isArray(companyIds) ? companyIds : [];
  return Array.from(new Set([companyId, ...ids].filter(Boolean).map(String)));
}

async function attachAssignedCompanies(users) {
  if (!users || !users.length) return users || [];

  const userIds = users.map((user) => user.id).filter(Boolean);
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
  // Delete existing
  await supabase.from("user_companies").delete().eq("user_id", userId);
  
  if (companyIds && companyIds.length > 0) {
    const records = companyIds.map(cid => ({ user_id: userId, company_id: cid }));
    await supabase.from("user_companies").upsert(records, { onConflict: "user_id,company_id" });
  }
}

async function getUserById(id) {
  const { data, error } = await supabase
    .from("users")
    .select(userSelect)
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.error("❌ Error getting user by ID:", error.message);
    return null;
  }
  
  if (!data) return null;
  const enriched = await attachAssignedCompanies([flattenUser(data)]);
  return enriched[0];
}

async function getUserByEmail(email) {
  const { data, error } = await supabase
    .from("users")
    .select(userSelect)
    .eq("email", email)
    .maybeSingle();

  if (error) {
    console.error("❌ Error getting user by email:", error.message);
    return null;
  }

  if (!data) return null;
  const enriched = await attachAssignedCompanies([flattenUser(data)]);
  return enriched[0];
}

async function resolveReplacementUserId(preferredUserId, userToDelete) {
  if (preferredUserId && String(preferredUserId) !== String(userToDelete?.id)) {
    return preferredUserId;
  }

  const companyIds = Array.from(new Set([
    userToDelete?.company_id,
    ...(userToDelete?.company_ids || []),
  ].filter(Boolean).map(String)));

  if (companyIds.length > 0) {
    // Try to find a broker/admin in the same companies
    const { data: candidates, error } = await supabase
      .from("users")
      .select("id, role")
      .neq("id", userToDelete.id)
      .in("role", ["broker", "admin"])
      .or(`company_id.in.(${companyIds.join(",")})`) // Simplified, might need more complex logic for user_companies check
      .order("role", { ascending: true }) // 'admin' comes before 'broker' in alpha? No, we need custom logic
      .order("created_at", { ascending: true });

    if (!error && candidates && candidates.length > 0) {
      // Sort by role (admin first)
      const sorted = candidates.sort((a, b) => (a.role === "admin" ? -1 : 1));
      return sorted[0].id;
    }
  }

  // Fallback to global search
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

async function reassignRestrictedUserReferences(userId, replacementUserId) {
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

const listUsers = asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from("users")
    .select(userSelect)
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  const flattened = (data || []).map(flattenUser);
  res.json(await attachAssignedCompanies(flattened));
});

const createUser = asyncHandler(async (req, res) => {
  const { name, email, phone, password, role, company_id, company_ids, status } = req.body || {};
  if (!name || !email || !password || !role) {
    return res.status(400).json({ error: "name, email, password, role required" });
  }

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

  if (error) return res.status(500).json({ error: error.message });

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

  if (Object.keys(updates).length === 0 && !hasCompanyAssignments) {
    return res.status(400).json({ error: "No updates" });
  }

  if (Object.keys(updates).length > 0) {
    updates.updated_at = new Date().toISOString();
    const { error } = await supabase
      .from("users")
      .update(updates)
      .eq("id", req.params.id);

    if (error) return res.status(500).json({ error: error.message });
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
  const { error } = await supabase.from("users").delete().eq("id", req.params.id);
  
  if (error) return res.status(500).json({ error: error.message });
  res.status(204).send();
});

module.exports = { listUsers, createUser, getUser, updateUser, deleteUser };

