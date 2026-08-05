import { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { brokerSignupRequest, loginRequest, logoutRequest, meRequest, resetPasswordRequest, setStoredToken, getStoredToken } from '../lib/api';
import {
  startSession,
  clearSession,
  isSessionExpired,
  getSessionExpiry,
  setSessionExpiredHandler,
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

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Holds the id of the one-shot expiry setTimeout so we can cancel it on logout.
  const expiryTimerRef = useRef(null);

  // Synchronous logout path used when the session clock runs out.
  // Does NOT make a network call — there is no need to inform the server.
  // setUser / setStoredToken / setError are stable React setState functions.
  const expireSession = useCallback(() => {
    if (expiryTimerRef.current) {
      clearTimeout(expiryTimerRef.current);
      expiryTimerRef.current = null;
    }
    clearSession();
    setStoredToken(null);
    setUser(null);
    setError('');
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Arms a one-shot timer that fires exactly at the stored expiry timestamp.
  // "Continuously running timers" (setInterval) are intentionally not used.
  const scheduleExpiryLogout = useCallback(() => {
    if (expiryTimerRef.current) clearTimeout(expiryTimerRef.current);
    expiryTimerRef.current = null;
    const expiry = getSessionExpiry();
    if (!expiry) return;
    const delay = expiry - Date.now();
    if (delay <= 0) {
      expireSession();
      return;
    }
    expiryTimerRef.current = setTimeout(expireSession, delay);
  }, [expireSession]);

  // Register expireSession as the callback invoked by the API interceptor when
  // it detects an expired session on a mid-flight authenticated request.
  useEffect(() => {
    setSessionExpiredHandler(expireSession);
    return () => setSessionExpiredHandler(null);
  }, [expireSession]);

  // On tab/window focus: immediately check whether the session has expired while
  // the app was in the background (covers Scenario B from the spec).
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && getStoredToken()) {
        if (isSessionExpired()) expireSession();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [expireSession]);

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
          setUser(normalizeUser(userData));
          scheduleExpiryLogout(); // re-arm timer after browser refresh
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    checkAuth();

    return () => { cancelled = true; };
  }, []); // expireSession and scheduleExpiryLogout are stable (useCallback [])

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
      startSession();           // record login time, calculate 8-hour expiry
      const normalizedUser = normalizeUser(userData);
      setUser(normalizedUser);
      scheduleExpiryLogout();   // arm one-shot timer for automatic logout

      return normalizedUser;
    } catch (backendError) {
      setError(backendError?.message || 'Invalid email or password.');
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
      scheduleExpiryLogout();
      return normalizedUser;
    } catch (signupError) {
      setError(signupError?.message || 'Unable to create broker account.');
      return false;
    } finally {
      setLoading(false);
    }
  };

  const resetPassword = async (payload) => {
    try {
      setError('');
      const response = await resetPasswordRequest(payload);
      const token = extractToken(response);
      const userData = unwrapUser(response);

      if (!token || !userData) {
        throw new Error('Invalid reset password response');
      }

      setStoredToken(token);
      startSession();
      const normalizedUser = normalizeUser(userData);
      setUser(normalizedUser);
      scheduleExpiryLogout();
      return normalizedUser;
    } catch (resetError) {
      setError(resetError?.message || 'Unable to reset password.');
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
        return normalized;
      }
    } catch (err) {
      console.log('Failed to refresh user:', err.message);
    }
    return null;
  };

  const logout = async () => {
    const token = getStoredToken();

    // Cancel the one-shot expiry timer so it doesn't fire after an explicit logout.
    if (expiryTimerRef.current) {
      clearTimeout(expiryTimerRef.current);
      expiryTimerRef.current = null;
    }

    // Clear session timestamps from localStorage.
    clearSession();

    // Optimistically clear local auth so signout feels instant.
    setUser(null);
    setError('');
    setStoredToken(null);

    try {
      if (token) {
        await logoutRequest({ token });
      }
    } catch (err) {
      console.log('Logout request failed:', err.message);
    }
  };

  return (
    <AuthContext.Provider value={{ user, login, signupBroker, resetPassword, logout, error, setError, loading, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export const useAuth = () => useContext(AuthContext);
