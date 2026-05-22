import { useEffect, useMemo, useRef, useState } from "react";
import {
  Loader2,
  MessageSquare,
  RefreshCw,
  Search,
  Send,
  Users,
} from "lucide-react";
import { useAuth } from "../../context/AuthContext";
import {
  createDirectMessageRequest,
  getDirectMessagesRequest,
  listDirectMessageThreadsRequest,
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

export default function DirectMessagesWorkspace({
  title = "Direct Messages",
  description = "Personal one-to-one conversations",
  availableUsers = [],
}) {
  const { user } = useAuth();
  const [threads, setThreads] = useState([]);
  const [threadsLoading, setThreadsLoading] = useState(true);
  const [conversation, setConversation] = useState(null);
  const [conversationLoading, setConversationLoading] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const messagesRef = useRef(null);

  const displayUsers = useMemo(() => {
    if (availableUsers.length > 0) {
      return availableUsers.filter((u) => String(u.id) !== String(user?.id));
    }
    return threads.map((thread) => thread.participant).filter(Boolean);
  }, [availableUsers, threads, user?.id]);

  const filteredUsers = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return displayUsers;
    return displayUsers.filter(
      (u) =>
        u.name?.toLowerCase().includes(query) ||
        u.email?.toLowerCase().includes(query)
    );
  }, [displayUsers, search]);

  const selectedThread = useMemo(
    () =>
      threads.find(
        (thread) => String(thread.participant?.id) === String(selectedUserId)
      ) || null,
    [threads, selectedUserId]
  );

  const loadThreads = async () => {
    setThreadsLoading(true);
    try {
      const data = await listDirectMessageThreadsRequest();
      setThreads(data || []);
      if (availableUsers.length === 0) {
        setSelectedUserId((current) => {
          if (current && (data || []).some((thread) => String(thread.participant?.id) === String(current))) {
            return current;
          }
          return data?.[0]?.participant?.id || "";
        });
      }
      setError("");
    } catch (err) {
      setError(err.message || "Unable to load conversations.");
    } finally {
      setThreadsLoading(false);
    }
  };

  const loadConversation = async (recipientId) => {
    if (!recipientId) {
      setConversation(null);
      return;
    }
    setConversationLoading(true);
    try {
      const data = await getDirectMessagesRequest(recipientId);
      setConversation(data);
      setError("");
    } catch (err) {
      setError(err.message || "Unable to load messages.");
    } finally {
      setConversationLoading(false);
    }
  };

  useEffect(() => {
    loadThreads();
  }, []);

  useEffect(() => {
    if (selectedUserId) {
      loadConversation(selectedUserId);
    }
  }, [selectedUserId]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      loadThreads();
      if (selectedUserId) {
        loadConversation(selectedUserId);
      }
    }, 10000);

    return () => window.clearInterval(interval);
  }, [selectedUserId]);

  useEffect(() => {
    if (!messagesRef.current) return;
    messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
  }, [conversation?.messages?.length]);

  const handleSend = async () => {
    if (!selectedUserId || !draft.trim()) return;
    setSending(true);
    try {
      const created = await createDirectMessageRequest(selectedUserId, { body: draft.trim() });
      setConversation((current) => ({
        ...(current || {}),
        participant2: current?.participant2 || selectedThread?.participant || { id: selectedUserId },
        messages: [...(current?.messages || []), created],
      }));
      setThreads((current) => {
        const next = [...current];
        const index = next.findIndex(
          (thread) => String(thread.participant?.id) === String(selectedUserId)
        );
        if (index >= 0) {
          const existing = next[index];
          next[index] = {
            ...existing,
            last_message: {
              id: created.id,
              body: created.body,
              created_at: created.created_at,
              sender_id: created.sender_id,
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

  const getOtherParticipant = () => {
    if (conversation?.participant2 && String(conversation.participant2.id) === String(selectedUserId)) {
      return conversation.participant2;
    }
    if (conversation?.participant1 && String(conversation.participant1.id) === String(selectedUserId)) {
      return conversation.participant1;
    }
    return selectedThread?.participant || displayUsers.find((u) => String(u.id) === String(selectedUserId));
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
            loadThreads();
            if (selectedUserId) loadConversation(selectedUserId);
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
        <div className="overflow-hidden rounded-3xl border border-[#E5E7EF] bg-white shadow-sm">
          <div className="border-b border-[#EEF0F5] p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-[#05164D]">
              <MessageSquare size={16} />
              People
            </div>
            <div className="relative mt-3">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#A5A5A5]" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search people..."
                className="w-full rounded-xl border border-[#E5E7EF] py-2.5 pl-9 pr-3 text-sm focus:border-[#8BC53D] focus:outline-none"
              />
            </div>
          </div>

          <div className="max-h-[70vh] overflow-y-auto">
            {threadsLoading && availableUsers.length === 0 ? (
              <div className="flex items-center justify-center px-4 py-10 text-sm text-[#6D6E71]">
                <Loader2 size={18} className="mr-2 animate-spin" />
                Loading people...
              </div>
            ) : filteredUsers.length === 0 ? (
              <div className="px-4 py-10 text-center text-sm text-[#6D6E71]">
                No people available for direct messaging.
              </div>
            ) : filteredUsers.map((participant) => {
              const active = String(participant.id) === String(selectedUserId);
              const threadForUser = threads.find(
                (thread) => String(thread.participant?.id) === String(participant.id)
              );
              return (
                <button
                  key={participant.id}
                  type="button"
                  onClick={() => setSelectedUserId(participant.id || "")}
                  className={`w-full border-b border-[#F4F6FA] px-4 py-4 text-left transition-colors ${
                    active ? "bg-[#EEF6E0]" : "hover:bg-[#F8FAFC]"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-[#05164D]">
                        {participant.name}
                      </p>
                      <p className="mt-0.5 truncate text-xs text-[#8A94A6]">
                        {participant.role === "broker"
                          ? "Broker"
                          : participant.role === "client"
                          ? "Client"
                          : "User"}
                      </p>
                      {threadForUser?.last_message && (
                        <p className="mt-1 truncate text-xs text-[#6D6E71]">
                          {threadForUser.last_message.body}
                        </p>
                      )}
                    </div>
                    {threadForUser?.last_message && (
                      <span className="shrink-0 text-[11px] text-[#A5A5A5]">
                        {formatThreadTime(threadForUser.last_message.created_at)}
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex min-h-[70vh] flex-col overflow-hidden rounded-3xl border border-[#E5E7EF] bg-white shadow-sm">
          {!selectedUserId ? (
            <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
              <MessageSquare size={36} className="text-[#CBD5E1]" />
              <p className="mt-4 text-base font-semibold text-[#05164D]">
                Select a person to message
              </p>
              <p className="mt-1 text-sm text-[#6D6E71]">
                Choose from the list to start a direct conversation.
              </p>
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
                      <Users size={18} />
                      {getOtherParticipant()?.name || "Direct Message"}
                    </div>
                    <p className="mt-1 text-sm text-[#6D6E71]">
                      {getOtherParticipant()?.email || "Personal conversation"}
                    </p>
                  </div>
                </div>
                <div className="mt-4">
                  {getOtherParticipant() && (
                    <ParticipantPill participant={getOtherParticipant()} />
                  )}
                </div>
              </div>

              <div
                ref={messagesRef}
                className="flex-1 space-y-4 overflow-y-auto bg-[#F8FAFC] px-4 py-5 sm:px-6"
              >
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
                    <p className="mt-4 text-base font-semibold text-[#05164D]">
                      No messages yet
                    </p>
                    <p className="mt-1 text-sm text-[#6D6E71]">
                      Start the conversation by sending the first message.
                    </p>
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
                    placeholder={`Write a message to ${getOtherParticipant()?.name || "this person"}...`}
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
