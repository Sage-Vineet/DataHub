const { Pool } = require("pg");
const { supabase } = require("../db");
const { config } = require("../config/env");
const logger = require("../security/logger");
const {
  hashPassword,
  verifyPassword,
  validatePassword,
  burnPasswordTiming,
} = require("../security/passwordPolicy");
const sessionService = require("./sessionService");
const accountLockout = require("./accountLockoutService");
const securityEvents = require("./securityEventService");

let _authPool = null;
function getAuthPool() {
  if (!config.DATABASE_URL) return null;
  if (!_authPool) {
    const isLocal = /localhost|127\.0\.0\.1/.test(config.DATABASE_URL);
    _authPool = new Pool({
      connectionString: config.DATABASE_URL,
      // Certificate verification is enabled in production. `rejectUnauthorized:
      // false` accepts ANY certificate, which reduces TLS to obfuscation and
      // leaves the connection open to an active man-in-the-middle — the whole
      // point of TLS to a managed database is authenticating the server.
      ssl: isLocal ? false : { rejectUnauthorized: config.DATABASE_SSL_REJECT_UNAUTHORIZED },
      max: 5,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 30000,
    });
    _authPool.on("error", (error) => {
      logger.error("auth_pool_error", { name: error.name });
    });
  }
  return _authPool;
}
const { attachAssignedCompanies, flattenUser, getUserByEmail, getUserById } = require("./userService");
const { invalidateUserCache } = require("../middleware/auth");

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeText(value) {
  return String(value || "").trim();
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isValidPhone() {
  return true;
}

async function setBrokerCompanyProfile(userId, brokerCompany) {
  if (!brokerCompany) return;
  const { error } = await supabase
    .from("users")
    .update({ broker_company: brokerCompany })
    .eq("id", userId);

  const missingColumn = error && (
    error.code === "42703" ||
    error.message?.toLowerCase().includes("broker_company") ||
    error.message?.toLowerCase().includes("column")
  );

  if (error && !missingColumn) throw error;
}

/**
 * Syncs user company assignment in the join table
 */
async function syncUserCompanyAssignment(userId, companyId) {
  if (!userId || !companyId) return;
  const { error } = await supabase
    .from("user_companies")
    .upsert({ user_id: userId, company_id: companyId }, { onConflict: "user_id,company_id" });

  if (error) {
    console.error("❌ Error syncing user company assignment via Supabase:", error.message);
    // Pg fallback — critical for post-migration state where Supabase RLS may block
    const pool = getAuthPool();
    if (pool) {
      try {
        await pool.query(
          `INSERT INTO user_companies (user_id, company_id)
           VALUES ($1, $2)
           ON CONFLICT (user_id, company_id) DO NOTHING`,
          [userId, companyId],
        );
      } catch (pgErr) {
        console.error("❌ pg fallback for syncUserCompanyAssignment also failed:", pgErr.message);
      }
    }
  }
}

/**
 * Creates default folders for a company if they don't exist
 */
async function ensureDefaultFolders(companyId, createdBy) {
  if (!companyId || !createdBy) return;

  const { data: existing, error: findError } = await supabase
    .from("folders")
    .select("id")
    .eq("company_id", companyId)
    .limit(1);

  if (findError || (existing && existing.length > 0)) return;

  const defaults = ["Finance", "Compliance", "HR", "Legal", "M&A", "Tax", "Other"];
  const folders = defaults.map(name => ({
    company_id: companyId,
    parent_id: null,
    name,
    color: null,
    created_by: createdBy
  }));

  const { error: insertError } = await supabase.from("folders").insert(folders);
  if (insertError) console.error("❌ Error creating default folders:", insertError.message);
}

/** Thrown for every authentication failure — the caller must not distinguish. */
class AuthenticationError extends Error {
  constructor(code = "INVALID_CREDENTIALS", { status = 401, retryAfter = null } = {}) {
    super("Invalid credentials");
    this.name = "AuthenticationError";
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/**
 * Reads a user's stored password hash, preferring whatever the user service
 * already loaded and falling back to a direct query.
 */
async function loadPasswordHash(user) {
  if (user.password_hash) return user.password_hash;

  if (supabase) {
    const { data } = await supabase
      .from("users")
      .select("password_hash")
      .eq("id", user.id)
      .maybeSingle();
    if (data?.password_hash) return data.password_hash;
  }

  const pool = getAuthPool();
  if (pool) {
    try {
      // Parameterised — the id is never interpolated into the SQL text.
      const { rows } = await pool.query(
        "SELECT password_hash FROM users WHERE id = $1 LIMIT 1",
        [user.id]
      );
      return rows[0]?.password_hash || null;
    } catch (error) {
      logger.error("password_hash_lookup_failed", { name: error.name });
    }
  }
  return null;
}

/**
 * Recovers a client/buyer account's company association when a migration left
 * `company_id` null. Unchanged in behaviour; extracted for clarity.
 */
async function reconcileClientCompany(user, normalizedEmail, { seedFolders = false } = {}) {
  let resolvedCompanyId = user.company_id;

  if (!resolvedCompanyId && supabase) {
    const { data: matched } = await supabase
      .from("companies")
      .select("id")
      .ilike("contact_email", normalizedEmail)
      .maybeSingle();
    if (matched?.id) {
      resolvedCompanyId = matched.id;
      await supabase.from("users").update({ company_id: resolvedCompanyId }).eq("id", user.id);
    }
  }

  if (resolvedCompanyId) {
    await syncUserCompanyAssignment(user.id, resolvedCompanyId);
    if (seedFolders) await ensureDefaultFolders(resolvedCompanyId, user.id);
  }
}

/**
 * Authenticates a user and establishes a session.
 *
 * SECURITY CHANGES from the previous implementation:
 *
 *   1. The plaintext comparison is gone. The old code ran
 *      `ok = rawPassword === storedPassword` whenever the stored value was not
 *      a bcrypt hash, so any account whose row held a plaintext password (seed
 *      data, a migration artefact, a manual insert) authenticated on a string
 *      match. `verifyPassword` now fails closed on any non-bcrypt value.
 *
 *   2. The shared static password is gone. Every client/buyer account could
 *      previously authenticate with CLIENT_STATIC_PASSWORD, which defaulted to
 *      "123456" when the env var was unset — one guess for every customer
 *      account in the system.
 *
 *   3. Failed attempts are counted and the account is locked temporarily.
 *
 *   4. Timing is equalised: a request for a non-existent account performs the
 *      same bcrypt work as a real one, so response latency does not reveal
 *      which addresses are registered.
 *
 *   5. A short-lived access token plus a revocable refresh token replace the
 *      previous single 7-day token that could not be invalidated.
 *
 * @returns {Promise<{user: object, accessToken: string, refreshToken: string, expiresIn: number}>}
 */
async function authenticate(email, password, context = {}) {
  const { ipHash = null, userAgent = null } = context;
  const normalizedEmail = normalizeEmail(email);
  const rawPassword = String(password || "");

  if (!normalizedEmail || !rawPassword) {
    await burnPasswordTiming();
    throw new AuthenticationError();
  }

  // ── Lockout check comes first ─────────────────────────────────────────────
  const lock = await accountLockout.getLockStatus(normalizedEmail);
  if (lock.locked) {
    await securityEvents.record({
      eventType: "login_blocked_locked_account",
      severity: securityEvents.SEVERITY.WARNING,
      email: normalizedEmail,
      ipHash,
      userAgent,
      metadata: { retryAfter: lock.retryAfterSeconds },
    });
    throw new AuthenticationError("ACCOUNT_LOCKED", {
      status: 429,
      retryAfter: lock.retryAfterSeconds,
    });
  }

  const user = await getUserByEmail(normalizedEmail);

  // Unknown account: burn equivalent bcrypt time, record the attempt, and
  // return the same error a wrong password produces.
  if (!user) {
    await burnPasswordTiming();
    await accountLockout.recordFailure(normalizedEmail, {
      ipHash,
      userAgent,
      kind: "unknown_account",
    });
    throw new AuthenticationError();
  }

  if (String(user.status || "").toLowerCase() === "inactive") {
    await burnPasswordTiming();
    await accountLockout.recordFailure(normalizedEmail, {
      ipHash,
      userAgent,
      userId: user.id,
      kind: "inactive_account",
    });
    throw new AuthenticationError();
  }

  const storedHash = await loadPasswordHash(user);
  const passwordMatches = await verifyPassword(rawPassword, storedHash);

  if (!passwordMatches) {
    const failure = await accountLockout.recordFailure(normalizedEmail, {
      ipHash,
      userAgent,
      userId: user.id,
      kind: storedHash ? "bad_password" : "no_credential",
    });
    await securityEvents.record({
      eventType: "login_failed",
      severity: securityEvents.SEVERITY.WARNING,
      userId: user.id,
      email: normalizedEmail,
      ipHash,
      userAgent,
      metadata: { attemptCount: failure.failedCount },
    });
    if (failure.locked) {
      throw new AuthenticationError("ACCOUNT_LOCKED", {
        status: 429,
        retryAfter: failure.retryAfterSeconds,
      });
    }
    throw new AuthenticationError();
  }

  // ── Authenticated ─────────────────────────────────────────────────────────
  await accountLockout.recordSuccess(normalizedEmail, { userId: user.id, ipHash });

  const isClientUser = user.role === "buyer" || user.role === "client";
  if (isClientUser) {
    await reconcileClientCompany(user, normalizedEmail, { seedFolders: true });
  }

  invalidateUserCache(user.id);
  const freshUser = (await getUserById(user.id)) || user;

  // Establish the server-side session. With SINGLE_DEVICE_LOGIN enabled this
  // revokes every other live session for the user first.
  const session = await sessionService.createSession(freshUser, { ipHash, userAgent });

  if (supabase) {
    await supabase
      .from("users")
      .update({ last_login_at: new Date().toISOString() })
      .eq("id", freshUser.id);
  }

  await securityEvents.record({
    eventType: "login_succeeded",
    userId: freshUser.id,
    email: normalizedEmail,
    ipHash,
    userAgent,
    metadata: { sessionId: session.sessionId, role: freshUser.role },
  });

  const safeUser = toSafeUser(freshUser);

  return {
    user: safeUser,
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    expiresIn: session.accessTokenExpiresIn,
    mustChangePassword: Boolean(freshUser.must_change_password),
  };
}

/** Strips every credential-bearing field before a user object leaves the server. */
function toSafeUser(user) {
  if (!user) return null;
  const safe = { ...user };
  delete safe.password_hash;
  delete safe.password;
  delete safe.token_version;
  return safe;
}

/**
 * Changes a user's password and invalidates every existing session.
 *
 * WHY sessions die on password change: the usual reason a user changes their
 * password is that they believe it is compromised. Leaving the attacker's
 * existing session alive defeats the entire point of the change.
 */
async function changePassword(userId, { currentPassword, newPassword }, context = {}) {
  const user = await getUserById(userId);
  if (!user) throw new AuthenticationError();

  const storedHash = await loadPasswordHash(user);
  const matches = await verifyPassword(currentPassword, storedHash);
  if (!matches) {
    await securityEvents.record({
      eventType: "password_change_failed",
      severity: securityEvents.SEVERITY.WARNING,
      userId,
      ...context,
      metadata: { reason: "wrong_current_password" },
    });
    throw new AuthenticationError();
  }

  const policy = validatePassword(newPassword, { email: user.email, name: user.name });
  if (!policy.valid) {
    const error = new Error(policy.errors[0]);
    error.status = 400;
    error.expose = true;
    error.details = policy.errors;
    throw error;
  }

  // Reusing the current password is not a change.
  if (await verifyPassword(newPassword, storedHash)) {
    const error = new Error("New password must differ from the current password.");
    error.status = 400;
    error.expose = true;
    throw error;
  }

  const passwordHash = await hashPassword(newPassword);
  const { error: updateError } = await supabase
    .from("users")
    .update({
      password_hash: passwordHash,
      password_changed_at: new Date().toISOString(),
      must_change_password: false,
      // Bumping token_version invalidates every outstanding access token
      // immediately, without waiting for its 15-minute expiry.
      token_version: (user.token_version ?? 0) + 1,
    })
    .eq("id", userId);

  if (updateError) throw updateError;

  invalidateUserCache(userId);
  const revoked = await sessionService.revokeAllUserSessions(userId, "password_change");

  await securityEvents.record({
    eventType: "password_changed",
    severity: securityEvents.SEVERITY.WARNING,
    userId,
    ...context,
    metadata: { revokedCount: revoked },
  });

  return { revokedSessions: revoked };
}

async function createBrokerAccount(payload = {}) {
  const name = normalizeText(payload.name);
  const email = normalizeEmail(payload.email);
  const phone = normalizeText(payload.phone);
  const password = String(payload.password || "");
  const brokerCompany = normalizeText(payload.broker_company || payload.brokerCompany);

  if (!name) {
    const error = new Error("Full name is required.");
    error.status = 400;
    throw error;
  }
  if (!email || !isValidEmail(email)) {
    const error = new Error("Please enter a valid email address.");
    error.status = 400;
    throw error;
  }
  // Full policy: 12+ chars, all four character classes, not a common password,
  // and not derived from the account's own name or email.
  const policy = validatePassword(password, { email, name });
  if (!policy.valid) {
    const error = new Error(policy.errors[0]);
    error.status = 400;
    error.expose = true;
    error.details = policy.errors;
    throw error;
  }
  if (!isValidPhone(phone)) {
    const error = new Error("Please enter a valid phone number.");
    error.status = 400;
    throw error;
  }

  const existing = await getUserByEmail(email);
  if (existing) {
    const error = new Error("An account with this email already exists.");
    error.status = 409;
    throw error;
  }

  // Work factor comes from config (>= 12), not a hardcoded 10. Each extra
  // round doubles the cost of an offline cracking attempt against a stolen hash.
  const passwordHash = await hashPassword(password);
  const { data: created, error } = await supabase
    .from("users")
    .insert({
      name,
      email,
      phone: phone || null,
      password_hash: passwordHash,
      role: "broker",
      company_id: null,
      status: "active",
      password_changed_at: new Date().toISOString(),
    })
    .select(`
      id, name, email, phone, role, company_id, status, created_at, updated_at,
      companies:company_id ( name )
    `)
    .single();

  if (error) {
    if (error.code === "23505") {
      const duplicate = new Error("An account with this email already exists.");
      duplicate.status = 409;
      throw duplicate;
    }
    throw error;
  }

  await setBrokerCompanyProfile(created.id, brokerCompany);

  const user = await attachAssignedCompanies(flattenUser({
    ...created,
    broker_company: brokerCompany || null,
  }));

  const session = await sessionService.createSession(user, {
    ipHash: payload.ipHash || null,
    userAgent: payload.userAgent || null,
  });

  await securityEvents.record({
    eventType: "account_created",
    userId: user.id,
    email,
    ipHash: payload.ipHash || null,
    metadata: { role: "broker" },
  });

  return {
    user: toSafeUser(user),
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    expiresIn: session.accessTokenExpiresIn,
  };
}

/**
 * Sets a user's password without knowing the current one — the completion step
 * of a verified password-reset flow. Callers MUST have already verified an
 * action token bound to this email.
 */
async function resetPasswordForUser(user, newPassword, context = {}) {
  const policy = validatePassword(newPassword, { email: user.email, name: user.name });
  if (!policy.valid) {
    const error = new Error(policy.errors[0]);
    error.status = 400;
    error.expose = true;
    error.details = policy.errors;
    throw error;
  }

  const passwordHash = await hashPassword(newPassword);
  const { error: updateError } = await supabase
    .from("users")
    .update({
      password_hash: passwordHash,
      password_changed_at: new Date().toISOString(),
      must_change_password: false,
      token_version: (user.token_version ?? 0) + 1,
    })
    .eq("id", user.id);

  if (updateError) throw updateError;

  invalidateUserCache(user.id);
  // Every session dies: a reset is the standard response to a suspected
  // compromise, so any session an attacker holds must go with it.
  const revoked = await sessionService.revokeAllUserSessions(user.id, "password_change");

  await securityEvents.record({
    eventType: "password_reset_completed",
    severity: securityEvents.SEVERITY.WARNING,
    userId: user.id,
    email: user.email,
    ...context,
    metadata: { revokedCount: revoked },
  });

  return { revokedSessions: revoked };
}

module.exports = {
  AuthenticationError,
  authenticate,
  createBrokerAccount,
  changePassword,
  resetPasswordForUser,
  toSafeUser,
  ensureDefaultFolders,
};
