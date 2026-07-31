import { useMemo, useState } from 'react';
import {
  AlertCircle,
  Bell,
  Building2,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  Clock3,
  History,
  Loader2,
  Mail,
  RefreshCw,
  Search,
  Send,
  SkipForward,
  User,
  X,
} from 'lucide-react';
import {
  filterAndSortReminders,
  getWorkflowStatusOptions,
  hasActiveReminderFilters,
  REMINDER_PRIORITY_OPTIONS,
  REMINDER_SORT_OPTIONS,
  REMINDER_STATUS_OPTIONS,
} from '../../lib/reminderFilters';

const STATUS_META = {
  due: { label: 'Due Now', tone: '#C62026', bg: '#FEE2E2', icon: AlertCircle },
  overdue: { label: 'Overdue', tone: '#991B1B', bg: '#FEE2E2', icon: AlertCircle },
  active: { label: 'Scheduled', tone: '#2563EB', bg: '#DBEAFE', icon: Clock3 },
  blocked: { label: 'Blocked', tone: '#7F1D1D', bg: '#FEE2E2', icon: AlertCircle },
  resolved: { label: 'Resolved', tone: '#166534', bg: '#DCFCE7', icon: CheckCircle2 },
};

const HISTORY_META = {
  sent: { label: 'Reminder sent', tone: '#2563EB', bg: '#DBEAFE' },
  skipped: { label: 'Skipped', tone: '#6D6E71', bg: '#F3F4F6' },
  overdue: { label: 'Overdue notice', tone: '#991B1B', bg: '#FEE2E2' },
};

function getPriorityTone(priority) {
  const normalized = `${priority ?? ''}`.trim().toLowerCase();
  if (normalized === 'critical') return { bg: '#FEE2E2', color: '#B91C1C' };
  if (normalized === 'high') return { bg: '#FED7AA', color: '#C2410C' };
  if (normalized === 'medium') return { bg: '#FEF3C7', color: '#A16207' };
  if (normalized === 'low') return { bg: '#DCFCE7', color: '#166534' };
  return { bg: '#DBEAFE', color: '#1D4ED8' };
}

function formatDate(value) {
  if (!value) return 'Not set';
  const text = String(value).slice(0, 10);
  const date = new Date(`${text}T00:00:00`);
  if (Number.isNaN(date.getTime())) return text;
  return date.toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatDateTime(value) {
  if (!value) return 'Not scheduled';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not scheduled';
  return date.toLocaleString('en-IN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function normalizeEventType(item) {
  return `${item?.event_type || 'sent'}`.trim().toLowerCase() || 'sent';
}

function getNextReminderDate(reminder) {
  return reminder?.next_reminder_at || reminder?.next_due_at;
}

function ReminderBadge({ children, tone }) {
  return (
    <span
      className="inline-flex h-5 items-center rounded px-1.5 text-[11px] font-semibold"
      style={{ backgroundColor: tone.bg, color: tone.color || tone.tone }}
    >
      {children}
    </span>
  );
}

function DetailField({ icon: Icon, label, value }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1 text-[10px] font-semibold uppercase text-[#A5A5A5]">
        {Icon && <Icon size={11} />}
        {label}
      </div>
      <p className="mt-0.5 truncate text-xs font-semibold text-[#050505]">{value || 'Not available'}</p>
    </div>
  );
}

export default function ReminderCenter({
  title = 'Reminders',
  reminders = [],
  loading = false,
  error = '',
  emptyMessage = 'No reminders yet.',
  showCompany = false,
  audience = 'broker',
  contactFallback = null,
  sendingId = '',
  skippingId = '',
  onSendNow = null,
  onSkipNext = null,
  onRefresh = null,
}) {
  const [filters, setFilters] = useState({
    search: '',
    status: 'all',
    priority: 'all',
    workflowStatus: 'all',
    sortBy: 'next_due',
  });
  const [expandedId, setExpandedId] = useState('');

  const filteredReminders = useMemo(
    () => filterAndSortReminders(reminders, filters),
    [reminders, filters],
  );
  const workflowOptions = useMemo(() => getWorkflowStatusOptions(reminders), [reminders]);
  const hasFilters = hasActiveReminderFilters(filters);

  const summary = useMemo(() => ({
    due: filteredReminders.filter((item) => item.status === 'due').length,
    overdue: filteredReminders.filter((item) => item.status === 'overdue').length,
    active: filteredReminders.filter((item) => item.status === 'active').length,
    resolved: filteredReminders.filter((item) => item.status === 'resolved').length,
  }), [filteredReminders]);

  const clearFilters = () => setFilters({
    search: '',
    status: 'all',
    priority: 'all',
    workflowStatus: 'all',
    sortBy: 'next_due',
  });

  const sentLabel = audience === 'client' ? 'Last received' : 'Last sent';
  const nextLabel = audience === 'client' ? 'Next received' : 'Next scheduled';
  const canAct = Boolean(onSendNow || onSkipNext);

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-bold text-[#050505]">{title}</h1>
          <p className="mt-0.5 text-xs text-[#6D6E71]">{filteredReminders.length} shown of {reminders.length}</p>
        </div>
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-[#E5E7EF] bg-white px-2.5 text-xs font-semibold text-[#05164D] transition-colors hover:border-[#8BC53D]"
          >
            <RefreshCw size={13} />
            Refresh
          </button>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-red-100 bg-red-50 px-4 py-3 text-sm text-[#C62026]">{error}</div>
      )}

      <div className="rounded-md border border-[#E8EDF5] bg-white px-3 py-2">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5">
        {[
          { label: 'Due now', value: summary.due, meta: STATUS_META.due },
          { label: 'Overdue', value: summary.overdue, meta: STATUS_META.overdue },
          { label: 'Scheduled', value: summary.active, meta: STATUS_META.active },
          { label: 'Resolved', value: summary.resolved, meta: STATUS_META.resolved },
        ].map((item) => (
          <div key={item.label} className="inline-flex items-center gap-1.5">
            <item.meta.icon size={13} style={{ color: item.meta.tone }} />
            <span className="text-[11px] font-semibold uppercase text-[#A5A5A5]">{item.label}</span>
            <span className="text-sm font-bold" style={{ color: item.meta.tone }}>{item.value}</span>
          </div>
        ))}
        </div>
      </div>

      <div className="rounded-md border border-[#E8EDF5] bg-white px-3 py-2">
        <div className="grid gap-2 lg:grid-cols-[minmax(220px,1fr)_repeat(4,minmax(128px,155px))_34px]">
          <div className="relative">
            <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[#A5A5A5]" />
            <input
              type="search"
              value={filters.search}
              onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))}
              placeholder="Search topic, detail, request, contact"
              className="h-8 w-full rounded-md border border-[#E5E7EF] bg-white pl-8 pr-2.5 text-xs text-[#050505] outline-none transition-colors focus:border-[#8BC53D]"
            />
          </div>
          <select value={filters.status} onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))} className="h-8 rounded-md border border-[#E5E7EF] bg-white px-2 text-xs text-[#050505] outline-none focus:border-[#8BC53D]">
            {REMINDER_STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <select value={filters.priority} onChange={(event) => setFilters((current) => ({ ...current, priority: event.target.value }))} className="h-8 rounded-md border border-[#E5E7EF] bg-white px-2 text-xs text-[#050505] outline-none focus:border-[#8BC53D]">
            {REMINDER_PRIORITY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <select value={filters.workflowStatus} onChange={(event) => setFilters((current) => ({ ...current, workflowStatus: event.target.value }))} className="h-8 rounded-md border border-[#E5E7EF] bg-white px-2 text-xs capitalize text-[#050505] outline-none focus:border-[#8BC53D]">
            {workflowOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <select value={filters.sortBy} onChange={(event) => setFilters((current) => ({ ...current, sortBy: event.target.value }))} className="h-8 rounded-md border border-[#E5E7EF] bg-white px-2 text-xs text-[#050505] outline-none focus:border-[#8BC53D]">
            {REMINDER_SORT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <button
            type="button"
            onClick={clearFilters}
            disabled={!hasFilters}
            className="inline-flex h-8 items-center justify-center rounded-md border border-[#E5E7EF] text-[#6D6E71] transition-colors hover:border-[#8BC53D] hover:text-[#05164D] disabled:cursor-not-allowed disabled:opacity-40"
            title="Clear filters"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {loading ? (
        <div className="rounded-lg border border-[#E8EDF5] bg-white px-6 py-14 text-center text-sm text-[#A5A5A5]">
          Loading reminders...
        </div>
      ) : reminders.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-200 bg-white px-6 py-14 text-center">
          <Bell size={34} className="mx-auto mb-3 text-gray-300" />
          <p className="text-sm text-[#6D6E71]">{emptyMessage}</p>
        </div>
      ) : filteredReminders.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-200 bg-white px-6 py-14 text-center">
          <Bell size={34} className="mx-auto mb-3 text-gray-300" />
          <p className="text-sm text-[#6D6E71]">No reminders match the current filters.</p>
        </div>
      ) : (
        <div className="max-h-[calc(100vh-275px)] overflow-auto rounded-md border border-[#E8EDF5] bg-white">
          <div className="sticky top-0 z-10 hidden grid-cols-[minmax(0,1.7fr)_110px_92px_132px_132px_30px] gap-2 border-b border-[#EEF2F7] bg-[#FAFBFC] px-3 py-2 text-[10px] font-semibold uppercase text-[#A5A5A5] lg:grid">
            <span>Topic and details</span>
            <span>Due date</span>
            <span>Priority</span>
            <span>{sentLabel}</span>
            <span>{nextLabel}</span>
            <span />
          </div>
          {filteredReminders.map((reminder) => {
            const status = STATUS_META[reminder.status] || STATUS_META.active;
            const priorityTone = getPriorityTone(reminder.priority);
            const StatusIcon = status.icon;
            const isExpanded = expandedId === reminder.id;
            const workflowLabel = `${reminder.workflow_status || 'active'}`.replace('-', ' ');
            return (
              <div key={`${reminder.company_id || 'company'}-${reminder.id}`} className="border-b border-[#EEF2F7] last:border-b-0">
                <button
                  type="button"
                  onClick={() => setExpandedId((current) => (current === reminder.id ? '' : reminder.id))}
                  aria-expanded={isExpanded}
                  className={`grid w-full gap-2 px-3 py-2.5 text-left transition-colors hover:bg-[#FAFCFF] lg:grid-cols-[minmax(0,1.7fr)_110px_92px_132px_132px_30px] lg:items-center ${isExpanded ? 'bg-[#F4F9EC]' : 'bg-white'}`}
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-bold text-[#050505]">{reminder.title}</p>
                      <span className="inline-flex h-5 items-center gap-1 rounded px-1.5 text-[11px] font-semibold" style={{ backgroundColor: status.bg, color: status.tone }}>
                        <StatusIcon size={11} />
                        {status.label}
                      </span>
                    </div>
                    {showCompany && reminder.company_name && (
                      <p className="mt-0.5 truncate text-[11px] font-semibold text-[#05164D]">{reminder.company_name}</p>
                    )}
                    <p className="mt-0.5 line-clamp-1 text-[11px] leading-4 text-[#6D6E71]">{reminder.message || 'No details provided.'}</p>
                  </div>
                  <DetailField label="Due" value={formatDate(reminder.due_date)} />
                  <div>
                    <ReminderBadge tone={priorityTone}>{reminder.priority || 'medium'}</ReminderBadge>
                  </div>
                  <DetailField label={sentLabel} value={formatDateTime(reminder.last_sent_at)} />
                  <DetailField label={nextLabel} value={formatDateTime(getNextReminderDate(reminder))} />
                  <div className="hidden justify-end lg:flex">
                    <ChevronRight size={16} className={`text-[#476E2C] transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
                  </div>
                </button>

                {isExpanded && (
                  <div className="border-t border-[#E6EFD9] bg-[#FBFDF8] px-3 py-3">
                    <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <ReminderBadge tone={priorityTone}>{reminder.priority || 'medium'}</ReminderBadge>
                          <span className="inline-flex h-5 items-center gap-1 rounded px-1.5 text-[11px] font-semibold" style={{ backgroundColor: status.bg, color: status.tone }}>
                            <StatusIcon size={11} />
                            {status.label}
                          </span>
                          <span className="inline-flex h-5 items-center rounded bg-white px-1.5 text-[11px] font-semibold capitalize text-[#6D6E71] ring-1 ring-[#E8EDF5]">
                            {workflowLabel}
                          </span>
                        </div>
                        <p className="mt-2 max-w-5xl text-xs leading-5 text-[#050505]">{reminder.message || 'No details provided.'}</p>
                      </div>

                      {canAct && ['due', 'active'].includes(reminder.status) && (
                        <div className="grid gap-2 sm:grid-cols-2 xl:min-w-[250px]">
                          {onSendNow && (
                            <button
                              type="button"
                              onClick={() => onSendNow(reminder)}
                              disabled={sendingId === reminder.request_id}
                              className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-[#8BC53D] px-2.5 text-xs font-semibold text-white transition-colors hover:bg-[#476E2C] disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              {sendingId === reminder.request_id ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
                              {sendingId === reminder.request_id ? 'Sending...' : 'Send now'}
                            </button>
                          )}
                          {onSkipNext && (
                            <button
                              type="button"
                              onClick={() => onSkipNext(reminder)}
                              disabled={skippingId === reminder.request_id}
                              className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-[#DCE8CC] bg-white px-2.5 text-xs font-semibold text-[#05164D] transition-colors hover:border-[#8BC53D] disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              {skippingId === reminder.request_id ? <Loader2 size={13} className="animate-spin" /> : <SkipForward size={13} />}
                              {skippingId === reminder.request_id ? 'Skipping...' : 'Skip next'}
                            </button>
                          )}
                        </div>
                      )}
                    </div>

                    <div className="mt-3 grid gap-x-6 gap-y-3 md:grid-cols-3 xl:grid-cols-5">
                      {showCompany && <DetailField icon={Building2} label="Company" value={reminder.company_name} />}
                      <DetailField icon={CalendarClock} label="Due date" value={formatDate(reminder.due_date)} />
                      <DetailField icon={Clock3} label="Cadence" value={reminder.frequency_label} />
                      <DetailField icon={History} label="Sent count" value={`${reminder.sent_count || 0}`} />
                      <DetailField icon={Clock3} label={sentLabel} value={formatDateTime(reminder.last_sent_at)} />
                      <DetailField icon={CalendarClock} label={nextLabel} value={formatDateTime(getNextReminderDate(reminder))} />
                      <DetailField icon={AlertCircle} label="Overdue notice" value={formatDateTime(reminder.overdue_notice_sent_at)} />
                      <DetailField icon={CheckCircle2} label="Workflow" value={workflowLabel} />
                      <DetailField icon={User} label="Contact" value={reminder.company_contact_name || contactFallback?.contact_name} />
                      <DetailField icon={Mail} label="Email" value={reminder.company_contact_email || contactFallback?.contact_email} />
                    </div>

                    <div className="mt-4">
                      <div className="flex items-center gap-1.5 text-xs font-bold text-[#050505]">
                        <History size={14} />
                        History
                      </div>
                      {reminder.history?.length ? (
                        <div className="mt-2 grid gap-2 lg:grid-cols-2 2xl:grid-cols-4">
                          {reminder.history.map((item) => {
                            const eventType = normalizeEventType(item);
                            const meta = HISTORY_META[eventType] || HISTORY_META.sent;
                            return (
                              <div key={`${reminder.request_id}-${item.sent_at}-${eventType}`} className="border-l-2 bg-white px-2.5 py-2" style={{ borderColor: meta.tone }}>
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <span className="rounded px-1.5 py-0.5 text-[11px] font-semibold" style={{ backgroundColor: meta.bg, color: meta.tone }}>
                                    {meta.label}
                                  </span>
                                  <span className="text-[11px] text-[#6D6E71]">{formatDateTime(item.sent_at)}</span>
                                </div>
                                <p className="mt-1 truncate text-[11px] font-semibold text-[#050505]">{item.sent_by_name || item.sent_by_email || 'System'}</p>
                                {item.scheduled_for && (
                                  <p className="mt-0.5 truncate text-[11px] text-[#6D6E71]">Scheduled for {formatDateTime(item.scheduled_for)}</p>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <p className="mt-2 text-xs text-[#6D6E71]">No reminder history recorded.</p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
