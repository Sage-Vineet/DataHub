import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  Bell,
  CheckCircle,
  Clock,
  Filter,
  FileUp,
  FileText,
  FolderPlus,
  KeyRound,
  MessageSquare,
  Search,
  Send,
  Upload,
  UserPlus,
  Users,
} from 'lucide-react';
import { listCompanyActivity } from '../../../lib/api';

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
  request_updated: {
    label: 'Request Updated',
    icon: Send,
    bg: '#E0F2FE',
    color: '#0369A1',
  },
  request_document_linked: {
    label: 'Request Document',
    icon: FileText,
    bg: '#ECFDF5',
    color: '#047857',
  },
  request_narrative_updated: {
    label: 'Narrative',
    icon: FileText,
    bg: '#F0F9FF',
    color: '#0284C7',
  },
  user_added: {
    label: 'User',
    icon: UserPlus,
    bg: '#DBEAFE',
    color: '#2563EB',
  },
  user_assigned: {
    label: 'User Assigned',
    icon: UserPlus,
    bg: '#E0E7FF',
    color: '#4F46E5',
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
  folder_access_granted: {
    label: 'Folder Access',
    icon: KeyRound,
    bg: '#FEF9C3',
    color: '#A16207',
  },
  document_uploaded: {
    label: 'Upload',
    icon: Upload,
    bg: '#DBEAFE',
    color: '#00648F',
  },
  document_status_changed: {
    label: 'Document Status',
    icon: CheckCircle,
    bg: '#DCFCE7',
    color: '#15803D',
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
  reminder_sent: {
    label: 'Reminder Sent',
    icon: Bell,
    bg: '#FCE7F3',
    color: '#BE185D',
  },
  message_sent: {
    label: 'Message',
    icon: MessageSquare,
    bg: '#F3E8FF',
    color: '#7E22CE',
  },
  direct_message_sent: {
    label: 'Direct Message',
    icon: MessageSquare,
    bg: '#EDE9FE',
    color: '#6D28D9',
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

function getEventFilterOptions(timeline) {
  return [
    'all',
    ...Array.from(new Set(timeline.map((item) => item.type).filter(Boolean))),
  ];
}

export default function WorkspaceActivity() {
  const { clientId } = useParams();
  const [timeline, setTimeline] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');

  useEffect(() => {
    if (!clientId) return;

    let cancelled = false;
    let intervalId;

    const loadActivity = async ({ isInitial = false } = {}) => {
      if (isInitial) setLoading(true);
      try {
        const activityResponse = await listCompanyActivity(clientId);

        if (cancelled) return;
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
    }, 60000);

    return () => {
      cancelled = true;
      if (intervalId) window.clearInterval(intervalId);
    };
  }, [clientId]);

  const filteredTimeline = useMemo(() => {
    const query = search.trim().toLowerCase();
    return timeline.filter((item) => {
      const matchesType = typeFilter === 'all' || item.type === typeFilter;
      if (!matchesType) return false;
      if (!query) return true;

      const haystack = [
        item.title,
        item.message,
        item.detail,
        item.actor_name,
        item.type,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      return haystack.includes(query);
    });
  }, [timeline, search, typeFilter]);

  const filterOptions = useMemo(() => getEventFilterOptions(timeline), [timeline]);

  const summary = useMemo(() => {
    const uploads = filteredTimeline.filter((item) => ['document_uploaded', 'document_status_changed', 'upload'].includes(item.type)).length;
    const requests = filteredTimeline.filter((item) => item.type?.startsWith('request_') || item.type === 'request').length;
    const users = filteredTimeline.filter((item) => ['user_added', 'user_assigned'].includes(item.type)).length;
    const groups = filteredTimeline.filter((item) => ['group_created', 'group_member_added', 'folder_access_granted'].includes(item.type)).length;
    return { uploads, requests, users, groups };
  }, [filteredTimeline]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[#050505]">Activity Log</h1>
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

      <div className="rounded-2xl bg-white p-5 shadow-card">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-2 text-sm font-semibold text-[#05164D]">
            <Filter size={16} />
            Search & Filter
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            <div className="relative min-w-[260px]">
              <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#A5A5A5]" />
              <input
                type="text"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search message, detail, actor..."
                className="w-full rounded-xl border border-[#E5E7EF] bg-white py-2.5 pl-9 pr-3 text-sm text-[#050505] outline-none transition-colors focus:border-[#8BC53D]"
              />
            </div>
            <select
              value={typeFilter}
              onChange={(event) => setTypeFilter(event.target.value)}
              className="rounded-xl border border-[#E5E7EF] bg-white px-3 py-2.5 text-sm text-[#050505] outline-none transition-colors focus:border-[#8BC53D]"
            >
              {filterOptions.map((option) => (
                <option key={option} value={option}>
                  {option === 'all'
                    ? 'All activity types'
                    : (EVENT_META[option]?.label || option).replace(/_/g, ' ')}
                </option>
              ))}
            </select>
          </div>
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
        ) : filteredTimeline.length === 0 ? (
          <div className="py-16 text-center">
            <Clock size={36} className="mx-auto mb-3 text-gray-200" />
            <p className="text-sm text-[#A5A5A5]">
              {timeline.length === 0 ? 'No activity yet for this client.' : 'No activity matches the current search/filter.'}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-gray-50">
            {filteredTimeline.map((item, idx) => {
              const meta = EVENT_META[item.type] || EVENT_META.activity;
              const Icon = meta.icon;

              return (
                <div key={item.id} className="flex items-start gap-4 px-5 py-4 transition-colors hover:bg-gray-50/80">
                  <div className="mt-1 flex flex-shrink-0 flex-col items-center gap-0">
                    <div className="flex h-8 w-8 items-center justify-center rounded-xl" style={{ background: meta.bg }}>
                      <Icon size={14} style={{ color: meta.color }} />
                    </div>
                    {idx < filteredTimeline.length - 1 && <div className="mt-1 h-6 w-0.5 bg-gray-100" />}
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
          <p className="text-xs text-[#A5A5A5]">
            {filteredTimeline.length} shown of {timeline.length} total events · refreshes every 60 seconds
          </p>
        </div>
      </div>
    </div>
  );
}
