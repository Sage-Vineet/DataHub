/**
 * Capability names, mirroring backend/src/middleware/rbac.js.
 *
 * Kept in a plain module (not a component file) so importing it never breaks
 * React Fast Refresh.
 *
 * These names drive UI gating only. Every one is independently enforced on the
 * server. A name that does not exist server-side simply never matches, so the
 * UI fails closed — the control stays hidden — which is the safe direction for
 * a typo.
 */
export const PERMISSION = Object.freeze({
  USER_READ: 'user:read',
  USER_CREATE: 'user:create',
  USER_UPDATE: 'user:update',
  USER_DELETE: 'user:delete',
  USER_IMPERSONATE: 'user:impersonate',

  COMPANY_READ: 'company:read',
  COMPANY_CREATE: 'company:create',
  COMPANY_UPDATE: 'company:update',
  COMPANY_DELETE: 'company:delete',

  DOCUMENT_READ: 'document:read',
  DOCUMENT_UPLOAD: 'document:upload',
  DOCUMENT_DELETE: 'document:delete',

  REPORT_READ: 'report:read',
  REPORT_GENERATE: 'report:generate',
  REPORT_APPROVE: 'report:approve',
  REPORT_DELETE: 'report:delete',

  REQUEST_READ: 'request:read',
  REQUEST_CREATE: 'request:create',
  REQUEST_UPDATE: 'request:update',
  REQUEST_APPROVE: 'request:approve',
  REQUEST_DELETE: 'request:delete',

  INTEGRATION_READ: 'integration:read',
  INTEGRATION_CONNECT: 'integration:connect',
  INTEGRATION_DISCONNECT: 'integration:disconnect',

  SECURITY_AUDIT_READ: 'security:audit:read',
  SECURITY_SESSION_REVOKE: 'security:session:revoke',
  SECURITY_ACCOUNT_UNLOCK: 'security:account:unlock',
});

/** Canonical role tiers, matching the server's resolveRole(). */
export const ROLE = Object.freeze({
  ADMIN: 'admin',
  MANAGER: 'manager',
  USER: 'user',
  VIEWER: 'viewer',
});

export const ROLE_RANK = Object.freeze({
  [ROLE.ADMIN]: 40,
  [ROLE.MANAGER]: 30,
  [ROLE.USER]: 20,
  [ROLE.VIEWER]: 10,
});
