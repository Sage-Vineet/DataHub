import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertCircle,
  ArrowRight,
  Bell,
  CheckCircle2,
  ClipboardList,
  Clock,
  FileText,
  FolderKanban,
  Loader2,
  TrendingUp,
  Upload,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import {
  getCompanyRequest,
  listCompanyActivity,
  listCompanyFolders,
  listCompanyReminders,
  listCompanyRequests,
  listRequestDocuments,
} from '../../lib/api';

const REQUEST_STATUS_META = {
  pending: { label: 'Pending', tone: '#A86F0B', bg: '#FEF3C7' },
  'in-review': { label: 'In Review', tone: '#2563EB', bg: '#DBEAFE' },
  completed: { label: 'Completed', tone: '#166534', bg: '#DCFCE7' },
  blocked: { label: 'Blocked', tone: '#991B1B', bg: '#FEE2E2' },
  overdue: { label: 'Overdue', tone: '#B91C1C', bg: '#FEE2E2' },
};

const REMINDER_STATUS_META = {
  due: { label: 'Needs Attention', tone: '#B91C1C', bg: '#FEE2E2' },
  active: { label: 'Scheduled', tone: '#2563EB', bg: '#DBEAFE' },
  blocked: { label: 'Blocked', tone: '#991B1B', bg: '#FEE2E2' },
  resolved: { label: 'Resolved', tone: '#166534', bg: '#DCFCE7' },
};

const CATEGORY_COLORS = ['#8BC53D', '#00648F', '#F68C1F', '#742982', '#476E2C', '#00B0F0', '#05164D'];
const DASHBOARD_CACHE_TTL_MS = 60 * 1000;
const REFRESH_THROTTLE_MS = 30 * 1000;

function getDashboardCacheKey(companyId) {
  return `client-dashboard:${companyId}`;
}

function readDashboardCache(companyId) {
  if (!companyId || typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(getDashboardCacheKey(companyId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.savedAt || Date.now() - parsed.savedAt > DASHBOARD_CACHE_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeDashboardCache(companyId, payload) {
  if (!companyId || typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(
      getDashboardCacheKey(companyId),
      JSON.stringify({ ...payload, savedAt: Date.now() }),
    );
  } catch {
    // Ignore cache write failures and keep dashboard functional.
  }
}

function normalizeWorkflowStatus(status) {
  if (['awaiting-review', 'in-progress', 'submitted', 'in-review'].includes(status)) return 'in-review';
  if (status === 'completed') return 'completed';
  if (status === 'blocked') return 'blocked';
  return 'pending';
}

function getDisplayStatus(status, dueDate) {
  if (status === 'blocked') return 'blocked';
  if (status === 'completed') return 'completed';
  if (dueDate) {
    const due = new Date(dueDate);
    if (!Number.isNaN(due.getTime()) && due < new Date()) {
      return 'overdue';
    }
  }
  return status;
}

function formatDate(value, options = {}) {
  if (!value) return 'Not set';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not set';
  return date.toLocaleDateString('en-IN', options.year
    ? options
    : { year: 'numeric', month: 'short', day: 'numeric', ...options });
}

function formatDateTime(value) {
  if (!value) return 'Not available';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not available';
  return date.toLocaleString('en-IN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function StatusPill({ status, metaMap }) {
  const meta = metaMap[status] || metaMap.pending || metaMap.active;
  return (
    <span
      className="inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold"
      style={{ backgroundColor: meta.bg, color: meta.tone }}
    >
      {meta.label}
    </span>
  );
}

export default function ClientDashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const companyId = user?.company_id || user?.companyId || null;

  const [company, setCompany] = useState(null);
  const [requests, setRequests] = useState([]);
  const [reminders, setReminders] = useState([]);
  const [folders, setFolders] = useState([]);
  const [activity, setActivity] = useState([]);
  const [documentCount, setDocumentCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const requestSequenceRef = useRef(0);
  const lastRefreshAtRef = useRef(0);

  const loadDashboard = useCallback(async ({ preferCache = true } = {}) => {
    const requestSequence = requestSequenceRef.current + 1;
    requestSequenceRef.current = requestSequence;

    if (!companyId) {
      setCompany(null);
      setRequests([]);
      setReminders([]);
      setFolders([]);
      setActivity([]);
      setDocumentCount(0);
      setLoading(false);
      return;
    }

    let showingCachedData = false;

    if (preferCache) {
      const cached = readDashboardCache(companyId);
      if (cached) {
        setCompany(cached.company || null);
        setRequests(Array.isArray(cached.requests) ? cached.requests : []);
        setReminders(Array.isArray(cached.reminders) ? cached.reminders : []);
        setFolders(Array.isArray(cached.folders) ? cached.folders : []);
        setActivity(Array.isArray(cached.activity) ? cached.activity : []);
        setDocumentCount(Number.isFinite(cached.documentCount) ? cached.documentCount : 0);
        setLoading(false);
        showingCachedData = true;
      } else {
        setLoading(true);
      }
    } else {
      setLoading(true);
    }

    if (!showingCachedData) setLoading(true);
    setError('');
    try {
      const [
        companyResult,
        requestsResult,
        remindersResult,
        foldersResult,
        activityResult,
      ] = await Promise.allSettled([
        getCompanyRequest(companyId).catch(() => null),
        listCompanyRequests(companyId),
        listCompanyReminders(companyId).catch(() => []),
        listCompanyFolders(companyId).catch(() => []),
        listCompanyActivity(companyId).catch(() => []),
      ]);

      if (requestSequenceRef.current !== requestSequence) return;

      const companyPayload = companyResult.status === 'fulfilled' ? companyResult.value : null;
      const requestRows = requestsResult.status === 'fulfilled' ? requestsResult.value : [];
      const reminderRows = remindersResult.status === 'fulfilled' ? remindersResult.value : [];
      const folderRows = foldersResult.status === 'fulfilled' ? foldersResult.value : [];
      const activityRows = activityResult.status === 'fulfilled' ? activityResult.value : [];

      if (requestsResult.status !== 'fulfilled') {
        throw new Error(requestsResult.reason?.message || 'Unable to load dashboard.');
      }

      const normalizedRequests = requestRows.map((request) => {
        const workflowStatus = normalizeWorkflowStatus(request.status);
        return {
          id: request.id,
          name: request.title || 'Untitled Request',
          category: request.category || 'Other',
          responseType: request.response_type || 'Narrative',
          priority: request.priority || 'medium',
          dueDate: request.due_date ? request.due_date.slice(0, 10) : '',
          createdAt: request.created_at || '',
          updatedAt: request.updated_at || request.created_at || '',
          workflowStatus,
          displayStatus: getDisplayStatus(workflowStatus, request.due_date),
          visible: request.visible !== false,
        };
      });

      setCompany(companyPayload);
      setRequests(normalizedRequests);
      setReminders(reminderRows);
      setFolders(folderRows);
      setActivity(activityRows);

      const requestSignature = normalizedRequests
        .map((request) => `${request.id}:${request.updatedAt || request.createdAt || ''}`)
        .join('|');
      const cached = preferCache ? readDashboardCache(companyId) : null;
      const hasMatchingDocumentCount = cached?.requestSignature === requestSignature && Number.isFinite(cached?.documentCount);

      if (hasMatchingDocumentCount) {
        setDocumentCount(cached.documentCount);
      } else {
        setDocumentCount(0);
      }

      writeDashboardCache(companyId, {
        company: companyPayload,
        requests: normalizedRequests,
        reminders: reminderRows,
        folders: folderRows,
        activity: activityRows,
        documentCount: hasMatchingDocumentCount ? cached.documentCount : 0,
        requestSignature,
      });

      setLoading(false);

      if (!normalizedRequests.length) {
        setDocumentCount(0);
        writeDashboardCache(companyId, {
          company: companyPayload,
          requests: normalizedRequests,
          reminders: reminderRows,
          folders: folderRows,
          activity: activityRows,
          documentCount: 0,
          requestSignature,
        });
        return;
      }

      const documentLists = await Promise.all(
        normalizedRequests.map((request) => listRequestDocuments(request.id).catch(() => [])),
      );

      if (requestSequenceRef.current !== requestSequence) return;

      const totalDocuments = documentLists.reduce((sum, docs) => sum + docs.length, 0);
      setDocumentCount(totalDocuments);
      writeDashboardCache(companyId, {
        company: companyPayload,
        requests: normalizedRequests,
        reminders: reminderRows,
        folders: folderRows,
        activity: activityRows,
        documentCount: totalDocuments,
        requestSignature,
      });
    } catch (err) {
      if (requestSequenceRef.current !== requestSequence) return;
      setError(err.message || 'Unable to load dashboard.');
    } finally {
      if (requestSequenceRef.current === requestSequence) {
        setLoading(false);
      }
    }
  }, [companyId]);

  useEffect(() => {
    loadDashboard();
  }, [loadDashboard]);

  useEffect(() => {
    if (!companyId) return undefined;
    const refreshOnReturn = () => {
      const now = Date.now();
      if (document.visibilityState === 'visible' && now - lastRefreshAtRef.current > REFRESH_THROTTLE_MS) {
        lastRefreshAtRef.current = now;
        loadDashboard({ preferCache: true });
      }
    };
    window.addEventListener('focus', refreshOnReturn);
    document.addEventListener('visibilitychange', refreshOnReturn);
    return () => {
      window.removeEventListener('focus', refreshOnReturn);
      document.removeEventListener('visibilitychange', refreshOnReturn);
    };
  }, [companyId, loadDashboard]);

  const todayLabel = useMemo(
    () => new Date().toLocaleDateString('en-IN', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    }),
    [],
  );

  const requestSummary = useMemo(() => ({
    pending: requests.filter((request) => request.displayStatus === 'pending' || request.displayStatus === 'overdue').length,
    inReview: requests.filter((request) => request.displayStatus === 'in-review').length,
    completed: requests.filter((request) => request.displayStatus === 'completed').length,
    overdue: requests.filter((request) => request.displayStatus === 'overdue').length,
  }), [requests]);

  const reminderSummary = useMemo(() => ({
    due: reminders.filter((item) => item.status === 'due').length,
    active: reminders.filter((item) => item.status === 'active').length,
  }), [reminders]);

  const completionPct = requests.length
    ? Math.round((requestSummary.completed / requests.length) * 100)
    : 0;

  const stats = [
    { label: 'Pending Requests', value: requestSummary.pending + requestSummary.inReview, icon: ClipboardList, color: '#A86F0B', bg: '#FEF3C7', cta: '/client/requests' },
    { label: 'Documents Shared', value: documentCount, icon: Upload, color: '#00648F', bg: '#DBF0FB', cta: '/client/upload' },
    { label: 'Total Folders', value: folders.length, icon: FolderKanban, color: '#742982', bg: '#F3E8FF', cta: '/client/documents' },
    { label: 'Reminders Due', value: reminderSummary.due, icon: Bell, color: '#B91C1C', bg: '#FEE2E2', cta: '/client/reminders' },
  ];

  const nextDueRequest = useMemo(
    () => [...requests]
      .filter((request) => ['pending', 'overdue'].includes(request.displayStatus) && request.dueDate)
      .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate))[0],
    [requests],
  );

  const categoryProgress = useMemo(() => {
    const grouped = requests.reduce((acc, request) => {
      const key = request.category || 'Other';
      if (!acc[key]) acc[key] = [];
      acc[key].push(request);
      return acc;
    }, {});

    return Object.entries(grouped)
      .map(([category, items], index) => {
        const completed = items.filter((item) => item.displayStatus === 'completed').length;
        return {
          category,
          total: items.length,
          pct: items.length ? Math.round((completed / items.length) * 100) : 0,
          color: CATEGORY_COLORS[index % CATEGORY_COLORS.length],
        };
      })
      .sort((a, b) => b.total - a.total);
  }, [requests]);

  const recentRequests = useMemo(
    () => [...requests]
      .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0))
      .slice(0, 6),
    [requests],
  );

  const recentActivity = useMemo(
    () => [...activity]
      .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
      .slice(0, 5),
    [activity],
  );

  const topReminder = useMemo(
    () => reminders.find((item) => item.status === 'due') || reminders.find((item) => item.status === 'active') || null,
    [reminders],
  );

  if (!companyId && !loading) {
    return (
      <div className="rounded-2xl bg-white px-6 py-14 text-center shadow-card">
        <AlertCircle size={36} className="mx-auto mb-3 text-gray-300" />
        <p className="text-sm text-[#6D6E71]">No client company is linked to this account yet.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[#050505]">Welcome, {user?.name?.split(' ')[0] || 'Client'}</h1>
        <p className="mt-0.5 text-sm text-[#6D6E71]">
           {company?.name || user?.company || 'Client Workspace'}   ·   {todayLabel}
        </p>
      </div>

      {error && (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {loading ? (
        <div className="rounded-2xl bg-white px-6 py-14 text-center text-sm text-[#6D6E71] shadow-card">
          <Loader2 size={28} className="mx-auto mb-3 animate-spin text-[#8BC53D]" />
          Loading dashboard...
        </div>
      ) : (
        <>
          {nextDueRequest && (
            <div className="flex flex-col gap-3 rounded-2xl border border-[#FDE68A] bg-[#FFFBEB] px-4 py-4 sm:flex-row sm:items-center">
              <AlertCircle size={18} className="mt-0.5 text-[#A16207] sm:mt-0" />
              <div className="flex-1">
                <p className="text-sm font-semibold text-[#92400E]">
                  Next due request: "{nextDueRequest.name}"
                </p>
                <p className="mt-1 text-xs text-[#A16207]">
                  {nextDueRequest.category} · due {formatDate(nextDueRequest.dueDate)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => navigate('/client/requests')}
                className="rounded-xl bg-[#8BC53D] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#476E2C]"
              >
                Open Requests
              </button>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {stats.map((card) => (
              <button
                key={card.label}
                type="button"
                onClick={() => navigate(card.cta)}
                className="rounded-2xl bg-white p-5 text-left shadow-card transition-all duration-300 hover:-translate-y-0.5 hover:shadow-hover"
              >
                <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl" style={{ backgroundColor: card.bg }}>
                  <card.icon size={20} style={{ color: card.color }} />
                </div>
                <p className="text-3xl font-bold text-[#050505]">{card.value}</p>
                <p className="mt-0.5 text-sm text-[#6D6E71]">{card.label}</p>
              </button>
            ))}
          </div>

          <div className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_380px]">
            <div className="space-y-6">
              <div className="rounded-2xl bg-white shadow-card">
                <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
                  <h2 className="font-semibold text-[#050505]">Category Progress</h2>
                  <TrendingUp size={15} className="text-[#8BC53D]" />
                </div>
                <div className="space-y-4 p-4">
                  {categoryProgress.length === 0 ? (
                    <p className="rounded-xl border border-dashed border-gray-200 px-4 py-10 text-center text-sm text-[#A5A5A5]">
                      No request categories available yet.
                    </p>
                  ) : (
                    categoryProgress.map((category) => (
                      <div key={category.category}>
                        <div className="mb-1.5 flex items-center justify-between">
                          <p className="text-sm font-semibold text-[#050505]">{category.category}</p>
                          <p className="text-xs font-bold" style={{ color: category.color }}>{category.pct}%</p>
                        </div>
                        <div className="h-2 overflow-hidden rounded-full bg-gray-100">
                          <div className="h-full rounded-full transition-all" style={{ width: `${category.pct}%`, backgroundColor: category.color }} />
                        </div>
                        <p className="mt-1 text-[11px] text-[#A5A5A5]">{category.total} request(s)</p>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div className="rounded-2xl bg-white shadow-card overflow-hidden">
                <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
                  <h2 className="font-semibold text-[#050505]">Recent Requests</h2>
                  <button
                    type="button"
                    onClick={() => navigate('/client/requests')}
                    className="flex items-center gap-1 text-xs font-semibold text-[#8BC53D] hover:underline"
                  >
                    View all <ArrowRight size={12} />
                  </button>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px]">
                    <thead>
                      <tr className="border-b border-gray-100 bg-gray-50/50">
                        {['Request', 'Category', 'Priority', 'Status', 'Updated'].map((heading) => (
                          <th key={heading} className="px-5 py-3 text-left text-xs font-semibold text-[#6D6E71]">
                            {heading}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {recentRequests.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="px-5 py-10 text-center text-sm text-[#A5A5A5]">
                            No requests available.
                          </td>
                        </tr>
                      ) : recentRequests.map((request) => (
                        <tr key={request.id} className="border-b border-gray-50 transition-colors hover:bg-gray-50/70">
                          <td className="px-5 py-3.5">
                            <p className="text-sm font-medium text-[#050505]">{request.name}</p>
                            <p className="mt-1 text-xs text-[#A5A5A5]">{request.responseType}</p>
                          </td>
                          <td className="px-5 py-3.5 text-sm text-[#6D6E71]">{request.category}</td>
                          <td className="px-5 py-3.5">
                            <span className="rounded-lg bg-[#EEF6E0] px-2 py-1 text-xs font-semibold capitalize text-[#476E2C]">
                              {request.priority}
                            </span>
                          </td>
                          <td className="px-5 py-3.5">
                            <StatusPill status={request.displayStatus} metaMap={REQUEST_STATUS_META} />
                          </td>
                          <td className="px-5 py-3.5 text-xs text-[#6D6E71]">{formatDateTime(request.updatedAt || request.createdAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            <div className="space-y-6">
              <div className="rounded-2xl bg-white p-5 shadow-card">
                <h2 className="font-semibold text-[#050505]">Workspace Snapshot</h2>
                <div className="mt-4 grid gap-3">
                  {[
                    { label: 'Completion Rate', value: `${completionPct}%`, tone: '#166534' },
                    { label: 'Pending / Overdue', value: requestSummary.pending, tone: '#A86F0B' },
                    { label: 'In Review', value: requestSummary.inReview, tone: '#2563EB' },
                    { label: 'Completed', value: requestSummary.completed, tone: '#166534' },
                  ].map((item) => (
                    <div key={item.label} className="rounded-xl bg-[#F8F9FC] px-4 py-3">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-[#A5A5A5]">{item.label}</p>
                      <p className="mt-1 text-lg font-bold" style={{ color: item.tone }}>{item.value}</p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-2xl bg-white p-5 shadow-card">
                <div className="flex items-center justify-between">
                  <h2 className="font-semibold text-[#050505]">Reminder Focus</h2>
                  <button
                    type="button"
                    onClick={() => navigate('/client/reminders')}
                    className="text-xs font-semibold text-[#8BC53D] hover:underline"
                  >
                    View reminders
                  </button>
                </div>
                {topReminder ? (
                  <div className="mt-4 rounded-2xl border border-gray-100 bg-[#FCFCFD] p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusPill status={topReminder.status} metaMap={REMINDER_STATUS_META} />
                      <span className="text-xs text-[#A5A5A5]">{topReminder.request_id}</span>
                    </div>
                    <p className="mt-3 text-sm font-semibold text-[#050505]">{topReminder.title}</p>
                    <p className="mt-1 text-xs leading-5 text-[#6D6E71]">{topReminder.message}</p>
                    <div className="mt-4 grid gap-3 sm:grid-cols-2">
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-[#A5A5A5]">Next Reminder</p>
                        <p className="mt-1 text-sm font-semibold text-[#050505]">{formatDateTime(topReminder.next_reminder_at || topReminder.next_due_at)}</p>
                      </div>
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-[#A5A5A5]">Cadence</p>
                        <p className="mt-1 text-sm font-semibold text-[#050505]">{topReminder.frequency_label}</p>
                      </div>
                    </div>
                  </div>
                ) : (
                  <p className="mt-4 rounded-xl border border-dashed border-gray-200 px-4 py-8 text-center text-sm text-[#A5A5A5]">
                    No reminders are active right now.
                  </p>
                )}
              </div>

              <div className="rounded-2xl bg-white p-5 shadow-card">
                <div className="flex items-center justify-between">
                  <h2 className="font-semibold text-[#050505]">Recent Activity</h2>
                  <button
                    type="button"
                    onClick={() => navigate('/client/documents')}
                    className="text-xs font-semibold text-[#8BC53D] hover:underline"
                  >
                    Open documents
                  </button>
                </div>
                <div className="mt-4 space-y-3">
                  {recentActivity.length === 0 ? (
                    <p className="rounded-xl border border-dashed border-gray-200 px-4 py-8 text-center text-sm text-[#A5A5A5]">
                      No recent activity available yet.
                    </p>
                  ) : recentActivity.map((item) => (
                    <div key={item.id} className="rounded-xl bg-[#F8F9FC] px-4 py-3">
                      <p className="text-sm font-semibold text-[#050505]">{item.title || item.message || 'Activity recorded'}</p>
                      <p className="mt-1 text-xs text-[#6D6E71]">{item.message}</p>
                      <p className="mt-2 text-[11px] text-[#A5A5A5]">
                        {item.actor_name ? `${item.actor_name} · ` : ''}
                        {formatDateTime(item.created_at)}
                      </p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-2xl bg-white p-5 shadow-card">
                <h2 className="font-semibold text-[#050505]">Company Details</h2>
                <div className="mt-4 grid gap-3">
                  {[
                    { label: 'Company', value: company?.name || user?.company || 'Not available' },
                    { label: 'Primary Contact', value: company?.contact_name || 'Not available' },
                    { label: 'Email', value: company?.contact_email || 'Not available' },
                    { label: 'Phone', value: company?.contact_phone || 'Not available' },
                  ].map((item) => (
                    <div key={item.label} className="rounded-xl bg-[#F8F9FC] px-4 py-3">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-[#A5A5A5]">{item.label}</p>
                      <p className="mt-1 text-sm font-semibold text-[#050505]">{item.value}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
