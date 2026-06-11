import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft, Building2,
  ChevronRight, Hash, Loader2, Lock,
  MessageSquare, RefreshCw, Search, Send, Users, X,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import {
  listMessageGroupsForCompany,
  listMyMessageGroups,
  listGroupMessages,
  sendGroupMessage,
  markGroupMessagesRead,
  getGroupMembers,
} from '../../lib/api';
import { MSG_GROUP_TYPE, ROLE_META, inferSubRole } from '../../lib/roles';

// ─── Constants ─────────────────────────────────────────────────────────────────

const POLL_MS = 6000;

// Group type display metadata
const GROUP_TYPE_META = {
  [MSG_GROUP_TYPE.BROKER_INTERNAL]: { label: 'Broker Team',     icon: Lock,          accent: '#b45e08' },
  [MSG_GROUP_TYPE.DEAL_TEAM]:       { label: 'Deal Team',        icon: Users,          accent: '#05164D' },
  [MSG_GROUP_TYPE.BROKER_CLIENT]:   { label: 'Broker & Client',  icon: Building2,      accent: '#00648F' },
  [MSG_GROUP_TYPE.BROKER_BUYER]:    { label: 'Broker & Buyer',   icon: MessageSquare,  accent: '#476E2C' },
  [MSG_GROUP_TYPE.CLIENT_INTERNAL]: { label: 'Client Team',      icon: Lock,           accent: '#00648F' },
  [MSG_GROUP_TYPE.BUYER_INTERNAL]:  { label: 'Buyer Team',       icon: Lock,           accent: '#476E2C' },
};

// Sidebar ordering: show deal_team first (most important), then broker groups, then internal
const GROUP_ORDER = [
  MSG_GROUP_TYPE.DEAL_TEAM,
  MSG_GROUP_TYPE.BROKER_CLIENT,
  MSG_GROUP_TYPE.BROKER_BUYER,
  MSG_GROUP_TYPE.BROKER_INTERNAL,
  MSG_GROUP_TYPE.BUYER_INTERNAL,
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function initials(name = '') {
  return name.split(' ').filter(Boolean).map((p) => p[0]).join('').slice(0, 2).toUpperCase() || '?';
}

// Deterministic color from string — cycles through brand palette
const PALETTE = ['#8BC53D', '#05164D', '#F68C1F', '#742982', '#00648F', '#476E2C', '#e05c2a'];
const colorFor = (str = '') => PALETTE[Math.abs(str.split('').reduce((a, c) => a + c.charCodeAt(0), 0)) % PALETTE.length];

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
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

function roleLabelFromUser(u) {
  if (!u) return '';
  const sub = u.sub_role || inferSubRole(u);
  if (sub && ROLE_META[sub]) return ROLE_META[sub].label;
  if (u.role === 'broker' || u.role === 'admin') return 'Broker';
  if (u.role === 'buyer' || u.role === 'client') return 'Client';
  return u.role || '';
}

function getGroupMeta(group) {
  return GROUP_TYPE_META[group?.group_type] || { label: group?.name || 'Group', icon: Hash, accent: '#6B7280' };
}

function sortGroups(groups) {
  return [...groups].sort((a, b) => {
    const ai = GROUP_ORDER.indexOf(a.group_type);
    const bi = GROUP_ORDER.indexOf(b.group_type);
    const order = (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    if (order !== 0) return order;
    // Within same type, sort by latest message time (newest first)
    const at = a.last_message?.created_at || a.created_at || '';
    const bt = b.last_message?.created_at || b.created_at || '';
    return bt.localeCompare(at);
  });
}

// ─── GroupAvatar ──────────────────────────────────────────────────────────────

function GroupAvatar({ group, size = 46 }) {
  const meta  = getGroupMeta(group);
  const Icon  = meta.icon;
  const bg    = colorFor(group.name || group.id || '');
  return (
    <div
      className="flex-shrink-0 rounded-full flex items-center justify-center text-white font-bold"
      style={{ width: size, height: size, background: bg, fontSize: size * 0.35 }}
    >
      <Icon size={size * 0.42} className="text-white/90" />
    </div>
  );
}

// ─── Sidebar group item ────────────────────────────────────────────────────────

function GroupListItem({ group, isActive, onClick }) {
  const meta        = getGroupMeta(group);
  const lastMsg     = group.last_message;
  const unread      = group.unread_count || 0;
  const timeLabel   = formatTime(lastMsg?.created_at || group.updated_at);
  const memberCount = group.message_group_members?.length || 0;

  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors border-b border-gray-100/80 ${
        isActive ? 'bg-[#F0F2F5]' : 'hover:bg-[#F5F5F5]'
      }`}
    >
      <GroupAvatar group={group} size={46} />

      <div className="flex-1 min-w-0">
        {/* Name row */}
        <div className="flex items-center justify-between gap-1 mb-0.5">
          <span className={`text-[14px] font-semibold truncate ${isActive ? 'text-[#05164D]' : 'text-[#111B21]'}`}>
            {group.name}
          </span>
          <span className={`text-[11px] flex-shrink-0 ${unread > 0 ? 'text-[#25D366] font-semibold' : 'text-gray-400'}`}>
            {timeLabel}
          </span>
        </div>

        {/* Preview row */}
        <div className="flex items-center justify-between gap-1">
          <p className="text-[13px] text-gray-500 truncate leading-tight">
            {lastMsg
              ? <>{lastMsg.sender_name && <span className="font-medium text-gray-600">{lastMsg.sender_name}: </span>}{lastMsg.body}</>
              : <span className="italic text-gray-400">{meta.label} · {memberCount} member{memberCount !== 1 ? 's' : ''}</span>
            }
          </p>
          {unread > 0 && (
            <span className="flex-shrink-0 min-w-[20px] h-5 px-1.5 rounded-full bg-[#25D366] text-white text-[11px] font-bold flex items-center justify-center">
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

// ─── Message bubble ───────────────────────────────────────────────────────────

function MessageBubble({ message, isOwn, showSenderInfo }) {
  const sender = message.users || message.sender;
  const name   = sender?.name || 'Unknown';

  return (
    <div className={`flex gap-2 px-3 ${isOwn ? 'justify-end' : 'justify-start'} ${showSenderInfo && !isOwn ? 'mt-8' : 'mt-0.5'}`}>
      {!isOwn && (
        showSenderInfo
          ? (
            <div
              className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0 self-start mt-0"
              style={{ background: colorFor(name) }}
            >
              {initials(name)}
            </div>
          )
          : <div className="w-7 flex-shrink-0" />
      )}

      <div className={`max-w-[65%] flex flex-col ${isOwn ? 'items-end' : 'items-start'}`}>
        {!isOwn && showSenderInfo && (
          <span
            className="text-[10px] font-semibold mb-0.5 px-1"
            style={{ color: colorFor(name) }}
          >
            {name}
            {roleLabelFromUser(sender) && (
              <span className="text-gray-400 font-normal ml-1.5 text-[10px]">
                {roleLabelFromUser(sender)}
              </span>
            )}
          </span>
        )}

        <div
          className={`px-3 pt-2 pb-1.5 rounded-2xl shadow-sm text-sm leading-relaxed ${
            isOwn
              ? 'bg-[#D9FDD3] text-[#111B21] rounded-br-sm'
              : 'bg-white text-[#111B21] rounded-tl-sm border border-gray-100'
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

// ─── Date separator ───────────────────────────────────────────────────────────

function DateSeparator({ date }) {
  return (
    <div className="flex items-center justify-center my-3 px-3">
      <span className="bg-white text-[11px] font-semibold text-gray-500 px-3 py-1 rounded-full shadow-sm border border-gray-100">
        {formatFullDate(date)}
      </span>
    </div>
  );
}

// ─── Members panel ────────────────────────────────────────────────────────────

function MembersPanel({ groupId, onClose }) {
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!groupId) return;
    setLoading(true);
    getGroupMembers(groupId)
      .then((d) => setMembers(d || []))
      .catch(() => setMembers([]))
      .finally(() => setLoading(false));
  }, [groupId]);

  return (
    <div className="w-72 flex-shrink-0 flex flex-col border-l border-gray-200 bg-white">
      {/* Header */}
      <div className="px-4 py-3.5 border-b border-gray-100 flex items-center justify-between flex-shrink-0 bg-[#F0F2F5]">
        <div>
          <h3 className="text-[13px] font-bold text-[#05164D]">Group Members</h3>
          {!loading && (
            <p className="text-[11px] text-gray-400 mt-0.5">
              {members.length} member{members.length !== 1 ? 's' : ''}
            </p>
          )}
        </div>
        <button
          onClick={onClose}
          className="w-7 h-7 rounded-full hover:bg-gray-200 flex items-center justify-center text-gray-500 transition-colors"
        >
          <X size={14} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto py-2">
        {loading ? (
          <div className="py-8 text-center">
            <Loader2 size={18} className="mx-auto text-gray-300 animate-spin" />
          </div>
        ) : members.length === 0 ? (
          <p className="text-xs text-gray-400 text-center py-6">No members found.</p>
        ) : (
          members.map((m) => {
            const label       = roleLabelFromUser(m);
            const displayName = m.name || m.email || 'Unknown';
            return (
              <div
                key={m.id}
                className="flex items-center gap-3 px-4 py-2.5 hover:bg-[#F5F5F5] transition-colors"
              >
                <div
                  className="w-9 h-9 rounded-full flex items-center justify-center text-[11px] font-bold text-white flex-shrink-0"
                  style={{ background: colorFor(displayName) }}
                >
                  {initials(displayName)}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] font-semibold text-[#111B21] truncate">{displayName}</p>
                  {label && <p className="text-[11px] text-gray-400 truncate">{label}</p>}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ─── Chat header ──────────────────────────────────────────────────────────────

function ChatHeader({ group, onMembersToggle, showMembers, onBack }) {
  const meta        = getGroupMeta(group);
  const memberCount = group.message_group_members?.length || 0;

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
      <GroupAvatar group={group} size={40} />
      <div className="flex-1 min-w-0">
        <p className="text-[14px] font-bold text-[#111B21] truncate">{group.name}</p>
        <p className="text-[12px] text-gray-500 truncate">
          {meta.label}
          {memberCount > 0 && ` · ${memberCount} member${memberCount !== 1 ? 's' : ''}`}
        </p>
      </div>
      <button
        onClick={onMembersToggle}
        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-semibold border transition-all ${
          showMembers
            ? 'bg-[#05164D] text-white border-[#05164D]'
            : 'bg-white text-[#05164D] border-gray-300 hover:border-[#05164D]'
        }`}
      >
        <Users size={13} />
        Members
      </button>
    </div>
  );
}

// ─── Chat input ───────────────────────────────────────────────────────────────

function ChatInput({ onSend, disabled }) {
  const [body, setBody]      = useState('');
  const [sending, setSending] = useState(false);
  const textareaRef           = useRef(null);

  const doSend = async () => {
    const text = body.trim();
    if (!text || sending || disabled) return;
    setSending(true);
    setBody('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
    const ok = await onSend(text);
    if (!ok) setBody(text); // restore on failure
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

// ─── Empty / no-groups state ──────────────────────────────────────────────────

function NoGroupsState({ onRefresh, loading }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 text-center px-6">
      <div className="w-16 h-16 rounded-full bg-[#E8ECF5] flex items-center justify-center">
        <MessageSquare size={28} className="text-[#05164D]" />
      </div>
      <div>
        <p className="text-base font-bold text-[#05164D]">No message groups yet</p>
        <p className="text-sm text-gray-400 mt-1.5 max-w-xs">
          Groups are created automatically when users are added to a deal. Try refreshing or ask your broker to add users.
        </p>
      </div>
      <button
        onClick={onRefresh}
        disabled={loading}
        className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-[#8BC53D] text-white text-sm font-semibold hover:bg-[#476E2C] transition-colors disabled:opacity-50"
      >
        {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
        Refresh
      </button>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

/**
 * WhatsApp-inspired group messaging workspace.
 *
 * Props:
 *   companyId   – required when useMyGroups=false (broker workspace view per company)
 *   useMyGroups – when true, loads all groups the current user is a member of
 *   title       – sidebar header title (only shown when headerSlot is absent)
 *   headerSlot  – optional React node to replace the sidebar header area
 */
export default function GroupMessagesWorkspace({
  companyId,
  useMyGroups = false,
  title = 'Messages',
  headerSlot,
  tab,
  onTabChange,
}) {
  const { user } = useAuth();

  const [groups,          setGroups         ] = useState([]);
  const [activeGroupId,   setActiveGroupId  ] = useState(null);
  const [messages,        setMessages       ] = useState([]);
  const [loadingGroups,   setLoadingGroups  ] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [groupError,      setGroupError     ] = useState('');
  const [msgError,        setMsgError       ] = useState('');
  const [showMembers,     setShowMembers    ] = useState(false);
  const [search,          setSearch         ] = useState('');
  const [mobileShowChat,  setMobileShowChat ] = useState(false);

  const messagesEndRef = useRef(null);
  const pollRef        = useRef(null);

  // ── Load groups ──────────────────────────────────────────────────────────────
  const loadGroups = useCallback(async () => {
    if (!useMyGroups && !companyId) return;
    setGroupError('');
    try {
      const raw = useMyGroups
        ? await listMyMessageGroups()
        : await listMessageGroupsForCompany(companyId);
      // CLIENT_INTERNAL and BUYER_INTERNAL are member-only groups — brokers must not see them
      const filtered = (raw || []).filter((g) =>
        g.group_type !== MSG_GROUP_TYPE.CLIENT_INTERNAL &&
        g.group_type !== MSG_GROUP_TYPE.BUYER_INTERNAL,
      );
      const sorted = sortGroups(filtered);
      setGroups(sorted);
      // Auto-select first group if nothing active
      setActiveGroupId((prev) => prev || sorted[0]?.id || null);
    } catch {
      setGroupError('Could not load message groups.');
    } finally {
      setLoadingGroups(false);
    }
  }, [companyId, useMyGroups]);

  useEffect(() => {
    setLoadingGroups(true);
    loadGroups();
  }, [companyId, useMyGroups]); // intentionally not including loadGroups to avoid double-fire

  // ── Load messages ─────────────────────────────────────────────────────────────
  const loadMessages = useCallback(async (groupId, silent = false) => {
    if (!groupId) return;
    if (!silent) setLoadingMessages(true);
    setMsgError('');
    try {
      const data = await listGroupMessages(groupId);
      setMessages(data || []);
      markGroupMessagesRead(groupId).catch(() => {});
      // Update unread_count in sidebar for this group
      setGroups((prev) =>
        prev.map((g) => g.id === groupId ? { ...g, unread_count: 0 } : g),
      );
    } catch {
      if (!silent) setMsgError('Could not load messages.');
    } finally {
      if (!silent) setLoadingMessages(false);
    }
  }, []);

  useEffect(() => {
    if (!activeGroupId) return;
    loadMessages(activeGroupId);
    clearInterval(pollRef.current);
    pollRef.current = setInterval(() => loadMessages(activeGroupId, true), POLL_MS);
    return () => clearInterval(pollRef.current);
  }, [activeGroupId, loadMessages]);

  // Reset members panel on group switch
  useEffect(() => { setShowMembers(false); }, [activeGroupId]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  // ── Select group ──────────────────────────────────────────────────────────────
  const handleSelectGroup = (groupId) => {
    setActiveGroupId(groupId);
    setMobileShowChat(true);
  };

  // ── Send message ──────────────────────────────────────────────────────────────
  const handleSend = async (text) => {
    if (!activeGroupId) return false;
    try {
      const sent = await sendGroupMessage(activeGroupId, text);
      if (sent) {
        setMessages((prev) => [...prev, sent]);
        // Update last_message in sidebar immediately
        setGroups((prev) =>
          sortGroups(
            prev.map((g) =>
              g.id === activeGroupId
                ? {
                    ...g,
                    last_message: {
                      body: sent.body,
                      sender_name: user?.name || 'You',
                      created_at: sent.created_at,
                    },
                  }
                : g,
            ),
          ),
        );
      }
      return true;
    } catch {
      return false;
    }
  };

  // ── Derived ───────────────────────────────────────────────────────────────────
  const filteredGroups = groups.filter(
    (g) => !search || g.name.toLowerCase().includes(search.toLowerCase()),
  );
  const activeGroup = groups.find((g) => g.id === activeGroupId);

  // Build messages with date separators
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

  // ── No groups state ───────────────────────────────────────────────────────────
  if (!loadingGroups && groups.length === 0 && !groupError) {
    return (
      <div className="flex h-full min-h-0 overflow-hidden rounded-2xl border border-gray-200 shadow-sm bg-white">
        <NoGroupsState onRefresh={loadGroups} loading={loadingGroups} />
      </div>
    );
  }

  // ── Mobile: show chat pane when a group is selected ───────────────────────────
  const isMobileChat = mobileShowChat && activeGroup;

  return (
    <div className="flex h-full min-h-0 overflow-hidden rounded-2xl border border-gray-200 shadow-sm bg-white">

      {/* ══ LEFT SIDEBAR ════════════════════════════════════════════════════════ */}
      <div
        className={`flex-shrink-0 flex flex-col border-r border-gray-200 bg-white ${
          isMobileChat ? 'hidden md:flex md:w-80' : 'w-full md:w-80'
        }`}
      >
        {/* Sidebar top bar */}
        <div className="px-4 py-3.5 bg-[#F0F2F5] border-b border-gray-200 flex items-center gap-3 flex-shrink-0">
          {headerSlot ?? (
            <>
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
                onClick={loadGroups}
                disabled={loadingGroups}
                className="w-8 h-8 rounded-full hover:bg-gray-200 flex items-center justify-center text-gray-500 transition-colors flex-shrink-0"
                title="Refresh groups"
              >
                {loadingGroups
                  ? <Loader2 size={15} className="animate-spin" />
                  : <RefreshCw size={15} />
                }
              </button>
            </>
          )}
        </div>

        {/* Search */}
        <div className="px-3 py-2 bg-[#F0F2F5] border-b border-gray-200 flex-shrink-0">
          <div className="flex items-center gap-2 bg-white rounded-full px-3.5 py-2 border border-gray-200">
            <Search size={13} className="text-gray-400 flex-shrink-0" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search groups"
              className="text-[13px] outline-none bg-transparent w-full text-[#111B21] placeholder-gray-400"
            />
            {search && (
              <button onClick={() => setSearch('')} className="text-gray-400 hover:text-gray-600 flex-shrink-0">
                <X size={12} />
              </button>
            )}
          </div>
        </div>

        {/* Group list */}
        <div className="flex-1 overflow-y-auto">
          {loadingGroups ? (
            <div className="py-12 text-center">
              <Loader2 size={22} className="mx-auto text-gray-300 animate-spin" />
            </div>
          ) : groupError ? (
            <p className="px-4 py-6 text-[13px] text-red-400 text-center">{groupError}</p>
          ) : filteredGroups.length === 0 ? (
            <p className="px-4 py-6 text-[13px] text-gray-400 text-center">No groups found</p>
          ) : (
            filteredGroups.map((group) => (
              <GroupListItem
                key={group.id}
                group={group}
                isActive={group.id === activeGroupId}
                onClick={() => handleSelectGroup(group.id)}
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
        {!activeGroup ? (
          /* No group selected — WhatsApp-style welcome pane */
          <div className="flex-1 flex flex-col items-center justify-center text-center px-6 bg-[#F0F2F5]">
            <div className="w-20 h-20 rounded-full bg-white border-2 border-gray-200 flex items-center justify-center mb-4 shadow-sm">
              <MessageSquare size={36} className="text-[#05164D]/30" />
            </div>
            <h3 className="text-[15px] font-bold text-[#41525D]">DataHub Messages</h3>
            <p className="text-[13px] text-gray-400 mt-2 max-w-xs">
              Select a group from the left to start or continue a conversation.
            </p>
          </div>
        ) : (
          <>
            {/* Chat header */}
            <ChatHeader
              group={activeGroup}
              onMembersToggle={() => setShowMembers((v) => !v)}
              showMembers={showMembers}
              onBack={isMobileChat ? () => setMobileShowChat(false) : undefined}
            />

            {/* Messages scroll area — WhatsApp tan background */}
            <div
              className="flex-1 overflow-y-auto py-3 space-y-px"
              style={{ background: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='80'%3E%3Ccircle cx='40' cy='40' r='35' fill='none' stroke='%23e0e0e0' stroke-width='0.5' opacity='0.3'/%3E%3C/svg%3E\") #E5DDD5" }}
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
                      Be the first to send a message in this group.
                    </p>
                  </div>
                </div>
              ) : (
                messagesWithDates.map((item, idx) => {
                  if (item._type === 'date') {
                    return <DateSeparator key={item._key} date={item.date} />;
                  }
                  const isOwn = String(item.sender_id) === String(user?.id);
                  // Show sender info if previous message was from a different sender
                  const prevMsg = messagesWithDates[idx - 1];
                  const showSenderInfo = !isOwn && (!prevMsg || prevMsg._type === 'date' || prevMsg.sender_id !== item.sender_id);
                  return (
                    <MessageBubble
                      key={item._key}
                      message={item}
                      isOwn={isOwn}
                      showSenderInfo={showSenderInfo}
                    />
                  );
                })
              )}
              <div ref={messagesEndRef} className="h-2" />
            </div>

            {/* Message input */}
            <ChatInput onSend={handleSend} disabled={!!msgError} />
          </>
        )}
      </div>

      {/* ══ MEMBERS PANEL ══════════════════════════════════════════════════════ */}
      {showMembers && activeGroupId && (
        <MembersPanel groupId={activeGroupId} onClose={() => setShowMembers(false)} />
      )}
    </div>
  );
}
