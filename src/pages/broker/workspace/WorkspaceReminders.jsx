import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { Bell, Plus, Clock, CheckCircle, AlertCircle, Trash2, ChevronDown } from 'lucide-react';
import { reminders as allReminders, requests, companies } from '../../../data/mockData';
import StatusBadge from '../../../components/common/StatusBadge';
import Modal from '../../../components/common/Modal';

export default function WorkspaceReminders() {
  const { clientId } = useParams();
  const company = companies.find(c => c.id === clientId);

  const [reminderList, setReminderList] = useState(
    allReminders.filter(r => r.companyId === clientId)
  );
  const [showCreate, setShowCreate] = useState(false);
  const [filter, setFilter] = useState('active');
  const [form, setForm] = useState({ requestId: '', title: '', message: '', dueDate: '', priority: 'medium' });

  const clientRequests = requests.filter(r => r.companyId === clientId);
  const activeCount = reminderList.filter(r => r.status === 'active').length;
  const filtered = reminderList.filter(r => filter === 'all' || r.status === filter);

  const isOverdue = (date) => new Date(date) < new Date();

  const dismiss = (id) => setReminderList(list => list.map(r => r.id === id ? { ...r, status: 'dismissed' } : r));

  const handleCreate = () => {
    if (!form.title || !form.dueDate) return;
    const newRem = {
      id: `rem${Date.now()}`,
      requestId: form.requestId,
      companyId: clientId,
      companyName: company?.name,
      title: form.title,
      message: form.message,
      dueDate: form.dueDate,
      priority: form.priority,
      status: 'active',
      createdAt: new Date().toISOString().slice(0, 10),
    };
    setReminderList(list => [newRem, ...list]);
    setForm({ requestId: '', title: '', message: '', dueDate: '', priority: 'medium' });
    setShowCreate(false);
  };

  const priorityConfig = {
    high:   { color: '#C62026', bg: '#FEE2E2', label: 'High' },
    medium: { color: '#F68C1F', bg: '#FEF3C7', label: 'Medium' },
    low:    { color: '#00648F', bg: '#DBEAFE', label: 'Low' },
  };

  const iCls = 'w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#8BC53D]/40 focus:border-[#8BC53D] placeholder-[#A5A5A5]';
  const lCls = 'block text-xs font-semibold text-[#6D6E71] mb-1';

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#050505]">Reminders</h1>
          <p className="text-sm text-[#6D6E71] mt-0.5">
            {activeCount} active reminder{activeCount !== 1 ? 's' : ''} for {company?.name}
          </p>
        </div>
        <button onClick={() => setShowCreate(true)} className="flex items-center gap-2 px-5 py-2.5 bg-[#8BC53D] hover:bg-[#476E2C] text-white rounded-xl text-sm font-semibold transition-all duration-200 hover:scale-[1.02] shadow-md">
          <Plus size={15} />
          Add Reminder
        </button>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-2">
        {['active', 'dismissed', 'all'].map(f => (
          <button key={f} onClick={() => setFilter(f)}
            className={`px-4 py-2 rounded-xl text-xs font-semibold transition-all capitalize ${
              filter === f ? 'bg-[#05164D] text-white shadow-md' : 'bg-white text-[#6D6E71] hover:bg-gray-100 border border-gray-200'
            }`}>
            {f}
          </button>
        ))}
      </div>

      {/* Reminder cards */}
      <div className="space-y-3">
        {filtered.length === 0 ? (
          <div className="bg-white rounded-2xl shadow-card p-12 text-center">
            <Bell size={36} className="mx-auto mb-3 text-gray-200" />
            <p className="text-sm text-[#A5A5A5]">No {filter === 'all' ? '' : filter} reminders found.</p>
          </div>
        ) : filtered.map(rem => {
          const overdue = isOverdue(rem.dueDate) && rem.status === 'active';
          const pc = priorityConfig[rem.priority] || priorityConfig.medium;
          return (
            <div key={rem.id} className={`bg-white rounded-2xl shadow-card p-5 border-l-4 transition-all ${
              rem.status === 'dismissed' ? 'opacity-60' : overdue ? 'border-red-400' : 'border-[#8BC53D]'
            }`}
              style={{ borderLeftColor: overdue ? '#C62026' : pc.color }}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3 min-w-0">
                  <div className={`mt-0.5 flex-shrink-0 w-8 h-8 rounded-xl flex items-center justify-center`}
                    style={{ background: overdue ? '#FEE2E2' : pc.bg }}>
                    {overdue
                      ? <AlertCircle size={16} style={{ color: '#C62026' }} />
                      : rem.status === 'dismissed'
                        ? <CheckCircle size={16} className="text-gray-400" />
                        : <Clock size={16} style={{ color: pc.color }} />
                    }
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-semibold text-sm text-[#050505]">{rem.title}</p>
                      <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full" style={{ color: pc.color, background: pc.bg }}>
                        {pc.label}
                      </span>
                      {overdue && (
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-red-100 text-red-600">Overdue</span>
                      )}
                    </div>
                    {rem.message && <p className="text-xs text-[#6D6E71] mt-1">{rem.message}</p>}
                    <div className="flex items-center gap-3 mt-2">
                      <div className="flex items-center gap-1 text-xs text-[#A5A5A5]">
                        <Clock size={11} />
                        Due: {rem.dueDate}
                      </div>
                      {rem.requestId && (
                        <span className="text-xs text-[#05164D] bg-[#e8ecf7] px-2 py-0.5 rounded-lg">{rem.requestId}</span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 flex-shrink-0">
                  {rem.status === 'active' && (
                    <button
                      onClick={() => dismiss(rem.id)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold text-[#476E2C] bg-[#C9E4A4]/50 hover:bg-[#C9E4A4] transition-colors"
                    >
                      <CheckCircle size={12} />
                      Dismiss
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Add reminder modal */}
      <Modal isOpen={showCreate} onClose={() => setShowCreate(false)} title="Add Reminder" size="md">
        <div className="space-y-4">
          <div>
            <label className={lCls}>Title *</label>
            <input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} placeholder="e.g. KYC bundle follow-up" className={iCls} />
          </div>
          <div>
            <label className={lCls}>Linked Request (optional)</label>
            <select value={form.requestId} onChange={e => setForm(f => ({ ...f, requestId: e.target.value }))} className={iCls}>
              <option value="">No specific request</option>
              {clientRequests.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </div>
          <div>
            <label className={lCls}>Message</label>
            <textarea value={form.message} onChange={e => setForm(f => ({ ...f, message: e.target.value }))} rows={3} placeholder="Additional details..." className={`${iCls} resize-none`} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={lCls}>Due Date *</label>
              <input type="date" value={form.dueDate} onChange={e => setForm(f => ({ ...f, dueDate: e.target.value }))} className={iCls} />
            </div>
            <div>
              <label className={lCls}>Priority</label>
              <select value={form.priority} onChange={e => setForm(f => ({ ...f, priority: e.target.value }))} className={iCls}>
                {['high', 'medium', 'low'].map(p => <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>)}
              </select>
            </div>
          </div>
          <div className="flex gap-3 pt-1">
            <button onClick={() => setShowCreate(false)} className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm font-semibold text-[#6D6E71] hover:bg-gray-50 transition-colors">Cancel</button>
            <button onClick={handleCreate} className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl bg-[#8BC53D] text-white text-sm font-semibold hover:bg-[#476E2C] transition-colors">
              <Bell size={14} />
              Save Reminder
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
