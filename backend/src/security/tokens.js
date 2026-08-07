"use strict";

/**
 * JWT issuance and verification.
 *
 * WHY the split into two token types:
 *   • Access tokens are sent on every request and therefore have the widest
 *     exposure (proxies, browser memory, error reports). They are kept short
 *     lived (15 min) so a stolen one has a small blast radius, and they are
 *     stateless so verification costs no database round-trip.
 *   • Refresh tokens are sent only to /auth/refresh. They are long lived but
 *     *stateful* — every one is recorded server-side and can be revoked
 *     instantly. This is what makes logout, single-device login and session
 *     timeout actually enforceable rather than advisory.
 *
 * Hardening applied to every verify() call:
 *   • `algorithms` is pinned, defeating the `alg: none` and RS256→HS256
 *     confusion attacks.
 *   • `issuer` and `audience` are checked, so a token minted by another service
 *     that happens to share a secret cannot be replayed here.
 *   • `typ` is checked, so an access token can never be presented as a refresh
 *     token or vice versa — they are also signed with different keys.
 *   • clockTolerance is 5s, not 30s. A generous skew allowance extends the life
 *     of an expired token.
 */

const jwt = require("jsonwebtoken");
const { config } = require("../config/env");
const { randomToken, sha256 } = require("./crypto");

const ALGORITHM = "HS256";

const TOKEN_TYPE = Object.freeze({
  ACCESS: "access",
  REFRESH: "refresh",
  /** Short-lived, single-purpose tokens (email verification, password reset). */
  ACTION: "action",
});

const CLOCK_TOLERANCE_SECONDS = 5;

class TokenError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "TokenError";
    this.code = code;
  }
}

function baseClaims() {
  return {
    iss: config.JWT_ISSUER,
    aud: config.JWT_AUDIENCE,
  };
}

/**
 * Signs an access token.
 *
 * The role and session id are embedded so the hot path can make an
 * authorization decision without a database read, but the session id is
 * *always* re-validated against the session store by requireAuth — the claim is
 * a cache key, never the source of truth.
 */
function signAccessToken({ userId, sessionId, role, subRole, tokenVersion = 0 }) {
  if (!userId || !sessionId) {
    throw new TokenError("userId and sessionId are required", "INVALID_ARGUMENT");
  }
  return jwt.sign(
    {
      ...baseClaims(),
      sub: String(userId),
      sid: String(sessionId),
      typ: TOKEN_TYPE.ACCESS,
      role: role || null,
      sub_role: subRole || null,
      ver: tokenVersion,
    },
    config.JWT_SECRET,
    { algorithm: ALGORITHM, expiresIn: config.ACCESS_TOKEN_TTL_SECONDS }
  );
}

/**
 * Signs a refresh token.
 *
 * `jti` is a high-entropy random id, not derived from anything guessable. Only
 * its SHA-256 hash is persisted, so a database leak does not yield usable
 * refresh tokens.
 */
function signRefreshToken({ userId, sessionId, familyId }) {
  if (!userId || !sessionId || !familyId) {
    throw new TokenError("userId, sessionId and familyId are required", "INVALID_ARGUMENT");
  }
  const jti = randomToken(32);
  const token = jwt.sign(
    {
      ...baseClaims(),
      sub: String(userId),
      sid: String(sessionId),
      fam: String(familyId),
      jti,
      typ: TOKEN_TYPE.REFRESH,
    },
    config.JWT_REFRESH_SECRET,
    { algorithm: ALGORITHM, expiresIn: config.REFRESH_TOKEN_TTL_SECONDS }
  );
  return { token, jti, jtiHash: sha256(jti) };
}

/**
 * Signs a single-purpose action token (email verification, password reset).
 * `purpose` is bound into the token so a verification token cannot be swapped
 * in for a password reset — the exact confusion the previous implementation
 * guarded against only by an `if` on the decoded payload.
 */
function signActionToken({ purpose, email, userId = null, ttlSeconds = 900 }) {
  if (!purpose) throw new TokenError("purpose is required", "INVALID_ARGUMENT");
  return jwt.sign(
    {
      ...baseClaims(),
      typ: TOKEN_TYPE.ACTION,
      purpose,
      email: email ? String(email).toLowerCase() : null,
      ...(userId ? { sub: String(userId) } : {}),
      nonce: randomToken(12),
    },
    config.JWT_SECRET,
    { algorithm: ALGORITHM, expiresIn: ttlSeconds }
  );
}

function verify(token, secret, expectedType) {
  if (!token || typeof token !== "string") {
    throw new TokenError("Token missing", "MISSING");
  }
  let payload;
  try {
    payload = jwt.verify(token, secret, {
      algorithms: [ALGORITHM],
      issuer: config.JWT_ISSUER,
      audience: config.JWT_AUDIENCE,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
    });
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      throw new TokenError("Token expired", "EXPIRED");
    }
    throw new TokenError("Token invalid", "INVALID");
  }
  if (payload.typ !== expectedType) {
    throw new TokenError("Token type mismatch", "WRONG_TYPE");
  }
  return payload;
}

function verifyAccessToken(token) {
  return verify(token, config.JWT_SECRET, TOKEN_TYPE.ACCESS);
}

function verifyRefreshToken(token) {
  return verify(token, config.JWT_REFRESH_SECRET, TOKEN_TYPE.REFRESH);
}

function verifyActionToken(token, expectedPurpose) {
  const payload = verify(token, config.JWT_SECRET, TOKEN_TYPE.ACTION);
  if (!expectedPurpose || payload.purpose !== expectedPurpose) {
    throw new TokenError("Token purpose mismatch", "WRONG_PURPOSE");
  }
  return payload;
}

/**
 * Extracts a bearer token from the Authorization header — and nowhere else.
 *
 * WHY only the header: query-string tokens end up in web-server access logs,
 * browser history, and the Referer header sent to third-party origins. Custom
 * `x-access-token`-style headers widen the surface for cross-origin abuse
 * without adding capability. Both were previously accepted; both are now gone.
 */
function extractBearerToken(req) {
  const header = req.headers?.authorization;
  if (typeof header !== "string") return null;
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}

module.exports = {
  TOKEN_TYPE,
  TokenError,
  signAccessToken,
  signRefreshToken,
  signActionToken,
  verifyAccessToken,
  verifyRefreshToken,
  verifyActionToken,
  extractBearerToken,
};
