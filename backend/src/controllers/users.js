const asyncHandler = require("../utils");
const userService = require("../services/userService");
const { hasSupabaseCredentials } = require("../lib/supabaseClient");
const { invalidateUserCache } = require("../middleware/auth");

const localPublicUsers = [];

function canViewUser(requester, target) {
  if (!requester || !target) return false;
  if (String(requester.id) === String(target.id)) return true;
  const requesterRole = String(requester.role || "").toLowerCase();
  const requesterCompanyIds = new Set(userService.getUserCompanyIds(requester).map(String));
  const sharesCompany = userService.getUserCompanyIds(target).some((companyId) => requesterCompanyIds.has(String(companyId)));
  return requesterRole === "admin" || (requesterRole === "broker" && sharesCompany);
}

const listUsers = asyncHandler(async (req, res) => {
  const users = await userService.listAllUsers(req.user);
  res.json(users);
});

const createUser = asyncHandler(async (req, res) => {
  const { name, email, password, role } = req.body || {};
  if (!name || !email || !password || !role) {
    return res.status(400).json({ error: "name, email, password, role required" });
  }

  const requesterRole = String(req.user?.role || "").toLowerCase();
  if (!["broker", "admin"].includes(requesterRole)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  if (requesterRole !== "admin" && ["admin", "broker"].includes(String(role || "").toLowerCase())) {
    return res.status(403).json({ error: "Brokers can only create company user accounts." });
  }

  const user = await userService.createUser({ ...req.body, created_by: req.user });
  res.status(201).json(user);
});

const listPublicUsers = asyncHandler(async (_req, res) => {
  if (!hasSupabaseCredentials) {
    return res.json(localPublicUsers);
  }

  const users = await userService.listAllUsers(_req.user);

  const publicUsers = users.map((user) => ({
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    effective_role: user.effective_role,
    company_id: user.company_id,
    company_name: user.company_name,
    status: user.status,
    created_at: user.created_at,
    updated_at: user.updated_at,
  }));

  res.json(publicUsers);
});

const getUser = asyncHandler(async (req, res) => {
  const user = await userService.getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: "Not found" });
  if (!canViewUser(req.user, user)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  res.json(user);
});

const getPublicUser = asyncHandler(async (req, res) => {
  if (!hasSupabaseCredentials) {
    const user = localPublicUsers.find((entry) => entry.id === req.params.id);
    if (!user) return res.status(404).json({ error: "Not found" });
    return res.json(user);
  }

  const user = await userService.getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: "Not found" });
  if (!canViewUser(req.user, user)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const publicUser = {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    effective_role: user.effective_role,
    company_id: user.company_id,
    company_name: user.company_name,
    status: user.status,
    created_at: user.created_at,
    updated_at: user.updated_at,
  };

  res.json(publicUser);
});

const updateUser = asyncHandler(async (req, res) => {
  const requesterRole = String(req.user?.role || "").toLowerCase();
  const isSelf = String(req.user?.id || "") === String(req.params.id);
  const canManageUsers = ["broker", "admin"].includes(requesterRole);

  if (!isSelf && !canManageUsers) {
    return res.status(403).json({ error: "Forbidden" });
  }

  if (req.body?.current_password !== undefined && !isSelf) {
    return res.status(403).json({ error: "Current password changes can only be made for the signed-in account." });
  }

  if (!isSelf && requesterRole !== "admin") {
    const target = await userService.getUserById(req.params.id);
    if (!target) return res.status(404).json({ error: "Not found" });
    const requesterCompanyIds = new Set(userService.getUserCompanyIds(req.user).map(String));
    const sharesCompany = userService.getUserCompanyIds(target).some((companyId) => requesterCompanyIds.has(String(companyId)));
    if (!sharesCompany) return res.status(403).json({ error: "Forbidden" });
  }
  if (requesterRole !== "admin") {
    if (req.body?.role !== undefined && String(req.body.role || "").toLowerCase() !== "buyer") {
      return res.status(403).json({ error: "Brokers cannot change account roles." });
    }
    if (req.body?.company_id !== undefined || req.body?.company_ids !== undefined) {
      const requestedCompanyIds = userService.normalizeCompanyIds(req.body?.company_id, req.body?.company_ids);
      const requesterCompanyIds = new Set(userService.getUserCompanyIds(req.user).map(String));
      const invalidCompanyId = requestedCompanyIds.find((companyId) => !requesterCompanyIds.has(String(companyId)));
      if (invalidCompanyId) {
        return res.status(403).json({ error: "Cannot assign users to a company outside this broker account." });
      }
    }
  }

  let user;
  try {
    user = await userService.updateUser(req.params.id, req.body);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }
  if (!user) return res.status(404).json({ error: "Not found" });
  // Bust the 60-second auth cache so the next /auth/me returns fresh data
  invalidateUserCache(req.params.id);
  res.json(user);
});

const deleteUser = asyncHandler(async (req, res) => {
  const user = await userService.getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: "Not found" });
  const requesterRole = String(req.user?.role || "").toLowerCase();
  const requesterCompanyIds = new Set(userService.getUserCompanyIds(req.user).map(String));
  const sharesCompany = userService.getUserCompanyIds(user).some((companyId) => requesterCompanyIds.has(String(companyId)));
  if (requesterRole !== "admin" && !(requesterRole === "broker" && sharesCompany)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const replacementUserId = await userService.resolveReplacementUserId(req.user?.id, user);
  if (!replacementUserId) {
    return res.status(400).json({ error: "Unable to delete user because no replacement owner is available for their records." });
  }

  await userService.reassignUserRecords(user.id, replacementUserId);
  const { error } = await userService.supabase.from("users").delete().eq("id", req.params.id);
  
  if (error) return res.status(500).json({ error: error.message });
  res.status(204).send();
});

module.exports = { listUsers, listPublicUsers, createUser, getUser, getPublicUser, updateUser, deleteUser };
