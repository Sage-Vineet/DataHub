import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, Bell, CheckCircle2, Clock3 } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { listCompanyReminders } from '../../lib/api';

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

export default function ClientReminders() {
  const { user } = useAuth();
  const companyId = user?.company_id || user?.companyId || null;
  const [reminders, setReminders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
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
  }, [companyId]);

  const summary = useMemo(() => ({
    due: reminders.filter((item) => item.status === 'due').length,
    active: reminders.filter((item) => item.status === 'active').length,
    resolved: reminders.filter((item) => item.status === 'resolved').length,
  }), [reminders]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[#050505]">Reminders</h1>
        <p className="text-sm text-[#6D6E71] mt-0.5">All incoming request reminders shared with your client portal.</p>
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

      {loading ? (
        <div className="rounded-2xl bg-white px-6 py-14 text-center text-sm text-[#A5A5A5] shadow-card">Loading reminders...</div>
      ) : reminders.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-gray-200 bg-white px-6 py-14 text-center shadow-card">
          <Bell size={36} className="mx-auto mb-3 text-gray-300" />
          <p className="text-sm text-[#6D6E71]">No reminders yet.</p>
          <p className="mt-1 text-xs text-[#A5A5A5]">Your broker reminders for incoming requests will appear here automatically.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {reminders.map((reminder) => {
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
                    <p className="mt-2 text-sm text-[#6D6E71]">{reminder.message}</p>
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
                        <p className="mt-1 font-semibold text-[#050505]">{formatDateTime(reminder.next_due_at)}</p>
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
