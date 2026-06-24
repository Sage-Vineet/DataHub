import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  ClipboardList,
  Clock,
  Loader2,
  MessageSquareText,
  Save,
  Send,
} from "lucide-react";
import { useAuth } from "../../context/AuthContext";
import { getCimQuestionnaireRequest, saveCimQuestionnaireRequest } from "../../lib/api";
import { useToast } from "../../context/ToastContext";

const STATUS_META = {
  open: { label: "Needs Response", color: "#A86F0B", bg: "#FEF3C7", icon: Clock },
  answered: { label: "Answered", color: "#2563EB", bg: "#DBEAFE", icon: MessageSquareText },
  resolved: { label: "Resolved", color: "#166534", bg: "#DCFCE7", icon: CheckCircle2 },
};

const FILTERS = [
  ["active", "Active"],
  ["answered", "Answered"],
  ["resolved", "Resolved"],
  ["all", "All"],
];

function resolveCompanies(user) {
  const assigned = user?.assigned_companies?.length
    ? user.assigned_companies
    : user?.assignedCompanies?.length
      ? user.assignedCompanies
      : [];
  const fallbackId = user?.company_id || user?.companyId || user?.company_ids?.[0] || user?.companyIds?.[0];

  if (assigned.length) {
    return assigned.map((company) => ({
      id: company.id,
      name: company.name || company.company_name || "Company",
    })).filter((company) => company.id);
  }

  if (!fallbackId) return [];
  return [{
    id: fallbackId,
    name: user?.company || user?.company_name || "Company",
  }];
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeQuestionnaireState(state) {
  return {
    version: 1,
    items: state?.items && typeof state.items === "object" ? state.items : {},
    createdAt: state?.createdAt || new Date().toISOString(),
    sentAt: state?.sentAt || "",
    sentBy: state?.sentBy || null,
    clientSubmittedAt: state?.clientSubmittedAt || "",
    clientSubmittedBy: state?.clientSubmittedBy || null,
    updatedAt: state?.updatedAt || "",
    updatedBy: state?.updatedBy || null,
  };
}

function getQuestionnaireLocalStorageKey(companyId) {
  return `datahub:cim-questionnaire:${companyId || "default"}`;
}

function getItems(state, filter) {
  return Object.values(state?.items || {})
    .filter((item) => !item.archived)
    .filter((item) => {
      if (filter === "all") return true;
      if (filter === "answered") return item.status === "answered" || normalizeText(item.clientNote);
      if (filter === "resolved") return item.status === "resolved";
      return item.status !== "resolved";
    })
    .sort((a, b) => {
      if (a.slideNumber !== b.slideNumber) return Number(a.slideNumber || 0) - Number(b.slideNumber || 0);
      return String(a.label || "").localeCompare(String(b.label || ""));
    });
}

function getCounts(state) {
  const active = Object.values(state?.items || {}).filter((item) => !item.archived);
  return {
    total: active.length,
    answered: active.filter((item) => item.status === "answered" || normalizeText(item.clientNote)).length,
    resolved: active.filter((item) => item.status === "resolved").length,
  };
}

function StatusPill({ status }) {
  const meta = STATUS_META[status] || STATUS_META.open;
  const Icon = meta.icon;

  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold"
      style={{ backgroundColor: meta.bg, color: meta.color }}
    >
      <Icon size={13} />
      {meta.label}
    </span>
  );
}

export default function ClientCimQuestionnaire() {
  const { user } = useAuth();
  const { showToast } = useToast();
  const companies = useMemo(() => resolveCompanies(user), [user]);
  const [selectedCompanyId, setSelectedCompanyId] = useState(companies[0]?.id || "");
  const activeCompanyId = selectedCompanyId || companies[0]?.id || "";
  const [state, setState] = useState(() => normalizeQuestionnaireState());
  const [draftNotes, setDraftNotes] = useState({});
  const [filter, setFilter] = useState("active");
  const [loading, setLoading] = useState(false);
  const [savingId, setSavingId] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!activeCompanyId) return undefined;
    let cancelled = false;
    const localKey = getQuestionnaireLocalStorageKey(activeCompanyId);

    async function loadQuestionnaire() {
      setLoading(true);
      try {
        const payload = await getCimQuestionnaireRequest({ clientId: activeCompanyId });
        if (cancelled) return;
        const nextState = normalizeQuestionnaireState(payload?.state || {});
        setState(nextState);
        setDraftNotes(Object.fromEntries(
          Object.values(nextState.items).map((item) => [item.id, item.clientNote || ""]),
        ));
        window.localStorage.setItem(localKey, JSON.stringify(nextState));
      } catch {
        try {
          const local = window.localStorage.getItem(localKey);
          if (local && !cancelled) {
            const parsed = normalizeQuestionnaireState(JSON.parse(local));
            setState(parsed);
            setDraftNotes(Object.fromEntries(
              Object.values(parsed.items).map((item) => [item.id, item.clientNote || ""]),
            ));
          }
        } catch {
          // Ignore malformed local drafts.
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadQuestionnaire();
    return () => {
      cancelled = true;
    };
  }, [activeCompanyId]);

  const persistState = useCallback(async (nextState, itemId, options = {}) => {
    if (!activeCompanyId) return;
    const localKey = getQuestionnaireLocalStorageKey(activeCompanyId);
    setSavingId(itemId);
    window.localStorage.setItem(localKey, JSON.stringify(nextState));

    try {
      const payload = await saveCimQuestionnaireRequest(nextState, { clientId: activeCompanyId });
      const savedState = normalizeQuestionnaireState(payload?.state || nextState);
      setState(savedState);
      window.localStorage.setItem(localKey, JSON.stringify(savedState));
      showToast({
        type: "success",
        title: options.successTitle || "Response Saved",
        message: options.successMessage || "Your CIM questionnaire note was saved for the broker.",
      });
    } catch {
      showToast({
        type: "info",
        title: options.localTitle || "Response Saved Locally",
        message: "Backend save failed, so a local draft was kept in this browser.",
      });
    } finally {
      setSavingId("");
    }
  }, [activeCompanyId, showToast]);

  const handleSaveNote = useCallback((item) => {
    const note = draftNotes[item.id] || "";
    const now = new Date().toISOString();
    const nextItem = {
      ...item,
      clientNote: note,
      clientUpdatedAt: now,
      clientUpdatedBy: {
        id: user?.id || null,
        name: user?.name || user?.email || "Client",
        email: user?.email || "",
      },
      status: normalizeText(note) ? "answered" : "open",
      updatedAt: now,
    };
    const nextState = normalizeQuestionnaireState({
      ...state,
      items: {
        ...state.items,
        [item.id]: nextItem,
      },
      updatedAt: now,
    });

    setState(nextState);
    void persistState(nextState, item.id);
  }, [draftNotes, persistState, state, user]);

  const handleSubmitResponses = useCallback(async () => {
    const now = new Date().toISOString();
    const clientSummary = {
      id: user?.id || null,
      name: user?.name || user?.email || "Client",
      email: user?.email || "",
    };
    const nextItems = Object.fromEntries(
      Object.entries(state.items || {}).map(([itemId, item]) => {
        if (item.archived || item.status === "resolved") return [itemId, item];
        const note = draftNotes[itemId] ?? item.clientNote ?? "";
        return [itemId, {
          ...item,
          clientNote: note,
          clientUpdatedAt: now,
          clientUpdatedBy: clientSummary,
          status: normalizeText(note) ? "answered" : "open",
          updatedAt: now,
        }];
      }),
    );
    const nextState = normalizeQuestionnaireState({
      ...state,
      items: nextItems,
      clientSubmittedAt: now,
      clientSubmittedBy: clientSummary,
      updatedAt: now,
    });

    setSubmitting(true);
    setState(nextState);
    try {
      await persistState(nextState, "submit", {
        successTitle: "Responses Submitted",
        successMessage: "Your CIM questionnaire responses were submitted for the broker.",
        localTitle: "Responses Saved Locally",
      });
    } finally {
      setSubmitting(false);
    }
  }, [draftNotes, persistState, state, user]);

  const items = useMemo(() => getItems(state, filter), [filter, state]);
  const counts = getCounts(state);

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-white p-4 shadow-card md:flex-row md:items-center md:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <ClipboardList size={20} className="text-[#476E2C]" />
            <h1 className="text-2xl font-bold text-[#050505]">CIM Questionnaire</h1>
          </div>
          <p className="mt-1 text-sm text-[#6D6E71]">
            Add notes for CIM fields the broker needs help completing.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {state.clientSubmittedAt && (
            <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-white px-3 py-2 text-xs font-semibold text-[#6D6E71]">
              <CheckCircle2 size={14} className="text-[#8BC53D]" />
              Submitted {new Date(state.clientSubmittedAt).toLocaleString("en-IN")}
            </span>
          )}
          {companies.length > 1 && (
            <select
              value={activeCompanyId}
              onChange={(event) => setSelectedCompanyId(event.target.value)}
              className="h-10 rounded-md border border-border bg-white px-3 text-sm font-semibold text-[#050505] outline-none focus:border-[#8BC53D] focus:ring-2 focus:ring-[#8BC53D]/20"
            >
              {companies.map((company) => (
                <option key={company.id} value={company.id}>
                  {company.name}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            onClick={handleSubmitResponses}
            disabled={submitting || counts.total === 0}
            className="theme-btn-primary disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
            Submit Responses
          </button>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <div className="rounded-lg border border-border bg-white p-4 shadow-card">
          <p className="text-xs font-bold uppercase tracking-[0.08em] text-[#6D6E71]">Requested</p>
          <p className="mt-2 text-2xl font-bold text-[#050505]">{counts.total}</p>
        </div>
        <div className="rounded-lg border border-border bg-white p-4 shadow-card">
          <p className="text-xs font-bold uppercase tracking-[0.08em] text-[#6D6E71]">Answered</p>
          <p className="mt-2 text-2xl font-bold text-[#2563EB]">{counts.answered}</p>
        </div>
        <div className="rounded-lg border border-border bg-white p-4 shadow-card">
          <p className="text-xs font-bold uppercase tracking-[0.08em] text-[#6D6E71]">Resolved</p>
          <p className="mt-2 text-2xl font-bold text-[#166534]">{counts.resolved}</p>
        </div>
      </div>

      <div className="flex gap-2 overflow-x-auto">
        {FILTERS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setFilter(value)}
            className={`shrink-0 rounded-md border px-3 py-2 text-sm font-bold transition ${
              filter === value
                ? "border-[#8BC53D] bg-[#EEF6E0] text-[#476E2C]"
                : "border-border bg-white text-[#6D6E71] hover:border-[#8BC53D]/60"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex min-h-[320px] items-center justify-center rounded-lg border border-border bg-white text-sm font-semibold text-[#6D6E71] shadow-card">
          <Loader2 size={18} className="mr-2 animate-spin text-[#8BC53D]" />
          Loading questionnaire
        </div>
      ) : items.length > 0 ? (
        <div className="space-y-3">
          {items.map((item) => {
            const resolved = item.status === "resolved";
            return (
              <article key={item.id} className="rounded-lg border border-border bg-white p-4 shadow-card">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusPill status={item.status} />
                      <span className="text-xs font-semibold text-[#6D6E71]">
                        Slide {item.slideNumber} · {item.sectionTitle}
                      </span>
                    </div>
                    <h2 className="mt-2 text-sm font-bold text-[#050505]">{item.label}</h2>
                    <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-[#6D6E71]">
                      {item.prompt}
                    </p>
                  </div>
                </div>

                <label className="mt-4 block">
                  <span className="mb-1 block text-[11px] font-bold uppercase tracking-[0.06em] text-[#6D6E71]">
                    Your notes
                  </span>
                  <textarea
                    value={draftNotes[item.id] || ""}
                    disabled={resolved}
                    onChange={(event) =>
                      setDraftNotes((previous) => ({ ...previous, [item.id]: event.target.value }))
                    }
                    placeholder="Add context, figures, assumptions, or source notes for the broker..."
                    className="min-h-[126px] w-full resize-y rounded-md border border-border bg-white px-3 py-2 text-sm leading-relaxed text-[#050505] outline-none transition focus:border-[#8BC53D] focus:ring-2 focus:ring-[#8BC53D]/20 disabled:bg-[#F7F8FA] disabled:text-[#6D6E71]"
                    spellCheck={false}
                  />
                </label>

                <div className="mt-3 flex items-center justify-between gap-3">
                  <p className="text-xs text-[#A5A5A5]">
                    {item.clientUpdatedAt
                      ? `Last updated ${new Date(item.clientUpdatedAt).toLocaleString("en-IN")}`
                      : "Not answered yet"}
                  </p>
                  <button
                    type="button"
                    disabled={resolved || savingId === item.id}
                    onClick={() => handleSaveNote(item)}
                    className="theme-btn-primary disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {savingId === item.id ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
                    Save Note
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="flex min-h-[320px] items-center justify-center rounded-lg border border-dashed border-border bg-white text-center shadow-card">
          <div>
            <ClipboardList size={34} className="mx-auto mb-3 text-[#8BC53D]" />
            <h2 className="text-sm font-bold text-[#050505]">No CIM questions here</h2>
            <p className="mt-1 text-sm text-[#6D6E71]">
              New questions will appear here when the broker requests client input.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
