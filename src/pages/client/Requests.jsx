import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  CheckCircle2,
  Clock,
  FileText,
  LayoutGrid,
  List,
  Loader2,
  Scale,
  Search,
  Send,
  ShieldCheck,
  TrendingUp,
  Upload,
  AlertTriangle,
  X,
  XCircle,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import {
  attachRequestDocument,
  createCompanyRequestItem,
  createCompanyFolder,
  createFolderDocument,
  listCompanyFolders,
  listCompanyRequests,
  listRequestDocuments,
  uploadFile,
  updateRequest,
  updateRequestNarrative,
} from '../../lib/api';
import NewRequestModal from '../../components/NewRequestModal';

const CATEGORY_META = {
  Finance: { icon: TrendingUp, color: '#00648F', bg: '#A7DCF7' },
  Legal: { icon: Scale, color: '#742982', bg: '#EBD5F0' },
  Compliance: { icon: ShieldCheck, color: '#8BC53D', bg: '#E6F3D3' },
  HR: { icon: ShieldCheck, color: '#F68C1F', bg: '#FDE7D2' },
  Tax: { icon: TrendingUp, color: '#476E2C', bg: '#E6F3D3' },
  'M&A': { icon: Scale, color: '#05164D', bg: '#E8ECF7' },
  Other: { icon: ShieldCheck, color: '#6D6E71', bg: '#F3F4F6' },
};

const STATUS_META = {
  pending: { label: 'Pending', bg: '#F3F4F6', color: '#6D6E71', icon: Clock },
  'in-review': { label: 'In Review', bg: '#DBEAFE', color: '#2563EB', icon: Loader2 },
  completed: { label: 'Completed', bg: '#DCFCE7', color: '#166534', icon: CheckCircle2 },
  overdue: { label: 'Overdue', bg: '#FEE2E2', color: '#B91C1C', icon: XCircle },
  blocked: { label: 'Blocked', bg: '#FEE2E2', color: '#991B1B', icon: AlertTriangle },
};

const PRIORITY_META = {
  critical: { label: 'Critical', bg: '#DC2626', color: '#FFFFFF' },
  high: { label: 'High', bg: '#F68C1F', color: '#FFFFFF' },
  medium: { label: 'Medium', bg: '#FACC15', color: '#111827' },
  low: { label: 'Low', bg: '#8BC53D', color: '#FFFFFF' },
};

const CATEGORY_ORDER = ['Finance', 'Legal', 'Compliance', 'HR', 'Tax', 'M&A', 'Other'];

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

function normalizeWorkflowStatus(status) {
  if (['awaiting-review', 'in-progress', 'submitted', 'in-review'].includes(status)) return 'in-review';
  if (status === 'completed') return 'completed';
  if (status === 'blocked') return 'blocked';
  return 'pending';
}

function getDisplayStatus(workflowStatus, dueDate) {
  if (workflowStatus === 'blocked') return 'blocked';
  const date = new Date(dueDate);
  const isOverdue = date < new Date() && workflowStatus !== 'completed';
  if (isOverdue) return 'overdue';
  return workflowStatus;
}

function normalizePriority(priority) {
  if (priority === 'critical' || priority === 'high' || priority === 'medium' || priority === 'low') return priority;
  return 'medium';
}

function normalizeType(item) {
  const type = (item.responseType || '').toLowerCase();
  const hasFolderBinding = Boolean((item.subLabel || '').trim());
  if (type === 'upload') {
    return hasFolderBinding ? 'Both' : item.responseType;
  }
  if (type === 'both') return item.responseType;
  if (type === 'narrative') {
    return hasFolderBinding ? 'Both' : item.responseType;
  }
  return item.documents?.length ? 'Both' : (hasFolderBinding ? 'Both' : 'Narrative');
}

function formatToday() {
  return new Date().toISOString().slice(0, 10);
}

function StatusBadge({ status }) {
  const meta = STATUS_META[status] || STATUS_META.pending;
  const Icon = meta.icon;
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold" style={{ background: meta.bg, color: meta.color }}>
      <Icon size={11} />
      {meta.label}
    </span>
  );
}

function mapApiRequestToUi(request) {
  if (!request) return null;
  const category = request.category || mapToCategory({
    name: request.title || '',
    subLabel: request.sub_label || '',
    description: request.description || '',
  });
  return {
    id: request.id,
    name: request.title || 'Untitled Request',
    subLabel: request.sub_label || '',
    description: request.description || 'No description provided.',
    category,
    responseType: normalizeType({
      responseType: request.response_type || '',
      subLabel: request.sub_label || '',
    }),
    priority: normalizePriority(request.priority),
    workflowStatus: normalizeWorkflowStatus(request.status),
    dueDate: request.due_date ? request.due_date.slice(0, 10) : formatToday(),
    createdAt: request.created_at ? request.created_at.slice(0, 10) : formatToday(),
    updatedAt: request.updated_at ? request.updated_at.slice(0, 10) : (request.created_at ? request.created_at.slice(0, 10) : formatToday()),
    assignedTo: request.assigned_to || 'Unassigned',
    visible: request.visible !== false,
    narrativeResponse: '',
    linkedDocuments: [],
    reminderHistory: [],
    notificationFrequency: request.priority === 'high' ? 'daily' : request.priority === 'medium' ? 'every 2 days' : 'weekly',
  };
}

function mapUiPatchToApi(patch) {
  const apiPatch = {};
  if (patch.name !== undefined) apiPatch.title = patch.name;
  if (patch.description !== undefined) apiPatch.description = patch.description;
  if (patch.priority !== undefined) apiPatch.priority = patch.priority;
  if (patch.workflowStatus !== undefined) apiPatch.status = patch.workflowStatus;
  if (patch.dueDate !== undefined) apiPatch.due_date = patch.dueDate;
  if (patch.assignedTo !== undefined && patch.assignedTo !== 'Unassigned') apiPatch.assigned_to = patch.assignedTo;
  if (patch.visible !== undefined) apiPatch.visible = patch.visible;
  return apiPatch;
}

function buildCreateRequestPayload(form) {
  const folderLabel = form.requestType === 'Information' ? '' : (form.category || '').trim();
  const resolvedCategory = mapToCategory({
    name: form.name?.trim() || '',
    subLabel: folderLabel,
    description: form.description?.trim() || '',
    category: folderLabel,
  });
  const responseType = form.requestType === 'Information' ? 'Narrative' : 'Both';

  return {
    title: form.name.trim(),
    sub_label: folderLabel,
    description: form.description?.trim() || '',
    category: resolvedCategory,
    response_type: responseType,
    priority: normalizePriority(form.priority),
    status: form.status,
    due_date: form.dueDate || null,
    assigned_to: null,
    visible: true,
  };
}

function CategoryCard({ category, requestsInCategory, onClick }) {
  const meta = CATEGORY_META[category];
  const Icon = meta.icon;
  const total = requestsInCategory.length;
  const completed = requestsInCategory.filter(r => r.workflowStatus === 'completed').length;
  const pending = total - completed;
  const pct = total ? Math.round((completed / total) * 100) : 0;

  return (
    <button
      onClick={onClick}
      className="text-left bg-white rounded-2xl shadow-card hover:shadow-hover p-5 transition-all duration-200 hover:-translate-y-0.5 border border-transparent hover:border-[#8BC53D]/30"
    >
      <div className="flex items-center justify-between mb-4">
        <div className="w-11 h-11 rounded-xl flex items-center justify-center" style={{ background: meta.bg }}>
          <Icon size={20} style={{ color: meta.color }} />
        </div>
        <span className="text-xs font-semibold text-[#6D6E71]">{total} Requests</span>
      </div>
      <h3 className="text-lg font-bold text-[#050505]">{category}</h3>
      <p className="text-sm text-[#6D6E71] mt-1">{completed} Completed · {pending} Pending</p>
      <div className="mt-4 h-2 bg-gray-100 rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: meta.color }} />
      </div>
      <p className="mt-1 text-xs text-[#A5A5A5]">Progress: {pct}%</p>
    </button>
  );
}

function RequestRow({ item, onView }) {
  const priority = PRIORITY_META[item.priority];
  return (
    <tr className="border-b border-gray-50 hover:bg-gray-50/70 transition-colors">
      <td className="px-4 py-3 text-xs font-bold text-[#6D6E71] font-mono">{item.id}</td>
      <td className="px-4 py-3">
        <p className="font-semibold text-[#050505] leading-tight">{item.name}</p>
        {item.subLabel && <p className="text-xs text-[#A5A5A5] mt-0.5">{item.subLabel}</p>}
      </td>
      <td className="px-4 py-3">
        <span className="text-xs px-2.5 py-1 rounded-full bg-gray-100 text-[#6D6E71] font-semibold">{item.responseType}</span>
      </td>
      <td className="px-4 py-3">
        <span className="text-xs font-bold px-2.5 py-1 rounded-full" style={{ background: priority.bg, color: priority.color }}>
          {priority.label}
        </span>
      </td>
      <td className="px-4 py-3 text-center text-sm font-semibold text-[#050505]">{item.linkedDocuments.length}</td>
      <td className="px-4 py-3"><StatusBadge status={item.status} /></td>
      <td className="px-4 py-3 text-center">
        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${item.visible ? 'bg-[#E6F3D3] text-[#476E2C]' : 'bg-gray-100 text-[#A5A5A5]'}`}>
          {item.visible ? 'Yes' : 'No'}
        </span>
      </td>
      <td className="px-4 py-3 text-center">
        <button
          onClick={() => onView(item)}
          className="px-3 py-1.5 rounded-lg bg-[#05164D] text-white text-xs font-semibold hover:bg-[#0b2a79] transition-colors"
        >
          View
        </button>
      </td>
    </tr>
  );
}

function RequestTable({ rows, onView }) {
  return (
    <div className="bg-white rounded-2xl shadow-card overflow-x-auto">
      <table className="w-full min-w-[980px]">
        <thead>
          <tr className="bg-gray-50 border-b border-gray-100">
            <th className="px-4 py-3 text-left text-xs font-semibold text-[#6D6E71] uppercase tracking-wide">Request ID</th>
            <th className="px-4 py-3 text-left text-xs font-semibold text-[#6D6E71] uppercase tracking-wide">Request Name</th>
            <th className="px-4 py-3 text-left text-xs font-semibold text-[#6D6E71] uppercase tracking-wide">Type</th>
            <th className="px-4 py-3 text-left text-xs font-semibold text-[#6D6E71] uppercase tracking-wide">Priority</th>
            <th className="px-4 py-3 text-center text-xs font-semibold text-[#6D6E71] uppercase tracking-wide">Documents Count</th>
            <th className="px-4 py-3 text-left text-xs font-semibold text-[#6D6E71] uppercase tracking-wide">Status</th>
            <th className="px-4 py-3 text-center text-xs font-semibold text-[#6D6E71] uppercase tracking-wide">Client Visibility</th>
            <th className="px-4 py-3 text-center text-xs font-semibold text-[#6D6E71] uppercase tracking-wide">Action</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => <RequestRow key={r.id} item={r} onView={onView} />)}
        </tbody>
      </table>
    </div>
  );
}

function CategoryGroupedTable({ grouped, onView }) {
  return (
    <div className="bg-white rounded-2xl shadow-card overflow-x-auto">
      <table className="w-full min-w-[980px]">
        <thead>
          <tr className="bg-gray-50 border-b border-gray-100">
            {['Request ID', 'Request Name', 'Type', 'Priority', 'Documents', 'Status', 'Visibility', 'Action'].map(h => (
              <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-[#6D6E71] uppercase tracking-wide">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grouped.map(g => {
            const meta = CATEGORY_META[g.category];
            const Icon = meta.icon;
            const rows = g.items.map(r => ({ ...r, status: getDisplayStatus(r.workflowStatus, r.dueDate) }));
            const completed = rows.filter(r => r.status === 'completed').length;
            const pct = rows.length ? Math.round((completed / rows.length) * 100) : 0;
            return (
              <Fragment key={g.category}>
                <tr>
                  <td colSpan={8} className="px-4 py-2.5 border-y border-gray-100" style={{ background: meta.bg + '60' }}>
                    <div className="flex items-center gap-2.5">
                      <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: meta.bg }}>
                        <Icon size={14} style={{ color: meta.color }} />
                      </div>
                      <span className="font-bold text-sm" style={{ color: meta.color }}>{g.category}</span>
                      <span className="text-xs text-[#6D6E71]">· {rows.length} requests · {completed} completed</span>
                      <div className="ml-auto flex items-center gap-2">
                        <span className="text-xs font-semibold" style={{ color: meta.color }}>{pct}%</span>
                        <div className="w-24 h-1.5 rounded-full overflow-hidden" style={{ background: meta.bg }}>
                          <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: meta.color }} />
                        </div>
                      </div>
                    </div>
                  </td>
                </tr>
                {rows.length === 0 ? (
                  <tr><td colSpan={8} className="px-4 py-4 text-center text-xs text-[#A5A5A5]">No requests in this category</td></tr>
                ) : rows.map(r => <RequestRow key={r.id} item={r} onView={onView} />)}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function FileUpload({ onAddFiles, duplicateNames }) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);

  const processFiles = (files) => {
    if (!files.length) return;
    onAddFiles(files);
  };

  return (
    <div className="bg-white rounded-2xl shadow-card p-5">
      <h3 className="font-semibold text-[#050505] mb-3">File Upload</h3>
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          processFiles(Array.from(e.dataTransfer.files));
        }}
        onClick={() => inputRef.current?.click()}
        className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-all ${dragging ? 'border-[#8BC53D] bg-[#E6F3D3]/40' : 'border-gray-200 hover:border-[#00B0F0]/40 hover:bg-gray-50'}`}
      >
        <Upload size={22} className="mx-auto mb-2 text-[#A5A5A5]" />
        <p className="text-sm text-[#6D6E71]">Drag files here or click to upload</p>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); inputRef.current?.click(); }}
          className="mt-3 px-4 py-1.5 rounded-lg border border-gray-200 text-xs font-semibold text-[#6D6E71] hover:bg-gray-50"
        >
          Choose Files
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => processFiles(Array.from(e.target.files || []))}
        />
      </div>
      <p className="text-[11px] text-[#A5A5A5] mt-2">
        Files can be attached to multiple requests. Warn on duplicates.
      </p>
      {duplicateNames.length > 0 && (
        <div className="mt-2 px-3 py-2 rounded-lg bg-[#FFF7ED] border border-[#FDBA74]">
          <p className="text-xs text-[#C2410C] font-medium">Duplicate warning: {duplicateNames.join(', ')}</p>
        </div>
      )}
    </div>
  );
}

function RequestDetailPage({ onBack, request, allRequests, onUpdateRequest, onUploadFiles, error, success }) {
  const [duplicateWarning, setDuplicateWarning] = useState([]);
  const [narrativeDraft, setNarrativeDraft] = useState(request?.narrativeResponse || '');

  useEffect(() => {
    setNarrativeDraft(request?.narrativeResponse || '');
  }, [request?.id, request?.narrativeResponse]);

  if (!request) return null;

  const priority = PRIORITY_META[request.priority];
  const due = new Date(request.dueDate);
  const isOverdue = due < new Date() && request.workflowStatus !== 'completed' && request.workflowStatus !== 'blocked';
  const currentStatus = getDisplayStatus(request.workflowStatus, request.dueDate);
  const categoryIcon = CATEGORY_META[request.category].icon;
  const CategoryIcon = categoryIcon;
  const isReadOnly = request.workflowStatus === 'in-review';

  const allLinkedNames = allRequests.flatMap(r => r.linkedDocuments.map(d => d.name.toLowerCase()));

  const addFiles = async (files) => {
    if (isReadOnly) return;
    const duplicates = files
      .map(f => f.name)
      .filter(name => allLinkedNames.includes(name.toLowerCase()));

    setDuplicateWarning(duplicates);
    if (!onUploadFiles) return;
    const optimisticDocs = files.map((f, idx) => ({
      id: `temp-${request.id}-${Date.now()}-${idx}`,
      name: f.name,
      uploadedBy: 'Client User',
      uploadedAt: formatToday(),
      visible: true,
    }));
    onUpdateRequest(request.id, {
      linkedDocuments: [...request.linkedDocuments, ...optimisticDocs],
      updatedAt: formatToday(),
    });
    const ok = await onUploadFiles(request, files);
    if (ok) onBack();
  };

  return (
    <div className="space-y-6">
      <div className="bg-[#F8FAFC] rounded-2xl p-5 lg:p-7">
          {error && (
            <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div>
          )}
          {success && (
            <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-700">{success}</div>
          )}
          <div className="flex items-center justify-between mb-4">
            <button onClick={onBack} className="flex items-center gap-2 text-sm text-[#6D6E71] hover:text-[#050505] transition-colors">
              <ArrowLeft size={14} /> Back
            </button>
            <button onClick={onBack} className="text-[#A5A5A5] hover:text-[#050505] p-1"><X size={18} /></button>
          </div>

          <div className="flex items-center gap-3 mb-2">
            <span className="px-2.5 py-1 rounded-md bg-gray-100 text-xs font-bold text-[#6D6E71] font-mono">{request.id}</span>
            <StatusBadge status={currentStatus} />
          </div>
          <h2 className="text-3xl font-bold text-[#050505] leading-tight">{request.name}</h2>
          <p className="text-sm text-[#6D6E71] mt-1 mb-5">{request.subLabel}</p>

          <div className="grid lg:grid-cols-3 gap-5">
            <div className="lg:col-span-2 space-y-5">
              <div className="bg-white rounded-2xl shadow-card p-5">
                <h3 className="font-semibold text-[#050505] mb-4">Request Details</h3>
                <div className="grid grid-cols-2 gap-4 mb-4">
                  <div>
                    <p className="text-[10px] uppercase tracking-wide text-[#A5A5A5] mb-1">Category</p>
                    <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-[#050505]">
                      <CategoryIcon size={14} style={{ color: CATEGORY_META[request.category].color }} />
                      {request.category}
                    </span>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-wide text-[#A5A5A5] mb-1">Priority</p>
                    <span className="text-xs font-bold px-2.5 py-1 rounded-full" style={{ background: priority.bg, color: priority.color }}>
                      {priority.label}
                    </span>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-wide text-[#A5A5A5] mb-1">Response Type</p>
                    <span className="text-xs font-semibold bg-gray-100 text-[#6D6E71] px-2.5 py-1 rounded-full">{request.responseType}</span>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-wide text-[#A5A5A5] mb-1">Due Date</p>
                    <span className={`text-sm font-semibold ${isOverdue ? 'text-[#B91C1C]' : 'text-[#050505]'}`}>{request.dueDate}</span>
                  </div>
                </div>
                <p className="text-[10px] uppercase tracking-wide text-[#A5A5A5] mb-1">Description</p>
                <p className="text-sm text-[#6D6E71] leading-relaxed border border-gray-100 bg-gray-50 rounded-xl p-3">{request.description}</p>
              </div>

              <div className="bg-[#EFF6FF] rounded-2xl border border-[#BFDBFE] shadow-card p-5">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-semibold text-[#050505] mb-1">Current Status</h3>
                    <StatusBadge status={currentStatus} />
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-[#6D6E71]">Status updates automatically</p>
                    <p className="text-xs text-[#6D6E71]">after you upload documents.</p>
                  </div>
                </div>
              </div>

              {isReadOnly && (
                <div className="bg-white rounded-2xl shadow-card p-4 border border-gray-100">
                  <p className="text-sm text-[#6D6E71]">
                    This request is currently in review. Responses are locked and view-only.
                  </p>
                </div>
              )}

              {!isReadOnly && (request.responseType === 'Upload' || request.responseType === 'Both') && (
                <FileUpload onAddFiles={addFiles} duplicateNames={duplicateWarning} />
              )}

              <div className="bg-white rounded-2xl shadow-card p-5">
                <h3 className="font-semibold text-[#050505] mb-3">Linked Documents ({request.linkedDocuments.length})</h3>
                <div className="space-y-2">
                  {request.linkedDocuments.map(doc => (
                    <div key={doc.id} className="flex items-center gap-3 p-3 rounded-xl bg-gray-50 hover:bg-gray-100 transition-colors">
                      <FileText size={15} className="text-[#00B0F0]" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-[#050505] truncate">{doc.name}</p>
                        <p className="text-xs text-[#A5A5A5]">{doc.uploadedBy} · {doc.uploadedAt}</p>
                      </div>
                      <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-[#E6F3D3] text-[#476E2C]">Client Visible</span>
                    </div>
                  ))}
                </div>
              </div>

              {(request.responseType === 'Narrative' || request.responseType === 'Both') && (
                <div className="bg-white rounded-2xl shadow-card p-5">
                  <h3 className="font-semibold text-[#050505] mb-3">Narrative Response</h3>
                  <textarea
                    rows={5}
                    value={narrativeDraft}
                    onChange={(e) => setNarrativeDraft(e.target.value)}
                    placeholder="Enter explanation, comments, or notes related to this request"
                    disabled={isReadOnly}
                    className={`w-full px-4 py-3 rounded-xl border text-sm resize-none ${isReadOnly ? 'bg-gray-50 text-[#6D6E71] border-gray-100' : 'border-gray-200 focus:outline-none focus:ring-2 focus:ring-[#8BC53D]/40 focus:border-[#8BC53D]'}`}
                  />
                  {!isReadOnly && (
                    <div className="mt-3 flex justify-end">
                      <button
                        onClick={async () => {
                          const ok = await onUpdateRequest(request.id, {
                            narrativeResponse: narrativeDraft,
                            workflowStatus: 'in-review',
                            updatedAt: formatToday(),
                          });
                          if (ok) onBack();
                        }}
                        className="px-3 py-1.5 rounded-lg bg-[#05164D] text-white text-xs font-semibold hover:bg-[#0b2a79] transition-colors"
                      >
                        Save
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="space-y-4 lg:sticky lg:top-5 h-fit">
              <div className="bg-white rounded-2xl shadow-card p-5">
                <h3 className="font-semibold text-[#050505] mb-3">Quick Info</h3>
                <div className="space-y-3 text-xs">
                  <div>
                    <p className="text-[#A5A5A5]">Assigned To</p>
                    <p className="font-semibold text-[#050505]">{request.assignedTo}</p>
                  </div>
                  <div>
                    <p className="text-[#A5A5A5]">Created Date</p>
                    <p className="font-semibold text-[#050505]">{request.createdAt}</p>
                  </div>
                  <div>
                    <p className="text-[#A5A5A5]">Last Updated</p>
                    <p className="font-semibold text-[#050505]">{request.updatedAt}</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
      </div>
    </div>
  );
}

export default function ClientRequests() {
  const { user } = useAuth();
  const companyId = user?.company_id || user?.companyId || null;
  const [requestState, setRequestState] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [folderMap, setFolderMap] = useState({});
  const [folderOptions, setFolderOptions] = useState([]);
  const [foldersLoading, setFoldersLoading] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState(null);
  const [categoryView, setCategoryView] = useState('table');
  const [statusFilter, setStatusFilter] = useState('all');
  const [priorityFilter, setPriorityFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [activeRequestId, setActiveRequestId] = useState(null);
  const [isNewRequestOpen, setIsNewRequestOpen] = useState(false);

  const loadRequests = async () => {
    if (!companyId) return;
    setLoading(true);
    setError('');
    try {
      const list = await listCompanyRequests(companyId);
      setRequestState(list.map(mapApiRequestToUi).filter(Boolean));
    } catch (err) {
      setError(err.message || 'Unable to load requests.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!companyId) return;
    loadRequests();
    setFoldersLoading(true);
    listCompanyFolders(companyId)
      .then((folders) => {
        const map = {};
        const options = [];
        folders.forEach((f) => {
          if (f?.name) {
            map[f.name.toLowerCase()] = f.id;
            options.push({ id: f.id, name: f.name });
          }
        });
        setFolderMap(map);
        setFolderOptions(options);
      })
      .catch(() => {
        setFolderMap({});
        setFolderOptions([]);
      })
      .finally(() => setFoldersLoading(false));
  }, [companyId]);

  useEffect(() => {
    if (!success) return undefined;
    const timer = setTimeout(() => setSuccess(''), 3000);
    return () => clearTimeout(timer);
  }, [success]);

  useEffect(() => {
    if (!activeRequestId) return;
    listRequestDocuments(activeRequestId)
      .then((docs) => {
        setRequestState((prev) => prev.map((r) => {
          if (r.id !== activeRequestId) return r;
          const mapped = docs.map((doc) => ({
            id: doc.id || doc.document_id,
            name: doc.name || doc.document_id || doc.id,
            uploadedBy: 'Client',
            uploadedAt: doc.created_at ? doc.created_at.slice(0, 10) : formatToday(),
            visible: doc.visible !== false,
          }));
          return { ...r, linkedDocuments: mapped };
        }));
      })
      .catch(() => {});
  }, [activeRequestId]);

  const updateRequestState = async (id, patch) => {
    setRequestState(prev => prev.map(r => (r.id === id ? { ...r, ...patch } : r)));
    try {
      if (patch.narrativeResponse !== undefined) {
        await updateRequestNarrative(id, { content: patch.narrativeResponse, updated_by: user?.id || null });
      }
      const apiPatch = mapUiPatchToApi(patch);
      if (Object.keys(apiPatch).length > 0) {
        await updateRequest(id, apiPatch);
      }
      return true;
    } catch (err) {
      setError(err.message || 'Unable to update request.');
      return false;
    }
  };

  const uploadFilesForRequest = async (request, files) => {
    if (!companyId || !files.length) return false;
    let folderId = folderMap[request.subLabel?.toLowerCase()] || folderMap[request.category?.toLowerCase()];
    if (!folderId) {
      try {
        const folderName = request.subLabel || request.category || 'Uploads';
        const created = await createCompanyFolder(companyId, {
          name: folderName,
          created_by: user?.id || null,
        });
        folderId = created?.id;
        if (folderId) {
          setFolderMap((prev) => ({ ...prev, [folderName.toLowerCase()]: folderId }));
        }
      } catch (err) {
        setError(err.message || 'Unable to create folder for upload.');
        return false;
      }
    }
    if (!folderId) {
      setError('No matching folder found for this request category.');
      return false;
    }
    try {
      const createdDocs = [];
      for (const file of files) {
        const uploaded = await uploadFile(file, {
          fileName: file.name,
          prefix: 'requests',
        });
        const ext = file.name.split('.').pop()?.toLowerCase() || '';
        const createdDoc = await createFolderDocument(folderId, {
          company_id: companyId,
          name: file.name,
          file_url: uploaded.fileUrl,
          upload_id: uploaded.id,
          size: file.size?.toString() || '0',
          ext,
          status: 'under-review',
          uploaded_by: user?.id || null,
        });
        await attachRequestDocument(request.id, { document_id: createdDoc.id, visible: true });
        createdDocs.push({
          id: createdDoc.id,
          name: createdDoc.name,
          uploadedBy: user?.name || user?.email || 'Client',
          uploadedAt: createdDoc.uploaded_at ? createdDoc.uploaded_at.slice(0, 10) : formatToday(),
          visible: true,
        });
      }
      if (createdDocs.length) {
        setRequestState(prev => prev.map(r => (r.id === request.id
          ? (() => {
            const existingNames = new Set(r.linkedDocuments.map(d => d.name.toLowerCase()));
            const merged = [
              ...r.linkedDocuments,
              ...createdDocs.filter(d => !existingNames.has(d.name.toLowerCase())),
            ];
            return { ...r, linkedDocuments: merged };
          })()
          : r)));
      }
      if (request.workflowStatus !== 'in-review') {
        await updateRequest(request.id, { status: 'in-review' });
        setRequestState(prev => prev.map(r => (r.id === request.id
          ? { ...r, workflowStatus: 'in-review', updatedAt: formatToday() }
          : r)));
      }
      setSuccess('Response uploaded successfully.');
      return true;
    } catch (err) {
      setError(err.message || 'Unable to upload response.');
      return false;
    }
  };

  const createRequest = async (form) => {
    if (!companyId) return;
    setError('');
    setSuccess('');
    try {
      const payload = {
        ...buildCreateRequestPayload(form),
        created_by: user?.id || null,
      };
      await createCompanyRequestItem(companyId, payload);
      await loadRequests();
      setIsNewRequestOpen(false);
      setSuccess('Request created successfully.');
    } catch (err) {
      setError(err.message || 'Unable to create request.');
    }
  };

  const visibleRequests = requestState.filter(r => r.visible);
  const grouped = useMemo(() => {
    const categories = Array.from(new Set(visibleRequests.map(r => r.category)))
      .sort((a, b) => {
        const ia = CATEGORY_ORDER.indexOf(a);
        const ib = CATEGORY_ORDER.indexOf(b);
        return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
      });
    return categories.map(cat => ({
      category: cat,
      items: visibleRequests.filter(r => r.category === cat),
    })).filter(g => g.items.length > 0);
  }, [visibleRequests]);

  const rowsForCategory = useMemo(() => {
    if (!selectedCategory) return [];
    return visibleRequests.filter(r => {
      if (r.category !== selectedCategory) return false;
      const s = search.toLowerCase();
      const matchesSearch = !s || r.name.toLowerCase().includes(s) || r.id.toLowerCase().includes(s);
      const displayStatus = getDisplayStatus(r.workflowStatus, r.dueDate);
      const matchesStatus = statusFilter === 'all' || displayStatus === statusFilter;
      const matchesPriority = priorityFilter === 'all' || r.priority === priorityFilter;
      return matchesSearch && matchesStatus && matchesPriority;
    }).map(r => ({ ...r, status: getDisplayStatus(r.workflowStatus, r.dueDate) }));
  }, [selectedCategory, visibleRequests, search, statusFilter, priorityFilter]);

  const activeRequest = requestState.find(r => r.id === activeRequestId) || null;

  if (activeRequest) {
    return (
      <RequestDetailPage
        onBack={() => setActiveRequestId(null)}
        request={activeRequest}
        allRequests={requestState}
        onUpdateRequest={updateRequestState}
        onUploadFiles={uploadFilesForRequest}
        error={error}
        success={success}
      />
    );
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div>
      )}
      {success && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-700">{success}</div>
      )}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[#050505]">Request Categories</h1>
          <p className="text-sm text-[#6D6E71] mt-0.5">Enterprise workflow grouped by Finance, Legal and Compliance.</p>
        </div>
        {!selectedCategory && (
          <div className="flex items-center gap-3">
            <div className="flex items-center bg-gray-100 rounded-xl p-0.5">
              <button
                onClick={() => setCategoryView('cards')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${categoryView === 'cards' ? 'bg-white text-[#050505] shadow-sm' : 'text-[#6D6E71] hover:text-[#050505]'}`}
              >
                <LayoutGrid size={13} /> Cards
              </button>
              <button
                onClick={() => setCategoryView('table')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${categoryView === 'table' ? 'bg-white text-[#050505] shadow-sm' : 'text-[#6D6E71] hover:text-[#050505]'}`}
              >
                <List size={13} /> Table
              </button>
            </div>
            <button
              type="button"
              onClick={() => setIsNewRequestOpen(true)}
              className="flex items-center gap-2 px-4 py-2.5 bg-[#8BC53D] hover:bg-[#476E2C] text-white rounded-xl text-xs sm:text-sm font-semibold transition-all duration-200 hover:scale-[1.02] shadow-md"
            >
              <Send size={15} />
              New Request
            </button>
          </div>
        )}
      </div>

      {loading ? (
        <div className="text-center text-sm text-[#A5A5A5] py-10">Loading requests...</div>
      ) : (!selectedCategory ? (
        categoryView === 'cards' ? (
          <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-5">
            {grouped.map(g => (
              <CategoryCard
                key={g.category}
                category={g.category}
                requestsInCategory={g.items}
                onClick={() => setSelectedCategory(g.category)}
              />
            ))}
          </div>
        ) : (
          <CategoryGroupedTable grouped={grouped} onView={(r) => setActiveRequestId(r.id)} />
        )
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <button
              onClick={() => setSelectedCategory(null)}
              className="flex items-center gap-2 text-sm text-[#6D6E71] hover:text-[#050505]"
            >
              <ArrowLeft size={14} /> Back to Categories
            </button>
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-2 bg-white border border-gray-200 rounded-xl px-3 py-2">
                <Search size={15} className="text-[#A5A5A5]" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search requests..."
                  className="text-sm outline-none bg-transparent"
                />
              </div>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="px-3 py-2 rounded-xl border border-gray-200 bg-white text-sm text-[#050505]"
              >
                <option value="all">All Status</option>
                <option value="pending">Pending</option>
                <option value="in-review">In Review</option>
                <option value="completed">Completed</option>
                <option value="overdue">Overdue</option>
                <option value="blocked">Blocked</option>
              </select>
              <select
                value={priorityFilter}
                onChange={(e) => setPriorityFilter(e.target.value)}
                className="px-3 py-2 rounded-xl border border-gray-200 bg-white text-sm text-[#050505]"
              >
                <option value="all">All Priorities</option>
                <option value="critical">Critical</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
              <button
                onClick={() => {
                  setSearch('');
                  setStatusFilter('all');
                  setPriorityFilter('all');
                }}
                className="px-3 py-2 rounded-xl border border-gray-200 bg-white text-sm text-[#6D6E71] hover:bg-gray-50"
              >
                Clear Filters
              </button>
            </div>
          </div>

          <CategoryTable rows={rowsForCategory} onView={(r) => setActiveRequestId(r.id)} />
        </div>
      ))}

      <NewRequestModal
        isOpen={isNewRequestOpen}
        onClose={() => setIsNewRequestOpen(false)}
        onCreate={createRequest}
        folderOptions={folderOptions}
        foldersLoading={foldersLoading}
      />
    </div>
  );
}
