import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useParams } from 'react-router-dom';
import {
  AlertCircle, ArrowLeft, Briefcase, Building2, Calendar,
  Check, ChevronDown, ChevronLeft, ChevronRight, Mail, Pencil,
  Phone, Plus, Search, ShoppingCart, Trash2, UserPlus,
  Users as UsersIcon, X,
} from 'lucide-react';
import {
  createUserRequest, deleteUserRequest, listCompaniesRequest,
  listUsersRequest, updateUserRequest, triggerAutoCreateMessageGroups,
  findUserByEmailRequest, addUserToCompaniesRequest, inviteBrokerToTeamRequest,
} from '../../../lib/api';
import {
  BROKER_SUB_ROLES, BUYER_SUB_ROLES, CLIENT_SUB_ROLES, ROLE_META,
  SUB_ROLE, BROKER_TEAM_ROLE_OPTIONS, CLIENT_TEAM_ROLE_OPTIONS,
  BUYER_TEAM_ROLE_OPTIONS, inferSubRole, getRoleMeta,
} from '../../../lib/roles';
import { useAuth } from '../../../context/AuthContext';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const palette = ['#8BC53D', '#05164D', '#F68C1F', '#742982', '#00648F', '#476E2C'];
const getColor = (name = '') => palette[(name || '').length % palette.length];
const initials = (name = '') => name.split(' ').filter(Boolean).map((p) => p[0]).join('').slice(0, 2).toUpperCase();
const isValidEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
const fmtPhone = (raw) => { const d = (raw || '').replace(/\D/g, '').slice(0, 10); if (d.length <= 3) return d; if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`; return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`; };
const fmtApiError = (err) => { const m = String(err?.message || err || ''); if (/duplicate|already exists|unique constraint|email.*taken/i.test(m)) return 'A user with this email already exists.'; return m || 'Something went wrong.'; };
const fmtDate = (v) => { try { return new Date(v).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); } catch { return '—'; } };

function normalizeUser(u) {
  if (!u) return null;
  const assignedCompanies = u.assigned_companies || u.assignedCompanies || [];
  const companyIds = Array.from(new Set([...(u.company_ids || u.companyIds || []), ...assignedCompanies.map((c) => c.id).filter(Boolean), u.company_id].filter(Boolean)));
  // inferSubRole uses buyer_company_name + parent_user_id as additional signals,
  // so even users that predate migration 041 are classified correctly.
  const sub = u.sub_role || inferSubRole(u);
  return {
    id: u.id, name: u.name || '', email: u.email || '', phone: u.phone || '',
    role: u.role, sub_role: sub, designation: u.designation || '',
    buyer_company_name: u.buyer_company_name || '', parent_user_id: u.parent_user_id || null,
    status: u.status || 'active', companyId: u.company_id || companyIds[0] || '',
    companyIds, assignedCompanies,
    company: u.company_name || assignedCompanies[0]?.name || 'Unassigned',
    joinedAt: u.created_at, avatar: initials(u.name || ''),
  };
}

/**
 * Robust section classifier — uses sub_role first, then additional signals
 * so that users created before migration 041 still land in the right section.
 * Returns 'broker' | 'client' | 'buyer' | 'unknown'
 */
function classifyUser(u) {
  const sub = u.sub_role;

  // 1. Explicit sub_role always wins
  if (BROKER_SUB_ROLES.includes(sub)) return 'broker';
  if (BUYER_SUB_ROLES.includes(sub))  return 'buyer';
  if (CLIENT_SUB_ROLES.includes(sub)) return 'client';

  // 2. buyer_company_name is a strong buyer signal
  if (u.buyer_company_name && String(u.buyer_company_name).trim()) return 'buyer';

  // 3. parent_user_id without a buyer_company_name → still buyer-side team member
  if (u.parent_user_id) return 'buyer';

  // 4. DB role fallback
  if (u.role === 'broker' || u.role === 'admin') return 'broker';
  // buyer/client with no other signals = company owner (client side)
  return 'client';
}

// ─── Shared mini-components ───────────────────────────────────────────────────

function Avatar({ name, size = 40 }) {
  return <div className="rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0" style={{ width: size, height: size, background: getColor(name) }}>{initials(name)}</div>;
}

function RoleBadge({ subRole }) {
  const meta = ROLE_META[subRole] || { label: subRole || '—', color: '#6B7280', bg: '#F9FAFB', border: '#E5E7EB' };
  return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold border" style={{ color: meta.color, background: meta.bg, borderColor: meta.border }}>{meta.label}</span>;
}

function StatusDot({ status }) {
  return <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${status === 'active' ? 'text-green-600' : 'text-gray-400'}`}><span className={`w-1.5 h-1.5 rounded-full ${status === 'active' ? 'bg-green-500' : 'bg-gray-300'}`} />{status === 'active' ? 'Active' : 'Inactive'}</span>;
}

function FormError({ message }) {
  if (!message) return null;
  return <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 flex items-start gap-2.5"><AlertCircle size={15} className="text-[#C62026] flex-shrink-0 mt-0.5" /><p className="text-sm text-[#C62026]">{message}</p></div>;
}

// ─── User card ────────────────────────────────────────────────────────────────

function UserCard({ user, onEdit }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-4 shadow-sm hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <Avatar name={user.name} size={44} />
          <div>
            <p className="font-semibold text-[#05164D] text-sm leading-tight">{user.name}</p>
            {user.designation && <p className="text-xs text-gray-400 mt-0.5">{user.designation}</p>}
            <div className="mt-1.5"><RoleBadge subRole={user.sub_role} /></div>
          </div>
        </div>
        <StatusDot status={user.status} />
      </div>
      <div className="mt-3 space-y-1.5">
        <div className="flex items-center gap-2 text-xs text-gray-500"><Mail size={11} className="text-gray-400 flex-shrink-0" /><span className="truncate">{user.email || '—'}</span></div>
        {user.phone && <div className="flex items-center gap-2 text-xs text-gray-500"><Phone size={11} className="text-gray-400 flex-shrink-0" /><span>{user.phone}</span></div>}
        {user.buyer_company_name && <div className="flex items-center gap-2 text-xs text-gray-500"><Building2 size={11} className="text-gray-400 flex-shrink-0" /><span>{user.buyer_company_name}</span></div>}
        <div className="flex items-center gap-2 text-xs text-gray-400"><Calendar size={11} className="text-gray-400 flex-shrink-0" /><span>Joined {fmtDate(user.joinedAt)}</span></div>
      </div>
      <div className="mt-3 pt-3 border-t border-gray-100">
        <button onClick={() => onEdit(user)} className="w-full py-1.5 rounded-lg border border-gray-200 text-xs font-semibold text-gray-600 hover:bg-gray-50 flex items-center justify-center gap-1 transition-colors"><Pencil size={11} /> Edit</button>
      </div>
    </div>
  );
}

// ─── Buyer summary card ───────────────────────────────────────────────────────

function BuyerCard({ buyer, allUsers, onViewTeam, onEdit }) {
  const team = allUsers.filter((u) => u.parent_user_id === buyer.id);
  // Include the buyer themselves in the team count (they are the primary member)
  const teamCount = 1 + team.filter((u) => u.sub_role === SUB_ROLE.BUYER_TEAM_MEMBER).length;
  const acctCount = team.filter((u) => u.sub_role === SUB_ROLE.BUYER_ACCOUNTANT).length;
  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-4 shadow-sm hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <Avatar name={buyer.name} size={44} />
          <div>
            <p className="font-semibold text-[#05164D] text-sm leading-tight">{buyer.name}</p>
            {buyer.buyer_company_name && <p className="text-xs text-[#476E2C] font-semibold mt-0.5">{buyer.buyer_company_name}</p>}
            {buyer.designation && <p className="text-xs text-gray-400">{buyer.designation}</p>}
          </div>
        </div>
        <StatusDot status={buyer.status} />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <div className="rounded-xl bg-[#E8F3D8] px-3 py-2 text-center"><p className="text-base font-bold text-[#476E2C]">{teamCount}</p><p className="text-[10px] text-[#476E2C] font-medium">Team Members</p></div>
        <div className="rounded-xl bg-[#ECFDF5] px-3 py-2 text-center"><p className="text-base font-bold text-[#059669]">{acctCount}</p><p className="text-[10px] text-[#059669] font-medium">Accountants</p></div>
      </div>
      <div className="mt-3 space-y-1.5">
        <div className="flex items-center gap-2 text-xs text-gray-500"><Mail size={11} className="text-gray-400 flex-shrink-0" /><span className="truncate">{buyer.email || '—'}</span></div>
        {buyer.phone && <div className="flex items-center gap-2 text-xs text-gray-500"><Phone size={11} className="text-gray-400 flex-shrink-0" /><span>{buyer.phone}</span></div>}
      </div>
      <div className="mt-3 pt-3 border-t border-gray-100 flex items-center gap-2">
        <button onClick={() => onViewTeam(buyer)} className="flex-1 py-1.5 rounded-lg bg-[#E8F3D8] text-xs font-semibold text-[#476E2C] hover:bg-[#d4ebbf] flex items-center justify-center gap-1 transition-colors"><UsersIcon size={11} /> View Team</button>
        <button onClick={() => onEdit(buyer)} className="py-1.5 px-2.5 rounded-lg border border-gray-200 text-xs text-gray-600 hover:bg-gray-50 flex items-center justify-center transition-colors"><Pencil size={11} /></button>
      </div>
    </div>
  );
}

// ─── Team summary card (Broker / Client) ─────────────────────────────────────

function TeamSummaryCard({ title, subtitle, ownerName, ownerLabel, color, bg, borderColor, icon: Icon, members, subRoles, onViewTeam, onAdd }) {
  const active = members.filter((u) => u.status === 'active').length;
  const breakdown = subRoles.map((sr) => ({ label: ROLE_META[sr]?.label || sr, count: members.filter((u) => u.sub_role === sr).length })).filter((r) => r.count > 0);
  return (
    <div className="rounded-2xl border p-5 flex flex-col gap-4" style={{ background: bg, borderColor }}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: `${color}22` }}>
            <Icon size={20} style={{ color }} />
          </div>
          <div>
            <p className="font-bold text-[#05164D] text-sm">{title}</p>
            {ownerName && <p className="text-xs font-semibold mt-0.5" style={{ color }}>{ownerLabel}: {ownerName}</p>}
            {subtitle && <p className="text-xs text-gray-400">{subtitle}</p>}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
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
        <div className="space-y-1.5 bg-white/50 rounded-xl px-3 py-2.5">
          {breakdown.map((r) => (
            <div key={r.label} className="flex items-center justify-between text-xs">
              <span className="text-gray-500">{r.label}</span>
              <span className="font-bold" style={{ color }}>{r.count}</span>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-2 pt-1">
        <button onClick={onViewTeam} className="flex-1 py-2 rounded-xl text-xs font-bold text-white transition-colors" style={{ background: color }}>View Team</button>
        <button onClick={onAdd} className="py-2 px-3 rounded-xl border text-xs font-semibold flex items-center gap-1 hover:bg-white/60 transition-colors" style={{ color, borderColor }}>
          <Plus size={12} /> Add
        </button>
      </div>
    </div>
  );
}

// ─── Team detail view ─────────────────────────────────────────────────────────

function TeamDetailView({ title, subtitle, members, filterSubRoles, onBack, onAdd, onEdit }) {
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('All');
  const roleOptions = ['All', ...filterSubRoles];

  const filtered = members.filter((u) => {
    const matchSearch = !search || u.name.toLowerCase().includes(search.toLowerCase()) || u.email.toLowerCase().includes(search.toLowerCase());
    const matchRole = roleFilter === 'All' || u.sub_role === roleFilter;
    return matchSearch && matchRole;
  });

  return (
    <div className="space-y-5 animate-fadeIn">
      <div className="flex items-center gap-4">
        <button onClick={onBack} className="w-9 h-9 rounded-xl border border-gray-200 flex items-center justify-center text-gray-500 hover:bg-gray-50 flex-shrink-0">
          <ArrowLeft size={16} />
        </button>
        <div className="flex-1 min-w-0">
          <h2 className="text-xl font-bold text-[#05164D] truncate">{title}</h2>
          {subtitle && <p className="text-sm text-gray-400 truncate">{subtitle}</p>}
        </div>
        <button onClick={onAdd} className="inline-flex items-center gap-2 px-4 py-2 bg-[#8BC53D] hover:bg-[#476E2C] text-white rounded-xl text-sm font-bold transition-colors flex-shrink-0">
          <Plus size={14} /> Add Member
        </button>
      </div>

      {/* Search + role filter */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name or email..."
            className="w-full pl-9 pr-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#8BC53D]/40 focus:border-[#8BC53D] bg-gray-50" />
        </div>
        <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}
          className="px-3 py-2.5 rounded-xl border border-gray-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#8BC53D]/30 min-w-[160px]">
          <option value="All">All Roles</option>
          {filterSubRoles.map((sr) => <option key={sr} value={sr}>{ROLE_META[sr]?.label || sr}</option>)}
        </select>
      </div>

      {filtered.length === 0 ? (
        <div className="py-16 text-center bg-white rounded-2xl border border-gray-100">
          <UsersIcon size={36} className="mx-auto text-gray-200 mb-3" />
          <p className="text-sm font-semibold text-gray-400">No members found</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filtered.map((u) => <UserCard key={u.id} user={u} onEdit={onEdit} />)}
        </div>
      )}
    </div>
  );
}

// ─── Buyer team detail view ───────────────────────────────────────────────────

function BuyerTeamView({ buyer, allUsers, onBack, onAddMember, onEdit }) {
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('All');
  const members = allUsers.filter((u) => u.parent_user_id === buyer.id || u.id === buyer.id);
  const teamRoles = [SUB_ROLE.BUYER_PRIMARY, SUB_ROLE.BUYER_TEAM_MEMBER, SUB_ROLE.BUYER_ACCOUNTANT];

  const filtered = members.filter((u) => {
    const matchSearch = !search || u.name.toLowerCase().includes(search.toLowerCase()) || u.email.toLowerCase().includes(search.toLowerCase());
    const matchRole = roleFilter === 'All' || u.sub_role === roleFilter;
    return matchSearch && matchRole;
  });

  return (
    <div className="space-y-5 animate-fadeIn">
      <div className="flex items-center gap-4">
        <button onClick={onBack} className="w-9 h-9 rounded-xl border border-gray-200 flex items-center justify-center text-gray-500 hover:bg-gray-50 flex-shrink-0">
          <ArrowLeft size={16} />
        </button>
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <Avatar name={buyer.name} size={40} />
          <div className="min-w-0">
            <h2 className="text-xl font-bold text-[#05164D] truncate">{buyer.buyer_company_name || buyer.name}</h2>
            <p className="text-sm text-gray-400">{members.length} member{members.length !== 1 ? 's' : ''}</p>
          </div>
        </div>
        <button onClick={onAddMember} className="inline-flex items-center gap-2 px-4 py-2 bg-[#8BC53D] hover:bg-[#476E2C] text-white rounded-xl text-sm font-bold transition-colors flex-shrink-0">
          <Plus size={14} /> Add Member
        </button>
      </div>

      {/* Buyer info strip */}
      <div className="bg-white rounded-2xl border border-gray-100 p-4 flex flex-wrap gap-4">
        {[{ icon: Mail, label: 'Email', val: buyer.email }, { icon: Phone, label: 'Phone', val: buyer.phone || '—' }, { icon: Building2, label: 'Company', val: buyer.buyer_company_name || '—' }].map(({ icon: Icon, label, val }) => (
          <div key={label} className="flex items-center gap-2 text-sm">
            <div className="w-8 h-8 rounded-lg bg-gray-50 flex items-center justify-center"><Icon size={13} className="text-gray-400" /></div>
            <div><p className="text-[10px] text-gray-400">{label}</p><p className="text-xs font-semibold text-[#05164D]">{val}</p></div>
          </div>
        ))}
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name or email..."
            className="w-full pl-9 pr-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#8BC53D]/40 focus:border-[#8BC53D] bg-gray-50" />
        </div>
        <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}
          className="px-3 py-2.5 rounded-xl border border-gray-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#8BC53D]/30 min-w-[160px]">
          <option value="All">All Roles</option>
          {teamRoles.map((sr) => <option key={sr} value={sr}>{ROLE_META[sr]?.label || sr}</option>)}
        </select>
      </div>

      {filtered.length === 0 ? (
        <div className="py-12 text-center bg-white rounded-2xl border border-gray-100">
          <UsersIcon size={36} className="mx-auto text-gray-200 mb-3" />
          <p className="text-sm font-semibold text-gray-400">No members yet</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filtered.map((u) => <UserCard key={u.id} user={u} onEdit={onEdit} />)}
        </div>
      )}
    </div>
  );
}

// ─── Existing-user confirmation modal ────────────────────────────────────────

const CONTEXT_META = {
  broker:         { title: 'Broker Already Exists',  label: 'broker', verb: 'Add to Broker Team' },
  client:         { title: 'Client Already Exists',  label: 'client', verb: 'Add Existing Account' },
  buyer:          { title: 'Buyer Already Exists',   label: 'buyer',  verb: 'Add Existing Account' },
  'buyer-member': { title: 'Buyer Already Exists',   label: 'buyer',  verb: 'Add Existing Account' },
};

function ExistingUserConfirmModal({ foundUser, context, companyNames, onConfirm, onClose, submitting }) {
  const meta = CONTEXT_META[context] || CONTEXT_META.client;
  const detail = (context === 'buyer' || context === 'buyer-member') && foundUser.buyer_company_name
    ? `${foundUser.name} (${foundUser.buyer_company_name})`
    : foundUser.name;

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, zIndex: 999999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}>
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(255,255,255,0.35)', backdropFilter: 'blur(4px)' }} onClick={onClose} />
      <div style={{ position: 'relative', zIndex: 1, background: '#fff', borderRadius: 16, padding: 24, width: '100%', maxWidth: 360, boxShadow: '0 8px 32px rgba(0,0,0,0.14)' }}>
        <div className="flex items-center justify-center w-14 h-14 rounded-full bg-blue-50 mx-auto mb-4">
          <UsersIcon size={24} className="text-[#00648F]" />
        </div>
        <h3 className="text-center text-base font-bold text-[#05164D] mb-2">{meta.title}</h3>
        <p className="text-center text-sm text-gray-500 mb-1">
          This email is already linked to a {meta.label}:
        </p>
        <p className="text-center text-sm font-semibold text-[#05164D] mb-4">{detail}</p>
        {companyNames?.length > 0 && (
          <p className="text-center text-xs text-gray-400 mb-4">
            They will be added to: {companyNames.join(', ')}
          </p>
        )}
        <p className="text-center text-xs text-gray-400 mb-5">
          Would you like to add this existing account to your team?
        </p>
        <div className="flex gap-3">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm font-semibold text-gray-600 hover:bg-gray-50">
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={submitting}
            className="flex-1 py-2.5 rounded-xl bg-[#8BC53D] hover:bg-[#476E2C] text-white text-sm font-bold disabled:opacity-50 transition-colors"
          >
            {submitting ? 'Adding...' : meta.verb}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ─── Add/Edit user form (portal modal) ────────────────────────────────────────

const EMPTY_FORM = { firstName: '', lastName: '', email: '', phone: '', password: '', sub_role: '', designation: '', buyer_company_name: '', status: 'active' };

function splitName(full = '') { const p = (full || '').trim().split(/\s+/); return { firstName: p[0] || '', lastName: p.slice(1).join(' ') || '' }; }

// Clears a single field's error when the user edits that field
function clearFieldErr(member, field) {
  const fe = { ...(member.fieldErrors || {}) };
  delete fe[field];
  return { ...member, fieldErrors: fe };
}

function TeamMemberRow({ member, index, onChange, onRemove, roleOptions }) {
  const fe = member.fieldErrors || {};

  const field = (key, updater) => onChange({ ...clearFieldErr(member, key), ...updater });

  const inputCls = (key) =>
    `w-full px-3 py-2 rounded-lg border text-xs focus:outline-none focus:border-[#8BC53D] ${fe[key] ? 'border-red-400 bg-red-50' : 'border-gray-200'}`;

  return (
    <div className="p-3 rounded-xl bg-gray-50 border border-gray-100 space-y-2">
      {/* Row header */}
      <div className="flex items-center justify-between mb-1">
        <span className="text-[11px] font-bold text-gray-400 uppercase tracking-wide">Member {index + 1}</span>
        <button type="button" onClick={onRemove} className="w-6 h-6 rounded-lg border border-red-100 text-red-400 hover:bg-red-50 flex items-center justify-center"><X size={11} /></button>
      </div>

      {/* Row 1: name + email */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <input value={member.name} onChange={(e) => field('name', { name: e.target.value })} placeholder="Full Name *" className={inputCls('name')} />
          {fe.name && <p className="text-[10px] text-red-500 mt-0.5">{fe.name}</p>}
        </div>
        <div>
          <input value={member.email} onChange={(e) => field('email', { email: e.target.value })} placeholder="Email *" className={inputCls('email')} />
          {fe.email && <p className="text-[10px] text-red-500 mt-0.5">{fe.email}</p>}
        </div>
      </div>

      {/* Row 2: phone + designation + role */}
      <div className="grid grid-cols-3 gap-2">
        <div>
          <input value={member.phone} onChange={(e) => field('phone', { phone: fmtPhone(e.target.value) })} placeholder="Phone" maxLength={14} className={inputCls('phone')} />
          {fe.phone && <p className="text-[10px] text-red-500 mt-0.5">{fe.phone}</p>}
        </div>
        <div>
          <input value={member.designation} onChange={(e) => field('designation', { designation: e.target.value })} placeholder="Designation" className={inputCls('designation')} />
        </div>
        <div>
          <select value={member.sub_role} onChange={(e) => field('sub_role', { sub_role: e.target.value })} className={inputCls('sub_role')}>
            {roleOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          {fe.sub_role && <p className="text-[10px] text-red-500 mt-0.5">{fe.sub_role}</p>}
        </div>
      </div>

      {/* Row 3: password */}
      <div>
        <input type="password" value={member.password} onChange={(e) => field('password', { password: e.target.value })} placeholder="Password *" className={inputCls('password')} />
        {fe.password && <p className="text-[10px] text-red-500 mt-0.5">{fe.password}</p>}
      </div>

      {/* General row-level error (e.g. from API) */}
      {fe._row && (
        <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{fe._row}</p>
      )}
    </div>
  );
}

function UserFormModal({ initial, roleOptions, dbRole, onSave, onClose, onDelete, submitting, error, showTeamMembers, teamMemberRoleOptions = [], companyId }) {
  const isEdit = !!initial?.id;
  const [form, setForm] = useState(() => {
    const s = initial || EMPTY_FORM;
    const { firstName, lastName } = s.name ? splitName(s.name) : { firstName: s.firstName || '', lastName: s.lastName || '' };
    return { ...s, firstName, lastName };
  });
  const [teamMembers, setTeamMembers] = useState([]);
  // Per-field errors for the main form
  const [fe, setFe] = useState({});

  // Clear a field's error when the user edits it
  const setField = (patch) => {
    setForm((c) => ({ ...c, ...patch }));
    setFe((e) => { const n = { ...e }; Object.keys(patch).forEach((k) => delete n[k]); return n; });
  };

  // Per-field validation — returns an errors object (empty = valid)
  const validateForm = () => {
    const errors = {};
    if (!form.firstName.trim()) errors.firstName = 'First name is required.';
    if (!form.lastName.trim()) errors.lastName = 'Last name is required.';
    if (!isValidEmail(form.email)) errors.email = 'Enter a valid email address.';
    if (!form.sub_role) errors.sub_role = 'Please select a role.';
    if (!isEdit && (!form.password.trim() || form.password.length < 8))
      errors.password = 'Password must be at least 8 characters.';
    return errors;
  };

  // Validate all team member rows — returns updated array with fieldErrors set
  const validateMembers = (members) => {
    let hasError = false;
    const updated = members.map((m) => {
      const mfe = {};
      if (!m.name?.trim()) mfe.name = 'Name is required.';
      if (!isValidEmail(m.email)) mfe.email = 'Enter a valid email.';
      if (!m.sub_role) mfe.sub_role = 'Select a role.';
      if (!m.password?.trim()) mfe.password = 'Password is required.';
      if (Object.keys(mfe).length) { hasError = true; return { ...m, fieldErrors: mfe }; }
      return { ...m, fieldErrors: {} };
    });
    return { updated, hasError };
  };

  const handleSave = () => {
    const formErrors = validateForm();
    if (Object.keys(formErrors).length) { setFe(formErrors); return; }

    if (showTeamMembers && teamMembers.length) {
      const { updated, hasError } = validateMembers(teamMembers);
      setTeamMembers(updated);
      if (hasError) return;
    }

    onSave({ ...form, name: `${form.firstName.trim()} ${form.lastName.trim()}`.trim(), teamMembers });
  };

  // Allow parent to inject member-level API errors (e.g. duplicate email on row 2)
  const setMemberError = (memberId, field, msg) => {
    setTeamMembers((prev) => prev.map((m) =>
      m.id === memberId
        ? { ...m, fieldErrors: { ...(m.fieldErrors || {}), [field]: msg } }
        : m
    ));
  };

  // Expose setMemberError so handleAdd can call it
  useEffect(() => { if (initial?._setMemberError) initial._setMemberError.current = setMemberError; }, []);

  const isBuyerPrimary = [SUB_ROLE.BUYER_PRIMARY, SUB_ROLE.BUYER_TEAM_MEMBER, SUB_ROLE.BUYER_ACCOUNTANT].includes(form.sub_role);

  const inputCls = (field) =>
    `w-full px-3.5 py-2.5 rounded-xl border text-sm focus:outline-none focus:ring-2 focus:ring-[#8BC53D]/40 focus:border-[#8BC53D] ${fe[field] ? 'border-red-400 bg-red-50' : 'border-gray-200'}`;

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, zIndex: 99999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem', boxSizing: 'border-box' }}>
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(255,255,255,0.35)', backdropFilter: 'blur(4px)' }} onClick={onClose} />
      <div style={{ position: 'relative', zIndex: 1, width: '100%', maxWidth: 640, maxHeight: 'calc(100vh - 2rem)', display: 'flex', flexDirection: 'column', borderRadius: 16, background: '#fff', boxShadow: '0 8px 32px rgba(0,0,0,0.14)' }}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 flex-shrink-0">
          <div><h2 className="text-base font-bold text-[#05164D]">{isEdit ? 'Edit User' : 'Add User'}</h2><p className="text-xs text-gray-400 mt-0.5">{isEdit ? 'Update user information' : 'Create a new user account'}</p></div>
          <button onClick={onClose} className="w-8 h-8 rounded-lg hover:bg-gray-100 flex items-center justify-center text-gray-400"><X size={16} /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {/* Name row */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1.5">First Name *</label>
              <input value={form.firstName} onChange={(e) => setField({ firstName: e.target.value })} placeholder="Jane" className={inputCls('firstName')} />
              {fe.firstName && <p className="text-xs text-red-500 mt-1">{fe.firstName}</p>}
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1.5">Last Name *</label>
              <input value={form.lastName} onChange={(e) => setField({ lastName: e.target.value })} placeholder="Smith" className={inputCls('lastName')} />
              {fe.lastName && <p className="text-xs text-red-500 mt-1">{fe.lastName}</p>}
            </div>
          </div>

          {/* Email */}
          <div>
            <label className="block text-xs font-semibold text-gray-500 mb-1.5">Email *</label>
            <input type="email" value={form.email} onChange={(e) => setField({ email: e.target.value })} placeholder="user@company.com" className={inputCls('email')} />
            {fe.email && <p className="text-xs text-red-500 mt-1">{fe.email}</p>}
          </div>

          {/* Phone + Designation */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1.5">Phone</label>
              <div className="flex">
                <span className="flex h-[42px] items-center rounded-l-xl border border-r-0 border-gray-200 bg-gray-50 px-3 text-sm text-gray-500">+1</span>
                <input type="tel" value={form.phone} onChange={(e) => setField({ phone: fmtPhone(e.target.value) })} placeholder="(555) 000-0000" maxLength={14}
                  className={`min-w-0 flex-1 rounded-l-none rounded-r-xl border text-sm focus:outline-none focus:ring-2 focus:ring-[#8BC53D]/40 focus:border-[#8BC53D] px-3.5 py-2.5 ${fe.phone ? 'border-red-400 bg-red-50' : 'border-gray-200'}`} />
              </div>
              {fe.phone && <p className="text-xs text-red-500 mt-1">{fe.phone}</p>}
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1.5">Designation</label>
              <input value={form.designation} onChange={(e) => setField({ designation: e.target.value })} placeholder="e.g. CFO" className="w-full px-3.5 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#8BC53D]/40 focus:border-[#8BC53D]" />
            </div>
          </div>

          {/* Role */}
          <div>
            <label className="block text-xs font-semibold text-gray-500 mb-1.5">Role *</label>
            <select value={form.sub_role} onChange={(e) => setField({ sub_role: e.target.value })} className={inputCls('sub_role')}>
              <option value="">Select Role</option>
              {roleOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            {fe.sub_role && <p className="text-xs text-red-500 mt-1">{fe.sub_role}</p>}
          </div>

          {/* Buyer company name */}
          {isBuyerPrimary && (
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1.5">Buyer Company Name *</label>
              <input value={form.buyer_company_name} onChange={(e) => setField({ buyer_company_name: e.target.value })} placeholder="Buyer Company Pvt Ltd" className={inputCls('buyer_company_name')} />
              {fe.buyer_company_name && <p className="text-xs text-red-500 mt-1">{fe.buyer_company_name}</p>}
            </div>
          )}

          {/* Password */}
          <div>
            <label className="block text-xs font-semibold text-gray-500 mb-1.5">{isEdit ? 'Password Reset' : 'Password'}{!isEdit && ' *'}</label>
            <input type="password" value={form.password} onChange={(e) => setField({ password: e.target.value })} placeholder={isEdit ? 'Leave blank to keep existing' : 'Min 8 characters'} className={inputCls('password')} />
            {fe.password && <p className="text-xs text-red-500 mt-1">{fe.password}</p>}
          </div>

          {/* Status (edit only) */}
          {isEdit && (
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1.5">Status *</label>
              <select value={form.status} onChange={(e) => setField({ status: e.target.value })} className="w-full px-3.5 py-2.5 rounded-xl border border-gray-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#8BC53D]/40 focus:border-[#8BC53D]">
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </div>
          )}

          {/* Team members section */}
          {showTeamMembers && !isEdit && (
            <div className="border border-dashed border-gray-200 rounded-2xl p-4">
              <div className="flex items-center justify-between mb-3">
                <div><p className="text-sm font-semibold text-[#05164D]">Team Members</p><p className="text-xs text-gray-400">Optionally add team members now</p></div>
                <button type="button"
                  onClick={() => setTeamMembers((p) => [...p, { id: Date.now(), name: '', email: '', phone: '', designation: '', sub_role: teamMemberRoleOptions[0]?.value || '', password: '', fieldErrors: {} }])}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#E6F3D3] text-[#476E2C] text-xs font-semibold hover:bg-[#d4ebbf] transition-colors">
                  <UserPlus size={13} /> Add
                </button>
              </div>
              {teamMembers.length === 0
                ? <p className="text-xs text-gray-400 text-center py-2">No team members added.</p>
                : (
                  <div className="space-y-3">
                    {teamMembers.map((m, idx) => (
                      <TeamMemberRow
                        key={m.id}
                        member={m}
                        index={idx}
                        roleOptions={teamMemberRoleOptions}
                        onChange={(u) => setTeamMembers((p) => p.map((x) => x.id === m.id ? u : x))}
                        onRemove={() => setTeamMembers((p) => p.filter((x) => x.id !== m.id))}
                      />
                    ))}
                  </div>
                )}
            </div>
          )}

          {/* Top-level API error (e.g. primary user creation failed) */}
          {error && <FormError message={error} />}
        </div>

        <div className="px-6 py-4 border-t border-gray-100 flex flex-col gap-3 flex-shrink-0">
          <div className="flex gap-3">
            {/* Delete button — only shown when editing, sits on the left */}
            {isEdit && onDelete && (
              <button
                onClick={() => onDelete(initial)}
                disabled={submitting}
                className="px-4 py-2.5 rounded-xl border border-red-200 text-sm font-semibold text-red-500 hover:bg-red-50 transition-colors disabled:opacity-50 flex-shrink-0"
              >
                Delete
              </button>
            )}
            <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm font-semibold text-gray-600 hover:bg-gray-50">Cancel</button>
            <button onClick={handleSave} disabled={submitting} className="flex-1 py-2.5 rounded-xl bg-[#8BC53D] hover:bg-[#476E2C] disabled:opacity-50 text-white text-sm font-bold transition-colors">{submitting ? 'Saving...' : isEdit ? 'Save Changes' : 'Add User'}</button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ─── Delete modal ─────────────────────────────────────────────────────────────

function DeleteModal({ user, onConfirm, onClose, submitting, error }) {
  return createPortal(
    <div style={{ position: 'fixed', inset: 0, zIndex: 99999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}>
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(255,255,255,0.35)', backdropFilter: 'blur(4px)' }} onClick={onClose} />
      <div style={{ position: 'relative', zIndex: 1, background: '#fff', borderRadius: 16, padding: 24, width: '100%', maxWidth: 360, boxShadow: '0 8px 32px rgba(0,0,0,0.14)' }}>
        <div className="flex items-center justify-center w-12 h-12 rounded-full bg-red-100 mx-auto mb-4"><Trash2 size={22} className="text-red-500" /></div>
        <h3 className="text-center text-lg font-bold text-[#05164D] mb-1">Delete User</h3>
        <p className="text-center text-sm text-gray-500 mb-5">Are you sure you want to delete <span className="font-semibold text-[#05164D]">{user.name}</span>? This cannot be undone.</p>
        {error && <p className="mb-4 text-sm text-red-600 bg-red-50 rounded-xl px-3 py-2 text-center">{error}</p>}
        <div className="flex gap-3">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm font-semibold text-gray-600 hover:bg-gray-50">Cancel</button>
          <button onClick={onConfirm} disabled={submitting} className="flex-1 py-2.5 rounded-xl bg-red-500 hover:bg-red-600 text-white text-sm font-semibold disabled:opacity-60">{submitting ? 'Deleting...' : 'Delete'}</button>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function WorkspaceUsers() {
  const { clientId } = useParams();
  const { user: authUser } = useAuth();

  const [allUsers, setAllUsers] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [formError, setFormError] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // view: 'overview' | 'broker-team' | 'client-team' | 'buyer-team'
  const [view, setView] = useState('overview');
  const [selectedBuyer, setSelectedBuyer] = useState(null);

  // Modal state
  const [editUser, setEditUser] = useState(null);
  const [deleteUser, setDeleteUser] = useState(null);
  const [addContext, setAddContext] = useState(null); // 'broker' | 'client' | 'buyer' | 'buyer-member'
  const [existingUserConfirm, setExistingUserConfirm] = useState(null); // { user, companyIds, context }

  const loadData = async () => {
    setLoading(true);
    setError('');
    try {
      const [usersRes, companiesRes] = await Promise.all([listUsersRequest(), listCompaniesRequest()]);
      const normalized = usersRes.map(normalizeUser).filter(Boolean);
      const thisCompany = companiesRes.find((c) => String(c.id) === String(clientId));
      const contactEmail = (thisCompany?.contact_email || '').trim().toLowerCase();

      // Filter to users belonging to this company (including broker team).
      // Also include the company's primary contact by email — catches cases where
      // the contact user's company_id association wasn't saved correctly.
      const companyUsers = normalized.filter((u) => {
        const userCompanyIds = (u.companyIds && u.companyIds.length > 0) ? u.companyIds : (u.companyId ? [u.companyId] : []);
        const matchesCompany = userCompanyIds.some((id) => String(id) === String(clientId));
        const isContact = contactEmail && (u.email || '').trim().toLowerCase() === contactEmail;
        return matchesCompany || isContact;
      });
      setAllUsers(companyUsers);
      setCompanies(companiesRes);
    } catch (err) {
      setError(err.message || 'Unable to load users.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadData(); }, [clientId]);
  useEffect(() => { if (!success) return; const t = setTimeout(() => setSuccess(''), 3500); return () => clearTimeout(t); }, [success]);

  // Grouped
  // Use classifyUser (not just sub_role) so legacy users without sub_role
  // still land in the correct section based on buyer_company_name / parent_user_id.
  const brokerUsers   = useMemo(() => allUsers.filter((u) => classifyUser(u) === 'broker'), [allUsers]);
  const clientUsers   = useMemo(() => allUsers.filter((u) => classifyUser(u) === 'client'), [allUsers]);
  // Buyer primaries = buyer-classified users that have NO parent (i.e. top-level buyers)
  const buyerPrimaries = useMemo(() =>
    allUsers.filter((u) => classifyUser(u) === 'buyer' && !u.parent_user_id),
    [allUsers]);
  // All buyer-side users (primaries + team members/accountants)
  const allBuyerUsers = useMemo(() => allUsers.filter((u) => classifyUser(u) === 'buyer'), [allUsers]);

  // Company info for this workspace
  const companyInfo = useMemo(() => companies.find((c) => String(c.id) === String(clientId)), [companies, clientId]);

  // Summary info for cards
  const primaryBroker = useMemo(() => brokerUsers.find((u) => u.sub_role === SUB_ROLE.BROKER_PRIMARY) || brokerUsers[0], [brokerUsers]);
  const companyOwner = useMemo(() => clientUsers.find((u) => u.sub_role === SUB_ROLE.COMPANY_OWNER) || clientUsers[0], [clientUsers]);

  // Role options per add context
  const roleOptionsMap = {
    broker:        [{ value: SUB_ROLE.BROKER_TEAM_MEMBER, label: 'Broker Team Member' }, { value: SUB_ROLE.BANKER, label: 'Banker' }, { value: SUB_ROLE.LOAN_BROKER, label: 'Loan Broker' }],
    client:        [{ value: SUB_ROLE.COMPANY_OWNER, label: 'Company Owner' }, { value: SUB_ROLE.CLIENT_TEAM_MEMBER, label: 'Client Team Member' }, { value: SUB_ROLE.CLIENT_ACCOUNTANT, label: 'Client Accountant' }],
    buyer:         [{ value: SUB_ROLE.BUYER_PRIMARY, label: 'Buyer (Primary)' }],
    'buyer-member': BUYER_TEAM_ROLE_OPTIONS,
  };

  const dbRoleMap = { broker: 'broker', client: 'buyer', buyer: 'buyer', 'buyer-member': 'buyer' };

  // Ref passed into the modal so handleAdd can push per-member errors back to it
  const memberErrorRef = useRef(null);

  const handleAdd = async (form) => {
    setSubmitting(true);
    setFormError('');
    try {
      const dbRole = dbRoleMap[addContext] || 'buyer';
      const payload = {
        name: form.name.trim(), email: form.email.trim(),
        phone: form.phone?.trim() || null, password: form.password,
        role: dbRole, sub_role: form.sub_role,
        designation: form.designation?.trim() || null,
        buyer_company_name: form.buyer_company_name?.trim() || null,
        parent_user_id: form.parent_user_id || null,
        company_id: clientId, company_ids: [clientId], status: 'active',
      };

      // Create primary user — on failure show error on the main form
      const created = await createUserRequest(payload);

      // Create team members one-by-one so we can pin errors to the right row
      if (created?.id && form.teamMembers?.length) {
        let anyMemberFailed = false;
        for (const m of form.teamMembers) {
          try {
            await createUserRequest({
              name: m.name.trim(), email: m.email.trim(),
              phone: m.phone?.trim() || null, password: m.password,
              role: dbRole, sub_role: m.sub_role,
              designation: m.designation?.trim() || null,
              parent_user_id: created.id,
              company_id: clientId, company_ids: [clientId], status: 'active',
            });
          } catch (memberErr) {
            anyMemberFailed = true;
            const msg = fmtApiError(memberErr);
            // Route error to the specific field that caused it
            const field = /email/i.test(msg) ? 'email'
              : /name/i.test(msg) ? 'name'
              : /password/i.test(msg) ? 'password'
              : '_row';
            if (memberErrorRef.current) {
              memberErrorRef.current(m.id, field, msg);
            }
          }
        }
        // If some members failed, keep the modal open so the user can fix them
        if (anyMemberFailed) {
          await loadData(); // reload so primary user is visible
          setSubmitting(false);
          return;
        }
      }

      try { await triggerAutoCreateMessageGroups(clientId); } catch { /* non-fatal */ }
      await loadData();
      setEditUser(null);
      setAddContext(null);
      setSuccess('User added successfully.');
    } catch (err) {
      const isDuplicate = /duplicate|already exists|unique constraint|email.*taken/i.test(String(err?.message || ''));
      if (isDuplicate) {
        try {
          const existing = await findUserByEmailRequest(form.email.trim());
          if (existing?.id) {
            const compatibleSubRoles = {
              broker:         BROKER_SUB_ROLES,
              client:         CLIENT_SUB_ROLES,
              buyer:          BUYER_SUB_ROLES,
              'buyer-member': BUYER_SUB_ROLES,
            }[addContext] || [];

            const existingSub = existing.sub_role || '';
            const existingRole = String(existing.role || '').toLowerCase();
            const brokerRoleMatch = addContext === 'broker' &&
              (existingRole === 'broker' || existingRole === 'admin');
            const isCompatible = compatibleSubRoles.includes(existingSub) || brokerRoleMatch;

            if (!isCompatible) {
              let existingType = 'a different role type';
              if (BROKER_SUB_ROLES.includes(existingSub) || existingRole === 'broker') existingType = 'a broker';
              else if (CLIENT_SUB_ROLES.includes(existingSub)) existingType = 'a client';
              else if (BUYER_SUB_ROLES.includes(existingSub)) existingType = 'a buyer';
              setFormError(`This email is already registered as ${existingType} and cannot be added here.`);
              setSubmitting(false);
              return;
            }

            setExistingUserConfirm({ user: existing, companyIds: [clientId], context: addContext });
            setSubmitting(false);
            return;
          }
        } catch (lookupErr) {
          console.warn('[duplicate-check] user lookup failed:', lookupErr?.message);
        }
      }
      setFormError(fmtApiError(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleAddExisting = async () => {
    if (!existingUserConfirm) return;
    setSubmitting(true);
    const { user: existingUser, companyIds, context } = existingUserConfirm;
    try {
      if (context === 'broker') {
        await inviteBrokerToTeamRequest(existingUser.id);
      } else {
        await addUserToCompaniesRequest(existingUser.id, companyIds);
        await Promise.allSettled(companyIds.map((cid) => triggerAutoCreateMessageGroups(cid)));
      }
      await loadData();
      setExistingUserConfirm(null);
      setEditUser(null);
      setAddContext(null);
      setSuccess(`${existingUser.name} has been added to your team.`);
    } catch (err) {
      setFormError(fmtApiError(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleEdit = async (form) => {
    setSubmitting(true);
    setFormError('');
    try {
      const payload = {
        name: form.name.trim(), email: form.email.trim(),
        phone: form.phone?.trim() || null,
        sub_role: form.sub_role,
        designation: form.designation?.trim() || null,
        buyer_company_name: form.buyer_company_name?.trim() || null,
        status: form.status,
        company_id: clientId, company_ids: [clientId],
      };
      if (form.password?.trim()) payload.password = form.password;
      await updateUserRequest(form.id, payload);
      await loadData();
      setEditUser(null);
      setSuccess('User updated successfully.');
    } catch (err) {
      setFormError(fmtApiError(err));
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

  const openAdd = (ctx, parentUserId = null) => {
    setFormError('');
    setAddContext(ctx);
    setEditUser({ ...EMPTY_FORM, isNew: true, parent_user_id: parentUserId });
  };

  const openEdit = (user) => { setFormError(''); setEditUser({ ...user, password: '' }); };

  if (loading) {
    return <div className="p-6 flex items-center justify-center py-32"><div className="text-sm text-gray-400 animate-pulse">Loading users...</div></div>;
  }

  return (
    <div className="p-6 space-y-6 animate-fadeIn">
      {success && <div className="px-4 py-3 bg-green-50 rounded-2xl border border-green-100 text-sm text-green-700">{success}</div>}
      {error && <div className="px-4 py-3 bg-red-50 rounded-2xl border border-red-100 text-sm text-[#C62026]">{error}</div>}

      {/* ── Overview ── */}
      {view === 'overview' && (
        <>
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-[#05164D]">Users</h1>
              <p className="text-sm text-gray-500 mt-0.5">{allUsers.length} total · {companyInfo?.name || ''}</p>
            </div>
          </div>

          {/* Broker Team + Client Team summary cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <TeamSummaryCard
              title="Broker Team"
              ownerName={primaryBroker?.name}
              ownerLabel="Broker"
              subtitle={authUser?.broker_company || primaryBroker?.company || ''}
              color="#b45e08"
              bg="#FFFAF5"
              borderColor="#FED7AA"
              icon={Briefcase}
              members={brokerUsers}
              subRoles={BROKER_SUB_ROLES}
              onViewTeam={() => setView('broker-team')}
              onAdd={() => openAdd('broker')}
            />
            <TeamSummaryCard
              title="Client Team"
              ownerName={companyOwner?.name}
              ownerLabel="Owner"
              subtitle={companyInfo?.name || companyOwner?.company || ''}
              color="#00648F"
              bg="#F0F9FF"
              borderColor="#BAE6FD"
              icon={Building2}
              members={clientUsers}
              subRoles={CLIENT_SUB_ROLES}
              onViewTeam={() => setView('client-team')}
              onAdd={() => openAdd('client')}
            />
          </div>

          {/* Buyers section */}
          <div>
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-lg font-bold text-[#05164D]">Buyers</h2>
                <p className="text-sm text-gray-500">{buyerPrimaries.length} buyer{buyerPrimaries.length !== 1 ? 's' : ''}</p>
              </div>
              <button onClick={() => openAdd('buyer')} className="inline-flex items-center gap-2 px-4 py-2 bg-[#8BC53D] hover:bg-[#476E2C] text-white rounded-xl text-sm font-bold transition-colors shadow-sm">
                <Plus size={14} /> Add New Buyer
              </button>
            </div>
            {buyerPrimaries.length === 0 ? (
              <div className="py-14 text-center bg-white rounded-2xl border border-gray-100">
                <ShoppingCart size={36} className="mx-auto text-gray-200 mb-3" />
                <p className="text-sm font-semibold text-gray-400">No buyers yet</p>
                <button onClick={() => openAdd('buyer')} className="mt-3 text-xs text-[#8BC53D] hover:underline font-semibold">Add first buyer</button>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {buyerPrimaries.map((buyer) => (
                  <BuyerCard key={buyer.id} buyer={buyer} allUsers={allBuyerUsers}
                    onViewTeam={(b) => { setSelectedBuyer(b); setView('buyer-team'); }}
                    onEdit={openEdit}
                  />
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {/* ── Broker Team Detail ── */}
      {view === 'broker-team' && (
        <TeamDetailView
          title="Broker Team"
          subtitle={`${brokerUsers.length} member${brokerUsers.length !== 1 ? 's' : ''}`}
          members={brokerUsers}
          filterSubRoles={BROKER_SUB_ROLES}
          onBack={() => setView('overview')}
          onAdd={() => openAdd('broker')}
          onEdit={openEdit}
        />
      )}

      {/* ── Client Team Detail ── */}
      {view === 'client-team' && (
        <TeamDetailView
          title="Client Team"
          subtitle={companyInfo?.name ? `${companyInfo.name} · ${clientUsers.length} member${clientUsers.length !== 1 ? 's' : ''}` : `${clientUsers.length} member${clientUsers.length !== 1 ? 's' : ''}`}
          members={clientUsers}
          filterSubRoles={CLIENT_SUB_ROLES}
          onBack={() => setView('overview')}
          onAdd={() => openAdd('client')}
          onEdit={openEdit}
        />
      )}

      {/* ── Buyer Team Detail ── */}
      {view === 'buyer-team' && selectedBuyer && (
        <BuyerTeamView
          buyer={selectedBuyer}
          allUsers={allBuyerUsers}
          onBack={() => { setView('overview'); setSelectedBuyer(null); }}
          onAddMember={() => openAdd('buyer-member', selectedBuyer.id)}
          onEdit={openEdit}
        />
      )}

      {/* ── Modals ── */}
      {editUser && !existingUserConfirm && (
        <UserFormModal
          initial={{ ...editUser, _setMemberError: memberErrorRef }}
          roleOptions={roleOptionsMap[addContext || (editUser.id ? (BROKER_SUB_ROLES.includes(editUser.sub_role) ? 'broker' : CLIENT_SUB_ROLES.includes(editUser.sub_role) ? 'client' : 'buyer') : 'buyer')] || []}
          dbRole={dbRoleMap[addContext || 'buyer']}
          onSave={editUser?.isNew ? handleAdd : handleEdit}
          onClose={() => { setFormError(''); setEditUser(null); setAddContext(null); }}
          onDelete={editUser?.id ? (u) => { setFormError(''); setEditUser(null); setAddContext(null); setDeleteError(''); setDeleteUser(u); } : undefined}
          submitting={submitting}
          error={formError}
          showTeamMembers={!editUser?.id && addContext === 'buyer'}
          teamMemberRoleOptions={BUYER_TEAM_ROLE_OPTIONS}
          companyId={clientId}
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

      {existingUserConfirm && (
        <ExistingUserConfirmModal
          foundUser={existingUserConfirm.user}
          context={existingUserConfirm.context}
          companyNames={companies.filter((c) => existingUserConfirm.companyIds.some((id) => String(id) === String(c.id))).map((c) => c.name)}
          onConfirm={handleAddExisting}
          onClose={() => { setExistingUserConfirm(null); setFormError(''); }}
          submitting={submitting}
        />
      )}
    </div>
  );
}
