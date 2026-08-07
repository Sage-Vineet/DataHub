"use strict";

/**
 * Server-side role-based access control.
 *
 * WHY capabilities rather than role string comparisons scattered through
 * handlers: `if (user.role === 'admin')` repeated across 149 route files is
 * impossible to audit and drifts the moment a role is added. A single matrix
 * gives one place to answer "who can do this?" and one place to review when it
 * changes. Broken access control is #1 in the OWASP Top 10 precisely because it
 * is usually an inconsistency bug, not a missing check.
 *
 * TENANCY: authorization here is two-dimensional. A capability answers "may this
 * role perform this action at all"; `requireCompanyAccess` answers "may this
 * user perform it against *this company's* data". Both are required — a Manager
 * with report:read must still not read another company's balance sheet.
 *
 * The frontend hides UI the user cannot use, but that is cosmetic. Nothing in
 * this file has a client-side counterpart that can be trusted.
 */

const securityEvents = require("../services/securityEventService");
const { canAccessCompany } = require("../services/permissionService");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Canonical roles ──────────────────────────────────────────────────────────
// The database enum (`admin` | `broker` | `buyer`) plus `users.sub_role` are the
// storage model. These four canonical tiers are the authorization model, and
// every stored role maps onto exactly one of them.
const ROLE = Object.freeze({
  ADMIN: "admin",
  MANAGER: "manager",
  USER: "user",
  VIEWER: "viewer",
});

const ROLE_RANK = Object.freeze({
  [ROLE.ADMIN]: 40,
  [ROLE.MANAGER]: 30,
  [ROLE.USER]: 20,
  [ROLE.VIEWER]: 10,
});

/** sub_role → canonical role. Checked before the coarse role mapping. */
const SUB_ROLE_TO_CANONICAL = Object.freeze({
  broker_primary: ROLE.MANAGER,
  broker_team_member: ROLE.USER,
  banker: ROLE.USER,
  loan_broker: ROLE.USER,

  company_owner: ROLE.MANAGER,
  client_team_member: ROLE.USER,
  client_accountant: ROLE.USER,

  buyer_primary: ROLE.USER,
  buyer_team_member: ROLE.VIEWER,
  buyer_accountant: ROLE.VIEWER,
});

/** users.role → canonical role, used when sub_role is absent (legacy rows). */
const DB_ROLE_TO_CANONICAL = Object.freeze({
  admin: ROLE.ADMIN,
  broker: ROLE.MANAGER,
  buyer: ROLE.USER,
  client: ROLE.USER,
});

/**
 * Resolves a user's canonical role.
 * `admin` at the DB level always wins — it is never downgraded by a sub_role.
 */
function resolveRole(user) {
  if (!user) return null;
  const dbRole = String(user.role || "").toLowerCase();
  if (dbRole === "admin") return ROLE.ADMIN;

  const subRole = String(user.sub_role || "").toLowerCase();
  if (subRole && SUB_ROLE_TO_CANONICAL[subRole]) {
    return SUB_ROLE_TO_CANONICAL[subRole];
  }
  return DB_ROLE_TO_CANONICAL[dbRole] || ROLE.VIEWER;
}

// ── Capabilities ─────────────────────────────────────────────────────────────
// Named `resource:action`. Keep this list closed — an unknown capability passed
// to requirePermission throws at startup rather than silently allowing.
const PERMISSION = Object.freeze({
  USER_READ: "user:read",
  USER_CREATE: "user:create",
  USER_UPDATE: "user:update",
  USER_DELETE: "user:delete",
  USER_IMPERSONATE: "user:impersonate",

  COMPANY_READ: "company:read",
  COMPANY_CREATE: "company:create",
  COMPANY_UPDATE: "company:update",
  COMPANY_DELETE: "company:delete",

  DOCUMENT_READ: "document:read",
  DOCUMENT_UPLOAD: "document:upload",
  DOCUMENT_DELETE: "document:delete",

  REPORT_READ: "report:read",
  REPORT_GENERATE: "report:generate",
  REPORT_APPROVE: "report:approve",
  REPORT_DELETE: "report:delete",

  REQUEST_READ: "request:read",
  REQUEST_CREATE: "request:create",
  REQUEST_UPDATE: "request:update",
  REQUEST_APPROVE: "request:approve",
  REQUEST_DELETE: "request:delete",

  INTEGRATION_READ: "integration:read",
  INTEGRATION_CONNECT: "integration:connect",
  INTEGRATION_DISCONNECT: "integration:disconnect",

  SECURITY_AUDIT_READ: "security:audit:read",
  SECURITY_SESSION_REVOKE: "security:session:revoke",
  SECURITY_ACCOUNT_UNLOCK: "security:account:unlock",
});

const ALL_PERMISSIONS = new Set(Object.values(PERMISSION));

/**
 * Permissions granted at each tier. Higher tiers inherit everything from the
 * tier below via ROLE_RANK, so each entry lists only what that tier adds.
 */
const GRANTS = Object.freeze({
  [ROLE.VIEWER]: [
    PERMISSION.COMPANY_READ,
    PERMISSION.DOCUMENT_READ,
    PERMISSION.REPORT_READ,
    PERMISSION.REQUEST_READ,
    PERMISSION.INTEGRATION_READ,
  ],
  [ROLE.USER]: [
    PERMISSION.USER_READ,
    PERMISSION.DOCUMENT_UPLOAD,
    PERMISSION.REPORT_GENERATE,
    PERMISSION.REQUEST_CREATE,
    PERMISSION.REQUEST_UPDATE,
  ],
  [ROLE.MANAGER]: [
    PERMISSION.USER_CREATE,
    PERMISSION.USER_UPDATE,
    PERMISSION.COMPANY_CREATE,
    PERMISSION.COMPANY_UPDATE,
    PERMISSION.DOCUMENT_DELETE,
    PERMISSION.REPORT_APPROVE,
    PERMISSION.REPORT_DELETE,
    PERMISSION.REQUEST_APPROVE,
    PERMISSION.REQUEST_DELETE,
    PERMISSION.INTEGRATION_CONNECT,
    PERMISSION.INTEGRATION_DISCONNECT,
  ],
  [ROLE.ADMIN]: [
    PERMISSION.USER_DELETE,
    PERMISSION.USER_IMPERSONATE,
    PERMISSION.COMPANY_DELETE,
    PERMISSION.SECURITY_AUDIT_READ,
    PERMISSION.SECURITY_SESSION_REVOKE,
    PERMISSION.SECURITY_ACCOUNT_UNLOCK,
  ],
});

/** Flattened effective permission set per role, computed once at load. */
const EFFECTIVE = (() => {
  const table = {};
  const ordered = Object.keys(ROLE_RANK).sort((a, b) => ROLE_RANK[a] - ROLE_RANK[b]);
  const accumulated = new Set();
  for (const role of ordered) {
    for (const permission of GRANTS[role] || []) accumulated.add(permission);
    table[role] = new Set(accumulated);
  }
  return Object.freeze(table);
})();

/** Does this user hold this capability? Pure function — safe to reuse anywhere. */
function can(user, permission) {
  const role = resolveRole(user);
  if (!role) return false;
  return EFFECTIVE[role]?.has(permission) === true;
}

/** Every capability the user holds — used to drive frontend UI gating. */
function permissionsFor(user) {
  const role = resolveRole(user);
  return role ? Array.from(EFFECTIVE[role] || []) : [];
}

async function denyRequest(req, res, metadata) {
  await securityEvents.record({
    eventType: "authorization_denied",
    severity: securityEvents.SEVERITY.WARNING,
    ...securityEvents.fromRequest(req),
    metadata: { path: req.path, method: req.method, ...metadata },
  });
  // Uniform body: never reveal which permission or role would have sufficed.
  return res.status(403).json({ error: "Access denied", code: "FORBIDDEN" });
}

/**
 * Requires one or more capabilities. Multiple arguments are ANDed.
 * Must be mounted after requireAuth.
 */
function requirePermission(...permissions) {
  for (const permission of permissions) {
    if (!ALL_PERMISSIONS.has(permission)) {
      // Fail at startup, not at request time, on a typo'd capability name.
      throw new Error(`requirePermission: unknown permission "${permission}"`);
    }
  }
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: "Authentication required", code: "UNAUTHENTICATED" });
    }
    const missing = permissions.filter((permission) => !can(req.user, permission));
    if (missing.length > 0) {
      return denyRequest(req, res, { role: resolveRole(req.user), action: missing[0] });
    }
    return next();
  };
}

/** Requires at least the given canonical tier. */
function requireMinRole(minimumRole) {
  const threshold = ROLE_RANK[minimumRole];
  if (threshold === undefined) {
    throw new Error(`requireMinRole: unknown role "${minimumRole}"`);
  }
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: "Authentication required", code: "UNAUTHENTICATED" });
    }
    const role = resolveRole(req.user);
    if ((ROLE_RANK[role] ?? 0) < threshold) {
      return denyRequest(req, res, { role });
    }
    return next();
  };
}

/**
 * Tenant isolation guard.
 *
 * Resolves the target company id from the route params, query or body — in that
 * order of trust — and rejects the request unless the caller is entitled to it.
 * This is the control that stops horizontal privilege escalation (IDOR), which
 * no amount of role checking prevents on its own.
 *
 * @param {string|string[]} sources parameter names to look for, e.g. "companyId"
 * @param {{ optional?: boolean }} options when optional, a request with no
 *   company reference passes through (the handler must then scope by req.user).
 */
function requireCompanyAccess(sources = ["companyId", "company_id", "clientId"], options = {}) {
  const names = Array.isArray(sources) ? sources : [sources];
  const { optional = false } = options;

  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: "Authentication required", code: "UNAUTHENTICATED" });
    }

    let companyId = null;
    for (const name of names) {
      const candidate = req.params?.[name] ?? req.query?.[name] ?? req.body?.[name];
      if (candidate) {
        companyId = String(candidate);
        break;
      }
    }
    // Some routes stash the id during path rewriting (see quickbooksAuth).
    if (!companyId && req.clientId) companyId = String(req.clientId);

    if (!companyId) {
      if (optional) return next();
      return res.status(400).json({ error: "Company reference required", code: "COMPANY_REQUIRED" });
    }

    if (!UUID_RE.test(companyId)) {
      return res.status(400).json({ error: "Invalid company reference", code: "INVALID_COMPANY" });
    }

    if (!canAccessCompany(req.user, companyId)) {
      return denyRequest(req, res, { companyId, resource: "company" });
    }

    req.companyId = companyId;
    return next();
  };
}

/**
 * Allows a caller to act on their own record, or requires a capability to act
 * on someone else's. Covers the "edit my profile" vs "edit any profile" split
 * without duplicating handlers.
 */
function requireSelfOrPermission(paramName, permission) {
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: "Authentication required", code: "UNAUTHENTICATED" });
    }
    const targetId = req.params?.[paramName] ?? req.body?.[paramName];
    if (targetId && String(targetId) === String(req.user.id)) return next();
    if (can(req.user, permission)) return next();
    return denyRequest(req, res, { targetUserId: targetId, action: permission });
  };
}

module.exports = {
  ROLE,
  ROLE_RANK,
  PERMISSION,
  resolveRole,
  can,
  permissionsFor,
  requirePermission,
  requireMinRole,
  requireCompanyAccess,
  requireSelfOrPermission,
};
