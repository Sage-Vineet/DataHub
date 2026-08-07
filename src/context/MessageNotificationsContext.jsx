import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { listCompaniesRequest, listCompanyDirectMessageContactsRequest, listMyMessageGroups } from '../lib/api';
import { useAuth } from './AuthContext';

// ── Why this provider no longer fetches proactively ──────────────────────────
// This provider is mounted once at the app root (App.jsx, above every route)
// and stays mounted for the whole session. `refresh()` powers the sidebar/
// navbar unread-message badge, and internally it calls the same two endpoints
// the actual Messages page uses to populate its contact/group lists:
//   GET /companies/:companyId/direct-messages/contacts  (once per assigned company)
//   GET /my-groups
// There is no lightweight "unread count" endpoint — the badge is derived
// client-side from the full contacts/groups payload — so these calls take
// 2-4 seconds each.
//
// Previously this fired: once on login, again on EVERY route change (a
// `useLocation()`-keyed effect — confirmed root cause of the reported
// background calls on Dashboard/Reports/Key Reports/COA/etc.), and again on
// every window focus/tab-visibility change. All three were unconditional:
// they had no idea whether the user had ever opened Messages.
//
// Decision (explicit product tradeoff, not a bug fix): the badge now shows
// the LAST-KNOWN count, persisted in localStorage so it survives a full page
// reload, and is refreshed only by a genuine user action:
//   - opening the bell/notifications dropdown (MessageNotificationsMenu's
//     onClick already calls ensureFresh — unchanged)
//   - marking something read while Messages is open (markConversationRead /
//     markGroupRead — local cache mutation only, never a network call)
// It is never refreshed automatically by mounting, navigating, or refocusing
// the tab. First-ever session (nothing cached yet) shows no badge until the
// user opens Messages or the bell once.
//
// None of this changes refresh()'s own logic (which endpoints, chunking,
// how unread is derived) — only when it is allowed to run.

const MessageNotificationsContext = createContext(null);
// How long a fetched result is considered fresh enough to skip a re-fetch when
// ensureFresh/refresh IS explicitly invoked (bell click, manual refresh, etc.)
// — NOT a polling interval; nothing in this file calls these on a timer.
const NOTIFICATION_CACHE_TTL_MS = 60_000;
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

// Durable copy of the last-fetched notification snapshot, so the sidebar/bell
// badge can show a last-known count on a fresh page load WITHOUT firing a
// network request — the in-memory `notificationCache` Map alone is lost on
// every full reload / new tab. This is purely a cache-durability addition:
// it never changes what refresh() fetches or how, only lets an already-fetched
// result survive a reload. See the module doc comment above for why this
// provider no longer fetches proactively (removed: on-mount-with-no-cache
// eager fetch, per-route-change refresh, focus/visibility refresh).
function getPersistedStorageKey(userId) {
  return `leo-message-notifications-cache:${userId}`;
}

function readPersistedState(userId) {
  if (!userId) return null;
  try {
    const raw = localStorage.getItem(getPersistedStorageKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.notifications)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writePersistedState(userId, state) {
  if (!userId) return;
  try {
    localStorage.setItem(getPersistedStorageKey(userId), JSON.stringify(state));
  } catch {
    /* quota / serialization — non-fatal, badge just won't survive a reload this time */
  }
}

function getCachedState(userId) {
  const inMemory = notificationCache.get(userId);
  if (inMemory) return inMemory;
  // Fall back to the durable copy (e.g. right after a full page reload, before
  // any fetch has happened this session) and warm the in-memory map from it so
  // subsequent reads this session don't re-hit localStorage.
  const persisted = readPersistedState(userId);
  if (persisted) {
    notificationCache.set(userId, persisted);
    return persisted;
  }
  return null;
}

function setCachedState(userId, state) {
  if (!userId) return;
  const entry = {
    notifications: state.notifications || [],
    lastUpdatedAt: state.lastUpdatedAt || new Date().toISOString(),
    fetchedAt: state.fetchedAt || Date.now(),
  };
  notificationCache.set(userId, entry);
  writePersistedState(userId, entry);
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
      const nextNotifications = [];

      // ── DM notifications (per-company contacts) ─────────────────────────────
      const companyIds = await resolveCompanyIds(user, force);
      if (companyIds.length) {
        const seenMap = readSeenMap(userId);
        const CHUNK_SIZE = 5;
        const payloadChunks = [];
        for (let i = 0; i < companyIds.length; i += CHUNK_SIZE) {
          const chunk = companyIds.slice(i, i + CHUNK_SIZE);
          const results = await Promise.all(
            chunk.map((companyId) =>
              listCompanyDirectMessageContactsRequest(companyId)
                .then((payload) => ({
                  companyId,
                  company: payload?.company || null,
                  contacts: payload?.contacts || [],
                }))
                .catch(() => ({ companyId, company: null, contacts: [] }))
            )
          );
          payloadChunks.push(...results);
        }
        payloadChunks.forEach(({ companyId, company, contacts }) => {
          contacts.forEach((contact) => {
            const latest = contact.last_message;
            if (!latest?.created_at) return;
            if (String(latest.sender_id) === userId) return;
            const key = threadKey(companyId, contact.id);
            const seenAt = seenMap[key];
            if (seenAt && String(seenAt) >= String(latest.created_at)) return;
            nextNotifications.push({
              id: key,
              type: 'dm',
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
      }

      // ── Group notifications — server unread_count is authoritative ──────────
      try {
        const myGroups = await listMyMessageGroups();
        for (const g of (myGroups || [])) {
          if ((g.unread_count || 0) > 0) {
            nextNotifications.push({
              id: `group:${g.id}`,
              type: 'group',
              groupId: String(g.id),
              companyId: String(g.company_id || ''),
              groupName: g.name,
              groupType: g.group_type,
              body: g.last_message?.body || 'New message in group',
              senderName: g.last_message?.sender_name || '',
              createdAt: g.last_message?.created_at || g.updated_at || '',
              unreadCount: g.unread_count || 0,
            });
          }
        }
      } catch {}

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

  // Seed React state from cache ONLY — never fetches. `getCachedState` already
  // falls back to the localStorage-persisted snapshot, so this shows a
  // last-known badge across a full page reload with zero network calls. If
  // nothing has ever been cached for this user (first-ever session, or a
  // browser that never opened Messages), the badge simply stays empty until
  // the user opens the bell dropdown or the Messages page themselves — see the
  // module doc comment above for why this is a deliberate tradeoff, not an
  // oversight.
  useEffect(() => {
    let cancelled = false;
    // Deferred (not called synchronously in the effect body) — same pattern
    // the previous version of this effect used, to avoid a same-tick
    // cascading render.
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
    } else {
      const cached = getCachedState(userId);
      if (cached) {
        commit(() => {
          setNotifications(applySeenMap(cached.notifications, userId));
          setLastUpdatedAt(cached.lastUpdatedAt);
        });
      }
    }

    return () => {
      cancelled = true;
    };
  }, [userId]);

  // Cross-tab / same-tab LOCAL sync only — neither listener below makes a
  // network call. `storage` fires when another tab marks something read
  // (writeSeenMap in a different tab); the custom event fires when THIS tab's
  // markConversationRead/markGroupRead mutates the cache. Both simply re-derive
  // the already-cached notifications through the seen-map filter.
  //
  // Deliberately NOT listening for `focus`/`visibilitychange` anymore: those
  // used to trigger a network refresh, which is exactly the
  // "background polling when chat is closed" this provider must never do.
  useEffect(() => {
    if (!userId) return undefined;

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

    window.addEventListener('storage', handleStorage);
    window.addEventListener('leo-message-notifications-updated', handleCustomUpdate);

    return () => {
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener('leo-message-notifications-updated', handleCustomUpdate);
    };
  }, [userId]);

  const markGroupRead = useCallback((groupId) => {
    if (!userId || !groupId) return;
    const key = `group:${groupId}`;
    const cached = getCachedState(userId);
    if (cached) {
      setCachedState(userId, { ...cached, notifications: cached.notifications.filter((n) => n.id !== key) });
    }
    setNotifications((current) => current.filter((n) => n.id !== key));
    window.dispatchEvent(new Event('leo-message-notifications-updated'));
  }, [userId]);

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
    markGroupRead,
  }), [notifications, unreadCount, loading, lastUpdatedAt, refresh, requestRefresh, ensureFresh, markConversationRead, markGroupRead]);

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
