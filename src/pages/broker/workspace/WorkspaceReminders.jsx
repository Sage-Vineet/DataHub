import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { AlertCircle, Bell, CheckCircle2, Clock3, Filter, Loader2, Search, Send, X } from 'lucide-react';
import { createRequestReminder, getCompanyRequest, listCompanyReminders } from '../../../lib/api';
import {
  filterAndSortReminders,
  getWorkflowStatusOptions,
  hasActiveReminderFilters,
  REMINDER_PRIORITY_OPTIONS,
  REMINDER_SORT_OPTIONS,
  REMINDER_STATUS_OPTIONS,
} from '../../../lib/reminderFilters';

const STATUS_META = {
  due: { label: 'Due Now', tone: '#C62026', bg: '#FEE2E2', icon: AlertCircle },
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

export default function WorkspaceReminders() {
  const { clientId } = useParams();
  const [company, setCompany] = useState(null);
  const [reminders, setReminders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sendingId, setSendingId] = useState('');
  const [filters, setFilters] = useState({
    search: '',
    status: 'all',
    priority: 'all',
    workflowStatus: 'all',
    sortBy: 'next_due',
  });

  const loadReminders = async () => {
    if (!clientId) return;
    setLoading(true);
    setError('');
    try {
      const [companyPayload, reminderPayload] = await Promise.all([
        getCompanyRequest(clientId).catch(() => null),
        listCompanyReminders(clientId),
      ]);
      setCompany(companyPayload);
      setReminders(reminderPayload || []);
    } catch (err) {
      setError(err.message || 'Unable to load reminders.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadReminders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  const sendReminderNow = async (reminder) => {
    if (!reminder?.request_id) return;
    setSendingId(reminder.request_id);
    setError('');
    try {
      await createRequestReminder(reminder.request_id, {
        sent_at: new Date().toISOString(),
      });
      await loadReminders();
    } catch (err) {
      setError(err.message || 'Unable to send reminder.');
    } finally {
      setSendingId('');
    }
  };

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
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[#050505]">Reminders</h1>
        </div>
      </div>

      {error && (
        <div className="rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-[#C62026]">{error}</div>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        {[
          { label: 'Due Now', value: summary.due, tone: '#C62026', bg: '#FEE2E2', icon: AlertCircle },
          { label: 'Scheduled', value: summary.active, tone: '#2563EB', bg: '#DBEAFE', icon: Clock3 },
          { label: 'Resolved', value: summary.resolved, tone: '#166534', bg: '#DCFCE7', icon: CheckCircle2 },
        ].map((card) => (
          <div key={card.label} className="rounded-2xl bg-white p-5 shadow-card">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-[#A5A5A5]">{card.label}</p>
                <p className="mt-2 text-3xl font-bold" style={{ color: card.tone }}>{card.value}</p>
              </div>
              <div className="flex h-12 w-12 items-center justify-center rounded-xl" style={{ background: card.bg }}>
                <card.icon size={22} style={{ color: card.tone }} />
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
          <div className="grid gap-3 lg:grid-cols-[minmax(260px,1fr)_repeat(4,minmax(150px,180px))_auto]">
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
          <p className="text-sm text-[#6D6E71]">No request reminders yet.</p>
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
            const isSendable = reminder.status === 'due' || reminder.status === 'active';

            return (
              <div key={reminder.id} className="rounded-2xl bg-white p-5 shadow-card">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-lg font-bold text-[#050505]">{reminder.title}</h2>
                      <span className="rounded-full px-2.5 py-1 text-xs font-semibold" style={{ backgroundColor: status.bg, color: status.tone }}>
                        <span className="inline-flex items-center gap-1"><StatusIcon size={12} /> {status.label}</span>
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
                        <p className="text-[#A5A5A5]">Workflow Status</p>
                        <p className="mt-1 font-semibold capitalize text-[#050505]">{`${reminder.workflow_status || 'active'}`.replace('-', ' ')}</p>
                      </div>
                      <div>
                        <p className="text-[#A5A5A5]">Request Due Date</p>
                        <p className="mt-1 font-semibold text-[#050505]">{formatDateTime(reminder.due_date)}</p>
                      </div>
                      <div>
                        <p className="text-[#A5A5A5]">Client Contact</p>
                        <p className="mt-1 font-semibold text-[#050505]">{reminder.company_contact_name || company?.contact_name || 'Not available'}</p>
                      </div>
                    </div>

                    <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
                      <div className="rounded-2xl border border-[#E8EDF5] bg-[#FAFCFF] p-4">
                        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#A5A5A5]">Reminder Details</p>
                        <div className="mt-3 grid gap-3 text-xs text-[#6D6E71] sm:grid-cols-2 xl:grid-cols-3">
                          <div>
                            <p className="text-[#A5A5A5]">Cadence</p>
                            <p className="mt-1 font-semibold text-[#050505]">{reminder.frequency_label}</p>
                          </div>
                          <div>
                            <p className="text-[#A5A5A5]">First Reminder</p>
                            <p className="mt-1 font-semibold text-[#050505]">{formatDateTime(reminder.first_sent_at)}</p>
                          </div>
                          <div>
                            <p className="text-[#A5A5A5]">Last Reminder</p>
                            <p className="mt-1 font-semibold text-[#050505]">{formatDateTime(reminder.last_sent_at)}</p>
                          </div>
                          <div>
                            <p className="text-[#A5A5A5]">Next Automatic Reminder</p>
                            <p className="mt-1 font-semibold text-[#050505]">{formatDateTime(getNextReminderDate(reminder))}</p>
                          </div>
                          <div>
                            <p className="text-[#A5A5A5]">Automatic Until</p>
                            <p className="mt-1 font-semibold text-[#050505]">{formatDateTime(reminder.automatic_until)}</p>
                          </div>
                          <div>
                            <p className="text-[#A5A5A5]">Sent Count</p>
                            <p className="mt-1 font-semibold text-[#050505]">{reminder.sent_count}</p>
                          </div>
                        </div>
                        <div className="mt-4">
                          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#A5A5A5]">Recent Reminder History</p>
                          {reminder.history?.length ? (
                            <div className="mt-3 space-y-2">
                              {reminder.history.slice(0, 3).map((item) => (
                                <div key={`${reminder.request_id}-${item.sent_at}`} className="flex items-center justify-between rounded-xl bg-white px-3 py-2 text-xs text-[#6D6E71]">
                                  <span className="font-medium text-[#050505]">{item.sent_by_name || item.sent_by_email || 'Broker'}</span>
                                  <span>{formatDateTime(item.sent_at)}</span>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <p className="mt-3 text-xs text-[#6D6E71]">No reminder events recorded yet.</p>
                          )}
                        </div>
                      </div>

                      <div className="rounded-2xl border border-[#E8EDF5] bg-white p-4">
                        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#A5A5A5]">Contact Details</p>
                        <div className="mt-3 space-y-3 text-xs text-[#6D6E71]">
                          <div>
                            <p className="text-[#A5A5A5]">Contact Person</p>
                            <p className="mt-1 font-semibold text-[#050505]">{reminder.company_contact_name || company?.contact_name || 'Not available'}</p>
                          </div>
                          <div>
                            <p className="text-[#A5A5A5]">Email</p>
                            <p className="mt-1 font-semibold text-[#050505]">{reminder.company_contact_email || company?.contact_email || 'Not available'}</p>
                          </div>
                          <div>
                            <p className="text-[#A5A5A5]">Phone</p>
                            <p className="mt-1 font-semibold text-[#050505]">{reminder.company_contact_phone || company?.contact_phone || 'Not available'}</p>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-col gap-2 lg:min-w-[180px]">
                    {isSendable && (
                      <button
                        type="button"
                        onClick={() => sendReminderNow(reminder)}
                        disabled={sendingId === reminder.request_id}
                        className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#8BC53D] px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#476E2C] disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {sendingId === reminder.request_id ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
                        {sendingId === reminder.request_id ? 'Sending...' : 'Send Reminder Again'}
                      </button>
                    )}
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
