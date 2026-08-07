import { createContext, useContext, useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  brokerSignupRequest,
  loginRequest,
  logoutRequest,
  meRequest,
  resetPasswordRequest,
  setStoredToken,
  getStoredToken,
  refreshAccessToken,
} from '../lib/api';
import {
  startSession,
  clearSession,
  isSessionExpired,
  getExpiryReason,
  getMsUntilExpiry,
  setSessionExpiredHandler,
  applyServerSessionConfig,
  watchActivity,
  recordActivity,
} from '../lib/session';

const AuthContext = createContext(null);

const ROLE_MAP = {
  user: 'user',
  buyer: 'client',
  broker: 'broker',
  admin: 'broker',
  client: 'client',
};

function unwrapUser(payload) {
  if (!payload) return null;
  if (payload.user) return payload.user;
  if (payload.data?.user) return payload.data.user;
  if (payload.data) return payload.data;
  return payload;
}

function extractToken(payload) {
  if (!payload || typeof payload !== 'object') return null;
  return (
    payload.token ||
    payload.access_token ||
    payload.accessToken ||
    payload.jwt ||
    payload.tokenFromHeader ||
    payload.data?.token ||
    payload.data?.access_token ||
    payload.data?.accessToken ||
    payload.data?.jwt ||
    payload.data?.data?.token ||
    payload.data?.data?.access_token ||
    payload.data?.data?.accessToken ||
    payload.data?.data?.jwt ||
    payload.user?.token ||
    payload.user?.access_token ||
    payload.user?.accessToken ||
    null
  );
}

function initials(name = '') {
  return name
    .split(' ')
    .filter(Boolean)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

function normalizeUser(userData) {
  if (!userData) return userData;
  const normalizedRole = ROLE_MAP[userData.effective_role || userData.role] || userData.effective_role || userData.role;
  const normalizedCompany =
    (userData.role === 'broker' && userData.broker_company) ? userData.broker_company
    : userData.company ?? userData.company_name ?? userData.companyName ?? '';
  const assignedCompanies = userData.assigned_companies ?? userData.assignedCompanies ?? [];
  const normalizedName = userData.name ?? userData.full_name ?? userData.fullName ?? '';
  const normalizedAvatar = userData.avatar ?? initials(normalizedName);
  const companyIds = userData.company_ids ?? userData.companyIds ?? assignedCompanies.map((company) => company.id).filter(Boolean);
  return {
    ...userData,
    role: normalizedRole,
    company: normalizedCompany,
    assignedCompanies,
    assigned_companies: assignedCompanies,
    companyIds,
    company_ids: companyIds,
    name: normalizedName,
    avatar: normalizedAvatar,
  };
}

/** Human-readable reason shown on the login screen after an automatic logout. */
const EXPIRY_MESSAGES = {
  idle: 'You were signed out after a period of inactivity.',
  absolute: 'Your session reached its maximum length. Please sign in again.',
  expired: 'Your session expired. Please sign in again.',
  revoked: 'You were signed out because your account was signed in on another device.',
};

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [permissions, setPermissions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const expiryTimerRef = useRef(null);
  const refreshTimerRef = useRef(null);

  const clearTimers = useCallback(() => {
    if (expiryTimerRef.current) {
      clearTimeout(expiryTimerRef.current);
      expiryTimerRef.current = null;
    }
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
  }, []);

  /**
   * Local teardown when the session ends. No network call — by this point the
   * server has already revoked the session, or the client has decided the
   * window closed. Either way the refresh cookie is dead or about to be.
   */
  const expireSession = useCallback(
    (reason = 'expired') => {
      clearTimers();
      clearSession();
      setStoredToken(null);
      setUser(null);
      setPermissions([]);
      setError(EXPIRY_MESSAGES[reason] || EXPIRY_MESSAGES.expired);
    },
    [clearTimers]
  );

  /**
   * Proactively renews the access token shortly before it expires, so the user
   * never sees a request fail. Belt-and-braces: api.js also refreshes
   * reactively on a 401 with code TOKEN_EXPIRED.
   *
   * The reschedule is reached through a ref rather than by the callback naming
   * itself. A useCallback cannot reference its own binding from inside its body
   * — that binding is still in its temporal dead zone while the callback is
   * being created — so the recursive call would throw at the first renewal.
   */
  const proactiveRefreshRef = useRef(null);

  const scheduleProactiveRefresh = useCallback(
    (expiresInSeconds) => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;

      if (!Number.isFinite(expiresInSeconds)) return;
      // Renew at 75% of the lifetime, with a 30s floor.
      const delayMs = Math.max(30_000, expiresInSeconds * 1000 * 0.75);

      refreshTimerRef.current = setTimeout(async () => {
        // Do not renew a session the user has walked away from — that would
        // keep an idle session alive forever, defeating the idle timeout.
        if (isSessionExpired()) {
          expireSession(getExpiryReason() === 'idle' ? 'idle' : 'expired');
          return;
        }
        try {
          await refreshAccessToken();
          proactiveRefreshRef.current?.(expiresInSeconds);
        } catch {
          expireSession('revoked');
        }
      }, delayMs);
    },
    [expireSession]
  );

  // Keep the ref pointing at the current callback so the timer above always
  // reschedules through the latest closure.
  useEffect(() => {
    proactiveRefreshRef.current = scheduleProactiveRefresh;
  }, [scheduleProactiveRefresh]);

  /** One-shot timer that fires exactly when the idle or absolute window closes. */
  const scheduleExpiryLogout = useCallback(() => {
    if (expiryTimerRef.current) clearTimeout(expiryTimerRef.current);
    expiryTimerRef.current = null;

    const remaining = getMsUntilExpiry();
    if (remaining === null) return;
    if (remaining <= 0) {
      expireSession(getExpiryReason() === 'idle' ? 'idle' : 'absolute');
      return;
    }
    expiryTimerRef.current = setTimeout(() => {
      expireSession(getExpiryReason() === 'idle' ? 'idle' : 'absolute');
    }, remaining);
  }, [expireSession]);

  // The API layer calls this when it detects an expired or revoked session
  // mid-request, so the UI reacts immediately rather than on the next timer tick.
  useEffect(() => {
    setSessionExpiredHandler(expireSession);
    return () => setSessionExpiredHandler(null);
  }, [expireSession]);

  // ── Idle tracking ──────────────────────────────────────────────────────────
  // User activity slides the idle window and re-arms the logout timer. Throttled
  // to one write per 30s inside watchActivity.
  useEffect(() => {
    if (!user) return undefined;
    const unwatch = watchActivity(() => {
      scheduleExpiryLogout();
    });
    return unwatch;
  }, [user, scheduleExpiryLogout]);

  // Returning to a backgrounded tab: timers may have been throttled or the
  // machine may have slept, so re-evaluate immediately.
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState !== 'visible' || !getStoredToken()) return;
      if (isSessionExpired()) {
        expireSession(getExpiryReason() === 'idle' ? 'idle' : 'absolute');
      } else {
        recordActivity();
        scheduleExpiryLogout();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [expireSession, scheduleExpiryLogout]);

  // Cross-tab logout: when another tab clears the token, this tab follows.
  // Without this, signing out in one tab leaves the others apparently signed in.
  useEffect(() => {
    const handleStorage = (event) => {
      if (event.key === 'leo-auth-token' && !event.newValue) {
        clearTimers();
        setUser(null);
        setPermissions([]);
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, [clearTimers]);

  useEffect(() => clearTimers, [clearTimers]);

  // Keepalive: ping the backend every 14 minutes so Render (free tier) never
  // spins down the server. Fires immediately on mount to wake the server as
  // soon as the user opens the app, eliminating the cold-start delay.
  useEffect(() => {
    const API_BASE = (
      import.meta.env.VITE_API_BASE_URL || "http://localhost:4000"
    ).replace(/\/$/, "");
    const ping = () =>
      fetch(`${API_BASE}/health`, { method: "GET", credentials: "omit" }).catch(
        () => {}
      );
    ping();
    const keepalive = setInterval(ping, 14 * 60 * 1000); // 14 minutes
    return () => clearInterval(keepalive);
  }, []);

  // Check for existing token on app load / browser refresh.
  // Session expiry is validated before hitting the server so a stale token
  // with a valid JWT signature (but an expired 8-hour window) never reaches /auth/me.
  useEffect(() => {
    // cancelled flag prevents a stale async chain (e.g. React StrictMode double-invoke
    // or a slow in-flight request) from clearing auth after the effect has been cleaned up.
    let cancelled = false;

    const checkAuth = async () => {
      try {
        const token = getStoredToken();
        if (!token) return;

        // If the session expiry key is present and legitimately past → expire.
        // If the key is ABSENT but a valid token exists (storage trimmed, migrated
        // from an older build, browser backup restore), repair the session window
        // instead of logging the user out — the server will confirm validity below.
        if (isSessionExpired()) {
          let keyExists = false;
          try { keyExists = localStorage.getItem('leo-session-expiry') !== null; } catch { /* ignore */ }
          if (keyExists) {
            // Key is present and in the past — genuine expiry.
            expireSession();
            return;
          }
          // Key absent: repair the window and proceed to server validation.
          startSession();
        }

        let payload;
        try {
          payload = await meRequest();
        } catch (firstErr) {
          if (cancelled) return;

          // 401 = the server explicitly rejected the token (revoked, tampered, wrong secret).
          // Clear auth immediately — keeping the token would loop infinitely.
          if (firstErr?.status === 401) {
            setStoredToken(null);
            setUser(null);
            return;
          }

          // Any other failure (network error, 5xx, server cold-starting on Render free tier)
          // is TRANSIENT. Wait briefly and retry once before giving up.
          // We must NOT clear the token here — it is still valid.
          await new Promise((res) => setTimeout(res, 1500));
          if (cancelled) return;

          try {
            payload = await meRequest();
          } catch (retryErr) {
            if (cancelled) return;
            if (retryErr?.status === 401) {
              setStoredToken(null);
              setUser(null);
            }
            // Non-401 on retry as well: token is preserved.
            // The route guard will redirect to login, but the token stays in
            // localStorage so the very next hard refresh succeeds normally.
            return;
          }
        }

        if (cancelled) return;

        const userData = unwrapUser(payload);
        if (!userData) {
          setStoredToken(null);
          setUser(null);
        } else {
          // Adopt the server's configured timeouts so the client never enforces
          // a longer window than the server actually honours.
          applyServerSessionConfig(payload?.session);
          setUser(normalizeUser(userData));
          setPermissions(payload?.permissions || []);
          recordActivity();
          scheduleExpiryLogout();
          scheduleProactiveRefresh(payload?.session?.accessTokenTtlSeconds);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    checkAuth();

    return () => { cancelled = true; };
    // Deliberately runs once, on mount. This is the initial session restore
    // after a page load; re-running it when a callback identity changes would
    // re-issue /auth/me and re-arm the timers on every render cycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const login = async (email, password) => {
    try {
      setError('');

      const response = await loginRequest({ email: email ? String(email).trim().toLowerCase() : email, password });
      const token = extractToken(response);
      const userData = unwrapUser(response);

      if (!token || !userData) {
        throw new Error('Invalid login response');
      }

      setStoredToken(token);
      applyServerSessionConfig(response?.session);
      startSession();
      const normalizedUser = normalizeUser(userData);
      setUser(normalizedUser);
      setPermissions(response?.permissions || []);
      scheduleExpiryLogout();
      scheduleProactiveRefresh(response?.expiresIn);

      return normalizedUser;
    } catch (backendError) {
      // Surface the lockout countdown; keep everything else generic so the
      // form never distinguishes "unknown account" from "wrong password".
      if (backendError?.code === 'ACCOUNT_LOCKED') {
        const minutes = Math.ceil((backendError.retryAfter || 900) / 60);
        setError(`Too many failed attempts. Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`);
      } else {
        setError(backendError?.message || 'Invalid email or password.');
      }
      return false;
    } finally {
      setLoading(false);
    }
  };

  const signupBroker = async (payload) => {
    try {
      setError('');
      const response = await brokerSignupRequest(payload);
      const token = extractToken(response);
      const userData = unwrapUser(response);

      if (!token || !userData) {
        throw new Error('Invalid sign up response');
      }

      setStoredToken(token);
      startSession();
      const normalizedUser = normalizeUser(userData);
      setUser(normalizedUser);
      setPermissions(response?.permissions || []);
      scheduleExpiryLogout();
      scheduleProactiveRefresh(response?.expiresIn);
      return normalizedUser;
    } catch (signupError) {
      setError(signupError?.message || 'Unable to create broker account.');
      // Password policy failures come back with a details array; surface them
      // all so the user can fix every problem in one go.
      if (signupError?.payload?.details) {
        setError(signupError.payload.details.join(' '));
      }
      return false;
    } finally {
      setLoading(false);
    }
  };

  /**
   * Completes a password reset. The server no longer returns a session here —
   * possession of a reset code should not by itself produce a logged-in
   * session. The caller must redirect to the login screen.
   */
  const resetPassword = async (payload) => {
    try {
      setError('');
      const response = await resetPasswordRequest(payload);
      // Any session that existed is now revoked server-side.
      clearSession();
      setStoredToken(null);
      setUser(null);
      setPermissions([]);
      return { success: true, message: response?.message || 'Password updated. Please sign in.' };
    } catch (resetError) {
      const details = resetError?.payload?.details;
      setError(details ? details.join(' ') : resetError?.message || 'Unable to reset password.');
      return false;
    } finally {
      setLoading(false);
    }
  };

  const refreshUser = async () => {
    try {
      const payload = await meRequest();
      const userData = unwrapUser(payload);
      if (userData) {
        const normalized = normalizeUser(userData);
        setUser(normalized);
        setPermissions(payload?.permissions || []);
        return normalized;
      }
    } catch (err) {
      if (err?.status !== 401) {
        // 401 is handled by the session-expired path; anything else is noise.
        console.warn('Failed to refresh user');
      }
    }
    return null;
  };

  const logout = async () => {
    const token = getStoredToken();

    clearTimers();
    clearSession();

    // Optimistic local clear so sign-out feels instant.
    setUser(null);
    setPermissions([]);
    setError('');
    setStoredToken(null);

    try {
      if (token) {
        // The server revokes the session row and clears the refresh cookie.
        // Unlike the previous implementation this genuinely invalidates the
        // credential rather than only forgetting it client-side.
        await logoutRequest({ token });
      }
    } catch {
      // A failed logout call still leaves the client signed out. The session
      // will expire server-side on its idle timeout.
    }
  };

  /** Capability check mirroring the server's RBAC matrix. UI gating only. */
  const can = useCallback(
    (permission) => permissions.includes(permission),
    [permissions]
  );

  const value = useMemo(
    () => ({
      user,
      permissions,
      can,
      login,
      signupBroker,
      resetPassword,
      logout,
      error,
      setError,
      loading,
      refreshUser,
    }),
    // login/signupBroker/resetPassword/logout/refreshUser are recreated each
    // render by design; including them would defeat the memo, and consumers
    // call them rather than compare them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [user, permissions, can, error, loading]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export const useAuth = () => useContext(AuthContext);
