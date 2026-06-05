// ─── Database-level roles (PostgreSQL enum values) ───────────────────────────
export const DB_ROLE = {
  ADMIN:  'admin',
  BROKER: 'broker',
  BUYER:  'buyer',
};

// ─── Sub-roles stored in users.sub_role (text column) ────────────────────────
export const SUB_ROLE = {
  // Broker side
  BROKER_PRIMARY:     'broker_primary',
  BROKER_TEAM_MEMBER: 'broker_team_member',
  BANKER:             'banker',
  LOAN_BROKER:        'loan_broker',

  // Client side
  COMPANY_OWNER:       'company_owner',
  CLIENT_TEAM_MEMBER:  'client_team_member',
  CLIENT_ACCOUNTANT:   'client_accountant',

  // Buyer side
  BUYER_PRIMARY:       'buyer_primary',
  BUYER_TEAM_MEMBER:   'buyer_team_member',
  BUYER_ACCOUNTANT:    'buyer_accountant',
};

// ─── Sub-roles that belong to the broker side ─────────────────────────────────
export const BROKER_SUB_ROLES = [
  SUB_ROLE.BROKER_PRIMARY,
  SUB_ROLE.BROKER_TEAM_MEMBER,
  SUB_ROLE.BANKER,
  SUB_ROLE.LOAN_BROKER,
];

// ─── Sub-roles that belong to the client side ─────────────────────────────────
export const CLIENT_SUB_ROLES = [
  SUB_ROLE.COMPANY_OWNER,
  SUB_ROLE.CLIENT_TEAM_MEMBER,
  SUB_ROLE.CLIENT_ACCOUNTANT,
];

// ─── Sub-roles that belong to the buyer side ──────────────────────────────────
export const BUYER_SUB_ROLES = [
  SUB_ROLE.BUYER_PRIMARY,
  SUB_ROLE.BUYER_TEAM_MEMBER,
  SUB_ROLE.BUYER_ACCOUNTANT,
];

// ─── Display metadata per sub-role ───────────────────────────────────────────
export const ROLE_META = {
  [SUB_ROLE.BROKER_PRIMARY]: {
    label: 'Broker',
    color: '#b45e08',
    bg: '#FFF8F0',
    border: '#FED7AA',
    section: 'broker',
  },
  [SUB_ROLE.BROKER_TEAM_MEMBER]: {
    label: 'Broker Team Member',
    color: '#b45e08',
    bg: '#FFF8F0',
    border: '#FED7AA',
    section: 'broker',
  },
  [SUB_ROLE.BANKER]: {
    label: 'Banker',
    color: '#1D4ED8',
    bg: '#EFF6FF',
    border: '#BFDBFE',
    section: 'broker',
  },
  [SUB_ROLE.LOAN_BROKER]: {
    label: 'Loan Broker',
    color: '#7C3AED',
    bg: '#F5F3FF',
    border: '#DDD6FE',
    section: 'broker',
  },
  [SUB_ROLE.COMPANY_OWNER]: {
    label: 'Company Owner',
    color: '#00648F',
    bg: '#E5F4FB',
    border: '#BAE6FD',
    section: 'client',
  },
  [SUB_ROLE.CLIENT_TEAM_MEMBER]: {
    label: 'Client Team Member',
    color: '#00648F',
    bg: '#E5F4FB',
    border: '#BAE6FD',
    section: 'client',
  },
  [SUB_ROLE.CLIENT_ACCOUNTANT]: {
    label: 'Client Accountant',
    color: '#059669',
    bg: '#ECFDF5',
    border: '#A7F3D0',
    section: 'client',
  },
  [SUB_ROLE.BUYER_PRIMARY]: {
    label: 'Buyer',
    color: '#476E2C',
    bg: '#E8F3D8',
    border: '#BBF7D0',
    section: 'buyer',
  },
  [SUB_ROLE.BUYER_TEAM_MEMBER]: {
    label: 'Buyer Team Member',
    color: '#476E2C',
    bg: '#E8F3D8',
    border: '#BBF7D0',
    section: 'buyer',
  },
  [SUB_ROLE.BUYER_ACCOUNTANT]: {
    label: 'Buyer Accountant',
    color: '#059669',
    bg: '#ECFDF5',
    border: '#A7F3D0',
    section: 'buyer',
  },
};

// ─── Dropdown options for the "Add Broker Team Member" form ──────────────────
export const BROKER_TEAM_ROLE_OPTIONS = [
  { value: SUB_ROLE.BROKER_TEAM_MEMBER, label: 'Broker Team Member' },
  { value: SUB_ROLE.BANKER,             label: 'Banker' },
  { value: SUB_ROLE.LOAN_BROKER,        label: 'Loan Broker' },
];

// ─── Dropdown options for the "Add Client Team Member" form ──────────────────
export const CLIENT_TEAM_ROLE_OPTIONS = [
  { value: SUB_ROLE.CLIENT_TEAM_MEMBER, label: 'Client Team Member' },
  { value: SUB_ROLE.CLIENT_ACCOUNTANT,  label: 'Client Accountant' },
];

// ─── Dropdown options for the "Add Buyer Team Member" form ───────────────────
export const BUYER_TEAM_ROLE_OPTIONS = [
  { value: SUB_ROLE.BUYER_TEAM_MEMBER, label: 'Team Member' },
  { value: SUB_ROLE.BUYER_ACCOUNTANT,  label: 'Accountant' },
];

// ─── Permission matrix ────────────────────────────────────────────────────────
// Maps sub_role → set of allowed actions.
// Checked at the UI layer; actual enforcement lives in the backend middleware.
export const PERMISSIONS = {
  [SUB_ROLE.BROKER_PRIMARY]: {
    canManageCompanies:    true,
    canManageBrokerTeam:   true,
    canManageClientTeam:   true,
    canManageBuyers:       true,
    canViewReports:        true,
    canViewMessages:       true,
    canManageRequests:     true,
    canManageDocuments:    true,
    canViewInvoices:       true,
    canManageInvoices:     true,
  },
  [SUB_ROLE.BROKER_TEAM_MEMBER]: {
    canManageCompanies:    false,
    canManageBrokerTeam:   false,
    canManageClientTeam:   true,
    canManageBuyers:       true,
    canViewReports:        true,
    canViewMessages:       true,
    canManageRequests:     true,
    canManageDocuments:    true,
    canViewInvoices:       true,
    canManageInvoices:     false,
  },
  [SUB_ROLE.BANKER]: {
    canManageCompanies:    false,
    canManageBrokerTeam:   false,
    canManageClientTeam:   false,
    canManageBuyers:       false,
    canViewReports:        true,
    canViewMessages:       true,
    canManageRequests:     false,
    canManageDocuments:    false,
    canViewInvoices:       true,
    canManageInvoices:     false,
  },
  [SUB_ROLE.LOAN_BROKER]: {
    canManageCompanies:    false,
    canManageBrokerTeam:   false,
    canManageClientTeam:   false,
    canManageBuyers:       false,
    canViewReports:        true,
    canViewMessages:       true,
    canManageRequests:     false,
    canManageDocuments:    false,
    canViewInvoices:       false,
    canManageInvoices:     false,
  },
  [SUB_ROLE.COMPANY_OWNER]: {
    canManageCompanies:    false,
    canManageBrokerTeam:   false,
    canManageClientTeam:   true,
    canManageBuyers:       false,
    canViewReports:        true,
    canViewMessages:       true,
    canManageRequests:     true,
    canManageDocuments:    true,
    canViewInvoices:       true,
    canManageInvoices:     false,
  },
  [SUB_ROLE.CLIENT_TEAM_MEMBER]: {
    canManageCompanies:    false,
    canManageBrokerTeam:   false,
    canManageClientTeam:   false,
    canManageBuyers:       false,
    canViewReports:        true,
    canViewMessages:       true,
    canManageRequests:     true,
    canManageDocuments:    true,
    canViewInvoices:       false,
    canManageInvoices:     false,
  },
  [SUB_ROLE.CLIENT_ACCOUNTANT]: {
    canManageCompanies:    false,
    canManageBrokerTeam:   false,
    canManageClientTeam:   false,
    canManageBuyers:       false,
    canViewReports:        true,
    canViewMessages:       true,
    canManageRequests:     false,
    canManageDocuments:    true,
    canViewInvoices:       true,
    canManageInvoices:     false,
  },
  [SUB_ROLE.BUYER_PRIMARY]: {
    canManageCompanies:    false,
    canManageBrokerTeam:   false,
    canManageClientTeam:   false,
    canManageBuyers:       true,
    canViewReports:        true,
    canViewMessages:       true,
    canManageRequests:     true,
    canManageDocuments:    true,
    canViewInvoices:       false,
    canManageInvoices:     false,
  },
  [SUB_ROLE.BUYER_TEAM_MEMBER]: {
    canManageCompanies:    false,
    canManageBrokerTeam:   false,
    canManageClientTeam:   false,
    canManageBuyers:       false,
    canViewReports:        true,
    canViewMessages:       true,
    canManageRequests:     true,
    canManageDocuments:    true,
    canViewInvoices:       false,
    canManageInvoices:     false,
  },
  [SUB_ROLE.BUYER_ACCOUNTANT]: {
    canManageCompanies:    false,
    canManageBrokerTeam:   false,
    canManageClientTeam:   false,
    canManageBuyers:       false,
    canViewReports:        true,
    canViewMessages:       true,
    canManageRequests:     false,
    canManageDocuments:    true,
    canViewInvoices:       true,
    canManageInvoices:     false,
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns the ROLE_META entry for a user, falling back to the DB role if no
 * sub_role is set (e.g. legacy users created before migration 041).
 */
export function getRoleMeta(user) {
  if (user?.sub_role && ROLE_META[user.sub_role]) return ROLE_META[user.sub_role];
  if (user?.role === 'broker') return ROLE_META[SUB_ROLE.BROKER_PRIMARY];
  if (user?.role === 'buyer' || user?.role === 'client') return ROLE_META[SUB_ROLE.COMPANY_OWNER];
  return { label: user?.sub_role || user?.role || 'Unknown', color: '#6B7280', bg: '#F9FAFB', border: '#E5E7EB', section: 'unknown' };
}

/** Returns true when the user belongs to the broker-side team. */
export function isBrokerSide(user) {
  if (user?.sub_role) return BROKER_SUB_ROLES.includes(user.sub_role);
  return user?.role === 'broker' || user?.role === 'admin';
}

/** Returns true when the user belongs to the client-side team. */
export function isClientSide(user) {
  if (user?.sub_role) return CLIENT_SUB_ROLES.includes(user.sub_role);
  return user?.role === 'buyer' || user?.role === 'client';
}

/** Returns true when the user is a buyer-side user. */
export function isBuyerSide(user) {
  if (user?.sub_role) return BUYER_SUB_ROLES.includes(user.sub_role);
  return false;
}

/**
 * Infers the correct sub_role for a user.
 *
 * Priority:
 *  1. Explicit `sub_role` from DB — always wins.
 *  2. `buyer_company_name` present → user is a buyer, not a company owner.
 *  3. `parent_user_id` present → team member; defer classification to the
 *     parent's section (treat as buyer_team_member so they land in Buyers).
 *  4. DB role fallback: broker/admin → broker_primary; buyer/client → company_owner.
 */
export function inferSubRole(user) {
  if (user?.sub_role) return user.sub_role;
  if (user?.role === 'broker' || user?.role === 'admin') return SUB_ROLE.BROKER_PRIMARY;
  if (user?.role === 'buyer' || user?.role === 'client') {
    // A non-empty buyer_company_name is a strong signal this is a buyer, not a seller.
    if (user?.buyer_company_name && String(user.buyer_company_name).trim()) {
      // If they have a parent they are a team member, otherwise primary buyer.
      return user?.parent_user_id ? SUB_ROLE.BUYER_TEAM_MEMBER : SUB_ROLE.BUYER_PRIMARY;
    }
    // A parent_user_id with no buyer_company_name — still treat as buyer team
    if (user?.parent_user_id) return SUB_ROLE.BUYER_TEAM_MEMBER;
    return SUB_ROLE.COMPANY_OWNER;
  }
  return null;
}

// ─── Message group type constants ─────────────────────────────────────────────
export const MSG_GROUP_TYPE = {
  BROKER_INTERNAL: 'broker_internal',
  DEAL_TEAM:        'deal_team',
  BROKER_CLIENT:    'broker_client',
  BROKER_BUYER:     'broker_buyer',
  CLIENT_INTERNAL:  'client_internal',
  BUYER_INTERNAL:   'buyer_internal',
};

/**
 * Returns the groups that should be visible to a given user role/sub_role.
 * Used by the messaging UI to filter the group list.
 */
export function getVisibleGroupTypes(user) {
  const side = isBrokerSide(user) ? 'broker'
    : isClientSide(user) ? 'client'
    : isBuyerSide(user) ? 'buyer' : null;

  switch (side) {
    case 'broker': return [
      MSG_GROUP_TYPE.BROKER_INTERNAL,
      MSG_GROUP_TYPE.DEAL_TEAM,
      MSG_GROUP_TYPE.BROKER_CLIENT,
      MSG_GROUP_TYPE.BROKER_BUYER,
    ];
    case 'client': return [
      MSG_GROUP_TYPE.DEAL_TEAM,
      MSG_GROUP_TYPE.CLIENT_INTERNAL,
      MSG_GROUP_TYPE.BROKER_CLIENT,
    ];
    case 'buyer': return [
      MSG_GROUP_TYPE.DEAL_TEAM,
      MSG_GROUP_TYPE.BROKER_BUYER,
      MSG_GROUP_TYPE.BUYER_INTERNAL,
    ];
    default: return [];
  }
}
