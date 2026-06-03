import { createContext, useContext, useState, useEffect } from 'react';
import { brokerSignupRequest, loginRequest, logoutRequest, meRequest, setStoredToken, getStoredToken } from '../lib/api';

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

  // Check for existing token on app load
  useEffect(() => {
    const checkAuth = async () => {
      const token = getStoredToken();
      if (token) {
        try {
          const payload = await meRequest();
          const userData = unwrapUser(payload);
          if (!userData) {
            setStoredToken(null);
            setUser(null);
          } else {
            setUser(normalizeUser(userData));
          }
        } catch (err) {
          // Token is invalid, clear it
          setStoredToken(null);
          setUser(null);
          console.log('Invalid token, clearing auth');
        }
      }
      setLoading(false);
    };

    checkAuth();
  }, []);

  const login = async (email, password) => {
    try {
      setError('');

      // Try backend authentication first
      const response = await loginRequest({ email, password });
      const token = extractToken(response);
      const userData = unwrapUser(response);

      if (!token || !userData) {
        throw new Error('Invalid login response');
      }

      // Store token and set user
      setStoredToken(token);
      const normalizedUser = normalizeUser(userData);
      setUser(normalizedUser);

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
      const normalizedUser = normalizeUser(userData);
      setUser(normalizedUser);
      return normalizedUser;
    } catch (signupError) {
      setError(signupError?.message || 'Unable to create broker account.');
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
    <AuthContext.Provider value={{ user, login, signupBroker, logout, error, setError, loading, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export const useAuth = () => useContext(AuthContext);
