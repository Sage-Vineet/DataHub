import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowRight, Bell, Briefcase, Building2, Clock,
  FileText, MessageSquare, ClipboardList, Users, Activity,
} from 'lucide-react';
import { listCompaniesRequest, listBrokerActivity } from '../../lib/api';

function normalizeCompany(company) {
  return {
    id: company.id,
    name: company.name,
    projectName: company.project_name || '',
    industry: company.industry,
    status: company.status,
    pendingCount: Number(company.pending_request_count || company.pendingCount || 0),
    completedCount: Number(company.completed_request_count || company.completedCount || 0),
    logo: company.logo || company.name?.slice(0, 2)?.toUpperCase(),
  };
}

const EVENT_ICON = {
  company_created: Building2,
  user_added: Users,
  document_uploaded: FileText,
  request_created: ClipboardList,
  request_narrative_updated: MessageSquare,
  reminder_sent: Bell,
  reminder_created: Bell,
  message_sent: MessageSquare,
  direct_message_sent: MessageSquare,
};

const EVENT_COLOR = {
  company_created: { bg: '#E8F3D8', tone: '#476E2C' },
  user_added: { bg: '#E5F4FB', tone: '#00648F' },
  document_uploaded: { bg: '#F2E6F6', tone: '#742982' },
  request_created: { bg: '#FFF1E2', tone: '#F68C1F' },
  request_narrative_updated: { bg: '#E8F3D8', tone: '#476E2C' },
};

function timeAgo(isoString) {
  if (!isoString) return '';
  const diff = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(isoString).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

export default function BrokerDashboard() {
  const navigate = useNavigate();
  const [companies, setCompanies] = useState([]);
  const [activity, setActivity] = useState([]);
  const [loadingCompanies, setLoadingCompanies] = useState(true);
  const [loadingActivity, setLoadingActivity] = useState(true);

  useEffect(() => {
    let cancelled = false;

    listCompaniesRequest()
      .then((payload) => { if (!cancelled) setCompanies(payload.map(normalizeCompany)); })
      .catch(() => { if (!cancelled) setCompanies([]); })
      .finally(() => { if (!cancelled) setLoadingCompanies(false); });

    listBrokerActivity(25)
      .then((payload) => { if (!cancelled) setActivity(payload); })
      .catch(() => { if (!cancelled) setActivity([]); })
      .finally(() => { if (!cancelled) setLoadingActivity(false); });

    return () => { cancelled = true; };
  }, []);

  const summary = useMemo(() => {
    const activeCompanies = companies.filter((c) => c.status === 'active').length;
    const pendingWorkspaces = companies.filter((c) => c.pendingCount > 0).length;
    const totalPendingRequests = companies.reduce((sum, c) => sum + c.pendingCount, 0);
    return { activeCompanies, pendingWorkspaces, totalPendingRequests };
  }, [companies]);

  const spotlightCompanies = useMemo(
    () => [...companies].sort((a, b) => (b.pendingCount || 0) - (a.pendingCount || 0)).slice(0, 5),
    [companies]
  );

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-[#050505]">Broker Dashboard</h1>

      <div className="grid gap-4 md:grid-cols-3">
        {[
          { label: 'Active Companies', value: summary.activeCompanies, icon: Building2, tone: '#476E2C', bg: '#E8F3D8' },
          { label: 'Workspaces Needing Attention', value: summary.pendingWorkspaces, icon: Briefcase, tone: '#00648F', bg: '#E5F4FB' },
          { label: 'Pending Requests', value: summary.totalPendingRequests, icon: Clock, tone: '#F68C1F', bg: '#FFF1E2' },
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
        {/* Workspace Spotlight */}
        <div className="rounded-2xl bg-white shadow-card">
          <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
            <div>
              <h2 className="font-semibold text-[#050505]">Workspace Spotlight</h2>
              <p className="mt-1 text-xs text-[#A5A5A5]">Companies that need broker attention first.</p>
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
                    {company.projectName && (
                      <span className="mb-0.5 inline-block rounded-full bg-[#05164D]/10 px-2 py-0.5 text-[10px] font-semibold text-[#05164D]">
                        {company.projectName}
                      </span>
                    )}
                    <p className="text-sm font-semibold text-[#050505]">{company.name}</p>
                    <p className="mt-0.5 text-xs text-[#6D6E71]">{company.industry}</p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-sm font-semibold text-[#050505]">{company.pendingCount} open</p>
                  <p className="mt-1 text-xs text-[#6D6E71]">{company.completedCount} completed</p>
                </div>
              </button>
            ))}
            {!loadingCompanies && spotlightCompanies.length === 0 && (
              <p className="px-5 py-10 text-center text-sm text-[#A5A5A5]">No companies available yet.</p>
            )}
          </div>
        </div>

        {/* Recent Activity */}
        <div className="rounded-2xl bg-white shadow-card flex flex-col">
          <div className="border-b border-gray-100 px-5 py-4">
            <h2 className="font-semibold text-[#050505]">Recent Activity</h2>
            <p className="mt-1 text-xs text-[#A5A5A5]">Latest events across all companies.</p>
          </div>

          <div className="flex-1 overflow-y-auto divide-y divide-gray-50">
            {loadingActivity && (
              <p className="px-5 py-10 text-center text-sm text-[#A5A5A5]">Loading activity…</p>
            )}
            {!loadingActivity && activity.length === 0 && (
              <div className="flex flex-col items-center gap-2 px-5 py-10 text-center">
                <Activity size={28} className="text-[#D1D5DB]" />
                <p className="text-sm text-[#A5A5A5]">No recent activity yet.</p>
              </div>
            )}
            {!loadingActivity && activity.map((event) => {
              const Icon = EVENT_ICON[event.type] || Activity;
              const color = EVENT_COLOR[event.type] || { bg: '#F3F4F6', tone: '#6D6E71' };
              return (
                <div key={event.id} className="flex items-start gap-3 px-5 py-3.5">
                  <div
                    className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
                    style={{ backgroundColor: color.bg }}
                  >
                    <Icon size={14} style={{ color: color.tone }} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-medium leading-snug text-[#050505] truncate">
                      {event.message}
                    </p>
                    <div className="mt-0.5 flex items-center gap-1.5 text-xs text-[#A5A5A5]">
                      {event.actor_name && (
                        <>
                          <span className="font-medium text-[#6D6E71]">{event.actor_name}</span>
                          <span>·</span>
                        </>
                      )}
                      {event.detail && (
                        <>
                          <span className="truncate max-w-[100px]">{event.detail}</span>
                          <span>·</span>
                        </>
                      )}
                      <span className="shrink-0">{timeAgo(event.created_at)}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
