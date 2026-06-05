"use strict";

const asyncHandler = require("../utils");
const messageGroupService = require("../services/messageGroupService");
const userService = require("../services/userService");
const { supabase } = require("../db");

// ─── Group management ─────────────────────────────────────────────────────────

const listGroupsForCompany = asyncHandler(async (req, res) => {
  const { companyId } = req.params;
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  if (!userService.canAccessCompany(req.user, companyId)) {
    return res.status(403).json({ error: "Access denied" });
  }
  const groups = await messageGroupService.getGroupsForCompany(companyId);
  res.json(groups);
});

const listGroupsForUser = asyncHandler(async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  const groups = await messageGroupService.getGroupsForUser(req.user.id);
  res.json(groups);
});

const triggerAutoCreate = asyncHandler(async (req, res) => {
  const { companyId } = req.params;
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  const requesterRole = String(req.user?.role || "").toLowerCase();
  if (!["broker", "admin"].includes(requesterRole)) {
    return res.status(403).json({ error: "Only brokers can trigger group creation." });
  }
  const { data: company } = await supabase.from("companies").select("id, name").eq("id", companyId).single();
  if (!company) return res.status(404).json({ error: "Company not found" });
  const result = await messageGroupService.autoCreateGroupsForCompany(company.id, company.name);
  res.json({ success: true, ...result });
});

const addMemberToGroup = asyncHandler(async (req, res) => {
  const { groupId } = req.params;
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: "user_id required" });
  await messageGroupService.addGroupMembers(groupId, [user_id]);
  res.json({ success: true });
});

const removeMemberFromGroup = asyncHandler(async (req, res) => {
  const { groupId, userId } = req.params;
  await messageGroupService.removeGroupMember(groupId, userId);
  res.json({ success: true });
});

// ─── Group messages (migration 042) ──────────────────────────────────────────

/** Verify the requesting user is a member of the group. */
async function assertGroupMember(userId, groupId) {
  const { data, error } = await supabase
    .from("message_group_members")
    .select("user_id")
    .eq("group_id", groupId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    const err = new Error("You are not a member of this group.");
    err.status = 403;
    throw err;
  }
}

const listGroupMessages = asyncHandler(async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  const { groupId } = req.params;
  const limit = Math.min(Number(req.query.limit) || 100, 200);
  const before = req.query.before; // ISO timestamp for pagination

  await assertGroupMember(req.user.id, groupId);

  let query = supabase
    .from("group_messages")
    .select("id, group_id, sender_id, body, created_at, users:sender_id(id, name, role, sub_role)")
    .eq("group_id", groupId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (before) query = query.lt("created_at", before);

  const { data, error } = await query;
  if (error) throw error;

  // Return in chronological order (oldest first)
  res.json((data || []).reverse());
});

const sendGroupMessage = asyncHandler(async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  const { groupId } = req.params;
  const { body } = req.body || {};
  if (!body?.trim()) return res.status(400).json({ error: "Message body is required." });

  await assertGroupMember(req.user.id, groupId);

  const { data, error } = await supabase
    .from("group_messages")
    .insert({ group_id: groupId, sender_id: req.user.id, body: body.trim() })
    .select("id, group_id, sender_id, body, created_at, users:sender_id(id, name, role, sub_role)")
    .single();

  if (error) throw error;
  res.status(201).json(data);
});

const markGroupRead = asyncHandler(async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  const { groupId } = req.params;
  await assertGroupMember(req.user.id, groupId);

  const { error } = await supabase
    .from("group_message_reads")
    .upsert({ group_id: groupId, user_id: req.user.id, last_read_at: new Date().toISOString() }, { onConflict: "group_id,user_id" });

  if (error) throw error;
  res.json({ success: true });
});

const getGroupUnreadCount = asyncHandler(async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  const { groupId } = req.params;
  await assertGroupMember(req.user.id, groupId);

  // Get last-read timestamp
  const { data: readRow } = await supabase
    .from("group_message_reads")
    .select("last_read_at")
    .eq("group_id", groupId)
    .eq("user_id", req.user.id)
    .maybeSingle();

  let countQuery = supabase
    .from("group_messages")
    .select("id", { count: "exact", head: true })
    .eq("group_id", groupId)
    .neq("sender_id", req.user.id);

  if (readRow?.last_read_at) {
    countQuery = countQuery.gt("created_at", readRow.last_read_at);
  }

  const { count, error } = await countQuery;
  if (error) throw error;
  res.json({ count: count || 0 });
});

module.exports = {
  listGroupsForCompany,
  listGroupsForUser,
  triggerAutoCreate,
  addMemberToGroup,
  removeMemberFromGroup,
  listGroupMessages,
  sendGroupMessage,
  markGroupRead,
  getGroupUnreadCount,
};
