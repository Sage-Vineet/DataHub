"use strict";

/**
 * Canonical session-invalidation vocabulary — the single authority translating an
 * internal reason into what the client is told.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * `auth_sessions.revoked_reason` has always recorded precisely why a session
 * ended (superseded, logout_all, reuse_detected, account_disabled, …), but two
 * layers threw that away:
 *
 *   • requireAuth mapped only idle_timeout / absolute_timeout to SESSION_EXPIRED
 *     and EVERYTHING else to SESSION_REVOKED.
 *   • the client then rendered SESSION_REVOKED as "your account was signed in on
 *     another device" — an assertion the server had never made.
 *
 * So a session row that simply could not be found, a refresh-token rotation
 * race, a logout-all, an admin revocation and a disabled account all told the
 * user the same untrue thing. With SINGLE_DEVICE_LOGIN=false the one cause that
 * message describes cannot even occur, yet it was still the message shown.
 *
 * ── DESIGN RULES ────────────────────────────────────────────────────────────
 * 1. DB reasons are NOT renamed. They are already written to rows in production;
 *    this module maps them, it does not migrate them.
 * 2. The client code is stable, machine-readable, and safe to expose. It carries
 *    only what the UI legitimately needs in order to say something true.
 * 3. Reasons that reveal a SECURITY DETERMINATION are deliberately flattened to
 *    the generic SESSION_INVALID. `reuse_detected` in particular must not be
 *    distinguishable by the client from an ordinary invalid session: telling a
 *    caller "we detected token replay" hands an attacker a probe oracle for the
 *    theft-detection logic. Generic to the client, precise in the server log.
 * 4. `SESSION_SUPERSEDED` — the only code the UI may describe as another device
 *    — is emitted for exactly one reason, `superseded`, which is written only by
 *    createSession under SINGLE_DEVICE_LOGIN. Nothing else can produce it.
 * 5. Availability failures are NOT invalidation. STORE_UNAVAILABLE is 503 and
 *    carries `transient: true` so no layer treats an outage as proof the session
 *    is gone. See isTransientCode.
 */

/**
 * Internal reason → what the client is told.
 *
 *   code      stable, non-sensitive, machine-readable client code
 *   status    HTTP status for this condition
 *   category  "invalidated" (the session is genuinely over) or "transient"
 *   sensitive true when the internal reason must not be inferable from the code
 */
const REASON_MAP = Object.freeze({
  // ── Deliberate replacement by a newer login (SINGLE_DEVICE_LOGIN only) ──
  superseded: { code: "SESSION_SUPERSEDED", status: 401, category: "invalidated" },

  // ── Timeouts. Distinct so the UI can say which clock ran out. ──
  idle_timeout: { code: "SESSION_IDLE_TIMEOUT", status: 401, category: "invalidated" },
  absolute_timeout: { code: "SESSION_ABSOLUTE_TIMEOUT", status: 401, category: "invalidated" },

  // ── User- or operator-initiated. Not a security incident, not a timeout. ──
  logout: { code: "SESSION_LOGGED_OUT", status: 401, category: "invalidated" },
  logout_all: { code: "SESSION_LOGGED_OUT", status: 401, category: "invalidated" },
  password_change: { code: "SESSION_PASSWORD_CHANGED", status: 401, category: "invalidated" },
  admin_revoked: { code: "SESSION_REVOKED_BY_ADMIN", status: 401, category: "invalidated" },

  // ── Account state ──
  account_disabled: { code: "ACCOUNT_DISABLED", status: 401, category: "invalidated" },

  // ── Deliberately generic to the client (rule 3). ──
  // The reason is still logged server-side at full fidelity.
  reuse_detected: { code: "SESSION_INVALID", status: 401, category: "invalidated", sensitive: true },
  not_found: { code: "SESSION_INVALID", status: 401, category: "invalidated" },
  revoked: { code: "SESSION_INVALID", status: 401, category: "invalidated" },
});

/** Fallback for any reason not in the map — generic, never "another device". */
const UNKNOWN = Object.freeze({ code: "SESSION_INVALID", status: 401, category: "invalidated" });

/**
 * Availability failures. NOT session invalidation: the session may well be
 * perfectly alive and the store merely unreachable. Callers must neither revoke
 * local state nor clear the refresh cookie on these.
 */
const TRANSIENT = Object.freeze({
  STORE_UNAVAILABLE: { code: "STORE_UNAVAILABLE", status: 503, category: "transient" },
});

/** Client codes that mean "stop, the session is genuinely over". */
const INVALIDATION_CODES = Object.freeze(
  Array.from(
    new Set([...Object.values(REASON_MAP).map((r) => r.code), UNKNOWN.code]),
  ),
);

/**
 * @param {string|null|undefined} reason a value from auth_sessions.revoked_reason
 *   (or validateSession's `reason`)
 * @returns {{code: string, status: number, category: string, sensitive?: boolean}}
 */
function describeReason(reason) {
  const key = String(reason || "").trim().toLowerCase();
  if (TRANSIENT[key.toUpperCase()]) return TRANSIENT[key.toUpperCase()];
  return REASON_MAP[key] || UNKNOWN;
}

/** The stable client code for an internal reason. */
function clientCodeForReason(reason) {
  return describeReason(reason).code;
}

/** True when a code represents an availability problem rather than invalidation. */
function isTransientCode(code) {
  const key = String(code || "").trim().toUpperCase();
  return Boolean(TRANSIENT[key]) || key === "STORE_DOWN";
}

/** True when a code means the session is genuinely finished. */
function isInvalidationCode(code) {
  return INVALIDATION_CODES.includes(String(code || "").trim().toUpperCase());
}

/**
 * SessionError.code values thrown by rotateRefreshToken that are NOT reason
 * strings — they come from token verification or the refresh window rather than
 * from a revoked row. Mapped here so the refresh endpoint answers with one
 * consistent vocabulary instead of a mixture of UPPER_SNAKE token codes and
 * lowercase DB reasons.
 */
const ERROR_CODE_MAP = Object.freeze({
  EXPIRED: { code: "SESSION_ABSOLUTE_TIMEOUT", status: 401, category: "invalidated" },
  REFRESH_EXPIRED: { code: "SESSION_ABSOLUTE_TIMEOUT", status: 401, category: "invalidated" },
  IDLE_TIMEOUT: { code: "SESSION_IDLE_TIMEOUT", status: 401, category: "invalidated" },
  ABSOLUTE_TIMEOUT: { code: "SESSION_ABSOLUTE_TIMEOUT", status: 401, category: "invalidated" },
  ACCOUNT_DISABLED: { code: "ACCOUNT_DISABLED", status: 401, category: "invalidated" },
  // Token could not be verified at all (bad signature, malformed, wrong type),
  // and replay detection — both generic to the client.
  REUSE_DETECTED: { code: "SESSION_INVALID", status: 401, category: "invalidated", sensitive: true },
  INVALID: { code: "SESSION_INVALID", status: 401, category: "invalidated" },
  INVALID_TYPE: { code: "SESSION_INVALID", status: 401, category: "invalidated" },
  NOT_FOUND: { code: "SESSION_INVALID", status: 401, category: "invalidated" },
  STORE_UNAVAILABLE: TRANSIENT.STORE_UNAVAILABLE,
});

/**
 * Describe a thrown SessionError/TokenError for the client.
 *
 * Prefers the error's own canonical `reason` (set by sessionService when the
 * failure came from a revoked row) so a `superseded` row is reported as
 * SESSION_SUPERSEDED rather than being flattened by its generic code.
 */
function describeSessionError(error) {
  if (error?.reason) {
    const byReason = describeReason(error.reason);
    if (byReason !== UNKNOWN) return byReason;
  }
  const key = String(error?.code || "").trim().toUpperCase();
  if (ERROR_CODE_MAP[key]) return ERROR_CODE_MAP[key];
  // A 503 from anywhere is availability, not invalidation.
  if (Number(error?.status) === 503) return TRANSIENT.STORE_UNAVAILABLE;
  return UNKNOWN;
}

module.exports = {
  REASON_MAP,
  TRANSIENT,
  INVALIDATION_CODES,
  describeReason,
  describeSessionError,
  clientCodeForReason,
  isTransientCode,
  isInvalidationCode,
};
