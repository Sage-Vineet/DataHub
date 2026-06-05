"use strict";

const { supabase } = require("../db");
const { Pool } = require("pg");
const { SUB_ROLE, BROKER_SUB_ROLES, CLIENT_SUB_ROLES, BUYER_SUB_ROLES, MSG_GROUP_TYPE } = require("../constants/roles");

let _pool = null;
function getPool() {
  if (!process.env.DATABASE_URL) return null;
  if (!_pool) {
    _pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 5,
      connectionTimeoutMillis: 10000,
    });
    _pool.on("error", () => {});
  }
  return _pool;
}

// ─── Supabase helpers ─────────────────────────────────────────────────────────

async function getGroupsForCompany(companyId) {
  const { data, error } = await supabase
    .from("message_groups")
    .select("*, message_group_members(user_id)")
    .eq("company_id", companyId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data || [];
}

async function getGroupsForUser(userId) {
  const { data, error } = await supabase
    .from("message_group_members")
    .select("group_id, message_groups(*)")
    .eq("user_id", userId);
  if (error) throw error;
  return (data || []).map((row) => row.message_groups).filter(Boolean);
}

async function createGroup({ companyId, name, groupType, buyerUserId = null }) {
  const { data, error } = await supabase
    .from("message_groups")
    .insert({ company_id: companyId, name, group_type: groupType, buyer_user_id: buyerUserId })
    .select("id")
    .single();
  if (error) throw error;
  return data;
}

async function addGroupMembers(groupId, userIds) {
  if (!userIds?.length) return;
  const rows = userIds.map((user_id) => ({ group_id: groupId, user_id }));
  const { error } = await supabase.from("message_group_members").upsert(rows, { onConflict: "group_id,user_id" });
  if (error) throw error;
}

async function removeGroupMember(groupId, userId) {
  const { error } = await supabase
    .from("message_group_members")
    .delete()
    .eq("group_id", groupId)
    .eq("user_id", userId);
  if (error) throw error;
}

// ─── Auto-create logic ────────────────────────────────────────────────────────

/**
 * Fetches all users belonging to a company, grouped by side (broker/client/buyer).
 * Returns { brokerIds, clientIds, buyerMap } where buyerMap is
 *   Map<parentUserId, Set<memberId>>.
 */
async function fetchCompanyUsersByRole(companyId) {
  const pool = getPool();

  // Supabase path
  const { data, error } = await supabase
    .from("user_companies")
    .select("user_id, users(id, role, sub_role, parent_user_id)")
    .eq("company_id", companyId);

  if (error) throw error;

  const brokerIds = [];
  const clientIds = [];
  const buyerMap = new Map();

  for (const row of data || []) {
    const user = row.users;
    if (!user) continue;
    const subRole = user.sub_role;
    const role = user.role;

    if (subRole && BROKER_SUB_ROLES.includes(subRole) || (!subRole && (role === "broker" || role === "admin"))) {
      brokerIds.push(user.id);
    } else if (subRole && CLIENT_SUB_ROLES.includes(subRole) || (!subRole && (role === "buyer" || role === "client"))) {
      clientIds.push(user.id);
    } else if (subRole && BUYER_SUB_ROLES.includes(subRole)) {
      const parentId = user.parent_user_id || user.id;
      if (!buyerMap.has(parentId)) buyerMap.set(parentId, new Set());
      buyerMap.get(parentId).add(user.id);
    }
  }

  return { brokerIds, clientIds, buyerMap };
}

/**
 * Auto-creates the standard message groups for a company once enough members
 * are present. Safe to call multiple times — uses upsert semantics via
 * group_type + company_id uniqueness.
 *
 * Groups created:
 *   1. broker_internal  — Broker + Broker Team + Bankers + Loan Brokers
 *   2. deal_team        — Everyone
 *   3. broker_client    — Broker Team + Client Team
 *   4. broker_buyer     — One per buyer (Broker Team + that buyer's team)
 *   5. client_internal  — Client Team only
 *   6. buyer_internal   — One per buyer (buyer's team only)
 */
async function autoCreateGroupsForCompany(companyId, companyName) {
  const { brokerIds, clientIds, buyerMap } = await fetchCompanyUsersByRole(companyId);
  const created = [];

  // Helper: find or create a group, then sync members
  async function upsertGroup(name, groupType, buyerUserId = null) {
    const { data: existing } = await supabase
      .from("message_groups")
      .select("id")
      .eq("company_id", companyId)
      .eq("group_type", groupType)
      .eq("buyer_user_id", buyerUserId ?? null)
      .maybeSingle();

    let groupId;
    if (existing?.id) {
      groupId = existing.id;
    } else {
      const row = await createGroup({ companyId, name, groupType, buyerUserId });
      groupId = row.id;
      created.push({ groupId, groupType });
    }
    return groupId;
  }

  // 1. Broker internal
  if (brokerIds.length) {
    const gid = await upsertGroup(`${companyName} - Broker Team`, MSG_GROUP_TYPE.BROKER_INTERNAL);
    await addGroupMembers(gid, brokerIds);
  }

  // 2. Deal team (everyone)
  const allIds = [...new Set([...brokerIds, ...clientIds, ...[...buyerMap.values()].flatMap((s) => [...s])])];
  if (allIds.length) {
    const gid = await upsertGroup(`DealTeam - ${companyName}`, MSG_GROUP_TYPE.DEAL_TEAM);
    await addGroupMembers(gid, allIds);
  }

  // 3. Broker + Client
  if (brokerIds.length && clientIds.length) {
    const gid = await upsertGroup(`Broker - ${companyName}`, MSG_GROUP_TYPE.BROKER_CLIENT);
    await addGroupMembers(gid, [...brokerIds, ...clientIds]);
  }

  // 4. Client internal
  if (clientIds.length) {
    const gid = await upsertGroup(`${companyName} - Client Team`, MSG_GROUP_TYPE.CLIENT_INTERNAL);
    await addGroupMembers(gid, clientIds);
  }

  // 5 & 6. Per-buyer groups
  for (const [buyerParentId, memberSet] of buyerMap.entries()) {
    const buyerMemberIds = [...memberSet];

    // broker_buyer group
    if (brokerIds.length) {
      const { data: buyerUser } = await supabase.from("users").select("buyer_company_name, name").eq("id", buyerParentId).single();
      const buyerLabel = buyerUser?.buyer_company_name || buyerUser?.name || "Buyer";
      const gid = await upsertGroup(`${companyName} - ${buyerLabel}`, MSG_GROUP_TYPE.BROKER_BUYER, buyerParentId);
      await addGroupMembers(gid, [...brokerIds, ...buyerMemberIds]);
    }

    // buyer_internal group
    const { data: buyerUser } = await supabase.from("users").select("buyer_company_name, name").eq("id", buyerParentId).maybeSingle();
    const buyerLabel = buyerUser?.buyer_company_name || buyerUser?.name || "Buyer";
    const gid = await upsertGroup(`${buyerLabel} - Internal`, MSG_GROUP_TYPE.BUYER_INTERNAL, buyerParentId);
    await addGroupMembers(gid, buyerMemberIds);
  }

  return { created };
}

/**
 * Called whenever a new user is added to a company. Adds the user to all
 * existing groups they should belong to, and re-runs auto-create so any
 * newly-satisfiable groups are created.
 */
async function onUserAddedToCompany(companyId, companyName, user) {
  await autoCreateGroupsForCompany(companyId, companyName);
}

module.exports = {
  getGroupsForCompany,
  getGroupsForUser,
  createGroup,
  addGroupMembers,
  removeGroupMember,
  autoCreateGroupsForCompany,
  onUserAddedToCompany,
};
