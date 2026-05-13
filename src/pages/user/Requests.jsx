import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle2, Clock3, Eye, FileText, Filter, Pencil, Send, ShieldCheck, XCircle } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import NewRequestModal from '../../components/NewRequestModal';
import { createCompanyRequestItem, listCompanyRequests, listFolderTree, updateRequest } from '../../lib/api';
import { buildFolderOptionsFromTree } from '../../lib/folderOptions';
import { getAssignedCompanies } from './portalUtils';

const WORKFLOW_META = {
  pending: { label: 'Pending', bg: '#F3F4F6', color: '#6D6E71' },
  'in-review': { label: 'In Review', bg: '#DBEAFE', color: '#2563EB' },
  completed: { label: 'Completed', bg: '#DCFCE7', color: '#166534' },
  blocked: { label: 'Blocked', bg: '#FEE2E2', color: '#991B1B' },
};

const APPROVAL_META = {
  pending: { label: 'Awaiting Broker Approval', bg: '#FEF3C7', color: '#A86F0B' },
  approved: { label: 'Approved By Broker', bg: '#E6F3D3', color: '#476E2C' },
};

function isOwnedByUser(request, userId) {
  if (!request || !userId) return false;
  return String(request.created_by) === String(userId);
}

function normalizeWorkflowStatus(status) {
  if (['awaiting-review', 'in-progress', 'submitted', 'in-review'].includes(status)) return 'in-review';
  if (status === 'completed') return 'completed';
  if (status === 'blocked') return 'blocked';
  return 'pending';
}

function StatusPill({ label, bg, color }) {
  return (
    <span
      className="inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold"
      style={{ backgroundColor: bg, color }}
    >
      {label}
    </span>
  );
}

function mapToCategory(item) {
  const text = `${item.name} ${item.subLabel || ''} ${item.description || ''}`.toLowerCase();
  if (text.includes('revenue recognition') || text.includes('trial balance')) return 'Finance';
  if (text.includes('litigation') || text.includes('arbitration')) return 'Legal';
  if (text.includes('tax') || text.includes('regulatory') || text.includes('compliance') || text.includes('gst')) return 'Compliance';
  if (text.includes('hr') || text.includes('people') || text.includes('employment')) return 'HR';
  if (text.includes('m&a') || text.includes('merger') || text.includes('acquisition')) return 'M&A';
  if ((item.category || '').toLowerCase().includes('finance')) return 'Finance';
  if ((item.category || '').toLowerCase().includes('legal')) return 'Legal';
  if ((item.category || '').toLowerCase().includes('tax')) return 'Tax';
  if ((item.category || '').toLowerCase().includes('hr')) return 'HR';
  if ((item.category || '').toLowerCase().includes('m&a')) return 'M&A';
  if ((item.category || '').toLowerCase().includes('compliance')) return 'Compliance';
  return 'Other';
}

function buildCreateRequestPayload(form) {
  const folderLabel = form.requestType === 'Information' ? '' : (form.category || '').trim();
  const resolvedCategory = mapToCategory({
    name: form.name?.trim() || '',
    subLabel: folderLabel,
    description: form.description?.trim() || '',
    category: folderLabel,
  });

  return {
    title: form.name.trim(),
    sub_label: folderLabel,
    description: form.description.trim(),
    category: resolvedCategory,
    response_type: form.requestType === 'Information' ? 'Narrative' : 'Both',
    priority: form.priority,
    status: 'pending',
    due_date: form.dueDate,
    assigned_to: null,
    visible: true,
  };
}

export default function UserRequests() {
  const { user } = useAuth();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const assignedCompanies = useMemo(() => getAssignedCompanies(user), [user]);
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [companyFilter, setCompanyFilter] = useState('all');
  const [approvalFilter, setApprovalFilter] = useState('all');
  const [isNewRequestOpen, setIsNewRequestOpen] = useState(false);
  const [editingRequest, setEditingRequest] = useState(null);
  const [editForm, setEditForm] = useState({ title: '', description: '', priority: 'high', dueDate: '' });
  const [savingEdit, setSavingEdit] = useState(false);
  const [folderOptions, setFolderOptions] = useState([]);
  const [foldersLoading, setFoldersLoading] = useState(false);

  const activeCompanyId = companyFilter !== 'all'
    ? companyFilter
    : (assignedCompanies.length === 1 ? String(assignedCompanies[0].id) : '');

  useEffect(() => {
    if (!isNewRequestOpen || !activeCompanyId) {
      setFolderOptions([]);
      return;
    }

    setFoldersLoading(true);
    listFolderTree(activeCompanyId)
      .then((tree) => setFolderOptions(buildFolderOptionsFromTree(tree)))
      .catch(() => setFolderOptions([]))
      .finally(() => setFoldersLoading(false));
  }, [isNewRequestOpen, activeCompanyId]);

  const loadRequests = async () => {
    if (!assignedCompanies.length) {
      setRequests([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError('');
    try {
      const responses = await Promise.all(
        assignedCompanies.map(async (company) => {
          const companyRequests = await listCompanyRequests(company.id).catch(() => []);
          return companyRequests
            .filter((request) => isOwnedByUser(request, user?.id))
            .map((request) => ({
            id: request.id,
            companyId: company.id,
            companyName: company.name,
            title: request.title || 'Untitled Request',
            description: request.description || 'No description provided.',
            category: request.category || 'Other',
            priority: request.priority || 'high',
            dueDate: request.due_date ? request.due_date.slice(0, 10) : 'Not set',
            createdAt: request.created_at ? request.created_at.slice(0, 10) : 'Not set',
            workflowStatus: normalizeWorkflowStatus(request.status),
            approvalStatus: request.approval_status || 'approved',
            responseType: request.response_type || 'Narrative',
            visible: request.visible !== false,
          }));
        }),
      );

      setRequests(responses.flat().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))));
    } catch (err) {
      setError(err.message || 'Unable to load requests.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadRequests();
  }, [assignedCompanies, user?.id]);

  useEffect(() => {
    if (!assignedCompanies.length) return undefined;
    const refreshOnReturn = () => {
      if (document.visibilityState === 'visible') {
        loadRequests();
      }
    };
    window.addEventListener('focus', refreshOnReturn);
    document.addEventListener('visibilitychange', refreshOnReturn);
    return () => {
      window.removeEventListener('focus', refreshOnReturn);
      document.removeEventListener('visibilitychange', refreshOnReturn);
    };
  }, [assignedCompanies, user?.id]);

  const createRequest = async (form) => {
    if (!activeCompanyId) {
      showToast({
        type: 'error',
        title: 'Select a company',
        message: 'Choose a company filter before creating a request.',
      });
      return;
    }

    try {
      await createCompanyRequestItem(activeCompanyId, {
        ...buildCreateRequestPayload(form),
        created_by: user?.id || null,
      });
      setIsNewRequestOpen(false);
      await loadRequests();
      showToast({
        type: 'success',
        title: 'Request submitted',
        message: 'Your request has been sent to the broker for approval.',
      });
    } catch (err) {
      showToast({
        type: 'error',
        title: 'Unable to create request',
        message: err.message || 'Please try again.',
      });
    }
  };

  const openEditRequest = (request) => {
    setEditingRequest(request);
    setEditForm({
      title: request.title || '',
      description: request.description || '',
      priority: request.priority || 'high',
      dueDate: request.dueDate || '',
    });
  };

  const saveEditedRequest = async (event) => {
    event.preventDefault();
    if (!editingRequest) return;

    setSavingEdit(true);
    try {
      await updateRequest(editingRequest.id, {
        title: editForm.title.trim(),
        description: editForm.description.trim(),
        priority: editForm.priority,
        due_date: editForm.dueDate,
      });
      setEditingRequest(null);
      await loadRequests();
      showToast({
        type: 'success',
        title: 'Request updated',
        message: 'Pending request details were updated successfully.',
      });
    } catch (err) {
      showToast({
        type: 'error',
        title: 'Unable to update request',
        message: err.message || 'Please try again.',
      });
    } finally {
      setSavingEdit(false);
    }
  };

  const filteredRequests = useMemo(
    () =>
      requests.filter((request) => {
        const matchesCompany = companyFilter === 'all' || String(request.companyId) === companyFilter;
        const matchesApproval = approvalFilter === 'all' || request.approvalStatus === approvalFilter;
        return matchesCompany && matchesApproval;
      }),
    [requests, companyFilter, approvalFilter],
  );

  const stats = useMemo(() => {
    const pendingApproval = requests.filter((request) => request.approvalStatus === 'pending').length;
    const sentToClient = requests.filter((request) => request.approvalStatus === 'approved' && request.visible).length;
    const inReview = requests.filter((request) => request.workflowStatus === 'in-review').length;
    const completed = requests.filter((request) => request.workflowStatus === 'completed').length;

    return { pendingApproval, sentToClient, inReview, completed };
  }, [requests]);

  if (!assignedCompanies.length) {
    return (
      <div className="rounded-3xl border border-[#E5E7EF] bg-white p-10 text-center shadow-sm">
        <FileText size={34} className="mx-auto mb-4 text-[#A5A5A5]" />
        <h1 className="text-2xl font-bold text-[#05164D]">No requests available</h1>
        <p className="mt-2 text-sm text-[#6D6E71]">A broker needs to assign a company before request tracking appears here.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[#050505]">Request Status</h1>
          <p className="mt-0.5 text-sm text-[#6D6E71]">Track submitted requests, broker approval, and what has already been sent to the client portal.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => setIsNewRequestOpen(true)}
            disabled={!activeCompanyId}
            className={`inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition-colors ${
              activeCompanyId
                ? 'bg-[#8BC53D] text-white hover:bg-[#476E2C]'
                : 'cursor-not-allowed bg-gray-200 text-[#A5A5A5]'
            }`}
          >
            <Send size={15} />
            Add Request
          </button>
          <button
            type="button"
            onClick={() => navigate('/user/portal-dashboard')}
            className="inline-flex items-center gap-2 rounded-xl border border-[#E5E7EF] bg-white px-4 py-2.5 text-sm font-semibold text-[#6D6E71] transition-colors hover:bg-[#F8F9FC] hover:text-[#05164D]"
          >
            <Send size={15} />
            Back to companies
          </button>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-2xl bg-white p-5 shadow-card">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-[#A5A5A5]">Awaiting Approval</p>
              <p className="mt-2 text-3xl font-bold text-[#05164D]">{stats.pendingApproval}</p>
            </div>
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[#FEF3C7]">
              <Clock3 size={22} className="text-[#A86F0B]" />
            </div>
          </div>
        </div>
        <div className="rounded-2xl bg-white p-5 shadow-card">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-[#A5A5A5]">Sent To Client</p>
              <p className="mt-2 text-3xl font-bold text-[#05164D]">{stats.sentToClient}</p>
            </div>
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[#E6F3D3]">
              <Eye size={22} className="text-[#476E2C]" />
            </div>
          </div>
        </div>
        <div className="rounded-2xl bg-white p-5 shadow-card">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-[#A5A5A5]">In Review</p>
              <p className="mt-2 text-3xl font-bold text-[#05164D]">{stats.inReview}</p>
            </div>
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[#DBEAFE]">
              <ShieldCheck size={22} className="text-[#2563EB]" />
            </div>
          </div>
        </div>
        <div className="rounded-2xl bg-white p-5 shadow-card">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-[#A5A5A5]">Completed</p>
              <p className="mt-2 text-3xl font-bold text-[#05164D]">{stats.completed}</p>
            </div>
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[#DCFCE7]">
              <CheckCircle2 size={22} className="text-[#166534]" />
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-3xl bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-2 text-sm font-semibold text-[#05164D]">
            <Filter size={16} />
            Filters
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            <select
              value={companyFilter}
              onChange={(event) => setCompanyFilter(event.target.value)}
              className="rounded-xl border border-[#E5E7EF] bg-white px-3 py-2 text-sm text-[#050505]"
            >
              <option value="all">All companies</option>
              {assignedCompanies.map((company) => (
                <option key={company.id} value={String(company.id)}>
                  {company.name}
                </option>
              ))}
            </select>
            <select
              value={approvalFilter}
              onChange={(event) => setApprovalFilter(event.target.value)}
              className="rounded-xl border border-[#E5E7EF] bg-white px-3 py-2 text-sm text-[#050505]"
            >
              <option value="all">All approval states</option>
              <option value="pending">Awaiting broker approval</option>
              <option value="approved">Approved by broker</option>
            </select>
          </div>
        </div>

        {error && (
          <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}
        {!activeCompanyId && assignedCompanies.length > 1 && (
          <div className="mt-4 rounded-2xl border border-[#FDE68A] bg-[#FFFBEB] px-4 py-3 text-sm text-[#A16207]">
            Select a specific company from the filter to enable request creation.
          </div>
        )}

        <div className="mt-5 overflow-x-auto">
          <table className="w-full min-w-[900px]">
            <thead>
              <tr className="border-b border-[#EEF0F5] text-left">
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-[#6D6E71]">Request</th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-[#6D6E71]">Company</th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-[#6D6E71]">Workflow</th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-[#6D6E71]">Broker Approval</th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-[#6D6E71]">Client Access</th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-[#6D6E71]">Due Date</th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-[#6D6E71]">Action</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-sm text-[#A5A5A5]">
                    Loading requests...
                  </td>
                </tr>
              ) : filteredRequests.length ? (
                filteredRequests.map((request) => {
                  const workflowMeta = WORKFLOW_META[request.workflowStatus] || WORKFLOW_META.pending;
                  const approvalMeta = APPROVAL_META[request.approvalStatus] || APPROVAL_META.approved;

                  return (
                    <tr key={request.id} className="border-b border-[#F4F6FA] align-top">
                      <td className="px-4 py-4">
                        <p className="font-semibold text-[#050505]">{request.title}</p>
                        <p className="mt-1 text-xs text-[#6D6E71]">{request.category} · {request.responseType}</p>
                        <p className="mt-2 max-w-md text-xs text-[#A5A5A5]">{request.description}</p>
                      </td>
                      <td className="px-4 py-4 text-sm font-medium text-[#05164D]">{request.companyName}</td>
                      <td className="px-4 py-4">
                        <StatusPill {...workflowMeta} />
                      </td>
                      <td className="px-4 py-4">
                        <StatusPill {...approvalMeta} />
                      </td>
                      <td className="px-4 py-4">
                        {request.approvalStatus === 'approved' && request.visible ? (
                          <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-[#476E2C]">
                            <CheckCircle2 size={14} />
                            Visible to client
                          </span>
                        ) : request.approvalStatus === 'approved' ? (
                          <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-[#A86F0B]">
                            <Clock3 size={14} />
                            Approved but hidden
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-[#6D6E71]">
                            <XCircle size={14} />
                            Waiting for approval
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-4 text-sm text-[#6D6E71]">{request.dueDate}</td>
                      <td className="px-4 py-4">
                        {request.workflowStatus === 'pending' ? (
                          <button
                            type="button"
                            onClick={() => openEditRequest(request)}
                            className="inline-flex items-center gap-1.5 rounded-xl border border-[#D8E2F0] bg-white px-3 py-2 text-xs font-semibold text-[#05164D] transition-colors hover:bg-[#F8F9FC]"
                          >
                            <Pencil size={13} />
                            Edit
                          </button>
                        ) : (
                          <span className="text-xs text-[#A5A5A5]">Locked</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-sm text-[#A5A5A5]">
                    No requests match the selected filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <NewRequestModal
        isOpen={isNewRequestOpen}
        onClose={() => setIsNewRequestOpen(false)}
        onCreate={createRequest}
        folderOptions={folderOptions}
        foldersLoading={foldersLoading}
      />

      {editingRequest && (
        <div
          className="fixed inset-0 z-[9999] flex items-start justify-center bg-white/30 p-4 pt-12 backdrop-blur-sm"
          onMouseDown={(event) => { if (event.target === event.currentTarget) setEditingRequest(null); }}
        >
          <div className="w-full max-w-[560px] rounded-3xl bg-white shadow-2xl">
            <div className="border-b border-gray-100 p-5">
              <p className="text-xs uppercase tracking-wide text-[#A5A5A5]">Edit Pending Request</p>
              <h3 className="text-xl font-bold text-[#050505]">{editingRequest.title}</h3>
            </div>
            <form onSubmit={saveEditedRequest} className="grid gap-4 p-6">
              <div className="space-y-1.5">
                <label className="text-xs font-semibold uppercase tracking-wide text-[#6D6E71]">Title</label>
                <input
                  value={editForm.title}
                  onChange={(event) => setEditForm((current) => ({ ...current, title: event.target.value }))}
                  className="w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-semibold uppercase tracking-wide text-[#6D6E71]">Description</label>
                <textarea
                  rows={4}
                  value={editForm.description}
                  onChange={(event) => setEditForm((current) => ({ ...current, description: event.target.value }))}
                  className="w-full resize-none rounded-xl border border-gray-200 px-3 py-2.5 text-sm"
                />
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold uppercase tracking-wide text-[#6D6E71]">Priority</label>
                  <select
                    value={editForm.priority}
                    onChange={(event) => setEditForm((current) => ({ ...current, priority: event.target.value }))}
                    className="w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm"
                  >
                    <option value="critical">Critical</option>
                    <option value="high">High</option>
                    <option value="medium">Medium</option>
                    <option value="low">Low</option>
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold uppercase tracking-wide text-[#6D6E71]">Due Date</label>
                  <input
                    type="date"
                    value={editForm.dueDate}
                    onChange={(event) => setEditForm((current) => ({ ...current, dueDate: event.target.value }))}
                    className="w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setEditingRequest(null)}
                  className="rounded-xl border border-[#E5E7EF] bg-white px-4 py-2.5 text-sm font-semibold text-[#6D6E71]"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingEdit}
                  className="rounded-xl bg-[#8BC53D] px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#476E2C] disabled:cursor-not-allowed disabled:bg-gray-200 disabled:text-[#A5A5A5]"
                >
                  {savingEdit ? 'Saving...' : 'Save Changes'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
