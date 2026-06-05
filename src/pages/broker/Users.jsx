import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle, Plus, X, Pencil, Trash2,
  Phone, Mail, Building2, Calendar, ChevronDown, Check,
  Search, Users as UsersIcon, Briefcase, ShoppingCart,
  ArrowLeft, ChevronRight,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import {
  createUserRequest, deleteUserRequest, listCompaniesRequest,
  listUsersRequest, updateUserRequest, triggerAutoCreateMessageGroups,
} from '../../lib/api';
import {
  SUB_ROLE, BROKER_SUB_ROLES, CLIENT_SUB_ROLES, BUYER_SUB_ROLES,
  ROLE_META, BROKER_TEAM_ROLE_OPTIONS, CLIENT_TEAM_ROLE_OPTIONS,
  BUYER_TEAM_ROLE_OPTIONS, getRoleMeta, inferSubRole,
} from '../../lib/roles';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const palette = ['#8BC53D', '#05164D', '#F68C1F', '#742982', '#00648F', '#476E2C'];

function getColor(name = '') {
  return palette[name.length % palette.length];
}

function initials(name = '') {
  return name.split(' ').filter(Boolean).map((p) => p[0]).join('').slice(0, 2).toUpperCase();
}

function formatUSPhone(raw) {
  const d = raw.replace(/\D/g, '').slice(0, 10);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

function isValidEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
}

function formatApiError(err) {
  const msg = String(err?.message || err || '');
  if (/duplicate|already exists|unique constraint|email.*taken/i.test(msg)) {
    return 'A user with this email already exists.';
  }
  return msg || 'Something went wrong. Please try again.';
}

function normalizeUser(u) {
  if (!u) return null;
  const assignedCompanies = u.assigned_companies || u.assignedCompanies || [];
  const companyIds = Array.from(new Set([
    ...(u.company_ids || u.companyIds || []),
    ...assignedCompanies.map((c) => c.id).filter(Boolean),
    u.company_id,
  ].filter(Boolean)));
  const sub = u.sub_role || inferSubRole(u);
  return {
    id: u.id,
    name: u.name || '',
    email: u.email || '',
    phone: u.phone || '',
    role: u.role,
    sub_role: sub,
    designation: u.designation || '',
    buyer_company_name: u.buyer_company_name || '',
    parent_user_id: u.parent_user_id || null,
    status: u.status || 'active',
    companyId: u.company_id || companyIds[0] || '',
    companyIds,
    assignedCompanies,
    company: u.company_name || (assignedCompanies[0]?.name) || (assignedCompanies.map((c) => c.name).join(', ')) || 'Unassigned',
    joinedAt: u.created_at,
    avatar: initials(u.name || ''),
    meta: getRoleMeta({ ...u, sub_role: sub }),
  };
}

// ─── Mini components ──────────────────────────────────────────────────────────

function Avatar({ name, size = 36 }) {
  return (
    <div
      className="rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0"
      style={{ width: size, height: size, background: getColor(name) }}
    >
      {initials(name)}
    </div>
  );
}

function RoleBadge({ subRole }) {
  const meta = ROLE_META[subRole] || { label: subRole, color: '#6B7280', bg: '#F9FAFB', border: '#E5E7EB' };
  return (
    <span
      className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold border"
      style={{ color: meta.color, background: meta.bg, borderColor: meta.border }}
    >
      {meta.label}
    </span>
  );
}

function StatusDot({ status }) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${status === 'active' ? 'text-green-600' : 'text-gray-400'}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${status === 'active' ? 'bg-green-500' : 'bg-gray-300'}`} />
      {status === 'active' ? 'Active' : 'Inactive'}
    </span>
  );
}

function FormError({ message }) {
  if (!message) return null;
  return (
    <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 flex items-start gap-2.5">
      <AlertCircle size={15} className="text-[#C62026] flex-shrink-0 mt-0.5" />
      <p className="text-sm text-[#C62026]">{message}</p>
    </div>
  );
}

// ─── User card (used in team detail view) ─────────────────────────────────────

function UserCard({ user, onEdit, onDelete }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-4 shadow-sm hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <Avatar name={user.name} size={44} />
          <div>
            <p className="font-semibold text-[#05164D] text-sm">{user.name}</p>
            {user.designation && <p className="text-xs text-gray-400">{user.designation}</p>}
            <div className="mt-1">
              <RoleBadge subRole={user.sub_role} />
            </div>
          </div>
        </div>
        <StatusDot status={user.status} />
      </div>

      <div className="mt-3 space-y-1.5">
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <Mail size={12} className="text-gray-400 flex-shrink-0" />
          <span className="truncate">{user.email}</span>
        </div>
        {user.phone && (
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <Phone size={12} className="text-gray-400 flex-shrink-0" />
            <span>{user.phone}</span>
          </div>
        )}
        {user.buyer_company_name && (
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <Building2 size={12} className="text-gray-400 flex-shrink-0" />
            <span>{user.buyer_company_name}</span>
          </div>
        )}
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <Calendar size={12} className="text-gray-400 flex-shrink-0" />
          <span>Joined {new Date(user.joinedAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</span>
        </div>
      </div>

      <div className="mt-3 pt-3 border-t border-gray-100 flex items-center gap-2">
        <button
          onClick={() => onEdit(user)}
          className="flex-1 py-1.5 rounded-lg border border-gray-200 text-xs font-semibold text-gray-600 hover:bg-gray-50 flex items-center justify-center gap-1 transition-colors"
        >
          <Pencil size={12} /> Edit
        </button>
        <button
          onClick={() => onDelete(user)}
          className="flex-1 py-1.5 rounded-lg border border-red-100 text-xs font-semibold text-red-500 hover:bg-red-50 flex items-center justify-center gap-1 transition-colors"
        >
          <Trash2 size={12} /> Delete
        </button>
      </div>
    </div>
  );
}

// ─── Buyer card (summary) ──────────────────────────────────────────────────────

function BuyerCard({ buyer, teamMembers, onViewTeam, onEdit, onDelete }) {
  const teamCount = teamMembers.filter((m) => m.sub_role === SUB_ROLE.BUYER_TEAM_MEMBER).length;
  const accountantCount = teamMembers.filter((m) => m.sub_role === SUB_ROLE.BUYER_ACCOUNTANT).length;

  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-4 shadow-sm hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <Avatar name={buyer.name} size={44} />
          <div>
            <p className="font-semibold text-[#05164D] text-sm">{buyer.name}</p>
            {buyer.buyer_company_name && (
              <p className="text-xs text-[#476E2C] font-medium">{buyer.buyer_company_name}</p>
            )}
            {buyer.designation && <p className="text-xs text-gray-400">{buyer.designation}</p>}
          </div>
        </div>
        <StatusDot status={buyer.status} />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <div className="rounded-xl bg-[#E8F3D8] px-3 py-2 text-center">
          <p className="text-lg font-bold text-[#476E2C]">{teamCount}</p>
          <p className="text-[10px] text-[#476E2C] font-medium">Team Members</p>
        </div>
        <div className="rounded-xl bg-[#ECFDF5] px-3 py-2 text-center">
          <p className="text-lg font-bold text-[#059669]">{accountantCount}</p>
          <p className="text-[10px] text-[#059669] font-medium">Accountants</p>
        </div>
      </div>

      <div className="mt-3 space-y-1.5">
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <Mail size={12} className="text-gray-400 flex-shrink-0" />
          <span className="truncate">{buyer.email}</span>
        </div>
        {buyer.phone && (
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <Phone size={12} className="text-gray-400 flex-shrink-0" />
            <span>{buyer.phone}</span>
          </div>
        )}
      </div>

      <div className="mt-3 pt-3 border-t border-gray-100 flex items-center gap-2">
        <button
          onClick={() => onViewTeam(buyer)}
          className="flex-1 py-1.5 rounded-lg bg-[#E8F3D8] text-xs font-semibold text-[#476E2C] hover:bg-[#d4ebbf] flex items-center justify-center gap-1 transition-colors"
        >
          <UsersIcon size={12} /> View Team
        </button>
        <button
          onClick={() => onEdit(buyer)}
          className="py-1.5 px-3 rounded-lg border border-gray-200 text-xs font-semibold text-gray-600 hover:bg-gray-50 flex items-center justify-center gap-1 transition-colors"
        >
          <Pencil size={12} />
        </button>
        <button
          onClick={() => onDelete(buyer)}
          className="py-1.5 px-3 rounded-lg border border-red-100 text-xs font-semibold text-red-500 hover:bg-red-50 flex items-center justify-center gap-1 transition-colors"
        >
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  );
}

// ─── Summary card (Broker Team / Client Team) ─────────────────────────────────

function TeamSummaryCard({ title, icon: Icon, color, bg, users, subRoles, onViewTeam, ownerName, ownerLabel, companyName }) {
  const members = users.filter((u) => subRoles.includes(u.sub_role));
  const active = members.filter((u) => u.status === 'active').length;
  const breakdown = subRoles.map((sr) => ({
    label: ROLE_META[sr]?.label || sr,
    count: members.filter((u) => u.sub_role === sr).length,
  })).filter((r) => r.count > 0);

  return (
    <div
      className="rounded-2xl border p-5 cursor-pointer hover:shadow-md transition-all"
      style={{ background: bg, borderColor: `${color}30` }}
      onClick={onViewTeam}
    >
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: `${color}22` }}>
            <Icon size={20} style={{ color }} />
          </div>
          <div>
            <p className="font-bold text-[#05164D] text-sm">{title}</p>
            {ownerName && <p className="text-xs font-semibold mt-0.5" style={{ color }}>{ownerLabel}: {ownerName}</p>}
            {companyName && <p className="text-xs text-gray-400 truncate max-w-[160px]">{companyName}</p>}
          </div>
        </div>
        <ChevronRight size={16} className="text-gray-400 flex-shrink-0 mt-1" />
      </div>

      <div className="grid grid-cols-2 gap-2 mb-3">
        <div className="rounded-xl bg-white/70 px-3 py-2.5 text-center">
          <p className="text-xl font-bold" style={{ color }}>{members.length}</p>
          <p className="text-[10px] text-gray-500 font-medium">Total</p>
        </div>
        <div className="rounded-xl bg-white/70 px-3 py-2.5 text-center">
          <p className="text-xl font-bold text-green-600">{active}</p>
          <p className="text-[10px] text-gray-500 font-medium">Active</p>
        </div>
      </div>

      {breakdown.length > 0 && (
        <div className="bg-white/50 rounded-xl px-3 py-2.5 space-y-1.5">
          {breakdown.map((r) => (
            <div key={r.label} className="flex items-center justify-between text-xs">
              <span className="text-gray-500">{r.label}</span>
              <span className="font-bold" style={{ color }}>{r.count}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Add/Edit user modal ──────────────────────────────────────────────────────

const EMPTY_FORM = {
  firstName: '', lastName: '', email: '', phone: '', password: '',
  sub_role: '', designation: '', buyer_company_name: '',
  companyIds: [], companyId: '', status: 'active',
};

function splitName(full = '') {
  const parts = (full || '').trim().split(/\s+/);
  return { firstName: parts[0] || '', lastName: parts.slice(1).join(' ') || '' };
}

function TeamMemberRow({ member, onChange, onRemove, roleOptions }) {
  return (
    <div className="flex flex-col sm:flex-row gap-2 p-3 rounded-xl bg-gray-50 border border-gray-100">
      <input
        value={member.name}
        onChange={(e) => onChange({ ...member, name: e.target.value })}
        placeholder="Full Name *"
        className="flex-1 px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#8BC53D]/40 focus:border-[#8BC53D]"
      />
      <input
        value={member.email}
        onChange={(e) => onChange({ ...member, email: e.target.value })}
        placeholder="Email *"
        className="flex-1 px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#8BC53D]/40 focus:border-[#8BC53D]"
      />
      <input
        value={member.phone}
        onChange={(e) => onChange({ ...member, phone: formatUSPhone(e.target.value) })}
        placeholder="Phone"
        maxLength={14}
        className="flex-1 px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#8BC53D]/40 focus:border-[#8BC53D]"
      />
      <select
        value={member.sub_role}
        onChange={(e) => onChange({ ...member, sub_role: e.target.value })}
        className="px-3 py-2 rounded-lg border border-gray-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#8BC53D]/40 focus:border-[#8BC53D]"
      >
        <option value="">Select Role</option>
        {roleOptions.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
      <input
        value={member.password}
        onChange={(e) => onChange({ ...member, password: e.target.value })}
        type="password"
        placeholder="Password *"
        className="flex-1 px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#8BC53D]/40 focus:border-[#8BC53D]"
      />
      <button
        type="button"
        onClick={onRemove}
        className="flex-shrink-0 w-8 h-8 rounded-lg border border-red-100 text-red-400 hover:bg-red-50 flex items-center justify-center"
      >
        <X size={14} />
      </button>
    </div>
  );
}

function UserFormModal({ initial, companies, roleOptions, dbRole, onSave, onClose, submitting, error, showTeamMembers = false, teamMemberRoleOptions = [] }) {
  const isEdit = !!initial?.id;
  const [form, setForm] = useState(() => {
    const s = initial || EMPTY_FORM;
    const { firstName, lastName } = s.name ? splitName(s.name) : { firstName: s.firstName || '', lastName: s.lastName || '' };
    return { ...s, firstName, lastName, companyIds: s.companyIds?.length ? s.companyIds : [s.companyId].filter(Boolean) };
  });
  const [teamMembers, setTeamMembers] = useState([]);
  const [localError, setLocalError] = useState('');
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [dropdownSearch, setDropdownSearch] = useState('');
  const dropdownRef = useRef(null);

  const setField = (patch) => { setForm((c) => ({ ...c, ...patch })); setLocalError(''); };

  useEffect(() => {
    const handler = (e) => { if (dropdownRef.current && !dropdownRef.current.contains(e.target)) setDropdownOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const validate = () => {
    if (!form.firstName.trim()) return 'First name is required.';
    if (!form.lastName.trim()) return 'Last name is required.';
    if (!isValidEmail(form.email)) return 'Valid email is required.';
    if (!form.companyIds?.length) return 'Assign at least one company.';
    if (!form.sub_role) return 'Role is required.';
    if (!isEdit && (!form.password.trim() || form.password.length < 8)) return 'Password must be at least 8 characters.';
    if (showTeamMembers) {
      for (const m of teamMembers) {
        if (!m.name?.trim()) return 'Team member name is required.';
        if (!isValidEmail(m.email)) return 'Team member email is invalid.';
        if (!m.sub_role) return 'Team member role is required.';
        if (!m.password?.trim()) return 'Team member password is required.';
      }
    }
    return '';
  };

  const handleSave = () => {
    const err = validate();
    if (err) { setLocalError(err); return; }
    const name = `${form.firstName.trim()} ${form.lastName.trim()}`.trim();
    onSave({ ...form, name, teamMembers });
  };

  const filteredCompanies = companies.filter((c) => c.name.toLowerCase().includes(dropdownSearch.toLowerCase()));
  const selectedCompanies = companies.filter((c) => (form.companyIds || []).some((id) => String(id) === String(c.id)));

  const displayError = localError || error;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-white/30 backdrop-blur-sm" />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-2xl z-10 animate-fadeIn max-h-[90vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h2 className="text-base font-bold text-[#05164D]">{isEdit ? 'Edit User' : 'Add User'}</h2>
            <p className="text-xs text-gray-400 mt-0.5">{isEdit ? 'Update user information' : 'Create a new user account'}</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-lg hover:bg-gray-100 flex items-center justify-center text-gray-400">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1.5">First Name *</label>
              <input value={form.firstName} onChange={(e) => setField({ firstName: e.target.value })} placeholder="Jane"
                className="w-full px-3.5 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#8BC53D]/40 focus:border-[#8BC53D]" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1.5">Last Name *</label>
              <input value={form.lastName} onChange={(e) => setField({ lastName: e.target.value })} placeholder="Smith"
                className="w-full px-3.5 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#8BC53D]/40 focus:border-[#8BC53D]" />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-500 mb-1.5">Email *</label>
            <input type="email" value={form.email} onChange={(e) => setField({ email: e.target.value })} placeholder="user@company.com"
              className="w-full px-3.5 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#8BC53D]/40 focus:border-[#8BC53D]" />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1.5">Phone</label>
              <div className="flex">
                <span className="flex h-[42px] items-center rounded-l-xl border border-r-0 border-gray-200 bg-gray-50 px-3 text-sm text-gray-500">+1</span>
                <input type="tel" value={form.phone} onChange={(e) => setField({ phone: formatUSPhone(e.target.value) })} placeholder="(555) 000-0000" maxLength={14}
                  className="min-w-0 flex-1 rounded-l-none rounded-r-xl border border-gray-200 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#8BC53D]/40 focus:border-[#8BC53D]" />
              </div>
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1.5">Designation</label>
              <input value={form.designation} onChange={(e) => setField({ designation: e.target.value })} placeholder="e.g. CFO"
                className="w-full px-3.5 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#8BC53D]/40 focus:border-[#8BC53D]" />
            </div>
          </div>

          {/* Buyer company name — shown only for buyer sub-roles */}
          {[SUB_ROLE.BUYER_PRIMARY, SUB_ROLE.BUYER_TEAM_MEMBER, SUB_ROLE.BUYER_ACCOUNTANT].includes(form.sub_role) && (
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1.5">Buyer Company Name *</label>
              <input value={form.buyer_company_name} onChange={(e) => setField({ buyer_company_name: e.target.value })} placeholder="Buyer Company Pvt Ltd"
                className="w-full px-3.5 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#8BC53D]/40 focus:border-[#8BC53D]" />
            </div>
          )}

          {/* Role picker */}
          <div>
            <label className="block text-xs font-semibold text-gray-500 mb-1.5">Role *</label>
            <select value={form.sub_role} onChange={(e) => setField({ sub_role: e.target.value })}
              className="w-full px-3.5 py-2.5 rounded-xl border border-gray-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#8BC53D]/40 focus:border-[#8BC53D]">
              <option value="">Select Role</option>
              {roleOptions.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
            </select>
          </div>

          {/* Company assignment */}
          <div>
            <label className="block text-xs font-semibold text-gray-500 mb-1.5">Assign Companies *</label>
            <div className="relative" ref={dropdownRef}>
              <button type="button" onClick={() => setDropdownOpen((v) => !v)}
                className="w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl border border-gray-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#8BC53D]/40 focus:border-[#8BC53D]">
                <span>{selectedCompanies.length === 0 ? 'Select companies...' : `${selectedCompanies.length} compan${selectedCompanies.length === 1 ? 'y' : 'ies'} selected`}</span>
                <ChevronDown size={16} className={`text-gray-400 transition-transform ${dropdownOpen ? 'rotate-180' : ''}`} />
              </button>
              {dropdownOpen && (
                <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-xl shadow-lg z-10 max-h-48 overflow-y-auto">
                  <div className="sticky top-0 bg-white border-b border-gray-100 p-3">
                    <div className="relative">
                      <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                      <input type="text" placeholder="Search companies..." value={dropdownSearch} onChange={(e) => setDropdownSearch(e.target.value)} autoFocus
                        className="w-full pl-9 pr-3 py-2 rounded-lg border border-gray-200 text-xs focus:outline-none focus:border-[#8BC53D]" />
                    </div>
                  </div>
                  <div className="p-2">
                    {filteredCompanies.map((c) => {
                      const sel = (form.companyIds || []).some((id) => String(id) === String(c.id));
                      return (
                        <button key={c.id} type="button" onClick={() => {
                          const next = sel ? (form.companyIds || []).filter((id) => String(id) !== String(c.id)) : [...(form.companyIds || []), c.id];
                          setField({ companyIds: next, companyId: next[0] || '' });
                        }}
                          className={`w-full flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm text-left transition-colors ${sel ? 'bg-[#E6F3D3] text-[#8BC53D]' : 'text-gray-700 hover:bg-gray-100'}`}>
                          <div className={`w-4 h-4 rounded border flex items-center justify-center ${sel ? 'bg-[#8BC53D] border-[#8BC53D]' : 'border-gray-300'}`}>
                            {sel && <Check size={12} className="text-white" />}
                          </div>
                          <span className="flex-1">{c.name}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
            {selectedCompanies.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-2">
                {selectedCompanies.map((c) => (
                  <div key={c.id} className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-[#E6F3D3] text-[#8BC53D] text-xs font-semibold">
                    <span>{c.name}</span>
                    <button type="button" onClick={() => {
                      const next = (form.companyIds || []).filter((id) => String(id) !== String(c.id));
                      setField({ companyIds: next, companyId: next[0] || '' });
                    }}><X size={12} /></button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-500 mb-1.5">{isEdit ? 'Password Reset' : 'Password'}{!isEdit && ' *'}</label>
            <input type="password" value={form.password} onChange={(e) => setField({ password: e.target.value })}
              placeholder={isEdit ? 'Leave blank to keep existing' : 'Set a password (min 8 chars)'}
              className="w-full px-3.5 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#8BC53D]/40 focus:border-[#8BC53D]" />
          </div>

          {isEdit && (
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1.5">Status *</label>
              <select value={form.status} onChange={(e) => setField({ status: e.target.value })}
                className="w-full px-3.5 py-2.5 rounded-xl border border-gray-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#8BC53D]/40 focus:border-[#8BC53D]">
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </div>
          )}

          {/* Team members section (only for primary buyer/client owner during creation) */}
          {showTeamMembers && !isEdit && (
            <div>
              <div className="flex items-center justify-between mb-3">
                <label className="text-xs font-semibold text-gray-500">Team Members</label>
                <button type="button" onClick={() => setTeamMembers((m) => [...m, { id: Date.now(), name: '', email: '', phone: '', sub_role: teamMemberRoleOptions[0]?.value || '', password: '' }])}
                  className="inline-flex items-center gap-1 text-xs font-semibold text-[#8BC53D] hover:text-[#476E2C] transition-colors">
                  <Plus size={14} /> Add Member
                </button>
              </div>
              {teamMembers.length === 0 ? (
                <p className="text-xs text-gray-400 py-2">No team members added yet.</p>
              ) : (
                <div className="space-y-2">
                  {teamMembers.map((m, idx) => (
                    <TeamMemberRow key={m.id} member={m} roleOptions={teamMemberRoleOptions}
                      onChange={(updated) => setTeamMembers((list) => list.map((x) => x.id === m.id ? updated : x))}
                      onRemove={() => setTeamMembers((list) => list.filter((x) => x.id !== m.id))} />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-gray-100 bg-white flex flex-col gap-3">
          <FormError message={displayError} />
          <div className="flex gap-3">
            <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm font-semibold text-gray-600 hover:bg-gray-50">Cancel</button>
            <button onClick={handleSave} disabled={submitting}
              className="flex-1 py-2.5 rounded-xl bg-[#8BC53D] hover:bg-[#476E2C] disabled:opacity-50 text-white text-sm font-bold transition-colors">
              {submitting ? 'Saving...' : isEdit ? 'Save Changes' : 'Add User'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Delete modal ─────────────────────────────────────────────────────────────

function DeleteModal({ user, onConfirm, onClose, submitting, error }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-white/30 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 z-10">
        <div className="flex items-center justify-center w-14 h-14 rounded-full bg-red-100 mx-auto mb-4">
          <Trash2 size={24} className="text-red-500" />
        </div>
        <h3 className="text-center text-lg font-bold text-[#05164D] mb-1">Delete User</h3>
        <p className="text-center text-sm text-gray-500 mb-6">
          Are you sure you want to delete <span className="font-semibold text-[#05164D]">{user.name}</span>? This action cannot be undone.
        </p>
        {error && <p className="mb-4 text-sm text-red-600 bg-red-50 rounded-xl px-3 py-2 text-center">{error}</p>}
        <div className="flex gap-3">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm font-semibold text-gray-600 hover:bg-gray-50">Cancel</button>
          <button onClick={onConfirm} disabled={submitting} className="flex-1 py-2.5 rounded-xl bg-red-500 hover:bg-red-600 text-white text-sm font-semibold disabled:opacity-60">
            {submitting ? 'Deleting...' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Team detail view ─────────────────────────────────────────────────────────

function TeamDetailView({ title, users, subRoles, onBack, onAdd, onEdit, onDelete }) {
  const [search, setSearch] = useState('');
  const filtered = users.filter((u) =>
    subRoles.includes(u.sub_role) &&
    (!search || u.name.toLowerCase().includes(search.toLowerCase()) || u.email.toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <div className="space-y-6 animate-fadeIn">
      <div className="flex items-center gap-4">
        <button onClick={onBack} className="w-9 h-9 rounded-xl border border-gray-200 flex items-center justify-center text-gray-500 hover:bg-gray-50">
          <ArrowLeft size={16} />
        </button>
        <div>
          <h2 className="text-xl font-bold text-[#05164D]">{title}</h2>
          <p className="text-sm text-gray-500">{filtered.length} member{filtered.length !== 1 ? 's' : ''}</p>
        </div>
        <div className="ml-auto">
          <button onClick={onAdd} className="inline-flex items-center gap-2 px-4 py-2 bg-[#8BC53D] hover:bg-[#476E2C] text-white rounded-xl text-sm font-bold transition-colors">
            <Plus size={15} /> Add Member
          </button>
        </div>
      </div>

      <div className="relative">
        <Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400" />
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search members..."
          className="w-full pl-9 pr-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#8BC53D]/40 focus:border-[#8BC53D] bg-gray-50" />
      </div>

      {filtered.length === 0 ? (
        <div className="py-16 text-center">
          <UsersIcon size={36} className="mx-auto text-gray-200 mb-3" />
          <p className="text-sm font-semibold text-gray-400">No members found</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filtered.map((u) => (
            <UserCard key={u.id} user={u} onEdit={onEdit} onDelete={onDelete} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Buyer team detail view ───────────────────────────────────────────────────

function BuyerTeamView({ buyer, teamMembers, onBack, onAddMember, onEdit, onDelete }) {
  const members = teamMembers.filter((m) => m.parent_user_id === buyer.id || m.id === buyer.id);
  const [search, setSearch] = useState('');
  const filtered = members.filter((m) =>
    !search || m.name.toLowerCase().includes(search.toLowerCase()) || m.email.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-6 animate-fadeIn">
      <div className="flex items-center gap-4">
        <button onClick={onBack} className="w-9 h-9 rounded-xl border border-gray-200 flex items-center justify-center text-gray-500 hover:bg-gray-50">
          <ArrowLeft size={16} />
        </button>
        <div className="flex items-center gap-3">
          <Avatar name={buyer.name} size={40} />
          <div>
            <h2 className="text-xl font-bold text-[#05164D]">{buyer.buyer_company_name || buyer.name}</h2>
            <p className="text-sm text-gray-500">{filtered.length} team member{filtered.length !== 1 ? 's' : ''}</p>
          </div>
        </div>
        <div className="ml-auto">
          <button onClick={onAddMember} className="inline-flex items-center gap-2 px-4 py-2 bg-[#8BC53D] hover:bg-[#476E2C] text-white rounded-xl text-sm font-bold transition-colors">
            <Plus size={15} /> Add Team Member
          </button>
        </div>
      </div>

      <div className="relative">
        <Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400" />
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search team members..."
          className="w-full pl-9 pr-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#8BC53D]/40 focus:border-[#8BC53D] bg-gray-50" />
      </div>

      {filtered.length === 0 ? (
        <div className="py-12 text-center">
          <UsersIcon size={36} className="mx-auto text-gray-200 mb-3" />
          <p className="text-sm font-semibold text-gray-400">No team members yet</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filtered.map((m) => (
            <UserCard key={m.id} user={m} onEdit={onEdit} onDelete={onDelete} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

// view: 'overview' | 'broker-team' | 'client-team' | 'buyer-team'
export default function BrokerUsers() {
  const { user: authUser } = useAuth();
  const [allUsers, setAllUsers] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const [view, setView] = useState('overview');
  const [selectedBuyer, setSelectedBuyer] = useState(null);

  const [editUser, setEditUser] = useState(null);
  const [deleteUser, setDeleteUser] = useState(null);
  const [formError, setFormError] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // What role context to open "Add User" in
  const [addContext, setAddContext] = useState(null); // 'broker' | 'client' | 'buyer' | 'buyer-member'

  const loadData = async () => {
    setLoading(true);
    setError('');
    try {
      const [usersRes, companiesRes] = await Promise.all([listUsersRequest(), listCompaniesRequest()]);
      setAllUsers(usersRes.map(normalizeUser).filter(Boolean));
      setCompanies(companiesRes);
    } catch (err) {
      setError(err.message || 'Unable to load users.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadData(); }, []);
  useEffect(() => { if (!success) return; const t = setTimeout(() => setSuccess(''), 3500); return () => clearTimeout(t); }, [success]);

  // Grouped users
  // Robust classification — same logic as WorkspaceUsers so both pages agree.
  const classifyUser = (u) => {
    const sub = u.sub_role;
    if (BROKER_SUB_ROLES.includes(sub)) return 'broker';
    if (BUYER_SUB_ROLES.includes(sub))  return 'buyer';
    if (CLIENT_SUB_ROLES.includes(sub)) return 'client';
    if (u.buyer_company_name && String(u.buyer_company_name).trim()) return 'buyer';
    if (u.parent_user_id) return 'buyer';
    if (u.role === 'broker' || u.role === 'admin') return 'broker';
    return 'client';
  };

  const brokerUsers    = useMemo(() => allUsers.filter((u) => classifyUser(u) === 'broker'), [allUsers]);
  const clientUsers    = useMemo(() => allUsers.filter((u) => classifyUser(u) === 'client'), [allUsers]);
  const buyerPrimaries = useMemo(() => allUsers.filter((u) => classifyUser(u) === 'buyer' && !u.parent_user_id), [allUsers]);
  const buyerTeamMembers = useMemo(() => allUsers.filter((u) => classifyUser(u) === 'buyer' && !!u.parent_user_id), [allUsers]);
  const allBuyerUsers  = useMemo(() => allUsers.filter((u) => classifyUser(u) === 'buyer'), [allUsers]);

  // Derived summary names
  const primaryBroker = useMemo(() => brokerUsers.find((u) => u.sub_role === SUB_ROLE.BROKER_PRIMARY) || brokerUsers[0], [brokerUsers]);
  const companyOwner = useMemo(() => clientUsers.find((u) => u.sub_role === SUB_ROLE.COMPANY_OWNER) || clientUsers[0], [clientUsers]);
  const brokerCompanyName = authUser?.broker_company || authUser?.company || primaryBroker?.company || '';
  const clientCompanyName = companyOwner?.company || companies.find((c) => c.id === companyOwner?.companyId)?.name || '';

  // Role options per context
  const roleOptionsMap = {
    broker: [
      { value: SUB_ROLE.BROKER_TEAM_MEMBER, label: 'Broker Team Member' },
      { value: SUB_ROLE.BANKER, label: 'Banker' },
      { value: SUB_ROLE.LOAN_BROKER, label: 'Loan Broker' },
    ],
    client: [
      { value: SUB_ROLE.COMPANY_OWNER, label: 'Company Owner' },
      { value: SUB_ROLE.CLIENT_TEAM_MEMBER, label: 'Client Team Member' },
      { value: SUB_ROLE.CLIENT_ACCOUNTANT, label: 'Client Accountant' },
    ],
    buyer: [
      { value: SUB_ROLE.BUYER_PRIMARY, label: 'Buyer (Primary)' },
    ],
    'buyer-member': BUYER_TEAM_ROLE_OPTIONS,
  };

  const dbRoleMap = {
    broker: 'broker',
    client: 'buyer',
    buyer: 'buyer',
    'buyer-member': 'buyer',
  };

  const teamMemberRoleOptions = addContext === 'buyer' ? BUYER_TEAM_ROLE_OPTIONS
    : addContext === 'client' ? CLIENT_TEAM_ROLE_OPTIONS
    : [];

  const handleAdd = async (form) => {
    setSubmitting(true);
    setFormError('');
    try {
      const dbRole = dbRoleMap[addContext] || 'buyer';
      const payload = {
        name: form.name.trim(),
        email: form.email.trim(),
        phone: form.phone?.trim() || null,
        password: form.password,
        role: dbRole,
        sub_role: form.sub_role,
        designation: form.designation?.trim() || null,
        buyer_company_name: form.buyer_company_name?.trim() || null,
        parent_user_id: form.parent_user_id || null,
        company_id: form.companyId || null,
        company_ids: Array.from(new Set([form.companyId, ...(form.companyIds || [])].filter(Boolean))),
        status: 'active',
      };
      const created = await createUserRequest(payload);
      if (created?.id && form.teamMembers?.length) {
        await Promise.all(
          form.teamMembers.map((m) =>
            createUserRequest({
              name: m.name.trim(),
              email: m.email.trim(),
              phone: m.phone?.trim() || null,
              password: m.password,
              role: dbRole,
              sub_role: m.sub_role,
              parent_user_id: created.id,
              company_id: payload.company_id,
              company_ids: payload.company_ids,
              status: 'active',
            })
          )
        );
      }
      // Trigger message group auto-creation for all affected companies (non-fatal)
      const affectedCompanyIds = Array.from(new Set([payload.company_id, ...(payload.company_ids || [])].filter(Boolean)));
      await Promise.allSettled(affectedCompanyIds.map((cid) => triggerAutoCreateMessageGroups(cid)));

      await loadData();
      setEditUser(null);
      setAddContext(null);
      setSuccess('User created successfully.');
    } catch (err) {
      setFormError(formatApiError(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleEdit = async (form) => {
    setSubmitting(true);
    setFormError('');
    try {
      const payload = {
        name: form.name.trim(),
        email: form.email.trim(),
        phone: form.phone?.trim() || null,
        sub_role: form.sub_role,
        designation: form.designation?.trim() || null,
        buyer_company_name: form.buyer_company_name?.trim() || null,
        company_id: form.companyId || null,
        company_ids: Array.from(new Set([form.companyId, ...(form.companyIds || [])].filter(Boolean))),
        status: form.status,
      };
      if (form.password?.trim()) payload.password = form.password;
      await updateUserRequest(form.id, payload);
      await loadData();
      setEditUser(null);
      setSuccess('User updated successfully.');
    } catch (err) {
      setFormError(formatApiError(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    setSubmitting(true);
    setDeleteError('');
    try {
      await deleteUserRequest(deleteUser.id);
      await loadData();
      setDeleteUser(null);
      setSuccess('User deleted.');
    } catch (err) {
      setDeleteError(err.message || 'Unable to delete user.');
    } finally {
      setSubmitting(false);
    }
  };

  const openEdit = (user) => { setFormError(''); setEditUser({ ...user, password: '' }); };
  const openAdd = (ctx) => { setFormError(''); setAddContext(ctx); setEditUser({ ...EMPTY_FORM, isNew: true }); };

  // ── Render views ──────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center py-32">
        <div className="text-sm text-gray-400 animate-pulse">Loading users...</div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 animate-fadeIn">
      {/* Toast */}
      {success && (
        <div className="px-4 py-3 bg-green-50 rounded-2xl border border-green-100 text-sm text-green-700">{success}</div>
      )}
      {error && (
        <div className="px-4 py-3 bg-red-50 rounded-2xl border border-red-100 text-sm text-[#C62026]">{error}</div>
      )}

      {/* ── Overview ── */}
      {view === 'overview' && (
        <>
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-[#05164D]">Users</h1>
              <p className="text-sm text-gray-500 mt-0.5">{allUsers.length} registered user{allUsers.length !== 1 ? 's' : ''}</p>
            </div>
          </div>

          {/* Team Summary Cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <TeamSummaryCard
              title="Broker Team"
              icon={Briefcase}
              color="#b45e08"
              bg="#FFFAF5"
              users={allUsers}
              subRoles={BROKER_SUB_ROLES}
              onViewTeam={() => setView('broker-team')}
              ownerName={primaryBroker?.name || authUser?.name}
              ownerLabel="Broker"
              companyName={brokerCompanyName}
            />
            <TeamSummaryCard
              title="Client Team"
              icon={Building2}
              color="#00648F"
              bg="#F0F9FF"
              users={allUsers}
              subRoles={CLIENT_SUB_ROLES}
              onViewTeam={() => setView('client-team')}
              ownerName={companyOwner?.name}
              ownerLabel="Owner"
              companyName={clientCompanyName}
            />
          </div>

          {/* Buyers Section */}
          <div>
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-lg font-bold text-[#05164D]">Buyers</h2>
                <p className="text-sm text-gray-500">{buyerPrimaries.length} buyer{buyerPrimaries.length !== 1 ? 's' : ''} · {buyerTeamMembers.length} team member{buyerTeamMembers.length !== 1 ? 's' : ''}</p>
              </div>
              <button
                onClick={() => openAdd('buyer')}
                className="inline-flex items-center gap-2 px-4 py-2 bg-[#8BC53D] hover:bg-[#476E2C] text-white rounded-xl text-sm font-bold transition-colors shadow-sm"
              >
                <Plus size={15} /> Add New Buyer
              </button>
            </div>

            {buyerPrimaries.length === 0 ? (
              <div className="py-16 text-center bg-white rounded-2xl border border-gray-100">
                <ShoppingCart size={36} className="mx-auto text-gray-200 mb-3" />
                <p className="text-sm font-semibold text-gray-400">No buyers yet</p>
                <button onClick={() => openAdd('buyer')} className="mt-3 text-xs text-[#8BC53D] hover:underline font-semibold">Add first buyer</button>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {buyerPrimaries.map((buyer) => {
                  const team = allBuyerUsers.filter((u) => u.parent_user_id === buyer.id);
                  return (
                    <BuyerCard
                      key={buyer.id}
                      buyer={buyer}
                      teamMembers={team}
                      onViewTeam={(b) => { setSelectedBuyer(b); setView('buyer-team'); }}
                      onEdit={openEdit}
                      onDelete={(u) => { setDeleteError(''); setDeleteUser(u); }}
                    />
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}

      {/* ── Broker Team Detail ── */}
      {view === 'broker-team' && (
        <TeamDetailView
          title="Broker Team"
          users={allUsers}
          subRoles={BROKER_SUB_ROLES}
          onBack={() => setView('overview')}
          onAdd={() => openAdd('broker')}
          onEdit={openEdit}
          onDelete={(u) => { setDeleteError(''); setDeleteUser(u); }}
        />
      )}

      {/* ── Client Team Detail ── */}
      {view === 'client-team' && (
        <TeamDetailView
          title="Client Team"
          users={allUsers}
          subRoles={CLIENT_SUB_ROLES}
          onBack={() => setView('overview')}
          onAdd={() => openAdd('client')}
          onEdit={openEdit}
          onDelete={(u) => { setDeleteError(''); setDeleteUser(u); }}
        />
      )}

      {/* ── Buyer Team Detail ── */}
      {view === 'buyer-team' && selectedBuyer && (
        <BuyerTeamView
          buyer={selectedBuyer}
          teamMembers={allBuyerUsers}
          onBack={() => { setView('overview'); setSelectedBuyer(null); }}
          onAddMember={() => openAdd('buyer-member')}
          onEdit={openEdit}
          onDelete={(u) => { setDeleteError(''); setDeleteUser(u); }}
        />
      )}

      {/* ── Modals ── */}
      {editUser && (
        <UserFormModal
          initial={editUser}
          companies={companies}
          roleOptions={roleOptionsMap[addContext || 'broker'] || []}
          dbRole={dbRoleMap[addContext || 'broker']}
          onSave={editUser?.isNew ? handleAdd : handleEdit}
          onClose={() => { setFormError(''); setEditUser(null); setAddContext(null); }}
          submitting={submitting}
          error={formError}
          showTeamMembers={!editUser?.id && (addContext === 'buyer' || addContext === 'client')}
          teamMemberRoleOptions={teamMemberRoleOptions}
        />
      )}

      {deleteUser && (
        <DeleteModal
          user={deleteUser}
          onConfirm={handleDelete}
          onClose={() => { setDeleteError(''); setDeleteUser(null); }}
          submitting={submitting}
          error={deleteError}
        />
      )}
    </div>
  );
}
