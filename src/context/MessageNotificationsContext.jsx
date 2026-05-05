import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { listCompaniesRequest, listCompanyDirectMessageContactsRequest } from '../lib/api';
import { useAuth } from './AuthContext';

const MessageNotificationsContext = createContext(null);

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

export function MessageNotificationsProvider({ children }) {
  const { user } = useAuth();
  const [notifications, setNotifications] = useState([]);
  const [loading, setLoading] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState(null);

  const userId = user?.id ? String(user.id) : null;

  const refresh = useCallback(async () => {
    if (!userId || !user) {
      setNotifications([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      let companyIds = normalizeCompanyIds(user);
      if (companyIds === null) {
        const companies = await listCompaniesRequest().catch(() => []);
        companyIds = companies.map((company) => String(company.id)).filter(Boolean);
      }

      if (!companyIds.length) {
        setNotifications([]);
        setLastUpdatedAt(new Date().toISOString());
        return;
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
      setNotifications(nextNotifications);
      setLastUpdatedAt(new Date().toISOString());
    } finally {
      setLoading(false);
    }
  }, [user, userId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!userId) return undefined;

    const intervalId = window.setInterval(() => {
      refresh();
    }, 30000);

    const handleFocus = () => refresh();
    const handleStorage = (event) => {
      if (event.key === getStorageKey(userId)) {
        refresh();
      }
    };
    const handleCustomUpdate = () => refresh();

    window.addEventListener('focus', handleFocus);
    window.addEventListener('storage', handleStorage);
    window.addEventListener('leo-message-notifications-updated', handleCustomUpdate);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener('leo-message-notifications-updated', handleCustomUpdate);
    };
  }, [refresh, userId]);

  const markConversationRead = useCallback((companyId, participantId, seenAt = null) => {
    if (!userId || !companyId || !participantId) return;
    const nextSeenAt = seenAt || new Date().toISOString();
    const seenMap = readSeenMap(userId);
    const key = threadKey(companyId, participantId);
    if (!seenMap[key] || String(seenMap[key]) < String(nextSeenAt)) {
      seenMap[key] = nextSeenAt;
      writeSeenMap(userId, seenMap);
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
    markConversationRead,
  }), [notifications, unreadCount, loading, lastUpdatedAt, refresh, markConversationRead]);

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
