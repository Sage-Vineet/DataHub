import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, Bell, CheckCircle2, Clock3, Loader2, Send } from 'lucide-react';
import { createRequestReminder, listCompaniesRequest, listCompanyReminders } from '../../lib/api';

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

export default function BrokerReminders() {
  const [reminders, setReminders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sendingId, setSendingId] = useState('');

  const loadReminders = async () => {
    setLoading(true);
    setError('');
    try {
      const companies = await listCompaniesRequest();
      const reminderGroups = await Promise.all(
        (companies || []).map(async (company) => (
          listCompanyReminders(company.id).catch(() => [])
        )),
      );
      setReminders(reminderGroups.flat());
    } catch (err) {
      setError(err.message || 'Unable to load reminders.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadReminders();
  }, []);

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

  const summary = useMemo(() => ({
    due: reminders.filter((item) => item.status === 'due').length,
    active: reminders.filter((item) => item.status === 'active').length,
    resolved: reminders.filter((item) => item.status === 'resolved').length,
  }), [reminders]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[#050505]">Broker Reminders</h1>
        <p className="text-sm text-[#6D6E71] mt-0.5">
          The first reminder is sent automatically when a request is generated. Follow-up reminders then run by priority until the request due date, and you can still send a manual reminder again before the request is completed.
        </p>
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

      {loading ? (
        <div className="rounded-2xl bg-white px-6 py-14 text-center text-sm text-[#A5A5A5] shadow-card">Loading reminders...</div>
      ) : reminders.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-gray-200 bg-white px-6 py-14 text-center shadow-card">
          <Bell size={36} className="mx-auto mb-3 text-gray-300" />
          <p className="text-sm text-[#6D6E71]">No reminders available yet.</p>
          <p className="mt-1 text-xs text-[#A5A5A5]">Create or approve requests to start broker reminder tracking.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {reminders.map((reminder) => {
            const status = STATUS_META[reminder.status] || STATUS_META.active;
            const priorityTone = getPriorityTone(reminder.priority);
            const StatusIcon = status.icon;
            const isSendable = reminder.status === 'due' || reminder.status === 'active';

            return (
              <div key={`${reminder.company_id}-${reminder.id}`} className="rounded-2xl bg-white p-5 shadow-card">
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
                    <p className="mt-2 text-sm text-[#6D6E71]">{reminder.message}</p>
                    <div className="mt-4 grid gap-3 text-xs text-[#6D6E71] sm:grid-cols-2 xl:grid-cols-4">
                      <div>
                        <p className="text-[#A5A5A5]">Company</p>
                        <p className="mt-1 font-semibold text-[#050505]">{reminder.company_name}</p>
                      </div>
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
                            <p className="mt-1 font-semibold text-[#050505]">{formatDateTime(reminder.next_due_at)}</p>
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
                        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#A5A5A5]">Client Contact</p>
                        <div className="mt-3 space-y-3 text-xs text-[#6D6E71]">
                          <div>
                            <p className="text-[#A5A5A5]">Contact Person</p>
                            <p className="mt-1 font-semibold text-[#050505]">{reminder.company_contact_name || 'Not available'}</p>
                          </div>
                          <div>
                            <p className="text-[#A5A5A5]">Email</p>
                            <p className="mt-1 font-semibold text-[#050505]">{reminder.company_contact_email || 'Not available'}</p>
                          </div>
                          <div>
                            <p className="text-[#A5A5A5]">Phone</p>
                            <p className="mt-1 font-semibold text-[#050505]">{reminder.company_contact_phone || 'Not available'}</p>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-col gap-2 lg:min-w-[180px]">
                    <div className="rounded-xl bg-[#F8FAFC] px-4 py-3 text-xs text-[#6D6E71]">
                      <p className="text-[#A5A5A5]">Manual Action</p>
                      <p className="mt-1 text-sm font-semibold text-[#05164D]">Send an extra reminder outside the automatic cadence.</p>
                    </div>
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
