const asyncHandler = require("../utils");
const userService = require("../services/userService");

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

const getUser = asyncHandler(async (req, res) => {
  const user = await userService.getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: "Not found" });
  res.json(user);
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

module.exports = { listUsers, createUser, getUser, updateUser, deleteUser };
