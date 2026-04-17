import { Bell, Clock, CheckCircle, AlertCircle, Info } from 'lucide-react';
import { reminders } from '../../data/mockData';
import StatusBadge from '../../components/common/StatusBadge';

const priorityColors = { high: '#C62026', medium: '#F68C1F', low: '#00648F' };
const priorityBg = { high: '#FEE2E2', medium: '#FAC086', low: '#A7DCF7' };

export default function ClientReminders() {
  const myReminders = reminders.filter(r => r.companyId === 'co1');
  const active = myReminders.filter(r => r.status === 'active');
  const dismissed = myReminders.filter(r => r.status === 'dismissed');

  const isOverdue = (date) => new Date(date) < new Date();

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-[#050505]">Reminders</h1>
        <p className="text-sm text-[#6D6E71] mt-0.5">Notifications and follow-ups from Dataroom</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        {[
          { label: 'Active', value: active.length, icon: Bell, color: '#8BC53D', bg: '#E6F3D3' },
          { label: 'Overdue', value: active.filter(r => isOverdue(r.dueDate)).length, icon: AlertCircle, color: '#C62026', bg: '#FEE2E2' },
          { label: 'Resolved', value: dismissed.length, icon: CheckCircle, color: '#476E2C', bg: '#C9E4A4' },
        ].map(s => (
          <div key={s.label} className="bg-white rounded-2xl p-4 shadow-card flex items-center gap-3">
            <div className="w-11 h-11 rounded-xl flex items-center justify-center" style={{ background: s.bg }}>
              <s.icon size={20} style={{ color: s.color }} />
            </div>
            <div>
              <p className="text-2xl font-bold" style={{ color: s.color }}>{s.value}</p>
              <p className="text-xs text-[#A5A5A5]">{s.label}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Active Reminders */}
      {active.length > 0 && (
        <div>
          <h2 className="font-semibold text-[#050505] mb-3">Active Reminders ({active.length})</h2>
          <div className="space-y-3">
            {active.map(r => {
              const overdue = isOverdue(r.dueDate);
              return (
                <div
                  key={r.id}
                  className="bg-white rounded-2xl shadow-card p-5 border-l-4 hover:shadow-hover transition-all duration-200"
                  style={{ borderLeftColor: priorityColors[r.priority] }}
                >
                  <div className="flex items-start gap-4">
                    <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: priorityBg[r.priority] }}>
                      <Bell size={18} style={{ color: priorityColors[r.priority] }} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <h3 className="font-semibold text-[#050505]">{r.title}</h3>
                        <StatusBadge value={r.priority} variant="priority" size="xs" />
                      </div>
                      <p className="text-sm text-[#6D6E71] mt-1">{r.message}</p>

                      <div className="flex flex-wrap items-center gap-4 mt-3 pt-3 border-t border-gray-100">
                        <div className={`flex items-center gap-1.5 text-xs font-medium ${overdue ? 'text-[#C62026]' : 'text-[#6D6E71]'}`}>
                          {overdue ? <AlertCircle size={13} /> : <Clock size={13} />}
                          {overdue ? `Overdue since ${r.dueDate}` : `Due: ${r.dueDate}`}
                        </div>
                        <div className="flex items-center gap-1.5 text-xs text-[#A5A5A5]">
                          <Info size={12} />
                          From: Dataroom
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Dismissed Reminders */}
      {dismissed.length > 0 && (
        <div>
          <h2 className="font-semibold text-[#050505] mb-3 flex items-center gap-2">
            Completed / Dismissed
            <span className="text-xs text-[#A5A5A5] font-normal">({dismissed.length})</span>
          </h2>
          <div className="space-y-2">
            {dismissed.map(r => (
              <div key={r.id} className="bg-white rounded-2xl shadow-card p-4 opacity-60 hover:opacity-80 transition-opacity flex items-center gap-3">
                <div className="w-8 h-8 rounded-xl bg-gray-100 flex items-center justify-center flex-shrink-0">
                  <CheckCircle size={16} className="text-[#A5A5A5]" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-[#050505] line-through">{r.title}</p>
                  <p className="text-xs text-[#A5A5A5]">Resolved · {r.dueDate}</p>
                </div>
                <StatusBadge value="dismissed" size="xs" />
              </div>
            ))}
          </div>
        </div>
      )}

      {myReminders.length === 0 && (
        <div className="text-center py-20 text-[#A5A5A5]">
          <Bell size={48} className="mx-auto mb-4 opacity-20" />
          <p className="text-base font-medium">No reminders yet.</p>
          <p className="text-sm mt-1">Your broker will send reminders for pending actions.</p>
        </div>
      )}
    </div>
  );
}
