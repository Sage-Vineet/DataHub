"use strict";

const asyncHandler = require("../utils");
const {
  authenticate,
  createBrokerAccount,
  changePassword,
  resetPasswordForUser,
  toSafeUser,
  AuthenticationError,
} = require("../services/authService");
const userService = require("../services/userService");
const otpService = require("../services/otpService");
const sessionService = require("../services/sessionService");
const securityEvents = require("../services/securityEventService");
const { sendOtpEmail, sendPasswordResetOtpEmail } = require("../services/emailService");
const { invalidateUserCache } = require("../middleware/auth");
const { verifyActionToken } = require("../security/tokens");
const { validatePassword } = require("../security/passwordPolicy");
const { permissionsFor, resolveRole } = require("../middleware/rbac");
const { config } = require("../config/env");
const logger = require("../security/logger");

/**
 * Refresh tokens are delivered as an HttpOnly cookie, never in the JSON body.
 *
 * WHY: a refresh token in localStorage is readable by any script that executes
 * on the page — one XSS and the attacker holds a long-lived credential they can
 * keep rotating. HttpOnly puts it out of JavaScript's reach entirely.
 *
 * SameSite=Strict is the CSRF control: the browser will not attach this cookie
 * to a request initiated by another site, so an attacker's page cannot silently
 * mint fresh access tokens. `path` narrows it further, so the cookie is only
 * ever sent to the two endpoints that need it.
 */
const REFRESH_COOKIE = "dh_rt";

function refreshCookieOptions() {
  return {
    httpOnly: true,
    secure: config.IS_PRODUCTION,
    sameSite: "strict",
    path: "/auth",
    maxAge: config.REFRESH_TOKEN_TTL_SECONDS * 1000,
  };
}

function setRefreshCookie(res, token) {
  res.cookie(REFRESH_COOKIE, token, refreshCookieOptions());
}

function clearRefreshCookie(res) {
  res.clearCookie(REFRESH_COOKIE, { ...refreshCookieOptions(), maxAge: undefined });
}

/**
 * Reads the refresh token from the cookie, falling back to the body.
 *
 * The body fallback exists for non-browser clients (mobile, server-to-server)
 * that cannot hold cookies. Browsers should always use the cookie.
 */
function readRefreshToken(req) {
  return req.cookies?.[REFRESH_COOKIE] || req.body?.refresh_token || req.body?.refreshToken || null;
}

/** Uniform shape for every response that establishes or renews a session. */
function sessionResponse(res, { user, accessToken, refreshToken, expiresIn, extra = {} }) {
  setRefreshCookie(res, refreshToken);
  return res.json({
    // `token` is retained alongside `accessToken` so existing frontend code
    // that reads `response.token` keeps working during the rollout.
    token: accessToken,
    accessToken,
    expiresIn,
    tokenType: "Bearer",
    user,
    role: resolveRole(user),
    permissions: permissionsFor(user),
    ...extra,
  });
}

function requestContext(req) {
  return {
    ipHash: logger.hashIp(req.ip),
    userAgent: req.headers["user-agent"] || null,
  };
}

// ── Login ────────────────────────────────────────────────────────────────────

const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    // Same generic message as a credential failure — a distinct "missing field"
    // error is harmless here, but keeping one shape avoids accidental drift.
    return res.status(400).json({ error: "Email and password are required.", code: "MISSING_FIELDS" });
  }

  try {
    const result = await authenticate(email, password, requestContext(req));
    return sessionResponse(res, {
      ...result,
      extra: result.mustChangePassword ? { mustChangePassword: true } : {},
    });
  } catch (error) {
    if (error instanceof AuthenticationError) {
      if (error.retryAfter) res.set("Retry-After", String(error.retryAfter));
      return res.status(error.status).json({
        // Identical body for unknown account, wrong password and inactive
        // account — nothing here lets an attacker enumerate valid addresses.
        error:
          error.code === "ACCOUNT_LOCKED"
            ? "Too many failed attempts. Try again later."
            : "Invalid email or password.",
        code: error.code,
        ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}),
      });
    }
    throw error;
  }
});

// ── Refresh ──────────────────────────────────────────────────────────────────

/**
 * POST /auth/refresh
 * Exchanges a refresh token for a new access token, rotating the refresh token.
 * Replay of an already-rotated token revokes the whole family — see
 * sessionService.rotateRefreshToken.
 */
const refresh = asyncHandler(async (req, res) => {
  const token = readRefreshToken(req);
  if (!token) {
    return res.status(401).json({ error: "Authentication required", code: "NO_REFRESH_TOKEN" });
  }

  try {
    const result = await sessionService.rotateRefreshToken(token, requestContext(req));
    return sessionResponse(res, {
      user: toSafeUser(result.user),
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresIn: result.accessTokenExpiresIn,
    });
  } catch (error) {
    clearRefreshCookie(res);
    const status = error.status || 401;
    return res.status(status).json({
      error: status === 503 ? "Service temporarily unavailable" : "Session expired. Please sign in again.",
      code: error.code || "SESSION_INVALID",
    });
  }
});

// ── Signup ───────────────────────────────────────────────────────────────────

const signupBroker = asyncHandler(async (req, res) => {
  const { password, confirm_password, confirmPassword, verification_token } = req.body || {};
  const confirm = confirm_password ?? confirmPassword;

  if (confirm !== undefined && String(password || "") !== String(confirm || "")) {
    return res.status(400).json({ error: "Passwords do not match.", code: "PASSWORD_MISMATCH" });
  }

  if (!verification_token) {
    return res.status(403).json({
      error: "Email verification required.",
      code: "VERIFICATION_REQUIRED",
    });
  }

  // The token's purpose is verified inside verifyActionToken and the signature
  // is checked against a validated secret with pinned algorithm, issuer and
  // audience — the previous code called jwt.verify with a "change_me" fallback
  // secret and no algorithm pinning.
  let decoded;
  try {
    decoded = verifyActionToken(verification_token, "email_verification");
  } catch {
    return res.status(403).json({
      error: "Verification expired or invalid. Please verify your email again.",
      code: "VERIFICATION_INVALID",
    });
  }

  const tokenEmail = String(decoded.email || "").toLowerCase();
  const bodyEmail = String(req.body?.email || "").trim().toLowerCase();
  if (!tokenEmail || tokenEmail !== bodyEmail) {
    return res.status(403).json({
      error: "Verification does not match the submitted email address.",
      code: "VERIFICATION_MISMATCH",
    });
  }

  try {
    const result = await createBrokerAccount({ ...req.body, ...requestContext(req) });
    setRefreshCookie(res, result.refreshToken);
    return res.status(201).json({
      token: result.accessToken,
      accessToken: result.accessToken,
      expiresIn: result.expiresIn,
      tokenType: "Bearer",
      user: result.user,
      role: resolveRole(result.user),
      permissions: permissionsFor(result.user),
    });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({
        error: error.message,
        code: error.code || "SIGNUP_REJECTED",
        ...(error.details ? { details: error.details } : {}),
      });
    }
    throw error;
  }
});

// ── Logout ───────────────────────────────────────────────────────────────────

/**
 * POST /auth/logout
 * Revokes the current session server-side. The old handler returned 204 without
 * touching any state, so the token stayed valid for its full 7-day life.
 */
const logout = asyncHandler(async (req, res) => {
  if (req.sessionId) {
    await sessionService.revokeSession(req.sessionId, "logout");
  }
  await securityEvents.record({
    eventType: "logout",
    ...securityEvents.fromRequest(req),
    metadata: { sessionId: req.sessionId },
  });
  clearRefreshCookie(res);
  return res.status(204).send();
});

/** POST /auth/logout-all — revokes every session for the caller. */
const logoutAll = asyncHandler(async (req, res) => {
  const revoked = await sessionService.revokeAllUserSessions(req.user.id, "logout_all");
  await securityEvents.record({
    eventType: "logout_all",
    severity: securityEvents.SEVERITY.WARNING,
    ...securityEvents.fromRequest(req),
    metadata: { revokedCount: revoked },
  });
  clearRefreshCookie(res);
  return res.json({ revokedSessions: revoked });
});

// ── Session introspection ────────────────────────────────────────────────────

const me = asyncHandler(async (req, res) => {
  const fresh = (await userService.getUserById(req.user.id)) || req.user;
  const user = toSafeUser(fresh);
  return res.json({
    user,
    role: resolveRole(user),
    // Drives frontend UI gating. Advisory only — every one of these is
    // independently enforced server-side.
    permissions: permissionsFor(user),
    session: {
      idleTimeoutSeconds: config.SESSION_IDLE_TIMEOUT_SECONDS,
      absoluteTimeoutSeconds: config.SESSION_ABSOLUTE_TIMEOUT_SECONDS,
      accessTokenTtlSeconds: config.ACCESS_TOKEN_TTL_SECONDS,
    },
  });
});

const listSessions = asyncHandler(async (req, res) => {
  const sessions = await sessionService.listActiveSessions(req.user.id);
  return res.json({
    sessions: sessions.map((session) => ({
      id: session.id,
      current: session.id === req.sessionId,
      createdAt: session.created_at,
      lastSeenAt: session.last_seen_at,
      expiresAt: session.absolute_expires_at,
      userAgent: session.user_agent,
    })),
  });
});

// ── Password change ──────────────────────────────────────────────────────────

const changeOwnPassword = asyncHandler(async (req, res) => {
  const { current_password, currentPassword, new_password, newPassword } = req.body || {};
  const current = current_password ?? currentPassword;
  const next = new_password ?? newPassword;

  if (!current || !next) {
    return res.status(400).json({ error: "Both current and new passwords are required.", code: "MISSING_FIELDS" });
  }

  try {
    const result = await changePassword(
      req.user.id,
      { currentPassword: current, newPassword: next },
      securityEvents.fromRequest(req)
    );
    clearRefreshCookie(res);
    // Every session including this one is now revoked; the client must sign in
    // again. That is intentional.
    return res.json({
      success: true,
      revokedSessions: result.revokedSessions,
      message: "Password updated. Please sign in again.",
    });
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return res.status(401).json({ error: "Current password is incorrect.", code: "INVALID_CREDENTIALS" });
    }
    if (error.status === 400) {
      return res.status(400).json({
        error: error.message,
        code: "WEAK_PASSWORD",
        ...(error.details ? { details: error.details } : {}),
      });
    }
    throw error;
  }
});

/** GET /auth/password-policy — lets the UI render live requirements. */
const passwordPolicy = asyncHandler(async (_req, res) => {
  const { MIN_LENGTH, MAX_LENGTH } = require("../security/passwordPolicy");
  return res.json({
    minLength: MIN_LENGTH,
    maxLength: MAX_LENGTH,
    requiresUppercase: true,
    requiresLowercase: true,
    requiresNumber: true,
    requiresSpecial: true,
    rejectsCommonPasswords: true,
    rejectsPersonalInfo: true,
  });
});

// ── OTP: email verification ──────────────────────────────────────────────────

/**
 * Surfaces an OTP on the server console when, and ONLY when, delivery failed
 * outside production.
 *
 * WHY this exists: email delivery is an external dependency. When it is
 * misconfigured — an Azure permission not yet consented, an expired client
 * secret — signup and password reset become completely untestable locally,
 * because the code is generated, stored, and then goes nowhere.
 *
 * WHY it is safe: the guard is `config.IS_PRODUCTION`, which is derived from a
 * validated environment at boot, and the code is written ONLY to the server
 * console — never to the HTTP response, never to the audit trail, never to a
 * log aggregator's structured payload. An attacker would already need shell
 * access to the running host to read it, at which point they have far more than
 * an OTP.
 *
 * A test in the regression suite asserts this cannot fire in production.
 */
function surfaceOtpInDevelopment(email, otp, purpose) {
  if (config.IS_PRODUCTION) return;
  // Deliberately console.log rather than the structured logger: the logger
  // redacts secret-shaped values and ships to aggregators. This must stay local.
  // eslint-disable-next-line no-console
  console.log(
    `\n  ┌─ DEVELOPMENT ONLY ────────────────────────────────────────────\n` +
      `  │ Email delivery is unavailable, so the ${purpose} code is\n` +
      `  │ printed here instead. This NEVER happens in production.\n` +
      `  │\n` +
      `  │   ${email}\n` +
      `  │   OTP: ${otp}\n` +
      `  └───────────────────────────────────────────────────────────────\n`
  );
}

const sendVerificationOtp = asyncHandler(async (req, res) => {
  const { email } = req.body || {};
  const normalizedEmail = String(email || "").trim().toLowerCase();

  const existing = await userService.getUserByEmail(normalizedEmail);
  if (!existing) {
    const otp = await otpService.sendOtp(normalizedEmail);
    const emailResult = await sendOtpEmail(normalizedEmail, otp);
    if (!emailResult.sent) {
      logger.warn("otp_delivery_failed", { reason: emailResult.reason });
      surfaceOtpInDevelopment(normalizedEmail, otp, "email verification");
    }
    await securityEvents.record({
      eventType: "verification_otp_sent",
      email: normalizedEmail,
      ...securityEvents.fromRequest(req),
    });
  }

  // Identical response whether or not the account exists, so this endpoint
  // cannot be used to enumerate registered addresses. The previous version
  // returned 409 "account already exists", which was exactly such an oracle.
  return res.json({
    success: true,
    message: "If this address can be registered, a verification code has been sent.",
  });
});

const verifyVerificationOtp = asyncHandler(async (req, res) => {
  const { email, otp } = req.body || {};
  if (!email || !otp) {
    return res.status(400).json({ error: "Email and verification code are required.", code: "MISSING_FIELDS" });
  }

  const result = await otpService.verifyOtp(
    String(email).trim().toLowerCase(),
    String(otp).trim()
  );

  await securityEvents.record({
    eventType: "email_verified",
    email: String(email).trim().toLowerCase(),
    ...securityEvents.fromRequest(req),
  });

  return res.json({ verified: true, verificationToken: result.verificationToken });
});

// ── Password reset ───────────────────────────────────────────────────────────

const forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body || {};
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const user = await userService.getUserByEmail(normalizedEmail);

  // The OTP is generated either way so the DB work — and therefore the response
  // latency — is the same for a registered and an unregistered address.
  const otp = await otpService.sendOtp(normalizedEmail, "password_reset");

  if (user) {
    const emailResult = await sendPasswordResetOtpEmail(normalizedEmail, otp);
    if (!emailResult.sent) {
      logger.warn("reset_otp_delivery_failed", { reason: emailResult.reason });
      surfaceOtpInDevelopment(normalizedEmail, otp, "password reset");
    }
    await securityEvents.record({
      eventType: "password_reset_requested",
      severity: securityEvents.SEVERITY.WARNING,
      userId: user.id,
      email: normalizedEmail,
      ...securityEvents.fromRequest(req),
    });
  }

  return res.json({
    success: true,
    message: "If an account exists for this email, a reset code has been sent.",
  });
});

const verifyResetOtp = asyncHandler(async (req, res) => {
  const { email, otp } = req.body || {};
  if (!email || !otp) {
    return res.status(400).json({ error: "Email and verification code are required.", code: "MISSING_FIELDS" });
  }

  const result = await otpService.verifyOtp(
    String(email).trim().toLowerCase(),
    String(otp).trim(),
    "password_reset"
  );

  return res.json({ verified: true, verificationToken: result.verificationToken });
});

const resetPassword = asyncHandler(async (req, res) => {
  const { email, new_password, newPassword, verification_token } = req.body || {};
  const password = String(new_password ?? newPassword ?? "");

  if (!verification_token) {
    return res.status(403).json({ error: "Verification required.", code: "VERIFICATION_REQUIRED" });
  }

  let decoded;
  try {
    decoded = verifyActionToken(verification_token, "password_reset");
  } catch {
    return res.status(403).json({
      error: "Verification expired or invalid. Please request a new code.",
      code: "VERIFICATION_INVALID",
    });
  }

  const normalizedEmail = String(email || "").trim().toLowerCase();
  const tokenEmail = String(decoded.email || "").toLowerCase();
  if (!tokenEmail || tokenEmail !== normalizedEmail) {
    return res.status(403).json({
      error: "Verification does not match the submitted email address.",
      code: "VERIFICATION_MISMATCH",
    });
  }

  const policy = validatePassword(password, { email: normalizedEmail });
  if (!policy.valid) {
    return res.status(400).json({
      error: policy.errors[0],
      code: "WEAK_PASSWORD",
      details: policy.errors,
    });
  }

  const user = await userService.getUserByEmail(normalizedEmail);
  if (!user) {
    // The token proves the address was verified, so this can only happen if the
    // account was deleted mid-flow. Stay generic.
    return res.status(400).json({ error: "Unable to reset password.", code: "RESET_FAILED" });
  }

  await resetPasswordForUser(user, password, securityEvents.fromRequest(req));
  invalidateUserCache(user.id);
  clearRefreshCookie(res);

  // The user is NOT signed in automatically. The old handler issued a token
  // here, which meant possession of a reset code alone produced a live session;
  // requiring an explicit sign-in keeps the credential and the session distinct.
  return res.json({
    success: true,
    message: "Password updated. Please sign in with your new password.",
  });
});

module.exports = {
  login,
  refresh,
  signupBroker,
  logout,
  logoutAll,
  me,
  listSessions,
  changeOwnPassword,
  passwordPolicy,
  sendVerificationOtp,
  verifyVerificationOtp,
  forgotPassword,
  verifyResetOtp,
  resetPassword,
};
