import { useState } from 'react';
import { Bell, MessageSquare, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useMessageNotifications } from '../../context/MessageNotificationsContext';

function formatTime(value) {
  if (!value) return 'Just now';
  const date = new Date(value);
  const now = new Date();
  if (Number.isNaN(date.getTime())) return 'Just now';
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  }
  return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
}

export default function MessageNotificationsMenu({ portal = 'client', companyId = null, className = '' }) {
  const navigate = useNavigate();
  const { notifications, unreadCount } = useMessageNotifications();
  const [open, setOpen] = useState(false);

  const scopedNotifications = companyId
    ? notifications.filter((item) => String(item.companyId) === String(companyId))
    : notifications;

  const scopedCount = companyId ? scopedNotifications.length : unreadCount;

  const openMessages = (notification = null) => {
    setOpen(false);
    if (portal === 'broker') {
      const targetCompanyId = companyId || notification?.companyId || scopedNotifications[0]?.companyId;
      if (targetCompanyId) {
        navigate(`/broker/client/${targetCompanyId}/dataroom/messages`);
      }
      return;
    }
    if (portal === 'user') {
      navigate('/user/messages');
      return;
    }
    navigate('/client/messages');
  };

  return (
    <div className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="group relative flex h-10 w-10 items-center justify-center rounded-md border border-border bg-bg-card text-text-muted transition-all hover:bg-bg-page"
      >
        <Bell size={18} className="transition-colors group-hover:text-primary" />
        {scopedCount > 0 && (
          <span className="absolute right-2.5 top-2.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-negative px-1 text-[9px] font-bold text-white">
            {scopedCount > 9 ? '9+' : scopedCount}
          </span>
        )}
      </button>

      {open && (
        <div
          className="absolute right-0 top-12 z-50 w-80 overflow-hidden rounded-[var(--radius-card)] border border-border bg-white animate-fadeIn"
          style={{ boxShadow: 'var(--shadow-dropdown)' }}
        >
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div>
              <p className="text-[14px] font-semibold text-text-primary">Message Notifications</p>
              <p className="mt-0.5 text-[11px] text-text-muted">{scopedCount} unread conversation{scopedCount === 1 ? '' : 's'}</p>
            </div>
            <button type="button" onClick={() => setOpen(false)} className="text-text-muted transition-colors hover:text-text-primary">
              <X size={15} />
            </button>
          </div>
          <div className="max-h-80 overflow-y-auto">
            {scopedNotifications.length === 0 ? (
              <div className="px-4 py-10 text-center">
                <MessageSquare size={28} className="mx-auto mb-3 text-[#CBD5E1]" />
                <p className="text-sm font-medium text-text-primary">No new messages</p>
                <p className="mt-1 text-xs text-text-muted">Incoming message notifications will appear here.</p>
              </div>
            ) : (
              scopedNotifications.slice(0, 8).map((notification) => (
                <button
                  key={notification.id}
                  type="button"
                  onClick={() => openMessages(notification)}
                  className="w-full border-b border-border-light px-4 py-3 text-left transition-colors hover:bg-bg-page"
                >
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5 flex h-9 w-9 items-center justify-center rounded-full bg-[#EEF6E0] text-[#476E2C]">
                      <MessageSquare size={16} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <p className="truncate text-sm font-semibold text-text-primary">{notification.participantName}</p>
                        <span className="text-[10px] text-text-muted">{formatTime(notification.createdAt)}</span>
                      </div>
                      <p className="mt-0.5 text-[11px] font-medium text-secondary">
                        {notification.companyName} · {notification.participantRole}
                      </p>
                      <p className="mt-1 line-clamp-2 text-xs text-text-muted">{notification.body}</p>
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
          {scopedNotifications.length > 0 && (
            <div className="px-4 py-2 text-center">
              <button type="button" onClick={() => openMessages()} className="text-xs font-medium text-primary hover:text-primary-dark">
                Open messages
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
