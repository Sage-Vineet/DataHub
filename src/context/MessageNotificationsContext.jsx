import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { listCompaniesRequest, listCompanyDirectMessageContactsRequest } from '../lib/api';
import { useAuth } from './AuthContext';

const MessageNotificationsContext = createContext(null);
const NOTIFICATION_CACHE_TTL_MS = 60_000;
const BACKGROUND_STALE_MS = 5 * 60_000;
const COMPANY_CACHE_TTL_MS = 10 * 60_000;
const REQUEST_DEBOUNCE_MS = 1_500;

const notificationCache = new Map();
const notificationInflight = new Map();
const brokerCompanyCache = {
  companyIds: [],
  fetchedAt: 0,
  inflight: null,
};

function getStorageKey(userId) {
  return `leo-message-seen:${userId}`;
}

function readSeenMap(userId) {
  if (!userId) return {};
  try {
    const raw = localStorage.getItem(getStorageKey(userId));
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeSeenMap(userId, seenMap) {
  if (!userId) return;
  localStorage.setItem(getStorageKey(userId), JSON.stringify(seenMap));
}

function threadKey(companyId, participantId) {
  return `${companyId}:${participantId}`;
}

function getCachedState(userId) {
  return notificationCache.get(userId) || null;
}

function setCachedState(userId, state) {
  if (!userId) return;
  notificationCache.set(userId, {
    notifications: state.notifications || [],
    lastUpdatedAt: state.lastUpdatedAt || new Date().toISOString(),
    fetchedAt: state.fetchedAt || Date.now(),
  });
}

function applySeenMap(notifications, userId) {
  const seenMap = readSeenMap(userId);
  return notifications.filter((item) => {
    const seenAt = seenMap[item.id];
    return !(seenAt && String(seenAt) >= String(item.createdAt));
  });
}

function normalizeCompanyIds(user) {
  if (!user) return [];
  if (user.role === 'broker') return null;
  return Array.from(new Set([
    user.company_id,
    user.companyId,
    ...(user.company_ids || []),
    ...(user.companyIds || []),
    ...((user.assignedCompanies || user.assigned_companies || []).map((company) => company.id)),
  ].filter(Boolean).map(String)));
}

async function resolveCompanyIds(user, force = false) {
  const companyIds = normalizeCompanyIds(user);
  if (companyIds !== null) return companyIds;

  const now = Date.now();
  if (!force && brokerCompanyCache.companyIds.length && now - brokerCompanyCache.fetchedAt < COMPANY_CACHE_TTL_MS) {
    return brokerCompanyCache.companyIds;
  }

  if (!force && brokerCompanyCache.inflight) {
    return brokerCompanyCache.inflight;
  }

  brokerCompanyCache.inflight = listCompaniesRequest()
    .catch(() => [])
    .then((companies) => {
      const ids = companies.map((company) => String(company.id)).filter(Boolean);
      brokerCompanyCache.companyIds = ids;
      brokerCompanyCache.fetchedAt = Date.now();
      return ids;
    })
    .finally(() => {
      brokerCompanyCache.inflight = null;
    });

  return brokerCompanyCache.inflight;
}

export function MessageNotificationsProvider({ children }) {
  const { user } = useAuth();
  const location = useLocation();
  const userId = user?.id ? String(user.id) : null;
  const cachedState = userId ? getCachedState(userId) : null;
  const [notifications, setNotifications] = useState(() => cachedState?.notifications || []);
  const [loading, setLoading] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState(() => cachedState?.lastUpdatedAt || null);
  const lastRefreshRequestAtRef = useRef(0);
  const mountedRef = useRef(false);

  const userScopeKey = useMemo(() => {
    if (!user) return 'anonymous';
    const companyIds = normalizeCompanyIds(user);
    return JSON.stringify({
      id: user.id,
      role: user.role,
      companyIds: companyIds === null ? 'broker-all' : companyIds,
    });
  }, [user]);

  const refresh = useCallback(async (options = {}) => {
    const { force = false, silent = false } = options;
    if (!userId || !user) {
      setNotifications([]);
      setLoading(false);
      return;
    }

    const now = Date.now();
    const cached = getCachedState(userId);
    if (!force && cached && now - cached.fetchedAt < NOTIFICATION_CACHE_TTL_MS) {
      const nextNotifications = applySeenMap(cached.notifications, userId);
      setNotifications(nextNotifications);
      setLastUpdatedAt(cached.lastUpdatedAt);
      return;
    }

    const inflightKey = `${userId}:${userScopeKey}`;
    if (notificationInflight.has(inflightKey)) {
      const cachedPromise = notificationInflight.get(inflightKey);
      if (!silent) setLoading(true);
      const result = await cachedPromise;
      if (mountedRef.current) {
        setNotifications(result.notifications);
        setLastUpdatedAt(result.lastUpdatedAt);
        setLoading(false);
      }
      return;
    }

    if (!silent) setLoading(true);
    const requestPromise = (async () => {
      const companyIds = await resolveCompanyIds(user, force);
      if (!companyIds.length) {
        return {
          notifications: [],
          lastUpdatedAt: new Date().toISOString(),
          fetchedAt: Date.now(),
        };
      }

      const seenMap = readSeenMap(userId);
      const contactPayloads = await Promise.all(
        companyIds.map((companyId) =>
          listCompanyDirectMessageContactsRequest(companyId)
            .then((payload) => ({
              companyId,
              company: payload?.company || null,
              contacts: payload?.contacts || [],
            }))
            .catch(() => ({ companyId, company: null, contacts: [] })),
        ),
      );

      const nextNotifications = [];
      contactPayloads.forEach(({ companyId, company, contacts }) => {
        contacts.forEach((contact) => {
          const latest = contact.last_message;
          if (!latest?.created_at) return;
          if (String(latest.sender_id) === userId) return;

          const key = threadKey(companyId, contact.id);
          const seenAt = seenMap[key];
          if (seenAt && String(seenAt) >= String(latest.created_at)) return;

          nextNotifications.push({
            id: key,
            companyId: String(companyId),
            companyName: company?.name || 'Company',
            participantId: String(contact.id),
            participantName: contact.name || 'Contact',
            participantRole: contact.role || 'user',
            body: latest.body || 'New message received',
            createdAt: latest.created_at,
          });
        });
      });

      nextNotifications.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      return {
        notifications: nextNotifications,
        lastUpdatedAt: new Date().toISOString(),
        fetchedAt: Date.now(),
      };
    })();

    notificationInflight.set(inflightKey, requestPromise);
    try {
      const result = await requestPromise;
      setCachedState(userId, result);
      if (mountedRef.current) {
        setNotifications(result.notifications);
        setLastUpdatedAt(result.lastUpdatedAt);
      }
    } finally {
      notificationInflight.delete(inflightKey);
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, [user, userId, userScopeKey]);

  const requestRefresh = useCallback((options = {}) => {
    const { force = false } = options;
    const now = Date.now();
    if (!force && now - lastRefreshRequestAtRef.current < REQUEST_DEBOUNCE_MS) return;
    lastRefreshRequestAtRef.current = now;
    refresh(options);
  }, [refresh]);

  const ensureFresh = useCallback((options = {}) => {
    const cached = userId ? getCachedState(userId) : null;
    const maxAge = options.maxAge ?? NOTIFICATION_CACHE_TTL_MS;
    if (!cached || Date.now() - cached.fetchedAt >= maxAge) {
      requestRefresh({ ...options, force: options.force ?? !cached });
    }
  }, [requestRefresh, userId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const commit = (fn) => {
      queueMicrotask(() => {
        if (!cancelled) fn();
      });
    };

    if (!userId) {
      commit(() => {
        setNotifications([]);
        setLastUpdatedAt(null);
        setLoading(false);
      });
      return () => {
        cancelled = true;
      };
    }

    const cached = getCachedState(userId);
    if (cached) {
      commit(() => {
        setNotifications(applySeenMap(cached.notifications, userId));
        setLastUpdatedAt(cached.lastUpdatedAt);
      });
      ensureFresh({ silent: true, maxAge: BACKGROUND_STALE_MS });
      return () => {
        cancelled = true;
      };
    }

    requestRefresh({ force: true });
    return () => {
      cancelled = true;
    };
  }, [ensureFresh, requestRefresh, userId]);

  useEffect(() => {
    ensureFresh({ silent: true, maxAge: BACKGROUND_STALE_MS });
  }, [ensureFresh, location.pathname, location.search]);

  useEffect(() => {
    if (!userId) return undefined;

    const handleFocus = () => {
      ensureFresh({ silent: true, maxAge: NOTIFICATION_CACHE_TTL_MS });
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        ensureFresh({ silent: true, maxAge: NOTIFICATION_CACHE_TTL_MS });
      }
    };
    const handleStorage = (event) => {
      if (event.key === getStorageKey(userId)) {
        const cached = getCachedState(userId);
        setNotifications((current) => applySeenMap(cached?.notifications || current, userId));
      }
    };
    const handleCustomUpdate = () => {
      const cached = getCachedState(userId);
      setNotifications((current) => applySeenMap(cached?.notifications || current, userId));
    };

    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('storage', handleStorage);
    window.addEventListener('leo-message-notifications-updated', handleCustomUpdate);

    return () => {
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener('leo-message-notifications-updated', handleCustomUpdate);
    };
  }, [ensureFresh, userId]);

  const markConversationRead = useCallback((companyId, participantId, seenAt = null) => {
    if (!userId || !companyId || !participantId) return;
    const nextSeenAt = seenAt || new Date().toISOString();
    const seenMap = readSeenMap(userId);
    const key = threadKey(companyId, participantId);
    if (!seenMap[key] || String(seenMap[key]) < String(nextSeenAt)) {
      seenMap[key] = nextSeenAt;
      writeSeenMap(userId, seenMap);
      const cached = getCachedState(userId);
      if (cached) {
        setCachedState(userId, {
          ...cached,
          notifications: cached.notifications.filter((item) => item.id !== key),
        });
      }
      setNotifications((current) => current.filter((item) => item.id !== key));
      window.dispatchEvent(new Event('leo-message-notifications-updated'));
    }
  }, [userId]);

  const unreadCount = notifications.length;

  const value = useMemo(() => ({
    notifications,
    unreadCount,
    loading,
    lastUpdatedAt,
    refresh,
    requestRefresh,
    ensureFresh,
    markConversationRead,
  }), [notifications, unreadCount, loading, lastUpdatedAt, refresh, requestRefresh, ensureFresh, markConversationRead]);

  return (
    <MessageNotificationsContext.Provider value={value}>
      {children}
    </MessageNotificationsContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useMessageNotifications() {
  const context = useContext(MessageNotificationsContext);
  if (!context) {
    throw new Error('useMessageNotifications must be used within a MessageNotificationsProvider');
  }
  return context;
}
