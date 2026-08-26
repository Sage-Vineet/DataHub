import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, Loader2, MessageSquare,
  RefreshCw, Search, Send, UserRound, X,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useMessageNotifications } from '../../context/MessageNotificationsContext';
import {
  listMyDirectContactsRequest,
  listCompanyDirectMessageContactsRequest,
  getCompanyDirectMessagesRequest,
  createCompanyDirectMessageRequest,
} from '../../lib/api';

const POLL_MS = 6000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function initials(name = '') {
  return name.split(' ').filter(Boolean).map((p) => p[0]).join('').slice(0, 2).toUpperCase() || '?';
}

const PALETTE = ['#8BC53D', '#05164D', '#F68C1F', '#742982', '#00648F', '#476E2C', '#e05c2a'];
const colorFor = (str = '') =>
  PALETTE[Math.abs(str.split('').reduce((a, c) => a + c.charCodeAt(0), 0)) % PALETTE.length];

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString())
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
}

function formatFullDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

function roleLabel(role, subRole) {
  if (subRole === 'company_owner') return 'Company Owner';
  if (subRole === 'client_team_member') return 'Client Team Member';
  if (subRole === 'client_accountant') return 'Client Accountant';
  if (subRole === 'buyer_primary') return 'Buyer';
  if (subRole === 'buyer_team_member') return 'Buyer Team Member';
  if (subRole === 'buyer_accountant') return 'Buyer Accountant';
  if (subRole === 'broker_primary') return 'Broker';
  if (subRole === 'broker_team_member') return 'Broker Team Member';
  if (subRole === 'banker') return 'Banker';
  if (subRole === 'loan_broker') return 'Loan Broker';
  if (role === 'broker' || role === 'admin') return 'Broker';
  if (role === 'client') return 'Client';
  if (role === 'buyer' || role === 'user') return 'Buyer';
  return '';
}

// ─── ContactListItem ──────────────────────────────────────────────────────────

function ContactListItem({ contact, isActive, onClick, unreadCount = 0 }) {
  const displayName = contact.name || contact.email || 'Unknown';
  const label = roleLabel(contact.role, contact.sub_role);
  const lastMsg = contact.last_message;
  const timeLabel = formatTime(lastMsg?.created_at || '');
  const hasUnread = unreadCount > 0 && !isActive;

  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors border-b border-gray-100/80 ${
        isActive ? 'bg-[#F0F2F5]' : 'hover:bg-[#F5F5F5]'
      }`}
    >
      <div className="relative flex-shrink-0">
        <div
          className="w-[46px] h-[46px] rounded-full flex items-center justify-center text-white text-[14px] font-bold"
          style={{ background: colorFor(displayName) }}
        >
          {initials(displayName)}
        </div>
        {hasUnread && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-[#25D366] text-white text-[9px] font-bold flex items-center justify-center">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-1 mb-0.5">
          <span className={`text-[14px] font-semibold truncate ${isActive ? 'text-[#05164D]' : 'text-[#111B21]'}`}>
            {displayName}
          </span>
          {timeLabel && (
            <span className={`text-[11px] flex-shrink-0 ${hasUnread ? 'text-[#25D366] font-semibold' : 'text-gray-400'}`}>{timeLabel}</span>
          )}
        </div>
        <p className={`text-[13px] truncate leading-tight ${hasUnread ? 'font-semibold text-[#111B21]' : 'text-gray-500'}`}>
          {lastMsg ? lastMsg.body : <span className="italic text-gray-400 font-normal">{label}</span>}
        </p>
      </div>
    </button>
  );
}

// ─── MessageBubble ────────────────────────────────────────────────────────────

function MessageBubble({ message, isOwn }) {
  const sender = message.sender || {};
  const name = sender.name || 'Unknown';

  return (
    <div className={`flex gap-2 px-3 ${isOwn ? 'justify-end' : 'justify-start'} mb-0.5`}>
      {!isOwn && (
        <div
          className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0 mt-1 self-end"
          style={{ background: colorFor(name) }}
        >
          {initials(name)}
        </div>
      )}
      <div className={`max-w-[65%] flex flex-col ${isOwn ? 'items-end' : 'items-start'}`}>
        <div
          className={`px-3 pt-2 pb-1.5 rounded-2xl shadow-sm text-sm leading-relaxed ${
            isOwn
              ? 'bg-[#D9FDD3] text-[#111B21] rounded-br-sm'
              : 'bg-white text-[#111B21] rounded-bl-sm border border-gray-100'
          }`}
        >
          <p className="whitespace-pre-wrap break-words">{message.body}</p>
          <div className={`flex justify-end mt-1 ${isOwn ? 'text-gray-500' : 'text-gray-400'}`}>
            <span className="text-[10px] whitespace-nowrap">
              {new Date(message.created_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── DateSeparator ────────────────────────────────────────────────────────────

function DateSeparator({ date }) {
  return (
    <div className="flex items-center justify-center my-3 px-3">
      <span className="bg-white text-[11px] font-semibold text-gray-500 px-3 py-1 rounded-full shadow-sm border border-gray-100">
        {formatFullDate(date)}
      </span>
    </div>
  );
}

// ─── DmChatHeader ─────────────────────────────────────────────────────────────

function DmChatHeader({ contact, onBack }) {
  const displayName = contact?.name || 'Direct Message';
  const label = roleLabel(contact?.role, contact?.sub_role);

  return (
    <div className="flex items-center gap-3 px-4 py-3 bg-[#F0F2F5] border-b border-gray-200 flex-shrink-0">
      {onBack && (
        <button
          onClick={onBack}
          className="w-8 h-8 rounded-full hover:bg-gray-200 flex items-center justify-center text-gray-600 flex-shrink-0 transition-colors"
        >
          <ArrowLeft size={18} />
        </button>
      )}
      <div
        className="w-10 h-10 rounded-full flex items-center justify-center text-white text-[13px] font-bold flex-shrink-0"
        style={{ background: colorFor(displayName) }}
      >
        {initials(displayName)}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[14px] font-bold text-[#111B21] truncate">{displayName}</p>
        {label && <p className="text-[12px] text-gray-500 truncate">{label}</p>}
      </div>
    </div>
  );
}

// ─── ChatInput ────────────────────────────────────────────────────────────────

function ChatInput({ onSend, disabled }) {
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const textareaRef = useRef(null);

  const doSend = async () => {
    const text = body.trim();
    if (!text || sending || disabled) return;
    setSending(true);
    setBody('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    const ok = await onSend(text);
    if (!ok) setBody(text);
    setSending(false);
    textareaRef.current?.focus();
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
  };

  const handleChange = (e) => {
    setBody(e.target.value);
    e.target.style.height = 'auto';
    e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
  };

  return (
    <div className="px-4 py-3 bg-[#F0F2F5] border-t border-gray-200 flex-shrink-0">
      <div className="flex items-end gap-2 bg-white rounded-xl border border-gray-200 px-4 py-2.5 shadow-sm focus-within:border-[#8BC53D] transition-colors">
        <textarea
          ref={textareaRef}
          rows={1}
          value={body}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder="Type a message"
          disabled={disabled}
          className="flex-1 text-[14px] outline-none bg-transparent resize-none leading-5 text-[#111B21] placeholder-gray-400 py-1 max-h-[120px] overflow-y-auto disabled:opacity-50"
          style={{ minHeight: 24 }}
        />
        <button
          onClick={doSend}
          disabled={!body.trim() || sending || disabled}
          className="w-9 h-9 rounded-full flex items-center justify-center bg-[#8BC53D] disabled:opacity-40 hover:bg-[#476E2C] transition-colors flex-shrink-0"
        >
          {sending
            ? <Loader2 size={16} className="text-white animate-spin" />
            : <Send size={16} className="text-white" />
          }
        </button>
      </div>
      <p className="text-[10px] text-gray-400 mt-1.5 text-center">
        Enter to send · Shift+Enter for new line
      </p>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

/**
 * WhatsApp-style 1-to-1 direct messages workspace.
 *
 * Props:
 *   companyId     – when provided (broker portal), loads contacts for that specific deal company
 *   useMyContacts – when true (client/buyer portals), loads /my-direct-contacts across all companies
 *   title         – sidebar header title
 */
export default function DirectMessagesWorkspace({
  companyId,
  useMyContacts = false,
  title = 'Chats',
  tab,
  onTabChange,
}) {
  const { user } = useAuth();
  const { notifications, markConversationRead } = useMessageNotifications();

  // Build contactId → unread count from DM notifications
  const unreadMap = useMemo(() => {
    const map = new Map();
    for (const n of notifications) {
      if (n.type !== 'group') map.set(String(n.participantId), (map.get(String(n.participantId)) || 0) + 1);
    }
    return map;
  }, [notifications]);

  const [contacts, setContacts] = useState([]);
  const [contactCompanyMap, setContactCompanyMap] = useState({});
  const [selectedContactId, setSelectedContactId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loadingContacts, setLoadingContacts] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [contactsError, setContactsError] = useState('');
  const [msgError, setMsgError] = useState('');
  const [search, setSearch] = useState('');
  const [mobileShowChat, setMobileShowChat] = useState(false);

  const messagesEndRef = useRef(null);
  const pollRef = useRef(null);

  const activeCompanyId = selectedContactId
    ? (contactCompanyMap[String(selectedContactId)] || companyId || null)
    : null;

  // ── Load contacts ─────────────────────────────────────────────────────────────
  const loadContacts = useCallback(async () => {
    if (!useMyContacts && !companyId) return;
    setContactsError('');
    try {
      let allContacts = [];
      const companyMap = {};

      if (useMyContacts) {
        const data = await listMyDirectContactsRequest();
        const seen = new Map(); // contactId → contact (deduped, keeps most-recent last_message)
        for (const entry of (data || [])) {
          const cid = String(entry.company?.id || '');
          for (const c of (entry.contacts || [])) {
            const key = String(c.id);
            const existing = seen.get(key);
            const existDate = existing?.last_message?.created_at || '';
            const newDate = c.last_message?.created_at || '';
            if (!existing || newDate > existDate) {
              seen.set(key, c);
              companyMap[key] = cid; // use the company with the most recent message
            }
          }
        }
        allContacts = [...seen.values()];
      } else {
        const data = await listCompanyDirectMessageContactsRequest(companyId);
        allContacts = data?.contacts || [];
        const cid = String(companyId);
        for (const c of allContacts) companyMap[String(c.id)] = cid;
      }

      setContacts(allContacts);
      setContactCompanyMap(companyMap);
      setSelectedContactId((prev) => {
        if (prev && allContacts.some((c) => String(c.id) === String(prev))) return prev;
        return null; // don't auto-select on load
      });
    } catch {
      setContactsError('Could not load contacts.');
    } finally {
      setLoadingContacts(false);
    }
  }, [companyId, useMyContacts]);

  useEffect(() => {
    setLoadingContacts(true);
    loadContacts();
  }, [companyId, useMyContacts]); // intentionally not including loadContacts to avoid double-fire

  // ── Load messages ─────────────────────────────────────────────────────────────
  const loadMessages = useCallback(async (contactId, cid, silent = false) => {
    if (!contactId || !cid) return;
    if (!silent) setLoadingMessages(true);
    setMsgError('');
    try {
      const data = await getCompanyDirectMessagesRequest(cid, contactId);
      const msgs = data?.messages || [];
      setMessages(msgs);
      markConversationRead(cid, String(contactId));
    } catch {
      if (!silent) setMsgError('Could not load messages.');
    } finally {
      if (!silent) setLoadingMessages(false);
    }
  }, [markConversationRead]);

  useEffect(() => {
    if (!selectedContactId || !activeCompanyId) {
      setMessages([]);
      return;
    }
    loadMessages(selectedContactId, activeCompanyId);
    clearInterval(pollRef.current);
    pollRef.current = setInterval(
      () => loadMessages(selectedContactId, activeCompanyId, true),
      POLL_MS,
    );
    return () => clearInterval(pollRef.current);
  }, [selectedContactId, activeCompanyId, loadMessages]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  // ── Handlers ──────────────────────────────────────────────────────────────────
  const handleSelectContact = (contactId) => {
    setSelectedContactId(String(contactId));
    setMobileShowChat(true);
  };

  const handleSend = async (text) => {
    if (!selectedContactId || !activeCompanyId) return false;
    try {
      const sent = await createCompanyDirectMessageRequest(activeCompanyId, selectedContactId, { body: text });
      const newMsg = sent?.id ? sent : {
        id: `temp-${Date.now()}`,
        body: text,
        created_at: new Date().toISOString(),
        sender_id: user?.id,
        sender: { id: user?.id, name: user?.name, role: user?.role },
      };
      setMessages((prev) => [...prev, newMsg]);
      setContacts((prev) => {
        const idx = prev.findIndex((c) => String(c.id) === String(selectedContactId));
        if (idx === -1) return prev;
        const updated = {
          ...prev[idx],
          last_message: { body: text, created_at: newMsg.created_at, sender_id: user?.id },
        };
        const next = [...prev];
        next.splice(idx, 1);
        return [updated, ...next];
      });
      return true;
    } catch {
      return false;
    }
  };

  // ── Derived ───────────────────────────────────────────────────────────────────
  const filteredContacts = contacts.filter(
    (c) => !search || (c.name || '').toLowerCase().includes(search.toLowerCase()),
  );
  const activeContact = contacts.find((c) => String(c.id) === String(selectedContactId)) || null;
  const isMobileChat = mobileShowChat && activeContact;

  const messagesWithDates = (() => {
    const result = [];
    let lastDate = null;
    for (const msg of messages) {
      const d = new Date(msg.created_at).toDateString();
      if (d !== lastDate) {
        result.push({ _type: 'date', date: msg.created_at, _key: `date-${msg.created_at}` });
        lastDate = d;
      }
      result.push({ _type: 'msg', ...msg, _key: msg.id });
    }
    return result;
  })();

  return (
    <div className="flex h-full min-h-0 overflow-hidden rounded-2xl border border-gray-200 shadow-sm bg-white">

      {/* ══ LEFT SIDEBAR ════════════════════════════════════════════════════════ */}
      <div
        className={`flex-shrink-0 flex flex-col border-r border-gray-200 bg-white ${
          isMobileChat ? 'hidden md:flex md:w-80' : 'w-full md:w-80'
        }`}
      >
        {/* Header */}
        <div className="px-4 py-3.5 bg-[#F0F2F5] border-b border-gray-200 flex items-center gap-3 flex-shrink-0">
          {onTabChange && (
            <div className="flex items-center gap-0.5 p-0.5 bg-white rounded-full border border-gray-200 flex-shrink-0">
              <button
                onClick={() => onTabChange('groups')}
                className={`px-3 py-1 rounded-full text-[11px] font-semibold transition-all ${tab === 'groups' ? 'bg-[#05164D] text-white' : 'text-gray-500 hover:text-[#05164D]'}`}
              >Groups</button>
              <button
                onClick={() => onTabChange('chats')}
                className={`px-3 py-1 rounded-full text-[11px] font-semibold transition-all ${tab === 'chats' ? 'bg-[#05164D] text-white' : 'text-gray-500 hover:text-[#05164D]'}`}
              >Chats</button>
            </div>
          )}
          <div className="flex-1 min-w-0" />
          <button
            onClick={loadContacts}
            disabled={loadingContacts}
            className="w-8 h-8 rounded-full hover:bg-gray-200 flex items-center justify-center text-gray-500 transition-colors flex-shrink-0"
          >
            {loadingContacts
              ? <Loader2 size={15} className="animate-spin" />
              : <RefreshCw size={15} />
            }
          </button>
        </div>

        {/* Search */}
        <div className="px-3 py-2 bg-[#F0F2F5] border-b border-gray-200 flex-shrink-0">
          <div className="flex items-center gap-2 bg-white rounded-full px-3.5 py-2 border border-gray-200">
            <Search size={13} className="text-gray-400 flex-shrink-0" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search contacts"
              className="text-[13px] outline-none bg-transparent w-full text-[#111B21] placeholder-gray-400"
            />
            {search && (
              <button onClick={() => setSearch('')} className="text-gray-400 hover:text-gray-600 flex-shrink-0">
                <X size={12} />
              </button>
            )}
          </div>
        </div>

        {/* Contact list */}
        <div className="flex-1 overflow-y-auto">
          {loadingContacts ? (
            <div className="py-12 text-center">
              <Loader2 size={22} className="mx-auto text-gray-300 animate-spin" />
            </div>
          ) : contactsError ? (
            <p className="px-4 py-6 text-[13px] text-red-400 text-center">{contactsError}</p>
          ) : filteredContacts.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 px-4 text-center gap-3">
              <UserRound size={32} className="text-gray-200" />
              <p className="text-[13px] text-gray-400">
                {contacts.length ? 'No matching contacts' : 'No contacts available'}
              </p>
            </div>
          ) : (
            filteredContacts.map((contact) => (
              <ContactListItem
                key={contact.id}
                contact={contact}
                isActive={String(contact.id) === String(selectedContactId)}
                onClick={() => handleSelectContact(contact.id)}
                unreadCount={unreadMap.get(String(contact.id)) || 0}
              />
            ))
          )}
        </div>
      </div>

      {/* ══ RIGHT: CHAT AREA ════════════════════════════════════════════════════ */}
      <div
        className={`flex-1 flex flex-col min-w-0 ${
          isMobileChat ? 'flex' : 'hidden md:flex'
        }`}
      >
        {!activeContact ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center px-6 bg-[#F0F2F5]">
            <div className="w-20 h-20 rounded-full bg-white border-2 border-gray-200 flex items-center justify-center mb-4 shadow-sm">
              <MessageSquare size={36} className="text-[#05164D]/30" />
            </div>
            <h3 className="text-[15px] font-bold text-[#41525D]">Direct Messages</h3>
            <p className="text-[13px] text-gray-400 mt-2 max-w-xs">
              Select a contact from the left to start a one-to-one conversation.
            </p>
          </div>
        ) : (
          <>
            <DmChatHeader
              contact={activeContact}
              onBack={isMobileChat ? () => setMobileShowChat(false) : undefined}
            />

            {/* Messages area — same WhatsApp tan background as group chat */}
            <div
              className="flex-1 overflow-y-auto py-3 space-y-px"
              style={{
                background: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='80'%3E%3Ccircle cx='40' cy='40' r='35' fill='none' stroke='%23e0e0e0' stroke-width='0.5' opacity='0.3'/%3E%3C/svg%3E\") #E5DDD5",
              }}
            >
              {loadingMessages ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 size={24} className="text-white/80 animate-spin drop-shadow" />
                </div>
              ) : msgError ? (
                <p className="text-center text-sm text-white bg-red-400/70 mx-6 py-2 rounded-lg mt-4">{msgError}</p>
              ) : messagesWithDates.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <div className="bg-white/80 rounded-xl px-5 py-4 shadow-sm">
                    <MessageSquare size={28} className="text-gray-300 mb-2 mx-auto" />
                    <p className="text-[13px] font-semibold text-gray-500">No messages yet</p>
                    <p className="text-[12px] text-gray-400 mt-0.5">
                      Start the conversation by sending the first message.
                    </p>
                  </div>
                </div>
              ) : (
                messagesWithDates.map((item) => {
                  if (item._type === 'date') return <DateSeparator key={item._key} date={item.date} />;
                  const isOwn = String(item.sender_id) === String(user?.id);
                  return <MessageBubble key={item._key} message={item} isOwn={isOwn} />;
                })
              )}
              <div ref={messagesEndRef} className="h-2" />
            </div>

            <ChatInput onSend={handleSend} disabled={!!msgError} />
          </>
        )}
      </div>
    </div>
  );
}
