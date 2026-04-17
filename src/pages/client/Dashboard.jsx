import { useNavigate } from 'react-router-dom';
import { ClipboardList, Upload, Bell, AlertCircle, ArrowRight, TrendingUp, Clock } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { requests, reminders, documents } from '../../data/mockData';
import StatusBadge from '../../components/common/StatusBadge';

const isCompletedStatus = (status) => ['approved', 'completed'].includes(status);

function mapProgressCategory(req) {
  const text = `${req.name} ${req.type}`.toLowerCase();
  if (text.includes('kyc') || text.includes('director') || text.includes('hr') || text.includes('employee')) return 'HR';
  if (text.includes('financial') || text.includes('bank') || text.includes('tax') || text.includes('revenue') || text.includes('trial balance') || text.includes('budget')) return 'Financial';
  return 'IT';
}

function progressPct(list) {
  if (!list.length) return 0;
  const completed = list.filter(r => isCompletedStatus(r.status)).length;
  return Math.round((completed / list.length) * 100);
}

export default function ClientDashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();

  // Client only sees Infosys requests
  const myRequests = requests.filter(r => r.companyId === 'co1');
  const myRequestIds = new Set(myRequests.map(r => r.id));
  const myDocs = documents.filter(d => myRequestIds.has(d.requestId));
  const myReminders = reminders.filter(r => r.companyId === 'co1' && r.status === 'active');

  const pendingCount = myRequests.filter(r => r.status === 'pending').length;
  const today = new Date().toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  const stats = [
    { label: 'Pending Requests', value: pendingCount, icon: ClipboardList, color: '#b45e08', bg: '#FAC086', cta: '/client/requests' },
    { label: 'Documents Uploaded', value: myDocs.length, icon: Upload, color: '#00648F', bg: '#A7DCF7', cta: '/client/upload' },
    { label: 'Active Reminders', value: myReminders.length, icon: Bell, color: '#742982', bg: '#DAAAE4', cta: '/client/reminders' },
  ];

  const categorized = {
    HR: myRequests.filter(r => mapProgressCategory(r) === 'HR'),
    Financial: myRequests.filter(r => mapProgressCategory(r) === 'Financial'),
    IT: myRequests.filter(r => mapProgressCategory(r) === 'IT'),
  };

  const progressCards = [
    { key: 'HR', color: '#742982', bg: '#DAAAE4' },
    { key: 'Financial', color: '#F68C1F', bg: '#FAC086' },
    { key: 'IT', color: '#00B0F0', bg: '#A7DCF7' },
  ].map(c => ({
    ...c,
    total: categorized[c.key].length,
    pct: progressPct(categorized[c.key]),
  }));

  const recentRequests = [...myRequests]
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    .slice(0, 5);

  const nextDue = myRequests
    .filter(r => r.status === 'pending' && r.dueDate)
    .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate))[0];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-[#050505]">Welcome, {user?.name?.split(' ')[0]} 👋</h1>
        <p className="text-sm text-[#6D6E71] mt-0.5">{today} · {user?.company}</p>
      </div>

      {/* Alert: next due */}
      {nextDue && (
        <div className="flex items-center gap-3 px-4 py-3 bg-[#FEF3C7] border border-[#8BC53D]/30 rounded-2xl">
          <AlertCircle size={18} className="text-[#8BC53D] flex-shrink-0" />
          <p className="text-sm text-[#476E2C] font-medium flex-1">
            Pending: <strong>"{nextDue.name}"</strong> due <strong>{nextDue.dueDate}</strong>
          </p>
          <button onClick={() => navigate('/client/requests')} className="text-xs font-semibold text-[#8BC53D] hover:text-[#476E2C] hover:underline whitespace-nowrap">
            Upload
          </button>
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {stats.map(s => (
          <div
            key={s.label}
            onClick={() => navigate(s.cta)}
            className="bg-white rounded-2xl p-5 shadow-card hover:shadow-hover transition-all duration-300 hover:-translate-y-0.5 cursor-pointer"
          >
            <div className="w-11 h-11 rounded-xl flex items-center justify-center mb-4" style={{ background: s.bg }}>
              <s.icon size={20} style={{ color: s.color }} />
            </div>
            <p className="text-3xl font-bold text-[#050505]">{s.value}</p>
            <p className="text-sm text-[#6D6E71] mt-0.5">{s.label}</p>
          </div>
        ))}
      </div>

      {/* Progress by Category */}
      <div className="bg-white rounded-2xl shadow-card overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h2 className="font-semibold text-[#050505]">Progress by Category</h2>
          <TrendingUp size={15} className="text-[#8BC53D]" />
        </div>
        <div className="space-y-4 p-4">
          {progressCards.map(cat => (
            <div key={cat.key}>
              <div className="flex items-center justify-between mb-1.5">
                <p className="text-sm font-semibold text-[#050505]">{cat.key}</p>
                <p className="text-xs font-bold" style={{ color: cat.color }}>{cat.pct}%</p>
              </div>
              <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                <div className="h-full rounded-full transition-all" style={{ width: `${cat.pct}%`, background: cat.color }} />
              </div>
              <p className="text-[11px] text-[#A5A5A5] mt-1">{cat.total} request(s)</p>
            </div>
          ))}
        </div>
      </div>

      {/* Recent Requests (only 5) */}
      <div className="bg-white rounded-2xl shadow-card overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h2 className="font-semibold text-[#050505]">Recent Requests</h2>
          <button onClick={() => navigate('/client/requests')} className="flex items-center gap-1 text-xs text-[#8BC53D] font-semibold hover:underline">
            View all <ArrowRight size={12} />
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[500px]">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50/50">
                {['Request Name', 'Type', 'Priority', 'Status', 'Due Date'].map(h => (
                  <th key={h} className="text-left text-xs font-semibold text-[#6D6E71] px-5 py-3">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {recentRequests.map(r => (
                <tr key={r.id} className="border-b border-gray-50 hover:bg-gray-50/70 transition-colors">
                  <td className="px-5 py-3.5">
                    <p className="text-sm font-medium text-[#050505]">{r.name}</p>
                  </td>
                  <td className="px-5 py-3.5">
                    <span className="text-xs font-medium text-[#742982] bg-[#DAAAE4]/30 px-2 py-1 rounded-lg">{r.type}</span>
                  </td>
                  <td className="px-5 py-3.5"><StatusBadge value={r.priority} variant="priority" size="xs" /></td>
                  <td className="px-5 py-3.5"><StatusBadge value={r.status} size="xs" /></td>
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-1">
                      <Clock size={11} className="text-[#A5A5A5]" />
                      <span className="text-xs text-[#6D6E71]">{r.dueDate}</span>
                    </div>
                  </td>
                </tr>
              ))}
              {recentRequests.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-10 text-center text-sm text-[#A5A5A5]">
                    No recent requests available.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
