"use strict";

/**
 * Account lockout after repeated failed logins.
 *
 * WHY: Rate limiting by IP alone is insufficient — a botnet spreads a password
 * spray across thousands of addresses, each staying under the per-IP ceiling.
 * Counting failures per *account* closes that path. Conversely, per-account
 * lockout alone enables a trivial denial-of-service (lock every user by
 * guessing wrong), so this is paired with per-IP limiting in rateLimit.js and
 * uses a time-boxed lock rather than a permanent one.
 *
 * Implements OWASP ASVS v4 §2.2.1.
 */

const { supabase } = require("../db");
const { config } = require("../config/env");
const logger = require("../security/logger");
const securityEvents = require("./securityEventService");

const LOCKOUT_TABLE = "account_lockouts";
const ATTEMPTS_TABLE = "login_attempts";

function normaliseEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * Returns lock state for an email.
 *
 * Fails CLOSED on store errors for the lock check: if we cannot prove the
 * account is unlocked we must not let the attempt through, otherwise an
 * attacker who can induce DB errors also disables lockout.
 */
async function getLockStatus(email) {
  const normalised = normaliseEmail(email);
  if (!normalised || !supabase) {
    return { locked: false, retryAfterSeconds: 0, failedCount: 0 };
  }

  const { data, error } = await supabase
    .from(LOCKOUT_TABLE)
    .select("email, failed_count, locked_until, first_failure_at")
    .eq("email", normalised)
    .maybeSingle();

  if (error) {
    // Fail CLOSED. If we cannot prove the account is unlocked, the attempt must
    // not proceed — otherwise an attacker who can induce store errors has also
    // disabled lockout. `expose` marks the message safe to return verbatim so
    // the client gets a retryable 503 rather than an opaque 500.
    logger.error("lockout_lookup_failed", { code: error.code });
    throw Object.assign(new Error("Authentication temporarily unavailable."), {
      status: 503,
      code: "AUTH_STORE_UNAVAILABLE",
      expose: true,
    });
  }

  if (!data) return { locked: false, retryAfterSeconds: 0, failedCount: 0 };

  if (data.locked_until) {
    const until = new Date(data.locked_until).getTime();
    if (until > Date.now()) {
      return {
        locked: true,
        retryAfterSeconds: Math.ceil((until - Date.now()) / 1000),
        failedCount: data.failed_count,
      };
    }
    // Lock has elapsed — clear it so the counter starts fresh.
    await resetFailures(normalised);
    return { locked: false, retryAfterSeconds: 0, failedCount: 0 };
  }

  // Failures older than the tracking window no longer count.
  const windowStart = Date.now() - config.LOGIN_ATTEMPT_WINDOW_SECONDS * 1000;
  if (new Date(data.first_failure_at).getTime() < windowStart) {
    await resetFailures(normalised);
    return { locked: false, retryAfterSeconds: 0, failedCount: 0 };
  }

  return { locked: false, retryAfterSeconds: 0, failedCount: data.failed_count };
}

/**
 * Records a failed login and locks the account once the threshold is reached.
 * Returns the resulting lock state.
 */
async function recordFailure(email, { ipHash = null, userId = null, kind = "bad_password", userAgent = null } = {}) {
  const normalised = normaliseEmail(email);
  if (!normalised || !supabase) return { locked: false, retryAfterSeconds: 0 };

  await recordAttempt({ email: normalised, userId, ipHash, successful: false, kind });

  const { data: existing } = await supabase
    .from(LOCKOUT_TABLE)
    .select("email, failed_count, first_failure_at, locked_until, notified_at")
    .eq("email", normalised)
    .maybeSingle();

  const windowStart = Date.now() - config.LOGIN_ATTEMPT_WINDOW_SECONDS * 1000;
  const withinWindow =
    existing && new Date(existing.first_failure_at).getTime() >= windowStart;

  const failedCount = withinWindow ? (existing.failed_count || 0) + 1 : 1;
  const shouldLock = failedCount >= config.LOGIN_MAX_FAILED_ATTEMPTS;
  const lockedUntil = shouldLock
    ? new Date(Date.now() + config.LOGIN_LOCKOUT_SECONDS * 1000).toISOString()
    : null;

  const { error } = await supabase.from(LOCKOUT_TABLE).upsert(
    {
      email: normalised,
      failed_count: failedCount,
      first_failure_at: withinWindow ? existing.first_failure_at : nowIso(),
      last_failure_at: nowIso(),
      locked_until: lockedUntil,
      notified_at: shouldLock ? existing?.notified_at ?? null : null,
    },
    { onConflict: "email" }
  );

  if (error) {
    logger.error("lockout_update_failed", { code: error.code });
    return { locked: false, retryAfterSeconds: 0 };
  }

  if (shouldLock) {
    await securityEvents.record({
      eventType: "account_locked",
      severity: securityEvents.SEVERITY.WARNING,
      userId,
      email: normalised,
      ipHash,
      userAgent,
      metadata: { attemptCount: failedCount, lockedUntil },
    });

    // Notify only a real account, and only once per lock, so the endpoint
    // cannot be turned into a mail bomb or an account-enumeration oracle.
    if (config.LOGIN_LOCKOUT_NOTIFY && userId && !existing?.notified_at) {
      notifyUserOfLockout(normalised, lockedUntil).catch(() => {});
      await supabase
        .from(LOCKOUT_TABLE)
        .update({ notified_at: nowIso() })
        .eq("email", normalised);
    }

    return {
      locked: true,
      retryAfterSeconds: config.LOGIN_LOCKOUT_SECONDS,
      failedCount,
    };
  }

  return {
    locked: false,
    retryAfterSeconds: 0,
    failedCount,
    remaining: Math.max(0, config.LOGIN_MAX_FAILED_ATTEMPTS - failedCount),
  };
}

/** Clears the failure counter after a successful authentication. */
async function recordSuccess(email, { userId = null, ipHash = null } = {}) {
  const normalised = normaliseEmail(email);
  if (!normalised || !supabase) return;
  await recordAttempt({ email: normalised, userId, ipHash, successful: true, kind: null });
  await resetFailures(normalised);
}

async function resetFailures(email) {
  if (!supabase) return;
  const { error } = await supabase.from(LOCKOUT_TABLE).delete().eq("email", normaliseEmail(email));
  if (error) logger.warn("lockout_reset_failed", { code: error.code });
}

/** Administrative unlock. */
async function unlockAccount(email, { actorId = null } = {}) {
  const normalised = normaliseEmail(email);
  await resetFailures(normalised);
  await securityEvents.record({
    eventType: "account_unlocked",
    severity: securityEvents.SEVERITY.WARNING,
    email: normalised,
    userId: actorId,
    metadata: { reason: "admin_unlock" },
  });
}

async function recordAttempt({ email, userId, ipHash, successful, kind }) {
  if (!supabase) return;
  const { error } = await supabase.from(ATTEMPTS_TABLE).insert({
    email,
    user_id: userId,
    ip_hash: ipHash,
    successful,
    failure_kind: kind,
  });
  if (error) logger.warn("login_attempt_insert_failed", { code: error.code });
}

async function notifyUserOfLockout(email, lockedUntil) {
  try {
    const emailService = require("./emailService");
    // The mailer is optional — only call a sender that actually exists.
    const send = emailService.sendAccountLockedEmail || emailService.sendSecurityAlertEmail;
    if (typeof send !== "function") return;
    await send(email, {
      lockedUntil,
      minutes: Math.round(config.LOGIN_LOCKOUT_SECONDS / 60),
    });
  } catch (error) {
    logger.warn("lockout_notification_failed", { name: error.name });
  }
}

module.exports = {
  getLockStatus,
  recordFailure,
  recordSuccess,
  resetFailures,
  unlockAccount,
};
