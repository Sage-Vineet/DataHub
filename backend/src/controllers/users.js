const asyncHandler = require("../utils");
const userService = require("../services/userService");
const { hasSupabaseCredentials } = require("../lib/supabaseClient");

const localPublicUsers = [
  {
    id: "demo-broker-1",
    name: "Rajesh Sharma",
    email: "broker@leo.com",
    phone: null,
    role: "broker",
    effective_role: "broker",
    company_id: "company-dataroom",
    company_name: "Dataroom",
    status: "active",
    created_at: null,
    updated_at: null,
  },
  {
    id: "demo-admin-1",
    name: "System Admin",
    email: "admin@datahub.com",
    phone: null,
    role: "admin",
    effective_role: "admin",
    company_id: "company-datahub",
    company_name: "DataHub",
    status: "active",
    created_at: null,
    updated_at: null,
  },
  {
    id: "demo-admin-2",
    name: "System Admin",
    email: "admin@leo.com",
    phone: null,
    role: "admin",
    effective_role: "admin",
    company_id: "company-datahub",
    company_name: "DataHub",
    status: "active",
    created_at: null,
    updated_at: null,
  },
  {
    id: "demo-buyer-1",
    name: "Demo User",
    email: "demo@leo.com",
    phone: null,
    role: "buyer",
    effective_role: "user",
    company_id: "company-demo",
    company_name: "Demo Company",
    status: "active",
    created_at: null,
    updated_at: null,
  },
  {
    id: "demo-client-1",
    name: "Ananya Mehta",
    email: "client@infosys.com",
    phone: null,
    role: "buyer",
    effective_role: "user",
    company_id: "company-infosys",
    company_name: "Infosys Ltd.",
    status: "active",
    created_at: null,
    updated_at: null,
  },
];

const listUsers = asyncHandler(async (req, res) => {
  const users = await userService.listAllUsers();
  res.json(users);
});

const createUser = asyncHandler(async (req, res) => {
  const { name, email, password, role } = req.body || {};
  if (!name || !email || !password || !role) {
    return res.status(400).json({ error: "name, email, password, role required" });
  }

  const user = await userService.createUser(req.body);
  res.status(201).json(user);
});

const listPublicUsers = asyncHandler(async (_req, res) => {
  if (!hasSupabaseCredentials) {
    return res.json(localPublicUsers);
  }

  const users = await userService.listAllUsers();

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
  const user = await userService.updateUser(req.params.id, req.body);
  if (!user) return res.status(404).json({ error: "Not found" });
  res.json(user);
});

const deleteUser = asyncHandler(async (req, res) => {
  const user = await userService.getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: "Not found" });

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
