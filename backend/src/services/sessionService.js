"use strict";

/**
 * Server-side session lifecycle.
 *
 * Delivers, together, the four requirements that a bare JWT cannot:
 *   1. Logout that actually invalidates  — revoke the row, the refresh token dies.
 *   2. Single active session per user    — a new login supersedes the old row.
 *   3. Idle + absolute session timeout   — enforced on the server, not the client.
 *   4. Refresh token rotation with theft detection.
 *
 * All queries go through the Supabase service-role client, which issues
 * parameterised PostgREST requests — no SQL string is ever concatenated.
 */

const crypto = require("crypto");
const { supabase } = require("../db");
const { config } = require("../config/env");
const { sha256 } = require("../security/crypto");
const {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  TokenError,
} = require("../security/tokens");
const logger = require("../security/logger");
const securityEvents = require("./securityEventService");

const TABLE = "auth_sessions";

class SessionError extends Error {
  constructor(message, code, status = 401) {
    super(message);
    this.name = "SessionError";
    this.code = code;
    this.status = status;
  }
}

function requireStore() {
  if (!supabase) {
    // Fail closed. An unreachable session store must not degrade into
    // "assume the session is valid".
    throw new SessionError("Session store unavailable", "STORE_UNAVAILABLE", 503);
  }
  return supabase;
}

function nowIso() {
  return new Date().toISOString();
}

function secondsFromNow(seconds) {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

/** user_agent is attacker-controlled free text; cap it before it reaches the DB. */
function truncateUserAgent(value) {
  const text = String(value || "").slice(0, 256);
  return text || null;
}

// ── Creation ────────────────────────────────────────────────────────────────

/**
 * Establishes a new session and issues the initial token pair.
 *
 * When SINGLE_DEVICE_LOGIN is on, every other live session for the user is
 * revoked first. The revocation is committed *before* the new session is
 * created so there is no window in which two sessions are simultaneously valid.
 */
async function createSession(user, { ipHash = null, userAgent = null } = {}) {
  const store = requireStore();

  if (config.SINGLE_DEVICE_LOGIN) {
    await revokeAllUserSessions(user.id, "superseded");
  }

  const sessionId = crypto.randomUUID();
  const familyId = crypto.randomUUID();
  const { token: refreshToken, jtiHash } = signRefreshToken({
    userId: user.id,
    sessionId,
    familyId,
  });

  const { error } = await store.from(TABLE).insert({
    id: sessionId,
    user_id: user.id,
    family_id: familyId,
    refresh_jti_hash: jtiHash,
    created_at: nowIso(),
    last_seen_at: nowIso(),
    absolute_expires_at: secondsFromNow(config.SESSION_ABSOLUTE_TIMEOUT_SECONDS),
    refresh_expires_at: secondsFromNow(config.REFRESH_TOKEN_TTL_SECONDS),
    ip_hash: ipHash,
    user_agent: truncateUserAgent(userAgent),
  });

  if (error) {
    logger.error("session_create_failed", { code: error.code });
    throw new SessionError("Could not establish session", "CREATE_FAILED", 503);
  }

  const accessToken = signAccessToken({
    userId: user.id,
    sessionId,
    role: user.role,
    subRole: user.sub_role,
    tokenVersion: user.token_version ?? 0,
  });

  await securityEvents.record({
    eventType: "session_created",
    userId: user.id,
    ipHash,
    userAgent,
    metadata: { singleDevice: config.SINGLE_DEVICE_LOGIN },
  });

  return {
    sessionId,
    accessToken,
    refreshToken,
    accessTokenExpiresIn: config.ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenExpiresIn: config.REFRESH_TOKEN_TTL_SECONDS,
  };
}

// ── Validation (hot path) ───────────────────────────────────────────────────

/**
 * Confirms a session is still live and slides the idle window forward.
 *
 * Returns the reason string when the session is NOT usable, or null when it is.
 * Called on every authenticated request via requireAuth.
 */
async function validateSession(sessionId, { touch = true } = {}) {
  const store = requireStore();

  const { data, error } = await store
    .from(TABLE)
    .select("id, user_id, revoked_at, revoked_reason, last_seen_at, absolute_expires_at")
    .eq("id", sessionId)
    .maybeSingle();

  if (error) {
    logger.error("session_lookup_failed", { code: error.code });
    throw new SessionError("Session store unavailable", "STORE_UNAVAILABLE", 503);
  }
  if (!data) return { valid: false, reason: "not_found" };
  if (data.revoked_at) return { valid: false, reason: data.revoked_reason || "revoked" };

  const now = Date.now();

  if (new Date(data.absolute_expires_at).getTime() <= now) {
    await revokeSession(sessionId, "absolute_timeout");
    return { valid: false, reason: "absolute_timeout" };
  }

  const idleDeadline =
    new Date(data.last_seen_at).getTime() + config.SESSION_IDLE_TIMEOUT_SECONDS * 1000;
  if (idleDeadline <= now) {
    await revokeSession(sessionId, "idle_timeout");
    return { valid: false, reason: "idle_timeout" };
  }

  if (touch) {
    // Only write when the stored timestamp is meaningfully stale. Without this
    // guard every request issues a DB write, which is both a latency and a
    // write-amplification problem on a busy tenant.
    const staleness = now - new Date(data.last_seen_at).getTime();
    if (staleness > TOUCH_THROTTLE_MS) {
      await touchSession(sessionId);
    }
  }

  return { valid: true, userId: data.user_id };
}

/** Refresh last_seen_at at most once per minute per session. */
const TOUCH_THROTTLE_MS = 60 * 1000;

async function touchSession(sessionId) {
  const store = requireStore();
  const { error } = await store
    .from(TABLE)
    .update({ last_seen_at: nowIso() })
    .eq("id", sessionId)
    .is("revoked_at", null);
  if (error) {
    // Non-fatal: a failed touch only risks a premature idle timeout, which is
    // the safe direction to fail in.
    logger.warn("session_touch_failed", { code: error.code });
  }
}

// ── Rotation ────────────────────────────────────────────────────────────────

/**
 * Exchanges a refresh token for a new token pair, rotating the refresh token.
 *
 * Theft detection: the update is conditional on the presented jti hash still
 * being the current one for the session. Because rotation overwrites that hash
 * atomically, a second use of an already-rotated token matches zero rows. That
 * signals the token was captured and replayed, so the entire token family is
 * revoked and the legitimate user is forced to re-authenticate.
 */
async function rotateRefreshToken(rawRefreshToken, { ipHash = null, userAgent = null } = {}) {
  const store = requireStore();

  let payload;
  try {
    payload = verifyRefreshToken(rawRefreshToken);
  } catch (error) {
    throw new SessionError(
      "Invalid session",
      error instanceof TokenError ? error.code : "INVALID",
      401
    );
  }

  const presentedHash = sha256(payload.jti);
  const sessionId = payload.sid;

  const { data: session, error: lookupError } = await store
    .from(TABLE)
    .select(
      "id, user_id, family_id, refresh_jti_hash, revoked_at, revoked_reason, " +
        "last_seen_at, absolute_expires_at, refresh_expires_at"
    )
    .eq("id", sessionId)
    .maybeSingle();

  if (lookupError) {
    logger.error("session_refresh_lookup_failed", { code: lookupError.code });
    throw new SessionError("Session store unavailable", "STORE_UNAVAILABLE", 503);
  }
  if (!session) {
    throw new SessionError("Invalid session", "NOT_FOUND", 401);
  }

  // ── Replay detection ──────────────────────────────────────────────────────
  if (session.refresh_jti_hash !== presentedHash) {
    await revokeFamily(session.family_id, "reuse_detected");
    await securityEvents.record({
      eventType: "refresh_token_reuse_detected",
      severity: "critical",
      userId: session.user_id,
      ipHash,
      userAgent,
      metadata: { sessionId, familyId: session.family_id },
    });
    throw new SessionError("Session revoked", "REUSE_DETECTED", 401);
  }

  if (session.revoked_at) {
    throw new SessionError("Session revoked", session.revoked_reason || "REVOKED", 401);
  }

  const now = Date.now();
  if (new Date(session.absolute_expires_at).getTime() <= now) {
    await revokeSession(sessionId, "absolute_timeout");
    throw new SessionError("Session expired", "ABSOLUTE_TIMEOUT", 401);
  }
  if (new Date(session.refresh_expires_at).getTime() <= now) {
    await revokeSession(sessionId, "absolute_timeout");
    throw new SessionError("Session expired", "REFRESH_EXPIRED", 401);
  }

  const idleDeadline =
    new Date(session.last_seen_at).getTime() + config.SESSION_IDLE_TIMEOUT_SECONDS * 1000;
  if (idleDeadline <= now) {
    await revokeSession(sessionId, "idle_timeout");
    throw new SessionError("Session expired", "IDLE_TIMEOUT", 401);
  }

  // The user record is re-read on every rotation so a role change, a
  // deactivation, or a token_version bump takes effect within one access-token
  // lifetime rather than at the end of the refresh window.
  const { getUserById } = require("./userService");
  const user = await getUserById(session.user_id);
  if (!user || String(user.status || "").toLowerCase() === "inactive") {
    await revokeSession(sessionId, "account_disabled");
    throw new SessionError("Session revoked", "ACCOUNT_DISABLED", 401);
  }

  const { token: newRefreshToken, jtiHash: newHash } = signRefreshToken({
    userId: session.user_id,
    sessionId,
    familyId: session.family_id,
  });

  // Conditional on the old hash: two concurrent refreshes race here and exactly
  // one wins. The loser sees zero updated rows and is treated as a replay.
  const { data: updated, error: updateError } = await store
    .from(TABLE)
    .update({ refresh_jti_hash: newHash, last_seen_at: nowIso() })
    .eq("id", sessionId)
    .eq("refresh_jti_hash", presentedHash)
    .is("revoked_at", null)
    .select("id");

  if (updateError) {
    logger.error("session_rotate_failed", { code: updateError.code });
    throw new SessionError("Session store unavailable", "STORE_UNAVAILABLE", 503);
  }
  if (!updated || updated.length === 0) {
    await revokeFamily(session.family_id, "reuse_detected");
    await securityEvents.record({
      eventType: "refresh_token_race_or_reuse",
      severity: "critical",
      userId: session.user_id,
      ipHash,
      metadata: { sessionId },
    });
    throw new SessionError("Session revoked", "REUSE_DETECTED", 401);
  }

  const accessToken = signAccessToken({
    userId: user.id,
    sessionId,
    role: user.role,
    subRole: user.sub_role,
    tokenVersion: user.token_version ?? 0,
  });

  return {
    user,
    sessionId,
    accessToken,
    refreshToken: newRefreshToken,
    accessTokenExpiresIn: config.ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenExpiresIn: config.REFRESH_TOKEN_TTL_SECONDS,
  };
}

// ── Revocation ──────────────────────────────────────────────────────────────

async function revokeSession(sessionId, reason = "logout") {
  if (!sessionId) return;
  const store = requireStore();
  const { error } = await store
    .from(TABLE)
    .update({ revoked_at: nowIso(), revoked_reason: reason })
    .eq("id", sessionId)
    .is("revoked_at", null);
  if (error) logger.error("session_revoke_failed", { code: error.code, reason });
}

async function revokeFamily(familyId, reason = "reuse_detected") {
  if (!familyId) return;
  const store = requireStore();
  const { error } = await store
    .from(TABLE)
    .update({ revoked_at: nowIso(), revoked_reason: reason })
    .eq("family_id", familyId)
    .is("revoked_at", null);
  if (error) logger.error("session_family_revoke_failed", { code: error.code, reason });
}

/** Kills every live session for a user — logout-all, password change, lockout. */
async function revokeAllUserSessions(userId, reason = "logout_all") {
  if (!userId) return 0;
  const store = requireStore();
  const { data, error } = await store
    .from(TABLE)
    .update({ revoked_at: nowIso(), revoked_reason: reason })
    .eq("user_id", userId)
    .is("revoked_at", null)
    .select("id");
  if (error) {
    logger.error("session_revoke_all_failed", { code: error.code, reason });
    return 0;
  }
  return data?.length || 0;
}

async function listActiveSessions(userId) {
  const store = requireStore();
  const { data, error } = await store
    .from(TABLE)
    .select("id, created_at, last_seen_at, absolute_expires_at, user_agent")
    .eq("user_id", userId)
    .is("revoked_at", null)
    .order("last_seen_at", { ascending: false });
  if (error) return [];
  return data || [];
}

/** Housekeeping for expired rows; safe to call from a scheduled task. */
async function pruneExpiredSessions() {
  const store = requireStore();
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await store.from(TABLE).delete().lt("absolute_expires_at", cutoff);
  if (error) logger.warn("session_prune_failed", { code: error.code });
}

module.exports = {
  SessionError,
  createSession,
  validateSession,
  rotateRefreshToken,
  revokeSession,
  revokeFamily,
  revokeAllUserSessions,
  listActiveSessions,
  pruneExpiredSessions,
};
