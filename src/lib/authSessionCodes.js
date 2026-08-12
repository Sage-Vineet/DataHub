/**
 * Client-side counterpart to backend/src/security/sessionReasons.js.
 *
 * ── THE RULE THIS MODULE EXISTS TO ENFORCE ──────────────────────────────────
 * The UI may describe a sign-out as "you signed in on another device" ONLY when
 * the server has explicitly said so, by returning SESSION_SUPERSEDED. Every
 * other invalidation — a session that no longer exists, a refresh-token rotation
 * race, a logout-all, an admin revocation, a disabled account — gets a neutral,
 * truthful message.
 *
 * Previously the API layer collapsed all of these into a single `'revoked'`
 * reason and AuthContext rendered that as the "another device" sentence. It was
 * shown for conditions that had nothing to do with another device, and in this
 * project's own development configuration (SINGLE_DEVICE_LOGIN=false) it was
 * shown for a cause that literally cannot occur.
 *
 * ── AND THE SECOND RULE ─────────────────────────────────────────────────────
 * An availability failure is not an invalidation. A network drop, a 500/502/503,
 * a CORS failure or an unreachable session store says nothing about whether the
 * session is alive, so it must never tear down client auth state. Only the codes
 * in INVALIDATION_CODES do that.
 */

/** Server codes that mean the session is genuinely over. */
export const SESSION_INVALIDATION_CODES = Object.freeze([
  'SESSION_SUPERSEDED',
  'SESSION_IDLE_TIMEOUT',
  'SESSION_ABSOLUTE_TIMEOUT',
  'SESSION_LOGGED_OUT',
  'SESSION_PASSWORD_CHANGED',
  'SESSION_REVOKED_BY_ADMIN',
  'ACCOUNT_DISABLED',
  'SESSION_INVALID',
  // Retained for one deploy cycle: a browser tab loaded from the previous build,
  // or an API instance not yet rolled forward, can still emit these. They are
  // treated as invalidation but map to the NEUTRAL message below — which is the
  // whole point of the fix, so an old server can no longer produce a false
  // "another device" claim on a new client either.
  'SESSION_REVOKED',
  'SESSION_EXPIRED',
]);

/** Codes that mean "the access token is stale but the session may be alive". */
export const REFRESHABLE_CODES = Object.freeze(['TOKEN_EXPIRED', 'TOKEN_STALE']);

/** Codes that mean "temporarily unavailable" — never a reason to sign out. */
export const TRANSIENT_CODES = Object.freeze(['STORE_UNAVAILABLE', 'STORE_DOWN']);

export function isSessionInvalidationCode(code) {
  return SESSION_INVALIDATION_CODES.includes(String(code || '').toUpperCase());
}

export function isTransientCode(code) {
  return TRANSIENT_CODES.includes(String(code || '').toUpperCase());
}

/**
 * User-facing copy per server code.
 *
 * Only SESSION_SUPERSEDED mentions another device. Everything else is accurate
 * without speculating about a cause the server never established. No raw
 * internal reason name is ever shown.
 */
export const SESSION_MESSAGES = Object.freeze({
  SESSION_SUPERSEDED:
    'You were signed out because your account was signed in on another device.',
  SESSION_IDLE_TIMEOUT: 'Your session expired due to inactivity. Please sign in again.',
  SESSION_ABSOLUTE_TIMEOUT: 'Your session expired. Please sign in again.',
  SESSION_LOGGED_OUT: 'You have been signed out of your active sessions.',
  SESSION_PASSWORD_CHANGED:
    'Your password was changed, so your other sessions were signed out. Please sign in again.',
  SESSION_REVOKED_BY_ADMIN:
    'An administrator ended your session. Please sign in again.',
  ACCOUNT_DISABLED: 'Your account is no longer active. Contact your administrator.',
  SESSION_INVALID: 'Your session is no longer valid. Please sign in again.',

  // Legacy codes from a pre-fix server: neutral, NOT "another device".
  SESSION_REVOKED: 'Your session is no longer valid. Please sign in again.',
  SESSION_EXPIRED: 'Your session expired. Please sign in again.',

  // Client-side determinations (the local idle/absolute clocks in lib/session.js).
  idle: 'You were signed out after a period of inactivity.',
  absolute: 'Your session reached its maximum length. Please sign in again.',
  expired: 'Your session expired. Please sign in again.',
});

/** The neutral default. Never mentions another device. */
export const DEFAULT_SESSION_MESSAGE = SESSION_MESSAGES.SESSION_INVALID;

/**
 * HTTP statuses that are an availability/throttling problem, not a verdict on the
 * session.
 *
 * 429 matters specifically: /auth/refresh sits behind `authLimiter`, so a burst of
 * refreshes is answered with 429. Treating that as an invalidation would sign the
 * user out for being rate-limited — the opposite of what the limiter is for.
 * 408 (request timeout) and 425 (too early) are the same class.
 */
const TRANSIENT_STATUSES = Object.freeze([408, 425, 429]);

/**
 * Classify a failed /auth/refresh attempt. PURE — no fetch, no DOM — so the
 * decision table can be asserted directly.
 *
 * This is the single place that answers "does this failure prove the session is
 * gone?". Before the fix there was no such place: api.js had a bare
 * `} catch { triggerSessionExpired('revoked') }` that treated every possible
 * failure as proof, so a network blip signed the user out and blamed another
 * device.
 *
 * @param {{networkError?: boolean, status?: number, body?: object|null}} input
 * @returns {{transient: boolean, code: string}}
 *   `transient: true`  → leave auth state alone, allow retry.
 *   `transient: false` → the session is genuinely over; `code` selects the message.
 */
export function classifyRefreshFailure({ networkError = false, status = 0, body = null } = {}) {
  // fetch() rejects only at the network layer: offline, DNS, TLS, connection
  // reset, CORS preflight rejection, abort. None of these describe the session.
  if (networkError) return { transient: true, code: 'NETWORK_ERROR' };

  const code = body && typeof body.code === 'string' ? body.code : null;

  // The server's own explicit signal wins over any status heuristic.
  if (body && body.retryable === true) {
    return { transient: true, code: code || 'REFRESH_UNAVAILABLE' };
  }
  if (isTransientCode(code)) return { transient: true, code };

  const numericStatus = Number(status) || 0;
  // No status at all means the response never really happened.
  if (numericStatus === 0) return { transient: true, code: code || 'NETWORK_ERROR' };
  if (numericStatus >= 500) return { transient: true, code: code || 'SERVER_ERROR' };
  if (TRANSIENT_STATUSES.includes(numericStatus)) {
    return { transient: true, code: code || 'REFRESH_THROTTLED' };
  }

  // A 4xx that is not throttling: the session really is finished. Use the
  // server's code when it is one we know, otherwise the neutral one — never a
  // guess at a specific cause.
  return {
    transient: false,
    code: isSessionInvalidationCode(code) ? code : 'SESSION_INVALID',
  };
}

/**
 * Message for a session-ending reason.
 *
 * Accepts a server code (SESSION_SUPERSEDED…) or one of the local clock reasons
 * ('idle' | 'absolute' | 'expired'). An unrecognised value yields the neutral
 * default — an unknown reason must never be narrated as a specific cause.
 */
export function messageForSessionCode(code) {
  if (!code) return DEFAULT_SESSION_MESSAGE;
  const raw = String(code);
  if (SESSION_MESSAGES[raw]) return SESSION_MESSAGES[raw];
  const upper = raw.toUpperCase();
  return SESSION_MESSAGES[upper] || DEFAULT_SESSION_MESSAGE;
}
