"use strict";

const asyncHandler = require("../utils");
const messageGroupService = require("../services/messageGroupService");
const userService = require("../services/userService");
const companyService = require("../services/companyService");
const { supabase } = require("../db");

// ─── Group management ─────────────────────────────────────────────────────────

/**
 * GET /companies/:companyId/message-groups
 * Returns enriched groups (with last_message + unread_count) for the company.
 * Auto-creates groups on first visit if none exist yet.
 */
const listGroupsForCompany = asyncHandler(async (req, res) => {
  const { companyId } = req.params;
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  if (!userService.canAccessCompany(req.user, companyId)) {
    return res.status(403).json({ error: "Access denied" });
  }

  // Always sync group membership so newly-added brokers/clients/buyers are reflected
  // immediately. All operations inside autoCreateGroupsForCompany are upserts, so
  // re-running on every load is safe and never disrupts existing messages.
  try {
    const company = await companyService.getCompanyById(companyId);
    if (company) {
      await messageGroupService.autoCreateGroupsForCompany(company.id, company.name);
    }
  } catch (err) {
    console.error("[listGroupsForCompany] sync failed:", err.message);
  }

  const groups = await messageGroupService.getGroupsForCompany(companyId);
  res.json(await messageGroupService.enrichGroups(groups, req.user.id));
});

/**
 * GET /my-groups
 * Returns all groups the current user is a member of, enriched.
 * For each company the user belongs to, auto-creates groups if none exist.
 */
const listGroupsForUser = asyncHandler(async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });

  let groups = await messageGroupService.getGroupsForUser(req.user.id);

  // First-visit bootstrap for all companies the user belongs to.
  if (!groups.length) {
    const companyIds = userService.getUserCompanyIds(req.user);
    for (const cid of companyIds) {
      try {
        const company = await companyService.getCompanyById(cid);
        if (company) {
          await messageGroupService.autoCreateGroupsForCompany(company.id, company.name);
        }
      } catch (err) {
        console.error("[listGroupsForUser] auto-create failed for", cid, ":", err.message);
      }
    }
    groups = await messageGroupService.getGroupsForUser(req.user.id);
  }

  res.json(await messageGroupService.enrichGroups(groups, req.user.id));
});

/**
 * POST /companies/:companyId/message-groups/auto-create
 * Any authenticated user who can access the company can trigger group regeneration.
 * (Previously broker-only — opened up so clients and buyers also get groups.)
 */
const triggerAutoCreate = asyncHandler(async (req, res) => {
  const { companyId } = req.params;
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  if (!userService.canAccessCompany(req.user, companyId)) {
    return res.status(403).json({ error: "Access denied" });
  }
  const { data: company } = await supabase
    .from("companies")
    .select("id, name")
    .eq("id", companyId)
    .single();
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

// ─── Group messages ───────────────────────────────────────────────────────────

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

const getGroupMembers = asyncHandler(async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  const { groupId } = req.params;
  await assertGroupMember(req.user.id, groupId);
  const members = await messageGroupService.getGroupMembersWithDetails(groupId);
  res.json(members);
});

const listGroupMessages = asyncHandler(async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  const { groupId } = req.params;
  const limit  = Math.min(Number(req.query.limit) || 100, 200);
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
    .upsert(
      { group_id: groupId, user_id: req.user.id, last_read_at: new Date().toISOString() },
      { onConflict: "group_id,user_id" },
    );

  if (error) throw error;
  res.json({ success: true });
});

const getGroupUnreadCount = asyncHandler(async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  const { groupId } = req.params;
  await assertGroupMember(req.user.id, groupId);

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
  getGroupMembers,
  listGroupMessages,
  sendGroupMessage,
  markGroupRead,
  getGroupUnreadCount,
};
