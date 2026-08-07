const LOGIN_TIMESTAMP_KEY = 'leo-login-timestamp';
const SESSION_EXPIRY_KEY = 'leo-session-expiry';
const SESSION_DURATION_MS = 8 * 60 * 60 * 1000; // 8 hours, never reset by activity

// Single callback invoked when the API layer detects an expired session mid-request.
// AuthContext registers this so any in-flight request can trigger a synchronous logout.
let _onExpiredCallback = null;

export function setSessionExpiredHandler(handler) {
  _onExpiredCallback = typeof handler === 'function' ? handler : null;
}

export function triggerSessionExpired() {
  _onExpiredCallback?.();
}

/**
 * Called immediately after a successful login or signup.
 * Writes loginTimestamp and sessionExpiryTimestamp to localStorage.
 * These values are never updated again — session length is fixed from this moment.
 */
export function startSession() {
  const now = Date.now();
  try {
    localStorage.setItem(LOGIN_TIMESTAMP_KEY, String(now));
    localStorage.setItem(SESSION_EXPIRY_KEY, String(now + SESSION_DURATION_MS));
  } catch { /* localStorage unavailable (e.g. private-browsing quota) */ }
}

/**
 * Returns true if:
 *   • no session exists in storage (cold start with no prior login), or
 *   • the stored expiry timestamp is in the past.
 */
export function isSessionExpired() {
  try {
    const expiry = localStorage.getItem(SESSION_EXPIRY_KEY);
    if (!expiry) return true;
    return Date.now() > Number(expiry);
  } catch {
    return true; // cannot read storage → treat as expired (safe default)
  }
}

/** Removes session timestamps. Called on every logout path. */
export function clearSession() {
  try {
    localStorage.removeItem(LOGIN_TIMESTAMP_KEY);
    localStorage.removeItem(SESSION_EXPIRY_KEY);
  } catch { /* ignore */ }
}

/** Returns the expiry timestamp in ms (epoch), or null if not set. */
export function getSessionExpiry() {
  try {
    const raw = localStorage.getItem(SESSION_EXPIRY_KEY);
    return raw ? Number(raw) : null;
  } catch {
    return null;
  }
}

/** Returns the login timestamp in ms (epoch), or null if not set. */
export function getLoginTimestamp() {
  try {
    const raw = localStorage.getItem(LOGIN_TIMESTAMP_KEY);
    return raw ? Number(raw) : null;
  } catch {
    return null;
  }
}
