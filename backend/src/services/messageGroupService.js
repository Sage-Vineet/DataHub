"use strict";

const { supabase } = require("../db");
const { Pool } = require("pg");
const { BROKER_SUB_ROLES, CLIENT_SUB_ROLES, BUYER_SUB_ROLES, MSG_GROUP_TYPE } = require("../constants/roles");

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
    .select("group_id, message_groups(*, message_group_members(user_id))")
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

async function getGroupMembersWithDetails(groupId) {
  const { data: members, error: membErr } = await supabase
    .from("message_group_members")
    .select("user_id")
    .eq("group_id", groupId);
  if (membErr) throw membErr;

  const userIds = (members || []).map((m) => m.user_id).filter(Boolean);
  if (!userIds.length) return [];

  const { data: users, error: usrErr } = await supabase
    .from("users")
    .select("id, name, email, role, sub_role, buyer_company_name, broker_company")
    .in("id", userIds);
  if (usrErr) throw usrErr;
  return users || [];
}

// ─── Auto-create logic ────────────────────────────────────────────────────────

/**
 * Fetches all users belonging to a company, grouped by side (broker/client/buyer).
 * Returns { brokerIds, clientIds, buyerMap } where buyerMap is
 *   Map<parentUserId, Set<memberId>>.
 */
async function fetchCompanyUsersByRole(companyId) {
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

    if ((subRole && BROKER_SUB_ROLES.includes(subRole)) || (!subRole && (role === "broker" || role === "admin"))) {
      brokerIds.push(user.id);
    } else if ((subRole && CLIENT_SUB_ROLES.includes(subRole)) || (!subRole && (role === "buyer" || role === "client"))) {
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
 * Resolves the broker company display name from the first broker user
 * associated with the company. Falls back to a generic label.
 */
async function resolveBrokerCompanyName(brokerIds) {
  if (!brokerIds.length) return "Broker";
  const { data } = await supabase
    .from("users")
    .select("broker_company, name")
    .in("id", brokerIds)
    .not("broker_company", "is", null)
    .limit(1)
    .maybeSingle();
  return data?.broker_company || "Broker";
}

/**
 * Auto-creates/syncs the standard message groups for a company.
 * Safe to call multiple times — upserts groups and updates names if changed.
 *
 * Groups created:
 *   1. broker_internal  — Broker team only           → "{brokerCompany}"
 *   2. broker_client    — Broker + Client team        → "{brokerCompany} - {clientCompany}"
 *   3. client_internal  — Client team only            → "{clientCompany}"
 *   4. deal_team        — One per buyer: broker + client + that buyer
 *                                                     → "DealTeam - {clientCompany} - {buyerCompany}"
 *   5. broker_buyer     — One per buyer: broker + buyer → "{brokerCompany} - {buyerCompany}"
 *   6. buyer_internal   — One per buyer: buyer only   → "{buyerCompany}"
 */
async function autoCreateGroupsForCompany(companyId, companyName) {
  const { brokerIds, clientIds, buyerMap } = await fetchCompanyUsersByRole(companyId);
  const brokerCompanyName = await resolveBrokerCompanyName(brokerIds);
  const created = [];

  // Helper: find-or-create a group, update its name if it changed, then sync members.
  async function upsertGroup(name, groupType, buyerUserId = null) {
    const { data: existing } = await supabase
      .from("message_groups")
      .select("id, name")
      .eq("company_id", companyId)
      .eq("group_type", groupType)
      .eq("buyer_user_id", buyerUserId ?? null)
      .maybeSingle();

    let groupId;
    if (existing?.id) {
      groupId = existing.id;
      if (existing.name !== name) {
        await supabase.from("message_groups").update({ name }).eq("id", groupId);
      }
    } else {
      const row = await createGroup({ companyId, name, groupType, buyerUserId });
      groupId = row.id;
      created.push({ groupId, groupType });
    }
    return groupId;
  }

  // Remove legacy "everyone" deal_team (buyer_user_id IS NULL) if it exists,
  // since we now create one per buyer.
  await supabase
    .from("message_groups")
    .delete()
    .eq("company_id", companyId)
    .eq("group_type", MSG_GROUP_TYPE.DEAL_TEAM)
    .is("buyer_user_id", null);

  // 1. Broker internal — broker team only
  if (brokerIds.length) {
    const gid = await upsertGroup(brokerCompanyName, MSG_GROUP_TYPE.BROKER_INTERNAL);
    await addGroupMembers(gid, brokerIds);
  }

  // 2. Broker + Client
  if (brokerIds.length && clientIds.length) {
    const gid = await upsertGroup(
      `${brokerCompanyName} - ${companyName}`,
      MSG_GROUP_TYPE.BROKER_CLIENT,
    );
    await addGroupMembers(gid, [...brokerIds, ...clientIds]);
  }

  // 3. Client internal — client team only
  if (clientIds.length) {
    const gid = await upsertGroup(companyName, MSG_GROUP_TYPE.CLIENT_INTERNAL);
    await addGroupMembers(gid, clientIds);
  }

  // 4, 5, 6 — per-buyer groups
  for (const [buyerParentId, memberSet] of buyerMap.entries()) {
    const buyerMemberIds = [...memberSet];

    const { data: buyerUser } = await supabase
      .from("users")
      .select("buyer_company_name, name")
      .eq("id", buyerParentId)
      .maybeSingle();
    const buyerCompanyName = buyerUser?.buyer_company_name || buyerUser?.name || "Buyer";

    // 4. DealTeam — broker + client + this buyer
    if (brokerIds.length && clientIds.length) {
      const gid = await upsertGroup(
        `DealTeam - ${companyName} - ${buyerCompanyName}`,
        MSG_GROUP_TYPE.DEAL_TEAM,
        buyerParentId,
      );
      await addGroupMembers(gid, [...brokerIds, ...clientIds, ...buyerMemberIds]);
    }

    // 5. Broker ↔ Buyer
    if (brokerIds.length) {
      const gid = await upsertGroup(
        `${brokerCompanyName} - ${buyerCompanyName}`,
        MSG_GROUP_TYPE.BROKER_BUYER,
        buyerParentId,
      );
      await addGroupMembers(gid, [...brokerIds, ...buyerMemberIds]);
    }

    // 6. Buyer internal — this buyer's team only
    const gid = await upsertGroup(buyerCompanyName, MSG_GROUP_TYPE.BUYER_INTERNAL, buyerParentId);
    await addGroupMembers(gid, buyerMemberIds);
  }

  return { created };
}

/**
 * Called whenever a new user is added to a company.
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
  getGroupMembersWithDetails,
  autoCreateGroupsForCompany,
  onUserAddedToCompany,
};
