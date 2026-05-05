const { supabase } = require("../db");
const asyncHandler = require("../utils");

const listGroups = asyncHandler(async (req, res) => {
  const { data: groups, error: groupsError } = await supabase
    .from("buyer_groups")
    .select("id, company_id, name, description, created_at")
    .eq("company_id", req.params.id)
    .order("created_at", { ascending: false });

  if (groupsError) return res.status(500).json({ error: groupsError.message });
  if (!groups?.length) return res.json([]);

  const groupIds = groups.map((g) => g.id);
  const { data: members, error: membersError } = await supabase
    .from("buyer_group_members")
    .select("group_id, user_id")
    .in("group_id", groupIds);

  if (membersError) return res.status(500).json({ error: membersError.message });

  const memberMap = {};
  (members || []).forEach((row) => {
    if (!memberMap[row.group_id]) memberMap[row.group_id] = [];
    memberMap[row.group_id].push(row.user_id);
  });

  const enriched = groups.map((group) => ({
    ...group,
    member_ids: memberMap[group.id] || [],
    member_count: (memberMap[group.id] || []).length,
  }));

  res.json(enriched);
});

const createGroup = asyncHandler(async (req, res) => {
  const { name, description } = req.body || {};
  if (!name) return res.status(400).json({ error: "name required" });

  const { data, error } = await supabase
    .from("buyer_groups")
    .insert({
      company_id: req.params.id,
      name,
      description: description || null
    })
    .select("*")
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ ...data, member_ids: [], member_count: 0 });
});

const updateGroup = asyncHandler(async (req, res) => {
  const { name, description } = req.body || {};
  if (!name) return res.status(400).json({ error: "name required" });

  const { data, error } = await supabase
    .from("buyer_groups")
    .update({
      name,
      description: description || null,
      updated_at: new Date().toISOString()
    })
    .eq("id", req.params.id)
    .select("*")
    .single();

  if (error) return res.status(404).json({ error: "Not found" });
  res.json(data);
});

const deleteGroup = asyncHandler(async (req, res) => {
  const { error } = await supabase.from("buyer_groups").delete().eq("id", req.params.id);
  if (error) return res.status(404).json({ error: "Not found" });
  res.status(204).send();
});

const addMember = asyncHandler(async (req, res) => {
  const { user_id } = req.body || {};
  if (!user_id) return res.status(400).json({ error: "user_id required" });

  const { data, error } = await supabase
    .from("buyer_group_members")
    .insert({
      group_id: req.params.id,
      user_id
    })
    .select("*")
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

const listGroupMembers = asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from("buyer_group_members")
    .select("user_id, created_at")
    .eq("group_id", req.params.id)
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

const removeMember = asyncHandler(async (req, res) => {
  const { error } = await supabase
    .from("buyer_group_members")
    .delete()
    .eq("group_id", req.params.id)
    .eq("user_id", req.params.userId);

  if (error) return res.status(404).json({ error: "Not found" });
  res.status(204).send();
});

module.exports = { listGroups, createGroup, updateGroup, deleteGroup, addMember, listGroupMembers, removeMember };

