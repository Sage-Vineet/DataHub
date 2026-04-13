import { useEffect, useMemo, useState } from 'react';
import {
  Search, Filter, Plus, Eye, Pencil, Trash2, X,
  ChevronLeft, ChevronRight, Users as UsersIcon,
  CheckCircle, XCircle, Shield, ShoppingCart,
  Phone, Mail, Building2, Calendar, ChevronDown, Check, Briefcase
} from 'lucide-react';
import {
  createUserRequest,
  deleteUserRequest,
  listCompaniesRequest,
  listCompanyGroups,
  addGroupMember,
  removeGroupMember,
  listUsersRequest,
  updateUserRequest,
  uploadFile,
} from '../../lib/api';

const PAGE_SIZE = 8;
const ROLE_ORDER = ['admin', 'broker', 'buyer'];
const CREATE_ROLE_ORDER = ['buyer'];
const STATUS_ORDER = ['active', 'inactive'];
const EMPTY_FORM = { name: '', companyId: '', companyIds: [], email: '', phone: '', role: 'buyer', status: 'active', password: '', profileImage: '', groupIds: [] };

function initials(name = '') {
  return name
    .split(' ')
    .filter(Boolean)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

function formatUser(user) {
  if (!user) return null;
  const assignedCompanies = user.assigned_companies || user.assignedCompanies || [];
  const companyIds = user.company_ids || user.companyIds || assignedCompanies.map((company) => company.id).filter(Boolean) || [];
  const primaryCompany = assignedCompanies.find((company) => String(company.id) === String(user.company_id)) || assignedCompanies[0] || null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone || 'N/A',
    role: user.effective_role || user.role,
    status: user.status,
    companyId: user.company_id || primaryCompany?.id || '',
    companyIds,
    assignedCompanies,
    company: user.company_name || primaryCompany?.name || (assignedCompanies.length ? assignedCompanies.map((company) => company.name).join(', ') : 'Unassigned'),
    joinedAt: user.created_at,
    profileImage: user.profile_image || user.profileImage || '',
    groupIds: user.group_ids || user.groupIds || (user.groups ? user.groups.map((g) => g.id) : []),
    avatar: initials(user.name),
  };
}

function statusMeta(status) {
  if (status === 'active') return { label: 'Active', bg: 'bg-green-100', text: 'text-green-700', dot: 'bg-green-500', Icon: CheckCircle };
  return { label: 'Inactive', bg: 'bg-gray-100', text: 'text-gray-500', dot: 'bg-gray-400', Icon: XCircle };
}

function roleMeta(role) {
  if (role === 'admin') return { label: 'Admin', bg: 'bg-purple-50', text: 'text-[#742982]', border: 'border-purple-200', Icon: Shield };
  if (role === 'broker') return { label: 'Broker', bg: 'bg-amber-50', text: 'text-[#b45e08]', border: 'border-orange-200', Icon: Briefcase };
  if (role === 'client') return { label: 'Seller', bg: 'bg-blue-50', text: 'text-[#00648F]', border: 'border-blue-200', Icon: Building2 };
  if (role === 'user') return { label: 'User', bg: 'bg-slate-50', text: 'text-slate-700', border: 'border-slate-200', Icon: ShoppingCart };
  return { label: 'Buyer', bg: 'bg-blue-50', text: 'text-[#00648F]', border: 'border-blue-200', Icon: ShoppingCart };
}

function Avatar({ user, size = 9 }) {
  const palette = ['#8BC53D', '#05164D', '#F68C1F', '#742982', '#00648F', '#476E2C'];
  const colorSeed = user.name.length % palette.length;
  const dimensions = size * 4;

  return (
    <div
      className="rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0"
      style={{ background: palette[colorSeed], width: dimensions, height: dimensions }}
    >
      {user.avatar}
    </div>
  );
}

function StatusBadge({ status }) {
  const meta = statusMeta(status);
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold ${meta.bg} ${meta.text}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${meta.dot}`} />
      {meta.label}
    </span>
  );
}

function RoleBadge({ role }) {
  const meta = roleMeta(role);
  return (
    <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold border ${meta.bg} ${meta.text} ${meta.border}`}>
      <meta.Icon size={11} />
      {meta.label}
    </span>
  );
}

function DeleteModal({ user, onConfirm, onClose, submitting }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-white/30 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 z-10 animate-fadeIn">
        <div className="flex items-center justify-center w-14 h-14 rounded-full bg-red-100 mx-auto mb-4">
          <Trash2 size={24} className="text-red-500" />
        </div>
        <h3 className="text-center text-lg font-bold text-[#05164D] mb-1">Delete User</h3>
        <p className="text-center text-sm text-gray-500 mb-6">
          Are you sure you want to delete <span className="font-semibold text-[#05164D]">{user.name}</span>? This action cannot be undone.
        </p>
        <div className="flex gap-3">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm font-semibold text-gray-600 hover:bg-gray-50 transition-colors">
            Cancel
          </button>
          <button onClick={onConfirm} disabled={submitting} className="flex-1 py-2.5 rounded-xl bg-red-500 hover:bg-red-600 text-white text-sm font-semibold transition-colors disabled:opacity-60">
            {submitting ? 'Deleting...' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ViewModal({ user, onClose, onEdit }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-white/30 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-md z-10 animate-fadeIn overflow-hidden">
        <div className="bg-gradient-to-r from-[#05164D] to-[#0a2266] px-6 py-5">
          <button onClick={onClose} className="absolute top-4 right-4 text-white/60 hover:text-white transition-colors">
            <X size={18} />
          </button>
          <div className="flex items-center gap-4">
            <Avatar user={user} size={14} />
            <div>
              <h2 className="text-white text-lg font-bold">{user.name}</h2>
              <p className="text-white/60 text-sm">{user.company}</p>
            </div>
          </div>
          <div className="flex gap-2 mt-4">
            <RoleBadge role={user.role} />
            <StatusBadge status={user.status} />
          </div>
        </div>

        <div className="p-6 space-y-4">
          {[
            { icon: Mail, label: 'Email', value: user.email },
            { icon: Phone, label: 'Phone', value: user.phone },
            { icon: Building2, label: 'Company', value: user.company },
            { icon: Calendar, label: 'Joined', value: new Date(user.joinedAt).toLocaleDateString('en-IN', { year: 'numeric', month: 'long', day: 'numeric' }) },
          ].map((item) => {
            const Icon = item.icon;

            return (
              <div key={item.label} className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-[#05164D]/6 flex items-center justify-center flex-shrink-0">
                  <Icon size={15} className="text-[#05164D]" />
                </div>
                <div>
                  <p className="text-xs text-gray-400 mb-0.5">{item.label}</p>
                  <p className="text-sm font-semibold text-[#05164D]">{item.value}</p>
                </div>
              </div>
            );
          })}
        </div>

        <div className="px-6 pb-6">
          <button onClick={onEdit} className="w-full py-2.5 rounded-xl bg-[#8BC53D] hover:bg-[#476E2C] text-white text-sm font-bold transition-colors">
            Edit User
          </button>
        </div>
      </div>
    </div>
  );
}

function UserFormModal({ initial, companies, groups, onCompanyChange, onSave, onClose, submitting }) {
  const isEdit = !!initial?.id;
  const [form, setForm] = useState(() => {
    const seed = initial || EMPTY_FORM;
    return { ...seed, companyIds: seed.companyIds?.length ? seed.companyIds : [seed.companyId].filter(Boolean) };
  });
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const setField = (patch) => setForm((current) => ({ ...current, ...patch }));
  const valid = form.name.trim() && form.email.trim() && form.role && form.status && (isEdit || form.password.trim());

  useEffect(() => {
    const seed = initial || EMPTY_FORM;
    setForm({ ...seed, companyIds: seed.companyIds?.length ? seed.companyIds : [seed.companyId].filter(Boolean) });
  }, [initial]);

  const handleProfilePick = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setUploadError('');
    try {
      const uploaded = await uploadFile(file, {
        fileName: file.name,
        prefix: 'profile-images',
      });
      setField({ profileImage: uploaded.fileUrl });
    } catch (err) {
      setUploadError(err.message || 'Unable to upload profile image.');
    } finally {
      setUploading(false);
      event.target.value = '';
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-white/30 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-2xl z-10 animate-fadeIn max-h-[88vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h2 className="text-base font-bold text-[#05164D]">{isEdit ? 'Edit User' : 'Add New User'}</h2>
            <p className="text-xs text-gray-400 mt-0.5">{isEdit ? 'Update user information' : 'Create a new backend user account'}</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-lg hover:bg-gray-100 flex items-center justify-center text-gray-400 hover:text-gray-600 transition-colors">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="col-span-2">
            <label className="block text-xs font-semibold text-gray-500 mb-1.5">Full Name *</label>
            <input
              value={form.name}
              onChange={(event) => setField({ name: event.target.value })}
              placeholder="e.g. Ananya Mehta"
              className="w-full px-3.5 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#8BC53D]/40 focus:border-[#8BC53D]"
            />
          </div>

          <div className="col-span-2 lg:col-span-1">
            <label className="block text-xs font-semibold text-gray-500 mb-1.5">Company</label>
            <select
              value={form.companyId}
              onChange={(event) => {
                const nextCompanyId = event.target.value;
                setField({
                  companyId: nextCompanyId,
                  companyIds: nextCompanyId ? Array.from(new Set([...(form.companyIds || []), nextCompanyId])) : (form.companyIds || []),
                  groupIds: [],
                });
                onCompanyChange?.(nextCompanyId);
              }}
              className="w-full px-3.5 py-2.5 rounded-xl border border-gray-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#8BC53D]/40 focus:border-[#8BC53D]"
            >
              <option value="">Unassigned</option>
              {companies.map((company) => (
                <option key={company.id} value={company.id}>{company.name}</option>
              ))}
            </select>
          </div>

          <div className="col-span-2">
            <label className="block text-xs font-semibold text-gray-500 mb-1.5">Assigned Clients</label>
            <div className="max-h-28 overflow-y-auto rounded-xl border border-gray-200 bg-gray-50 p-2">
              {companies.length === 0 ? (
                <p className="px-2 py-1 text-xs text-gray-400">No companies available</p>
              ) : companies.map((company) => {
                const active = (form.companyIds || []).some((id) => String(id) === String(company.id));
                return (
                  <label key={company.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs font-semibold text-[#05164D] hover:bg-white">
                    <input
                      type="checkbox"
                      checked={active}
                      onChange={(event) => {
                        const nextIds = event.target.checked
                          ? Array.from(new Set([...(form.companyIds || []), company.id]))
                          : (form.companyIds || []).filter((id) => String(id) !== String(company.id));
                        setField({
                          companyIds: nextIds,
                          companyId: nextIds.some((id) => String(id) === String(form.companyId)) ? form.companyId : (nextIds[0] || ''),
                        });
                      }}
                      className="h-3.5 w-3.5 accent-[#8BC53D]"
                    />
                    {company.name}
                  </label>
                );
              })}
            </div>
            <p className="mt-1 text-[11px] text-gray-400">A user can be assigned to multiple clients. The primary company is kept for compatibility.</p>
          </div>

          <div className="col-span-2 lg:col-span-1">
            <label className="block text-xs font-semibold text-gray-500 mb-1.5">Phone No.</label>
            <input
              value={form.phone}
              onChange={(event) => setField({ phone: event.target.value })}
              placeholder="+91 98765 43210"
              className="w-full px-3.5 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#8BC53D]/40 focus:border-[#8BC53D]"
            />
          </div>

          <div className="col-span-2">
            <label className="block text-xs font-semibold text-gray-500 mb-1.5">Email *</label>
            <input
              type="email"
              value={form.email}
              onChange={(event) => setField({ email: event.target.value })}
              placeholder="user@company.com"
              className="w-full px-3.5 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#8BC53D]/40 focus:border-[#8BC53D]"
            />
          </div>

          <div className="col-span-2">
            <label className="block text-xs font-semibold text-gray-500 mb-1.5">Profile Image</label>
            <div className="rounded-xl border border-dashed border-gray-200 p-3 bg-gray-50">
              <input
                type="file"
                accept=".jpg,.jpeg,.png,.webp"
                onChange={handleProfilePick}
                disabled={uploading}
                className="w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-white file:px-3 file:py-2 file:text-xs file:font-semibold file:text-[#05164D] hover:file:bg-gray-100 disabled:opacity-60"
              />
              {form.profileImage && (
                <p className="text-xs text-[#6D6E71] mt-2 truncate">{form.profileImage}</p>
              )}
              {uploadError && <p className="text-xs text-red-500 mt-2">{uploadError}</p>}
              <p className="text-[11px] text-[#A5A5A5] mt-1">Uploads JPG, PNG, WEBP</p>
            </div>
          </div>

          <div className="col-span-2">
            <label className="block text-xs font-semibold text-gray-500 mb-1.5">Groups</label>
            <div className="flex flex-wrap gap-2">
              {groups.length === 0 ? (
                <span className="text-xs text-gray-400">Select a company to load groups</span>
              ) : groups.map((group) => {
                const active = form.groupIds.includes(group.id);
                return (
                  <button
                    key={group.id}
                    type="button"
                    onClick={() => {
                      setField({
                        groupIds: active
                          ? form.groupIds.filter((id) => id !== group.id)
                          : [...form.groupIds, group.id],
                      });
                    }}
                    className={`px-3 py-1.5 rounded-full border text-xs font-semibold transition-all ${
                      active ? 'bg-[#05164D] text-white border-[#05164D]' : 'bg-gray-50 text-gray-500 border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    {group.name || group.id}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="col-span-2">
            <label className="block text-xs font-semibold text-gray-500 mb-1.5">{isEdit ? 'Password Reset' : 'Password'} {!isEdit && '*'}</label>
            <input
              type="password"
              value={form.password}
              onChange={(event) => setField({ password: event.target.value })}
              placeholder={isEdit ? 'Leave blank to keep existing password' : 'Set an initial password'}
              className="w-full px-3.5 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#8BC53D]/40 focus:border-[#8BC53D]"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-500 mb-1.5">Role *</label>
            <div className="flex gap-2">
              {(isEdit ? ROLE_ORDER : CREATE_ROLE_ORDER).map((role) => {
                const meta = roleMeta(role);
                return (
                  <button
                    key={role}
                    type="button"
                    onClick={() => setField({ role })}
                    className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl border text-xs font-semibold transition-all ${
                      form.role === role
                        ? 'bg-[#05164D] text-white border-[#05164D]'
                        : 'bg-gray-50 text-gray-500 border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    <meta.Icon size={12} />
                    {meta.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-500 mb-1.5">Status *</label>
            <select
              value={form.status}
              onChange={(event) => setField({ status: event.target.value })}
              className="w-full px-3.5 py-2.5 rounded-xl border border-gray-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#8BC53D]/40 focus:border-[#8BC53D]"
            >
              {STATUS_ORDER.map((status) => (
                <option key={status} value={status}>{statusMeta(status).label}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="px-6 py-4 border-t border-gray-100 bg-white flex gap-3">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm font-semibold text-gray-600 hover:bg-gray-50 transition-colors">
            Cancel
          </button>
          <button
            onClick={() => valid && onSave(form)}
            disabled={!valid || submitting}
            className="flex-1 py-2.5 rounded-xl bg-[#8BC53D] hover:bg-[#476E2C] disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-bold transition-colors"
          >
            {submitting ? 'Saving...' : isEdit ? 'Save Changes' : 'Add User'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function BrokerUsers() {
  const [data, setData] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [search, setSearch] = useState('');
  const [filterRole, setRole] = useState('All Roles');
  const [filterStatus, setStatus] = useState('All Status');
  const [filterCompany, setComp] = useState('All Companies');
  const [selected, setSelected] = useState(new Set());
  const [page, setPage] = useState(1);
  const [viewUser, setViewUser] = useState(null);
  const [editUser, setEditUser] = useState(null);
  const [deleteUser, setDeleteUser] = useState(null);
  const [showFilters, setShowFilters] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [groupsByCompany, setGroupsByCompany] = useState({});

  const loadGroupsForCompany = async (companyId) => {
    if (!companyId) return [];
    if (groupsByCompany[companyId]) return groupsByCompany[companyId];
    try {
      const groups = await listCompanyGroups(companyId);
      setGroupsByCompany((current) => ({ ...current, [companyId]: groups }));
      return groups;
    } catch (err) {
      return [];
    }
  };

  const loadData = async () => {
    setLoading(true);
    setError('');

    try {
      const [usersResponse, companiesResponse] = await Promise.all([
        listUsersRequest(),
        listCompaniesRequest(),
      ]);

      setData(usersResponse.map(formatUser).filter(Boolean));
      setCompanies(companiesResponse);
    } catch (err) {
      setError(err.message || 'Unable to load users.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    if (!success) return undefined;
    const timer = setTimeout(() => setSuccess(''), 3000);
    return () => clearTimeout(timer);
  }, [success]);

  useEffect(() => {
    if (!editUser?.companyId) return;
    loadGroupsForCompany(editUser.companyId);
  }, [editUser?.companyId]);

  const companyOptions = useMemo(
    () => ['All Companies', ...Array.from(new Set(data.map((user) => user.company))).filter(Boolean)],
    [data]
  );
  const roleOptions = useMemo(
    () => ['All Roles', ...Array.from(new Set(data.map((user) => user.role))).sort((a, b) => ROLE_ORDER.indexOf(a) - ROLE_ORDER.indexOf(b))],
    [data]
  );
  const statusOptions = useMemo(
    () => ['All Status', ...Array.from(new Set(data.map((user) => user.status))).sort((a, b) => STATUS_ORDER.indexOf(a) - STATUS_ORDER.indexOf(b))],
    [data]
  );

  const filtered = useMemo(() => {
    const query = search.toLowerCase();
    return data.filter((user) => {
      const matchSearch = !query || user.name.toLowerCase().includes(query) || user.email.toLowerCase().includes(query) || user.company.toLowerCase().includes(query) || user.phone.includes(query);
      const matchRole = filterRole === 'All Roles' || user.role === filterRole;
      const matchStatus = filterStatus === 'All Status' || user.status === filterStatus;
      const matchCompany = filterCompany === 'All Companies' || user.company === filterCompany;
      return matchSearch && matchRole && matchStatus && matchCompany;
    });
  }, [data, search, filterRole, filterStatus, filterCompany]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const paginated = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const pageRange = useMemo(() => {
    const range = [];
    const delta = 2;
    for (let index = Math.max(1, safePage - delta); index <= Math.min(totalPages, safePage + delta); index += 1) {
      range.push(index);
    }
    return range;
  }, [safePage, totalPages]);

  const pageIds = paginated.map((user) => user.id);
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const someSelected = pageIds.some((id) => selected.has(id)) && !allPageSelected;

  const toggleAll = () => {
    setSelected((current) => {
      const next = new Set(current);
      if (allPageSelected) {
        pageIds.forEach((id) => next.delete(id));
      } else {
        pageIds.forEach((id) => next.add(id));
      }
      return next;
    });
  };

  const toggleOne = (id) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const clearSelection = () => setSelected(new Set());

  const handleAdd = async (form) => {
    setSubmitting(true);
    setError('');
    setSuccess('');

    try {
      const created = await createUserRequest({
        name: form.name.trim(),
        email: form.email.trim(),
        phone: form.phone.trim() || null,
        password: form.password,
        role: form.role,
        profile_image: form.profileImage.trim() || null,
        company_id: form.companyId || null,
        company_ids: Array.from(new Set([form.companyId, ...(form.companyIds || [])].filter(Boolean))),
        status: form.status,
      });

      if (created?.id) {
        if (form.groupIds?.length) {
          await Promise.all(form.groupIds.map((groupId) => addGroupMember(groupId, { user_id: created.id })));
        }
        setData((current) => [formatUser(created), ...current].filter(Boolean));
      }
      await loadData();
      setEditUser(null);
      setPage(1);
      setSuccess('User created successfully.');
    } catch (err) {
      setError(err.message || 'Unable to create user.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleEdit = async (form) => {
    setSubmitting(true);
    setError('');

    const payload = {
      name: form.name.trim(),
      email: form.email.trim(),
      phone: form.phone.trim() || null,
      role: form.role,
      profile_image: form.profileImage.trim() || null,
      company_id: form.companyId || null,
      company_ids: Array.from(new Set([form.companyId, ...(form.companyIds || [])].filter(Boolean))),
      status: form.status,
    };

    if (form.password.trim()) {
      payload.password = form.password;
    }

    try {
      const updated = await updateUserRequest(form.id, payload);
      if (updated?.id) {
        const originalGroups = editUser?.groupIds || [];
        const nextGroups = form.groupIds || [];
        const toAdd = nextGroups.filter((id) => !originalGroups.includes(id));
        const toRemove = originalGroups.filter((id) => !nextGroups.includes(id));
        await Promise.all(toAdd.map((groupId) => addGroupMember(groupId, { user_id: form.id })));
        await Promise.all(toRemove.map((groupId) => removeGroupMember(groupId, form.id)));
        const nextUser = formatUser(updated);
        setData((current) => current.map((user) => user.id === form.id ? nextUser : user).filter(Boolean));
        if (viewUser?.id === form.id) setViewUser(nextUser);
      }
      await loadData();
      setEditUser(null);
      setSuccess('User updated successfully.');
    } catch (err) {
      setError(err.message || 'Unable to update user.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    setSubmitting(true);
    setError('');

    try {
      await deleteUserRequest(deleteUser.id);
      setData((current) => current.filter((user) => user.id !== deleteUser.id));
      setSelected((current) => {
        const next = new Set(current);
        next.delete(deleteUser.id);
        return next;
      });
      if (viewUser?.id === deleteUser.id) setViewUser(null);
      setDeleteUser(null);
    } catch (err) {
      setError(err.message || 'Unable to delete user.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleBulkDelete = async () => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;

    setSubmitting(true);
    setError('');

    try {
      await Promise.all(ids.map((id) => deleteUserRequest(id)));
      setData((current) => current.filter((user) => !selected.has(user.id)));
      setSelected(new Set());
    } catch (err) {
      setError(err.message || 'Unable to delete selected users.');
    } finally {
      setSubmitting(false);
    }
  };

  const stats = useMemo(() => ({
    total: data.length,
    active: data.filter((user) => user.status === 'active').length,
    buyers: data.filter((user) => user.role === 'buyer').length,
  }), [data]);

  const resetFilters = () => {
    setSearch('');
    setRole('All Roles');
    setStatus('All Status');
    setComp('All Companies');
    setPage(1);
  };

  const hasActiveFilter = search || filterRole !== 'All Roles' || filterStatus !== 'All Status' || filterCompany !== 'All Companies';

  return (
    <div className="p-6 space-y-6 animate-fadeIn">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-[#05164D]">Users</h1>
          <p className="text-sm text-gray-500 mt-0.5">{stats.total} registered users across all companies</p>
        </div>
        <button
          onClick={() => { setError(''); setEditUser({ ...EMPTY_FORM, isNew: true }); }}
          className="inline-flex items-center gap-2 px-5 py-2.5 bg-[#8BC53D] hover:bg-[#476E2C] text-white rounded-xl text-sm font-bold transition-colors shadow-sm"
        >
          <Plus size={16} />
          Add User
        </button>
      </div>

      {error && (
        <div className="px-4 py-3 bg-red-50 rounded-2xl border border-red-100 text-sm text-[#C62026]">
          {error}
        </div>
      )}
      {success && (
        <div className="px-4 py-3 bg-green-50 rounded-2xl border border-green-100 text-sm text-green-700">
          {success}
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Total Users', value: stats.total, color: '#05164D', icon: UsersIcon },
          { label: 'Active', value: stats.active, color: '#8BC53D', icon: CheckCircle },
          { label: 'Buyers', value: stats.buyers, color: '#00648F', icon: ShoppingCart },
        ].map((item) => {
          const Icon = item.icon;

          return (
            <div key={item.label} className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100 flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: `${item.color}15` }}>
                <Icon size={18} style={{ color: item.color }} />
              </div>
              <div>
                <p className="text-2xl font-bold" style={{ color: item.color }}>{item.value}</p>
                <p className="text-xs text-gray-500">{item.label}</p>
              </div>
            </div>
          );
        })}
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-gray-100">
        <div className="p-4 border-b border-gray-100 flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              value={search}
              onChange={(event) => { setSearch(event.target.value); setPage(1); }}
              placeholder="Search by name, email, company or phone..."
              className="w-full pl-9 pr-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#8BC53D]/40 focus:border-[#8BC53D] bg-gray-50"
            />
          </div>

          <button
            onClick={() => setShowFilters((value) => !value)}
            className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border text-sm font-medium transition-all ${showFilters ? 'bg-[#05164D] text-white border-[#05164D]' : 'border-gray-200 text-gray-600 hover:border-gray-300 bg-gray-50'}`}
          >
            <Filter size={14} />
            Filters
            {hasActiveFilter && <span className="w-2 h-2 rounded-full bg-[#F68C1F] flex-shrink-0" />}
            <ChevronDown size={13} className={`transition-transform ${showFilters ? 'rotate-180' : ''}`} />
          </button>

          {hasActiveFilter && (
            <button onClick={resetFilters} className="inline-flex items-center gap-1.5 px-3 py-2.5 text-xs text-red-500 hover:text-red-600 font-medium">
              <X size={13} /> Clear
            </button>
          )}
        </div>

        {showFilters && (
          <div className="px-4 pb-4 flex flex-wrap gap-3 border-b border-gray-100 pt-3">
            {[
              { label: 'Company', value: filterCompany, options: companyOptions, onChange: (value) => { setComp(value); setPage(1); } },
              { label: 'Role', value: filterRole, options: roleOptions, onChange: (value) => { setRole(value); setPage(1); } },
              { label: 'Status', value: filterStatus, options: statusOptions, onChange: (value) => { setStatus(value); setPage(1); } },
            ].map(({ label, value, options, onChange }) => (
              <div key={label} className="flex flex-col gap-1">
                <span className="text-xs font-semibold text-gray-400 px-1">{label}</span>
                <select
                  value={value}
                  onChange={(event) => onChange(event.target.value)}
                  className="px-3 py-2 rounded-xl border border-gray-200 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-[#8BC53D]/30 focus:border-[#8BC53D] min-w-[140px]"
                >
                  {options.map((option) => <option key={option}>{option}</option>)}
                </select>
              </div>
            ))}
          </div>
        )}

        {selected.size > 0 && (
          <div className="px-4 py-2.5 bg-[#05164D]/5 border-b border-gray-100 flex items-center gap-3">
            <span className="text-sm font-semibold text-[#05164D]">{selected.size} user{selected.size > 1 ? 's' : ''} selected</span>
            <button
              onClick={handleBulkDelete}
              disabled={submitting}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-50 text-red-600 text-xs font-semibold hover:bg-red-100 transition-colors disabled:opacity-60"
            >
              <Trash2 size={12} /> Delete Selected
            </button>
            <button onClick={clearSelection} className="text-xs text-gray-400 hover:text-gray-600 ml-auto">Clear selection</button>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100">
                <th className="pl-4 pr-2 py-3 text-left">
                  <button
                    onClick={toggleAll}
                    className={`w-4.5 h-4.5 rounded border-2 flex items-center justify-center transition-colors ${allPageSelected ? 'bg-[#8BC53D] border-[#8BC53D]' : someSelected ? 'bg-[#8BC53D]/30 border-[#8BC53D]' : 'border-gray-300 hover:border-[#8BC53D]'}`}
                    style={{ width: 18, height: 18 }}
                  >
                    {(allPageSelected || someSelected) && <Check size={10} className="text-white" strokeWidth={3} />}
                  </button>
                </th>
                {['Name', 'Company', 'Email', 'Phone No.', 'Role', 'Status', 'Actions'].map((header) => (
                  <th key={header} className="px-3 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wide whitespace-nowrap">
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {loading ? (
                <tr>
                  <td colSpan={8} className="py-16 text-center text-sm text-gray-400">
                    Loading users...
                  </td>
                </tr>
              ) : paginated.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-16 text-center">
                    <UsersIcon size={36} className="mx-auto text-gray-200 mb-3" />
                    <p className="text-sm font-semibold text-gray-400">No users found</p>
                    {hasActiveFilter && <button onClick={resetFilters} className="mt-2 text-xs text-[#8BC53D] hover:underline">Clear filters</button>}
                  </td>
                </tr>
              ) : paginated.map((user) => (
                <tr key={user.id} className={`group hover:bg-gray-50/80 transition-colors ${selected.has(user.id) ? 'bg-[#8BC53D]/5' : ''}`}>
                  <td className="pl-4 pr-2 py-3.5">
                    <button
                      onClick={() => toggleOne(user.id)}
                      className={`w-4.5 h-4.5 rounded border-2 flex items-center justify-center transition-colors ${selected.has(user.id) ? 'bg-[#8BC53D] border-[#8BC53D]' : 'border-gray-300 hover:border-[#8BC53D]'}`}
                      style={{ width: 18, height: 18 }}
                    >
                      {selected.has(user.id) && <Check size={10} className="text-white" strokeWidth={3} />}
                    </button>
                  </td>
                  <td className="px-3 py-3.5">
                    <div className="flex items-center gap-2.5">
                      <Avatar user={user} size={8} />
                      <span className="font-semibold text-[#05164D] whitespace-nowrap">{user.name}</span>
                    </div>
                  </td>
                  <td className="px-3 py-3.5">
                    <span className="text-gray-600 whitespace-nowrap">{user.company}</span>
                  </td>
                  <td className="px-3 py-3.5">
                    <span className="text-gray-500 text-xs">{user.email}</span>
                  </td>
                  <td className="px-3 py-3.5">
                    <span className="text-gray-600 whitespace-nowrap">{user.phone}</span>
                  </td>
                  <td className="px-3 py-3.5">
                    <RoleBadge role={user.role} />
                  </td>
                  <td className="px-3 py-3.5">
                    <StatusBadge status={user.status} />
                  </td>
                  <td className="px-3 py-3.5">
                    <div className="flex items-center gap-1">
                      <button
                        title="View Details"
                        onClick={() => setViewUser(user)}
                        className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-[#00648F] hover:bg-blue-50 transition-colors"
                      >
                        <Eye size={15} />
                      </button>
                      <button
                        title="Edit"
                        onClick={() => setEditUser({ ...user, password: '' })}
                        className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-[#8BC53D] hover:bg-green-50 transition-colors"
                      >
                        <Pencil size={15} />
                      </button>
                      <button
                        title="Delete"
                        onClick={() => setDeleteUser(user)}
                        className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="px-4 py-3.5 border-t border-gray-100 flex flex-col sm:flex-row items-center justify-between gap-3">
          <p className="text-xs text-gray-400">
            Showing <span className="font-semibold text-gray-600">{filtered.length === 0 ? 0 : (safePage - 1) * PAGE_SIZE + 1}-{Math.min(safePage * PAGE_SIZE, filtered.length)}</span> of <span className="font-semibold text-gray-600">{filtered.length}</span> users
          </p>

          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage((current) => Math.max(1, current - 1))}
              disabled={safePage === 1}
              className="w-8 h-8 rounded-lg border border-gray-200 flex items-center justify-center text-gray-500 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronLeft size={14} />
            </button>

            {pageRange[0] > 1 && (
              <>
                <button onClick={() => setPage(1)} className="w-8 h-8 rounded-lg border border-gray-200 text-xs font-semibold text-gray-500 hover:bg-gray-50 transition-colors">1</button>
                {pageRange[0] > 2 && <span className="text-gray-300 text-sm px-1">...</span>}
              </>
            )}

            {pageRange.map((pageNumber) => (
              <button
                key={pageNumber}
                onClick={() => setPage(pageNumber)}
                className={`w-8 h-8 rounded-lg border text-xs font-semibold transition-colors ${pageNumber === safePage ? 'bg-[#05164D] border-[#05164D] text-white' : 'border-gray-200 text-gray-500 hover:bg-gray-50'}`}
              >
                {pageNumber}
              </button>
            ))}

            {pageRange[pageRange.length - 1] < totalPages && (
              <>
                {pageRange[pageRange.length - 1] < totalPages - 1 && <span className="text-gray-300 text-sm px-1">...</span>}
                <button onClick={() => setPage(totalPages)} className="w-8 h-8 rounded-lg border border-gray-200 text-xs font-semibold text-gray-500 hover:bg-gray-50 transition-colors">{totalPages}</button>
              </>
            )}

            <button
              onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
              disabled={safePage === totalPages}
              className="w-8 h-8 rounded-lg border border-gray-200 flex items-center justify-center text-gray-500 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronRight size={14} />
            </button>
          </div>
        </div>
      </div>

      {viewUser && (
        <ViewModal
          user={viewUser}
          onClose={() => setViewUser(null)}
          onEdit={() => { setEditUser({ ...viewUser, password: '' }); setViewUser(null); }}
        />
      )}

      {editUser && (
        <UserFormModal
          initial={editUser}
          companies={companies}
          groups={editUser?.companyId ? (groupsByCompany[editUser.companyId] || []) : []}
          onCompanyChange={(companyId) => loadGroupsForCompany(companyId)}
          onSave={editUser?.isNew ? handleAdd : handleEdit}
          onClose={() => setEditUser(null)}
          submitting={submitting}
        />
      )}

      {deleteUser && (
        <DeleteModal
          user={deleteUser}
          onConfirm={handleDelete}
          onClose={() => setDeleteUser(null)}
          submitting={submitting}
        />
      )}
    </div>
  );
}
