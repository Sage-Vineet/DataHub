const asyncHandler = require("../utils");
const userService = require("../services/userService");
const { hasSupabaseCredentials } = require("../lib/supabaseClient");
const { invalidateUserCache } = require("../middleware/auth");
const { sendWelcomeEmail } = require("../services/emailService");
const { createWelcomeNotification } = require("../services/notificationService");

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
    return res.status(403).json({ error: "Only broker or admin accounts can create users." });
  }

  // Brokers cannot create top-level broker or admin accounts, BUT they are
  // allowed to create broker-team sub-roles (broker_team_member, banker,
  // loan_broker) which carry DB role = 'broker'.
  // Only block when role is 'broker' AND no recognised team sub_role is set.
  const { sub_role } = req.body || {};
  const BROKER_TEAM_SUB_ROLES = ["broker_team_member", "banker", "loan_broker"];
  const isBrokerTeamMember = BROKER_TEAM_SUB_ROLES.includes(String(sub_role || "").toLowerCase());

  if (requesterRole !== "admin" && String(role || "").toLowerCase() === "admin") {
    return res.status(403).json({ error: "Brokers cannot create admin accounts." });
  }
  if (requesterRole !== "admin" && String(role || "").toLowerCase() === "broker" && !isBrokerTeamMember) {
    return res.status(403).json({ error: "Brokers cannot create primary broker accounts. Use a broker team sub-role (broker_team_member, banker, loan_broker)." });
  }

  const user = await userService.createUser({ ...req.body, created_by: req.user });

  const now = new Date().toISOString();
  console.log(
    `[Audit] [User Creation] id=${user.id} email=${email} role=${role} ` +
      `created_by=${req.user?.id} (${req.user?.email}) at=${now}`
  );

  // Capture company names from the enriched user object for the email.
  const companyNames = (user.assigned_companies || [])
    .map((c) => c.name)
    .filter(Boolean);

  // Send welcome email — failure is non-fatal; user creation always succeeds.
  const emailResult = await sendWelcomeEmail({
    userId: user.id,
    userName: user.name || name,
    email: user.email || email,
    password,           // plain-text password from req.body, before it was hashed
    companyNames,
  });

  if (emailResult.sent) {
    console.log(
      `[Audit] [Email Service] Welcome email delivered email=${email} user=${user.id} at=${now}`
    );
  } else {
    console.warn(
      `[Audit] [Email Service] Welcome email NOT sent email=${email} user=${user.id} ` +
        `reason=${emailResult.reason || "unknown"} error=${emailResult.error || ""} at=${now}`
    );
  }

  // Create in-app notification — also non-fatal.
  const notificationResult = await createWelcomeNotification(user.id, req.user);

  if (notificationResult.created) {
    console.log(
      `[Audit] [Notification Service] Welcome notification created user=${user.id} at=${now}`
    );
  } else {
    console.warn(
      `[Audit] [Notification Service] Notification skipped user=${user.id} ` +
        `error=${notificationResult.error || ""} at=${now}`
    );
  }

  console.log(
    `[Audit] [Audit Trail] userCreated=true emailSent=${emailResult.sent} ` +
      `notificationCreated=${notificationResult.created} userId=${user.id} ` +
      `createdBy=${req.user?.id} at=${now}`
  );

  res.status(201).json({
    ...user,
    success: true,
    userCreated: true,
    emailSent: emailResult.sent,
    notificationCreated: notificationResult.created,
  });
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
    sub_role: user.sub_role || null,
    designation: user.designation || null,
    buyer_company_name: user.buyer_company_name || null,
    parent_user_id: user.parent_user_id || null,
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
    return res.status(403).json({ error: "You do not have permission to view this user's profile." });
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
    return res.status(403).json({ error: "You do not have permission to view this user's profile." });
  }

  const publicUser = {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    effective_role: user.effective_role,
    sub_role: user.sub_role || null,
    designation: user.designation || null,
    buyer_company_name: user.buyer_company_name || null,
    parent_user_id: user.parent_user_id || null,
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
    return res.status(403).json({ error: "You can only update your own profile or users in your company." });
  }

  if (req.body?.current_password !== undefined && !isSelf) {
    return res.status(403).json({ error: "Current password changes can only be made for the signed-in account." });
  }

  if (!isSelf && requesterRole !== "admin") {
    const target = await userService.getUserById(req.params.id);
    if (!target) return res.status(404).json({ error: "Not found" });
    const requesterCompanyIds = new Set(userService.getUserCompanyIds(req.user).map(String));
    const sharesCompany = userService.getUserCompanyIds(target).some((companyId) => requesterCompanyIds.has(String(companyId)));
    if (!sharesCompany) return res.status(403).json({ error: "You do not have permission to update users outside your company." });
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
    return res.status(403).json({ error: "Only admins or brokers sharing a company can delete users." });
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

const inviteBrokerToTeam = asyncHandler(async (req, res) => {
  const requesterRole = String(req.user?.role || "").toLowerCase();
  if (!["broker", "admin"].includes(requesterRole)) {
    return res.status(403).json({ error: "Only broker or admin can invite brokers." });
  }
  const { invited_broker_id } = req.body || {};
  if (!invited_broker_id) return res.status(400).json({ error: "invited_broker_id required" });

  const invitedUser = await userService.getUserById(invited_broker_id);
  if (!invitedUser) return res.status(404).json({ error: "Invited broker not found." });

  const invitedRole = String(invitedUser.role || "").toLowerCase();
  if (!["broker", "admin"].includes(invitedRole)) {
    return res.status(400).json({ error: "The invited user is not a broker account." });
  }
  if (String(invited_broker_id) === String(req.user.id)) {
    return res.status(400).json({ error: "Cannot invite yourself to your own team." });
  }

  await userService.inviteBrokerToTeam(req.user.id, invited_broker_id);
  res.status(201).json({ success: true });
});

const removeBrokerFromTeam = asyncHandler(async (req, res) => {
  const requesterRole = String(req.user?.role || "").toLowerCase();
  if (!["broker", "admin"].includes(requesterRole)) {
    return res.status(403).json({ error: "Only broker or admin can remove brokers from team." });
  }
  const invitedBrokerId = req.params.invitedBrokerId;
  if (!invitedBrokerId) return res.status(400).json({ error: "invitedBrokerId param required" });

  await userService.removeBrokerFromTeam(req.user.id, invitedBrokerId);
  res.status(204).send();
});

const findByEmail = asyncHandler(async (req, res) => {
  const email = String(req.query.email || '').trim();
  if (!email) return res.status(400).json({ error: "email query parameter required" });
  const user = await userService.getUserByEmail(email);
  if (!user) return res.status(404).json({ error: "No user found with that email." });
  res.json(user);
});

const addUserToCompanies = asyncHandler(async (req, res) => {
  const { company_ids } = req.body || {};
  if (!Array.isArray(company_ids) || !company_ids.length) {
    return res.status(400).json({ error: "company_ids array required" });
  }
  const requesterRole = String(req.user?.role || "").toLowerCase();
  if (!["broker", "admin"].includes(requesterRole)) {
    return res.status(403).json({ error: "Only broker or admin can perform this action." });
  }
  if (requesterRole !== "admin") {
    const requesterCompanyIds = new Set(userService.getUserCompanyIds(req.user).map(String));
    const invalid = company_ids.find((id) => !requesterCompanyIds.has(String(id)));
    if (invalid) return res.status(403).json({ error: "Cannot assign users to a company outside your account." });
  }
  const user = await userService.getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: "Not found" });
  await userService.addUserToCompanies(req.params.id, company_ids);
  const updated = await userService.getUserById(req.params.id);
  res.json(updated);
});

const removeUserFromCompanies = asyncHandler(async (req, res) => {
  const { company_ids } = req.body || {};
  if (!Array.isArray(company_ids) || !company_ids.length) {
    return res.status(400).json({ error: "company_ids array required" });
  }
  const requesterRole = String(req.user?.role || "").toLowerCase();
  if (!["broker", "admin"].includes(requesterRole)) {
    return res.status(403).json({ error: "Only broker or admin can perform this action." });
  }
  const user = await userService.getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: "Not found" });
  await userService.removeUserFromCompanies(req.params.id, company_ids);
  res.status(204).send();
});

module.exports = { listUsers, listPublicUsers, createUser, getUser, getPublicUser, updateUser, deleteUser, findByEmail, addUserToCompanies, removeUserFromCompanies, inviteBrokerToTeam, removeBrokerFromTeam };
