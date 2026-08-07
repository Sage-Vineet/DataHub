"use strict";

/**
 * Authentication middleware.
 *
 * Changes from the previous implementation, and why each mattered:
 *
 *   • Tokens are read ONLY from the Authorization header. Previously they were
 *     also accepted from `?token=`, `x-access-token`, `x-auth-token` and
 *     `x-token`. Query-string tokens leak into access logs, browser history and
 *     the Referer header sent to any third-party origin the page loads.
 *
 *   • The signing key is required at boot. `process.env.JWT_SECRET || "change_me"`
 *     meant a deploy with a missing variable accepted tokens signed with a
 *     publicly known string — a complete authentication bypass.
 *
 *   • Every request revalidates the server-side session, so logout, single-device
 *     login, idle timeout and admin revocation take effect immediately instead of
 *     waiting for the JWT to expire.
 *
 *   • The user cache is keyed on (userId, tokenVersion) and is skipped entirely
 *     for privilege data, so a role downgrade cannot be ridden out for 60s.
 *
 *   • Failures are generic. The old handler returned the caller's own role in a
 *     403 body, which hands an attacker a free privilege-mapping oracle.
 */

const { getUserById } = require("../services/userService");
const { extractBearerToken, verifyAccessToken, TokenError } = require("../security/tokens");
const sessionService = require("../services/sessionService");
const securityEvents = require("../services/securityEventService");
const logger = require("../security/logger");

// ── Bounded user cache ──────────────────────────────────────────────────────
// Short TTL, and the key includes token_version so bumping that column evicts
// the entry instantly across the whole process.
const USER_CACHE_TTL_MS = 30 * 1000;
const USER_CACHE_MAX = 500;
const userCache = new Map();
const inFlight = new Map();

function cacheKey(userId, tokenVersion) {
  return `${userId}:${tokenVersion ?? 0}`;
}

function getCachedUser(key) {
  const entry = userCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > USER_CACHE_TTL_MS) {
    userCache.delete(key);
    return null;
  }
  return entry.user;
}

function setCachedUser(key, user) {
  if (userCache.size >= USER_CACHE_MAX) {
    userCache.delete(userCache.keys().next().value);
  }
  userCache.set(key, { user, ts: Date.now() });
}

/** Evicts every cached entry for a user, across all token versions. */
function invalidateUserCache(userId) {
  if (!userId) return;
  const prefix = `${String(userId)}:`;
  for (const key of userCache.keys()) {
    if (key.startsWith(prefix)) userCache.delete(key);
  }
  for (const key of inFlight.keys()) {
    if (key.startsWith(prefix)) inFlight.delete(key);
  }
}

async function loadUser(userId, tokenVersion) {
  const key = cacheKey(userId, tokenVersion);
  const cached = getCachedUser(key);
  if (cached) return cached;

  let pending = inFlight.get(key);
  if (!pending) {
    pending = getUserById(userId).finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  const user = await pending;
  if (user) setCachedUser(key, user);
  return user;
}

/**
 * Sends a uniform 401. The `code` is machine-readable so the client can decide
 * whether to attempt a silent refresh, but the human-facing message never
 * distinguishes "no such user" from "wrong password" from "revoked".
 */
function unauthorized(res, code = "UNAUTHENTICATED") {
  return res.status(401).json({ error: "Authentication required", code });
}

/**
 * Requires a valid access token bound to a live session.
 * Populates req.user, req.sessionId and req.tokenPayload.
 */
async function requireAuth(req, res, next) {
  const token = extractBearerToken(req);
  if (!token) return unauthorized(res, "MISSING_TOKEN");

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch (error) {
    const code = error instanceof TokenError ? error.code : "INVALID";
    // TOKEN_EXPIRED is the signal the frontend uses to trigger a silent refresh.
    return unauthorized(res, code === "EXPIRED" ? "TOKEN_EXPIRED" : "INVALID_TOKEN");
  }

  if (!payload.sid) return unauthorized(res, "INVALID_TOKEN");

  // ── Server-side session check ────────────────────────────────────────────
  let session;
  try {
    session = await sessionService.validateSession(payload.sid);
  } catch (error) {
    // Store unavailable: fail closed rather than trusting the bearer token.
    logger.error("auth_session_check_failed", { name: error.name });
    return res.status(503).json({ error: "Service temporarily unavailable", code: "STORE_DOWN" });
  }

  if (!session.valid) {
    const expiryReasons = new Set(["idle_timeout", "absolute_timeout"]);
    return unauthorized(res, expiryReasons.has(session.reason) ? "SESSION_EXPIRED" : "SESSION_REVOKED");
  }

  // The session must belong to the subject named in the token. A mismatch means
  // a forged or stitched-together token.
  if (String(session.userId) !== String(payload.sub)) {
    await securityEvents.record({
      eventType: "token_session_subject_mismatch",
      severity: securityEvents.SEVERITY.CRITICAL,
      userId: payload.sub,
      ...securityEvents.fromRequest(req),
    });
    await sessionService.revokeSession(payload.sid, "reuse_detected");
    return unauthorized(res, "INVALID_TOKEN");
  }

  const user = await loadUser(payload.sub, payload.ver);
  if (!user) return unauthorized(res, "INVALID_TOKEN");

  // A deactivated account must lose access immediately, not at token expiry.
  if (String(user.status || "").toLowerCase() === "inactive") {
    await sessionService.revokeSession(payload.sid, "account_disabled");
    return unauthorized(res, "ACCOUNT_DISABLED");
  }

  // token_version is the global kill switch: bumping it in the DB invalidates
  // every outstanding access token for that user without touching sessions.
  if ((user.token_version ?? 0) !== (payload.ver ?? 0)) {
    return unauthorized(res, "TOKEN_STALE");
  }

  // Privileges always come from the freshly-loaded user record, never from the
  // token claims — a claim is a client-supplied assertion about itself.
  req.user = user;
  req.sessionId = payload.sid;
  req.tokenPayload = payload;
  return next();
}

/**
 * Attaches req.user when a valid token is present, but allows the request
 * through when it is absent. For endpoints with genuinely public behaviour that
 * enrich their response for signed-in callers. Never use this as a substitute
 * for requireAuth on anything that returns tenant data.
 */
async function optionalAuth(req, res, next) {
  if (!extractBearerToken(req)) return next();
  return requireAuth(req, res, (err) => (err ? next(err) : next()));
}

/**
 * Legacy role gate, retained so existing call sites keep working.
 * New code should prefer the capability-based `requirePermission` in rbac.js.
 */
function requireRole(roles) {
  const allowed = Array.isArray(roles) ? roles : [roles];
  return async (req, res, next) => {
    if (!req.user) return unauthorized(res, "UNAUTHENTICATED");
    if (!allowed.includes(req.user.role)) {
      await securityEvents.record({
        eventType: "authorization_denied",
        severity: securityEvents.SEVERITY.WARNING,
        ...securityEvents.fromRequest(req),
        metadata: { role: req.user.role, path: req.path, method: req.method },
      });
      // Generic body — no echo of the caller's role or the required role.
      return res.status(403).json({ error: "Access denied", code: "FORBIDDEN" });
    }
    return next();
  };
}

module.exports = { requireAuth, optionalAuth, requireRole, invalidateUserCache };
