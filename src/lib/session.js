/**
 * Client-side session state.
 *
 * IMPORTANT: everything here is a UX affordance, not a security control. A user
 * can edit localStorage, freeze timers, or call the API directly. The real
 * session lifetime is enforced by the server (auth_sessions.last_seen_at and
 * absolute_expires_at). This module exists so the UI logs out promptly and
 * predictably rather than letting the user keep clicking into 401s.
 *
 * Two independent clocks, matching the server:
 *   • idle     — resets on user activity; the server slides its own window on
 *                each authenticated request, so the two stay roughly in step.
 *   • absolute — fixed from login, never extended, no matter how active.
 */

const LOGIN_TIMESTAMP_KEY = 'leo-login-timestamp';
const SESSION_EXPIRY_KEY = 'leo-session-expiry';
const LAST_ACTIVITY_KEY = 'leo-last-activity';

/**
 * Defaults mirror the server's own defaults. `/auth/me` returns the server's
 * actual configured values and `applyServerSessionConfig` adopts them, so the
 * client never enforces a *longer* window than the server does.
 */
const DEFAULTS = {
  idleTimeoutMs: 30 * 60 * 1000,
  absoluteTimeoutMs: 12 * 60 * 60 * 1000,
};

let idleTimeoutMs = DEFAULTS.idleTimeoutMs;
let absoluteTimeoutMs = DEFAULTS.absoluteTimeoutMs;

/**
 * Adopts the server's configured timeouts.
 *
 * The server is the authority — it enforces the real deadline on every request,
 * and everything in this module is only a UX affordance (see the header). This
 * previously took Math.min() against the hardcoded defaults above, which meant
 * the client could only ever be STRICTER: raising SESSION_IDLE_TIMEOUT_SECONDS
 * on the server had no effect and the UI still signed people out at the local
 * 30-minute default while their server session was very much alive. Mirroring
 * the server's value keeps the two windows in step in both directions.
 */
export function applyServerSessionConfig(sessionConfig) {
  if (!sessionConfig) return;
  if (Number.isFinite(sessionConfig.idleTimeoutSeconds)) {
    idleTimeoutMs = sessionConfig.idleTimeoutSeconds * 1000;
  }
  if (Number.isFinite(sessionConfig.absoluteTimeoutSeconds)) {
    absoluteTimeoutMs = sessionConfig.absoluteTimeoutSeconds * 1000;
  }
}

export function getIdleTimeoutMs() {
  return idleTimeoutMs;
}

let onExpiredCallback = null;

export function setSessionExpiredHandler(handler) {
  onExpiredCallback = typeof handler === 'function' ? handler : null;
}

export function triggerSessionExpired(reason = 'expired') {
  onExpiredCallback?.(reason);
}

function readNumber(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? Number(raw) : null;
  } catch {
    return null;
  }
}

function writeNumber(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* private browsing / quota — the server still enforces the real timeout */
  }
}

/** Called immediately after a successful login, signup or password reset. */
export function startSession() {
  const now = Date.now();
  writeNumber(LOGIN_TIMESTAMP_KEY, now);
  writeNumber(SESSION_EXPIRY_KEY, now + absoluteTimeoutMs);
  writeNumber(LAST_ACTIVITY_KEY, now);
}

/** Records user activity, sliding the idle window forward. */
export function recordActivity() {
  if (!getLoginTimestamp()) return;
  writeNumber(LAST_ACTIVITY_KEY, Date.now());
}

/**
 * Reasons a session is over, in priority order.
 * @returns {'absolute'|'idle'|'none'|null} null when no session exists at all
 */
export function getExpiryReason() {
  const loginAt = readNumber(LOGIN_TIMESTAMP_KEY);
  const expiry = readNumber(SESSION_EXPIRY_KEY);
  if (!loginAt || !expiry) return null;

  const now = Date.now();
  if (now > expiry) return 'absolute';

  const lastActivity = readNumber(LAST_ACTIVITY_KEY) ?? loginAt;
  if (now - lastActivity > idleTimeoutMs) return 'idle';

  return 'none';
}

export function isSessionExpired() {
  const reason = getExpiryReason();
  // A missing session record is treated as expired — fail closed.
  return reason === null || (reason !== 'none');
}

export function clearSession() {
  try {
    localStorage.removeItem(LOGIN_TIMESTAMP_KEY);
    localStorage.removeItem(SESSION_EXPIRY_KEY);
    localStorage.removeItem(LAST_ACTIVITY_KEY);
  } catch {
    /* ignore */
  }
}

export function getSessionExpiry() {
  return readNumber(SESSION_EXPIRY_KEY);
}

export function getLoginTimestamp() {
  return readNumber(LOGIN_TIMESTAMP_KEY);
}

export function getLastActivity() {
  return readNumber(LAST_ACTIVITY_KEY);
}

/** Milliseconds until the next expiry event, or null when no session exists. */
export function getMsUntilExpiry() {
  const loginAt = readNumber(LOGIN_TIMESTAMP_KEY);
  const expiry = readNumber(SESSION_EXPIRY_KEY);
  if (!loginAt || !expiry) return null;

  const lastActivity = readNumber(LAST_ACTIVITY_KEY) ?? loginAt;
  const idleDeadline = lastActivity + idleTimeoutMs;
  return Math.max(0, Math.min(expiry, idleDeadline) - Date.now());
}

/**
 * Subscribes to user activity, throttled so a mousemove storm does not write to
 * localStorage on every frame.
 *
 * `pointerdown`/`keydown` are deliberate interactions; `scroll` and `mousemove`
 * catch reading without clicking. Returns an unsubscribe function.
 */
export function watchActivity(onActivity, { throttleMs = 30 * 1000 } = {}) {
  let lastRun = 0;

  const handler = () => {
    const now = Date.now();
    if (now - lastRun < throttleMs) return;
    lastRun = now;
    recordActivity();
    onActivity?.();
  };

  const events = ['pointerdown', 'keydown', 'scroll', 'mousemove', 'touchstart', 'focus'];
  for (const event of events) {
    window.addEventListener(event, handler, { passive: true, capture: true });
  }

  return () => {
    for (const event of events) {
      window.removeEventListener(event, handler, { capture: true });
    }
  };
}
