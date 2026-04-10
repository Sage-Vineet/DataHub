import { useState } from 'react';
import { Bell, Plus, Clock, CheckCircle, AlertCircle, Trash2, ChevronDown } from 'lucide-react';
import { reminders as initReminders, companies, requests } from '../../data/mockData';
import StatusBadge from '../../components/common/StatusBadge';
import Modal from '../../components/common/Modal';

const priorityColors = { high: '#C62026', medium: '#F68C1F', low: '#00648F' };
const priorityBg = { high: '#FEE2E2', medium: '#FAC086', low: '#A7DCF7' };

export default function BrokerReminders() {
  const [reminderList, setReminderList] = useState(initReminders);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ companyId: '', requestId: '', title: '', message: '', dueDate: '', priority: 'medium' });
  const [filter, setFilter] = useState('active');

  const dismiss = (id) => {
    setReminderList(list => list.map(r => r.id === id ? { ...r, status: 'dismissed' } : r));
  };

  const filtered = reminderList.filter(r => filter === 'all' || r.status === filter);
  const activeCount = reminderList.filter(r => r.status === 'active').length;

  const handleCreate = () => {
    const co = companies.find(c => c.id === form.companyId);
    if (!co || !form.title || !form.dueDate) return;
    const newRem = {
      id: `rem${Date.now()}`,
      ...form,
      companyName: co.name,
      status: 'active',
      createdAt: new Date().toISOString().slice(0, 10),
    };
    setReminderList(list => [newRem, ...list]);
    setForm({ companyId: '', requestId: '', title: '', message: '', dueDate: '', priority: 'medium' });
    setShowCreate(false);
  };

  const relatedRequests = form.companyId
    ? requests.filter(r => r.companyId === form.companyId)
    : [];

  const isOverdue = (date) => new Date(date) < new Date();

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#050505]">Reminders</h1>
          <p className="text-sm text-[#6D6E71] mt-0.5">
            {activeCount} active reminder{activeCount !== 1 ? 's' : ''} — never miss a follow-up
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 px-5 py-2.5 bg-[#8BC53D] hover:bg-[#476E2C] text-white rounded-xl text-sm font-semibold transition-all duration-200 hover:scale-[1.02] shadow-md"
        >
          <Plus size={15} />
          Add Reminder
        </button>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: 'Active', value: reminderList.filter(r => r.status === 'active').length, color: '#476E2C', bg: '#C9E4A4', icon: Bell },
          { label: 'Overdue', value: reminderList.filter(r => r.status === 'active' && isOverdue(r.dueDate)).length, color: '#C62026', bg: '#FEE2E2', icon: AlertCircle },
          { label: 'Dismissed', value: reminderList.filter(r => r.status === 'dismissed').length, color: '#6D6E71', bg: '#f3f4f6', icon: CheckCircle },
        ].map(s => (
          <div key={s.label} className="bg-white rounded-2xl p-4 shadow-card flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl flex items-center justify-center" style={{ background: s.bg }}>
              <s.icon size={22} style={{ color: s.color }} />
            </div>
            <div>
              <p className="text-2xl font-bold" style={{ color: s.color }}>{s.value}</p>
              <p className="text-xs text-[#A5A5A5]">{s.label}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex gap-2">
        {['active', 'dismissed', 'all'].map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-4 py-2 rounded-xl text-xs font-semibold capitalize transition-all ${
              filter === f ? 'bg-[#05164D] text-white' : 'bg-white text-[#6D6E71] border border-gray-200 hover:bg-gray-50'
            }`}
          >
            {f}
          </button>
        ))}
      </div>

      {/* Reminder Cards */}
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {filtered.length === 0 ? (
          <div className="col-span-full text-center py-16 text-[#A5A5A5]">
            <Bell size={40} className="mx-auto mb-3 opacity-30" />
            <p className="text-sm">No reminders found.</p>
          </div>
        ) : filtered.map(rem => {
          const overdue = isOverdue(rem.dueDate) && rem.status === 'active';
          return (
            <div
              key={rem.id}
              className={`bg-white rounded-2xl shadow-card p-5 border-l-4 transition-all hover:shadow-hover ${rem.status === 'dismissed' ? 'opacity-60' : ''}`}
              style={{ borderLeftColor: rem.status === 'dismissed' ? '#A5A5A5' : priorityColors[rem.priority] }}
            >
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-xl flex items-center justify-center" style={{ background: priorityBg[rem.priority] }}>
                    <Bell size={15} style={{ color: priorityColors[rem.priority] }} />
                  </div>
                  <StatusBadge value={rem.priority} variant="priority" size="xs" />
                </div>
                {rem.status === 'active' && (
                  <button
                    onClick={() => dismiss(rem.id)}
                    className="p-1.5 rounded-lg hover:bg-gray-100 text-[#A5A5A5] hover:text-[#6D6E71] transition-colors"
                    title="Dismiss"
                  >
                    <CheckCircle size={15} />
                  </button>
                )}
              </div>

              <h3 className="font-semibold text-[#050505] text-sm mb-1">{rem.title}</h3>
              <p className="text-xs text-[#6D6E71] line-clamp-2 mb-3">{rem.message}</p>

              <div className="flex items-center justify-between pt-3 border-t border-gray-100">
                <div className="flex items-center gap-1.5">
                  <div className="w-5 h-5 rounded-full bg-[#05164D] flex items-center justify-center text-[7px] font-bold text-white">
                    {rem.companyName.slice(0, 2).toUpperCase()}
                  </div>
                  <span className="text-xs text-[#6D6E71]">{rem.companyName}</span>
                </div>
                <div className={`flex items-center gap-1 text-xs font-medium ${overdue ? 'text-[#C62026]' : 'text-[#6D6E71]'}`}>
                  {overdue ? <AlertCircle size={12} /> : <Clock size={12} />}
                  {overdue ? 'Overdue' : rem.dueDate}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Create Reminder Modal */}
      <Modal isOpen={showCreate} onClose={() => setShowCreate(false)} title="Add New Reminder">
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-[#050505] mb-1.5">Client Company *</label>
            <select
              value={form.companyId}
              onChange={e => setForm(f => ({ ...f, companyId: e.target.value, requestId: '' }))}
              className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#8BC53D]/40 focus:border-[#8BC53D]"
            >
              <option value="">Select company...</option>
              {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>

          {relatedRequests.length > 0 && (
            <div>
              <label className="block text-sm font-medium text-[#050505] mb-1.5">Related Request (Optional)</label>
              <select
                value={form.requestId}
                onChange={e => setForm(f => ({ ...f, requestId: e.target.value }))}
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#8BC53D]/40 focus:border-[#8BC53D]"
              >
                <option value="">None</option>
                {relatedRequests.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-[#050505] mb-1.5">Reminder Title *</label>
            <input
              value={form.title}
              onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
              placeholder="e.g. KYC documents due soon"
              className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#8BC53D]/40 focus:border-[#8BC53D] placeholder-[#A5A5A5]"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-[#050505] mb-1.5">Message</label>
            <textarea
              value={form.message}
              onChange={e => setForm(f => ({ ...f, message: e.target.value }))}
              rows={3}
              placeholder="Reminder details..."
              className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#8BC53D]/40 focus:border-[#8BC53D] resize-none placeholder-[#A5A5A5]"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-[#050505] mb-1.5">Due Date *</label>
              <input
                type="date"
                value={form.dueDate}
                onChange={e => setForm(f => ({ ...f, dueDate: e.target.value }))}
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#8BC53D]/40 focus:border-[#8BC53D]"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-[#050505] mb-1.5">Priority</label>
              <select
                value={form.priority}
                onChange={e => setForm(f => ({ ...f, priority: e.target.value }))}
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#8BC53D]/40 focus:border-[#8BC53D]"
              >
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </div>
          </div>

          <div className="flex gap-3 pt-1">
            <button onClick={() => setShowCreate(false)} className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm font-semibold text-[#6D6E71] hover:bg-gray-50 transition-colors">
              Cancel
            </button>
            <button
              onClick={handleCreate}
              className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl bg-[#742982] text-white text-sm font-semibold hover:bg-[#5a1f65] transition-colors"
            >
              <Bell size={14} />
              Set Reminder
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
