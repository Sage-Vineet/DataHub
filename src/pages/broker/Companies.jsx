import { useEffect, useMemo, useState } from 'react';
import {
  Building2, Phone, Mail, Plus, Search,
  Users, ArrowRight, Filter, Download, ChevronLeft,
  ChevronDown, Eye, X, ChevronRight, Pencil
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useClientStore } from '../../store/clientStore';
import StatusBadge from '../../components/common/StatusBadge';
import Modal from '../../components/common/Modal';
import { createCompanyFolder, createCompanyRequest, listCompaniesRequest, listFolderTree, updateCompanyRequest } from '../../lib/api';

const PAGE_SIZE = 10;
const EMPTY_FORM = { name: '', contact: '', email: '', phone: '', industry: '' };
const DEFAULT_COMPANY_FOLDERS = ['Finance', 'Legal', 'Compliance', 'HR', 'Tax', 'M&A'];

function getInitials(name = '') {
  return name
    .split(' ')
    .filter(Boolean)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

function formatCompany(company) {
  if (!company) return null;
  return {
    id: company.id,
    name: company.name,
    contact: company.contact_name,
    email: company.contact_email,
    phone: company.contact_phone,
    industry: company.industry,
    status: company.status,
    since: company.since ? company.since.slice(0, 10) : 'N/A',
    logo: company.logo || getInitials(company.name),
    requestCount: company.request_count || 0,
    pendingCount: company.pending_request_count || 0,
    completedCount: company.completed_request_count || 0,
  };
}

async function ensureDefaultCompanyFolders(companyId) {
  if (!companyId) return;

  const existingTree = await listFolderTree(companyId).catch(() => []);
  const existingNames = new Set(
    (existingTree || [])
      .map((folder) => folder?.name?.trim().toLowerCase())
      .filter(Boolean)
  );

  const missingFolders = DEFAULT_COMPANY_FOLDERS.filter(
    (name) => !existingNames.has(name.toLowerCase())
  );

  if (!missingFolders.length) return;

  const results = await Promise.allSettled(
    missingFolders.map((name) => createCompanyFolder(companyId, { name }))
  );

  const failed = results.filter((result) => result.status === 'rejected');
  if (failed.length) {
    throw new Error('Company was created, but some default folders could not be created.');
  }
}

export default function Companies() {
  const navigate = useNavigate();
  const { setSelectedClient } = useClientStore();
  const [companies, setCompanies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [search, setSearch] = useState('');
  const [industryFilter, setIndustryFilter] = useState('All Industries');
  const [statusFilter, setStatusFilter] = useState('All Status');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editing, setEditing] = useState(null);

  const loadCompanies = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await listCompaniesRequest();
      setCompanies(data.map(formatCompany).filter(Boolean));
    } catch (err) {
      setError(err.message || 'Unable to load companies.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadCompanies();
  }, []);

  useEffect(() => {
    if (!success) return undefined;
    const timer = setTimeout(() => setSuccess(''), 3000);
    return () => clearTimeout(timer);
  }, [success]);

  const industryOptions = useMemo(
    () => ['All Industries', ...Array.from(new Set(companies.map((company) => company.industry))).filter(Boolean)],
    [companies]
  );
  const statusOptions = useMemo(
    () => ['All Status', ...Array.from(new Set(companies.map((company) => company.status))).filter(Boolean)],
    [companies]
  );

  const handleOpenWorkspace = (company) => {
    if (!company?.id) {
      console.warn('Client click ignored: missing company id', company);
      return;
    }
    console.log('Client clicked:', company.id);
    setSelectedClient({ id: company.id, name: company.name });
    navigate(`/broker/client/${company.id}/datahub-dashboard`, { state: { company } });
  };

  const filtered = useMemo(() => {
    return companies.filter((company) => {
      const term = search.toLowerCase();
      const matchSearch =
        !term ||
        company.name.toLowerCase().includes(term) ||
        company.contact.toLowerCase().includes(term) ||
        company.email.toLowerCase().includes(term) ||
        company.phone.includes(term);
      const matchIndustry = industryFilter === 'All Industries' || company.industry === industryFilter;
      const matchStatus = statusFilter === 'All Status' || company.status === statusFilter;
      return matchSearch && matchIndustry && matchStatus;
    });
  }, [companies, search, industryFilter, statusFilter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const paginated = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const handleExport = () => {
    const headers = ['Company Name', 'Industry', 'Contact Person', 'Email', 'Phone', 'Status', 'Since', 'Total Requests', 'Pending'];
    const rows = filtered.map((company) => [
      company.name,
      company.industry,
      company.contact,
      company.email,
      company.phone,
      company.status,
      company.since,
      company.requestCount,
      company.pendingCount,
    ]);
    const csv = [headers, ...rows].map((row) => row.map((value) => `"${value}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'companies.csv';
    link.click();
    URL.revokeObjectURL(url);
  };

  const closeFormModal = () => {
    setShowAdd(false);
    setEditing(null);
    setForm(EMPTY_FORM);
  };

  const openAddModal = () => {
    setError('');
    setEditing(null);
    setForm(EMPTY_FORM);
    setShowAdd(true);
  };

  const openEditModal = (company) => {
    setError('');
    setEditing(company);
    setForm({
      name: company.name || '',
      contact: company.contact || '',
      email: company.email || '',
      phone: company.phone || '',
      industry: company.industry || '',
    });
    setShowAdd(true);
  };

  const handlePhoneChange = (event) => {
    let value = event.target.value.replace(/\D/g, ''); // Keep only numbers
    if (value.length > 10) value = value.slice(0, 10);
    
    let formatted = value;
    if (value.length > 6) {
      formatted = `${value.slice(0, 3)}-${value.slice(3, 6)}-${value.slice(6)}`;
    } else if (value.length > 3) {
      formatted = `${value.slice(0, 3)}-${value.slice(3)}`;
    }
    
    setForm((current) => ({ ...current, phone: formatted }));
  };

  const handleSaveCompany = async () => {
    if (!form.name.trim() || !form.contact.trim() || !form.email.trim() || !form.phone.trim() || !form.industry.trim()) {
      setError('Please fill in all company fields.');
      return;
    }

    setSubmitting(true);
    setError('');
    setSuccess('');

    const payload = {
        name: form.name.trim(),
        industry: form.industry.trim(),
        contact_name: form.contact.trim(),
        contact_email: form.email.trim(),
        contact_phone: form.phone.trim(),
        logo: getInitials(form.name),
      };

    try {
      if (editing) {
        const updated = await updateCompanyRequest(editing.id, payload);
        if (updated?.id) {
          setCompanies((current) => current.map((company) => {
            if (company.id !== editing.id) return company;
            const hydrated = {
              ...updated,
              request_count: company.requestCount,
              pending_request_count: company.pendingCount,
              completed_request_count: company.completedCount,
            };
            return formatCompany(hydrated);
          }));
        } else {
          await loadCompanies();
        }
        setSuccess('Company updated successfully.');
      } else {
        const created = await createCompanyRequest(payload);
        if (created?.id) {
          await ensureDefaultCompanyFolders(created.id);
          setCompanies((current) => [formatCompany(created), ...current].filter(Boolean));
          setPage(1);
        }
        await loadCompanies();
        setSuccess('Company created successfully.');
      }

      closeFormModal();
    } catch (err) {
      setError(err.message || `Unable to ${editing ? 'update' : 'create'} company.`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#050505]">Client Companies</h1>
          <p className="text-sm text-[#6D6E71] mt-0.5">{companies.length} companies registered</p>
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
            className="flex items-center gap-2 px-5 py-2.5 bg-[#8BC53D] hover:bg-[#476E2C] text-white rounded-xl text-sm font-semibold transition-all duration-200 hover:scale-[1.02] shadow-md"
          >
            <Plus size={15} />
            Add Company
          </button>
        </div>
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

      <div className="bg-white rounded-2xl shadow-card p-4">
        <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
          <div className="flex items-center gap-2 border border-gray-200 rounded-xl px-3 py-2 focus-within:ring-2 focus-within:ring-[#8BC53D]/30 flex-1 min-w-0">
            <Search size={15} className="text-[#A5A5A5] flex-shrink-0" />
            <input
              value={search}
              onChange={(event) => { setSearch(event.target.value); setPage(1); }}
              placeholder="Search by name, contact, email..."
              className="text-sm outline-none text-[#050505] placeholder-[#A5A5A5] bg-transparent w-full"
            />
            {search && (
              <button onClick={() => { setSearch(''); setPage(1); }} className="text-[#A5A5A5] hover:text-[#050505]">
                <X size={13} />
              </button>
            )}
          </div>
          <div className="relative">
            <Filter size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#A5A5A5] pointer-events-none" />
            <select
              value={industryFilter}
              onChange={(event) => { setIndustryFilter(event.target.value); setPage(1); }}
              className="appearance-none pl-8 pr-8 py-2 text-sm border border-gray-200 rounded-xl text-[#050505] bg-white focus:outline-none focus:ring-2 focus:ring-[#8BC53D]/30 cursor-pointer"
            >
              {industryOptions.map((option) => <option key={option}>{option}</option>)}
            </select>
            <ChevronDown size={13} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#A5A5A5] pointer-events-none" />
          </div>
          <div className="relative">
            <select
              value={statusFilter}
              onChange={(event) => { setStatusFilter(event.target.value); setPage(1); }}
              className="appearance-none pl-4 pr-8 py-2 text-sm border border-gray-200 rounded-xl text-[#050505] bg-white focus:outline-none focus:ring-2 focus:ring-[#8BC53D]/30 cursor-pointer capitalize"
            >
              {statusOptions.map((option) => <option key={option} className="capitalize">{option}</option>)}
            </select>
            <ChevronDown size={13} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#A5A5A5] pointer-events-none" />
          </div>
          <p className="text-xs text-[#A5A5A5] whitespace-nowrap flex-shrink-0">
            {filtered.length} result{filtered.length !== 1 ? 's' : ''}
          </p>
        </div>
      </div>

      <div className="bg-white rounded-2xl shadow-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="text-left px-5 py-3.5 text-xs font-semibold text-[#6D6E71] uppercase tracking-wide">#</th>
                <th className="text-left px-5 py-3.5 text-xs font-semibold text-[#6D6E71] uppercase tracking-wide">Company</th>
                <th className="text-left px-5 py-3.5 text-xs font-semibold text-[#6D6E71] uppercase tracking-wide">Contact Person</th>
                <th className="text-left px-5 py-3.5 text-xs font-semibold text-[#6D6E71] uppercase tracking-wide">Email</th>
                <th className="text-left px-5 py-3.5 text-xs font-semibold text-[#6D6E71] uppercase tracking-wide">Phone</th>
                <th className="text-left px-5 py-3.5 text-xs font-semibold text-[#6D6E71] uppercase tracking-wide">Status</th>
                <th className="text-center px-5 py-3.5 text-xs font-semibold text-[#6D6E71] uppercase tracking-wide">Total Req</th>
                <th className="text-center px-5 py-3.5 text-xs font-semibold text-[#6D6E71] uppercase tracking-wide">Pending</th>
                <th className="text-right px-5 py-3.5 text-xs font-semibold text-[#6D6E71] uppercase tracking-wide">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {loading && (
                <tr>
                  <td colSpan={9} className="text-center py-16 text-[#A5A5A5] text-sm">
                    Loading companies...
                  </td>
                </tr>
              )}
              {!loading && paginated.length === 0 && (
                <tr>
                  <td colSpan={9} className="text-center py-16 text-[#A5A5A5] text-sm">
                    No companies found matching your filters.
                  </td>
                </tr>
              )}
              {!loading && paginated.map((company, index) => (
                <tr key={company.id} className="hover:bg-gray-50/60 transition-colors group">
                  <td className="px-5 py-4 text-xs text-[#A5A5A5] font-medium">
                    {(safePage - 1) * PAGE_SIZE + index + 1}
                  </td>
                  <td className="px-5 py-4">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-xl bg-[#05164D] flex items-center justify-center text-xs font-bold text-white flex-shrink-0">
                        {company.logo}
                      </div>
                      <button
                        onClick={() => handleOpenWorkspace(company)}
                        className="font-semibold text-[#050505] hover:text-[#8BC53D] hover:underline leading-tight text-left transition-colors"
                      >
                        {company.name}
                      </button>
                    </div>
                  </td>
                  <td className="px-5 py-4">
                    <div className="flex items-center gap-1.5 text-[#050505]">
                      <Users size={13} className="text-[#A5A5A5] flex-shrink-0" />
                      <span>{company.contact}</span>
                    </div>
                  </td>
                  <td className="px-5 py-4">
                    <div className="flex items-center gap-1.5 text-[#6D6E71]">
                      <Mail size={13} className="text-[#A5A5A5] flex-shrink-0" />
                      <span className="truncate max-w-[180px]">{company.email}</span>
                    </div>
                  </td>
                  <td className="px-5 py-4">
                    <div className="flex items-center gap-1.5 text-[#6D6E71]">
                      <Phone size={13} className="text-[#A5A5A5] flex-shrink-0" />
                      <span>{company.phone}</span>
                    </div>
                  </td>
                  <td className="px-5 py-4">
                    <StatusBadge value={company.status} size="xs" />
                  </td>
                  <td className="px-5 py-4 text-center">
                    <span className="text-base font-bold text-[#050505]">{company.requestCount}</span>
                  </td>
                  <td className="px-5 py-4 text-center">
                    {company.pendingCount > 0 ? (
                      <span className="inline-block px-2.5 py-0.5 rounded-full text-xs font-bold bg-[#FAC086]/50 text-[#b45e08]">
                        {company.pendingCount}
                      </span>
                    ) : (
                      <span className="text-[#A5A5A5] text-xs">-</span>
                    )}
                  </td>
                  <td className="px-5 py-4">
                    <div className="flex items-center justify-end">
                      <button
                        onClick={() => setSelected(company)}
                        title="View details"
                        className="p-1.5 rounded-lg text-[#6D6E71] hover:bg-[#A7DCF7]/40 hover:text-[#00648F] transition-colors"
                      >
                        <Eye size={15} />
                      </button>
                      <button
                        onClick={() => openEditModal(company)}
                        title="Edit company"
                        className="p-1.5 rounded-lg text-[#6D6E71] hover:bg-[#C9E4A4]/60 hover:text-[#476E2C] transition-colors"
                      >
                        <Pencil size={15} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {!loading && totalPages > 1 && (
          <div className="flex items-center justify-between px-5 py-3.5 border-t border-gray-100 bg-gray-50/50">
            <p className="text-xs text-[#6D6E71]">
              Showing {(safePage - 1) * PAGE_SIZE + 1}-{Math.min(safePage * PAGE_SIZE, filtered.length)} of {filtered.length} companies
            </p>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setPage((current) => Math.max(1, current - 1))}
                disabled={safePage === 1}
                className="p-1.5 rounded-lg border border-gray-200 text-[#6D6E71] hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronLeft size={15} />
              </button>
              {Array.from({ length: totalPages }, (_, index) => index + 1).map((pageNumber) => (
                <button
                  key={pageNumber}
                  onClick={() => setPage(pageNumber)}
                  className={`w-8 h-8 rounded-lg text-xs font-semibold transition-colors border ${
                    pageNumber === safePage
                      ? 'bg-[#05164D] text-white border-[#05164D]'
                      : 'border-gray-200 text-[#6D6E71] hover:bg-white'
                  }`}
                >
                  {pageNumber}
                </button>
              ))}
              <button
                onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                disabled={safePage === totalPages}
                className="p-1.5 rounded-lg border border-gray-200 text-[#6D6E71] hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronRight size={15} />
              </button>
            </div>
          </div>
        )}
        {!loading && totalPages === 1 && filtered.length > 0 && (
          <div className="px-5 py-3 border-t border-gray-100 bg-gray-50/50">
            <p className="text-xs text-[#A5A5A5]">
              Showing all <span className="font-semibold text-[#6D6E71]">{filtered.length}</span> companies
            </p>
          </div>
        )}
      </div>

      <Modal isOpen={!!selected} onClose={() => setSelected(null)} title="Company Details" size="md">
        {selected && (
          <div className="space-y-5">
            <div className="flex items-center gap-4 p-4 bg-gray-50 rounded-xl">
              <div className="w-16 h-16 rounded-2xl bg-[#05164D] flex items-center justify-center text-xl font-bold text-white">
                {selected.logo}
              </div>
              <div>
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
            <div className="grid grid-cols-3 gap-3">
              {[
                { label: 'Total', value: selected.requestCount, color: '#050505' },
                { label: 'Pending', value: selected.pendingCount, color: '#b45e08' },
                { label: 'Completed', value: selected.completedCount, color: '#476E2C' },
              ].map((stat) => (
                <div key={stat.label} className="text-center bg-gray-50 rounded-xl py-3">
                  <p className="text-2xl font-bold" style={{ color: stat.color }}>{stat.value}</p>
                  <p className="text-xs text-[#A5A5A5] mt-0.5">{stat.label}</p>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => {
                  const target = selected;
                  setSelected(null);
                  handleOpenWorkspace(target);
                }}
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

      <Modal isOpen={showAdd} onClose={closeFormModal} title={editing ? 'Edit Company' : 'Add New Company'}>
        <div className="space-y-4">
          {[
            { label: 'Company Name', key: 'name', placeholder: 'e.g. Accenture India' },
            { label: 'Contact Person', key: 'contact', placeholder: 'Full name' },
            { label: 'Email Address', key: 'email', placeholder: 'contact@company.com', type: 'email' },
            { label: 'Phone Number', key: 'phone', placeholder: '555-555-5555' },
            { label: 'Industry', key: 'industry', placeholder: 'e.g. IT Services' },
          ].map((field) => (
            <div key={field.key}>
              <label className="block text-sm font-medium text-[#050505] mb-1.5">{field.label}</label>
              <input
                type={field.type || 'text'}
                value={form[field.key]}
                onChange={(event) => {
                  if (field.key === 'phone') {
                    handlePhoneChange(event);
                  } else {
                    setForm((current) => ({ ...current, [field.key]: event.target.value }));
                  }
                }}
                placeholder={field.placeholder}
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#8BC53D]/40 focus:border-[#8BC53D] transition-all placeholder-[#A5A5A5]"
              />
            </div>
          ))}
          <div className="flex gap-3 pt-2">
            <button
              onClick={closeFormModal}
              className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm font-semibold text-[#6D6E71] hover:bg-gray-50 transition-colors"
            >
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
    </div>
  );
}
