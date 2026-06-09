import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Activity, ArrowRight, Bell, Briefcase, Building2, Calendar, CheckCircle, Clock,
  FileText, MessageSquare, ClipboardList, Plus, Users,
  Search, Filter, X, ChevronDown, AlertCircle,
  Eye, Pencil, Download, Phone, Mail, ChevronLeft,
  ChevronRight, UserPlus,
} from 'lucide-react';
import {
  listCompaniesRequest, listBrokerActivity,
  createCompanyRequest, updateCompanyRequest, deleteCompanyRequest,
  createUserRequest, triggerAutoCreateMessageGroups,
} from '../../lib/api';
import { useClientStore } from '../../store/clientStore';
import StatusBadge from '../../components/common/StatusBadge';
import Modal from '../../components/common/Modal';
import { SUB_ROLE, CLIENT_TEAM_ROLE_OPTIONS } from '../../lib/roles';

// ─── Constants ─────────────────────────────────────────────────────────────────

const PAGE_SIZE = 9; // 3-column grid looks best with multiples of 3
const OTHER_INDUSTRY = 'Other';
const EMPTY_FORM = { name: '', project_name: '', contactFirst: '', contactLast: '', email: '', phone: '', industry: '', year_type: 'calendar' };

const YEAR_TYPE_OPTIONS = [
  { value: 'calendar', label: 'Calendar Year', description: 'Jan 1 – Dec 31' },
  { value: 'fiscal', label: 'Fiscal Year', description: 'Custom fiscal period' },
];

const INDUSTRY_OPTIONS = [
  'Technology & Software', 'Healthcare & Life Sciences', 'Financial Services',
  'Consumer & Retail', 'Industrial & Manufacturing', 'Real Estate & Construction',
  'Media & Entertainment', 'Energy & Natural Resources', 'Transportation & Logistics',
  'Business Services', 'Education & Training', 'Telecommunications',
  'Food & Beverage', 'Agriculture', 'Government & Non-Profit',
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getInitials(name = '') {
  return name.split(' ').filter(Boolean).map((p) => p[0]).join('').slice(0, 2).toUpperCase();
}

function formatUSPhone(raw) {
  const d = (raw || '').replace(/\D/g, '').slice(0, 10);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

function splitName(full = '') {
  const parts = (full || '').trim().split(/\s+/);
  return { contactFirst: parts[0] || '', contactLast: parts.slice(1).join(' ') || '' };
}

function formatDate(value) {
  if (!value) return 'N/A';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function formatCompany(c) {
  if (!c) return null;
  return {
    id: c.id,
    name: c.name,
    projectName: c.project_name || '',
    contact: c.contact_name || c.contact || '—',
    email: c.contact_email || c.email || '—',
    phone: c.contact_phone || c.phone || '—',
    industry: c.industry || '',
    yearType: c.year_type || 'calendar',
    status: c.status || 'active',
    since: formatDate(c.created_at || c.since),
    logo: c.logo || getInitials(c.name),
    requestCount: Number(c.request_count || 0),
    pendingCount: Number(c.pending_request_count || c.pendingCount || 0),
    completedCount: Number(c.completed_request_count || c.completedCount || 0),
  };
}

function formatApiError(err) {
  const msg = String(err?.message || err || '');
  if (/duplicate|already exists|unique constraint|email.*taken/i.test(msg)) {
    return 'A company with this email address already exists.';
  }
  return msg || 'Something went wrong. Please try again.';
}

// ─── Activity feed helpers ─────────────────────────────────────────────────────

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

function timeAgo(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function FormError({ message }) {
  if (!message) return null;
  return (
    <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 flex items-start gap-2.5">
      <AlertCircle size={15} className="text-[#C62026] flex-shrink-0 mt-0.5" />
      <p className="text-sm text-[#C62026]">{message}</p>
    </div>
  );
}

const STATUS_META = {
  active: { label: 'Active', dot: 'bg-green-500', text: 'text-green-600', bg: 'bg-green-50' },
  inactive: { label: 'Inactive', dot: 'bg-gray-400', text: 'text-gray-500', bg: 'bg-gray-100' },
};

function CompanyCard({ company, onOpenWorkspace, onView, onEdit }) {
  const s = STATUS_META[company.status] || STATUS_META.inactive;

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm hover:shadow-md transition-all flex flex-col">
      {/* Clickable body → opens workspace */}
      <div
        className="p-4 flex-1 cursor-pointer group"
        onClick={() => onOpenWorkspace(company)}
      >
        <div className="flex items-start justify-between gap-2 mb-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[#05164D] flex items-center justify-center text-sm font-bold text-white flex-shrink-0">
              {company.logo}
            </div>
            <div className="min-w-0">
              <p className="font-semibold text-[#05164D] text-sm truncate group-hover:text-[#8BC53D] transition-colors">
                {company.name}
              </p>
              {company.projectName && (
                <span className="inline-block rounded-full bg-[#05164D]/10 px-2 py-0.5 text-[10px] font-semibold text-[#05164D]">
                  {company.projectName}
                </span>
              )}
            </div>
          </div>
          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold flex-shrink-0 ${s.bg} ${s.text}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
            {s.label}
          </span>
        </div>

        <p className="text-xs text-gray-400 mb-3">{company.industry || '—'}</p>

        <div className="grid grid-cols-2 gap-2 mb-3">
          <div className="rounded-xl bg-[#FFF1E2] px-2.5 py-2 text-center">
            <p className="text-sm font-bold text-[#F68C1F]">{company.pendingCount}</p>
            <p className="text-[10px] text-[#F68C1F] font-medium">Pending</p>
          </div>
          <div className="rounded-xl bg-[#E8F3D8] px-2.5 py-2 text-center">
            <p className="text-sm font-bold text-[#476E2C]">{company.completedCount}</p>
            <p className="text-[10px] text-[#476E2C] font-medium">Completed</p>
          </div>
        </div>

        <div className="text-xs text-gray-500 truncate">{company.contact} · {company.email}</div>
      </div>

      {/* Action buttons */}
      <div className="px-4 pb-4 pt-3 flex items-center gap-2 border-t border-gray-50">
        <button
          onClick={() => onView(company)}
          title="View details"
          className="flex-1 py-1.5 rounded-lg border border-gray-200 text-xs font-semibold text-gray-600 hover:bg-gray-50 flex items-center justify-center gap-1.5 transition-colors"
        >
          <Eye size={12} /> View
        </button>
        <button
          onClick={() => onEdit(company)}
          title="Edit company"
          className="flex-1 py-1.5 rounded-lg border border-gray-200 text-xs font-semibold text-[#476E2C] hover:bg-[#E8F3D8] flex items-center justify-center gap-1.5 transition-colors"
        >
          <Pencil size={12} /> Edit
        </button>
      </div>
    </div>
  );
}

// ─── Main Dashboard ───────────────────────────────────────────────────────────

export default function BrokerDashboard() {
  const navigate = useNavigate();
  const { setSelectedClient } = useClientStore();

  // ── Data state ──────────────────────────────────────────────────────────────
  const [companies, setCompanies] = useState([]);
  const [activity, setActivity] = useState([]);
  const [loadingCompanies, setLoadingCompanies] = useState(true);
  const [loadingActivity, setLoadingActivity] = useState(true);
  const [pageError, setPageError] = useState('');
  const [success, setSuccess] = useState('');

  // ── Filter / pagination state ────────────────────────────────────────────────
  const [search, setSearch] = useState('');
  const [industryFilter, setIndustryFilter] = useState('All Industries');
  const [statusFilter, setStatusFilter] = useState('All Status');
  const [page, setPage] = useState(1);

  // ── Form / modal state ───────────────────────────────────────────────────────
  const [selected, setSelected] = useState(null);        // view-details modal
  const [showAdd, setShowAdd] = useState(false);         // add/edit modal
  const [editing, setEditing] = useState(null);          // null = adding, object = editing
  const [form, setForm] = useState(EMPTY_FORM);
  const [useCustomIndustry, setUseCustomIndustry] = useState(false);
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [teamMembers, setTeamMembers] = useState([]);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [deleteError, setDeleteError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const submittingRef = useRef(false);

  // ── Load data ────────────────────────────────────────────────────────────────
  const loadCompanies = async () => {
    setLoadingCompanies(true);
    setPageError('');
    try {
      const data = await listCompaniesRequest();
      setCompanies(data.map(formatCompany).filter(Boolean));
    } catch (err) {
      setPageError(err.message || 'Unable to load companies.');
    } finally {
      setLoadingCompanies(false);
    }
  };

  useEffect(() => {
    let cancelled = false;

    listBrokerActivity(30)
      .then((acts) => { if (!cancelled) setActivity(acts); })
      .catch(() => { })
      .finally(() => { if (!cancelled) setLoadingActivity(false); });

    loadCompanies();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!success) return;
    const t = setTimeout(() => setSuccess(''), 3000);
    return () => clearTimeout(t);
  }, [success]);

  // ── Analytics ────────────────────────────────────────────────────────────────
  const analytics = useMemo(() => {
    const active = companies.filter((c) => c.status === 'active').length;
    const pending = companies.reduce((s, c) => s + c.pendingCount, 0);
    const completed = companies.reduce((s, c) => s + c.completedCount, 0);
    return { total: companies.length, active, pending, completed };
  }, [companies]);

  // ── Filter options ────────────────────────────────────────────────────────────
  const industryOptions = useMemo(
    () => ['All Industries', ...Array.from(new Set(companies.map((c) => c.industry))).filter(Boolean)],
    [companies],
  );
  const statusOptions = useMemo(
    () => ['All Status', ...Array.from(new Set(companies.map((c) => c.status))).filter(Boolean)],
    [companies],
  );

  // ── Filtered + paginated ─────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return companies.filter((c) => {
      const matchSearch = !q
        || c.name.toLowerCase().includes(q)
        || (c.projectName || '').toLowerCase().includes(q)
        || (c.industry || '').toLowerCase().includes(q)
        || (c.contact || '').toLowerCase().includes(q)
        || (c.email || '').toLowerCase().includes(q)
        || (c.phone || '').toLowerCase().includes(q);
      const matchIndustry = industryFilter === 'All Industries' || c.industry === industryFilter;
      const matchStatus = statusFilter === 'All Status' || c.status === statusFilter;
      return matchSearch && matchIndustry && matchStatus;
    });
  }, [companies, search, industryFilter, statusFilter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const paginated = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  // ── Export CSV ───────────────────────────────────────────────────────────────
  const handleExport = () => {
    const headers = ['Project Name', 'Company Name', 'Industry', 'Contact Person', 'Email', 'Phone', 'Status', 'Since', 'Total Requests', 'Pending'];
    const rows = filtered.map((c) => [
      c.projectName, c.name, c.industry, c.contact, c.email, c.phone, c.status, c.since, c.requestCount, c.pendingCount,
    ]);
    const csv = [headers, ...rows].map((row) => row.map((v) => `"${v ?? ''}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'companies.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  // ── Form helpers ──────────────────────────────────────────────────────────────
  const closeFormModal = () => {
    setShowAdd(false);
    setEditing(null);
    setForm(EMPTY_FORM);
    setUseCustomIndustry(false);
    setFormError('');
    setTeamMembers([]);
  };

  const openAddModal = () => {
    setFormError('');
    setEditing(null);
    setForm(EMPTY_FORM);
    setUseCustomIndustry(false);
    setTeamMembers([]);
    setShowAdd(true);
  };

  const openEditModal = (company) => {
    setFormError('');
    setEditing(company);
    const industry = company.industry || '';
    setUseCustomIndustry(Boolean(industry) && !INDUSTRY_OPTIONS.includes(industry));
    const { contactFirst, contactLast } = splitName(company.contact || '');
    setForm({ name: company.name || '', project_name: company.projectName || '', contactFirst, contactLast, email: company.email || '', phone: formatUSPhone(company.phone || ''), industry, year_type: company.yearType || 'calendar' });
    setTeamMembers([]);
    setShowAdd(true);
  };

  const addTeamMember = () => {
    setTeamMembers((prev) => [...prev, { id: Date.now(), name: '', email: '', phone: '', sub_role: SUB_ROLE.CLIENT_TEAM_MEMBER, password: '' }]);
  };
  const updateTeamMember = (id, patch) => setTeamMembers((prev) => prev.map((m) => m.id === id ? { ...m, ...patch } : m));
  const removeTeamMember = (id) => setTeamMembers((prev) => prev.filter((m) => m.id !== id));

  // ── Save company ──────────────────────────────────────────────────────────────
  const handleSaveCompany = async () => {
    if (submittingRef.current) return;
    const contactName = `${(form.contactFirst || '').trim()} ${(form.contactLast || '').trim()}`.trim();
    if (!form.name.trim() || !form.project_name.trim() || !form.contactFirst.trim() || !form.contactLast.trim() || !form.email.trim() || !form.phone.trim() || !form.industry.trim()) {
      setFormError('Please fill in all required fields, including Project Name and Industry.');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) {
      setFormError('Please enter a valid email address.');
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);
    setFormError('');

    const payload = {
      name: form.name.trim(),
      project_name: form.project_name.trim(),
      industry: form.industry.trim(),
      contact_name: contactName,
      contact_email: form.email.trim(),
      contact_phone: form.phone.trim(),
      logo: getInitials(form.name),
      year_type: form.year_type || 'calendar',
    };

    try {
      if (editing) {
        const updated = await updateCompanyRequest(editing.id, payload);
        if (updated?.id) {
          const formatted = formatCompany({ ...updated, request_count: editing.requestCount, pending_request_count: editing.pendingCount, completed_request_count: editing.completedCount });
          setCompanies((prev) => prev.map((c) => c.id === editing.id ? formatted : c));
          setSelected((prev) => prev?.id === editing.id ? formatted : prev);
        } else {
          await loadCompanies();
        }
        setSuccess('Company updated successfully.');
        closeFormModal();
      } else {
        const created = await createCompanyRequest(payload);
        if (created?.id) {
          const formatted = formatCompany({ ...created, request_count: 0, pending_request_count: 0, completed_request_count: 0 });
          setCompanies((prev) => [formatted, ...prev]);
          setPage(1);
          setSuccess('Company created successfully.');
          closeFormModal();
          // Create team members (background, non-blocking)
          if (teamMembers.length > 0) {
            const valid = teamMembers.filter((m) => m.name?.trim() && m.email?.trim() && m.password?.trim());
            Promise.allSettled(valid.map((m) =>
              createUserRequest({ name: m.name.trim(), email: m.email.trim(), phone: m.phone?.trim() || null, password: m.password, role: 'buyer', sub_role: m.sub_role, company_id: created.id, company_ids: [created.id], status: 'active' })
            ));
          }
          // Auto-create message groups (fire-and-forget)
          triggerAutoCreateMessageGroups(created.id).catch(() => {});
        } else {
          await loadCompanies();
          setSuccess('Company created successfully.');
          closeFormModal();
        }
      }
    } catch (err) {
      setFormError(formatApiError(err));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  // ── Delete company ────────────────────────────────────────────────────────────
  const handleDeleteCompany = async () => {
    if (!confirmDelete) return;
    setDeleting(true);
    setDeleteError('');
    try {
      await deleteCompanyRequest(confirmDelete.id);
      setCompanies((prev) => prev.filter((c) => c.id !== confirmDelete.id));
      if (selected?.id === confirmDelete.id) setSelected(null);
      setConfirmDelete(null);
      setSuccess('Company deleted successfully.');
    } catch (err) {
      setDeleteError(err.message || 'Unable to delete company.');
    } finally {
      setDeleting(false);
    }
  };

  // ── Open workspace ────────────────────────────────────────────────────────────
  const openWorkspace = (company) => {
    if (!company?.id) return;
    setSelectedClient({ id: company.id, name: company.name });
    navigate(`/broker/client/${company.id}/dataroom/deal-tracker`, { state: { company } });
  };

  // ─────────────────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6 animate-fadeIn">
      {/* ── Header ── */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[#05164D]">Your Deals</h1>
          <p className="mt-0.5 text-sm text-[#6D6E71]">
            {companies.length} compan{companies.length !== 1 ? 'ies' : 'y'} registered
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleExport}
            disabled={filtered.length === 0}
            className="flex items-center gap-2 px-4 py-2.5 bg-white border border-gray-200 hover:bg-gray-50 text-[#050505] rounded-xl text-sm font-semibold transition-all shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Download size={15} className="text-[#6D6E71]" />
            Export CSV
          </button>
          <button
            onClick={openAddModal}
            className="inline-flex items-center gap-2 rounded-xl bg-[#8BC53D] px-5 py-2.5 text-sm font-semibold text-white shadow-md hover:bg-[#476E2C] hover:scale-[1.02] transition-all"
          >
            <Plus size={15} /> Add Company
          </button>
        </div>
      </div>

      {/* ── Toasts ── */}
      {pageError && (
        <div className="px-4 py-3 bg-red-50 rounded-2xl border border-red-100 text-sm text-[#C62026]">{pageError}</div>
      )}
      {success && (
        <div className="px-4 py-3 bg-green-50 rounded-2xl border border-green-100 text-sm text-green-700">{success}</div>
      )}

      {/* ── Analytics ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Total Deals', value: analytics.total, icon: Briefcase, tone: '#05164D', bg: '#E8ECF5' },
          { label: 'Active Companies', value: analytics.active, icon: Building2, tone: '#476E2C', bg: '#E8F3D8' },
          { label: 'Completed Requests', value: analytics.completed, icon: CheckCircle, tone: '#059669', bg: '#ECFDF5' },
          { label: 'Pending Requests', value: analytics.pending, icon: Clock, tone: '#F68C1F', bg: '#FFF1E2' },
        ].map((card) => (
          <div key={card.label} className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
            <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-xl" style={{ backgroundColor: card.bg }}>
              <card.icon size={16} style={{ color: card.tone }} />
            </div>
            <p className="text-2xl font-bold" style={{ color: card.tone }}>{card.value}</p>
            <p className="mt-1 text-xs text-[#6D6E71]">{card.label}</p>
          </div>
        ))}
      </div>

      {/* ── Main content ── */}
      <div className="grid gap-5 xl:grid-cols-[1fr_300px]">

        {/* Companies section */}
        <div className="space-y-4">
          {/* Toolbar */}
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4">
            <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
              {/* Search */}
              <div className="flex items-center gap-2 border border-gray-200 rounded-xl px-3 py-2 focus-within:ring-2 focus-within:ring-[#8BC53D]/30 flex-1 min-w-0">
                <Search size={15} className="text-[#A5A5A5] flex-shrink-0" />
                <input
                  value={search}
                  onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                  placeholder="Search by project, company, industry, contact, email or phone..."
                  className="text-sm outline-none text-[#050505] placeholder-[#A5A5A5] bg-transparent w-full"
                />
                {search && (
                  <button onClick={() => { setSearch(''); setPage(1); }} className="text-[#A5A5A5] hover:text-[#050505]">
                    <X size={13} />
                  </button>
                )}
              </div>
              {/* Industry filter */}
              <div className="relative flex-shrink-0">
                <Filter size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#A5A5A5] pointer-events-none" />
                <select
                  value={industryFilter}
                  onChange={(e) => { setIndustryFilter(e.target.value); setPage(1); }}
                  className="appearance-none pl-8 pr-8 py-2 text-sm border border-gray-200 rounded-xl text-[#050505] bg-white focus:outline-none focus:ring-2 focus:ring-[#8BC53D]/30 cursor-pointer"
                >
                  {industryOptions.map((o) => <option key={o}>{o}</option>)}
                </select>
                <ChevronDown size={13} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#A5A5A5] pointer-events-none" />
              </div>
              {/* Status filter */}
              <div className="relative flex-shrink-0">
                <select
                  value={statusFilter}
                  onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
                  className="appearance-none pl-4 pr-8 py-2 text-sm border border-gray-200 rounded-xl text-[#050505] bg-white focus:outline-none focus:ring-2 focus:ring-[#8BC53D]/30 cursor-pointer capitalize"
                >
                  {statusOptions.map((o) => <option key={o} className="capitalize">{o}</option>)}
                </select>
                <ChevronDown size={13} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#A5A5A5] pointer-events-none" />
              </div>
              <p className="text-xs text-[#A5A5A5] whitespace-nowrap flex-shrink-0">
                {filtered.length} result{filtered.length !== 1 ? 's' : ''}
              </p>
            </div>
          </div>

          {/* Company cards */}
          {loadingCompanies ? (
            <div className="py-16 text-center text-sm text-gray-400 animate-pulse">Loading companies…</div>
          ) : filtered.length === 0 ? (
            <div className="py-16 text-center bg-white rounded-2xl border border-gray-100">
              <Building2 size={36} className="mx-auto text-gray-200 mb-3" />
              <p className="text-sm font-semibold text-gray-400">No companies found</p>
              {(search || industryFilter !== 'All Industries' || statusFilter !== 'All Status') && (
                <button
                  onClick={() => { setSearch(''); setIndustryFilter('All Industries'); setStatusFilter('All Status'); }}
                  className="mt-2 text-xs text-[#8BC53D] hover:underline"
                >
                  Clear filters
                </button>
              )}
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
                {paginated.map((company) => (
                  <CompanyCard
                    key={company.id}
                    company={company}
                    onOpenWorkspace={openWorkspace}
                    onView={setSelected}
                    onEdit={openEditModal}
                  />
                ))}
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex items-center justify-between px-1">
                  <p className="text-xs text-[#6D6E71]">
                    Showing {(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, filtered.length)} of {filtered.length} companies
                  </p>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      disabled={safePage === 1}
                      className="p-1.5 rounded-lg border border-gray-200 text-[#6D6E71] hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      <ChevronLeft size={15} />
                    </button>
                    {Array.from({ length: totalPages }, (_, i) => i + 1).map((n) => (
                      <button
                        key={n}
                        onClick={() => setPage(n)}
                        className={`w-8 h-8 rounded-lg text-xs font-semibold transition-colors border ${n === safePage ? 'bg-[#05164D] text-white border-[#05164D]' : 'border-gray-200 text-[#6D6E71] hover:bg-white'}`}
                      >
                        {n}
                      </button>
                    ))}
                    <button
                      onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                      disabled={safePage === totalPages}
                      className="p-1.5 rounded-lg border border-gray-200 text-[#6D6E71] hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      <ChevronRight size={15} />
                    </button>
                  </div>
                </div>
              )}
              {totalPages === 1 && (
                <p className="text-xs text-[#A5A5A5] px-1">
                  Showing all <span className="font-semibold text-[#6D6E71]">{filtered.length}</span> compan{filtered.length !== 1 ? 'ies' : 'y'}
                </p>
              )}
            </>
          )}
        </div>

        {/* Recent Activity panel */}
        <div className="flex flex-col rounded-2xl bg-white shadow-sm border border-gray-100 max-h-[680px]">
          <div className="border-b border-gray-100 px-5 py-4 flex-shrink-0">
            <h2 className="font-semibold text-[#05164D]">Recent Activity</h2>
            <p className="mt-0.5 text-xs text-[#A5A5A5]">Latest events across all companies.</p>
          </div>
          <div className="flex-1 divide-y divide-gray-50 overflow-y-auto">
            {loadingActivity && (
              <p className="px-5 py-10 text-center text-sm text-[#A5A5A5] animate-pulse">Loading activity…</p>
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
                  <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg" style={{ backgroundColor: color.bg }}>
                    <Icon size={14} style={{ color: color.tone }} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium leading-snug text-[#050505]">{event.message}</p>
                    <div className="mt-0.5 flex items-center gap-1.5 text-xs text-[#A5A5A5]">
                      {event.actor_name && <><span className="font-medium text-[#6D6E71]">{event.actor_name}</span><span>·</span></>}
                      {event.detail && <><span className="max-w-[100px] truncate">{event.detail}</span><span>·</span></>}
                      <span className="shrink-0">{timeAgo(event.created_at)}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── Company Details Modal ── */}
      <Modal isOpen={!!selected} onClose={() => setSelected(null)} title="Company Details" size="md">
        {selected && (
          <div className="space-y-5">
            <div className="flex items-center gap-4 p-4 bg-gray-50 rounded-xl">
              <div className="w-16 h-16 rounded-2xl bg-[#05164D] flex items-center justify-center text-xl font-bold text-white">
                {selected.logo}
              </div>
              <div className="min-w-0">
                {selected.projectName && (
                  <span className="mb-1 inline-block rounded-full bg-[#05164D]/10 px-2.5 py-0.5 text-xs font-semibold text-[#05164D]">
                    {selected.projectName}
                  </span>
                )}
                <h3 className="text-lg font-bold text-[#050505]">{selected.name}</h3>
                <p className="text-sm text-[#6D6E71]">{selected.industry}</p>
                <StatusBadge value={selected.status} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              {[
                { label: 'Contact Person', value: selected.contact, icon: Users },
                { label: 'Email', value: selected.email, icon: Mail },
                { label: 'Phone', value: selected.phone, icon: Phone },
                { label: 'Client Since', value: selected.since, icon: Building2 },
              ].map((item) => (
                <div key={item.label} className="bg-gray-50 rounded-xl p-3">
                  <div className="flex items-center gap-1.5 mb-1">
                    <item.icon size={12} className="text-[#A5A5A5]" />
                    <p className="text-xs text-[#A5A5A5] font-medium">{item.label}</p>
                  </div>
                  <p className="text-sm font-semibold text-[#050505] truncate">{item.value}</p>
                </div>
              ))}
            </div>
            <div className={`flex items-center gap-3 rounded-xl p-3 ${selected.yearType === 'fiscal' ? 'bg-[#FFF8EC] border border-[#F68C1F]/20' : 'bg-[#EEF6E0] border border-[#8BC53D]/20'}`}>
              <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${selected.yearType === 'fiscal' ? 'bg-[#F68C1F]/10' : 'bg-[#8BC53D]/10'}`}>
                <Calendar size={14} className={selected.yearType === 'fiscal' ? 'text-[#F68C1F]' : 'text-[#476E2C]'} />
              </div>
              <div>
                <p className="text-xs text-[#A5A5A5] font-medium">Fiscal Year Type</p>
                <p className={`text-sm font-semibold ${selected.yearType === 'fiscal' ? 'text-[#b45e08]' : 'text-[#476E2C]'}`}>
                  {selected.yearType === 'fiscal' ? 'Fiscal Year' : 'Calendar Year'}
                  <span className="ml-2 text-[10px] font-medium text-[#A5A5A5]">
                    {selected.yearType === 'fiscal' ? 'Custom fiscal period' : 'Jan 1 – Dec 31'}
                  </span>
                </p>
              </div>
            </div>
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-[#6D6E71]">Request Summary</p>
              <div className="grid grid-cols-3 gap-3">
                {[
                  { label: 'Total', value: selected.requestCount, color: '#050505' },
                  { label: 'Pending', value: selected.pendingCount, color: '#b45e08' },
                  { label: 'Completed', value: selected.completedCount, color: '#476E2C' },
                ].map((stat) => (
                  <div key={stat.label} className="text-center bg-gray-50 rounded-xl py-3 px-2">
                    <p className="text-2xl font-bold" style={{ color: stat.color }}>{stat.value}</p>
                    <p className="text-xs text-[#A5A5A5] mt-0.5 leading-tight">{stat.label} Requests</p>
                  </div>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => { const t = selected; setSelected(null); openWorkspace(t); }}
                className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-[#8BC53D] hover:bg-[#476E2C] text-white text-sm font-bold transition-colors shadow-md"
              >
                Open Workspace <ArrowRight size={15} />
              </button>
              <button
                onClick={() => { setSelected(null); openEditModal(selected); }}
                className="w-full flex items-center justify-center gap-2 py-3 rounded-xl border border-gray-200 text-[#050505] text-sm font-bold hover:bg-gray-50 transition-colors"
              >
                Edit Company <Pencil size={15} />
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* ── Add / Edit Company Modal ── */}
      <Modal isOpen={showAdd} onClose={submitting ? () => {} : closeFormModal} title={editing ? 'Edit Company' : 'Add New Company'}>
        <div className="space-y-4 pt-6">
          <FormError message={formError} />

          {[
            { label: 'Project Name', key: 'project_name', placeholder: 'e.g. Project Falcon' },
            { label: 'Company Name', key: 'name', placeholder: 'e.g. Acme Corp' },
          ].map((field) => (
            <div key={field.key}>
              <label className="block text-sm font-medium text-[#050505] mb-1.5">
                {field.label} <span className="text-[#C62026]">*</span>
              </label>
              <input
                type="text"
                value={form[field.key]}
                onChange={(e) => setForm((c) => ({ ...c, [field.key]: e.target.value }))}
                placeholder={field.placeholder}
                disabled={submitting}
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#8BC53D]/40 focus:border-[#8BC53D] transition-all placeholder-[#A5A5A5] disabled:bg-gray-50 disabled:cursor-not-allowed"
              />
            </div>
          ))}

          <div className="grid grid-cols-2 gap-3">
            {[
              { key: 'contactFirst', label: 'First Name', placeholder: 'Jane' },
              { key: 'contactLast', label: 'Last Name', placeholder: 'Smith' },
            ].map((field) => (
              <div key={field.key}>
                <label className="block text-sm font-medium text-[#050505] mb-1.5">
                  {field.label} <span className="text-[#C62026]">*</span>
                </label>
                <input
                  type="text"
                  value={form[field.key]}
                  onChange={(e) => setForm((c) => ({ ...c, [field.key]: e.target.value }))}
                  placeholder={field.placeholder}
                  disabled={submitting}
                  className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#8BC53D]/40 focus:border-[#8BC53D] transition-all placeholder-[#A5A5A5] disabled:bg-gray-50 disabled:cursor-not-allowed"
                />
              </div>
            ))}
          </div>

          <div>
            <label className="block text-sm font-medium text-[#050505] mb-1.5">Email Address <span className="text-[#C62026]">*</span></label>
            <input
              type="email"
              value={form.email}
              onChange={(e) => setForm((c) => ({ ...c, email: e.target.value }))}
              placeholder="contact@company.com"
              disabled={submitting}
              className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#8BC53D]/40 focus:border-[#8BC53D] transition-all placeholder-[#A5A5A5] disabled:bg-gray-50 disabled:cursor-not-allowed"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-[#050505] mb-1.5">Phone Number <span className="text-[#C62026]">*</span></label>
            <div className="flex">
              <span className="flex h-[42px] items-center rounded-l-xl border border-r-0 border-gray-200 bg-gray-50 px-3 text-sm font-medium text-[#6D6E71]">+1</span>
              <input
                type="tel"
                value={form.phone}
                onChange={(e) => setForm((c) => ({ ...c, phone: formatUSPhone(e.target.value) }))}
                placeholder="(555) 000-0000"
                maxLength={14}
                disabled={submitting}
                className="min-w-0 flex-1 rounded-l-none rounded-r-xl border border-gray-200 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#8BC53D]/40 focus:border-[#8BC53D] transition-all placeholder-[#A5A5A5] disabled:bg-gray-50 disabled:cursor-not-allowed"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-[#050505] mb-1.5">Industry <span className="text-[#C62026]">*</span></label>
            <select
              value={useCustomIndustry ? OTHER_INDUSTRY : form.industry}
              onChange={(e) => {
                if (e.target.value === OTHER_INDUSTRY) {
                  setUseCustomIndustry(true);
                  setForm((c) => ({ ...c, industry: '' }));
                } else {
                  setUseCustomIndustry(false);
                  setForm((c) => ({ ...c, industry: e.target.value }));
                }
              }}
              disabled={submitting}
              className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#8BC53D]/40 focus:border-[#8BC53D] transition-all text-[#050505] bg-white disabled:bg-gray-50 disabled:cursor-not-allowed"
            >
              <option value="">Select industry…</option>
              {INDUSTRY_OPTIONS.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
              <option value={OTHER_INDUSTRY}>{OTHER_INDUSTRY}</option>
            </select>
            {useCustomIndustry && (
              <input
                type="text"
                value={form.industry}
                onChange={(e) => setForm((c) => ({ ...c, industry: e.target.value }))}
                placeholder="Enter industry name"
                disabled={submitting}
                className="mt-3 w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#8BC53D]/40 focus:border-[#8BC53D] transition-all placeholder-[#A5A5A5] disabled:bg-gray-50 disabled:cursor-not-allowed"
              />
            )}
          </div>

          {/* Fiscal Year Type */}
          <div>
            <label className="block text-sm font-medium text-[#050505] mb-1.5">
              Fiscal Year Type <span className="text-[#C62026]">*</span>
            </label>
            <div className="grid grid-cols-2 gap-2">
              {YEAR_TYPE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  disabled={submitting}
                  onClick={() => setForm((c) => ({ ...c, year_type: opt.value }))}
                  className={`flex items-center gap-2.5 px-4 py-3 rounded-xl border text-left transition-all disabled:cursor-not-allowed disabled:opacity-50 ${
                    form.year_type === opt.value
                      ? 'border-[#8BC53D] bg-[#EEF6E0] text-[#476E2C]'
                      : 'border-gray-200 text-[#6D6E71] hover:border-gray-300 hover:bg-gray-50'
                  }`}
                >
                  <Calendar size={15} className={form.year_type === opt.value ? 'text-[#8BC53D] flex-shrink-0' : 'text-[#A5A5A5] flex-shrink-0'} />
                  <div>
                    <p className="text-sm font-semibold leading-tight">{opt.label}</p>
                    <p className="text-[10px] text-[#A5A5A5] mt-0.5">{opt.description}</p>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Team Members — creation only */}
          {!editing && (
            <div className="border border-dashed border-gray-200 rounded-2xl p-4">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <p className="text-sm font-semibold text-[#05164D]">Client Team Members</p>
                  <p className="text-xs text-gray-400">Optionally add team members or accountants now</p>
                </div>
                <button
                  type="button"
                  onClick={addTeamMember}
                  disabled={submitting}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#E6F3D3] text-[#476E2C] text-xs font-semibold hover:bg-[#d4ebbf] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <UserPlus size={13} /> Add Member
                </button>
              </div>
              {teamMembers.length === 0 ? (
                <p className="text-xs text-gray-400 text-center py-2">No team members added yet.</p>
              ) : (
                <div className="space-y-2">
                  {teamMembers.map((m) => (
                    <div key={m.id} className="flex flex-wrap gap-2 p-3 rounded-xl bg-gray-50 border border-gray-100">
                      <input value={m.name} onChange={(e) => updateTeamMember(m.id, { name: e.target.value })}
                        placeholder="Full Name *" className="flex-1 min-w-[120px] px-3 py-2 rounded-lg border border-gray-200 text-xs focus:outline-none focus:border-[#8BC53D]" />
                      <input value={m.email} onChange={(e) => updateTeamMember(m.id, { email: e.target.value })}
                        placeholder="Email *" className="flex-1 min-w-[140px] px-3 py-2 rounded-lg border border-gray-200 text-xs focus:outline-none focus:border-[#8BC53D]" />
                      <input value={m.phone} onChange={(e) => updateTeamMember(m.id, { phone: formatUSPhone(e.target.value) })}
                        placeholder="Phone" maxLength={14} className="w-32 px-3 py-2 rounded-lg border border-gray-200 text-xs focus:outline-none focus:border-[#8BC53D]" />
                      <select value={m.sub_role} onChange={(e) => updateTeamMember(m.id, { sub_role: e.target.value })}
                        className="px-3 py-2 rounded-lg border border-gray-200 text-xs bg-white focus:outline-none focus:border-[#8BC53D]">
                        {CLIENT_TEAM_ROLE_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                      </select>
                      <input type="password" value={m.password} onChange={(e) => updateTeamMember(m.id, { password: e.target.value })}
                        placeholder="Password *" className="flex-1 min-w-[120px] px-3 py-2 rounded-lg border border-gray-200 text-xs focus:outline-none focus:border-[#8BC53D]" />
                      <button type="button" onClick={() => removeTeamMember(m.id)}
                        className="w-8 h-8 rounded-lg border border-red-100 text-red-400 hover:bg-red-50 flex items-center justify-center">
                        <X size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="flex gap-3 pt-2">
            {editing && (
              <button
                onClick={() => { setShowAdd(false); setDeleteError(''); setConfirmDelete(editing); }}
                disabled={submitting}
                className="px-4 py-2.5 rounded-xl border border-red-200 text-sm font-semibold text-[#C62026] hover:bg-red-50 transition-colors disabled:opacity-50"
              >
                Delete
              </button>
            )}
            <button onClick={closeFormModal} disabled={submitting} className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm font-semibold text-[#6D6E71] hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
              Cancel
            </button>
            <button
              onClick={handleSaveCompany}
              disabled={submitting}
              className="flex-1 py-2.5 rounded-xl bg-[#8BC53D] text-white text-sm font-semibold hover:bg-[#476E2C] transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {submitting ? (editing ? 'Saving...' : 'Adding...') : (editing ? 'Save Changes' : 'Add Company')}
            </button>
          </div>
        </div>
      </Modal>

      {/* ── Delete Confirm Modal ── */}
      <Modal isOpen={!!confirmDelete} onClose={() => { setDeleteError(''); setConfirmDelete(null); }} title="Delete Company" size="sm">
        {confirmDelete && (
          <div className="space-y-5">
            <p className="text-sm text-[#050505] leading-relaxed">
              Are you sure you want to delete <span className="font-semibold">{confirmDelete.name}</span>? This action cannot be undone.
            </p>
            <FormError message={deleteError} />
            <div className="flex gap-3">
              <button
                onClick={() => { setDeleteError(''); setConfirmDelete(null); }}
                disabled={deleting}
                className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm font-semibold text-[#6D6E71] hover:bg-gray-50 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteCompany}
                disabled={deleting}
                className="flex-1 py-2.5 rounded-xl bg-[#C62026] text-white text-sm font-semibold hover:bg-red-700 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {deleting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
