import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { useParams } from 'react-router-dom';
import { useAuth } from '../../../context/AuthContext';
import {
  ArrowLeft,
  Bell,
  CheckCircle2,
  Clock,
  Download,
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
import {
  attachRequestDocument,
  createCompanyBulkRequestItems,
  createCompanyRequestItem,
  createRequestReminder,
  getCompanyRequest,
  listCompanyFolders,
  listCompanyRequests,
  listRequestDocuments,
  updateRequest,
  updateRequestNarrative,
} from '../../../lib/api';
import NewRequestModal from '../../../components/NewRequestModal';

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

const STATUS_FLOW = ['pending', 'in-review', 'completed'];
const CATEGORY_ORDER = ['Finance', 'Legal', 'Compliance', 'HR', 'Tax', 'M&A', 'Other'];
const RESPONSE_TYPE_OPTIONS = ['Upload', 'Narrative', 'Both'];
const PRIORITY_OPTIONS = ['critical', 'high', 'medium', 'low'];
const STATUS_OPTIONS = ['pending', 'in-review', 'completed', 'blocked'];
const BULK_TEMPLATE_HEADERS = ['title', 'sub_label', 'description', 'category', 'response_type', 'priority', 'status', 'due_date', 'assigned_to', 'visible'];

function normalizeVisibleFlag(value) {
  if (typeof value === 'boolean') return value;
  const normalized = `${value ?? ''}`.trim().toLowerCase();
  if (['false', 'no', 'n', '0'].includes(normalized)) return false;
  return true;
}

function isEmptyBulkRow(row) {
  return Object.values(row || {}).every((value) => `${value ?? ''}`.trim() === '');
}

function downloadFile(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function buildBulkTemplateWorkbook(folderOptions) {
  const folderNames = folderOptions.length
    ? folderOptions.map((folder) => (typeof folder === 'string' ? folder : folder.name)).filter(Boolean)
    : CATEGORY_ORDER;
  const sampleFolder = folderNames[0] || 'Compliance';
  const sampleCategory = mapToCategory({
    name: 'GST Certificate',
    subLabel: sampleFolder,
    description: 'Upload the latest signed GST certificate for review.',
    category: sampleFolder,
  });

  const templateSheet = XLSX.utils.json_to_sheet([
    {
      title: 'GST Certificate',
      sub_label: sampleFolder,
      description: 'Upload the latest signed GST certificate for review.',
      category: sampleCategory,
      response_type: 'Upload',
      priority: 'high',
      status: 'pending',
      due_date: formatToday(),
      assigned_to: '',
      visible: 'true',
    },
  ], { header: BULK_TEMPLATE_HEADERS });

  templateSheet['!cols'] = BULK_TEMPLATE_HEADERS.map((header) => ({
    wch: header === 'description' ? 42 : 18,
  }));

  const instructionsSheet = XLSX.utils.aoa_to_sheet([
    ['Field', 'Required', 'Guidance'],
    ['title', 'Yes', 'Request title shown to the client.'],
    ['sub_label', 'No', 'Optional short label; use the folder name here if the request maps to a specific folder.'],
    ['description', 'Yes', 'Short request description or instructions.'],
    ['category', 'Yes', `Use one of: ${CATEGORY_ORDER.join(', ')}`],
    ['response_type', 'Yes', `Use one of: ${RESPONSE_TYPE_OPTIONS.join(', ')}`],
    ['priority', 'Yes', `Use one of: ${PRIORITY_OPTIONS.join(', ')}`],
    ['status', 'Yes', `Use one of: ${STATUS_OPTIONS.join(', ')}`],
    ['due_date', 'Yes', 'Format must be YYYY-MM-DD.'],
    ['assigned_to', 'No', 'Optional user id for assignment. Leave blank if unassigned.'],
    ['visible', 'No', 'Use true or false. Blank defaults to true.'],
  ]);

  instructionsSheet['!cols'] = [
    { wch: 18 },
    { wch: 10 },
    { wch: 70 },
  ];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, templateSheet, 'Requests');
  XLSX.utils.book_append_sheet(workbook, instructionsSheet, 'Instructions');
  return workbook;
}

function readBulkWorkbook(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (event) => {
      try {
        const workbook = XLSX.read(event.target?.result, { type: 'array' });
        const sheetName = workbook.SheetNames[0];
        if (!sheetName) {
          reject(new Error('The uploaded workbook does not contain any sheets.'));
          return;
        }

        const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
          defval: '',
          raw: false,
        });
        resolve(rows);
      } catch (error) {
        reject(new Error('Unable to read the uploaded Excel file.'));
      }
    };

    reader.onerror = () => reject(new Error('Unable to read the selected file.'));
    reader.readAsArrayBuffer(file);
  });
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

function normalizeWorkflowStatus(status) {
  if (['awaiting-review', 'in-progress', 'submitted'].includes(status)) return 'in-review';
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
  return hasFolderBinding ? 'Both' : 'Narrative';
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
    description: form.description.trim(),
    category: resolvedCategory,
    response_type: responseType,
    priority: normalizePriority(form.priority),
    status: form.status,
    due_date: form.dueDate,
    assigned_to: null,
    visible: true,
  };
}
function VisibilityToggle({ value, onChange }) {
  return (
    <button
      onClick={onChange}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${value ? 'bg-[#8BC53D]' : 'bg-gray-300'}`}
      aria-label="Toggle visibility"
    >
      <span className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${value ? 'translate-x-5' : 'translate-x-1'}`} />
    </button>
  );
}

function CategoryCard({ category, requestsInCategory, onClick }) {
  const meta = CATEGORY_META[category];
  const Icon = meta.icon;
  const total = requestsInCategory.length;
  const completed = requestsInCategory.filter(r => r.status === 'completed').length;
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
      <p className="text-sm text-[#6D6E71] mt-1">{completed} Completed � {pending} Pending</p>
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
                      <span className="text-xs text-[#6D6E71]">� {rows.length} requests � {completed} completed</span>
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
      <p className="text-[11px] text-[#A5A5A5] mt-2">Files can be attached to multiple requests. Warn on duplicates.</p>
      {duplicateNames.length > 0 && (
        <div className="mt-2 px-3 py-2 rounded-lg bg-[#FFF7ED] border border-[#FDBA74]">
          <p className="text-xs text-[#C2410C] font-medium">Duplicate warning: {duplicateNames.join(', ')}</p>
        </div>
      )}
    </div>
  );
}

function RequestDetailPage({ onBack, request, allRequests, onUpdateRequest, onSendReminder, onAttachDocument }) {
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
  const statusIdx = STATUS_FLOW.indexOf(request.workflowStatus);
  const allowedNext = request.workflowStatus === 'blocked'
    ? ['blocked']
    : STATUS_FLOW.slice(Math.max(0, statusIdx), Math.min(statusIdx + 2, STATUS_FLOW.length));
  const CategoryIcon = CATEGORY_META[request.category].icon;

  const allLinkedNames = allRequests.flatMap(r => r.linkedDocuments.map(d => d.name.toLowerCase()));

  const addFiles = (files) => {
    const duplicates = files.map(f => f.name).filter(name => allLinkedNames.includes(name.toLowerCase()));
    setDuplicateWarning(duplicates);

    const newDocs = files.map((f, idx) => ({
      id: `${request.id}-local-${Date.now()}-${idx}`,
      name: f.name,
      uploadedBy: 'Broker User',
      uploadedAt: formatToday(),
      visible: true,
    }));

    onUpdateRequest(request.id, {
      linkedDocuments: [...request.linkedDocuments, ...newDocs],
      updatedAt: formatToday(),
    });
    if (onAttachDocument) {
      newDocs.forEach((doc) => {
        onAttachDocument(request.id, doc);
      });
    }
  };

  const sendReminder = () => {
    const entry = `Reminder sent on ${new Date().toLocaleString('en-IN')}`;
    onUpdateRequest(request.id, {
      reminderHistory: [entry, ...(request.reminderHistory || [])],
      updatedAt: formatToday(),
    });
    onSendReminder?.(request.id);
  };

  return (
    <div className="space-y-6">
      <div className="bg-[#F8FAFC] rounded-2xl p-5 lg:p-7">
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
                <select
                  value={request.workflowStatus}
                  onChange={(e) => onUpdateRequest(request.id, { workflowStatus: e.target.value, updatedAt: formatToday() })}
                  className="px-3 py-2 rounded-xl border border-[#93C5FD] bg-white text-sm font-semibold text-[#1D4ED8] focus:outline-none"
                >
                  {allowedNext.map(s => <option key={s} value={s}>{STATUS_META[s].label}</option>)}
                </select>
              </div>
            </div>

            {(request.responseType === 'Upload' || request.responseType === 'Both') && (
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
                      <p className="text-xs text-[#A5A5A5]">{doc.uploadedBy} � {doc.uploadedAt}</p>
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
                  onChange={(e) => onUpdateRequest(request.id, { narrativeResponse: e.target.value, updatedAt: formatToday() })}
                  placeholder="Enter explanation, comments, or notes related to this request"
                  className="w-full px-4 py-3 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-[#8BC53D]/40 focus:border-[#8BC53D] resize-none"
                />
              </div>
            )}
          </div>

          <div className="space-y-4 lg:sticky lg:top-5 h-fit">
            <div className="bg-white rounded-2xl shadow-card p-5">
              <h3 className="font-semibold text-[#050505] mb-3">? Quick Info</h3>
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

            <div className="bg-white rounded-2xl shadow-card p-5">
              <h3 className="font-semibold text-[#050505] mb-3">Client Visibility</h3>
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-[#6D6E71]">{request.visible ? 'Visible' : 'Hidden'}</span>
                <VisibilityToggle
                  value={request.visible}
                  onChange={() => onUpdateRequest(request.id, { visible: !request.visible, updatedAt: formatToday() })}
                />
              </div>
              <p className="mt-2 text-xs text-[#A5A5A5]">
                {request.visible ? 'Client can see this request.' : 'Hidden from client dashboard.'}
              </p>
            </div>

            <div className="bg-white rounded-2xl shadow-card p-5 space-y-2">
              <button
                onClick={sendReminder}
                className="w-full py-2.5 rounded-xl border border-gray-200 text-sm font-semibold text-[#6D6E71] hover:bg-gray-50 transition-colors"
              >
                Send Reminder
              </button>
              <button
                onClick={() => {
                  const content = JSON.stringify(request, null, 2);
                  const blob = new Blob([content], { type: 'application/json' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = `${request.id}.json`;
                  a.click();
                  URL.revokeObjectURL(url);
                }}
                className="w-full py-2.5 rounded-xl border border-gray-200 text-sm font-semibold text-[#6D6E71] hover:bg-gray-50 transition-colors flex items-center justify-center gap-2"
              >
                <Download size={14} /> Export Request
              </button>
              <button
                onClick={() => onUpdateRequest(request.id, { workflowStatus: 'blocked', updatedAt: formatToday() })}
                className="w-full py-2.5 rounded-xl bg-red-500 hover:bg-red-600 text-white text-sm font-semibold transition-colors"
              >
                Block Request
              </button>
              {!!request.reminderHistory?.length && (
                <div className="pt-2 border-t border-gray-100">
                  <p className="text-xs font-semibold text-[#6D6E71] mb-1.5 flex items-center gap-1"><Bell size={12} /> Reminder History</p>
                  <div className="space-y-1.5">
                    {request.reminderHistory.slice(0, 3).map((entry, idx) => (
                      <p key={idx} className="text-[11px] text-[#A5A5A5]">{entry}</p>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function WorkspaceRequests() {
  const { clientId } = useParams();
  const { user } = useAuth();
  const [company, setCompany] = useState(null);
  const [requestState, setRequestState] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [folderOptions, setFolderOptions] = useState([]);
  const [foldersLoading, setFoldersLoading] = useState(false);
  const [bulkFile, setBulkFile] = useState(null);
  const [bulkUploading, setBulkUploading] = useState(false);

  const loadRequests = async () => {
    if (!clientId) return;
    setLoading(true);
    setError('');
    try {
      const list = await listCompanyRequests(clientId);
      setRequestState(list.map(mapApiRequestToUi).filter(Boolean));
    } catch (err) {
      setError(err.message || 'Unable to load requests.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!clientId) return;
    loadRequests();
    setFoldersLoading(true);
    listCompanyFolders(clientId)
      .then((folders) => {
        const topLevel = folders.filter((f) => !f.parent_id);
        const options = (topLevel.length ? topLevel : folders)
          .map((f) => ({ id: f.id, name: f.name }))
          .filter((f) => f.name);
        setFolderOptions(options);
      })
      .catch(() => setFolderOptions([]))
      .finally(() => setFoldersLoading(false));
    getCompanyRequest(clientId)
      .then((data) => setCompany(data))
      .catch(() => setCompany(null));
  }, [clientId]);
  useEffect(() => {
    if (!success) return undefined;
    const timer = setTimeout(() => setSuccess(''), 3000);
    return () => clearTimeout(timer);
  }, [success]);

  const [selectedCategory, setSelectedCategory] = useState(null);
  const [categoryView, setCategoryView] = useState('table');
  const [statusFilter, setStatusFilter] = useState('all');
  const [priorityFilter, setPriorityFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [activeRequestId, setActiveRequestId] = useState(null);

  useEffect(() => {
    if (!activeRequestId) return;
    listRequestDocuments(activeRequestId)
      .then((docs) => {
        setRequestState((prev) => prev.map((r) => {
          if (r.id !== activeRequestId) return r;
          const mapped = docs.map((doc) => ({
            id: doc.id || doc.document_id,
            name: doc.document_id || doc.id,
            uploadedBy: 'Client',
            uploadedAt: doc.created_at ? doc.created_at.slice(0, 10) : formatToday(),
            visible: doc.visible !== false,
          }));
          return { ...r, linkedDocuments: mapped };
        }));
      })
      .catch(() => {});
  }, [activeRequestId]);
  
  const [isNewRequestOpen, setIsNewRequestOpen] = useState(false);

  useEffect(() => {
    if (isNewRequestOpen) return;
    setBulkFile(null);
  }, [isNewRequestOpen]);

  const grouped = useMemo(() => {
    const categories = Array.from(new Set(requestState.map(r => r.category)))
      .sort((a, b) => {
        const ia = CATEGORY_ORDER.indexOf(a);
        const ib = CATEGORY_ORDER.indexOf(b);
        return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
      });
    return categories.map(cat => ({
      category: cat,
      items: requestState.filter(r => r.category === cat),
    })).filter(g => g.items.length > 0);
  }, [requestState]);

  const rowsForCategory = useMemo(() => {
    if (!selectedCategory) return [];
    return requestState
      .filter(r => {
        if (r.category !== selectedCategory) return false;
        const s = search.toLowerCase();
        const matchesSearch = !s || r.name.toLowerCase().includes(s) || r.id.toLowerCase().includes(s);
        const displayStatus = getDisplayStatus(r.workflowStatus, r.dueDate);
        const matchesStatus = statusFilter === 'all' || displayStatus === statusFilter;
        const matchesPriority = priorityFilter === 'all' || r.priority === priorityFilter;
        return matchesSearch && matchesStatus && matchesPriority;
      })
      .map(r => ({ ...r, status: getDisplayStatus(r.workflowStatus, r.dueDate) }));
  }, [selectedCategory, requestState, search, statusFilter, priorityFilter]);

  const activeRequest = requestState.find(r => r.id === activeRequestId) || null;

  const updateRequestState = async (id, patch) => {
    setRequestState(prev => prev.map(r => (r.id === id ? { ...r, ...patch } : r)));
    try {
      if (patch.narrativeResponse !== undefined) {
        await updateRequestNarrative(id, {
          content: patch.narrativeResponse,
          updated_by: user?.id || null,
        });
      }
      const apiPatch = mapUiPatchToApi(patch);
      if (Object.keys(apiPatch).length > 0) {
        await updateRequest(id, apiPatch);
      }
    } catch (err) {
      setError(err.message || 'Unable to update request.');
    }
  };

  const createRequest = async (form) => {
    if (!clientId) return;
    setError('');
    setSuccess('');
    try {
      const payload = {
        ...buildCreateRequestPayload(form),
        created_by: user?.id || null,
      };
      await createCompanyRequestItem(clientId, payload);
      await loadRequests();
      setIsNewRequestOpen(false);
      setSuccess('Request created successfully.');
    } catch (err) {
      setError(err.message || 'Unable to create request.');
    }
  };

  const downloadBulkTemplate = () => {
    const workbook = buildBulkTemplateWorkbook(folderOptions);
    const content = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
    downloadFile(
      new Blob([content], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      `${(company?.name || 'client').replace(/\s+/g, '-').toLowerCase()}-request-template.xlsx`
    );
    setSuccess('Bulk request template downloaded.');
  };

  const uploadBulkRequests = async () => {
    if (!clientId) return;
    if (!bulkFile) {
      setError('Select a filled Excel sheet before uploading.');
      return;
    }

    setBulkUploading(true);
    setError('');
    setSuccess('');

    try {
      const rows = await readBulkWorkbook(bulkFile);
      const requests = rows
        .filter((row) => !isEmptyBulkRow(row))
        .map((row) => ({
          title: `${row.title ?? ''}`.trim(),
          sub_label: `${row.sub_label ?? ''}`.trim(),
          description: `${row.description ?? ''}`.trim(),
          category: `${row.category ?? ''}`.trim(),
          response_type: `${row.response_type ?? ''}`.trim(),
          priority: `${row.priority ?? ''}`.trim().toLowerCase(),
          status: `${row.status ?? ''}`.trim().toLowerCase(),
          due_date: `${row.due_date ?? ''}`.trim(),
          assigned_to: `${row.assigned_to ?? ''}`.trim(),
          visible: normalizeVisibleFlag(row.visible),
          created_by: user?.id || null,
        }));

      if (requests.length === 0) {
        throw new Error('The uploaded Excel sheet does not contain any request rows.');
      }

      const result = await createCompanyBulkRequestItems(clientId, { requests });
      await loadRequests();
      setBulkFile(null);
      setIsNewRequestOpen(false);
      setSuccess(`${result?.count || requests.length} requests created successfully.`);
    } catch (err) {
      const message = err.message || 'Unable to upload bulk requests.';
      setError(message);
    } finally {
      setBulkUploading(false);
    }
  };

  if (activeRequest) {
    return (
      <RequestDetailPage
        onBack={() => setActiveRequestId(null)}
        request={activeRequest}
        allRequests={requestState}
        onUpdateRequest={updateRequestState}
        onSendReminder={(id) => createRequestReminder(id, {
          sent_at: new Date().toISOString(),
          sent_by: user?.id || null,
        }).catch(() => {})}
        onAttachDocument={(id, doc) => attachRequestDocument(id, { document_id: doc.id, visible: true }).catch(() => {})}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[#050505]">{company?.name || 'Client'} Request Categories</h1>
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

      {!selectedCategory ? (
        categoryView === 'cards' ? (
          <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-5">
            {loading ? (
              <div className="col-span-full text-center text-sm text-[#A5A5A5] py-10">Loading requests...</div>
            ) : grouped.map(g => (
              <CategoryCard
                key={g.category}
                category={g.category}
                requestsInCategory={g.items}
                onClick={() => setSelectedCategory(g.category)}
              />
            ))}
          </div>
        ) : (
          loading ? (
            <div className="text-center text-sm text-[#A5A5A5] py-10">Loading requests...</div>
          ) : (
            <CategoryGroupedTable grouped={grouped} onView={(r) => setActiveRequestId(r.id)} />
          )
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

          {loading ? (
            <div className="text-center text-sm text-[#A5A5A5] py-10">Loading requests...</div>
          ) : (
            <RequestTable rows={rowsForCategory} onView={(r) => setActiveRequestId(r.id)} />
          )}
        </div>
      )}

      <NewRequestModal
        isOpen={isNewRequestOpen}
        onClose={() => setIsNewRequestOpen(false)}
        onCreate={createRequest}
        folderOptions={folderOptions}
        foldersLoading={foldersLoading}
        extraContent={(
          <div className="rounded-2xl border border-[#BFDBFE] bg-[#EFF6FF] p-4 space-y-3">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-[#2563EB]">Bulk Upload</p>
                <h4 className="text-sm font-bold text-[#050505]">Create multiple requests from an Excel sheet</h4>
                <p className="text-xs text-[#6D6E71] mt-1">Download the template first, fill each row, then upload the completed file.</p>
              </div>
              <button
                type="button"
                onClick={downloadBulkTemplate}
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-[#93C5FD] bg-white px-4 py-2.5 text-xs font-semibold text-[#1D4ED8] hover:bg-[#DBEAFE]"
              >
                <Download size={14} />
                Download Excel Sheet
              </button>
            </div>

            <div className="rounded-xl border border-dashed border-[#93C5FD] bg-white p-3">
              <div className="flex flex-col gap-3 md:flex-row md:items-center">
                <input
                  type="file"
                  accept=".xlsx,.xls"
                  onChange={(e) => setBulkFile(e.target.files?.[0] || null)}
                  className="w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-[#EFF6FF] file:px-3 file:py-2 file:text-xs file:font-semibold file:text-[#1D4ED8] hover:file:bg-[#DBEAFE]"
                />
                <button
                  type="button"
                  onClick={uploadBulkRequests}
                  disabled={bulkUploading || !bulkFile}
                  className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#05164D] px-4 py-2.5 text-xs font-semibold text-white hover:bg-[#0b2a79] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {bulkUploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                  Upload Filled Sheet
                </button>
              </div>
              <p className="mt-2 text-[11px] text-[#6D6E71]">
                {bulkFile ? `Selected file: ${bulkFile.name}` : 'Accepted format: .xlsx or .xls'}
              </p>
            </div>
          </div>
        )}
      />
    </div>
  );
}
















































