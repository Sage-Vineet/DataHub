import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  AlertCircle,
  ArrowRight,
  Bell,
  CheckCircle2,
  Building2,
  CheckCircle,
  ClipboardList,
  Clock,
  FolderOpen,
  Link2,
  Receipt,
  RefreshCw,
  Send,
  TrendingUp,
  Users,
} from 'lucide-react';
import { getCompanyRequest, listCompanyActivity, listCompanyReminders, listCompanyRequests } from '../../../lib/api';
import { fetchQuickbooksInvoices, formatCurrency, getConnectionStatus } from '../../../lib/quickbooks';
import StatusBadge from '../../../components/common/StatusBadge';
import { useToast } from '../../../context/ToastContext';

function matchesCompany(invoice, companyName) {
  const customerName = `${invoice?.CustomerRef?.name || ''}`.toLowerCase();
  const target = `${companyName || ''}`.toLowerCase();
  return customerName && target && (customerName.includes(target) || target.includes(customerName));
}

export default function WorkspaceDashboard() {
  const { clientId } = useParams();
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [company, setCompany] = useState(null);
  const [requests, setRequests] = useState([]);
  const [reminders, setReminders] = useState([]);
  const [activityFeed, setActivityFeed] = useState([]);
  const [loading, setLoading] = useState(true);
  const [financeConnected, setFinanceConnected] = useState(false);
  const [financeError, setFinanceError] = useState('');
  const [workspaceInvoices, setWorkspaceInvoices] = useState([]);

  useEffect(() => {
    let cancelled = false;

    async function loadWorkspace() {
      setLoading(true);
      try {
        const companyPayload = await getCompanyRequest(clientId);
        if (cancelled) return;
        setCompany(companyPayload);

        const [requestPayload, reminderPayload, activityPayload] = await Promise.all([
          listCompanyRequests(clientId).catch(() => []),
          listCompanyReminders(clientId).catch(() => []),
          listCompanyActivity(clientId).catch(() => []),
        ]);
        if (!cancelled) {
          setRequests(requestPayload);
          setReminders(reminderPayload);
          setActivityFeed(activityPayload);
        }

        try {
          const connection = await getConnectionStatus();
          if (!cancelled) setFinanceConnected(connection.isConnected);
          if (connection.isConnected) {
            const invoicePayload = await fetchQuickbooksInvoices();
            const scoped = (invoicePayload?.QueryResponse?.Invoice || []).filter((invoice) =>
              matchesCompany(invoice, companyPayload.name)
            );
            if (!cancelled) setWorkspaceInvoices(scoped);
          }
        } catch (error) {
          if (!cancelled) {
            setFinanceConnected(false);
            setFinanceError(error.message || 'Unable to load finance data.');
          }
        }
      } catch {
        if (!cancelled) {
          setCompany(null);
          setRequests([]);
          setReminders([]);
          setActivityFeed([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadWorkspace();
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  const activeReminders = useMemo(
    () => reminders.filter((item) => item.status === 'active' || item.status === 'due'),
    [reminders]
  );

  const requestSummary = useMemo(() => {
    const pending = requests.filter((item) => item.status === 'pending').length;
    const inReview = requests.filter((item) => item.status === 'in-review').length;
    const completed = requests.filter((item) => item.status === 'completed').length;
    const overdue = requests.filter((item) => item.status !== 'completed' && new Date(item.due_date || item.dueDate) < new Date()).length;

    return { pending, inReview, completed, overdue };
  }, [requests]);

  const invoiceSummary = useMemo(() => workspaceInvoices.reduce((summary, invoice) => {
    const amount = Number(invoice.TotalAmt || 0);
    const balance = Number(invoice.Balance || 0);
    summary.total += amount;
    summary.outstanding += balance;
    summary.count += 1;
    return summary;
  }, { total: 0, outstanding: 0, count: 0 }), [workspaceInvoices]);

  const recentRequests = useMemo(() => [...requests]
    .sort((a, b) => new Date(b.created_at || b.createdAt || 0) - new Date(a.created_at || a.createdAt || 0))
    .slice(0, 5), [requests]);

  const recentActivity = useMemo(() => activityFeed.slice(0, 4), [activityFeed]);

  const dataroomSummary = useMemo(() => ({
    openRequests: requestSummary.pending + requestSummary.inReview,
    activeReminders: activeReminders.length,
    activityEntries: activityFeed.length,
  }), [activeReminders.length, activityFeed.length, requestSummary.inReview, requestSummary.pending]);

  useEffect(() => {
    if (!financeError) return;
    showToast({
      type: 'error',
      title: 'Finance Sync Notice',
      message: financeError,
    });
  }, [financeError, showToast]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[#050505]">{company?.name || 'Company'} Dashboard</h1>
          <p className="mt-0.5 text-sm text-[#6D6E71]">
            Merged company workspace view across DataRoom operations and Data Hub finance tools.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => navigate(`/broker/client/${clientId}/connections`)}
            className="flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm font-semibold text-[#050505]"
          >
            <Link2 size={15} />
            {financeConnected ? 'Manage Connection' : 'Connect QuickBooks'}
          </button>
          <button
            onClick={() => navigate(`/broker/client/${clientId}/dataroom/requests`)}
            className="flex items-center gap-2 rounded-xl bg-[#8BC53D] px-5 py-2.5 text-sm font-semibold text-white shadow-md"
          >
            <Send size={15} />
            New Request
          </button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        {[
          { label: 'Open Requests', value: requestSummary.pending + requestSummary.inReview, icon: ClipboardList, tone: '#05164D', bg: '#E8ECF7' },
          { label: 'Active Reminders', value: activeReminders.length, icon: Bell, tone: '#742982', bg: '#F2E6F6' },
          { label: 'Invoices Synced', value: financeConnected ? invoiceSummary.count : 'Not connected', icon: Receipt, tone: '#00648F', bg: '#E5F4FB' },
          { label: 'Outstanding Balance', value: financeConnected ? formatCurrency(invoiceSummary.outstanding) : '-', icon: TrendingUp, tone: '#476E2C', bg: '#E8F3D8' },
        ].map((card) => (
          <div key={card.label} className="rounded-2xl bg-white p-5 shadow-card">
            <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl" style={{ background: card.bg }}>
              <card.icon size={20} style={{ color: card.tone }} />
            </div>
            <p className="text-2xl font-bold text-[#050505]">{card.value}</p>
            <p className="mt-1 text-sm text-[#6D6E71]">{card.label}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-5 xl:grid-cols-[1.15fr_0.85fr]">
        <div className="space-y-5">
          <div className="rounded-2xl bg-white p-5 shadow-card">
            <div className="mb-5 flex items-center justify-between">
              <div>
                <h2 className="font-semibold text-[#050505]">DataRoom Overview</h2>
                <p className="mt-1 text-xs text-[#A5A5A5]">Live requests, reminders, and workspace activity for this company only.</p>
              </div>
              <button
                onClick={() => navigate(`/broker/client/${clientId}/dataroom/requests`)}
                className="text-xs font-semibold text-[#8BC53D] hover:underline"
              >
                Open DataRoom
              </button>
            </div>
            <div className="grid gap-4 md:grid-cols-3">
              <div className="rounded-xl border border-gray-100 p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#6D6E71]">Open Requests</p>
                <p className="mt-3 text-2xl font-bold text-[#050505]">{dataroomSummary.openRequests}</p>
              </div>
              <div className="rounded-xl border border-gray-100 p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#6D6E71]">Active Reminders</p>
                <p className="mt-3 text-2xl font-bold text-[#050505]">{dataroomSummary.activeReminders}</p>
              </div>
              <div className="rounded-xl border border-gray-100 p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#6D6E71]">Activity Entries</p>
                <p className="mt-3 text-2xl font-bold text-[#050505]">{dataroomSummary.activityEntries}</p>
              </div>
            </div>
          </div>

          <div className="rounded-2xl bg-white shadow-card overflow-hidden">
            <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
              <h2 className="font-semibold text-[#050505]">Recent Requests</h2>
              <button
                onClick={() => navigate(`/broker/client/${clientId}/dataroom/requests`)}
                className="flex items-center gap-1 text-xs font-semibold text-[#8BC53D] hover:underline"
              >
                View all <ArrowRight size={12} />
              </button>
            </div>
            <div className="divide-y divide-gray-50">
              {recentRequests.length > 0 ? recentRequests.map((request) => (
                <div key={request.id} className="flex items-center justify-between px-5 py-3.5 hover:bg-gray-50/80 transition-colors">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-[#050505]">{request.title || request.name}</p>
                    <p className="mt-1 text-xs text-[#A5A5A5]">{request.category} • Due {request.due_date || request.dueDate}</p>
                  </div>
                  <StatusBadge value={request.status} size="xs" />
                </div>
              )) : (
                <p className="px-5 py-10 text-center text-sm text-[#A5A5A5]">{loading ? 'Loading requests...' : 'No requests yet.'}</p>
              )}
            </div>
          </div>
        </div>

        <div className="space-y-5">
          <div className="rounded-2xl bg-white p-5 shadow-card">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="font-semibold text-[#050505]">Finance Snapshot</h2>
                <p className="mt-1 text-xs text-[#A5A5A5]">Company-level finance cues from the merged Data Hub layer.</p>
              </div>
              {financeConnected && (
                <button
                  onClick={() => navigate(`/broker/client/${clientId}/invoices`)}
                  className="text-xs font-semibold text-[#00648F] hover:underline"
                >
                  Open invoices
                </button>
              )}
            </div>
            {financeConnected ? (
              <div className="space-y-3">
                <div className="rounded-xl border border-gray-100 p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#6D6E71]">Invoice Value</p>
                  <p className="mt-2 text-2xl font-bold text-[#050505]">{formatCurrency(invoiceSummary.total)}</p>
                </div>
                <div className="rounded-xl border border-gray-100 p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#6D6E71]">Outstanding Balance</p>
                  <p className="mt-2 text-2xl font-bold text-[#050505]">{formatCurrency(invoiceSummary.outstanding)}</p>
                </div>
                <div className="rounded-xl border border-gray-100 p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#6D6E71]">Workspace Invoices</p>
                  <p className="mt-2 text-2xl font-bold text-[#050505]">{invoiceSummary.count}</p>
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-gray-300 p-4 text-sm text-[#6D6E71]">
                Connect QuickBooks from the Connections tab to unlock invoices, reports, and reconciliation for this company workspace.
              </div>
            )}
          </div>

          <div className="rounded-2xl bg-white shadow-card">
            <div className="border-b border-gray-100 px-5 py-4">
              <h2 className="font-semibold text-[#050505]">Recent Activity</h2>
            </div>
            <div className="p-4 space-y-3">
              {recentActivity.length > 0 ? recentActivity.map((item) => (
                <div key={item.id} className="flex items-start gap-3">
                  <div className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-xl bg-[#EEF6E0]">
                    {item.type === 'approved'
                      ? <CheckCircle2 size={14} className="text-[#476E2C]" />
                      : item.type === 'reminder'
                        ? <Bell size={14} className="text-[#742982]" />
                        : <RefreshCw size={14} className="text-[#8BC53D]" />}
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-[#050505]">{item.message}</p>
                    <p className="mt-1 text-xs text-[#A5A5A5]">
                      {item.created_at ? new Date(item.created_at).toLocaleString('en-IN') : item.time || 'Recently'}
                    </p>
                  </div>
                </div>
              )) : (
                <p className="text-sm text-[#A5A5A5]">No activity logged for this company yet.</p>
              )}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-5 shadow-card">
            <h2 className="font-semibold text-[#050505]">Quick Info</h2>
            <div className="mt-3 space-y-3">
              {[
                { label: 'Industry', value: company?.industry || 'N/A', icon: Building2 },
                { label: 'Workspace Users', value: 'See DataRoom / Users', icon: Users },
                { label: 'Documents', value: 'See DataRoom / Documents', icon: FolderOpen },
                { label: 'Completed Requests', value: requestSummary.completed, icon: CheckCircle },
                { label: 'Overdue Requests', value: requestSummary.overdue, icon: Clock },
              ].map((item) => (
                <div key={item.label} className="flex items-center justify-between rounded-xl border border-gray-100 px-4 py-3">
                  <span className="flex items-center gap-2 text-sm text-[#6D6E71]">
                    <item.icon size={14} />
                    {item.label}
                  </span>
                  <span className="text-sm font-semibold text-[#050505]">{item.value}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {requestSummary.overdue > 0 && (
        <div className="flex items-center gap-3 rounded-2xl border border-[#F68C1F]/30 bg-[#FAC086]/40 px-4 py-3">
          <AlertCircle size={18} className="text-[#b45e08]" />
          <p className="text-sm font-medium text-[#b45e08]">
            <strong>{requestSummary.overdue} overdue request(s)</strong> need follow-up in this company workspace.
          </p>
        </div>
      )}
    </div>
  );
}
