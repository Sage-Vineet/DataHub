import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  Bell,
  CheckCircle,
  Clock,
  FileUp,
  FolderPlus,
  Send,
  Upload,
  UserPlus,
  Users,
} from 'lucide-react';
import { getCompanyRequest, listCompanyActivity } from '../../../lib/api';

const EVENT_META = {
  request_created: {
    label: 'Request',
    icon: Send,
    bg: '#FEF3C7',
    color: '#F68C1F',
  },
  request_approved: {
    label: 'Approved',
    icon: CheckCircle,
    bg: '#DCFCE7',
    color: '#476E2C',
  },
  user_added: {
    label: 'User',
    icon: UserPlus,
    bg: '#DBEAFE',
    color: '#2563EB',
  },
  group_created: {
    label: 'Group',
    icon: Users,
    bg: '#F3E8FF',
    color: '#742982',
  },
  group_member_added: {
    label: 'Group Member',
    icon: Users,
    bg: '#EDE9FE',
    color: '#6D28D9',
  },
  document_uploaded: {
    label: 'Upload',
    icon: Upload,
    bg: '#DBEAFE',
    color: '#00648F',
  },
  folder_created: {
    label: 'Folder',
    icon: FolderPlus,
    bg: '#ECFCCB',
    color: '#4D7C0F',
  },
  reminder_created: {
    label: 'Reminder',
    icon: Bell,
    bg: '#FCE7F3',
    color: '#BE185D',
  },
  upload: {
    label: 'Upload',
    icon: FileUp,
    bg: '#DBEAFE',
    color: '#00648F',
  },
  request: {
    label: 'Request',
    icon: Send,
    bg: '#FEF3C7',
    color: '#F68C1F',
  },
  approved: {
    label: 'Approved',
    icon: CheckCircle,
    bg: '#DCFCE7',
    color: '#476E2C',
  },
  reminder: {
    label: 'Reminder',
    icon: Bell,
    bg: '#F3E8FF',
    color: '#742982',
  },
  activity: {
    label: 'Activity',
    icon: Clock,
    bg: '#F3F4F6',
    color: '#6D6E71',
  },
};

function formatTimestamp(value) {
  if (!value) return 'Unknown time';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);

  return new Intl.DateTimeFormat('en-IN', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

export default function WorkspaceActivity() {
  const { clientId } = useParams();
  const [company, setCompany] = useState(null);
  const [timeline, setTimeline] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!clientId) return;

    let cancelled = false;
    let intervalId;

    const loadActivity = async ({ isInitial = false } = {}) => {
      if (isInitial) setLoading(true);
      try {
        const [companyResponse, activityResponse] = await Promise.all([
          getCompanyRequest(clientId).catch(() => null),
          listCompanyActivity(clientId),
        ]);

        if (cancelled) return;
        setCompany(companyResponse);
        setTimeline(Array.isArray(activityResponse) ? activityResponse : []);
        setError('');
      } catch (err) {
        if (cancelled) return;
        setError(err.message || 'Unable to load activity log.');
      } finally {
        if (!cancelled && isInitial) setLoading(false);
      }
    };

    loadActivity({ isInitial: true });
    intervalId = window.setInterval(() => {
      loadActivity();
    }, 15000);

    return () => {
      cancelled = true;
      if (intervalId) window.clearInterval(intervalId);
    };
  }, [clientId]);

  const summary = useMemo(() => {
    const uploads = timeline.filter((item) => item.type === 'document_uploaded' || item.type === 'upload').length;
    const requests = timeline.filter((item) => item.type === 'request_created' || item.type === 'request').length;
    const users = timeline.filter((item) => item.type === 'user_added').length;
    const groups = timeline.filter((item) => item.type === 'group_created' || item.type === 'group_member_added').length;
    return { uploads, requests, users, groups };
  }, [timeline]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[#050505]">Activity Log</h1>
        <p className="mt-0.5 text-sm text-[#6D6E71]">Live workspace activity for {company?.name || 'this client'}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-2xl bg-white p-5 shadow-card">
          <p className="text-xs text-[#A5A5A5]">Requests</p>
          <p className="mt-2 text-3xl font-bold text-[#05164D]">{summary.requests}</p>
        </div>
        <div className="rounded-2xl bg-white p-5 shadow-card">
          <p className="text-xs text-[#A5A5A5]">Uploads</p>
          <p className="mt-2 text-3xl font-bold text-[#05164D]">{summary.uploads}</p>
        </div>
        <div className="rounded-2xl bg-white p-5 shadow-card">
          <p className="text-xs text-[#A5A5A5]">Users Added</p>
          <p className="mt-2 text-3xl font-bold text-[#05164D]">{summary.users}</p>
        </div>
        <div className="rounded-2xl bg-white p-5 shadow-card">
          <p className="text-xs text-[#A5A5A5]">Groups Updated</p>
          <p className="mt-2 text-3xl font-bold text-[#05164D]">{summary.groups}</p>
        </div>
      </div>

      <div className="bg-white rounded-2xl shadow-card overflow-hidden">
        {error && (
          <div className="border-b border-red-100 bg-red-50 px-5 py-3 text-sm text-[#C62026]">
            {error}
          </div>
        )}

        {loading ? (
          <div className="py-16 text-center">
            <Clock size={36} className="mx-auto mb-3 text-gray-200" />
            <p className="text-sm text-[#A5A5A5]">Loading activity log...</p>
          </div>
        ) : timeline.length === 0 ? (
          <div className="py-16 text-center">
            <Clock size={36} className="mx-auto mb-3 text-gray-200" />
            <p className="text-sm text-[#A5A5A5]">No activity yet for this client.</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-50">
            {timeline.map((item, idx) => {
              const meta = EVENT_META[item.type] || EVENT_META.activity;
              const Icon = meta.icon;

              return (
                <div key={item.id} className="flex items-start gap-4 px-5 py-4 transition-colors hover:bg-gray-50/80">
                  <div className="mt-1 flex flex-shrink-0 flex-col items-center gap-0">
                    <div className="flex h-8 w-8 items-center justify-center rounded-xl" style={{ background: meta.bg }}>
                      <Icon size={14} style={{ color: meta.color }} />
                    </div>
                    {idx < timeline.length - 1 && <div className="mt-1 h-6 w-0.5 bg-gray-100" />}
                  </div>

                  <div className="min-w-0 flex-1 pb-1">
                    <p className="text-sm font-semibold text-[#050505]">{item.message || item.title || 'Activity recorded'}</p>
                    {item.detail && (
                      <p className="mt-0.5 line-clamp-2 text-xs text-[#6D6E71]">{item.detail}</p>
                    )}
                    <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-[#A5A5A5]">
                      <span className="inline-flex items-center gap-1">
                        <Clock size={10} />
                        {formatTimestamp(item.created_at)}
                      </span>
                      {item.actor_name && <span>By {item.actor_name}</span>}
                    </div>
                  </div>

                  <span
                    className="flex-shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold capitalize"
                    style={{ background: meta.bg, color: meta.color }}
                  >
                    {meta.label}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        <div className="border-t border-gray-100 bg-gray-50/30 px-5 py-3">
          <p className="text-xs text-[#A5A5A5]">{timeline.length} total events · refreshes every 15 seconds</p>
        </div>
      </div>
    </div>
  );
}
