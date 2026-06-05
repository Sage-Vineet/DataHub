"use strict";

// ─── Database-level roles (user_role enum) ────────────────────────────────────
const DB_ROLE = {
  ADMIN:  "admin",
  BROKER: "broker",
  BUYER:  "buyer",
};

// ─── Sub-roles stored in users.sub_role ──────────────────────────────────────
const SUB_ROLE = {
  BROKER_PRIMARY:      "broker_primary",
  BROKER_TEAM_MEMBER:  "broker_team_member",
  BANKER:              "banker",
  LOAN_BROKER:         "loan_broker",

  COMPANY_OWNER:       "company_owner",
  CLIENT_TEAM_MEMBER:  "client_team_member",
  CLIENT_ACCOUNTANT:   "client_accountant",

  BUYER_PRIMARY:       "buyer_primary",
  BUYER_TEAM_MEMBER:   "buyer_team_member",
  BUYER_ACCOUNTANT:    "buyer_accountant",
};

const BROKER_SUB_ROLES = [
  SUB_ROLE.BROKER_PRIMARY,
  SUB_ROLE.BROKER_TEAM_MEMBER,
  SUB_ROLE.BANKER,
  SUB_ROLE.LOAN_BROKER,
];

const CLIENT_SUB_ROLES = [
  SUB_ROLE.COMPANY_OWNER,
  SUB_ROLE.CLIENT_TEAM_MEMBER,
  SUB_ROLE.CLIENT_ACCOUNTANT,
];

const BUYER_SUB_ROLES = [
  SUB_ROLE.BUYER_PRIMARY,
  SUB_ROLE.BUYER_TEAM_MEMBER,
  SUB_ROLE.BUYER_ACCOUNTANT,
];

// ─── Message group types ──────────────────────────────────────────────────────
const MSG_GROUP_TYPE = {
  BROKER_INTERNAL: "broker_internal",
  DEAL_TEAM:       "deal_team",
  BROKER_CLIENT:   "broker_client",
  BROKER_BUYER:    "broker_buyer",
  CLIENT_INTERNAL: "client_internal",
  BUYER_INTERNAL:  "buyer_internal",
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isBrokerSide(user) {
  if (user?.sub_role) return BROKER_SUB_ROLES.includes(user.sub_role);
  return user?.role === "broker" || user?.role === "admin";
}

function isClientSide(user) {
  if (user?.sub_role) return CLIENT_SUB_ROLES.includes(user.sub_role);
  return user?.role === "buyer" || user?.role === "client";
}

function isBuyerSide(user) {
  if (user?.sub_role) return BUYER_SUB_ROLES.includes(user.sub_role);
  return false;
}

/** Infers sub_role for legacy users that pre-date migration 041. */
function inferSubRole(user) {
  if (user?.sub_role) return user.sub_role;
  if (user?.role === "broker" || user?.role === "admin") return SUB_ROLE.BROKER_PRIMARY;
  if (user?.role === "buyer" || user?.role === "client") return SUB_ROLE.COMPANY_OWNER;
  return null;
}

module.exports = {
  DB_ROLE,
  SUB_ROLE,
  BROKER_SUB_ROLES,
  CLIENT_SUB_ROLES,
  BUYER_SUB_ROLES,
  MSG_GROUP_TYPE,
  isBrokerSide,
  isClientSide,
  isBuyerSide,
  inferSubRole,
};
