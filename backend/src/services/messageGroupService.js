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

// ─── Enrichment: last_message + unread_count ─────────────────────────────────

/**
 * Attaches last_message and unread_count to every group in the array.
 * Uses two bulk Postgres queries instead of N+1 calls.
 * Falls back gracefully if pg pool is unavailable.
 */
async function enrichGroups(groups, userId) {
  if (!groups || !groups.length) return groups;

  const groupIds = groups.map((g) => g.id).filter(Boolean);
  if (!groupIds.length) return groups;

  const pool = getPool();
  if (!pool) return groups; // pg not available — return unenriched

  try {
    // Last message per group (DISTINCT ON = one row per group, latest first)
    const { rows: lastMsgRows } = await pool.query(
      `SELECT DISTINCT ON (gm.group_id)
         gm.group_id,
         gm.body,
         gm.created_at,
         gm.sender_id,
         u.name AS sender_name
       FROM group_messages gm
       LEFT JOIN users u ON u.id = gm.sender_id
       WHERE gm.group_id = ANY($1)
       ORDER BY gm.group_id, gm.created_at DESC`,
      [groupIds],
    );

    // Unread message counts per group for the requesting user
    const { rows: unreadRows } = userId
      ? await pool.query(
          `SELECT gm.group_id, COUNT(*) AS unread
           FROM group_messages gm
           LEFT JOIN group_message_reads gmr
             ON gmr.group_id = gm.group_id AND gmr.user_id = $1
           WHERE gm.group_id = ANY($2)
             AND gm.sender_id != $1
             AND (gmr.last_read_at IS NULL OR gm.created_at > gmr.last_read_at)
           GROUP BY gm.group_id`,
          [userId, groupIds],
        )
      : { rows: [] };

    const lastMsgMap = Object.fromEntries(lastMsgRows.map((r) => [r.group_id, r]));
    const unreadMap  = Object.fromEntries(unreadRows.map((r) => [r.group_id, Number(r.unread)]));

    return groups.map((g) => {
      const lm = lastMsgMap[g.id];
      return {
        ...g,
        last_message: lm
          ? { body: lm.body, sender_name: lm.sender_name, created_at: lm.created_at }
          : null,
        unread_count: unreadMap[g.id] || 0,
      };
    });
  } catch (err) {
    console.error("[messageGroupService] enrichGroups error:", err.message);
    return groups; // non-fatal: return unenriched
  }
}

// ─── Auto-create logic ────────────────────────────────────────────────────────

/**
 * Fetches all users belonging to a company, grouped by side (broker/client/buyer).
 *
 * Broker identification:
 *   1. Users in user_companies with a BROKER_SUB_ROLES sub_role (or legacy role=broker/admin).
 *   2. Members invited to a broker team via broker_team_invites where the team_owner is
 *      already identified as a broker for this company — ensures broker team members
 *      who were added via the invite system (not directly to user_companies) are included.
 *
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
  const buyerMap  = new Map();

  for (const row of data || []) {
    const user = row.users;
    if (!user) continue;
    const subRole = user.sub_role;
    const role    = user.role;

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
 *   4. deal_team        — ONE per company: all parties → "DealTeam - {clientCompany}"
 *                          (broker + ALL clients + ALL buyers)
 *   5. broker_buyer     — One per buyer: broker + that buyer → "{brokerCompany} - {buyerCompany}"
 *   6. buyer_internal   — One per buyer: buyer only   → "{buyerCompany}"
 */
async function autoCreateGroupsForCompany(companyId, companyName) {
  const { brokerIds, clientIds, buyerMap } = await fetchCompanyUsersByRole(companyId);
  const brokerCompanyName = await resolveBrokerCompanyName(brokerIds);
  const created = [];

  // Helper: find-or-create a group, update its name if it changed, then sync members.
  async function upsertGroup(name, groupType, buyerUserId = null) {
    let q = supabase
      .from("message_groups")
      .select("id, name")
      .eq("company_id", companyId)
      .eq("group_type", groupType);
    // .eq(col, null) does NOT match SQL IS NULL in PostgREST — must use .is()
    q = buyerUserId ? q.eq("buyer_user_id", buyerUserId) : q.is("buyer_user_id", null);
    const { data: existing } = await q.limit(1).maybeSingle();

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

  // 1. Broker internal — skipped during auto-creation; created only when the broker
  //    manually adds a team member so the group is never pre-populated.

  // 2. Broker + Client
  if (brokerIds.length && clientIds.length) {
    const gid = await upsertGroup(
      `${brokerCompanyName} - ${companyName}`,
      MSG_GROUP_TYPE.BROKER_CLIENT,
    );
    await addGroupMembers(gid, [...brokerIds, ...clientIds]);
  }

  // 4. DealTeam — everyone: the directly-assigned broker(s) + all client + all buyer members.
  //    Created on initial company creation with at minimum the creating broker + company owner.
  //    autoCreateGroupsForCompany re-runs whenever a user is added to the company, so new
  //    broker team members, client team members, and buyers are upserted into this group automatically.
  //    buyer_user_id = null signals this is the company-wide group, not per-buyer.
  {
    const allBuyerMemberIds = [...buyerMap.values()].flatMap((set) => [...set]);
    const allMemberIds = [...new Set([...brokerIds, ...clientIds, ...allBuyerMemberIds])];
    if (allMemberIds.length) {
      const gid = await upsertGroup(
        `DealTeam - ${companyName}`,
        MSG_GROUP_TYPE.DEAL_TEAM,
        null,
      );
      await addGroupMembers(gid, allMemberIds);
    }
  }

  // 5 & 6 — per-buyer groups (broker↔buyer channel + buyer internal)
  for (const [buyerParentId, memberSet] of buyerMap.entries()) {
    const buyerMemberIds = [...memberSet];

    const { data: buyerUser } = await supabase
      .from("users")
      .select("buyer_company_name, name")
      .eq("id", buyerParentId)
      .maybeSingle();
    const buyerCompanyName = buyerUser?.buyer_company_name || buyerUser?.name || "Buyer";

    // 5. Broker ↔ Buyer (private channel between broker team and this buyer)
    if (brokerIds.length) {
      const gid = await upsertGroup(
        `${brokerCompanyName} - ${buyerCompanyName}`,
        MSG_GROUP_TYPE.BROKER_BUYER,
        buyerParentId,
      );
      await addGroupMembers(gid, [...brokerIds, ...buyerMemberIds]);
    }

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
  enrichGroups,
  autoCreateGroupsForCompany,
  onUserAddedToCompany,
};
