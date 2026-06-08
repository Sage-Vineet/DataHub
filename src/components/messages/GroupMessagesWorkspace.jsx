import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Building2, MessageSquare, RefreshCw, Search, Send,
  Users, Lock, Loader2, ChevronRight, Hash, X, ChevronDown,
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

const POLL_MS = 8000;

const GROUP_TYPE_META = {
  [MSG_GROUP_TYPE.BROKER_INTERNAL]: { label: 'Broker Team',        icon: Lock,         color: '#b45e08', bg: '#FFF8F0' },
  [MSG_GROUP_TYPE.DEAL_TEAM]:       { label: 'Deal Team',          icon: Users,         color: '#05164D', bg: '#EEF1FA' },
  [MSG_GROUP_TYPE.BROKER_CLIENT]:   { label: 'Broker & Client',    icon: Building2,     color: '#00648F', bg: '#EEF7FC' },
  [MSG_GROUP_TYPE.BROKER_BUYER]:    { label: 'Broker & Buyer',     icon: MessageSquare, color: '#476E2C', bg: '#EDF6E2' },
  [MSG_GROUP_TYPE.CLIENT_INTERNAL]: { label: 'Client Team',        icon: Lock,          color: '#00648F', bg: '#EEF7FC' },
  [MSG_GROUP_TYPE.BUYER_INTERNAL]:  { label: 'Buyer Team',         icon: Lock,          color: '#476E2C', bg: '#EDF6E2' },
};

function getGroupMeta(group) {
  return GROUP_TYPE_META[group.group_type] || { label: group.name || 'Group', icon: Hash, color: '#6B7280', bg: '#F3F4F6' };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function initials(name = '') {
  return name.split(' ').filter(Boolean).map((p) => p[0]).join('').slice(0, 2).toUpperCase();
}

const palette = ['#8BC53D', '#05164D', '#F68C1F', '#742982', '#00648F', '#476E2C'];
const avatarColor = (name = '') => palette[(name || '').length % palette.length];

function formatTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return date.toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
}

function roleLabelFromUser(u) {
  if (!u) return '';
  const sub = u.sub_role || inferSubRole(u);
  if (sub && ROLE_META[sub]) return ROLE_META[sub].label;
  if (u.role === 'broker' || u.role === 'admin') return 'Broker';
  if (u.role === 'buyer' || u.role === 'client') return 'Client';
  return u.role || '';
}

// ─── Group item in sidebar ────────────────────────────────────────────────────

function GroupItem({ group, isActive, onClick }) {
  const meta = getGroupMeta(group);
  const Icon = meta.icon;
  const memberCount = group.message_group_members?.length || 0;

  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all text-left ${
        isActive ? 'bg-[#05164D] text-white' : 'hover:bg-gray-100 text-[#050505]'
      }`}
    >
      <div
        className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
        style={{ background: isActive ? 'rgba(255,255,255,0.18)' : meta.bg }}
      >
        <Icon size={16} style={{ color: isActive ? '#fff' : meta.color }} />
      </div>
      <div className="flex-1 min-w-0">
        <p className={`text-[13px] font-semibold truncate ${isActive ? 'text-white' : 'text-[#05164D]'}`}>{group.name}</p>
        <p className={`text-[11px] truncate ${isActive ? 'text-white/70' : 'text-gray-400'}`}>
          {meta.label} · {memberCount} member{memberCount !== 1 ? 's' : ''}
        </p>
      </div>
      {!isActive && <ChevronRight size={14} className="text-gray-300 flex-shrink-0" />}
    </button>
  );
}

// ─── Message bubble ───────────────────────────────────────────────────────────

function MessageBubble({ message, isOwn }) {
  const sender = message.users || message.sender;
  return (
    <div className={`flex gap-2.5 ${isOwn ? 'flex-row-reverse' : 'flex-row'}`}>
      {!isOwn && (
        <div
          className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0 mt-1"
          style={{ background: avatarColor(sender?.name || '') }}
        >
          {initials(sender?.name || '')}
        </div>
      )}
      <div className={`max-w-[78%] flex flex-col ${isOwn ? 'items-end' : 'items-start'}`}>
        {!isOwn && (
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[11px] font-semibold text-[#05164D]">{sender?.name || 'Unknown'}</span>
            <span className="text-[10px] text-gray-400">{roleLabelFromUser(sender)}</span>
          </div>
        )}
        <div className={`px-3.5 py-2.5 rounded-2xl text-sm leading-relaxed shadow-sm ${
          isOwn
            ? 'bg-[#8BC53D] text-white rounded-br-sm'
            : 'bg-white border border-gray-100 text-[#05164D] rounded-bl-sm'
        }`}>
          <p className="whitespace-pre-wrap break-words">{message.body}</p>
        </div>
        <p className="text-[10px] mt-1 text-gray-400">{formatTime(message.created_at)}</p>
      </div>
    </div>
  );
}

// ─── Date separator ───────────────────────────────────────────────────────────

function DateSeparator({ date }) {
  const label = (() => {
    const d = new Date(date);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return 'Today';
    const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  })();
  return (
    <div className="flex items-center gap-3 my-4">
      <div className="flex-1 h-px bg-gray-100" />
      <span className="text-[11px] font-semibold text-gray-400 px-2">{label}</span>
      <div className="flex-1 h-px bg-gray-100" />
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
      .then((data) => setMembers(data || []))
      .catch(() => setMembers([]))
      .finally(() => setLoading(false));
  }, [groupId]);

  return (
    <div className="w-64 flex-shrink-0 flex flex-col border-l border-gray-100 bg-gray-50/50">
      <div className="px-4 py-3.5 border-b border-gray-100 flex items-center justify-between flex-shrink-0">
        <div>
          <h3 className="text-sm font-bold text-[#05164D]">Members</h3>
          {!loading && <p className="text-xs text-gray-400 mt-0.5">{members.length} member{members.length !== 1 ? 's' : ''}</p>}
        </div>
        <button onClick={onClose} className="w-7 h-7 rounded-lg hover:bg-gray-200 flex items-center justify-center text-gray-400">
          <X size={14} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-1">
        {loading ? (
          <div className="py-8 text-center"><Loader2 size={18} className="mx-auto text-gray-300 animate-spin" /></div>
        ) : members.length === 0 ? (
          <p className="text-xs text-gray-400 text-center py-6">No members found.</p>
        ) : members.map((m) => {
          const roleLabel = roleLabelFromUser(m);
          const displayName = m.name || m.email || 'Unknown';
          return (
            <div key={m.id} className="flex items-center gap-2.5 px-2.5 py-2 rounded-xl hover:bg-white transition-colors">
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-bold text-white flex-shrink-0"
                style={{ background: avatarColor(displayName) }}
              >
                {initials(displayName)}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[13px] font-semibold text-[#05164D] truncate">{displayName}</p>
                {roleLabel && <p className="text-[11px] text-gray-400 truncate">{roleLabel}</p>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

/**
 * @param {string}  companyId   – required when useMyGroups=false (broker view)
 * @param {boolean} useMyGroups – when true, loads groups the current user is a
 *                                member of (for client / buyer portals)
 * @param {string}  title
 */
export default function GroupMessagesWorkspace({ companyId, useMyGroups = false, title = 'Messages' }) {
  const { user } = useAuth();
  const [groups, setGroups] = useState([]);
  const [activeGroupId, setActiveGroupId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [body, setBody] = useState('');
  const [loadingGroups, setLoadingGroups] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sending, setSending] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [groupError, setGroupError] = useState('');
  const [msgError, setMsgError] = useState('');
  const [showMembers, setShowMembers] = useState(false);
  const messagesEndRef = useRef(null);
  const textareaRef = useRef(null);
  const pollRef = useRef(null);

  // ── Load groups ─────────────────────────────────────────────────────────────
  const loadGroups = useCallback(async () => {
    if (!useMyGroups && !companyId) return;
    try {
      setGroupError('');
      const data = useMyGroups
        ? await listMyMessageGroups()
        : await listMessageGroupsForCompany(companyId);
      setGroups(data || []);
      if (!activeGroupId && data?.length) setActiveGroupId(data[0].id);
    } catch {
      setGroupError('Could not load message groups. Try refreshing.');
    } finally {
      setLoadingGroups(false);
    }
  }, [companyId, useMyGroups, activeGroupId]);

  useEffect(() => { loadGroups(); }, [companyId, useMyGroups]);

  // ── Load messages ───────────────────────────────────────────────────────────
  const loadMessages = useCallback(async (groupId, silent = false) => {
    if (!groupId) return;
    if (!silent) setLoadingMessages(true);
    setMsgError('');
    try {
      const data = await listGroupMessages(groupId);
      setMessages(data || []);
      markGroupMessagesRead(groupId).catch(() => {});
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

  // Reset member panel when switching groups
  useEffect(() => { setShowMembers(false); }, [activeGroupId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  // ── Send ─────────────────────────────────────────────────────────────────────
  const handleSend = async () => {
    const text = body.trim();
    if (!text || !activeGroupId || sending) return;
    setSending(true);
    setBody('');
    try {
      const sent = await sendGroupMessage(activeGroupId, text);
      if (sent) setMessages((prev) => [...prev, sent]);
    } catch {
      setBody(text);
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const filteredGroups = groups.filter((g) =>
    !searchQuery || g.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const activeGroup = groups.find((g) => g.id === activeGroupId);

  const messagesWithDates = (() => {
    const result = [];
    let lastDate = null;
    for (const msg of messages) {
      const msgDate = new Date(msg.created_at).toDateString();
      if (msgDate !== lastDate) { result.push({ type: 'date', date: msg.created_at, key: `date-${msg.created_at}` }); lastDate = msgDate; }
      result.push({ type: 'msg', ...msg, key: msg.id });
    }
    return result;
  })();

  if (!loadingGroups && groups.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full min-h-[400px] gap-4 text-center px-6">
        <div className="w-14 h-14 rounded-2xl bg-[#E8ECF5] flex items-center justify-center">
          <MessageSquare size={24} className="text-[#05164D]" />
        </div>
        <div>
          <p className="text-base font-bold text-[#05164D]">No message groups yet</p>
          <p className="text-sm text-gray-400 mt-1">Groups are created automatically when users are added to this deal.</p>
        </div>
        <button onClick={loadGroups} className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-[#8BC53D] text-white text-sm font-semibold hover:bg-[#476E2C] transition-colors">
          <RefreshCw size={14} /> Refresh
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 overflow-hidden rounded-2xl border border-gray-100 shadow-sm bg-white">
      {/* ── Left sidebar: group list ── */}
      <div className="w-72 flex-shrink-0 flex flex-col border-r border-gray-100 bg-gray-50/50">
        <div className="px-4 py-3.5 border-b border-gray-100 flex-shrink-0">
          <h2 className="text-sm font-bold text-[#05164D]">{title}</h2>
          <p className="text-xs text-gray-400 mt-0.5">{groups.length} group{groups.length !== 1 ? 's' : ''}</p>
        </div>

        <div className="px-3 py-2.5 border-b border-gray-100 flex-shrink-0">
          <div className="flex items-center gap-2 bg-white border border-gray-200 rounded-xl px-3 py-2">
            <Search size={13} className="text-gray-400 flex-shrink-0" />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search groups..."
              className="text-xs outline-none bg-transparent w-full text-[#05164D] placeholder-gray-400"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-2 py-2 space-y-0.5">
          {loadingGroups ? (
            <div className="py-8 text-center"><Loader2 size={20} className="mx-auto text-gray-300 animate-spin" /></div>
          ) : groupError ? (
            <p className="px-3 py-4 text-xs text-red-400 text-center">{groupError}</p>
          ) : filteredGroups.length === 0 ? (
            <p className="px-3 py-4 text-xs text-gray-400 text-center">No groups found</p>
          ) : filteredGroups.map((group) => (
            <GroupItem
              key={group.id}
              group={group}
              isActive={group.id === activeGroupId}
              onClick={() => setActiveGroupId(group.id)}
            />
          ))}
        </div>
      </div>

      {/* ── Centre: message area ── */}
      <div className="flex-1 flex flex-col min-w-0">
        {!activeGroup ? (
          <div className="flex-1 flex items-center justify-center text-center px-6">
            <div>
              <MessageSquare size={32} className="mx-auto text-gray-200 mb-3" />
              <p className="text-sm font-semibold text-gray-400">Select a group to start messaging</p>
            </div>
          </div>
        ) : (
          <>
            {/* Header */}
            <div className="px-5 py-3.5 border-b border-gray-100 flex items-center gap-3 flex-shrink-0">
              {(() => { const meta = getGroupMeta(activeGroup); const Icon = meta.icon; return (
                <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: meta.bg }}>
                  <Icon size={16} style={{ color: meta.color }} />
                </div>
              ); })()}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-bold text-[#05164D] truncate">{activeGroup.name}</p>
                <p className="text-xs text-gray-400">{getGroupMeta(activeGroup).label} · {activeGroup.message_group_members?.length || 0} members</p>
              </div>
              {/* Members toggle */}
              <button
                onClick={() => setShowMembers((v) => !v)}
                title="View members"
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all border ${
                  showMembers
                    ? 'bg-[#05164D] text-white border-[#05164D]'
                    : 'bg-white text-[#05164D] border-gray-200 hover:border-[#05164D]'
                }`}
              >
                <Users size={13} />
                Members
                <ChevronDown size={12} className={`transition-transform ${showMembers ? 'rotate-180' : ''}`} />
              </button>
              <button onClick={() => loadMessages(activeGroupId)} className="w-8 h-8 rounded-lg hover:bg-gray-100 flex items-center justify-center text-gray-400 flex-shrink-0" title="Refresh">
                <RefreshCw size={14} />
              </button>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-1">
              {loadingMessages ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 size={22} className="text-gray-300 animate-spin" />
                </div>
              ) : msgError ? (
                <p className="text-center text-sm text-red-400 py-8">{msgError}</p>
              ) : messagesWithDates.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <MessageSquare size={28} className="text-gray-200 mb-2" />
                  <p className="text-sm font-semibold text-gray-400">No messages yet</p>
                  <p className="text-xs text-gray-300 mt-1">Be the first to send a message in this group.</p>
                </div>
              ) : messagesWithDates.map((item) => {
                if (item.type === 'date') return <DateSeparator key={item.key} date={item.date} />;
                const isOwn = String(item.sender_id) === String(user?.id);
                return <MessageBubble key={item.key} message={item} isOwn={isOwn} />;
              })}
              <div ref={messagesEndRef} />
            </div>

            {/* Composer */}
            <div className="px-4 py-3 border-t border-gray-100 flex-shrink-0">
              <div className="flex items-end gap-2 bg-gray-50 rounded-2xl border border-gray-200 px-3 py-2 focus-within:border-[#8BC53D] focus-within:ring-2 focus-within:ring-[#8BC53D]/20 transition-all">
                <textarea
                  ref={textareaRef}
                  rows={1}
                  value={body}
                  onChange={(e) => { setBody(e.target.value); e.target.style.height = 'auto'; e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`; }}
                  onKeyDown={handleKeyDown}
                  placeholder={`Message ${activeGroup.name}… (Enter to send, Shift+Enter for new line)`}
                  className="flex-1 text-sm outline-none bg-transparent resize-none leading-5 text-[#05164D] placeholder-gray-400 py-1 max-h-[120px] overflow-y-auto"
                  style={{ minHeight: 28 }}
                />
                <button
                  onClick={handleSend}
                  disabled={!body.trim() || sending}
                  className="w-8 h-8 rounded-xl flex items-center justify-center bg-[#8BC53D] disabled:opacity-40 hover:bg-[#476E2C] transition-colors flex-shrink-0 mb-0.5"
                >
                  {sending ? <Loader2 size={14} className="text-white animate-spin" /> : <Send size={14} className="text-white" />}
                </button>
              </div>
              <p className="text-[10px] text-gray-300 mt-1.5 px-1">Enter to send · Shift+Enter for new line</p>
            </div>
          </>
        )}
      </div>

      {/* ── Right: members panel ── */}
      {showMembers && activeGroupId && (
        <MembersPanel groupId={activeGroupId} onClose={() => setShowMembers(false)} />
      )}
    </div>
  );
}
