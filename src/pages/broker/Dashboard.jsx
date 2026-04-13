import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, ArrowRight, Bell, Briefcase, Building2, Clock, Plus, RefreshCw, Send, TrendingUp } from 'lucide-react';
import { activities, reminders as mockReminders } from '../../data/mockData';
import { listCompaniesRequest } from '../../lib/api';

function normalizeCompany(company) {
  return {
    id: company.id,
    name: company.name,
    industry: company.industry,
    status: company.status,
    since: company.since,
    pendingCount: Number(company.pending_request_count || company.pendingCount || 0),
    completedCount: Number(company.completed_request_count || company.completedCount || 0),
    logo: company.logo || company.name?.slice(0, 2)?.toUpperCase(),
  };
}

export default function BrokerDashboard() {
  const navigate = useNavigate();
  const [companies, setCompanies] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    listCompaniesRequest()
      .then((payload) => {
        if (!cancelled) setCompanies(payload.map(normalizeCompany));
      })
      .catch(() => {
        if (!cancelled) setCompanies([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const summary = useMemo(() => {
    const activeCompanies = companies.filter((company) => company.status === 'active').length;
    const pendingWorkspaces = companies.filter((company) => company.pendingCount > 0).length;
    const totalPendingRequests = companies.reduce((sum, company) => sum + company.pendingCount, 0);
    const totalCompleted = companies.reduce((sum, company) => sum + company.completedCount, 0);
    const activeReminders = mockReminders.filter((item) => item.status === 'active').length;

    return {
      activeCompanies,
      pendingWorkspaces,
      totalPendingRequests,
      totalCompleted,
      activeReminders,
    };
  }, [companies]);

  const spotlightCompanies = useMemo(() => [...companies]
    .sort((a, b) => (b.pendingCount || 0) - (a.pendingCount || 0))
    .slice(0, 5), [companies]);

  const today = new Date().toLocaleDateString('en-IN', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[#050505]">Broker Dashboard</h1>
          <p className="mt-0.5 text-sm text-[#6D6E71]">{today}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => navigate('/broker/companies')}
            className="flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm font-semibold text-[#050505] shadow-sm"
          >
            <Building2 size={15} />
            Open Companies
          </button>
          <button
            onClick={() => navigate('/broker/companies')}
            className="flex items-center gap-2 rounded-xl bg-[#8BC53D] px-5 py-2.5 text-sm font-semibold text-white shadow-md"
          >
            <Plus size={15} />
            Add Company
          </button>
        </div>
      </div>

      {summary.totalPendingRequests > 0 && (
        <div className="flex items-center gap-3 rounded-2xl border border-[#F68C1F]/30 bg-[#FAC086]/40 px-4 py-3">
          <AlertCircle size={18} className="text-[#b45e08]" />
          <p className="text-sm font-medium text-[#b45e08]">
            <strong>{summary.totalPendingRequests} pending request(s)</strong> are currently open across company workspaces.
          </p>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-4">
        {[
          { label: 'Active Companies', value: summary.activeCompanies, icon: Building2, tone: '#476E2C', bg: '#E8F3D8' },
          { label: 'Workspaces Needing Attention', value: summary.pendingWorkspaces, icon: Briefcase, tone: '#00648F', bg: '#E5F4FB' },
          { label: 'Pending Requests', value: summary.totalPendingRequests, icon: Clock, tone: '#F68C1F', bg: '#FFF1E2' },
          { label: 'Active Reminders', value: summary.activeReminders, icon: Bell, tone: '#742982', bg: '#F2E6F6' },
        ].map((card) => (
          <div key={card.label} className="rounded-2xl bg-white p-5 shadow-card">
            <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl" style={{ backgroundColor: card.bg }}>
              <card.icon size={20} style={{ color: card.tone }} />
            </div>
            <p className="text-2xl font-bold text-[#050505]">{card.value}</p>
            <p className="mt-1 text-sm text-[#6D6E71]">{card.label}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-5 xl:grid-cols-[1.1fr_0.9fr]">
        <div className="rounded-2xl bg-white shadow-card">
          <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
            <div>
              <h2 className="font-semibold text-[#050505]">Workspace Spotlight</h2>
              <p className="mt-1 text-xs text-[#A5A5A5]">Jump into the companies that need broker attention first.</p>
            </div>
            <button
              onClick={() => navigate('/broker/companies')}
              className="flex items-center gap-1 text-xs font-semibold text-[#8BC53D] hover:underline"
            >
              View all <ArrowRight size={12} />
            </button>
          </div>
          <div className="divide-y divide-gray-50">
            {spotlightCompanies.map((company) => (
              <button
                key={company.id}
                onClick={() => navigate(`/broker/client/${company.id}/datahub-dashboard`, { state: { company } })}
                className="flex w-full items-center justify-between px-5 py-4 text-left transition-colors hover:bg-[#FAFBF7]"
              >
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#05164D] text-sm font-semibold text-white">
                    {company.logo}
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-[#050505]">{company.name}</p>
                    <p className="mt-1 text-xs text-[#6D6E71]">{company.industry}</p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-sm font-semibold text-[#050505]">{company.pendingCount} open</p>
                  <p className="mt-1 text-xs text-[#6D6E71]">{company.completedCount} completed</p>
                </div>
              </button>
            ))}
            {!loading && spotlightCompanies.length === 0 && (
              <p className="px-5 py-10 text-center text-sm text-[#A5A5A5]">No companies available yet.</p>
            )}
          </div>
        </div>

        <div className="space-y-5">
          <div className="rounded-2xl bg-white p-5 shadow-card">
            <h2 className="font-semibold text-[#050505]">Broker Actions</h2>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {[
                { label: 'Open Companies', icon: Building2, action: () => navigate('/broker/companies') },
                { label: 'Review Reminders', icon: Bell, action: () => navigate('/broker/reminders') },
                { label: 'Global Requests', icon: Send, action: () => navigate('/broker/requests') },
                { label: 'Documents', icon: TrendingUp, action: () => navigate('/broker/documents') },
              ].map((item) => (
                <button
                  key={item.label}
                  onClick={item.action}
                  className="flex items-center gap-3 rounded-xl border border-gray-100 px-4 py-4 text-left transition-all hover:border-[#8BC53D]/50 hover:bg-[#F8FBF1]"
                >
                  <item.icon size={18} className="text-[#8BC53D]" />
                  <span className="text-sm font-semibold text-[#050505]">{item.label}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-2xl bg-white shadow-card">
            <div className="border-b border-gray-100 px-5 py-4">
              <h2 className="font-semibold text-[#050505]">Recent Activity</h2>
            </div>
            <div className="p-4 space-y-3">
              {activities.slice(0, 4).map((item) => (
                <div key={item.id} className="flex items-start gap-3">
                  <div className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-xl bg-[#EEF6E0]">
                    <RefreshCw size={14} className="text-[#8BC53D]" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-[#050505]">{item.message}</p>
                    <p className="mt-1 text-xs text-[#A5A5A5]">{item.time}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
