import { useEffect, useMemo, useRef, useState } from "react";
import {
  Building2,
  Loader2,
  MessageSquare,
  RefreshCw,
  Search,
  Send,
  Users,
} from "lucide-react";
import { useAuth } from "../../context/AuthContext";
import {
  createCompanyMessageRequest,
  getCompanyMessagesRequest,
  listMessageThreadsRequest,
} from "../../lib/api";

function initials(name = "") {
  return name
    .split(" ")
    .filter(Boolean)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function formatThreadTime(value) {
  if (!value) return "No messages yet";
  const date = new Date(value);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  return sameDay
    ? date.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
}

function roleLabel(role) {
  if (role === "broker") return "Broker";
  if (role === "client") return "Client";
  return "User";
}

function ParticipantPill({ participant }) {
  return (
    <div className="inline-flex items-center gap-2 rounded-full bg-[#F4F7FB] px-3 py-1.5 text-xs font-medium text-[#51607A]">
      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#DDE7F4] text-[10px] font-bold text-[#05164D]">
        {initials(participant.name)}
      </span>
      <span>{participant.name}</span>
      <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#8A94A6]">
        {roleLabel(participant.role)}
      </span>
    </div>
  );
}

function MessageBubble({ message, isOwn }) {
  return (
    <div className={`flex ${isOwn ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[82%] rounded-2xl px-4 py-3 shadow-sm ${
        isOwn
          ? "bg-[#8BC53D] text-white"
          : "border border-[#E5E7EF] bg-white text-[#05164D]"
      }`}>
        {!isOwn && (
          <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold">
            <span>{message.sender?.name || "Unknown"}</span>
            <span className={`${isOwn ? "text-white/70" : "text-[#94A3B8]"}`}>
              {roleLabel(message.sender?.role)}
            </span>
          </div>
        )}
        <p className="whitespace-pre-wrap break-words text-sm leading-6">{message.body}</p>
        <div className={`mt-2 text-[11px] ${isOwn ? "text-white/80" : "text-[#94A3B8]"}`}>
          {formatThreadTime(message.created_at)}
        </div>
      </div>
    </div>
  );
}

export default function MessagesWorkspace({
  fixedCompanyId = null,
  title = "Messages",
  description = "Company conversations",
}) {
  const { user } = useAuth();
  const [threads, setThreads] = useState([]);
  const [threadsLoading, setThreadsLoading] = useState(!fixedCompanyId);
  const [conversation, setConversation] = useState(null);
  const [conversationLoading, setConversationLoading] = useState(Boolean(fixedCompanyId));
  const [selectedCompanyId, setSelectedCompanyId] = useState(fixedCompanyId || "");
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const messagesRef = useRef(null);

  const filteredThreads = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return threads;
    return threads.filter((thread) => thread.company?.name?.toLowerCase().includes(query));
  }, [threads, search]);

  const selectedThread = useMemo(
    () => threads.find((thread) => String(thread.company?.id) === String(selectedCompanyId)) || null,
    [threads, selectedCompanyId],
  );

  const activeCompanyId = fixedCompanyId || selectedCompanyId;

  const loadThreads = async () => {
    if (fixedCompanyId) return;
    setThreadsLoading(true);
    try {
      const data = await listMessageThreadsRequest();
      setThreads(data || []);
      setSelectedCompanyId((current) => {
        if (current && (data || []).some((thread) => String(thread.company?.id) === String(current))) {
          return current;
        }
        return data?.[0]?.company?.id || "";
      });
      setError("");
    } catch (err) {
      setError(err.message || "Unable to load conversations.");
    } finally {
      setThreadsLoading(false);
    }
  };

  const loadConversation = async (companyId) => {
    if (!companyId) {
      setConversation(null);
      return;
    }
    setConversationLoading(true);
    try {
      const data = await getCompanyMessagesRequest(companyId);
      setConversation(data);
      setError("");
    } catch (err) {
      setError(err.message || "Unable to load messages.");
    } finally {
      setConversationLoading(false);
    }
  };

  useEffect(() => {
    if (fixedCompanyId) {
      setSelectedCompanyId(fixedCompanyId);
      loadConversation(fixedCompanyId);
      return;
    }
    loadThreads();
  }, [fixedCompanyId]);

  useEffect(() => {
    if (!fixedCompanyId && selectedCompanyId) {
      loadConversation(selectedCompanyId);
    }
  }, [fixedCompanyId, selectedCompanyId]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (!fixedCompanyId) {
        loadThreads();
      }
      if (activeCompanyId) {
        loadConversation(activeCompanyId);
      }
    }, 10000);

    return () => window.clearInterval(interval);
  }, [fixedCompanyId, activeCompanyId]);

  useEffect(() => {
    if (!messagesRef.current) return;
    messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
  }, [conversation?.messages?.length]);

  const handleSend = async () => {
    if (!activeCompanyId || !draft.trim()) return;
    setSending(true);
    try {
      const created = await createCompanyMessageRequest(activeCompanyId, { body: draft.trim() });
      setConversation((current) => ({
        ...(current || {}),
        company: current?.company || selectedThread?.company || { id: activeCompanyId },
        participants: current?.participants || [],
        messages: [...(current?.messages || []), created],
      }));
      setThreads((current) => {
        const next = [...current];
        const index = next.findIndex((thread) => String(thread.company?.id) === String(activeCompanyId));
        if (index >= 0) {
          const existing = next[index];
          next[index] = {
            ...existing,
            last_message: {
              id: created.id,
              body: created.body,
              created_at: created.created_at,
              sender_id: created.sender_id,
              sender_name: created.sender?.name,
            },
          };
          const [moved] = next.splice(index, 1);
          next.unshift(moved);
          return next;
        }
        return current;
      });
      setDraft("");
    } catch (err) {
      setError(err.message || "Unable to send message.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-[#05164D]">{title}</h1>
          <p className="mt-1 text-sm text-[#6D6E71]">{description}</p>
        </div>
        <button
          type="button"
          onClick={() => {
            if (!fixedCompanyId) loadThreads();
            if (activeCompanyId) loadConversation(activeCompanyId);
          }}
          className="inline-flex items-center gap-2 rounded-xl border border-[#E5E7EF] bg-white px-3.5 py-2.5 text-sm font-semibold text-[#51607A] transition-colors hover:bg-[#F8FAFC]"
        >
          <RefreshCw size={15} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
          {error}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[300px_minmax(0,1fr)]">
        {!fixedCompanyId && (
          <div className="overflow-hidden rounded-3xl border border-[#E5E7EF] bg-white shadow-sm">
            <div className="border-b border-[#EEF0F5] p-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-[#05164D]">
                <MessageSquare size={16} />
                Conversations
              </div>
              <div className="relative mt-3">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#A5A5A5]" />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search companies..."
                  className="w-full rounded-xl border border-[#E5E7EF] py-2.5 pl-9 pr-3 text-sm focus:border-[#8BC53D] focus:outline-none"
                />
              </div>
            </div>

            <div className="max-h-[70vh] overflow-y-auto">
              {threadsLoading ? (
                <div className="flex items-center justify-center px-4 py-10 text-sm text-[#6D6E71]">
                  <Loader2 size={18} className="mr-2 animate-spin" />
                  Loading conversations...
                </div>
              ) : filteredThreads.length === 0 ? (
                <div className="px-4 py-10 text-center text-sm text-[#6D6E71]">
                  No conversations available.
                </div>
              ) : filteredThreads.map((thread) => {
                const active = String(thread.company?.id) === String(selectedCompanyId);
                return (
                  <button
                    key={thread.company?.id}
                    type="button"
                    onClick={() => setSelectedCompanyId(thread.company?.id || "")}
                    className={`w-full border-b border-[#F4F6FA] px-4 py-4 text-left transition-colors ${
                      active ? "bg-[#EEF6E0]" : "hover:bg-[#F8FAFC]"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-[#05164D]">
                          {thread.company?.name}
                        </p>
                        <p className="mt-1 truncate text-xs text-[#8A94A6]">
                          {thread.last_message?.body || "No messages yet"}
                        </p>
                      </div>
                      <span className="shrink-0 text-[11px] text-[#A5A5A5]">
                        {formatThreadTime(thread.last_message?.created_at)}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="flex min-h-[70vh] flex-col overflow-hidden rounded-3xl border border-[#E5E7EF] bg-white shadow-sm">
          {!activeCompanyId ? (
            <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
              <MessageSquare size={36} className="text-[#CBD5E1]" />
              <p className="mt-4 text-base font-semibold text-[#05164D]">Select a company conversation</p>
              <p className="mt-1 text-sm text-[#6D6E71]">Choose a thread from the left to start messaging.</p>
            </div>
          ) : conversationLoading ? (
            <div className="flex flex-1 items-center justify-center text-sm text-[#6D6E71]">
              <Loader2 size={18} className="mr-2 animate-spin" />
              Loading messages...
            </div>
          ) : (
            <>
              <div className="border-b border-[#EEF0F5] px-6 py-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2 text-lg font-bold text-[#05164D]">
                      <Building2 size={18} />
                      {conversation?.company?.name || selectedThread?.company?.name || "Conversation"}
                    </div>
                    <p className="mt-1 text-sm text-[#6D6E71]">
                      {conversation?.company?.industry || selectedThread?.company?.industry || "Company workspace conversation"}
                    </p>
                  </div>
                  <div className="inline-flex items-center gap-2 rounded-full bg-[#F8FAFC] px-3 py-1.5 text-xs font-semibold text-[#51607A]">
                    <Users size={14} />
                    {conversation?.participants?.length || 0} participants
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  {(conversation?.participants || []).map((participant) => (
                    <ParticipantPill key={participant.id} participant={participant} />
                  ))}
                </div>
              </div>

              <div ref={messagesRef} className="flex-1 space-y-4 overflow-y-auto bg-[#F8FAFC] px-4 py-5 sm:px-6">
                {conversation?.messages?.length ? (
                  conversation.messages.map((message) => (
                    <MessageBubble
                      key={message.id}
                      message={message}
                      isOwn={String(message.sender_id) === String(user?.id)}
                    />
                  ))
                ) : (
                  <div className="flex h-full min-h-[240px] flex-col items-center justify-center text-center">
                    <MessageSquare size={36} className="text-[#CBD5E1]" />
                    <p className="mt-4 text-base font-semibold text-[#05164D]">No messages yet</p>
                    <p className="mt-1 text-sm text-[#6D6E71]">Start the company conversation by sending the first message.</p>
                  </div>
                )}
              </div>

              <div className="border-t border-[#EEF0F5] bg-white px-4 py-4 sm:px-6">
                <div className="flex items-end gap-3">
                  <textarea
                    rows={3}
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        handleSend();
                      }
                    }}
                    placeholder="Write a message to the company conversation..."
                    className="min-h-[92px] flex-1 rounded-2xl border border-[#E5E7EF] px-4 py-3 text-sm text-[#05164D] focus:border-[#8BC53D] focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={handleSend}
                    disabled={sending || !draft.trim()}
                    className="inline-flex items-center gap-2 rounded-2xl bg-[#8BC53D] px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-[#476E2C] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                    Send
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
