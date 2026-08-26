import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Activity,
  AlertCircle,
  ArrowRight,
  Bell,
  Building2,
  CheckCircle,
  CheckCircle2,
  ClipboardList,
  Clock,
  FileText,
  FileUp,
  Filter,
  FolderOpen,
  FolderPlus,
  KeyRound,
  MessageSquare,
  RefreshCw,
  Search,
  Send,
  Upload,
  UserPlus,
  Users,
} from 'lucide-react';
import { getCompanyRequest, listCompanyActivity, listCompanyReminders, listCompanyRequests } from '../../../lib/api';
import { formatCalendarDate, isPastDue } from '../../../lib/calendarDate';
import StatusBadge from '../../../components/common/StatusBadge';

// ─── Activity meta (mirrors WorkspaceActivity) ────────────────────────────────

const EVENT_META = {
  request_created:           { label: 'Request',          icon: Send,        bg: '#FEF3C7', color: '#F68C1F' },
  request_approved:          { label: 'Approved',         icon: CheckCircle2,bg: '#DCFCE7', color: '#476E2C' },
  request_updated:           { label: 'Updated',          icon: Send,        bg: '#E0F2FE', color: '#0369A1' },
  request_document_linked:   { label: 'Doc Linked',       icon: FileText,    bg: '#ECFDF5', color: '#047857' },
  request_narrative_updated: { label: 'Narrative',        icon: FileText,    bg: '#F0F9FF', color: '#0284C7' },
  user_added:                { label: 'User',             icon: UserPlus,    bg: '#DBEAFE', color: '#2563EB' },
  user_assigned:             { label: 'Assigned',         icon: UserPlus,    bg: '#E0E7FF', color: '#4F46E5' },
  group_created:             { label: 'Group',            icon: Users,       bg: '#F3E8FF', color: '#742982' },
  group_member_added:        { label: 'Group Member',     icon: Users,       bg: '#EDE9FE', color: '#6D28D9' },
  folder_access_granted:     { label: 'Folder Access',    icon: KeyRound,    bg: '#FEF9C3', color: '#A16207' },
  document_uploaded:         { label: 'Upload',           icon: Upload,      bg: '#DBEAFE', color: '#00648F' },
  document_status_changed:   { label: 'Doc Status',       icon: CheckCircle, bg: '#DCFCE7', color: '#15803D' },
  folder_created:            { label: 'Folder',           icon: FolderPlus,  bg: '#ECFCCB', color: '#4D7C0F' },
  reminder_created:          { label: 'Reminder',         icon: Bell,        bg: '#FCE7F3', color: '#BE185D' },
  reminder_sent:             { label: 'Reminder Sent',    icon: Bell,        bg: '#FCE7F3', color: '#BE185D' },
  message_sent:              { label: 'Message',          icon: MessageSquare,bg: '#F3E8FF', color: '#7E22CE' },
  direct_message_sent:       { label: 'Direct Message',   icon: MessageSquare,bg: '#EDE9FE', color: '#6D28D9' },
  upload:                    { label: 'Upload',           icon: FileUp,      bg: '#DBEAFE', color: '#00648F' },
  request:                   { label: 'Request',          icon: Send,        bg: '#FEF3C7', color: '#F68C1F' },
  approved:                  { label: 'Approved',         icon: CheckCircle2,bg: '#DCFCE7', color: '#476E2C' },
  reminder:                  { label: 'Reminder',         icon: Bell,        bg: '#F3E8FF', color: '#742982' },
  activity:                  { label: 'Activity',         icon: Clock,       bg: '#F3F4F6', color: '#6D6E71' },
};

function formatTimestamp(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit',
  }).format(date);
}

// ─── Activity panel (right column) ───────────────────────────────────────────

function ActivityPanel({ timeline, loading }) {
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');

  const filterOptions = useMemo(() => [
    'all',
    ...Array.from(new Set(timeline.map((i) => i.type).filter(Boolean))),
  ], [timeline]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return timeline.filter((item) => {
      if (typeFilter !== 'all' && item.type !== typeFilter) return false;
      if (!q) return true;
      return [item.title, item.message, item.detail, item.actor_name, item.type]
        .filter(Boolean).join(' ').toLowerCase().includes(q);
    });
  }, [timeline, search, typeFilter]);

  return (
    <div className="flex flex-col rounded-2xl bg-white shadow-card overflow-hidden h-full" style={{ minHeight: 0 }}>
      {/* header */}
      <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3.5 flex-shrink-0">
        <div className="flex items-center gap-2">
          <Activity size={15} className="text-[#476E2C]" />
          <h2 className="font-semibold text-[#050505] text-sm">Activity Log</h2>
        </div>
        <span className="text-[11px] text-[#A5A5A5]">{filtered.length} events</span>
      </div>

      {/* search + filter */}
      <div className="flex flex-col gap-2 border-b border-gray-100 px-3 py-2.5 flex-shrink-0">
        <div className="relative">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[#A5A5A5]" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search activity..."
            className="w-full rounded-lg border border-[#E5E7EF] bg-white py-2 pl-7 pr-2.5 text-xs text-[#050505] outline-none focus:border-[#8BC53D]"
          />
        </div>
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="w-full rounded-lg border border-[#E5E7EF] bg-white px-2.5 py-2 text-xs text-[#050505] outline-none focus:border-[#8BC53D]"
        >
          {filterOptions.map((opt) => (
            <option key={opt} value={opt}>
              {opt === 'all' ? 'All types' : (EVENT_META[opt]?.label || opt).replace(/_/g, ' ')}
            </option>
          ))}
        </select>
      </div>

      {/* list */}
      <div className="flex-1 overflow-y-auto divide-y divide-gray-50">
        {loading ? (
          <div className="py-12 text-center">
            <Clock size={28} className="mx-auto mb-2 text-gray-200" />
            <p className="text-xs text-[#A5A5A5]">Loading activity…</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-12 text-center">
            <Clock size={28} className="mx-auto mb-2 text-gray-200" />
            <p className="text-xs text-[#A5A5A5]">
              {timeline.length === 0 ? 'No activity yet.' : 'No results.'}
            </p>
          </div>
        ) : filtered.map((item, idx) => {
          const meta = EVENT_META[item.type] || EVENT_META.activity;
          const Icon = meta.icon;
          return (
            <div key={item.id || idx} className="flex items-start gap-3 px-4 py-3 hover:bg-gray-50/70 transition-colors">
              <div
                className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg"
                style={{ background: meta.bg }}
              >
                <Icon size={13} style={{ color: meta.color }} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold text-[#050505] leading-snug">
                  {item.message || item.title || 'Activity recorded'}
                </p>
                {item.detail && (
                  <p className="mt-0.5 line-clamp-1 text-[11px] text-[#6D6E71]">{item.detail}</p>
                )}
                <div className="mt-1 flex items-center gap-2 text-[11px] text-[#A5A5A5]">
                  <span>{formatTimestamp(item.created_at)}</span>
                  {item.actor_name && <span>· {item.actor_name}</span>}
                </div>
              </div>
              <span
                className="flex-shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold whitespace-nowrap"
                style={{ background: meta.bg, color: meta.color }}
              >
                {meta.label}
              </span>
            </div>
          );
        })}
      </div>

      <div className="border-t border-gray-100 bg-gray-50/40 px-4 py-2 flex-shrink-0">
        <p className="text-[10px] text-[#A5A5A5]">Refreshes every 60 s</p>
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function WorkspaceDealTracker() {
  const { clientId } = useParams();
  const navigate = useNavigate();

  const [company, setCompany] = useState(null);
  const [requests, setRequests] = useState([]);
  const [reminders, setReminders] = useState([]);
  const [activityFeed, setActivityFeed] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!clientId) return;
    let cancelled = false;
    let intervalId;

    const load = async (isInitial = false) => {
      if (isInitial) setLoading(true);
      try {
        const [companyData, requestData, reminderData, activityData] = await Promise.all([
          getCompanyRequest(clientId).catch(() => null),
          listCompanyRequests(clientId).catch(() => []),
          listCompanyReminders(clientId).catch(() => []),
          listCompanyActivity(clientId).catch(() => []),
        ]);
        if (cancelled) return;
        setCompany(companyData);
        setRequests(Array.isArray(requestData) ? requestData : []);
        setReminders(Array.isArray(reminderData) ? reminderData : []);
        setActivityFeed(Array.isArray(activityData) ? activityData : []);
      } catch {
        /* non-fatal */
      } finally {
        if (!cancelled && isInitial) setLoading(false);
      }
    };

    load(true);
    intervalId = window.setInterval(() => load(false), 60000);
    return () => { cancelled = true; window.clearInterval(intervalId); };
  }, [clientId]);

  /**
   * A request's status as a reader should see it: overdue outranks pending, and
   * a calendar-day comparison decides it (an instant comparison against a
   * date-only string calls a request due today overdue, and lands a day early in
   * any timezone behind UTC).
   */
  const displayStatus = (req) => {
    const status = req.status;
    if (status === 'completed' || status === 'blocked') return status;
    return isPastDue(req.due_date || req.dueDate) ? 'overdue' : status;
  };

  /**
   * One derivation, used by every counter on this page.
   *
   * Three panels here used to count the same requests three different ways and
   * report 4, 3 and 6 for one set of six. Each was individually defensible —
   * "open" and "pending" are not the same question — but nothing on screen said
   * which question it was answering, and none of them accounted for blocked or
   * overdue at all. Buckets are mutually exclusive and sum to the total, so the
   * numbers can be reconciled by looking at them.
   */
  const requestSummary = useMemo(() => {
    const counts = { pending: 0, inReview: 0, overdue: 0, blocked: 0, completed: 0 };
    for (const r of requests) {
      const status = displayStatus(r);
      if (status === 'overdue') counts.overdue += 1;
      else if (status === 'in-review') counts.inReview += 1;
      else if (status === 'blocked') counts.blocked += 1;
      else if (status === 'completed') counts.completed += 1;
      else counts.pending += 1;
    }
    return {
      ...counts,
      total: requests.length,
      // Everything still owed by someone. Named for what it means so it can be
      // checked against the buckets rather than guessed at.
      outstanding: counts.pending + counts.inReview + counts.overdue + counts.blocked,
    };
  }, [requests]);

  const activeReminders = useMemo(
    () => reminders.filter((r) => r.status === 'active' || r.status === 'due'),
    [reminders],
  );

  const recentRequests = useMemo(() =>
    [...requests]
      .sort((a, b) => new Date(b.created_at || b.createdAt || 0) - new Date(a.created_at || a.createdAt || 0))
      .slice(0, 6),
    [requests],
  );

  const activitySummary = useMemo(() => ({
    uploads:  activityFeed.filter((i) => ['document_uploaded', 'upload'].includes(i.type)).length,
    messages: activityFeed.filter((i) => ['message_sent', 'direct_message_sent'].includes(i.type)).length,
    users:    activityFeed.filter((i) => ['user_added', 'user_assigned'].includes(i.type)).length,
  }), [activityFeed]);

  return (
    <div className="space-y-5">
      {/* ── Page header ── */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[#050505]">Deal Tracker</h1>
          <p className="mt-0.5 text-sm text-[#6D6E71]">
            {company ? `${company.project_name || company.name} · ${company.industry || 'Company overview'}` : 'Loading company…'}
          </p>
        </div>
        <button
          onClick={() => navigate(`/broker/client/${clientId}/dataroom/requests`)}
          className="inline-flex items-center gap-2 rounded-xl bg-[#8BC53D] px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-[#476E2C] transition-colors self-start"
        >
          <Send size={14} />
          New Request
        </button>
      </div>

      {/* ── Stat cards ── */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          // Every card names the bucket it counts, and the buckets reconcile:
          // outstanding + completed = total. Previously "Open Requests" (4),
          // "Pending" (3) and the six-row list below disagreed with no way to
          // tell which question any of them was answering.
          { label: `Outstanding of ${requestSummary.total}`, value: requestSummary.outstanding, icon: ClipboardList, tone: '#05164D', bg: '#E8ECF7' },
          { label: 'Overdue',          value: requestSummary.overdue,   icon: AlertCircle,   tone: '#C62026', bg: '#FDECEC' },
          { label: 'Completed',        value: requestSummary.completed, icon: CheckCircle2,  tone: '#476E2C', bg: '#E8F3D8' },
          { label: 'Active Reminders', value: activeReminders.length,  icon: Bell,          tone: '#742982', bg: '#F2E6F6' },
        ].map((card) => (
          <div key={card.label} className="rounded-2xl bg-white p-5 shadow-card">
            <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl" style={{ background: card.bg }}>
              <card.icon size={18} style={{ color: card.tone }} />
            </div>
            <p className="text-2xl font-bold text-[#050505]">{loading ? '—' : card.value}</p>
            <p className="mt-1 text-sm text-[#6D6E71]">{card.label}</p>
          </div>
        ))}
      </div>

      {/* ── Two-column main layout ── */}
      <div className="grid gap-5 xl:grid-cols-[1fr_360px]" style={{ minHeight: 0 }}>

        {/* LEFT — company overview + requests */}
        <div className="space-y-5">

          {/*
            The "Company Overview" panel stood here. It was six cells repeating
            the page header (name, industry) and the KPI strip directly above it
            (open, completed, reminders), plus an Activity Events count that was
            always 0. Removed rather than reworked: a panel whose every value
            appears elsewhere on the same screen has nothing to say.
          */}

          {/* DataRoom analytics strip */}
          <div className="rounded-2xl bg-white p-5 shadow-card">
            {/*
              Called "DataRoom Analytics" until it was read carefully: it reports
              request statuses and deal activity, neither of which is analytics
              about the data room. Blocked was missing entirely, so the buckets
              could not add up to the six rows below.
            */}
            <h2 className="mb-4 font-semibold text-[#050505]">Deal Activity</h2>
            <div className="grid gap-4 sm:grid-cols-3">
              {[
                // The five workflow buckets, all of them. They are mutually
                // exclusive and sum to the request total, so a reader can check
                // them against the list below rather than take them on trust.
                { label: 'Pending',     value: requestSummary.pending,   color: '#F68C1F', bg: '#FEF3C7' },
                { label: 'Overdue',     value: requestSummary.overdue,   color: '#C62026', bg: '#FDECEC' },
                { label: 'In Review',   value: requestSummary.inReview,  color: '#00648F', bg: '#E5F4FB' },
                { label: 'Blocked',     value: requestSummary.blocked,   color: '#8A5E10', bg: '#FAF0DC' },
                { label: 'Completed',   value: requestSummary.completed, color: '#476E2C', bg: '#E8F3D8' },
                { label: 'Uploads',     value: activitySummary.uploads,  color: '#05164D', bg: '#E8ECF7' },
                { label: 'Messages',    value: activitySummary.messages, color: '#742982', bg: '#F2E6F6' },
                { label: 'Users Added', value: activitySummary.users,    color: '#2563EB', bg: '#DBEAFE' },
              ].map((stat) => (
                <div
                  key={stat.label}
                  className="flex items-center justify-between rounded-xl border border-gray-100 px-4 py-3"
                >
                  <span className="text-xs font-semibold uppercase tracking-wide text-[#6D6E71]">{stat.label}</span>
                  <span
                    className="rounded-full px-2.5 py-0.5 text-sm font-bold"
                    style={{ background: stat.bg, color: stat.color }}
                  >
                    {loading ? '—' : stat.value}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Recent requests */}
          <div className="rounded-2xl bg-white shadow-card overflow-hidden">
            <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
              <h2 className="font-semibold text-[#050505]">Recent Requests</h2>
              <button
                onClick={() => navigate(`/broker/client/${clientId}/dataroom/requests`)}
                className="flex items-center gap-1 text-xs font-semibold text-[#8BC53D] hover:underline"
              >
                View all <ArrowRight size={12} />
              </button>
            </div>
            <div className="divide-y divide-gray-50">
              {loading ? (
                <p className="px-5 py-10 text-center text-sm text-[#A5A5A5]">Loading requests…</p>
              ) : recentRequests.length === 0 ? (
                <p className="px-5 py-10 text-center text-sm text-[#A5A5A5]">No requests yet.</p>
              ) : recentRequests.map((req) => (
                <div key={req.id} className="flex items-center justify-between px-5 py-3.5 hover:bg-gray-50/80 transition-colors">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-[#050505]">{req.title || req.name}</p>
                    <p className="mt-0.5 text-xs text-[#A5A5A5]">
                      {req.category} · Due {formatCalendarDate(req.due_date || req.dueDate)}
                    </p>
                  </div>
                  {/*
                    Derived, not raw. The API stores `pending` for a request whose
                    due date has passed; overdue is a function of that date, and
                    computing it here is what stops this panel from disagreeing
                    with the requests table about the same row.
                  */}
                  <StatusBadge value={displayStatus(req)} size="xs" />
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* RIGHT — activity log */}
        <div className="xl:sticky xl:top-5" style={{ height: 'calc(100vh - 200px)' }}>
          <ActivityPanel timeline={activityFeed} loading={loading} />
        </div>
      </div>

      {/* ── Overdue alert ── */}
      {!loading && requestSummary.overdue > 0 && (
        <div className="flex items-center gap-3 rounded-2xl border border-[#F68C1F]/30 bg-[#FAC086]/40 px-4 py-3">
          <AlertCircle size={16} className="text-[#b45e08] flex-shrink-0" />
          <p className="text-sm font-medium text-[#b45e08]">
            <strong>{requestSummary.overdue} overdue request{requestSummary.overdue !== 1 ? 's' : ''}</strong> {requestSummary.overdue === 1 ? 'needs' : 'need'} follow-up for this company.
          </p>
          <button
            onClick={() => navigate(`/broker/client/${clientId}/dataroom/requests`)}
            className="ml-auto flex-shrink-0 text-xs font-semibold text-[#b45e08] underline"
          >
            Review
          </button>
        </div>
      )}
    </div>
  );
}
