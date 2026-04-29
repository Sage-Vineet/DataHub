import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, Bell, CheckCircle2, Clock3, Filter, Search, X } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { listCompanyReminders } from '../../lib/api';
import {
  filterAndSortReminders,
  getWorkflowStatusOptions,
  hasActiveReminderFilters,
  REMINDER_PRIORITY_OPTIONS,
  REMINDER_SORT_OPTIONS,
  REMINDER_STATUS_OPTIONS,
} from '../../lib/reminderFilters';

const STATUS_META = {
  due: { label: 'Needs Attention', tone: '#C62026', bg: '#FEE2E2', icon: AlertCircle },
  active: { label: 'Scheduled', tone: '#2563EB', bg: '#DBEAFE', icon: Clock3 },
  blocked: { label: 'Blocked', tone: '#991B1B', bg: '#FEE2E2', icon: AlertCircle },
  resolved: { label: 'Resolved', tone: '#166534', bg: '#DCFCE7', icon: CheckCircle2 },
};

function getPriorityTone(priority) {
  const normalized = `${priority ?? ''}`.trim().toLowerCase();
  if (normalized === 'critical') return { bg: '#FEE2E2', color: '#B91C1C' };
  if (normalized === 'high') return { bg: '#FED7AA', color: '#C2410C' };
  if (normalized === 'medium') return { bg: '#FEF3C7', color: '#A16207' };
  if (normalized === 'low') return { bg: '#DCFCE7', color: '#166534' };
  return { bg: '#DBEAFE', color: '#1D4ED8' };
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

function getNextReminderDate(reminder) {
  return reminder?.next_reminder_at || reminder?.next_due_at;
}

export default function ClientReminders() {
  const { user } = useAuth();
  const companyId = user?.company_id || user?.companyId || null;
  const [reminders, setReminders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState({
    search: '',
    status: 'all',
    priority: 'all',
    workflowStatus: 'all',
    sortBy: 'next_due',
  });

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- This effect syncs reminder state with the active company. */
    if (!companyId) {
      setReminders([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError('');
    listCompanyReminders(companyId)
      .then((payload) => setReminders(payload || []))
      .catch((err) => setError(err.message || 'Unable to load reminders.'))
      .finally(() => setLoading(false));
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [companyId]);

  const filteredReminders = useMemo(
    () => filterAndSortReminders(reminders, filters),
    [reminders, filters]
  );

  const workflowOptions = useMemo(() => getWorkflowStatusOptions(reminders), [reminders]);
  const hasFilters = hasActiveReminderFilters(filters);

  const summary = useMemo(() => ({
    due: filteredReminders.filter((item) => item.status === 'due').length,
    active: filteredReminders.filter((item) => item.status === 'active').length,
    resolved: filteredReminders.filter((item) => item.status === 'resolved').length,
  }), [filteredReminders]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[#050505]">Reminders</h1>
      </div>

      {error && (
        <div className="rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-[#C62026]">{error}</div>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        {[
          { label: 'Needs Attention', value: summary.due, tone: '#C62026', bg: '#FEE2E2', icon: AlertCircle },
          { label: 'Scheduled', value: summary.active, tone: '#2563EB', bg: '#DBEAFE', icon: Clock3 },
          { label: 'Resolved', value: summary.resolved, tone: '#166534', bg: '#DCFCE7', icon: CheckCircle2 },
        ].map((card) => (
          <div key={card.label} className="rounded-2xl bg-white p-5 shadow-card">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-[#A5A5A5]">{card.label}</p>
                <p className="mt-2 text-3xl font-bold" style={{ color: card.tone }}>{card.value}</p>
              </div>
              <div className="flex h-11 w-11 items-center justify-center rounded-xl" style={{ background: card.bg }}>
                <card.icon size={20} style={{ color: card.tone }} />
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="rounded-2xl bg-white p-5 shadow-card">
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="inline-flex items-center gap-2 text-sm font-semibold text-[#05164D]">
              <Filter size={16} />
              Search & Filter
            </div>
            <p className="text-xs text-[#A5A5A5]">{filteredReminders.length} shown of {reminders.length}</p>
          </div>
          <div className="grid gap-3 lg:grid-cols-[minmax(240px,1fr)_repeat(4,minmax(145px,170px))_auto]">
            <div className="relative">
              <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#A5A5A5]" />
              <input
                type="search"
                value={filters.search}
                onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))}
                placeholder="Search title, request, contact..."
                className="w-full rounded-xl border border-[#E5E7EF] bg-white py-2.5 pl-9 pr-3 text-sm text-[#050505] outline-none transition-colors focus:border-[#8BC53D]"
              />
            </div>
            <select value={filters.status} onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))} className="rounded-xl border border-[#E5E7EF] bg-white px-3 py-2.5 text-sm text-[#050505] outline-none transition-colors focus:border-[#8BC53D]">
              {REMINDER_STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            <select value={filters.priority} onChange={(event) => setFilters((current) => ({ ...current, priority: event.target.value }))} className="rounded-xl border border-[#E5E7EF] bg-white px-3 py-2.5 text-sm text-[#050505] outline-none transition-colors focus:border-[#8BC53D]">
              {REMINDER_PRIORITY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            <select value={filters.workflowStatus} onChange={(event) => setFilters((current) => ({ ...current, workflowStatus: event.target.value }))} className="rounded-xl border border-[#E5E7EF] bg-white px-3 py-2.5 text-sm capitalize text-[#050505] outline-none transition-colors focus:border-[#8BC53D]">
              {workflowOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            <select value={filters.sortBy} onChange={(event) => setFilters((current) => ({ ...current, sortBy: event.target.value }))} className="rounded-xl border border-[#E5E7EF] bg-white px-3 py-2.5 text-sm text-[#050505] outline-none transition-colors focus:border-[#8BC53D]">
              {REMINDER_SORT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            <button
              type="button"
              onClick={() => setFilters({ search: '', status: 'all', priority: 'all', workflowStatus: 'all', sortBy: 'next_due' })}
              disabled={!hasFilters}
              className="inline-flex items-center justify-center rounded-xl border border-[#E5E7EF] px-3 py-2.5 text-sm font-semibold text-[#6D6E71] transition-colors hover:border-[#8BC53D] hover:text-[#05164D] disabled:cursor-not-allowed disabled:opacity-40"
              title="Clear filters"
            >
              <X size={16} />
            </button>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="rounded-2xl bg-white px-6 py-14 text-center text-sm text-[#A5A5A5] shadow-card">Loading reminders...</div>
      ) : reminders.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-gray-200 bg-white px-6 py-14 text-center shadow-card">
          <Bell size={36} className="mx-auto mb-3 text-gray-300" />
          <p className="text-sm text-[#6D6E71]">No reminders yet.</p>
        </div>
      ) : filteredReminders.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-gray-200 bg-white px-6 py-14 text-center shadow-card">
          <Bell size={36} className="mx-auto mb-3 text-gray-300" />
          <p className="text-sm text-[#6D6E71]">No reminders match the current filters.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {filteredReminders.map((reminder) => {
            const status = STATUS_META[reminder.status] || STATUS_META.active;
            const priorityTone = getPriorityTone(reminder.priority);
            const StatusIcon = status.icon;

            return (
              <div key={reminder.id} className="rounded-2xl bg-white p-5 shadow-card">
                <div className="flex items-start gap-4">
                  <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl" style={{ background: status.bg }}>
                    <StatusIcon size={20} style={{ color: status.tone }} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-lg font-bold text-[#050505]">{reminder.title}</h2>
                      <span className="rounded-full px-2.5 py-1 text-xs font-semibold" style={{ backgroundColor: status.bg, color: status.tone }}>
                        {status.label}
                      </span>
                      <span className="rounded-full px-2.5 py-1 text-xs font-semibold" style={{ backgroundColor: priorityTone.bg, color: priorityTone.color }}>
                        {reminder.priority}
                      </span>
                    </div>
                    <div className="mt-4 grid gap-3 text-xs text-[#6D6E71] sm:grid-cols-2 xl:grid-cols-4">
                      <div>
                        <p className="text-[#A5A5A5]">Request ID</p>
                        <p className="mt-1 font-semibold text-[#050505]">{reminder.request_id}</p>
                      </div>
                      <div>
                        <p className="text-[#A5A5A5]">Reminder Cadence</p>
                        <p className="mt-1 font-semibold text-[#050505]">{reminder.frequency_label}</p>
                      </div>
                      <div>
                        <p className="text-[#A5A5A5]">Last Reminder</p>
                        <p className="mt-1 font-semibold text-[#050505]">{formatDateTime(reminder.last_sent_at)}</p>
                      </div>
                      <div>
                        <p className="text-[#A5A5A5]">Next Reminder</p>
                        <p className="mt-1 font-semibold text-[#050505]">{formatDateTime(getNextReminderDate(reminder))}</p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
