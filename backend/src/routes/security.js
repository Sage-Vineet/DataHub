"use strict";

/**
 * Administrative security endpoints — audit trail, session control, unlocks.
 *
 * Every route requires an explicit admin-tier capability. These endpoints are
 * themselves high value (the audit log is where an attacker would go to cover
 * their tracks), so access to them is recorded like any other privileged action.
 */

const express = require("express");
const asyncHandler = require("../utils");
const { requireAuth } = require("../middleware/auth");
const { requirePermission, PERMISSION, permissionsFor, resolveRole } = require("../middleware/rbac");
const { validate, schemas, z } = require("../middleware/validate");
const securityEvents = require("../services/securityEventService");
const sessionService = require("../services/sessionService");
const accountLockout = require("../services/accountLockoutService");
const { invalidateUserCache } = require("../middleware/auth");

const router = express.Router();

router.use(requireAuth);

/**
 * GET /security/permissions
 * The caller's own effective capabilities. Available to every authenticated
 * user because it only describes what they already are — the frontend uses it
 * to decide which controls to render.
 */
router.get(
  "/permissions",
  asyncHandler(async (req, res) => {
    return res.json({
      role: resolveRole(req.user),
      permissions: permissionsFor(req.user),
    });
  })
);

/** GET /security/events — the audit trail. */
router.get(
  "/events",
  requirePermission(PERMISSION.SECURITY_AUDIT_READ),
  validate({
    query: z.object({
      userId: schemas.uuid.optional(),
      severity: z.enum(["info", "warning", "critical"]).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
    }),
  }),
  asyncHandler(async (req, res) => {
    const events = await securityEvents.listRecent(req.query);
    await securityEvents.record({
      eventType: "audit_log_accessed",
      ...securityEvents.fromRequest(req),
      metadata: { targetUserId: req.query.userId || null },
    });
    return res.json({ events });
  })
);

/** GET /security/users/:userId/sessions — sessions for any user. */
router.get(
  "/users/:userId/sessions",
  requirePermission(PERMISSION.SECURITY_SESSION_REVOKE),
  validate({ params: z.object({ userId: schemas.uuid }) }),
  asyncHandler(async (req, res) => {
    const sessions = await sessionService.listActiveSessions(req.params.userId);
    return res.json({ sessions });
  })
);

/** POST /security/users/:userId/revoke-sessions — force a user offline. */
router.post(
  "/users/:userId/revoke-sessions",
  requirePermission(PERMISSION.SECURITY_SESSION_REVOKE),
  validate({ params: z.object({ userId: schemas.uuid }) }),
  asyncHandler(async (req, res) => {
    const revoked = await sessionService.revokeAllUserSessions(
      req.params.userId,
      "admin_revoked"
    );
    invalidateUserCache(req.params.userId);
    await securityEvents.record({
      eventType: "admin_revoked_sessions",
      severity: securityEvents.SEVERITY.WARNING,
      ...securityEvents.fromRequest(req),
      metadata: { targetUserId: req.params.userId, revokedCount: revoked },
    });
    return res.json({ revokedSessions: revoked });
  })
);

/** POST /security/accounts/unlock — clear a lockout early. */
router.post(
  "/accounts/unlock",
  requirePermission(PERMISSION.SECURITY_ACCOUNT_UNLOCK),
  validate({ body: schemas.strictObject({ email: schemas.email }) }),
  asyncHandler(async (req, res) => {
    await accountLockout.unlockAccount(req.body.email, { actorId: req.user.id });
    return res.json({ success: true });
  })
);

module.exports = router;
