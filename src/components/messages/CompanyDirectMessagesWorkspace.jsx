import { useEffect, useMemo, useRef, useState } from "react";
import {
  Building2,
  Loader2,
  MessageSquare,
  RefreshCw,
  Search,
  Send,
  UserRound,
} from "lucide-react";
import { useAuth } from "../../context/AuthContext";
import { useMessageNotifications } from "../../context/MessageNotificationsContext";
import {
  createCompanyDirectMessageRequest,
  getCompanyDirectMessagesRequest,
  listCompanyDirectMessageContactsRequest,
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

export default function CompanyDirectMessagesWorkspace({
  title = "Messages",
  description = "Direct company conversations",
  fixedCompanyId = null,
  companyOptions = [],
  companyPlaceholder = "Select a company",
  companyEmptyState = "No companies available.",
  contactLabel = "People",
  contactEmptyState = "No one is available for messaging in this company.",
  singleListMode = false,
  singleListEmptyState = "No conversations available.",
}) {
  const { user } = useAuth();
  const { markConversationRead } = useMessageNotifications();
  const [selectedCompanyId, setSelectedCompanyId] = useState(fixedCompanyId || companyOptions[0]?.id || "");
  const [companySearch, setCompanySearch] = useState("");
  const [contactSearch, setContactSearch] = useState("");
  const [contacts, setContacts] = useState([]);
  const [contactsByCompany, setContactsByCompany] = useState({});
  const [contactsLoading, setContactsLoading] = useState(Boolean(fixedCompanyId || companyOptions.length));
  const [selectedRecipientId, setSelectedRecipientId] = useState("");
  const [conversation, setConversation] = useState(null);
  const [conversationLoading, setConversationLoading] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const messagesRef = useRef(null);
  const composerFocusedRef = useRef(false);

  const activeCompanyId = fixedCompanyId || selectedCompanyId;
  const showCompanySidebar = !fixedCompanyId && !singleListMode;
  const companyOptionsKey = useMemo(
    () => companyOptions.map((company) => company.id).filter(Boolean).join("|"),
    [companyOptions],
  );

  const filteredCompanies = useMemo(() => {
    const query = companySearch.trim().toLowerCase();
    if (!query) return companyOptions;
    return companyOptions.filter((company) =>
      company.name?.toLowerCase().includes(query) ||
      company.industry?.toLowerCase().includes(query),
    );
  }, [companyOptions, companySearch]);

  const filteredContacts = useMemo(() => {
    const query = contactSearch.trim().toLowerCase();
    if (!query) return contacts;
    return contacts.filter((contact) =>
      contact.name?.toLowerCase().includes(query) ||
      contact.email?.toLowerCase().includes(query),
    );
  }, [contacts, contactSearch]);

  const singleListEntries = useMemo(() => {
    if (!singleListMode) return [];

    const query = contactSearch.trim().toLowerCase();
    return companyOptions
      .map((company) => {
        const companyContacts = contactsByCompany[company.id] || [];
        const primaryContact = companyContacts[0] || null;
        return {
          company,
          contact: primaryContact,
        };
      })
      .filter((entry) => {
        if (!query) return true;
        return (
          entry.contact?.name?.toLowerCase().includes(query) ||
          entry.contact?.email?.toLowerCase().includes(query) ||
          entry.company?.name?.toLowerCase().includes(query)
        );
      });
  }, [companyOptions, contactSearch, contactsByCompany, singleListMode]);

  const activeContact = useMemo(
    () => contacts.find((contact) => String(contact.id) === String(selectedRecipientId)) || null,
    [contacts, selectedRecipientId],
  );

  const fetchContacts = async (companyId) => {
    const data = await listCompanyDirectMessageContactsRequest(companyId);
    return data?.contacts || [];
  };

  const loadContacts = async (companyId, options = {}) => {
    const { showLoader = true } = options;
    if (!companyId) {
      setContacts([]);
      setSelectedRecipientId("");
      setConversation(null);
      setContactsLoading(false);
      return;
    }

    if (showLoader) {
      setContactsLoading(true);
    }
    try {
      const nextContacts = await fetchContacts(companyId);
      setContacts(nextContacts);
      setContactsByCompany((current) => ({
        ...current,
        [companyId]: nextContacts,
      }));
      setSelectedRecipientId((current) => {
        if (current && nextContacts.some((contact) => String(contact.id) === String(current))) {
          return current;
        }
        return nextContacts[0]?.id || "";
      });
      setError("");
    } catch (err) {
      setContacts([]);
      setSelectedRecipientId("");
      setConversation(null);
      setError(err.message || "Unable to load message contacts.");
    } finally {
      if (showLoader) {
        setContactsLoading(false);
      }
    }
  };

  const loadSingleListContacts = async (options = {}) => {
    const { showLoader = true } = options;
    if (!companyOptions.length) {
      setContactsByCompany({});
      setContacts([]);
      setSelectedCompanyId("");
      setSelectedRecipientId("");
      setConversation(null);
      setContactsLoading(false);
      return;
    }

    if (showLoader) {
      setContactsLoading(true);
    }
    try {
      const entries = await Promise.all(
        companyOptions.map(async (company) => {
          const nextContacts = await fetchContacts(company.id);
          return [company.id, nextContacts];
        }),
      );

      const nextContactsByCompany = Object.fromEntries(entries);
      setContactsByCompany(nextContactsByCompany);

      const currentCompanyStillValid = selectedCompanyId &&
        companyOptions.some((company) => String(company.id) === String(selectedCompanyId)) &&
        (nextContactsByCompany[selectedCompanyId] || []).length > 0;

      const fallbackCompany = companyOptions.find(
        (company) => (nextContactsByCompany[company.id] || []).length > 0,
      )?.id || companyOptions[0]?.id || "";

      const nextCompanyId = currentCompanyStillValid ? selectedCompanyId : fallbackCompany;
      const nextContacts = nextContactsByCompany[nextCompanyId] || [];

      setSelectedCompanyId(nextCompanyId);
      setContacts(nextContacts);
      setSelectedRecipientId((current) => {
        if (current && nextContacts.some((contact) => String(contact.id) === String(current))) {
          return current;
        }
        return nextContacts[0]?.id || "";
      });
      setError("");
    } catch (err) {
      setContactsByCompany({});
      setContacts([]);
      setSelectedRecipientId("");
      setConversation(null);
      setError(err.message || "Unable to load message contacts.");
    } finally {
      if (showLoader) {
        setContactsLoading(false);
      }
    }
  };

  const loadConversation = async (companyId, recipientId) => {
    if (!companyId || !recipientId) {
      setConversation(null);
      return;
    }

    setConversationLoading(true);
    try {
      const data = await getCompanyDirectMessagesRequest(companyId, recipientId);
      setConversation(data);
      setError("");
    } catch (err) {
      setConversation(null);
      setError(err.message || "Unable to load messages.");
    } finally {
      setConversationLoading(false);
    }
  };

  useEffect(() => {
    if (fixedCompanyId) {
      setSelectedCompanyId(fixedCompanyId);
      return;
    }

    setSelectedCompanyId((current) => {
      if (current && companyOptions.some((company) => String(company.id) === String(current))) {
        return current;
      }
      return companyOptions[0]?.id || "";
    });
  }, [fixedCompanyId, companyOptions]);

  useEffect(() => {
    if (singleListMode) {
      loadSingleListContacts();
      return;
    }

    loadContacts(activeCompanyId);
  }, [activeCompanyId, companyOptionsKey, singleListMode]);

  useEffect(() => {
    loadConversation(activeCompanyId, selectedRecipientId);
  }, [activeCompanyId, selectedRecipientId]);

  useEffect(() => {
    const latestMessage = conversation?.messages?.[conversation.messages.length - 1];
    if (!activeCompanyId || !selectedRecipientId || !latestMessage?.created_at) return;
    markConversationRead(activeCompanyId, selectedRecipientId, latestMessage.created_at);
  }, [activeCompanyId, selectedRecipientId, conversation, markConversationRead]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (composerFocusedRef.current) {
        return;
      }

      if (singleListMode) {
        loadSingleListContacts({ showLoader: false });
        if (selectedCompanyId && selectedRecipientId) {
          loadConversation(selectedCompanyId, selectedRecipientId);
        }
        return;
      }

      if (!activeCompanyId) return;
      loadContacts(activeCompanyId, { showLoader: false });
      if (selectedRecipientId) {
        loadConversation(activeCompanyId, selectedRecipientId);
      }
    }, 10000);

    return () => window.clearInterval(interval);
  }, [activeCompanyId, companyOptionsKey, selectedCompanyId, selectedRecipientId, singleListMode]);

  useEffect(() => {
    if (!messagesRef.current) return;
    messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
  }, [conversation?.messages?.length]);

  const handleSend = async () => {
    if (!activeCompanyId || !selectedRecipientId || !draft.trim()) return;

    setSending(true);
    try {
      const created = await createCompanyDirectMessageRequest(activeCompanyId, selectedRecipientId, {
        body: draft.trim(),
      });
      setConversation((current) => ({
        ...(current || {}),
        company: current?.company,
        participant: current?.participant || activeContact || created.participant,
        messages: [...(current?.messages || []), created],
      }));
      setContacts((current) => {
        const next = [...current];
        const index = next.findIndex((contact) => String(contact.id) === String(selectedRecipientId));
        if (index === -1) return current;
        next[index] = {
          ...next[index],
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
      });
      setDraft("");
      setError("");
      markConversationRead(activeCompanyId, selectedRecipientId, created.created_at || new Date().toISOString());
    } catch (err) {
      setError(err.message || "Unable to send message.");
    } finally {
      setSending(false);
    }
  };

  const gridClassName = showCompanySidebar
    ? "grid gap-6 xl:grid-cols-[260px_320px_minmax(0,1fr)]"
    : "grid gap-6 lg:grid-cols-[320px_minmax(0,1fr)]";

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
            if (singleListMode) {
              loadSingleListContacts();
            } else if (activeCompanyId) {
              loadContacts(activeCompanyId);
            }
            if ((singleListMode ? selectedCompanyId : activeCompanyId) && selectedRecipientId) {
              loadConversation(singleListMode ? selectedCompanyId : activeCompanyId, selectedRecipientId);
            }
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

      <div className={gridClassName}>
        {showCompanySidebar && (
          <div className="overflow-hidden rounded-3xl border border-[#E5E7EF] bg-white shadow-sm">
            <div className="border-b border-[#EEF0F5] p-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-[#05164D]">
                <Building2 size={16} />
                Companies
              </div>
              <div className="relative mt-3">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#A5A5A5]" />
                <input
                  value={companySearch}
                  onChange={(event) => setCompanySearch(event.target.value)}
                  placeholder="Search companies..."
                  className="w-full rounded-xl border border-[#E5E7EF] py-2.5 pl-9 pr-3 text-sm focus:border-[#8BC53D] focus:outline-none"
                />
              </div>
            </div>

            <div className="max-h-[70vh] overflow-y-auto">
              {filteredCompanies.length === 0 ? (
                <div className="px-4 py-10 text-center text-sm text-[#6D6E71]">
                  {companyOptions.length ? companyPlaceholder : companyEmptyState}
                </div>
              ) : filteredCompanies.map((company) => {
                const active = String(company.id) === String(selectedCompanyId);
                return (
                  <button
                    key={company.id}
                    type="button"
                    onClick={() => setSelectedCompanyId(company.id || "")}
                    className={`w-full border-b border-[#F4F6FA] px-4 py-4 text-left transition-colors ${
                      active ? "bg-[#EEF6E0]" : "hover:bg-[#F8FAFC]"
                    }`}
                  >
                    <p className="truncate text-sm font-semibold text-[#05164D]">{company.name}</p>
                    <p className="mt-1 truncate text-xs text-[#8A94A6]">
                      {company.industry || "Assigned company"}
                    </p>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="overflow-hidden rounded-3xl border border-[#E5E7EF] bg-white shadow-sm">
          <div className="border-b border-[#EEF0F5] p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-[#05164D]">
              <MessageSquare size={16} />
              {contactLabel}
            </div>
            <div className="relative mt-3">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#A5A5A5]" />
              <input
                value={contactSearch}
                onChange={(event) => setContactSearch(event.target.value)}
                placeholder={singleListMode ? "Search brokers or companies..." : "Search people..."}
                className="w-full rounded-xl border border-[#E5E7EF] py-2.5 pl-9 pr-3 text-sm focus:border-[#8BC53D] focus:outline-none"
              />
            </div>
          </div>

          <div className="max-h-[70vh] overflow-y-auto">
            {contactsLoading ? (
              <div className="flex items-center justify-center px-4 py-10 text-sm text-[#6D6E71]">
                <Loader2 size={18} className="mr-2 animate-spin" />
                Loading contacts...
              </div>
            ) : singleListMode ? (
              singleListEntries.length === 0 ? (
                <div className="px-4 py-10 text-center text-sm text-[#6D6E71]">
                  {companyOptions.length ? singleListEmptyState : companyEmptyState}
                </div>
              ) : singleListEntries.map((entry) => {
                const active = String(entry.company?.id) === String(selectedCompanyId);
                return (
                  <button
                    key={entry.company?.id}
                    type="button"
                    onClick={() => {
                      const nextCompanyId = entry.company?.id || "";
                      const nextContacts = contactsByCompany[nextCompanyId] || [];
                      setSelectedCompanyId(nextCompanyId);
                      setContacts(nextContacts);
                      setSelectedRecipientId(nextContacts[0]?.id || "");
                    }}
                    className={`w-full border-b border-[#F4F6FA] px-4 py-4 text-left transition-colors ${
                      active ? "bg-[#EEF6E0]" : "hover:bg-[#F8FAFC]"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-[#05164D]">
                          {entry.contact?.name || "Broker unavailable"}
                        </p>
                        <p className="mt-0.5 truncate text-xs text-[#8A94A6]">
                          {entry.company?.name || "Assigned company"}
                        </p>
                        {entry.contact?.last_message && (
                          <p className="mt-1 truncate text-xs text-[#6D6E71]">
                            {entry.contact.last_message.body}
                          </p>
                        )}
                      </div>
                      {entry.contact?.last_message && (
                        <span className="shrink-0 text-[11px] text-[#A5A5A5]">
                          {formatThreadTime(entry.contact.last_message.created_at)}
                        </span>
                      )}
                    </div>
                  </button>
                );
              })
            ) : !activeCompanyId ? (
              <div className="px-4 py-10 text-center text-sm text-[#6D6E71]">
                {companyPlaceholder}
              </div>
            ) : filteredContacts.length === 0 ? (
              <div className="px-4 py-10 text-center text-sm text-[#6D6E71]">
                {contacts.length ? "No matching people found." : contactEmptyState}
              </div>
            ) : filteredContacts.map((contact) => {
              const active = String(contact.id) === String(selectedRecipientId);
              return (
                <button
                  key={contact.id}
                  type="button"
                  onClick={() => setSelectedRecipientId(contact.id || "")}
                  className={`w-full border-b border-[#F4F6FA] px-4 py-4 text-left transition-colors ${
                    active ? "bg-[#EEF6E0]" : "hover:bg-[#F8FAFC]"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-[#05164D]">
                        {contact.name}
                      </p>
                      <p className="mt-0.5 truncate text-xs text-[#8A94A6]">
                        {roleLabel(contact.role)}
                      </p>
                      {contact.last_message && (
                        <p className="mt-1 truncate text-xs text-[#6D6E71]">
                          {contact.last_message.body}
                        </p>
                      )}
                    </div>
                    {contact.last_message && (
                      <span className="shrink-0 text-[11px] text-[#A5A5A5]">
                        {formatThreadTime(contact.last_message.created_at)}
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex min-h-[70vh] flex-col overflow-hidden rounded-3xl border border-[#E5E7EF] bg-white shadow-sm">
          {!activeCompanyId ? (
            <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
              <Building2 size={36} className="text-[#CBD5E1]" />
              <p className="mt-4 text-base font-semibold text-[#05164D]">
                {singleListMode ? "Select a conversation" : "Select a company"}
              </p>
              <p className="mt-1 text-sm text-[#6D6E71]">
                {singleListMode
                  ? "Choose a broker conversation to open messages."
                  : "Choose a company to open direct messages."}
              </p>
            </div>
          ) : !selectedRecipientId ? (
            <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
              <UserRound size={36} className="text-[#CBD5E1]" />
              <p className="mt-4 text-base font-semibold text-[#05164D]">Select a person to message</p>
              <p className="mt-1 text-sm text-[#6D6E71]">Choose a contact to start a one-to-one conversation.</p>
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
                      <UserRound size={18} />
                      {conversation?.participant?.name || activeContact?.name || "Direct Message"}
                    </div>
                    <p className="mt-1 text-sm text-[#6D6E71]">
                      {conversation?.participant?.email || activeContact?.email || "Personal conversation"}
                    </p>
                  </div>
                  <div className="inline-flex items-center gap-2 rounded-full bg-[#F8FAFC] px-3 py-1.5 text-xs font-semibold text-[#51607A]">
                    <Building2 size={14} />
                    {conversation?.company?.name ||
                      companyOptions.find((company) => String(company.id) === String(activeCompanyId))?.name ||
                      "Selected company"}
                  </div>
                </div>
                <div className="mt-4">
                  {(conversation?.participant || activeContact) && (
                    <ParticipantPill participant={conversation?.participant || activeContact} />
                  )}
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
                    <p className="mt-1 text-sm text-[#6D6E71]">Start the conversation by sending the first message.</p>
                  </div>
                )}
              </div>

              <div className="border-t border-[#EEF0F5] bg-white px-4 py-4 sm:px-6">
                <div className="flex items-end gap-3">
                  <textarea
                    rows={3}
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onFocus={() => {
                      composerFocusedRef.current = true;
                    }}
                    onBlur={() => {
                      composerFocusedRef.current = false;
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        handleSend();
                      }
                    }}
                    placeholder={`Write a message to ${conversation?.participant?.name || activeContact?.name || "this person"}...`}
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
